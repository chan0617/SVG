// Pixel-level building blocks shared across the pipeline: sRGB->Lab
// conversion, k-means clustering in Lab space, and a flood-fill style
// connected-components labeler. Implemented directly in JS (rather than via
// OpenCV bindings whose exact signatures are hard to verify offline) so
// behaviour is fully predictable and testable.

/** Deterministic PRNG (mulberry32) so the same image + settings always
 * produce the same k-means clusters — important both for debugging and so
 * re-converting the same file doesn't shuffle colors/groups between runs. */
function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** sRGB [0-255] -> CIE Lab (L:0-100, a/b roughly -128..127). */
export function rgbToLab(r, g, b) {
  let rl = r / 255;
  let gl = g / 255;
  let bl = b / 255;
  rl = rl > 0.04045 ? Math.pow((rl + 0.055) / 1.055, 2.4) : rl / 12.92;
  gl = gl > 0.04045 ? Math.pow((gl + 0.055) / 1.055, 2.4) : gl / 12.92;
  bl = bl > 0.04045 ? Math.pow((bl + 0.055) / 1.055, 2.4) : bl / 12.92;

  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Builds a Float32Array [L,a,b, L,a,b, ...] for every pixel of an RGB(A)
 * buffer, for fast repeated distance computation during clustering. */
export function bufferToLab(data, channels, pixelCount) {
  const lab = new Float32Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const o = i * channels;
    const [l, a, b] = rgbToLab(data[o], data[o + 1], data[o + 2]);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return lab;
}

/**
 * k-means++ clustering in Lab space, restricted to pixels where
 * `mask[i] !== 0`. Returns a label per pixel (-1 for masked-out pixels) and
 * the resulting cluster centers (in Lab).
 */
export function kmeansLab(lab, mask, pixelCount, k, { maxIter = 12, sampleCap = 24000, seed = 42 } = {}) {
  const rng = createRng(seed);
  const indices = [];
  for (let i = 0; i < pixelCount; i++) if (mask[i]) indices.push(i);

  if (indices.length === 0) {
    return { labels: new Int32Array(pixelCount).fill(-1), centers: [] };
  }
  const kEff = Math.min(k, indices.length);

  // Subsample for centroid fitting on very large images; full assignment
  // still runs over every foreground pixel afterwards.
  let sampleIdx = indices;
  if (indices.length > sampleCap) {
    sampleIdx = new Array(sampleCap);
    for (let i = 0; i < sampleCap; i++) {
      sampleIdx[i] = indices[(rng() * indices.length) | 0];
    }
  }

  const centers = kmeansPlusPlusInit(lab, sampleIdx, kEff, rng);

  for (let iter = 0; iter < maxIter; iter++) {
    const sums = new Float64Array(kEff * 3);
    const counts = new Float64Array(kEff);

    for (const idx of sampleIdx) {
      const c = nearestCenter(lab, idx, centers);
      sums[c * 3] += lab[idx * 3];
      sums[c * 3 + 1] += lab[idx * 3 + 1];
      sums[c * 3 + 2] += lab[idx * 3 + 2];
      counts[c]++;
    }

    let moved = 0;
    for (let c = 0; c < kEff; c++) {
      if (counts[c] === 0) continue;
      const nl = sums[c * 3] / counts[c];
      const na = sums[c * 3 + 1] / counts[c];
      const nb = sums[c * 3 + 2] / counts[c];
      moved += Math.hypot(nl - centers[c][0], na - centers[c][1], nb - centers[c][2]);
      centers[c] = [nl, na, nb];
    }
    if (moved < 0.05) break;
  }

  const labels = new Int32Array(pixelCount).fill(-1);
  for (const idx of indices) {
    labels[idx] = nearestCenter(lab, idx, centers);
  }

  return { labels, centers };
}

function kmeansPlusPlusInit(lab, sampleIdx, k, rng) {
  const centers = [];
  const first = sampleIdx[(rng() * sampleIdx.length) | 0];
  centers.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);

  const distSq = new Float64Array(sampleIdx.length).fill(Infinity);

  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < sampleIdx.length; i++) {
      const idx = sampleIdx[i];
      const last = centers[centers.length - 1];
      const d =
        (lab[idx * 3] - last[0]) ** 2 +
        (lab[idx * 3 + 1] - last[1]) ** 2 +
        (lab[idx * 3 + 2] - last[2]) ** 2;
      if (d < distSq[i]) distSq[i] = d;
      total += distSq[i];
    }
    if (total === 0) {
      const idx = sampleIdx[(rng() * sampleIdx.length) | 0];
      centers.push([lab[idx * 3], lab[idx * 3 + 1], lab[idx * 3 + 2]]);
      continue;
    }
    let r = rng() * total;
    let chosen = sampleIdx[0];
    for (let i = 0; i < sampleIdx.length; i++) {
      r -= distSq[i];
      if (r <= 0) {
        chosen = sampleIdx[i];
        break;
      }
    }
    centers.push([lab[chosen * 3], lab[chosen * 3 + 1], lab[chosen * 3 + 2]]);
  }
  return centers;
}

