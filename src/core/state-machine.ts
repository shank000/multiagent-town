// Agent 状态机 + 动作执行（design §5.1/§5.5 的 M0 子集）
// idle → thinking（异步 LLM）→ moving → acting → idle；LLM 绝不阻塞 tick

import { randomUUID } from 'node:crypto';
import type { Agent, Decision, GameEvent } from './types';
import { MINUTES_PER_DAY } from './time';
import { validateDecision, type ValidationResult } from '../llm/action-validator';
import { buildActionDecisionMessages, ACTION_DECISION_TEMPLATE } from '../llm/prompts';
import type { MemoryBrief } from '../llm/prompts';
import type { ReflectionMindState } from '../store/memory';
import type { LLMGateway, LLMRuntimeMode } from '../llm/gateway';
import type { LLMRequest } from '../llm/types';
import type { WorldState } from './world';
import type { EventLog } from '../store/events';
import type { MindEngine } from '../engine/mind';
import type { PlayerDirector } from '../engine/player';
import { initialMindStateOf } from '../engine/agent-profile';

export const DECISION_INTERVAL_MIN = 10; // 每 10 游戏分钟决策一次（M0 固定值）
export const MOVE_SPEED_TILES_PER_MIN = 1;

const ACTION_DECISION_VALIDATOR = 'action-decision/v3';
const MAX_DECISION_AGE_MIN = 15;

type ActionDecisionQualityStatus = 'valid' | 'normalized' | 'repaired' | 'safe_fallback' | 'stale_rejected';
type ActionDecisionRejectionCode = 'ungrounded_interaction' | 'stale_context';

interface ActionDecisionQuality {
  status: ActionDecisionQualityStatus;
  attempts: number;
  validator: typeof ACTION_DECISION_VALIDATOR;
  model?: string;
  rejectionCodes?: ActionDecisionRejectionCode[];
}

/** 动作类型与目标使用互斥分支，结构化生成阶段即可遵守跨字段约束。 */
export function actionDecisionJsonSchema(objectIds: readonly string[]): Record<string, unknown> {
  const targets = [...new Set(objectIds)];
  const actionBase = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'target', 'verb'],
  } as const;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['thought', 'action', 'duration_minutes'],
    properties: {
      thought: { type: 'string', maxLength: 240 },
      action: {
        oneOf: [
          {
            ...actionBase,
            properties: {
              type: { type: 'string', enum: ['idle'] },
              target: { type: 'null' },
              verb: { type: 'string', maxLength: 80 },
            },
          },
          {
            ...actionBase,
            properties: {
              type: { type: 'string', enum: ['move_to', 'interact'] },
              target: { type: 'string', enum: targets },
              verb: { type: 'string', maxLength: 80 },
            },
          },
        ],
      },
      duration_minutes: { type: 'integer', minimum: 1, maximum: 120 },
    },
  };
}

interface PendingDecision {
  resolved: {
    decision: Decision;
    quality: ActionDecisionQuality;
    reasons: string[];
  } | null;
  error: string | null;
  context: DecisionRequestContext;
}

interface DecisionRequestContext {
  requestedAt: number;
  day: number;
  locationId: string;
  routineSlotKey: string | null;
  playerInstruction: string | null;
  runtimeMode: LLMRuntimeMode;
}

export class AgentExecutor {
  private pending = new Map<string, PendingDecision>();
  /** 过期响应触发重取后冻结虚拟时间，直到新上下文中的响应落定或失败。 */
  private temporalDecisionBarriers = new Set<string>();
  private blockCount = new Map<string, number>();
  private fallbackStreak = new Map<string, number>();
  private activeDecisions = new Set<Promise<void>>();

  constructor(
    private llm: LLMGateway,
    private world: WorldState,
    private log: EventLog,
    private mind?: MindEngine,
    private player?: PlayerDirector,
    private scopeId = 'default',
  ) {}

