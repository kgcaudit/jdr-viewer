/**
 * 동선 대조 패널.
 *
 * 휴대폰 위치기록(도와줘 txt)을 올리면, 그날 차량 GPS(뷰어가 스캔으로 모아
 * 둔 session.records.gps)와 같은 시간축에 맞춰 각 시간대를 "이 차량 주행 /
 * 보행 / 다른 이동 / 체류"로 가른다.
 *
 * 개인정보: 휴대폰 원본은 브라우저 안에서만 파싱·대조되고 밖으로 나가지 않는다.
 */
import type { PhoneFix } from '../core/phone-track';
import type { MatchResult, TrackClass } from '../core/track-match';
import { CLASS_LABEL } from '../core/track-match';
import { formatDurationKo, formatRecordedTime } from '../core/time';
import { escapeHtml, num } from './format';

export interface TrackPanelState {
  /** 올린 휴대폰 위치 (없으면 아직 안 올림) */
  phone: PhoneFix[] | null;
  /** 그날 차량 GPS 개수 (뷰어 스캔 결과) */
  carGpsCount: number;
  /** 차량 스캔이 끝났는가 — 진행 중이면 결과가 늘어날 수 있다 */
  scanDone: boolean;
  /** 대조 결과 (휴대폰·차량 둘 다 있을 때) */
  match: MatchResult | null;
  /** 폴더를 연 상태인가 (안 열었으면 차량 GPS 자체가 없다) */
  hasSession: boolean;
}

export interface TrackPanelHandlers {
  onLoadFile(): void;
  onExportCsv(): void;
  onClear(): void;
}

const ORDER: TrackClass[] = ['in_vehicle_this', 'walking', 'moving_other', 'stationary', 'unknown'];
const CLASS_COLOR: Record<TrackClass, string> = {
  in_vehicle_this: '#2b6cb0',
  walking: '#2f855a',
  moving_other: '#b7791f',
  stationary: '#718096',
  unknown: '#a0aec0',
};

function minutes(ms: number): string {
  return formatDurationKo(ms / 1000);
}

/** 표에 다 뿌리면 수천 줄이라 느리다. 분류가 바뀌는 '구간'으로 접어 보여준다. */
interface Segment { klass: TrackClass; fromMs: number; toMs: number; points: number; distM: number; }
function foldSegments(m: MatchResult): Segment[] {
  const segs: Segment[] = [];
  for (const p of m.points) {
    const last = segs[segs.length - 1];
    if (last && last.klass === p.klass) {
      last.toMs = p.timeMs;
      last.points++;
      last.distM += 0; // 거리는 아래에서 별도로 채우지 않는다(요약에 이미 있음)
    } else {
      segs.push({ klass: p.klass, fromMs: p.timeMs, toMs: p.timeMs, points: 1, distM: 0 });
    }
  }
  return segs;
}

