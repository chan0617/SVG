// OpenCV.js는 13MB짜리 emscripten(WASM) 번들이라 Vite/Rollup이 정적 분석하다
// require('fs') 등 Node 전용 폴백 때문에 깨지기 쉽다. 번들러를 거치지 않고
// public/vendor/opencv.js를 plain <script> 태그로 로드해 전역 `cv`를 쓰는,
// OpenCV 공식 문서가 권장하는 가장 안정적인 방식을 사용한다.
let cvPromise = null;

export function loadCv(onProgress) {
  if (cvPromise) return cvPromise;

  cvPromise = new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) {
      resolve(window.cv);
      return;
    }

    onProgress?.("OpenCV.js 로딩 중...");
    const script = document.createElement("script");
    script.src = "/vendor/opencv.js";
    script.async = true;
    script.onload = async () => {
      try {
        // @techstark/opencv-js's UMD build assigns a *Promise<Module>* to
        // the global (not the Module itself, and not a synchronous
        // onRuntimeInitialized hook we can attach to after the fact) — it
        // must be awaited rather than polled.
        let cv = window.cv;
        if (cv instanceof Promise) {
          cv = await cv;
        } else if (!cv.Mat) {
          cv = await new Promise((res) => {
            cv["onRuntimeInitialized"] = () => res(cv);
          });
        }
        window.cv = cv;
        resolve(cv);
      } catch (err) {
        reject(new Error(`OpenCV.js 초기화에 실패했습니다: ${err?.message ?? err}`));
      }
    };
    script.onerror = () => {
      reject(
        new Error(
          "OpenCV.js 로드에 실패했습니다. 네트워크 연결을 확인하거나 새로고침해 주세요.",
        ),
      );
    };
    document.head.appendChild(script);
  });

  return cvPromise;
}
