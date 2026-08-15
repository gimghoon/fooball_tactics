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

export function normalizeClientPoint(
  point: Point,
  bounds: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: ((point.x - bounds.left) / bounds.width) * 100,
    y: ((point.y - bounds.top) / bounds.height) * 100,
  };
}

