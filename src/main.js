import ImageTracer from "imagetracerjs";
import JSZip from "jszip";
import { saveAs } from "file-saver";

const ACCEPTED_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_DIMENSION = 1600; // 변환 성능을 위해 긴 변 기준 최대 해상도를 제한합니다.

const TRACE_OPTIONS = {
  viewbox: true,
  numberofcolors: 16,
  mincolorratio: 0.02,
  scale: 1,
};

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const selectBtn = document.getElementById("select-btn");
const fileListSection = document.getElementById("file-list-section");
const fileListEl = document.getElementById("file-list");
const previewSection = document.getElementById("preview-section");
const previewGrid = document.getElementById("preview-grid");
const zipDownloadBtn = document.getElementById("zip-download-btn");

/** @type {Map<string, Job>} */
const jobs = new Map();
let jobSeq = 0;

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

    convertJob(job);
  }
}

function isSupportedFile(file) {
  const ext = getExtension(file.name);
  const mimeOk = ACCEPTED_MIME_TYPES.includes(file.type) || file.type === "";
  return ACCEPTED_EXTENSIONS.includes(ext) && (mimeOk || ACCEPTED_MIME_TYPES.includes(file.type));
}

function getExtension(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function toSvgFilename(filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.svg`;
}

function createJob(file) {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}-${Date.now()}`,
    file,
    status: "pending", // pending | processing | done | error
    svgString: "",
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

  const errorText = document.createElement("div");
  errorText.className = "file-item-error hidden";

  info.append(name, meta, errorText);

  const badge = document.createElement("span");
  badge.className = "status-badge pending";
  badge.textContent = "⏳ 대기 중";

  li.append(thumb, info, badge);
  fileListEl.appendChild(li);

  job.dom = { li, badge, errorText };
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

  try {
    const imageData = await loadImageData(job.file);
    const svgString = ImageTracer.imagedataToSVG(imageData, TRACE_OPTIONS);

    if (!svgString || !svgString.includes("<svg")) {
      throw new Error("SVG 생성 결과가 비어 있습니다.");
    }

    job.svgString = svgString;
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
  if (err?.message?.includes("decode")) {
    return "이미지를 디코딩할 수 없습니다. 파일 형식을 확인해주세요.";
  }
  return err?.message ? `변환 중 오류가 발생했습니다: ${err.message}` : "알 수 없는 오류로 변환에 실패했습니다.";
}

async function loadImageData(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = await loadViaImageElement(file);
  }

  let { width, height } = bitmap;
  const longestSide = Math.max(width, height);
  if (longestSide > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / longestSide;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  return ctx.getImageData(0, 0, width, height);
}

function loadViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러오는 데 실패했습니다."));
    };
    img.src = url;
  });
}

function renderPreviewCard(job) {
  previewSection.classList.remove("hidden");

  const card = document.createElement("div");
  card.className = "preview-card";

  const imageBox = document.createElement("div");
  imageBox.className = "preview-card-image";
  imageBox.innerHTML = job.svgString;

  const body = document.createElement("div");
  body.className = "preview-card-body";

  const name = document.createElement("div");
  name.className = "preview-card-name";
  name.textContent = toSvgFilename(job.file.name);
  name.title = toSvgFilename(job.file.name);

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "btn btn-outline";
  downloadBtn.textContent = "⬇️ SVG 다운로드";
  downloadBtn.addEventListener("click", () => downloadSingleSvg(job));

  body.append(name, downloadBtn);
  card.append(imageBox, body);
  previewGrid.appendChild(card);
}

function downloadSingleSvg(job) {
  const blob = new Blob([job.svgString], { type: "image/svg+xml" });
  saveAs(blob, toSvgFilename(job.file.name));
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
