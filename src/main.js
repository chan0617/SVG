import JSZip from "jszip";
import { saveAs } from "file-saver";
import { vectorizeImage } from "./pipeline/vectorize.js";
import { PRESETS, DEFAULT_PRESET_ID } from "./pipeline/presets.js";

const ACCEPTED_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const selectBtn = document.getElementById("select-btn");
const fileListSection = document.getElementById("file-list-section");
const fileListEl = document.getElementById("file-list");
const previewSection = document.getElementById("preview-section");
const previewGrid = document.getElementById("preview-grid");
const zipDownloadBtn = document.getElementById("zip-download-btn");

const presetButtons = Array.from(document.querySelectorAll(".preset-btn"));
const colorCountInput = document.getElementById("color-count");
const colorCountValue = document.getElementById("color-count-value");
const smoothingInput = document.getElementById("smoothing");
const smoothingValue = document.getElementById("smoothing-value");
const keepShadingInput = document.getElementById("keep-shading");
const detectLinesInput = document.getElementById("detect-lines");
const removeShadowInput = document.getElementById("remove-shadow");
const useCssClassesInput = document.getElementById("use-css-classes");

/** @type {Map<string, Job>} */
const jobs = new Map();
let jobSeq = 0;
let currentPresetId = DEFAULT_PRESET_ID;

function applyPresetToControls(presetId) {
  const preset = PRESETS[presetId];
  colorCountInput.value = preset.numColors;
  colorCountValue.textContent = preset.numColors;
  smoothingInput.value = preset.smoothing;
  smoothingValue.textContent = preset.smoothing;
  keepShadingInput.checked = preset.keepShading;
  detectLinesInput.checked = preset.detectLines;
  useCssClassesInput.checked = preset.useCssClasses;
}
applyPresetToControls(currentPresetId);

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    presetButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPresetId = btn.dataset.preset;
    applyPresetToControls(currentPresetId);
  });
});

colorCountInput.addEventListener("input", () => (colorCountValue.textContent = colorCountInput.value));
smoothingInput.addEventListener("input", () => (smoothingValue.textContent = smoothingInput.value));

function currentOverrides() {
  return {
    numColors: Number(colorCountInput.value),
    smoothing: Number(smoothingInput.value),
    keepShading: keepShadingInput.checked,
    detectLines: detectLinesInput.checked,
    removeShadow: removeShadowInput.checked,
    useCssClasses: useCssClassesInput.checked,
  };
}

// 여러 이미지를 한꺼번에 변환하면 메모리/CPU 부하가 겹쳐 탭이 멈출 수 있어
// 한 번에 하나씩만 처리하는 순차 큐를 사용한다. (OpenCV Mat도 GC되지 않아
// 동시 처리 시 누수 위험이 커진다.)
const conversionQueue = [];
let isProcessingQueue = false;

function enqueueJob(job) {
  conversionQueue.push(job);
  if (!isProcessingQueue) processQueue();
}

async function processQueue() {
  isProcessingQueue = true;
  while (conversionQueue.length) {
    const job = conversionQueue.shift();
    await convertJob(job);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  isProcessingQueue = false;
}

selectBtn.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("click", (e) => {
  if (e.target === selectBtn) return;
  fileInput.click();
});

fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
  });
});

dropZone.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (files && files.length) handleFiles(files);
});

zipDownloadBtn.addEventListener("click", downloadAllAsZip);

function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  fileListSection.classList.remove("hidden");

  for (const file of files) {
    const job = createJob(file);
    jobs.set(job.id, job);
    renderFileItem(job);

    if (!isSupportedFile(file)) {
      updateJobStatus(job, "error", "지원하지 않는 파일 형식입니다. (PNG, JPG, JPEG, WEBP만 가능)");
      continue;
    }

    enqueueJob(job);
  }
}

function isSupportedFile(file) {
  const ext = getExtension(file.name);
  const mimeOk = ACCEPTED_MIME_TYPES.includes(file.type) || file.type === "";
  return ACCEPTED_EXTENSIONS.includes(ext) && mimeOk;
}

function getExtension(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function toSvgFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}_vector.svg`;
}

function toPngFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}_vector.png`;
}

