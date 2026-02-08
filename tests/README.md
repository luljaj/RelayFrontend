# Test Suite (`tests/`)

This folder proves Relay is not just a demo UI: core coordination behavior is exercised with automated tests.

## What It Covers

- Route behavior for:
  - lock checks (`check_status`)
  - lock updates (`post_status`)
  - graph fetches
  - cleanup endpoint auth/path
- Lock logic and conflict scenarios
- Parser and resolver correctness
- MCP route behavior and tool envelope expectations

## Why It Matters For Judges

Hackathon projects often stop at “it worked once.”
These tests show repeatability and engineering discipline under time pressure.

## Run Tests

From repository root:

```bash
npm test
```

Target a specific suite:

```bash
npx vitest run tests/routes.test.ts
npx vitest run tests/mcp-route.test.ts
```

Watch mode:

```bash
npm run test:watch
```

## How We Built This Suite

- Heavy use of module mocking for GitHub/KV dependencies
- Route-first tests to validate real API contract outputs
- Explicit checks for orchestration actions and lock metadata fields

## Challenges

- Simulating distributed coordination edge cases in unit tests
- Keeping tests deterministic while mocking dynamic timestamps/heads

## What’s Next

- Add integration tests against a real ephemeral KV instance
- Add load-oriented tests for graph polling and lock churn
