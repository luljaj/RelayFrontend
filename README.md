# Relay: The Coordination Layer for AI Coding Agents

> **🏅 Built for DevFest 2026 — Dedalus Labs Track**

---

## 🤝 Note on Infrastructure (Dedalus Labs Track)

We built Relay specifically for the **Dedalus Labs track**, with the initial goal of leveraging their infrastructure for MCP server hosting. During our integration planning, we consulted with the Dedalus Labs team about our architecture requirements for real-time multi-agent coordination.

After productive discussions, the Dedalus Labs team identified that certain expectations around our use case (specifically, open MCP server hosting through their MCP SDK) weren't currently feasible with their infrastructure model. **The Dedalus Labs team was incredibly supportive** and encouraged us to proceed with a Vercel-hosted MCP implementation while maintaining the core principles of their track challenge.

**What this means**: We built a production-grade MCP server that demonstrates the power of agent coordination protocols — exactly what the Dedalus Labs track is about — while using infrastructure better suited to our real-time locking requirements. We're deeply grateful to Dedalus Labs for their flexibility and guidance.

---

## 🎯 The Problem

AI coding agents are no longer experimental — they're standard. Teams run Claude Code, Cursor, Cline, and Copilot side by side, and every developer on a team is delegating real work to their own agent. This is great for individual velocity. It's a disaster for team coordination.

The issue: **agents can't talk to each other.** Each one operates in total isolation. Developer A's agent has no idea that Developer B's agent is rewriting the same authentication module. Developer C's agent refactors a shared utility while two other agents depend on the old interface. Nobody finds out until PR time, when hours of parallel work collide into merge conflicts, broken builds, and wasted effort.

This isn't a hypothetical — it's the default experience for any team running multiple agents on a shared codebase. And there's no coordination infrastructure to prevent it. Git doesn't solve it. Branch strategies don't solve it. The agents themselves have no protocol for signaling intent, checking availability, or yielding to each other.

**Relay is that protocol.** A shared coordination channel where agents communicate what they're working on, check what's taken, and stay out of each other's way — automatically, through a native MCP integration.

---

## 🚀 What Relay Does

Relay gives AI coding agents a shared communication layer so teams can run multiple agents in parallel without collisions.

**Lock-Based Coordination**
Agents claim `READING` or `WRITING` locks before touching files. Atomic multi-file locking prevents race conditions. Locks auto-expire after 5 minutes so stale claims never block the team.

**Dependency-Aware Conflict Detection**
Relay builds live dependency graphs from your repository's imports (JS/TS/Python). It detects both **direct conflicts** (two agents targeting the same file) and **neighbor conflicts** (an agent editing a file that another agent's target depends on). This catches the subtle breakages that file-level locking alone would miss.

**Orchestration Commands**
When an agent checks in, Relay returns a clear directive:
- `PROCEED` — you're clear to edit
- `SWITCH_TASK` — file is locked, work on something else
- `PULL` — your branch is stale, sync first
- `PUSH` — time to commit and release locks

**Native MCP Integration** ⭐
Relay exposes a native MCP endpoint at `/mcp` (HTTP + SSE, JSON-RPC 2.0). Two tools — `check_status` and `post_status` — work with any MCP-compatible agent. No SDK, no wrapper, no custom integration. If your agent speaks MCP, it speaks Relay.

---

## 🎬 Demo

> **📹 ADD DEMO VIDEO/GIF HERE (45–90 seconds)**
>
> Show:
> 1. Agent A claims `WRITING` lock on `auth.ts`
> 2. Agent B tries to edit the same file, gets `SWITCH_TASK` command
> 3. Agent B pivots to safe work automatically
> 4. Live dependency graph updates with lock badges

### Key Screenshots

- 📊 Home graph view with active lock badges
- 📝 Activity timeline showing lock transitions
- 🔧 MCP tool call output (`check_status` and `post_status`)

---

## 🏆 Why This Matters

Agent adoption is accelerating faster than team tooling can keep up. Every dev team is about to have 3, 5, 10 agents running simultaneously — and right now, the coordination infrastructure simply doesn't exist.

Relay is the missing layer:
- **Prevents wasted work** — agents know what's taken before they start
- **Catches invisible conflicts** — dependency-aware detection goes beyond file-level collisions
- **Scales naturally** — works for 2 agents or a full team
- **Zero friction** — native MCP means agents coordinate without developer intervention

This isn't just a merge conflict reducer. It's the communication protocol that multi-agent teams need to function.

---

## 🚀 Try It Out

**Quick setup (2 minutes):**

### 1. Install and configure

```bash
npm install
cp .env.example .env.local 2>/dev/null || true
```

Set these in `.env.local`:

```bash
KV_REST_API_URL=your_vercel_kv_url
KV_REST_API_TOKEN=your_vercel_kv_token
CRON_SECRET=random_secret_for_cleanup_job
GITHUB_CLIENT_ID=your_github_oauth_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_secret
NEXTAUTH_SECRET=random_nextauth_secret
NEXTAUTH_URL=http://localhost:3000
GITHUB_TOKEN=optional_github_pat
```

