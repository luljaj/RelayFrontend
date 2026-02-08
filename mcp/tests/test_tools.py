import asyncio
from pathlib import Path
import sys
from typing import Any, Dict, List

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import tools


class FakeAsyncClient:
    def __init__(self, responses: List[httpx.Response]):
        self._responses = responses
        self.calls: List[Dict[str, Any]] = []

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def post(self, url: str, *, headers: Dict[str, str], json: Dict[str, Any], timeout: float):
        self.calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        index = len(self.calls) - 1
        if index < len(self._responses):
            return self._responses[index]
        return self._responses[-1]


def _response(status_code: int, payload: Dict[str, Any], url: str) -> httpx.Response:
    request = httpx.Request("POST", url)
    return httpx.Response(status_code=status_code, request=request, json=payload)


def test_check_status_retries_with_master_when_main_ref_is_missing(monkeypatch) -> None:
    first = _response(
        500,
        {"error": "Internal server error", "details": "Not Found - https://docs.github.com/rest/git/refs#get-a-reference"},
        "https://relay.example/api/check_status",
    )
    second = _response(
        200,
        {
            "status": "OK",
            "repo_head": "abc123",
            "locks": {},
            "warnings": [],
            "orchestration": {
                "type": "orchestration_command",
                "action": "PROCEED",
                "command": None,
                "reason": "",
            },
        },
        "https://relay.example/api/check_status",
    )

    fake_client = FakeAsyncClient([first, second])
    monkeypatch.setattr(tools.httpx, "AsyncClient", lambda: fake_client)

    result = asyncio.run(
        tools.check_status(
            username="alice",
            file_paths=["README.md"],
            agent_head="abc123",
            repo_url="https://github.com/example/repo.git",
        )
    )

    assert result["status"] == "OK"
    assert len(fake_client.calls) == 2
    assert fake_client.calls[0]["json"]["branch"] == "main"
    assert fake_client.calls[1]["json"]["branch"] == "master"
    assert fake_client.calls[0]["json"]["repo_url"] == "https://github.com/luljaj/RelayDevFest"
    assert fake_client.calls[1]["json"]["repo_url"] == "https://github.com/luljaj/RelayDevFest"


def test_post_status_preserves_orchestration_from_400_payload(monkeypatch) -> None:
    response = _response(
        400,
        {
            "success": False,
            "orchestration": {
                "type": "orchestration_command",
                "action": "PUSH",
                "command": "git push",
                "reason": "You need to push your changes to advance the repo",
            },
        },
        "https://relay.example/api/post_status",
    )

    fake_client = FakeAsyncClient([response])
    monkeypatch.setattr(tools.httpx, "AsyncClient", lambda: fake_client)

    result = asyncio.run(
        tools.post_status(
            username="alice",
            file_paths=["README.md"],
            status="OPEN",
            message="done",
            agent_head="abc123",
            new_repo_head="abc123",
            repo_url="https://github.com/example/repo.git",
            branch="master",
        )
    )

    assert result["success"] is False
    assert result["orchestration"]["action"] == "PUSH"
    assert result["orchestration"]["command"] == "git push"
    assert "Validation error" not in result["orchestration"]["reason"]
    assert fake_client.calls[0]["json"]["repo_url"] == "https://github.com/luljaj/RelayDevFest"
