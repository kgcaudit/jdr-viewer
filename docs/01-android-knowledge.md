# 안드로이드 앱 제작에 필요한 지식 검토

> 목표: `reference/jdr_extractor_tool/jdr_extractor.py`(Windows/Python CLI)의 기능을
> **안드로이드 앱(JDR Viewer)** 으로 옮기기 위해 필요한 기술 지식을 정리합니다.
> 각 항목은 "무엇이 필요한가 → 왜 어려운가 → 어떤 선택지가 있고 무엇을 고르는가" 순서입니다.
> 조사 기준일: 2026-09-13

---

## 0. 요약: 이 앱의 진짜 난이도는 어디에 있나

Python CLI를 그대로 옮기는 게 아니라, **모바일에서만 생기는 4가지 제약**이 실제 작업량입니다.

| 영역 | Python(PC) | 안드로이드 | 난이도 |
|---|---|---|---|
| 파일 읽기 | 경로로 그냥 open + mmap | **Scoped Storage** → SAF URI, 직접 경로 없음 | 중 |
| 영상 재생 | ffmpeg에 통째로 맡김 | **ffmpeg 없음** → MediaCodec 직접 제어 | **상 (최난이도)** |
| 메모리 | 수 GB 자유롭게 | 앱 힙 수백 MB 제한, 패킷 수십만 개 | 중상 |
| 결과물 | 폴더에 파일 저장 | SAF/MediaStore, 백그라운드 작업 제약 | 중 |

**영상 재생(5장)이 이 프로젝트의 핵심 리스크**이며, 나머지는 정형화된 작업입니다.

---

## 1. 만들 앱의 정의

| 항목 | 내용 |
|---|---|
| 이름 | JDR Viewer (IROAD 블랙박스 JDR 뷰어) |
| 목적 | PC·전용 뷰어 없이 **폰에서 바로** JDR을 열어 영상/음성/GPS/G센서를 확인, 필요 시 MP4·CSV로 내보내기 |
| 주 사용자 | 사고 직후 현장에서 확인해야 하는 운전자, 감사/증거 검토자 |
| 온라인 | **전부 오프라인 동작**이 기본 (지도 타일만 선택적 온라인) |
| 개인정보 | 영상·위치가 모두 개인정보 → **외부 전송 없음**이 기본 원칙 |

### 화면 구성(초안)

1. **파일 선택** — SAF로 `.jdr` 열기, 최근 파일 목록
2. **분석 요약** — SHA-256, 블록/패킷 수, 시간 범위, 태그 통계, 인덱스 불일치
3. **플레이어** — 전/후방 2채널 영상 + 음성, 타임라인, 배속, 프레임 이동
4. **지도** — GPS 경로 폴리라인 + 현재 재생 위치 마커 + 속도 그래프
5. **G센서** — 3축 차트, 충격 구간 표시
6. **내보내기** — MP4 / WAV / CSV / 요약 리포트

---

## 2. 기술 스택 및 버전 기준

### 2.1 언어·UI

- **Kotlin** (자바 아님). 바이너리 파싱·코루틴·성능 모두 Kotlin이 유리
- **Jetpack Compose** + **Material 3**. XML 레이아웃 대비 상태 관리가 단순
- 단, **영상 표면(Surface)** 은 Compose에서 `AndroidView`로 `SurfaceView`를 감싸서 씀
  (`TextureView`보다 `SurfaceView`가 전력·성능상 유리, 단 애니메이션/변형은 제약)

### 2.2 버전 (2026-09 기준, Google Play 정책 반영)

| 항목 | 값 | 근거 |
|---|---|---|
| `compileSdk` | **36** (Android 16) | 최신 API로 컴파일 |
| `targetSdk` | **36** | 2026-08-31부터 **신규 앱·업데이트는 API 36 이상 필수** |
| `minSdk` | **26 (Android 8.0)** 권장 | `MediaMuxer` 기능, `java.time`, 코덱 안정성 확보. 24로 낮추면 desugaring 필요 |
| Media3 | **1.11.0** (2026-08-05 릴리스) | 최신 안정판 |
| Compose BOM | **2026.08.00** | 최신 안정판 |
| Kotlin / Compose 컴파일러 플러그인 | **2.3.21** | Compose 컴파일러 플러그인 버전과 Kotlin 버전이 일치해야 함 |
| AGP | 8.x 최신 안정판 (9.0 계열도 출시됨) | **사용 전 Android Studio에서 실제 버전 확인 필요** |
| Gradle | 8.14.3 (이 컨테이너에 설치됨) | AGP 버전에 맞춰 조정 |
| JDK | **21** (컨테이너 설치 확인됨) | AGP 8.x/9.x 모두 지원 |

