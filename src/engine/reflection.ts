// 反思引擎：importance 累计 >150 触发 → 3 问题 → 检索证据 → 洞察 → 反思树 + 写回记忆流
// （spec §5.6；每天每 agent 最多 2 次控成本）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import {
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE,
  reflectionQuestionsMessages, reflectionInsightsMessages,
} from '../llm/prompts';

export class ReflectionEngine {
  private inFlight = new Set<string>();
  private dayCount = new Map<string, { day: number; count: number }>();

  constructor(private llm: LLMGateway, private store: MemoryStore, private log: EventLog) {}

  tick(agent: Agent, day: number, now: number): void {
    const dc = this.dayCount.get(agent.id);
    const count = dc && dc.day === day ? dc.count : 0;
    if (count >= 2) return;
    if (this.inFlight.has(agent.id)) return;
    if (this.store.accumulator(agent.id) > 150) {
      this.store.resetAccumulator(agent.id);
      this.inFlight.add(agent.id);
      this.dayCount.set(agent.id, { day, count: count + 1 });
      void this.run(agent, day, now).catch((err) => console.error('[reflection]', err));
    }
  }

  private async run(agent: Agent, day: number, now: number): Promise<void> {
    try {
      const recent = this.store.recentMemories(agent.id, 100).map((m) => m.content);
      const q = await this.ask(REFLECTION_QUESTIONS_TEMPLATE, { memories: recent });
      const questions = (q.questions ?? []).slice(0, 3);
      const evidenceIds: string[] = [];
      const insights: string[] = [];
      for (const question of questions) {
        const ev = this.store.retrieve(agent.id, question, now, 5);
        evidenceIds.push(...ev.map((m) => m.id));
        const r = await this.ask(REFLECTION_INSIGHTS_TEMPLATE, { question, evidence: ev.map((m) => m.content) });
        insights.push(...(r.insights ?? []).slice(0, 5));
      }
      const final = insights.slice(0, 5);
      const parent = this.store.reflectionsFor(agent.id)[0] ?? null;
      this.store.addReflection({
        agentId: agent.id, parentId: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0,
        questions, insights: final, evidenceIds, triggerScore: 150, createdGameTime: now,
      });
      for (const ins of final) {
        this.store.addMemory({ agentId: agent.id, kind: 'insight', content: ins, importance: 8, createdGameTime: now });
      }
      this.log.addEvent(reflectionEvent(agent, final[0] ?? '', day, now));
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  private async ask(template: string, ctx: unknown): Promise<{ questions?: string[]; insights?: string[] }> {
    const messages = template === REFLECTION_QUESTIONS_TEMPLATE
      ? reflectionQuestionsMessages((ctx as { memories: string[] }).memories)
      : reflectionInsightsMessages((ctx as { question: string }).question, (ctx as { evidence: string[] }).evidence);
    const res = await this.llm.complete({ tier: 'large', template, jsonMode: true, maxTokens: 512, messages });
    return (res.parsed ?? {}) as { questions?: string[]; insights?: string[] };
  }
}

function reflectionEvent(agent: Agent, insight: string, day: number, now: number): GameEvent {
  return {
    id: randomUUID(), type: 'system', actorId: agent.id, targetIds: [],
    description: `「${agent.name}」反思：${insight}`, location: null, gameTime: now,
    payload: { kind: 'reflection', day },
  };
}
