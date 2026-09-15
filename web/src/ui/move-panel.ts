/**
 * 이동기록 공간 UI — 날짜 목록과 날짜별 상세.
 *
 * 블랙박스(재생) 공간과 분리된 별도 공간이다. 휴대폰 위치기록을 올려
 * 날짜별로 관리하고, 그날 동선을 지도·요약으로 본다. 대조(블랙박스와 겹치기)는
 * 상세 화면에서 별도 동작으로 부른다.
 */
import type { MoveDay, MoveDaySummary } from '../core/move-store';
import type { MatchResult, TrackClass } from '../core/track-match';
import { CLASS_LABEL } from '../core/track-match';
import { formatDurationKo, formatRecordedTime, formatShortDate } from '../core/time';
import { escapeHtml, num } from './format';

const ORDER: TrackClass[] = ['in_vehicle_this', 'walking', 'moving_other', 'stationary', 'unknown'];
export const MOVE_CLASS_COLOR: Record<TrackClass, string> = {
  in_vehicle_this: '#2b6cb0',
  walking: '#2f855a',
  moving_other: '#b7791f',
  stationary: '#718096',
  unknown: '#a0aec0',
};

const clock = (ms: number): string => formatRecordedTime(ms, false).slice(11, 16);

export interface MoveListHandlers {
  onUpload(): void;
  onImport(): void;
  onExport(): void;
  onOpenDay(dayKey: string): void;
}

/** 날짜 목록 */
export function renderMoveList(el: HTMLElement, days: MoveDaySummary[], persistent: boolean, h: MoveListHandlers): void {
  const warn = persistent ? '' :
    `<p class="status-warn small">이 브라우저에서는 자동 저장을 못 씁니다(시크릿/ file://).
     파일로 내보내 두세요.</p>`;

  const rows = days.length === 0
    ? `<p class="muted small" style="margin-top:14px">아직 올린 이동기록이 없습니다.
       <strong>위치기록 올리기</strong>로 도와줘 파일(.txt)을 올리세요. 여러 파일을 한 번에 고를 수 있습니다.</p>`
    : `<ul class="move-days">` + days.map((d) => `<li>
        <button class="move-day" type="button" data-day="${escapeHtml(d.dayKey)}">
          <span class="move-day-date">${escapeHtml(formatShortDate(d.dayKey))}</span>
          <span class="move-day-meta">${num(d.count)}점 · ${escapeHtml(clock(d.startMs))}~${escapeHtml(clock(d.endMs))}</span>
          <span class="move-day-src muted">${escapeHtml(d.sources.join(', ') || '—')}</span>
        </button>
      </li>`).join('') + `</ul>`;

  el.innerHTML = `
    ${warn}
    <div class="move-actions">
      <button class="btn btn-primary" type="button" id="move-upload">위치기록 올리기</button>
      <button class="btn" type="button" id="move-import">파일에서 불러오기</button>
      ${days.length > 0 ? '<button class="btn" type="button" id="move-export">파일로 저장</button>' : ''}
    </div>
    ${rows}`;

  el.querySelector('#move-upload')?.addEventListener('click', () => h.onUpload());
  el.querySelector('#move-import')?.addEventListener('click', () => h.onImport());
  el.querySelector('#move-export')?.addEventListener('click', () => h.onExport());
  el.querySelectorAll<HTMLButtonElement>('[data-day]').forEach((b) => {
    b.addEventListener('click', () => h.onOpenDay(b.dataset.day ?? ''));
  });
}

export interface MoveDayHandlers {
  onBack(): void;
  onCompare(): void;
  onExportCsv(): void;
  onDelete(): void;
}

interface Seg { klass: TrackClass; fromMs: number; toMs: number; points: number; }
function foldSegments(m: MatchResult): Seg[] {
  const segs: Seg[] = [];
  for (const p of m.points) {
    const last = segs[segs.length - 1];
    if (last && last.klass === p.klass) { last.toMs = p.timeMs; last.points++; }
    else segs.push({ klass: p.klass, fromMs: p.timeMs, toMs: p.timeMs, points: 1 });
  }
  return segs;
}

