/**
 * Wraps cv.findContours (RETR_CCOMP) to get outer boundaries paired with
 * their holes correctly — this is the "내부 구멍과 겹침 관계를 정확히 유지"
 * requirement; hand-rolled marching-squares would need to reimplement the
 * same hole/parent bookkeeping OpenCV already does robustly.
 */
export function extractShapes(cv, mask, width, height, minPoints = 3) {
  const matU8 = new cv.Mat(height, width, cv.CV_8UC1);
  const matData = matU8.data;
  for (let i = 0; i < mask.length; i++) matData[i] = mask[i] ? 255 : 0;

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(matU8, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

  const hierData = hierarchy.data32S;
  const contourPointsList = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const pts = [];
    const d = c.data32S;
    for (let p = 0; p < d.length; p += 2) pts.push([d[p], d[p + 1]]);
    contourPointsList.push(pts);
    c.delete();
  }

  const shapes = [];
  const shapeByIndex = new Map();
  for (let i = 0; i < contourPointsList.length; i++) {
    const parent = hierData[i * 4 + 3];
    if (parent === -1 && contourPointsList[i].length >= minPoints) {
      const shape = { outer: contourPointsList[i], holes: [] };
      shapes.push(shape);
      shapeByIndex.set(i, shape);
    }
  }
  for (let i = 0; i < contourPointsList.length; i++) {
    const parent = hierData[i * 4 + 3];
    if (parent !== -1 && shapeByIndex.has(parent) && contourPointsList[i].length >= minPoints) {
      shapeByIndex.get(parent).holes.push(contourPointsList[i]);
    }
  }

  matU8.delete();
  contours.delete();
  hierarchy.delete();

  return shapes;
}

export function maskFromPixels(pixels, width, height) {
  const mask = new Uint8Array(width * height);
  for (const idx of pixels) mask[idx] = 1;
  return mask;
}

export function maskFromLabel(labels, targetLabel) {
  const mask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] === targetLabel) mask[i] = 1;
  return mask;
}
