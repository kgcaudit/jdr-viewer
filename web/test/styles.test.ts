/**
 * 터치 화면의 hover 고착 방지.
 *
 * 안드로이드 크롬은 한 번 누른 요소를 다른 곳을 누를 때까지 계속 hover로
 * 취급한다. :hover에 배경색을 주면 손을 뗀 뒤에도 버튼이 회색으로 굳는다.
 * 그래서 hover 규칙은 마우스가 있는 기기에서만 켜져야 한다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf-8');
/** 주석 안의 설명 문구가 규칙으로 잡히지 않도록 지운다 */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** @media (hover: hover) 블록 바깥에 남은 :hover 규칙을 찾는다 */
function ungatedHoverRules(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let gateDepth = -1;
  let line = '';
  for (const raw of source.split('\n')) {
    line = raw.trim();
    const isGate = /@media[^{]*hover:\s*hover/.test(line);
    if (line.includes(':hover') && !isGate && gateDepth < 0) out.push(line);
    for (const ch of raw) {
      if (ch === '{') {
        depth++;
        if (isGate && gateDepth < 0) gateDepth = depth;
      } else if (ch === '}') {
        if (gateDepth === depth) gateDepth = -1;
        depth--;
      }
    }
  }
  return out;
}

describe('스타일시트', () => {
  it('hover 규칙은 모두 마우스 기기 전용 블록 안에 있다', () => {
    expect(ungatedHoverRules(rules)).toEqual([]);
  });

  it('누름 표시는 :active로 준다 — 손을 떼면 사라진다', () => {
    expect(css).toMatch(/\.btn:not\(:disabled\):active/);
    expect(css).toMatch(/\.chip-btn:active/);
  });

  it('안드로이드 탭 하이라이트 사각형을 끈다', () => {
    expect(css).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });
});

/**
 * 쓰는 토큰은 반드시 정의돼 있어야 한다.
 *
 * `var(--없는이름)`은 조용히 실패한다. 오류도 경고도 없이 **그 선언 하나가
 * 통째로 무효**가 되어 값이 상속되어 버린다. 실제로 `--text-2`라는 오타가
 * 네 곳에 있었고, 회색이어야 할 라벨이 본문색으로 나오고 있었다.
 * 토큰을 쓰기로 한 이상 이건 기계가 잡아야 한다.
 */
/** @media (hover: hover) and (pointer: fine) 블록을 통째로 들어낸다 */
function stripMouseOnly(source: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = source.indexOf('@media (hover: hover)', i);
    if (at < 0) { out += source.slice(i); break; }
    out += source.slice(i, at);
    let depth = 0;
    let k = source.indexOf('{', at);
    if (k < 0) break;
    for (; k < source.length; k++) {
      if (source[k] === '{') depth++;
      else if (source[k] === '}' && --depth === 0) { k++; break; }
    }
    i = k;
  }
  return out;
}

describe('디자인 토큰', () => {
  /** :root 와 @media 안의 :root 에서 정의된 이름 */
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
  /** fallback이 있는 var(--x, ...)은 없어도 동작하므로 뺀다 */
  const used = [...rules.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]);

  it('var()로 참조하는 이름이 모두 정의돼 있다', () => {
    const missing = [...new Set(used.filter((n) => !defined.has(n)))];
    expect(missing, `정의되지 않은 토큰: ${missing.join(', ')}`).toEqual([]);
  });

  it('간격·글자·터치 토큰이 실제로 쓰이고 있다', () => {
    for (const name of ['--s-2', '--s-4', '--t-body', '--t-label', '--tap']) {
      expect(used, `${name} 이 쓰이지 않는다`).toContain(name);
    }
  });

  it('손가락 규격은 44px 아래로 내려가지 않는다', () => {
    expect(/--tap:\s*44px/.test(css)).toBe(true);
    // 버튼·탭·입력의 min-height/min-width에 40px 같은 값이 다시 새어 들어오면 잡는다.
    // 마우스 전용 블록은 뺀다 — 손가락 규격은 손가락한테만 필요하다.
    const small = [...stripMouseOnly(rules).matchAll(/min-(?:height|width):\s*(3\d|4[0-3])px/g)]
      .map((m) => m[0]);
    expect(small, `44px 미만 터치 규격: ${small.join(', ')}`).toEqual([]);
  });
});
