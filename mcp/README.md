# Relay MCP Proxy (`mcp/`)

This optional service gives teams a standalone MCP process that forwards coordination calls to the Relay Next.js backend.
Use it when your agent runtime expects a separate MCP server process.

## Demo Insert (for judges)

- Add a short clip showing:
  - MCP client calls `check_status`
  - Proxy forwards to Relay backend
  - Client receives orchestration response (`PROCEED`, `SWITCH_TASK`, etc.)

## What This Folder Does

- Registers two MCP tools: `check_status` and `post_status`
- Forwards requests to Relay API endpoints (`/api/check_status`, `/api/post_status`)
- Normalizes errors for agent-friendly behavior:
  - rate-limit response -> `OFFLINE` style fallback with clear reason
  - connectivity errors -> deterministic offline orchestration
- Includes branch fallback logic (`main` -> `master`) for older repos

## Why It Matters

Some hackathon agent stacks are easier to integrate with a dedicated MCP service than an in-app endpoint.
This folder gives that compatibility path without duplicating business logic.

## Try It Out

### 1. Install dependencies

```bash
uv sync
```

### 2. Set environment

```bash
cat > .env <<'EOF'
VERCEL_API_URL=http://localhost:3000
LOG_LEVEL=INFO
EOF
```

### 3. Run the MCP proxy

```bash
uv run python main.py
```

Server starts on `http://0.0.0.0:8000/mcp`.

### 4. Smoke test the route through your MCP client

Point your MCP client to `http://localhost:8000/mcp` and invoke:

- `check_status(username, file_paths, agent_head, repo_url, branch?)`
- `post_status(username, file_paths, status, message, agent_head, repo_url, branch?, new_repo_head?)`

Use the username schema: `(model)-(random word)-(agent owner github username)` (example: `gpt5-orchid-lukauljaj`).

## How We Built It

- `src/server.py`: thin MCP server bootstrap (`dedalus_mcp.MCPServer`)
- `src/tools.py`: HTTP bridge, error extraction, fallback behavior
- `src/models.py`: strict response models for consistency and safer tool outputs

## Challenges

- Translating HTTP/API errors into stable MCP tool outputs
- Preserving useful orchestration metadata while avoiding brittle client parsing
- Supporting mixed default branches (`main` and legacy `master`) without extra client config

## What’s Next

- Add richer telemetry for tool latency and failure modes
- Add retry/backoff configuration per tool
- Expand toolset beyond status checks (batch operations, diagnostics)
