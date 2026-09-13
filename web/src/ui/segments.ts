/**
 * 구간(세그먼트) 목록과 타임라인 스트립.
 *
 * 증거 추적성 원칙: 병합은 보기 편하게 만드는 것일 뿐이므로
 * 어느 시각이 어느 파일에서 왔는지 항상 되짚을 수 있어야 한다.
 */
import type { Library } from '../core/library';
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

/**
 * 타임라인 스트립을 그린다.
 * 축은 벽시계 비율이 아니라 "빈 구간을 눌러 담은" 비율이다 (strip-layout.ts 참조).
 */
export function renderStrip(track: HTMLElement, lib: Library): StripLayout | null {
  if (lib.segments.length === 0) {
    track.innerHTML = '';
    return null;
  }
  const layout = new StripLayout(lib);
  const parts: string[] = [];
  for (const it of layout.items) {
    const left = it.from * 100;
    const width = Math.max(0.25, (it.to - it.from) * 100);
    if (it.kind === 'segment') {
      const s = lib.segments[it.index];
      parts.push(`<span class="strip-seg" data-seg="${it.index}" style="left:${left}%;width:${width}%" title="${escapeHtml(
        `${s.name}\n${formatRecordedTime(s.startMs, false)} ~ ${formatRecordedTime(s.endMs, false)}`,
      )}"></span>`);
    } else {
      const g = lib.gaps[it.index];
      // 빈 구간은 숨기지 않는다 — 녹화 공백도 사실이다. 다만 폭은 눌러 담는다.
      parts.push(`<span class="strip-gap" style="left:${left}%;width:${width}%" title="${escapeHtml(
        `빈 구간 ${formatDuration(g.durationMs / 1000)}\n${formatRecordedTime(g.fromMs, false)} ~ ${formatRecordedTime(g.toMs, false)}`,
      )}"></span>`);
    }
  }
  parts.push('<span id="strip-cursor" class="strip-cursor" style="left:0%"></span>');
  track.innerHTML = parts.join('');
  return layout;
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

function segmentRow(s: SegmentInfo, index: number, activeIndex: number): string {
  const flags: string[] = [];
  if (s.timeSource !== 'header') flags.push(`시각출처 ${TIME_SOURCE_LABEL[s.timeSource]}`);
  if (s.endEstimated) flags.push('길이 추정');
  return `<button class="seg-row${index === activeIndex ? ' is-active' : ''}" data-open="${index}" type="button">
    <span class="seg-time">${formatRecordedTime(s.startMs, false)}</span>
    <span class="seg-main">
      <span class="seg-name">${escapeHtml(s.name)}</span>
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
         <p class="muted small">체크한 폴더의 파일만 타임라인에 넣습니다. 같은 시각을 담은 폴더를 함께 넣으면 구간이 겹칩니다.</p>`
      : '';

  const invalidBox =
    lib.invalid.length > 0
      ? `<p class="section-title">읽지 못한 파일 ${num(lib.invalid.length)}개</p>
         <div class="invalid-list">${lib.invalid
           .slice(0, 30)
           .map((s) => `<div class="invalid-item"><strong>${escapeHtml(s.name)}</strong><span>${escapeHtml(s.error ?? '')}</span></div>`)
           .join('')}${lib.invalid.length > 30 ? `<p class="muted small">외 ${num(lib.invalid.length - 30)}개</p>` : ''}</div>`
      : '';

  const gapBox =
    lib.gaps.length > 0
      ? `<p class="section-title">빈 구간 ${num(lib.gaps.length)}개</p>
         <div class="tag-grid">${lib.gaps
           .slice(0, 20)
           .map(
             (g) => `<span class="tag-pill">${formatRecordedTime(g.fromMs, false).slice(11)} ~ ${formatRecordedTime(g.toMs, false).slice(11)} · ${formatDuration(g.durationMs / 1000)}</span>`,
           )
           .join('')}${lib.gaps.length > 20 ? `<span class="tag-pill muted">외 ${num(lib.gaps.length - 20)}개</span>` : ''}</div>`
      : '';

  el.innerHTML = `
    ${folderBox}
    <p class="section-title">구간 ${num(lib.segments.length)}개</p>
    <div class="seg-list">${lib.segments.map((s, i) => segmentRow(s, i, activeIndex)).join('')}</div>
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
