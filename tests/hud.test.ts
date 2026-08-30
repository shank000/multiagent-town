// hud.ts 冒烟：mock ctx 下 tooltip/banner/bubbles 不抛；wrap 行为
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawTooltip, drawBanner, drawBubbles, wrap, type Bubble, type DisplayPos } from '../src/web/client/hud';

function mockCtx() {
  const noop = () => {};
  return {
    fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop, fill: noop, ellipse: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 40 }), drawImage: noop,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop, rotate: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

test('wrap：按 max 切分', () => {
  assert.deepEqual(wrap('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrap('', 3), ['']);
});

test('drawTooltip/drawBanner/drawBubbles 冒烟：mock ctx 不抛（含 dpr 访问）', () => {
  const ctx = mockCtx();
  drawTooltip(ctx, { text: '测试', x: 10, y: 10 }, 800, 600);
  drawBanner(ctx, { text: '广播', until: 1e12 }, 1000, 800);
  const bubbles = new Map<string, Bubble>([['a1', { kind: 'chat', speaker: '甲', text: '你好', until: 1e12 }]]);
  const display = new Map<string, DisplayPos>([['a1', { x: 100, y: 100 }]]);
  drawBubbles(ctx, bubbles, display, 1000);
});

test('对话气泡用整数像素尾连续指向说话者头顶', () => {
  const rects: number[][] = [];
  const ctx = mockCtx();
  ctx.fillRect = (...args: number[]) => { rects.push(args); };
  const bubbles = new Map<string, Bubble>([['a1', { kind: 'chat', speaker: '甲', text: '你好', until: 1e12 }]]);
  const display = new Map<string, DisplayPos>([['a1', { x: 100.4, y: 100.4 }]]);
  drawBubbles(ctx, bubbles, display, 1000);
  const outerTail = rects[0];
  const innerTail = rects[1];
  assert.equal(outerTail[2], 6);
  assert.equal(innerTail[2], 2);
  assert.equal(outerTail[1] + outerTail[3], Math.round(100.4 - 18));
  assert.ok(rects.every((rect) => rect.every(Number.isInteger)));
});
