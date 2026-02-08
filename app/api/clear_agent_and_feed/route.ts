import { NextRequest, NextResponse } from 'next/server';
import { clearActivityEvents } from '@/lib/activity';
import { normalizeRepoUrl } from '@/lib/github';
import { releaseAllLocks } from '@/lib/locks';
import { getMissingFields, isNonEmptyString, toBodyRecord } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = toBodyRecord(await request.json());
    const missing = getMissingFields(body, ['repo_url', 'branch']);
    if (missing.length > 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const repoUrl = body.repo_url;
    const branch = body.branch;
    if (!isNonEmptyString(repoUrl) || !isNonEmptyString(branch)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
    const normalizedBranch = branch.trim() || 'main';
    const [locksResult, activityResult] = await Promise.all([
      releaseAllLocks(normalizedRepoUrl, normalizedBranch),
      clearActivityEvents(normalizedRepoUrl, normalizedBranch),
    ]);

    if (!locksResult.success || !activityResult.success) {
      return NextResponse.json(
        {
          error: 'Failed to clear agent tab and live feed',
          details: {
            locks_cleared: locksResult.success,
            feed_cleared: activityResult.success,
          },
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      released: locksResult.released,
      cleared: activityResult.cleared,
      repo_url: normalizedRepoUrl,
      branch: normalizedBranch,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown error';
    console.error('clear_agent_and_feed error:', error);
    return NextResponse.json({ error: 'Internal server error', details }, { status: 500 });
  }
}
