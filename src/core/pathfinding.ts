// A* 寻路：4 方向网格、曼哈顿启发（spec §9 寻路；墙 = 建筑边界除门，由 WorldState 提供 walkable）

import type { Tile } from './types';
import type { WorldState } from './world';

const key = (t: Tile) => `${t.x},${t.y}`;
const unkey = (k: string): Tile => {
  const [x, y] = k.split(',').map(Number);
  return { x, y };
};
const h = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** 返回含起点终点的路径；起点或终点不可通行 → null */
export function findPath(world: WorldState, from: Tile, to: Tile): Tile[] | null {
  if (!world.inBounds(from) || !world.inBounds(to)) return null;
  if (!world.walkable(from.x, from.y) || !world.walkable(to.x, to.y)) return null;
  const startKey = key(from);
  const goalKey = key(to);
  if (startKey === goalKey) return [from];
  const open = new Map<string, { tile: Tile; g: number; f: number }>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  gScore.set(startKey, 0);
  open.set(startKey, { tile: from, g: 0, f: h(from, to) });
  while (open.size) {
    let curKey = '';
    let cur: { tile: Tile; g: number; f: number } | undefined;
    for (const [k, v] of open) {
      if (!cur || v.f < cur.f || (v.f === cur.f && k < curKey)) {
        curKey = k;
        cur = v;
      }
    }
    cur = cur!;
    if (curKey === goalKey) {
      const path: Tile[] = [to];
      let k = goalKey;
      while (k !== startKey) {
        k = cameFrom.get(k)!;
        path.unshift(unkey(k));
      }
      return path;
    }
    open.delete(curKey);
    for (const nb of world.neighbors(cur.tile)) {
      if (!world.walkable(nb.x, nb.y)) continue;
      const nk = key(nb);
      const tentative = cur.g + 1;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, curKey);
        gScore.set(nk, tentative);
        open.set(nk, { tile: nb, g: tentative, f: tentative + h(nb, to) });
      }
    }
  }
  return null;
}
