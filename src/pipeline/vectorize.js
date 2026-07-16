import { loadCv } from "./cv-loader.js";
import { preprocessImage } from "./preprocess.js";
import { segmentColors } from "./segment.js";
import { detectStructuralElements } from "./lines.js";
import { extractShapes, maskFromLabel, maskFromPixels } from "./contour.js";
import { zhangSuenThin, skeletonToPolylines } from "./skeleton.js";
import { shapesToPaths, strokesToPaths } from "./trace.js";
import { assembleSvg } from "./assemble-svg.js";
import { smoothingToTolerances, buildOptions } from "./presets.js";

/**
 * Full pipeline: preprocess -> segment -> detect lines -> vectorize each
 * layer with its own strategy -> curve-fit -> assemble into a grouped SVG.
 * Mirrors the required stage order (전처리 → 영역 분할 → 선 검출 → 벡터화 →
 * 곡선 보정 → 작은 조각 정리) rather than calling one tracer with default
 * settings.
 */
export async function vectorizeImage(file, presetId, overrides, onProgress) {
  const report = (label, pct) => onProgress?.(label, pct);

  report("OpenCV 로딩 중", 2);
  const cv = await loadCv((msg) => report(msg, 2));

  const options = buildOptions(presetId, overrides);

  report("이미지 로드 중", 5);
  const imageData = await loadImageData(file, options);

  report("전처리 (노이즈 제거·edge-preserving smoothing)", 10);
  const pre = preprocessImage(cv, imageData, options);

  const diagonal = Math.hypot(pre.width, pre.height);
  const { epsilon, error } = smoothingToTolerances(options.smoothing, diagonal);
  const minAreaPx = Math.max(6, pre.pixelCount * options.minAreaRatio);
  const thickLineRadiusPx = options.thickLineRadiusPx ?? Math.max(2, Math.round(pre.height * 0.006));

  report("색상 영역 분할 (LAB k-means)", 25);
  const segResult = segmentColors(pre, { numColors: options.numColors, minAreaRatio: options.minAreaRatio });

  let structural = null;
  if (options.detectLines) {
    report("외곽선·얇은 선 검출", 40);
    structural = detectStructuralElements(pre, segResult, { ...options, thickLineRadiusPx });
  }


  report("벡터화 중", 55);
  const groups = {
    shadow: [],
    "base-colors": [],
    shading: [],
    details: [],
    stitching: [],
    laces: [],
    logo: [],
    outline: [],
  };

  // --- shadow -----------------------------------------------------
  if (hasPixels(pre.shadowMask)) {
    const shapes = extractShapes(cv, pre.shadowMask, pre.width, pre.height);
    const paths = shapesToPaths(shapes, { epsilon, error, minAreaPx });
    for (const p of paths) groups.shadow.push({ ...p, mode: "fill", color: "#000000", opacity: 0.22 });
  }

  // --- base-colors / shading ---------------------------------------
  for (const info of segResult.clusterInfo) {
    if (info.role === "neutral-light") continue; // handled by structural detection below
    if (info.area === 0) continue;

    const targetGroup = info.role === "shading" && options.keepShading ? "shading" : "base-colors";
    const mask = maskFromLabel(segResult.labels, info.index);
    const shapes = extractShapes(cv, mask, pre.width, pre.height);
    const color = labToHex(info.l, info.a, info.b);
    const paths = shapesToPaths(shapes, { epsilon, error, minAreaPx });
    for (const p of paths) groups[targetGroup].push({ ...p, mode: "fill", color });
  }

  // --- white structural elements ------------------------------------
  if (structural) {
    const { whiteComponents } = structural;

    // Sole: large white blob touching the bottom -> treated as a base fill.
    if (whiteComponents.sole.length) {
      const pixels = whiteComponents.sole.flatMap((c) => c.pixels);
      const mask = maskFromPixels(pixels, pre.width, pre.height);
      const shapes = extractShapes(cv, mask, pre.width, pre.height);
      const paths = shapesToPaths(shapes, { epsilon, error, minAreaPx });
      for (const p of paths) groups["base-colors"].push({ ...p, mode: "fill", color: "#f5f5f5" });
    }

    // Logo: compact white blobs -> filled shapes.
    if (whiteComponents.logo.length) {
      const pixels = whiteComponents.logo.flatMap((c) => c.pixels);
      const mask = maskFromPixels(pixels, pre.width, pre.height);
      const shapes = extractShapes(cv, mask, pre.width, pre.height);
      const paths = shapesToPaths(shapes, { epsilon, error, minAreaPx: Math.min(minAreaPx, 10) });
      for (const p of paths) groups.logo.push({ ...p, mode: "fill", color: "#ffffff" });
    }

    // Laces & stitching: skeletonize -> stroke paths (never filled), so
    // they can't merge into a blob the way naive polygon tracing would.
    addSkeletonStrokes(whiteComponents.laces, pre, groups.laces, { epsilon, error }, "#ffffff");
    addSkeletonStrokes(whiteComponents.stitching, pre, groups.stitching, { epsilon, error }, "#e8e8e8");

    // Outline: the outer silhouette as a standalone stroke, plus any thin
    // interior black hairline dividers.
    const silhouetteShapes = extractShapes(cv, structural.silhouetteMask, pre.width, pre.height);
    for (const shape of silhouetteShapes) {
      const paths = shapesToPaths([shape], { epsilon, error, minAreaPx });
      for (const p of paths) {
        groups.outline.push({
          d: p.d,
          mode: "stroke",
          color: "#000000",
          strokeWidth: thickLineRadiusPx * 2,
        });
      }
    }
    if (hasPixels(structural.blackThinLineMask)) {
      // The opening-based thin/thick split also flags naturally-narrow
      // fabric strips (e.g. the black material between shoelace loops) as
      // "thin lines". Those are short and numerous; a real interior divider
      // stroke in a flat illustration spans a meaningful distance, so a
      // generous minimum length filters the fabric-strip noise out while
      // keeping genuine hairline dividers.
      const thin = zhangSuenThin(structural.blackThinLineMask, pre.width, pre.height);
      const polylines = skeletonToPolylines(thin, pre.width, pre.height);
      const minDividerLength = pre.height * 0.05;
      const paths = strokesToPaths(polylines, { epsilon, error, minLengthPx: minDividerLength });
      for (const p of paths) {
        groups.outline.push({ d: p.d, mode: "stroke", color: "#000000", strokeWidth: thickLineRadiusPx });
      }
    }
  } else {
    // Icon/no-line-detection presets still get an outer silhouette outline.
    const silhouetteShapes = extractShapes(cv, pre.productMask, pre.width, pre.height);
    for (const shape of silhouetteShapes) {
      const paths = shapesToPaths([shape], { epsilon, error, minAreaPx });
      for (const p of paths) {
        groups.outline.push({ d: p.d, mode: "stroke", color: "#000000", strokeWidth: thickLineRadiusPx * 2 });
      }
    }
  }

  pre.mat.delete();

  report("SVG 조립 중", 92);
  const { svgString, stats } = assembleSvg({
    width: pre.width,
    height: pre.height,
    groups,
    useCssClasses: options.useCssClasses,
  });

  report("완료", 100);
  return { svgString, stats, width: pre.width, height: pre.height, groups };
}

