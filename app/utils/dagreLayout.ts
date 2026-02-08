import dagre from 'dagre';

type Point = { x: number; y: number };

interface LayoutOptions {
    nodeWidth?: number;
    nodeHeight?: number;
    nodesep?: number;
    ranksep?: number;
    groupPadding?: number;
    maxRowWidth?: number;
}

// Find connected components using Union-Find
function calculateGroups(nodeIds: string[], edges: { source: string; target: string }[]): Record<string, number> {
    const parent: Record<string, string> = {};
    nodeIds.forEach(id => parent[id] = id);

    function find(i: string): string {
        if (parent[i] === i) return i;
        parent[i] = find(parent[i]); // Path compression
        return parent[i];
    }

    function union(i: string, j: string) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            parent[rootI] = rootJ;
        }
    }

    edges.forEach(edge => {
        if (nodeIds.includes(edge.source) && nodeIds.includes(edge.target)) {
            union(edge.source, edge.target);
        }
    });

    const groupMap: Record<string, number> = {};
    let groupCounter = 0;
    const rootToGroupId: Record<string, number> = {};

    nodeIds.forEach(id => {
        const root = find(id);
        if (rootToGroupId[root] === undefined) {
            rootToGroupId[root] = groupCounter++;
        }
        groupMap[id] = rootToGroupId[root];
    });

    return groupMap;
}

export function computeDagreLayout(
    nodeIds: string[],
    edges: { source: string; target: string }[],
    options: LayoutOptions = {}
): Record<string, Point> {
    const {
        nodeWidth = 180,
        nodeHeight = 60,
        nodesep = 80,
        ranksep = 100,
        groupPadding = 150,
        maxRowWidth = 2000,
    } = options;

    if (nodeIds.length === 0) {
        return {};
    }

    // Find connected components
    const nodeGroups = calculateGroups(nodeIds, edges);
    const groupIds = [...new Set(Object.values(nodeGroups))];

    // Layout each group separately
    const groupLayouts: Record<number, Record<string, Point>> = {};
    const groupBounds: Record<number, { minX: number; maxX: number; minY: number; maxY: number }> = {};

    for (const groupId of groupIds) {
        const groupNodeIds = nodeIds.filter((id) => nodeGroups[id] === groupId);
        const groupEdges = edges.filter(
            (e) => nodeGroups[e.source] === groupId && nodeGroups[e.target] === groupId
        );

        // Create Dagre graph
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: 'TB', nodesep, ranksep, marginx: 50, marginy: 50 });
        g.setDefaultEdgeLabel(() => ({}));

        for (const nodeId of groupNodeIds) {
            g.setNode(nodeId, { width: nodeWidth, height: nodeHeight });
        }
        for (const edge of groupEdges) {
            g.setEdge(edge.source, edge.target);
        }

        dagre.layout(g);

        const positions: Record<string, Point> = {};
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (const nodeId of groupNodeIds) {
            const node = g.node(nodeId);
            if (node) {
                positions[nodeId] = { x: node.x, y: node.y };
                minX = Math.min(minX, node.x - nodeWidth / 2);
                maxX = Math.max(maxX, node.x + nodeWidth / 2);
                minY = Math.min(minY, node.y - nodeHeight / 2);
                maxY = Math.max(maxY, node.y + nodeHeight / 2);
            }
        }

        groupLayouts[groupId] = positions;
        groupBounds[groupId] = { minX, maxX, minY, maxY };
    }

    // Position groups in a grid to prevent overlap
    const sortedGroupIds = groupIds.sort((a, b) => {
        const sizeA = Object.keys(groupLayouts[a]).length;
        const sizeB = Object.keys(groupLayouts[b]).length;
        return sizeB - sizeA; // Largest first
    });

    const finalPositions: Record<string, Point> = {};
    let currentX = 0;
    let currentRowMaxY = 0;
    let currentY = 0;

    for (const groupId of sortedGroupIds) {
        const bounds = groupBounds[groupId];
        const groupWidth = bounds.maxX - bounds.minX;
        const groupHeight = bounds.maxY - bounds.minY;

        // Check if we need to start a new row
        if (currentX + groupWidth > maxRowWidth && currentX > 0) {
            currentY += currentRowMaxY + groupPadding;
            currentX = 0;
            currentRowMaxY = 0;
        }

        // Offset all nodes in this group
        const offsetX = currentX - bounds.minX;
        const offsetY = currentY - bounds.minY;

        for (const [nodeId, pos] of Object.entries(groupLayouts[groupId])) {
            finalPositions[nodeId] = {
                x: pos.x + offsetX,
                y: pos.y + offsetY,
            };
        }

        currentX += groupWidth + groupPadding;
        currentRowMaxY = Math.max(currentRowMaxY, groupHeight);
    }

    return finalPositions;
}
