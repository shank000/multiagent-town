import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldState, GRID_W, GRID_H } from '../src/core/world';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:cafe', name: '咖啡馆', type: 'building', parentId: 'obj:town', x: 2, y: 1, w: 2, h: 2 },
  { id: 'obj:cafe_counter', name: '吧台', type: 'room', parentId: 'obj:cafe', x: 2, y: 1, w: 1, h: 1 },
];

const world = () => new WorldState(OBJS, []);

test('centerOf 计算对象中心瓦片', () => {
  assert.deepEqual(world().centerOf(OBJS[1]), { x: 3, y: 2 });
});

test('findPath 与 walkable 经 world 暴露', () => {
  const w = world();
  assert.ok(w.findPath({ x: 0, y: 0 }, { x: 11, y: 7 }) !== null);
  assert.equal(w.walkable(0, 0), true);
});

test('objectAt 取面积最小的包含对象', () => {
  assert.equal(world().objectAt({ x: 2, y: 1 })?.id, 'obj:cafe_counter');
  assert.equal(world().objectAt({ x: 3, y: 2 })?.id, 'obj:cafe');
  assert.equal(world().objectAt({ x: 11, y: 7 })?.id, 'obj:town');
});

test('targetTile 对未知对象返回 null', () => {
  assert.equal(world().targetTile('obj:none'), null);
  assert.deepEqual(world().targetTile('obj:cafe'), { x: 3, y: 2 });
});

test('hasObject / getAgent / inBounds', () => {
  const w = world();
  assert.equal(w.hasObject('obj:cafe'), true);
  assert.equal(w.hasObject('obj:none'), false);
  assert.throws(() => w.getAgent('agent:none'), /不存在/);
  assert.equal(w.inBounds({ x: 0, y: 0 }), true);
  assert.equal(w.inBounds({ x: GRID_W, y: 0 }), false);
  assert.equal(w.inBounds({ x: 0, y: GRID_H }), false);
});
