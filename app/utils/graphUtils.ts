
import { Position, Node } from 'reactflow';

// Get the intersection point between the center of the node and the target position
function getNodeIntersection(intersectionNode: Node, targetNode: Node) {
    // https://math.stackexchange.com/questions/228841/how-do-i-calculate-the-intersection-point-of-the-boundary-of-a-rectangle-and-a
    const { width: intersectionNodeWidth, height: intersectionNodeHeight, positionAbsolute: intersectionNodePosition } = intersectionNode;
    const targetPosition = targetNode.positionAbsolute;

    const w = (intersectionNodeWidth ?? 0) / 2;
    const h = (intersectionNodeHeight ?? 0) / 2;

    const x2 = (intersectionNodePosition?.x ?? 0) + w;
    const y2 = (intersectionNodePosition?.y ?? 0) + h;
    const x1 = (targetPosition?.x ?? 0) + (targetNode.width ?? 0) / 2;
    const y1 = (targetPosition?.y ?? 0) + (targetNode.height ?? 0) / 2;

    const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
    const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
    const a = 1 / (Math.abs(xx1) + Math.abs(yy1));
    const xx3 = a * xx1;
    const yy3 = a * yy1;
    const x = w * (xx3 + yy3) + x2;
    const y = h * (-xx3 + yy3) + y2;

    return { x, y };
}

// Returns the position (top, right, bottom, left) based on the intersection point
function getEdgePosition(node: Node, intersectionPoint: { x: number; y: number }) {
    const n = { ...node.positionAbsolute, ...node };
    const nx = Math.round(n.x ?? 0);
    const ny = Math.round(n.y ?? 0);
    const px = Math.round(intersectionPoint.x);
    const py = Math.round(intersectionPoint.y);

    if (px <= nx + 1) {
        return Position.Left;
    }
    if (px >= nx + (n.width ?? 0) - 1) {
        return Position.Right;
    }
    if (py <= ny + 1) {
        return Position.Top;
    }
    if (py >= ny + (n.height ?? 0) - 1) {
        return Position.Bottom;
    }

    return Position.Top;
}

// Main function to get edge parameters
export function getEdgeParams(source: Node, target: Node) {
    const sourceIntersectionPoint = getNodeIntersection(source, target);
    const targetIntersectionPoint = getNodeIntersection(target, source);

    const sourcePos = getEdgePosition(source, sourceIntersectionPoint);
    const targetPos = getEdgePosition(target, targetIntersectionPoint);

    return {
        sx: sourceIntersectionPoint.x,
        sy: sourceIntersectionPoint.y,
        tx: targetIntersectionPoint.x,
        ty: targetIntersectionPoint.y,
        sourcePos,
        targetPos,
    };
}
