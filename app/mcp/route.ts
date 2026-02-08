import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_MCP_BRANCH = 'master';
const FALLBACK_MCP_BRANCH = 'main';
const STANDARDIZED_REPO_URL = 'https://github.com/luljaj/RelayDevFest';
const MCP_SERVER_INFO = {
  name: 'relay-mcp',
  version: '1.0.0',
};

const MCP_CAPABILITIES = {
  experimental: {},
  logging: {},
  prompts: { listChanged: false },
  resources: { subscribe: true, listChanged: false },
  tools: { listChanged: false },
  completions: {},
};

type JsonRpcId = string | number | null;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'check_status',
    description: 'Check status of files before editing. Returns orchestration commands.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'file_paths', 'agent_head', 'repo_url'],
      properties: {
        username: {
          type: 'string',
          description:
            'Stable agent identity used for lock attribution. Choose once as "(model)-(random word)-(agent owner github username)" (e.g., "gpt5-orchid-lukauljaj") and keep it unchanged across calls.',
          pattern: '^[a-z0-9]+-[a-z0-9]+-[a-z0-9-]+$',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file paths (e.g., ["src/auth.ts", "src/db.ts"])',
        },
        agent_head: {
          type: 'string',
          description: 'Current git HEAD SHA',
        },
        repo_url: {
          type: 'string',
          description: 'Repository URL',
        },
        branch: {
          type: 'string',
          description: `Git branch name (default: "${DEFAULT_MCP_BRANCH}")`,
          default: DEFAULT_MCP_BRANCH,
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
    },
  },
  {
    name: 'post_status',
    description: 'Update lock status for files. Supports atomic multi-file locking.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'file_paths', 'status', 'message', 'agent_head', 'repo_url'],
      properties: {
        username: {
          type: 'string',
          description:
            'Stable agent identity used for lock attribution. Choose once as "(model)-(random word)-(agent owner github username)" (e.g., "gpt5-orchid-lukauljaj") and keep it unchanged across calls.',
          pattern: '^[a-z0-9]+-[a-z0-9]+-[a-z0-9-]+$',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file paths (e.g., ["src/auth.ts"])',
        },
        status: {
          type: 'string',
          description: 'Lock status - "READING", "WRITING", or "OPEN"',
        },
        message: {
          type: 'string',
          description: "Context message about what you're doing",
        },
        agent_head: {
          type: 'string',
          description: 'Current git HEAD SHA',
        },
        repo_url: {
          type: 'string',
          description: 'Repository URL',
        },
        branch: {
          type: 'string',
          description: `Git branch name (default: "${DEFAULT_MCP_BRANCH}")`,
          default: DEFAULT_MCP_BRANCH,
        },
        new_repo_head: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'New HEAD SHA after push (required for OPEN status)',
          default: null,
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
    },
  },
];

