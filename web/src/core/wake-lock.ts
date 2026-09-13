/**
 * 열람 중 화면 잠김 방지.
 *
 * 감사 용도로는 한 장면을 멈춰 놓고 들여다보는 일이 잦다. 그 사이에 화면이
 * 꺼지면 다시 켜고 잠금을 풀고 위치를 찾아야 한다. 그래서 **재생 화면이
 * 열려 있는 동안은** 화면을 깨워 둔다.
 *
 * 막아 주는 것은 **화면 자동 꺼짐**뿐이다. 전원 버튼으로 직접 잠그는 것,
 * 다른 앱으로 넘어가는 것은 막지 못한다 (막아서도 안 된다).
 *
 * 두 가지를 꼭 지켜야 한다.
 *  - 문서가 비활성이 되면 **잠금이 자동으로 풀린다.** 다시 보일 때 다시 잡지
 *    않으면 "처음엔 되는데 다른 앱 갔다 오면 안 되는" 증상이 된다
 *  - 화면이 켜져 있는 것 자체가 폰에서 가장 큰 전력 소모다.
 *    쓰지 않는 화면(캘린더 등)에서는 반드시 놓아준다
 */

export type WakeState =
  /** 꺼짐 */
  | 'off'
  /** 표준 Wake Lock으로 걸림 */
  | 'on'
  /** 표준이 막혀 숨은 영상으로 대신 걸림 */
  | 'fallback'
  /** 이 환경에서는 막을 수 없음 */
  | 'unsupported';

/** navigator.wakeLock이 주는 것과 같은 모양 (테스트에서 갈아끼우기 위해) */
export interface WakeLockLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

export interface WakeDeps {
  /** 표준 API. 이 환경에 없으면 undefined */
  requestLock?: () => Promise<WakeLockLike>;
  /** 표준이 실패했을 때 쓰는 우회법 */
  fallback?: { start(): boolean; stop(): void };
  isVisible?: () => boolean;
}

export class ScreenWake {
  private lock: WakeLockLike | null = null;
  private fallbackOn = false;
  /** 사용자가/앱이 원하는 상태. 자동 해제와 구분하기 위해 따로 둔다. */
  private want = false;
  private stateValue: WakeState = 'off';

  onChange: ((state: WakeState) => void) | null = null;

  constructor(private readonly deps: WakeDeps = {}) {}

  get state(): WakeState {
    return this.stateValue;
  }

  /** 사용자가 원하는 상태 (자동 해제 중이어도 true일 수 있다) */
  get wanted(): boolean {
    return this.want;
  }

  private set(next: WakeState): void {
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.onChange?.(next);
  }

  async enable(): Promise<void> {
    this.want = true;
    await this.acquire();
  }

  async disable(): Promise<void> {
    this.want = false;
    await this.release();
    this.set('off');
  }

  async toggle(): Promise<void> {
    if (this.want) await this.disable();
    else await this.enable();
  }

  /**
   * 화면이 다시 보일 때 부른다.
   * 이미 풀려 있으면 다시 잡는다 — 이게 없으면 앱 전환 뒤에 동작하지 않는다.
   */
  async refresh(): Promise<void> {
    if (!this.want) return;
    if (this.deps.isVisible && !this.deps.isVisible()) return;
    if (this.lock && !this.lock.released) return;
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (this.deps.isVisible && !this.deps.isVisible()) return;

    if (this.deps.requestLock) {
      try {
        const lock = await this.deps.requestLock();
        // 기다리는 사이에 사용자가 껐을 수 있다
        if (!this.want) { await lock.release().catch(() => {}); return; }
        this.lock = lock;
        lock.addEventListener('release', () => {
          // 자동 해제. 원하는 상태는 그대로 두고 표시만 내린다.
          if (this.lock === lock) this.lock = null;
          if (this.want && this.stateValue === 'on') this.set('off');
        });
        this.stopFallback();
        this.set('on');
        return;
      } catch {
        // 보안 컨텍스트가 아니거나 정책으로 막힌 경우 — 우회법으로 넘어간다
      }
    }

    if (this.deps.fallback && this.deps.fallback.start()) {
      this.fallbackOn = true;
      this.set('fallback');
      return;
    }
    this.set('unsupported');
  }

  private async release(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock && !lock.released) await lock.release().catch(() => {});
    this.stopFallback();
  }

  private stopFallback(): void {
    if (!this.fallbackOn) return;
    this.fallbackOn = false;
    this.deps.fallback?.stop();
  }
}

/**
 * 브라우저용 조립.
 *
 * 우회법은 보이지 않는 1px 영상을 무음으로 되감는 것이다. 잠금 API가 없던
 * 시절의 표준 우회법(NoSleep.js)인데, 여기서는 파일을 끼워 넣는 대신
 * **캔버스 스트림**을 쓴다 — 단일 HTML 파일에 영상을 base64로 박지 않아도 된다.
 *
 * 소리 트랙이 없고 muted라 우리 Web Audio 재생과 오디오 초점을 다투지 않는다.
 * `display:none`이면 재생으로 치지 않으므로 투명하게만 둔다.
 */
export function createScreenWake(): ScreenWake {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> };
  };

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  return new ScreenWake({
    requestLock: nav.wakeLock ? () => nav.wakeLock!.request('screen') : undefined,
    isVisible: () => document.visibilityState === 'visible',
    fallback: {
      start(): boolean {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 2;
          canvas.height = 2;
          const ctx = canvas.getContext('2d');
          if (!ctx) return false;
          ctx.fillRect(0, 0, 2, 2);
          stream = canvas.captureStream(1);

          video = document.createElement('video');
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.setAttribute('aria-hidden', 'true');
          video.style.cssText =
            'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
          video.srcObject = stream;
          document.body.appendChild(video);
          void video.play().catch(() => {});
          return true;
        } catch {
          return false;
        }
      },
      stop(): void {
        video?.pause();
        video?.remove();
        video = null;
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
      },
    },
  });
}
