import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
    Background,
    BackgroundVariant,
    Controls,
    Edge,
    MarkerType,
    MiniMap,
    Node,
    NodeMouseHandler,
    Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { DependencyGraph, LockEntry } from '../hooks/useGraphData';
import FileNode from './FileNode';
import DependencyEdge from './DependencyEdge';
import ControlDock from './ControlDock';
import NodeDetailsDialog from './NodeDetailsDialog';

const nodeTypes = {
    activeFile: FileNode,
};

const edgeTypes = {
    dependency: DependencyEdge,
};

interface GraphPanelProps {
    graph: DependencyGraph | null;
    repoUrl: string;
    setRepoUrl: (url: string) => void;
    branch: string;
    setBranch: (branch: string) => void;
    onRefresh: () => void;
    refreshing: boolean;
    loading: boolean;
    lastUpdatedAt: number | null;
    pollIntervalMs: number;
    isDark: boolean;
    onToggleTheme: () => void;
}

const NODE_UPDATE_HIGHLIGHT_MS = 4500;
const NEW_EDGE_HIGHLIGHT_MS = 2500;
const LAYOUT_X_STEP = 360;
const LAYOUT_Y_STEP = 210;
const LAYOUT_SPAWN_JITTER = 24;
const LAYOUT_TICK_MS = 42;
const LAYOUT_EDGE_LENGTH = 120; // Reduce edge length to keep hierarchy tighter
const LAYOUT_EDGE_SPRING = 0.08; // Strong springs to keep structure tight
const LAYOUT_REPULSION = 12000; // Reduced repulsion to prevent infinite spread
const LAYOUT_REPULSION_MIN_DISTANCE = 140; // Moderate personal space
const LAYOUT_CENTER_GRAVITY = 0.001; // Minimal gravity just to keep it loosely on screen
const LAYOUT_SAME_FOLDER_TARGET = 100;
const LAYOUT_SAME_FOLDER_RANGE = 2000;
const LAYOUT_SAME_FOLDER_PULL = 0.008;
const LAYOUT_BROWNIAN_MOTION = 0.02; // Reduced jitter for stability
const LAYOUT_MIN_X_GAP = 200; // Adjusted for hierarchy
const LAYOUT_MIN_Y_GAP = 120; // Adjusted for hierarchy
const LAYOUT_AXIS_GAP_PUSH = 0.05;
const LAYOUT_AXIS_GAP_PUSH_MAX = 2.8;
const LAYOUT_HIERARCHY_STRENGTH = 0.2; // Strength of the Y-axis alignment force
const LAYOUT_HIERARCHY_LEVEL_HEIGHT = 180; // Vertical distance between levels
const LAYOUT_FOLDER_GROUP_X_STEP = 520;
const LAYOUT_FOLDER_GROUP_Y_STEP = 340;
const LAYOUT_FOLDER_ITEM_X_STEP = 260;
const LAYOUT_FOLDER_ITEM_Y_STEP = 130;
const LAYOUT_DAMPING = 0.60; // High friction/viscosity to stop movement quickly
const LAYOUT_MAX_SPEED = 0.4; // Very slow, deliberate movement cap
const VIEW_TRANSITION_OVERLAY_MS = 1000;

type Point = { x: number; y: number };

