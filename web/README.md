# JDR Viewer — 웹 프로토타입

IROAD 블랙박스 `.jdr` 파일을 **브라우저에서 바로** 열어보는 뷰어입니다.
파일은 **서버로 전송되지 않고** 전부 브라우저 안에서 처리됩니다.

## 실행

```bash
cd web
npm install
npm run dev        # http://127.0.0.1:5173
```

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` | 정적 빌드 (`dist/`) — 아무 정적 호스팅에나 올리면 됨 |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 파서 유닛 테스트 (vitest, 22개) |
| `npm run test:e2e` | 브라우저 E2E 테스트 (Playwright, 8개) |

## 구현된 기능

- **파일 열기** — `<input type="file">` + 드래그 앤 드롭. `File.slice()`로 필요한 구간만 읽어 수 GB 파일도 메모리에 올리지 않음
- **파싱** — Web Worker에서 진행률과 함께. JEB 블록 탐색, 패킷 순차 파싱, 12바이트 인덱스 대조
- **무결성** — 스트리밍 SHA-256, 인덱스 불일치 건수 표시
- **영상 재생** — WebCodecs `VideoDecoder`로 전/후방 2채널. 변환 없이 바로 재생
- **음성** — Web Audio로 PCM 8kHz 재생. `AudioContext.currentTime`이 A/V 마스터 클럭
- **시크** — I-프레임(`00VI`) 인덱스 기반. 프레임 단위 이동, 0.5~4배속
- **지도** — Leaflet + OSM. 경로 폴리라인 + 재생 위치 마커 동기화
- **차트** — uPlot 속도/G센서 3축. 재생 위치 커서 동기화
- **내보내기** — 요약 JSON, GPS·G센서·패킷 CSV, WAV, H.264 Annex-B
- **반응형** — 데스크톱 2열 / 모바일 1열 + 탭. 다크 모드

## 구조

```
src/core/      플랫폼 독립 파서 (DOM 의존 없음 → 안드로이드 포팅 시 그대로 번역 가능)
  byte-source  ByteSource 추상화 (Blob / ArrayBuffer) + WindowReader
  parser       JEB 블록·패킷·GPS·G센서 파싱
  nal          H.264 Annex-B NAL 스캔 + SPS 파싱 (해상도/코덱 문자열)
  sha256       스트리밍 SHA-256 (crypto.subtle은 대용량에 못 씀)
  export       CSV / WAV / JSON 생성
src/worker/    파싱 워커
src/player/    WebCodecs 디코더, Web Audio, 재생 엔진
src/ui/        요약·지도·차트·내보내기 패널
```

## 알아둘 점

### 브라우저 지원

| 브라우저 | 영상 재생 |
|---|---|
| Chrome / Edge / Opera 94+ | ✅ |
| Safari 26.0+ (macOS·iOS·iPadOS) | ✅ |
| Firefox 130+ (데스크톱) | ✅ |
| Firefox Android | ❌ WebCodecs 미지원 |

WebCodecs가 없어도 **요약·GPS·센서·내보내기는 전부 동작**합니다. 영상만 비활성화됩니다.

### 코덱 수동 지정

코덱 자동 판별(SPS 파싱)이 실패하는 JDR 변형을 위해 쿼리 파라미터를 지원합니다.

```
?codec=avc1.4D401E
```

### 아직 안 한 것

- **MP4 내보내기** — Mediabunny 등 JS 먹서 + `AudioEncoder`(AAC) 필요
- **PWA** — Service Worker / manifest (오프라인·홈 화면 추가)
- **충격 이벤트 자동 검출** — 합성 가속도 임계값 기반 점프
- 파싱이 파일을 두 번 읽음 (해시+스캔 1회, 패킷 헤더 1회). 블록 체인을 따라가는 방식으로 줄일 수 있음

## 면책

JDR 포맷 해석은 샘플 1개에 대한 **역분석 추정**이며 제조사 공식 사양이 아닙니다.
GPS 속도, G센서 스케일(raw ÷ 1024 ≈ g)은 추정값입니다.
원본성 판단의 기준은 **원본 JDR 파일과 SHA-256**이며, 내보낸 결과물은 파생물입니다.
