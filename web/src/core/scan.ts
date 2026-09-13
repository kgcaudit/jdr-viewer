/**
 * 전 구간 GPS·G센서 스캔 (D4).
 *
 * 실제 기기는 70MB 파일이 수백 개다(58GB 규모). 전체 파싱으로 하면 몇 분이 걸리므로
 * 인덱스 테이블만 읽어 GPS/센서 패킷 자리만 집어 읽는다(records.ts).
 * 인덱스가 깨진 파일만 전체 파싱으로 폴백한다.
 *
 * 재생을 막지 않도록 백그라운드에서 돌리고, 한 파일이 끝날 때마다 결과를 흘려보낸다.
 */
import type { ByteSource } from './byte-source';
import { parseJdr } from './parser';
import { scanRecords } from './records';
import type { SegmentInfo } from './segment';
import type { GpsFix } from './types';

/** 전 구간 개요용이므로 세그먼트당 센서 샘플 수를 제한한다 */
const SENSOR_SAMPLES_PER_SEGMENT = 240;

export interface ScanChunk {
  segmentId: string;
  gps: GpsFix[];
  sensorTime: Float64Array;
  sensorX: Int32Array;
  sensorY: Int32Array;
  sensorZ: Int32Array;
  done: number;
  total: number;
}

export interface ScanItem {
  seg: SegmentInfo;
  src: ByteSource;
}

/**
 * 세그먼트를 순서대로 훑으며 GPS/G센서만 뽑아 chunk로 넘긴다.
 * 영상·음성 페이로드는 읽지 않는다 (패킷 헤더만 지나간다).
 */
export async function scanSegments(
  items: ScanItem[],
  onChunk: (chunk: ScanChunk) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (shouldStop?.()) return;
    const { seg, src } = items[i];
    // GPS도 센서도 없는 세그먼트는 통째로 건너뛴다
    if (seg.gpsCount === 0 && seg.sensorCount === 0) {
      onChunk({
        segmentId: seg.id, gps: [],
        sensorTime: new Float64Array(0), sensorX: new Int32Array(0),
        sensorY: new Int32Array(0), sensorZ: new Int32Array(0),
        done: i + 1, total: items.length,
      });
      continue;
    }
    try {
      let result = await scanRecords(src, seg, SENSOR_SAMPLES_PER_SEGMENT);
      // 인덱스 테이블이 깨진 파일만 전체 파싱으로 되돌아간다
      if (result.indexUnavailable && result.gps.length === 0 && result.gsensor.count === 0) {
        const doc = await parseJdr(src, undefined, {
          hash: false,
          blockOffsets: seg.blockOffsets.length > 0 ? seg.blockOffsets : undefined,
        });
        result = { gps: doc.gps, gsensor: doc.gsensor, indexUnavailable: true, bytesRead: seg.size };
      }
      onChunk({
        segmentId: seg.id,
        gps: result.gps,
        sensorTime: result.gsensor.timeMs,
        sensorX: result.gsensor.x,
        sensorY: result.gsensor.y,
        sensorZ: result.gsensor.z,
        done: i + 1,
        total: items.length,
      });
    } catch {
      // 한 파일이 깨졌다고 전체 스캔을 멈추지 않는다
      onChunk({
        segmentId: seg.id, gps: [],
        sensorTime: new Float64Array(0), sensorX: new Int32Array(0),
        sensorY: new Int32Array(0), sensorZ: new Int32Array(0),
        done: i + 1, total: items.length,
      });
    }
  }
}