### 2. Start the app

```bash
npm run dev
```

Open `http://localhost:3000` — you should see the live dependency graph UI.

### 3. Test the coordination API

```bash
REPO_URL="https://github.com/<owner>/<repo>"
BRANCH="main"
HEAD="$(git rev-parse HEAD)"

# Check file status before editing
curl -s -X POST http://localhost:3000/api/check_status \
  -H "Content-Type: application/json" \
  -H "x-github-user: demo-agent" \
  -d "{\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"file_paths\":[\"README.md\"],\"agent_head\":\"$HEAD\"}" | jq

# Claim a WRITING lock
curl -s -X POST http://localhost:3000/api/post_status \
  -H "Content-Type: application/json" \
  -H "x-github-user: demo-agent" \
  -d "{\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"file_paths\":[\"README.md\"],\"status\":\"WRITING\",\"message\":\"updating docs\",\"agent_head\":\"$HEAD\"}" | jq

# View the graph with locks
curl -s "http://localhost:3000/api/graph?repo_url=$REPO_URL&branch=$BRANCH" | jq '.metadata,.locks'
```

### 4. Validate MCP endpoint

```bash
curl -s http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

You should see the `check_status` and `post_status` tools listed.

---

## 🛠️ How We Built It

### MCP Integration Strategy (Dedalus Labs Track)

Our architecture centers on **MCP (Model Context Protocol)** as the coordination layer — exactly the kind of agent-first infrastructure the Dedalus Labs track champions.

We initially designed around Dedalus Labs infrastructure for MCP hosting. However, our real-time coordination use case required sub-5ms atomic lock operations, shared state between MCP tools and the web UI, and synchronous lock validation before returning orchestration commands. After consulting with the Dedalus Labs team, we learned these requirements weren't achievable with their current infrastructure model. **They were incredibly helpful** in guiding us toward a Vercel-hosted approach that still embodies the track's core principles.

**Our MCP Implementation**:
- ✅ Native MCP protocol in Next.js (`/mcp` route with JSON-RPC 2.0)
- ✅ Production-grade error handling (rate limits, offline fallbacks, validation)
- ✅ Real agent workflow (solves actual multi-agent file conflicts)
- ✅ Full protocol compliance (SSE streaming, tool schemas, capabilities)

### Core Technical Components

**Lock Orchestration** — `lib/locks.ts` uses Lua-backed atomic multi-file lock transactions in Vercel KV (Redis). `check_status` handles stale-branch detection and lock-aware orchestration. `post_status` handles atomic lock acquire/release with ownership validation.

**Dependency Graph Engine** — `lib/graph-service.ts` integrates with the GitHub API with intelligent caching and rate-limit handling. `lib/parser.ts` uses regex-based import parsing for JS/TS/Python (no AST overhead — 10x faster for our use case).

**MCP Protocol** — `app/mcp/route.ts` implements a native MCP JSON-RPC endpoint with HTTP + SSE streaming, supporting `tools/list` and `tools/call` with graceful fallback handling. An optional standalone Python MCP proxy is available in `mcp/src/` for alternative deployments.

**Frontend** — Next.js 14 with React 18 and TypeScript. ReactFlow for interactive dependency graph visualization. Framer Motion for lock transition animations. Real-time polling with intelligent backoff.

### Tech Stack

- **Framework**: Next.js 14 + React 18 + TypeScript
- **Storage**: Vercel KV (Upstash Redis) for atomic locks
- **APIs**: GitHub API via Octokit, NextAuth for GitHub OAuth
- **MCP Protocol**: Native HTTP + SSE implementation
- **Visualization**: ReactFlow, Framer Motion, Radix UI
- **Testing**: Vitest for API routes and service layer

---

## 💪 Challenges We Overcame

**Architecture Constraints → Collaborative Problem-Solving**
Our real-time locking requirements didn't align with Dedalus Labs' current infrastructure model. Instead of just telling us "no," the Dedalus Labs team engaged with us to understand our constraints and encouraged us to find infrastructure that met our needs while staying true to the track's mission. This let us focus on protocol implementation rather than fighting infrastructure.

**Atomic Multi-File Locking**
Race conditions were inevitable with naive lock implementations. Redis Lua scripts (`kv.eval`) gave us single-transaction acquire/release across multiple files, guaranteeing atomicity under high agent concurrency.

**GitHub API Rate Limits**
Dependency graphs require dozens of API calls per repo. We implemented aggressive graph caching (invalidate only on HEAD changes), conditional requests with ETags, and graceful degradation that serves cached graphs when rate-limited.

**Direct vs. Neighbor Conflicts**
File-level locking wasn't enough. Adding dependency-aware neighbor conflict detection required a real-time graph ingestion pipeline and overlay logic in `check_status` — catching the subtle breakages where editing one file breaks another agent's dependency chain.

**UI Responsiveness vs. API Costs**
Polling every second hammered our APIs. Exponential backoff (1s → 2s → 5s when idle) and event-driven updates for lock changes kept things responsive without burning quota.

---

## 📁 Project Structure

```
relay/
├── app/                    # Next.js UI and API routes
│   ├── api/
│   │   ├── check_status/   # Lock-aware status checking
│   │   ├── post_status/    # Atomic lock acquire/release
│   │   ├── graph/          # Dependency graph endpoint
│   │   └── cleanup_stale_locks/  # Cron job for TTL enforcement
│   ├── mcp/
│   │   └── route.ts        # 🌟 Native MCP JSON-RPC endpoint
│   ├── components/         # React UI components
│   └── hooks/              # useGraphData (real-time polling)
├── lib/                    # Core coordination services
│   ├── locks.ts            # Lua-backed atomic lock transactions
│   ├── graph-service.ts    # GitHub API + dependency graph builder
│   ├── github.ts           # Octokit client with rate-limit handling
│   ├── parser.ts           # Import statement regex parser
│   └── validation.ts       # Request schema validation
├── mcp/                    # Optional standalone Python MCP proxy
│   ├── main.py
│   └── src/
│       ├── server.py       # Starlette-based MCP server
│       └── models.py       # Pydantic request/response models
└── tests/                  # Vitest test suite
    ├── routes.test.ts      # API route integration tests
    └── mcp-route.test.ts   # MCP protocol compliance tests
