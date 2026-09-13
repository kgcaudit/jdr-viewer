/** 분석 요약 패널. 증거성 정보(해시·무결성)를 맨 위에 둔다. */
import type { JdrDocument } from '../core/types';
import type { Library } from '../core/library';
import type { SegmentInfo } from '../core/segment';
import { formatDuration, formatRecordedTime } from '../core/time';
import { bytes, escapeHtml, num } from './format';

export interface SummaryInput {
  /** 현재 재생 중인 세그먼트의 파싱 결과 (아직 없으면 null) */
  doc: JdrDocument | null;
  lib: Library;
  segment: SegmentInfo | null;
  /** 폴더 모드인가 (세그먼트가 여러 개) */
  merged: boolean;
}

/** 폴더 전체 요약 — 병합 타임라인이 어떤 모습인지 */
function librarySection(lib: Library): string {
  const coverage = lib.spanMs > 0 ? (lib.coveredMs / lib.spanMs) * 100 : 100;
  const overlapNote =
    lib.overlaps.length > 0
      ? `<div class="note"><strong>구간 ${num(lib.overlaps.length)}곳이 겹칩니다.</strong>
         같은 시각을 담은 파일이 여러 개라는 뜻입니다(예: event와 data).
         연속 재생에서는 <strong>먼저 시작한 쪽</strong>을 씁니다.
         구간 탭에서 폴더를 나눠 선택할 수 있습니다.</div>`
      : '';
  return `
    <p class="section-title">병합 타임라인</p>
    <dl class="kv">
      <dt>구간</dt><dd>${num(lib.segments.length)}개${lib.invalid.length ? ` <span class="status-warn">(읽지 못한 파일 ${num(lib.invalid.length)}개)</span>` : ''}</dd>
      <dt>전체 범위</dt><dd>${formatRecordedTime(lib.startMs)}<br>~ ${formatRecordedTime(lib.endMs)}</dd>
      <dt>벽시계 길이</dt><dd>${formatDuration(lib.spanMs / 1000)}</dd>
      <dt>실제 영상</dt><dd>${formatDuration(lib.coveredMs / 1000)} <span class="muted">(${coverage.toFixed(1)}%)</span></dd>
      <dt>빈 구간</dt><dd>${gapSummary(lib)}</dd>
      <dt>이벤트</dt><dd>${lib.events.length === 0 ? '없음' : `${num(lib.events.length)}건`}</dd>
      <dt>전체 크기</dt><dd>${bytes(lib.totalBytes)}</dd>
    </dl>
    ${overlapNote}`;
}

function integrityLine(doc: JdrDocument): string {
  const noIndex = doc.blocks.some((b) => !b.indexAvailable);
  if (noIndex) {
    return `<span class="status-warn">인덱스 테이블 없음/잘림</span> — 녹화 중 전원이 끊긴 파일일 수 있습니다`;
  }
  if (doc.indexMismatches === 0) {
    return `<span class="status-ok">일치 (불일치 0건)</span>`;
  }
  return `<span class="status-bad">불일치 ${num(doc.indexMismatches)}건</span> — 파일이 변형·손상되었을 수 있습니다`;
}

function bitstreamRow(doc: JdrDocument, channel: number): string {
  const v = doc.video[channel];
  if (!v || v.frameCount === 0) return `<dd class="muted">영상 없음</dd>`;
  const bs = v.bitstream;
  const res = bs?.width && bs?.height ? `${bs.width}×${bs.height}` : '해상도 미상';
  const codec = bs?.codec ?? '코덱 미상';
  return `<dd>${num(v.frameCount)}프레임 · 키프레임 ${num(v.keyframeCount)} · ${v.fps.toFixed(3)}fps<br>
    <span class="muted">${escapeHtml(res)} · ${escapeHtml(codec)}</span></dd>`;
}

/**
 * Annex-B 재생의 전제 조건 점검 결과.
 * WebCodecs는 key 청크에 SPS/PPS가 함께 있어야 하므로 이 값이 중요하다.
 */
function parameterSetNote(doc: JdrDocument): string {
  const rows = doc.video
    .filter((v) => v.frameCount > 0)
    .map((v) => {
      const bs = v.bitstream;
      if (!bs) return `<li>CH${v.channel}: 키프레임을 찾지 못했습니다</li>`;
      const inKey = bs.hasSps && bs.hasPps;
      const nal = bs.nalTypes.length ? bs.nalTypes.join(', ') : '없음';
      if (inKey) {
        return `<li>CH${v.channel}: <span class="status-ok">키프레임에 SPS·PPS 포함</span> (NAL 타입 ${escapeHtml(nal)})</li>`;
      }
      if (bs.parameterSets) {
        return `<li>CH${v.channel}: <span class="status-warn">키프레임에 SPS·PPS 없음</span> — 주변 패킷에서 찾아 재생 시 앞에 붙입니다 (NAL 타입 ${escapeHtml(nal)})</li>`;
      }
      return `<li>CH${v.channel}: <span class="status-bad">SPS·PPS를 찾지 못했습니다</span> — 재생이 안 될 수 있습니다 (NAL 타입 ${escapeHtml(nal)})</li>`;
    })
    .join('');
  if (!rows) return '';
  return `<div class="note"><strong>H.264 비트스트림 점검</strong><ul style="margin:6px 0 0;padding-left:18px">${rows}</ul></div>`;
}