> ⚠️ **정책 주의**: 기존 앱은 2026-08-31까지 API 35 이상, 신규/업데이트는 API 36 이상.
> 미준수 시 업데이트 게시가 차단됩니다. (2026-11-01까지 연장 신청 가능)

### 2.3 라이브러리 선택

| 용도 | 선택 | 이유 / 대안 |
|---|---|---|
| 영상 디코딩 | **`android.media.MediaCodec`** (플랫폼 내장) | 5장 참조. Media3도 병행 검토 |
| 영상 재생(대안) | **AndroidX Media3 1.11.0 (ExoPlayer)** | MP4로 변환한 뒤 재생하는 경로에서 사용 |
| 오디오 출력 | **`AudioTrack`** (플랫폼 내장) | 8kHz PCM을 그대로 넣을 수 있음 |
| MP4 저장 | **`MediaMuxer`** + `MediaCodec` AAC 인코더 | ffmpeg 불필요 |
| 지도 | **MapLibre Native** 또는 **osmdroid** | 둘 다 오픈소스·무료·오프라인 지원. **Google Maps SDK는 API 키·과금·온라인 의존**이라 이 앱 성격에 부적합 |
| 차트 | **Vico** | Compose 네이티브. MPAndroidChart는 View 기반(래핑 필요) |
| 비동기 | **Coroutines + Flow** | 파싱 진행률을 Flow로 방출 |
| 백그라운드 변환 | **WorkManager** | 긴 MP4 변환을 앱 이탈 후에도 유지 |
| 캐시 DB | **Room** (선택) | 파싱 결과(인덱스/GPS/센서) 캐싱 |
| DI | Hilt 또는 수동 DI | 앱 규모가 작으면 수동으로 충분 |

---

## 3. 파일 접근 — Scoped Storage와 SAF

### 왜 문제인가

Python은 `open("C:\\...\\00000000.jdr")` 로 끝이지만, **Android 10(API 29)부터 Scoped Storage**가
강제되어 앱이 임의 경로를 직접 열 수 없습니다. 블랙박스 SD카드를 OTG로 꽂은 경우도 마찬가지입니다.

`MANAGE_EXTERNAL_STORAGE`(모든 파일 접근) 권한은 Play 정책상 파일 관리자류에만 허용되므로
**사용하지 않습니다.**

### 해야 할 것

1. **`ACTION_OPEN_DOCUMENT`** 로 단일 파일 열기
   - `.jdr`은 등록된 MIME 타입이 없음 → **`type = "*/*"`** 로 열고 확장자로 필터
   - Compose에서는 `rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument())`
2. **`ACTION_OPEN_DOCUMENT_TREE`** 로 SD카드/OTG 폴더 통째로 열기 (JDR 목록 브라우징)
   - `DocumentFile.fromTreeUri()` 로 순회
3. **영구 권한 유지**: `contentResolver.takePersistableUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION)`
   → "최근 파일" 목록을 앱 재시작 후에도 다시 열 수 있음
4. **내보내기**: `ACTION_CREATE_DOCUMENT`로 사용자가 저장 위치 지정,
   또는 `MediaStore`(Downloads/Movies)에 기록

### 랜덤 액세스 (중요)

JDR 파싱은 **오프셋 기반 랜덤 액세스**가 필수인데, `contentResolver.openInputStream()` 은
순차 스트림이라 부적합합니다. 다음을 씁니다.

```kotlin
contentResolver.openFileDescriptor(uri, "r")!!.use { pfd ->
    FileInputStream(pfd.fileDescriptor).channel.use { ch ->
        // ch.position(offset); ch.read(buffer)
    }
}
```

### mmap을 그대로 옮기면 안 되는 이유

Python은 파일 전체를 `mmap` 합니다. Android에서 `FileChannel.map()`은
**한 매핑당 최대 약 2GB(Int 범위)** 제약이 있고, 대용량 파일에서 주소 공간 압박이 있습니다.