function addSkeletonStrokes(components, pre, targetArray, tolerances, defaultColor) {
  for (const comp of components) {
    const mask = maskFromPixels(comp.pixels, pre.width, pre.height);
    const thin = zhangSuenThin(mask, pre.width, pre.height);
    const polylines = skeletonToPolylines(thin, pre.width, pre.height);
    const paths = strokesToPaths(polylines, { ...tolerances, minLengthPx: 3 });
    for (const p of paths) {
      targetArray.push({
        d: p.d,
        mode: "stroke",
        color: defaultColor,
        strokeWidth: comp.strokeWidth ?? 2,
      });
    }
  }
}

function hasPixels(mask) {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
  return false;
}

function labToHex(l, a, b) {
  // Inverse of the sRGB->Lab conversion in raster.js.
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const finv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = finv(fx) * 0.95047;
  const y = finv(fy);
  const z = finv(fz) * 1.08883;

  let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let bch = x * 0.0557 + y * -0.204 + z * 1.057;

  const gamma = (c) => (c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c);
  r = clamp255(gamma(r) * 255);
  g = clamp255(gamma(g) * 255);
  bch = clamp255(gamma(bch) * 255);

  return `#${hex(r)}${hex(g)}${hex(bch)}`;
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}
function hex(v) {
  return v.toString(16).padStart(2, "0");
}

function loadImageData(file, options) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러오는 데 실패했습니다."));
    };
    img.src = url;
    void options;
  });
}