export async function GET(request: NextRequest) {
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/event-stream')) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: 'server-error',
        error: {
          code: -32600,
          message: 'Not Acceptable: Client must accept text/event-stream',
        },
      },
      { status: 406 },
    );
  }

  return new NextResponse(':\n\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export async function POST(request: NextRequest) {
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: 'server-error',
        error: {
          code: -32600,
          message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
        },
      },
      { status: 406 },
    );
  }

  const payload = await safeParseJson(request);
  if (!isRecord(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
    return sseJsonRpcResponse(
      makeJsonRpcError(null, -32600, 'Invalid request parameters', ''),
    );
  }

  const id = parseJsonRpcId(payload.id);
  const method = payload.method;
  const params = isRecord(payload.params) ? payload.params : {};

  if (method.startsWith('notifications/')) {
    return new NextResponse(null, { status: 202 });
  }

  if (method === 'ping') {
    return sseJsonRpcResponse(makeJsonRpcResult(id, {}));
  }

  if (method === 'initialize') {
    return sseJsonRpcResponse(
      makeJsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: MCP_CAPABILITIES,
        serverInfo: MCP_SERVER_INFO,
      }),
    );
  }

  if (method === 'tools/list') {
    return sseJsonRpcResponse(
      makeJsonRpcResult(id, {
        tools: TOOL_DEFINITIONS,
      }),
    );
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};

    if (!name) {
      return sseJsonRpcResponse(
        makeJsonRpcResult(id, makeToolErrorResult('Missing required parameter "name" for tools/call')),
      );
    }

    if (name === 'check_status') {
      const missing = missingRequiredArg(args, ['username', 'file_paths', 'agent_head', 'repo_url']);
      if (missing) {
        return sseJsonRpcResponse(
          makeJsonRpcResult(
            id,
            makeToolErrorResult(`Missing required argument '${missing}' for tool 'check_status'`),
          ),
        );
      }

      const result = await callCheckStatusTool(args, request);
      return sseJsonRpcResponse(makeJsonRpcResult(id, makeToolSuccessResult(result)));
    }

    if (name === 'post_status') {
      const missing = missingRequiredArg(args, [
        'username',
        'file_paths',
        'status',
        'message',
        'agent_head',
        'repo_url',
      ]);
      if (missing) {
        return sseJsonRpcResponse(
          makeJsonRpcResult(
            id,
            makeToolErrorResult(`Missing required argument '${missing}' for tool 'post_status'`),
          ),
        );
      }

      const result = await callPostStatusTool(args, request);
      return sseJsonRpcResponse(makeJsonRpcResult(id, makeToolSuccessResult(result)));
    }

    return sseJsonRpcResponse(
      makeJsonRpcResult(id, makeToolErrorResult(`Tool "${name}" is not available`)),
    );
  }

  return sseJsonRpcResponse(
    makeJsonRpcError(id, -32600, 'Invalid request parameters', ''),
  );
}

function makeJsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function makeJsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(typeof data === 'undefined' ? {} : { data }),
    },
  };
}

function sseJsonRpcResponse(payload: JsonRpcResponse): NextResponse {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function makeToolSuccessResult(content: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(content) }],
    structuredContent: content,
    isError: false,
  };
}

function makeToolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function callCheckStatusTool(
  args: Record<string, unknown>,
  request: NextRequest,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(args.username);
  const repoUrl = getStandardizedRepoUrl();
  const branchResolution = resolveBranch(args.branch);
  let branch = branchResolution.branch;

  try {
    let response = await callInternalApi(
      request,
      '/api/check_status',
      {
        file_paths: args.file_paths,
        agent_head: args.agent_head,
        repo_url: repoUrl,
        branch,
      },
      username,
    );

    if (
      !branchResolution.wasProvided &&
      shouldRetryOnMissingBranchReference(response) &&
      branch !== FALLBACK_MCP_BRANCH
    ) {
      branch = FALLBACK_MCP_BRANCH;
      response = await callInternalApi(
        request,
        '/api/check_status',
        {
          file_paths: args.file_paths,
          agent_head: args.agent_head,
          repo_url: repoUrl,
          branch,
        },
        username,
      );
    }

    if (response.status === 429) {
      const details = extractErrorMessage(response.payload, 'Rate limited');
      return {
        status: 'OFFLINE',
        repo_head: 'unknown',
        locks: {},
        warnings: ['RATE_LIMITED: GitHub API quota exhausted on Vercel'],
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: details,
        },
      };
    }

    if (response.status === 400) {
      const details = extractErrorMessage(response.payload, 'Validation error');
      return {
        status: 'OFFLINE',
        repo_head: 'unknown',
        locks: {},
        warnings: [`REQUEST_REJECTED: ${details}`],
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: `Validation error: ${details}`,
        },
      };
    }

    if (response.status >= 400) {
      const details = extractErrorMessage(response.payload, `HTTP ${response.status}`);
      return {
        status: 'OFFLINE',
        repo_head: 'unknown',
        locks: {},
        warnings: [`HTTP_ERROR: ${details}`],
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: `check_status failed (${response.status}): ${details}`,
        },
      };
    }

    return ensureRecord(response.payload);
  } catch {
    return {
      status: 'OFFLINE',
      repo_head: 'unknown',
      locks: {},
      warnings: ['OFFLINE_MODE: Vercel Unreachable'],
      orchestration: {
        type: 'orchestration_command',
        action: 'SWITCH_TASK',
        command: null,
        reason: 'System Offline',
      },
    };
  }
}

