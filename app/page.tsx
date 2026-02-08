'use client';

import { useEffect, useRef, useState } from 'react';
import { PanelRightOpen, X } from 'lucide-react';
import { useGraphData } from './hooks/useGraphData';
import GraphPanel from './components/GraphPanel';
import SidebarPanel from './components/SidebarPanel';
import AdminPanel from './components/AdminPanel';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const LEGACY_DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;
const MAX_REFRESH_INTERVAL_MS = 300_000;

export default function HomePage() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(DEFAULT_REFRESH_INTERVAL_MS);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const comboUsedRef = useRef(false);

  const {
    graph,
    repoUrl,
    setRepoUrl,
    branch,
    setBranch,
    activities,
    fetchGraph,
    refreshing,
    loading,
    error,
    lastUpdatedAt,
    isUsingImportedGraph,
    importGraphFromJson,
    clearImportedGraph,
    exportGraphJson,
  } = useGraphData({ pollIntervalMs: refreshIntervalMs });

  const locks = graph?.locks ?? {};

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const storedTheme = window.localStorage.getItem('devfest_theme');
    if (storedTheme === 'dark') {
      setIsDark(true);
    } else if (storedTheme === 'light') {
      setIsDark(false);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setIsDark(true);
    }

    const storedInterval = Number.parseInt(window.localStorage.getItem('devfest_refresh_interval_ms') ?? '', 10);
    if (Number.isFinite(storedInterval)) {
      const normalized = normalizeRefreshInterval(storedInterval);
      setRefreshIntervalMs(
        normalized === LEGACY_DEFAULT_REFRESH_INTERVAL_MS
          ? DEFAULT_REFRESH_INTERVAL_MS
          : normalized,
      );
    }

    setPreferencesHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('dark', isDark);

    if (!preferencesHydrated) {
      return;
    }

    window.localStorage.setItem('devfest_theme', isDark ? 'dark' : 'light');
    window.localStorage.setItem('devfest_refresh_interval_ms', String(refreshIntervalMs));
  }, [isDark, refreshIntervalMs, preferencesHydrated]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      pressedKeysRef.current.add(event.code);
      const comboActive = isAdminComboPressed(pressedKeysRef.current, event.shiftKey);
      if (!comboActive || comboUsedRef.current) {
        return;
      }

      comboUsedRef.current = true;
      setAdminPanelOpen((previous) => !previous);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      pressedKeysRef.current.delete(event.code);
      if (!isAdminComboPressed(pressedKeysRef.current, false)) {
        comboUsedRef.current = false;
      }
    };

    const onBlur = () => {
      pressedKeysRef.current.clear();
      comboUsedRef.current = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onRefreshIntervalChange = (value: number) => {
    setRefreshIntervalMs(normalizeRefreshInterval(value));
  };

  const onImportGraphJson = (json: string): string | null => {
    const result = importGraphFromJson(json);
    return result.error;
  };

  const onExportGraph = () => {
    const payload = exportGraphJson();
    if (!payload || typeof window === 'undefined') {
      return;
    }

    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    downloadLink.href = url;
    downloadLink.download = `dependency-graph-${timestamp}.json`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  };

  return (
    <main className={`relative flex h-screen w-screen overflow-hidden pt-12 ${isDark ? 'bg-black text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      {error && (
        <div className={`absolute left-1/2 top-14 z-[70] w-[min(96vw,680px)] -translate-x-1/2 border px-4 py-2 text-sm font-medium shadow-lg ${isDark ? 'border-zinc-700 bg-zinc-900/95 text-zinc-200' : 'border-zinc-300 bg-white text-zinc-700'}`}>
          Error: {error}
        </div>
      )}

      <section className="relative h-full flex-1 p-3 pb-4 md:p-4 md:pb-5 lg:pr-2">
        <GraphPanel
          graph={graph}
          repoUrl={repoUrl}
          setRepoUrl={setRepoUrl}
          branch={branch}
          setBranch={setBranch}
          onRefresh={() => fetchGraph({ regenerate: true })}
          refreshing={refreshing}
          loading={loading}
          lastUpdatedAt={lastUpdatedAt}
          pollIntervalMs={refreshIntervalMs}
          isDark={isDark}
          onToggleTheme={() => setIsDark((previous) => !previous)}
        />

        <AdminPanel
          open={adminPanelOpen}
          onClose={() => setAdminPanelOpen(false)}
          isDark={isDark}
          onToggleTheme={() => setIsDark((previous) => !previous)}
          refreshIntervalMs={refreshIntervalMs}
          onRefreshIntervalChange={onRefreshIntervalChange}
          onImportGraphJson={onImportGraphJson}
          onExportGraph={onExportGraph}
          onClearImportedGraph={clearImportedGraph}
          isUsingImportedGraph={isUsingImportedGraph}
          hasGraph={!!graph}
        />
      </section>

      <aside className="hidden h-full w-[350px] shrink-0 p-4 pl-2 lg:block">
        <SidebarPanel activities={activities} locks={locks} isDark={isDark} />
      </aside>

      <button
        className={`absolute right-4 top-14 z-[75] border p-2 shadow-lg backdrop-blur-sm lg:hidden ${isDark ? 'border-zinc-700 bg-zinc-900/90 text-zinc-200' : 'border-zinc-200 bg-white/90 text-zinc-700'}`}
        onClick={() => setMobileSidebarOpen(true)}
        aria-label="Open activity sidebar"
      >
        <PanelRightOpen className="h-5 w-5" />
      </button>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-[80] lg:hidden">
          <button
            className={`absolute inset-0 ${isDark ? 'bg-black/65' : 'bg-zinc-900/40'} backdrop-blur-[1px]`}
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close sidebar backdrop"
          />

          <div className="absolute right-0 top-0 h-full w-[90vw] max-w-[360px] py-2 pr-2">
            <button
              className={`absolute left-3 top-3 z-[81] border p-1 shadow ${isDark ? 'border-zinc-700 bg-zinc-900 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-600'}`}
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="Close activity sidebar"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarPanel activities={activities} locks={locks} isDark={isDark} />
          </div>
        </div>
      )}
    </main>
  );
}

function isAdminComboPressed(pressed: Set<string>, shiftKey: boolean): boolean {
  const hasShift = shiftKey || pressed.has('ShiftLeft') || pressed.has('ShiftRight');
  return hasShift && pressed.has('KeyA') && pressed.has('Digit1');
}

function normalizeRefreshInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }

  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(value)));
}
