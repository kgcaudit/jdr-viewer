/**
 * 즐겨찾기 목록 패널.
 *
 * 상단바의 별을 누르면 열린다. 항목을 누르면 그 지점으로 바로 간다 —
 * 다른 날짜여도 그 날짜·운행을 열고 이동한다.
 */
import type { Bookmark } from '../core/bookmarks';
import { BOOKMARK_FILE_NAME } from '../core/bookmarks';
import { formatRecordedTime } from '../core/time';
import { escapeHtml, num } from './format';

export interface BookmarkPanelHandlers {
  onGoto(id: string): void;
  onRename(id: string): void;
  onRemove(id: string): void;
  onSaveFile(): void;
  onLoadFile(): void;
  onClose(): void;
}

function row(b: Bookmark): string {
  const when = formatRecordedTime(b.absMs, false);
  return `<li class="bm-row">
    <button class="bm-main" type="button" data-goto="${escapeHtml(b.id)}">
      <span class="bm-label">${escapeHtml(b.label)}</span>
      <span class="bm-meta">${escapeHtml(when)} · ${escapeHtml(b.name)}</span>
    </button>
    <button class="btn btn-icon bm-act" type="button" data-rename="${escapeHtml(b.id)}" aria-label="이름 바꾸기" title="이름 바꾸기">✎</button>
    <button class="btn btn-icon bm-act" type="button" data-remove="${escapeHtml(b.id)}" aria-label="지우기" title="지우기">🗑</button>
  </li>`;
}

export function renderBookmarkPanel(
  el: HTMLElement,
  list: Bookmark[],
  persistent: boolean,
  h: BookmarkPanelHandlers,
): void {
  const empty = `<p class="muted small bm-empty">아직 없습니다.
    재생 중에 컨트롤의 <strong>☆</strong>를 누르면 그 지점이 여기에 담깁니다.</p>`;

  const warn = persistent
    ? ''
    : `<p class="status-warn small" style="margin:0 0 8px">이 브라우저에서는 자동 저장을 쓸 수 없습니다
       (시크릿 모드이거나 file://). 아래에서 파일로 저장해 두세요.</p>`;

  el.innerHTML = `
    <div class="bm-head">
      <p class="section-title" style="margin:0">즐겨찾기 ${num(list.length)}개</p>
      <button class="btn btn-icon" type="button" id="bm-close" aria-label="닫기" title="닫기">✕</button>
    </div>
    ${warn}
    ${list.length === 0 ? empty : `<ul class="bm-list">${list.map(row).join('')}</ul>`}
    <div class="bm-foot">
      <button class="btn" type="button" id="bm-save">파일로 저장 (${escapeHtml(BOOKMARK_FILE_NAME)})</button>
      <button class="btn" type="button" id="bm-load">파일에서 불러오기</button>
    </div>
    <p class="muted small" style="margin:8px 0 0">브라우저에 자동으로 남습니다.
      다른 기기에서도 쓰려면 파일로 저장해 옮기세요.</p>`;

  el.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => h.onGoto(b.dataset.goto ?? ''));
  });
  el.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((b) => {
    b.addEventListener('click', () => h.onRename(b.dataset.rename ?? ''));
  });
  el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => {
    b.addEventListener('click', () => h.onRemove(b.dataset.remove ?? ''));
  });
  el.querySelector('#bm-save')?.addEventListener('click', () => h.onSaveFile());
  el.querySelector('#bm-load')?.addEventListener('click', () => h.onLoadFile());
  el.querySelector('#bm-close')?.addEventListener('click', () => h.onClose());
}
