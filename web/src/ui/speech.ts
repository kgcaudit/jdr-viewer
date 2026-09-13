/**
 * "대화" 탭 — 말한 구간 목록.
 *
 * 3시간 운행에서 사람이 말한 건 몇 분뿐일 수 있다. 그걸 찾아 준다.
 *
 * 여기서 파는 건 **전사가 아니라 색인**이다. 무슨 말인지는 사람이 듣고
 * 판단하고, 앱은 "어디를 들어야 하는지"만 좁혀 준다. 8kHz 모노 차내
 * 음성에서 기계 전사는 못 믿지만, 말이 있었는지 없었는지는 가를 수 있다.
 */
import type { SpeechResult } from '../core/speech';
import { speechTotalMs } from '../core/vad';
import { formatDuration, formatDurationKo, formatRecordedTime } from '../core/time';
import { escapeHtml, num } from './format';

export interface SpeechPanelHandlers {
  onAnalyze(): void;
  onGoto(relMs: number): void;
  onSaveWav(): void;
  onSaveCsv(): void;
}

export interface SpeechPanelState {
  /** 지금 분석 중인가 */
  busy: boolean;
  /** 0~100 */
  progress: number;
  result: SpeechResult | null;
  /** 분석할 대상 이름 (아직 안 돌렸을 때 보여 준다) */
  targetName: string;
  /** 음성 자체가 없는 파일 */
  noAudio: boolean;
}

const NOTE = `<p class="muted small sp-note">
  이건 <strong>증거가 아니라 색인</strong>입니다. 소리가 났는지를 신호로 가릴 뿐,
  무슨 말인지는 판단하지 않습니다. 반드시 해당 지점을 직접 들어 확인하세요.
</p>`;

function spanRow(r: SpeechResult, index: number, startMs: number, endMs: number, score: number): string {
  const at = formatRecordedTime(r.baseMs + startMs, false).slice(11, 19);
  const dur = (endMs - startMs) / 1000;
  // 신뢰도는 막대로만 보여 준다 — 숫자로 적으면 정확도처럼 오해된다
  const bar = Math.round(score * 100);
  return `<button class="sp-row" type="button" data-at="${Math.round(startMs)}">
    <span class="sp-no">${index + 1}</span>
    <span class="sp-main">
      <span class="sp-time">${escapeHtml(at)}</span>
      <span class="sp-meta">${dur.toFixed(1)}초 · 파일 내 ${formatDuration(startMs / 1000)}</span>
    </span>
    <span class="sp-score" aria-hidden="true"><span style="width:${bar}%"></span></span>
  </button>`;
}

export function renderSpeechPanel(
  el: HTMLElement,
  state: SpeechPanelState,
  h: SpeechPanelHandlers,
): void {
  if (state.noAudio) {
    el.innerHTML = `<p class="section-title">대화</p>
      <p class="muted">이 파일에는 음성 패킷이 없습니다 (마이크가 꺼져 있었거나 지원하지 않는 기종).</p>`;
    return;
  }

  if (state.busy) {
    el.innerHTML = `<p class="section-title">대화</p>
      <p class="muted small">${escapeHtml(state.targetName)} 음성을 훑는 중…</p>
      <div class="progress"><div class="progress-bar" style="width:${state.progress}%"></div></div>
      <p class="muted small" style="margin-top:8px">음성은 파일 곳곳에 흩어져 있어 파일 전체를 읽어야 합니다.</p>`;
    return;
  }

  const r = state.result;
  if (!r) {
    el.innerHTML = `<p class="section-title">대화</p>
      <p class="muted small">지금 보고 있는 구간에서 <strong>사람 말소리가 있는 곳</strong>을 찾아 줍니다.</p>
      <button class="btn btn-primary" type="button" id="sp-run">${escapeHtml(state.targetName)} 훑어보기</button>
      ${NOTE}`;
    el.querySelector('#sp-run')?.addEventListener('click', () => h.onAnalyze());
    return;
  }

  const talkMs = speechTotalMs(r.spans);
  const ratio = r.audioMs > 0 ? (talkMs / r.audioMs) * 100 : 0;

  const body = r.spans.length === 0
    ? `<p class="muted">말소리를 찾지 못했습니다. 주행 잡음만 있는 구간으로 보입니다.</p>`
    : `<div class="sp-list">${r.spans
        .map((s, i) => spanRow(r, i, s.startMs, s.endMs, s.score))
        .join('')}</div>`;

  el.innerHTML = `
    <p class="section-title">대화 — ${escapeHtml(r.name)}</p>
    <p class="muted small">${num(r.spans.length)}곳 · 합계 ${formatDurationKo(talkMs / 1000)}
      / 음성 ${formatDurationKo(r.audioMs / 1000)} (${ratio.toFixed(1)}%)</p>
    ${body}
    <div class="sp-foot">
      <button class="btn" type="button" id="sp-again">다시 훑기</button>
      <button class="btn" type="button" id="sp-wav"${r.spans.length ? '' : ' disabled'}>말한 구간만 WAV</button>
      <button class="btn" type="button" id="sp-csv"${r.spans.length ? '' : ' disabled'}>대조표 CSV</button>
    </div>
    <p class="muted small" style="margin:8px 0 0">WAV와 CSV는 짝입니다 — CSV가 잘라낸 위치를
      원본 파일·시각으로 되짚어 줍니다. 전사 도구에 넘길 때 함께 쓰세요.</p>
    ${NOTE}`;

  el.querySelectorAll<HTMLButtonElement>('[data-at]').forEach((b) => {
    b.addEventListener('click', () => h.onGoto(Number(b.dataset.at)));
  });
  el.querySelector('#sp-again')?.addEventListener('click', () => h.onAnalyze());
  el.querySelector('#sp-wav')?.addEventListener('click', () => h.onSaveWav());
  el.querySelector('#sp-csv')?.addEventListener('click', () => h.onSaveCsv());
}
