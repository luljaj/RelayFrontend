import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getCachedGraphMock } = vi.hoisted(() => ({
  getCachedGraphMock: vi.fn(async () => null),
}));

vi.mock('@/lib/github', () => ({
  parseRepoUrl: vi.fn(() => ({ owner: 'test', repo: 'repo' })),
  normalizeRepoUrl: vi.fn((repoUrl: string) => repoUrl),
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
  releaseAllLocks: vi.fn(async () => ({ success: true, released: 0 })),
  cleanupExpiredLocks: vi.fn(async () => 3),
}));

vi.mock('@/lib/graph-service', () => ({
  GraphService: class {
    getCached = getCachedGraphMock;
  },
}));

vi.mock('@/lib/activity', () => ({
  publishActivityEvents: vi.fn(async () => undefined),
  getRecentActivityEvents: vi.fn(async () => []),
  clearActivityEvents: vi.fn(async () => ({ success: true, cleared: 0 })),
}));

import { GET as graphGet } from '@/app/api/graph/route';
import { GET as activityGet } from '@/app/api/activity/route';
import { POST as checkStatusPost } from '@/app/api/check_status/route';
import { GET as cleanupGet } from '@/app/api/cleanup_stale_locks/route';
import { POST as postStatusPost } from '@/app/api/post_status/route';
import { POST as releaseAllLocksPost } from '@/app/api/release_all_locks/route';
import { POST as clearAgentAndFeedPost } from '@/app/api/clear_agent_and_feed/route';
import { clearActivityEvents, getRecentActivityEvents, publishActivityEvents } from '@/lib/activity';
import { getRepoHeadCached } from '@/lib/github';
import { acquireLocks, getLocks, releaseAllLocks, releaseLocks } from '@/lib/locks';

const mockedPublishActivityEvents = vi.mocked(publishActivityEvents);
const mockedGetRecentActivityEvents = vi.mocked(getRecentActivityEvents);
const mockedClearActivityEvents = vi.mocked(clearActivityEvents);
const mockedGetRepoHead = vi.mocked(getRepoHeadCached);
const mockedGetLocks = vi.mocked(getLocks);
const mockedAcquireLocks = vi.mocked(acquireLocks);
const mockedReleaseLocks = vi.mocked(releaseLocks);
const mockedReleaseAllLocks = vi.mocked(releaseAllLocks);

