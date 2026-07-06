# 이미지 → SVG 벡터화 변환기

이미지를 업로드하면 브라우저 안에서 바로 **path 기반 SVG**로 변환해주는 프론트엔드 전용 웹앱입니다.
서버 없이 동작하며, 업로드한 이미지는 사용자의 브라우저 밖으로 전송되지 않습니다.

## 주요 기능

- 여러 장의 이미지를 동시에 업로드 (드래그 앤 드롭 / 파일 선택 버튼)
- 지원 형식: PNG, JPG, JPEG, WEBP
- 업로드한 이미지를 각각 path 기반 SVG로 벡터화 (`imagetracerjs` 사용, base64 삽입 방식 아님)
- 투명 배경 PNG의 알파 채널을 최대한 보존
- 컬러 이미지도 색상을 양자화하여 벡터화 (색상 수 16단계)
- 파일별 처리 상태 표시: 대기 중 → 변환 중 → 완료 / 실패
- 변환 완료된 SVG를 브라우저에서 바로 미리보기
- 개별 SVG 다운로드 및 전체 SVG를 ZIP으로 한 번에 다운로드 (`vectorized_svg_files.zip`)
- 반응형 UI (모바일/데스크톱 모두 지원)

## 기술 스택

- Vite (개발 서버 / 번들러)
- Vanilla JavaScript (프레임워크 없음)
- [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) — 이미지를 path 기반 SVG로 벡터화
- [JSZip](https://stuk.github.io/jszip/) — 여러 SVG를 ZIP으로 압축
- [FileSaver.js (file-saver)](https://github.com/eligrey/FileSaver.js) — 다운로드 처리

## 로컬 실행 방법

```bash
# 1. 저장소로 이동
cd svg-vectorizer-app

# 2. 의존성 설치
npm install

# 3. 개발 서버 실행
npm run dev
```

터미널에 출력되는 주소(예: `http://localhost:5173`)를 브라우저에서 열면 됩니다.

### 프로덕션 빌드

```bash
npm run build     # dist/ 폴더에 정적 파일 생성
npm run preview   # 빌드 결과를 로컬에서 미리보기
```

`dist/` 폴더는 정적 파일만 포함하므로 GitHub Pages, Netlify, Vercel 등 어떤 정적 호스팅에도 그대로 올릴 수 있습니다.

## 사용 방법

1. 드래그 앤 드롭 영역에 이미지를 끌어다 놓거나 "이미지 선택" 버튼으로 파일을 고릅니다.
2. 업로드한 파일 목록에서 각 파일의 변환 상태를 확인합니다.
3. 변환이 완료되면 아래쪽에 SVG 미리보기 카드가 나타납니다.
4. 카드의 "SVG 다운로드" 버튼으로 개별 파일을 받거나, 상단의 "전체 ZIP 다운로드" 버튼으로 모든 결과물을 한 번에 받을 수 있습니다.

## 참고 사항 (벡터화의 한계)

- 로고, 아이콘, 단순한 일러스트, 흑백 이미지는 결과가 깔끔하게 나옵니다.
- 사람 얼굴, 풍경 사진 등 **색과 디테일이 많은 사진은 완벽하게 벡터화되지 않을 수 있으며**, 원본과 다르게 보일 수 있습니다.
- 처리 속도를 위해 긴 변이 1600px를 넘는 이미지는 자동으로 축소된 후 변환됩니다.

## 프로젝트 구조

```
svg-vectorizer-app/
├── index.html        # 앱 진입점 (마크업)
├── style.css          # 전체 스타일
├── src/
│   └── main.js        # 업로드, 벡터화, 미리보기, 다운로드 로직
├── package.json
├── vite.config.js
├── .gitignore
└── README.md
```
