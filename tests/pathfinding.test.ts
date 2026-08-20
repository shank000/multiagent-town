import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldState } from '../src/core/world';
import type { WorldObject } from '../src/core/types';

// 咖啡馆 (2,1,2,2)：边界 x∈{2,3},y∈{1,2} 除门 (3,2)；室内 (2,1) 可通行
const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:cafe', name: '咖啡馆', type: 'building', parentId: 'obj:town', x: 2, y: 1, w: 2, h: 2 },
  { id: 'obj:cafe_counter', name: '吧台', type: 'room', parentId: 'obj:cafe', x: 2, y: 1, w: 1, h: 1 },
];

const world = () => new WorldState(OBJS, []);

test('walkable：房间开口可通行、门开口、其余边界被挡', () => {
  const w = world();
  assert.equal(w.walkable(2, 1), true);  // 吧台（房间瓦片开口）
  assert.equal(w.walkable(3, 2), true);  // 门（底边中点）
  assert.equal(w.walkable(3, 1), false); // 顶边（非门非房间）
  assert.equal(w.walkable(2, 2), false); // 底边（非门）
  assert.equal(w.walkable(2, 0), true);  // 咖啡馆外草地
  assert.equal(w.walkable(-1, 0), false); // 越界
});

test('findPath 从馆外进吧台：路径全可通行、逐格相邻', () => {
  const w = world();
  const path = w.findPath({ x: 4, y: 4 }, { x: 2, y: 1 })!;
  assert.ok(path, '应有路径');
  assert.deepEqual(path[0], { x: 4, y: 4 });
  assert.deepEqual(path[path.length - 1], { x: 2, y: 1 });
  // 全程无墙
  for (const t of path) assert.equal(w.walkable(t.x, t.y), true, `路径含墙 (${t.x},${t.y})`);
  // 相邻步差 1（无穿墙）
  for (let i = 1; i < path.length; i++) {
    const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    assert.equal(d, 1, '路径必须逐格相邻');
  }
});

test('findPath 目标为墙 → null；邻居四方向', () => {
  const w = world();
  assert.equal(w.findPath({ x: 4, y: 4 }, { x: 2, y: 2 }), null); // (2,2) 是墙
  assert.deepEqual(w.neighbors({ x: 0, y: 0 }), [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]);
});

test('地图边角建筑也有出口（防死角）', () => {
  const OBJS2: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
    { id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 10, y: 6, w: 2, h: 2 },
  ];
  const w = new WorldState(OBJS2, []);
  assert.ok(w.findPath({ x: 11, y: 7 }, { x: 11, y: 5 }), '边角建筑必须能出门');
});
