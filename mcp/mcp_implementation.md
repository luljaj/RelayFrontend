# IMPLEMENTATION PLAN: Dedalus Labs MCP Server

This document outlines the step-by-step implementation plan for the Dedalus Labs MCP Server, based on the specifications in `mcp_planning.md` and the structure of the `dedalus-labs/example-dedalus-mcp` repository.

## 1. Project Structure

We will adopt the standard Dedalus MCP project structure:

```text
RelayMCP/
├── .env                  # Environment variables (gitignored)
├── .gitignore
├── pyproject.toml        # Dependency management
├── README.md
├── mcp_planning.md       # (Existing) Project Plans
├── schema.md             # (Existing) Data Schemas
└── src/
    ├── __init__.py
    ├── server.py         # Main entry point & server configuration
    ├── auth.py           # User authentication helpers
    ├── models.py         # Pydantic data models
    └── tools.py          # Tool definitions (check_status, post_status)
```

**Note**: Per Dedalus guidelines, server name must match deployment slug. We're using `relay-mcp`.

## 2. Dependencies & Configuration

### `pyproject.toml`
Match the dependencies from the planning doc and Dedalus documentation.

```toml
[project]
name = "relay-mcp"
version = "0.1.0"
description = "MCP Server for Dedalus Labs multi-agent coordination"
requires-python = ">=3.10"
dependencies = [
    "dedalus-mcp",
    "httpx",
    "pydantic>=2.0.0",
    "python-dotenv"
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src"]
```

### Environment Variables (`.env`)
```bash
VERCEL_API_URL=https://dedalus-coordination.vercel.app
LOG_LEVEL=INFO
```

**Note**: Authentication via GitHub OAuth is under development by Dedalus. For now, `username` is passed as a tool parameter.

## 3. Implementation Steps

### Step 1: Data Models (`src/models.py`)
Implement the Pydantic models defined in `mcp_planning.md` and `schema.md`.

```python
from enum import Enum
from typing import List, Optional, Dict, Literal, Any
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
```

### Step 2: Authentication (`src/auth.py`)
**Note**: Per Dedalus guidelines, authentication is not currently supported. Servers should be stateless.
For now, we'll pass the username as a required parameter in tool calls until OAuth is available.

```python
from dataclasses import dataclass

@dataclass
class AuthenticatedUser:
    login: str
    name: str = "Unknown"
    email: str = "unknown@example.com"

def get_user_from_username(username: str) -> AuthenticatedUser:
    """
    Simple user object from username.
    In production, this would integrate with Dedalus OAuth when available.
    """
    return AuthenticatedUser(login=username)
```

### Step 3: Tool Definitions (`src/tools.py`)
Implement `check_status` and `post_status` using `httpx` and the models above.

```python
import os
import httpx
from typing import List, Optional, Dict, Any
from dedalus_mcp import tool
from .models import (
    CheckStatusResponse, PostStatusResponse, OrchestrationCommand,
    OrchestrationAction
)
from .auth import get_user_from_username

VERCEL_URL = os.getenv("VERCEL_API_URL", "https://dedalus-coordination.vercel.app")

@tool(description="Check status of files before editing. Returns orchestration commands.")
async def check_status(
    username: str,
    file_paths: List[str], 
    agent_head: str, 
    repo_url: str, 
    branch: str = "main"
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
                    "branch": branch
                },
                timeout=5.0
            )
            resp.raise_for_status()
            data = resp.json()
            # Validate with Pydantic
            validated = CheckStatusResponse(**data)
            return validated.model_dump()
            
    except (httpx.ConnectError, httpx.TimeoutException):
        # Graceful offline mode
        offline_response = CheckStatusResponse(
            status="OFFLINE",
            repo_head="unknown",
            locks={},
            warnings=["OFFLINE_MODE: Vercel Unreachable"],
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.SWITCH_TASK, 
                reason="System Offline"
            )
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
    new_repo_head: Optional[str] = None
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
                    "branch": branch
                },
                timeout=5.0
            )
            
            if resp.status_code == 409:
                # Conflict - file is locked
                conflict_response = PostStatusResponse(
                    success=False,
                    orchestration=OrchestrationCommand(
                        action=OrchestrationAction.WAIT, 
                        reason="Conflict: File locked by another user"
                    )
                )
                return conflict_response.model_dump()
                
            resp.raise_for_status()
            data = resp.json()
            # Validate with Pydantic
            validated = PostStatusResponse(**data)
            return validated.model_dump()
            
    except (httpx.ConnectError, httpx.TimeoutException):
        # Offline mode - cannot safely acquire locks
        offline_response = PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP, 
                reason="Vercel Offline - Cannot Acquire Lock"
            )
        )
        return offline_response.model_dump()
    except Exception as e:
        # Other errors
        error_response = PostStatusResponse(
            success=False,
            orchestration=OrchestrationCommand(
                action=OrchestrationAction.STOP, 
                reason=f"Error: {str(e)}"
            )
        )
        return error_response.model_dump()
```

### Step 4: Server Entry Point (`src/server.py`)
Initialize the `MCPServer` and register the tools.

```python
from dedalus_mcp import MCPServer
from dotenv import load_dotenv

# Import tools to register
from .tools import check_status, post_status

load_dotenv()

# Server name must match your deployment slug
server = MCPServer("relay-mcp")

# Register tools
server.collect(check_status, post_status)

if __name__ == "__main__":
    import asyncio
    asyncio.run(server.serve())
```

## 4. Verification Plan

1.  **Install Dependencies**:
    ```bash
    pip install -e .
    # or with uv:
    uv pip install -e .
    ```

2.  **Set Environment Variables**:
    ```bash
    cp .env.example .env
    # Edit .env with your VERCEL_API_URL
    ```

3.  **Run Server Locally**:
    ```bash
    python -m src.server
    # Server will start on http://localhost:8000/mcp by default
    ```

4.  **Test with Dedalus SDK**:
    ```python
    from dedalus_labs import AsyncDedalus, DedalusRunner
    
    client = AsyncDedalus()
    runner = DedalusRunner(client)
    
    response = await runner.run(
        input="Check status of src/auth.ts in myrepo",
        model="anthropic/claude-sonnet-4-20250514",
        mcp_servers=["http://localhost:8000/mcp"],
    )
    ```

5.  **Deploy to Dedalus**:
    Follow the Dedalus deployment guide to publish your MCP server to the marketplace.
