// 世界状态：agent 集合 + 对象树 + 12×8 网格

import type { Agent, Tile, WorldObject } from './types';
import { findPath } from './pathfinding';

export const GRID_W = 12;
export const GRID_H = 8;

export class WorldState {
  private agents = new Map<string, Agent>();
  private objects = new Map<string, WorldObject>();
  private blocked = new Set<string>();

  constructor(objects: WorldObject[], agents: Agent[]) {
    for (const o of objects) this.objects.set(o.id, o);
    for (const a of agents) this.agents.set(a.id, a);
    this.computeWalkable();
  }

  /** 建筑边界（除门）为墙；门 = 底边中点；房间/家具所在瓦片始终可通行（活动目标点） */
  private computeWalkable(): void {
    for (const o of this.objects.values()) {
      if (o.type !== 'building') continue;
      const door = `${o.x + Math.floor(o.w / 2)},${o.y + o.h - 1}`;
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) {
          const border = x === o.x || x === o.x + o.w - 1 || y === o.y || y === o.y + o.h - 1;
          if (border) this.blocked.add(`${x},${y}`);
        }
      }
      this.blocked.delete(door); // 门开口
    }
    // 房间/家具瓦片开口（2×2 小建筑无室内，吧台/柜台等活动点必须可达）
    for (const r of this.objects.values()) {
      if (r.type !== 'room' && r.type !== 'furniture') continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        for (let y = r.y; y < r.y + r.h; y++) this.blocked.delete(`${x},${y}`);
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
