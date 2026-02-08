import os
from typing import Any, Dict, List, Optional

import httpx
from dedalus_mcp import tool

from src.auth import get_user_from_username
from src.models import (
    CheckStatusResponse,
    OrchestrationAction,
    OrchestrationCommand,
    PostStatusResponse,
)

VERCEL_URL = os.getenv("VERCEL_API_URL", "https://relay_devfest.vercel.app")


@tool(description="Check status of files before editing. Returns orchestration commands.")
async def check_status(
    username: str,
    file_paths: List[str],
    agent_head: str,
    repo_url: str,
    branch: str = "main",
) -> Dict[str, Any]:
    """Check status of files before editing. Returns orchestration commands.

    Args:
        username: GitHub username (required until OAuth is available)
        file_paths: List of file paths (e.g., ["src/auth.ts", "src/db.ts"])
        agent_head: Current git HEAD SHA
        repo_url: Repository URL
        branch: Git branch name (default: "main")

    Returns:
        Status response with locks, warnings, and orchestration commands
    """
    user = get_user_from_username(username)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{VERCEL_URL}/api/check_status",
                headers={"x-github-username": user.login},
                json={
                    "file_paths": file_paths,
                    "agent_head": agent_head,
                    "repo_url": repo_url,
                    "branch": branch,
                },
                timeout=5.0,
            )
            resp.raise_for_status()
            data = resp.json()
            validated = CheckStatusResponse(**data)
            return validated.model_dump()

    except (httpx.ConnectError, httpx.TimeoutException):
        offline_response = CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=["OFFLINE_MODE: Vercel Unreachable"],
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.SWITCH_TASK,
                reason="System Offline",
            ),
        )
        return offline_response.model_dump()


@tool(description="Update lock status for files. Supports atomic multi-file locking.")
async def post_status(
    username: str,
    file_paths: List[str],
    status: str,
    message: str,
    agent_head: str,
    repo_url: str,
    branch: str = "main",
    new_repo_head: Optional[str] = None,
) -> Dict[str, Any]:
    """Update lock status for files. Supports atomic multi-file locking.

    Args:
        username: GitHub username (required until OAuth is available)
        file_paths: List of file paths (e.g., ["src/auth.ts"])
        status: Lock status - "READING", "WRITING", or "OPEN"
        message: Context message about what you're doing
        agent_head: Current git HEAD SHA
        repo_url: Repository URL
        branch: Git branch name (default: "main")
        new_repo_head: New HEAD SHA after push (required for OPEN status)

    Returns:
        Success status, orphaned dependencies, and orchestration commands
    """
    user = get_user_from_username(username)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{VERCEL_URL}/api/post_status",
                headers={"x-github-username": user.login},
                json={
                    "file_paths": file_paths,
                    "status": status,
                    "message": message,
                    "agent_head": agent_head,
                    "new_repo_head": new_repo_head,
                    "repo_url": repo_url,
                    "branch": branch,
                },
                timeout=5.0,
            )

            if resp.status_code == 409:
                conflict_response = PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.WAIT,
                        reason="Conflict: File locked by another user",
                    ),
                )
                return conflict_response.model_dump()

            resp.raise_for_status()
            data = resp.json()
            validated = PostStatusResponse(**data)
            return validated.model_dump()

    except (httpx.ConnectError, httpx.TimeoutException):
        offline_response = PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason="Vercel Offline - Cannot Acquire Lock",
            ),
        )
        return offline_response.model_dump()
    except Exception as e:
        error_response = PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason=f"Error: {str(e)}",
            ),
        )
        return error_response.model_dump()
