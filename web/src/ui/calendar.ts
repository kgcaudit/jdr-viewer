/**
 * 월간 캘린더 — 날짜를 고르면 그 날짜만 불러온다.
 *
 * 어느 날에 얼마나 찍혔는지 한눈에 보이도록, 칸마다 녹화량 막대를 그린다.
 */
import type { CalendarIndex, DayEntry, MonthKey } from '../core/calendar';
import { monthGrid } from '../core/calendar';
import { INDEX_FILE_NAME } from '../core/index-file';
import { formatDurationKo, formatRecordedTime } from '../core/time';
import { bytes, escapeHtml, num } from './format';
import type { FolderStat } from './segments';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export interface CalendarHandlers {
  onPickDay(key: string): void;
  onPickSession(key: string, sessionIndex: number): void;
  onToggleFolder(folder: string, selected: boolean): void;
  onMonthChange(index: number): void;
  onSaveIndex(): void;
  onRebuildIndex(): void;
}

/** 이번에 파일들을 어디서 읽어왔는지 */
export interface LoadStats {
  total: number;
  fromIndexFile: number;
  fromCache: number;
  probed: number;
  indexError?: string;
  /** 폴더에 인덱스 파일이 있었는지 (읽기에 성공한 경우만) */
  hadIndexFile: boolean;
  /** 그 인덱스에 없던 파일 수 — 대개 인덱스를 저장한 뒤 새로 녹화된 것들 */
  missingFromIndex: number;
  /** 방금 "갱신"으로 원본에서 전부 다시 읽었는가 */
  rebuilt?: boolean;
}

function loadSection(stats: LoadStats): string {
  const parts: string[] = [];
  if (stats.fromIndexFile > 0) parts.push(`인덱스 파일 ${num(stats.fromIndexFile)}개`);
  if (stats.fromCache > 0) parts.push(`브라우저 캐시 ${num(stats.fromCache)}개`);
  if (stats.probed > 0) parts.push(`직접 읽음 ${num(stats.probed)}개`);

  const err = stats.indexError
    ? `<p class="status-warn small" style="margin:0 0 8px">${escapeHtml(stats.indexError)}</p>`
    : '';

  // 인덱스는 저장한 시점에 멈춰 있다. 그 뒤에 녹화된 파일은 인덱스에 없으므로
  // 매번 직접 읽게 되는데, 사용자는 그 사실을 알 길이 없다. 그래서 알려준다.
  const stale = stats.missingFromIndex > 0;
  const staleNote = stale
    ? `<p class="status-warn small" style="margin:0 0 8px">인덱스에 없는 파일이 ${num(stats.missingFromIndex)}개 있습니다
       (인덱스를 저장한 뒤 녹화된 파일). 아래에서 다시 저장해 폴더의
       ${escapeHtml(INDEX_FILE_NAME)}을 덮어쓰면 다음부터 건너뜁니다.</p>`
    : '';

  const hint = stats.rebuilt
    ? `원본 ${num(stats.total)}개를 다시 읽었습니다. 저장해서 폴더의 ${escapeHtml(INDEX_FILE_NAME)}을 덮어써야 다음에도 이 결과가 쓰입니다.`
    : stale
      ? `다시 저장하면 기존 것까지 합쳐 ${num(stats.total)}개가 한 파일로 나옵니다.`
      : stats.fromIndexFile === stats.total && stats.total > 0
        ? '인덱스 파일 덕분에 헤더 훑기를 건너뛰었습니다.'
        : '브라우저는 폴더에 직접 쓸 수 없어 다운로드 폴더에 저장됩니다. 그 파일을 이 폴더로 옮겨 두면 다음에 열 때 헤더 훑기를 건너뜁니다. 원본 JDR은 건드리지 않습니다.';

  // 저장은 "지금 아는 것을 파일로", 갱신은 "원본에서 다시 알아내기"다.
  // 둘은 짝이라 나란히 둔다 — 인덱스가 꼬였을 때 갱신하고 곧바로 저장한다.
  const wantSave = stale || stats.rebuilt === true;
  return `
    <p class="section-title">불러온 방식</p>
    ${err}
    ${staleNote}
    <p class="muted small" style="margin:0 0 8px">${parts.join(' · ') || '없음'}</p>
    <div class="idx-row">
      <button class="btn${wantSave ? ' btn-primary' : ''}" type="button" id="btn-save-index">인덱스 ${stale ? '다시 ' : ''}저장 (${escapeHtml(INDEX_FILE_NAME)})</button>
      <button class="btn" type="button" id="btn-rebuild-index">인덱스 갱신</button>
    </div>
    <p class="muted small" style="margin:8px 0 0">${hint}</p>
    <p class="muted small" style="margin:6px 0 0"><strong>갱신</strong>은 인덱스 파일과 브라우저 캐시를
      모두 무시하고 원본 JDR 헤더를 처음부터 다시 읽습니다. 시각이나 길이가 엉뚱하게 보일 때 쓰세요.
      원본은 건드리지 않습니다.</p>`;
}

