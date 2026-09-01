// 自发社交：居民在同一现场观察到彼此后，依据可用状态、人格与冷却形成可审计的会话意图。

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { DialogueEngine } from './dialogue';
import type { RelationshipStore } from '../store/relationships';

export interface SocialConfig {
  minProximityMinutes?: number; // 相邻累计多少游戏分钟触发（默认 3）
  cooldownMinutes?: number;     // 同一对完整会话后的冷却（默认 90）
  residentCooldownMinutes?: number; // 单个居民结束一次发起后多久可再次主动发起（默认 45）
  cueRetentionMinutes?: number; // 可用于开启话题的现场观察保留时长（默认 180）
  enabled?: () => boolean;      // 正式受控实验运行时可暂停自然接触，避免污染处理效应
}

export interface SocialTickerCheckpoint {
  schemaVersion: 1;
  proximity: Array<[string, number]>;
  nextAt: Array<[string, number]>;
  residentNextAt: Array<[string, number]>;
  cues: SocialCue[];
}

const GENERIC_GREETINGS = ['你好呀！', '今天天气真不错。', '最近忙什么呢？', '有阵子没见啦。'];

export class SocialTicker {
  private proximity = new Map<string, number>();
  private nextAt = new Map<string, number>();
  private residentNextAt = new Map<string, number>();
  private cues: SocialCue[] = [];
  private unsubscribe: (() => void) | null;

  constructor(
    private log: EventLog,
    private cfg: SocialConfig = {},
    private dialogue?: DialogueEngine,
    private rels?: RelationshipStore,
  ) {
    this.unsubscribe = this.log.subscribe((event) => this.observe(event));
  }

