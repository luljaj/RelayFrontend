# Orchestration & Data Schema

## 1. Orchestration Commands
These commands are returned by MCP tools (`check_status`, `post_status`) to guide the agent's next actions. Agents **MUST** parse and execute these commands.

### Schema
```json
{
  "type": "orchestration_command",
  "action": "PULL" | "PUSH" | "WAIT" | "STOP" | "PROCEED",
  "command": "string" | null,
  "reason": "string",
  "metadata": {
    "remote_head": "string",  // for PULL/PUSH
    "lock_owner": "string",   // for WAIT
    "conflicts": ["string"]   // for WAIT/STOP
  }
}
```

### Command Types

| Action | Description | `command` value | Condition |
| :--- | :--- | :--- | :--- |
| **PULL** | Local repo is behind remote. | `git pull --rebase` | `agent_head != repo_head` |
| **PUSH** | Lock release requires sync. | `git push` | `post_status(OPEN)` but `head` unchanged |
| **WAIT** | Symbol is locked by another user. | `sleep 5` | `locks[symbol] != null` |
| **SWITCH_TASK** | Node or neighbor locked. | `null` | `lock_type == "DIRECT" \| "NEIGHBOR"` |
| **STOP** | Hard conflict or error. | `null` | Lock timeout, Vercel down |
| **PROCEED**| Safe to continue. | `null` | No conflicts, fresh repo |

---

## 2. Tool Input/Output Schemas

### Common Fields
All requests MUST include:
*   `repo_url`: "https://github.com/user/repo.git"
*   `branch`: "main" (or current branch)

### `check_status`

**Request:**
```json
{
  "repo_url": "https://github.com/dedalus/core.git",
  "branch": "main",
  "file_paths": ["src/auth.ts", "src/db.ts"],
  "agent_head": "abc1234..." 
}
```

**Note:** `file_paths` are file-level only (e.g., "src/auth.ts"), not function/symbol level.

**Response:**
```json
{
  "status": "OK" | "STALE" | "CONFLICT" | "OFFLINE",
  "repo_head": "abc1234...",
  "locks": {
    "src/auth.ts": {
      "user": "github_user_1",
      "user_name": "GitHub User",
      "status": "WRITING",
      "lock_type": "DIRECT" | "NEIGHBOR",
      "message": "Refactoring authentication",
      "timestamp": 1234567890
    }
  },
  "warnings": [
    "OFFLINE_MODE: Vercel is unreachable. Reading allowed, Writing disabled.",
    "STALE_BRANCH: Your branch is behind origin/main."
  ],
  "orchestration": {
    "type": "orchestration_command",
    "action": "SWITCH_TASK",
    "command": null,
    "reason": "File 'src/auth.ts' is locked by user 'octocat' (DIRECT)"
  }
}
```

**Note:** File-level granularity. Keys in `locks` are file paths.

### `post_status`

**Request:**
```json
{
  "repo_url": "https://github.com/dedalus/core.git",
  "branch": "main",
  "file_paths": ["src/auth.ts", "src/utils.ts"], 
  "status": "READING" | "WRITING" | "OPEN",
  "message": "Refactoring auth logic",
  "agent_head": "abc1234...",
  "new_repo_head": "def4567..." // Only for OPEN
}
```

**Note:** `file_paths` are file-level only. Multi-file locking is atomic (all-or-nothing).

**Response:**
```json
{
  "success": true,
  "orphaned_dependencies": ["src/utils.ts"], 
  "orchestration": {
    "type": "orchestration_command",
    "action": "PROCEED",
    "command": null
  }
}
```

**Note:** `orphaned_dependencies` lists file paths that depend on the files you just released.

---

## 3. Data Structures (Vercel Backend)

### Lock Entry
```json
{
  "key": "repo_url:branch:file_path", // Composite Key
  "file_path": "string",
  "user_id": "string",
  "user_name": "string",
  "status": "READING" | "WRITING",
  "agent_head": "string",
  "message": "string",
  "timestamp": 1610000000,
  "expiry": 1610000300 // timestamp + 300s (Passive Timeout - 5 minutes)
}
```

**Notes:**
- **Granularity**: File-level only. `file_path` represents the file being worked on (e.g., "src/auth.ts")
- **No Heartbeat**: Lock expiration is passive. If timestamp + 300s < now, lock is expired
- **user_name**: Display name for UI purposes
- **message**: Optional context message about what the user is doing