function createJob(file) {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}-${Date.now()}`,
    file,
    status: "pending",
    svgString: "",
    stats: null,
    width: 0,
    height: 0,
    errorMessage: "",
    dom: {},
  };
}

function renderFileItem(job) {
  const li = document.createElement("li");
  li.className = "file-item";

  const thumb = document.createElement("img");
  thumb.className = "file-item-thumb";
  thumb.alt = job.file.name;
  const objectUrl = URL.createObjectURL(job.file);
  thumb.src = objectUrl;
  thumb.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });

  const info = document.createElement("div");
  info.className = "file-item-info";

  const name = document.createElement("div");
  name.className = "file-item-name";
  name.textContent = job.file.name;

  const meta = document.createElement("div");
  meta.className = "file-item-meta";
  meta.textContent = formatFileSize(job.file.size);

  const progressText = document.createElement("div");
  progressText.className = "file-item-progress";

  const errorText = document.createElement("div");
  errorText.className = "file-item-error hidden";

  info.append(name, meta, progressText, errorText);

  const badge = document.createElement("span");
  badge.className = "status-badge pending";
  badge.textContent = "⏳ 대기 중";

  li.append(thumb, info, badge);
  fileListEl.appendChild(li);

  job.dom = { li, badge, errorText, progressText };
}

function updateJobStatus(job, status, message = "") {
  job.status = status;
  const { badge, errorText } = job.dom;

  const statusMap = {
    pending: { className: "pending", label: "⏳ 대기 중" },
    processing: { className: "processing", label: "🔄 변환 중" },
    done: { className: "done", label: "✅ 완료" },
    error: { className: "error", label: "❌ 실패" },
  };

  const { className, label } = statusMap[status];
  badge.className = `status-badge ${className}`;
  badge.textContent = label;

  if (status === "error" && message) {
    job.errorMessage = message;
    errorText.textContent = message;
    errorText.classList.remove("hidden");
  } else {
    errorText.classList.add("hidden");
  }

  updateZipButtonState();
}

function updateZipButtonState() {
  const doneCount = Array.from(jobs.values()).filter((j) => j.status === "done").length;
  zipDownloadBtn.disabled = doneCount === 0;
  zipDownloadBtn.textContent =
    doneCount > 1 ? `📦 전체 ZIP 다운로드 (${doneCount}개)` : "📦 전체 ZIP 다운로드";
}

async function convertJob(job) {
  updateJobStatus(job, "processing");
  const presetId = currentPresetId;
  const overrides = currentOverrides();

  try {
    const result = await vectorizeImage(job.file, presetId, overrides, (label, pct) => {
      job.dom.progressText.textContent = `${label} (${pct}%)`;
    });

    job.svgString = result.svgString;
    job.stats = result.stats;
    job.width = result.width;
    job.height = result.height;
    job.dom.progressText.textContent = "";

    updateJobStatus(job, "done");
    renderPreviewCard(job);
  } catch (err) {
    console.error(`[${job.file.name}] 변환 실패:`, err);
    updateJobStatus(job, "error", describeError(err));
  }
}

function describeError(err) {
  if (err instanceof DOMException && err.name === "InvalidStateError") {
    return "이미지 파일을 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.";
  }
  if (err?.message?.includes("OpenCV")) {
    return err.message;
  }
  if (err?.message?.includes("decode")) {
    return "이미지를 디코딩할 수 없습니다. 파일 형식을 확인해주세요.";
  }
  return err?.message ? `변환 중 오류가 발생했습니다: ${err.message}` : "알 수 없는 오류로 변환에 실패했습니다.";
}

const FILL_GROUPS = ["shadow", "base-colors", "shading", "details", "logo"];
const LINE_GROUPS = ["stitching", "laces", "outline"];

function renderPreviewCard(job) {
  previewSection.classList.remove("hidden");

  const card = document.createElement("div");
  card.className = "preview-card";
  card.dataset.view = "all";
  card.dataset.bg = "transparent";

  const originalUrl = URL.createObjectURL(job.file);

  card.innerHTML = `
    <div class="compare-view">
      <div class="compare-pane original">
        <img src="${originalUrl}" alt="원본" />
        <span class="pane-label">원본</span>
      </div>
      <div class="compare-pane result checkerboard">
        <div class="svg-zoom-wrap"><div class="svg-holder">${job.svgString}</div></div>
        <span class="pane-label">SVG 결과</span>
        <div class="overlay-holder" style="opacity:0"></div>
      </div>
    </div>

    <div class="compare-controls">
      <div class="control-row">
        <button type="button" class="chip-btn" data-bg="transparent">투명</button>
        <button type="button" class="chip-btn active" data-bg="white">흰 배경</button>
        <span class="sep"></span>
        <button type="button" class="chip-btn active" data-view="all">전체</button>
        <button type="button" class="chip-btn" data-view="outline">외곽선만</button>
        <button type="button" class="chip-btn" data-view="colors">색상면만</button>
        <button type="button" class="chip-btn" data-view="small">작은 조각 표시</button>
      </div>
      <div class="control-row">
        <label class="slider-label">겹쳐보기(원본↔결과)
          <input type="range" class="overlay-slider" min="0" max="100" value="0" />
        </label>
        <label class="slider-label">확대
          <input type="range" class="zoom-slider" min="100" max="400" value="100" />
        </label>
      </div>
    </div>

    <div class="stats-row">
      path ${job.stats.totalPaths}개 · anchor point ${job.stats.totalAnchors}개 · ${job.width}×${job.height}px
    </div>

    <div class="preview-card-body">
      <div class="preview-card-name" title="${toSvgFilename(job.file.name)}">${toSvgFilename(job.file.name)}</div>
      <div class="card-actions">
        <button type="button" class="btn btn-outline btn-svg">⬇️ SVG 다운로드</button>
        <button type="button" class="btn btn-outline btn-png">🖼️ PNG 미리보기 저장</button>
      </div>
    </div>
  `;

  wireCardInteractions(card, job);
  previewGrid.appendChild(card);
}

function wireCardInteractions(card, job) {
  const svgHolder = card.querySelector(".svg-holder");
  const resultPane = card.querySelector(".compare-pane.result");
  const zoomWrap = card.querySelector(".svg-zoom-wrap");

  card.querySelectorAll("[data-bg]").forEach((btn) => {
    btn.addEventListener("click", () => {
      card.querySelectorAll("[data-bg]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const bg = btn.dataset.bg;
      resultPane.classList.toggle("checkerboard", bg === "transparent");
      resultPane.classList.toggle("white-bg", bg === "white");
    });
  });

  card.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      card.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyViewFilter(svgHolder, btn.dataset.view);
    });
  });

  const overlaySlider = card.querySelector(".overlay-slider");
  const originalImg = card.querySelector(".compare-pane.original img");
  const overlayHolder = card.querySelector(".overlay-holder");
  overlayHolder.style.backgroundImage = `url(${originalImg.src})`;
  overlayHolder.style.backgroundSize = "contain";
  overlayHolder.style.backgroundRepeat = "no-repeat";
  overlayHolder.style.backgroundPosition = "center";
  overlaySlider.addEventListener("input", () => {
    overlayHolder.style.opacity = String(overlaySlider.value / 100);
  });

  const zoomSlider = card.querySelector(".zoom-slider");
  zoomSlider.addEventListener("input", () => {
    const scale = zoomSlider.value / 100;
    zoomWrap.style.transform = `scale(${scale})`;
    zoomWrap.style.transformOrigin = "center";
  });

  card.querySelector(".btn-svg").addEventListener("click", () => downloadSingleSvg(job));
  card.querySelector(".btn-png").addEventListener("click", () => downloadSinglePng(job));
}

function applyViewFilter(svgHolder, view) {
  const svg = svgHolder.querySelector("svg");
  if (!svg) return;
  const allGroups = [...FILL_GROUPS, ...LINE_GROUPS];

  for (const name of allGroups) {
    const g = svg.querySelector(`#${CSS.escape(name)}`);
    if (!g) continue;
    if (view === "all") g.style.display = "";
    else if (view === "outline") g.style.display = name === "outline" ? "" : "none";
    else if (view === "colors") g.style.display = LINE_GROUPS.includes(name) ? "none" : "";
    else if (view === "small") g.style.display = "";
  }

  // "작은 조각 표시": highlight the smallest-area 10% of fill paths in
  // magenta so leftover noise fragments are easy to spot at a glance.
  svg.querySelectorAll("path[data-small-highlight]").forEach((p) => p.removeAttribute("data-small-highlight"));
  if (view === "small") {
    const fillPaths = Array.from(svg.querySelectorAll("g:not(#outline):not(#laces):not(#stitching) path"));
    const areas = fillPaths.map((p) => estimatePathArea(p));
    const sorted = [...areas].sort((a, b) => a - b);
    const cutoff = sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 1)] ?? 0;
    fillPaths.forEach((p, i) => {
      if (areas[i] <= cutoff && areas[i] > 0) {
        p.setAttribute("data-small-highlight", "1");
        p.style.outline = "1px solid magenta";
      } else {
        p.style.outline = "";
      }
    });
  } else {
    svgHolder.querySelectorAll("path").forEach((p) => (p.style.outline = ""));
  }
}

