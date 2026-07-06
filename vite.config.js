import { defineConfig } from "vite";

// GitHub Pages(프로젝트 페이지)에서 https://<user>.github.io/SVG/ 로 서빙되므로
// 빌드 시에만 base 경로를 저장소 이름으로 맞춰준다. 로컬 개발 서버는 영향받지 않는다.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/SVG/" : "/",
}));
