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
import { probeSegment, type SegmentInfo } from './core/segment';
import { formatDuration, formatRecordedTime } from './core/time';
import type { JdrDocument, ParseProgress } from './core/types';
import { JdrParseJob } from './parse-client';
import { MergedRecords, RecordScanJob } from './scan-client';
import { FileSegmentLoader } from './player/loader';
import { SequencePlayer } from './player/sequence';
import { hasWebCodecs } from './player/index';
import type { PlayerStatus } from './player/player';
import { renderCalendar, type LoadStats } from './ui/calendar';
import { renderSummary } from './ui/summary';
import { GpsMap } from './ui/map';
import { TimeCharts } from './ui/charts';
import { renderExports } from './ui/exports';
import {
  highlightSegmentRow, markActiveSegment, renderSegments, renderStrip, updateStripCursor,
  type FolderStat,
} from './ui/segments';
import { bytes, num } from './ui/format';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const views = {
  empty: $('view-empty'),
  loading: $('view-loading'),
  error: $('view-error'),
  calendar: $('view-calendar'),
  main: $('view-main'),
};

const CONTROL_IDS = ['btn-play', 'btn-prev-file', 'btn-next-file', 'btn-back10', 'btn-fwd10', 'seek', 'speed', 'btn-mute'];
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
      seg.endMs = doc.lastTimeMs;
      seg.durationMs = doc.durationSec * 1000;
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

  // ② 없으면 브라우저 캐시, ③ 그것도 없으면 헤더를 직접 읽는다
  const keys = jdrFiles.map(cacheKeyOf);
  const cached = indexMap.size > 0 ? new Map() : await probeCache.getMany(keys);
  const stats: LoadStats = { total: jdrFiles.length, fromIndexFile: 0, fromCache: 0, probed: 0, indexError };

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
      seg = fromCacheValue(hit, meta);
      stats.fromCache++;
    } else {
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
  if (stats.fromIndexFile > 0) toast(`인덱스 파일에서 ${num(stats.fromIndexFile)}개를 읽어 훑기를 건너뛰었습니다`);
  else if (stats.fromCache > 0) toast(`${num(stats.fromCache)}개는 브라우저 캐시에서 읽었습니다`);
  drawCalendar();
  showView('calendar');
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
  const list = [...map.values()].sort((a, b) => b.durationMs - a.durationMs);
  if (list.length > 0) list[0].selected = true;
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
    onExportIndex: () => exportIndexFile(),
  }, fs.stats);
}

/** 훑은 결과를 파일로 내보낸다. 폴더에 넣어두면 다음에 열 때 훑기를 건너뛴다. */
function exportIndexFile(): void {
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
  toast(`${INDEX_FILE_NAME} 저장 · ${num(items.length)}개 · ${bytes(blob.size)} — 이 폴더에 넣어두세요`);
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
  s.player.onSegmentLoading = (index) => {
    const seg = s.lib.segments[index];
    for (let ch = 0; ch < 2; ch++) $(`ch${ch}-note`).textContent = '여는 중…';
    if (seg) $('file-note').textContent = `구간 ${index + 1}/${s.lib.segments.length} · 출처 ${seg.path}`;
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

  renderSummary($('tab-summary'), { doc, lib: s.lib, segment: seg, merged: s.merged });
  if (doc && s.player.currentSource) {
    renderExports($('tab-export'), doc, s.player.currentSource, toast, s.merged ? seg?.name : undefined);
  }
  if (s.merged) {
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
  $('file-note').textContent = seg
    ? `구간 ${segIndex + 1}/${s.lib.segments.length} · 출처 ${seg.path}`
    : '';

  if (s.merged) updateStripCursor($('strip-track'), stripLayout, absMs);
  const fix = map?.syncTo(absMs) ?? null;
  charts?.syncTo((absMs - s.lib.startMs) / 1000);

  const parts = [`기록 시각 ${formatRecordedTime(absMs)}`];
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
      ${s.dayKey.slice(5)} 전체<span class="chip-sub">${num(day.segments.length)}개</span>
    </button>`,
    ...day.sessions.map(
      (ses, i) => `<button class="chip-btn${s.sessionIndex === i ? ' is-active' : ''}" type="button" data-session="${i}">
        ${hhmm(ses.startMs)}~${hhmm(ses.endMs)}<span class="chip-sub">${num(ses.segments.length)}개</span>
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

$('strip-track').addEventListener('click', (e) => {
  const s = session;
  if (!s || !s.merged || !stripLayout) return;
  const rect = ($('strip-track') as HTMLElement).getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, ((e as MouseEvent).clientX - rect.left) / rect.width));
  void s.player.seek(stripLayout.timeAt(ratio));
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
