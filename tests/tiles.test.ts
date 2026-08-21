// tiles.ts 冒烟：未加载时全部 ready=false 且 draw 不崩（node 无 DOM/Image 路径）
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetReady, drawTile, drawTileW, TILE_MAP, TOWN_SHEET, INTERIOR_SHEET } from '../src/web/client/tiles';

function mockCtx() {
  const noop = () => {};
  return { drawImage: noop, imageSmoothingEnabled: true, save: noop, restore: noop } as unknown as CanvasRenderingContext2D;
}

test('未加载时所有 sheet ready=false，drawTile/drawTileW 不抛', () => {
  assert.equal(sheetReady('town'), false);
  assert.equal(sheetReady('forest'), false);
  assert.equal(sheetReady('interiors'), false);
  assert.equal(sheetReady('ui'), false);
  assert.equal(sheetReady('tinytown'), false);
  assert.equal(sheetReady('tiny16'), false);
  assert.equal(sheetReady('dungeon'), false);
  const ctx = mockCtx();
  drawTile(ctx, 'town', 0, 0, 0, 0, 32);
  drawTileW(ctx, 'interiors', 0, 0, 16, 32, 0, 0, 32, 64);
});

test('TILE_MAP 结构完整：全部 terrain 键存在且坐标非负整数', () => {
  for (const k of ['grass', 'dirt', 'path', 'plaza', 'flowers', 'crops', 'grassAlt', 'tree2', 'flowerBed'] as const) {
    assert.ok(Array.isArray(TILE_MAP.terrain[k]) && TILE_MAP.terrain[k].length === 2, k);
    for (const v of TILE_MAP.terrain[k]) assert.ok(Number.isInteger(v) && v >= 0, k + ' 坐标非法');
  }
  assert.ok(TILE_MAP.water.frames.length >= 2);
  assert.ok(TILE_MAP.tree.frames.length >= 1);
  for (const b of ['cafe', 'bookstore', 'post_office', 'bakery', 'clinic', 'home', 'pier', 'flower_shop', 'grocer']) {
    const s = TILE_MAP.buildings[b];
    assert.ok(s && s.wall.length === 2 && s.roof.length === 2 && s.door.length === 2 && s.window.length === 2, b);
  }
  for (const f of ['bed', 'sofa', 'table', 'counter']) {
    assert.ok(TILE_MAP.furniture[f] && TILE_MAP.furniture[f].frames.length >= 1, f);
  }
  assert.ok(TILE_MAP.interior.floor.length === 2 && TILE_MAP.interior.wallTile.length === 2);
});

test('TOWN_SHEET/INTERIOR_SHEET 常量指向已下载包（tiny16 已下载、dungeon 未下载）', () => {
  assert.equal(TOWN_SHEET, 'tiny16');
  assert.equal(INTERIOR_SHEET, 'interiors');
});
