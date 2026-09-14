/** 화면 배선. 무거운 일은 worker와 player가 한다. */
import './styles.css';
import { BlobByteSource } from './core/byte-source';
import { buildCalendar, type CalendarIndex } from './core/calendar';
import { buildLibrary, type Library } from './core/library';
import type { StripLayout } from './core/strip-layout';
import {
  buildIndexFile, entryToSegment, findIndexFile, indexMatches, INDEX_FILE_NAME,
  parseIndexFile, serializeIndexFile, type IndexEntry,
} from './core/index-file';
import { cacheKeyOf, fromCacheValue, ProbeCache, toCacheValue } from './core/probe-cache';
import { createScreenWake, type WakeState } from './core/wake-lock';
import {
  BOOKMARK_FILE_NAME, BookmarkStore, bookmarkAt, bookmarkId, defaultLabel,
  mergeBookmarks, parseBookmarks, serializeBookmarks, sortBookmarks, type Bookmark,
} from './core/bookmarks';
import { probeSegment, type SegmentInfo } from './core/segment';
import { formatDuration, formatRecordedTime, formatShortDate } from './core/time';
import type { JdrDocument, ParseProgress } from './core/types';
import { JdrParseJob } from './parse-client';
import { MergedRecords, RecordScanJob } from './scan-client';
import { FileSegmentLoader } from './player/loader';
import { SequencePlayer } from './player/sequence';
import { hasWebCodecs } from './player/index';
import type { PlayerStatus } from './player/player';
import { renderCalendar, type LoadStats } from './ui/calendar';
import { renderSummary } from './ui/summary';
import { hashSource } from './core/sha256';
import { GpsMap } from './ui/map';
import { TimeCharts } from './ui/charts';
import { renderRangeExport } from './ui/range-export';
import {
  buildRange, isVideoKind, rangeFileName, RANGE_LABEL, type RangeKind, type TimeRange,
} from './core/range-export';
import { buildCompositeMp4, buildRangeMp4 } from './core/mp4';
import {
  highlightSegmentRow, markActiveSegment, markLoadingSegment, renderSegments, renderStrip,
  updateStripCursor, type FolderStat,
} from './ui/segments';
import { attachStripScrub } from './ui/strip-scrub';
import { renderBookmarkPanel } from './ui/bookmarks';
import { renderSpeechPanel, type SpeechPanelState } from './ui/speech';
import { analyzeSegment, buildSpeechCsv, buildSpeechWav, type SpeechResult } from './core/speech';
import { bytes, num } from './ui/format';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const views = {
  empty: $('view-empty'),
  loading: $('view-loading'),
  error: $('view-error'),
  calendar: $('view-calendar'),
  main: $('view-main'),
};

const CONTROL_IDS = ['btn-play', 'btn-prev-file', 'btn-next-file', 'btn-back10', 'btn-fwd10', 'seek', 'speed', 'btn-mute', 'btn-bookmark'];
const SKIP_MS = 10_000;

/** 폴더 전체에 대한 상태 — 날짜를 바꿔도 유지된다 */
interface FolderState {
  allSegments: SegmentInfo[];
  folders: FolderStat[];
  calendar: CalendarIndex;
  monthIndex: number;
  selectedDay: string;
  files: Map<string, File>;
  stats: LoadStats;
}

/** 지금 열려 있는 날짜(또는 단일 파일)의 재생 세션 */
interface PlaySession {
  merged: boolean;
  lib: Library;
  loader: FileSegmentLoader;
  player: SequencePlayer;
  records: MergedRecords;
  scan: RecordScanJob | null;
  label: string;
  /** 지금 보고 있는 날짜와 운행 (-1 = 날짜 전체) */
  dayKey: string;
  sessionIndex: number;
}

let folderState: FolderState | null = null;
let session: PlaySession | null = null;
let parseJob: JdrParseJob | null = null;
let map: GpsMap | null = null;
let charts: TimeCharts | null = null;
let seekDragging = false;
let muted = false;
let stripLayout: StripLayout | null = null;

const probeCache = new ProbeCache();

function readCodecOverride(): string | undefined {
  const raw = new URLSearchParams(location.search).get('codec')?.trim();
  if (!raw || raw === 'undefined' || raw === 'null') return undefined;
  return /^[a-z0-9][a-z0-9.\-_]*$/i.test(raw) ? raw : undefined;
}
const codecOverride = readCodecOverride();
/** ?debug=1 — 끊김을 진단할 때 쓰는 재생 계수 */
const debugMode = new URLSearchParams(location.search).get('debug') === '1';

function showView(name: keyof typeof views): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  $('btn-back-calendar').hidden = !(name === 'main' && folderState !== null);
  // 즐겨찾기는 무엇이든 열려 있어야 의미가 있다
  $('btn-bookmarks').hidden = !(name === 'main' || name === 'calendar');
  syncWakeChip(name);
}

function setControlsEnabled(enabled: boolean): void {
  for (const id of CONTROL_IDS) {
    ($(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = !enabled;
  }
}

let toastTimer = 0;
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 3600);
}

function showError(msg: string): void {
  $('error-message').textContent = msg;
  showView('error');
}

// ── 입력 ────────────────────────────────────────────
const fileInput = $<HTMLInputElement>('file-input');
const folderInput = $<HTMLInputElement>('folder-input');

$('btn-open').addEventListener('click', () => fileInput.click());
$('btn-open-2').addEventListener('click', () => fileInput.click());
$('btn-retry').addEventListener('click', () => fileInput.click());
$('btn-open-folder').addEventListener('click', () => folderInput.click());
$('btn-open-folder-2').addEventListener('click', () => folderInput.click());
$('btn-back-calendar').addEventListener('click', () => {
  if (!folderState) return;
  session?.player.pause();
  showView('calendar');
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openSingleFile(f);
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  const files = Array.from(folderInput.files ?? []);
  if (files.length) void openFolder(files);
  folderInput.value = '';
});

/**
 * 휴대폰에서는 **한 번에 한 대만** 본다. 채널 딱지를 누르면 바뀐다.
 *
 * 처음엔 전방을 크게, 후방을 모서리에 겹쳐 두었는데(PIP) 한 번 누르면
 * 바뀌고 **다시 눌러도 안 돌아왔다.** 겹쳐 놓으면 가려질 수 있다는 것이
 * 문제의 뿌리였다. 좁은 화면에서 두 대를 동시에 볼 이유도 없으므로,
 * 겹치지 않게 하나만 보여 준다. 자리만 바뀌고 재생은 건드리지 않는다.
 */
$('video-grid').addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-swap-ch]')) return;
  const grid = $('video-grid');
  // 나란히 보이는 넓은 화면에서는 바꿀 것이 없다.
  // 중단점을 코드에 또 적지 않고 **실제 배치**로 판단한다.
  const hidden = [...grid.children].some((c) => getComputedStyle(c).display === 'none');
  if (!hidden) return;
  grid.classList.toggle('is-rear');
});

/**
 * 영상 접기.
 *
 * 세로가 짧은 기기에서 패널에 남는 높이가 97px(화면의 18%)까지 눌렸다.
 * 접으면 영상만 숨고 벽시계·재생·띠는 남으므로, **앱 셸로 얻은 맥락을
 * 잃지 않으면서** 표와 목록에 자리를 내준다.
 *
 * 상태는 기억한다 — 감사하듯 오래 보는 사람은 한 번 정한 모양을 계속 쓴다.
 */
const FOLD_KEY = 'jdr-viewer.stage-folded';

function applyStageFold(folded: boolean): void {
  document.body.classList.toggle('is-stage-folded', folded);
  const btn = $('btn-fold-stage');
  btn.textContent = folded ? '⌃' : '⌄';
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  const label = folded ? '영상 펴기' : '영상 접기';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function readStageFold(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    // 시크릿 모드나 file:// 에서는 못 읽을 수 있다. 그때는 펼친 채로 둔다.
    return false;
  }
}