export default function GraphPanel({
    graph,
    repoUrl,
    setRepoUrl,
    branch,
    setBranch,
    onRefresh,
    refreshing,
    loading,
    lastUpdatedAt,
    pollIntervalMs,
    isDark,
    onToggleTheme,
}: GraphPanelProps) {
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [updatedNodeExpiry, setUpdatedNodeExpiry] = useState<Record<string, number>>({});
    const [newEdgeExpiry, setNewEdgeExpiry] = useState<Record<string, number>>({});
    const [nodePositions, setNodePositions] = useState<Record<string, Point>>({});
    const [showViewTransitionOverlay, setShowViewTransitionOverlay] = useState(false);
    const previousLocksRef = useRef<Record<string, LockEntry>>({});
    const previousEdgesRef = useRef<Set<string>>(new Set());
    const previousStructureSignatureRef = useRef('');
    const viewTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const velocitiesRef = useRef<Record<string, Point>>({});
    const structureSignature = useMemo(() => {
        if (!graph) {
            return '';
        }

        const nodeIds = graph.nodes.map((node) => node.id).sort().join('|');
        const edgeIds = graph.edges.map((edge) => toEdgeId(edge.source, edge.target)).sort().join('|');
        return `${nodeIds}::${edgeIds}`;
    }, [graph]);

    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            setUpdatedNodeExpiry((previous) => pruneExpired(previous, now));
            setNewEdgeExpiry((previous) => pruneExpired(previous, now));
        }, 700);

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!structureSignature) {
            previousStructureSignatureRef.current = '';
            return;
        }

        const previousSignature = previousStructureSignatureRef.current;
        previousStructureSignatureRef.current = structureSignature;
        if (!previousSignature || previousSignature === structureSignature) {
            return;
        }

        setShowViewTransitionOverlay(true);
        if (viewTransitionTimerRef.current) {
            clearTimeout(viewTransitionTimerRef.current);
        }
        viewTransitionTimerRef.current = setTimeout(() => {
            setShowViewTransitionOverlay(false);
            viewTransitionTimerRef.current = null;
        }, VIEW_TRANSITION_OVERLAY_MS);
    }, [structureSignature]);

    useEffect(() => {
        return () => {
            if (viewTransitionTimerRef.current) {
                clearTimeout(viewTransitionTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!graph) {
            setNodePositions({});
            velocitiesRef.current = {};
            return;
        }

        setNodePositions((previous) => {
            const next: Record<string, Point> = {};
            const seededPositions = buildFolderClusterPositions(graph.nodes.map((node) => node.id));

            for (const node of graph.nodes) {
                const existing = previous[node.id];
                if (existing) {
                    next[node.id] = existing;
                    continue;
                }

                next[node.id] = seededPositions[node.id] ?? { x: 0, y: 0 };
            }

            return next;
        });

        const nextVelocities: Record<string, Point> = {};
        for (const node of graph.nodes) {
            nextVelocities[node.id] = velocitiesRef.current[node.id] ?? { x: 0, y: 0 };
        }
        velocitiesRef.current = nextVelocities;
    }, [graph, structureSignature]);

    useEffect(() => {
        if (!graph || graph.nodes.length === 0) {
            return;
        }

        const nodeIds = graph.nodes.map((node) => node.id);
        const edges = graph.edges.map((edge) => ({ source: edge.source, target: edge.target }));
        const folderByNodeId = Object.fromEntries(
            graph.nodes.map((node) => [node.id, getFolderPath(node.id)]),
        );

        // Calculate hierarchical levels
        const nodeLevels = calculateNodeLevels(nodeIds, edges);
        const seededPositions = buildFolderClusterPositions(nodeIds);

        const interval = setInterval(() => {
            setNodePositions((previous) => {
                if (Object.keys(previous).length === 0) {
                    return previous;
                }

                const nextPositions: Record<string, Point> = {};
                const forces: Record<string, Point> = {};
                const nextVelocities: Record<string, Point> = { ...velocitiesRef.current };

                for (const nodeId of nodeIds) {
                    const fallback = seededPositions[nodeId] ?? { x: 0, y: 0 };
                    nextPositions[nodeId] = previous[nodeId] ?? fallback;
                    forces[nodeId] = { x: 0, y: 0 };

                    // Brownian motion / Floating effect
                    forces[nodeId].x += (Math.random() - 0.5) * LAYOUT_BROWNIAN_MOTION;
                    forces[nodeId].y += (Math.random() - 0.5) * LAYOUT_BROWNIAN_MOTION;
                }

                for (let i = 0; i < nodeIds.length; i += 1) {
                    const sourceId = nodeIds[i];
                    for (let j = i + 1; j < nodeIds.length; j += 1) {
                        const targetId = nodeIds[j];
                        const source = nextPositions[sourceId];
                        const target = nextPositions[targetId];
                        const deltaX = target.x - source.x;
                        const deltaY = target.y - source.y;
                        const distance = Math.max(
                            Math.hypot(deltaX, deltaY),
                            LAYOUT_REPULSION_MIN_DISTANCE,
                        );
                        const directionX = deltaX / distance;
                        const directionY = deltaY / distance;
                        const magnitude = LAYOUT_REPULSION / (distance * distance);

                        forces[sourceId].x -= directionX * magnitude;
                        forces[sourceId].y -= directionY * magnitude;
                        forces[targetId].x += directionX * magnitude;
                        forces[targetId].y += directionY * magnitude;

                        if (folderByNodeId[sourceId] === folderByNodeId[targetId]) {
                            const separation = distance - LAYOUT_SAME_FOLDER_TARGET;
                            // Pull them together if they drift too far, or push if too close
                            if (Math.abs(separation) > 5) {
                                const folderPull = separation * LAYOUT_SAME_FOLDER_PULL;
                                forces[sourceId].x += directionX * folderPull;
                                forces[sourceId].y += directionY * folderPull;
                                forces[targetId].x -= directionX * folderPull;
                                forces[targetId].y -= directionY * folderPull;
                            }
                        }

                        const absDeltaX = Math.abs(deltaX);
                        if (absDeltaX < LAYOUT_MIN_X_GAP) {
                            const pushX = Math.min(
                                (LAYOUT_MIN_X_GAP - absDeltaX) * LAYOUT_AXIS_GAP_PUSH,
                                LAYOUT_AXIS_GAP_PUSH_MAX,
                            );
                            const separationDirectionX = absDeltaX < 0.001
                                ? getAxisSeparationDirection(sourceId, targetId, 'x')
                                : deltaX / absDeltaX;
                            forces[sourceId].x -= separationDirectionX * pushX;
                            forces[targetId].x += separationDirectionX * pushX;
                        }

                        const absDeltaY = Math.abs(deltaY);
                        if (absDeltaY < LAYOUT_MIN_Y_GAP) {
                            const pushY = Math.min(
                                (LAYOUT_MIN_Y_GAP - absDeltaY) * LAYOUT_AXIS_GAP_PUSH,
                                LAYOUT_AXIS_GAP_PUSH_MAX,
                            );
                            const separationDirectionY = absDeltaY < 0.001
                                ? getAxisSeparationDirection(sourceId, targetId, 'y')
                                : deltaY / absDeltaY;
                            forces[sourceId].y -= separationDirectionY * pushY;
                            forces[targetId].y += separationDirectionY * pushY;
                        }
                    }
                }

                for (const edge of edges) {
                    const source = nextPositions[edge.source];
                    const target = nextPositions[edge.target];
                    if (!source || !target) {
                        continue;
                    }

                    const deltaX = target.x - source.x;
                    const deltaY = target.y - source.y;
                    const distance = Math.max(Math.hypot(deltaX, deltaY), 1);
                    const directionX = deltaX / distance;
                    const directionY = deltaY / distance;
                    const spring = (distance - LAYOUT_EDGE_LENGTH) * LAYOUT_EDGE_SPRING;

                    forces[edge.source].x += directionX * spring;
                    forces[edge.source].y += directionY * spring;
                    forces[edge.target].x -= directionX * spring;
                    forces[edge.target].y -= directionY * spring;
                }

                let centroidX = 0;
                let centroidY = 0;
                for (const nodeId of nodeIds) {
                    centroidX += nextPositions[nodeId].x;
                    centroidY += nextPositions[nodeId].y;
                }
                centroidX /= nodeIds.length;
                centroidY /= nodeIds.length;

                for (const nodeId of nodeIds) {
                    const position = nextPositions[nodeId];
                    forces[nodeId].x += (centroidX - position.x) * LAYOUT_CENTER_GRAVITY;
                    forces[nodeId].y += (centroidY - position.y) * LAYOUT_CENTER_GRAVITY;

                    // Apply hierarchical force
                    const level = nodeLevels[nodeId] || 0;
                    const targetY = level * LAYOUT_HIERARCHY_LEVEL_HEIGHT;
                    // Pull towards the target Y level, relative to centroidY to center the whole structure vertically
                    const absoluteTargetY = centroidY - (Math.max(...Object.values(nodeLevels)) * LAYOUT_HIERARCHY_LEVEL_HEIGHT / 2) + targetY;

                    forces[nodeId].y += (absoluteTargetY - position.y) * LAYOUT_HIERARCHY_STRENGTH;
                }

                for (const nodeId of nodeIds) {
                    const velocity = nextVelocities[nodeId] ?? { x: 0, y: 0 };
                    velocity.x = (velocity.x + forces[nodeId].x) * LAYOUT_DAMPING;
                    velocity.y = (velocity.y + forces[nodeId].y) * LAYOUT_DAMPING;

                    const speed = Math.hypot(velocity.x, velocity.y);
                    if (speed > LAYOUT_MAX_SPEED) {
                        const scale = LAYOUT_MAX_SPEED / speed;
                        velocity.x *= scale;
                        velocity.y *= scale;
                    }

                    nextVelocities[nodeId] = velocity;
                    nextPositions[nodeId] = {
                        x: nextPositions[nodeId].x + velocity.x,
                        y: nextPositions[nodeId].y + velocity.y,
                    };
                }

                velocitiesRef.current = nextVelocities;
                return nextPositions;
            });
        }, LAYOUT_TICK_MS);

        return () => clearInterval(interval);
    }, [graph, structureSignature]);

    useEffect(() => {
        if (!graph) {
            previousLocksRef.current = {};
            previousEdgesRef.current = new Set();
            return;
        }

        const now = Date.now();
        const previousLocks = previousLocksRef.current;
        const releasedLocks = Object.keys(previousLocks).filter((path) => !graph.locks[path]);

        if (releasedLocks.length > 0) {
            setUpdatedNodeExpiry((previous) => {
                const next = { ...previous };
                for (const filePath of releasedLocks) {
                    next[filePath] = now + NODE_UPDATE_HIGHLIGHT_MS;
                }
                return next;
            });
        }

        const currentEdgeIds = new Set(graph.edges.map((edge) => toEdgeId(edge.source, edge.target)));
        if (previousEdgesRef.current.size > 0) {
            const newEdges: string[] = [];
            for (const edgeId of currentEdgeIds) {
                if (!previousEdgesRef.current.has(edgeId)) {
                    newEdges.push(edgeId);
                }
            }

            if (newEdges.length > 0) {
                setNewEdgeExpiry((previous) => {
                    const next = { ...previous };
                    for (const edgeId of newEdges) {
                        next[edgeId] = now + NEW_EDGE_HIGHLIGHT_MS;
                    }
                    return next;
                });
            }
        }

        previousLocksRef.current = graph.locks;
        previousEdgesRef.current = currentEdgeIds;
    }, [graph]);

    const activeDevelopers = useMemo(() => {
        if (!graph) {
            return [];
        }

        const grouped = new Map<string, { name: string; lockCount: number }>();
        for (const lock of Object.values(graph.locks)) {
            const existing = grouped.get(lock.user_id);
            if (existing) {
                existing.lockCount += 1;
                continue;
            }
            grouped.set(lock.user_id, { name: lock.user_name, lockCount: 1 });
        }

        return Array.from(grouped.entries())
            .map(([id, value]) => ({
                id,
                name: value.name,
                lockCount: value.lockCount,
                color: neutralTone(id),
            }))
            .sort((a, b) => b.lockCount - a.lockCount || a.name.localeCompare(b.name));
    }, [graph]);

    const nodes = useMemo(() => {
        if (!graph) return [];

        const columns = Math.max(2, Math.ceil(Math.sqrt(graph.nodes.length)));
        const now = Date.now();

        return graph.nodes.map((node, index) => {
            const lock = graph.locks[node.id];
            const isUpdated = (updatedNodeExpiry[node.id] ?? 0) > now;
            const fallback = getGridPosition(index, columns);
            const position = nodePositions[node.id] ?? fallback;

            return {
                id: node.id,
                type: 'activeFile',
                position,
                data: {
                    path: node.id,
                    fileName: node.id,
                    lockStatus: lock?.status,
                    isUpdated,
                    isDark,
                },
            };
        });
    }, [graph, nodePositions, updatedNodeExpiry, isDark]);

    const edges = useMemo(() => {
        if (!graph) return [];
        const now = Date.now();

        return graph.edges.map((edge) => {
            const edgeId = toEdgeId(edge.source, edge.target);
            const isNew = (newEdgeExpiry[edgeId] ?? 0) > now;
            const sourceLock = graph.locks[edge.source];
            const targetLock = graph.locks[edge.target];
            const isLockedEdge = !!sourceLock || !!targetLock;

            // Colors for backend-driven states
            const colorNew = '#10b981'; // Emerald-500
            const colorLocked = '#f59e0b'; // Amber-500
            const colorBase = isDark ? '#52525b' : '#a1a1aa'; // Zinc-600 / Zinc-400

            let stroke = colorBase;
            let strokeWidth = 1.1;
            let opacity = 0.6;
            let animated = false;

            if (isNew) {
                stroke = colorNew;
                strokeWidth = 2.5;
                opacity = 1;
                animated = true;
            } else if (isLockedEdge) {
                stroke = colorLocked;
                strokeWidth = 2;
                opacity = 0.9;
                animated = true;
            }

            return {
                id: edgeId,
                source: edge.source,
                target: edge.target,
                type: 'dependency',
                animated,
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: stroke,
                    width: 14,
                    height: 14,
                },
                style: {
                    stroke,
                    strokeWidth,
                    opacity,
                },
                data: {
                    isNew,
                },
            };
        });
    }, [graph, newEdgeExpiry, isDark]);

    const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
        setSelectedNodeId(node.id);
    }, []);

    const selectedNodeData = useMemo(() => {
        if (!graph || !selectedNodeId) return null;
        return {
            node: graph.nodes.find((n) => n.id === selectedNodeId) || null,
            lock: graph.locks[selectedNodeId],
            dependencies: graph.edges.filter((e) => e.source === selectedNodeId).map((e) => e.target),
            dependents: graph.edges.filter((e) => e.target === selectedNodeId).map((e) => e.source),
        };
    }, [graph, selectedNodeId]);

    const activeLocksCount = graph ? Object.keys(graph.locks).length : 0;
    const showGraphMask = loading || showViewTransitionOverlay;

    return (
        <div className={`w-full h-full relative overflow-hidden border rounded-2xl ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-zinc-100'}`}>
            <ControlDock
                repoUrl={repoUrl}
                setRepoUrl={setRepoUrl}
                branch={branch}
                setBranch={setBranch}
                onRefresh={onRefresh}
                refreshing={refreshing}
                loading={loading}
                lastUpdatedAt={lastUpdatedAt}
                activeLocks={activeLocksCount}
                pollIntervalMs={pollIntervalMs}
                isDark={isDark}
                onToggleTheme={onToggleTheme}
            />

            <div className="relative h-full w-full">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodeClick={onNodeClick}
                    nodesConnectable={false}
                    nodesDraggable
                    fitView
                    minZoom={0.1}
                    maxZoom={2}
                    proOptions={{ hideAttribution: true }}
                    className={`${isDark ? '!bg-zinc-900' : '!bg-zinc-100'} transition-opacity duration-150 ${showGraphMask ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                >
                    <Background color={isDark ? '#3f3f46' : '#a1a1aa'} variant={BackgroundVariant.Dots} gap={24} size={1.2} />
                    <Controls
                        position="top-right"
                        className={isDark
                            ? '!bg-zinc-900/85 !text-zinc-200 !shadow-lg !border !border-zinc-700 !rounded-xl z-[1000]'
                            : '!bg-white/65 !shadow-lg !border !border-zinc-200 !rounded-xl z-[1000]'}
                    />
                    <MiniMap
                        pannable
                        zoomable
                        className={isDark
                            ? '!bg-zinc-900/85 !shadow-lg !rounded-xl !border !border-zinc-700 z-[1000]'
                            : '!bg-white/60 !shadow-lg !rounded-xl !border !border-zinc-200 z-[1000]'}
                        nodeColor={(node) => {
                            const lockStatus = node.data.lockStatus;
                            if (!lockStatus) return isDark ? '#3f3f46' : '#d4d4d8';
                            return isDark ? '#f4f4f5' : '#18181b';
                        }}
                    />

                    <Panel
                        position="bottom-left"
                        className={`max-w-[280px] border px-4 py-3 shadow-xl rounded-xl z-[1000] ${isDark ? 'border-zinc-700 bg-black' : 'border-zinc-200 bg-white'}`}
                    >
                        <h4 className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Legend</h4>
                        <div className="mt-2 space-y-2">
                            {activeDevelopers.length === 0 && (
                                <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>No active locks. Nodes are currently available.</p>
                            )}
                            {activeDevelopers.slice(0, 6).map((developer) => (
                                <div key={developer.id} className="flex items-center justify-between gap-3 text-xs">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: developer.color }} />
                                        <span className={`truncate font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-700'}`}>{developer.name}</span>
                                    </div>
                                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-300' : 'border-zinc-200 bg-zinc-100 text-zinc-600'}`}>
                                        {developer.lockCount} lock{developer.lockCount === 1 ? '' : 's'}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </Panel>
                </ReactFlow>

                {showGraphMask && (
                    <div className={`absolute inset-0 z-50 flex items-center justify-center ${isDark ? 'bg-zinc-900/95' : 'bg-zinc-100/95'} backdrop-blur-sm`}>
                        <div className={`flex items-center gap-3 rounded-xl border px-4 py-2 text-xs font-semibold tracking-wide ${isDark ? 'border-zinc-700 bg-black/70 text-zinc-200' : 'border-zinc-200 bg-white/90 text-zinc-700'}`}>
                            <span className={`h-2.5 w-2.5 rounded-full animate-pulse ${isDark ? 'bg-zinc-300' : 'bg-zinc-700'}`} />
                            Loading view...
                        </div>
                    </div>
                )}
            </div>

            <NodeDetailsDialog
                isOpen={!!selectedNodeId}
                onClose={() => setSelectedNodeId(null)}
                node={selectedNodeData?.node || null}
                lock={selectedNodeData?.lock}
                dependencies={selectedNodeData?.dependencies || []}
                dependents={selectedNodeData?.dependents || []}
                repoUrl={normalizeRepoUrl(repoUrl)}
                branch={branch}
                isDark={isDark}
            />
        </div>
    );
}

