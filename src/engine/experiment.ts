// 伙伴选择预实验：每晚 19:30 全员各选一名伙伴一对一交流（关系记忆开/关两组对照）
// 研究假设：可访问伙伴历史互动记忆时，选择变为历史依赖 → 随时间形成持久的互动结构

import { createHash, randomUUID } from 'node:crypto';
import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MindEngine } from './mind';
import { Economy, ITEMS, validateEconomyCheckpoint, type EconomyCheckpoint } from './economy';

export interface PartnerExperimentConfig {
  /** 因子1：on = 按关系记忆（亲密度 + 最近互动时间）打分选伙伴；off = 均匀随机选 */
  historyAccess: 'on' | 'off';
  /** 因子2：on = 每日购买鲜花赠予所择伙伴（馈礼→亲密度+0.1）；off = 无馈礼 */
  giftExchange: 'on' | 'off';
}

export type LabelledRandom = (label: string) => number;

export interface PartnerChoiceExperimentOptions {
  /** Pilot/reference policy seed. Identical labels under an identical seed produce identical draws. */
  seed?: number | string;
  /** Optional injected draw function for focused tests or alternate deterministic backends. */
  random?: LabelledRandom;
}

export interface PartnerChoiceExperimentCheckpoint {
  schemaVersion: 1;
  lastMinute: number;
  manualDecisionIndices: Array<{ agentId: string; index: number }>;
  economy: EconomyCheckpoint;
}

export const RECENCY_WINDOW_MINUTES = 2400;

/** A stateless labelled draw prevents one policy branch from shifting another branch's random stream. */
export function createLabelledRandom(seed: number | string): LabelledRandom {
  const namespace = `${typeof seed}:${String(seed)}`;
  return (label: string): number => {
    const digest = createHash('sha256').update(namespace).update('\0').update(label).digest();
    const high27 = digest.readUInt32BE(0) >>> 5;
    const low26 = digest.readUInt32BE(4) >>> 6;
    return (high27 * 67_108_864 + low26) / 9_007_199_254_740_992;
  };
}

/** Recent relationships receive a linearly decaying bonus; an absent relationship has no bonus. */
export function recencyBonus(
  now: number,
  lastInteraction: number | null | undefined,
  window = RECENCY_WINDOW_MINUTES
): number {
  if (lastInteraction === null || lastInteraction === undefined) return 0;
  return Math.max(0, Math.min(1, 1 - (now - lastInteraction) / window));
}

export const CHOICE_MINUTE = 1170; // 19:30

export class PartnerChoiceExperiment {
  private lastMinute = 0;
  private manualDecisionIndex = new Map<string, number>();

  private economy = new Economy();
  private random: LabelledRandom;
  cfg: PartnerExperimentConfig;

  constructor(
    private log: EventLog,
    private world: WorldState,
    private mind: MindEngine,
    cfg: PartnerExperimentConfig,
    options: PartnerChoiceExperimentOptions = {}
  ) {
    this.cfg = cfg;
    this.random = options.random ?? createLabelledRandom(options.seed ?? randomUUID());
  }

  /** 跨越一个或多个 19:30 边界时逐轮触发，并返回实际完成的轮数。 */
  tick(now: number, maxRounds = Number.MAX_SAFE_INTEGER): number {
    if (now < this.lastMinute) {
      this.lastMinute = now;
      return 0;
    }
    let completed = 0;
    const firstDay = Math.floor(this.lastMinute / 1440);
    const lastDay = Math.floor(now / 1440);
    for (let day = firstDay; day <= lastDay && completed < maxRounds; day++) {
      const scheduled = day * 1440 + CHOICE_MINUTE;
      if (this.lastMinute < scheduled && scheduled <= now) {
        this.round(scheduled);
        completed++;
      }
    }
    this.lastMinute = now;
    return completed;
  }

  /** 运行器开始或恢复时以当前时刻建立触发基线，不回补停机期间的轮次。 */
  resetClock(now: number): void {
    this.lastMinute = now;
  }

