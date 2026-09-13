/**
 * 타임라인 스트립 끌어 옮기기.
 *
 * 한 운행에 파일 60개면 폰(390px)에서 구간 하나가 6px 남짓이다.
 * "정확히 누르기"로는 못 맞춘다. 그래서 **끌면서 보고 맞추는** 방식으로 바꾼다.
 *
 *  - 누르는 즉시 커서가 따라온다 (이동은 아직 안 한다 → 파싱이 끼어들지 않는다)
 *  - 손가락 위에 말풍선이 떠서 시각·파일명·구간 번호를 보여준다
 *  - 떼는 순간 그 지점으로 이동하고, 되면 짧게 진동한다
 *
 * pointer 이벤트 하나로 마우스·터치·펜을 같이 받는다.
 * 트랙에 `touch-action: none`이 걸려 있어야 끄는 동안 화면이 스크롤되지 않는다.
 */
import type { StripLayout } from '../core/strip-layout';

/** 이동이 확정됐을 때의 진동 길이(ms). 안드로이드 크롬에서만 동작한다. */
const COMMIT_VIBRATE_MS = 10;

export interface StripScrubHandlers {
  /** 지금 그려져 있는 축. 세션이 바뀌면 달라지므로 그때그때 물어본다. */
  layout(): StripLayout | null;
  /** 말풍선에 쓸 글. 줄바꿈(\n)을 넣으면 두 줄로 나온다. */
  label(absMs: number, segIndex: number): string;
  /** 끄는 동안 — 커서만 옮긴다 */
  onPreview(absMs: number): void;
  /** 떼었을 때 — 실제로 이동한다 */
  onCommit(absMs: number): void;
}

function ratioOf(track: HTMLElement, clientX: number): number {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

export function attachStripScrub(
  track: HTMLElement,
  bubble: HTMLElement,
  h: StripScrubHandlers,
): void {
  let dragging = false;
  let lastMs = 0;

  const show = (clientX: number): void => {
    const layout = h.layout();
    if (!layout) return;
    const ratio = ratioOf(track, clientX);
    // 빈 구간에 걸리면 가까운 구간으로 붙인다 — 녹화가 없는 시각으로 갈 수는 없다
    const absMs = layout.snapTime(ratio);
    lastMs = absMs;

    const text = h.label(absMs, layout.segmentAt(ratio));
    bubble.innerHTML = '';
    for (const line of text.split('\n')) {
      const span = document.createElement('span');
      span.textContent = line;
      bubble.appendChild(span);
    }
    bubble.hidden = false;

    // 말풍선이 트랙 밖으로 삐져나가지 않게 붙잡는다
    const rect = track.getBoundingClientRect();
    const half = bubble.offsetWidth / 2;
    const x = Math.max(half, Math.min(clientX - rect.left, rect.width - half));
    bubble.style.left = `${x}px`;

    h.onPreview(absMs);
  };

  const end = (commit: boolean): void => {
    if (!dragging) return;
    dragging = false;
    bubble.hidden = true;
    track.classList.remove('is-scrubbing');
    if (!commit) return;
    h.onCommit(lastMs);
    // 손가락이 스트립을 가려도 "걸렸다"를 알 수 있게 한다
    try { navigator.vibrate?.(COMMIT_VIBRATE_MS); } catch { /* 지원 안 하면 그만 */ }
  };

  track.addEventListener('pointerdown', (e) => {
    if (!h.layout()) return;
    dragging = true;
    track.classList.add('is-scrubbing');
    // 손가락이 트랙 밖으로 나가도 이벤트를 계속 받는다
    try { track.setPointerCapture(e.pointerId); } catch { /* 캡처 못 해도 동작은 한다 */ }
    show(e.clientX);
    e.preventDefault();
  });

  track.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    show(e.clientX);
    e.preventDefault();
  });

  track.addEventListener('pointerup', (e) => {
    end(true);
    e.preventDefault();
  });

  // 시스템이 제스처를 가로챈 경우(전화가 오는 등) — 이동시키지 않는다
  track.addEventListener('pointercancel', () => end(false));
}
