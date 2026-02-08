# MCP_MERGE: Integration Plan — MCP Server ↔ Vercel App

> Deep implementation plan for wiring the Python MCP server (`mcp/`) into the live
> Next.js + Vercel KV backend. Every delta between the two systems is catalogued,
> and every fix is specified with file paths, code-level diffs, and sequencing.

---

## 0. Executive Summary

| Layer | What Exists | Status |
|---|---|---|
| **Vercel App** (Next.js 14, Vercel KV) | `POST /api/check_status`, `POST /api/post_status`, `GET /api/graph`, `GET /api/cleanup_stale_locks`, frontend dashboard | **Deployed & functional** |
| **MCP Server** (Python, `dedalus-mcp`) | `check_status` tool, `post_status` tool, Pydantic models, httpx client | **Scaffolded, not yet wired** |

**Core Problem:** The MCP server is designed to be a thin HTTP proxy — agents call
MCP tools, MCP forwards to Vercel API, Vercel returns orchestration commands. But
the two sides were built from slightly different spec snapshots. There are **schema
mismatches, missing headers, absent features, and response shape deltas** that will
cause runtime failures the moment a real agent calls through.

**Goal of this plan:** Bring both sides into strict contract alignment so that:
1. An agent calling `check_status` / `post_status` via MCP gets back a valid, actionable response.
2. The Vercel frontend dashboard reflects MCP-originating lock activity in real time.
3. No breaking changes to the existing frontend polling contract (`GET /api/graph`).

---

## 1. Contract Mismatches (The Full Audit)

### 1.1 Header Mismatch — Identity Propagation

**MCP sends:**
```python
# mcp/src/tools.py line 43
headers={"x-github-username": user.login}
```

**Vercel reads:**
```typescript
// app/api/post_status/route.ts line 48-49
const userId = request.headers.get('x-github-user') || 'anonymous';
const userName = request.headers.get('x-github-username') || 'Anonymous';
```

**Problem:** MCP only sends `x-github-username` (the login/display name). Vercel
uses `x-github-user` for `userId` (the lock owner identity used in conflict checks)
and `x-github-username` for `userName` (display only). Since MCP never sends
`x-github-user`, every lock created via MCP will have `user_id: "anonymous"` —
meaning **no agent can ever release its own locks** and **conflict detection between
agents is broken** (all agents appear as the same "anonymous" user).

**Fix (both sides):**

A) **MCP side** — send both headers:
```python
# mcp/src/tools.py — in both check_status and post_status
headers={
    "x-github-user": user.login,      # identity for lock ownership
    "x-github-username": user.name or user.login,  # display name
}
```

B) **Vercel side** — fallback chain for resilience:
```typescript
// app/api/post_status/route.ts
const userId = request.headers.get('x-github-user')
  || request.headers.get('x-github-username')
  || 'anonymous';
const userName = request.headers.get('x-github-username')
  || request.headers.get('x-github-user')
  || 'Anonymous';
```

This ensures that even if only one header arrives, the system still functions.

---

### 1.2 `check_status` Response Shape — Lock Entry Fields

**MCP expects** (from `mcp/src/models.py`):
```python
class LockEntry(BaseModel):
    user: str
    status: Literal["READING", "WRITING"]
    lock_type: Literal["DIRECT", "NEIGHBOR"]
    timestamp: float
    message: Optional[str] = None
```

**Vercel returns** (from `lib/locks.ts` `LockEntry`):
```json
{
  "file_path": "src/auth.ts",
  "user_id": "jane",
  "user_name": "Jane",
  "status": "WRITING",
  "agent_head": "abc123",
  "message": "Refactoring auth",
  "timestamp": 1707321600000,
  "expiry": 1707321900000
}
```

**Deltas:**
| Field | MCP Model | Vercel Reality | Impact |
|---|---|---|---|
| `user` | expected | not present | Pydantic validation **FAILS** |
| `user_id` | not expected | present | ignored |
| `user_name` | not expected | present | ignored |
| `lock_type` | expected (`DIRECT`/`NEIGHBOR`) | **never sent** | Pydantic validation **FAILS** |
| `file_path` | not expected | present | ignored |
| `agent_head` | not expected | present | ignored |
| `expiry` | not expected | present | ignored |
| `message` | Optional | present | OK |