  /** 每 tick 对每个 agent 调用一次；dt = 本次 tick 推进的游戏分钟数 */
  progress(agent: Agent, dt: number, now: number, realtimeSampling = false): void {
    // 已发出的思考始终先落定，避免会话在异步决策返回后留下无法结算的 thinking 状态。
    if (agent.state === 'thinking') {
      const entry = this.pending.get(agent.id);
      if (!entry) return;
      if (entry.error) {
        this.pending.delete(agent.id);
        this.temporalDecisionBarriers.delete(agent.id);
        agent.state = 'idle';
        agent.lastDecisionAt = now;
        return;
      }
      if (entry.resolved) {
        this.pending.delete(agent.id);
        const staleReasons = this.staleDecisionReasons(agent, entry.context, now);
        if (staleReasons.length > 0) {
          agent.state = 'idle';
          agent.lastDecisionAt = now;
          const rejectionCodes = [...new Set([
            ...(entry.resolved.quality.rejectionCodes ?? []),
            'stale_context' as const,
          ])];
          this.log.addEvent(this.actionQualityEvent(agent, {
            ...entry.resolved.quality,
            status: 'stale_rejected',
            rejectionCodes,
          }, [...entry.resolved.reasons, ...staleReasons], now));
          const scheduledSleep = this.sleepRoutineDecision(agent, now);
          if (scheduledSleep) {
            this.temporalDecisionBarriers.delete(agent.id);
            this.log.addEvent(this.thoughtEvent(agent, scheduledSleep, now));
            this.beginAction(agent, scheduledSleep, now);
          } else {
            // 新请求期间冻结虚拟时间，避免粗粒度 tick 令每次重取都再次过期。
            this.temporalDecisionBarriers.add(agent.id);
            this.requestDecision(agent, now);
          }
          return;
        }
        this.temporalDecisionBarriers.delete(agent.id);
        if (entry.resolved.quality.status !== 'valid') {
          this.log.addEvent(this.actionQualityEvent(
            agent,
            entry.resolved.quality,
            entry.resolved.reasons,
            now,
          ));
        }
        this.log.addEvent(this.thoughtEvent(agent, entry.resolved.decision, now, entry.resolved.quality));
        this.beginAction(agent, entry.resolved.decision, now);
      }
      return;
    }
    // 活动会话（含摘要落库阶段）冻结已排定的移动/动作，也不发起下一次决策；结束后继续。
    if (this.mind?.dialogue.isParticipantActive(agent.id)) return;
    if (agent.state === 'moving') {
      this.stepMove(agent, dt, now);
      return;
    }
    if (agent.state === 'acting') {
      if (now >= agent.actionEndsAt) this.finishAction(agent, now);
      return;
    }
    const scheduledSleep = this.sleepRoutineDecision(agent, now);
    if (scheduledSleep) {
      agent.lastDecisionAt = now;
      this.log.addEvent(this.thoughtEvent(agent, scheduledSleep, now));
      this.beginAction(agent, scheduledSleep, now);
      return;
    }
    // 高速观察保持固定的墙钟认知节奏，避免虚拟分钟倍速线性放大真实模型请求。
    const decisionInterval = realtimeSampling && dt > 5
      ? Math.max(DECISION_INTERVAL_MIN, dt * 24)
      : DECISION_INTERVAL_MIN;
    if (now - agent.lastDecisionAt >= decisionInterval) {
      this.requestDecision(agent, now);
    }
  }

