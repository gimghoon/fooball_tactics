export type Point = { x: number; y: number };
export type CircleZone = {
  kind: "circle";
  cx: number;
  cy: number;
  radius: number;
};

export function isPointInZone(point: Point, zone: CircleZone) {
  return Math.hypot(point.x - zone.cx, point.y - zone.cy) <= zone.radius;
}

export function segmentIntersectsCircle(start: Point, end: Point, zone: CircleZone): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const dot = (zone.cx - start.x) * dx + (zone.cy - start.y) * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, dot / lengthSquared));
  const closest = { x: start.x + t * dx, y: start.y + t * dy };

  return Math.hypot(closest.x - zone.cx, closest.y - zone.cy) <= zone.radius;
}

export function normalizeClientPoint(
  point: Point,
  bounds: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: ((point.x - bounds.left) / bounds.width) * 100,
    y: ((point.y - bounds.top) / bounds.height) * 100,
  };
}
