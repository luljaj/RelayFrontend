# Relay (DevFest 2026)

Relay helps multi-agent teams stop stepping on each other while shipping code fast.
Instead of discovering merge pain at PR time, Relay surfaces conflicts early with lock-aware orchestration and a live dependency graph.

## Demo First

### Demo GIF / Video (add this before judging)

- Replace this section with a 45-90s walkthrough:
  - Agent A claims `WRITING` lock
  - Agent B gets `SWITCH_TASK` on conflicting file
  - Agent B pivots to neighbor-safe work
  - Graph view updates with lock/activity context

### Screenshots To Add

- Home graph view with active lock badges
- Activity timeline showing lock transitions
- MCP tool call output (`check_status` and `post_status`)

### Architecture Diagram (recommended)

- Add `docs/architecture.png` with:
  - Next.js UI and API routes
  - Vercel KV lock store
  - GitHub API dependency ingestion
  - Native `/mcp` endpoint + optional Python MCP proxy

## What It Does

- Builds a dependency graph from repository imports
- Lets agents claim/release `READING` and `WRITING` file locks
- Detects direct and neighbor conflicts before edits begin
- Returns actionable orchestration commands (`PULL`, `SWITCH_TASK`, `PROCEED`, `PUSH`)
- Exposes the same coordination flow through MCP tools

## Why It Matters

Hackathon teams lose time on invisible collisions: stale branches, duplicated work, and late merge conflicts.
Relay turns coordination into an API contract that agents and humans can both follow.

## Try It Out (Copy/Paste)

### 1. Install and configure

```bash
npm install
cp .env.example .env.local 2>/dev/null || true
```

Set these in `.env.local`:

```bash
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
CRON_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
NEXTAUTH_SECRET=...
NEXTAUTH_URL=http://localhost:3000
GITHUB_TOKEN=...
```

### 2. Start the app

```bash
npm run dev
```

Open `http://localhost:3000`.

### 3. Validate core flow quickly

```bash
REPO_URL="https://github.com/<owner>/<repo>"
BRANCH="main"
HEAD="$(git rev-parse HEAD)"

curl -s -X POST http://localhost:3000/api/check_status \
  -H "Content-Type: application/json" \
  -H "x-github-user: demo-agent" \
  -d "{\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"file_paths\":[\"README.md\"],\"agent_head\":\"$HEAD\"}" | jq

curl -s -X POST http://localhost:3000/api/post_status \
  -H "Content-Type: application/json" \
  -H "x-github-user: demo-agent" \
  -d "{\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"file_paths\":[\"README.md\"],\"status\":\"WRITING\",\"message\":\"updating docs\",\"agent_head\":\"$HEAD\"}" | jq

curl -s "http://localhost:3000/api/graph?repo_url=$REPO_URL&branch=$BRANCH" | jq '.metadata,.locks'
```

### 4. Validate MCP endpoint

```bash
curl -s http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

## How We Built It

- `app/api/check_status`: stale-branch detection + lock-aware orchestration
- `app/api/post_status`: atomic lock writes/releases and lifecycle updates
- `lib/locks.ts`: Lua-backed multi-file lock transactions in Vercel KV
- `lib/graph-service.ts`: dependency graph generation with GitHub API + cache/rate-limit handling
- `app/mcp/route.ts`: native MCP JSON-RPC endpoint (tool list + tool call)
- `mcp/src/tools.py`: optional Python MCP proxy with offline and rate-limit fallbacks

## APIs and Frameworks Used

- Next.js 14 + React 18 + TypeScript
- Vercel KV (Upstash Redis)
- GitHub API via Octokit
- NextAuth (GitHub OAuth)
- MCP protocol (streamable HTTP style)

## Challenges We Hit

- Keeping lock updates atomic across multiple files without race conditions
- Handling GitHub API quota/rate-limit windows gracefully
- Distinguishing direct conflicts from dependency-neighbor conflicts
- Keeping UI polling responsive without turning into API spam

## Project Structure

- `app/` UI, MCP endpoint, and API routes
- `lib/` lock, graph, GitHub, parser, and validation services
- `mcp/` standalone Python MCP server (optional deployment mode)
- `tests/` route and service tests (Vitest)

## Team Roles (fill in)

- `Name A`: coordination backend + lock orchestration
- `Name B`: graph UI + interaction design
- `Name C`: MCP integration + agent workflow testing

## What’s Next

- Multi-repo awareness and cross-repo conflict hints
- Smarter file recommendation when `SWITCH_TASK` is returned
- Historical analytics for lock hot-spots and merge-risk trends
- More MCP tools (batch planning, auto-retry policies, branch health)

## Scripts

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm run typecheck`
- `npm run test`
