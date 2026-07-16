import { connectedComponents } from "./raster.js";

const MAX_WORKING_DIMENSION = 2200;

/**
 * Stage 1: upscale + denoise + edge-preserving smoothing, then split the
 * image into background / shadow / product-foreground via connectivity
 * (not just color distance) so an enclosed white logo never gets swallowed
 * by a same-colored background.
 */
export function preprocessImage(cv, imageData, options) {
  const { upscale = "auto", denoise = true, removeShadow = true } = options;

  let src = cv.matFromImageData(imageData);
  let width = src.cols;
  let height = src.rows;

  const longestSide = Math.max(width, height);
  let scaleFactor = 1;
  if (upscale === "auto") {
    scaleFactor = longestSide < 1100 ? 2 : 1;
  } else if (typeof upscale === "number") {
    scaleFactor = upscale;
  }
  if (longestSide * scaleFactor > MAX_WORKING_DIMENSION) {
    scaleFactor = MAX_WORKING_DIMENSION / longestSide;
  }

  if (Math.abs(scaleFactor - 1) > 0.01) {
    const dst = new cv.Mat();
    const newSize = new cv.Size(Math.round(width * scaleFactor), Math.round(height * scaleFactor));
    cv.resize(src, dst, newSize, 0, 0, scaleFactor > 1 ? cv.INTER_CUBIC : cv.INTER_AREA);
    src.delete();
    src = dst;
    width = src.cols;
    height = src.rows;
  }

  let rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();

  if (denoise) {
    const median = new cv.Mat();
    cv.medianBlur(rgb, median, 3);
    rgb.delete();
    rgb = median;
  }

  // Edge-preserving smoothing: removes JPEG block noise and soft gradients
  // without blurring across strong edges (the thick black outline stays
  // crisp instead of bleeding into neighboring color fills).
  const smoothed = new cv.Mat();
  cv.bilateralFilter(rgb, smoothed, 5, 40, 40, cv.BORDER_DEFAULT);
  rgb.delete();

  const pixelCount = width * height;
  const data = smoothed.data; // Uint8Array, RGB interleaved

  const { backgroundMask, bgColor } = detectBackground(data, width, height, pixelCount);
  const { productMask, shadowMask } = detectShadow(
    data,
    width,
    height,
    pixelCount,
    backgroundMask,
    removeShadow,
  );

  return {
    mat: smoothed, // caller must .delete() when done
    data,
    width,
    height,
    pixelCount,
    backgroundMask,
    productMask,
    shadowMask,
    bgColor,
  };
}

