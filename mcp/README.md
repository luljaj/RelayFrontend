# relay-mcp

MCP Server for Dedalus Labs multi-agent coordination.

## Setup

```bash
uv pip install -e .
# or
python3 -m pip install -e .
```

## Environment

```bash
cp .env.example .env
```

Defaults:

- `VERCEL_API_URL=https://relay_devfest.vercel.app`
- `LOG_LEVEL=INFO`

## Run

```bash
python3 main.py
# or
python3 -m src.server
```
