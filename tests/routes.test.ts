import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getCachedGraphMock } = vi.hoisted(() => ({
  getCachedGraphMock: vi.fn(async () => null),
}));

vi.mock('@/lib/github', () => ({
  parseRepoUrl: vi.fn(() => ({ owner: 'test', repo: 'repo' })),
  getRepoHead: vi.fn(async () => 'remote-head'),
  getRepoHeadCached: vi.fn(async () => 'remote-head'),
  isGitHubQuotaError: vi.fn(() => false),
  getGitHubQuotaErrorMessage: vi.fn(() => 'GitHub API quota exhausted.'),
  getGitHubQuotaResetMs: vi.fn(() => Date.now() + 60_000),
}));

vi.mock('@/lib/locks', () => ({
  getLocks: vi.fn(async () => ({})),
  acquireLocks: vi.fn(async () => ({ success: true, locks: [] })),
  releaseLocks: vi.fn(async () => ({ success: true })),
  cleanupExpiredLocks: vi.fn(async () => 3),
}));

vi.mock('@/lib/graph-service', () => ({
  GraphService: class {
    getCached = getCachedGraphMock;
  },
}));

import { GET as graphGet } from '@/app/api/graph/route';
import { POST as checkStatusPost } from '@/app/api/check_status/route';
import { GET as cleanupGet } from '@/app/api/cleanup_stale_locks/route';
import { POST as postStatusPost } from '@/app/api/post_status/route';
import { getRepoHeadCached } from '@/lib/github';
import { acquireLocks, getLocks, releaseLocks } from '@/lib/locks';

const mockedGetRepoHead = vi.mocked(getRepoHeadCached);
const mockedGetLocks = vi.mocked(getLocks);
const mockedAcquireLocks = vi.mocked(acquireLocks);
const mockedReleaseLocks = vi.mocked(releaseLocks);

