/** JDR 파싱 결과 타입. 이 파일은 브라우저/Node 어디서든 쓸 수 있어야 한다 (DOM 의존 금지). */

/** 패킷 테이블 — 구조 배열(SoA). 패킷 수십만 개에서도 메모리를 아끼기 위함. */
export interface PacketTable {
  count: number;
  /** 소속 JEB 블록 번호 */
  blockNo: Uint16Array;
  /** 패킷 헤더의 파일 절대 오프셋 (페이로드는 +28) */
  offset: Float64Array;
  /** 페이로드 바이트 수 */
  size: Uint32Array;
  /** 4바이트 ASCII 태그를 빅엔디안으로 패킹한 값 */
  tag: Uint32Array;
  /** 패킷 헤더 +0x08 (시퀀스/샘플 인덱스로 추정) */
  aux: Uint32Array;
  /** 기록된 벽시계 시각. Date.UTC로 만든 epoch ms (타임존 미적용 — 6장 주석 참조) */
  timeMs: Float64Array;
}

export interface JdrBlockInfo {
  blockNo: number;
  headerOffset: number;
  packetCount: number;
  videoCh0Count: number;
  videoCh1Count: number;
  audioCount: number;
  gpsCount: number;
  sensorCount: number;
  indexOffset: number;
  startTimeMs: number;
  endTimeMs: number;
  gpsHint: string;
  /** 순차 파싱 결과와 12바이트 인덱스 테이블이 어긋난 건수 */
  indexMismatches: number;
  /** 인덱스 테이블이 파일 안에 온전히 존재하는가 (잘린 녹화 파일이면 false) */
  indexAvailable: boolean;
  /** 선언된 패킷 수를 다 읽기 전에 파일이 끝난 경우 */
  truncated: boolean;
}

export interface GpsFix {
  /** 패킷 헤더 시각 */
  timeMs: number;
  /** GPS 페이로드에 들어있는 자체 시각 (UTC로 추정) */
  gpsTimeMs: number;
  pdop: number;
  hdop: number;
  vdop: number;
  /** 원본 NMEA ddmm.mmmm 값 */
  latNmea: number;
  lonNmea: number;
  /** 십진 도로 변환한 값 */
  lat: number;
  lon: number;
  altitude: number;
  /** km/h로 해석 — 역공학 추정치 */
  speed: number;
}

/** G센서 샘플 — SoA */
export interface GsensorSeries {
  count: number;
  timeMs: Float64Array;
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
}

/** 채널별 영상 요약 */
export interface VideoChannelInfo {
  channel: number;
  frameCount: number;
  keyframeCount: number;
  /** 타임스탬프로 추정한 fps */
  fps: number;
  /** 첫 키프레임 페이로드를 뜯어본 결과 (WebCodecs 설정에 필요) */
  bitstream: BitstreamInfo | null;
}

/** 첫 키프레임 Annex-B 분석 결과 */
export interface BitstreamInfo {
  /** 발견한 NAL 유닛 타입 목록 (등장 순서) */
  nalTypes: number[];
  hasSps: boolean;
  hasPps: boolean;
  hasIdr: boolean;
  /** WebCodecs configure()에 넘길 코덱 문자열. 예: "avc1.42E01E" */
  codec: string | null;
  width: number | null;
  height: number | null;
  /** SPS/PPS가 키프레임 안에 없어서 따로 앞에 붙여야 하는 경우 그 바이트 */
  parameterSets: Uint8Array | null;
}

export interface JdrDocument {
  fileName: string;
  fileSize: number;
  sha256: string;
  blocks: JdrBlockInfo[];
  packets: PacketTable;
  /** 태그 문자열 → 개수 */
  tagCounts: Record<string, number>;
  firstTimeMs: number;
  lastTimeMs: number;
  /**
   * 영상·음성 패킷만 본 마지막 시각. 구간의 길이는 담긴 내용이 정한다 —
   * 꼬리에 덧붙은 GPS·센서 패킷 한 줄이 주차 시간을 녹화로 덮으면 안 된다.
   */
  contentEndMs: number;
  durationSec: number;
  indexMismatches: number;
  video: VideoChannelInfo[];
  audio: {
    packetCount: number;
    totalBytes: number;
    sampleRate: number;
    /** PCM s16le 기준 총 샘플 수 */
    sampleCount: number;
  };
  gps: GpsFix[];
  gsensor: GsensorSeries;
}

export type ParseProgress =
  | { phase: 'hash'; done: number; total: number }
  | { phase: 'scan'; done: number; total: number }
  | { phase: 'packets'; done: number; total: number }
  | { phase: 'analyze' };
