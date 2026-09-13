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