/**
 * 날짜별 상세.
 * @param compared 블랙박스 차량 GPS와 대조했는가 (안 했으면 '이 차량 주행'은 안 나온다)
 */
export function renderMoveDay(
  el: HTMLElement, day: MoveDay, m: MatchResult, compared: boolean, h: MoveDayHandlers,
): void {
  const start = day.points.length ? day.points[0].t : NaN;
  const end = day.points.length ? day.points[day.points.length - 1].t : NaN;

  const total = m.summary.spanTotalMs || 1;
  const bars = `<div class="track-bars">` + ORDER.map((k) => {
    const st = m.summary.byClass[k];
    if (st.points === 0) return '';
    const pct = Math.round((st.spanMs / total) * 100);
    return `<div class="track-bar">
      <span class="track-dot" style="background:${MOVE_CLASS_COLOR[k]}"></span>
      <span class="track-bar-label">${CLASS_LABEL[k]}</span>
      <span class="track-bar-fill"><span style="width:${pct}%;background:${MOVE_CLASS_COLOR[k]}"></span></span>
      <span class="track-bar-val">${formatDurationKo(st.spanMs / 1000)} · ${pct}%</span>
    </div>`;
  }).join('') + `</div>`;

  const segs = foldSegments(m).filter((g) => g.toMs > g.fromMs || g.points > 1);
  const table = `<div class="track-table-wrap"><table class="track-table">
    <thead><tr><th>시각</th><th>구분</th><th>점</th></tr></thead><tbody>` +
    segs.map((g) => `<tr>
      <td class="tnum">${escapeHtml(clock(g.fromMs))}~${escapeHtml(clock(g.toMs))}</td>
      <td><span class="track-dot" style="background:${MOVE_CLASS_COLOR[g.klass]}"></span>${CLASS_LABEL[g.klass]}</td>
      <td class="tnum">${num(g.points)}</td>
    </tr>`).join('') + `</tbody></table></div>`;

  const compareNote = compared
    ? `<p class="muted small">블랙박스 차량 GPS와 대조했습니다.</p>`
    : `<p class="muted small">아직 차량과 대조하지 않았습니다 — <strong>블랙박스와 대조</strong>를 누르면
       같은 날짜 차량 GPS를 끌어와 "이 차량 주행"까지 가립니다.</p>`;

  el.innerHTML = `
    <div class="move-detail-head">
      <button class="btn btn-sm" type="button" id="move-day-back">‹ 목록</button>
      <strong>${escapeHtml(formatShortDate(day.dayKey))}</strong>
      <span class="muted small">${num(day.points.length)}점 · ${escapeHtml(clock(start))}~${escapeHtml(clock(end))}</span>
    </div>
    <div id="move-map" class="map"></div>
    <div class="map-bar">
      <p class="muted small" style="margin:0">${escapeHtml(day.sources.join(', ') || '')}</p>
      <span class="map-acts">
        <button class="btn btn-sm" type="button" id="move-fit">전체 경로</button>
        <button class="btn btn-sm" type="button" id="move-compare">블랙박스와 대조</button>
      </span>
    </div>
    ${compareNote}
    ${bars}
    ${table}
    <div class="move-actions" style="margin-top:10px">
      <button class="btn" type="button" id="move-export-csv">대조 결과 CSV</button>
      <button class="btn" type="button" id="move-delete">이 날짜 지우기</button>
    </div>`;

  el.querySelector('#move-day-back')?.addEventListener('click', () => h.onBack());
  el.querySelector('#move-compare')?.addEventListener('click', () => h.onCompare());
  el.querySelector('#move-export-csv')?.addEventListener('click', () => h.onExportCsv());
  el.querySelector('#move-delete')?.addEventListener('click', () => h.onDelete());
}
