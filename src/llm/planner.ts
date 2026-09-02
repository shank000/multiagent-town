// 规划：模型只选择当前世界提供的选项 id，面向居民的计划文字由代码确定性渲染。

import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { LLMGateway } from './gateway';
import { DAILY_PLAN_TEMPLATE, dailyPlanMessages } from './prompts';
import type { ChatMessage, LLMRequest } from './types';
import type { AgendaItem, MemoryStore } from '../store/memory';
import { initialMindStateOf } from '../engine/agent-profile';
import { planningContextFromWorld } from './plan-grounding';
import {
  assessDailyOptionSelection, auditRenderedDailyPlan, auditRenderedHourAgenda,
  buildPlanningOptions, dailyPlanningOptionPool, fallbackDailyOptions, fallbackHourChoices,
  renderDailyPlan, renderHourAgenda,
  type HourOptionChoice, type PlanningContractIssue, type PlanningOption,
} from './planning-options';

interface ScheduledPlan {
  agent: Agent;
  daily: { day: number; now: number; revision: number } | null;
  hour: { day: number; hour: number; now: number; revision: number } | null;
  dailyRevision: number;
  hourRevision: number;
  task: Promise<void> | null;
}

function hhToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export interface GroundedContinuityOption {
  targetId: string;
  verb: string;
  interaction: boolean;
}

export class Planner {
  private scheduled = new Map<string, ScheduledPlan>();
  private active = new Set<Promise<void>>();
  private world: WorldState | null = null;

  constructor(private llm: LLMGateway, private store: MemoryStore, private scopeId = 'default') {}

  /** MindEngine 每次 tick 绑定正在运行的世界；实体与可选行动在每次生成和提交前重新建立。 */
  bindWorld(world: WorldState): void { this.world = world; }

  async dailyPlan(agent: Agent, day: number, now: number): Promise<void> {
    this.commitDailyPlan(agent, day, now, await this.generateDailyPlan(agent, day, now));
  }

