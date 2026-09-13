/** 화면 배선. 무거운 일은 worker와 player가 한다. */
import './styles.css';
import { BlobByteSource } from './core/byte-source';
import { buildLibrary, type Library } from './core/library';
import { probeSegment, type SegmentInfo } from './core/segment';
import { formatDuration, formatRecordedTime } from './core/time';
import type { JdrDocument, ParseProgress } from './core/types';
import { JdrParseJob } from './parse-client';
import { MergedRecords, RecordScanJob } from './scan-client';
import { FileSegmentLoader } from './player/loader';
import { SequencePlayer } from './player/sequence';
import { hasWebCodecs } from './player/index';
import type { PlayerStatus } from './player/player';
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
  main: $('view-main'),
};

const CONTROL_IDS = ['btn-play', 'btn-prev', 'btn-next', 'seek', 'speed', 'btn-mute'];

interface Session {
  merged: boolean;
  allSegments: SegmentInfo[];
  folders: FolderStat[];
  lib: Library;
  files: Map<string, File>;
  loader: FileSegmentLoader;
  player: SequencePlayer;
  records: MergedRecords;
  scan: RecordScanJob | null;
}

let session: Session | null = null;
let parseJob: JdrParseJob | null = null;
let map: GpsMap | null = null;
let charts: TimeCharts | null = null;
let seekDragging = false;
let muted = false;

/** ?codec= 로 들어온 값이 코덱 문자열 모양이 아니면 무시한다 */
function readCodecOverride(): string | undefined {
  const raw = new URLSearchParams(location.search).get('codec')?.trim();
  if (!raw || raw === 'undefined' || raw === 'null') return undefined;
  return /^[a-z0-9][a-z0-9.\-_]*$/i.test(raw) ? raw : undefined;
}
const codecOverride = readCodecOverride();

function showView(name: keyof typeof views): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
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
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  void handleDrop(e as DragEvent);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/** 폴더를 끌어다 놓으면 하위까지 훑는다 */
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
      // 드롭으로 들어온 파일에는 webkitRelativePath가 없으므로 직접 심어 준다
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

