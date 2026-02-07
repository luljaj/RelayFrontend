# Vercel Backend Architecture

## Core Design Principles

### 1. **WebSocket Connection**
- **Provider:** Dedalus MCP infrastructure (not Pusher/Ably)
- **Connection:** Dedalus WebSocket connects to Vercel backend
- **Purpose:**
  - Graph construction (visualize file dependencies + agent activity)
  - Broadcasting text messages and status updates
- **Event Schema:** Defined in `schema.md` (designed separately)

### 2. **Data Storage**
- **Backend:** Vercel KV (Redis) ONLY
- **Schema:** Complete structure defined in `schema.md`
- **Historical Data Retention:** As long as Vercel can hold it (no explicit TTL)

### 3. **Repository State**
- **repo_head:** NOT stored in Redis
- **Source:** Fetched from GitHub API on-demand
- **Method:** `GET /repos/{owner}/{repo}/git/refs/heads/{branch}`
- **Purpose:** Real-time freshness checking

### 4. **Lock Expiration**
- **Timeout:** 300 seconds (5 minutes) of no status update (NOT heartbeat-based)
- **Cleanup:** Vercel cron job runs every 1 minute
- **Behavior:** When lock expires, status → OPEN
- **Agent Workflow:** Agent commits their own work when complete (lock expiration doesn't force anything)
- **NO Heartbeat Mechanism:** Not implemented (passive timeout only)

### 5. **Graph Generation**
- **Supported Languages:** JavaScript/TypeScript, Python only
- **Granularity:** FILE-level dependencies only (NOT function-level, NOT line-level)
- **Analysis Method:** Import/require statement parsing (NO AST parsing)
- **Lock Granularity:** File-level only. Locks apply to entire files, not functions or lines
- **Update Strategy:** Incremental "Diff & Sync"
  - **Layer 1 (Repo Check):** Compare `repo_head` SHA. If unchanged, exit.
  - **Layer 2 (File Check):** Compare GitHub Tree SHAs against Redis Hash (`coord:file_shas`).
  - **Logic:**
    - **NEW:** Path in GitHub, not in Redis → Parse & Add Node.
    - **CHANGED:** Path in both, SHAs differ → Parse & Update Edges.
    - **DELETED:** Path in Redis, not in GitHub → Remove Node & Edges.
    - **UNCHANGED:** SHAs match → Skip.
- **Dependency Parsing (Regex-based):**
  - **TS/JS:**
    - `^import\s+.*\s+from\s+['"]([^'"]+)['"]`
    - `^export\s+.*\s+from\s+['"]([^'"]+)['"]`
    - `(import|require)\(['"]([^'"]+)['"]\)`
  - **Python:**
    - `^import\s+([\w\.]+)`
    - `^from\s+([\w\.]+)\s+import`
  - **Resolution:**
    - Ignore non-relative imports (libraries).
    - Resolve relative paths (`./`, `../`).
    - Probe extensions (`.ts`, `.tsx`, `.js`, `/index.ts`, etc.) against file list.
- **Data Source:** GitHub repository at HEAD
- **Visualization:** Overlays lock status on file graph (shows which files agents are working on)

### 6. **Conflict Detection**
- **Granularity:** FILE-LEVEL only
- **Logic:** Only one agent can write to a file at a time (file-level locking)
- **Complete Rules:** See `mcp_planning.md` and `schema.md` for full lock logic

### 7. **Lock Management**
- **Updates:** ONLY current lock holder can update their own lock
- **Logic Details:** See `mcp_planning.md`
- **Race Conditions:** Handled by Redis transactions/Lua scripts

### 8. **MCP Response Freshness**
- **Caching:** NONE - every MCP request fetches fresh state from Vercel
- **GitHub API:** Called on every status check/update
- **KV Reads:** Direct reads, no caching layer

---

## REST API Endpoints

### **State Management**

#### `POST /api/check_status`
**Purpose:** Fetch current world state for agent decision-making

**Request:**
```json
{
  "user_id": "luka",
  "file_paths": ["src/auth.ts", "src/db.ts"]
}
```

**Note:** File-level granularity only. `file_paths` are full file paths, not functions/symbols.

**Response:**
```json
{
  "repo_head": "abc123def",  // Fetched from GitHub API
  "locks": {
    "src/auth.ts": {
      "user_id": "jane",
      "status": "WRITING",
      "lines": [10, 11, 12],
      "timestamp": 1707321600000
    }
  },
  "recent_activity": [...],
  "graph_version": "xyz789"
}
```

**Process:**
1. Fetch repo_head from GitHub API
2. Read locks from `coord:locks` (KV)
3. Read activity from `coord:activity` (KV)
4. Return combined state

---

#### `POST /api/post_status`
**Purpose:** Acquire/update/release lock on files

**Request:**
```json
{
  "user_id": "luka",
  "file_paths": ["src/auth.ts"],
  "status": "WRITING",  // or "OPEN", "READING"
  "message": "Refactoring authentication",
  "agent_head": "abc123def",  // Required for WRITING
  "new_repo_head": "xyz789"  // Required for OPEN (after push)
}
```

**Note:** File-level locking only. Multi-file locking is atomic (all-or-nothing).

**Response (Success):**
```json
{
  "status": "SUCCESS",
  "lock_acquired": true
}
```

**Response (Rejection - Stale):**
```json
{
  "status": "REJECTED",
  "reason": "STALE_REPO",
  "message": "Your local repo is behind. Pull and retry.",
  "server_repo_head": "abc123def",
  "your_agent_head": "old789"
}
```

**Response (Rejection - File Conflict):**
```json
{
  "status": "REJECTED",
  "reason": "FILE_CONFLICT",
  "message": "File is being modified by another user.",
  "conflicting_user": "jane@example.com",
  "conflicting_file": "src/auth.ts"
}
```

**Process:**
1. Fetch repo_head from GitHub API
2. If WRITING: Validate agent_head == repo_head
3. Check file-level conflicts in `coord:locks`
4. If OPEN: Verify new_repo_head advanced (optional)
5. Update `coord:locks` in KV
6. Broadcast WebSocket event
7. Log to `coord:status_log`

**Lock Update Rule:**
- ONLY the current lock holder (matching user_id) can update their own lock
- Other users get REJECTED if they try to modify a locked file
- Lock expires after 300 seconds (5 minutes) with no heartbeat mechanism

---

#### `POST /api/post_activity`
**Purpose:** Post high-level activity message (agent slack)

**Request:**
```json
{
  "user_id": "luka",
  "summary": "Starting authentication refactor",
  "scope": ["src/auth/*"],
  "intent": "WRITING"
}
```

**Process:**
1. Append to `coord:activity` (KV list)
2. Log to `coord:status_log`
3. Broadcast WebSocket event

---

### **Graph Management**

#### `POST /api/generate_graph`
**Purpose:** Generate/update file dependency graph from GitHub

**Request:**
```json
{
  "repo_url": "https://github.com/user/repo",
  "branch": "main"
}
```

**Process:**
1. Authenticate with GitHub API (token from env)
2. Fetch repository tree at HEAD
3. Filter for JS/TS/Python files
4. Parse import statements (simple regex, no AST)
5. Build file→file edges
6. If incremental: Compare with existing graph, only update changed files
7. Overlay lock status from `coord:locks`
8. Store in `coord:graph` (KV)
9. Broadcast WebSocket `graph_update` event

**Graph Structure:**
```json
{
  "nodes": [
    {"id": "src/auth.ts", "type": "file"},
    {"id": "src/db.ts", "type": "file"}
  ],
  "edges": [
    {"source": "src/auth.ts", "target": "src/db.ts", "type": "import"}
  ],
  "locks": {
    "src/auth.ts": {"user": "luka", "status": "WRITING"}
  }
}
```

---

#### `GET /api/graph`
**Purpose:** Fetch current dependency graph

**Response:**
```json
{
  "nodes": [...],
  "edges": [...],
  "locks": {...},
  "version": "xyz789"
}
```

---

### **Background Jobs**

#### `GET /api/cleanup_stale_locks`
**Purpose:** Expire locks with no status update for 300+ seconds (5 minutes)

**Trigger:** Vercel cron job, runs every 1 minute

**Process:**
1. Read all locks from `coord:locks`
2. Check each lock's timestamp
3. If `now - timestamp > 300 seconds`:
   - Set status to OPEN
   - Delete from `coord:locks`
   - Broadcast `lock_expired` event
   - Log to `coord:status_log`

**Note:** Agent commits own work when complete. Lock expiration just releases coordination, doesn't force git operations.
**No Heartbeat:** Lock expiration is passive, based only on timestamp of last status update.

---

## Data Schema (Vercel KV - Redis)

**See `schema.md` for complete structure**

### Key Patterns:

- `coord:locks` → Hash (symbol → lock JSON)
- `coord:activity` → List (recent activity messages)
- `coord:graph` → String (JSON graph structure)
- `coord:graph_meta` → String (SHA of repo_head from last graph update)
- `coord:file_shas` → Hash (file_path → git_sha)
- `coord:status_log` → List (historical events)
- `coord:chat` → List (chat messages)

### Lock Entry Structure:
```json
{
  "file_path": "src/auth.ts",
  "user_id": "luka",
  "user_name": "Luka",
  "status": "WRITING",
  "agent_head": "abc123def",
  "timestamp": 1707321600000,
  "expiry": 1707321900000,
  "message": "Refactoring auth"
}
```

**Note:** File-level granularity only. Expiry is timestamp + 300 seconds (5 minutes).

---

## GitHub Integration

### Authentication:
- **Method:** Personal Access Token or GitHub App
- **Permissions:** `repo:read` (contents, refs)
- **Configuration:** `GITHUB_TOKEN` env var in Vercel

### API Calls:

**Get repo HEAD:**
```
GET /repos/{owner}/{repo}/git/refs/heads/{branch}
Response: { "object": { "sha": "abc123..." } }
```

**Get file tree:**
```
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
Response: { "tree": [{ "path": "src/auth.ts", ... }] }
```

**Get file content:**
```
GET /repos/{owner}/{repo}/contents/{path}?ref={sha}
Response: { "content": "<base64>", ... }
```

### Rate Limiting:
- GitHub API: 5000 requests/hour (authenticated)
- Graph generation is incremental to minimize API calls
- Cache file contents between graph updates

---

## WebSocket Events

**Event Schema:** See `schema.md`

### Event Types:

1. **status_update** - Lock status changed
2. **activity_posted** - New activity message
3. **lock_expired** - Lock timed out (300s / 5 minutes)
4. **conflict_warning** - Conflict detected
5. **graph_update** - Dependency graph updated
6. **chat_message** - New chat message

### Broadcast Process:
1. Vercel API endpoint completes update
2. Vercel calls Dedalus WebSocket API
3. Dedalus broadcasts to connected UI clients

---

## Environment Variables

```bash
# Vercel KV
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# GitHub
GITHUB_TOKEN=ghp_...  # Personal Access Token
GITHUB_REPO_OWNER=username
GITHUB_REPO_NAME=repository

# MCP Authentication
MCP_SHARED_SECRET=...  # Shared with Dedalus MCP server

# Dedalus WebSocket
DEDALUS_WEBSOCKET_URL=wss://...
DEDALUS_WEBSOCKET_SECRET=...
```

---

## Deployment (vercel.json)

```json
{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "env": {
    "KV_REST_API_URL": "@kv-url",
    "KV_REST_API_TOKEN": "@kv-token",
    "GITHUB_TOKEN": "@github-token",
    "MCP_SHARED_SECRET": "@mcp-secret",
    "DEDALUS_WEBSOCKET_URL": "@websocket-url"
  },
  "crons": [
    {
      "path": "/api/cleanup_stale_locks",
      "schedule": "*/1 * * * *"
    }
  ]
}
```

---

## Key Design Decisions

1. **No Heartbeat:** Lock expiration based solely on timestamp of last status update (300s timeout)
2. **File-Level Locking:** One agent per file at a time (not line-level, not function-level)
3. **Fresh State:** No caching - every request queries GitHub API + KV
4. **File Dependencies:** Simple import parsing, no complex AST analysis
5. **Incremental Graph:** Only reanalyze changed files to save GitHub API quota
6. **Dedalus WebSocket:** Use Dedalus infrastructure instead of managing our own
7. **Redis Only:** Vercel KV for all state (no Postgres)
8. **GitHub as Source of Truth:** repo_head always fetched from GitHub, never cached
9. **300 Second Timeout:** Locks expire after 5 minutes (300s) with no heartbeat mechanism

---

## References

- **Lock Logic:** See `mcp_planning.md` for complete rules
- **Data Schema:** See `schema.md` for KV structure and WebSocket events
- **MCP Integration:** See `project_info.md` for MCP server architecture