applyStageFold(readStageFold());
$('btn-fold-stage').addEventListener('click', () => {
  const next = !document.body.classList.contains('is-stage-folded');
  applyStageFold(next);
  try {
    localStorage.setItem(FOLD_KEY, next ? '1' : '0');
  } catch { /* 저장 못 해도 이번 세션에는 적용된다 */ }
});

/**
 * 좁은 화면에서 도크(컨트롤+띠)가 위에 붙었는지 살핀다.
 *
 * 붙어 있는 동안에는 곁가지를 접어 자리를 아끼고, 탭바가 도크 바로 아래에
 * 붙도록 도크 높이를 CSS에 알려 준다. 높이를 코드 양쪽에 적어 두면 한쪽만
 * 고쳐져 어긋나므로, **재서 알려 주는 쪽**을 택한다.
 */
function watchDock(): void {
  const dock = document.getElementById('stage-dock');
  const scroller = $('view-main');
  if (!dock) return;

  const sync = (): void => {
    document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`);
  };
  new ResizeObserver(sync).observe(dock);
  sync();

  // 붙었는지는 **표식이 화면 위로 빠져나갔는지**로 판정한다.
  // 좌표를 직접 비교하면 스크롤 영역의 안쪽 여백만큼 어긋나 늘 어긋난 값이
  // 나온다(실제로 그래서 한 번도 '붙음'으로 안 잡혔다).
  const sentinel = document.getElementById('dock-sentinel');
  if (!sentinel) return;
  new IntersectionObserver(
    ([entry]) => {
      document.body.classList.toggle('is-docked', !entry.isIntersecting);
      sync();
    },
    { root: scroller, threshold: 0 },
  ).observe(sentinel);
}
watchDock();

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('is-over'); });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('is-over'));
}
dropzone.addEventListener('drop', (e) => { e.preventDefault(); void handleDrop(e as DragEvent); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function handleDrop(e: DragEvent): Promise<void> {
  const dt = e.dataTransfer;
  if (!dt) return;
  const entries = Array.from(dt.items)
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter((x): x is FileSystemEntry => !!x);

  if (entries.some((en) => en.isDirectory)) {
    const files: File[] = [];
    for (const en of entries) await collectEntry(en, files);
    if (files.length) void openFolder(files);
    return;
  }
  const f = dt.files?.[0];
  if (f) void openSingleFile(f);
}

async function collectEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file((f) => resolve(f), () => resolve(null)),
    );
    if (file) {
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
      out.push(file);
    }
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries((r) => resolve(r), () => resolve([])),
    );
    if (batch.length === 0) break;
    for (const child of batch) await collectEntry(child, out);
  }
}

// ── 단일 파일 ───────────────────────────────────────
const PHASE_LABEL: Record<string, string> = {
  hash: '해시 계산 중…',
  scan: '파일을 훑는 중 (해시 + 블록 탐색)…',
  packets: '패킷을 읽는 중…',
  analyze: '분석 중…',
};

function setBar(pct: number): void {
  ($('loading-bar') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

function showParseProgress(p: ParseProgress): void {
  $('loading-phase').textContent = PHASE_LABEL[p.phase] ?? '처리 중…';
  if (p.phase === 'analyze') { setBar(100); return; }
  const pct = p.total > 0 ? (p.done / p.total) * 100 : 0;
  setBar(p.phase === 'scan' ? pct * 0.6 : 60 + pct * 0.4);
}

async function openSingleFile(file: File): Promise<void> {
  await teardown();
  folderState = null;
  showView('loading');
  $('loading-detail').textContent = `${file.name} · ${bytes(file.size)}`;
  $('loading-phase').textContent = '파일을 읽는 중…';
  setBar(0);

  parseJob = new JdrParseJob();
  try {
    const doc = await parseJob.run(file, showParseProgress, () => {
      $('loading-detail').textContent =
        `${file.name} · ${bytes(file.size)} — 이 환경에서는 워커를 쓸 수 없어 조금 느릴 수 있습니다`;
    });
    const seg = await probeSegment({
      src: new BlobByteSource(file, file.name), name: file.name, path: file.name, size: file.size,
    });
    if (seg.error || !Number.isFinite(seg.startMs)) {
      seg.error = undefined;
      seg.startMs = doc.firstTimeMs;
      // 꼬리에 덧붙은 GPS·센서 패킷이 아니라 영상·음성이 끝난 곳이 기준이다
      seg.endMs = Number.isFinite(doc.contentEndMs) ? doc.contentEndMs : doc.lastTimeMs;
      seg.durationMs = Math.max(0, seg.endMs - seg.startMs);
      seg.timeSource = 'packets';
    }
    await startPlaySession([seg], new Map([[seg.id, file]]), false, file.name, doc);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

// ── 폴더: 헤더만 훑어 날짜 인덱스를 만든다 ──────────
function commonRootPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const slash = paths[0].indexOf('/');
  if (slash < 0) return '';
  const root = paths[0].slice(0, slash + 1);
  return paths.every((p) => p.startsWith(root)) ? root : '';
}

async function openFolder(all: File[]): Promise<void> {
  const jdrFiles = all.filter((f) => f.name.toLowerCase().endsWith('.jdr'));
  if (jdrFiles.length === 0) {
    showError('폴더 안에서 .jdr 파일을 찾지 못했습니다.');
    return;
  }
  await teardown();
  showView('loading');
  $('loading-phase').textContent = '파일 목록을 훑는 중…';
  $('loading-detail').textContent = `${num(jdrFiles.length)}개 파일`;
  setBar(0);

  const rawPaths = jdrFiles.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  const root = commonRootPrefix(rawPaths);

  // ① 폴더 안에 인덱스 파일이 있으면 그걸 먼저 쓴다 (헤더 훑기를 통째로 건너뛴다)
  let indexMap = new Map<string, IndexEntry>();
  let indexError: string | undefined;
  const indexFile = findIndexFile(all);
  if (indexFile) {
    $('loading-phase').textContent = '인덱스 파일을 읽는 중…';
    try {
      indexMap = parseIndexFile(await indexFile.text());
    } catch (e) {
      indexError = `인덱스 파일을 쓸 수 없어 직접 읽습니다 — ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ② 인덱스에 없는 파일은 브라우저 캐시, ③ 그것도 없으면 헤더를 직접 읽는다.
  //
  // 인덱스 파일이 있어도 캐시는 반드시 같이 본다. 인덱스는 저장한 시점에 멈춰
  // 있으므로 그 뒤에 녹화된 파일은 인덱스에 없는데, 캐시를 건너뛰면 그 파일들을
  // 열 때마다 다시 읽게 된다.
  const keys = jdrFiles.map(cacheKeyOf);
  const cached = await probeCache.getMany(keys);
  const stats: LoadStats = {
    total: jdrFiles.length, fromIndexFile: 0, fromCache: 0, probed: 0,
    indexError, hadIndexFile: !!indexFile && !indexError, missingFromIndex: 0,
    unreadable: 0, blank: 0,
  };

  const segments: SegmentInfo[] = [];
  const files = new Map<string, File>();
  const toStore: ReturnType<typeof toCacheValue>[] = [];

  $('loading-phase').textContent = '파일 목록을 훑는 중…';
  for (let i = 0; i < jdrFiles.length; i++) {
    const f = jdrFiles[i];
    const path = rawPaths[i].startsWith(root) ? rawPaths[i].slice(root.length) : rawPaths[i];
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const meta = { name: f.name, path, folder, size: f.size };

    const entry = indexMap.get(path);
    const hit = cached.get(keys[i]);
    let seg: SegmentInfo;
    if (entry && indexMatches(entry, f)) {
      // 크기·수정시각이 같을 때만 믿는다. 파일이 바뀌었으면 다시 읽는다.
      seg = entryToSegment(entry, meta);
      stats.fromIndexFile++;
    } else if (hit) {
      if (stats.hadIndexFile) stats.missingFromIndex++;
      seg = fromCacheValue(hit, meta);
      stats.fromCache++;
    } else {
      if (stats.hadIndexFile) stats.missingFromIndex++;
      // 헤더 512바이트만 읽는다 (파일 전체를 읽지 않는다)
      seg = await probeSegment({ src: new BlobByteSource(f, f.name), name: f.name, path, size: f.size });
      toStore.push(toCacheValue(keys[i], seg));
      stats.probed++;
    }
    segments.push(seg);
    files.set(seg.id, f);

    if ((i & 31) === 0) {
      setBar((i / jdrFiles.length) * 100);
      $('loading-detail').textContent =
        `${num(i + 1)} / ${num(jdrFiles.length)}개` +
        (stats.fromIndexFile > 0 ? ` · 인덱스 ${num(stats.fromIndexFile)}개` : '') +
        (stats.fromCache > 0 ? ` · 캐시 ${num(stats.fromCache)}개` : '');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  setBar(100);
  void probeCache.putMany(toStore);
  Object.assign(stats, countDropped(segments));

  if (segments.every((s) => s.error)) {
    showError(`${num(segments.length)}개 파일을 모두 읽지 못했습니다. 지원하지 않는 JDR 변형일 수 있습니다.`);
    return;
  }

  const folders = buildFolderStats(segments);
  folderState = {
    allSegments: segments, folders,
    calendar: buildCalendar(selectedSegments(segments, folders)),
    monthIndex: 0, selectedDay: '', files, stats,
  };
  // 가장 최근 달부터 보여준다
  folderState.monthIndex = Math.max(0, folderState.calendar.months.length - 1);
  if (stats.missingFromIndex > 0) {
    toast(`인덱스에 없는 새 파일 ${num(stats.missingFromIndex)}개를 읽었습니다 — 인덱스를 다시 저장하세요`);
  } else if (stats.fromIndexFile > 0) {
    toast(`인덱스 파일에서 ${num(stats.fromIndexFile)}개를 읽어 훑기를 건너뛰었습니다`);
  } else if (stats.fromCache > 0) {
    toast(`${num(stats.fromCache)}개는 브라우저 캐시에서 읽었습니다`);
  }
  drawCalendar();
  showView('calendar');
}

/**
 * 타임라인에 오르지 못한 파일을 센다.
 *
 * 둘을 갈라야 한다. 기기가 미리 잡아 두기만 한 **빈 파일**은 정상이고,
 * 내용이 있는데 **열지 못한 파일**은 확인이 필요하다. 섞어 놓으면 사용자는
 * 멀쩡한 카드를 고장난 줄 안다.
 */
function countDropped(segments: SegmentInfo[]): { unreadable: number; blank: number } {
  let unreadable = 0;
  let blank = 0;
  for (const s of segments) {
    if (!s.error) continue;
    if (s.blank) blank++;
    else unreadable++;
  }
  return { unreadable, blank };
}

function buildFolderStats(segments: SegmentInfo[]): FolderStat[] {
  const map = new Map<string, FolderStat>();
  for (const s of segments) {
    if (s.error) continue;
    const cur = map.get(s.folder) ?? { folder: s.folder, count: 0, bytes: 0, durationMs: 0, selected: false };
    cur.count++;
    cur.bytes += s.size;
    cur.durationMs += s.durationMs;
    map.set(s.folder, cur);
  }
  // 기기는 한 번의 주행을 data(평상시)와 event(충격)에 나눠 쓴다.
  // 하나만 켜면 주행이 반쪽이 되므로 **전부 켜 두고** 시작한다.
  const list = [...map.values()].sort((a, b) => b.durationMs - a.durationMs);
  for (const f of list) f.selected = true;
  return list;
}

function selectedSegments(segments: SegmentInfo[], folders: FolderStat[]): SegmentInfo[] {
  const on = new Set(folders.filter((f) => f.selected).map((f) => f.folder));
  return segments.filter((s) => !s.error && on.has(s.folder));
}

function drawCalendar(): void {
  const fs = folderState;
  if (!fs) return;
  renderCalendar($('calendar'), fs.calendar, fs.monthIndex, fs.selectedDay, fs.folders, {
    onPickDay: (key) => {
      fs.selectedDay = key;
      drawCalendar();
      revealDayDetail();
    },
    onPickSession: (key, sessionIndex) => void openDay(key, sessionIndex),
    onMonthChange: (index) => {
      fs.monthIndex = Math.max(0, Math.min(index, fs.calendar.months.length - 1));
      drawCalendar();
    },
    onToggleFolder: (folder, selected) => {
      const f = fs.folders.find((x) => x.folder === folder);
      if (!f) return;
      f.selected = selected;
      if (fs.folders.every((x) => !x.selected)) {
        f.selected = true;
        toast('폴더를 최소 하나는 선택해야 합니다');
      }
      fs.calendar = buildCalendar(selectedSegments(fs.allSegments, fs.folders));
      fs.monthIndex = Math.max(0, Math.min(fs.monthIndex, fs.calendar.months.length - 1));
      fs.selectedDay = fs.calendar.byKey.has(fs.selectedDay) ? fs.selectedDay : '';
      drawCalendar();
    },
    onSaveIndex: () => saveIndexFile(),
    onRebuildIndex: () => void rebuildIndex(),
  }, fs.stats);
}

/**
 * 좁은 화면에서 날짜를 누르면 그 날의 운행 목록이 보이는 자리로 옮겨 준다.
 *
 * 좌우로 갈린 화면에서는 오른쪽이 이미 보이므로 할 일이 없다. 세로로 쌓인
 * 화면에서는 눌러도 화면이 그대로라 "눌린 건가?" 싶은 순간이 생긴다.
 */
function revealDayDetail(): void {
  const detail = document.getElementById('cal-detail');
  if (!detail) return;
  // 좌우로 갈렸는지는 실제 배치로 판단한다 (중단점을 두 군데 적지 않는다).
  // 격자는 카드가 아니라 #calendar에 걸려 있다.
  const grid = document.getElementById('calendar');
  if (grid && getComputedStyle(grid).display === 'grid') return;
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * 인덱스를 원본에서 처음부터 다시 만든다.
 *
 * 인덱스 파일도, 브라우저 캐시도 믿지 않고 **원본 JDR 헤더를 전부 다시 읽는다.**
 * 인덱스는 저장한 시점에 멈춘 사본이라, 그 뒤에 기기가 같은 이름으로 다시 쓰거나
 * 다른 도구가 파일을 손대면 실제와 어긋난다. 그때 시각·길이가 엉뚱하게 보이는데,
 * 사용자에게는 손쓸 방법이 없었다. 이게 그 방법이다.
 *
 * 폴더를 다시 고를 필요는 없다 — File 객체를 계속 들고 있기 때문이다.
 */
async function rebuildIndex(): Promise<void> {
  const fs = folderState;
  if (!fs) return;
  const targets = fs.allSegments
    .map((seg) => ({ seg, file: fs.files.get(seg.id) }))
    .filter((x): x is { seg: SegmentInfo; file: File } => !!x.file);
  if (targets.length === 0) return;

  // 수백 개면 시간이 걸린다. 잘못 눌렀을 때 붙잡히지 않도록 먼저 묻는다.
  if (!confirm(`원본 ${num(targets.length)}개를 처음부터 다시 읽습니다.\n인덱스 파일과 브라우저 캐시는 무시합니다. 계속할까요?`)) {
    return;
  }

  session?.player.pause();
  showView('loading');
  $('loading-phase').textContent = '원본에서 인덱스를 다시 만드는 중…';
  setBar(0);

  const rebuilt: SegmentInfo[] = [];
  const toStore: ReturnType<typeof toCacheValue>[] = [];
  for (let i = 0; i < targets.length; i++) {
    const { seg, file } = targets[i];
    const meta = { name: seg.name, path: seg.path, folder: seg.folder, size: file.size };
    const next = await probeSegment({
      src: new BlobByteSource(file, file.name), name: meta.name, path: meta.path, size: meta.size,
    });
    rebuilt.push(next);
    toStore.push(toCacheValue(cacheKeyOf(file), next));
    if ((i & 31) === 0) {
      setBar((i / targets.length) * 100);
      $('loading-detail').textContent = `${num(i + 1)} / ${num(targets.length)}개`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  setBar(100);
  // 낡은 값을 덮어써야 다음에 열 때도 고쳐진 채로 나온다
  await probeCache.putMany(toStore);

  // 켜 둔 폴더는 그대로 둔다 — 갱신은 "다시 읽기"지 "처음부터 다시 고르기"가 아니다
  const selected = new Set(fs.folders.filter((f) => f.selected).map((f) => f.folder));
  const folders = buildFolderStats(rebuilt);
  for (const f of folders) f.selected = selected.size === 0 || selected.has(f.folder);
  if (folders.every((f) => !f.selected)) for (const f of folders) f.selected = true;

  fs.allSegments = rebuilt;
  fs.folders = folders;
  fs.calendar = buildCalendar(selectedSegments(rebuilt, folders));
  fs.monthIndex = Math.max(0, Math.min(fs.monthIndex, fs.calendar.months.length - 1));
  if (!fs.calendar.byKey.has(fs.selectedDay)) fs.selectedDay = '';
  fs.stats = {
    total: rebuilt.length, fromIndexFile: 0, fromCache: 0, probed: rebuilt.length,
    hadIndexFile: false, missingFromIndex: 0, rebuilt: true,
    ...countDropped(rebuilt),
  };

  drawCalendar();
  showView('calendar');
  toast(`원본 ${num(rebuilt.length)}개를 다시 읽었습니다 — 인덱스를 저장해 폴더의 것을 덮어쓰세요`);
}

/**
 * 훑은 결과를 인덱스 파일로 저장한다. 폴더에 넣어두면 다음에 열 때 훑기를 건너뛴다.
 *
 * 브라우저는 폴더에 직접 쓸 수 없으므로 실제 동작은 다운로드다.
 * 사용자가 그 파일을 폴더로 옮겨야 한다 — 그래서 안내 문구가 붙는다.
 */
function saveIndexFile(): void {
  const fs = folderState;
  if (!fs) return;
  const items = fs.allSegments
    .map((seg) => ({ seg, file: fs.files.get(seg.id) }))
    .filter((x): x is { seg: SegmentInfo; file: File } => !!x.file);
  const text = serializeIndexFile(buildIndexFile(items));
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = INDEX_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`${INDEX_FILE_NAME} 저장 · ${num(items.length)}개 · ${bytes(blob.size)} — 다운로드 폴더에서 이 폴더로 옮겨 두세요`);
  // 방금 저장한 파일에는 새 파일(과 갱신 결과)까지 들어 있으므로 재촉을 거둔다
  if (fs.stats.missingFromIndex > 0 || fs.stats.rebuilt) {
    fs.stats.missingFromIndex = 0;
    fs.stats.rebuilt = false;
    fs.stats.indexError = undefined;
    drawCalendar();
  }
}

/** 날짜(또는 그 안의 운행 하나)만 불러온다 */
async function openDay(dayKey: string, sessionIndex: number): Promise<void> {
  const fs = folderState;
  if (!fs) return;
  const day = fs.calendar.byKey.get(dayKey);
  if (!day) return;
  const segs = sessionIndex >= 0 && day.sessions[sessionIndex]
    ? day.sessions[sessionIndex].segments
    : day.segments;
  const label = sessionIndex >= 0
    ? `${dayKey} · ${formatRecordedTime(segs[0].startMs, false).slice(11, 16)} 운행`
    : dayKey;

  await teardown();
  showView('loading');
  $('loading-phase').textContent = `${label} 여는 중…`;
  $('loading-detail').textContent = `${num(segs.length)}개 구간`;
  setBar(30);
  await startPlaySession(segs, fs.files, true, label, null, dayKey, sessionIndex);
}

// ── 재생 세션 ───────────────────────────────────────
async function teardown(): Promise<void> {
  exportRange = null;
  session?.scan?.stop();
  session?.player.close();
  session?.loader.clear();
  parseJob?.cancel();
  charts?.destroy();
  session = null;
  setControlsEnabled(false);
}

async function startPlaySession(
  segments: SegmentInfo[],
  files: Map<string, File>,
  merged: boolean,
  label: string,
  preparsed: JdrDocument | null,
  dayKey = '',
  sessionIndex = -1,
): Promise<void> {
  const lib = buildLibrary(segments);
  if (lib.segments.length === 0) {
    showError('재생할 수 있는 구간이 없습니다.');
    return;
  }
  const loader = new FileSegmentLoader(files, merged ? 3 : 1, !merged);
  const player = new SequencePlayer(
    lib, loader,
    [$<HTMLCanvasElement>('canvas-0'), $<HTMLCanvasElement>('canvas-1')],
    toast, codecOverride,
  );
  session = {
    merged, lib, loader, player, records: new MergedRecords(), scan: null, label,
    dayKey, sessionIndex,
  };

  if (preparsed && lib.segments.length === 1) {
    loader.prime(lib.segments[0].id, preparsed, new BlobByteSource(files.get(lib.segments[0].id)!, preparsed.fileName));
  }
  showView('main');
  await mount();
}

async function mount(): Promise<void> {
  const s = session;
  if (!s) return;
  setControlsEnabled(false);

  $('timeline-strip').hidden = !s.merged;
  $('session-chips').hidden = !s.merged;
  document.querySelector<HTMLButtonElement>('.tab[data-tab="segments"]')!.hidden = !s.merged;

  map = new GpsMap($('map'));
  map.resetFit();
  charts = new TimeCharts($('chart-speed'), $('chart-gsensor'));

  if (s.merged) {
    renderSessionChips();
    stripLayout = renderStrip($('strip-track'), s.lib);
    $('strip-start').textContent = formatRecordedTime(s.lib.startMs, false).slice(11);
    $('strip-end').textContent = formatRecordedTime(s.lib.endMs, false).slice(11);
    renderSegmentsPanel();
  }

  s.player.onTimeUpdate = (absMs, segIndex) => updateLabels(absMs, segIndex);
  s.player.onPlayingChange = (playing) => {
    $('btn-play').textContent = playing ? '❚❚' : '▶';
    $('btn-play').setAttribute('aria-label', playing ? '일시정지' : '재생');
  };
  s.player.onSegmentChange = (index, status) => onSegmentChange(index, status);
  // 프로브 시각이 실제와 달라 타임라인이 고쳐지면 화면도 다시 그린다
  // 구간을 여는 도중에 불린다. 여기서 목록 전체를 다시 그리면 본선이 수백 ms
  // 멎어 **막 시작한 소리가 끊긴다.** 한 박자 미뤄 몰아서 한 번만 그린다.
  let fixPending = 0;
  s.player.onLibraryFixed = () => {
    if (!s.merged) return;
    clearTimeout(fixPending);
    fixPending = window.setTimeout(redrawFixedLibrary, 200);
  };
  const redrawFixedLibrary = (): void => {
    if (!s.merged) return;
    stripLayout = renderStrip($('strip-track'), s.lib);
    $('strip-start').textContent = formatRecordedTime(s.lib.startMs, false).slice(11);
    $('strip-end').textContent = formatRecordedTime(s.lib.endMs, false).slice(11);
    markActiveSegment($('strip-track'), s.player.segmentIndex);
    updateStripCursor($('strip-track'), stripLayout, s.player.position);
    drawTalkBands();
    renderSegmentsPanel();
  };
  s.player.onSegmentLoading = (index) => {
    const seg = s.lib.segments[index];
    for (let ch = 0; ch < 2; ch++) $(`ch${ch}-note`).textContent = '여는 중…';
    if (seg) $('file-note').textContent = `구간 ${index + 1}/${s.lib.segments.length} · 출처 ${seg.path}`;
    if (s.merged) markLoadingSegment($('strip-track'), index);
  };

  await s.player.init();
  setControlsEnabled(true);

  if (!hasWebCodecs()) toast('이 브라우저는 WebCodecs 미지원 — 영상 재생만 비활성화됩니다');
  else if (codecOverride) toast(`코덱을 ${codecOverride}(으)로 강제 지정했습니다`);

  if (debugMode) startDebugMeter();
  startRecordScan();
}

function onSegmentChange(index: number, status: PlayerStatus | null): void {
  const s = session;
  if (!s) return;
  const doc = s.player.currentDoc;
  const seg = s.lib.segments[index] ?? null;

  const src = s.player.currentSource;
  renderSummary($('tab-summary'), {
    doc, lib: s.lib, segment: seg, merged: s.merged,
    // 해시는 저장이 아니라 점검이다. 내보내기에서 빠졌어도 여기 남는다.
    onComputeHash: doc && src && !doc.sha256
      ? async (report) => {
          try {
            doc.sha256 = await hashSource(src, report);
            toast('SHA-256 계산 완료');
            onSegmentChange(index, status);
          } catch (e) {
            toast(`해시 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
        }
      : undefined,
  });
  if (s.merged) {
    markLoadingSegment($('strip-track'), -1);
    markActiveSegment($('strip-track'), index);
    highlightSegmentRow($('tab-segments'), index);
  }
  // 현재 파일 길이에 맞춰 슬라이더를 다시 잡는다
  const seek = $<HTMLInputElement>('seek');
  seek.max = String(Math.max(1, Math.round(s.player.fileDuration)));
  for (let ch = 0; ch < 2; ch++) {
    const st = status?.channels[ch];
    $(`ch${ch}-note`).textContent = st?.available
      ? `${st.width || '?'}×${st.height || '?'} · ${doc?.video[ch]?.fps.toFixed(1) ?? '?'}fps`
      : st?.reason ?? '영상 없음';
  }
  if (!s.merged && doc) drawRecords(doc.firstTimeMs, doc.gps, doc.gsensor);
  drawSpeechPanel();
  drawTalkBands();
  if (!rangeBusy) drawRangeExport();
  updateLabels(s.player.position, index);
}

function updateLabels(absMs: number, segIndex: number): void {
  const s = session;
  if (!s) return;
  const seg = s.lib.segments[segIndex];

  // 시간 라벨은 "전체"가 아니라 "현재 파일" 기준이다
  const filePos = s.player.filePosition;
  const fileDur = s.player.fileDuration;
  if (!seekDragging) $<HTMLInputElement>('seek').value = String(Math.round(filePos));
  $('time-label').textContent = `${formatDuration(filePos / 1000)} / ${formatDuration(fileDur / 1000)}`;
  // 구간을 지정해 내보낼 때 정작 필요한 건 "지금 몇 시인가"다.
  // 파일 안 위치(0:02.8)만으로는 시작·끝을 고를 수 없다.
  $('time-clock').textContent = clockOf(absMs);
  // 내보내기 칸이 열려 있으면 거기 숫자도 같이 움직인다. 패널을 통째로 다시
  // 그리면 입력 칸의 포커스가 날아가므로 글자만 바꾼다.
  const nowTime = document.getElementById('rng-now-time');
  if (nowTime) {
    nowTime.textContent = clockOf(absMs);
    const nowDate = document.getElementById('rng-now-date');
    const date = formatRecordedTime(absMs, false).slice(0, 10);
    if (nowDate && nowDate.textContent !== date) nowDate.textContent = date;
  }
  $('file-note').textContent = seg
    ? `구간 ${segIndex + 1}/${s.lib.segments.length} · 출처 ${seg.path}`
    : '';

  if (s.merged) updateStripCursor($('strip-track'), stripLayout, absMs);
  refreshBookmarkUi();
  const fix = map?.syncTo(absMs) ?? null;
  charts?.syncTo((absMs - s.lib.startMs) / 1000);

  // 벽시계가 이미 크게 떠 있으므로 라벨은 군더더기다. 밀리초까지 적힌
  // 정확한 값만 남긴다 — 감사에서는 이 값이 증거다.
  const parts = [formatRecordedTime(absMs)];
  if (fix) parts.push(`${fix.speed.toFixed(1)} km/h (추정)`, `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`);
  $('recorded-time').textContent = parts.join('  ·  ');
}

function drawRecords(t0: number, gps: JdrDocument['gps'], gsensor: JdrDocument['gsensor']): void {
  const r = map?.render(gps);
  if (r) {
    $('map-note').textContent =
      r.shown === 0
        ? 'GPS 좌표가 없습니다 (위성 미수신이거나 GPS 패킷이 없는 구간).'
        : `${num(r.shown)}개 지점 표시${r.dropped > 0 ? ` · 위성 미수신 ${num(r.dropped)}건 제외` : ''}`;
  }
  charts?.render({ t0, gps, gsensor });
}

/** 선택한 날짜의 구간만 스캔한다 (전체 폴더가 아니라) */
function startRecordScan(): void {
  const s = session;
  const fs = folderState;
  if (!s || !s.merged || !fs) return;
  const items = s.lib.segments
    .map((seg) => ({ seg, file: fs.files.get(seg.id) }))
    .filter((x): x is { seg: SegmentInfo; file: File } => !!x.file);

  s.scan = new RecordScanJob();
  $('scan-note').textContent = `${s.label} GPS·센서 스캔 중… 0 / ${num(items.length)}`;
  let lastDraw = 0;

  void s.scan.run(items, (chunk) => {
    if (session !== s) return;
    s.records.add(chunk);
    $('scan-note').textContent =
      chunk.done >= chunk.total
        ? `${s.label} 스캔 완료 · GPS ${num(s.records.gps.length)}건 · 센서 ${num(s.records.sensorCount)}건`
        : `${s.label} GPS·센서 스캔 중… ${num(chunk.done)} / ${num(chunk.total)}`;
    const now = performance.now();
    if (chunk.done >= chunk.total || now - lastDraw > 1200) {
      lastDraw = now;
      s.records.finish();
      drawRecords(s.lib.startMs, s.records.gps, s.records.gsensor);
    }
  });
}

/**
 * 같은 날짜의 다른 운행으로 바로 옮겨가는 칩.
 * 시간대를 바꾸겠다고 캘린더까지 돌아가는 건 번거롭다.
 */
function renderSessionChips(): void {
  const s = session;
  const fs = folderState;
  const el = $('session-chips');
  if (!s || !fs || !s.dayKey) { el.innerHTML = ''; el.hidden = true; return; }
  const day = fs.calendar.byKey.get(s.dayKey);
  if (!day || day.sessions.length === 0) { el.innerHTML = ''; el.hidden = true; return; }

  const hhmm = (ms: number) => formatRecordedTime(ms, false).slice(11, 16);
  const chips = [
    `<button class="chip-btn${s.sessionIndex < 0 ? ' is-active' : ''}" type="button" data-session="-1">
      ${formatShortDate(s.dayKey)} 전체<span class="chip-sub">${num(day.segments.length - day.eventCount)}개${day.eventCount > 0 ? ` +이벤트 ${num(day.eventCount)}` : ''}</span>
    </button>`,
    ...day.sessions.map(
      (ses, i) => `<button class="chip-btn${s.sessionIndex === i ? ' is-active' : ''}" type="button" data-session="${i}">
        ${hhmm(ses.startMs)}~${hhmm(ses.endMs)}<span class="chip-sub">${num(ses.segments.length - ses.eventCount)}개${ses.eventCount > 0 ? ` +이벤트 ${num(ses.eventCount)}` : ''}</span>
      </button>`,
    ),
  ];
  el.innerHTML = chips.join('');
  el.hidden = false;
  el.querySelectorAll<HTMLButtonElement>('[data-session]').forEach((b) => {
    b.addEventListener('click', () => {
      const idx = Number(b.dataset.session);
      if (idx === s.sessionIndex) return;
      void openDay(s.dayKey, idx);
    });
  });
}

/** 끊김 진단: 초당 디코딩·렌더 수와 버린 프레임 수 */
let debugTimer = 0;
function startDebugMeter(): void {
  const el = $('debug-note');
  el.hidden = false;
  clearInterval(debugTimer);
  let prev = [{ decoded: 0, rendered: 0, dropped: 0 }, { decoded: 0, rendered: 0, dropped: 0 }];
  let prevIo = { hits: 0, misses: 0, waitMs: 0 };
  debugTimer = window.setInterval(() => {
    const cur = session?.player.channelStats ?? [];
    if (cur.length === 0) return;
    const parts = cur.map((c, i) => {
      const p = prev[i] ?? { decoded: 0, rendered: 0, dropped: 0 };
      return `CH${i} 디코딩 ${c.decoded - p.decoded} · 렌더 ${c.rendered - p.rendered} · 버림 ${c.dropped - p.dropped}`;
    });
    prev = cur;

    // 읽기 대기 시간이 크면 끊김의 원인이 디코딩이 아니라 파일 읽기다
    const io = session?.player.ioStats;
    if (io) {
      parts.push(`읽기 대기 ${Math.round(io.waitMs - prevIo.waitMs)}ms · 미스 ${io.misses - prevIo.misses}`);
      prevIo = io;
    }
    el.textContent = parts.join('  |  ') + '  (초당)';
  }, 1000);
}

function renderSegmentsPanel(): void {
  const s = session;
  if (!s) return;
  renderSegments($('tab-segments'), s.lib, [], s.player.segmentIndex, {
    onOpen: (index) => void s.player.openSegment(index),
    onToggleFolder: () => { /* 폴더 선택은 캘린더에서 한다 */ },
  });
}

// ── 재생 컨트롤 ─────────────────────────────────────
$('btn-play').addEventListener('click', () => {
  const p = session?.player;
  if (!p) return;
  if (p.isPlaying) p.pause();
  else void p.play();
});
$('btn-prev-file').addEventListener('click', () => void session?.player.prevFile());
$('btn-next-file').addEventListener('click', () => void session?.player.nextFile());
$('btn-back10').addEventListener('click', () => void session?.player.skip(-SKIP_MS));
$('btn-fwd10').addEventListener('click', () => void session?.player.skip(SKIP_MS));

const seekEl = $<HTMLInputElement>('seek');
seekEl.addEventListener('input', () => {
  seekDragging = true;
  const s = session;
  if (!s) return;
  const seg = s.player.currentSegment;
  if (seg) updateLabelsWhileDragging(Number(seekEl.value), seg.durationMs);
});
function updateLabelsWhileDragging(pos: number, dur: number): void {
  $('time-label').textContent = `${formatDuration(pos / 1000)} / ${formatDuration(dur / 1000)}`;
  // 끌면서 벽시계가 같이 움직여야 원하는 시각을 찾을 수 있다
  const s = session;
  if (s) $('time-clock').textContent = clockOf(s.player.currentBaseMs + pos);
}

/** 절대 시각의 시:분:초. 날짜는 위쪽 "기록 시각"에 이미 있다. */
function clockOf(absMs: number): string {
  return Number.isFinite(absMs) ? formatRecordedTime(absMs, false).slice(11, 19) : '--:--:--';
}
const commitSeek = (): void => {
  if (!seekDragging || !session) return;
  seekDragging = false;
  void session.player.seekInFile(Number(seekEl.value));
};
seekEl.addEventListener('change', commitSeek);
seekEl.addEventListener('pointerup', commitSeek);

$('btn-fit-map').addEventListener('click', () => {
  if (!map?.fitAll()) toast('표시할 경로가 없습니다');
});

// ── 화면 잠김 방지 ───────────────────────────────────

/**
 * 재생 화면이 열려 있는 동안 화면을 깨워 둔다.
 *
 * 멈춰 놓고 한 장면을 들여다보는 일이 잦은데 그 사이에 화면이 꺼지면
 * 다시 켜고 잠금을 풀고 위치를 찾아야 한다.
 * 화면이 켜져 있는 것 자체가 폰에서 가장 큰 전력 소모이므로
 * **캘린더나 빈 화면으로 나가면 반드시 놓아준다.**
 */
const screenWake = createScreenWake();
/** 사용자가 직접 끄면 이번 세션 동안은 다시 켜지 않는다 */
let wakeOptedOut = false;

const WAKE_LABEL: Record<WakeState, string> = {
  on: '🔆 화면 켜둠',
  fallback: '🔆 화면 켜둠',
  off: '🌙 화면 꺼짐 허용',
  unsupported: '화면 잠김 못 막음',
};

screenWake.onChange = (state) => {
  const el = $<HTMLButtonElement>('btn-wake');
  el.textContent = WAKE_LABEL[state];
  el.classList.toggle('is-on', state === 'on' || state === 'fallback');
  el.classList.toggle('is-off', state === 'off');
  el.disabled = state === 'unsupported';
  el.title = state === 'unsupported'
    ? '이 환경에서는 화면 잠김을 막을 수 없습니다'
    : state === 'fallback'
      ? '표준 방식이 막혀 우회 방식으로 켜 두었습니다'
      : '눌러서 켜고 끕니다. 전원 버튼으로 직접 잠그는 것은 막지 못합니다.';
};

function syncWakeChip(viewName: keyof typeof views): void {
  const on = viewName === 'main';
  $('btn-wake').hidden = !on;
  if (on && !wakeOptedOut) void screenWake.enable();
  else if (!on) void screenWake.disable();
}

$('btn-wake').addEventListener('click', () => {
  wakeOptedOut = screenWake.wanted;
  void screenWake.toggle();
});

// 다른 앱에 다녀오면 잠금이 자동으로 풀려 있다. 다시 잡지 않으면 안 걸린다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void screenWake.refresh();
});

// ── 구간 내보내기 ────────────────────────────────────

/** 사용자가 고른 시간 구간. 세션이 바뀌면 다시 잡는다. */
let exportRange: TimeRange | null = null;
let rangeBusy: RangeKind | null = null;
let rangeProgress = 0;
let rangeNote = '';

/** 세션을 열 때 기본값 — 현재 파일 */
function resetExportRange(): void {
  const s = session;
  if (!s || s.lib.segments.length === 0) { exportRange = null; return; }
  const seg = s.lib.segments[Math.max(0, s.player.segmentIndex)];
  exportRange = { fromMs: seg.startMs, toMs: seg.endMs };
}

/**
 * `HH:MM:SS` 입력을 절대 시각으로.
 * 시각만 받으므로 어느 날인지는 기준 시각에서 가져오고,
 * 자정을 넘어가는 운행이면 하루를 더한다.
 */
function timeToAbs(value: string, anchorMs: number): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(anchorMs);
  const at = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Number(m[1]), Number(m[2]), Number(m[3] ?? 0),
  );
  const s = session;
  // 운행이 자정을 넘으면 "00:30"은 다음 날이다
  if (s && at < s.lib.startMs - 12 * 3600_000) return at + 86_400_000;
  return at;
}

function drawRangeExport(): void {
  const s = session;
  const el = $('range-export');
  if (!s) { el.innerHTML = ''; return; }
  if (!exportRange) resetExportRange();
  if (!exportRange) { el.innerHTML = ''; return; }

  renderRangeExport(el, {
    range: exportRange,
    segments: s.lib.segments,
    nowMs: s.player.position,
    busy: rangeBusy,
    progress: rangeProgress,
    progressNote: rangeNote,
  }, {
    onPickNow: (edge) => {
      if (!exportRange) return;
      const now = s.player.position;
      if (edge === 'from') {
        exportRange = { fromMs: now, toMs: Math.max(now + 1000, exportRange.toMs) };
      } else {
        exportRange = { fromMs: Math.min(exportRange.fromMs, now - 1000), toMs: now };
      }
      drawRangeExport();
    },
    onEditTime: (edge, value) => {
      if (!exportRange) return;
      const at = timeToAbs(value, edge === 'from' ? exportRange.fromMs : exportRange.toMs);
      if (at === null) { toast('시각 형식이 올바르지 않습니다 (HH:MM:SS)'); drawRangeExport(); return; }
      exportRange = edge === 'from'
        ? { ...exportRange, fromMs: at }
        : { ...exportRange, toMs: at };
      drawRangeExport();
    },
    onPreset: (preset) => {
      if (!exportRange) return;
      if (preset === 'file') { resetExportRange(); drawRangeExport(); return; }
      if (preset === 'session') {
        exportRange = { fromMs: s.lib.startMs, toMs: s.lib.endMs };
        drawRangeExport();
        return;
      }
      exportRange = { fromMs: exportRange.fromMs, toMs: exportRange.fromMs + preset * 60_000 };
      drawRangeExport();
    },
    onExport: (kind) => void runRangeExport(kind),
  });
}

async function runRangeExport(kind: RangeKind): Promise<void> {
  const s = session;
  if (!s || !exportRange || rangeBusy) return;
  const range = exportRange;

  rangeBusy = kind;
  rangeProgress = 0;
  rangeNote = '';
  drawRangeExport();
  try {
    const report = (p: { ratio: number; name: string; index: number; total: number }) => {
      rangeProgress = p.ratio * 100;
      rangeNote = p.name ? `${p.name} (${p.index}/${p.total})` : '';
      drawRangeExport();
    };
    // 영상은 MP4로 만든다 — 아무 데서나 열려야 쓸모가 있다
    const result = kind === 'both'
      ? await buildCompositeMp4(s.lib.segments, s.loader, range, codecOverride, report)
      : isVideoKind(kind)
        ? await buildRangeMp4(kind === 'front' ? 0 : 1, s.lib.segments, s.loader, range, report)
        : await buildRange(kind, s.lib.segments, s.loader, range, report);

    const name = rangeFileName(range, kind);
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    // 키프레임 때문에 실제 시작이 이를 수 있다 — 숨기지 않고 알린다
    const lead = Math.round((range.fromMs - result.actualFromMs) / 100) / 10;
    const notes: string[] = [];
    if (lead >= 0.1) notes.push(`키프레임 때문에 ${lead}초 일찍 시작`);
    if (isVideoKind(kind) && 'hasAudio' in result && !result.hasAudio) {
      notes.push('이 브라우저에 소리 인코더가 없어 영상만 담았습니다');
    }
    toast(`${name} 저장 · ${bytes(result.blob.size)}${notes.length ? ` (${notes.join(' · ')})` : ''}`);
  } catch (e) {
    toast(`${RANGE_LABEL[kind]} 내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rangeBusy = null;
    drawRangeExport();
  }
}

// ── 대화(말한 구간) ──────────────────────────────────

/**
 * 구간마다 결과를 들고 있는다. 구간을 왔다 갔다 해도 다시 훑지 않게.
 * 파일 하나가 70MB라 다시 읽는 값이 싸지 않다.
 */
const speechByPath = new Map<string, SpeechResult>();
let speechBusy = false;
let speechProgress = 0;

function speechState(): SpeechPanelState {
  const s = session;
  const seg = s ? s.lib.segments[s.player.segmentIndex] : null;
  const doc = s?.player.currentDoc ?? null;
  return {
    busy: speechBusy,
    progress: speechProgress,
    result: seg ? speechByPath.get(seg.path) ?? null : null,
    targetName: seg?.name ?? '현재 구간',
    noAudio: !!doc && doc.audio.packetCount === 0,
  };
}

function drawSpeechPanel(): void {
  renderSpeechPanel($('tab-speech'), speechState(), {
    onAnalyze: () => void runSpeechAnalysis(),
    onGoto: (relMs) => void session?.player.seekInFile(relMs),
    onSaveWav: () => saveSpeech('wav'),
    onSaveCsv: () => saveSpeech('csv'),
  });
}

async function runSpeechAnalysis(): Promise<void> {
  const s = session;
  const doc = s?.player.currentDoc;
  const src = s?.player.currentSource;
  const seg = s?.lib.segments[s.player.segmentIndex];
  if (!s || !doc || !src || !seg || speechBusy) return;

  speechBusy = true;
  speechProgress = 0;
  drawSpeechPanel();
  try {
    const result = await analyzeSegment(src, doc, { path: seg.path, name: seg.name }, undefined,
      (done, total) => {
        speechProgress = total > 0 ? (done / total) * 100 : 0;
        drawSpeechPanel();
      });
    speechByPath.set(seg.path, result);
    toast(result.spans.length > 0
      ? `말소리 ${num(result.spans.length)}곳을 찾았습니다`
      : '말소리를 찾지 못했습니다');
  } catch (e) {
    toast(`음성을 훑지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    speechBusy = false;
    drawSpeechPanel();
    drawTalkBands();
  }
}

function saveSpeech(kind: 'wav' | 'csv'): void {
  const s = session;
  const seg = s?.lib.segments[s.player.segmentIndex];
  const result = seg ? speechByPath.get(seg.path) : null;
  if (!result || result.spans.length === 0) return;

  const base = result.name.replace(/\.jdr$/i, '');
  const blob = kind === 'wav'
    ? buildSpeechWav([result])
    : new Blob([buildSpeechCsv([result])], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}_speech.${kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`${a.download} 저장 · ${bytes(blob.size)}`);
}

/** 찾아 둔 말한 구간을 타임라인 위에 띠로 얹는다 */
function drawTalkBands(): void {
  const s = session;
  const track = $('strip-track');
  track.querySelectorAll('.strip-talk').forEach((el) => el.remove());
  if (!s?.merged || !stripLayout) return;

  const cursor = track.querySelector('#strip-cursor');
  for (let i = 0; i < s.lib.segments.length; i++) {
    const seg = s.lib.segments[i];
    const r = speechByPath.get(seg.path);
    if (!r) continue;
    for (const span of r.spans) {
      const from = stripLayout.ratioAt(seg.startMs + span.startMs);
      const to = stripLayout.ratioAt(seg.startMs + span.endMs);
      const el = document.createElement('span');
      el.className = 'strip-talk';
      el.style.left = `${from * 100}%`;
      // 짧은 말도 보이도록 최소 폭을 준다
      el.style.width = `max(3px, ${(to - from) * 100}%)`;
      track.insertBefore(el, cursor);
    }
  }
}

// ── 즐겨찾기 ────────────────────────────────────────

const bookmarkStore = new BookmarkStore();
let bookmarks: Bookmark[] = [];

void bookmarkStore.all().then((list) => {
  bookmarks = list;
  refreshBookmarkUi(true);
});

/** 지금 재생 중인 지점을 즐겨찾기 형태로 적는다 */
function currentPoint(): Omit<Bookmark, 'label' | 'createdAt'> | null {
  const s = session;
  if (!s) return null;
  const seg = s.lib.segments[s.player.segmentIndex];
  if (!seg) return null;
  const relMs = Math.max(0, s.player.filePosition);
  return {
    id: bookmarkId(seg.path, relMs),
    absMs: s.player.position,
    dayKey: s.dayKey,
    path: seg.path,
    name: seg.name,
    relMs,
  };
}

/**
 * 별 표시를 갱신한다.
 *
 * 재생 중에는 초당 60번 불리므로, **값이 실제로 바뀔 때만** DOM을 건드린다.
 * (열려 있는 목록을 매 프레임 다시 그리면 스크롤이 튄다)
 */
let lastStarState = '';
function refreshBookmarkUi(force = false): void {
  const here = currentPoint();
  const on = here ? bookmarkAt(bookmarks, here.path, here.relMs) : null;
  const state = `${bookmarks.length}|${on?.id ?? ''}`;
  if (state === lastStarState && !force) return;
  const listChanged = lastStarState.split('|')[0] !== String(bookmarks.length);
  lastStarState = state;

  $('bm-count').textContent = String(bookmarks.length);
  $('btn-bookmarks').classList.toggle('is-empty', bookmarks.length === 0);

  const add = $('btn-bookmark');
  add.textContent = on ? '★' : '☆';
  add.classList.toggle('is-on', !!on);
  add.setAttribute('aria-label', on ? '즐겨찾기 해제' : '이 지점 즐겨찾기');

  if (!$('bm-overlay').hidden && (listChanged || force)) drawBookmarkPanel();
}

function drawBookmarkPanel(): void {
  renderBookmarkPanel($('bm-panel'), bookmarks, bookmarkStore.persistent, {
    onGoto: (id) => void gotoBookmark(id),
    onRename: (id) => {
      const b = bookmarks.find((x) => x.id === id);
      if (!b) return;
      const next = prompt('즐겨찾기 이름', b.label);
      if (next === null) return;
      b.label = next.trim() || defaultLabel(b.absMs);
      void bookmarkStore.put([b]);
      refreshBookmarkUi(true);
    },
    onRemove: (id) => {
      bookmarks = bookmarks.filter((x) => x.id !== id);
      void bookmarkStore.remove(id);
      refreshBookmarkUi(true);
    },
    onSaveFile: () => saveBookmarkFile(),
    onLoadFile: () => $<HTMLInputElement>('bm-file-input').click(),
    onClose: () => closeBookmarkPanel(),
  });
}

function openBookmarkPanel(): void {
  $('bm-overlay').hidden = false;
  drawBookmarkPanel();
}

function closeBookmarkPanel(): void {
  $('bm-overlay').hidden = true;
}

function toggleBookmarkHere(): void {
  const here = currentPoint();
  if (!here) { toast('재생 중일 때만 담을 수 있습니다'); return; }

  const existing = bookmarkAt(bookmarks, here.path, here.relMs);
  if (existing) {
    bookmarks = bookmarks.filter((b) => b.id !== existing.id);
    void bookmarkStore.remove(existing.id);
    toast('즐겨찾기에서 뺐습니다');
  } else {
    const b: Bookmark = { ...here, label: defaultLabel(here.absMs), createdAt: Date.now() };
    bookmarks = sortBookmarks([...bookmarks, b]);
    void bookmarkStore.put([b]);
    toast(`즐겨찾기에 담았습니다 — ${b.label}`);
  }
  refreshBookmarkUi(true);
}

/**
 * 즐겨찾기 지점으로 간다.
 * 지금 열린 운행 밖이면 그 날짜·운행을 먼저 연다 — 캘린더로 돌아갈 필요가 없다.
 */
async function gotoBookmark(id: string): Promise<void> {
  const b = bookmarks.find((x) => x.id === id);
  if (!b) return;
  closeBookmarkPanel();

  const s = session;
  if (s?.lib.segments.some((x) => x.path === b.path)) {
    await s.player.seek(b.absMs);
    return;
  }

  const fs = folderState;
  if (fs) {
    for (const [key, day] of fs.calendar.byKey) {
      const si = day.sessions.findIndex((ss) => ss.segments.some((x) => x.path === b.path));
      if (si < 0) continue;
      await openDay(key, si);
      await session?.player.seek(b.absMs);
      return;
    }
    toast('이 즐겨찾기의 파일을 지금 열린 폴더에서 찾지 못했습니다 (폴더 선택을 확인하세요)');
    return;
  }
  toast(`이 즐겨찾기는 ${b.name}에 있습니다. 그 파일이 든 폴더를 열어 주세요`);
}

function saveBookmarkFile(): void {
  if (bookmarks.length === 0) { toast('저장할 즐겨찾기가 없습니다'); return; }
  const blob = new Blob([serializeBookmarks(bookmarks)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = BOOKMARK_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`${BOOKMARK_FILE_NAME} 저장 · ${num(bookmarks.length)}개`);
}

$('btn-bookmarks').addEventListener('click', () => {
  if ($('bm-overlay').hidden) openBookmarkPanel();
  else closeBookmarkPanel();
});
$('btn-bookmark').addEventListener('click', () => toggleBookmarkHere());
$('bm-overlay').addEventListener('click', (e) => {
  // 패널 바깥(어두운 곳)을 누르면 닫는다
  if (e.target === $('bm-overlay')) closeBookmarkPanel();
});

$<HTMLInputElement>('bm-file-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const incoming = parseBookmarks(await file.text());
    const { list, added } = mergeBookmarks(bookmarks, incoming);
    bookmarks = list;
    await bookmarkStore.put(incoming);
    toast(added > 0 ? `${num(added)}개를 불러왔습니다` : '새로 들어온 즐겨찾기가 없습니다');
    refreshBookmarkUi(true);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

/**
 * 화면 폭이 바뀌면 스트립을 다시 그린다.
 * 최소 구간 폭이 픽셀 기준이라(7px) 폭이 달라지면 축 자체가 달라진다.
 */
let stripResizeTimer = 0;
window.addEventListener('resize', () => {
  const s = session;
  if (!s?.merged) return;
  clearTimeout(stripResizeTimer);
  stripResizeTimer = window.setTimeout(() => {
    if (!session?.merged) return;
    stripLayout = renderStrip($('strip-track'), session.lib);
    markActiveSegment($('strip-track'), session.player.segmentIndex);
    updateStripCursor($('strip-track'), stripLayout, session.player.position);
  }, 150);
});

attachStripScrub($('strip-track'), $('strip-bubble'), {
  layout: () => (session?.merged ? stripLayout : null),
  label: (absMs, segIndex) => {
    const s = session;
    const seg = s?.lib.segments[segIndex];
    const time = formatRecordedTime(absMs, false).slice(11, 19);
    if (!seg || !s) return time;
    return `${time}\n${seg.name} · ${segIndex + 1}/${s.lib.segments.length}`;
  },
  // 끄는 동안에는 커서만 옮긴다. 여기서 seek하면 매 프레임 파싱이 걸린다.
  onPreview: (absMs) => updateStripCursor($('strip-track'), stripLayout, absMs),
  onCommit: (absMs) => void session?.player.seek(absMs),
});

$<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  session?.player.setSpeed(Number((e.target as HTMLSelectElement).value));
});
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  session?.player.setMuted(muted);
  $('btn-mute').textContent = muted ? '🔇' : '🔊';
});

document.addEventListener('keydown', (e) => {
  const p = session?.player;
  if (!p || views.main.hidden) return;
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (p.isPlaying) p.pause();
      else void p.play();
      break;
    case 'ArrowLeft': void p.skip(-SKIP_MS); break;
    case 'ArrowRight': void p.skip(SKIP_MS); break;
    case 'Comma': void p.step(-1); break;   // 프레임 단위는 키보드로
    case 'Period': void p.step(1); break;
    case 'BracketLeft': void p.prevFile(); break;
    case 'BracketRight': void p.nextFile(); break;
    default: break;
  }
});

// ── 탭 ──────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    $(`tab-${tab.dataset.tab}`).classList.add('is-active');
    if (tab.dataset.tab === 'map') map?.invalidate();
    if (tab.dataset.tab === 'sensor') charts?.resize();
    if (tab.dataset.tab === 'speech') drawSpeechPanel();
    if (tab.dataset.tab === 'export') drawRangeExport();
  });
});

window.addEventListener('resize', () => {
  map?.invalidate();
  charts?.resize();
});

// 화면이 가려지면 재생을 멈춘다 — 백그라운드에서 디코더를 돌려 배터리를 쓸 이유가 없다
document.addEventListener('visibilitychange', () => {
  if (document.hidden) session?.player.pause();
});

$('codec-note').textContent = hasWebCodecs()
  ? '이 브라우저는 WebCodecs를 지원합니다 — 변환 없이 바로 재생할 수 있습니다.'
  : '이 브라우저는 WebCodecs 미지원입니다 — 요약·GPS·센서·내보내기는 동작하지만 영상 재생은 되지 않습니다.';
