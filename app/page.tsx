'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from 'reactflow';
import 'reactflow/dist/style.css';

interface GraphNode {
  id: string;
  type: 'file';
  size?: number;
  language?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  type: 'import';
}

interface LockEntry {
  user_id: string;
  user_name: string;
  status: 'READING' | 'WRITING';
  message: string;
  timestamp: number;
  expiry: number;
}

interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  locks: Record<string, LockEntry>;
  version: string;
  metadata: {
    generated_at: number;
    files_processed: number;
    edges_found: number;
  };
}

type StatusFilter = 'ALL' | 'AVAILABLE' | 'READING' | 'WRITING';

type ActivityEvent = {
  id: string;
  type: 'lock_acquired' | 'lock_released' | 'lock_reassigned';
  filePath: string;
  userName: string;
  message: string;
  timestamp: number;
};

type NodeData = {
  label: React.ReactNode;
};

const initialRepo = 'github.com/luljaj/relayfrontend';
const initialBranch = 'master';

export default function HomePage() {
  const [repoUrl, setRepoUrl] = useState(initialRepo);
  const [branch, setBranch] = useState(initialBranch);
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);
  const previousLocksRef = useRef<Record<string, LockEntry>>({});

  const lockCount = useMemo(() => Object.keys(graph?.locks ?? {}).length, [graph]);

  const filteredNodes = useMemo(() => {
    if (!graph) {
      return [];
    }

    const query = search.trim().toLowerCase();

    return graph.nodes
      .filter((node) => {
        if (!query) {
          return true;
        }

        return node.id.toLowerCase().includes(query);
      })
      .filter((node) => {
        const lock = graph.locks[node.id];

        if (statusFilter === 'ALL') {
          return true;
        }

        if (statusFilter === 'AVAILABLE') {
          return !lock;
        }

        return lock?.status === statusFilter;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [graph, search, statusFilter]);

  const visibleNodeSet = useMemo(() => new Set(filteredNodes.map((node) => node.id)), [filteredNodes]);

  const flowNodes = useMemo<Node<NodeData>[]>(() => {
    if (!graph || filteredNodes.length === 0) {
      return [];
    }

    const columns = Math.max(2, Math.ceil(Math.sqrt(filteredNodes.length)));
    const xStep = 250;
    const yStep = 130;

    return filteredNodes.map((node, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const lock = graph.locks[node.id];
      const colors = getNodeColors(lock, selectedNodeId === node.id);

      return {
        id: node.id,
        data: {
          label: (
            <div className="rf-label">
              <span className="rf-title">{fileName(node.id)}</span>
              <span className="rf-subtitle">{lock ? `${lock.status} • ${lock.user_name}` : node.language ?? 'file'}</span>
            </div>
          ),
        },
        position: {
          x: column * xStep,
          y: row * yStep,
        },
        style: {
          width: 220,
          borderRadius: 14,
          border: `2px solid ${colors.border}`,
          background: colors.background,
          color: colors.text,
          padding: '0.35rem 0.45rem',
          boxShadow: '0 4px 18px rgba(2, 6, 23, 0.08)',
          fontSize: 12,
        },
        draggable: true,
      };
    });
  }, [graph, filteredNodes, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!graph) {
      return [];
    }

    return graph.edges
      .filter((edge) => visibleNodeSet.has(edge.source) && visibleNodeSet.has(edge.target))
      .map((edge) => {
        const locked = Boolean(graph.locks[edge.source] || graph.locks[edge.target]);

        return {
          id: `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          animated: locked,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: locked ? '#b45309' : '#64748b',
            width: 18,
            height: 18,
          },
          style: {
            stroke: locked ? '#b45309' : '#64748b',
            strokeWidth: locked ? 2.2 : 1.2,
            opacity: 0.8,
          },
        };
      });
  }, [graph, visibleNodeSet]);

  const selectedDetails = useMemo(() => {
    if (!graph || !selectedNodeId) {
      return null;
    }

    const node = graph.nodes.find((entry) => entry.id === selectedNodeId);
    if (!node) {
      return null;
    }

    const dependencies = graph.edges.filter((edge) => edge.source === selectedNodeId).map((edge) => edge.target);
    const dependents = graph.edges.filter((edge) => edge.target === selectedNodeId).map((edge) => edge.source);

    return {
      node,
      dependencies,
      dependents,
      lock: graph.locks[selectedNodeId] ?? null,
    };
  }, [graph, selectedNodeId]);

  const fetchGraph = useCallback(
    async (options?: { regenerate?: boolean }) => {
      if (!hasLoadedRef.current) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setError(null);

      try {
        const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
        const query = new URLSearchParams({
          repo_url: normalizedRepoUrl,
          branch: branch.trim() || 'master',
          ...(options?.regenerate ? { regenerate: 'true' } : {}),
        });

        const response = await fetch(`/api/graph?${query.toString()}`);
        const data = (await response.json()) as DependencyGraph | { error: string };

        if (!response.ok) {
          const message = 'error' in data ? data.error : 'Failed to fetch graph';
          throw new Error(message);
        }

        const nextGraph = data as DependencyGraph;
        setGraph(nextGraph);
        captureActivity(previousLocksRef.current, nextGraph.locks, setActivities);
        previousLocksRef.current = nextGraph.locks;

        setSelectedNodeId((current) => current ?? (nextGraph.nodes[0]?.id ?? null));

        hasLoadedRef.current = true;
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : 'Unknown error';
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [repoUrl, branch],
  );

  useEffect(() => {
    previousLocksRef.current = {};
    setActivities([]);
    setSelectedNodeId(null);
    hasLoadedRef.current = false;

    fetchGraph();
    const interval = setInterval(() => {
      fetchGraph();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchGraph]);

  useEffect(() => {
    if (!graph || !selectedNodeId) {
      return;
    }

    const exists = graph.nodes.some((node) => node.id === selectedNodeId);
    if (!exists) {
      setSelectedNodeId(null);
    }
  }, [graph, selectedNodeId]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    fetchGraph();
  }

  const onNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedNodeId(node.id);
  };

  return (
    <main className="dashboard-shell">
      <section className="panel controls-panel">
        <div>
          <h1 className="title">Relay Coordination Graph</h1>
          <p className="subtitle">
            Polling <code>/api/graph</code> every 5 seconds with lock overlays and dependency links.
          </p>
        </div>

        <form onSubmit={onSubmit} className="controls-form">
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="github.com/user/repo"
            className="control-input"
          />
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            className="control-input"
          />
          <button type="submit" className="action-button">
            Refresh
          </button>
          <button type="button" className="action-button secondary" onClick={() => fetchGraph({ regenerate: true })}>
            Regenerate
          </button>
        </form>

        <div className="toolbar-row">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search files..."
            className="control-input"
          />

          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            className="control-input"
          >
            <option value="ALL">All statuses</option>
            <option value="AVAILABLE">Available</option>
            <option value="READING">Reading</option>
            <option value="WRITING">Writing</option>
          </select>
        </div>

        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="summary-grid">
        <MetricCard label="Files" value={graph?.nodes.length ?? 0} />
        <MetricCard label="Edges" value={graph?.edges.length ?? 0} />
        <MetricCard label="Active Locks" value={lockCount} />
        <MetricCard
          label="Last Generated"
          value={graph?.metadata.generated_at ? new Date(graph.metadata.generated_at).toLocaleTimeString() : 'Not yet'}
        />
      </section>

      <section className="workspace-grid">
        <aside className="panel sidebar-panel">
          <h2>Files</h2>
          <p className="panel-meta">{filteredNodes.length} visible</p>
          <div className="file-list">
            {filteredNodes.slice(0, 500).map((node) => {
              const lock = graph?.locks[node.id];
              return (
                <button
                  key={node.id}
                  className={`file-row ${selectedNodeId === node.id ? 'selected' : ''}`}
                  type="button"
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="file-path">{node.id}</span>
                  <span className={`status-pill ${lock ? lock.status.toLowerCase() : 'available'}`}>
                    {lock ? `${lock.status}` : 'AVAILABLE'}
                  </span>
                </button>
              );
            })}
            {filteredNodes.length === 0 && <p className="empty-text">No files match current filter.</p>}
          </div>
        </aside>

        <section className="panel graph-panel">
          <div className="graph-header">
            <h2>Dependency Graph</h2>
            <span className="panel-meta">{refreshing ? 'Refreshing...' : graph ? `Version ${graph.version.slice(0, 7)}` : 'No graph'}</span>
          </div>

          {!graph && loading && <p className="empty-text">Loading graph...</p>}
          {graph && flowNodes.length === 0 && <p className="empty-text">No nodes to display for current filters.</p>}

          {graph && flowNodes.length > 0 && (
            <div className="graph-canvas">
              <ReactFlow nodes={flowNodes} edges={flowEdges} fitView onNodeClick={onNodeClick} minZoom={0.2} maxZoom={2.2}>
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => {
                    const lock = graph.locks[node.id];
                    if (!lock) return '#0ea5a4';
                    if (lock.status === 'WRITING') return '#dc2626';
                    return '#d97706';
                  }}
                />
                <Controls position="bottom-right" />
                <Background color="#cbd5e1" gap={16} size={1} />
              </ReactFlow>
            </div>
          )}
        </section>

        <aside className="panel detail-panel">
          <h2>Details</h2>

          {!selectedDetails && <p className="empty-text">Select a file to inspect dependencies and lock info.</p>}

          {selectedDetails && (
            <div className="detail-block">
              <h3>{selectedDetails.node.id}</h3>
              <p className="panel-meta">
                {selectedDetails.node.language ?? 'unknown'}
                {typeof selectedDetails.node.size === 'number' ? ` • ${selectedDetails.node.size} bytes` : ''}
              </p>

              <p>
                <strong>Lock:</strong>{' '}
                {selectedDetails.lock
                  ? `${selectedDetails.lock.status} by ${selectedDetails.lock.user_name}`
                  : 'No active lock'}
              </p>
              {selectedDetails.lock && <p className="lock-message">{selectedDetails.lock.message}</p>}

              <p>
                <strong>Dependencies:</strong> {selectedDetails.dependencies.length}
              </p>
              <ul className="compact-list">
                {selectedDetails.dependencies.slice(0, 12).map((dep) => (
                  <li key={dep}>{dep}</li>
                ))}
              </ul>

              <p>
                <strong>Dependents:</strong> {selectedDetails.dependents.length}
              </p>
              <ul className="compact-list">
                {selectedDetails.dependents.slice(0, 12).map((dep) => (
                  <li key={dep}>{dep}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="activity-block">
            <h3>Activity</h3>
            <div className="activity-list">
              {activities.map((activity) => (
                <div key={activity.id} className="activity-row">
                  <span className="activity-type">{activity.type.replace('_', ' ')}</span>
                  <span className="activity-file">{activity.filePath}</span>
                  <span className="activity-meta">
                    {activity.userName} • {relativeTime(activity.timestamp)}
                  </span>
                </div>
              ))}
              {activities.length === 0 && <p className="empty-text">No lock transitions yet.</p>}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <article className="panel metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
    </article>
  );
}

function normalizeRepoUrl(input: string): string {
  const value = input.trim();

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  if (value.startsWith('github.com/')) {
    return `https://${value}`;
  }

  return value;
}

function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function getNodeColors(lock: LockEntry | undefined, selected: boolean): {
  background: string;
  border: string;
  text: string;
} {
  if (!lock) {
    return {
      background: selected ? '#d1fae5' : '#ecfdf5',
      border: selected ? '#047857' : '#10b981',
      text: '#064e3b',
    };
  }

  if (lock.status === 'WRITING') {
    return {
      background: selected ? '#fee2e2' : '#fef2f2',
      border: selected ? '#b91c1c' : '#ef4444',
      text: '#7f1d1d',
    };
  }

  return {
    background: selected ? '#fef3c7' : '#fffbeb',
    border: selected ? '#b45309' : '#f59e0b',
    text: '#78350f',
  };
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;

  if (delta < 1000 * 30) return 'just now';
  if (delta < 1000 * 60) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 1000 * 60 * 60) return `${Math.floor(delta / (1000 * 60))}m ago`;

  return `${Math.floor(delta / (1000 * 60 * 60))}h ago`;
}

function captureActivity(
  previousLocks: Record<string, LockEntry>,
  currentLocks: Record<string, LockEntry>,
  setActivities: React.Dispatch<React.SetStateAction<ActivityEvent[]>>,
): void {
  const events: ActivityEvent[] = [];

  for (const [filePath, lock] of Object.entries(currentLocks)) {
    const prev = previousLocks[filePath];

    if (!prev) {
      events.push({
        id: `acquire:${filePath}:${lock.timestamp}`,
        type: 'lock_acquired',
        filePath,
        userName: lock.user_name,
        message: lock.message,
        timestamp: lock.timestamp,
      });
      continue;
    }

    if (prev.user_id !== lock.user_id || prev.status !== lock.status) {
      events.push({
        id: `reassign:${filePath}:${lock.timestamp}`,
        type: 'lock_reassigned',
        filePath,
        userName: lock.user_name,
        message: lock.message,
        timestamp: lock.timestamp,
      });
    }
  }

  for (const [filePath, lock] of Object.entries(previousLocks)) {
    if (!currentLocks[filePath]) {
      events.push({
        id: `release:${filePath}:${Date.now()}`,
        type: 'lock_released',
        filePath,
        userName: lock.user_name,
        message: lock.message,
        timestamp: Date.now(),
      });
    }
  }

  if (events.length === 0) {
    return;
  }

  setActivities((prev) => [...events, ...prev].sort((a, b) => b.timestamp - a.timestamp).slice(0, 25));
}