  private requestDecision(agent: Agent, now: number): void {
    agent.state = 'thinking';
    agent.lastDecisionAt = now;
    const minuteOfDay = now % MINUTES_PER_DAY;
    // 装配决策上下文：有 mind 时注入检索记忆 / 近期洞察 / 当前时段议程
    let memories: MemoryBrief[] = [];
    let insights: string[] = [];
    let behaviorGuidance: string[] = [];
    let mindState: ReflectionMindState | null = null;
    let agenda: string | null = null;
    if (this.mind) {
      const day = Math.floor(now / MINUTES_PER_DAY) + 1;
      const query = `${agent.persona.goals.join(' ')} ${agent.action?.action.verb ?? ''} ${this.world.getObject(agent.locationId)?.name ?? ''}`;
      memories = this.mind.store.retrieve(agent.id, query, now, 20).map((m) => ({ content: m.content, importance: m.importance }));
      insights = this.mind.store.recentInsights(agent.id, 3);
      behaviorGuidance = this.mind.store.recentGuidance(agent.id, 3);
      mindState = this.mind.store.latestMindState(agent.id) ?? initialMindStateOf(agent.persona);
      agenda = this.mind.planner.currentAgendaLine(agent, day, minuteOfDay);
    }
    const runtimeMode = this.llm.runtimeSnapshot().mode;
    const playerInstruction = this.player?.current(agent.id, now) ?? null;
    const context = this.decisionRequestContext(agent, now, playerInstruction, runtimeMode);
    const detailedObjectIds = new Set<string>([
      agent.locationId,
      agent.homeObjectId,
      ...agent.persona.routine.map((slot) => slot.target),
    ].filter((value): value is string => typeof value === 'string'));
    const actionObjects = this.world.allObjects().map((object) => {
      const center = this.world.centerOf(object);
      const distance = Math.abs(agent.x - center.x) + Math.abs(agent.y - center.y);
      const canSenseState = !!object.state && distance <= (object.observationRadius ?? 3);
      // 真实模型只为现场、作息目标与家提供富描述；远处对象保留 id/name，仍可规划前往。
      // Mock 保持完整机器上下文，从而不改变离线实验的确定性基线。
      const detailed = runtimeMode === 'mock' || detailedObjectIds.has(object.id) || distance <= 8
        || (!!playerInstruction && (playerInstruction.includes(object.id) || playerInstruction.includes(object.name)));
      return {
        id: object.id,
        name: object.name,
        ...(detailed && object.description ? { description: object.description } : {}),
        ...(detailed && object.affordances?.length ? { affordances: object.affordances.map((item) => ({ ...item })) } : {}),
        ...(detailed && object.sensoryCues?.length ? { sensoryCues: [...object.sensoryCues] } : {}),
        ...(canSenseState ? { state: { label: object.state!.label, detail: object.state!.detail } } : {}),
      };
    });
    const { messages } = buildActionDecisionMessages({
      agent,
      day: Math.floor(now / MINUTES_PER_DAY) + 1,
      minuteOfDay,
      locationName: this.world.getObject(agent.locationId)?.name ?? agent.locationId,
      objects: actionObjects,
      playerInstruction,
      mockContext: {
        persona: agent.persona, minuteOfDay, routine: agent.persona.routine, memories, insights,
        behaviorGuidance, mindState, agenda,
        playerInstruction,
        objects: actionObjects,
      },
      includeMockContext: runtimeMode === 'mock',
    });
    const req: LLMRequest = {
      tier: 'small', template: ACTION_DECISION_TEMPLATE, messages, jsonMode: true,
      jsonSchema: actionDecisionJsonSchema(this.world.allObjects().map((object) => object.id)), maxTokens: 256,
      temperature: 0.45, reasoning: false, agentId: agent.id, priority: 'action', scopeId: this.scopeId, timeoutMs: 60_000,
    };
    const entry: PendingDecision = { resolved: null, error: null, context };
    this.pending.set(agent.id, entry);
    const task = this.runDecision(agent, req, entry, now, playerInstruction);
    this.activeDecisions.add(task);
    void task.finally(() => this.activeDecisions.delete(task));
  }

  /** 等待已发出的决策完成，保证关闭数据库前不再写入事件。 */
  async drain(): Promise<void> {
    while (this.activeDecisions.size > 0) await Promise.allSettled(this.activeDecisions);
  }

  /** 过期响应的替代决策尚未落定时，世界循环不得继续推进虚拟时间。 */
  hasTemporalDecisionBarrier(): boolean {
    return this.temporalDecisionBarriers.size > 0;
  }

