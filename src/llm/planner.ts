// 规划：每日大计划 + 每小时议程分解 + 当前时段议程（spec §5.4；M0 作息为兜底）

import type { Agent } from '../core/types';
import type { LLMGateway } from './gateway';
import { DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE, dailyPlanMessages, hourPlanMessages } from './prompts';
import type { AgendaItem, MemoryStore } from '../store/memory';
import { initialMindStateOf } from '../engine/agent-profile';

interface ScheduledPlan {
  agent: Agent;
  daily: { day: number; now: number; revision: number } | null;
  hour: { day: number; hour: number; now: number; revision: number } | null;
  dailyRevision: number;
  hourRevision: number;
  task: Promise<void> | null;
}

const DAILY_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['broad_plan'],
  properties: {
    broad_plan: { type: 'string', maxLength: 300 },
  },
} as const;

const HOUR_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agenda'],
  properties: {
    agenda: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['time', 'action', 'location'],
        properties: {
          time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          action: { type: 'string', maxLength: 50 },
          location: { type: 'string', maxLength: 30 },
        },
      },
    },
  },
} as const;

function hhToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export class Planner {
  private scheduled = new Map<string, ScheduledPlan>();
  private active = new Set<Promise<void>>();

  constructor(private llm: LLMGateway, private store: MemoryStore, private scopeId = 'default') {}

  async dailyPlan(agent: Agent, day: number, now: number): Promise<void> {
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((m) => ({ content: m.content, importance: m.importance }));
    const insights = this.store.recentInsights(agent.id, 5);
    const guidance = this.store.recentGuidance(agent.id, 4);
    const mindState = this.store.latestMindState(agent.id) ?? initialMindStateOf(agent.persona);
    const priorDiary = this.store.dailyReflectionFor(agent.id, day - 1)?.diary ?? '';
    const res = await this.llm.complete({
      tier: 'small',
      template: DAILY_PLAN_TEMPLATE,
      jsonMode: true,
      jsonSchema: DAILY_PLAN_JSON_SCHEMA,
      maxTokens: 256,
      temperature: 0.45,
      agentId: agent.id,
      reasoning: false,
      priority: 'planning',
      scopeId: this.scopeId,
      timeoutMs: 120_000,
      messages: dailyPlanMessages(agent, day, memories, insights, { guidance, mindState, priorDiary }),
    });
    const raw = (res.parsed as { broad_plan?: unknown } | null)?.broad_plan;
    const broad = (typeof raw === 'string' ? raw : '').slice(0, 300) || '自由安排一天。';
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${broad}`, importance: 8, createdGameTime: now });
  }

  async decomposeHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const plan = this.store.planFor(agent.id, day);
    const broad = plan?.broadPlan ?? '';
    const res = await this.llm.complete({
      tier: 'small', template: HOUR_PLAN_TEMPLATE, jsonMode: true, jsonSchema: HOUR_PLAN_JSON_SCHEMA,
      maxTokens: 384, temperature: 0.35,
      messages: hourPlanMessages(agent, hour, broad), agentId: agent.id, reasoning: false,
      priority: 'planning', scopeId: this.scopeId, timeoutMs: 120_000,
    });
    const rawAgenda = (res.parsed as { agenda?: unknown } | null)?.agenda;
    const agenda = (Array.isArray(rawAgenda) ? rawAgenda : [])
      .filter((h): h is { time: string; action: string; location?: unknown } =>
        !!h && typeof (h as { time?: unknown }).time === 'string' && typeof (h as { action?: unknown }).action === 'string')
      .map((h) => ({ time: h.time, action: h.action.slice(0, 60), location: String(h.location ?? '').slice(0, 40) }));
    const merged = (plan?.hourly ?? []).filter((h) => Math.floor(hhToMin(h.time) / 60) !== hour);
    merged.push(...agenda);
    merged.sort((a, b) => hhToMin(a.time) - hhToMin(b.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad || '自由安排一天。', hourly: merged, status: 'active', createdGameTime: now });
  }

  /** 只保留每位居民最新的小时规划；模型返回时若已过时则不覆盖当前计划。 */
  scheduleHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const state = this.stateFor(agent);
    const revision = ++state.hourRevision;
    state.hour = { day, hour, now, revision };
    return this.ensureRunner(state);
  }

  /** 5:00 调度：最新日计划完成后再分解最新小时，保持同一居民串行。 */
  scheduleDailyAndHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const state = this.stateFor(agent);
    const dailyRevision = ++state.dailyRevision;
    const hourRevision = ++state.hourRevision;
    state.daily = { day, now, revision: dailyRevision };
    state.hour = { day, hour, now, revision: hourRevision };
    return this.ensureRunner(state);
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  currentAgendaLine(agent: Agent, day: number, minuteOfDay: number): string | null {
    const plan = this.store.planFor(agent.id, day);
    if (!plan) return null;
    const hour = Math.floor(minuteOfDay / 60);
    const items = plan.hourly.filter((h) => Math.floor(hhToMin(h.time) / 60) === hour);
    if (!items.length) return plan.broadPlan;
    return items.map((h) => `${h.time} ${h.action}（${h.location}）`).join('；');
  }

  private stateFor(agent: Agent): ScheduledPlan {
    const existing = this.scheduled.get(agent.id);
    if (existing) {
      existing.agent = agent;
      return existing;
    }
    const state: ScheduledPlan = { agent, daily: null, hour: null, dailyRevision: 0, hourRevision: 0, task: null };
    this.scheduled.set(agent.id, state);
    return state;
  }

  private ensureRunner(state: ScheduledPlan): Promise<void> {
    if (state.task) return state.task;
    let task: Promise<void>;
    task = this.runScheduled(state).finally(() => {
      this.active.delete(task);
      state.task = null;
      if (state.daily || state.hour) void this.ensureRunner(state);
      else this.scheduled.delete(state.agent.id);
    });
    state.task = task;
    this.active.add(task);
    return task;
  }

  private async runScheduled(state: ScheduledPlan): Promise<void> {
    while (state.daily || state.hour) {
      const daily = state.daily;
      state.daily = null;
      if (daily) {
        try {
          const result = await this.generateDailyPlan(state.agent, daily.day, daily.now);
          if (state.dailyRevision === daily.revision) this.commitDailyPlan(state.agent, daily.day, daily.now, result);
        } catch (error) {
          console.warn(`[planner] ${state.agent.id} 第${daily.day}天计划暂用现有安排：${errorMessage(error)}`);
        }
      }

      const hour = state.hour;
      state.hour = null;
      if (hour) {
        try {
          const result = await this.generateHourPlan(state.agent, hour.day, hour.hour, hour.now);
          if (state.hourRevision === hour.revision) this.commitHourPlan(state.agent, hour.day, hour.hour, hour.now, result);
        } catch (error) {
          console.warn(`[planner] ${state.agent.id} ${hour.hour}:00 议程沿用现有安排：${errorMessage(error)}`);
        }
      }
    }
  }

  private async generateDailyPlan(agent: Agent, day: number, now: number): Promise<string> {
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((m) => ({ content: m.content, importance: m.importance }));
    const insights = this.store.recentInsights(agent.id, 5);
    const guidance = this.store.recentGuidance(agent.id, 4);
    const mindState = this.store.latestMindState(agent.id) ?? initialMindStateOf(agent.persona);
    const priorDiary = this.store.dailyReflectionFor(agent.id, day - 1)?.diary ?? '';
    const res = await this.llm.complete({
      tier: 'small', template: DAILY_PLAN_TEMPLATE, jsonMode: true, jsonSchema: DAILY_PLAN_JSON_SCHEMA,
      maxTokens: 256,
      temperature: 0.45, agentId: agent.id, reasoning: false, priority: 'planning',
      scopeId: this.scopeId, timeoutMs: 120_000,
      messages: dailyPlanMessages(agent, day, memories, insights, { guidance, mindState, priorDiary }),
    });
    const raw = (res.parsed as { broad_plan?: unknown } | null)?.broad_plan;
    return (typeof raw === 'string' ? raw : '').slice(0, 300) || '自由安排一天。';
  }

  private commitDailyPlan(agent: Agent, day: number, now: number, broad: string): void {
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${broad}`, importance: 8, createdGameTime: now });
  }

  private async generateHourPlan(agent: Agent, day: number, hour: number, now: number): Promise<AgendaItem[]> {
    const plan = this.store.planFor(agent.id, day);
    const broad = plan?.broadPlan ?? '';
    const res = await this.llm.complete({
      tier: 'small', template: HOUR_PLAN_TEMPLATE, jsonMode: true, jsonSchema: HOUR_PLAN_JSON_SCHEMA,
      maxTokens: 384,
      temperature: 0.35, messages: hourPlanMessages(agent, hour, broad), agentId: agent.id,
      reasoning: false, priority: 'planning', scopeId: this.scopeId, timeoutMs: 120_000,
    });
    const rawAgenda = (res.parsed as { agenda?: unknown } | null)?.agenda;
    return (Array.isArray(rawAgenda) ? rawAgenda : [])
      .filter((item): item is { time: string; action: string; location?: unknown } =>
        !!item && typeof (item as { time?: unknown }).time === 'string'
          && typeof (item as { action?: unknown }).action === 'string')
      .map((item) => ({ time: item.time, action: item.action.slice(0, 60), location: String(item.location ?? '').slice(0, 40) }));
  }

  private commitHourPlan(agent: Agent, day: number, hour: number, now: number, agenda: AgendaItem[]): void {
    const plan = this.store.planFor(agent.id, day);
    const broad = plan?.broadPlan ?? '自由安排一天。';
    const merged = (plan?.hourly ?? []).filter((item) => Math.floor(hhToMin(item.time) / 60) !== hour);
    merged.push(...agenda);
    merged.sort((a, b) => hhToMin(a.time) - hhToMin(b.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: merged, status: 'active', createdGameTime: now });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