**Impact:** Every `check_status` call with active locks will crash with a Pydantic
`ValidationError` because `user` and `lock_type` are missing.

**Fix (two-pronged):**

A) **Vercel side** — enrich lock entries in `check_status` response to include
MCP-expected fields:

```typescript
// app/api/check_status/route.ts — transform locks before returning
const enrichedLocks: Record<string, unknown> = {};
for (const [filePath, lock] of Object.entries(locks)) {
  enrichedLocks[filePath] = {
    ...lock,
    user: lock.user_id,         // alias for MCP compat
    lock_type: 'DIRECT',        // all returned locks are DIRECT (requested files)
  };
}
```

B) **MCP side** — make model more tolerant of extra fields and flexible field names:

```python
class LockEntry(BaseModel):
    model_config = ConfigDict(extra='ignore')

    user: Optional[str] = None
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    status: Literal["READING", "WRITING"]
    lock_type: Optional[Literal["DIRECT", "NEIGHBOR"]] = "DIRECT"
    timestamp: float
    message: Optional[str] = None

    @model_validator(mode='after')
    def resolve_user(self) -> 'LockEntry':
        if not self.user and self.user_id:
            self.user = self.user_id
        return self
```

---

### 1.3 `check_status` — Missing NEIGHBOR Lock Detection

**Spec says** (`schema.md`): When you `check_status` on `["src/auth.ts"]`, the
response should also include NEIGHBOR locks — i.e., locks on files that `src/auth.ts`
imports or is imported by.

**Vercel reality** (`app/api/check_status/route.ts` line 42):
```typescript
const locks = await checkLocks(repoUrl, branch, filePaths);
```
This only checks the **exact files requested** — no graph traversal for neighbors.

**Fix — add neighbor lock detection to Vercel:**

```typescript
// app/api/check_status/route.ts — after getting direct locks

// Get dependency graph for neighbor detection
const graphService = new GraphService(repoUrl, branch);
const cachedGraph = await graphService.getCached();

const allLocks = await getLocks(repoUrl, branch);
const enrichedLocks: Record<string, unknown> = {};

// Direct locks (files the agent asked about)
for (const filePath of filePaths) {
  if (allLocks[filePath]) {
    enrichedLocks[filePath] = {
      ...allLocks[filePath],
      user: allLocks[filePath].user_id,
      lock_type: 'DIRECT',
    };
  }
}

// Neighbor locks (dependencies/dependents of requested files)
if (cachedGraph) {
  const neighborPaths = new Set<string>();

  for (const filePath of filePaths) {
    // Files that filePath imports
    for (const edge of cachedGraph.edges) {
      if (edge.source === filePath && !filePaths.includes(edge.target)) {
        neighborPaths.add(edge.target);
      }
      // Files that import filePath
      if (edge.target === filePath && !filePaths.includes(edge.source)) {
        neighborPaths.add(edge.source);
      }
    }
  }

  for (const neighborPath of neighborPaths) {
    if (allLocks[neighborPath] && !enrichedLocks[neighborPath]) {
      enrichedLocks[neighborPath] = {
        ...allLocks[neighborPath],
        user: allLocks[neighborPath].user_id,
        lock_type: 'NEIGHBOR',
      };
    }
  }
}
```

**Complexity:** This is the single most impactful Vercel-side change. It requires
importing `GraphService` into `check_status` and reading the cached graph (no
regeneration — just a KV read). Cost is one extra `kv.get()` call per request.

---

### 1.4 `post_status` — Missing `orphaned_dependencies`

**Spec says** (`schema.md`): When releasing locks (`status: "OPEN"`), the response
should include `orphaned_dependencies` — file paths that depend on the released files.

**Vercel reality** (`app/api/post_status/route.ts` line 73):
```typescript
orphaned_dependencies: [],  // hardcoded empty
```