async function callPostStatusTool(
  args: Record<string, unknown>,
  request: NextRequest,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(args.username);
  const repoUrl = getStandardizedRepoUrl();
  const branchResolution = resolveBranch(args.branch);
  let branch = branchResolution.branch;

  try {
    let response = await callInternalApi(
      request,
      '/api/post_status',
      {
        file_paths: args.file_paths,
        status: args.status,
        message: args.message,
        agent_head: args.agent_head,
        repo_url: repoUrl,
        branch,
        new_repo_head: args.new_repo_head ?? null,
      },
      username,
    );

    if (
      !branchResolution.wasProvided &&
      shouldRetryOnMissingBranchReference(response) &&
      branch !== FALLBACK_MCP_BRANCH
    ) {
      branch = FALLBACK_MCP_BRANCH;
      response = await callInternalApi(
        request,
        '/api/post_status',
        {
          file_paths: args.file_paths,
          status: args.status,
          message: args.message,
          agent_head: args.agent_head,
          repo_url: repoUrl,
          branch,
          new_repo_head: args.new_repo_head ?? null,
        },
        username,
      );
    }

    if (response.status === 429) {
      return {
        success: false,
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: 'Rate limited - retry later',
        },
      };
    }

    if (response.status === 400) {
      if (isRecord(response.payload) && isRecord(response.payload.orchestration)) {
        return ensureRecord(response.payload);
      }

      const details = extractErrorMessage(response.payload, 'Validation error');
      return {
        success: false,
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: `Validation error: ${details}`,
        },
      };
    }

    if (response.status === 409) {
      return {
        success: false,
        orchestration: {
          type: 'orchestration_command',
          action: 'WAIT',
          command: null,
          reason: 'Conflict: File locked by another user',
        },
      };
    }

    if (response.status >= 400) {
      const details = extractErrorMessage(response.payload, `HTTP ${response.status}`);
      return {
        success: false,
        orchestration: {
          type: 'orchestration_command',
          action: 'STOP',
          command: null,
          reason: `post_status failed (${response.status}): ${details}`,
        },
      };
    }

    return ensureRecord(response.payload);
  } catch {
    return {
      success: false,
      orchestration: {
        type: 'orchestration_command',
        action: 'STOP',
        command: null,
        reason: 'Vercel Offline - Cannot Acquire Lock',
      },
    };
  }
}

async function callInternalApi(
  request: NextRequest,
  path: '/api/check_status' | '/api/post_status',
  body: Record<string, unknown>,
  username: string,
): Promise<{ status: number; payload: unknown }> {
  const origin = new URL(request.url).origin;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-user': username,
        'x-github-username': username,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });

    return {
      status: response.status,
      payload: await readResponsePayload(response),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function safeParseJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseJsonRpcId(id: unknown): JsonRpcId {
  if (typeof id === 'string' || typeof id === 'number' || id === null) {
    return id;
  }
  return null;
}

function missingRequiredArg(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (!(key in args)) {
      return key;
    }
  }
  return null;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') {
    return 'anonymous';
  }
  const trimmed = value.trim();
  return trimmed || 'anonymous';
}

function getStandardizedRepoUrl(): string {
  return STANDARDIZED_REPO_URL;
}

function resolveBranch(value: unknown): { branch: string; wasProvided: boolean } {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      return { branch: trimmed, wasProvided: true };
    }
  }

  return { branch: DEFAULT_MCP_BRANCH, wasProvided: false };
}

function shouldRetryOnMissingBranchReference(response: { status: number; payload: unknown }): boolean {
  if (response.status !== 404 && response.status !== 500) {
    return false;
  }

  const details = extractErrorMessage(response.payload, '').toLowerCase();
  return (
    details.includes('git/refs#get-a-reference') ||
    details.includes('reference does not exist') ||
    details.includes('not found')
  );
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    for (const key of ['details', 'error', 'reason']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  return fallback;
}

function ensureRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