  /** 真实异步模型的快速响应在请求时刻结算；确定性 Mock 保留离线基线的下一 tick 轨迹。 */
  shouldSettleDecisionSameTick(agentId: string): boolean {
    const pending = this.pending.get(agentId);
    return !!pending && pending.context.runtimeMode !== 'mock';
  }

  private async runDecision(
    agent: Agent,
    req: LLMRequest,
    entry: PendingDecision,
    now: number,
    playerInstruction: string | null,
  ): Promise<void> {
    try {
      let attempts = 1;
      const reasons: string[] = [];
      const rejectionCodes = new Set<ActionDecisionRejectionCode>();
      let response = await this.llm.complete(req);
      let model = response.performance?.model;
      let validation = this.validate(agent, response.parsed, playerInstruction);
      if (!validation.ok) {
        reasons.push(validation.error ?? '动作决策未通过校验');
        if (validation.errorCode === 'ungrounded_interaction') rejectionCodes.add('ungrounded_interaction');
        attempts = 2;
        response = await this.llm.complete(this.repairRequest(agent, req, response.parsed, reasons[0], playerInstruction));
        model = response.performance?.model ?? model;
        validation = this.validate(agent, response.parsed, playerInstruction);
        if (!validation.ok) {
          reasons.push(validation.error ?? '修正后的动作决策未通过校验');
          if (validation.errorCode === 'ungrounded_interaction') rejectionCodes.add('ungrounded_interaction');
        }
      }

      let status: ActionDecisionQualityStatus;
      let selected: Decision;
      if (!validation.ok) {
        status = 'safe_fallback';
        selected = this.safeFallbackDecision(agent);
      } else {
        if (validation.normalization) reasons.push(validation.normalization.detail);
        status = attempts > 1 ? 'repaired' : validation.normalization ? 'normalized' : 'valid';
        selected = validation.decision;
        this.fallbackStreak.delete(agent.id);
      }

      const quality: ActionDecisionQuality = {
        status,
        attempts,
        validator: ACTION_DECISION_VALIDATOR,
        ...(model ? { model } : {}),
        ...(rejectionCodes.size ? { rejectionCodes: [...rejectionCodes] } : {}),
      };
      const decision = this.enforceSleepRoutine(agent, selected, now);
      entry.resolved = { decision, quality, reasons };
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      console.warn(`[agent-decision] agent=${agent.id} template=${req.template} failed: ${entry.error}`);
    }
  }

  private repairRequest(
    agent: Agent,
    req: LLMRequest,
    invalid: unknown,
    reason: string,
    playerInstruction: string | null,
  ): LLMRequest {
    const previous = safeJson(invalid).slice(0, 1_200);
    const target = targetFromDecision(invalid);
    const allowed = target ? this.interactionVerbs(agent, target) : [];
    const groundingRule = allowed.length
      ? `若使用 interact，verb 必须逐字选择目标已声明动词之一：${allowed.join('、')}。`
      : playerInstruction
        ? `若使用 interact，verb 必须来自明确玩家指令「${playerInstruction}」中的动作短语。`
        : '若目标没有已声明交互动词，请改用 move_to 或 idle，不得发明 interact 动词。';
    return {
      ...req,
      temperature: 0.1,
      messages: [
        ...req.messages,
        { role: 'assistant', content: previous },
        {
          role: 'user',
          content: `上一个动作 JSON 未通过校验：${reason}。请只修正 JSON，不要解释。idle 的 target 必须是 null；move_to/interact 的 target 必须是可用对象 id。${groundingRule}`,
        },
      ],
    };
  }

  private validate(agent: Agent, parsed: unknown, playerInstruction: string | null): ValidationResult {
    return validateDecision(parsed, (id) => this.world.hasObject(id), {
      interactionVerbs: (targetId) => this.interactionVerbs(agent, targetId),
      playerInstruction,
    });
  }

