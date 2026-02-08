# Core Services (`lib/`)

This folder holds the coordination engine: graph generation, lock orchestration, GitHub integration, and request validation.

## Diagram Request (add before judging)

- Add a focused backend diagram here showing:
  - `graph-service` -> GitHub API + KV cache
  - `locks` -> Redis/Lua atomic operations
  - `validation` -> route guardrails
  - `activity` -> event timeline pipeline

## What It Does

- Parses repository imports and resolves internal dependencies
- Generates and caches a dependency graph keyed by repo + branch
- Performs atomic multi-file lock acquire/release operations
- Normalizes/validates API payloads and repo URLs
- Handles GitHub quota/rate-limit behavior and head caching

## Why It Matters

If this layer is unstable, coordination breaks down fast.
These services make API responses deterministic enough for both humans and agents to trust.

## How We Built It

- `graph-service.ts`
  - single-flight graph generation to avoid duplicate heavy work
  - KV metadata + file SHA caching
  - graceful behavior under GitHub rate limits
- `locks.ts`
  - Lua scripts for atomic lock checks/updates
  - TTL-based lock expiry and cleanup support
- `github.ts`
  - repo URL parsing/normalization
  - cached head reads and quota error helpers
- `parser.ts` + `resolver.ts`
  - import extraction and file-path resolution for graph edges

## Challenges

- Coordinating lock semantics across many files in one operation
- Avoiding thundering-herd graph rebuilds under polling load
- Handling malformed payloads without leaking internal errors

## What’s Next

- Incremental graph diff updates instead of full regen in more cases
- Smarter lock policies by dependency depth and confidence
- Better observability hooks for coordination latency debugging