function sampleColorAt(data, width, x, y) {
  const o = (y * width + x) * 3;
  return [data[o], data[o + 1], data[o + 2]];
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Background pixels are found by color-threshold *and* connectivity to the
 * image border, so an interior shape that happens to share the background's
 * color (a white logo, a white sole) is never removed — only the part of
 * that color that's actually contiguous with the border is background.
 */
function detectBackground(data, width, height, pixelCount) {
  const corners = [
    [1, 1],
    [width - 2, 1],
    [1, height - 2],
    [width - 2, height - 2],
    [Math.floor(width / 2), 1],
    [1, Math.floor(height / 2)],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [x, y] of corners) {
    const c = sampleColorAt(data, width, x, y);
    r += c[0];
    g += c[1];
    b += c[2];
  }
  const bgColor = [r / corners.length, g / corners.length, b / corners.length];

  // Kept tight so a soft gray drop-shadow (which differs from a pure-white
  // backdrop by more than this) survives as its own foreground component
  // for the shadow-detection pass below, instead of being swallowed here.
  const tolerance = 15;
  const isBgColor = (idx) => {
    const o = idx * 3;
    return colorDistance([data[o], data[o + 1], data[o + 2]], bgColor) < tolerance;
  };

  const { labels, components } = connectedComponents(isBgColor, width, height);

  const backgroundMask = new Uint8Array(pixelCount);
  for (const comp of components) {
    if (comp.touchesBorder) {
      for (const idx of comp.pixels) backgroundMask[idx] = 1;
    }
  }
  void labels;

  return { backgroundMask, bgColor };
}

/**
 * Among the connected components that remain after background removal, the
 * largest is the product. Any other component that is desaturated (grayish)
 * and sits in the lower half of the frame is treated as a drop shadow and
 * pulled into its own layer (or dropped entirely if the user disabled it).
 */
function detectShadow(data, width, height, pixelCount, backgroundMask, removeShadow) {
  const isForeground = (idx) => backgroundMask[idx] === 0;
  const { components } = connectedComponents(isForeground, width, height);

  if (components.length === 0) {
    return { productMask: new Uint8Array(pixelCount), shadowMask: new Uint8Array(pixelCount) };
  }

  components.sort((a, b) => b.count - a.count);
  const main = components[0];

  const productMask = new Uint8Array(pixelCount);
  for (const idx of main.pixels) productMask[idx] = 1;

  const shadowMask = new Uint8Array(pixelCount);
  const midY = height / 2;

  for (let i = 1; i < components.length; i++) {
    const comp = components[i];
    // Small stray specks (JPEG artifacts) are neither shadow nor product.
    if (comp.count < pixelCount * 0.0006) continue;

    let sumSat = 0;
    for (const idx of comp.pixels) {
      const o = idx * 3;
      const max = Math.max(data[o], data[o + 1], data[o + 2]);
      const min = Math.min(data[o], data[o + 1], data[o + 2]);
      sumSat += max === 0 ? 0 : (max - min) / max;
    }
    const avgSat = sumSat / comp.count;
    const centerY = (comp.minY + comp.maxY) / 2;
    const isLowSaturation = avgSat < 0.18;
    const isBelowCenter = centerY > midY * 0.7;

    if (isLowSaturation && isBelowCenter) {
      if (!removeShadow) {
        for (const idx of comp.pixels) shadowMask[idx] = 1;
      }
      // If removeShadow is true we simply omit it from both masks.
    } else {
      for (const idx of comp.pixels) productMask[idx] = 1;
    }
  }

  // A shadow that touches the product (no background gap between them, e.g.
  // a shoe sole sitting directly on its own shadow) ends up as part of the
  // same connected component above and is never considered by the
  // separate-component pass. Carve it out by width: a drop shadow makes the
  // silhouette noticeably *wider* than the object's stable body width, only
  // near the bottom.
  carveAttachedShadow(data, width, height, productMask, shadowMask, removeShadow);

  return { productMask, shadowMask };
}

function carveAttachedShadow(data, width, height, productMask, shadowMask, removeShadow) {
  const rowMinX = new Int32Array(height).fill(-1);
  const rowMaxX = new Int32Array(height).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (productMask[row + x]) {
        if (rowMinX[y] === -1) rowMinX[y] = x;
        rowMaxX[y] = x;
      }
    }
  }

  const widths = [];
  const yFrom = Math.floor(height * 0.15);
  const yTo = Math.floor(height * 0.7);
  for (let y = yFrom; y < yTo; y++) {
    if (rowMinX[y] !== -1) widths.push(rowMaxX[y] - rowMinX[y]);
  }
  if (widths.length === 0) return;
  widths.sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)];
  if (medianWidth <= 0) return;

  let lastContentY = -1;
  for (let y = height - 1; y >= 0; y--) {
    if (rowMinX[y] !== -1) {
      lastContentY = y;
      break;
    }
  }
  if (lastContentY === -1) return;

  const widthThreshold = medianWidth * 1.1;
  for (let y = Math.floor(height * 0.55); y <= lastContentY; y++) {
    if (rowMinX[y] === -1) continue;
    const rowWidth = rowMaxX[y] - rowMinX[y];
    if (rowWidth <= widthThreshold) continue;

    // Only the low-saturation excess beyond the stable body width is shadow;
    // pixels near the row's center stay with the product.
    const excess = (rowWidth - widthThreshold) / 2;
    const row = y * width;
    for (let x = rowMinX[y]; x <= rowMaxX[y]; x++) {
      const distFromEdge = Math.min(x - rowMinX[y], rowMaxX[y] - x);
      if (distFromEdge > excess) continue;
      const o = (row + x) * 3;
      const max = Math.max(data[o], data[o + 1], data[o + 2]);
      const min = Math.min(data[o], data[o + 1], data[o + 2]);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18) {
        productMask[row + x] = 0;
        if (!removeShadow) shadowMask[row + x] = 1;
      }
    }
  }
}
