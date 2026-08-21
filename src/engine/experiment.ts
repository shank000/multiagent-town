// 伙伴选择预实验：每晚 19:30 全员各选一名伙伴一对一交流（关系记忆开/关两组对照）
// 研究假设：可访问伙伴历史互动记忆时，选择变为历史依赖 → 随时间形成持久的互动结构

import { randomUUID } from 'node:crypto';
import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MindEngine } from './mind';

export interface PartnerExperimentConfig {
  /** on = 按关系记忆（亲密度 + 最近互动时间）打分选伙伴；off = 均匀随机选 */
  historyAccess: 'on' | 'off';
}

const CHOICE_MINUTE = 1170; // 19:30

export class PartnerChoiceExperiment {
  private lastMinute = 0;

  constructor(
    private log: EventLog,
    private world: WorldState,
    private mind: MindEngine,
    private cfg: PartnerExperimentConfig
  ) {}

  /** 由主循环每 tick 调用；跨过 19:30 触发当日一轮选择 */
  tick(now: number): void {
    const minute = now % 1440;
    if (this.lastMinute < CHOICE_MINUTE && minute >= CHOICE_MINUTE) this.round(now);
    this.lastMinute = minute;
  }

  /** 当日一轮：每位参与者独立选择一位伙伴并开始一对一对话 */
  round(now: number): void {
    for (const agent of this.world.allAgents()) {
      const partner = this.pickPartner(agent);
      if (!partner) continue;
      this.log.addEvent({
        id: randomUUID(),
        type: 'chat',
        actorId: agent.id,
        targetIds: [partner.id],
        description: `「${agent.name}」选择了「${partner.name}」一对一交流`,
        location: agent.locationId,
        gameTime: now,
        payload: { kind: 'experiment_pair_choice', fromId: agent.id, toId: partner.id },
      });
      if (!this.mind.dialogue.isActive(agent.id, partner.id)) this.mind.dialogue.start(agent, partner, now);
    }
  }

  /** 伙伴选择：on = 亲密度×权重 + 最近互动时间加成 + 微量扰动（避免永远同一人）；off = 均匀随机 */
  pickPartner(agent: Agent): Agent | null {
    const others = this.world.allAgents().filter((a) => a.id !== agent.id);
    if (!others.length) return null;
    if (this.cfg.historyAccess === 'off') {
      return others[Math.floor(Math.random() * others.length)];
    }
    const rels = this.mind.rels.allFor(agent.id);
    const score = (a: Agent): number => {
      const rel = rels.find((r) => r.agentB === a.id);
      const affection = rel ? rel.affection : 0;
      const lastInteraction = rel ? rel.updatedGameTime : 0;
      const recency = Math.max(0, 1 - lastInteraction / 2400); // 近 40 游戏小时内的互动视为新鲜
      return affection + recency * 0.5 + Math.random() * 0.3;
    };
    let best = others[0];
    for (const a of others.slice(1)) {
      if (score(a) > score(best)) best = a;
    }
    return best;
  }
}
