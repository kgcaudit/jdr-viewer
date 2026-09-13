/**
 * 구간(세그먼트) 목록과 타임라인 스트립.
 *
 * 증거 추적성 원칙: 병합은 보기 편하게 만드는 것일 뿐이므로
 * 어느 시각이 어느 파일에서 왔는지 항상 되짚을 수 있어야 한다.
 */
import { isEventFolder, type Gap, type Library } from '../core/library';
import type { SegmentInfo } from '../core/segment';
import { StripLayout } from '../core/strip-layout';
import { formatDuration, formatRecordedTime } from '../core/time';
import { bytes, escapeHtml, num } from './format';

const TIME_SOURCE_LABEL: Record<string, string> = {
  header: '헤더',
  packets: '패킷',
  filename: '파일명',
  unknown: '미상',
};

export interface FolderStat {
  folder: string;
  count: number;
  bytes: number;
  durationMs: number;
  selected: boolean;
}

/** 구간 하나가 화면에서 최소한 이만큼은 되어야 손가락으로 겨냥할 수 있다 */
const MIN_SEGMENT_PX = 7;
/** 빈 구간은 "있다"는 걸 알릴 정도만 — 길이에 비례하되 이보다 얇아지지 않게 */
const MIN_GAP_PX = 2;

/**
 * 타임라인 스트립을 그린다.
 * 축은 벽시계 비율이 아니라 "빈 구간을 눌러 담은" 비율이다 (strip-layout.ts 참조).
 *
 * 최소 폭은 퍼센트가 아니라 **픽셀 기준**으로 잡는다. 예전에는 `max(0.25%)`였는데
 * 390px 화면에서 0.25%는 1px이라 아무 의미가 없었다.
 */
export function renderStrip(track: HTMLElement, lib: Library): StripLayout | null {
  if (lib.segments.length === 0) {
    track.innerHTML = '';
    return null;
  }
  // 아직 화면에 안 붙었으면 폭을 모른다 — 그때는 최소 폭 보정을 건너뛴다
  const trackPx = track.clientWidth || 0;
  const minFrac = trackPx > 0 ? MIN_SEGMENT_PX / trackPx : 0;

  const layout = new StripLayout(lib, minFrac, trackPx > 0 ? MIN_GAP_PX / trackPx : 0);
  const parts: string[] = [];
  for (const it of layout.items) {
    const left = it.from * 100;
    const width = (it.to - it.from) * 100;
    if (it.kind === 'segment') {
      const s = lib.segments[it.index];
      const evt = isEventFolder(s.folder);
      parts.push(`<span class="strip-seg${evt ? ' is-event' : ''}" data-seg="${it.index}" style="left:${left}%;width:${width}%" title="${escapeHtml(
        `${evt ? '[이벤트] ' : ''}${s.name}\n${formatRecordedTime(s.startMs, false)} ~ ${formatRecordedTime(s.endMs, false)}`,
      )}"></span>`);
    } else {
      const g = lib.gaps[it.index];
      // 빈 구간은 숨기지 않는다 — 녹화 공백도 사실이다. 폭은 실제 길이에 비례한다.
      parts.push(`<span class="strip-gap" style="left:${left}%;width:${width}%" title="${escapeHtml(
        `빈 구간 ${formatDuration(g.durationMs / 1000)}\n${formatRecordedTime(g.fromMs, false)} ~ ${formatRecordedTime(g.toMs, false)}\n${gapCause(g)}`,
      )}"></span>`);
    }
  }
  parts.push('<span id="strip-cursor" class="strip-cursor" style="left:0%"></span>');
  track.innerHTML = parts.join('');
  return layout;
}

/** 여는 중인 구간을 맥동시킨다 — 눌렀다는 사실이 손가락 근처에서 보여야 한다 */
export function markLoadingSegment(track: HTMLElement, index: number): void {
  track.querySelectorAll('.strip-seg').forEach((el) => {
    el.classList.toggle('is-loading', Number((el as HTMLElement).dataset.seg) === index);
  });
}

export function updateStripCursor(track: HTMLElement, layout: StripLayout | null, absMs: number): void {
  const cursor = track.querySelector<HTMLElement>('#strip-cursor');
  if (!cursor || !layout) return;
  cursor.style.left = `${(layout.ratioAt(absMs) * 100).toFixed(3)}%`;
}

