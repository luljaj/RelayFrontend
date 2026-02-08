# About Relay

**Relay** is a real-time coordination system for multi-agent development teams. Built for the Dedalus Labs track at DevFest 2026.

## The Problem We're Solving

When multiple AI agents (or human developers) work on the same codebase simultaneously, chaos ensues:

- **Merge conflicts discovered too late** - hours of work thrown away
- **Duplicate effort** - two agents refactoring the same file
- **Stale branches** - your code is outdated before you even commit
- **Silent conflicts** - editing dependent files without knowing

Traditional version control catches these issues *after the damage is done*. Relay prevents them *before they happen*.

## How It Works

Relay adds a coordination layer on top of Git:

1. **Before editing** → Agent calls `check_status` to see if files are locked
2. **While editing** → Agent claims a `READING` or `WRITING` lock
3. **Smart orchestration** → System returns actionable commands:
   - `PULL` - your branch is stale
   - `SWITCH_TASK` - file is locked by another agent
   - `PROCEED` - you're clear to work
4. **After editing** → Agent releases lock with `OPEN` status

All coordination happens through a native **MCP (Model Context Protocol)** integration, making it work seamlessly with Claude Code, Cline, and other MCP-compatible agents.

## Core Features

- ✅ **Atomic multi-file locking** - no race conditions
- ✅ **Dependency-aware conflict detection** - catches both direct and neighbor file conflicts
- ✅ **Live dependency graphs** - visualize who's working on what, in real-time
- ✅ **Stale branch detection** - compares your HEAD against remote
- ✅ **MCP protocol integration** - first-class support for AI agents

## Tech Stack

- **Backend**: Next.js 14 + TypeScript
- **Coordination**: Vercel KV (Redis) with Lua-backed atomic locks
- **Graph Engine**: GitHub API + Octokit
- **Protocol**: MCP (Model Context Protocol) via native `/mcp` endpoint
- **Frontend**: React 18 + ReactFlow + Framer Motion

## Built for Dedalus Labs Track

Relay was specifically designed for the **Dedalus Labs track** at DevFest 2026. Our goal was to demonstrate production-ready MCP integrations that solve real agent coordination problems.

After consulting with the Dedalus Labs team about our architecture requirements (sub-5ms latency, shared state between MCP and UI), they encouraged us to use Vercel-hosted infrastructure while maintaining full MCP protocol compliance. This collaborative approach let us focus on what matters: building MCP tools that agents actually use.

## Who This Is For

- **Hackathon teams** racing against the clock with multiple agents
- **Open source projects** with distributed contributors
- **Dev teams** experimenting with AI pair programming
- **Anyone** tired of merge conflicts ruining their flow

## Quick Start

```bash
npm install
cp .env.example .env.local
# Configure your .env.local with Vercel KV and GitHub credentials
npm run dev
```

Visit `http://localhost:3000` to see the live dependency graph.

Test the MCP integration:
```bash
curl http://localhost:3000/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Repository Structure

- `app/` - Next.js UI and API routes
- `lib/` - Core coordination services (locks, graph, GitHub API)
- `mcp/` - Optional standalone Python MCP proxy
- `tests/` - Vitest test suite

See [README.md](./README.md) for comprehensive documentation, architecture details, and judging criteria.

## License

MIT - Built with ❤️ for DevFest 2026

## Links

- **Demo**: [Add deployment URL]
- **Docs**: [README.md](./README.md)
- **DevFest 2026**: [Add event link]
- **Dedalus Labs**: [Add sponsor link]

---

_"Stop fighting Git. Start coordinating."_