**Fix:**
```typescript
// app/api/post_status/route.ts — in the OPEN handler, before returning
const graphService = new GraphService(repoUrl, branch);
const cachedGraph = await graphService.getCached();

let orphanedDeps: string[] = [];
if (cachedGraph) {
  const depSet = new Set<string>();
  for (const releasedFile of filePaths) {
    for (const edge of cachedGraph.edges) {
      // Files that import the released file
      if (edge.target === releasedFile) {
        depSet.add(edge.source);
      }
    }
  }
  // Remove the released files themselves
  for (const fp of filePaths) depSet.delete(fp);
  orphanedDeps = Array.from(depSet);
}
```

---

### 1.5 `post_status` Response — Missing `orchestration.type`

**MCP expects** (from `mcp/src/models.py`):
```python
class OrchestrationCommand(BaseModel):
    type: Literal["orchestration_command"] = "orchestration_command"
    action: OrchestrationAction
    ...
```

**Vercel returns:**
```json
{
  "orchestration": {
    "action": "PROCEED",
    "command": null,
    "reason": "..."
  }
}
```

**No `type` field.** Pydantic has a default so this won't crash, but it's a spec
inconsistency.

**Fix (Vercel side):** Add `type: "orchestration_command"` to all orchestration
objects in both `check_status` and `post_status` routes. This is a simple find-and-
replace: wherever `orchestration: {` appears, add the `type` field.

---

### 1.6 `check_status` — Vercel Doesn't Send `user_id` Filter

**MCP sends** username in headers, but `check_status` doesn't use it. The response
includes ALL locks on requested files, including the requesting user's own locks.

**Potential issue:** An agent checking status on files it already locked will get
`status: "CONFLICT"` against itself.

**Fix (Vercel side):** Filter out the requester's own locks when determining conflict
status:

```typescript
// app/api/check_status/route.ts
const requestingUser = request.headers.get('x-github-user')
  || request.headers.get('x-github-username')
  || '';

// ... after getting locks ...
const conflictingLocks: Record<string, LockEntry> = {};
for (const [fp, lock] of Object.entries(locks)) {
  if (lock.user_id !== requestingUser) {
    conflictingLocks[fp] = lock;
  }
}

// Use conflictingLocks for status determination, but return all locks in response
let status = 'OK';
if (isStale) status = 'STALE';
if (Object.keys(conflictingLocks).length > 0) status = 'CONFLICT';
```

Still return ALL locks (including own) in the response body — the MCP/agent should
see everything. But status should only be CONFLICT for *other users'* locks.

---

### 1.7 MCP Default URL Mismatch

**MCP `tools.py`:**
```python
VERCEL_URL = os.getenv("VERCEL_API_URL", "https://relay_devfest.vercel.app")
```

**MCP `README.md`:**
```
VERCEL_API_URL=https://relay_devfest.vercel.app
```

**Actual deployed URL:** Needs to match wherever the Vercel app is actually deployed.
Underscores in Vercel subdomains are atypical (usually hyphens).

**Fix:** Verify actual deployment URL and update both the default in `tools.py` and
`README.md`. The `.env` file should be the canonical source.

---

## 2. Implementation Phases

### Phase 1: Contract Alignment (Vercel API Fixes)

Priority: **CRITICAL** — nothing works without these.

| # | File | Change | Complexity |
|---|---|---|---|
| 1.1 | `app/api/post_status/route.ts` | Fallback chain for `x-github-user` / `x-github-username` headers | Low |
| 1.2 | `app/api/check_status/route.ts` | Same header fallback chain (read requesting user identity) | Low |
| 1.3 | `app/api/check_status/route.ts` | Add `user` and `lock_type: "DIRECT"` aliases to lock entries in response | Low |
| 1.4 | `app/api/check_status/route.ts` | Add `type: "orchestration_command"` to orchestration object | Low |
| 1.5 | `app/api/post_status/route.ts` | Add `type: "orchestration_command"` to all orchestration objects | Low |
| 1.6 | `app/api/check_status/route.ts` | Filter own locks from conflict determination | Medium |

### Phase 2: Neighbor-Aware Lock Detection (Vercel)

Priority: **HIGH** — spec compliance, enables smarter agent behavior.

