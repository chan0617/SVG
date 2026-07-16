import { connectedComponents, binaryOpen, distanceTransform } from "./raster.js";

/**
 * Stage 2 (line side): separates the black outline into a "thick fill" part
 * (large blobs — the shoe body itself) and a "thin stroke" part (hairline
 * dividers), and buckets every near-white blob into laces / stitching /
 * logo / sole using shape + position instead of tracing everything as one
 * kind of face like the old pipeline did.
 */
export function detectStructuralElements(pre, segResult, options) {
  const { width, height, pixelCount, productMask } = pre;
  const { labels, clusterInfo } = segResult;
  const strokeRadiusPx = Math.max(1, Math.round(options.thickLineRadiusPx ?? height * 0.006));

  const blackMask = new Uint8Array(pixelCount);
  const whiteMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const l = labels[i];
    if (l < 0) continue;
    const info = clusterInfo[l];
    if (info.isNearBlack) blackMask[i] = 1;
    else if (info.role === "neutral-light") whiteMask[i] = 1;
  }

  // Opening removes anything thinner than strokeRadiusPx*2, leaving only
  // "fill" blobs; subtracting that from the full mask isolates hairline
  // strokes (interior black divider lines, if the illustration has any
  // separate from the main body).
  const blackBlobs = binaryOpen(blackMask, width, height, strokeRadiusPx);
  const blackThinLines = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (blackMask[i] && !blackBlobs[i]) blackThinLines[i] = 1;
  }

  const silhouette = productMask;

  // --- White region classification ---------------------------------
  const dist = distanceTransform(whiteMask, width, height);
  const { components } = connectedComponents((idx) => whiteMask[idx] === 1, width, height);

  const [prodMinY, prodMaxY] = productYExtent(productMask, width, height);
  const productHeight = Math.max(1, prodMaxY - prodMinY);
  const strokeThicknessLimit = Math.max(3, height * (options.strokeMaxWidthRatio ?? 0.018));
  const smallStitchArea = pixelCount * (options.stitchAreaRatio ?? 0.0018);

  const laces = [];
  const stitching = [];
  const logo = [];
  const soleExtraPixels = [];

  for (const comp of components) {
    if (comp.count < 4) continue; // pure noise speck

    // Several separate laces touch where they cross at each eyelet, so
    // connected-components merges the whole crisscross into one blob. A
    // handful of locally-wide crossing points would blow out a max-based
    // thickness test and misclassify the entire tangle as a solid blob
    // (dumping it into 'logo' as a messy multi-hole fill instead of clean
    // lace strokes). The 70th percentile of per-pixel distance is robust to
    // those outliers and reflects the *typical* strand width instead.
    const distances = new Array(comp.pixels.length);
    for (let i = 0; i < comp.pixels.length; i++) distances[i] = dist[comp.pixels[i]];
    distances.sort((a, b) => a - b);
    const p70 = distances[Math.floor(distances.length * 0.7)];
    const maxDist = distances[distances.length - 1];
    const thickness = p70 * 2;

    comp.strokeWidth = Math.max(2, Math.min(maxDist, p70 * 1.6) * 2);
    const bboxW = comp.maxX - comp.minX + 1;
    const bboxH = comp.maxY - comp.minY + 1;
    const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
    const touchesBottomBand = comp.maxY >= prodMaxY - productHeight * 0.16;
    const isStrokeLike = thickness < strokeThicknessLimit;

    if (!isStrokeLike) {
      if (touchesBottomBand && comp.count > pixelCount * 0.04) {
        soleExtraPixels.push(comp);
      } else {
        logo.push(comp);
      }
      continue;
    }

    if (comp.count < smallStitchArea && aspect > 1.8) {
      stitching.push(comp);
    } else {
      laces.push(comp);
    }
  }

  return {
    silhouetteMask: silhouette,
    blackFillMask: blackBlobs,
    blackThinLineMask: blackThinLines,
    whiteComponents: { laces, stitching, logo, sole: soleExtraPixels },
    strokeRadiusPx,
  };
}

function productYExtent(mask, width, height) {
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        break;
      }
    }
  }
  if (maxY === -1) return [0, height];
  return [minY, maxY];
}
