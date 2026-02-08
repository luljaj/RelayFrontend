import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';

interface FileNodeProps {
    data: {
        fileName: string;
        path?: string;
        lockStatus?: 'READING' | 'WRITING';
        lockUserId?: string;
        lockUserName?: string;
        lockColor?: string;
        isUpdated?: boolean;
        isSearchMatch?: boolean;
        isDark?: boolean;
    };
}

const FileNode = ({ data }: FileNodeProps) => {
    const { fileName, lockStatus, lockUserName, lockColor, isUpdated, isSearchMatch, path, isDark } = data;

    const isTaken = !!lockStatus;
    const resolvedPath = path ?? fileName;
    const displayName = getDisplayFileName(resolvedPath);
    const folderPath = getFolderPath(resolvedPath);
    const folderLabel = folderPath || '(repo root)';

    const accentColor = lockColor ?? (isDark ? '#71717a' : '#a1a1aa');
    const borderColor = isTaken ? accentColor : isDark ? '#71717a' : '#a1a1aa';
    const borderWidth = isTaken ? 2.8 : 1.5;
    const borderStyle = lockStatus === 'READING' ? 'dashed' : 'solid';
    const backgroundColor = !isTaken
        ? (isDark ? '#18181b' : '#fafafa')
        : lockStatus === 'WRITING'
            ? withOpacity(accentColor, isDark ? 0.24 : 0.16)
            : withOpacity(accentColor, isDark ? 0.16 : 0.1);
    const boxShadow = buildNodeShadow({
        isTaken,
        accentColor,
        isSearchMatch: Boolean(isSearchMatch),
        isUpdated: Boolean(isUpdated),
        isDark,
    });

    return (
        <div className="relative group">
            <style jsx>{`
                @keyframes gentle-pulse {
                    0%, 100% {
                        transform: scale(1);
                    }
                    50% {
                        transform: scale(1.05);
                    }
                }
                .pulse-animation {
                    animation: gentle-pulse 2s ease-in-out infinite;
                }
            `}</style>
            <div
                className={`relative min-w-[210px] overflow-hidden rounded-2xl px-4 py-3 transition-all duration-200 ${isDark ? 'text-zinc-100' : 'text-zinc-900'} ${isTaken ? 'pulse-animation' : ''}`}
                style={{
                    borderColor,
                    borderStyle,
                    borderWidth,
                    backgroundColor,
                    boxShadow,
                }}
            >
                {isSearchMatch && (
                    <div
                        className={`pointer-events-none absolute inset-0 rounded-2xl border animate-pulse ${isDark ? 'border-sky-300/70' : 'border-sky-500/55'}`}
                    />
                )}
                {isUpdated && (
                    <div
                        className={`pointer-events-none absolute inset-0 rounded-2xl border ${isDark ? 'border-zinc-500/60' : 'border-zinc-400/55'}`}
                    />
                )}

                <div className="truncate font-mono text-[12px] font-semibold" title={resolvedPath}>
                    {displayName}
                </div>
                <div
                    className={`mt-1 truncate text-[10px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                    title={folderLabel}
                >
                    Folder: {folderLabel}
                </div>
                {lockStatus && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                        <span
                            className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide"
                            style={{
                                borderColor: accentColor,
                                backgroundColor: withOpacity(accentColor, isDark ? 0.18 : 0.14),
                                color: isDark ? '#f4f4f5' : '#18181b',
                            }}
                        >
                            {lockStatus}
                        </span>
                        <span
                            className={`truncate text-[9px] ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                            title={lockUserName || 'Unknown user'}
                        >
                            {lockUserName || 'Unknown user'}
                        </span>
                    </div>
                )}
            </div>

            <Handle type="target" position={Position.Top} className={`!w-2 !h-1 !rounded-sm opacity-0 group-hover:opacity-100 transition-opacity ${isDark ? '!bg-zinc-600' : '!bg-zinc-300'}`} />
            <Handle type="source" position={Position.Bottom} className={`!w-2 !h-1 !rounded-sm opacity-0 group-hover:opacity-100 transition-opacity ${isDark ? '!bg-zinc-600' : '!bg-zinc-300'}`} />
        </div>
    );
};

function getDisplayFileName(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return path;
    }
    return path.slice(lastSlash + 1);
}

function getFolderPath(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return '';
    }
    return path.slice(0, lastSlash);
}

function buildNodeShadow({
    isTaken,
    accentColor,
    isSearchMatch,
    isUpdated,
    isDark,
}: {
    isTaken: boolean;
    accentColor: string;
    isSearchMatch: boolean;
    isUpdated: boolean;
    isDark?: boolean;
}): string {
    const layers: string[] = [];

    if (isTaken) {
        layers.push(`0 0 0 1px ${withOpacity(accentColor, isDark ? 0.9 : 0.7)}`);
        layers.push(`0 0 18px ${withOpacity(accentColor, isDark ? 0.45 : 0.32)}`);
    }

    if (isSearchMatch) {
        layers.push(isDark ? '0 0 0 1px rgba(56,189,248,0.85)' : '0 0 0 1px rgba(14,116,144,0.48)');
        layers.push(isDark ? '0 0 18px rgba(56,189,248,0.28)' : '0 0 12px rgba(56,189,248,0.2)');
    } else if (isUpdated) {
        layers.push(isDark ? '0 0 0 1px rgba(161,161,170,0.55)' : '0 0 0 1px rgba(113,113,122,0.35)');
    }

    return layers.length > 0 ? layers.join(', ') : 'none';
}

function withOpacity(hex: string, opacity: number): string {
    const cleaned = hex.replace('#', '');
    if (cleaned.length !== 6) {
        return hex;
    }

    const r = Number.parseInt(cleaned.slice(0, 2), 16);
    const g = Number.parseInt(cleaned.slice(2, 4), 16);
    const b = Number.parseInt(cleaned.slice(4, 6), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        return hex;
    }

    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export default memo(FileNode);
