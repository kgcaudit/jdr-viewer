# 반응형 웹 앱으로 제작 가능한가? — 타당성 검토

> 질문: "브라우저에서 반응형 웹으로 만들 수 있나?"
> **결론: 가능합니다. 그리고 여러 면에서 안드로이드 네이티브보다 유리합니다.**
> 조사 기준일: 2026-09-13

---

## 1. 결론 먼저

| 기능 | 웹에서 가능한가 | 비고 |
|---|---|---|
| JDR 파일 읽기 (수 GB) | ✅ | `File.slice()` — 랜덤 액세스가 공짜 |
| 바이너리 파싱 | ✅ | `DataView` — **Python 코드와 거의 1:1** |
| **raw H.264 재생** | ✅ | **WebCodecs가 Annex-B를 네이티브 지원** |
| PCM 8kHz 음성 재생 | ✅ | Web Audio API |
| A/V 동기 | ✅ | `AudioContext.currentTime` 마스터 클럭 |
| MP4 내보내기 | ✅ | Mediabunny 등 JS 먹서 |
| CSV / WAV 내보내기 | ✅ | Blob 다운로드 |
| GPS 지도 | ✅ | Leaflet / MapLibre GL JS |
| G센서 차트 | ✅ | uPlot |
| SHA-256 | ✅ | Web Crypto API |
| 오프라인 동작 | ✅ | PWA + Service Worker |
| 설치형 앱처럼 쓰기 | ✅ | PWA "홈 화면에 추가" |

**가장 중요한 발견**: 안드로이드에서 최난이도였던 **raw H.264 Annex-B 재생이 웹에서는 오히려 쉽습니다.**

---

## 2. 안드로이드 네이티브 vs 반응형 웹

| 항목 | 안드로이드 네이티브 | 반응형 웹 |
|---|---|---|
| **H.264 Annex-B 재생** | `MediaCodec`에 SPS/PPS를 직접 파싱해 `csd-0/csd-1`로 주입 | **`description`을 생략하면 Annex-B 모드**. SPS 파싱 불필요 |
| **키프레임 판별** | 비트스트림에서 NAL type 5를 직접 찾아야 함 | `EncodedVideoChunk`의 `type: 'key'` — **JDR 태그(`00VI`/`00VP`)를 그대로 매핑** |
| 부호 없는 32비트 정수 | Kotlin `Int`가 부호 있음 → 마스킹 필요 | `getUint32()` 가 그대로 있음 — **함정 없음** |
| 파일 접근 | SAF, `openFileDescriptor`, 영구 권한 | `<input type="file">` 한 줄 |
| 배포 | Play 심사, targetSdk 정책, .aab 서명 | **URL 하나. 심사 없음** |
| 지원 기기 | 안드로이드만 | **안드로이드 + iOS + PC + 태블릿 전부** |
| 업데이트 | 스토어 경유, 사용자 수동 업데이트 | 새로고침하면 끝 |
| 하드웨어 가속 | 확실함 | WebCodecs가 대부분 하드웨어 사용 |
| 파일 시스템 쓰기 | 자유로움(SAF) | **다운로드만 가능** (Safari/Firefox) |
| 백그라운드 장시간 작업 | WorkManager | 탭이 살아있어야 함 |
| 오래된 기기 | 잘 동작 | **브라우저 버전 의존** (5장) |

---

## 3. 파일 읽기 — 웹이 더 간단합니다

### 핵심: `Blob.slice()` 는 지연 로딩입니다

```js
const file = input.files[0];               // 3GB짜리여도 메모리에 안 올라감
const buf  = await file.slice(off, off+n).arrayBuffer();  // 필요한 구간만 읽음
```

`File`은 `Blob`이고, `slice()`는 **실제로 읽지 않고 범위만 잡는** 연산입니다.
안드로이드에서 `openFileDescriptor` + `FileChannel`로 해야 했던 랜덤 액세스가
웹에서는 기본 제공됩니다. Python의 `mmap`에 가장 가까운 감각입니다.

### 파일 선택 방식

| 방식 | 지원 | 용도 |
|---|---|---|
| **`<input type="file">`** | **모든 브라우저** | 기본 경로 ✅ |
| 드래그 앤 드롭 | 모든 데스크톱 브라우저 | 편의 기능 |
| `showOpenFilePicker()` (File System Access API) | **Chromium 전용** (Firefox·Safari 미지원) | 점진적 향상으로만 사용 |
| OPFS (Origin Private File System) | Chrome/Firefox/Safari 15.2+ | 파싱 결과 캐시용 |

→ **`<input type="file">`를 기본으로 하고, File System Access API는 있으면 쓰는 보너스**로 취급합니다.
Firefox는 로컬 디스크 피커에 대해 반대 입장을 공식 표명했으므로 앞으로도 기대하면 안 됩니다.

