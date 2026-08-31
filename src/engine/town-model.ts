// 公开活动：预告意向 → 居民步行前往 → 现场到场核验 → 仅对真实参与者形成共同经历。

import { createHash, randomUUID } from 'node:crypto';
import type { Agent, Persona, Personality, Tile, WorldObject } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { RelationshipStore } from '../store/relationships';

export const PERSONALITY_DEFAULTS: Personality = { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 };

export function personalityOf(p: Persona): Personality {
  return { ...PERSONALITY_DEFAULTS, ...(p.personality ?? {}) };
}

interface CatalogEvent {
  name: string;
  announcement: string;
  trait: keyof Personality;
  venueId: string;
  attendanceRadius: number;
  activityVerb: string;
  sensoryCues: string[];
  durationMinutes: number;
  capacity: number;
}

interface PlannedEvent {
  day: number;
  event: CatalogEvent;
  interestedIds: string[];
  selectedIds: string[];
  stagedTiles: Map<string, Tile>;
}

export interface TownModelOptions {
  /** 同一世界种子、日期、居民和活动得到相同出席排序；不消费伙伴选择 RNG。 */
  seed?: number | string;
}

const PLAN_MINUTE = 300;
const PREP_MINUTE = 1110;
const START_MINUTE = 1170;

const CATALOG: readonly CatalogEvent[] = [
  {
    name: '湖边派对', announcement: '计划今晚在湖边举办小型聚会；只有实际到场才算参加。',
    trait: 'extraversion', venueId: 'obj:lake', attendanceRadius: 2, activityVerb: '参加湖边派对',
    sensoryCues: ['湖风与水声', '居民在湖边交谈的声音'], durationMinutes: 60, capacity: 3,
  },
  {
    name: '书店读书会', announcement: '计划今晚在默语书店举行读书会；只有实际到场才算参加。',
    trait: 'curiosity', venueId: 'obj:bookstore_counter', attendanceRadius: 2, activityVerb: '参加书店读书会',
    sensoryCues: ['翻动书页的声音', '书店木架与纸张的气味'], durationMinutes: 60, capacity: 3,
  },
  {
    name: '广场集市', announcement: '计划今晚开放广场集市摊位；只有实际到场才算参加。',
    trait: 'extraversion', venueId: 'obj:market_stall', attendanceRadius: 3, activityVerb: '参加广场集市',
    sensoryCues: ['篮筐与零钱碰撞声', '果蔬、面包和干草的气味'], durationMinutes: 60, capacity: 3,
  },
] as const;

export class TownModel {
  private plans = new Map<number, PlannedEvent>();
  private lastNow = 0;
  private seed: string;

  constructor(private log: EventLog, _rels: RelationshipStore, options: TownModelOptions = {}) {
    this.seed = `${typeof options.seed}:${String(options.seed ?? 'town-default')}`;
  }

  tick(world: WorldState, _dt: number, now: number): void {
    if (now < this.lastNow) {
      this.plans.clear();
      this.lastNow = now;
      return;
    }
    const previous = this.lastNow;
    const firstDay = Math.floor(previous / 1440) + 1;
    const lastDay = Math.floor(now / 1440) + 1;
    for (let day = firstDay; day <= lastDay; day += 1) {
      const dayStart = (day - 1) * 1440;
      const planAt = dayStart + PLAN_MINUTE;
      if (previous < planAt && planAt <= now) this.plan(world, day, planAt);
    }
    for (const plan of this.plans.values()) {
      const dayStart = (plan.day - 1) * 1440;
      const startAt = dayStart + START_MINUTE;
      if (now >= dayStart + PREP_MINUTE && now < startAt) this.stageInterested(world, plan, now, startAt);
      if (previous < startAt && startAt <= now) this.startOrCancel(world, plan, startAt);
    }
    for (const day of this.plans.keys()) if (day < lastDay - 1) this.plans.delete(day);
    this.lastNow = now;
  }

