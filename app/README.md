# App Layer (`app/`)

This folder contains the product surface judges will experience first: the live graph UI and the coordination API routes.

## Demo and Screenshots (add before judging)

- Demo clip idea:
  - Open UI
  - select repo
  - trigger refresh
  - show conflict surfaced in activity panel
- Screenshot list:
  - graph canvas with lock state
  - sidebar timeline activity
  - admin panel import/export graph workflow

## What It Does

- Renders an interactive dependency graph UI
- Polls backend graph state and lock activity
- Exposes coordination APIs:
  - `GET /api/graph`
  - `POST /api/check_status`
  - `POST /api/post_status`
  - `GET /api/cleanup_stale_locks`
- Exposes native MCP endpoint: `POST /mcp` and `GET /mcp` (SSE handshake)
- Supports GitHub OAuth repo selection with NextAuth

## Why It Matters

This is where coordination becomes visible and actionable.
Instead of abstract lock data in Redis, teams see who is editing what and what to do next.

## Try It Out (App-only)

From repository root:

```bash
npm run dev
```

Then:

```bash
open http://localhost:3000
```

API quick check:

```bash
curl -s "http://localhost:3000/api/graph?repo_url=https://github.com/<owner>/<repo>&branch=main" | jq '.metadata'
```

## How We Built It

- `page.tsx`: layout orchestration for graph, sidebar, and admin controls
- `hooks/useGraphData.ts`: polling, import/export JSON flow, retry behavior
- `api/check_status/route.ts`: stale head + direct/neighbor conflict detection
- `api/post_status/route.ts`: lock lifecycle and orchestration actions
- `mcp/route.ts`: MCP protocol support on the same deployment surface

## Challenges

- Balancing frequent updates with API quota limits
- Making conflict status readable in under a few seconds
- Keeping MCP behavior and HTTP API behavior aligned

## What’s Next

- Add richer conflict explanations in the UI
- Add “suggested next files” when users are blocked
- Add deeper timeline filters for faster debugging during team sprints
