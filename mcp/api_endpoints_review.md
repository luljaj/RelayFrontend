# API Endpoints - Comprehensive Review

## Endpoint Mapping Across Documents

### **Core State Management Endpoints**

#### `POST /api/check_status`
**Mentioned in:** schema.md, vercel_app.md, mcp_planning.md, project_info.md

**Purpose:** Check status of files before editing

**Request Schema:**
```json
{
  "repo_url": "https://github.com/user/repo.git",
  "branch": "main",
  "file_paths": ["src/auth.ts", "src/db.ts"],
  "agent_head": "abc1234..."
}
```

**Response Schema:**
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
  "warnings": ["OFFLINE_MODE: ...", "STALE_BRANCH: ..."],
  "orchestration": {
    "type": "orchestration_command",
    "action": "SWITCH_TASK",
    "command": null,
    "reason": "File 'src/auth.ts' is locked by user 'octocat' (DIRECT)"
  }
}
```

**Status:** ✅ **CONSISTENT** - Schema aligned across all docs

---

#### `POST /api/post_status`
**Mentioned in:** schema.md, vercel_app.md, mcp_planning.md, project_info.md

**Purpose:** Acquire/update/release lock on files

**Request Schema:**
```json
{
  "repo_url": "https://github.com/user/repo.git",
  "branch": "main",
  "file_paths": ["src/auth.ts"],
  "status": "READING" | "WRITING" | "OPEN",
  "message": "Refactoring auth logic",
  "agent_head": "abc1234...",
  "new_repo_head": "def4567..."  // Only for OPEN
}
```

**Response Schema:**
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

**Error Responses:**
- `409 Conflict` - File already locked by another user
- `REJECTED` with reason: "STALE_REPO", "FILE_CONFLICT"

**Status:** ✅ **CONSISTENT** - Schema aligned across all docs

---

#### `POST /api/post_activity`
**Mentioned in:** schema.md (indirectly), vercel_app.md, mcp_planning.md, project_info.md

**Purpose:** Post high-level activity message to shared feed

**Request Schema:**
```json
{
  "user_id": "luka",
  "summary": "Starting authentication refactor",
  "scope": ["src/auth/*"],
  "intent": "WRITING"
}
```

**Response:** Success confirmation + WebSocket broadcast

**Status:** ✅ **DEFINED** - Mentioned in multiple docs, consistent purpose

---

### **Graph Management Endpoints**

#### `POST /api/generate_graph`
**Mentioned in:** vercel_app.md, project_info.md

**Purpose:** Generate/update file dependency graph from GitHub

**Request Schema:**
```json
{
  "repo_url": "https://github.com/user/repo",
  "branch": "main"
}
```

**Process:**
1. Authenticate with GitHub API
2. Fetch repository tree at HEAD
3. Filter for JS/TS/Python files
4. Parse import statements (regex, no AST)
5. Build file→file edges
6. Incremental update (compare with existing graph)
7. Overlay lock status from `coord:locks`
8. Store in `coord:graph` (KV)
9. Broadcast WebSocket `graph_update` event

**Response:**
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

**Status:** ✅ **DEFINED** - Consistent across docs, file-level only

---

#### `GET /api/graph`
**Mentioned in:** vercel_app.md, project_info.md

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

**Status:** ✅ **DEFINED** - Simple GET endpoint

---

### **Background Jobs / Cron Endpoints**

#### `GET /api/cleanup_stale_locks`
**Mentioned in:** vercel_app.md, project_info.md

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

**Notes:**
- No heartbeat mechanism (passive timeout only)
- Agent commits own work when complete
- Lock expiration only releases coordination state

**Status:** ✅ **DEFINED** - Purpose clear, 300s timeout confirmed

---

### **Chat Endpoint**

#### `POST /api/chat`
**Mentioned in:** vercel_app.md, project_info.md

**Purpose:** Post chat message for agent-to-agent communication

**Request Schema:**
```json
{
  "user_id": "luka",
  "message": "Should we refactor validateToken first?",
  "context": {
    "file": "src/auth.ts",
    "thread_id": "thread_001"
  }
}
```

**Response:** Success + WebSocket broadcast

**Status:** ✅ **DEFINED** - Optional feature for coordination

---

## **INCONSISTENCIES & CONFLICTS TO RESOLVE**

### ⚠️ 1. Endpoint Naming Conventions

**Different naming patterns found:**

- **Pattern A (vercel_app.md):**
  - `POST /api/check_status`
  - `POST /api/post_status`
  - `POST /api/post_activity`
  
- **Pattern B (mcp_planning.md - old version):**
  - `POST /api/lock` (atomic locking)
  - `GET /api/state`
  - `POST /api/heartbeat` (removed)
  
- **Pattern C (project_info.md - some sections):**
  - `POST /api/state/lock`
  - `GET /api/state/locks`
  - `POST /api/graph/generate`

**RECOMMENDATION:** Use Pattern A (flat structure, descriptive names). This is what's in schema.md and most consistent across docs.

**Action Items:**
- Standardize all references to Pattern A
- Remove Pattern B/C references from documentation

---

### ⚠️ 2. Missing Endpoints in Schema

**Endpoints mentioned in docs but NOT in schema.md:**

1. `POST /api/generate_graph` - Graph generation
2. `GET /api/graph` - Fetch graph
3. `GET /api/cleanup_stale_locks` - Background job
4. `POST /api/chat` - Chat messages

**RECOMMENDATION:** 
- **Keep:** `POST /api/generate_graph` and `GET /api/graph` (core features)
- **Keep:** `GET /api/cleanup_stale_locks` (internal cron job)
- **Optional:** `POST /api/chat` (nice-to-have, not critical for MVP)

---

### ⚠️ 3. User Identification in Requests

**Inconsistency:**
- Some examples show `user_id` in request body
- MCP server docs show user extracted from GITHUB_TOKEN via authentication

**RECOMMENDATION:**
- User should be derived from GITHUB_TOKEN authentication (implicit)
- Remove `user_id` from request bodies
- MCP server adds `x-github-username` header when forwarding to Vercel

---

## **FINAL RECOMMENDED API SURFACE**

### **Required Endpoints (MVP):**

1. ✅ `POST /api/check_status` - Check file locks before editing
2. ✅ `POST /api/post_status` - Acquire/update/release locks
3. ✅ `POST /api/post_activity` - High-level activity feed
4. ✅ `POST /api/generate_graph` - Generate dependency graph
5. ✅ `GET /api/graph` - Fetch current graph
6. ✅ `GET /api/cleanup_stale_locks` - Cron job for expired locks

### **Optional Endpoints (Post-MVP):**

7. ⭕ `POST /api/chat` - Agent chat/coordination messages

### **Removed Endpoints:**

- ❌ `POST /api/heartbeat` - Not needed (passive timeout)
- ❌ `POST /api/state/lock` - Replaced by `POST /api/post_status`
- ❌ `GET /api/state` - Replaced by `GET /api/graph`

---

## **DATA STORAGE (Vercel KV - Redis)**

### Key Patterns:

```
coord:locks          → Hash (file_path → lock JSON)
coord:activity       → List (recent activity messages)
coord:graph          → String (JSON graph structure)
coord:graph_meta     → String (SHA of repo_head from last graph update)
coord:file_shas      → Hash (file_path → git_sha)
coord:status_log     → List (historical events)
coord:chat           → List (chat messages)
```

### Lock Entry Structure:
```json
{
  "file_path": "src/auth.ts",
  "user_id": "luka",
  "user_name": "Luka",
  "status": "READING" | "WRITING",
  "agent_head": "abc123def",
  "message": "Refactoring auth",
  "timestamp": 1707321600000,
  "expiry": 1707321900000  // timestamp + 300s
}
```

**Status:** ✅ **ALIGNED** with schema.md

---

## **QUESTIONS FOR USER:**

1. **Chat endpoint:** Should we implement `POST /api/chat` for MVP or defer to post-MVP?

2. **State endpoints:** Are the alternative endpoint names (Pattern B/C) from old design iterations? Can we safely remove all references to them?

3. **Additional endpoints needed:** Are there any other endpoints needed that aren't listed here?

4. **Vercel backend implementation:** Should we start implementing these endpoints, or focus on MCP server first?
