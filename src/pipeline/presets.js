export const PRESETS = {
  icon: {
    label: "로고/아이콘",
    description: "적은 색상, 선명한 외곽선, 적은 path",
    numColors: 5,
    minAreaRatio: 0.006,
    smoothing: 75,
    detectLines: false,
    keepShading: false,
    strokeMaxWidthRatio: 0.02,
    stitchAreaRatio: 0.002,
    thickLineRadiusPx: null, // derived from image size
    useCssClasses: true,
  },
  illustration: {
    label: "캐릭터/일러스트",
    description: "곡선과 내부 선 보존, 중간 색상 수, 봉제선·세부선 유지",
    numColors: 14,
    minAreaRatio: 0.0016,
    smoothing: 48,
    detectLines: true,
    keepShading: true,
    strokeMaxWidthRatio: 0.018,
    stitchAreaRatio: 0.0018,
    thickLineRadiusPx: null,
    useCssClasses: true,
  },
  product: {
    label: "제품 이미지",
    description: "명암 면 보존, 높은 색상 수, 디테일 우선",
    numColors: 26,
    minAreaRatio: 0.0008,
    smoothing: 28,
    detectLines: true,
    keepShading: true,
    strokeMaxWidthRatio: 0.014,
    stitchAreaRatio: 0.0014,
    thickLineRadiusPx: null,
    useCssClasses: true,
  },
};

export const DEFAULT_PRESET_ID = "illustration";

/** smoothing (0-100, higher = smoother/fewer points) -> the two numeric
 * knobs the curve stage actually needs: Douglas-Peucker epsilon and the
 * fit-curve max error, both scaled to image size so the same slider value
 * behaves consistently across resolutions. Epsilon is additionally capped
 * so the silhouette can never drift far from the source regardless of
 * slider position. */
export function smoothingToTolerances(smoothing, diagonal) {
  const t = Math.min(100, Math.max(0, smoothing)) / 100;
  const maxEpsilon = diagonal * 0.004;
  const epsilon = Math.max(0.6, t * maxEpsilon);
  const error = Math.max(0.8, epsilon * 2.2);
  return { epsilon, error };
}

export function buildOptions(presetId, overrides = {}) {
  const preset = PRESETS[presetId] ?? PRESETS[DEFAULT_PRESET_ID];
  return { ...preset, presetId, ...overrides };
}
