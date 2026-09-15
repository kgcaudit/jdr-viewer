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
import type { Stay } from '../core/stays';
import { staysSummary } from '../core/stays';
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

/** 체류(머문 곳) — 감사에서 가장 눈에 띄어야 하는 정보라 카드로 도드라지게 그린다. */
function staysBlock(stays: Stay[]): string {
  if (stays.length === 0) {
    return `<section class="stay-block stay-empty">
      <div class="stay-head"><span class="stay-ic" aria-hidden="true">📍</span>
        <h4 class="stay-h">머문 곳</h4></div>
      <p class="muted small" style="margin:0">한 자리에 5분 이상 머문 구간이 없습니다.</p>
    </section>`;
  }
  const sum = staysSummary(stays);
  const items = stays.map((s, i) => `<li class="stay-item">
      <button type="button" class="stay-rank" data-stay-focus="${i}" title="지도에서 이 지점 보기" aria-label="지도에서 ${num(i + 1)}번 지점 보기">${num(i + 1)}</button>
      <div class="stay-body">
        <div class="stay-dur">${escapeHtml(formatDurationKo(s.durationMs / 1000))}</div>
        <div class="stay-place" data-stay-place="${i}"${s.place ? '' : ' hidden'}>${s.place ? escapeHtml(s.place) : ''}</div>
        <div class="stay-meta tnum">${escapeHtml(clock(s.fromMs))} ~ ${escapeHtml(clock(s.toMs))}</div>
        <div class="stay-where" data-stay-where="${i}">${s.addr ? escapeHtml(s.addr) : `<span class="muted">주소 조회 중…</span>`}</div>
      </div>
    </li>`).join('');
  return `<section class="stay-block">
    <div class="stay-head">
      <span class="stay-ic" aria-hidden="true">📍</span>
      <h4 class="stay-h">머문 곳</h4>
      <span class="stay-sum">${num(sum.places)}곳 · 총 ${escapeHtml(formatDurationKo(sum.totalMs / 1000))}</span>
    </div>
    <ol class="stay-list">${items}</ol>
    <p class="stay-note muted small">주소는 지도 서비스 리버스 지오코딩입니다(호스팅 시 카카오 도로명, 그 외 OSM) — 체류 좌표가 전송됩니다.</p>
  </section>`;
}

export interface MoveListHandlers {
  onOpenDay(dayKey: string): void;
}

/** 날짜 목록. 올리기·저장 등 동작은 상단바에 있으므로 여기선 목록만 그린다. */
export function renderMoveList(el: HTMLElement, days: MoveDaySummary[], persistent: boolean, h: MoveListHandlers): void {
  const warn = persistent ? '' :
    `<p class="status-warn small">이 브라우저에서는 자동 저장을 못 씁니다(시크릿/ file://).
     상단 ⋯의 <strong>파일로 저장</strong>으로 내보내 두세요.</p>`;

  const rows = days.length === 0
    ? `<p class="muted small" style="margin-top:14px">아직 올린 이동기록이 없습니다.
       상단 <strong>⋯ → 파일 열기</strong> 또는 <strong>폴더 열기</strong>로 도와줘 기록(.txt)·차량 CSV를 여세요.</p>`
    : `<ul class="move-days">` + days.map((d) => `<li>
        <button class="move-day" type="button" data-day="${escapeHtml(d.dayKey)}">
          <span class="move-day-date">${escapeHtml(formatShortDate(d.dayKey))}</span>
          <span class="move-day-meta">${num(d.count)}점 · ${escapeHtml(clock(d.startMs))}~${escapeHtml(clock(d.endMs))}</span>
          <span class="move-day-src muted">${escapeHtml(d.sources.join(', ') || '—')}</span>
        </button>
      </li>`).join('') + `</ul>`;

  el.innerHTML = warn + rows;

  el.querySelectorAll<HTMLButtonElement>('[data-day]').forEach((b) => {
    b.addEventListener('click', () => h.onOpenDay(b.dataset.day ?? ''));
  });
}