  private plan(world: WorldState, day: number, now: number): void {
    const event = CATALOG[(day - 1) % CATALOG.length];
    const interestedIds = world.allAgents()
      .filter((agent) => personalityOf(agent.persona)[event.trait] >= 0.25)
      .map((agent) => agent.id);
    const selectedIds = interestedIds
      .map((agentId) => {
        const trait = personalityOf(world.getAgent(agentId).persona)[event.trait];
        const variation = this.seededUnit(`attendance:${day}:${event.name}:${agentId}`);
        return { agentId, score: trait * 0.55 + variation * 0.45 };
      })
      .sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId))
      .slice(0, event.capacity)
      .map((item) => item.agentId);
    this.plans.set(day, { day, event, interestedIds, selectedIds, stagedTiles: new Map() });
    const venue = world.getObject(event.venueId);
    this.log.addEvent({
      id: randomUUID(), type: 'broadcast', actorId: null, targetIds: interestedIds,
      description: `活动预告（尚未发生）：「${event.name}」${event.announcement}`,
      location: event.venueId, gameTime: now,
      payload: {
        kind: 'town_event_announcement', name: event.name, status: 'planned',
        venueId: event.venueId, venueName: venue?.name ?? event.venueId,
        interestedIds, selectedIds, attendanceCapacity: event.capacity,
        selectionMethod: 'seeded_trait_rank/v1', memoryAgentIds: interestedIds,
      },
    });
  }

  private stageInterested(world: WorldState, plan: PlannedEvent, now: number, startAt: number): void {
    const venue = world.getObject(plan.event.venueId);
    if (!venue) return;
    const reserved = new Set([...plan.stagedTiles.values()].map(tileKey));
    for (const agentId of plan.selectedIds) {
      if (plan.stagedTiles.has(agentId)) continue;
      const agent = world.getAgent(agentId);
      if (agent.state === 'thinking' || /睡|就寝|打盹/u.test(agent.action?.action.verb ?? '')) continue;
      const destination = this.gatheringTile(world, venue, plan.event.attendanceRadius, agent, reserved);
      if (!destination) continue;
      const path = world.findPath({ x: agent.x, y: agent.y }, destination);
      if (!path) continue;
      plan.stagedTiles.set(agent.id, destination);
      reserved.add(tileKey(destination));
      const duration = Math.max(10, startAt + plan.event.durationMinutes - now);
      agent.thought = `我对「${plan.event.name}」有兴趣，先前往${venue.name}；到场后才算真正参加。`;
      agent.action = {
        thought: agent.thought,
        action: { type: 'interact', target: venue.id, verb: `等待「${plan.event.name}」开始` },
        durationMinutes: duration,
      };
      agent.lastDecisionAt = now;
      if (path.length <= 1) {
        agent.state = 'acting';
        agent.actionEndsAt = startAt + plan.event.durationMinutes;
      } else {
        agent.state = 'moving';
        agent.path = path;
        agent.pathProgress = 0;
      }
      this.log.addEvent({
        id: randomUUID(), type: 'move', actorId: agent.id, targetIds: [venue.id],
        description: `${agent.name}根据活动预告开始前往「${venue.name}」，活动尚未开始。`,
        location: agent.locationId, gameTime: now,
        payload: {
          kind: 'town_event_departure', name: plan.event.name, status: 'en_route',
          venueId: venue.id, venueName: venue.name, memoryAgentIds: [agent.id],
        },
      });
    }
  }

  private startOrCancel(world: WorldState, plan: PlannedEvent, now: number): void {
    const venue = world.getObject(plan.event.venueId);
    const selected = plan.selectedIds.map((id) => world.getAgent(id));
    const attendees = venue
      ? selected.filter((agent) => distanceToObject(agent, venue) <= plan.event.attendanceRadius)
      : [];
    const attendeeIds = new Set(attendees.map((agent) => agent.id));
    const observers = venue
      ? world.allAgents().filter((agent) => !attendeeIds.has(agent.id)
        && distanceToObject(agent, venue) <= plan.event.attendanceRadius + 2)
      : [];
    if (!venue || attendees.length < 2) {
      this.releaseStaged(selected, plan.event.venueId, new Set());
      const present = attendees.length ? attendees.map((agent) => agent.name).join('、') : '无人';
      this.log.addEvent({
        id: randomUUID(), type: 'system', actorId: null, targetIds: plan.interestedIds,
        description: `「${plan.event.name}」现场核验未达到两人：${present}实际到场，活动取消。`,
        location: plan.event.venueId, gameTime: now,
        payload: {
          kind: 'town_event_cancelled', name: plan.event.name, status: 'cancelled',
          venueId: plan.event.venueId, attendeeIds: attendees.map((agent) => agent.id),
          interestedIds: plan.interestedIds, selectedIds: plan.selectedIds,
          attendanceCapacity: plan.event.capacity, selectionMethod: 'seeded_trait_rank/v1',
          memoryAgentIds: plan.interestedIds,
        },
      });
      this.plans.delete(plan.day);
      return;
    }

    const attendeeNames = attendees.map((agent) => agent.name);
    const eventId = randomUUID();
    venue.state = {
      label: `${plan.event.name}进行中`,
      detail: `${attendeeNames.join('、')}已在${venue.name}实际到场。`,
      updatedGameTime: now,
      expiresGameTime: now + plan.event.durationMinutes,
    };
    for (const agent of attendees) {
      agent.state = 'acting';
      agent.path = [];
      agent.pathProgress = 0;
      agent.thought = `我已经到达${venue.name}，现在可以参加「${plan.event.name}」。`;
      agent.action = {
        thought: agent.thought,
        action: { type: 'interact', target: venue.id, verb: plan.event.activityVerb },
        durationMinutes: plan.event.durationMinutes,
      };
      agent.actionEndsAt = now + plan.event.durationMinutes;
      agent.lastDecisionAt = now;
    }
    this.releaseStaged(selected, plan.event.venueId, attendeeIds);
    this.log.addEvent({
      id: eventId, type: 'broadcast', actorId: null,
      targetIds: [...attendees.map((agent) => agent.id), ...observers.map((agent) => agent.id)],
      description: `活动现场（已核验）：${attendeeNames.join('、')}在「${venue.name}」实际到场参加「${plan.event.name}」。`,
      location: venue.id, gameTime: now,
      payload: {
        kind: 'town_event', name: plan.event.name, status: 'active',
        venueId: venue.id, venueName: venue.name,
        participants: attendees.map((agent) => agent.id),
        interestedIds: plan.interestedIds, selectedIds: plan.selectedIds,
        attendanceCapacity: plan.event.capacity, selectionMethod: 'seeded_trait_rank/v1',
        observerIds: observers.map((agent) => agent.id),
        memoryAgentIds: [...attendees.map((agent) => agent.id), ...observers.map((agent) => agent.id)],
        sensoryCues: plan.event.sensoryCues,
        startsAt: now, endsAt: now + plan.event.durationMinutes,
      },
    });
    // 共同在场由可重放的 town_event 参与者列表记录；仅同场不推断二元亲密关系。
    // 后续若发生对话、协作或馈礼，再由对应的二元证据更新 RelationshipStore。
    this.plans.delete(plan.day);
  }

  private seededUnit(label: string): number {
    return createHash('sha256').update(this.seed).update('\0').update(label).digest().readUInt32BE(0) / 0x1_0000_0000;
  }

  private releaseStaged(agents: Agent[], venueId: string, keep: ReadonlySet<string>): void {
    for (const agent of agents) {
      if (keep.has(agent.id) || agent.action?.action.target !== venueId) continue;
      agent.state = 'idle';
      agent.action = null;
      agent.path = [];
      agent.pathProgress = 0;
    }
  }

  private gatheringTile(
    world: WorldState,
    venue: WorldObject,
    radius: number,
    agent: Agent,
    reserved: ReadonlySet<string>,
  ): Tile | null {
    if (distanceToObject(agent, venue) <= radius && !reserved.has(tileKey(agent))) return { x: agent.x, y: agent.y };
    const center = world.centerOf(venue);
    const candidates: Tile[] = [];
    for (let y = venue.y - radius; y < venue.y + venue.h + radius; y += 1) {
      for (let x = venue.x - radius; x < venue.x + venue.w + radius; x += 1) {
        const tile = { x, y };
        if (!world.walkable(x, y) || reserved.has(tileKey(tile))) continue;
        if (distanceTileToObject(tile, venue) <= radius) candidates.push(tile);
      }
    }
    candidates.sort((left, right) => (
      Math.abs(left.x - center.x) + Math.abs(left.y - center.y)
      - Math.abs(right.x - center.x) - Math.abs(right.y - center.y)
    ));
    return candidates.find((tile) => world.findPath({ x: agent.x, y: agent.y }, tile) !== null) ?? null;
  }
}

function distanceToObject(agent: Agent, object: WorldObject): number {
  return distanceTileToObject({ x: agent.x, y: agent.y }, object);
}

function distanceTileToObject(tile: Tile, object: WorldObject): number {
  const dx = tile.x < object.x ? object.x - tile.x : tile.x >= object.x + object.w ? tile.x - (object.x + object.w - 1) : 0;
  const dy = tile.y < object.y ? object.y - tile.y : tile.y >= object.y + object.h ? tile.y - (object.y + object.h - 1) : 0;
  return dx + dy;
}

function tileKey(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}
