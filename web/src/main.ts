/** 화면 배선. 무거운 일은 전부 worker와 player가 한다. */
import './styles.css';
import { BlobByteSource } from './core/byte-source';
import type { JdrDocument, ParseProgress } from './core/types';
import { formatDuration, formatRecordedTime } from './core/time';
import { JdrPlayer } from './player/player';
import { hasWebCodecs } from './player/index';
import { renderSummary } from './ui/summary';
import { GpsMap } from './ui/map';
import { TimeCharts } from './ui/charts';
import { renderExports } from './ui/exports';
import { bytes } from './ui/format';
import { JdrParseJob } from './parse-client';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const views = {
  empty: $('view-empty'),
  loading: $('view-loading'),
  error: $('view-error'),
  main: $('view-main'),
};

let job: JdrParseJob | null = null;
let player: JdrPlayer | null = null;
let doc: JdrDocument | null = null;
let source: BlobByteSource | null = null;
let map: GpsMap | null = null;
let charts: TimeCharts | null = null;
let seekDragging = false;

function showView(name: keyof typeof views): void {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

const CONTROL_IDS = ['btn-play', 'btn-prev', 'btn-next', 'seek', 'speed', 'btn-mute'];

/**
 * 플레이어가 준비되기 전의 클릭은 조용히 무시되어 "눌러도 아무 일이 없는" 상태가 된다.
 * 준비될 때까지 아예 못 누르게 막는다.
 */
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
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 3200);
}

// ── 파일 선택 ─────────────────────────────────────────
const fileInput = $<HTMLInputElement>('file-input');
const pick = (): void => fileInput.click();
$('btn-open').addEventListener('click', pick);
$('btn-open-2').addEventListener('click', pick);
$('btn-retry').addEventListener('click', pick);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = ''; // 같은 파일을 다시 선택해도 change가 뜨도록
});

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('is-over'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void openFile(f);
});
// 창 전체에서 실수로 파일을 열어 페이지가 날아가는 것을 막는다
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ── 파싱 ─────────────────────────────────────────────
const PHASE_LABEL: Record<string, string> = {
  hash: '해시 계산 중…',
  scan: '파일을 훑는 중 (해시 + 블록 탐색)…',
  packets: '패킷을 읽는 중…',
  analyze: '분석 중…',
};

let fellBackToMainThread = false;

async function openFile(file: File): Promise<void> {
  setControlsEnabled(false);
  player?.close();
  player = null;
  charts?.destroy();
  job?.cancel();

  showView('loading');
  $('loading-detail').textContent = `${file.name} · ${bytes(file.size)}`;
  $('loading-phase').textContent = '파일을 읽는 중…';
  ($('loading-bar') as HTMLElement).style.width = '0%';
  fellBackToMainThread = false;

  job = new JdrParseJob();
  try {
    const parsed = await job.run(file, showProgress, () => {
      fellBackToMainThread = true;
      $('loading-detail').textContent =
        `${file.name} · ${bytes(file.size)} — 이 환경에서는 워커를 쓸 수 없어 조금 느릴 수 있습니다`;
    });
    doc = parsed;
    source = new BlobByteSource(file, file.name);
    await mount(parsed, source);
    if (fellBackToMainThread) {
      toast('워커 없이 처리했습니다 — 로컬 서버로 열면 더 빠릅니다');
    }
  } catch (err) {
    $('error-message').textContent = err instanceof Error ? err.message : String(err);
    showView('error');
  }
}

function showProgress(p: ParseProgress): void {
  $('loading-phase').textContent = PHASE_LABEL[p.phase] ?? '처리 중…';
  if (p.phase === 'analyze') {
    ($('loading-bar') as HTMLElement).style.width = '100%';
    return;
  }
  const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  // scan이 전체의 60%, packets가 나머지 40%를 차지하도록 눈금을 나눈다
  const scaled = p.phase === 'scan' ? pct * 0.6 : 60 + pct * 0.4;
  ($('loading-bar') as HTMLElement).style.width = `${scaled.toFixed(1)}%`;
}