  checkpoint(): PartnerChoiceExperimentCheckpoint {
    return {
      schemaVersion: 1,
      lastMinute: this.lastMinute,
      manualDecisionIndices: [...this.manualDecisionIndex]
        .map(([agentId, index]) => ({ agentId, index }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      economy: this.economy.checkpoint(),
    };
  }

  /** 恢复触发基线；用当前恢复时刻夹紧，明确不补跑进程停机区间。 */
  restore(input: unknown, now: number): void {
    const checkpoint = validatePartnerChoiceCheckpoint(input, this.world, now);
    this.lastMinute = now;
    this.manualDecisionIndex = new Map(
      checkpoint.manualDecisionIndices.map(({ agentId, index }) => [agentId, index]),
    );
    this.economy.restore(checkpoint.economy, new Set(this.world.allAgents().map((agent) => agent.id)));
  }

  /** 当日一轮：先冻结全员候选状态并独立选择，再执行馈礼与一对一对话。 */
  round(now: number): void {
    const decisions = this.world.allAgents().map((agent) => ({
      agent,
      snapshot: this.pickSnapshot(agent),
      partner: this.pickPartner(agent, now, `round:${now}:agent:${agent.id}`),
    }));
    const reservations = new Map<string, { conversationId: string; status: 'queued' }>();

    for (const { agent, partner, snapshot } of decisions) {
      if (partner === null) continue;
      const pair = experimentPairKey(agent.id, partner.id);
      let reservation = reservations.get(pair);
      if (!reservation) {
        reservation = this.mind.dialogue.reserve(agent, partner, now, {
          requireAdjacent: false,
          source: 'experiment',
          world: this.world,
        });
        reservations.set(pair, reservation);
      }
      this.log.addEvent({
        id: randomUUID(),
        type: 'chat',
        actorId: agent.id,
        targetIds: [partner.id],
        description: `「${agent.name}」选择了「${partner.name}」一对一交流`,
        location: agent.locationId,
        gameTime: now,
        payload: {
          kind: 'experiment_pair_choice', fromId: agent.id, toId: partner.id,
          mode: this.cfg.historyAccess,
          candidates: snapshot,
          chosen: partner.id,
          conversationId: reservation.conversationId,
          conversationStatus: reservation.status,
        },
      });
      if (this.cfg.giftExchange === 'on') this.gift(agent, partner, now);
    }
    this.mind.dialogue.dispatchReservations(this.world, now);
  }

  /** 馈礼：工资购买 → 花店订单履约 → 收礼方库存入账 → 关系证据同步。 */
  private gift(gifter: Agent, receiver: Agent, now: number): void {
    this.economy.earnDaily(gifter.id);
    if (!this.economy.buy(gifter.id, 'flower')) return;
    const delta = this.economy.give(gifter.id, receiver.id, 'flower');
    if (delta === null) return;
    const giftEventId = randomUUID();
    const sourceObjectId = 'obj:flower_counter';
    const sourceObjectName = this.world.getObject(sourceObjectId)?.name ?? '花店服务台';
    const deliveryLocationId = receiver.locationId;
    const deliveryLocationName = this.world.getObject(deliveryLocationId)?.name ?? deliveryLocationId;
    const receiverInventory = this.economy.inventoryOf(receiver.id);
    this.log.addEvent({
      id: giftEventId,
      type: 'system',
      actorId: gifter.id,
      targetIds: [receiver.id],
      description: `花店订单（已履约）：「${gifter.name}」从${sourceObjectName}购买一束${ITEMS.flower.name}，配送到${deliveryLocationName}并交给「${receiver.name}」。`,
      location: sourceObjectId,
      gameTime: now,
      payload: {
        kind: 'gift', status: 'fulfilled', fromId: gifter.id, toId: receiver.id, item: 'flower',
        mechanism: 'flower_shop_delivery', sourceObjectId, sourceObjectName,
        deliveryLocationId, deliveryLocationName,
        receiverInventory: { flower: receiverInventory.flower ?? 0 },
        memoryAgentIds: [gifter.id, receiver.id],
      },
    });
    this.mind.rels.update(gifter.id, receiver.id, {
      affectionDelta: delta,
      evidence: {
        kind: 'gift_sent', eventId: giftEventId,
        text: `赠送${ITEMS.flower.name}`,
        supportDelta: delta * 0.5,
        metadata: { item: 'flower', role: 'sender', status: 'fulfilled', sourceObjectId, deliveryLocationId },
      },
    }, now);
    this.mind.rels.update(receiver.id, gifter.id, {
      affectionDelta: delta * 0.5,
      evidence: {
        kind: 'gift_received', eventId: giftEventId,
        text: `收到${ITEMS.flower.name}`,
        trustDelta: delta * 0.3,
        supportDelta: delta,
        metadata: { item: 'flower', role: 'receiver', status: 'fulfilled', sourceObjectId, deliveryLocationId },
      },
    }, now);
  }

  /** 候选者快照：等量可用伙伴 + 各自关系痕迹（供叙事呈现「历史依赖选择」） */
  private pickSnapshot(agent: Agent): { id: string; name: string; affection: number; lastInteraction: number }[] {
    return this.world.allAgents()
      .filter((a) => a.id !== agent.id)
      .map((a) => {
        const rel = this.mind.rels.allFor(agent.id).find((r) => r.agentB === a.id);
        return {
          id: a.id,
          name: a.name,
          affection: rel ? Math.round(rel.affection * 100) / 100 : 0,
          lastInteraction: rel ? Math.round(rel.updatedGameTime) : 0,
        };
      });
  }

  /** Pilot/reference policy: on = 亲密度 + 相对近因 + 标记扰动；off = 标记均匀抽样。 */
  pickPartner(agent: Agent, now = 0, decisionLabel?: string): Agent | null {
    const others = this.world.allAgents().filter((a) => a.id !== agent.id);
    if (!others.length) return null;
    const label = decisionLabel ?? this.nextManualDecisionLabel(agent.id);
    if (this.cfg.historyAccess === 'off') {
      return others[Math.floor(this.random(`${label}:uniform`) * others.length)];
    }
    const rels = this.mind.rels.allFor(agent.id);
    const scored = others.map((candidate) => {
      const rel = rels.find((r) => r.agentB === candidate.id);
      const affection = rel?.affection ?? 0;
      const recency = recencyBonus(now, rel?.updatedGameTime);
      const jitter = this.random(`${label}:candidate:${candidate.id}:jitter`) * 0.3;
      return { candidate, score: affection + recency * 0.5 + jitter };
    });
    return scored.slice(1).reduce((best, current) => (
      current.score > best.score ? current : best
    ), scored[0]).candidate;
  }

  private nextManualDecisionLabel(agentId: string): string {
    const index = this.manualDecisionIndex.get(agentId) ?? 0;
    this.manualDecisionIndex.set(agentId, index + 1);
    return `manual:${agentId}:${index}`;
  }
}

export function validatePartnerChoiceCheckpoint(
  input: unknown,
  world: WorldState,
  now: number,
): PartnerChoiceExperimentCheckpoint {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('伙伴实验恢复时刻无效');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('伙伴实验检查点必须是对象');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.lastMinute)
      || (value.lastMinute as number) < 0 || (value.lastMinute as number) > now) {
    throw new Error('伙伴实验检查点版本或触发基线无效');
  }
  if (!Array.isArray(value.manualDecisionIndices)) throw new Error('伙伴实验检查点决策索引无效');
  const ids = new Set<string>();
  const manualDecisionIndices = value.manualDecisionIndices.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('伙伴实验检查点决策索引无效');
    const entry = item as Record<string, unknown>;
    if (typeof entry.agentId !== 'string' || !world.hasAgent(entry.agentId)
        || ids.has(entry.agentId) || !Number.isSafeInteger(entry.index) || (entry.index as number) < 0) {
      throw new Error('伙伴实验检查点包含未知居民或非法决策索引');
    }
    ids.add(entry.agentId);
    return { agentId: entry.agentId, index: entry.index as number };
  });
  const economy = validateEconomyCheckpoint(value.economy, new Set(world.allAgents().map((agent) => agent.id)));
  return {
    schemaVersion: 1,
    lastMinute: value.lastMinute as number,
    manualDecisionIndices,
    economy,
  };
}

function experimentPairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}