---

## 4. 바이너리 파싱 — Python과 가장 비슷합니다

```js
const dv = new DataView(buf);
const count       = dv.getUint32(0x04, true);   // true = little-endian
const indexOffset = dv.getUint32(0xB8, true);
const sentinel    = dv.getUint32(0x1FC, true);  // === 0x200 이어야 유효
```

- **`getUint32`가 부호 없는 값을 그대로 반환** → 안드로이드의 최대 함정이 사라집니다
- JS `Number`는 2^53까지 정수를 정확히 표현 → 수 GB 오프셋도 안전
- SYSTEMTIME: `getUint16` × 8 → `new Date(y, m-1, d, h, mi, s, ms)`
  (3번째 `dayOfWeek`는 버림. JS `Date`는 월이 0-based인 점만 주의)

### 반드시 Web Worker에서

수십만 패킷 파싱이 메인 스레드를 막으면 UI가 멈춥니다.

```
main thread ──postMessage(file)──► worker (파싱)
            ◄──진행률/결과(Transferable)──
```
`ArrayBuffer`를 **Transferable**로 넘기면 복사 없이 이동합니다.

### 메모리 전략 (안드로이드와 동일한 원칙)

패킷을 객체 배열로 담지 말고 **TypedArray 구조 배열(SoA)** 로:

```js
const offsets = new Float64Array(n);  // 2^53까지 안전
const sizes   = new Uint32Array(n);
const tags    = new Uint32Array(n);   // 4바이트 ASCII 패킹
const timesMs = new Float64Array(n);
```
패킷 50만 개 ≈ 12MB. 객체 배열로 하면 수백 MB입니다.

---

## 5. 영상 재생 — WebCodecs (여기가 핵심)

### 왜 웹이 더 쉬운가

W3C AVC WebCodecs 등록 명세에 따르면,
**`VideoDecoderConfig.description`을 생략하면 Annex-B 형식으로 간주**됩니다.

즉 안드로이드에서 해야 했던 "SPS 파싱 → exp-Golomb 디코딩 → csd-0/csd-1 구성"이
**전부 필요 없습니다.** JDR 페이로드를 그대로 넣으면 됩니다.

```js
const decoder = new VideoDecoder({
  output: frame => { ctx.drawImage(frame, 0, 0); frame.close(); },
  error: e => console.error(e),
});

decoder.configure({
  codec: 'avc1.42E01E',     // Baseline L3.0 (실제 프로파일은 SPS에 맞춰 조정)
  optimizeForLatency: true,
  // description 없음 → Annex-B 모드
});

// JDR 태그가 키프레임 여부를 이미 알려줌!
decoder.decode(new EncodedVideoChunk({
  type: tag === '00VI' ? 'key' : 'delta',
  timestamp: ptsMicros,
  data: payload,
}));
```

### JDR과 WebCodecs의 궁합이 특히 좋은 이유

| WebCodecs가 요구하는 것 | JDR이 이미 갖고 있는 것 |
|---|---|
| 청크별 `key`/`delta` 구분 | 태그 `00VI` / `00VP` ✅ |
| 청크별 `timestamp` (마이크로초) | 패킷별 SYSTEMTIME ✅ |
| 프레임 경계로 나뉜 청크 | 패킷 = 프레임 ✅ |
| 시크 시 키프레임부터 재공급 | 12바이트 인덱스 테이블 ✅ |

**보통은 컨테이너를 파싱해서 얻어야 하는 정보를 JDR이 전부 갖고 있습니다.**

### ⚠️ 반드시 확인해야 할 한 가지

Annex-B 모드에서 **`type: 'key'` 청크는 IDR 픽처와 함께 그 프레임을 디코딩하는 데
필요한 모든 파라미터 세트(SPS/PPS)를 포함해야 합니다.**

블랙박스는 보통 I-프레임 패킷에 `SPS + PPS + IDR`을 함께 넣지만,
**JDR이 그런지는 실제 `00VI` 패킷의 앞부분 바이트를 확인해야 합니다.**

- SPS/PPS가 들어있다 → 그대로 넣으면 끝
- 없다 → 첫 등장 SPS/PPS를 기억했다가 **매 키프레임 청크 앞에 붙여서** 넣으면 됩니다

> 이것이 웹 버전 착수 시 **가장 먼저 검증할 항목**입니다.
> (샘플 JDR의 첫 `00VI` 페이로드 hex 덤프 확인)

### 렌더링

- `VideoFrame` → `<canvas>` (`drawImage`) 또는 WebGL/WebGPU
- **`frame.close()`를 반드시 호출**해야 합니다. 안 하면 GPU 메모리가 금방 고갈됩니다
- 전/후방 2채널 = `VideoDecoder` 인스턴스 2개 + 캔버스 2개