/**
 * 빈 구간을 한 줄로. **왜 비었는지**까지 적는다 —
 * 파일이 없는 것과 기록이 끊긴 것은 원인도 대응도 다르다.
 */
function gapSummary(lib: Library): string {
  if (lib.gaps.length === 0) return '없음';
  const totalMs = lib.gaps.reduce((a, g) => a + g.durationMs, 0);
  const missing = lib.gaps.reduce((a, g) => a + Math.max(0, g.numberSkip), 0);
  const parts = [`${num(lib.gaps.length)}곳 · 합계 ${formatDuration(totalMs / 1000)}`];
  if (missing > 0) parts.push(`파일 ${num(missing)}개 없음`);
  return parts.join('<br>');
}

export function renderSummary(el: HTMLElement, input: SummaryInput): void {
  const { doc, lib, segment, merged } = input;
  if (!doc) {
    el.innerHTML = `${merged ? librarySection(lib) : ''}<p class="muted">구간을 여는 중…</p>`;
    return;
  }
  const tags = Object.entries(doc.tagCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, c]) => `<span class="tag-pill">${escapeHtml(t)} · ${num(c)}</span>`)
    .join('');

  const blockRows = doc.blocks
    .map(
      (b) => `<span class="tag-pill">#${b.blockNo} · 0x${b.headerOffset.toString(16).toUpperCase()} · ${num(b.packetCount)}패킷${
        b.truncated ? ' · 잘림' : ''
      }</span>`,
    )
    .join('');

  el.innerHTML = `
    ${merged ? librarySection(lib) : ''}
    <p class="section-title">${merged ? '현재 구간 파일' : '파일'}</p>
    <dl class="kv">
      <dt>이름</dt><dd>${escapeHtml(doc.fileName)}${segment?.folder ? ` <span class="muted">(${escapeHtml(segment.folder)})</span>` : ''}</dd>
      <dt>크기</dt><dd>${bytes(doc.fileSize)} <span class="muted">(${num(doc.fileSize)} bytes)</span></dd>
      <dt>SHA-256</dt><dd style="font-size:12px">${
        doc.sha256
          ? escapeHtml(doc.sha256)
          : '<span class="muted">폴더 모드에서는 생략합니다 — 파일 전체를 읽어야 해서 가장 비쌉니다. 내보내기 탭에서 계산할 수 있습니다.</span>'
      }</dd>
      <dt>인덱스 대조</dt><dd>${integrityLine(doc)}</dd>
    </dl>

    <p class="section-title">${merged ? '현재 구간 기록' : '기록'}</p>
    <dl class="kv">
      <dt>시작</dt><dd>${formatRecordedTime(doc.firstTimeMs)}</dd>
      <dt>종료</dt><dd>${formatRecordedTime(doc.lastTimeMs)}</dd>
      <dt>길이</dt><dd>${formatDuration(doc.durationSec)} <span class="muted">(${doc.durationSec.toFixed(3)}초)</span></dd>
      <dt>JEB 블록</dt><dd>${num(doc.blocks.length)}개</dd>
      <dt>패킷</dt><dd>${num(doc.packets.count)}개</dd>
    </dl>

    <p class="section-title">영상</p>
    <dl class="kv">
      <dt>전방 CH0</dt>${bitstreamRow(doc, 0)}
      <dt>후방 CH1</dt>${bitstreamRow(doc, 1)}
    </dl>
    ${parameterSetNote(doc)}

    <p class="section-title">음성 · 센서</p>
    <dl class="kv">
      <dt>음성</dt><dd>${num(doc.audio.packetCount)}패킷 · ${num(doc.audio.sampleCount)}샘플 ·
        ${doc.audio.sampleRate.toLocaleString('ko-KR')}Hz 모노 16bit
        <span class="muted">(${(doc.audio.sampleCount / doc.audio.sampleRate).toFixed(1)}초)</span></dd>
      <dt>GPS</dt><dd>${num(doc.gps.length)}건</dd>
      <dt>G센서</dt><dd>${num(doc.gsensor.count)}건</dd>
    </dl>

    <p class="section-title">블록</p>
    <div class="tag-grid">${blockRows}</div>

    <p class="section-title">패킷 태그</p>
    <div class="tag-grid">${tags}</div>

    <div class="note">
      이 뷰어의 JDR 해석은 <strong>역분석 추정</strong>이며 제조사 공식 사양이 아닙니다.
      GPS 속도와 G센서 스케일(raw ÷ 1024 ≈ g)은 추정값입니다.
      원본성 판단의 기준은 <strong>원본 JDR 파일과 위 SHA-256</strong>입니다.
    </div>
  `;
}