| # | File | Change | Complexity |
|---|---|---|---|
| 2.1 | `app/api/check_status/route.ts` | Import `GraphService`, read cached graph, compute NEIGHBOR locks | Medium |
| 2.2 | `app/api/check_status/route.ts` | Tag neighbor locks with `lock_type: "NEIGHBOR"` | Low |

### Phase 3: Orphaned Dependencies (Vercel)

Priority: **MEDIUM** — nice-to-have for agent intelligence.

| # | File | Change | Complexity |
|---|---|---|---|
| 3.1 | `app/api/post_status/route.ts` | Import `GraphService`, compute orphaned deps on OPEN | Medium |

### Phase 4: MCP Server Hardening

Priority: **HIGH** — the MCP side must tolerate the real API responses.

| # | File | Change | Complexity |
|---|---|---|---|
| 4.1 | `mcp/src/tools.py` | Send both `x-github-user` and `x-github-username` headers | Low |
| 4.2 | `mcp/src/models.py` | Make `LockEntry` tolerant: `extra='ignore'`, optional `lock_type`, `user`/`user_id` aliasing | Medium |
| 4.3 | `mcp/src/models.py` | Make `CheckStatusResponse` use `model_config = ConfigDict(extra='ignore')` | Low |
| 4.4 | `mcp/src/models.py` | Make `PostStatusResponse` use `model_config = ConfigDict(extra='ignore')` | Low |
| 4.5 | `mcp/src/tools.py` | Handle HTTP 429 (rate limit) from Vercel gracefully | Low |
| 4.6 | `mcp/src/tools.py` | Handle HTTP 400 (validation error) with descriptive error | Low |
| 4.7 | `mcp/src/auth.py` | Populate `name` from `username` so headers have a display name | Low |
| 4.8 | `mcp/README.md` | Verify and correct `VERCEL_API_URL` default | Low |

### Phase 5: End-to-End Validation

Priority: **HIGH** — cannot ship without testing the full path.

| # | Task | Detail |
|---|---|---|
| 5.1 | Integration test: `check_status` | MCP → Vercel → Redis → response validates in Pydantic |
| 5.2 | Integration test: `post_status` WRITING | Lock acquired, visible on frontend graph |
| 5.3 | Integration test: `post_status` OPEN | Lock released, orphaned deps returned |
| 5.4 | Integration test: conflict detection | Two agents locking same file → SWITCH_TASK |
| 5.5 | Integration test: stale repo | Agent behind HEAD → PULL command |
| 5.6 | Frontend verification | Locks created via MCP show user name (not "Anonymous") |

---

## 3. Detailed Code Changes