  dispose(preserveCheckpointState = false): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (preserveCheckpointState) return;
    this.cues = [];
    this.proximity.clear();
    this.nextAt.clear();
    this.residentNextAt.clear();
  }

  checkpoint(): SocialTickerCheckpoint {
    const ordered = (source: ReadonlyMap<string, number>): Array<[string, number]> => (
      [...source].sort(([left], [right]) => left.localeCompare(right))
    );
    return {
      schemaVersion: 1,
      proximity: ordered(this.proximity),
      nextAt: ordered(this.nextAt),
      residentNextAt: ordered(this.residentNextAt),
      cues: this.cues.map((cue) => ({ ...cue, observerIds: [...cue.observerIds] })),
    };
  }

  restore(input: unknown, validAgentIds: ReadonlySet<string>, now: number): void {
    const checkpoint = validateSocialTickerCheckpoint(input, validAgentIds, now);
    this.proximity = new Map(checkpoint.proximity);
    this.nextAt = new Map(checkpoint.nextAt);
    this.residentNextAt = new Map(checkpoint.residentNextAt);
    this.cues = checkpoint.cues.map((cue) => ({ ...cue, observerIds: [...cue.observerIds] }));
  }

  /** 每 tick 调用一次；dt = 本次推进的游戏分钟数 */
  tick(agents: Agent[], dt: number, now: number, world?: WorldState): void {
    if (this.cfg.enabled && !this.cfg.enabled()) {
      this.proximity.clear();
      return;
    }
    const min = this.cfg.minProximityMinutes ?? 3;
    const cooldown = this.cfg.cooldownMinutes ?? 90;
    const residentCooldown = this.cfg.residentCooldownMinutes ?? 45;
    const cueRetention = this.cfg.cueRetentionMinutes ?? 180;
    this.cues = this.cues.filter((cue) => now - cue.gameTime <= cueRetention);
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const key = pairKey(a.id, b.id);
        if (chebyshev(a, b) <= 1 && sociallyAvailable(a) && sociallyAvailable(b)) {
          this.proximity.set(key, (this.proximity.get(key) ?? 0) + dt);
        } else {
          this.proximity.set(key, 0);
          continue;
        }
        if (this.proximity.get(key)! < min || now < (this.nextAt.get(key) ?? 0)) continue;
        const [initiator, other] = chooseInitiator(a, b, this.rels);
        if (now < (this.residentNextAt.get(initiator.id) ?? 0)) continue;
        const cue = this.bestCueFor(initiator.id, other.id);
        const place = world?.getObject(initiator.locationId)?.name
          ?? world?.getObject(other.locationId)?.name
          ?? '当前地点';
        const evidence = cue
          ? [cue.description]
          : [`${initiator.name}在${place}看见${other.name}就在身边。`];
        let started = false;
        if (this.dialogue) {
          // 完整会话是这次社会接触的唯一言语记录；失败的竞争请求不消耗冷却。
          if (!this.dialogue.isActive(initiator.id, other.id)) {
            started = this.dialogue.start(initiator, other, now, {
              requireAdjacent: true,
              source: 'proximity',
              world,
              trigger: {
                initiatorId: initiator.id,
                reason: cue ? 'observed_event' : 'co_presence',
                evidence,
                evidenceEventIds: cue ? [cue.eventId] : [],
              },
            });
          }
        } else {
          const line = pickLine(initiator, Math.floor(now / Math.max(1, cooldown)));
          this.log.addEvent(makeChatEvent(initiator, other, line, now));
          started = true;
        }
        if (!started) continue;
        this.proximity.set(key, 0);
        this.nextAt.set(key, now + cooldown);
        this.residentNextAt.set(initiator.id, now + Math.min(residentCooldown, cooldown));
      }
    }
  }

  private observe(event: GameEvent): void {
    const kind = typeof event.payload?.kind === 'string' ? event.payload.kind : '';
    if (
      event.type !== 'interact'
      && event.type !== 'move'
      && kind !== 'ambient_life'
      && kind !== 'public_object_interaction'
    ) return;
    const payloadObservers = Array.isArray(event.payload?.observerIds)
      ? event.payload.observerIds.filter((id): id is string => typeof id === 'string')
      : [];
    const memoryObservers = Array.isArray(event.payload?.memoryAgentIds)
      ? event.payload.memoryAgentIds.filter((id): id is string => typeof id === 'string')
      : [];
    this.cues.push({
      eventId: event.id,
      gameTime: event.gameTime,
      actorId: event.actorId,
      // targetIds 也可能是柜台、长椅等物件；只有显式观察者字段才具有居民语义。
      observerIds: [...new Set([...payloadObservers, ...memoryObservers])],
      description: event.description.slice(0, 180),
    });
    while (this.cues.length > 64) this.cues.shift();
  }

  private bestCueFor(observerId: string, otherId: string): SocialCue | null {
    return [...this.cues].reverse().find((cue) => (
      cue.observerIds.includes(observerId)
      && (cue.actorId === otherId || cue.observerIds.includes(otherId))
    )) ?? null;
  }
}

export interface SocialCue {
  eventId: string;
  gameTime: number;
  actorId: string | null;
  observerIds: string[];
  description: string;
}

export function validateSocialTickerCheckpoint(
  input: unknown,
  validAgentIds: ReadonlySet<string>,
  now: number,
): SocialTickerCheckpoint {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('社交冷却恢复时刻无效');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('社交冷却检查点必须是对象');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.proximity) || !Array.isArray(value.nextAt)
      || !Array.isArray(value.residentNextAt) || !Array.isArray(value.cues)) {
    throw new Error('社交冷却检查点版本或结构无效');
  }
  const proximity = validatePairMap(value.proximity, validAgentIds, '相邻累计', 0, 10_000);
  const nextAt = validatePairMap(value.nextAt, validAgentIds, '配对冷却', 0, Number.MAX_SAFE_INTEGER);
  const residentNextAt = validateResidentMap(value.residentNextAt, validAgentIds);
  const cueIds = new Set<string>();
  const cues = value.cues.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('社交线索检查点无效');
    const cue = raw as Record<string, unknown>;
    if (typeof cue.eventId !== 'string' || !cue.eventId || cue.eventId.length > 200 || cueIds.has(cue.eventId)
        || !Number.isSafeInteger(cue.gameTime) || (cue.gameTime as number) < 0 || (cue.gameTime as number) > now
        || (cue.actorId !== null && (typeof cue.actorId !== 'string' || !validAgentIds.has(cue.actorId)))
        || !Array.isArray(cue.observerIds) || typeof cue.description !== 'string' || cue.description.length > 180) {
      throw new Error('社交线索检查点引用未知居民或非法时间');
    }
    const observers = new Set<string>();
    const observerIds = cue.observerIds.map((id) => {
      if (typeof id !== 'string' || !validAgentIds.has(id) || observers.has(id)) throw new Error('社交线索观察者无效');
      observers.add(id);
      return id;
    });
    cueIds.add(cue.eventId);
    return {
      eventId: cue.eventId,
      gameTime: cue.gameTime as number,
      actorId: cue.actorId as string | null,
      observerIds,
      description: cue.description,
    };
  });
  return { schemaVersion: 1, proximity, nextAt, residentNextAt, cues };
}

