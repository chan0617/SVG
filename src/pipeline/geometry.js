import fitCurve from "fit-curve";

/** Ramer-Douglas-Peucker polyline simplification. Keeps high-curvature
 * points, drops points that lie close to the straight-line chord — the
 * opposite failure mode of naively connecting every contour pixel. */
export function simplifyPolyline(points, epsilon) {
  if (points.length < 3 || epsilon <= 0) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let maxIndex = -1;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segLenSq = dx * dx + dy * dy;

    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i];
      let dist;
      if (segLenSq === 0) {
        dist = Math.hypot(px - x1, py - y1);
      } else {
        const t = ((px - x1) * dx + (py - y1) * dy) / segLenSq;
        const clampedT = Math.max(0, Math.min(1, t));
        const projX = x1 + clampedT * dx;
        const projY = y1 + clampedT * dy;
        dist = Math.hypot(px - projX, py - projY);
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    if (maxDist > epsilon && maxIndex !== -1) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }

  const result = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

/** Shoelace formula — used to prune paths below an absolute pixel-area
 * threshold instead of relying on relative color-ratio filtering only. */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function pathLength(points, closed) {
  let len = 0;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    len += Math.hypot(x2 - x1, y2 - y1);
  }
  return len;
}

/** Converts a simplified polyline into a cubic-bezier SVG path 'd' fragment
 * via Schneider's curve-fitting algorithm (fit-curve), instead of connecting
 * points with straight `L` segments (which is what produces the jagged
 * "stair-step" look on originally-smooth curves). */
export function polylineToBezierPath(points, { closed, error }) {
  if (points.length < 2) return "";

  const fitPoints = closed ? [...points, points[0]] : points;
  if (fitPoints.length < 3) {
    const [x0, y0] = fitPoints[0];
    const [x1, y1] = fitPoints[fitPoints.length - 1];
    return `M ${fmt(x0)},${fmt(y0)} L ${fmt(x1)},${fmt(y1)}${closed ? " Z" : ""}`;
  }

  // fit-curve's tolerance is a *squared*-distance error, but every caller
  // in this codebase thinks in linear pixel tolerance — square it here so
  // the rest of the pipeline (and the smoothing slider) stays intuitive.
  const linearError = Math.max(error, 0.2);
  const curves = fitCurve(fitPoints, linearError * linearError);
  if (!curves.length) return "";

  const [x0, y0] = curves[0][0];
  let d = `M ${fmt(x0)},${fmt(y0)}`;
  for (const [, c1, c2, p1] of curves) {
    d += ` C ${fmt(c1[0])},${fmt(c1[1])} ${fmt(c2[0])},${fmt(c2[1])} ${fmt(p1[0])},${fmt(p1[1])}`;
  }
  if (closed) d += " Z";
  return d;
}

function fmt(n) {
  return Math.round(n * 100) / 100;
}

export function countAnchors(d) {
  const matches = d.match(/[ML]\s*-?\d/g) || [];
  const curveMatches = d.match(/C\s*-?\d[^A-Za-z]*/g) || [];
  return matches.length + curveMatches.length;
}