### 3.1 Vercel: `app/api/check_status/route.ts` (Full Rewrite of Response Section)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import {
  getGitHubQuotaErrorMessage,
  getGitHubQuotaResetMs,
  getRepoHeadCached,
  isGitHubQuotaError,
  parseRepoUrl,
} from '@/lib/github';
import { getLocks } from '@/lib/locks';
import { GraphService } from '@/lib/graph-service';
import { getMissingFields, isNonEmptyString, normalizeFilePaths, toBodyRecord } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = toBodyRecord(await request.json());
    const missing = getMissingFields(body, ['repo_url', 'branch', 'file_paths', 'agent_head']);

    if (missing.length > 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const repoUrl = body.repo_url;
    const branch = body.branch;
    const filePaths = normalizeFilePaths(body.file_paths);
    const agentHead = body.agent_head;

    if (
      !isNonEmptyString(repoUrl) ||
      !isNonEmptyString(branch) ||
      !isNonEmptyString(agentHead) ||
      !filePaths ||
      filePaths.length === 0
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Read requesting user for self-lock filtering
    const requestingUser =
      request.headers.get('x-github-user') ||
      request.headers.get('x-github-username') ||
      '';

    const { owner, repo } = parseRepoUrl(repoUrl);
    const repoHead = await getRepoHeadCached(owner, repo, branch);
    const isStale = agentHead !== repoHead;

    // Get ALL active locks for the repo
    const allLocks = await getLocks(repoUrl, branch);

    // Build enriched lock map with DIRECT locks
    const enrichedLocks: Record<string, unknown> = {};
    const filePathSet = new Set(filePaths);

    for (const filePath of filePaths) {
      if (allLocks[filePath]) {
        enrichedLocks[filePath] = {
          ...allLocks[filePath],
          user: allLocks[filePath].user_id,
          lock_type: 'DIRECT',
        };
      }
    }

    // NEIGHBOR lock detection via cached graph
    try {
      const graphService = new GraphService(repoUrl, branch);
      const cachedGraph = await graphService.getCached();

      if (cachedGraph) {
        const neighborPaths = new Set<string>();
        for (const filePath of filePaths) {
          for (const edge of cachedGraph.edges) {
            if (edge.source === filePath && !filePathSet.has(edge.target)) {
              neighborPaths.add(edge.target);
            }
            if (edge.target === filePath && !filePathSet.has(edge.source)) {
              neighborPaths.add(edge.source);
            }
          }
        }
        for (const neighborPath of neighborPaths) {
          if (allLocks[neighborPath] && !enrichedLocks[neighborPath]) {
            enrichedLocks[neighborPath] = {
              ...allLocks[neighborPath],
              user: allLocks[neighborPath].user_id,
              lock_type: 'NEIGHBOR',
            };
          }
        }
      }
    } catch {
      // Graph unavailable — skip neighbor detection, not critical
    }

    // Determine conflict status (exclude own locks)
    const conflictingLockCount = Object.values(enrichedLocks).filter(
      (lock: any) => lock.user_id !== requestingUser
    ).length;

    let status = 'OK';
    if (isStale) status = 'STALE';
    if (conflictingLockCount > 0) status = 'CONFLICT';

    let orchestration = {
      type: 'orchestration_command',
      action: 'PROCEED',
      command: null as string | null,
      reason: '',
    };

    if (isStale) {
      orchestration = {
        type: 'orchestration_command',
        action: 'PULL',
        command: 'git pull --rebase',
        reason: `Your local repo is behind. Current HEAD: ${repoHead}`,
      };
    } else if (conflictingLockCount > 0) {
      const firstConflict = Object.entries(enrichedLocks).find(
        ([, lock]: [string, any]) => lock.user_id !== requestingUser
      );
      if (firstConflict) {
        const [fp, lock] = firstConflict as [string, any];
        orchestration = {
          type: 'orchestration_command',
          action: 'SWITCH_TASK',
          command: null,
          reason: `File '${fp}' is locked by ${lock.user_name} (${lock.lock_type})`,
        };
      }
    }

    return NextResponse.json({
      status,
      repo_head: repoHead,
      locks: enrichedLocks,
      warnings: isStale ? [`STALE_BRANCH: Your branch is behind origin/${branch}`] : [],
      orchestration,
    });
  } catch (error) {
    if (isGitHubQuotaError(error)) {
      const retryAtMs = getGitHubQuotaResetMs(error);
      return NextResponse.json(
        {
          error: 'GitHub API rate limit exceeded',
          details: getGitHubQuotaErrorMessage(error),
          retry_after_ms: retryAtMs ?? undefined,
        },
        { status: 429 },
      );
    }

    const details = error instanceof Error ? error.message : 'Unknown error';
    console.error('check_status error:', error);
    return NextResponse.json({ error: 'Internal server error', details }, { status: 500 });
  }
}
```

### 3.2 Vercel: `app/api/post_status/route.ts` (Key Diff Areas)

**Header fallback (lines 48-49):**
```typescript
const userId =
  request.headers.get('x-github-user') ||
  request.headers.get('x-github-username') ||
  'anonymous';
const userName =
  request.headers.get('x-github-username') ||
  request.headers.get('x-github-user') ||
  'Anonymous';
