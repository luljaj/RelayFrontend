# Agent Onboarding Guide

This document explains how to navigate and safely modify this codebase as a new coding agent.

## 1. Mission and Product Model

Relay coordinates multi-agent coding work by combining:

- file lock orchestration (`READING`, `WRITING`, `OPEN`)
- stale-branch detection against GitHub HEAD
- dependency graph awareness (including neighbor conflict hints)
- MCP tool access so agents can follow the same coordination contract

Core idea: before editing files, an agent should call `check_status`; while editing, it should call `post_status` with `WRITING`/`READING`; when done, it should call `post_status` with `OPEN`.

## 2. Repository Map

- `app/`: Next.js UI and API routes
- `lib/`: core coordination services (graph, locks, GitHub helpers, validation)
- `mcp/`: optional standalone Python MCP proxy server
- `tests/`: Vitest route/service tests
- `mcp/tests/`: Python tests for MCP models/tools

High-signal files:

- `app/api/check_status/route.ts`
- `app/api/post_status/route.ts`
- `app/api/graph/route.ts`
- `app/mcp/route.ts`
- `lib/locks.ts`
- `lib/graph-service.ts`
- `lib/github.ts`
- `app/hooks/useGraphData.ts`

## 3. Request and Data Flow

### Graph flow (`GET /api/graph`)

1. UI requests graph with `repo_url` and `branch`.
2. `GraphService` checks cached graph and repo HEAD.
3. If needed, it rebuilds dependency graph from GitHub tree + file contents.
4. Lock overlay and activity events are returned with graph metadata.

### Coordination flow (`POST /api/check_status`)

1. Validate payload: `repo_url`, `branch`, `file_paths`, `agent_head`.
2. Compare `agent_head` to remote branch head.
3. Collect direct locks on requested files.
4. If graph cache exists, include neighbor locks from dependency edges.
5. Return status + orchestration command:
  - `PULL` if stale
  - `SWITCH_TASK` if conflict
  - `PROCEED` otherwise

### Lock update flow (`POST /api/post_status`)

1. Validate payload and normalize identity headers.
2. For `WRITING`/`READING`, acquire atomic locks via Lua script in KV.
3. For `OPEN`, release current user locks and report orphaned dependencies.
4. Publish activity events (best effort).
5. Return orchestration output.

## 4. Lock Semantics (Critical)

- Storage key format: `locks:<normalized_repo_url>:<branch>`
- Lock TTL: 5 minutes (`LOCK_TTL_MS = 300_000`)
- Atomicity: multi-file acquire/release uses Redis Lua (`kv.eval`)
- Conflict rule: active lock by another user blocks acquisition
- Ownership rule: only lock owner can release their locks
- Cleanup: `GET /api/cleanup_stale_locks` removes expired locks (cron-protected)

## 5. MCP Surfaces

There are two MCP integration options:

1. Native MCP route in Next app: `app/mcp/route.ts` (`/mcp`)
2. Standalone Python MCP proxy: `mcp/main.py`, `mcp/src/tools.py`

Both expose tools:

- `check_status(...)`
- `post_status(...)`

The Python proxy forwards to Next API endpoints and adds resilient fallbacks for rate-limit/offline scenarios.

## 6. Local Setup (Agent Quickstart)

From repo root:

```bash
npm install
npm run dev
```

Environment variables required for full functionality:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `CRON_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- optional fallback: `GITHUB_TOKEN`

### Fast smoke checks

```bash
npm run typecheck
npm test
```

MCP route check:

```bash
curl -s http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 7. Safe Editing Protocol for Agents

When making non-trivial changes:

1. Identify target files and affected routes.
2. Check tests covering that behavior (`tests/routes.test.ts`, `tests/mcp-route.test.ts`, etc.).
3. Preserve orchestration response shape and action names.
4. Preserve lock ownership and TTL logic unless explicitly changing lock policy.
5. Update docs when endpoint behavior changes.
6. Run `npm test` and `npm run typecheck` before finalizing.

Do not break these contract fields unless planned migration exists:

- `orchestration.type`
- `orchestration.action`
- `orchestration.command`
- `orchestration.reason`

## 8. Common Failure Modes

- GitHub API quota exceeded -> 429 responses with retry metadata
- Missing/invalid env vars -> graph/auth failures
- Branch mismatch (`main` vs `master`) -> stale/lookup issues
- KV connectivity issues -> lock acquisition/release failures

## 9. Where to Add New Features

- New API behavior: `app/api/...`
- Shared coordination logic: `lib/...`
- UI updates and polling behavior: `app/components/...`, `app/hooks/useGraphData.ts`
- MCP protocol/tool additions:
  - native route: `app/mcp/route.ts`
  - optional proxy: `mcp/src/tools.py`, `mcp/src/models.py`

## 10. First 15 Minutes Checklist for a New Agent

1. Read `README.md` (project-level narrative and runbook).
2. Read `app/README.md`, `lib/README.md`, and `tests/README.md`.
3. Run app and tests locally.
4. Trace one full lock cycle through `check_status` -> `post_status`.
5. Confirm no contract changes are needed for your task.