// ── 화면 구성 ────────────────────────────────────────
async function mount(d: JdrDocument, src: BlobByteSource): Promise<void> {
  setControlsEnabled(false);
  showView('main');
  renderSummary($('tab-summary'), d);
  renderExports($('tab-export'), d, src, toast);

  map = new GpsMap($('map'));
  const { shown, dropped } = map.render(d.gps);
  $('map-note').textContent =
    shown === 0
      ? 'GPS 좌표가 없습니다 (위성 미수신이거나 GPS 패킷이 없는 파일).'
      : `${shown.toLocaleString('ko-KR')}개 지점 표시${dropped > 0 ? ` · 위성 미수신 ${dropped.toLocaleString('ko-KR')}건 제외` : ''}`;

  charts = new TimeCharts($('chart-speed'), $('chart-gsensor'));
  charts.render(d);

  // 코덱 자동 판별이 안 되는 JDR 변형을 위한 수동 지정 (?codec=avc1.4D401E 등)
  const codecOverride = new URLSearchParams(location.search).get('codec') ?? undefined;
  player = new JdrPlayer(
    d, src,
    [$<HTMLCanvasElement>('canvas-0'), $<HTMLCanvasElement>('canvas-1')],
    toast,
    codecOverride,
  );
  const seek = $<HTMLInputElement>('seek');
  player.onTimeUpdate = (ms) => {
    if (!seekDragging) seek.value = String(Math.round(ms));
    updateTimeLabels(ms);
  };
  player.onPlayingChange = (playing) => {
    $('btn-play').textContent = playing ? '❚❚' : '▶';
    $('btn-play').setAttribute('aria-label', playing ? '일시정지' : '재생');
  };
  seek.max = String(Math.max(1, Math.round(player.durationMs)));
  updateTimeLabels(player.position);

  const status = await player.init();
  setControlsEnabled(true);

  for (let ch = 0; ch < 2; ch++) {
    const note = $(`ch${ch}-note`);
    const st = status.channels[ch];
    note.textContent = st?.available
      ? `${st.width || '?'}×${st.height || '?'} · ${d.video[ch].fps.toFixed(1)}fps`
      : st?.reason ?? '영상 없음';
  }
  if (!status.webCodecs) {
    toast('이 브라우저는 WebCodecs 미지원 — 영상 재생만 비활성화됩니다');
  } else if (codecOverride) {
    toast(`코덱을 ${codecOverride}(으)로 강제 지정했습니다`);
  }

}

function updateTimeLabels(ms: number): void {
  if (!doc || !player) return;
  $('time-label').textContent =
    `${formatDuration(ms / 1000)} / ${formatDuration(player.durationMs / 1000)}`;
  const abs = doc.firstTimeMs + ms;
  const fix = map?.syncTo(abs) ?? null;
  charts?.syncTo(ms / 1000);
  const parts = [`기록 시각 ${formatRecordedTime(abs)}`];
  if (fix) parts.push(`${fix.speed.toFixed(1)} km/h (추정)`, `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`);
  $('recorded-time').textContent = parts.join('  ·  ');
}

// ── 재생 컨트롤 ──────────────────────────────────────
$('btn-play').addEventListener('click', () => {
  if (!player) return;
  if (player.isPlaying) player.pause();
  else void player.play();
});
$('btn-prev').addEventListener('click', () => void player?.step(-1));
$('btn-next').addEventListener('click', () => void player?.step(1));

const seekEl = $<HTMLInputElement>('seek');
seekEl.addEventListener('input', () => {
  seekDragging = true;
  updateTimeLabels(Number(seekEl.value));
});
const commitSeek = (): void => {
  if (!seekDragging) return;
  seekDragging = false;
  player?.seek(Number(seekEl.value));
  if (!player?.isPlaying) void player?.pumpOnce();
};
seekEl.addEventListener('change', commitSeek);
seekEl.addEventListener('pointerup', commitSeek);

$<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  player?.setSpeed(Number((e.target as HTMLSelectElement).value));
});

let muted = false;
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  player?.setMuted(muted);
  $('btn-mute').textContent = muted ? '🔇' : '🔊';
});

document.addEventListener('keydown', (e) => {
  if (!player || views.main.hidden) return;
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (player.isPlaying) player.pause();
    else void player.play();
  } else if (e.code === 'ArrowRight') {
    void player.step(1);
  } else if (e.code === 'ArrowLeft') {
    void player.step(-1);
  }
});

// ── 탭 ──────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    $(`tab-${tab.dataset.tab}`).classList.add('is-active');
    // 숨겨진 채로 만들어진 지도/차트는 크기가 0이라 다시 계산해야 한다
    if (tab.dataset.tab === 'map') map?.invalidate();
    if (tab.dataset.tab === 'sensor') charts?.resize();
  });
});

window.addEventListener('resize', () => {
  map?.invalidate();
  charts?.resize();
});

// ── 초기 안내 ────────────────────────────────────────
$('codec-note').textContent = hasWebCodecs()
  ? '이 브라우저는 WebCodecs를 지원합니다 — 변환 없이 바로 재생할 수 있습니다.'
  : '이 브라우저는 WebCodecs 미지원입니다 — 요약·GPS·센서·내보내기는 동작하지만 영상 재생은 되지 않습니다.';
