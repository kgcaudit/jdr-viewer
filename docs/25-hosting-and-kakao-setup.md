# 25. 호스팅 + 카카오(지도·도로명 주소) 켜기

카카오 지도와 도로명 주소(coord2Address)는 **등록한 http(s) 도메인에서만** 동작한다
(`file://` 은 안 됨). 이 앱을 한 번 호스팅하고 그 도메인을 카카오 콘솔에 등록하면
지도·주소가 자동으로 카카오(도로명)로 전환된다. 안 하면 그대로 OSM 으로 동작한다.

개인정보: 호스팅해도 원칙은 그대로다 — 서버에 올라가는 건 **빈 뷰어 껍데기(HTML)**
뿐이고, JDR·GPS 파일은 여전히 브라우저에서만 처리되고 업로드되지 않는다.

## 1) GitHub Pages 로 배포 (턴키)

1. 저장소 **Settings → Pages → Source** 를 **"GitHub Actions"** 로 설정(한 번만).
2. 배포 실행:
   - `main` 에 병합하면 자동 배포, 또는
   - **Actions 탭 → "Deploy to GitHub Pages" → Run workflow** 로 원하는 브랜치를 골라
     수동 실행(병합 전 미리 확인용).
3. 배포 후 사이트 주소: **`https://kgcaudit.github.io/jdr-viewer/`**
   (워크플로 `deploy` 단계의 URL 로도 확인 가능)

> 사내 서버 등 다른 호스팅도 됨 — http(s)로 서빙되고 그 도메인을 카카오에 등록하면 된다.

## 2) 카카오 콘솔에 도메인 등록

1. 카카오 개발자센터(https://developers.kakao.com) → **내 애플리케이션** → 해당 앱
   (JS 키 `e1c60a…` 가 이 앱 것)
2. **앱 설정 → 플랫폼 → Web → 사이트 도메인**에 배포 주소의 **오리진**을 추가:
   ```
   https://kgcaudit.github.io
   ```
   (경로 `/jdr-viewer/` 는 빼고 오리진만. 반영에 몇 분 걸릴 수 있음)
3. 지도·주소 둘 다 이 **JavaScript 키 하나**로 동작한다(추가 키·서버 불필요).
   `libraries=services` 로 좌표→주소(coord2Address)까지 같은 SDK 가 처리 → CORS 문제 없음.

## 3) 폰에서 열기

- 폰 브라우저로 **`https://kgcaudit.github.io/jdr-viewer/`** 를 연다(파일 열기 아님).
- 지도는 **카카오**, 머문 곳 주소는 **도로명(없으면 지번)** 으로 자동 채워진다.
- 강제 전환이 필요하면 주소 끝에 `?map=kakao` 또는 `?map=osm` 을 붙인다.

## 동작 요약

| 여는 방식 | 지도 | 체류 주소 |
|---|---|---|
| 등록 도메인 http(s) (호스팅) | **카카오** | **카카오 도로명/지번** |
| `file://` · localhost · 미등록 · 오프라인 | OSM | OSM |

코드: 자격 판정은 `web/src/ui/kakao.ts`의 `eligible()`, 주소 제공자 주입은
`main.ts`(`setPreferredProvider`)+`core/geocode.ts`. 카카오가 준비되면 주소는 카카오,
아니면 OSM(초당 1회, 캐시)로 자동 폴백한다.
