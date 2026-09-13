/**
 * 화면 잠김 방지.
 *
 * 가장 흔한 실수는 **다시 잡지 않는 것**이다. 문서가 비활성이 되면 잠금이
 * 자동으로 풀리므로, 화면이 다시 보일 때 요청하지 않으면 "처음엔 되는데
 * 다른 앱 갔다 오면 안 되는" 증상이 된다. 그걸 집중적으로 본다.
 */
import { describe, expect, it, vi } from 'vitest';
import { ScreenWake, type WakeLockLike } from '../src/core/wake-lock';

/** navigator.wakeLock 흉내 */
function fakeLock() {
  const listeners: (() => void)[] = [];
  const lock: WakeLockLike & { fireRelease(): void } = {
    released: false,
    async release() { lock.released = true; },
    addEventListener(_t, cb) { listeners.push(cb); },
    /** 브라우저가 자동으로 푸는 상황 */
    fireRelease() { lock.released = true; for (const cb of listeners) cb(); },
  };
  return lock;
}

function setup(opts: { fail?: boolean; noApi?: boolean; fallbackOk?: boolean } = {}) {
  const locks: ReturnType<typeof fakeLock>[] = [];
  const fallback = { started: 0, stopped: 0 };
  const wake = new ScreenWake({
    requestLock: opts.noApi ? undefined : async () => {
      if (opts.fail) throw new DOMException('not allowed', 'NotAllowedError');
      const l = fakeLock();
      locks.push(l);
      return l;
    },
    fallback: {
      start() { fallback.started++; return opts.fallbackOk !== false; },
      stop() { fallback.stopped++; },
    },
    isVisible: () => true,
  });
  return { wake, locks, fallback };
}

describe('화면 잠김 방지', () => {
  it('켜면 잠금을 잡는다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    expect(wake.state).toBe('on');
    expect(locks).toHaveLength(1);
  });

  it('끄면 놓아준다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    await wake.disable();
    expect(wake.state).toBe('off');
    expect(locks[0].released).toBe(true);
  });

  it('브라우저가 자동으로 풀면 표시가 내려간다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    locks[0].fireRelease();
    expect(wake.state).toBe('off');
    // 사용자가 끈 게 아니므로 "원하는 상태"는 그대로다
    expect(wake.wanted).toBe(true);
  });

  it('화면이 다시 보이면 다시 잡는다 — 이게 없으면 앱 전환 뒤 안 걸린다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    locks[0].fireRelease();
    await wake.refresh();
    expect(wake.state).toBe('on');
    expect(locks).toHaveLength(2);
  });

  it('아직 걸려 있으면 중복으로 잡지 않는다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    await wake.refresh();
    await wake.refresh();
    expect(locks).toHaveLength(1);
  });

  it('사용자가 껐으면 화면이 다시 보여도 켜지 않는다', async () => {
    const { wake, locks } = setup();
    await wake.enable();
    await wake.disable();
    await wake.refresh();
    expect(wake.state).toBe('off');
    expect(locks).toHaveLength(1);
  });

  it('화면이 안 보이는 동안에는 요청하지 않는다', async () => {
    let visible = false;
    const locks: ReturnType<typeof fakeLock>[] = [];
    const wake = new ScreenWake({
      requestLock: async () => { const l = fakeLock(); locks.push(l); return l; },
      isVisible: () => visible,
    });
    await wake.enable();
    expect(locks).toHaveLength(0);
    visible = true;
    await wake.refresh();
    expect(locks).toHaveLength(1);
  });

  it('토글이 오간다', async () => {
    const { wake } = setup();
    await wake.toggle();
    expect(wake.state).toBe('on');
    await wake.toggle();
    expect(wake.state).toBe('off');
  });
});

describe('표준이 막혔을 때', () => {
  it('요청이 거부되면 우회법으로 넘어간다', async () => {
    const { wake, fallback } = setup({ fail: true });
    await wake.enable();
    expect(wake.state).toBe('fallback');
    expect(fallback.started).toBe(1);
  });

  it('API 자체가 없어도 우회법을 쓴다', async () => {
    const { wake, fallback } = setup({ noApi: true });
    await wake.enable();
    expect(wake.state).toBe('fallback');
    expect(fallback.started).toBe(1);
  });

  it('우회법도 안 되면 못 막는다고 알린다', async () => {
    const { wake } = setup({ noApi: true, fallbackOk: false });
    await wake.enable();
    expect(wake.state).toBe('unsupported');
  });

  it('우회법을 쓰다 꺼지면 영상도 멈춘다', async () => {
    const { wake, fallback } = setup({ fail: true });
    await wake.enable();
    await wake.disable();
    expect(fallback.stopped).toBe(1);
  });

  it('표준이 되면 우회법은 쓰지 않는다 — 배터리와 오디오 초점 때문', async () => {
    const { wake, fallback } = setup();
    await wake.enable();
    expect(fallback.started).toBe(0);
  });
});

describe('상태 변화 알림', () => {
  it('바뀔 때만 부른다', async () => {
    const { wake } = setup();
    const onChange = vi.fn();
    wake.onChange = onChange;
    await wake.enable();
    await wake.refresh();      // 이미 걸려 있음 — 알림 없음
    await wake.disable();
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['on', 'off']);
  });
});