function toEdgeId(source: string, target: string): string {
    return `${source}->${target}`;
}

function pruneExpired(values: Record<string, number>, now: number): Record<string, number> {
    const entries = Object.entries(values);
    let changed = false;
    const next: Record<string, number> = {};

    for (const [key, expiry] of entries) {
        if (expiry > now) {
            next[key] = expiry;
            continue;
        }
        changed = true;
    }

    return changed ? next : values;
}

function neutralTone(seed: string): string {
    const tones = ['#3f3f46', '#52525b', '#71717a', '#a1a1aa'];
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return tones[hash % tones.length];
}

function getGridPosition(index: number, columns: number): Point {
    const row = Math.floor(index / columns);
    const col = index % columns;
    return {
        x: col * LAYOUT_X_STEP,
        y: row * LAYOUT_Y_STEP,
    };
}

function getInitialJitter(seed: string): Point {
    const hash = hashSeed(seed);
    const angle = (hash % 360) * (Math.PI / 180);
    const radius = ((hash >>> 8) % 1000) / 1000 * LAYOUT_SPAWN_JITTER;
    return {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
    };
}

function hashSeed(input: string): number {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
        hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
    }
    return hash;
}

function getFolderPath(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) {
        return '';
    }
    return filePath.slice(0, lastSlash);
}

