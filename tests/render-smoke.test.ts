// 渲染冒烟：昼夜纯函数数值合法 + 各绘制函数在 mock ctx 下不抛异常
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayNightState, applyDayNight, drawRiver, drawTree, drawLampGlow, drawObjectDetail, drawFurniture, drawTerrain, TILE } from '../src/web/client/render';
import type { ObjectView } from '../src/web/client/types';

function mockCtx() {
  const noop = () => {};
  return {
    fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop, fill: noop, ellipse: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }), drawImage: noop,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop, rotate: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

test('dayNightState：白天无着色，夜间蓝色覆盖，黄昏渐入', () => {
  assert.equal(dayNightState(600).alpha, 0);
  assert.equal(dayNightState(300).alpha, 0);
  assert.ok(dayNightState(1350).alpha > 0.25);
  assert.ok(dayNightState(100).alpha > 0.25);
  const dusk = dayNightState(1100);
  assert.ok(dusk.alpha > 0 && dusk.alpha < 0.2);
  for (const m of [0, 100, 300, 480, 600, 1020, 1100, 1200, 1300, 1400]) {
    const s = dayNightState(m);
    assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha 越界 at ${m}`);
  }
});

test('绘制函数冒烟：mock ctx 不抛异常', () => {
  const ctx = mockCtx();
  drawTerrain(ctx, 48 * TILE, 44 * TILE);
  drawRiver(ctx, 8 * TILE, 40 * TILE, 40 * TILE, 4 * TILE, 1000);
  drawTree(ctx, 41 * TILE, 3 * TILE, 1000, 2);
  drawLampGlow(ctx, 17 * TILE, 18 * TILE, 1000, true);
  const water: ObjectView = { id: 'obj:river', name: '小镇河', type: 'water', x: 8, y: 40, w: 40, h: 4 };
  drawObjectDetail(ctx, water, 1000, 1350);
  const lamp: ObjectView = { id: 'obj:lamp_plaza', name: '广场路灯', type: 'zone', x: 17, y: 18, w: 1, h: 1 };
  drawObjectDetail(ctx, lamp, 1000, 1350);
  const bed: ObjectView = { id: 'obj:bed_lin', name: '床', type: 'furniture', x: 3, y: 2, w: 1, h: 2 };
  drawFurniture(ctx, bed);
  applyDayNight(ctx, 100, 100, 1350);
});
