// 世界状态：agent 集合 + 对象树 + 48×44 网格

import type { Agent, Tile, WorldObject } from './types';
import { findPath } from './pathfinding';

export const GRID_W = 48;
export const GRID_H = 44;

export class WorldState {
  private agents = new Map<string, Agent>();
  private objects = new Map<string, WorldObject>();
  private blocked = new Set<string>();

  constructor(objects: WorldObject[], agents: Agent[]) {
    for (const o of objects) this.objects.set(o.id, o);
    for (const a of agents) this.agents.set(a.id, a);
    this.computeWalkable();
  }

  /** 建筑边界为墙；房间/家具瓦片永远开口；每建筑至少保证一个开口瓦片有出口（防死角） */
  private computeWalkable(): void {
    const key = (t: Tile) => `${t.x},${t.y}`;
    const buildings = [...this.objects.values()].filter((o) => o.type === 'building');
    // 1) 全部边界标记为墙
    for (const o of buildings) {
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) {
          const border = x === o.x || x === o.x + o.w - 1 || y === o.y || y === o.y + o.h - 1;
          if (border) this.blocked.add(key({ x, y }));
        }
      }
    }
    // 1.5) 水域瓦片全部阻挡（河流不可走，无 routine 端点依赖）
    for (const o of this.objects.values()) {
      if (o.type !== 'water') continue;
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) this.blocked.add(key({ x, y }));
      }
    }
    // 2) 房间/家具瓦片开口（活动目标点必须可达）
    for (const r of this.objects.values()) {
      if (r.type !== 'room' && r.type !== 'furniture') continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        for (let y = r.y; y < r.y + r.h; y++) this.blocked.delete(key({ x, y }));
      }
    }
    // 3) 门：底边中点优先；开口后若门无法通到建筑外，依次开放其余边界瓦片直至可达（防死角）
    const inside = (o: WorldObject, t: Tile) => t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h;
    const reachesOutside = (o: WorldObject, start: Tile): boolean => {
      const seen = new Set<string>([key(start)]);
      const queue: Tile[] = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nb of this.neighbors(cur)) {
          if (!this.inBounds(nb) || this.blocked.has(key(nb))) continue;
          if (!inside(o, nb)) return true;
          const nk = key(nb);
          if (!seen.has(nk)) { seen.add(nk); queue.push(nb); }
        }
      }
      return false;
    };
    for (const o of buildings) {
      const door: Tile = { x: o.x + Math.floor(o.w / 2), y: o.y + o.h - 1 };
      const borders: Tile[] = [];
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) {
          const border = x === o.x || x === o.x + o.w - 1 || y === o.y || y === o.y + o.h - 1;
          if (border) borders.push({ x, y });
        }
      }
      const ordered = [door, ...borders.filter((t) => !(t.x === door.x && t.y === door.y))];
      for (const t of ordered) {
        this.blocked.delete(key(t));
        if (reachesOutside(o, door)) break;
      }
    }
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds({ x, y }) && !this.blocked.has(`${x},${y}`);
  }

  neighbors(t: Tile): Tile[] {
    return [
      { x: t.x, y: t.y - 1 },
      { x: t.x, y: t.y + 1 },
      { x: t.x - 1, y: t.y },
      { x: t.x + 1, y: t.y },
    ];
  }

  findPath(from: Tile, to: Tile): Tile[] | null {
    return findPath(this, from, to);
  }

  getObject(id: string | null): WorldObject | null {
    if (!id) return null;
    return this.objects.get(id) ?? null;
  }

  allObjects(): WorldObject[] { return [...this.objects.values()]; }
  allAgents(): Agent[] { return [...this.agents.values()]; }

  hasAgent(id: string): boolean { return this.agents.has(id); }

  addAgent(a: Agent): void { this.agents.set(a.id, a); }

  getAgent(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`agent 不存在: ${id}`);
    return a;
  }

  hasObject(id: string): boolean { return this.objects.has(id); }

  /** 对象中心瓦片 */
  centerOf(obj: WorldObject): Tile {
    return { x: obj.x + Math.floor(obj.w / 2), y: obj.y + Math.floor(obj.h / 2) };
  }

  /** 目标对象的中心瓦片；对象不存在返回 null */
  targetTile(objectId: string | null): Tile | null {
    const obj = this.getObject(objectId);
    return obj ? this.centerOf(obj) : null;
  }

  inBounds(t: Tile): boolean {
    return t.x >= 0 && t.x < GRID_W && t.y >= 0 && t.y < GRID_H;
  }

  /** 所在瓦片上的对象：取包含该瓦片且面积最小的对象；无则返回 town */
  objectAt(t: Tile): WorldObject | null {
    let best: WorldObject | null = null;
    for (const o of this.objects.values()) {
      if (o.type === 'town') continue;
      const contains = t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h;
      if (!contains) continue;
      if (!best || o.w * o.h < best.w * best.h) best = o;
    }
    return best ?? this.objects.get('obj:town') ?? null;
  }

  /** agent 所在瓦片对应的对象 id */
  locationOf(agent: Agent): string {
    return this.objectAt({ x: agent.x, y: agent.y })?.id ?? agent.locationId;
  }
}