function validatePairMap(
  input: unknown[],
  validAgentIds: ReadonlySet<string>,
  label: string,
  min: number,
  max: number,
): Array<[string, number]> {
  const seen = new Set<string>();
  return input.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || seen.has(entry[0]) || typeof entry[1] !== 'number' || !Number.isFinite(entry[1])
        || entry[1] < min || entry[1] > max) throw new Error(`社交${label}检查点无效`);
    const ids = entry[0].split('|');
    if (ids.length !== 2 || ids[0] >= ids[1] || !validAgentIds.has(ids[0]) || !validAgentIds.has(ids[1])) {
      throw new Error(`社交${label}检查点包含未知配对`);
    }
    seen.add(entry[0]);
    return [entry[0], entry[1]] as [string, number];
  });
}

function validateResidentMap(input: unknown[], validAgentIds: ReadonlySet<string>): Array<[string, number]> {
  const seen = new Set<string>();
  return input.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !validAgentIds.has(entry[0]) || seen.has(entry[0])
        || !Number.isSafeInteger(entry[1]) || entry[1] < 0) {
      throw new Error('社交居民冷却检查点无效');
    }
    seen.add(entry[0]);
    return [entry[0], entry[1]] as [string, number];
  });
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

function chebyshev(a: Agent, b: Agent): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function sociallyAvailable(agent: Agent): boolean {
  if (agent.state === 'thinking' || agent.state === 'moving') return false;
  if (agent.state !== 'acting') return true;
  const verb = agent.action?.action.verb ?? '';
  return !/睡觉|睡眠|午睡|午休|小憩|打盹|就寝/.test(verb);
}

function chooseInitiator(a: Agent, b: Agent, rels?: RelationshipStore): [Agent, Agent] {
  const score = (agent: Agent, other: Agent): number => {
    const personality = agent.persona.personality;
    const initial = agent.persona.initialState;
    const relationship = rels?.getOrCreate(agent.id, other.id);
    return (personality?.extraversion ?? 0.5) * 0.45
      + (personality?.empathy ?? 0.5) * 0.15
      + (personality?.curiosity ?? 0.5) * 0.15
      + (initial?.socialNeed ?? 0.5) * 0.2
      + Math.max(-0.2, Math.min(0.2, relationship?.affection ?? 0)) * 0.05;
  };
  const aScore = score(a, b);
  const bScore = score(b, a);
  if (aScore === bScore) return a.id.localeCompare(b.id) <= 0 ? [a, b] : [b, a];
  return aScore > bScore ? [a, b] : [b, a];
}

function pickLine(a: Agent, count: number): string {
  const pool = a.persona.greetingPool?.length ? a.persona.greetingPool : GENERIC_GREETINGS;
  return pool[count % pool.length];
}

function makeChatEvent(a: Agent, b: Agent, line: string, now: number): GameEvent {
  return {
    id: randomUUID(),
    type: 'chat',
    actorId: a.id,
    targetIds: [b.id],
    description: `「${a.name}」对「${b.name}」说：「${line}」`,
    location: a.locationId,
    gameTime: now,
    payload: { kind: 'chat', line, fromId: a.id, toId: b.id },
  };
}
