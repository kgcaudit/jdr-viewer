# JDR Viewer

IROAD 블랙박스 `.jdr` 파일을 **안드로이드 폰에서 직접** 열어보기 위한 프로젝트입니다.

현재 상태: **설계·기술 검토 단계** (앱 코드 착수 전)

## 배경

PC용 Python CLI 추출 도구(`reference/jdr_extractor_tool/`)가 먼저 만들어졌고,
이것을 안드로이드 앱으로 옮기는 것이 목표입니다.

추출 대상: 전/후방 H.264 영상, PCM 음성, GPS, G센서, 파일 SHA-256

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/00-jdr-format-spec.md`](docs/00-jdr-format-spec.md) | JDR 바이너리 포맷 사양 (역분석 정리, 구현 기준) |
| [`docs/01-android-knowledge.md`](docs/01-android-knowledge.md) | **안드로이드 앱 제작에 필요한 지식 검토** |
| [`docs/02-roadmap.md`](docs/02-roadmap.md) | 안드로이드 단계별 개발 로드맵 |
| [`docs/03-web-app-feasibility.md`](docs/03-web-app-feasibility.md) | **반응형 웹으로 만들 수 있는가 — 타당성 검토** |

## 핵심 결론 요약

- **가장 어려운 부분은 영상 재생**입니다. JDR에서 나오는 것은 컨테이너 없는
  raw H.264 Annex-B이고, 안드로이드에는 ffmpeg가 없어 `MediaCodec`을 직접 제어해야 합니다.
- 다행히 **JDR 패킷마다 정확한 타임스탬프와 12바이트 인덱스 테이블**이 있어서,
  프레임 단위 공급과 I-프레임 시크를 깔끔하게 구현할 수 있습니다.
- **반응형 웹도 가능하며, 오히려 더 유리합니다.** WebCodecs가 Annex-B를
  네이티브 지원해서 안드로이드 최난이도 문제가 사라지고, iOS까지 한 번에 커버됩니다.
  → [`docs/03-web-app-feasibility.md`](docs/03-web-app-feasibility.md)
- **파서 로직은 UI·플랫폼과 분리**해서 작성합니다. 웹(TypeScript)이든
  안드로이드(Kotlin)든 재사용할 수 있어야 합니다.

## 플랫폼 선택 (검토 결과)

| | 안드로이드 네이티브 | 반응형 웹 |
|---|---|---|
| raw H.264 재생 | `MediaCodec` + SPS 직접 파싱 (난이도 상) | **WebCodecs, `description` 생략 = Annex-B** |
| 지원 기기 | 안드로이드만 | 안드로이드 + iOS + PC |
| 배포 | Play 심사·정책·서명 | URL 하나 |
| 이 저장소 환경에서 빌드 | ❌ (Android SDK 없음, google maven 차단) | ✅ (Node 22 + npm 사용 가능) |

→ **웹 우선 개발을 권장**합니다. 상세 근거는 `docs/03-web-app-feasibility.md` 12장.

## 면책

이 프로젝트의 JDR 포맷 해석은 샘플 파일 1개에 대한 **역분석 추정**이며,
제조사 공식 사양이 아닙니다. 다른 기종·펌웨어의 JDR은 구조가 다를 수 있습니다.
GPS 속도, G센서 스케일 등 일부 값은 추정치이므로 법적·감정 용도로 사용할 경우
제조사 사양 확인 또는 추가 샘플 검증이 필요합니다.

## 참고 도구 (PC용)

`reference/jdr_extractor_tool/` — 원본 Python 추출 도구.
사용법은 해당 폴더의 `README_KO.txt`를 참고하세요.
