/**
 * 시간 구간 내보내기 패널.
 *
 * 파일 하나가 50초라 파일 단위로 뽑으면 쓸모가 없다. 사람이 말하는 단위
 * ("07:57부터 08:02까지")로 고르게 한다.
 *
 * 시작·끝은 두 가지로 정한다.
 *  - 재생하다가 **[지금]** 을 누른다 (제일 자연스럽다)
 *  - 시각을 직접 입력한다 (정확히 맞출 때)
 */
import type { SegmentInfo } from '../core/segment';
import {
  estimateRangeBytes, RANGE_LABEL, rangeFileName, segmentsInRange,
  type RangeKind, type TimeRange,
} from '../core/range-export';
import { formatDurationKo, formatRecordedTime } from '../core/time';
import { bytes, escapeHtml, num } from './format';

export interface RangeExportHandlers {
  /** 시작/끝을 현재 재생 위치로 */
  onPickNow(edge: 'from' | 'to'): void;
  /** 시각 입력이 바뀜 (HH:MM:SS) */
  onEditTime(edge: 'from' | 'to', value: string): void;
  /** 빠른 선택 */
  onPreset(preset: 'file' | 'session' | 1 | 5 | 10): void;
  onExport(kind: RangeKind): void;
}

export interface RangeExportState {
  range: TimeRange;
  segments: SegmentInfo[];
  /** 지금 만들고 있는 것 */
  busy: RangeKind | null;
  progress: number;
  progressNote: string;
}

const KINDS: RangeKind[] = ['front', 'rear', 'audio', 'gps', 'sensor'];

function hhmmss(ms: number): string {
  return formatRecordedTime(ms, false).slice(11, 19);
}

export function renderRangeExport(
  el: HTMLElement,
  state: RangeExportState,
  h: RangeExportHandlers,
): void {
  const { range } = state;
  const durationMs = Math.max(0, range.toMs - range.fromMs);
  const hit = segmentsInRange(state.segments, range);
  const valid = durationMs > 0 && hit.length > 0;

  const rows = KINDS.map((kind) => {
    const size = estimateRangeBytes(state.segments, range, kind);
    const busy = state.busy === kind;
    const label = kind === 'gps' || kind === 'sensor' ? `${num(estimateRows(state.segments, range, kind))}행 남짓` : `대략 ${bytes(size)}`;
    return `<div class="export-item">
      <div>
        <strong>${RANGE_LABEL[kind]}</strong>
        <span>${escapeHtml(rangeFileName(range, kind))}</span>
        <span>${valid ? label : '—'}</span>
      </div>
      <button class="btn" type="button" data-range="${kind}"
        ${!valid || state.busy ? 'disabled' : ''}>${busy ? `${Math.round(state.progress)}%` : '저장'}</button>
    </div>`;
  }).join('');

  el.innerHTML = `
    <p class="section-title">구간 지정</p>
    <div class="rng-grid">
      <label class="rng-row">
        <span class="rng-tag">시작</span>
        <input class="select rng-time" type="time" step="1" id="rng-from" value="${hhmmss(range.fromMs)}" />
        <button class="btn btn-sm" type="button" data-now="from">지금</button>
      </label>
      <label class="rng-row">
        <span class="rng-tag">끝</span>
        <input class="select rng-time" type="time" step="1" id="rng-to" value="${hhmmss(range.toMs)}" />
        <button class="btn btn-sm" type="button" data-now="to">지금</button>
      </label>
    </div>
    <div class="rng-presets">
      <button class="btn btn-sm" type="button" data-preset="file">현재 파일</button>
      <button class="btn btn-sm" type="button" data-preset="session">이 운행 전체</button>
      <button class="btn btn-sm" type="button" data-preset="1">시작+1분</button>
      <button class="btn btn-sm" type="button" data-preset="5">시작+5분</button>
      <button class="btn btn-sm" type="button" data-preset="10">시작+10분</button>
    </div>
    <p class="rng-sum${valid ? '' : ' status-warn'}">
      ${valid
        ? `${escapeHtml(formatRecordedTime(range.fromMs, false))} ~ ${escapeHtml(hhmmss(range.toMs))}
           · <strong>${escapeHtml(formatDurationKo(durationMs / 1000))}</strong> · 원본 ${num(hit.length)}개 파일`
        : durationMs <= 0 ? '끝이 시작보다 빠릅니다' : '이 시간에 해당하는 영상이 없습니다'}
    </p>

    ${state.busy
      ? `<div class="progress"><div class="progress-bar" style="width:${state.progress}%"></div></div>
         <p class="muted small" style="margin:6px 2px 10px">${escapeHtml(state.progressNote)}</p>`
      : ''}

    <p class="section-title">구간 내보내기</p>
    <div class="export-list">${rows}</div>
    <div class="note">
      영상은 <strong>다시 인코딩하지 않습니다.</strong> 그래서 시작 지점 직전 키프레임까지
      거슬러 올라가며, 파일이 요청한 시각보다 <strong>몇 초 이르게 시작할 수 있습니다.</strong>
      실제 시작 시각은 저장할 때 알려 드립니다.
      <br>파일명은 <code>YYMMDD_HHMMSS-HHMMSS_종류</code>입니다. CSV에는 각 줄이 어느 원본
      파일에서 왔는지가 함께 들어갑니다.
    </div>`;

  el.querySelectorAll<HTMLButtonElement>('[data-now]').forEach((b) => {
    b.addEventListener('click', () => h.onPickNow(b.dataset.now as 'from' | 'to'));
  });
  el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.preset!;
      h.onPreset(v === 'file' || v === 'session' ? v : (Number(v) as 1 | 5 | 10));
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => {
    b.addEventListener('click', () => h.onExport(b.dataset.range as RangeKind));
  });
  for (const edge of ['from', 'to'] as const) {
    el.querySelector<HTMLInputElement>(`#rng-${edge}`)?.addEventListener('change', (e) => {
      h.onEditTime(edge, (e.target as HTMLInputElement).value);
    });
  }
}

function estimateRows(segments: SegmentInfo[], range: TimeRange, kind: RangeKind): number {
  let n = 0;
  for (const s of segmentsInRange(segments, range)) {
    const overlap = Math.min(s.endMs, range.toMs) - Math.max(s.startMs, range.fromMs);
    if (overlap <= 0) continue;
    const share = s.durationMs > 0 ? overlap / s.durationMs : 1;
    n += (kind === 'gps' ? s.gpsCount : s.sensorCount) * share;
  }
  return Math.round(n);
}