interface Seg { klass: TrackClass; fromMs: number; toMs: number; points: number; }
function foldSegments(m: MatchResult): Seg[] {
  const segs: Seg[] = [];
  for (const p of m.points) {
    // 체류 점(원본 staytime)은 점 하나가 [도착, 도착+staytime] 구간을 대표한다.
    // 그래야 타임테이블에 "17:46~21:24 체류"처럼 폭이 있는 줄로 남는다(안 그러면 걸러짐).
    const end = p.klass === 'stationary' && p.stayMs > 0 ? p.timeMs + p.stayMs : p.timeMs;
    const last = segs[segs.length - 1];
    if (last && last.klass === p.klass) { last.toMs = Math.max(last.toMs, end); last.points++; }
    else segs.push({ klass: p.klass, fromMs: p.timeMs, toMs: end, points: 1 });
  }
  return segs;
}

/**
 * 날짜별 상세. 목록·대조·CSV·삭제는 상단바에 있으므로 여기선 지도·요약만 그린다.
 * @param compared 블랙박스 차량 GPS와 대조했는가 (안 했으면 '이 차량 주행'은 안 나온다)
 */
export function renderMoveDay(
  el: HTMLElement, day: MoveDay, m: MatchResult, compared: boolean, stays: Stay[],
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
    : `<p class="muted small">아직 차량과 대조하지 않았습니다 — 상단 <strong>⋯ → 차량 GPS(CSV) 불러오기</strong>로
       그날 블랙박스 GPS를 올리면(또는 블랙박스를 한 번 스캔) "이 차량 주행"까지 가립니다.</p>`;

  el.innerHTML = `
    <div class="move-detail-head">
      <strong>${escapeHtml(formatShortDate(day.dayKey))}</strong>
      <span class="muted small">${num(day.points.length)}점 · ${escapeHtml(clock(start))}~${escapeHtml(clock(end))}</span>
    </div>
    <div id="move-map" class="map"></div>
    <div class="move-scrub">
      <input id="move-seek" class="seek" type="range" min="0" max="1000" value="0" aria-label="시각으로 위치 보기" />
      <span id="move-seek-time" class="move-seek-time tnum">${escapeHtml(formatRecordedTime(start, false).slice(11, 19))}</span>
    </div>
    <div class="map-bar">
      <p class="muted small" style="margin:0"><span id="map-src"></span>${escapeHtml(day.sources.join(', ') || '')} · 경로를 눌러 시각을 봅니다</p>
      <span class="map-acts">
        <button class="btn btn-sm" type="button" id="move-fit">전체 경로</button>
      </span>
    </div>
    ${compareNote}
    ${staysBlock(stays)}
    ${bars}
    ${table}`;
}

// ── 전체 요약(여러 날짜 한눈에) ─────────────────────

/** 하루 분석 요약 (전체 요약 화면·CSV용) */
export interface DayOverview {
  dayKey: string;
  count: number;
  startMs: number;
  endMs: number;
  hasCar: boolean;
  classMs: Record<TrackClass, number>;
  spanTotal: number;
  stays: number;
  stayMs: number;
}

function zeroClass(): Record<TrackClass, number> {
  return { in_vehicle_this: 0, walking: 0, moving_other: 0, stationary: 0, unknown: 0 };
}
const durKo = (ms: number): string => formatDurationKo(ms / 1000);

/** 구분 비율을 가로 막대 하나로 (색은 지도·상세와 같은 팔레트) */
function miniBar(cm: Record<TrackClass, number>, total: number): string {
  const segs = ORDER.filter((k) => cm[k] > 0).map((k) =>
    `<span style="width:${((cm[k] / total) * 100).toFixed(1)}%;background:${MOVE_CLASS_COLOR[k]}" title="${CLASS_LABEL[k]}"></span>`).join('');
  return `<div class="ov-bar">${segs || '<span style="width:100%;background:var(--surface-2)"></span>'}</div>`;
}