---

## 6. 오디오와 A/V 동기 — 웹이 더 깔끔합니다

```js
const ac = new AudioContext({ sampleRate: 8000 });
// PCM s16le → Float32 (/32768) → AudioBuffer → AudioBufferSourceNode
```

- 8kHz 모노 PCM을 그대로 넣을 수 있습니다
- **`AudioContext.currentTime` 이 정밀한 마스터 클럭**이라
  안드로이드에서 `playbackHeadPosition`으로 계산하던 것보다 단순합니다
- 영상 프레임은 이 시각에 맞춰 캔버스에 그립니다

주의: 안드로이드 편과 동일하게, **오디오 패킷이 끊긴 구간은 무음을 채워야**
영상과 어긋나지 않습니다.

브라우저 정책상 **사용자 제스처 이후에만 `AudioContext`가 시작**되므로
"재생" 버튼 클릭 시 `ac.resume()`을 호출해야 합니다.

---

## 7. 내보내기

| 결과물 | 방법 |
|---|---|
| `.h264` / `.wav` / `.csv` | `Blob` + `URL.createObjectURL` 다운로드 — 간단 |
| **`.mp4`** | **Mediabunny** (구 `mp4-muxer`의 후속, 더 빠르고 기능 많음) 또는 `mp4box.js` |
| MP4용 AAC 음성 | `AudioEncoder` (WebCodecs) — Safari는 26.0부터 오디오까지 완전 지원 |
| SHA-256 | `crypto.subtle.digest` — 단, 스트리밍 API가 없어 **대용량은 청크 해싱 라이브러리 필요** |

- WebCodecs는 **코덱만 제공하고 컨테이너 먹싱은 안 해줍니다** → 먹서 라이브러리 필수
- 매우 큰 MP4는 메모리에 다 못 담으므로 **File System Access API의 쓰기 스트림(Chromium)**
  또는 OPFS에 조각으로 쓰는 전략이 필요합니다
- `ffmpeg.wasm`도 가능하지만 **수십 MB 다운로드 + 느림** → 권장하지 않습니다

---

## 8. 지도 · 차트

| 용도 | 선택 | 비고 |
|---|---|---|
| 지도 | **Leaflet** (가볍고 간단) 또는 **MapLibre GL JS** (벡터, 고급) | 둘 다 무료·API 키 불필요. OSM 타일 |
| 차트 | **uPlot** | 수만 포인트 시계열에 특화. Chart.js는 대량 데이터에서 느림 |

GPS 유효성 필터(위/경도 0 제외)는 안드로이드 편과 동일하게 필요합니다.

---

## 9. 반응형 + PWA

### 반응형 레이아웃

```
데스크톱  : 영상 2채널 나란히 | 지도 | 차트  (3분할)
태블릿    : 영상 위 / 지도·차트 아래       (2분할)
모바일 세로: 영상 → 탭으로 지도/차트 전환
모바일 가로: 영상 전체화면 + 오버레이
```
- CSS Grid + **컨테이너 쿼리**
- 캔버스는 `aspect-ratio: 16/9` + `width: 100%`
- 터치 타깃 44px 이상, `env(safe-area-inset-*)` 로 노치 대응

### PWA로 만들면 네이티브에 근접합니다

- **Service Worker** → 앱 자체를 캐시해서 **완전 오프라인 동작**
- **manifest.json** → "홈 화면에 추가", 전체화면 실행, 아이콘
- iOS Safari도 홈 화면 추가를 지원합니다

### 개인정보 측면에서 웹이 오히려 유리합니다

파일은 **브라우저 안에서만 처리되고 서버로 절대 올라가지 않습니다.**
정적 호스팅(서버 로직 없음)이면 "업로드 없음"을 구조적으로 보장할 수 있어,
사고 영상·위치 같은 민감 데이터에 대해 **네이티브 앱보다 설명하기 쉽습니다.**

---

## 10. 브라우저 지원 현실 (2026-09 기준)

| 브라우저 | WebCodecs | 판정 |
|---|---|---|
| Chrome / Edge / Opera 94+ | ✅ 완전 | 주 타깃 |
| Firefox 130+ (데스크톱) | ✅ 완전 | 지원 |
| **Firefox Android** | ❌ **미지원** | 폴백 필요 |
| Safari 26.0+ (macOS/iOS/iPadOS) | ✅ 완전 | **iOS도 됩니다** |
| Safari 16.4 ~ 25 | ⚠️ 부분 (영상 위주, 오디오 미지원이었음) | 우리는 음성이 raw PCM(Web Audio)이라 **영상만 되면 충분할 가능성** → 실측 필요 |
| Safari 16.3 이하 | ❌ | 폴백 |
| Samsung Internet 17+ | ✅ | 지원 |