describe('route smoke checks', () => {
  beforeEach(() => {
    mockedGetRepoHead.mockClear();
    mockedGetLocks.mockClear();
    mockedAcquireLocks.mockClear();
    mockedReleaseLocks.mockClear();
    mockedReleaseAllLocks.mockClear();
    mockedPublishActivityEvents.mockClear();
    mockedGetRecentActivityEvents.mockClear();
    mockedClearActivityEvents.mockClear();
    getCachedGraphMock.mockClear();

    mockedGetRepoHead.mockResolvedValue('remote-head');
    mockedGetLocks.mockResolvedValue({});
    mockedAcquireLocks.mockResolvedValue({ success: true, locks: [] });
    mockedReleaseLocks.mockResolvedValue({ success: true });
    mockedReleaseAllLocks.mockResolvedValue({ success: true, released: 0 });
    mockedGetRecentActivityEvents.mockResolvedValue([]);
    mockedClearActivityEvents.mockResolvedValue({ success: true, cleared: 0 });
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

  test('post_status surfaces non-conflict lock acquisition failures without undefined placeholders', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('same-head');
    mockedAcquireLocks.mockResolvedValueOnce({
      success: false,
      reason: 'INTERNAL_ERROR',
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
    expect(payload.orchestration.reason).toBe('INTERNAL_ERROR');
    expect(payload.orchestration.reason).not.toContain('undefined');
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
    expect(mockedPublishActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'OPEN',
        filePaths: ['src/auth.ts'],
        userId: 'agent-user',
      }),
    );
  });

  test('post_status returns STOP when OPEN lock release fails', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedReleaseLocks.mockResolvedValueOnce({ success: false });

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

    expect(response.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.orchestration.action).toBe('STOP');
    expect(payload.orchestration.reason).toBe('Failed to release locks');
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
    expect(mockedPublishActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'WRITING',
        userId: 'fallback-user',
      }),
    );
  });

  test('post_status records READING locks and publishes activity', async () => {
    mockedGetRepoHead.mockResolvedValueOnce('remote-head');
    mockedAcquireLocks.mockResolvedValueOnce({
      success: true,
      locks: [
        {
          file_path: 'src/readme.ts',
          user_id: 'reader',
          user_name: 'Reader',
          status: 'READING',
          agent_head: 'remote-head',
          message: 'reviewing',
          timestamp: 1000,
          expiry: 2000,
        },
      ],
    });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
        file_paths: ['src/readme.ts'],
        status: 'READING',
        message: 'reviewing',
      }),
      headers: new Headers([['x-github-user', 'reader']]),
    } as any;

    const response = await postStatusPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.orchestration.reason).toBe('Reading lock recorded');
    expect(mockedAcquireLocks).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'READING',
        agentHead: 'remote-head',
      }),
    );
    expect(mockedPublishActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'READING',
        filePaths: ['src/readme.ts'],
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

  test('activity route returns 400 when repo_url is missing', async () => {
    const request = { url: 'http://localhost:3000/api/activity' } as any;
    const response = await activityGet(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'repo_url is required' });
  });

  test('activity route returns recent activity without graph rebuilds', async () => {
    mockedGetRecentActivityEvents.mockResolvedValueOnce([
      {
        id: 'evt-1',
        file_path: 'src/a.ts',
        user_id: 'agent-user',
        user_name: 'Agent User',
        status: 'WRITING',
        message: 'editing',
        timestamp: 12345,
      },
    ]);

    const request = {
      url: 'http://localhost:3000/api/activity?repo_url=https://github.com/a/b&branch=main&limit=10',
    } as any;
    const response = await activityGet(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.activity_events).toEqual([
      expect.objectContaining({
        id: 'evt-1',
        file_path: 'src/a.ts',
        status: 'WRITING',
      }),
    ]);
    expect(mockedGetRecentActivityEvents).toHaveBeenCalledWith('https://github.com/a/b', 'main', 10);
    expect(getCachedGraphMock).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  test('release_all_locks route returns 400 on missing fields', async () => {
    const request = { json: async () => ({}) } as any;
    const response = await releaseAllLocksPost(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing required fields' });
  });

  test('release_all_locks route releases locks for repo and branch', async () => {
    mockedReleaseAllLocks.mockResolvedValueOnce({ success: true, released: 3 });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
      }),
    } as any;

    const response = await releaseAllLocksPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedReleaseAllLocks).toHaveBeenCalledWith('https://github.com/a/b', 'main');
    expect(payload).toEqual({
      success: true,
      released: 3,
      repo_url: 'https://github.com/a/b',
      branch: 'main',
    });
  });

  test('release_all_locks route returns 500 when release fails', async () => {
    mockedReleaseAllLocks.mockResolvedValueOnce({ success: false, released: 0 });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
      }),
    } as any;

    const response = await releaseAllLocksPost(request);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: 'Failed to release all locks' });
  });

  test('clear_agent_and_feed route returns 400 on missing fields', async () => {
    const request = { json: async () => ({}) } as any;
    const response = await clearAgentAndFeedPost(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing required fields' });
  });

  test('clear_agent_and_feed route clears locks and activity feed', async () => {
    mockedReleaseAllLocks.mockResolvedValueOnce({ success: true, released: 2 });
    mockedClearActivityEvents.mockResolvedValueOnce({ success: true, cleared: 5 });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
      }),
    } as any;

    const response = await clearAgentAndFeedPost(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockedReleaseAllLocks).toHaveBeenCalledWith('https://github.com/a/b', 'main');
    expect(mockedClearActivityEvents).toHaveBeenCalledWith('https://github.com/a/b', 'main');
    expect(payload).toEqual({
      success: true,
      released: 2,
      cleared: 5,
      repo_url: 'https://github.com/a/b',
      branch: 'main',
    });
  });

  test('clear_agent_and_feed route returns 500 when clear operation fails', async () => {
    mockedReleaseAllLocks.mockResolvedValueOnce({ success: true, released: 2 });
    mockedClearActivityEvents.mockResolvedValueOnce({ success: false, cleared: 0 });

    const request = {
      json: async () => ({
        repo_url: 'https://github.com/a/b',
        branch: 'main',
      }),
    } as any;

    const response = await clearAgentAndFeedPost(request);
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: 'Failed to clear agent tab and live feed',
      details: {
        locks_cleared: true,
        feed_cleared: false,
      },
    });
  });
});
