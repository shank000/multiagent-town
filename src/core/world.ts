// 世界状态：agent 集合 + 对象树 + 12×8 网格

import type { Agent, Tile, WorldObject } from './types';

export const GRID_W = 12;
export const GRID_H = 8;

export class WorldState {
  private agents = new Map<string, Agent>();
  private objects = new Map<string, WorldObject>();

  constructor(objects: WorldObject[], agents: Agent[]) {
    for (const o of objects) this.objects.set(o.id, o);
    for (const a of agents) this.agents.set(a.id, a);
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

  /** 曼哈顿步进路径：从 from 到 to（含起点与终点） */
  manhattanPath(from: Tile, to: Tile): Tile[] {
    const path: Tile[] = [];
    let { x, y } = from;
    path.push({ x, y });
    while (x !== to.x || y !== to.y) {
      if (x !== to.x) x += Math.sign(to.x - x);
      else y += Math.sign(to.y - y);
      path.push({ x, y });
    }
    return path;
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
