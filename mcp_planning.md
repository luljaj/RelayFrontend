# IMPLEMENTATION GUIDE: Dedalus Labs MCP Server

**Technical Spec**: strict stateless implementation using `dedalus_mcp`, `httpx`, and `pydantic`.

---

## 1. Environment & Configuration

**Required Environment Variables**:
```bash
VERCEL_API_URL=https://dedalus-coordination.vercel.app # Base URL
MCP_PORT=8000
LOG_LEVEL=INFO
```

---

## 2. Authentication (Dedalus Middleware)

**Implementation**:
All tools must use the `AuthenticatedUser` dependency.

```python
from dedalus_mcp.core import get_context
from mcp.server.fastapi import McpError

async def get_current_user() -> AuthenticatedUser:
    ctx = get_context()
    if not ctx or not ctx.request_context.credentials:
        raise McpError(-32000, "Missing Credentials")

    token = ctx.request_context.credentials.get("GITHUB_TOKEN")
    if not token:
        raise McpError(-32000, "Missing GITHUB_TOKEN")

    # Validate with GitHub (Use specific verification logic)
    # Ideally invoke a utility that calls GET https://api.github.com/user
    user_profile = await verify_github_token(token) 
    
    return AuthenticatedUser(
        login=user_profile.login,
        name=user_profile.name,
        email=user_profile.email
    )
```

---

## 3. Data Models (Pydantic)

Match these strict schemas to `schema.md`.

### Orchestration
```python
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
```

### Models
```python
class LockEntry(BaseModel):
    user: str
    status: Literal["READING", "WRITING"]
    lock_type: Literal["DIRECT", "NEIGHBOR"]
    timestamp: float

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
```

---

## 4. Vercel API Client (`httpx`)

**Base URL**: `os.getenv("VERCEL_API_URL")`
**Headers**: `{"Content-Type": "application/json", "x-github-username": user.login}`

### Endpoints
1.  **POST `/api/check_status`**:
    *   **Input**: `{ "file_paths": [...], "agent_head": "...", "repo_url": "...", "branch": "..." }`
    *   **Output**: `CheckStatusResponse` JSON.
    *   **Note**: `file_paths` are file-level (e.g., "src/auth.ts"), not function-level
2.  **POST `/api/post_status`**:
    *   **Input**: `{ "file_paths": [...], "status": "WRITING", "agent_head": "...", "repo_url": "...", "branch": "..." }`
    *   **Output**: `PostStatusResponse` JSON.
    *   **Response Codes**: 
        *   `200`: Success (PROCEED).
        *   `409`: Conflict (WAIT).
    *   **Note**: Lock timeout is 300 seconds (5 minutes) with no heartbeat mechanism
3.  **POST `/api/post_activity`**:
    *   **Input**: `{ "message": "...", "scope": "...", "intent": "..." }`

---

## 5. Tool Implementation Logic

### `check_status`
```python
@mcp.tool()
async def check_status(file_paths: List[str], agent_head: str, repo_url: str, branch: str = "main") -> CheckStatusResponse:
    """Check status of files before editing. Returns orchestration commands.
    
    Args:
        file_paths: List of file paths (e.g., ["src/auth.ts", "src/db.ts"])
        agent_head: Current git HEAD SHA
        repo_url: Repository URL
        branch: Git branch name
        
    Note: Uses file-level granularity only. Lock timeout is 300s (5 min) with no heartbeat.
    """
    user = await get_current_user()
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{VERCEL_URL}/api/check_status",
                headers={"x-github-username": user.login},
                json={
                    "file_paths": file_paths, 
                    "agent_head": agent_head,
                    "repo_url": repo_url,
                    "branch": branch
                },
                timeout=5.0
            )
            resp.raise_for_status()
            return CheckStatusResponse(**resp.json())
            
    except (httpx.ConnectError, httpx.TimeoutException):
        # Graceful OFFLINE mode
        return CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=["OFFLINE_MODE: Vercel Unreachable"],
            orchestration={"action": "SWITCH_TASK", "reason": "System Offline"}
        )
```

### `post_status`
```python
@mcp.tool()
async def post_status(file_paths: List[str], status: str, message: str, agent_head: str, repo_url: str, branch: str = "main", new_repo_head: Optional[str] = None) -> PostStatusResponse:
    """Update lock status for files. Supports atomic multi-file locking.
    
    Args:
        file_paths: List of file paths (e.g., ["src/auth.ts"])
        status: "READING", "WRITING", or "OPEN"
        message: Context message about what you're doing
        agent_head: Current git HEAD SHA (required for WRITING)
        new_repo_head: New HEAD SHA after push (required for OPEN)
        repo_url: Repository URL
        branch: Git branch name
        
    Note: Lock expires after 300s (5 min) with no heartbeat. Re-issue post_status to extend.
    """
    user = await get_current_user()
    
    # Rely on Vercel for definitive conflict check
    
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
                    "branch": branch
                },
                timeout=5.0
            )
            
            if resp.status_code == 409:
                return PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(action="WAIT", reason="Conflict")
                )
                
            resp.raise_for_status()
            return PostStatusResponse(**resp.json())
            
    except Exception as e:
        # WRITING is unsafe if offline
        return PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(action="STOP", reason="Vercel Offline")
        )
```

### Prompt for LLM Agent (Meta-Prompt)
*Include in `mcp_planning.md` for context, but implementation is via Tool definition description docstrings.*

For `check_status` description:
"Checks strict consistency with the team. Returns ORCHESTRATION_COMMANDs. If 'SWITCH_TASK' is returned, do not wait—switch immediately."
