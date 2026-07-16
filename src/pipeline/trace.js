import { simplifyPolyline, polylineToBezierPath, polygonArea, pathLength } from "./geometry.js";

/** Converts a {outer, holes[]} shape (from contour.js) into one SVG path
 * 'd' string. Holes are emitted as extra subpaths and rendered correctly
 * regardless of winding direction via fill-rule="evenodd" on the caller. */
export function shapeToPathD(shape, { epsilon, error }) {
  const outer = simplifyPolyline(shape.outer, epsilon);
  let d = polylineToBezierPath(outer, { closed: true, error });
  for (const hole of shape.holes) {
    const simplifiedHole = simplifyPolyline(hole, epsilon);
    const holeD = polylineToBezierPath(simplifiedHole, { closed: true, error });
    if (holeD) d += ` ${holeD}`;
  }
  return d;
}

/** Fill shapes -> path list, pruning anything below an absolute pixel-area
 * threshold (small-fragment cleanup happens earlier at the raster level via
 * region-merge; this is the final safety net for whatever slips through). */
export function shapesToPaths(shapes, { epsilon, error, minAreaPx }) {
  const paths = [];
  for (const shape of shapes) {
    const area = polygonArea(shape.outer);
    if (area < minAreaPx) continue;
    const d = shapeToPathD(shape, { epsilon, error });
    if (d) paths.push({ d, area });
  }
  return paths;
}

/** Skeleton polylines -> open/closed stroke paths (laces, stitching, thin
 * outline hairlines) — never filled, so they can't turn into blobs. */
export function strokesToPaths(polylines, { epsilon, error, minLengthPx }) {
  const paths = [];
  for (const poly of polylines) {
    if (poly.points.length < 2) continue;
    if (!poly.closed && pathLength(poly.points, false) < minLengthPx) continue;

    const simplified = simplifyPolyline(poly.points, epsilon);
    if (simplified.length < 2) continue;
    const d = polylineToBezierPath(simplified, { closed: poly.closed, error });
    if (d) paths.push({ d });
  }
  return paths;
}