export function markActiveSegment(track: HTMLElement, index: number): void {
  track.querySelectorAll('.strip-seg').forEach((el) => {
    el.classList.toggle('is-active', Number((el as HTMLElement).dataset.seg) === index);
  });
}

/**
 * 빈 구간의 성격을 가른다.
 *
 * 파일 번호가 건너뛰었으면 **파일이 실제로 없는 것**이고(덮어썼거나 지워졌다),
 * 번호가 이어지는데도 시간이 비면 **기록이 끊겼거나 시각이 어긋난 것**이다.
 * 둘은 원인도 대응도 완전히 다르므로 반드시 구분해서 보여 준다.
 */
export function gapCause(g: Gap): string {
  if (g.numberSkip > 0) return `파일 ${num(g.numberSkip)}개 없음 (${g.beforeName} → ${g.afterName})`;
  if (g.numberSkip === 0) return `파일 번호는 이어짐 (${g.beforeName} → ${g.afterName}) — 기록 끊김`;
  return `${g.beforeName} → ${g.afterName}`;
}

function gapSection(gaps: Gap[]): string {
  const totalMs = gaps.reduce((a, g) => a + g.durationMs, 0);
  const missing = gaps.reduce((a, g) => a + Math.max(0, g.numberSkip), 0);
  const broken = gaps.filter((g) => g.numberSkip === 0).length;

  const head = [
    `빈 구간 ${num(gaps.length)}곳 · 합계 ${formatDuration(totalMs / 1000)}`,
    missing > 0 ? `파일 ${num(missing)}개 없음` : '',
    broken > 0 ? `번호는 이어지는데 끊긴 곳 ${num(broken)}곳` : '',
  ].filter(Boolean).join(' · ');

  const rows = gaps.slice(0, 60).map((g) => `<div class="gap-row${g.numberSkip > 0 ? ' is-missing' : ''}">
    <span class="gap-time">${formatRecordedTime(g.fromMs, false).slice(11, 19)} ~ ${formatRecordedTime(g.toMs, false).slice(11, 19)}</span>
    <span class="gap-dur">${formatDuration(g.durationMs / 1000)}</span>
    <span class="gap-why">${escapeHtml(gapCause(g))}</span>
  </div>`).join('');

  return `<p class="section-title">${escapeHtml(head)}</p>
    <div class="gap-list">${rows}${gaps.length > 60 ? `<p class="muted small">외 ${num(gaps.length - 60)}곳</p>` : ''}</div>
    <p class="muted small">파일 번호가 건너뛰면 <strong>그 파일이 실제로 없는 것</strong>입니다
      (덮어쓰기·삭제). 번호가 이어지는데도 비어 있으면 녹화가 끊겼거나 기록된 시각이 어긋난 것입니다.</p>`;
}

/**
 * 이벤트(충격) 구간.
 *
 * 감사에서는 "언제 충격이 있었나"가 가장 먼저 보고 싶은 정보다.
 * data의 사본이라 재생 줄기에서 뺀 것도 여기에는 반드시 남긴다.
 */
function eventSection(lib: Library): string {
  const rows = lib.events.slice(0, 60).map((e) => `<div class="evt-row">
    <span class="evt-time">${formatRecordedTime(e.fromMs, false).slice(11, 19)}</span>
    <span class="evt-dur">${formatDuration((e.toMs - e.fromMs) / 1000)}</span>
    <span class="evt-name">${escapeHtml(e.name)}</span>
    <span class="evt-why">${e.inChain ? 'data에 없는 구간을 채움' : 'data와 같은 시각 — 표시로만'}</span>
  </div>`).join('');

  const filled = lib.events.filter((e) => e.inChain).length;
  return `<p class="section-title">이벤트 ${num(lib.events.length)}건${filled > 0 ? ` · 이 중 ${num(filled)}건은 data에 없어 타임라인을 채웠습니다` : ''}</p>
    <div class="evt-list">${rows}${lib.events.length > 60 ? `<p class="muted small">외 ${num(lib.events.length - 60)}건</p>` : ''}</div>`;
}

