from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.models import CheckStatusResponse, LockEntry


def test_lock_entry_from_vercel_response() -> None:
    data = {
        "file_path": "src/auth.ts",
        "user_id": "jane",
        "user_name": "Jane",
        "status": "WRITING",
        "agent_head": "abc123",
        "message": "Refactoring",
        "timestamp": 1707321600000,
        "expiry": 1707321900000,
        "lock_type": "DIRECT",
    }

    entry = LockEntry(**data)
    assert entry.user == "jane"
    assert entry.status == "WRITING"
    assert entry.lock_type == "DIRECT"


def test_lock_entry_without_lock_type() -> None:
    data = {"user_id": "bob", "status": "READING", "timestamp": 123}
    entry = LockEntry(**data)
    assert entry.lock_type == "DIRECT"
    assert entry.user == "bob"


def test_check_status_response_extra_fields() -> None:
    data = {
        "status": "OK",
        "repo_head": "abc123",
        "locks": {},
        "warnings": [],
        "orchestration": {"action": "PROCEED", "reason": "All clear"},
        "some_future_field": True,
    }

    response = CheckStatusResponse(**data)
    assert response.status == "OK"
