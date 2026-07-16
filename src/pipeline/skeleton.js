/**
 * Zhang-Suen thinning: reduces a thick binary stroke (shoelace, stitching
 * line) down to a 1px centerline so it can be exported as an SVG `stroke`
 * path with the original width re-applied, instead of being traced as a
 * filled blob that swallows the line's shape.
 */
export function zhangSuenThin(mask, width, height) {
  const img = mask.slice();
  let changed = true;
  while (changed) {
    changed = thinPass(img, width, height, 0) || changed;
    changed = thinPass(img, width, height, 1);
  }
  return img;
}

function thinPass(img, width, height, step) {
  const toRemove = [];
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (!img[idx]) continue;

      const p2 = img[idx - width];
      const p3 = img[idx - width + 1];
      const p4 = img[idx + 1];
      const p5 = img[idx + width + 1];
      const p6 = img[idx + width];
      const p7 = img[idx + width - 1];
      const p8 = img[idx - 1];
      const p9 = img[idx - width - 1];
      const n = [p2, p3, p4, p5, p6, p7, p8, p9];

      const B = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
      if (B < 2 || B > 6) continue;

      let A = 0;
      for (let i = 0; i < 8; i++) {
        if (n[i] === 0 && n[(i + 1) % 8] === 1) A++;
      }
      if (A !== 1) continue;

      if (step === 0) {
        if (p2 * p4 * p6 !== 0) continue;
        if (p4 * p6 * p8 !== 0) continue;
      } else {
        if (p2 * p4 * p8 !== 0) continue;
        if (p2 * p6 * p8 !== 0) continue;
      }
      toRemove.push(idx);
    }
  }
  for (const idx of toRemove) img[idx] = 0;
  return toRemove.length > 0;
}

/** Walks the 1px skeleton graph into ordered polylines, splitting at
 * junctions so each returned polyline is a simple open (or closed, for
 * loops) chain ready for Douglas-Peucker + Bezier fitting. */
export function skeletonToPolylines(skeleton, width, height) {
  const pixelCount = width * height;
  const idxToXY = (idx) => [idx % width, (idx / width) | 0];
  const neighborCache = new Map();

  const getNeighbors = (idx) => {
    let cached = neighborCache.get(idx);
    if (cached) return cached;
    const x = idx % width;
    const y = (idx / width) | 0;
    const result = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nidx = ny * width + nx;
        if (skeleton[nidx]) result.push(nidx);
      }
    }
    neighborCache.set(idx, result);
    return result;
  };

  const skeletonPixels = [];
  for (let i = 0; i < pixelCount; i++) if (skeleton[i]) skeletonPixels.push(i);

  const edgeVisited = new Set();
  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  function walk(start, firstNext) {
    const path = [start, firstNext];
    edgeVisited.add(edgeKey(start, firstNext));
    let prev = start;
    let cur = firstNext;
    while (true) {
      const next = getNeighbors(cur).filter((n) => n !== prev);
      if (next.length !== 1) break;
      const key = edgeKey(cur, next[0]);
      if (edgeVisited.has(key)) break;
      edgeVisited.add(key);
      path.push(next[0]);
      prev = cur;
      cur = next[0];
    }
    return path;
  }

  const polylines = [];

  for (const idx of skeletonPixels) {
    const neighbors = getNeighbors(idx);
    if (neighbors.length === 1 || neighbors.length >= 3) {
      for (const n of neighbors) {
        if (edgeVisited.has(edgeKey(idx, n))) continue;
        const path = walk(idx, n);
        if (path.length >= 2) polylines.push({ points: path.map(idxToXY), closed: false });
      }
    }
  }

  // Any leftover pixels belong to pure cycles (rings) with no endpoint/junction.
  for (const idx of skeletonPixels) {
    for (const n of getNeighbors(idx)) {
      if (edgeVisited.has(edgeKey(idx, n))) continue;
      const path = walk(idx, n);
      if (path.length >= 3) polylines.push({ points: path.map(idxToXY), closed: true });
    }
  }

  return polylines;
}