function segmentRow(s: SegmentInfo, index: number, activeIndex: number): string {
  const flags: string[] = [];
  if (s.timeSource !== 'header') flags.push(`시각출처 ${TIME_SOURCE_LABEL[s.timeSource]}`);
  if (s.endEstimated) flags.push('길이 추정');
  if (Math.abs(s.headerShiftMs) >= 500) {
    flags.push(`헤더 시각 ${(s.headerShiftMs / 1000).toFixed(1)}초 어긋남`);
  }
  const evt = isEventFolder(s.folder);
  return `<button class="seg-row${index === activeIndex ? ' is-active' : ''}" data-open="${index}" type="button">
    <span class="seg-time">${formatRecordedTime(s.startMs, false)}</span>
    <span class="seg-main">
      <span class="seg-name">${evt ? '<span class="seg-evt">이벤트</span> ' : ''}${escapeHtml(s.name)}</span>
      <span class="seg-meta">${s.folder ? escapeHtml(s.folder) + ' · ' : ''}${formatDuration(s.durationMs / 1000)} · ${bytes(s.size)}${
        flags.length ? ' · ' + flags.join(' · ') : ''
      }</span>
    </span>
  </button>`;
}

export interface SegmentsPanelHandlers {
  onOpen(index: number): void;
  onToggleFolder(folder: string, selected: boolean): void;
}

export function renderSegments(
  el: HTMLElement,
  lib: Library,
  folders: FolderStat[],
  activeIndex: number,
  handlers: SegmentsPanelHandlers,
): void {
  const folderBox =
    folders.length > 1
      ? `<p class="section-title">폴더</p>
         <div class="folder-list">${folders
           .map(
             (f) => `<label class="folder-item">
               <input type="checkbox" data-folder="${escapeHtml(f.folder)}" ${f.selected ? 'checked' : ''} />
               <span><strong>${escapeHtml(f.folder || '(최상위)')}</strong>
               <span class="muted">${num(f.count)}개 · ${bytes(f.bytes)} · ${formatDuration(f.durationMs / 1000)}</span></span>
             </label>`,
           )
           .join('')}</div>
         <p class="muted small">기기는 한 번의 주행을 <strong>data(평상시)</strong>와
           <strong>event(충격)</strong>에 나눠 씁니다. 둘 다 켜 두어야 주행이 온전합니다.
           event가 data와 같은 시각을 담고 있으면 되풀이 재생되지 않도록 표시로만 남깁니다.</p>`
      : '';

  const invalidBox =
    lib.invalid.length > 0
      ? `<p class="section-title">읽지 못한 파일 ${num(lib.invalid.length)}개</p>
         <div class="invalid-list">${lib.invalid
           .slice(0, 30)
           .map((s) => `<div class="invalid-item"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(s.error ?? '')}</span></div>`)
           .join('')}${lib.invalid.length > 30 ? `<p class="muted small">외 ${num(lib.invalid.length - 30)}개</p>` : ''}</div>`
      : '';

  const gapBox = lib.gaps.length > 0 ? gapSection(lib.gaps) : '';
  const eventBox = lib.events.length > 0 ? eventSection(lib) : '';

  el.innerHTML = `
    ${folderBox}
    <p class="section-title">구간 ${num(lib.segments.length)}개</p>
    <div class="seg-list">${lib.segments.map((s, i) => segmentRow(s, i, activeIndex)).join('')}</div>
    ${eventBox}
    ${gapBox}
    ${invalidBox}
  `;

  el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
    b.addEventListener('click', () => handlers.onOpen(Number(b.dataset.open)));
  });
  el.querySelectorAll<HTMLInputElement>('[data-folder]').forEach((c) => {
    c.addEventListener('change', () => handlers.onToggleFolder(c.dataset.folder ?? '', c.checked));
  });
}

export function highlightSegmentRow(el: HTMLElement, index: number): void {
  el.querySelectorAll('.seg-row').forEach((row) => {
    const i = Number((row as HTMLElement).dataset.open);
    row.classList.toggle('is-active', i === index);
    if (i === index) row.scrollIntoView({ block: 'nearest' });
  });
}
