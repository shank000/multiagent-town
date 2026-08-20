// Agent 状态机 + 动作执行（design §5.1/§5.5 的 M0 子集）
// idle → thinking（异步 LLM）→ moving → acting → idle；LLM 绝不阻塞 tick

import { randomUUID } from 'node:crypto';
import type { Agent, Decision, GameEvent } from './types';
import { MINUTES_PER_DAY } from './time';
import { validateDecision, type ValidationResult } from '../llm/action-validator';
import { buildActionDecisionMessages, ACTION_DECISION_TEMPLATE } from '../llm/prompts';
import type { MemoryBrief } from '../llm/prompts';
import type { LLMGateway } from '../llm/gateway';
import type { LLMRequest } from '../llm/types';
import type { WorldState } from './world';
import type { EventLog } from '../store/events';
import type { MindEngine } from '../engine/mind';
import type { PlayerDirector } from '../engine/player';

export const DECISION_INTERVAL_MIN = 10; // 每 10 游戏分钟决策一次（M0 固定值）
export const MOVE_SPEED_TILES_PER_MIN = 1;

interface PendingDecision {
  resolved: Decision | null;
  error: string | null;
}

export class AgentExecutor {
  private pending = new Map<string, PendingDecision>();

  constructor(
    private llm: LLMGateway,
    private world: WorldState,
    private log: EventLog,
    private mind?: MindEngine,
    private player?: PlayerDirector
  ) {}

  /** 每 tick 对每个 agent 调用一次；dt = 本次 tick 推进的游戏分钟数 */
  progress(agent: Agent, dt: number, now: number): void {
    if (agent.state === 'thinking') {
      const entry = this.pending.get(agent.id);
      if (!entry) return;
      if (entry.error) {
        this.pending.delete(agent.id);
        agent.state = 'idle';
        agent.lastDecisionAt = now;
        return;
      }
      if (entry.resolved) {
        this.pending.delete(agent.id);
        this.beginAction(agent, entry.resolved, now);
      }
      return;
    }
    if (agent.state === 'moving') {
      this.stepMove(agent, dt, now);
      return;
    }
    if (agent.state === 'acting') {
      if (now >= agent.actionEndsAt) this.finishAction(agent, now);
      return;
    }
    if (now - agent.lastDecisionAt >= DECISION_INTERVAL_MIN) {
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
    let agenda: string | null = null;
    if (this.mind) {
      const day = Math.floor(now / MINUTES_PER_DAY) + 1;
      const query = `${agent.persona.goals.join(' ')} ${agent.action?.action.verb ?? ''} ${this.world.getObject(agent.locationId)?.name ?? ''}`;
      memories = this.mind.store.retrieve(agent.id, query, now, 20).map((m) => ({ content: m.content, importance: m.importance }));
      insights = this.mind.store.recentInsights(agent.id, 3);
      agenda = this.mind.planner.currentAgendaLine(agent, day, minuteOfDay);
    }
    const { messages } = buildActionDecisionMessages({
      agent,
      day: Math.floor(now / MINUTES_PER_DAY) + 1,
      minuteOfDay,
      locationName: this.world.getObject(agent.locationId)?.name ?? agent.locationId,
      objects: this.world.allObjects().map((o) => ({ id: o.id, name: o.name })),
      playerInstruction: this.player?.current(agent.id, now) ?? null,
      mockContext: {
        persona: agent.persona, minuteOfDay, routine: agent.persona.routine, memories, insights, agenda,
        playerInstruction: this.player?.current(agent.id, now) ?? null,
        objects: this.world.allObjects().map((o) => ({ id: o.id, name: o.name })),
      },
    });
    const req: LLMRequest = {
      tier: 'small', template: ACTION_DECISION_TEMPLATE, messages, jsonMode: true, maxTokens: 512,
    };
    const entry: PendingDecision = { resolved: null, error: null };
    this.pending.set(agent.id, entry);
    void this.runDecision(agent, req, entry, now);
  }

  private async runDecision(agent: Agent, req: LLMRequest, entry: PendingDecision, now: number): Promise<void> {
    try {
      let r = this.validate((await this.llm.complete(req)).parsed);
      if (!r.ok) r = this.validate((await this.llm.complete(req)).parsed); // 校验失败重试一次
      entry.resolved = r.decision; // !ok 时 decision 即 idle 降级
      this.log.addEvent(this.thoughtEvent(agent, r.decision, now));
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
  }

  private validate(parsed: unknown): ValidationResult {
    return validateDecision(parsed, (id) => this.world.hasObject(id));
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
    this.log.addEvent(this.makeEvent(d.action.type === 'interact' ? 'interact' : 'system', agent, d, now, desc));
  }

  private stepMove(agent: Agent, dt: number, now: number): void {
    const nextProgress = agent.pathProgress + dt * MOVE_SPEED_TILES_PER_MIN;
    const nextIdx = Math.min(Math.floor(nextProgress), agent.path.length - 1);
    const nextTile = agent.path[nextIdx];
    // 排队让行：下一格被 moving/acting 的他人占用则本 tick 等待（idle 者不阻塞，防死锁）
    const occupied = this.world.allAgents().some(
      (other) => other.id !== agent.id && other.x === nextTile.x && other.y === nextTile.y && (other.state === 'moving' || other.state === 'acting')
    );
    if (occupied) return;
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
      this.log.addEvent(
        this.makeEvent('interact', agent, d, now, `开始「${d.action.verb}」，约 ${d.durationMinutes} 分钟`)
      );
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

  private thoughtEvent(agent: Agent, d: Decision, now: number): GameEvent {
    return {
      id: randomUUID(),
      type: 'system',
      actorId: agent.id,
      targetIds: [],
      description: `${agent.name} 心想：「${d.thought}」`,
      location: agent.locationId,
      gameTime: now,
      payload: { kind: 'thought', thought: d.thought },
    };
  }
}