function buildFolderClusterPositions(nodeIds: string[]): Record<string, Point> {
    const byFolder = new Map<string, string[]>();
    for (const nodeId of nodeIds) {
        const folder = getFolderPath(nodeId);
        const current = byFolder.get(folder);
        if (current) {
            current.push(nodeId);
            continue;
        }
        byFolder.set(folder, [nodeId]);
    }

    const folders = Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b));
    const folderColumns = Math.max(1, Math.ceil(Math.sqrt(folders.length)));
    const positions: Record<string, Point> = {};

    for (const [folderIndex, folder] of folders.entries()) {
        const folderNodes = [...(byFolder.get(folder) ?? [])].sort((a, b) => a.localeCompare(b));
        const folderRow = Math.floor(folderIndex / folderColumns);
        const folderCol = folderIndex % folderColumns;
        const centerX = folderCol * LAYOUT_FOLDER_GROUP_X_STEP;
        const centerY = folderRow * LAYOUT_FOLDER_GROUP_Y_STEP;

        const innerColumns = Math.max(1, Math.ceil(Math.sqrt(folderNodes.length)));
        const innerRows = Math.max(1, Math.ceil(folderNodes.length / innerColumns));

        for (const [nodeIndex, nodeId] of folderNodes.entries()) {
            const innerRow = Math.floor(nodeIndex / innerColumns);
            const innerCol = nodeIndex % innerColumns;
            const offsetX = (innerCol - (innerColumns - 1) / 2) * LAYOUT_FOLDER_ITEM_X_STEP;
            const offsetY = (innerRow - (innerRows - 1) / 2) * LAYOUT_FOLDER_ITEM_Y_STEP;
            const jitter = getInitialJitter(nodeId);
            positions[nodeId] = {
                x: centerX + offsetX + jitter.x,
                y: centerY + offsetY + jitter.y,
            };
        }
    }

    return positions;
}

