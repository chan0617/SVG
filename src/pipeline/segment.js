import { bufferToLab, kmeansLab, connectedComponents } from "./raster.js";

/**
 * Stage 2 (color side): perceptual LAB k-means over the product mask, then
 * an explicit region-merge pass that folds any island smaller than the area
 * threshold into whichever neighboring cluster shares the longest border —
 * this is what keeps near-duplicate colors from splintering into dozens of
 * slivers, instead of just filtering by a global color-ratio like the old
 * imagetracerjs setup did.
 */
export function segmentColors(pre, options) {
  const { width, height, pixelCount, data, productMask } = pre;
  const { numColors, minAreaRatio } = options;

  const lab = bufferToLab(data, 3, pixelCount);
  const { labels, centers } = kmeansLab(lab, productMask, pixelCount, numColors);

  mergeSmallRegions(labels, centers, width, height, pixelCount, centers.length, minAreaRatio);

  const clusterInfo = classifyClusters(labels, centers, pixelCount);

  return { labels, centers, clusterInfo, lab };
}

// Only fold a small fragment into a neighbor if their *colors* are close —
// otherwise a thin white shoelace or stitch line sitting on a large black
// body would get folded straight into the black cluster (its only
// neighbor) and disappear. The spec asks to merge "similar-color" small
// fragments, not any small fragment regardless of color.
const MERGE_COLOR_DISTANCE = 14;

function mergeSmallRegions(labels, centers, width, height, pixelCount, numClusters, minAreaRatio) {
  const minArea = Math.max(24, Math.round(pixelCount * minAreaRatio));

  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let L = 0; L < numClusters; L++) {
      const { components } = connectedComponents((idx) => labels[idx] === L, width, height);
      for (const comp of components) {
        if (comp.count >= minArea) continue;

        const neighborCount = new Map();
        for (const idx of comp.pixels) {
          const x = idx % width;
          const y = (idx / width) | 0;
          const neighbors = [];
          if (x > 0) neighbors.push(idx - 1);
          if (x < width - 1) neighbors.push(idx + 1);
          if (y > 0) neighbors.push(idx - width);
          if (y < height - 1) neighbors.push(idx + width);
          for (const n of neighbors) {
            const nl = labels[n];
            if (nl !== -1 && nl !== L) neighborCount.set(nl, (neighborCount.get(nl) || 0) + 1);
          }
        }
        if (neighborCount.size === 0) continue;

        let bestLabel = -1;
        let bestCount = -1;
        for (const [nl, cnt] of neighborCount) {
          if (cnt > bestCount) {
            bestCount = cnt;
            bestLabel = nl;
          }
        }

        const colorDist = Math.hypot(
          centers[L][0] - centers[bestLabel][0],
          centers[L][1] - centers[bestLabel][1],
          centers[L][2] - centers[bestLabel][2],
        );
        if (colorDist > MERGE_COLOR_DISTANCE) continue;

        for (const idx of comp.pixels) labels[idx] = bestLabel;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * Buckets each cluster into 'base' (dominant fill of its hue family) or
 * 'shading' (a darker/lighter variant of the same hue), and separately
 * flags near-white / near-black clusters as candidates for the outline and
 * white-line-detection stages to pick apart further.
 */
function classifyClusters(labels, centers, pixelCount) {
  const areas = new Array(centers.length).fill(0);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= 0) areas[labels[i]]++;
  }

  const info = centers.map((center, i) => {
    const [l, a, b] = center;
    const chroma = Math.hypot(a, b);
    return {
      index: i,
      l,
      a,
      b,
      chroma,
      area: areas[i],
      areaRatio: areas[i] / pixelCount,
      isNearWhite: l > 62 && chroma < 24,
      isNearBlack: l < 38 && chroma < 22,
      role: "base",
      family: -1,
    };
  });

  // Union-find over chromatic clusters by (a,b) proximity — L is
  // deliberately excluded so a dark and light version of "red" land in the
  // same family even though their Lab distance in L is large.
  const chromatic = info.filter((c) => !c.isNearWhite && !c.isNearBlack);
  const parent = chromatic.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  for (let i = 0; i < chromatic.length; i++) {
    for (let j = i + 1; j < chromatic.length; j++) {
      const dist = Math.hypot(chromatic[i].a - chromatic[j].a, chromatic[i].b - chromatic[j].b);
      if (dist < 18) union(i, j);
    }
  }
  const familyGroups = new Map();
  chromatic.forEach((c, i) => {
    const root = find(i);
    if (!familyGroups.has(root)) familyGroups.set(root, []);
    familyGroups.get(root).push(c);
  });
  for (const group of familyGroups.values()) {
    group.sort((x, y) => y.area - x.area);
    group.forEach((c, rank) => {
      c.role = rank === 0 ? "base" : "shading";
    });
  }

  // Near-black clusters: largest becomes the main body fill (base), the
  // rest are shading variants of the black body.
  const blacks = info.filter((c) => c.isNearBlack).sort((x, y) => y.area - x.area);
  blacks.forEach((c, rank) => {
    c.role = rank === 0 ? "base" : "shading";
  });

  // Near-white clusters are left with role 'neutral-light' — line/shape
  // analysis downstream decides logo vs. laces vs. stitching vs. sole.
  for (const c of info) {
    if (c.isNearWhite) c.role = "neutral-light";
  }

  return info;
}