  async decomposeHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    this.commitHourPlan(agent, day, hour, now, this.deriveHourPlan(agent, day, hour));
  }

  scheduleHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const state = this.stateFor(agent);
    const revision = ++state.hourRevision;
    state.hour = { day, hour, now, revision };
    return this.ensureRunner(state);
  }

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
    return items.map((item) => {
      const place = this.world?.getObject(item.location)?.name ?? item.location;
      return `${item.time} ${item.action}（${place}）`;
    }).join('；');
  }

  /** Returns only an option that can still be recovered from the current closed-world catalog. */
  groundedContinuityOption(agent: Agent, day: number, minuteOfDay: number): GroundedContinuityOption | null {
    const world = this.currentWorld();
    const catalog = buildPlanningOptions(agent, world);
    const hour = Math.floor(minuteOfDay / 60);
    const plan = this.store.planFor(agent.id, day);
    const dailyAudit = plan ? auditRenderedDailyPlan(plan.broadPlan, catalog, world) : null;
    const dailyOptions = dailyAudit?.ok ? dailyAudit.value : [];
    const activeRoutine = catalog.find((option) => (
      option.kind === 'routine'
      && option.fromMinute !== null && option.toMinute !== null
      && option.fromMinute <= minuteOfDay && minuteOfDay < option.toMinute
    ));
    const hourlyItems = plan?.hourly.filter((item) => Math.floor(hhToMin(item.time) / 60) === hour) ?? [];
    const hourlyAudit = hourlyItems.length ? auditRenderedHourAgenda(hourlyItems, hour, catalog) : null;
    const allowedIds = new Set([...dailyOptions, ...(activeRoutine ? [activeRoutine] : [])].map((option) => option.id));
    const hourlyOption = hourlyAudit?.ok
      ? hourlyAudit.value.find((option) => allowedIds.has(option.id))
      : undefined;
    const fallbackChoice = fallbackHourChoices(catalog, agent.id, hour)[0];
    const fallbackOption = fallbackChoice ? catalog.find((option) => option.id === fallbackChoice.optionId) : undefined;
    const option = hourlyOption ?? activeRoutine ?? dailyOptions[0] ?? fallbackOption;
    if (!option) return null;
    const routineSlot = option.kind === 'routine'
      ? agent.persona.routine.find((slot) => (
        slot.target === option.locationId && slot.verb === option.verb
        && slot.from === option.fromMinute && slot.to === option.toMinute
      ))
      : undefined;
    return {
      targetId: option.locationId,
      verb: option.verb,
      interaction: option.kind === 'place_action' || routineSlot?.type === 'interact',
    };
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
          const result = this.deriveHourPlan(state.agent, hour.day, hour.hour);
          if (state.hourRevision === hour.revision) this.commitHourPlan(state.agent, hour.day, hour.hour, hour.now, result);
        } catch (error) {
          console.warn(`[planner] ${state.agent.id} ${hour.hour}:00 议程未能形成：${errorMessage(error)}`);
        }
      }
    }
  }

  private async generateDailyPlan(agent: Agent, day: number, now: number): Promise<string[]> {
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((memory) => ({
      content: memory.content, importance: memory.importance,
    }));
    const adaptive = {
      guidance: this.store.recentGuidance(agent.id, 4),
      mindState: this.store.latestMindState(agent.id) ?? initialMindStateOf(agent.persona),
      priorDiary: this.store.dailyReflectionFor(agent.id, day - 1)?.diary ?? '',
    };
    const insights = this.store.recentInsights(agent.id, 5);
    let issues: PlanningContractIssue[] = [{ code: 'invalid_structure', message: '尚未选择日计划选项' }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const world = this.currentWorld();
      const context = planningContextFromWorld(world);
      const pool = dailyPlanningOptionPool(buildPlanningOptions(agent, world), agent);
      let messages = dailyPlanMessages(agent, day, memories, insights, adaptive, context, pool);
      if (attempt === 1) messages = appendRepair(messages, optionRepairInstruction(issues, pool, 'daily'));
      try {
        const response = await this.llm.complete(this.dailyRequest(agent, messages, pool, attempt));
        const assessment = assessDailyOptionSelection(response.parsed, pool, agent.id);
        if (assessment.ok) return assessment.value.map((option) => option.id);
        issues = assessment.issues;
      } catch {
        issues = [{ code: 'invalid_structure', message: '模型暂未形成可用的日计划选择' }];
      }
    }
    const catalog = buildPlanningOptions(agent, this.currentWorld());
    return fallbackDailyOptions(catalog, agent.id).map((option) => option.id);
  }

  private deriveHourPlan(agent: Agent, day: number, hour: number): HourOptionChoice[] {
    const world = this.currentWorld();
    const catalog = buildPlanningOptions(agent, world);
    const plan = this.store.planFor(agent.id, day);
    const auditedDaily = plan ? auditRenderedDailyPlan(plan.broadPlan, catalog, world) : null;
    const selectedDaily = auditedDaily?.ok ? auditedDaily.value : fallbackDailyOptions(catalog, agent.id);
    const hourStart = hour * 60;
    const hourEnd = hourStart + 60;
    const activeRoutine = catalog.find((option) => (
      option.actorId === agent.id
      && option.kind === 'routine'
      && option.fromMinute !== null && option.toMinute !== null
      && option.fromMinute < hourEnd && option.toMinute > hourStart
    ));
    const selected = activeRoutine ?? selectedDaily.find((option) => option.actorId === agent.id);
    return selected
      ? [{ time: `${String(hour).padStart(2, '0')}:00`, optionId: selected.id }]
      : fallbackHourChoices(catalog, agent.id, hour);
  }

  private dailyRequest(
    agent: Agent,
    messages: ChatMessage[],
    options: readonly PlanningOption[],
    attempt: number,
  ): LLMRequest {
    return {
      tier: 'small', template: DAILY_PLAN_TEMPLATE, jsonMode: true,
      jsonSchema: dailyOptionSchema(options.map((option) => option.id)),
      maxTokens: 192, temperature: attempt === 0 ? 0.4 : 0.1, agentId: agent.id, reasoning: false,
      priority: 'planning', scopeId: this.scopeId, timeoutMs: 120_000, messages,
    };
  }

  private commitDailyPlan(agent: Agent, day: number, now: number, optionIds: string[]): void {
    const world = this.currentWorld();
    const catalog = buildPlanningOptions(agent, world);
    const assessed = assessDailyOptionSelection({ option_ids: optionIds }, catalog, agent.id);
    const selected = assessed.ok ? assessed.value : fallbackDailyOptions(catalog, agent.id);
    if (selected.length < 3) throw new Error('当前世界不足以形成三个日计划选项');
    const broad = renderDailyPlan(selected, world);
    const provenance = auditRenderedDailyPlan(broad, catalog, world);
    if (!provenance.ok) throw new Error(provenance.issues.map((issue) => issue.message).join('；'));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${broad}`, importance: 8, createdGameTime: now });
  }

  private commitHourPlan(agent: Agent, day: number, hour: number, now: number, choices: HourOptionChoice[]): void {
    const world = this.currentWorld();
    const catalog = buildPlanningOptions(agent, world);
    let agenda: AgendaItem[];
    try {
      agenda = renderHourAgenda(choices, catalog);
    } catch {
      agenda = renderHourAgenda(fallbackHourChoices(catalog, agent.id, hour), catalog);
    }
    const agendaAudit = auditRenderedHourAgenda(agenda, hour, catalog);
    if (!agendaAudit.ok) throw new Error(agendaAudit.issues.map((issue) => issue.message).join('；'));

    const plan = this.store.planFor(agent.id, day);
    const broadAudit = plan ? auditRenderedDailyPlan(plan.broadPlan, catalog, world) : null;
    const broadOptions = broadAudit?.ok ? broadAudit.value : fallbackDailyOptions(catalog, agent.id);
    const broad = renderDailyPlan(broadOptions, world);
    const merged = validatedExistingAgenda(plan?.hourly ?? [], catalog)
      .filter((item) => Math.floor(hhToMin(item.time) / 60) !== hour);
    merged.push(...agenda);
    merged.sort((left, right) => hhToMin(left.time) - hhToMin(right.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: merged, status: 'active', createdGameTime: now });
  }

  private currentWorld(): WorldState {
    if (!this.world) throw new Error('规划器尚未绑定当前世界');
    return this.world;
  }
}

function dailyOptionSchema(optionIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['option_ids'],
    properties: {
      option_ids: { type: 'array', minItems: 3, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: optionIds } },
    },
  };
}

function optionRepairInstruction(
  issues: readonly PlanningContractIssue[],
  options: readonly PlanningOption[],
  kind: 'daily',
): string {
  const errors = issues.map((issue) => issue.message).join('；') || '选择没有通过当前世界边界检查';
  const ids = options.map((option) => option.id).join('、');
  return `上一版选择有误：${errors}。请仅从这些 id 中选择 3 至 5 个不同选项：${ids}。不要增加说明文字。`;
}

function appendRepair(messages: ChatMessage[], instruction: string): ChatMessage[] {
  return [...messages, { role: 'user', content: instruction }];
}

function validatedExistingAgenda(items: AgendaItem[], options: readonly PlanningOption[]): AgendaItem[] {
  const groups = new Map<number, AgendaItem[]>();
  for (const item of items) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time)) continue;
    const hour = Number(item.time.slice(0, 2));
    const group = groups.get(hour) ?? [];
    group.push(item);
    groups.set(hour, group);
  }
  return [...groups.entries()].flatMap(([hour, group]) => {
    const audit = auditRenderedHourAgenda(group, hour, options);
    return audit.ok ? group : [];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
