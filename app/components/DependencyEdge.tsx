import React, { memo, useCallback } from 'react';
import { BaseEdge, EdgeProps, getBezierPath, useStore } from 'reactflow';
import { getEdgeParams } from '../utils/graphUtils';

const DependencyEdge = ({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    markerEnd,
    data,
    source,
    target,
}: EdgeProps) => {
    const sourceNode = useStore(useCallback((store) => store.nodeInternals.get(source), [source]));
    const targetNode = useStore(useCallback((store) => store.nodeInternals.get(target), [target]));

    if (!sourceNode || !targetNode) {
        return null;
    }

    const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);

    const [edgePath] = getBezierPath({
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos,
    });

    const isNew = data?.isNew;
    const strokeColor = normalizeStroke(style.stroke);
    const baseWidth = typeof style.strokeWidth === 'number' ? style.strokeWidth : 1.2;

    return (
        <>
            <BaseEdge
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    ...style,
                    stroke: strokeColor,
                    strokeWidth: isNew ? Math.max(2, baseWidth) : baseWidth,
                    strokeDasharray: isNew ? '6 4' : undefined,
                    filter: isNew ? `drop-shadow(0 0 2px ${strokeColor})` : 'none',
                    transition: 'stroke 1.8s ease-out, stroke-width 1.8s ease-out, filter 1.8s ease-out',
                }}
            />
        </>
    );
};

function normalizeStroke(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    return '#a1a1aa';
}

export default memo(DependencyEdge);