```

**Add `type` to all orchestration objects:**
Every `orchestration: { action: ... }` gets `type: 'orchestration_command'` added.

**Compute orphaned dependencies in OPEN handler:**
```typescript
if (status === 'OPEN') {
  // ... existing release logic ...

  // Compute orphaned dependencies
  let orphanedDeps: string[] = [];
  try {
    const graphService = new GraphService(repoUrl, branch);
    const cachedGraph = await graphService.getCached();
    if (cachedGraph) {
      const depSet = new Set<string>();
      for (const releasedFile of filePaths) {
        for (const edge of cachedGraph.edges) {
          if (edge.target === releasedFile) {
            depSet.add(edge.source);
          }
        }
      }
      for (const fp of filePaths) depSet.delete(fp);
      orphanedDeps = Array.from(depSet);
    }
  } catch {
    // Graph unavailable — return empty array
  }

  return NextResponse.json({
    success: true,
    orphaned_dependencies: orphanedDeps,
    orchestration: {
      type: 'orchestration_command',
      action: 'PROCEED',
      command: null,
      reason: 'Locks released successfully',
    },
  });
}
```

### 3.3 MCP: `mcp/src/models.py` (Resilient Models)

```python
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, model_validator


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
        """Ensure `user` is populated from `user_id` if not provided directly."""
        if not self.user and self.user_id:
            self.user = self.user_id
        if not self.user and self.user_name:
            self.user = self.user_name
        return self


class CheckStatusResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: Literal["OK", "STALE", "CONFLICT", "OFFLINE"]
    repo_head: str
    locks: Dict[str, LockEntry] = {}
    warnings: List[str] = []
    orchestration: Optional[OrchestrationCommand] = None


class PostStatusResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    success: bool
    orphaned_dependencies: List[str] = []
    orchestration: Optional[OrchestrationCommand] = None
```

### 3.4 MCP: `mcp/src/tools.py` (Header Fix + Error Handling)

Key changes:
```python
# Both tools — updated headers
headers={
    "x-github-user": user.login,
    "x-github-username": user.name if user.name != "Unknown" else user.login,
}

# check_status — add 429 handling
if resp.status_code == 429:
    return CheckStatusResponse(
        status="OFFLINE",
        repo_head="unknown",
        locks={},
        warnings=["RATE_LIMITED: GitHub API quota exhausted on Vercel"],
        orchestration=OrchestrationCommand(
            action=OrchestrationAction.STOP,
            reason="Rate limited — retry later",
        ),
    ).model_dump()

# post_status — add 429 handling
if resp.status_code == 429:
    return PostStatusResponse(
        success=False,
        orchestration=OrchestrationCommand(
            action=OrchestrationAction.STOP,
            reason="Rate limited — retry later",
        ),
    ).model_dump()
```

### 3.5 MCP: `mcp/src/auth.py` (Name Propagation)

```python
from dataclasses import dataclass


@dataclass
class AuthenticatedUser:
    login: str
    name: str = ""
    email: str = ""

    def __post_init__(self):
        if not self.name:
            self.name = self.login


def get_user_from_username(username: str) -> AuthenticatedUser:
    """
    Simple user object from username.
    In production, this would integrate with Dedalus OAuth when available.
    """
    return AuthenticatedUser(login=username, name=username)
```

---

## 4. Data Flow After Merge (Complete Path)

```
Agent (Claude/GPT in Cursor)
  │
  │  calls MCP tool: check_status(username="luka", file_paths=["src/auth.ts"], ...)
  ▼
MCP Server (Python, dedalus-mcp)
  │  POST https://<vercel-url>/api/check_status
  │  Headers: x-github-user: luka, x-github-username: luka
  │  Body: { file_paths: ["src/auth.ts"], agent_head: "abc123", repo_url: "...", branch: "main" }
  ▼
Vercel API Route (check_status/route.ts)
  │  1. Reads x-github-user header → requestingUser = "luka"
  │  2. Fetches repo HEAD from GitHub (cached 20s)
  │  3. Gets ALL locks from Redis (getLocks)
  │  4. Identifies DIRECT locks on requested files
  │  5. Reads cached graph → finds NEIGHBOR locks
  │  6. Filters own locks from conflict determination
  │  7. Returns enriched response with lock_type tags
  ▼
MCP Server
  │  Validates response with Pydantic (CheckStatusResponse)
  │  Returns dict to agent
  ▼
Agent
  │  Reads orchestration.action
  │  PROCEED → continue with edits
  │  PULL → runs git pull --rebase
  │  SWITCH_TASK → picks a different file
