import { NextRequest, NextResponse } from 'next/server';
import {
  getGitHubQuotaErrorMessage,
  getGitHubQuotaResetMs,
  getRepoHeadCached,
  isGitHubQuotaError,
  parseRepoUrl,
} from '@/lib/github';
import { GraphService } from '@/lib/graph-service';
import { getLocks, type LockEntry } from '@/lib/locks';
import { getMissingFields, isNonEmptyString, normalizeFilePaths, toBodyRecord } from '@/lib/validation';

export const dynamic = 'force-dynamic';

type EnrichedLockEntry = LockEntry & {
  user: string;
  lock_type: 'DIRECT' | 'NEIGHBOR';
};

export async function POST(request: NextRequest) {
  try {
    const body = toBodyRecord(await request.json());
    const missing = getMissingFields(body, ['repo_url', 'branch', 'file_paths', 'agent_head']);

    if (missing.length > 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const repoUrl = body.repo_url;
    const branch = body.branch;
    const filePaths = normalizeFilePaths(body.file_paths);
    const agentHead = body.agent_head;

    if (
      !isNonEmptyString(repoUrl) ||
      !isNonEmptyString(branch) ||
      !isNonEmptyString(agentHead) ||
      !filePaths ||
      filePaths.length === 0
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const requestingUser =
      request.headers.get('x-github-user') ||
      request.headers.get('x-github-username') ||
      '';

    const { owner, repo } = parseRepoUrl(repoUrl);
    const repoHead = await getRepoHeadCached(owner, repo, branch);

    const isStale = agentHead !== repoHead;
    const allLocks = await getLocks(repoUrl, branch);
    const requestedFilePaths = new Set(filePaths);
    const enrichedLocks: Record<string, EnrichedLockEntry> = {};

    for (const filePath of filePaths) {
      const lock = allLocks[filePath];
      if (!lock) {
        continue;
      }

      enrichedLocks[filePath] = {
        ...lock,
        user: lock.user_id,
        lock_type: 'DIRECT',
      };
    }

    try {
      const graphService = new GraphService(repoUrl, branch);
      const cachedGraph = await graphService.getCached();

      if (cachedGraph) {
        const neighborPaths = new Set<string>();

        for (const edge of cachedGraph.edges) {
          if (requestedFilePaths.has(edge.source) && !requestedFilePaths.has(edge.target)) {
            neighborPaths.add(edge.target);
          }

          if (requestedFilePaths.has(edge.target) && !requestedFilePaths.has(edge.source)) {
            neighborPaths.add(edge.source);
          }
        }

        for (const neighborPath of neighborPaths) {
          const lock = allLocks[neighborPath];
          if (!lock || enrichedLocks[neighborPath]) {
            continue;
          }

          enrichedLocks[neighborPath] = {
            ...lock,
            user: lock.user_id,
            lock_type: 'NEIGHBOR',
          };
        }
      }
    } catch {
      // Graph cache is optional for check_status; skip neighbor detection on read errors.
    }

    const conflictingLocks = Object.entries(enrichedLocks).filter(
      ([, lock]) => lock.user_id !== requestingUser,
    );

    let status = 'OK';
    if (isStale) status = 'STALE';
    if (conflictingLocks.length > 0) status = 'CONFLICT';

    let orchestration: {
      type: 'orchestration_command';
      action: string;
      command: string | null;
      reason: string;
    } = {
      type: 'orchestration_command',
      action: 'PROCEED',
      command: null,
      reason: '',
    };

    if (isStale) {
      orchestration = {
        type: 'orchestration_command',
        action: 'PULL',
        command: 'git pull --rebase',
        reason: `Your local repo is behind. Current HEAD: ${repoHead}`,
      };
    } else if (conflictingLocks.length > 0) {
      const [filePath, firstLock] = conflictingLocks[0];
      orchestration = {
        type: 'orchestration_command',
        action: 'SWITCH_TASK',
        command: null,
        reason: `File '${filePath}' is locked by ${firstLock.user_name} (${firstLock.lock_type})`,
      };
    }

    return NextResponse.json({
      status,
      repo_head: repoHead,
      locks: enrichedLocks,
      warnings: isStale ? [`STALE_BRANCH: Your branch is behind origin/${branch}`] : [],
      orchestration,
    });
  } catch (error) {
    if (isGitHubQuotaError(error)) {
      const retryAtMs = getGitHubQuotaResetMs(error);
      return NextResponse.json(
        {
          error: 'GitHub API rate limit exceeded',
          details: getGitHubQuotaErrorMessage(error),
          retry_after_ms: retryAtMs ?? undefined,
        },
        { status: 429 },
      );
    }

    const details = error instanceof Error ? error.message : 'Unknown error';
    console.error('check_status error:', error);
    return NextResponse.json({ error: 'Internal server error', details }, { status: 500 });
  }
}