export function renderTrackPanel(el: HTMLElement, s: TrackPanelState, h: TrackPanelHandlers): void {
  const clock = (ms: number): string => formatRecordedTime(ms, false).slice(11, 16);
  const date = (ms: number): string => formatRecordedTime(ms, false).slice(0, 10);

  const intro = `<p class="section-title">동선 대조</p>
    <p class="muted small" style="margin:0 0 10px">휴대폰 위치기록(도와줘)을 올리면 그날 차량 GPS와 맞춰
    <strong>주행·보행·체류</strong>를 가려 줍니다. 휴대폰 원본은 이 브라우저 안에서만 처리됩니다.</p>`;

  const loadBtn = `<div class="track-actions">
      <button class="btn btn-primary" type="button" id="track-load">위치기록 파일 올리기</button>
      ${s.phone ? '<button class="btn" type="button" id="track-clear">지우기</button>' : ''}
    </div>`;

  if (!s.phone) {
    el.innerHTML = intro + loadBtn +
      `<p class="muted small" style="margin-top:12px">아직 올린 파일이 없습니다.
       도와줘 위치기록 응답(<code>.txt</code>)을 올리세요.</p>`;
    wire(el, h);
    return;
  }

  // 차량 GPS 상태
  let carNote = '';
  if (!s.hasSession) {
    carNote = `<p class="status-warn small">폴더를 열고 날짜를 선택해야 차량 GPS와 맞출 수 있습니다.
      지금은 휴대폰 동선만 보여줍니다.</p>`;
  } else if (s.carGpsCount === 0) {
    carNote = `<p class="status-warn small">이 운행의 차량 GPS를 아직 못 읽었습니다
      (지도 탭에서 스캔이 끝나길 기다리세요).</p>`;
  } else if (!s.scanDone) {
    carNote = `<p class="muted small">차량 GPS 스캔이 진행 중입니다 (${num(s.carGpsCount)}건까지) —
      끝나면 판정이 더 정확해집니다.</p>`;
  } else {
    carNote = `<p class="muted small">차량 GPS ${num(s.carGpsCount)}건과 대조했습니다.</p>`;
  }

  const m = s.match;
  const start = s.phone[0].timeMs;
  const end = s.phone[s.phone.length - 1].timeMs;
  const head = `<p class="track-head"><strong>${escapeHtml(date(start))}</strong>
      · ${escapeHtml(clock(start))}~${escapeHtml(clock(end))}
      · 휴대폰 ${num(s.phone.length)}점</p>`;

  let summary = '';
  let table = '';
  if (m) {
    const total = m.summary.spanTotalMs || 1;
    summary = `<div class="track-bars">` + ORDER.map((k) => {
      const st = m.summary.byClass[k];
      if (st.points === 0) return '';
      const pct = Math.round((st.spanMs / total) * 100);
      return `<div class="track-bar">
        <span class="track-dot" style="background:${CLASS_COLOR[k]}"></span>
        <span class="track-bar-label">${CLASS_LABEL[k]}</span>
        <span class="track-bar-fill"><span style="width:${pct}%;background:${CLASS_COLOR[k]}"></span></span>
        <span class="track-bar-val">${minutes(st.spanMs)} · ${pct}%</span>
      </div>`;
    }).join('') + `</div>`;

    const segs = foldSegments(m).filter((g) => g.toMs > g.fromMs || g.points > 1);
    table = `<div class="track-table-wrap"><table class="track-table">
      <thead><tr><th>시각</th><th>구분</th><th>점</th></tr></thead>
      <tbody>` + segs.map((g) => `<tr>
        <td class="tnum">${escapeHtml(clock(g.fromMs))}~${escapeHtml(clock(g.toMs))}</td>
        <td><span class="track-dot" style="background:${CLASS_COLOR[g.klass]}"></span>${CLASS_LABEL[g.klass]}</td>
        <td class="tnum">${num(g.points)}</td>
      </tr>`).join('') + `</tbody></table></div>`;
  }

  const exportBtn = m
    ? `<button class="btn" type="button" id="track-export">대조 결과 CSV 내보내기</button>`
    : '';

  el.innerHTML = intro + loadBtn + head + carNote + summary + table +
    (exportBtn ? `<div class="track-actions" style="margin-top:10px">${exportBtn}</div>` : '');
  wire(el, h);
}

function wire(el: HTMLElement, h: TrackPanelHandlers): void {
  el.querySelector('#track-load')?.addEventListener('click', () => h.onLoadFile());
  el.querySelector('#track-clear')?.addEventListener('click', () => h.onClear());
  el.querySelector('#track-export')?.addEventListener('click', () => h.onExportCsv());
}

/** 대조 결과를 CSV로 (감사 근거로 쓰도록 원 좌표·판정을 모두 남긴다) */
export function trackMatchCsv(m: MatchResult): string {
  const head = ['시각', '위도', '경도', '구분', '활동유형', '이동속도_kmh', '차량거리_m', '정확도_m'];
  const rows = m.points.map((p) => [
    formatRecordedTime(p.timeMs, false),
    p.lat.toFixed(6), p.lon.toFixed(6),
    CLASS_LABEL[p.klass], p.activity,
    Number.isFinite(p.moveKmh) ? p.moveKmh.toFixed(1) : '',
    Number.isFinite(p.carDistM) ? Math.round(p.carDistM).toString() : '',
    Math.round(p.accuracyM).toString(),
  ]);
  const esc = (v: string): string => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(',')).join('\r\n') + '\r\n';
}
