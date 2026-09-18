# Movement Analysis System <sub>(구 JDR Viewer)</sub>

IROAD 블랙박스 `.jdr` 영상과 휴대폰 위치기록을 **브라우저에서 바로** 열어,
날짜별 동선을 재구성하고 둘을 대조하는 **감사용 단일 HTML 도구**입니다.

- 라이브: <https://kgcaudit.github.io/jdr-viewer/>
- 파일은 **서버로 전송되지 않고** 전부 브라우저 안에서 처리됩니다.
  (호스팅되는 것은 데이터 없는 **앱 껍데기 HTML** 뿐입니다.)

## 무엇을 하나

화면은 두 공간으로 나뉩니다.

- **블랙박스** — `.jdr` 파일/폴더를 열어 전·후방 영상·GPS·G센서를 **기록 시각 순**으로 재생.
  월간 달력 → 운행 단위 분리, 파일 병합 재생, 지도·센서 차트, 말한 구간 색인,
  즐겨찾기, 내보내기(CSV·WAV·MP4).
- **이동기록** — 휴대폰 위치기록(도와줘 앱 내보내기)을 올려 날짜별 동선을 관리하고,
  블랙박스 차량 GPS와 대조해 **주행 / 이 차량 주행 / 보행 / 체류**를 가립니다.
  머문 곳(체류)에 상호명·주소를 붙이고(카카오 장소검색·OSM), 여러 날짜를 한 번에 요약.

## 배경 / 현재 상태

PC용 Python 추출 도구(`reference/`)에서 출발해, 브라우저 뷰어 → **동선 분석 감사 도구**로
확장했습니다. **현재 상태: GitHub Pages에 배포된 동작하는 웹 앱**이며, 파서는 UI·플랫폼과
분리해 두어(안드로이드 네이티브 포팅 대비) 로직을 그대로 옮길 수 있습니다.

추출 대상: 전/후방 H.264 영상, PCM 음성, GPS, G센서, 파일 SHA-256.

## 개인정보

- JDR·GPS 원본은 업로드되지 않고 **브라우저 안에서만** 처리·저장(IndexedDB)됩니다.
- 밖으로 나가는 것은 리버스 지오코딩(좌표 → 주소·상호명) 요청뿐이며, 지도 제공자
  (카카오/OpenStreetMap)로 **체류 좌표만** 갑니다. 좌표별 캐시로 같은 자리는 한 번만 조회합니다.
- GitHub Pages에 올라가는 것은 **데이터가 들어 있지 않은 앱 껍데기(HTML)** 입니다.

## 빠른 시작

```bash
cd web
npm install
npm run dev            # http://127.0.0.1:5173
npm run build:single   # dist-single/index.html — 파일 하나로 끝(더블클릭)
```

**배포:** 기본 브랜치에 push하면 `.github/workflows/deploy-pages.yml`가 단일 HTML을
빌드해 GitHub Pages로 자동 배포합니다. (새 코드는 **탭을 새로고침**해야 반영됩니다 —
`?v=숫자`를 붙이면 캐시를 무시합니다.)

자세한 실행·기능·구조·성능은 [`web/README.md`](web/README.md)를 보세요.

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/00-jdr-format-spec.md`](docs/00-jdr-format-spec.md) | JDR 바이너리 포맷 사양 (역분석 정리, 구현 기준) |
| [`docs/01-android-knowledge.md`](docs/01-android-knowledge.md) | 안드로이드 앱 제작에 필요한 지식 검토 |
| [`docs/03-web-app-feasibility.md`](docs/03-web-app-feasibility.md) | 반응형 웹 타당성 검토 (WebCodecs) |
| [`docs/04-prototype-status.md`](docs/04-prototype-status.md) | 프로토타입 현황 — 검증된 것과 안 된 것 |
| [`docs/22-movement-space-plan.md`](docs/22-movement-space-plan.md) | **이동기록 공간 — 휴대폰 GPS 대조 설계** |
| [`docs/24-stays-and-kakao-map.md`](docs/24-stays-and-kakao-map.md) | 머문 곳(체류) 도출 · 카카오 지도 |
| [`docs/25-hosting-and-kakao-setup.md`](docs/25-hosting-and-kakao-setup.md) | GitHub Pages 호스팅 · 카카오 키/도메인 설정 |
| [`web/README.md`](web/README.md) | **웹 앱 실행 방법 · 전체 기능 · 구조 · 성능** |

`docs/`에는 이 밖에도 기능별 설계·진단 메모(05–23)가 순서대로 쌓여 있습니다.

## 핵심 결론 (플랫폼)

- **가장 어려운 부분은 영상 재생**입니다. JDR에서 나오는 것은 컨테이너 없는 raw
  H.264 Annex-B이고, 안드로이드에는 ffmpeg가 없어 `MediaCodec`을 직접 제어해야 합니다.
- **반응형 웹이 오히려 유리합니다.** WebCodecs가 Annex-B를 네이티브 지원해 최난이도
  문제가 사라지고, iOS까지 한 번에 커버됩니다. → [`docs/03-web-app-feasibility.md`](docs/03-web-app-feasibility.md)
- **파서 로직은 UI·플랫폼과 분리**(`web/src/core/`)해, 웹(TypeScript)이든 안드로이드(Kotlin)든
  재사용할 수 있게 두었습니다.

| | 안드로이드 네이티브 | 반응형 웹 (채택) |
|---|---|---|
| raw H.264 재생 | `MediaCodec` + SPS 직접 파싱 (난이도 상) | **WebCodecs, `description` 생략 = Annex-B** |
| 지원 기기 | 안드로이드만 | 안드로이드 + iOS + PC |
| 배포 | Play 심사·정책·서명 | **URL 하나 (GitHub Pages)** |

## 면책

- JDR 포맷 해석은 샘플에 대한 **역분석 추정**이며 제조사 공식 사양이 아닙니다.
  다른 기종·펌웨어의 JDR은 구조가 다를 수 있습니다.
- GPS 속도, G센서 스케일(raw ÷ 1024 ≈ g) 등 일부 값은 **추정치**입니다.
- 원본성 판단의 기준은 **원본 JDR 파일과 SHA-256**이며, 내보낸 결과물은 파생물입니다.
- 동선 분류(주행·보행·체류·이 차량 주행)는 GPS 근접·속도 기반 **판정 보조 자료**이며,
  법적·감정 용도로는 원본 확인이 필요합니다.

## 참고 도구 (PC용)

`reference/jdr_extractor_tool/` — 원본 Python 추출 도구.
사용법은 해당 폴더의 `README_KO.txt`를 참고하세요.
