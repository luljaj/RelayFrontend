import { afterEach, describe, expect, test, vi } from 'vitest';
import { GET as mcpGet, POST as mcpPost } from '@/app/mcp/route';

function parseSseData(body: string): any {
  const dataLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('data: '));

  if (!dataLine) {
    throw new Error(`No data line found in SSE body: ${body}`);
  }

  return JSON.parse(dataLine.slice('data: '.length));
}

describe('mcp route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('rejects POST when Accept header is missing required mime types', async () => {
    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    } as any;

    const response = await mcpPost(request);
    const payload = await response.json();

    expect(response.status).toBe(406);
    expect(payload.error.code).toBe(-32600);
  });

  test('supports initialize via SSE response', async () => {
    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(payload.result.protocolVersion).toBe('2024-11-05');
    expect(payload.result.capabilities.tools.listChanged).toBe(false);
  });

  test('returns tools/list with check_status and post_status', async () => {
    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);
    const toolNames = payload.result.tools.map((tool: { name: string }) => tool.name);

    expect(toolNames).toContain('check_status');
    expect(toolNames).toContain('post_status');
  });

  test('forwards check_status tool calls to internal API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          repo_head: 'abc123',
          locks: {},
          warnings: [],
          orchestration: {
            type: 'orchestration_command',
            action: 'PROCEED',
            command: null,
            reason: '',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'check_status',
          arguments: {
            username: 'luka',
            file_paths: ['README.md'],
            agent_head: 'abc123',
            repo_url: 'https://github.com/lukauljaj/DevFest',
            branch: 'main',
          },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay-devfest.vercel.app/api/check_status',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-github-user': 'luka',
          'x-github-username': 'luka',
        }),
      }),
    );
    expect(payload.result.isError).toBe(false);
    expect(payload.result.structuredContent.status).toBe('OK');
  });

  test('defaults check_status branch to master when branch is omitted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          repo_head: 'abc123',
          locks: {},
          warnings: [],
          orchestration: {
            type: 'orchestration_command',
            action: 'PROCEED',
            command: null,
            reason: '',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'check_status',
          arguments: {
            username: 'luka',
            file_paths: ['README.md'],
            agent_head: 'abc123',
            repo_url: 'https://github.com/lukauljaj/DevFest',
          },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const forwardedBody = JSON.parse(String(requestInit?.body ?? '{}'));

    expect(forwardedBody.branch).toBe('master');
    expect(forwardedBody.repo_url).toBe('https://github.com/luljaj/RelayDevFest');
    expect(payload.result.isError).toBe(false);
  });

  test('retries check_status with main when default master branch ref is missing', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Internal server error',
            details: 'Not Found - https://docs.github.com/rest/git/refs#get-a-reference',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'OK',
            repo_head: 'def456',
            locks: {},
            warnings: [],
            orchestration: {
              type: 'orchestration_command',
              action: 'PROCEED',
              command: null,
              reason: '',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'check_status',
          arguments: {
            username: 'luka',
            file_paths: ['README.md'],
            agent_head: 'def456',
            repo_url: 'https://github.com/lukauljaj/DevFest',
          },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    const firstRequestBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '{}'));
    const secondRequestBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body ?? '{}'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstRequestBody.branch).toBe('master');
    expect(firstRequestBody.repo_url).toBe('https://github.com/luljaj/RelayDevFest');
    expect(secondRequestBody.branch).toBe('main');
    expect(secondRequestBody.repo_url).toBe('https://github.com/luljaj/RelayDevFest');
    expect(payload.result.isError).toBe(false);
    expect(payload.result.structuredContent.status).toBe('OK');
  });

  test('preserves post_status orchestration payload on validation responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          orchestration: {
            type: 'orchestration_command',
            action: 'PUSH',
            command: 'git push',
            reason: 'You need to push your changes to advance the repo',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'post_status',
          arguments: {
            username: 'luka',
            file_paths: ['README.md'],
            status: 'OPEN',
            message: 'release lock',
            agent_head: 'abc123',
            repo_url: 'https://github.com/lukauljaj/DevFest',
            branch: 'master',
            new_repo_head: 'abc123',
          },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay-devfest.vercel.app/api/post_status',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-github-user': 'luka',
          'x-github-username': 'luka',
        }),
      }),
    );
    expect(payload.result.isError).toBe(false);
    expect(payload.result.structuredContent.success).toBe(false);
    expect(payload.result.structuredContent.orchestration.action).toBe('PUSH');
  });

  test('defaults post_status branch to master when branch is omitted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          locks: [],
          orchestration: {
            type: 'orchestration_command',
            action: 'PROCEED',
            command: null,
            reason: 'Locks acquired successfully',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'post_status',
          arguments: {
            username: 'luka',
            file_paths: ['README.md'],
            status: 'WRITING',
            message: 'editing',
            agent_head: 'abc123',
            repo_url: 'https://github.com/lukauljaj/DevFest',
          },
        },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const forwardedBody = JSON.parse(String(requestInit?.body ?? '{}'));

    expect(forwardedBody.branch).toBe('master');
    expect(forwardedBody.repo_url).toBe('https://github.com/luljaj/RelayDevFest');
    expect(payload.result.isError).toBe(false);
  });

  test('returns tool error result for unknown tool', async () => {
    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'unknown_tool', arguments: {} },
      }),
    } as any;

    const response = await mcpPost(request);
    const body = await response.text();
    const payload = parseSseData(body);

    expect(response.status).toBe(200);
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain('not available');
  });

  test('returns 202 for notifications', async () => {
    const request = {
      url: 'https://relay-devfest.vercel.app/mcp',
      headers: new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }),
      json: async () => ({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    } as any;

    const response = await mcpPost(request);
    expect(response.status).toBe(202);
  });

  test('GET requires text/event-stream accept header', async () => {
    const request = {
      headers: new Headers({ accept: 'application/json' }),
    } as any;

    const response = await mcpGet(request);
    const payload = await response.json();

    expect(response.status).toBe(406);
    expect(payload.error.code).toBe(-32600);
  });
});