/**
 * 파일 수 표기. event 폴더 것은 따로 센다 —
 * 기기가 같은 시각을 data와 event에 겹쳐 쓰기도 해서, 합쳐 세면 부풀려진다.
 */
function countLabel(total: number, eventCount: number): string {
  const normal = total - eventCount;
  return eventCount > 0 ? `${num(normal)}개 + 이벤트 ${num(eventCount)}` : `${num(total)}개`;
}

function hhmm(ms: number): string {
  return formatRecordedTime(ms, false).slice(11, 16);
}

/** 하루 칸 */
function dayCell(cell: { key: string; day: number; inMonth: boolean }, index: CalendarIndex, selected: string): string {
  if (!cell.inMonth) return '<div class="cal-cell is-empty"></div>';
  const day = index.byKey.get(cell.key);
  if (!day) {
    return `<div class="cal-cell is-off"><span class="cal-day">${cell.day}</span></div>`;
  }
  const ratio = index.maxCoveredMs > 0 ? day.coveredMs / index.maxCoveredMs : 0;
  const height = Math.max(8, Math.round(ratio * 100));
  return `<button class="cal-cell is-on${cell.key === selected ? ' is-selected' : ''}" type="button"
      data-day="${cell.key}"
      title="${escapeHtml(`${cell.key} · ${countLabel(day.segments.length, day.eventCount)} · ${formatDurationKo(day.coveredMs / 1000)} · ${bytes(day.bytes)}`)}">
    <span class="cal-day">${cell.day}</span>
    <span class="cal-bar" style="height:${height}%"></span>
    <span class="cal-meta">${num(day.segments.length - day.eventCount)}개${day.eventCount > 0 ? '<span class="cal-evt">+' + num(day.eventCount) + '</span>' : ''}<br>${formatDurationKo(day.coveredMs / 1000)}</span>
  </button>`;
}

function sessionList(day: DayEntry): string {
  if (day.sessions.length === 0) return '';
  const rows = day.sessions
    .map(
      (s, i) => `<button class="session-row" type="button" data-session="${i}">
        <span class="session-time">${hhmm(s.startMs)} ~ ${hhmm(s.endMs)}</span>
        <span class="session-meta">${countLabel(s.segments.length, s.eventCount)} · ${formatDurationKo(s.coveredMs / 1000)}</span>
      </button>`,
    )
    .join('');
  return `
    <p class="section-title">${escapeHtml(day.key)} 운행 ${num(day.sessions.length)}건${
      day.crossesMidnight ? ' <span class="muted">· 자정 넘는 파일 포함</span>' : ''
    }</p>
    <div class="session-list">${rows}</div>
    <button class="btn btn-primary cal-open-day" type="button" data-open-day="${day.key}">
      이 날짜 전체 열기 (${countLabel(day.segments.length, day.eventCount)} · ${formatDurationKo(day.coveredMs / 1000)})
    </button>`;
}

