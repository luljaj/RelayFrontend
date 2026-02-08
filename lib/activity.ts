import { normalizeRepoUrl } from './github';
import { kv } from './kv';

export type CoordinationActivityStatus = 'OPEN' | 'READING' | 'WRITING';

export interface CoordinationActivityEvent {
  id: string;
  file_path: string;
  user_id: string;
  user_name: string;
  status: CoordinationActivityStatus;
  message: string;
  timestamp: number;
}

interface PublishActivityInput {
  repoUrl: string;
  branch: string;
  filePaths: string[];
  userId: string;
  userName: string;
  status: CoordinationActivityStatus;
  message: string;
  timestamp?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 120;
const MAX_ACTIVITY_RETENTION = 500;

function getActivityKey(repoUrl: string, branch: string): string {
  const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
  const normalizedBranch = branch.trim() || 'main';
  return `activity:${normalizedRepoUrl}:${normalizedBranch}`;
}

function parseActivityEvent(raw: unknown): CoordinationActivityEvent | null {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const candidate = parsed as Partial<CoordinationActivityEvent>;
  if (
    typeof candidate.id === 'string' &&
    typeof candidate.file_path === 'string' &&
    typeof candidate.user_id === 'string' &&
    typeof candidate.user_name === 'string' &&
    (candidate.status === 'OPEN' || candidate.status === 'READING' || candidate.status === 'WRITING') &&
    typeof candidate.message === 'string' &&
    typeof candidate.timestamp === 'number'
  ) {
    return candidate as CoordinationActivityEvent;
  }

  return null;
}

export async function publishActivityEvents(input: PublishActivityInput): Promise<void> {
  if (input.filePaths.length === 0) {
    return;
  }

  const key = getActivityKey(input.repoUrl, input.branch);
  const timestamp = input.timestamp ?? Date.now();
  const listClient = kv as unknown as {
    lpush?: (key: string, ...values: string[]) => Promise<unknown>;
    ltrim?: (key: string, start: number, stop: number) => Promise<unknown>;
  };

  if (!listClient.lpush || !listClient.ltrim) {
    return;
  }

  const payloads = input.filePaths.map((filePath, index) => {
    const event: CoordinationActivityEvent = {
      id: `${timestamp}:${input.userId}:${input.status}:${filePath}:${index}`,
      file_path: filePath,
      user_id: input.userId,
      user_name: input.userName,
      status: input.status,
      message: input.message,
      timestamp,
    };
    return JSON.stringify(event);
  });

  await listClient.lpush(key, ...payloads);
  await listClient.ltrim(key, 0, MAX_ACTIVITY_RETENTION - 1);
}

export async function getRecentActivityEvents(
  repoUrl: string,
  branch: string,
  limit = DEFAULT_ACTIVITY_LIMIT,
): Promise<CoordinationActivityEvent[]> {
  const key = getActivityKey(repoUrl, branch);
  const listClient = kv as unknown as {
    lrange?: (key: string, start: number, stop: number) => Promise<unknown>;
  };

  if (!listClient.lrange) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_ACTIVITY_LIMIT;
  const rawValues = await listClient.lrange(key, 0, safeLimit - 1);
  if (!Array.isArray(rawValues)) {
    return [];
  }

  const parsed = rawValues
    .map((raw) => parseActivityEvent(raw))
    .filter((event): event is CoordinationActivityEvent => event !== null);

  // Redis lists are newest-first (LPUSH), UI expects oldest-first.
  parsed.reverse();
  return parsed;
}

export async function clearActivityEvents(
  repoUrl: string,
  branch: string,
): Promise<{ success: boolean; cleared: number }> {
  const key = getActivityKey(repoUrl, branch);
  const listClient = kv as unknown as {
    llen?: (key: string) => Promise<unknown>;
  };

  try {
    let cleared = 0;
    if (listClient.llen) {
      const rawLength = await listClient.llen(key);
      if (typeof rawLength === 'number' && Number.isFinite(rawLength)) {
        cleared = rawLength;
      }
    }

    await kv.del(key);
    return { success: true, cleared };
  } catch (error) {
    console.error('Clear activity events failed:', error);
    return { success: false, cleared: 0 };
  }
}