async function openSingleFile(file: File): Promise<void> {
  await teardown();
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
    // 프로브가 실패해도 파싱은 됐으므로 파싱 결과로 시간 범위를 채운다
    if (seg.error || !Number.isFinite(seg.startMs)) {
      seg.error = undefined;
      seg.startMs = doc.firstTimeMs;
      seg.endMs = doc.lastTimeMs;
      seg.durationMs = doc.durationSec * 1000;
      seg.timeSource = 'packets';
    }
    await startSession([seg], new Map([[seg.id, file]]), false, doc);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

function setBar(pct: number): void {
  ($('loading-bar') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

function showParseProgress(p: ParseProgress): void {
  $('loading-phase').textContent = PHASE_LABEL[p.phase] ?? '처리 중…';
  if (p.phase === 'analyze') { setBar(100); return; }
  const pct = p.total > 0 ? (p.done / p.total) * 100 : 0;
  setBar(p.phase === 'scan' ? pct * 0.6 : 60 + pct * 0.4);
}

// ── 폴더 ────────────────────────────────────────────
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

  // webkitRelativePath에는 고른 폴더 이름이 앞에 붙는다. 떼어내야 data/ event/ 로 보인다.
  const rawPaths = jdrFiles.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
  const root = commonRootPrefix(rawPaths);

  // 헤더 512바이트만 읽으므로 파일당 1ms 수준이다
  const segments: SegmentInfo[] = [];
  const files = new Map<string, File>();
  for (let i = 0; i < jdrFiles.length; i++) {
    const f = jdrFiles[i];
    const path = rawPaths[i].startsWith(root) ? rawPaths[i].slice(root.length) : rawPaths[i];
    const seg = await probeSegment({
      src: new BlobByteSource(f, f.name), name: f.name, path, size: f.size,
    });
    segments.push(seg);
    files.set(seg.id, f);
    if ((i & 15) === 0) {
      setBar((i / jdrFiles.length) * 100);
      $('loading-detail').textContent = `${num(i + 1)} / ${num(jdrFiles.length)}개 훑는 중`;
      await new Promise((r) => setTimeout(r, 0)); // UI가 그려질 틈을 준다
    }
  }
  setBar(100);

  if (segments.every((s) => s.error)) {
    showError(`${num(segments.length)}개 파일을 모두 읽지 못했습니다. 지원하지 않는 JDR 변형일 수 있습니다.`);
    return;
  }
  await startSession(segments, files, true, null);
}

/** 모든 경로가 같은 최상위 폴더에 있으면 그 이름을 떼어낸다 */
function commonRootPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const first = paths[0];
  const slash = first.indexOf('/');
  if (slash < 0) return '';
  const root = first.slice(0, slash + 1);
  return paths.every((p) => p.startsWith(root)) ? root : '';
}

/** 폴더별 통계. 기본 선택은 "가장 길게 찍힌 폴더" 하나 — 겹치는 event까지 넣으면 구간이 중복된다. */
function buildFolderStats(segments: SegmentInfo[]): FolderStat[] {
  const map = new Map<string, FolderStat>();
  for (const s of segments) {
    if (s.error) continue;
    const key = s.folder;
    const cur = map.get(key) ?? { folder: key, count: 0, bytes: 0, durationMs: 0, selected: false };
    cur.count++;
    cur.bytes += s.size;
    cur.durationMs += s.durationMs;
    map.set(key, cur);
  }
  const list = [...map.values()].sort((a, b) => b.durationMs - a.durationMs);
  if (list.length > 0) list[0].selected = true;
  if (list.length === 1) list[0].selected = true;
  return list;
}

function selectedSegments(segments: SegmentInfo[], folders: FolderStat[]): SegmentInfo[] {
  const on = new Set(folders.filter((f) => f.selected).map((f) => f.folder));
  return segments.filter((s) => s.error || on.has(s.folder));
}

// ── 세션 ────────────────────────────────────────────
async function teardown(): Promise<void> {
  session?.scan?.stop();
  session?.player.close();
  session?.loader.clear();
  parseJob?.cancel();
  charts?.destroy();
  session = null;
  setControlsEnabled(false);
}

async function startSession(
  segments: SegmentInfo[],
  files: Map<string, File>,
  merged: boolean,
  preparsed: JdrDocument | null,
): Promise<void> {
  const folders = merged ? buildFolderStats(segments) : [];
  const lib = buildLibrary(merged ? selectedSegments(segments, folders) : segments);
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
  const records = new MergedRecords();
  session = { merged, allSegments: segments, folders, lib, files, loader, player, records, scan: null };

  // 단일 파일은 이미 파싱해 두었으므로 다시 읽지 않는다
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
  const segTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="segments"]')!;
  segTab.hidden = !s.merged;

  map = new GpsMap($('map'));
  charts = new TimeCharts($('chart-speed'), $('chart-gsensor'));

  if (s.merged) {
    renderStrip($('strip-track'), s.lib);
    $('strip-start').textContent = formatRecordedTime(s.lib.startMs, false);
    $('strip-end').textContent = formatRecordedTime(s.lib.endMs, false);
    renderSegmentsPanel();
  }

  const seek = $<HTMLInputElement>('seek');
  seek.min = '0';
  seek.max = String(Math.max(1, Math.round(s.lib.spanMs)));
  seek.value = '0';

  s.player.onTimeUpdate = (absMs, segIndex) => {
    if (!seekDragging) seek.value = String(Math.round(absMs - s.lib.startMs));
    updateTimeLabels(absMs, segIndex);
  };
  s.player.onPlayingChange = (playing) => {
    $('btn-play').textContent = playing ? '❚❚' : '▶';
    $('btn-play').setAttribute('aria-label', playing ? '일시정지' : '재생');
  };
  s.player.onSegmentChange = (index, status) => onSegmentChange(index, status);

  updateTimeLabels(s.lib.startMs, 0);
  await s.player.init();
  setControlsEnabled(true);

  if (!hasWebCodecs()) toast('이 브라우저는 WebCodecs 미지원 — 영상 재생만 비활성화됩니다');
  else if (codecOverride) toast(`코덱을 ${codecOverride}(으)로 강제 지정했습니다`);

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
  for (let ch = 0; ch < 2; ch++) {
    const st = status?.channels[ch];
    $(`ch${ch}-note`).textContent = st?.available
      ? `${st.width || '?'}×${st.height || '?'} · ${doc?.video[ch]?.fps.toFixed(1) ?? '?'}fps`
      : st?.reason ?? '영상 없음';
  }
  // 단일 파일 모드에서는 스캔 없이 문서에서 바로 그린다
  if (!s.merged && doc) {
    drawRecords(doc.firstTimeMs, doc.gps, doc.gsensor);
  }
}

function drawRecords(
  t0: number,
  gps: JdrDocument['gps'],
  gsensor: JdrDocument['gsensor'],
): void {
  const r = map?.render(gps);
  if (r) {
    $('map-note').textContent =
      r.shown === 0
        ? 'GPS 좌표가 없습니다 (위성 미수신이거나 GPS 패킷이 없는 구간).'
        : `${num(r.shown)}개 지점 표시${r.dropped > 0 ? ` · 위성 미수신 ${num(r.dropped)}건 제외` : ''}`;
  }
  charts?.render({ t0, gps, gsensor });
}