  private interactionVerbs(agent: Agent, targetId: string): string[] {
    const declared = this.world.getObject(targetId)?.affordances?.map((item) => item.verb) ?? [];
    const routine = agent.persona.routine
      .filter((slot) => slot.type === 'interact' && slot.target === targetId)
      .map((slot) => slot.verb);
    return [...new Set([...declared, ...routine].map((item) => item.trim()).filter(Boolean))];
  }

  private decisionRequestContext(
    agent: Agent,
    now: number,
    playerInstruction: string | null,
    runtimeMode: LLMRuntimeMode,
  ): DecisionRequestContext {
    return {
      requestedAt: now,
      day: Math.floor(now / MINUTES_PER_DAY) + 1,
      locationId: agent.locationId,
      routineSlotKey: this.routineSlotKey(agent, now),
      playerInstruction,
      runtimeMode,
    };
  }

  private staleDecisionReasons(agent: Agent, context: DecisionRequestContext, now: number): string[] {
    // Mock 是同步、确定性的离线模拟器；下一 tick 消费是既有离散时间语义，不代表模型响应过期。
    if (context.runtimeMode === 'mock') return [];
    const reasons: string[] = [];
    const age = now - context.requestedAt;
    if (age < 0 || age > MAX_DECISION_AGE_MIN) {
      reasons.push(`决策上下文已过期：请求于 ${context.requestedAt}，当前为 ${now}，有效期 ${MAX_DECISION_AGE_MIN} 分钟`);
    }
    const day = Math.floor(now / MINUTES_PER_DAY) + 1;
    if (day !== context.day) reasons.push(`决策日期已从第 ${context.day} 天变为第 ${day} 天`);
    if (agent.locationId !== context.locationId) {
      reasons.push(`居民位置已从「${context.locationId}」变为「${agent.locationId}」`);
    }
    if (this.routineSlotKey(agent, now) !== context.routineSlotKey) {
      reasons.push('居民当前作息槽已变化');
    }
    const playerInstruction = this.player?.current(agent.id, now) ?? null;
    if (playerInstruction !== context.playerInstruction) reasons.push('玩家指令上下文已变化');
    return reasons;
  }

  private routineSlotKey(agent: Agent, now: number): string | null {
    const minuteOfDay = now % MINUTES_PER_DAY;
    const slot = agent.persona.routine.find((item) => item.from <= minuteOfDay && minuteOfDay < item.to);
    return slot ? JSON.stringify([slot.from, slot.to, slot.type, slot.target, slot.verb]) : null;
  }

  private safeFallbackDecision(agent: Agent): Decision {
    const streak = (this.fallbackStreak.get(agent.id) ?? 0) + 1;
    this.fallbackStreak.set(agent.id, streak);
    const place = this.world.getObject(agent.locationId)?.name ?? '这里';
    const thoughts = [
      `眼下没有合适的行动条件，我先在「${place}」稍作整理，再决定下一步。`,
      `我先在「${place}」放慢节奏，留意周围的变化。`,
      `此刻适合在「${place}」短暂休息，稍后再继续今天的安排。`,
    ];
    return {
      thought: thoughts[(streak - 1) % thoughts.length],
      action: { type: 'idle', target: null, verb: '整理思绪' },
      durationMinutes: Math.min(30, 10 + (streak - 1) * 5),
    };
  }

  private enforceSleepRoutine(agent: Agent, decision: Decision, now: number): Decision {
    const scheduled = this.sleepRoutineDecision(agent, now);
    if (!scheduled || decision.action.target === scheduled.action.target) return decision;
    return scheduled;
  }

  private sleepRoutineDecision(agent: Agent, now: number): Decision | null {
    if (this.player?.current(agent.id, now)) return null;
    const minuteOfDay = now % MINUTES_PER_DAY;
    const slot = agent.persona.routine.find((item) => item.from <= minuteOfDay && minuteOfDay < item.to);
    if (!slot || !/睡|就寝|休息|打盹/.test(slot.verb)) return null;
    return {
      thought: `当前是${slot.verb}时段，先按作息休息。`,
      action: {
        type: 'interact',
        target: slot.target,
        verb: slot.verb,
      },
      durationMinutes: Math.max(10, slot.to - minuteOfDay),
    };
  }

