// 规划：每日大计划 + 每小时议程分解 + 当前时段议程（spec §5.4；M0 作息为兜底）

import type { Agent } from '../core/types';
import type { LLMGateway } from './gateway';
import { DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE, dailyPlanMessages, hourPlanMessages } from './prompts';
import type { AgendaItem, MemoryStore } from '../store/memory';

function hhToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export class Planner {
  constructor(private llm: LLMGateway, private store: MemoryStore) {}

  async dailyPlan(agent: Agent, day: number, now: number): Promise<void> {
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((m) => ({ content: m.content, importance: m.importance }));
    const insights = this.store.recentInsights(agent.id, 5);
    const res = await this.llm.complete({ tier: 'large', template: DAILY_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: dailyPlanMessages(agent, day, memories, insights) });
    const broad = (((res.parsed as { broad_plan?: string } | null)?.broad_plan) ?? '').slice(0, 300) || '自由安排一天。';
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${broad}`, importance: 8, createdGameTime: now });
  }

  async decomposeHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const plan = this.store.planFor(agent.id, day);
    const broad = plan?.broadPlan ?? '';
    const res = await this.llm.complete({ tier: 'large', template: HOUR_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: hourPlanMessages(agent, hour, broad) });
    const agenda = ((res.parsed as { agenda?: AgendaItem[] } | null)?.agenda ?? []).map((h) => ({ time: h.time, action: String(h.action).slice(0, 60), location: String(h.location).slice(0, 40) }));
    const merged = (plan?.hourly ?? []).filter((h) => Math.floor(hhToMin(h.time) / 60) !== hour);
    merged.push(...agenda);
    merged.sort((a, b) => hhToMin(a.time) - hhToMin(b.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad || '自由安排一天。', hourly: merged, status: 'active', createdGameTime: now });
  }

  currentAgendaLine(agent: Agent, day: number, minuteOfDay: number): string | null {
    const plan = this.store.planFor(agent.id, day);
    if (!plan) return null;
    const hour = Math.floor(minuteOfDay / 60);
    const items = plan.hourly.filter((h) => Math.floor(hhToMin(h.time) / 60) === hour);
    if (!items.length) return plan.broadPlan;
    return items.map((h) => `${h.time} ${h.action}（${h.location}）`).join('；');
  }
}
