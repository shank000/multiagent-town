// 伙伴选择预实验：每晚 19:30 全员各选一名伙伴一对一交流（关系记忆开/关两组对照）
// 研究假设：可访问伙伴历史互动记忆时，选择变为历史依赖 → 随时间形成持久的互动结构

import { createHash, randomUUID } from 'node:crypto';
import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MindEngine } from './mind';
import { Economy, ITEMS } from './economy';

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
  return Math.max(0, 1 - (now - lastInteraction) / window);
}

const CHOICE_MINUTE = 1170; // 19:30

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

  /** 由主循环每 tick 调用；跨过 19:30 触发当日一轮选择 */
  tick(now: number): void {
    const minute = now % 1440;
    if (this.lastMinute < CHOICE_MINUTE && minute >= CHOICE_MINUTE) this.round(now);
    this.lastMinute = minute;
  }

  /** 当日一轮：先冻结全员候选状态并独立选择，再执行馈礼与一对一对话。 */
  round(now: number): void {
    const decisions = this.world.allAgents().map((agent) => ({
      agent,
      snapshot: this.pickSnapshot(agent),
      partner: this.pickPartner(agent, now, `round:${now}:agent:${agent.id}`),
    }));

    for (const { agent, partner, snapshot } of decisions) {
      if (partner === null) continue;
      if (this.cfg.giftExchange === 'on') this.gift(agent, partner, now);
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
        },
      });
      if (!this.mind.dialogue.isActive(agent.id, partner.id)) this.mind.dialogue.start(agent, partner, now);
    }
  }

  /** 馈礼：每日工资入账 → 买鲜花 → 赠予伙伴（关系升温），事件与亲密度同步 */
  private gift(gifter: Agent, receiver: Agent, now: number): void {
    this.economy.earnDaily(gifter.id);
    if (!this.economy.buy(gifter.id, 'flower')) return;
    const delta = this.economy.give(gifter.id, receiver.id, 'flower');
    if (delta === null) return;
    this.mind.rels.update(gifter.id, receiver.id, { affectionDelta: delta }, now);
    this.mind.rels.update(receiver.id, gifter.id, { affectionDelta: delta * 0.5 }, now);
    this.log.addEvent({
      id: randomUUID(),
      type: 'system',
      actorId: gifter.id,
      targetIds: [receiver.id],
      description: `「${gifter.name}」把一束${ITEMS.flower.name}送给了「${receiver.name}」`,
      location: gifter.locationId,
      gameTime: now,
      payload: { kind: 'gift', fromId: gifter.id, toId: receiver.id, item: 'flower' },
    });
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