  private beginAction(agent: Agent, d: Decision, now: number): void {
    agent.thought = d.thought;
    agent.action = d;
    const tile = this.world.targetTile(d.action.target);
    const here = { x: agent.x, y: agent.y };
    const isHere = !tile || (tile.x === here.x && tile.y === here.y);
    if ((d.action.type === 'move_to' || d.action.type === 'interact') && !isHere) {
      const path = this.world.findPath(here, tile!);
      if (!path) {
        this.log.addEvent(this.makeEvent('system', agent, d, now, `找不到通往「${this.targetName(d)}」的路，先休息一下。`));
        agent.state = 'idle';
        agent.action = null;
        agent.lastDecisionAt = now;
        return;
      }
      agent.state = 'moving';
      agent.path = path;
      agent.pathProgress = 0;
      return;
    }
    if (d.action.type === 'move_to') {
      // 已在目标处：直接完成
      this.log.addEvent(this.makeEvent('move', agent, d, now, `到达「${this.targetName(d)}」`));
      agent.state = 'idle';
      agent.action = null;
      agent.lastDecisionAt = now;
      return;
    }
    // interact / idle：原地执行
    agent.state = 'acting';
    agent.actionEndsAt = now + d.durationMinutes;
    const desc =
      d.action.type === 'interact'
        ? `开始「${d.action.verb}」，约 ${d.durationMinutes} 分钟`
        : `小憩，约 ${d.durationMinutes} 分钟`;
    if (d.action.type === 'interact') this.emitPublicActionStart(agent, d, now, desc);
    else this.log.addEvent(this.makeEvent('system', agent, d, now, desc));
  }

  private stepMove(agent: Agent, dt: number, now: number): void {
    const nextProgress = agent.pathProgress + dt * MOVE_SPEED_TILES_PER_MIN;
    const nextIdx = Math.min(Math.floor(nextProgress), agent.path.length - 1);
    const nextTile = agent.path[nextIdx];
    // 排队让行：下一格被 moving/acting 的他人占用则本 tick 等待（idle 者不阻塞，防死锁）
    const occupied = this.world.allAgents().some(
      (other) => other.id !== agent.id && other.x === nextTile.x && other.y === nextTile.y && (other.state === 'moving' || other.state === 'acting')
    );
    if (occupied) {
      const blocked = (this.blockCount.get(agent.id) ?? 0) + 1;
      if (blocked >= 4) {
        // 连续受阻：判定死锁，放弃本次移动，休息后再决策
        this.blockCount.delete(agent.id);
        this.log.addEvent(this.makeEvent('system', agent, agent.action!, now, '被堵住了，先休息一下。'));
        agent.state = 'idle';
        agent.action = null;
        agent.lastDecisionAt = now;
        return;
      }
      this.blockCount.set(agent.id, blocked);
      return;
    }
    this.blockCount.delete(agent.id);
    agent.pathProgress = nextProgress;
    const idx = Math.min(Math.floor(agent.pathProgress), agent.path.length - 1);
    const tile = agent.path[idx];
    agent.x = tile.x;
    agent.y = tile.y;
    agent.locationId = this.world.locationOf(agent);
    if (idx >= agent.path.length - 1) this.onArrival(agent, now);
  }

  private onArrival(agent: Agent, now: number): void {
    const d = agent.action!;
    if (d.action.type === 'move_to') {
      this.log.addEvent(this.makeEvent('move', agent, d, now, `到达「${this.targetName(d)}」`));
      agent.state = 'idle';
      agent.action = null;
      agent.lastDecisionAt = now;
    } else {
      agent.state = 'acting';
      agent.actionEndsAt = now + d.durationMinutes;
      this.log.addEvent(this.makeEvent('move', agent, d, now, `到达「${this.targetName(d)}」`));
      this.emitPublicActionStart(agent, d, now, `开始「${d.action.verb}」，约 ${d.durationMinutes} 分钟`);
    }
  }

