from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel


class OrchestrationAction(str, Enum):
    PULL = "PULL"
    PUSH = "PUSH"
    WAIT = "WAIT"
    SWITCH_TASK = "SWITCH_TASK"
    STOP = "STOP"
    PROCEED = "PROCEED"


class OrchestrationCommand(BaseModel):
    type: Literal["orchestration_command"] = "orchestration_command"
    action: OrchestrationAction
    command: Optional[str] = None
    reason: str
    metadata: Optional[Dict[str, Any]] = None


class LockEntry(BaseModel):
    user: str
    status: Literal["READING", "WRITING"]
    lock_type: Literal["DIRECT", "NEIGHBOR"]
    timestamp: float
    message: Optional[str] = None


class CheckStatusResponse(BaseModel):
    status: Literal["OK", "STALE", "CONFLICT", "OFFLINE"]
    repo_head: str
    locks: Dict[str, LockEntry]
    warnings: List[str]
    orchestration: Optional[OrchestrationCommand] = None


class PostStatusResponse(BaseModel):
    success: bool
    orphaned_dependencies: List[str] = []
    orchestration: Optional[OrchestrationCommand] = None