→ **권장**: 매핑하지 않고 `FileChannel` + 재사용 버퍼로 필요한 구간만 읽기.
굳이 매핑하려면 **청크 단위(예: 64MB)로 나눠 매핑**하고 경계를 처리해야 합니다.

---

## 4. 바이너리 파싱 — Python struct → Kotlin

### 4.1 엔디안

```kotlin
val buf = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)
```
**`ByteBuffer`의 기본 엔디안은 BIG_ENDIAN**입니다. `order()` 호출을 빠뜨리면 전부 틀립니다.

### 4.2 부호 없는 정수 (가장 흔한 버그)

Python `struct.unpack("<I")` 는 **부호 없는 0~4294967295**를 돌려주지만,
Kotlin `ByteBuffer.getInt()` 는 **부호 있는 Int**입니다.
파일이 2GB를 넘거나 오프셋이 큰 경우 **음수가 되어 파싱이 무너집니다.**

```kotlin
fun ByteBuffer.u32(index: Int): Long = getInt(index).toLong() and 0xFFFF_FFFFL
fun ByteBuffer.u16(index: Int): Int  = getShort(index).toInt() and 0xFFFF
```
→ 오프셋·크기는 전부 **`Long`** 으로 다룹니다.

### 4.3 SYSTEMTIME → 시각

```kotlin
// u16 × 8: year, month, dayOfWeek, day, hour, minute, second, millis
LocalDateTime.of(year, month, day, hour, minute, second, millis * 1_000_000)
```
- `dayOfWeek`(3번째)는 **버립니다**
- 이 값은 **기기 로컬 시각**이며 타임존 정보가 없습니다.
  → 앱 UI에 "기기 기록 시각(타임존 미상)"으로 표기하고, 절대 임의로 UTC 변환하지 않습니다.
- 값이 깨진 패킷이 있을 수 있으므로 `DateTimeException`을 반드시 잡습니다.

### 4.4 Magic 탐색

Python `buf.find(b"1BEJ", pos)` 에 해당하는 것을 직접 구현해야 합니다.
파일 전체를 훑되 **버퍼 경계에 걸친 magic**(예: 버퍼 끝 `1B`, 다음 버퍼 시작 `EJ`)을
놓치지 않도록 **3바이트 겹침(overlap)** 을 두고 읽습니다.

### 4.5 진행률과 취소

수십만 패킷 파싱은 수 초 이상 걸립니다.

```kotlin
fun parse(uri: Uri): Flow<ParseProgress> = flow { /* ... */ }
    .flowOn(Dispatchers.IO)
```
- UI 스레드 금지, `Dispatchers.IO`
- 코루틴 취소 협조: 루프 안에서 `ensureActive()` 호출
- 화면 회전 시 재파싱되지 않도록 **ViewModel에 결과 보관**

---

## 5. 영상 재생 — 이 프로젝트의 핵심 (최난이도)

### 문제 정의

JDR에서 뽑아낸 것은 **컨테이너 없는 raw H.264 Annex-B**입니다.
컨테이너가 없으므로 **프레임 경계·해상도·프레임레이트·타임스탬프가 파일에 없습니다.**
PC에서는 ffmpeg가 알아서 처리했지만, 안드로이드에는 ffmpeg가 없습니다.

또한 `MediaPlayer`, `MediaExtractor`는 **컨테이너를 요구**하므로 그대로는 쓸 수 없습니다.

### 선택지 3가지

#### A. MediaCodec 직접 피딩 — **최종 목표(권장)**

JDR 패킷에는 **패킷별 정확한 타임스탬프가 이미 있습니다.**
따라서 패킷 = 프레임으로 보고 디코더에 그대로 넣으면 됩니다. 구조적으로 가장 깔끔합니다.

```kotlin
val format = MediaFormat.createVideoFormat("video/avc", width, height).apply {
    setByteBuffer("csd-0", spsBuffer)   // SPS NAL (start code 포함)
    setByteBuffer("csd-1", ppsBuffer)   // PPS NAL
}
codec.configure(format, surface, null, 0)
codec.start()
// 입력: codec.queueInputBuffer(idx, 0, size, ptsUs, 0)
// 출력: codec.releaseOutputBuffer(idx, renderTimestampNs)  ← 렌더 시각 지정 가능
```