function estimatePathArea(pathEl) {
  try {
    const bbox = pathEl.getBBox();
    return bbox.width * bbox.height;
  } catch {
    return 0;
  }
}

function downloadSingleSvg(job) {
  const blob = new Blob([job.svgString], { type: "image/svg+xml" });
  saveAs(blob, toSvgFilename(job.file.name));
}

async function downloadSinglePng(job) {
  const blob = await svgToPngBlob(job.svgString, job.width, job.height, 2);
  saveAs(blob, toPngFilename(job.file.name));
}

function svgToPngBlob(svgString, width, height, scale = 2) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 변환에 실패했습니다."));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG를 PNG로 렌더링하는 데 실패했습니다."));
    };
    img.src = url;
  });
}

async function downloadAllAsZip() {
  const doneJobs = Array.from(jobs.values()).filter((j) => j.status === "done");
  if (!doneJobs.length) return;

  zipDownloadBtn.disabled = true;
  const originalText = zipDownloadBtn.textContent;
  zipDownloadBtn.textContent = "압축 중...";

  try {
    const zip = new JSZip();
    const usedNames = new Set();

    for (const job of doneJobs) {
      const filename = uniqueName(toSvgFilename(job.file.name), usedNames);
      zip.file(filename, job.svgString);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "vectorized_svg_files.zip");
  } catch (err) {
    console.error("ZIP 생성 실패:", err);
    alert("ZIP 파일을 생성하는 중 오류가 발생했습니다. 다시 시도해주세요.");
  } finally {
    zipDownloadBtn.disabled = false;
    updateZipButtonState();
    if (zipDownloadBtn.disabled === false && zipDownloadBtn.textContent === "압축 중...") {
      zipDownloadBtn.textContent = originalText;
    }
  }
}

function uniqueName(name, usedNames) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = `${base}(${i})${ext}`;
  while (usedNames.has(candidate)) {
    i += 1;
    candidate = `${base}(${i})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
