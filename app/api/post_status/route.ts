import { NextRequest, NextResponse } from 'next/server';
import {
  getGitHubQuotaErrorMessage,
  getGitHubQuotaResetMs,
  getRepoHeadCached,
  isGitHubQuotaError,
  parseRepoUrl,
} from '@/lib/github';
import { GraphService } from '@/lib/graph-service';
import { acquireLocks, releaseLocks } from '@/lib/locks';
import {
  getMissingFields,
  isNonEmptyString,
  normalizeFilePaths,
  parseCoordinationStatus,
  toBodyRecord,
} from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = toBodyRecord(await request.json());
    const missing = getMissingFields(body, ['repo_url', 'branch', 'file_paths', 'status', 'message']);

    if (missing.length > 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const repoUrl = body.repo_url;
    const branch = body.branch;
    const filePaths = normalizeFilePaths(body.file_paths);
    const status = parseCoordinationStatus(body.status);
    const message = body.message;
    const agentHead = body.agent_head;
    const newRepoHead = body.new_repo_head;

    if (
      !isNonEmptyString(repoUrl) ||
      !isNonEmptyString(branch) ||
      !isNonEmptyString(message) ||
      !status ||
      !filePaths ||
      filePaths.length === 0
    ) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const userId =
      request.headers.get('x-github-user') ||
      request.headers.get('x-github-username') ||
      'anonymous';
    const userName =
      request.headers.get('x-github-username') ||
      request.headers.get('x-github-user') ||
      'Anonymous';

    const { owner, repo } = parseRepoUrl(repoUrl);
    const repoHead = await getRepoHeadCached(owner, repo, branch);

    if (status === 'OPEN') {
      if (isNonEmptyString(newRepoHead) && isNonEmptyString(agentHead) && newRepoHead === agentHead) {
        return NextResponse.json(
          {
            success: false,
            orchestration: {
              type: 'orchestration_command',
              action: 'PUSH',
              command: 'git push',
              reason: 'You need to push your changes to advance the repo',
            },
          },
          { status: 400 },
        );
      }

      await releaseLocks(repoUrl, branch, filePaths, userId);

      let orphanedDependencies: string[] = [];
      try {
        const graphService = new GraphService(repoUrl, branch);
        const cachedGraph = await graphService.getCached();

        if (cachedGraph) {
          const releasedPaths = new Set(filePaths);
          const dependencyPaths = new Set<string>();

          for (const edge of cachedGraph.edges) {
            if (releasedPaths.has(edge.target) && !releasedPaths.has(edge.source)) {
              dependencyPaths.add(edge.source);
            }
          }

          orphanedDependencies = Array.from(dependencyPaths);
        }
      } catch {
        // Graph cache is optional for unlock flow; return empty orphaned dependencies on read errors.
      }

      return NextResponse.json({
        success: true,
        orphaned_dependencies: orphanedDependencies,
        orchestration: {
          type: 'orchestration_command',
          action: 'PROCEED',
          command: null,
          reason: 'Locks released successfully',
        },
      });
    }

    if (status === 'WRITING') {
      if (!isNonEmptyString(agentHead)) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      if (agentHead !== repoHead) {
        return NextResponse.json({
          success: false,
          orchestration: {
            type: 'orchestration_command',
            action: 'PULL',
            command: 'git pull --rebase',
            reason: 'Your local repo is behind remote',
            metadata: {
              remote_head: repoHead,
              your_head: agentHead,
            },
          },
        });
      }

      const lockResult = await acquireLocks({
        repoUrl,
        branch,
        filePaths,
        userId,
        userName,
        status,
        message,
        agentHead,
      });

      if (!lockResult.success) {
        return NextResponse.json({
          success: false,
          orchestration: {
            type: 'orchestration_command',
            action: 'SWITCH_TASK',
            command: null,
            reason: `${lockResult.reason}: ${lockResult.conflictingFile} locked by ${lockResult.conflictingUser}`,
          },
        });
      }

      return NextResponse.json({
        success: true,
        locks: lockResult.locks,
        orchestration: {
          type: 'orchestration_command',
          action: 'PROCEED',
          command: null,
          reason: 'Locks acquired successfully',
        },
      });
    }

    return NextResponse.json({
      success: true,
      orchestration: {
        type: 'orchestration_command',
        action: 'PROCEED',
        command: null,
        reason: 'Reading status recorded',
      },
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
    console.error('post_status error:', error);
    return NextResponse.json({ error: 'Internal server error', details }, { status: 500 });
  }
}