/** 전 구간 GPS·G센서 백그라운드 스캔 (D4) */
function startRecordScan(): void {
  const s = session;
  if (!s || !s.merged) return;
  const items = s.lib.segments
    .map((seg) => ({ seg, file: s.files.get(seg.id) }))
    .filter((x): x is { seg: SegmentInfo; file: File } => !!x.file);

  s.scan = new RecordScanJob();
  $('scan-note').textContent = `전 구간 GPS·센서 스캔 중… 0 / ${num(items.length)}`;
  let lastDraw = 0;

  void s.scan.run(items, (chunk) => {
    if (session !== s) return;
    s.records.add(chunk);
    $('scan-note').textContent =
      chunk.done >= chunk.total
        ? `전 구간 스캔 완료 · GPS ${num(s.records.gps.length)}건 · 센서 ${num(s.records.sensorCount)}건`
        : `전 구간 GPS·센서 스캔 중… ${num(chunk.done)} / ${num(chunk.total)}`;
    const now = performance.now();
    if (chunk.done >= chunk.total || now - lastDraw > 1500) {
      lastDraw = now;
      s.records.finish();
      drawRecords(s.lib.startMs, s.records.gps, s.records.gsensor);
    }
  });
}

function renderSegmentsPanel(): void {
  const s = session;
  if (!s) return;
  renderSegments($('tab-segments'), s.lib, s.folders, s.player.segmentIndex, {
    onOpen: (index) => void s.player.openSegment(index),
    onToggleFolder: (folder, selected) => {
      const f = s.folders.find((x) => x.folder === folder);
      if (!f) return;
      f.selected = selected;
      if (s.folders.every((x) => !x.selected)) {
        f.selected = true;
        toast('폴더를 최소 하나는 선택해야 합니다');
        renderSegmentsPanel();
        return;
      }
      void rebuildLibrary();
    },
  });
}

/** 폴더 선택이 바뀌면 타임라인을 다시 만든다 */
async function rebuildLibrary(): Promise<void> {
  const s = session;
  if (!s) return;
  const at = s.player.position;
  s.scan?.stop();
  s.player.close();
  s.lib = buildLibrary(selectedSegments(s.allSegments, s.folders));
  if (s.lib.segments.length === 0) {
    showError('선택한 폴더에 재생할 수 있는 구간이 없습니다.');
    return;
  }
  s.records = new MergedRecords();
  const player = new SequencePlayer(
    s.lib, s.loader,
    [$<HTMLCanvasElement>('canvas-0'), $<HTMLCanvasElement>('canvas-1')],
    toast, codecOverride,
  );
  session = { ...s, player };
  await mount();
  await session.player.seek(at);
}

function updateTimeLabels(absMs: number, segIndex: number): void {
  const s = session;
  if (!s) return;
  const rel = absMs - s.lib.startMs;
  $('time-label').textContent = `${formatDuration(rel / 1000)} / ${formatDuration(s.lib.spanMs / 1000)}`;
  if (s.merged) updateStripCursor($('strip-track'), s.lib, absMs);

  const fix = map?.syncTo(absMs) ?? null;
  charts?.syncTo((absMs - (s.merged ? s.lib.startMs : s.lib.segments[0].startMs)) / 1000);

  const parts = [`기록 시각 ${formatRecordedTime(absMs)}`];
  if (fix) parts.push(`${fix.speed.toFixed(1)} km/h (추정)`, `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`);
  $('recorded-time').textContent = parts.join('  ·  ');

  // 증거 추적성: 지금 보이는 프레임이 어느 파일에서 왔는지 항상 밝힌다
  const seg = s.lib.segments[segIndex];
  $('source-note').textContent = s.merged && seg
    ? `출처 ${seg.path}  ·  구간 ${segIndex + 1}/${s.lib.segments.length}`
    : '';
}

// ── 재생 컨트롤 ─────────────────────────────────────
$('btn-play').addEventListener('click', () => {
  const p = session?.player;
  if (!p) return;
  if (p.isPlaying) p.pause();
  else void p.play();
});
$('btn-prev').addEventListener('click', () => void session?.player.step(-1));
$('btn-next').addEventListener('click', () => void session?.player.step(1));

const seekEl = $<HTMLInputElement>('seek');
seekEl.addEventListener('input', () => {
  seekDragging = true;
  if (session) updateTimeLabels(session.lib.startMs + Number(seekEl.value), session.player.segmentIndex);
});
const commitSeek = (): void => {
  if (!seekDragging || !session) return;
  seekDragging = false;
  void session.player.seek(session.lib.startMs + Number(seekEl.value));
};
seekEl.addEventListener('change', commitSeek);
seekEl.addEventListener('pointerup', commitSeek);

$('strip-track').addEventListener('click', (e) => {
  const s = session;
  if (!s || !s.merged) return;
  const rect = ($('strip-track') as HTMLElement).getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, ((e as MouseEvent).clientX - rect.left) / rect.width));
  void s.player.seek(s.lib.startMs + ratio * s.lib.spanMs);
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
  if (e.code === 'Space') {
    e.preventDefault();
    if (p.isPlaying) p.pause();
    else void p.play();
  } else if (e.code === 'ArrowRight') void p.step(1);
  else if (e.code === 'ArrowLeft') void p.step(-1);
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

$('codec-note').textContent = hasWebCodecs()
  ? '이 브라우저는 WebCodecs를 지원합니다 — 변환 없이 바로 재생할 수 있습니다.'
  : '이 브라우저는 WebCodecs 미지원입니다 — 요약·GPS·센서·내보내기는 동작하지만 영상 재생은 되지 않습니다.';
