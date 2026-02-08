import React, { ChangeEvent, useRef, useState } from 'react';
import { Download, FileJson, Moon, RefreshCw, RotateCcw, Settings2, Sun, Upload, X } from 'lucide-react';

const QUICK_INTERVALS = [10, 30, 60, 120];

interface AdminPanelProps {
    open: boolean;
    onClose: () => void;
    isDark: boolean;
    onToggleTheme: () => void;
    refreshIntervalMs: number;
    onRefreshIntervalChange: (value: number) => void;
    onInstantSync: () => void;
    syncInProgress: boolean;
    onReleaseAllLocks: () => Promise<{ success: boolean; released: number; error?: string }>;
    releaseAllLocksInProgress: boolean;
    onClearAgentAndFeed: () => Promise<{ success: boolean; released: number; cleared: number; error?: string }>;
    clearAgentAndFeedInProgress: boolean;
    onImportGraphJson: (json: string) => string | null;
    onExportGraph: () => void;
    onClearImportedGraph: () => void;
    isUsingImportedGraph: boolean;
    hasGraph: boolean;
}

export default function AdminPanel({
    open,
    onClose,
    isDark,
    onToggleTheme,
    refreshIntervalMs,
    onRefreshIntervalChange,
    onInstantSync,
    syncInProgress,
    onReleaseAllLocks,
    releaseAllLocksInProgress,
    onClearAgentAndFeed,
    clearAgentAndFeedInProgress,
    onImportGraphJson,
    onExportGraph,
    onClearImportedGraph,
    isUsingImportedGraph,
    hasGraph,
}: AdminPanelProps) {
    const [jsonDraft, setJsonDraft] = useState('');
    const [importFeedback, setImportFeedback] = useState<string | null>(null);
    const [lockFeedback, setLockFeedback] = useState<string | null>(null);
    const [clearFeedFeedback, setClearFeedFeedback] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    if (!open) {
        return null;
    }

    const seconds = Math.round(refreshIntervalMs / 1000);

    const onSecondsChange = (event: ChangeEvent<HTMLInputElement>) => {
        const raw = Number.parseInt(event.target.value, 10);
        if (!Number.isFinite(raw)) {
            return;
        }

        onRefreshIntervalChange(raw * 1000);
    };

    const runImport = (raw: string) => {
        const error = onImportGraphJson(raw);
        if (error) {
            setImportFeedback(error);
            return;
        }
        setImportFeedback('Graph imported. Live GitHub polling paused.');
    };

    const onImportClick = () => {
        runImport(jsonDraft);
    };

    const onImportFile: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        try {
            const raw = await file.text();
            setJsonDraft(raw);
            runImport(raw);
        } catch {
            setImportFeedback('Failed to read selected file.');
        } finally {
            event.target.value = '';
        }
    };

    const onExitImportedMode = () => {
        onClearImportedGraph();
        setImportFeedback('Returned to live GitHub graph mode.');
    };

    const onReleaseAllLocksClick = async () => {
        setLockFeedback(null);
        const result = await onReleaseAllLocks();
        if (!result.success) {
            setLockFeedback(result.error ?? 'Failed to release locks.');
            return;
        }

        const count = result.released;
        if (count === 0) {
            setLockFeedback('No active locks to release.');
            return;
        }
        setLockFeedback(`Released ${count} lock${count === 1 ? '' : 's'}.`);
    };

    const onClearAgentAndFeedClick = async () => {
        setClearFeedFeedback(null);
        const result = await onClearAgentAndFeed();
        if (!result.success) {
            setClearFeedFeedback(result.error ?? 'Failed to clear agent tab and live feed.');
            return;
        }

        if (result.released === 0 && result.cleared === 0) {
            setClearFeedFeedback('No agents or feed entries to clear.');
            return;
        }

        setClearFeedFeedback(
            `Cleared ${result.released} lock${result.released === 1 ? '' : 's'} and ${result.cleared} feed item${result.cleared === 1 ? '' : 's'}.`,
        );
    };

    return (
        <div className="absolute right-4 top-14 z-[90] w-[min(96vw,430px)]">
            <div className={`overflow-hidden border rounded-2xl shadow-2xl ${isDark ? 'border-zinc-700 bg-black text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}>
                <header className={`flex items-center justify-between border-b px-4 py-3 ${isDark ? 'border-zinc-700 bg-zinc-950' : 'border-zinc-200 bg-zinc-50'}`}>
                    <div className="flex items-center gap-2">
                        <Settings2 className={`h-4 w-4 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`} />
                        <h2 className="text-sm font-semibold tracking-wide">Admin Panel</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className={`rounded-md p-1 transition-colors ${isDark ? 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'}`}
                        aria-label="Close admin panel"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>

                <div className="space-y-4 px-4 py-4">
                    <section>
                        <h3 className={`text-xs font-semibold uppercase tracking-[0.16em] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                            Theme
                        </h3>
                        <button
                            onClick={onToggleTheme}
                            className={`mt-2 inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors ${isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700' : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'}`}
                        >
                            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                            {isDark ? 'Switch to light' : 'Switch to dark'}
                        </button>
                    </section>

                    <section>
                        <h3 className={`text-xs font-semibold uppercase tracking-[0.16em] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                            GitHub Refresh Rate
                        </h3>
                        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                            Graph polling interval (default is 120 seconds).
                        </p>

                        <button
                            onClick={onInstantSync}
                            disabled={syncInProgress || isUsingImportedGraph}
                            className={`mt-3 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20' : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                            title={isUsingImportedGraph ? 'Switch to live graph mode to sync from GitHub.' : 'Run a sync now.'}
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${syncInProgress ? 'animate-spin' : ''}`} />
                            {syncInProgress ? 'Syncing…' : 'Instant Sync'}
                        </button>

                        <button
                            onClick={onReleaseAllLocksClick}
                            disabled={releaseAllLocksInProgress || isUsingImportedGraph}
                            className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'border-rose-500/60 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20' : 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'}`}
                            title={isUsingImportedGraph ? 'Switch to live graph mode to manage locks.' : 'Manually release every active lock for this repo/branch.'}
                        >
                            {releaseAllLocksInProgress ? 'Releasing…' : 'Release All Locks'}
                        </button>

                        {lockFeedback && (
                            <p className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-600'}`}>
                                {lockFeedback}
                            </p>
                        )}

                        <button
                            onClick={onClearAgentAndFeedClick}
                            disabled={clearAgentAndFeedInProgress || isUsingImportedGraph}
                            className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20' : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
                            title={isUsingImportedGraph ? 'Switch to live graph mode to clear live state.' : 'Clear active agents and live feed for this repo/branch.'}
                        >
                            {clearAgentAndFeedInProgress ? 'Clearing…' : 'Clear Agent Tab + Live Feed'}
                        </button>

                        {clearFeedFeedback && (
                            <p className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-600'}`}>
                                {clearFeedFeedback}
                            </p>
                        )}

                        <div className="mt-3 flex items-center gap-2">
                            {QUICK_INTERVALS.map((value) => {
                                const selected = value === seconds;
                                return (
                                    <button
                                        key={value}
                                        onClick={() => onRefreshIntervalChange(value * 1000)}
                                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${selected
                                            ? isDark
                                                ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                                                : 'border-zinc-400 bg-zinc-100 text-zinc-800'
                                            : isDark
                                                ? 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                                                : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                                        }`}
                                    >
                                        {value}s
                                    </button>
                                );
                            })}
                        </div>

                        <label className={`mt-3 block text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} htmlFor="refresh-seconds">
                            Custom seconds
                        </label>
                        <input
                            id="refresh-seconds"
                            min={5}
                            max={300}
                            step={1}
                            value={seconds}
                            onChange={onSecondsChange}
                            type="number"
                            className={`mt-1 w-full border rounded-lg px-3 py-2 text-sm outline-none transition-colors ${isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500' : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500'}`}
                        />
                    </section>

                    <section>
                        <h3 className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                            <FileJson className="h-3.5 w-3.5" />
                            Graph JSON
                        </h3>
                        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                            Import/export graph snapshots for local testing without extra GitHub requests.
                        </p>

                        <textarea
                            className={`mt-2 h-28 w-full resize-y rounded-lg border px-3 py-2 text-xs outline-none transition-colors ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 placeholder:text-zinc-500 focus:border-zinc-500' : 'border-zinc-200 bg-zinc-50 text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400'}`}
                            placeholder='Paste graph JSON here...'
                            value={jsonDraft}
                            onChange={(event) => setJsonDraft(event.target.value)}
                        />

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                                onClick={onImportClick}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700' : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'}`}
                            >
                                <Upload className="h-3.5 w-3.5" />
                                Import JSON
                            </button>

                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100'}`}
                            >
                                <Upload className="h-3.5 w-3.5" />
                                Import File
                            </button>

                            <button
                                onClick={onExportGraph}
                                disabled={!hasGraph}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800' : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100'}`}
                            >
                                <Download className="h-3.5 w-3.5" />
                                Export JSON
                            </button>

                            {isUsingImportedGraph && (
                                <button
                                    onClick={onExitImportedMode}
                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${isDark ? 'border-zinc-600 bg-zinc-700 text-zinc-100 hover:bg-zinc-600' : 'border-zinc-300 bg-zinc-200 text-zinc-800 hover:bg-zinc-300'}`}
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    Use Live Graph
                                </button>
                            )}
                        </div>

                        {importFeedback && (
                            <p className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11px] ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-600'}`}>
                                {importFeedback}
                            </p>
                        )}

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/json,.json"
                            className="hidden"
                            onChange={onImportFile}
                        />
                    </section>
                </div>
            </div>
        </div>
    );
}
