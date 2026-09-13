/**
 * 인덱스 테이블만 보고 GPS·G센서 레코드를 뽑는다.
 *
 * 왜 필요한가: 실제 기기의 파일은 70MB짜리가 수백 개다(58GB 규모).
 * 전 구간 GPS 경로를 그리겠다고 파일을 통째로 파싱하면 몇 분이 걸린다.
 *
 * 핵심은 12바이트 인덱스 항목에 **태그가 들어있다**는 점이다.
 * 인덱스만 한 번에 읽으면(패킷 4천 개 기준 48KB) GPS/센서 패킷의 위치를
 * 바로 알 수 있고, 그 자리만 골라 읽으면 된다. 70MB → 수십 KB로 줄어든다.
 */
import type { ByteSource } from './byte-source';
import { INDEX_ENTRY_SIZE, PACKET_HEADER_SIZE, nmeaToDegrees, validateHeader } from './parser';
import { TagKind, packTag, tagKind } from './tags';
import { systemTimeToMs } from './time';
import type { GpsFix, GsensorSeries } from './types';
import type { SegmentInfo } from './segment';

/** 이 정도 떨어진 항목은 한 번에 읽어 버리는 게 낫다 (읽기 호출 자체의 비용 때문) */
const COALESCE_GAP = 64 * 1024;
const GPS_PAYLOAD_MIN = 96;
const SENSOR_PAYLOAD_MIN = 12;

export interface RecordScanResult {
  gps: GpsFix[];
  gsensor: GsensorSeries;
  /** 인덱스 테이블을 못 써서 건너뛴 경우 */
  indexUnavailable: boolean;
  /** 실제로 읽은 바이트 수 (성능 확인용) */
  bytesRead: number;
}

interface Wanted {
  offset: number;
  length: number;
  kind: TagKind;
}

/**
 * @param maxSensorSamples 전 구간 개요용이라 센서는 솎아낸다. 0이면 전부.
 */
export async function scanRecords(
  src: ByteSource,
  seg: SegmentInfo,
  maxSensorSamples = 0,
): Promise<RecordScanResult> {
  const wanted: Wanted[] = [];
  let indexUnavailable = false;
  let bytesRead = 0;

  for (const blockOffset of seg.blockOffsets) {
    const h = await validateHeader(src, blockOffset);
    if (!h || !h.indexAvailable) {
      indexUnavailable = true;
      continue;
    }
    const idx = await src.read(h.indexOffset, h.packetCount * INDEX_ENTRY_SIZE);
    bytesRead += idx.length;
    const dv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const entries = Math.floor(idx.length / INDEX_ENTRY_SIZE);

    for (let i = 0; i < entries; i++) {
      const o = i * INDEX_ENTRY_SIZE;
      const kind = tagKind(packTag(idx[o], idx[o + 1], idx[o + 2], idx[o + 3]));
      if (kind !== TagKind.Gps && kind !== TagKind.Sensor) continue;
      const size = dv.getUint32(o + 4, true);
      const min = kind === TagKind.Gps ? GPS_PAYLOAD_MIN : SENSOR_PAYLOAD_MIN;
      if (size < min) continue;
      wanted.push({
        offset: dv.getUint32(o + 8, true),
        length: PACKET_HEADER_SIZE + Math.min(size, kind === TagKind.Gps ? 256 : 64),
        kind,
      });
    }
  }

  // 센서는 개요용이므로 균등하게 솎아낸다 (수만 개를 다 읽을 이유가 없다)
  let picked = wanted;
  if (maxSensorSamples > 0) {
    const sensors = wanted.filter((w) => w.kind === TagKind.Sensor);
    if (sensors.length > maxSensorSamples) {
      const step = Math.ceil(sensors.length / maxSensorSamples);
      const keep = new Set(sensors.filter((_, i) => i % step === 0));
      picked = wanted.filter((w) => w.kind !== TagKind.Sensor || keep.has(w));
    }
  }
  picked.sort((a, b) => a.offset - b.offset);

  // 가까운 항목끼리 묶어 한 번에 읽는다
  const spans: { from: number; to: number }[] = [];
  for (const w of picked) {
    const last = spans[spans.length - 1];
    if (last && w.offset - last.to <= COALESCE_GAP) {
      last.to = Math.max(last.to, w.offset + w.length);
    } else {
      spans.push({ from: w.offset, to: w.offset + w.length });
    }
  }

  const gps: GpsFix[] = [];
  const sTime: number[] = [];
  const sX: number[] = [];
  const sY: number[] = [];
  const sZ: number[] = [];

  let si = 0;
  for (const span of spans) {
    const buf = await src.read(span.from, span.to - span.from);
    bytesRead += buf.length;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (si < picked.length && picked[si].offset < span.to) {
      const w = picked[si];
      const rel = w.offset - span.from;
      if (rel < 0 || rel + PACKET_HEADER_SIZE > buf.length) { si++; continue; }
      const timeMs = systemTimeToMs(
        dv.getUint16(rel + 12, true), dv.getUint16(rel + 14, true), dv.getUint16(rel + 18, true),
        dv.getUint16(rel + 20, true), dv.getUint16(rel + 22, true), dv.getUint16(rel + 24, true),
        dv.getUint16(rel + 26, true),
      );
      const p = rel + PACKET_HEADER_SIZE;

      if (w.kind === TagKind.Gps && p + GPS_PAYLOAD_MIN <= buf.length) {
        const latNmea = dv.getFloat64(p + 64, true);
        const lonNmea = dv.getFloat64(p + 72, true);
        gps.push({
          timeMs,
          gpsTimeMs: systemTimeToMs(
            dv.getInt32(p + 4, true), dv.getInt32(p + 8, true), dv.getInt32(p + 12, true),
            dv.getInt32(p + 16, true), dv.getInt32(p + 20, true), dv.getInt32(p + 24, true), 0,
          ),
          pdop: dv.getFloat64(p + 40, true),
          hdop: dv.getFloat64(p + 48, true),
          vdop: dv.getFloat64(p + 56, true),
          latNmea, lonNmea,
          lat: nmeaToDegrees(latNmea),
          lon: nmeaToDegrees(lonNmea),
          altitude: dv.getFloat64(p + 80, true),
          speed: dv.getFloat64(p + 88, true),
        });
      } else if (w.kind === TagKind.Sensor && p + SENSOR_PAYLOAD_MIN <= buf.length) {
        sTime.push(timeMs);
        sX.push(dv.getInt32(p, true));
        sY.push(dv.getInt32(p + 4, true));
        sZ.push(dv.getInt32(p + 8, true));
      }
      si++;
    }
  }

  return {
    gps,
    gsensor: {
      count: sTime.length,
      timeMs: Float64Array.from(sTime),
      x: Int32Array.from(sX),
      y: Int32Array.from(sY),
      z: Int32Array.from(sZ),
    },
    indexUnavailable,
    bytesRead,
  };
}