export function renderCalendar(
  el: HTMLElement,
  index: CalendarIndex,
  monthIndex: number,
  selectedDay: string,
  folders: FolderStat[],
  handlers: CalendarHandlers,
  stats: LoadStats,
): void {
  if (index.days.length === 0) {
    el.innerHTML = '<p class="muted">기록 시각을 읽을 수 있는 파일이 없습니다.</p>';
    return;
  }
  const month: MonthKey = index.months[Math.max(0, Math.min(monthIndex, index.months.length - 1))];
  const cells = monthGrid(month.year, month.month);
  const day = selectedDay ? index.byKey.get(selectedDay) : undefined;

  const folderBox =
    folders.length > 1
      ? `<div class="folder-list cal-folders">${folders
          .map(
            (f) => `<label class="folder-item">
              <input type="checkbox" data-folder="${escapeHtml(f.folder)}" ${f.selected ? 'checked' : ''} />
              <span><strong>${escapeHtml(f.folder || '(최상위)')}</strong>
              <span class="muted">${num(f.count)}개 · ${bytes(f.bytes)}</span></span>
            </label>`,
          )
          .join('')}</div>`
      : '';

  el.innerHTML = `
    <div class="cal-head">
      <button class="btn btn-icon" type="button" data-month="${monthIndex - 1}" ${monthIndex <= 0 ? 'disabled' : ''} aria-label="이전 달">‹</button>
      <strong class="cal-title">${month.year}년 ${month.month}월</strong>
      <button class="btn btn-icon" type="button" data-month="${monthIndex + 1}" ${
        monthIndex >= index.months.length - 1 ? 'disabled' : ''
      } aria-label="다음 달">›</button>
    </div>
    ${folderBox}
    <div class="cal-weekdays">${WEEKDAYS.map((w, i) => `<span class="${i === 0 ? 'is-sun' : i === 6 ? 'is-sat' : ''}">${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells.map((c) => dayCell(c, index, selectedDay)).join('')}</div>
    <p class="muted small cal-hint">막대 높이는 그날 녹화량입니다. 날짜를 누르면 운행별로 나뉩니다.</p>
    <div class="cal-detail">${day ? sessionList(day) : '<p class="muted">날짜를 선택하세요.</p>'}</div>
    <p class="section-title">전체</p>
    <dl class="kv">
      <dt>기간</dt><dd>${formatRecordedTime(index.days[0].startMs, false)}<br>~ ${formatRecordedTime(index.days[index.days.length - 1].endMs, false)}</dd>
      <dt>날짜</dt><dd>${num(index.days.length)}일</dd>
      <dt>파일</dt><dd>${num(index.totalSegments)}개 · ${bytes(index.totalBytes)}</dd>
    </dl>
    ${loadSection(stats)}
  `;

  el.querySelectorAll<HTMLButtonElement>('[data-day]').forEach((b) =>
    b.addEventListener('click', () => handlers.onPickDay(b.dataset.day!)),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-month]').forEach((b) =>
    b.addEventListener('click', () => handlers.onMonthChange(Number(b.dataset.month))),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-session]').forEach((b) =>
    b.addEventListener('click', () => handlers.onPickSession(selectedDay, Number(b.dataset.session))),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-open-day]').forEach((b) =>
    b.addEventListener('click', () => handlers.onPickSession(b.dataset.openDay!, -1)),
  );
  el.querySelectorAll<HTMLInputElement>('[data-folder]').forEach((c) =>
    c.addEventListener('change', () => handlers.onToggleFolder(c.dataset.folder ?? '', c.checked)),
  );
  el.querySelector<HTMLButtonElement>('#btn-save-index')?.addEventListener('click', () => handlers.onSaveIndex());
  el.querySelector<HTMLButtonElement>('#btn-rebuild-index')?.addEventListener('click', () => handlers.onRebuildIndex());
}