필요한 지식:
- **NAL 파싱**: start code(`00 00 01` / `00 00 00 01`) 스캔,
  `nal_unit_type = byte & 0x1F` → **7 = SPS, 8 = PPS, 5 = IDR**
- **해상도**: 샘플은 1280×720이지만 하드코딩하면 안 됨.
  SPS를 파싱(`pic_width_in_mbs_minus1` 등, exp-Golomb 디코딩)하거나,
  1차 구현에서는 임시값으로 configure 후 `INFO_OUTPUT_FORMAT_CHANGED`에서
  실제 크기를 받아 뷰 비율을 갱신하는 방법
- **csd 주의**: 포맷에 `csd-0/csd-1`을 넣었으면 `BUFFER_FLAG_CODEC_CONFIG`로
  **다시 넣으면 안 됩니다**(start 시 자동 제출됨). 둘 중 하나만 씁니다.
- **PTS**: `presentationTimeUs` = (패킷 시각 - 첫 패킷 시각) 마이크로초
- **시크**: `00VI`(I-프레임) 인덱스로 점프 → `codec.flush()` → **IDR부터** 재공급
  (P-프레임부터 넣으면 화면이 깨집니다)
- **2채널 동시 재생**: 디코더 인스턴스 2개. 기기별 **동시 코덱 인스턴스 제한**이 있어
  저가형에서 실패할 수 있음 → 실패 시 단일 채널로 폴백
- **비동기 모드** `setCallback()` 사용 권장 (동기 dequeue 루프보다 관리가 쉬움)

#### B. Media3(ExoPlayer) 커스텀 Extractor — **비권장**

