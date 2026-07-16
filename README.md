# 이미지 → SVG 벡터화 변환기

이미지를 업로드하면 브라우저 안에서 바로 **레이어 구조를 갖춘 고품질 SVG**로 변환해주는
프론트엔드 전용 웹앱입니다. 서버 없이 동작하며, 업로드한 이미지는 브라우저 밖으로
전송되지 않습니다.

## 파이프라인

단일 라이브러리를 기본 옵션으로 호출하는 방식이 아니라, 다음 6단계를 직접 구성합니다.

1. **전처리** — 필요 시 2배 업스케일, 노이즈 제거, OpenCV.js bilateral filter로
   edge-preserving smoothing, 연결성 기반 배경/그림자 자동 분리
2. **영역 분할** — LAB(perceptual) 색상 공간 k-means 군집화(결정적 시드) +
   색상 유사도가 실제로 가까울 때만 작은 조각을 이웃 면에 병합
3. **선 검출** — 두께의 70th-percentile 기반으로 굵은 면과 얇은 선을 구분,
   흰색 얇은 영역은 스켈레톤화 후 stroke 후보로, 검정 얇은 영역은 outline 후보로 분리
4. **벡터화** — OpenCV `findContours`(hierarchy 포함, 구멍/겹침 관계 유지)로 면을,
   Zhang-Suen 스켈레톤 그래프 워크로 선을 좌표열로 추출
5. **곡선 보정** — Douglas-Peucker로 직선 구간은 축소하고 곡률이 큰 지점은 보존,
   `fit-curve`(Schneider 알고리즘) 베지어 피팅으로 매끄러운 `C` 커맨드 생성
6. **작은 조각 정리** — 병합 후에도 남은 절대 픽셀 면적 미만 path는 최종 제거

## 기존 코드의 문제와 원인 (수정 전 분석)

- `imagetracerjs`를 옵션 튜닝 없이 그대로 호출 → 내부적으로 RGB 거리 기반 색상
  양자화라 비슷한 색이 잘게 쪼개짐
- 전처리(노이즈 제거/edge-preserving smoothing)가 전혀 없어 JPEG 노이즈가 그대로
  작은 조각으로 트레이싱됨
- 배경/그림자/외곽선/얇은 선을 구분하지 않고 전부 동일한 "색상 면" 트레이싱 방식으로
  처리 → 신발끈·봉제선이 면으로 뭉개지거나 사라짐
- 작은 조각을 면적 기준으로 병합/제거하는 로직이 없고 색상 비율 필터만 존재
- 레이어 구조 없이 색상별 flat path만 생성

## 프로젝트 구조

```
svg-vectorizer-app/
├── index.html
├── style.css
├── public/vendor/opencv.js       # OpenCV.js (script 태그로 로드, 번들러 미거침)
├── src/
│   ├── main.js                    # 업로드/큐/미리보기/다운로드 UI 로직
│   └── pipeline/
│       ├── cv-loader.js            # OpenCV.js 비동기 로드
│       ├── raster.js                # Lab 변환, k-means, connected-components,
│       │                              erode/dilate, distance transform, 시드 PRNG
│       ├── preprocess.js             # 업스케일/노이즈제거/스무딩/배경·그림자 분리
│       ├── segment.js                 # LAB k-means 색상 분할 + small-region merge
│       ├── lines.js                    # 굵은/얇은 선 검출, 흰색 영역 laces/stitching/logo/sole 분류
│       ├── skeleton.js                  # Zhang-Suen 스켈레톤화 + 그래프 워크
│       ├── contour.js                    # OpenCV findContours 래핑 (hole 포함)
│       ├── geometry.js                    # Douglas-Peucker, fit-curve 래핑, 넓이 계산
│       ├── trace.js                        # 면/선 → path 리스트 변환 (면적 pruning)
│       ├── assemble-svg.js                  # 레이어 그룹 SVG 조립, 통계 계산
│       ├── presets.js                        # 프리셋 3종 + smoothing 슬라이더 매핑
│       └── vectorize.js                       # 전체 파이프라인 오케스트레이터
├── package.json
├── vite.config.js
└── README.md
```

## 기술 스택

- Vite + Vanilla JavaScript (프레임워크 없음)
- [OpenCV.js](https://github.com/TechStark/opencv-js) — bilateral filter, resize, findContours
- [fit-curve](https://github.com/soswow/fit-curve) — Bézier curve fitting (Schneider 알고리즘)
- [JSZip](https://stuk.github.io/jszip/) / [file-saver](https://github.com/eligrey/FileSaver.js) — 다운로드
- 무료 오픈소스만 사용, 외부 유료 API 없음

## 로컬 실행 방법

```bash
cd svg-vectorizer-app
npm install
npm run dev
```

터미널에 출력되는 주소(예: `http://localhost:5173`)를 브라우저에서 엽니다.

```bash
npm run build     # dist/ 폴더에 정적 파일 생성
npm run preview   # 빌드 결과를 로컬에서 미리보기
```

## 품질 프리셋

| 프리셋 | 색상 수 | Smoothing | 얇은 선 검출 | 명암 유지 |
| --- | --- | --- | --- | --- |
| A. 로고/아이콘 | 5 | 75 | ✗ | ✗ |
| B. 캐릭터/일러스트 (기본값) | 14 | 48 | ✓ | ✓ |
| C. 제품 이미지 | 26 | 28 | ✓ | ✓ |

세부 설정(색상 수 4~32, smoothing 0~100, 내부 명암 유지, 얇은 선 검출, 그림자 제거,
CSS class 정리)은 화면 상단 "세부 설정"에서 직접 조절할 수 있습니다.

## SVG 레이어 구조

```
<svg viewBox="0 0 W H" ...>
  <g id="shadow">      <!-- 바닥 그림자, opacity 0.22 -->
  <g id="base-colors">  <!-- 주요 색상 면 -->
  <g id="shading">        <!-- 내부 명암 면 (같은 색상군 중 어두운/밝은 변형) -->
  <g id="details">          <!-- 예약 그룹 -->
  <g id="stitching">          <!-- 얇은 봉제선, stroke 기반 -->
  <g id="laces">                <!-- 신발끈 등 얇은 흰색 선, stroke 기반 -->
  <g id="logo">                   <!-- 로고/장식, fill 기반 -->
  <g id="outline">                  <!-- 바깥쪽 실루엣 + 내부 굵은 경계선, stroke 기반 -->
</svg>
```

각 그룹은 독립적으로 선택/수정 가능하며, 동일 색상은 옵션으로 CSS class로 정리됩니다.
다운로드 파일명은 `원본파일명_vector.svg` 규칙을 따릅니다.

## 참고 사항 (알려진 한계)

- 서로 교차하는 얇은 선(예: 여러 겹으로 겹친 신발끈)은 스켈레톤 그래프가 교차점마다
  갈라지기 때문에 하나의 긴 곡선이 아니라 여러 개의 짧은 stroke path로 나뉠 수 있습니다.
  시각적으로는 이어져 보이지만 path 개수는 실제 가닥 수보다 많게 잡힙니다.
- 얇은 선과 로고/솔 영역을 구분할 때 두께·위치 기반 휴리스틱을 사용하므로, 형태가
  일반적이지 않은 이미지에서는 경계 사례가 잘못 분류될 수 있습니다.
- 사람 얼굴, 풍경 사진처럼 색과 디테일이 매우 많은 사진은 완벽한 벡터화가 어렵습니다.
