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
| [`docs/02-roadmap.md`](docs/02-roadmap.md) | 단계별 개발 로드맵 |

## 핵심 결론 요약

- **가장 어려운 부분은 영상 재생**입니다. JDR에서 나오는 것은 컨테이너 없는
  raw H.264 Annex-B이고, 안드로이드에는 ffmpeg가 없어 `MediaCodec`을 직접 제어해야 합니다.
- 다행히 **JDR 패킷마다 정확한 타임스탬프와 12바이트 인덱스 테이블**이 있어서,
  프레임 단위 공급과 I-프레임 시크를 깔끔하게 구현할 수 있습니다.
- MVP는 `MediaMuxer`로 **MP4 변환 후 재생**하는 안전한 경로로 시작하고,
  이후 `MediaCodec` 직접 재생으로 넘어가는 2단계 전략을 권장합니다.
- **파서는 안드로이드 의존성 없이** 순수 Kotlin으로 먼저 만들 수 있습니다.

## 면책

이 프로젝트의 JDR 포맷 해석은 샘플 파일 1개에 대한 **역분석 추정**이며,
제조사 공식 사양이 아닙니다. 다른 기종·펌웨어의 JDR은 구조가 다를 수 있습니다.
GPS 속도, G센서 스케일 등 일부 값은 추정치이므로 법적·감정 용도로 사용할 경우
제조사 사양 확인 또는 추가 샘플 검증이 필요합니다.

## 참고 도구 (PC용)

`reference/jdr_extractor_tool/` — 원본 Python 추출 도구.
사용법은 해당 폴더의 `README_KO.txt`를 참고하세요.
