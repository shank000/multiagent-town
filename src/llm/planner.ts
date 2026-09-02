// 规划：每日大计划 + 每小时议程分解；所有模型结果先通过当前世界边界检查再进入记忆。

import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { LLMGateway } from './gateway';
import { DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE, dailyPlanMessages, hourPlanMessages } from './prompts';
import type { ChatMessage, LLMRequest } from './types';
import type { AgendaItem, MemoryStore } from '../store/memory';
import { initialMindStateOf } from '../engine/agent-profile';
import {
  assessDailyPlan, assessHourAgenda, groundedDailyFallback, groundedHourFallback,
  planningContextFromWorld, planningRepairInstruction,
  type GroundingIssue, type PlanningWorldContext,
} from './plan-grounding';

interface ScheduledPlan {
  agent: Agent;
  daily: { day: number; now: number; revision: number } | null;
  hour: { day: number; hour: number; now: number; revision: number } | null;
  dailyRevision: number;
  hourRevision: number;
  task: Promise<void> | null;
}

const DAILY_PLAN_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['broad_plan'],
  properties: { broad_plan: { type: 'string', maxLength: 300 } },
} as const;

const HOUR_PLAN_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['agenda'],
  properties: {
    agenda: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['time', 'action', 'location'],
        properties: {
          time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          action: { type: 'string', maxLength: 50 },
          location: { type: 'string', maxLength: 40 },
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
  private world: WorldState | null = null;

  constructor(private llm: LLMGateway, private store: MemoryStore, private scopeId = 'default') {}

  /** MindEngine 每次 tick 绑定正在运行的世界；实体列表在每次生成和提交前重新读取。 */
  bindWorld(world: WorldState): void { this.world = world; }

  async dailyPlan(agent: Agent, day: number, now: number): Promise<void> {
    this.commitDailyPlan(agent, day, now, await this.generateDailyPlan(agent, day, now));
  }

  async decomposeHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    this.commitHourPlan(agent, day, hour, now, await this.generateHourPlan(agent, day, hour));
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
    const items = plan.hourly.filter((item) => Math.floor(hhToMin(item.time) / 60) === hour);
    if (!items.length) return plan.broadPlan;
    const context = this.world ? this.currentContext() : null;
    return items.map((item) => {
      const place = context?.places.find((candidate) => candidate.id === item.location)?.name ?? item.location;
      return `${item.time} ${item.action}（${place}）`;
    }).join('；');
  }

  private stateFor(agent: Agent): ScheduledPlan {
    const existing = this.scheduled.get(agent.id);
    if (existing) { existing.agent = agent; return existing; }
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
          console.warn(`[planner] ${state.agent.id} 第${daily.day}天计划未能形成：${errorMessage(error)}`);
        }
      }
      const hour = state.hour;
      state.hour = null;
      if (hour) {
        try {
          const result = await this.generateHourPlan(state.agent, hour.day, hour.hour);
          if (state.hourRevision === hour.revision) this.commitHourPlan(state.agent, hour.day, hour.hour, hour.now, result);
        } catch (error) {
          console.warn(`[planner] ${state.agent.id} ${hour.hour}:00 议程未能形成：${errorMessage(error)}`);
        }
      }
    }
  }

  private async generateDailyPlan(agent: Agent, day: number, now: number): Promise<string> {
    let context = this.currentContext();
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((memory) => ({
      content: memory.content, importance: memory.importance,
    }));
    const adaptive = {
      guidance: this.store.recentGuidance(agent.id, 4),
      mindState: this.store.latestMindState(agent.id) ?? initialMindStateOf(agent.persona),
      priorDiary: this.store.dailyReflectionFor(agent.id, day - 1)?.diary ?? '',
    };
    const insights = this.store.recentInsights(agent.id, 5);
    let messages = dailyPlanMessages(agent, day, memories, insights, adaptive, context);
    let issues: GroundingIssue[] = [{ code: 'empty_narrative', message: '尚未生成计划' }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) {
        context = this.currentContext();
        messages = appendRepair(messages, planningRepairInstruction(issues, context, 'daily'));
      }
      try {
        const res = await this.llm.complete(this.dailyRequest(agent, messages, attempt));
        context = this.currentContext();
        const raw = (res.parsed as { broad_plan?: unknown } | null)?.broad_plan;
        const assessment = assessDailyPlan(raw, context);
        if (assessment.ok) return assessment.value;
        issues = assessment.issues;
      } catch {
        issues = [{ code: 'invalid_agenda', message: '模型暂未形成可用的日计划' }];
      }
    }
    const fallbackContext = this.currentContext();
    const assessed = assessDailyPlan(groundedDailyFallback(agent, fallbackContext), fallbackContext);
    if (!assessed.ok) throw new Error(assessed.issues.map((issue) => issue.message).join('；'));
    return assessed.value;
  }

  private async generateHourPlan(agent: Agent, day: number, hour: number): Promise<AgendaItem[]> {
    let context = this.currentContext();
    const broad = this.store.planFor(agent.id, day)?.broadPlan ?? '';
    let messages = hourPlanMessages(agent, hour, broad, context);
    let issues: GroundingIssue[] = [{ code: 'invalid_agenda', message: '尚未生成小时安排' }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) {
        context = this.currentContext();
        messages = appendRepair(messages, planningRepairInstruction(issues, context, 'hour', hour));
      }
      try {
        const res = await this.llm.complete(this.hourRequest(agent, messages, attempt));
        context = this.currentContext();
        const raw = (res.parsed as { agenda?: unknown } | null)?.agenda;
        const assessment = assessHourAgenda(raw, hour, context);
        if (assessment.ok) return assessment.value;
        issues = assessment.issues;
      } catch {
        issues = [{ code: 'invalid_agenda', message: '模型暂未形成可用的小时安排' }];
      }
    }
    const fallbackContext = this.currentContext();
    const assessed = assessHourAgenda(groundedHourFallback(agent, hour, fallbackContext), hour, fallbackContext);
    if (!assessed.ok) throw new Error(assessed.issues.map((issue) => issue.message).join('；'));
    return assessed.value;
  }

  private dailyRequest(agent: Agent, messages: ChatMessage[], attempt: number): LLMRequest {
    return {
      tier: 'small', template: DAILY_PLAN_TEMPLATE, jsonMode: true, jsonSchema: DAILY_PLAN_JSON_SCHEMA,
      maxTokens: 256, temperature: attempt === 0 ? 0.45 : 0.1, agentId: agent.id, reasoning: false,
      priority: 'planning', scopeId: this.scopeId, timeoutMs: 120_000, messages,
    };
  }

  private hourRequest(agent: Agent, messages: ChatMessage[], attempt: number): LLMRequest {
    return {
      tier: 'small', template: HOUR_PLAN_TEMPLATE, jsonMode: true, jsonSchema: HOUR_PLAN_JSON_SCHEMA,
      maxTokens: 384, temperature: attempt === 0 ? 0.35 : 0.1, agentId: agent.id, reasoning: false,
      priority: 'planning', scopeId: this.scopeId, timeoutMs: 120_000, messages,
    };
  }

  private commitDailyPlan(agent: Agent, day: number, now: number, broad: string): void {
    const assessment = assessDailyPlan(broad, this.currentContext());
    if (!assessment.ok) throw new Error(`日计划提交边界失败：${assessment.issues.map((issue) => issue.message).join('；')}`);
    this.store.savePlan({ agentId: agent.id, day, broadPlan: assessment.value, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${assessment.value}`, importance: 8, createdGameTime: now });
  }

  private commitHourPlan(agent: Agent, day: number, hour: number, now: number, agenda: AgendaItem[]): void {
    const context = this.currentContext();
    const assessment = assessHourAgenda(agenda, hour, context);
    if (!assessment.ok) throw new Error(`小时安排提交边界失败：${assessment.issues.map((issue) => issue.message).join('；')}`);
    const plan = this.store.planFor(agent.id, day);
    const broadAssessment = assessDailyPlan(plan?.broadPlan ?? '', context);
    const broad = broadAssessment.ok ? broadAssessment.value : groundedDailyFallback(agent, context);
    const merged = validatedExistingAgenda(plan?.hourly ?? [], context)
      .filter((item) => Math.floor(hhToMin(item.time) / 60) !== hour);
    merged.push(...assessment.value);
    merged.sort((a, b) => hhToMin(a.time) - hhToMin(b.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: merged, status: 'active', createdGameTime: now });
  }

  private currentContext(): PlanningWorldContext {
    if (!this.world) throw new Error('规划器尚未绑定当前世界');
    return planningContextFromWorld(this.world);
  }
}

function appendRepair(messages: ChatMessage[], instruction: string): ChatMessage[] {
  return [...messages, { role: 'user', content: instruction }];
}

function validatedExistingAgenda(items: AgendaItem[], context: PlanningWorldContext): AgendaItem[] {
  const groups = new Map<number, AgendaItem[]>();
  for (const item of items) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time)) continue;
    const hour = Number(item.time.slice(0, 2));
    const group = groups.get(hour) ?? [];
    group.push(item);
    groups.set(hour, group);
  }
  return [...groups.entries()].flatMap(([hour, group]) => assessHourAgenda(group, hour, context).value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
