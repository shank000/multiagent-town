// 全屏相机纯函数：fit 缩放 / 缩放钳制 / 光标锚定偏移
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFit, zoomScale, zoomOffsets } from '../src/web/client/camera';
import { TILE } from '../src/web/client/render';

test('computeFit：48×44 网格在 1920×1080 窗口按高度铺满并居中', () => {
  const c = computeFit(1920, 1080, 48, 44, 32);
  assert.equal(c.scale, 1080 / (44 * 32)); // min(1920/1536, 1080/1408)
  assert.equal(c.offX, (1920 - 48 * 32 * c.scale) / 2);
  assert.equal(c.offY, 0);
});

test('computeFit：窄窗口按宽度铺满', () => {
  const c = computeFit(800, 1200, 48, 44, 32);
  assert.equal(c.scale, 800 / (48 * 32));
});

test('zoomScale：钳制在 [fit, fit×4]', () => {
  assert.equal(zoomScale(1, 2, 1), 2);
  assert.equal(zoomScale(1, 0.5, 1), 1);
  assert.equal(zoomScale(3.9, 2, 1), 4);
  assert.equal(zoomScale(0.5, 0.5, 0.5), 0.5);
});

test('zoomOffsets：缩放后光标下的世界点不动', () => {
  const fit = computeFit(1920, 1080, 48, 44, 32);
  const z = zoomOffsets(400, 300, fit.scale, 2 * fit.scale, fit.offX, fit.offY, 32);
  const wBefore = (400 - fit.offX) / (fit.scale * 32);
  const wAfter = (400 - z.offX) / (2 * fit.scale * 32);
  assert.ok(Math.abs(wBefore - wAfter) < 1e-9);
});

test('dpr=2 路径：offset 存 CSS px，边界换算一致', () => {
  // 模拟 fitCamera(dpr=2)：CSS 尺度 offset，设备像素边界在 applyCamera/tileAt 乘 dpr
  const dpr = 2;
  const f = computeFit(1920 / dpr, 1080 / dpr, 48, 44, 32); // 窗口 CSS 尺寸
  const offX = f.offX; // CSS px
  // tileAt：设备像素 (px) 下的瓦片
  const px = (400 + offX) * dpr; // 设备像素 = CSS 400px 处
  const scale = f.scale;
  const tx = Math.floor((px - offX * dpr) / (TILE * scale * dpr));
  assert.equal(tx, Math.floor(400 / (TILE * scale)));
  // onWheel 锚定：CSS 单位守恒
  const next = zoomScale(scale, 1.25, scale);
  const z = zoomOffsets(400, 300, scale, next, offX, f.offY, 32);
  const wBefore = (400 - offX) / (scale * 32);
  const wAfter = (400 - z.offX) / (next * 32);
  assert.ok(Math.abs(wBefore - wAfter) < 1e-9);
});
