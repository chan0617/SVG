export const GROUP_ORDER = [
  "shadow",
  "base-colors",
  "shading",
  "details",
  "stitching",
  "laces",
  "logo",
  "outline",
];

/**
 * Builds the final SVG as explicit named <g> layers (never one merged
 * mega-path), each independently selectable/editable in Illustrator or
 * Figma. `groups[name]` is an array of
 * `{ d, mode: 'fill'|'stroke', color, strokeWidth?, opacity? }`.
 */
export function assembleSvg({ width, height, groups, useCssClasses = false }) {
  const classMap = new Map();
  const colorAttr = (color, mode) => {
    if (!useCssClasses) {
      return mode === "stroke" ? `stroke="${color}"` : `fill="${color}"`;
    }
    const key = `${mode}:${color}`;
    if (!classMap.has(key)) classMap.set(key, `c${classMap.size}`);
    return `class="${classMap.get(key)}"`;
  };

  let body = "";
  let totalPaths = 0;
  let totalAnchors = 0;
  const groupStats = {};

  for (const groupName of GROUP_ORDER) {
    const items = groups[groupName] || [];
    let inner = "";
    let anchors = 0;

    for (const item of items) {
      if (!item.d) continue;
      totalPaths++;
      anchors += countAnchors(item.d);

      if (item.mode === "stroke") {
        const width = item.strokeWidth ?? 2;
        inner += `<path ${colorAttr(item.color, "stroke")} fill="none" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" d="${item.d}"/>`;
      } else {
        const opacityAttr = item.opacity !== undefined ? ` opacity="${item.opacity}"` : "";
        inner += `<path ${colorAttr(item.color, "fill")} fill-rule="evenodd"${opacityAttr} d="${item.d}"/>`;
      }
    }

    totalAnchors += anchors;
    groupStats[groupName] = { paths: items.length, anchors };
    if (inner) body += `<g id="${groupName}">${inner}</g>`;
    else body += `<g id="${groupName}"/>`;
  }

  let styleBlock = "";
  if (useCssClasses && classMap.size) {
    const rules = [];
    for (const [key, cls] of classMap) {
      const [mode, color] = key.split(":");
      rules.push(`.${cls}{${mode}:${color};${mode === "stroke" ? "fill:none;" : ""}}`);
    }
    styleBlock = `<style>${rules.join("")}</style>`;
  }

  const svgString =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${styleBlock}${body}</svg>`;

  return { svgString, stats: { totalPaths, totalAnchors, groupStats } };
}

function countAnchors(d) {
  const moves = d.match(/M\s*-?\d/g) || [];
  const curves = d.match(/C\s*-?\d/g) || [];
  const lines = d.match(/L\s*-?\d/g) || [];
  return moves.length + curves.length + lines.length;
}
