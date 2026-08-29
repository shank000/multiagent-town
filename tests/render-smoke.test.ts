// 渲染冒烟：昼夜纯函数数值合法 + 各绘制函数在 mock ctx 下不抛异常
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayNightState, applyDayNight, drawRiver, drawTree, drawLampGlow, drawObjectDetail, drawFurniture, drawTerrain, fitPixelSprite, TILE } from '../src/web/client/render';
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

test('dayNightState：无跳变连续过渡', () => {
  assert.equal(dayNightState(600).alpha, 0);
  assert.equal(dayNightState(300).alpha, 0.32);       // 黎明起点=夜值
  assert.equal(dayNightState(480).alpha, 0);           // 黎明终点=昼值
  assert.equal(dayNightState(1020).alpha, 0);          // 黄昏起点=昼值
  assert.ok(Math.abs(dayNightState(1200).alpha - 0.32) < 1e-9); // 黄昏终点=夜值
  assert.equal(dayNightState(1350).alpha, 0.32);
  for (const m of [0, 100, 300, 390, 480, 600, 1020, 1100, 1199, 1200, 1300, 1400]) {
    const s = dayNightState(m);
    assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha 越界 at ${m}`);
  }
});

test('整房精灵保持整数倍等比缩放并底部居中', () => {
  assert.deepEqual(fitPixelSprite(64, 48, 0, 0, 128, 128), { dx: 0, dy: 32, dw: 128, dh: 96 });
  assert.deepEqual(fitPixelSprite(64, 48, 10, 20, 96, 96), { dx: 26, dy: 68, dw: 64, dh: 48 });
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
  // 终审修复波新增分支：zone(码头/花坛/栅栏)、furniture(小船)、building(花店，node 下 sheet 未就绪→程序化回退)
  const pier: ObjectView = { id: 'obj:pier', name: '湖边码头', type: 'zone', x: 16, y: 26, w: 4, h: 2 };
  drawObjectDetail(ctx, pier, 1000, 1350);
  const boat: ObjectView = { id: 'obj:boat', name: '小船', type: 'furniture', x: 17, y: 27, w: 2, h: 1 };
  drawObjectDetail(ctx, boat, 1000, 1350);
  const flowerbed: ObjectView = { id: 'obj:flowerbed', name: '广场花坛', type: 'zone', x: 20, y: 20, w: 2, h: 2 };
  drawObjectDetail(ctx, flowerbed, 1000, 1350);
  const flowerShop: ObjectView = { id: 'obj:flower_shop', name: '白露花店', type: 'building', x: 12, y: 18, w: 4, h: 4 };
  drawObjectDetail(ctx, flowerShop, 1000, 1350);
  const fence: ObjectView = { id: 'obj:fence_lake', name: '湖边栅栏', type: 'zone', x: 14, y: 26, w: 2, h: 1 };
  drawObjectDetail(ctx, fence, 1000, 1350);
});