describe('route smoke checks', () => {
  beforeEach(() => {
    mockedGetRepoHead.mockClear();
    mockedGetLocks.mockClear();
    mockedAcquireLocks.mockClear();
    mockedReleaseLocks.mockClear();
    getCachedGraphMock.mockClear();

    mockedGetRepoHead.mockResolvedValue('remote-head');
    mockedGetLocks.mockResolvedValue({});
    mockedAcquireLocks.mockResolvedValue({ success: true, locks: [] });
    mockedReleaseLocks.mockResolvedValue({ success: true });
    getCachedGraphMock.mockResolvedValue(null);
  });

  test('check_status returns lock_type DIRECT and user alias for requested lock', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedGetLocks.mockResolvedValueOnce({
      'src/a.ts': {
        file_path: 'src/a.ts',
        user_id: 'user-1',
        user_name: 'User One',
        status: 'WRITING',
        agent_head: 'remote-head',
        message: 'work',
        timestamp: 100,
        expiry: 200,
      },
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        agent_head: 'remote-head',
      }),
      headers: new Headers([['x-github-user', 'other-user']]),
    } as any;

    const response = await checkStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.locks['src/a.ts'].lock_type).toBe('DIRECT');
    expect(payload.locks['src/a.ts'].user).toBe('user-1');
    expect(payload.orchestration.type).toBe('orchestration_command');
  });

  test('check_status returns lock_type NEIGHBOR for neighbor lock', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedGetLocks.mockResolvedValueOnce({
      'src/dependency.ts': {
        file_path: 'src/dependency.ts',
        user_id: 'neighbor-user',
        user_name: 'Neighbor User',
        status: 'WRITING',
        agent_head: 'remote-head',
        message: 'editing dependency',
        timestamp: 110,
        expiry: 210,
      },
    });
    getCachedGraphMock.mockResolvedValueOnce({
      nodes: [],
      edges: [{ source: 'src/a.ts', target: 'src/dependency.ts', type: 'import' }],
      locks: {},
      version: 'v1',
      metadata: {
        generated_at: 1,
        files_processed: 1,
        edges_found: 1,
      },
    } as any);

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        agent_head: 'remote-head',
      }),
      headers: new Headers([['x-github-user', 'agent-user']]),
    } as any;

    const response = await checkStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(getCachedGraphMock).toHaveBeenCalled();
    expect(payload.locks['src/dependency.ts'].lock_type).toBe('NEIGHBOR');
  });

  test('check_status does not report CONFLICT for own lock', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedGetLocks.mockResolvedValueOnce({
      'src/a.ts': {
        file_path: 'src/a.ts',
        user_id: 'agent-user',
        user_name: 'Agent User',
        status: 'WRITING',
        agent_head: 'remote-head',
        message: 'work',
        timestamp: 100,
        expiry: 200,
      },
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        agent_head: 'remote-head',
      }),
      headers: new Headers([['x-github-user', 'agent-user']]),
    } as any;

    const response = await checkStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('OK');
    expect(payload.locks['src/a.ts'].user_id).toBe('agent-user');
  });

  test('check_status falls back requesting user from x-github-username header', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedGetLocks.mockResolvedValueOnce({
      'src/a.ts': {
        file_path: 'src/a.ts',
        user_id: 'fallback-user',
        user_name: 'Fallback User',
        status: 'WRITING',
        agent_head: 'remote-head',
        message: 'work',
        timestamp: 100,
        expiry: 200,
      },
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        agent_head: 'remote-head',
      }),
      headers: new Headers([['x-github-username', 'fallback-user']]),
    } as any;

    const response = await checkStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('OK');
  });

  test('check_status returns 400 on missing fields', async () => {
    const request = { json: async () => ({}) } as any;
    const response = await checkStatusPost(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing required fields' });
  });

  test('check_status returns PULL orchestration on stale head', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedGetLocks.mockResolvedValueOnce({});

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        agent_head: 'local-head',
      }),
      headers: new Headers(),
    } as any;

    const response = await checkStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('STALE');
    expect(payload.orchestration.action).toBe('PULL');
    expect(payload.orchestration.type).toBe('orchestration_command');
  });

  test('post_status returns 400 on missing fields', async () => {
    const request = { json: async () => ({}) } as any;
    const response = await postStatusPost(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing required fields' });
  });

  test('post_status returns PULL orchestration on stale WRITING request', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        status: 'WRITING',
        message: 'work',
        agent_head: 'local-head',
      }),
      headers: new Headers(),
    } as any;

    const response = await postStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.orchestration.action).toBe('PULL');
    expect(payload.orchestration.type).toBe('orchestration_command');
  });

  test('post_status returns conflict orchestration when lock acquisition fails', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('same-head');
    mockedAcquireLocks.mockResolvedValueOnce({
      success: false,
      reason: 'FILE_CONFLICT',
      conflictingFile: 'src/a.ts',
      conflictingUser: 'user2',
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        status: 'WRITING',
        message: 'work',
        agent_head: 'same-head',
      }),
      headers: new Headers(),
    } as any;

    const response = await postStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.orchestration.action).toBe('SWITCH_TASK');
    expect(payload.orchestration.reason).toContain('FILE_CONFLICT');
    expect(payload.orchestration.type).toBe('orchestration_command');
  });

  test('post_status returns orphaned_dependencies on OPEN', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    getCachedGraphMock.mockResolvedValueOnce({
      nodes: [],
      edges: [
        { source: 'src/app.ts', target: 'src/auth.ts', type: 'import' },
        { source: 'src/auth.ts', target: 'src/util.ts', type: 'import' },
      ],
      locks: {},
      version: 'v1',
      metadata: {
        generated_at: 1,
        files_processed: 2,
        edges_found: 2,
      },
    } as any);

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/auth.ts'],
        status: 'OPEN',
        message: 'done',
      }),
      headers: new Headers([['x-github-user', 'agent-user']]),
    } as any;

    const response = await postStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(getCachedGraphMock).toHaveBeenCalled();
    expect(payload.orphaned_dependencies).toContain('src/app.ts');
    expect(payload.orphaned_dependencies).not.toContain('src/auth.ts');
    expect(payload.orchestration.type).toBe('orchestration_command');
    expect(mockedReleaseLocks).toHaveBeenCalledWith(
      'https://github.com/a/b',
      'main',
      ['src/auth.ts'],
      'agent-user',
    );
  });

  test('post_status uses x-github-username as fallback for user identity', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedAcquireLocks.mockResolvedValueOnce({
      success: true,
      locks: [],
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/a.ts'],
        status: 'WRITING',
        message: 'work',
        agent_head: 'remote-head',
      }),
      headers: new Headers([['x-github-username', 'fallback-user']]),
    } as any;

    const response = await postStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.orchestration.type).toBe('orchestration_command');
    expect(mockedAcquireLocks).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'fallback-user',
        userName: 'fallback-user',
      }),
    );
  });

  test('cleanup route returns 401 when auth is missing', async () => {
    const request = { headers: new Headers() } as any;
    const response = await cleanupGet(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  test('graph route returns 400 when repo_url is missing', async () => {
    const request = { url: 'http://localhost:3000/api/graph' } as any;
    const response = await graphGet(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'repo_url is required' });
  });
});