function getAxisSeparationDirection(sourceId: string, targetId: string, axis: 'x' | 'y'): number {
    const signature = sourceId < targetId
        ? `${sourceId}|${targetId}|${axis}`
        : `${targetId}|${sourceId}|${axis}`;
    return hashSeed(signature) % 2 === 0 ? 1 : -1;
}

function normalizeRepoUrl(input: string): string {
    const trimmed = input.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }
    if (trimmed.startsWith('github.com/')) {
        return `https://${trimmed}`;
    }
    return trimmed;
}

function calculateNodeLevels(nodeIds: string[], edges: { source: string; target: string }[]): Record<string, number> {
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    nodeIds.forEach(id => {
        adj.set(id, []);
        inDegree.set(id, 0);
    });

    edges.forEach(edge => {
        if (adj.has(edge.source) && adj.has(edge.target)) {
            adj.get(edge.source)?.push(edge.target);
            inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
        }
    });

    const levels: Record<string, number> = {};
    const queue: string[] = [];

    // Initialize roots (nodes with 0 in-degree)
    nodeIds.forEach(id => {
        if ((inDegree.get(id) || 0) === 0) {
            levels[id] = 0;
            queue.push(id);
        }
    });

    // BFS to assign levels
    while (queue.length > 0) {
        const u = queue.shift()!;
        const neighbors = adj.get(u) || [];

        for (const v of neighbors) {
            // Assign level based on max parent level + 1
            const newLevel = (levels[u] || 0) + 1;
            if (newLevel > (levels[v] || -1)) {
                levels[v] = newLevel;
                // Add to queue if we haven't processed it fully or if we found a deeper path
                if (!queue.includes(v)) { // Simple check to avoid duplicates in queue, though imperfect for DAGs it's okay for visual layout
                    queue.push(v);
                }
            }
        }
    }

    // Fallback for cycles or disconnected components: default to level 0 if not assigned
    nodeIds.forEach(id => {
        if (levels[id] === undefined) {
            levels[id] = 0;
        }
    });

    return levels;
}