  private finishAction(agent: Agent, now: number): void {
    const d = agent.action;
    agent.state = 'idle';
    agent.action = null;
    agent.lastDecisionAt = now;
    if (!d) return;
    const desc = d.action.type === 'interact' ? `完成「${d.action.verb}」` : '小憩结束';
    this.log.addEvent(this.makeEvent(d.action.type === 'interact' ? 'interact' : 'system', agent, d, now, desc));
  }

  private targetName(d: Decision): string {
    return this.world.getObject(d.action.target)?.name ?? d.action.target ?? '';
  }

  /** 公共生活物件上的行动会被附近居民见证，并形成定向的观察证据。 */
  private emitPublicActionStart(agent: Agent, d: Decision, now: number, description: string): void {
    const event = this.makeEvent('interact', agent, d, now, description);
    const object = this.world.getObject(d.action.target);
    const radius = object?.observationRadius ?? 0;
    const center = object ? this.world.centerOf(object) : null;
    const observers = center && radius > 0
      ? this.world.allAgents().filter((other) => (
        other.id !== agent.id
        && Math.abs(other.x - center.x) + Math.abs(other.y - center.y) <= radius
      ))
      : [];
    if (object && observers.length > 0) {
      event.payload = {
        ...(event.payload ?? {}),
        kind: 'public_object_interaction',
        objectId: object.id,
        objectName: object.name,
        observerIds: observers.map((observer) => observer.id),
        memoryAgentIds: [agent.id, ...observers.map((observer) => observer.id)],
        sensoryCues: object.sensoryCues ?? [],
      };
    }
    this.log.addEvent(event);
    if (!object || !this.mind || observers.length === 0) return;
    for (const observer of observers) {
      this.mind.rels.update(observer.id, agent.id, {
        knowledge: [event.description],
        evidence: {
          kind: 'observation',
          eventId: event.id,
          text: event.description,
          metadata: {
            channel: 'attention',
            source: 'public_object',
            objectId: object.id,
            objectName: object.name,
            actionVerb: d.action.verb,
          },
        },
      }, now);
    }
  }

  private makeEvent(type: GameEvent['type'], agent: Agent, d: Decision, now: number, description: string): GameEvent {
    return {
      id: randomUUID(),
      type,
      actorId: agent.id,
      targetIds: d.action.target ? [d.action.target] : [],
      description: `${agent.name} ${description}`,
      location: agent.locationId,
      gameTime: now,
      payload: type === 'system' ? null : { verb: d.action.verb, durationMinutes: d.durationMinutes },
    };
  }

  private thoughtEvent(agent: Agent, d: Decision, now: number, quality?: ActionDecisionQuality): GameEvent {
    return {
      id: randomUUID(),
      type: 'system',
      actorId: agent.id,
      targetIds: [],
      description: `${agent.name} 心想：「${d.thought}」`,
      location: agent.locationId,
      gameTime: now,
      payload: {
        kind: 'thought',
        thought: d.thought,
        ...(quality ? { source: 'llm', decisionQuality: quality } : { source: 'routine' }),
      },
    };
  }

  private actionQualityEvent(agent: Agent, quality: ActionDecisionQuality, reasons: string[], now: number): GameEvent {
    const description = quality.status === 'stale_rejected'
      ? `${agent.name} 的动作决策因上下文变化进入重新决策。`
      : `${agent.name} 的动作决策完成了可执行性校验。`;
    return {
      id: randomUUID(),
      type: 'system',
      actorId: agent.id,
      targetIds: [],
      description,
      location: agent.locationId,
      gameTime: now,
      payload: { kind: 'action_decision_quality', ...quality, reasons },
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}

function targetFromDecision(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const action = (value as { action?: unknown }).action;
  if (!action || typeof action !== 'object') return null;
  const target = (action as { target?: unknown }).target;
  return typeof target === 'string' ? target : null;
}
