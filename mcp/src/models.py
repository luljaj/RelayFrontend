from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class OrchestrationAction(str, Enum):
    PULL = "PULL"
    PUSH = "PUSH"
    WAIT = "WAIT"
    SWITCH_TASK = "SWITCH_TASK"
    STOP = "STOP"
    PROCEED = "PROCEED"


class OrchestrationCommand(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["orchestration_command"] = "orchestration_command"
    action: OrchestrationAction
    command: Optional[str] = None
    reason: str = ""
    metadata: Optional[Dict[str, Any]] = None


class LockEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user: Optional[str] = None
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    status: Literal["READING", "WRITING"]
    lock_type: Optional[Literal["DIRECT", "NEIGHBOR"]] = "DIRECT"
    timestamp: float = 0
    message: Optional[str] = None

    @model_validator(mode="after")
    def resolve_user_field(self) -> "LockEntry":
        if not self.user and self.user_id:
            self.user = self.user_id
        if not self.user and self.user_name:
            self.user = self.user_name
        return self


class CheckStatusResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: Literal["OK", "STALE", "CONFLICT", "OFFLINE"]
    repo_head: str
    locks: Dict[str, LockEntry] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    orchestration: Optional[OrchestrationCommand] = None


class PostStatusResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    success: bool
    orphaned_dependencies: List[str] = Field(default_factory=list)
    orchestration: Optional[OrchestrationCommand] = None