/** 여러 날짜 분석을 한 화면에. 날짜를 누르면 그 날 상세로. */
export function renderMoveOverview(el: HTMLElement, list: DayOverview[], h: MoveListHandlers): void {
  if (list.length === 0) {
    el.innerHTML = `<p class="muted small" style="margin-top:14px">분석할 이동기록이 없습니다. 먼저 ⋯로 도와줘 파일과 차량 CSV를 올리세요.</p>`;
    return;
  }
  const tot = zeroClass();
  let totStay = 0; let totStays = 0; let carDays = 0;
  for (const d of list) {
    for (const k of ORDER) tot[k] += d.classMs[k];
    totStay += d.stayMs; totStays += d.stays; if (d.hasCar) carDays++;
  }
  const grand = ORDER.reduce((s, k) => s + tot[k], 0) || 1;

  const legend = ORDER.filter((k) => tot[k] > 0).map((k) =>
    `<span class="ov-leg"><span class="track-dot" style="background:${MOVE_CLASS_COLOR[k]}"></span>${CLASS_LABEL[k]} ${durKo(tot[k])}</span>`).join('');

  const cards = list.map((d) => {
    const span = d.spanTotal || 1;
    const carBadge = d.hasCar
      ? `<span class="ov-car ov-car-on">차량 대조됨</span>`
      : `<span class="ov-car ov-car-off">차량 없음</span>`;
    const other = d.classMs.moving_other;
    return `<button class="ov-day" type="button" data-day="${escapeHtml(d.dayKey)}">
      <div class="ov-day-top">
        <strong>${escapeHtml(formatShortDate(d.dayKey))}</strong>
        ${carBadge}
        <span class="muted small">${num(d.count)}점 · ${escapeHtml(clock(d.startMs))}~${escapeHtml(clock(d.endMs))}</span>
      </div>
      ${miniBar(d.classMs, span)}
      <div class="ov-day-meta">
        ${d.hasCar ? `<span>이 차량 주행 <b>${durKo(d.classMs.in_vehicle_this)}</b></span>` : ''}
        <span class="ov-hot">차량 없이 이동 <b>${durKo(other)}</b></span>
        <span>머문곳 ${num(d.stays)}곳 · ${durKo(d.stayMs)}</span>
      </div>
    </button>`;
  }).join('');

  el.innerHTML = `
    <div class="ov-head"><strong>전체 요약</strong> <span class="muted small">${num(list.length)}일 · 차량 대조 ${num(carDays)}일</span></div>
    <div class="ov-total">
      ${miniBar(tot, grand)}
      <div class="ov-legend">${legend}</div>
      <p class="muted small" style="margin:6px 0 0">머문곳 합계 ${num(totStays)}곳 · ${durKo(totStay)} · 날짜를 누르면 그날 상세로</p>
    </div>
    <div class="ov-days">${cards}</div>`;

  el.querySelectorAll<HTMLButtonElement>('[data-day]').forEach((b) => {
    b.addEventListener('click', () => h.onOpenDay(b.dataset.day ?? ''));
  });
}

/** 전체 요약을 CSV로 (날짜별 구분 시간·차량유무·머문곳) */
export function overviewCsv(list: DayOverview[]): string {
  const head = ['날짜', '점수', '시작', '끝', '차량GPS', '이차량주행_분', '다른이동_분', '보행_분', '체류_분', '머문곳', '총체류_분'];
  const m = (ms: number): number => Math.round(ms / 60000);
  const rows = list.map((d) => [
    d.dayKey, d.count, clock(d.startMs), clock(d.endMs), d.hasCar ? 'Y' : 'N',
    m(d.classMs.in_vehicle_this), m(d.classMs.moving_other), m(d.classMs.walking), m(d.classMs.stationary),
    d.stays, m(d.stayMs),
  ]);
  const esc = (v: string): string => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(',')).join('\r\n') + '\r\n';
}

/** 대조 결과를 CSV로 (감사 근거: 원 좌표·판정을 모두 남긴다) */
export function trackMatchCsv(m: MatchResult): string {
  const head = ['시각', '위도', '경도', '구분', '활동유형', '체류시간_초', '이동속도_kmh', '차량거리_m', '정확도_m'];
  const rows = m.points.map((p) => [
    formatRecordedTime(p.timeMs, false),
    p.lat.toFixed(6), p.lon.toFixed(6),
    CLASS_LABEL[p.klass], p.activity,
    p.stayMs ? Math.round(p.stayMs / 1000).toString() : '',
    Number.isFinite(p.moveKmh) ? p.moveKmh.toFixed(1) : '',
    Number.isFinite(p.carDistM) ? Math.round(p.carDistM).toString() : '',
    Math.round(p.accuracyM).toString(),
  ]);
  const esc = (v: string): string => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(',')).join('\r\n') + '\r\n';
}