```

```
Agent
  │  calls MCP tool: post_status(username="luka", file_paths=["src/auth.ts"],
  │                               status="WRITING", message="Refactoring auth", ...)
  ▼
MCP Server
  │  POST /api/post_status
  │  Headers: x-github-user: luka, x-github-username: luka
  ▼
Vercel API Route (post_status/route.ts)
  │  1. Reads userId from headers → "luka"
  │  2. Validates agent_head == repo HEAD
  │  3. Atomic lock acquisition via Redis Lua script
  │  4. Returns orchestration command
  ▼
MCP → Agent: { success: true, orchestration: { action: "PROCEED" } }

  ... Agent edits files, commits, pushes ...

Agent
  │  calls MCP tool: post_status(status="OPEN", new_repo_head="def456", ...)
  ▼
Vercel
  │  1. Releases locks in Redis
  │  2. Computes orphaned_dependencies from graph
  │  3. Returns list of files that depend on released files
  ▼
Frontend Dashboard (polling GET /api/graph every 30s)
  │  Sees lock disappear → activity feed shows "luka released lock on src/auth.ts"
```

---

## 5. Frontend Impact Assessment

**The frontend is NOT broken by any of these changes.** Here's why:

| Frontend Contract | Change Impact |
|---|---|
| `GET /api/graph` response shape | **Unchanged.** Graph generation and lock overlay are untouched. |
| `locks` object in graph response | **Unchanged.** `getLocks()` return shape in `lib/locks.ts` is the same. |
| `useGraphData` hook | **Unchanged.** It only calls `GET /api/graph`. |
| Activity detection (`captureActivity`) | **Unchanged.** It diffs `locks` objects which keep the same shape. |
| Lock colors in `FileNode` | **Works.** Locks created via MCP will now have real `user_name` instead of "Anonymous". |

**One improvement the frontend gets for free:** Locks created through MCP will show
the agent's actual username in the sidebar and on graph nodes, instead of "Anonymous".

---

## 6. Testing Strategy

### Unit Tests (Vercel)

Add to `tests/routes.test.ts`:

```typescript
describe('POST /api/check_status — MCP compatibility', () => {
  it('returns lock_type DIRECT for requested files', async () => { ... });
  it('returns lock_type NEIGHBOR for dependency locks', async () => { ... });
  it('returns user field aliased from user_id', async () => { ... });
  it('includes type: orchestration_command', async () => { ... });
  it('does not report CONFLICT for own locks', async () => { ... });
  it('falls back x-github-user from x-github-username', async () => { ... });
});

describe('POST /api/post_status — MCP compatibility', () => {
  it('returns orphaned_dependencies on OPEN', async () => { ... });
  it('includes type: orchestration_command', async () => { ... });
  it('reads userId from x-github-username fallback', async () => { ... });
});
```

### Unit Tests (MCP)

Add `mcp/tests/test_models.py`:

```python
def test_lock_entry_from_vercel_response():
    """Vercel returns user_id, not user. Model should handle it."""
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

def test_lock_entry_without_lock_type():
    """If Vercel somehow doesn't send lock_type, default to DIRECT."""
    data = {"user_id": "bob", "status": "READING", "timestamp": 123}
    entry = LockEntry(**data)
    assert entry.lock_type == "DIRECT"
    assert entry.user == "bob"

def test_check_status_response_extra_fields():
    """Response should not crash on extra fields from Vercel."""
    data = {
        "status": "OK",
        "repo_head": "abc123",
        "locks": {},
        "warnings": [],
        "orchestration": {"action": "PROCEED", "reason": "All clear"},
        "some_future_field": True,
    }
    resp = CheckStatusResponse(**data)
    assert resp.status == "OK"
```

### Manual E2E Test Script

```bash
# 1. Start MCP server locally
cd mcp && python3 main.py &

# 2. Test check_status through MCP
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check_status",
      "arguments": {
        "username": "test-agent",
        "file_paths": ["src/auth.ts"],
        "agent_head": "<current-head-sha>",
        "repo_url": "https://github.com/<owner>/<repo>",
        "branch": "main"
      }
    },
    "id": 1
  }'