### 폴백 전략

```js
if (!('VideoDecoder' in window)) { /* 영상 재생 비활성화 */ }
```
WebCodecs가 없어도 **요약·GPS·G센서·CSV 내보내기는 전부 동작**하게 설계합니다.
영상은 "이 브라우저에서는 재생할 수 없습니다. 최신 Chrome/Safari를 쓰거나
MP4로 내보낸 뒤 보세요"로 안내 — 기능 전체가 죽지 않습니다.

---

## 11. 웹의 한계 (정직하게)

| 한계 | 영향 | 완화 |
|---|---|---|
| 브라우저 버전 의존 | 구형 기기에서 영상 재생 불가 | 기능 감지 + 폴백 |
| iOS 메모리 제한이 엄격 | 대용량 파일에서 탭 강제 종료 가능 | 스트리밍 읽기 철저, 전체 적재 금지 |
| 파일 쓰기 = 다운로드뿐 (Safari/FF) | 큰 MP4 내보내기 시 메모리 압박 | 조각 쓰기, Chromium은 스트림 쓰기 |
| 탭을 닫으면 작업 중단 | 긴 변환 작업 | 진행률 표시 + 재개 가능 설계 |
| 스토어 노출 없음 | 발견 가능성 | PWA 설치 유도, 필요 시 나중에 래핑 |
| 하드웨어 코덱 접근이 네이티브보다 제한적 | 2채널 동시 디코딩 부하 | 한 채널씩 또는 해상도 낮춰 미리보기 |

---

## 12. 권고

**웹을 먼저 만드는 것을 권합니다.**

근거:
1. **가장 어려웠던 영상 재생이 웹에서 더 쉽습니다** (Annex-B 네이티브 지원)
2. **iOS까지 한 번에 커버**됩니다 — 안드로이드 앱은 아이폰 사용자를 버립니다
3. 심사·서명·정책(targetSdk 36 등) 부담이 전부 사라집니다
4. **이 개발 환경에서 지금 바로 만들 수 있습니다** (13장)
5. 나중에 네이티브가 정말 필요해지면, 검증된 파싱·재생 로직을
   Capacitor/TWA로 감싸거나 Kotlin으로 포팅하면 됩니다

단, **파서 로직은 UI와 완전히 분리**해서 작성합니다.
그래야 나중에 안드로이드로 가든, 웹에 남든 재사용할 수 있습니다.

### 제안 스택

| 영역 | 선택 |
|---|---|
| 언어 | **TypeScript** (바이너리 오프셋 다루는 코드에 타입이 큰 도움) |
| 빌드 | **Vite** |
| UI | 정하기 나름 — React / Svelte / 바닐라 모두 가능 |
| 파싱 | 의존성 없는 순수 TS + Web Worker |
| 영상 | WebCodecs + Canvas |
| 음성 | Web Audio API |
| 먹싱 | Mediabunny |
| 지도 | Leaflet |
| 차트 | uPlot |
| 배포 | 정적 호스팅 (GitHub Pages 등) + PWA |

---

## 13. 개발 환경 — 웹은 여기서 바로 됩니다

| 항목 | 상태 |
|---|---|
| Node.js 22.22.2 | ✅ |
| npm 10.9.7 / pnpm 10.33.0 / bun 1.3.11 | ✅ |
| **npm 레지스트리 접근** | ✅ **HTTP 200** |
| (비교) Android SDK | ❌ 없음 |
| (비교) `dl.google.com` | ❌ 차단됨 (403) |

**안드로이드는 이 환경에서 빌드할 수 없지만, 웹은 바로 개발·빌드·테스트가 가능합니다.**
실제 재생 확인만 브라우저에서 하면 됩니다.

---

## 14. 참고 자료

- [AVC (H.264) WebCodecs Registration — W3C](https://www.w3.org/TR/webcodecs-avc-codec-registration/) — Annex-B / avcC 구분
- [Video processing with WebCodecs — Chrome for Developers](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)
- [Codec selection — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection)
- [WebCodecs 브라우저 지원 현황](https://www.testmuai.com/learning-hub/webcodecs-browser-support/)
- [Muxing and Demuxing — WebCodecs Fundamentals](https://webcodecsfundamentals.org/basics/muxing/)
- [mp4-muxer (→ Mediabunny로 이관)](https://github.com/Vanilagy/mp4-muxer)
- [File System API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [File System Access API 브라우저 지원](https://www.testmuai.com/learning-hub/file-system-access-api-browser-support/)
- [Origin Private File System — MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