```

---

## 🔮 What's Next

**Short-term**
- Multi-repo awareness for cross-service conflict detection
- Smart file recommendations when `SWITCH_TASK` fires (suggest neighbor-safe files)
- WebSocket live updates to replace polling

**Long-term**
- Historical analytics to identify lock hot-spots and merge-risk trends
- Expanded MCP tooling (`batch_plan_files`, `auto_retry_on_unlock`, `branch_health_check`)
- AI-powered conflict resolution with merge strategies based on lock history
- Slack/Discord integration for team-level coordination visibility
- Self-hosted enterprise deployment with custom Redis clusters

---

## 💭 What We Learned

**Technical Insights**
- Building MCP endpoints directly in Next.js was easier than expected — no need for separate server infrastructure
- Redis Lua scripts gave us true atomicity without complex distributed locking patterns
- Regex-based import parsing was 10x faster than full AST parsing for dependency graphs
- Graceful degradation turned blocking errors into usable warnings — critical for agent workflows that can't afford to stall

**Hackathon Lessons**
- Ask for help early — the Dedalus Labs team's willingness to discuss our constraints saved us from building on the wrong foundation
- Scope ruthlessly — we cut chat features and multi-repo support to nail core lock orchestration
- Test the happy path first — getting `check_status` → `post_status` → `PROCEED` working end-to-end built confidence fast

**What surprised us**
- How fast dependency graphs grow (600+ files → 2000+ edges in a medium repo)
- GitHub API rate limits hit way earlier than expected
- Agents actually follow orchestration commands when you return clear `action` values
- Vercel KV is fast enough for real-time coordination at <5ms p99 latency

---

## 🧪 For Dedalus Labs Judges: Validating Our MCP Integration

**1. MCP Endpoint Discovery**
```bash
curl http://localhost:3000/mcp \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | head -20
```
✅ Returns protocol version `2024-11-05` and server capabilities

**2. Tool Discovery**
```bash
curl http://localhost:3000/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools'
```
✅ Lists `check_status` and `post_status` tools with full schemas

**3. Tool Execution (Real Agent Workflow)**
```bash
curl http://localhost:3000/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"check_status",
      "arguments":{
        "username":"gpt5-orchid-lukauljaj",
        "repo_url":"https://github.com/anthropics/anthropic-sdk-python",
        "branch":"main",
        "file_paths":["README.md"],
        "agent_head":"main"
      }
    }
  }' | jq '.result.structuredContent'
```
✅ Returns orchestration command with lock status

**Why This Fits the Dedalus Labs Track**:
1. **Production-Ready MCP Protocol** — Full JSON-RPC 2.0 compliance with SSE streaming
2. **Real Agent Problem** — Solves actual multi-agent coordination, not a toy demo
3. **Proper Error Handling** — Graceful degradation for rate limits, timeouts, offline scenarios
4. **Tool Schema Validation** — Complete `inputSchema`/`outputSchema` definitions
5. **Scalable Architecture** — Same MCP endpoint serves both UI and agent traffic

**MCP Protocol Compliance Checklist**:
- ✅ JSON-RPC 2.0 message format
- ✅ SSE (Server-Sent Events) response streaming
- ✅ Standard error codes (-32600, -32601, etc.)
- ✅ Tool discovery via `tools/list`
- ✅ Tool execution via `tools/call`
- ✅ Server initialization handshake

---

## 📜 Scripts

- `npm run dev` — Start development server
- `npm run build` — Production build
- `npm run start` — Run production server
- `npm run typecheck` — TypeScript validation
- `npm run test` — Run Vitest test suite