`H264Reader`를 이용해 커스텀 Extractor를 만드는 시도가 ExoPlayer 이슈
[#5175](https://github.com/google/ExoPlayer/issues/5175),
[#6519](https://github.com/google/ExoPlayer/issues/6519),
[#7209](https://github.com/google/ExoPlayer/issues/7209) 에 여러 건 있으나,
**첫 프레임만 나오고 멈추거나 `pesTimeUs`가 항상 0이 되는 타임스탬프 문제**가 공통적으로 보고됩니다.
raw Annex-B는 ExoPlayer가 1급으로 지원하는 경로가 아니므로 이 길은 리스크가 큽니다.

#### C. 먼저 MP4로 변환 후 ExoPlayer로 재생 — **1단계(MVP) 권장**

`MediaMuxer`로 MP4를 만든 뒤 표준 재생. **가장 안전하고, 내보내기 기능과 코드가 겹칩니다.**
단점은 재생 전에 변환 시간이 필요하다는 점.

### 결론: 단계적 접근

```
MVP  : C (MP4 변환 → ExoPlayer 재생)  ← 확실히 동작하는 것 먼저
v1.0 : A (MediaCodec 직접 재생)        ← 변환 없이 즉시 재생, 2채널 동기
```

---

## 6. 오디오 재생과 A/V 동기

### AudioTrack

```kotlin
AudioTrack.Builder()
    .setAudioFormat(AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(8000)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build())
    .setTransferMode(AudioTrack.MODE_STREAM)
    .build()
```
- 8kHz는 하드웨어가 직접 지원하지 않을 수 있으나 플랫폼이 리샘플링합니다
- 버퍼 크기는 `AudioTrack.getMinBufferSize()` 의 2~4배로 잡아 언더런 방지

### 동기화

**오디오를 마스터 클럭으로** 삼는 것이 표준입니다.
`audioTrack.playbackHeadPosition / 8000.0` 으로 현재 재생 시각을 구하고,
영상 프레임은 그 시각에 맞춰 `releaseOutputBuffer(idx, renderTimeNs)` 로 내보냅니다.

주의: JDR의 오디오 패킷은 **중간에 끊길 수 있습니다**(주차모드 등).
패킷 타임스탬프 간격이 벌어지면 **무음 삽입(gap filling)** 을 해야
영상과 음성이 어긋나지 않습니다. (Python 버전은 단순 이어붙이기라 이 문제가 있습니다.)

### 오디오 포커스 / 백그라운드

- `AudioManager` 오디오 포커스 요청·상실 처리 (전화 수신 시 정지)
- 백그라운드 재생을 지원하려면 **`MediaSessionService` + 포그라운드 서비스**
  (Android 14+ 는 `foregroundServiceType="mediaPlayback"` 선언 필수)

---

## 7. MP4 내보내기 (ffmpeg 없이)

Python은 ffmpeg에 `-c:v copy -c:a aac` 를 넘겼습니다. 안드로이드 대응:

| ffmpeg가 하던 일 | 안드로이드 대체 |
|---|---|
| H.264 stream copy | `MediaMuxer.writeSampleData()` — **재인코딩 없음** |
| SPS/PPS → avcC | `MediaFormat`의 `csd-0/csd-1`로 전달하면 muxer가 생성 |
| PCM → AAC | `MediaCodec` **AAC 인코더** (`audio/mp4a-latm`, AAC-LC는 8kHz 지원) |
| `+faststart` | 불필요 — `MediaMuxer`는 moov를 적절히 배치 |
| `-r fps` | 각 샘플의 `presentationTimeUs`를 직접 지정 |

핵심 주의사항:
- **MP4 컨테이너는 raw PCM을 담지 못합니다.** 반드시 AAC로 인코딩해야 합니다
  (WAV로 따로 내보내는 경로는 별도 유지)
- `MediaMuxer`에 넘기는 샘플의 `presentationTimeUs`는 **단조 증가**해야 합니다
- `BufferInfo.flags`에 I-프레임은 `BUFFER_FLAG_KEY_FRAME` 설정
- 트랙은 `start()` **전에** 모두 `addTrack()` 해야 합니다
- **FFmpeg 라이브러리(ffmpeg-kit 등)를 넣는 선택지**도 있으나:
  APK 수십 MB 증가, **네이티브 라이브러리이므로 16KB 페이지 크기 정렬 필수**
  (2025-11-01부터 네이티브 코드 사용 신규 앱·업데이트는 16KB 지원 필수,
  NDK r28+ / AGP 8.5.1+ 는 기본 정렬됨), 라이선스(GPL/LGPL) 검토 필요
  → **플랫폼 API만으로 충분하므로 도입하지 않는 것을 권장**

### 긴 작업 처리

수백 MB 변환은 수 분이 걸립니다.
→ **WorkManager** + 포그라운드 서비스(`dataSync` 타입) + 진행률 알림.
Android 15+ 는 포그라운드 서비스 실행 시간 제약이 강화되었으므로
사용자가 앱을 떠난 상태에서의 장시간 작업은 별도 테스트가 필요합니다.

---

## 8. GPS 시각화

- 파싱: `docs/00-jdr-format-spec.md` 5.3 (NMEA `ddmm.mmmm` → 십진 도 변환 필수)
- **유효성 필터**: 위성 미수신 구간은 위/경도가 0 → 경로에서 제외해야 함
  (0,0을 그리면 아프리카 기니만으로 선이 튑니다)
- 지도: **MapLibre Native** 또는 **osmdroid**
  - 둘 다 오픈소스, API 키 불필요, 오프라인 타일 지원
  - MapLibre는 벡터 타일·Compose 바인딩(MapLibre Compose)이 있고,
    osmdroid는 더 가볍고 Apache-2.0
  - Google Maps SDK는 키 발급·과금·온라인 전제 → 이 앱에는 부적합
- 경로는 폴리라인, 재생 시각에 맞춰 마커 이동 (플레이어 시각 ↔ GPS 행 바인딩)
- 속도는 별도 그래프 + 영상 오버레이

> ⚠️ **속도 값 주의**: km/h로 해석한 것은 역공학 추정입니다.
> 증거로 쓸 때는 UI에 "추정값" 표기가 반드시 필요합니다.

---

## 9. G센서 시각화

- `i32 × 3` raw → `/1024.0` 로 g 환산 (**추정 스케일**)
- **Vico**로 3축 시계열 차트, 영상 타임라인과 X축 공유
- 충격 감지: 합성 가속도 `sqrt(x²+y²+z²)` 가 임계값을 넘는 구간 마킹 →
  "이벤트로 바로 점프" 기능이 사용자 가치가 큼
- 데이터 포인트가 수만 개 → **다운샘플링(화면 픽셀 수 수준으로)** 하지 않으면 렌더가 버벅임

---

## 10. 성능 / 메모리 (실전에서 반드시 걸리는 부분)

### 패킷 객체를 그대로 만들면 OOM

Python의 `Packet` 데이터클래스를 Kotlin `data class`로 그대로 옮기고
`List<Packet>`에 담으면, 패킷 50만 개 기준 **객체 헤더 + LocalDateTime 참조**만으로
수백 MB가 나가 앱 힙(기본 수백 MB)을 넘길 수 있습니다.

→ **구조 배열(SoA) 권장**:

```kotlin
class PacketTable(n: Int) {
    val offset   = LongArray(n)   // 파일 오프셋
    val size     = IntArray(n)
    val tag      = IntArray(n)    // 4바이트 ASCII를 Int로 패킹
    val timeMs   = LongArray(n)   // epoch millis
}
```
패킷 1개당 24바이트 수준으로 줄어듭니다. (50만 개 ≈ 12MB)

### 그 외

- **인덱스 테이블 우선 사용**: 순차 파싱 대신 12바이트 인덱스를 읽으면 훨씬 빠름.
  단, 인덱스가 깨진 파일 대비 **순차 파싱 폴백**을 유지
- 재생 중 패킷 페이로드는 **디스크에서 그때그때 읽기** (전체 메모리 적재 금지)
- ByteBuffer 재사용 (루프 안 `allocate` 금지)
- `largeHeap="true"` 는 근본 해결이 아니므로 최후 수단
- **StrictMode**로 메인 스레드 디스크 I/O 조기 검출

---

## 11. UI / UX에서 챙길 것

- **Edge-to-edge 강제**: targetSdk 35+ 에서는 시스템 바 뒤까지 그려지는 것이 기본.
  `WindowInsets` 처리를 하지 않으면 컨트롤이 내비게이션 바에 가려집니다
- **가로 모드**가 사실상 기본 (16:9 영상). 구성 변경 시 재생 상태 유지 필수
- **화면 꺼짐 방지**: 재생 중 `KEEP_SCREEN_ON`
- 큰 화면(태블릿·폴더블) 대응: Play 정책상 대화면 대응 권장
- 다크 테마, 동적 색상(Material You)
- 접근성: 컨트롤 터치 영역 48dp 이상, 콘텐츠 설명

---

## 12. 아키텍처

```
ui/            Compose 화면 + ViewModel (StateFlow)
domain/        유스케이스 (파싱, 내보내기, 이벤트 검출)
data/
  jdr/         JdrParser, PacketTable, GpsRecord, GsensorRecord
  io/          SafFileSource (openFileDescriptor 래핑)
  export/      Mp4Exporter(MediaMuxer), WavExporter, CsvExporter
player/        VideoDecoder(MediaCodec), AudioRenderer(AudioTrack), Clock
```

- **파서는 안드로이드 의존성 제로**로 작성 → JVM 유닛테스트로 검증 가능
  (`InputStream`/`SeekableSource` 인터페이스만 받도록)
- ViewModel에 파싱 결과 보관, 화면 회전 시 재파싱 방지
- 단방향 데이터 흐름(UDF), 상태는 `sealed interface UiState`

---

## 13. 테스트

| 레이어 | 방법 |
|---|---|
| 파서 | JUnit5 + **작은 합성 JDR 골든 파일**을 테스트 리소스로 생성해 검증 |
| 포맷 경계 | 잘린 파일, 잘못된 크기, magic 오탐, 인덱스 불일치 케이스 |
| 성능 | 대용량 파일 파싱 시간 측정 (회귀 방지) |
| 코덱 | **실기기 필수** — 에뮬레이터와 실제 기기의 코덱 동작이 다름. 저가·고가 기기 각 1대 |
| UI | Compose UI 테스트 |

**교차 검증 전략**: 동일 JDR을 Python 도구로 뽑은 결과와 앱 결과의
SHA-256/행 수/타임스탬프를 비교하면 파서 정확성을 강하게 보장할 수 있습니다.

---

## 14. 배포 시 체크리스트

- [ ] `targetSdk 36` (2026-08-31 정책)
- [ ] Android App Bundle(.aab), Play App Signing
- [ ] 네이티브 라이브러리를 쓴다면 **16KB 페이지 크기 정렬** 확인
- [ ] **Data safety 양식**: 위치 데이터·영상 취급 신고. "기기 외부 전송 없음"을 명확히
- [ ] 개인정보처리방침 URL (Play 필수)
- [ ] 권한 최소화: 인터넷 권한조차 지도 미사용 시 뺄 수 있음
- [ ] ProGuard/R8 — 리플렉션 없는 구조라 큰 이슈 없음
- [ ] **면책 고지**: "비공식 역분석 기반, 제조사 사양 아님"을 앱 내 표기

---

## 15. 리스크 정리

| 리스크 | 영향 | 완화 |
|---|---|---|
| **MediaCodec 직접 재생 난이도** | 높음 | MVP는 MP4 변환 경로(선택지 C)로 우회 |
| 기기별 코덱 편차 | 높음 | 실기기 다수 테스트, 실패 시 소프트웨어 디코더 폴백 |
| 다른 IROAD 기종 JDR 변형 | 중간 | 파싱 실패 시 명확한 안내 + 진단 정보(헤더 hex) 제공 |
| 대용량 파일 OOM | 중간 | SoA 구조, 스트리밍 읽기 |
| 2채널 동시 디코딩 실패 | 중간 | 단일 채널 폴백 |
| 역공학 값(속도·G스케일) 오해 | 중간 | UI에 "추정값" 명시 |
| 이 개발 컨테이너에 Android SDK 없음 | 낮음 | 16장 참조 |

---

## 16. 개발 환경 현황 (이 컨테이너)

확인 결과:

| 항목 | 상태 |
|---|---|
| JDK 21 | ✅ 설치됨 |
| Gradle 8.14.3 | ✅ 설치됨 |
| **Android SDK** | ❌ **없음** |
| Kotlin 컴파일러 | ❌ 없음 (Gradle이 받아옴) |
| ffmpeg | ❌ 없음 |
| `dl.google.com` 접근 | ❌ **네트워크 정책에서 차단됨** (HTTP 403) |

→ **이 컨테이너에서는 안드로이드 앱을 빌드할 수 없습니다.**
Android SDK 설치와 Google Maven 저장소 접근이 모두 막혀 있기 때문입니다.

선택지:
1. **로컬 Android Studio에서 개발** — 이 저장소를 클론해서 진행 (권장)
2. 환경의 네트워크 정책에 `dl.google.com` / `maven.google.com` 허용 추가 후
   여기서 SDK를 설치해 빌드

단, **JDR 파서 자체는 안드로이드 의존성이 없으므로**(12장) 순수 Kotlin/JVM 모듈로
이 컨테이너에서도 작성·테스트가 가능합니다.

---

## 17. 참고 자료

**Android 공식**
- [MediaCodec](https://developer.android.com/reference/android/media/MediaCodec)
- [MediaMuxer](https://developer.android.com/reference/android/media/MediaMuxer)
- [AudioTrack](https://developer.android.com/reference/android/media/AudioTrack)
- [Storage Access Framework](https://developer.android.com/guide/topics/providers/document-provider)
- [Media3 릴리스 노트](https://developer.android.com/jetpack/androidx/releases/media3)
- [Compose BOM](https://developer.android.com/develop/ui/compose/bom)
- [Compose ↔ Kotlin 호환 표](https://developer.android.com/jetpack/androidx/releases/compose-kotlin)
- [16KB 페이지 크기 지원](https://developer.android.com/guide/practices/page-sizes)
- [Play targetSdk 정책](https://support.google.com/googleplay/android-developer/answer/11926878)

**raw H.264 재생 관련 선행 사례**
- [ExoPlayer #5175 — raw H.264 Annex-B 커스텀 구현](https://github.com/google/ExoPlayer/issues/5175)
- [ExoPlayer #6519 — raw H264 extractor](https://github.com/google/ExoPlayer/issues/6519)
- [androidx/media #2416 — raw 프레임 추출](https://github.com/androidx/media/issues/2416)

**라이브러리**
- [MapLibre Compose 가이드](https://medium.com/@joy458963214/a-practical-guide-to-maplibre-compose-94a8cb6f79c4)
- [Vico (Compose 차트)](https://www.jetpackcompose.app/compose-catalog/vico)