# 3. Test post_status WRITING through MCP
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "post_status",
      "arguments": {
        "username": "test-agent",
        "file_paths": ["src/auth.ts"],
        "status": "WRITING",
        "message": "Integration test — refactoring auth",
        "agent_head": "<current-head-sha>",
        "repo_url": "https://github.com/<owner>/<repo>",
        "branch": "main"
      }
    },
    "id": 2
  }'

# 4. Verify on frontend dashboard — lock should appear with user "test-agent"

# 5. Test post_status OPEN (release)
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "post_status",
      "arguments": {
        "username": "test-agent",
        "file_paths": ["src/auth.ts"],
        "status": "OPEN",
        "message": "Done with auth refactor",
        "agent_head": "<current-head-sha>",
        "repo_url": "https://github.com/<owner>/<repo>",
        "branch": "main"
      }
    },
    "id": 3
  }'
```

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Neighbor detection adds latency to `check_status` | Medium | Low (one extra KV read, ~50ms) | Graph read is from cache only, no GitHub API call |
| Pydantic model changes break existing MCP tests | Low | Low | Models are being made *more* permissive, not restrictive |
| `orchestration.type` field breaks frontend | None | None | Frontend never reads `orchestration` from these endpoints |
| `orphaned_dependencies` computation incorrect | Low | Low | It's informational only — agent uses it as guidance, not hard constraint |
| Auth header fallback creates identity confusion | Low | Medium | Document that `x-github-user` is canonical; `x-github-username` is fallback only |

---

## 8. Sequencing & Dependencies

```
Phase 1 (Contract Alignment)     ← No dependencies, start immediately
  ├── 1.1-1.6 Vercel changes     ← Can be done in a single PR
  │
Phase 4 (MCP Hardening)          ← Independent of Phase 1, can run in parallel
  ├── 4.1-4.8 MCP changes        ← Single PR in mcp/ directory
  │
Phase 2 (Neighbor Detection)     ← Depends on Phase 1 (needs header fix)
  ├── 2.1-2.2 Vercel changes     ← Same PR as Phase 1 or follow-up
  │
Phase 3 (Orphaned Deps)          ← Depends on Phase 1
  ├── 3.1 Vercel change          ← Same PR as Phase 2
  │
Phase 5 (E2E Validation)         ← Depends on Phases 1-4
  ├── 5.1-5.6 Tests              ← Run after both PRs merge
```

**Recommended PR Structure:**
1. **PR #1:** Vercel contract alignment + neighbor detection + orphaned deps (Phases 1-3)
2. **PR #2:** MCP model hardening + header fix (Phase 4)
3. **PR #3:** Integration tests (Phase 5)

---

## 9. Open Questions

1. **Vercel deployment URL:** What is the actual production URL? The MCP defaults to
   `relay_devfest.vercel.app` — is this correct?

2. **Cron schedule:** `vercel.json` has cleanup running at `0 3 * * *` (once daily at
   3 AM). The spec says every 1 minute (`* * * * *`). Which is intended? With 5-minute
   lock TTL, daily cleanup means abandoned locks persist for up to 24 hours until
   the next check. If agents are actively using MCP, the cron should be
   `*/1 * * * *` (every minute).

3. **MCP authentication roadmap:** Currently `username` is a plain string parameter.
   When Dedalus OAuth ships, the MCP `auth.py` should be updated to extract identity
   from `get_context().request_context.credentials`. Is there a timeline for this?

4. **Rate limit coordination:** Both `check_status` and `post_status` call
   `getRepoHeadCached` which hits GitHub API. With multiple agents polling frequently,
   the 5000 req/hour limit could be reached. The 20-second cache helps, but should we
   add a shared rate-limit counter in Redis?

5. **`check_status` in `post_status` flow:** Should `post_status` also read the
   requesting user from headers and add self-lock filtering? Currently if an agent
   that already holds a WRITING lock re-issues `post_status` on the same file (to
   extend the lock), the Lua script allows it (same `user_id`). This is correct
   behavior, but depends on the headers being set correctly (Phase 1/4 fixes).
