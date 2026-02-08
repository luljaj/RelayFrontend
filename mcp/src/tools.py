import os
from typing import Any, Dict, List, Optional

import httpx
from dedalus_mcp import tool

from src.models import (
    CheckStatusResponse,
    OrchestrationAction,
    OrchestrationCommand,
    PostStatusResponse,
)

VERCEL_URL = os.getenv("VERCEL_API_URL", "https://relay-frontend-liard.vercel.app").rstrip("/")


def _build_identity_headers(username: str) -> Dict[str, str]:
    normalized = username.strip() or "anonymous"
    return {
        "x-github-user": normalized,
        "x-github-username": normalized,
    }


def _extract_error_message(resp: httpx.Response) -> str:
    try:
        payload = resp.json()
    except ValueError:
        text = resp.text.strip()
        return text or f"HTTP {resp.status_code}"

    if isinstance(payload, dict):
        for key in ("details", "error", "reason"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value

    text = resp.text.strip()
    return text or f"HTTP {resp.status_code}"


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
        username: GitHub username used for lock attribution
        file_paths: List of file paths (e.g., ["src/auth.ts", "src/db.ts"])
        agent_head: Current git HEAD SHA
        repo_url: Repository URL
        branch: Git branch name (default: "main")

    Returns:
        Status response with locks, warnings, and orchestration commands
    """
    headers = _build_identity_headers(username)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{VERCEL_URL}/api/check_status",
                headers=headers,
                json={
                    "file_paths": file_paths,
                    "agent_head": agent_head,
                    "repo_url": repo_url,
                    "branch": branch,
                },
                timeout=5.0,
            )

            if resp.status_code == 429:
                retry_after_ms: Optional[int] = None
                try:
                    payload = resp.json()
                    retry_value = payload.get("retry_after_ms") if isinstance(payload, dict) else None
                    if isinstance(retry_value, (int, float)):
                        retry_after_ms = int(retry_value)
                except ValueError:
                    retry_after_ms = None

                reason = "Rate limited - retry later"
                if retry_after_ms is not None:
                    reason = f"Rate limited - retry after {retry_after_ms} ms"

                return CheckStatusResponse(
                    status="OFFLINE",
                    repo_head="unknown",
                    locks={},
                    warnings=["RATE_LIMITED: GitHub API quota exhausted on Vercel"],
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.STOP,
                        reason=reason,
                    ),
                ).model_dump()

            if resp.status_code == 400:
                details = _extract_error_message(resp)
                return CheckStatusResponse(
                    status="OFFLINE",
                    repo_head="unknown",
                    locks={},
                    warnings=[f"REQUEST_REJECTED: {details}"],
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.STOP,
                        reason=f"Validation error: {details}",
                    ),
                ).model_dump()

            resp.raise_for_status()
            data = resp.json()
            validated = CheckStatusResponse(**data)
            return validated.model_dump()

    except (httpx.ConnectError, httpx.TimeoutException):
        return CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=["OFFLINE_MODE: Vercel Unreachable"],
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.SWITCH_TASK,
                reason="System Offline",
            ),
        ).model_dump()
    except httpx.HTTPStatusError as exc:
        details = _extract_error_message(exc.response)
        return CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=[f"HTTP_ERROR: {details}"],
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason=f"check_status failed ({exc.response.status_code}): {details}",
            ),
        ).model_dump()
    except Exception as exc:
        return CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=[f"UNEXPECTED_ERROR: {exc}"],
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason="Unexpected error while checking status",
            ),
        ).model_dump()


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
        username: GitHub username used for lock attribution
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
    headers = _build_identity_headers(username)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{VERCEL_URL}/api/post_status",
                headers=headers,
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

            if resp.status_code == 429:
                return PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.STOP,
                        reason="Rate limited - retry later",
                    ),
                ).model_dump()

            if resp.status_code == 400:
                details = _extract_error_message(resp)
                return PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.STOP,
                        reason=f"Validation error: {details}",
                    ),
                ).model_dump()

            if resp.status_code == 409:
                return PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.WAIT,
                        reason="Conflict: File locked by another user",
                    ),
                ).model_dump()

            resp.raise_for_status()
            data = resp.json()
            validated = PostStatusResponse(**data)
            return validated.model_dump()

    except (httpx.ConnectError, httpx.TimeoutException):
        return PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason="Vercel Offline - Cannot Acquire Lock",
            ),
        ).model_dump()
    except httpx.HTTPStatusError as exc:
        details = _extract_error_message(exc.response)
        return PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason=f"post_status failed ({exc.response.status_code}): {details}",
            ),
        ).model_dump()
    except Exception as exc:
        return PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP,
                reason=f"Error: {exc}",
            ),
        ).model_dump()
