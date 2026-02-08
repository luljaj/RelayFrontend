import React, { memo, useCallback, useMemo } from 'react';
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
    const flowHighlight = useMemo(() => {
        const width = Math.max(1, baseWidth * 0.72);
        const opacity = isNew ? 0.55 : 0.32;
        return {
            stroke: toSoftGlowColor(strokeColor, opacity),
            strokeWidth: width,
            strokeLinecap: 'round' as const,
            fill: 'none' as const,
            strokeDasharray: '9 140',
            strokeDashoffset: 0,
            animation: 'edge-flow-glow 2.2s linear infinite',
            pointerEvents: 'none' as const,
        };
    }, [baseWidth, isNew, strokeColor]);

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
                    filter: 'none',
                    transition: 'stroke 1.8s ease-out, stroke-width 1.8s ease-out, filter 1.8s ease-out',
                }}
            />
            <path d={edgePath} style={flowHighlight} />
        </>
    );
};

function normalizeStroke(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    return '#a1a1aa';
}

function toSoftGlowColor(color: string, alpha: number): string {
    if (color.startsWith('#')) {
        const rgb = hexToRgb(color);
        if (rgb) {
            return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
        }
    }
    if (color.startsWith('rgb(')) {
        const inside = color.slice(4, -1).trim();
        return `rgba(${inside}, ${alpha})`;
    }
    if (color.startsWith('rgba(')) {
        return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
    }
    return `rgba(255, 255, 255, ${alpha})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const normalized = hex.replace('#', '');
    if (normalized.length !== 3 && normalized.length !== 6) return null;
    const full = normalized.length === 3
        ? normalized.split('').map((ch) => ch + ch).join('')
        : normalized;
    const value = Number.parseInt(full, 16);
    if (Number.isNaN(value)) return null;
    return {
        r: (value >> 16) & 255,
        g: (value >> 8) & 255,
        b: value & 255,
    };
}

export default memo(DependencyEdge);
