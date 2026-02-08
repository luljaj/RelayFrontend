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


def _extract_payload(resp: httpx.Response) -> Optional[Dict[str, Any]]:
    try:
        payload = resp.json()
    except ValueError:
        return None

    if isinstance(payload, dict):
        return payload

    return None


def _extract_orchestration(payload: Optional[Dict[str, Any]]) -> Optional[OrchestrationCommand]:
    if not payload:
        return None

    orchestration = payload.get("orchestration")
    if not isinstance(orchestration, dict):
        return None

    action = orchestration.get("action")
    if not isinstance(action, str):
        return None

    try:
        parsed_action = OrchestrationAction(action)
    except ValueError:
        return None

    command = orchestration.get("command")
    reason = orchestration.get("reason")
    metadata = orchestration.get("metadata")

    return OrchestrationCommand(
        action=parsed_action,
        command=command if isinstance(command, str) else None,
        reason=reason if isinstance(reason, str) else "",
        metadata=metadata if isinstance(metadata, dict) else None,
    )


def _is_missing_git_ref_error(resp: httpx.Response) -> bool:
    details = _extract_error_message(resp)
    return "Not Found" in details and "git/refs#get-a-reference" in details


async def _post_with_branch_fallback(
    client: httpx.AsyncClient,
    endpoint: str,
    headers: Dict[str, str],
    payload: Dict[str, Any],
) -> httpx.Response:
    resp = await client.post(
        f"{VERCEL_URL}{endpoint}",
        headers=headers,
        json=payload,
        timeout=5.0,
    )

    # Allow repositories that still use master to work when branch isn't specified by the caller.
    if payload.get("branch") == "main" and resp.status_code >= 500 and _is_missing_git_ref_error(resp):
        retry_payload = {**payload, "branch": "master"}
        return await client.post(
            f"{VERCEL_URL}{endpoint}",
            headers=headers,
            json=retry_payload,
            timeout=5.0,
        )

    return resp


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
        username: Stable agent identity for lock attribution; choose once as "(model)-(random word)-(agent owner github username)" (e.g., "gpt5-orchid-lukauljaj") and keep using the same value
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
            resp = await _post_with_branch_fallback(
                client=client,
                endpoint="/api/check_status",
                headers=headers,
                payload={
                    "file_paths": file_paths,
                    "agent_head": agent_head,
                    "repo_url": repo_url,
                    "branch": branch,
                },
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
                payload = _extract_payload(resp)
                orchestration = _extract_orchestration(payload)
                details = _extract_error_message(resp)
                return CheckStatusResponse(
                    status="OFFLINE",
                    repo_head="unknown",
                    locks={},
                    warnings=[f"REQUEST_REJECTED: {details}"],
                    orchestration=orchestration
                    or OrchestrationCommand(
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
        username: Stable agent identity for lock attribution; choose once as "(model)-(random word)-(agent owner github username)" (e.g., "gpt5-orchid-lukauljaj") and keep using the same value
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
            resp = await _post_with_branch_fallback(
                client=client,
                endpoint="/api/post_status",
                headers=headers,
                payload={
                    "file_paths": file_paths,
                    "status": status,
                    "message": message,
                    "agent_head": agent_head,
                    "new_repo_head": new_repo_head,
                    "repo_url": repo_url,
                    "branch": branch,
                },
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
                payload = _extract_payload(resp)
                orchestration = _extract_orchestration(payload)
                if orchestration:
                    orphaned_dependencies = payload.get("orphaned_dependencies") if payload else None
                    return PostStatusResponse(
                        success=bool(payload.get("success", False)) if payload else False,
                        orphaned_dependencies=(
                            orphaned_dependencies if isinstance(orphaned_dependencies, list) else []
                        ),
                        orchestration=orchestration,
                    ).model_dump()

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