function nearestCenter(lab, idx, centers) {
  const l = lab[idx * 3];
  const a = lab[idx * 3 + 1];
  const b = lab[idx * 3 + 2];
  let best = 0;
  let bestDist = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const d = (l - centers[c][0]) ** 2 + (a - centers[c][1]) ** 2 + (b - centers[c][2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/**
 * Iterative flood-fill connected-components labeler (4-connectivity) over a
 * boolean predicate. Shared by background/shadow/thin-line detection so
 * every "find blobs and inspect their shape" step behaves consistently.
 */
export function connectedComponents(maskFn, width, height) {
  const pixelCount = width * height;
  const labels = new Int32Array(pixelCount).fill(-1);
  const stack = new Int32Array(pixelCount);
  const components = [];
  let compId = 0;

  for (let start = 0; start < pixelCount; start++) {
    if (labels[start] !== -1 || !maskFn(start)) continue;

    let sp = 0;
    stack[sp++] = start;
    labels[start] = compId;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let touchesBorder = false;
    const pixels = [];

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;
      pixels.push(idx);
      count++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) {
        const n = idx - 1;
        if (labels[n] === -1 && maskFn(n)) {
          labels[n] = compId;
          stack[sp++] = n;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (labels[n] === -1 && maskFn(n)) {
          labels[n] = compId;
          stack[sp++] = n;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (labels[n] === -1 && maskFn(n)) {
          labels[n] = compId;
          stack[sp++] = n;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (labels[n] === -1 && maskFn(n)) {
          labels[n] = compId;
          stack[sp++] = n;
        }
      }
    }

    components.push({ id: compId, pixels, minX, minY, maxX, maxY, count, touchesBorder });
    compId++;
  }

  return { labels, components };
}

/** Binary box erosion (min-filter): shrinks a 0/1 mask inward by `radius`. */
export function binaryErode(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const h = boxPass(mask, width, height, radius, true);
  return boxPass(h, width, height, radius, false);
}

/** Binary box dilation (max-filter): grows a 0/1 mask outward by `radius`. */
export function binaryDilate(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const h = boxPass(mask, width, height, radius, true, true);
  return boxPass(h, width, height, radius, false, true);
}

function boxPass(mask, width, height, radius, horizontal, isMax = false) {
  const out = new Uint8Array(width * height);
  if (horizontal) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let acc = isMax ? 0 : 1;
        const xs = Math.max(0, x - radius);
        const xe = Math.min(width - 1, x + radius);
        for (let xx = xs; xx <= xe; xx++) {
          const v = mask[row + xx];
          acc = isMax ? Math.max(acc, v) : Math.min(acc, v);
        }
        out[row + x] = acc;
      }
    }
  } else {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let acc = isMax ? 0 : 1;
        const ys = Math.max(0, y - radius);
        const ye = Math.min(height - 1, y + radius);
        for (let yy = ys; yy <= ye; yy++) {
          const v = mask[yy * width + x];
          acc = isMax ? Math.max(acc, v) : Math.min(acc, v);
        }
        out[y * width + x] = acc;
      }
    }
  }
  return out;
}

/** Opening = erode then dilate. Strips features thinner than `radius`,
 * leaving only "blob"-like fill regions. */
export function binaryOpen(mask, width, height, radius) {
  return binaryDilate(binaryErode(mask, width, height, radius), width, height, radius);
}

/**
 * Multi-source BFS distance transform (4-connectivity) from the mask's
 * background. `2 * distance` at a pixel approximates the local stroke width
 * there — enough precision to threshold "is this a thin line or a blob".
 */
export function distanceTransform(mask, width, height) {
  const pixelCount = width * height;
  const dist = new Int32Array(pixelCount).fill(-1);
  const queue = new Int32Array(pixelCount);
  let qHead = 0;
  let qTail = 0;

  for (let idx = 0; idx < pixelCount; idx++) {
    if (mask[idx] === 0) {
      dist[idx] = 0;
      queue[qTail++] = idx;
    }
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    const d = dist[idx] + 1;
    if (x > 0 && dist[idx - 1] === -1) {
      dist[idx - 1] = d;
      queue[qTail++] = idx - 1;
    }
    if (x < width - 1 && dist[idx + 1] === -1) {
      dist[idx + 1] = d;
      queue[qTail++] = idx + 1;
    }
    if (y > 0 && dist[idx - width] === -1) {
      dist[idx - width] = d;
      queue[qTail++] = idx - width;
    }
    if (y < height - 1 && dist[idx + width] === -1) {
      dist[idx + width] = d;
      queue[qTail++] = idx + width;
    }
  }

  return dist;
}
