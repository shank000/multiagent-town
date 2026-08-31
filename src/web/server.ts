// 像素小镇本地 Web 服务：静态页面 + 快照/事件 SSE + 世界控制（零新增依赖，node:http）

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TimeEngine } from '../core/time';
import type { WorldState } from '../core/world';
import type { WorldLoop } from '../engine/loop';
import type { EventLog } from '../store/events';
import type { DbHandle } from '../store/db';
import type { RelationshipStore } from '../store/relationships';
import type { RumorTracker } from '../engine/rumors';
import type { GameEvent } from '../core/types';
import type { MindEngine } from '../engine/mind';
import type { PlayerDirector } from '../engine/player';
import type { LLMGateway } from '../llm/gateway';
import type { BackendLogLevel, BackendRuntimeLog } from '../runtime/backend-log';
import { gatewayConfigFromRuntimeInput, probeGatewayConfig } from '../llm/runtime-config';
import { computeStanding } from '../engine/status';
import { analyzeTown } from '../engine/analyze';
import {
  DEFAULT_RELATION_WINDOW_DAYS,
  projectSocialRelationships,
  type PartnerChoiceObservation,
} from '../engine/social-relations';
import { createGuestAgent, hydrateWorld } from '../engine/seed';
import { PerceptionEngine } from '../engine/perception';
import { metricsOf, type Choice } from '../engine/metrics';
import { buildSnapshot, type WorldSnapshot } from './snapshot';
import { startLoopGroup, stopLoopGroup } from '../engine/loop';
import { MAX_WORLD_SPEED } from '../engine/runtime-limits';
import {
  TimelineGovernor,
  timelinePerformanceSummary,
  type GovernedTimelineWorld,
  type TimelineAdjustment,
} from '../engine/timeline-governor';
import {
  applyAgentProfile,
  normalizeAgentProfile,
  profileDefinitionOf,
  profileSetHash,
  type AgentProfileDefinition,
} from '../engine/agent-profile';
import { saveAgentProfileConfig } from '../store/agent-profile-config';
import { performSocialInteraction, socialInteractionDefinition } from '../engine/social-interactions';
import {
  WORLD_TEMPLATE_CATALOG,
  type BuiltExperimentWorkspace,
  type ExperimentWorkspaceRuntime,
} from '../engine/workspace';

export interface TownWebOptions {
  world: WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  mind?: MindEngine;    // M1 认知核心（心智面板数据源）
  player?: PlayerDirector;    // 玩家扮演
  rels?: RelationshipStore;  // M3 关系存储（声望/关系 API 数据源）
  rumors?: RumorTracker;  // M3 谣言追踪（种子 API 数据源）
  db?: DbHandle;         // 数据统计与分析（/api/stats）数据源；缺省则该接口 404
  dbPath?: string;       // 展示用库路径（/api/stats 报告内），缺省空串
  publicDir?: string;   // 默认 <cwd>/public
  snapshotMs?: number;  // 默认 200
  experiment?: { state(): unknown; setConfig(cfg: { historyAccess: 'on' | 'off'; giftExchange: 'on' | 'off' }): void; start(days: number, now: number): void; stop(): void };
  worlds?: unknown[]; // ManagedWorld[]；结构由 hubWorlds 适配器按需取字段
  port?: number;        // 默认 0 = 系统随机端口
  llm?: LLMGateway;     // 共享推理调度状态与背压观测
  /** 桌面版持久档案文件；CLI 缺省为仅本次运行生效。 */
  profileStorePath?: string;
  /** 当前后端进程的结构化运行日志；只读接口不会访问该路径之外的文件。 */
  runtimeLog?: BackendRuntimeLog;
  /** 可替换的独立实验工作空间；缺省时保持兼容的固定世界模式。 */
  workspace?: ExperimentWorkspaceRuntime;
}

export interface TownWebServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

interface HubAccess {
  meta: {
    id: string;
    kind: string;
    name: string;
    desc: string;
    badges?: { label: string; value: string; tone: 'on' | 'off' | 'neutral' }[];
  };
  world: import('../core/world').WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  db: DbHandle | undefined;
  dbPath: string;
  mind: MindEngine;
  player: PlayerDirector | undefined;
  experiment: { state(): unknown; setConfig(c: { historyAccess: 'on' | 'off'; giftExchange: 'on' | 'off' }): void; start(days: number, now: number): void; stop(): void } | null | undefined;
}

function relationshipWindow(raw: string | null): { valid: true; days: number | null } | { valid: false } {
  if (raw === null || raw === '') return { valid: true, days: DEFAULT_RELATION_WINDOW_DAYS };
  if (raw === 'all') return { valid: true, days: null };
  if (!/^\d+$/.test(raw)) return { valid: false };
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= 3650
    ? { valid: true, days }
    : { valid: false };
}

function partnerChoiceObservations(log: EventLog, endGameTimeInclusive: number): PartnerChoiceObservation[] {
  const observations: PartnerChoiceObservation[] = [];
  for (const event of log.eventsOfKind('experiment_pair_choice', 0, endGameTimeInclusive + 1)) {
    const payload = event.payload as { kind?: string; fromId?: string; toId?: string } | null;
    if (payload?.kind !== 'experiment_pair_choice' || !payload.fromId || !payload.toId) continue;
    observations.push({
      fromId: payload.fromId,
      toId: payload.toId,
      gameTime: event.gameTime,
      eventId: event.id,
    });
  }
  return observations;
}

export async function createTownServer(opts: TownWebOptions): Promise<TownWebServer> {
  const publicDir = opts.publicDir ?? resolve(process.cwd(), 'public');
  const snapshotMs = opts.snapshotMs ?? 200;
  // 多世界模式：worlds 提供时以切换式 hub 服务；否则单世界包装
  let activeId = (opts.worlds?.[0] as { meta?: { id?: string } } | undefined)?.meta?.id ?? '';
  const adaptWorlds = (worlds: unknown[]): HubAccess[] => (worlds as HubAccess[]).map((w) => ({
      get meta() { return w.meta; },
      get world() { return w.world; },
      get time() { return w.time; },
      get loop() { return w.loop; },
      get log() { return w.log; },
      get db() { return w.db; },
      get dbPath() { return w.dbPath; },
      get mind() { return w.mind; },
      get player() { return w.player; },
      get experiment() { return w.experiment; },
    }));
  let hubWorlds: HubAccess[] | null = opts.worlds?.length ? adaptWorlds(opts.worlds) : null;
  const hub = (): HubAccess => {
    if (hubWorlds) {
      const found = hubWorlds.find((x) => x.meta.id === activeId) ?? hubWorlds[0];
      return {
        meta: found.meta, world: found.world, time: found.time, loop: found.loop,
        log: found.log, db: found.db, dbPath: found.dbPath,
        mind: found.mind, player: found.player, experiment: found.experiment,
      };
    }
    return {
      meta: {
        id: 'w1', kind: 'legacy', name: '小镇', desc: '单世界模式',
        badges: [{ label: '模式', value: '单世界', tone: 'neutral' }],
      },
      world: opts.world, time: opts.time, loop: opts.loop, log: opts.log,
      db: opts.db, dbPath: opts.dbPath ?? '',
      mind: opts.mind!, player: opts.player, experiment: opts.experiment,
    };
  };
  const hubById = (id: string | null): HubAccess | null => {
    if (!id) return hub();
    if (!hubWorlds) {
      const current = hub();
      return current.meta.id === id ? current : null;
    }
    const found = hubWorlds.find((world) => world.meta.id === id);
    return found ? {
      meta: found.meta, world: found.world, time: found.time, loop: found.loop,
      log: found.log, db: found.db, dbPath: found.dbPath,
      mind: found.mind, player: found.player, experiment: found.experiment,
    } : null;
  };
  const clients = new Set<ServerResponse>();
  let seq = 0;
  let paused = opts.workspace?.current.meta.startPaused ?? false;
  const timelineWorlds = (): GovernedTimelineWorld[] => (hubWorlds ?? [hub()]).map((world) => ({
    id: world.meta.id,
    time: world.time,
  }));
  const recordTimelineAdjustment = (adjustment: TimelineAdjustment) => {
    const reasonLabel = adjustment.reason === 'manual_selection'
      ? '手动选择'
      : adjustment.reason === 'workspace_configuration'
        ? '工作空间配置'
        : adjustment.reason === 'queue_pressure'
          ? '推理队列负载'
          : adjustment.reason === 'recovery_hysteresis'
            ? '持续稳定后渐进提速'
            : adjustment.reason === 'warming_up'
              ? '吞吐预热'
              : '实测模型容量';
    for (const world of hubWorlds ?? [hub()]) {
      world.log.addEvent({
        id: randomUUID(), type: 'system', actorId: null, targetIds: [],
        description: `世界时间治理器设为 ${adjustment.toSpeed}×（${reasonLabel}）。`,
        location: null, gameTime: world.time.state.totalMinutes,
        payload: {
          kind: 'timeline_speed_adjusted', mode: adjustment.mode,
          fromSpeed: adjustment.fromSpeed, toSpeed: adjustment.toSpeed,
          reason: adjustment.reason, sampleCount: adjustment.sampleCount,
          generationTokensPerSecond: adjustment.generationTokensPerSecond,
          p90LatencyMs: adjustment.p90LatencyMs,
        },
      });
    }
    opts.runtimeLog?.info(
      'timeline',
      `mode=${adjustment.mode} speed=${adjustment.fromSpeed}->${adjustment.toSpeed} reason=${adjustment.reason} ${timelinePerformanceSummary(opts.llm!.throughputSnapshot())}`,
    );
  };
  const timelineGovernor = opts.llm
    ? new TimelineGovernor(opts.llm, { onAdjustment: recordTimelineAdjustment })
    : null;

  const llmConfigurationSafety = (requireSettledWorld = true) => {
    const scheduler = opts.llm?.schedulerSnapshot();
    const controlledWorlds = hubWorlds ?? [hub()];
    const experimentsRunning = controlledWorlds.some((world) => {
      const state = world.experiment?.state() as { running?: unknown } | undefined;
      return state?.running === true;
    });
    const activeConversations = controlledWorlds.reduce((count, world) => (
      count + (world.mind?.dialogue.activeSessions().length ?? 0)
    ), 0);
    const thinkingAgents = controlledWorlds.reduce((count, world) => (
      count + world.world.allAgents().filter((agent) => agent.state === 'thinking').length
    ), 0);
    const reasons: string[] = [];
    if (!paused) reasons.push('先暂停世界时钟');
    if (experimentsRunning) reasons.push('先停止正在运行的正式实验');
    if ((scheduler?.active ?? 0) > 0 || (scheduler?.queued ?? 0) > 0) reasons.push('等待模型生成与排队任务清空');
    if (requireSettledWorld && activeConversations > 0) reasons.push('等待当前人物对话完整结束后再暂停');
    if (requireSettledWorld && thinkingAgents > 0) reasons.push('等待已生成的居民决策完成结算');
    return {
      ready: reasons.length === 0,
      paused,
      experimentsRunning,
      active: scheduler?.active ?? 0,
      queued: scheduler?.queued ?? 0,
      activeConversations,
      thinkingAgents,
      reasons,
    };
  };
  const settlePausedCognition = async () => {
    if (!paused) return;
    const controlledWorlds = hubWorlds ?? [hub()];
    if (controlledWorlds.some((world) => (world.mind?.dialogue.activeSessions().length ?? 0) > 0)) return;
    await Promise.all(controlledWorlds.map((world) => world.loop.drain()));
    await Promise.all(controlledWorlds.map((world) => world.mind?.drain() ?? Promise.resolve()));
    await opts.llm?.drain();
    await Promise.all(controlledWorlds.map((world) => world.loop.settlePendingDecisions()));
    await Promise.all(controlledWorlds.map((world) => world.mind?.drain() ?? Promise.resolve()));
    await opts.llm?.drain();
  };
  const quiesceWorkspaceForMutation = async () => {
    const controlledWorlds = hubWorlds ?? [hub()];
    paused = true;
    if (controlledWorlds.length > 1) stopLoopGroup(controlledWorlds.map((world) => world.loop));
    else controlledWorlds[0].loop.stop();
    for (const world of controlledWorlds) world.experiment?.stop();
    await Promise.all(controlledWorlds.map((world) => world.loop.drain()));
    await Promise.all(controlledWorlds.map((world) => world.mind?.drain() ?? Promise.resolve()));
    await opts.llm?.drain();
    await Promise.all(controlledWorlds.map((world) => world.loop.settlePendingDecisions()));
    await Promise.all(controlledWorlds.map((world) => world.mind?.drain() ?? Promise.resolve()));
    await opts.llm?.drain();
    return llmConfigurationSafety(false);
  };

  function snapshotOf(selected: HubAccess): WorldSnapshot & { worldId: string } {
    return {
      ...buildSnapshot(selected.world, selected.time, paused, ++seq),
      activeConversations: selected.mind?.dialogue.activeSessions() ?? [],
      worldId: selected.meta.id,
    };
  }
  function allSnapshots(): (WorldSnapshot & { worldId: string })[] {
    return hubWorlds ? hubWorlds.map((selected) => snapshotOf(selected)) : [snapshotOf(hub())];
  }
  function send(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event: string, data: unknown): void {
    for (const c of clients) send(c, event, data);
  }
  const perceptionByWorld = new Map<string, PerceptionEngine>();
  const unsubLogs: (() => void)[] = [];
  const clearHubResources = () => {
    for (const unsubscribe of unsubLogs.splice(0)) unsubscribe();
    for (const perception of perceptionByWorld.values()) perception.dispose();
    perceptionByWorld.clear();
  };
  const bindHubResources = () => {
    clearHubResources();
    const selectedWorlds = hubWorlds ?? [hub()];
    for (const selected of selectedWorlds) {
      perceptionByWorld.set(selected.meta.id, new PerceptionEngine(selected.world, selected.log));
      unsubLogs.push(selected.log.subscribe((event: GameEvent) => (
        broadcast('event', hubWorlds ? { ...event, worldId: selected.meta.id } : event)
      )));
    }
  };
  bindHubResources();

  const activateWorkspace = (built: BuiltExperimentWorkspace): HubAccess[] => {
    const activatedWorlds = adaptWorlds(built.worlds);
    hubWorlds = activatedWorlds;
    activeId = activatedWorlds[0].meta.id;
    seq = 0;
    opts.llm?.setExpectedActiveAgents(
      activatedWorlds.reduce((count, world) => count + world.world.allAgents().length, 0),
    );
    bindHubResources();
    paused = built.meta.startPaused;
    timelineGovernor?.setManual(built.meta.worldSpeed, timelineWorlds(), 'workspace_configuration');
    if (!paused) startLoopGroup(activatedWorlds.map((world) => world.loop));
    return activatedWorlds;
  };

  const restoreCurrentWorkspaceBindings = (): void => {
    if (!opts.workspace) return;
    hubWorlds = adaptWorlds(opts.workspace.current.worlds);
    activeId = hubWorlds[0].meta.id;
    bindHubResources();
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        for (const snapshot of allSnapshots()) send(res, 'snapshot', snapshot);
        req.on('close', () => clients.delete(res));
        res.on('error', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/state') {
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ...buildSnapshot(
            selected.world,
            selected.time,
            paused,
            ++seq,
            selected.mind?.dialogue.activeSessions() ?? []
          ),
          worldId: selected.meta.id,
        }));
        return;
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (!selected.db) {
          res.writeHead(404);
          res.end('数据统计未启用');
          return;
        }
        const dayRaw = url.searchParams.get('day');
        let day: number | undefined;
        if (dayRaw !== null) {
          const parsed = Number(dayRaw);
          if (!/^\d+$/.test(dayRaw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
            res.writeHead(400);
            res.end('day 必须是正整数');
            return;
          }
          day = parsed;
        }
        // 名册优先用内存世界（含访客），与 agents 表保持一致（两者都由 hydrateWorld 维护）
        const names = new Map(selected.world.allAgents().map((agent) => [agent.id, agent.name]));
        const report = analyzeTown(selected.db, { day, top: 10, dbPath: selected.dbPath, names });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...report, worldId: selected.meta.id }));
        return;
      }
      if (url.pathname === '/api/runtime-logs' && req.method === 'GET') {
        if (!opts.runtimeLog) { res.writeHead(404); res.end('后端运行日志未启用'); return; }
        const rawLevel = url.searchParams.get('level') ?? 'all';
        if (!['all', 'debug', 'info', 'warn', 'error'].includes(rawLevel)) {
          res.writeHead(400); res.end('level 必须是 all、debug、info、warn 或 error'); return;
        }
        const rawAfter = url.searchParams.get('after') ?? '0';
        const rawLimit = url.searchParams.get('limit') ?? '500';
        if (!/^\d+$/.test(rawAfter) || !/^\d+$/.test(rawLimit)) {
          res.writeHead(400); res.end('after 与 limit 必须是非负整数'); return;
        }
        const after = Number(rawAfter);
        const limit = Number(rawLimit);
        if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
          res.writeHead(400); res.end('after 必须是安全整数，limit 必须在 1..2000'); return;
        }
        const search = (url.searchParams.get('q') ?? '').trim();
        if (search.length > 200) { res.writeHead(400); res.end('搜索文本不能超过 200 个字符'); return; }
        const snapshot = opts.runtimeLog.query({
          level: rawLevel as BackendLogLevel | 'all', after, limit, search,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(snapshot));
        return;
      }
      if (url.pathname === '/api/runtime-logs/download' && req.method === 'GET') {
        if (!opts.runtimeLog) { res.writeHead(404); res.end('后端运行日志未启用'); return; }
        const content = await readFile(opts.runtimeLog.filePath);
        const safeName = opts.runtimeLog.fileName.replace(/[^A-Za-z0-9_.-]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Length': String(content.byteLength),
          'Content-Disposition': `attachment; filename="${safeName}"`,
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!hub().mind.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const standing = computeStanding(hub().mind.rels.allPairs());
        for (const agent of hub().world.allAgents()) if (!standing.has(agent.id)) standing.set(agent.id, 0);
        const list = [...standing.entries()]
          .map(([id, score]) => ({ id, name: hub().world.allAgents().find((a) => a.id === id)?.name ?? id, score }))
          .sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(list));
        return;
      }
      if (url.pathname === '/api/llm/status' && req.method === 'GET') {
        const controlledTimelineWorlds = timelineWorlds();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(opts.llm ? {
          ...opts.llm.schedulerSnapshot(),
          timeline: timelineGovernor?.snapshot(controlledTimelineWorlds, paused) ?? null,
        } : {
          active: 0, queued: 0, maxConcurrent: 0, maxQueued: 0,
          oldestActiveMs: 0, oldestWaitMs: 0, backpressured: false, pressureReason: null,
          activeByPriority: {}, byPriority: {}, byScope: {},
          performance: {
            provider: 'none', sampleCount: 0, generationTokensPerSecond: null, promptTokensPerSecond: null,
            effectiveTokensPerSecond: null, p50LatencyMs: null, p90LatencyMs: null,
            p90LoadMs: null, p90PromptMs: null, p90GenerationMs: null,
            p90DialogueLatencyMs: null, p90QueueWaitMs: null,
            recommendedMaxWorldSpeed: null, burstMaxWorldSpeed: MAX_WORLD_SPEED, confidence: 'unavailable',
          },
          timeline: null,
        }));
        return;
      }
      if (url.pathname === '/api/llm/config' && req.method === 'GET') {
        if (!opts.llm) { res.writeHead(404); res.end('LLM 网关未启用'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          config: opts.llm.runtimeSnapshot(),
          safety: llmConfigurationSafety(),
          supportedModes: ['mock', 'ollama', 'api'],
          credentialPolicy: 'memory_only',
        }));
        return;
      }
      if (url.pathname === '/api/llm/test' && req.method === 'POST') {
        if (!opts.llm) { res.writeHead(404); res.end('LLM 网关未启用'); return; }
        const safety = llmConfigurationSafety(false);
        if (!safety.ready) { res.writeHead(409); res.end(safety.reasons.join('；')); return; }
        let config;
        try {
          config = gatewayConfigFromRuntimeInput(await readBody(req));
        } catch (error) {
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '模型配置无效');
          return;
        }
        try {
          const probe = await probeGatewayConfig(config);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, probe }));
        } catch (error) {
          res.writeHead(502);
          res.end(error instanceof Error ? error.message : '模型连接检测失败');
        }
        return;
      }
      if (url.pathname === '/api/llm/config' && req.method === 'POST') {
        if (!opts.llm) { res.writeHead(404); res.end('LLM 网关未启用'); return; }
        await settlePausedCognition();
        const safety = llmConfigurationSafety();
        if (!safety.ready) { res.writeHead(409); res.end(safety.reasons.join('；')); return; }
        let config;
        try {
          config = gatewayConfigFromRuntimeInput(await readBody(req));
        } catch (error) {
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '模型配置无效');
          return;
        }
        try {
          const probe = await probeGatewayConfig(config);
          config.expectedActiveAgents = (hubWorlds ?? [hub()])
            .reduce((count, world) => count + world.world.allAgents().length, 0);
          const runtime = opts.llm.reconfigure(config);
          const controlledWorlds = hubWorlds ?? [hub()];
          if (timelineGovernor?.mode === 'adaptive') timelineGovernor.enableAdaptive(timelineWorlds());
          for (const world of controlledWorlds) {
            world.log.addEvent({
              id: randomUUID(), type: 'system', actorId: null, targetIds: [],
              description: `Agent 模型运行方式设为${runtime.mode === 'mock' ? ' Mock 模拟' : runtime.mode === 'ollama' ? '本地开源模型' : 'API 推理'}。`,
              location: null, gameTime: world.time.state.totalMinutes,
              payload: {
                kind: 'llm_runtime_config_changed', mode: runtime.mode, provider: runtime.provider,
                model: runtime.model, smallModel: runtime.smallModel, numCtx: runtime.numCtx,
                configRevision: runtime.revision,
              },
            });
          }
          opts.runtimeLog?.info(
            'llm-config',
            `模型运行方式已切换 mode=${runtime.mode} provider=${runtime.provider} model=${runtime.model ?? 'none'} revision=${runtime.revision}`,
          );
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, config: runtime, probe, safety: llmConfigurationSafety() }));
        } catch (error) {
          res.writeHead(502);
          res.end(error instanceof Error ? error.message : '模型配置应用失败');
        }
        return;
      }
      if (url.pathname === '/api/llm/calibrate' && req.method === 'POST') {
        if (!opts.llm) { res.writeHead(404); res.end('LLM 网关未启用'); return; }
        const performance = await opts.llm.calibrate();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, performance }));
        return;
      }
      if (url.pathname === '/api/relationships' && req.method === 'GET') {
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (!selected.mind.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const window = relationshipWindow(url.searchParams.get('windowDays'));
        if (!window.valid) {
          res.writeHead(400);
          res.end('windowDays 必须是 1..3650 或 all');
          return;
        }
        const names = new Map(selected.world.allAgents().map((agent) => [agent.id, agent.name]));
        const now = selected.time.state.totalMinutes;
        const evidence = selected.mind.rels.evidenceInGameTimeRange(0, now);
        const projection = projectSocialRelationships(
          selected.mind.rels.allPairs(),
          evidence,
          names,
          now,
          {
            windowDays: window.days,
            choices: partnerChoiceObservations(selected.log, now),
          },
        );
        const directions = projection.directions.map(({ evidence: _evidence, ...direction }) => direction);
        const dyads = projection.dyads.map(({
          aToB: _aToB,
          bToA: _bToA,
          aToBMeasures: _aToBMeasures,
          bToAMeasures: _bToAMeasures,
          ...dyad
        }) => dyad);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ worldId: selected.meta.id, ...projection, directions, dyads }));
        return;
      }
      if (url.pathname === '/api/relationships/dyad' && req.method === 'GET') {
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (!selected.mind.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const aId = url.searchParams.get('aId') ?? '';
        const bId = url.searchParams.get('bId') ?? '';
        const residents = new Map(selected.world.allAgents().map((agent) => [agent.id, agent.name]));
        if (!aId || !bId || aId === bId) {
          res.writeHead(400);
          res.end('aId 与 bId 必须是两个不同居民');
          return;
        }
        if (!residents.has(aId) || !residents.has(bId)) {
          res.writeHead(404);
          res.end('未知居民');
          return;
        }
        const window = relationshipWindow(url.searchParams.get('windowDays'));
        if (!window.valid) {
          res.writeHead(400);
          res.end('windowDays 必须是 1..3650 或 all');
          return;
        }
        const now = selected.time.state.totalMinutes;
        const evidence = selected.mind.rels.evidenceInGameTimeRange(0, now);
        const choices = partnerChoiceObservations(selected.log, now);
        const projection = projectSocialRelationships(
          selected.mind.rels.allPairs(),
          evidence,
          residents,
          now,
          { windowDays: window.days, choices, evidencePerDirection: 100 },
        );
        const dyad = projection.dyads.find((item) => (
          (item.aId === aId && item.bId === bId) || (item.aId === bId && item.bId === aId)
        )) ?? null;
        const aToB = projection.directions.find((item) => item.fromId === aId && item.toId === bId) ?? null;
        const bToA = projection.directions.find((item) => item.fromId === bId && item.toId === aId) ?? null;
        const directionSummary = (direction: typeof aToB) => {
          if (!direction) return null;
          const { evidence: _evidence, ...summary } = direction;
          return summary;
        };
        const dyadSummary = (() => {
          if (!dyad) return null;
          const {
            aToB: _aToB,
            bToA: _bToA,
            aToBMeasures: _aToBMeasures,
            bToAMeasures: _bToAMeasures,
            ...summary
          } = dyad;
          return summary;
        })();
        const dyadEvidence = selected.mind.rels.evidenceForDyadInGameTimeRange(
          aId,
          bId,
          projection.window.startGameTime,
          projection.window.endGameTime,
        );
        const evidenceTimeline = dyadEvidence.map((item) => ({
          ...item,
          direction: item.agentA === aId
            ? `${residents.get(aId)} → ${residents.get(bId)}`
            : `${residents.get(bId)} → ${residents.get(aId)}`,
        }));
        const choiceEvents = choices
          .filter((item) => item.gameTime >= projection.window.startGameTime && (
            (item.fromId === aId && item.toId === bId) || (item.fromId === bId && item.toId === aId)
          ))
          .sort((left, right) => right.gameTime - left.gameTime);
        const runtimeConversations = new Map(selected.mind.dialogue.activeSessions()
          .map((conversation) => [conversation.conversationId, conversation]));
        const conversations = selected.mind.store.conversationsFor(aId, 100)
          .filter((conversation) => conversation.participants.includes(bId)
            && conversation.updatedGameTime >= projection.window.startGameTime
            && conversation.startedGameTime <= projection.window.endGameTime)
          .map((conversation) => ({
            ...conversation,
            runtime: runtimeConversations.get(conversation.id) ?? null,
            participants: conversation.participants.map((id) => ({ id, name: residents.get(id) ?? id })),
            messages: conversation.messages
              .filter((message) => message.gameTime >= projection.window.startGameTime
                && message.gameTime <= projection.window.endGameTime)
              .map((message) => ({
                ...message,
                fromName: residents.get(message.fromAgent) ?? message.fromAgent,
                toName: residents.get(message.toAgent) ?? message.toAgent,
              })),
          }))
          .filter((conversation) => conversation.messages.length > 0)
          .slice(0, 30);
        const totalEvidence = selected.mind.rels.countEvidenceForDyadInGameTimeRange(
          aId,
          bId,
          projection.window.startGameTime,
          projection.window.endGameTime,
        );
        const earliestLoaded = dyadEvidence.at(-1)?.gameTime ?? null;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          schemaVersion: 'social-dyad.response/v2',
          worldId: selected.meta.id,
          modelVersion: projection.modelVersion,
          generatedGameTime: projection.generatedGameTime,
          window: projection.window,
          proxyNotice: projection.proxyNotice,
          measureSchema: projection.measureSchema,
          dataQuality: projection.dataQuality,
          scope: { source: 'local_event_log', validatedRun: null },
          people: {
            a: { id: aId, name: residents.get(aId) },
            b: { id: bId, name: residents.get(bId) },
          },
          aToB: directionSummary(aToB),
          bToA: directionSummary(bToA),
          dyad: dyadSummary,
          evidenceSummary: {
            totalCount: totalEvidence,
            loadedCount: dyadEvidence.length,
            returnedCount: evidenceTimeline.length,
            truncated: totalEvidence > dyadEvidence.length,
            earliestLoaded,
          },
          evidenceTimeline,
          choiceEvents,
          conversations,
        }));
        return;
      }
      if (url.pathname.startsWith('/api/relationships/') && req.method === 'GET') {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/relationships/'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (!selected.mind.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const names = new Map(selected.world.allAgents().map((agent) => [agent.id, agent.name]));
        if (!names.has(id)) {
          res.writeHead(404);
          res.end('未知居民');
          return;
        }
        const window = relationshipWindow(url.searchParams.get('windowDays'));
        if (!window.valid) {
          res.writeHead(400);
          res.end('windowDays 必须是 1..3650 或 all');
          return;
        }
        const now = selected.time.state.totalMinutes;
        const evidence = selected.mind.rels.evidenceInGameTimeRange(0, now);
        const projection = projectSocialRelationships(
          selected.mind.rels.allPairs(),
          evidence,
          names,
          now,
          {
            windowDays: window.days,
            choices: partnerChoiceObservations(selected.log, now),
          },
        );
        const directionByOther = new Map(projection.directions
          .filter((direction) => direction.fromId === id)
          .map((direction) => [direction.toId, direction]));
        const dyadByOther = new Map(projection.dyads
          .filter((dyad) => dyad.aId === id || dyad.bId === id)
          .map((dyad) => [dyad.aId === id ? dyad.bId : dyad.aId, dyad]));
        const outgoingByOther = new Map(selected.mind.rels.allFor(id).map((relation) => [relation.agentB, relation]));
        const otherIds = new Set([...outgoingByOther.keys(), ...dyadByOther.keys()]);
        const relations = [...otherIds].map((otherId) => {
          const legacy = outgoingByOther.get(otherId);
          const direction = directionByOther.get(otherId);
          const dyad = dyadByOther.get(otherId);
          const reverseDirection = projection.directions.find((candidate) => (
            candidate.fromId === otherId && candidate.toId === id
          ));
          return {
            otherId,
            otherName: names.get(otherId) ?? otherId,
            affection: legacy?.affection ?? 0,
            respect: legacy?.respect ?? 0,
            knowledgeCount: legacy?.knowledge.length ?? 0,
            direction: direction ?? null,
            reverseDirection: reverseDirection ?? null,
            reciprocity: dyad?.reciprocity ?? 0,
            asymmetry: dyad?.asymmetry ?? 1,
            measures: dyad?.measures ?? null,
            aToBMeasures: dyad?.aId === id ? dyad.aToBMeasures : dyad?.bToAMeasures ?? null,
            bToAMeasures: dyad?.aId === id ? dyad.bToAMeasures : dyad?.aToBMeasures ?? null,
            dyadType: dyad?.tieType ?? 'asymmetric',
            dyadLabel: dyad?.tieLabel ?? '证据稀疏画像',
          };
        }).sort((left, right) => (
          Math.max(right.direction?.strength ?? 0, right.reverseDirection?.strength ?? 0)
          - Math.max(left.direction?.strength ?? 0, left.reverseDirection?.strength ?? 0)
        ) || left.otherId.localeCompare(right.otherId));
        const standingMap = computeStanding(selected.mind.rels.allPairs());
        for (const agent of selected.world.allAgents()) if (!standingMap.has(agent.id)) standingMap.set(agent.id, 0);
        const standings = [...standingMap.entries()]
          .map(([sid, score]) => ({ id: sid, name: selected.world.allAgents().find((a) => a.id === sid)?.name ?? sid, score }))
          .sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          worldId: selected.meta.id,
          modelVersion: projection.modelVersion,
          generatedGameTime: projection.generatedGameTime,
          window: projection.window,
          proxyNotice: projection.proxyNotice,
          measureSchema: projection.measureSchema,
          dataQuality: projection.dataQuality,
          relations,
          standings,
        }));
        return;
      }
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/mind') && req.method === 'GET') {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/mind'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (!selected.mind) {
          res.writeHead(404);
          res.end('mind 未启用');
          return;
        }
        const agentNames = new Map(selected.world.allAgents().map((agent) => [agent.id, agent.name]));
        const runtimeConversations = new Map(selected.mind.dialogue.activeSessions()
          .map((conversation) => [conversation.conversationId, conversation]));
        const conversations = selected.mind.store.conversationsFor(id, 20).map((conversation) => ({
          ...conversation,
          runtime: runtimeConversations.get(conversation.id) ?? null,
          participants: conversation.participants.map((participantId) => ({
            id: participantId,
            name: agentNames.get(participantId) ?? participantId,
          })),
          messages: conversation.messages.map((message) => ({
            ...message,
            fromName: agentNames.get(message.fromAgent) ?? message.fromAgent,
            toName: agentNames.get(message.toAgent) ?? message.toAgent,
          })),
        }));
        const body: {
          worldId: string; memories: unknown[]; reflections: unknown[]; plans: unknown[];
          dialogues: unknown[]; conversations: unknown[];
        } = {
          worldId: selected.meta.id,
          memories: selected.mind.store.recentMemories(id, 50),
          reflections: selected.mind.store.reflectionsFor(id),
          plans: [], // 计划列表：取当天与前一天
          dialogues: selected.mind.store.messagesFor(id, 50),
          conversations,
        };
        for (let day = Math.floor(selected.time.state.totalMinutes / 1440) + 1; day >= 1 && body.plans.length < 4; day--) {
          const p = selected.mind.store.planFor(id, day);
          if (p) body.plans.push(p);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
        return;
      }
      if (url.pathname.startsWith('/api/guest/login') && req.method === 'POST') {
        const body = (await readBody(req)) as { name?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : '';
        if (!name) { res.writeHead(400); res.end('名字不能为空'); return; }
        const selected = hub();
        let guest = selected.world.allAgents().find((agent) => agent.id === `agent:${name}`);
        if (!guest) {
          guest = createGuestAgent(name);
          selected.world.addAgent(guest);
          if (selected.db) hydrateWorld(selected.db, selected.world);
          selected.log.addEvent({
            id: randomUUID(), type: 'system', actorId: guest.id, targetIds: [],
            description: `访客「${name}」登录了小镇。`, location: 'obj:plaza',
            gameTime: selected.time.state.totalMinutes, payload: { kind: 'guest_login', name },
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: guest.id, x: guest.x, y: guest.y }));
        return;
      }
      if (url.pathname === '/api/guest/look' && req.method === 'GET') {
        const name = decodeURIComponent(url.searchParams.get('name') ?? '');
        const selected = hub();
        const guest = selected.world.allAgents().find((a) => a.id === `agent:${name}`);
        if (!guest) { res.writeHead(404); res.end('访客未登录'); return; }
        const nearby = selected.world.allAgents()
          .filter((a) => a.id !== guest.id && Math.max(Math.abs(a.x - guest.x), Math.abs(a.y - guest.y)) <= 3)
          .map((a) => ({ id: a.id, name: a.name, state: a.state, verb: a.action?.action.verb ?? '' }));
        const spot = selected.world.objectAt({ x: guest.x, y: guest.y });
        const perceptions = perceptionByWorld.get(selected.meta.id)?.drain(guest.id) ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, x: guest.x, y: guest.y, location: `${spot?.name ?? '小镇'}`, nearby, perceptions }));
        return;
      }
      if (url.pathname.startsWith('/api/guest/act') && req.method === 'POST') {
        const body = (await readBody(req)) as { name?: unknown; action?: unknown; target?: unknown; text?: unknown };
        const name = typeof body.name === 'string' ? body.name : '';
        const action = typeof body.action === 'string' ? body.action : '';
        const target = typeof body.target === 'string' ? body.target : '';
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        const guest = hub().world.allAgents().find((a) => a.id === `agent:${name}`);
        if (!guest) { res.writeHead(404); res.end('访客未登录'); return; }
        if (!hub().player) { res.writeHead(404); res.end('扮演未启用'); return; }
        const now = hub().time.state.totalMinutes;
        if (action === 'say' && text) {
          hub().log.addEvent({
            id: randomUUID(), type: 'chat', actorId: guest.id, targetIds: [],
            description: `「${guest.name}」说：「${text}」`, location: guest.locationId,
            gameTime: now, payload: { kind: 'chat', line: text, fromId: guest.id, toId: null },
          });
          const other = hub().world.allAgents()
            .filter((a) => a.id !== guest.id && Math.max(Math.abs(a.x - guest.x), Math.abs(a.y - guest.y)) <= 3)
            .sort((a, b) => (Math.abs(a.x - guest.x) + Math.abs(a.y - guest.y)) - (Math.abs(b.x - guest.x) + Math.abs(b.y - guest.y)))[0];
          if (other && hub().mind && !hub().mind.dialogue.isActive(guest.id, other.id)) {
            hub().mind.dialogue.start(guest, other, now, { world: hub().world });
            void other;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if ((action === 'walk' || action === 'interact') && target) {
          const obj = hub().world.allObjects().find((o) => o.id === target || o.name === target);
          const instruction = obj ? `去${obj.name}（${obj.id}）` : `去${target}`;
          hub().player?.act(guest.id, instruction, now);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(400);
        res.end('action 需为 walk/interact（含 target）或 say（含 text）');
        return;
      }
      if (url.pathname === '/api/workspace' && req.method === 'GET') {
        if (!opts.workspace) { res.writeHead(404); res.end('工作空间管理未启用'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          workspace: opts.workspace.current.meta,
          templates: WORLD_TEMPLATE_CATALOG,
          active: activeId,
          worlds: (hubWorlds ?? [hub()]).map((world) => world.meta),
          safety: llmConfigurationSafety(),
        }));
        return;
      }
      if (url.pathname === '/api/workspace' && req.method === 'POST') {
        if (!opts.workspace) { res.writeHead(404); res.end('工作空间管理未启用'); return; }
        await settlePausedCognition();
        const safety = llmConfigurationSafety();
        if (!safety.ready) { res.writeHead(409); res.end(safety.reasons.join('；')); return; }
        const body = await readBody(req);
        clearHubResources();
        try {
          const built = await opts.workspace.replace(body);
          const activatedWorlds = activateWorkspace(built);
          opts.runtimeLog?.info(
            'workspace',
            `工作空间已加载 id=${built.meta.id} worlds=${built.meta.worldIds.join(',')} paused=${paused}`,
          );
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            workspace: built.meta,
            active: activeId,
            worlds: activatedWorlds.map((world) => world.meta),
          }));
        } catch (error) {
          restoreCurrentWorkspaceBindings();
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '工作空间配置无效');
        }
        return;
      }
      if (url.pathname === '/api/workspace/reset' && req.method === 'POST') {
        if (!opts.workspace) { res.writeHead(404); res.end('工作空间管理未启用'); return; }
        const body = (await readBody(req)) as { workspaceId?: unknown };
        const previous = opts.workspace.current.meta;
        if (typeof body.workspaceId !== 'string' || body.workspaceId !== previous.id) {
          res.writeHead(409);
          res.end('当前工作空间已经变化，请刷新状态后再重置');
          return;
        }
        const safety = await quiesceWorkspaceForMutation();
        if (!safety.ready) { res.writeHead(409); res.end(safety.reasons.join('；')); return; }
        const resetConfig = {
          name: previous.name,
          seed: previous.seed,
          worldSpeed: previous.worldSpeed,
          defaultExperimentDays: previous.defaultExperimentDays,
          worldKinds: [...previous.worldKinds],
          startPaused: true,
        };
        clearHubResources();
        try {
          const built = await opts.workspace.replace(resetConfig);
          const activatedWorlds = activateWorkspace(built);
          const previousPersisted = previous.databaseBasePath !== ':memory:';
          opts.runtimeLog?.info(
            'workspace',
            `工作空间已按同配置重新开始 previous=${previous.id} current=${built.meta.id} archived=${previousPersisted}`,
          );
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            workspace: built.meta,
            active: activeId,
            worlds: activatedWorlds.map((world) => world.meta),
            previous: {
              id: previous.id,
              databaseBasePath: previous.databaseBasePath,
              runtimeLogPath: previous.runtimeLogPath,
              persisted: previousPersisted,
            },
          }));
        } catch (error) {
          restoreCurrentWorkspaceBindings();
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '工作空间重置失败');
        }
        return;
      }
      if (url.pathname === '/api/workspace' && req.method === 'DELETE') {
        if (!opts.workspace) { res.writeHead(404); res.end('工作空间管理未启用'); return; }
        const body = (await readBody(req)) as {
          workspaceId?: unknown;
          confirmationName?: unknown;
          exportAcknowledged?: unknown;
        };
        const previous = opts.workspace.current.meta;
        if (typeof body.workspaceId !== 'string' || body.workspaceId !== previous.id) {
          res.writeHead(409);
          res.end('当前工作空间已经变化，请刷新状态后再删除');
          return;
        }
        if (typeof body.confirmationName !== 'string' || body.confirmationName !== previous.name) {
          res.writeHead(400);
          res.end('请输入完整且完全一致的当前实验名称');
          return;
        }
        if (body.exportAcknowledged !== true) {
          res.writeHead(400);
          res.end('请先确认需要保留的数据已经导出');
          return;
        }
        const safety = await quiesceWorkspaceForMutation();
        if (!safety.ready) { res.writeHead(409); res.end(safety.reasons.join('；')); return; }
        const replacementConfig = {
          name: '未命名实验',
          seed: previous.seed,
          worldSpeed: previous.worldSpeed,
          defaultExperimentDays: previous.defaultExperimentDays,
          worldKinds: ['mem-on'],
          startPaused: true,
        };
        clearHubResources();
        try {
          const { built, archive } = await opts.workspace.replaceAndArchive(replacementConfig);
          const activatedWorlds = activateWorkspace(built);
          opts.runtimeLog?.info(
            'workspace',
            `实验已安全删除 previous=${previous.id} current=${built.meta.id} recoverable=${archive.recoverable} archive=${JSON.stringify(archive.archiveDirectory)}`,
          );
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            workspace: built.meta,
            active: activeId,
            worlds: activatedWorlds.map((world) => world.meta),
            deleted: {
              id: previous.id,
              name: previous.name,
              databaseBasePath: previous.databaseBasePath,
              runtimeLogPath: previous.runtimeLogPath,
            },
            archive,
          }));
        } catch (error) {
          restoreCurrentWorkspaceBindings();
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '实验安全删除失败');
        }
        return;
      }
      if (url.pathname === '/api/worlds' && req.method === 'GET') {
        const list = hubWorlds
          ? hubWorlds.map((x) => ({ ...x.meta, clock: `${x.time.state.day}天 ${x.time.state.minutesOfDay}分` }))
          : [{ ...hub().meta, clock: `${hub().time.state.day}天 ${hub().time.state.minutesOfDay}分` }];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true, active: activeId, worlds: list,
          workspaceId: opts.workspace?.current.meta.id ?? null,
          workspaceName: opts.workspace?.current.meta.name ?? null,
        }));
        return;
      }
      if (url.pathname === '/api/world/switch' && req.method === 'POST') {
        const body = (await readBody(req)) as { id?: unknown };
        const id = typeof body.id === 'string' ? body.id : '';
        if (hubWorlds && hubWorlds.some((x) => x.meta.id === id)) activeId = id;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, active: activeId }));
        return;
      }
      if (url.pathname === '/api/narrative' && req.method === 'GET') {
        // 叙事流：结构化事件（对话/行动/内心/馈礼/移动），供涌现酒馆前端渲染
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
        const limit = Math.min(500, Math.max(10, Number(url.searchParams.get('limit')) || 200));
        const from = selected.world.allAgents();
        const nameOf = (id: string | null) => from.find((a) => a.id === id)?.name ?? id ?? '';
        const recent = selected.log.recent(limit, selected.time.state.totalMinutes + 1)
          .filter((event) => event.payload?.kind !== 'action_decision_quality');
        const items = recent.map((e, i) => {
          const p = (e.payload ?? {}) as Record<string, unknown>;
          const kind = String(p.kind ?? '');
          return {
            seq: i,
            id: e.id,
            time: e.gameTime,
            day: Math.floor(e.gameTime / 1440) + 1,
            minute: e.gameTime % 1440,
            type: e.type,
            kind,
            actor: e.actorId,
            actorName: nameOf(e.actorId),
            target: e.targetIds[0] ?? null,
            targetName: nameOf(e.targetIds[0] ?? null),
            text: e.description,
            line: typeof p.line === 'string' ? p.line : null,
            thought: typeof p.thought === 'string' ? p.thought : null,
            mode: typeof p.mode === 'string' ? p.mode : null,
            chosen: typeof p.chosen === 'string' ? p.chosen : null,
            candidates: Array.isArray(p.candidates) ? p.candidates : null,
            interactionType: typeof p.interactionType === 'string' ? p.interactionType : null,
            interactionLabel: typeof p.interactionLabel === 'string' ? p.interactionLabel : null,
            icon: typeof p.icon === 'string' ? p.icon : null,
            source: typeof p.source === 'string' ? p.source : null,
            eventStatus: typeof p.status === 'string' ? p.status : null,
            objectId: typeof p.objectId === 'string' ? p.objectId : null,
            objectName: typeof p.objectName === 'string' ? p.objectName : null,
            venueId: typeof p.venueId === 'string' ? p.venueId : null,
            venueName: typeof p.venueName === 'string' ? p.venueName : null,
            participantCount: Array.isArray(p.participants) ? p.participants.filter((id): id is string => typeof id === 'string').length : 0,
            sourceObjectId: typeof p.sourceObjectId === 'string' ? p.sourceObjectId : null,
            sourceObjectName: typeof p.sourceObjectName === 'string' ? p.sourceObjectName : null,
            deliveryLocationId: typeof p.deliveryLocationId === 'string' ? p.deliveryLocationId : null,
            deliveryLocationName: typeof p.deliveryLocationName === 'string' ? p.deliveryLocationName : null,
            lifeCategory: typeof p.category === 'string' ? p.category : null,
            sensoryCues: Array.isArray(p.sensoryCues) ? p.sensoryCues.filter((cue): cue is string => typeof cue === 'string') : [],
            observerCount: Array.isArray(p.observerIds) ? p.observerIds.filter((id): id is string => typeof id === 'string').length : 0,
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, worldId: selected.meta.id, items }));
        return;
      }
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/profile') && req.method === 'PUT') {
        let agentId: string;
        try {
          agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/profile'.length));
        } catch {
          res.writeHead(400); res.end('居民 ID 无效'); return;
        }
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
        const controlledWorlds = hubWorlds ?? [selected];
        if (controlledWorlds.some((world) => !world.world.hasAgent(agentId))) {
          res.writeHead(404); res.end('居民不存在'); return;
        }
        if (controlledWorlds.some((world) => world.mind?.dialogue.isParticipantActive(agentId))) {
          res.writeHead(409); res.end('居民正在对话，请在本轮对话结束后保存档案'); return;
        }
        const body = (await readBody(req)) as { profile?: unknown };
        const rawProfile = body?.profile;
        let profiles: AgentProfileDefinition[];
        try {
          profiles = controlledWorlds.map((world) => {
            const agent = world.world.getAgent(agentId);
            const index = world.world.allAgents().findIndex((item) => item.id === agentId);
            return normalizeAgentProfile(rawProfile, agent, world.world, index);
          });
        } catch (error) {
          res.writeHead(400);
          res.end(error instanceof Error ? error.message : '居民档案无效');
          return;
        }
        const before = profileDefinitionOf(selected.world.getAgent(agentId), selected.world.allAgents().findIndex((item) => item.id === agentId));
        const changedFields = Object.keys(before).filter((key) => (
          JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(profiles[0][key as keyof typeof profiles[0]])
        ));
        controlledWorlds.forEach((world, index) => {
          applyAgentProfile(world.world, agentId, profiles[index]);
          if (world.db) hydrateWorld(world.db, world.world);
          const hash = profileSetHash(world.world);
          world.log.addEvent({
            id: randomUUID(), type: 'system', actorId: agentId, targetIds: [agentId],
            description: `${profiles[index].name}的研究档案已更新。`, location: world.world.getAgent(agentId).locationId,
            gameTime: world.time.state.totalMinutes,
            payload: {
              kind: 'agent_profile_updated', fromId: agentId, toId: agentId,
              changedFields, profileHash: hash, scope: 'loaded_worlds', memoryAgentIds: [],
            },
          });
        });
        if (opts.profileStorePath) {
          const sourceWorld = controlledWorlds[0].world;
          const persisted = Object.fromEntries(sourceWorld.allAgents()
            .filter((agent) => controlledWorlds.every((world) => world.world.hasAgent(agent.id)))
            .map((agent, index) => [agent.id, profileDefinitionOf(agent, index)]));
          saveAgentProfileConfig(opts.profileStorePath, persisted);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          scope: 'loaded_worlds',
          worldIds: controlledWorlds.map((world) => world.meta.id),
          profile: profiles[0],
          profileHash: profileSetHash(selected.world),
          changedFields,
        }));
        return;
      }
      if (url.pathname === '/api/social/interact' && req.method === 'POST') {
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
        const body = (await readBody(req)) as { actorId?: unknown; targetId?: unknown; interactionType?: unknown };
        const actorId = typeof body.actorId === 'string' ? body.actorId : '';
        const targetId = typeof body.targetId === 'string' ? body.targetId : '';
        const interactionType = typeof body.interactionType === 'string' ? body.interactionType : '';
        const definition = socialInteractionDefinition(interactionType);
        if (!actorId || !targetId || actorId === targetId || !definition) {
          res.writeHead(400); res.end('互动双方或互动类型无效'); return;
        }
        if (!selected.world.hasAgent(actorId) || !selected.world.hasAgent(targetId)) {
          res.writeHead(404); res.end('互动居民不存在'); return;
        }
        if (selected.mind.dialogue.isParticipantActive(actorId) || selected.mind.dialogue.isParticipantActive(targetId)) {
          res.writeHead(409); res.end('居民正在对话，请在本轮对话结束后发起互动'); return;
        }
        const event = performSocialInteraction({
          kind: definition.kind,
          actor: selected.world.getAgent(actorId),
          target: selected.world.getAgent(targetId),
          now: selected.time.state.totalMinutes,
          log: selected.log,
          rels: selected.mind.rels,
          source: 'researcher',
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, worldId: selected.meta.id, event, intervention: true }));
        return;
      }
      if (url.pathname.startsWith('/api/experiment/')) {
        if (url.pathname === '/api/experiment/state' && req.method === 'GET') {
          const selected = hubById(url.searchParams.get('worldId'));
          if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(selected.experiment
            ? { ...(selected.experiment.state() as object), worldId: selected.meta.id }
            : { available: false, worldId: selected.meta.id }));
          return;
        }
        if (url.pathname === '/api/experiment/config' && req.method === 'POST') {
          const selected = hubById(url.searchParams.get('worldId'));
          if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
          if (!selected.experiment) { res.writeHead(404); res.end('此世界不提供伙伴选择实验'); return; }
          const body = (await readBody(req)) as { mem?: unknown; gift?: unknown };
          const mem = body.mem === 'on' ? 'on' : 'off';
          const gift = body.gift === 'on' ? 'on' : 'off';
          selected.experiment.setConfig({ historyAccess: mem, giftExchange: gift });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worldId: selected.meta.id }));
          return;
        }
        if (url.pathname === '/api/experiment/start' && req.method === 'POST') {
          const selected = hubById(url.searchParams.get('worldId'));
          if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
          if (!selected.experiment) { res.writeHead(404); res.end('此世界不提供伙伴选择实验'); return; }
          const body = (await readBody(req)) as { days?: unknown };
          const days = typeof body.days === 'number' && body.days > 0 ? Math.min(365, Math.floor(body.days)) : 30;
          selected.experiment.start(days, selected.time.state.totalMinutes);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worldId: selected.meta.id }));
          return;
        }
        if (url.pathname === '/api/experiment/stop' && req.method === 'POST') {
          const selected = hubById(url.searchParams.get('worldId'));
          if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
          if (!selected.experiment) { res.writeHead(404); res.end('此世界不提供伙伴选择实验'); return; }
          selected.experiment.stop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worldId: selected.meta.id }));
          return;
        }
        if (url.pathname === '/api/experiment/metrics' && req.method === 'GET') {
          const selected = hubById(url.searchParams.get('worldId'));
          if (!selected) { res.writeHead(404); res.end('未知世界'); return; }
          const ids = selected.world.allAgents().map((a) => a.id);
          const choices: Choice[] = [];
          for (const e of selected.log.eventsOfKind('experiment_pair_choice', 0, selected.time.state.totalMinutes + 1)) {
            const p = e.payload as { kind?: string; fromId?: string; toId?: string } | null;
            if (p?.kind === 'experiment_pair_choice' && p.fromId && p.toId) {
              choices.push({ day: Math.floor(e.gameTime / 1440) + 1, from: p.fromId, to: p.toId });
            }
          }
          const m = metricsOf(choices, ids);
          const pairs = [...m.pairs.entries()].map(([k, v]) => ({ pair: k, count: v }));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            worldId: selected.meta.id,
            repeat: m.repeat,
            recip: m.recip,
            clus: m.clus,
            div: m.div,
            hhi: m.hhi,
            persistence: m.persistence,
            hub: m.hub,
            pairs,
          }));
          return;
        }
      }
      if (url.pathname === '/api/guest/map' && req.method === 'GET') {
        const dir = hub().world.allObjects()
          .filter((o) => o.type !== 'town')
          .map((o) => ({ id: o.id, name: o.name, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, places: dir }));
        return;
      }
      if (url.pathname === '/api/guest/status' && req.method === 'GET') {
        const name = decodeURIComponent(url.searchParams.get('name') ?? '');
        const guest = hub().world.allAgents().find((a) => a.id === `agent:${name}`);
        if (!guest) { res.writeHead(404); res.end('访客未登录'); return; }
        const spot = hub().world.objectAt({ x: guest.x, y: guest.y });
        const rels = hub().mind?.rels.allFor(guest.id).sort((a, b) => b.affection - a.affection).slice(0, 3)
          .map((r) => ({ other: r.agentB, affection: r.affection })) ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, name: guest.name, x: guest.x, y: guest.y, state: guest.state,
          verb: guest.action?.action.verb ?? '', location: spot?.name ?? '小镇', relations: rels }));
        return;
      }
      if (url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/act')) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/act'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        const selected = hubById(url.searchParams.get('worldId'));
        if (!selected) {
          res.writeHead(404);
          res.end('未知世界');
          return;
        }
        if (req.method === 'POST') {
          const body = (await readBody(req)) as { instruction?: unknown };
          const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 120) : '';
          if (!instruction) {
            res.writeHead(400);
            res.end('指令不能为空');
            return;
          }
          if (!selected.player) {
            res.writeHead(404);
            res.end('扮演未启用');
            return;
          }
          selected.player.act(id, instruction, selected.time.state.totalMinutes);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worldId: selected.meta.id }));
          return;
        }
        if (req.method === 'DELETE') {
          selected.player?.clear(id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worldId: selected.meta.id }));
          return;
        }
      }
      if (url.pathname === '/api/broadcast' && req.method === 'POST') {
        const body = (await readBody(req)) as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        if (!text) {
          res.writeHead(400);
          res.end('广播内容不能为空');
          return;
        }
        hub().log.addEvent({
          id: randomUUID(),
          type: 'broadcast',
          actorId: null,
          targetIds: hub().world.allAgents().map((a) => a.id),
          description: `小镇广播：${text}`,
          location: null,
          gameTime: hub().time.state.totalMinutes,
          payload: { kind: 'broadcast', text },
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/api/rumor' && req.method === 'POST') {
        const body = (await readBody(req)) as { text?: unknown; sourceId?: unknown };
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        const sourceId = typeof body.sourceId === 'string' ? body.sourceId : hub().world.allAgents()[0]?.id;
        if (!text || !sourceId || !hub().mind.rumors) {
          res.writeHead(400);
          res.end('谣言内容/来源无效');
          return;
        }
        const id = hub().mind.rumors.seed(sourceId, text, hub().time.state.totalMinutes);
        // 源头确定性高重要度记忆（不依赖 LLM 打分）
        hub().mind?.store.addMemory({ agentId: sourceId, kind: 'observation', content: `第${Math.floor(hub().time.state.totalMinutes / 1440) + 1}天 我知道了一个秘密：${text}`, importance: 9, createdGameTime: hub().time.state.totalMinutes });
        hub().log.addEvent({
          id: randomUUID(), type: 'system', actorId: sourceId, targetIds: [],
          description: `「${hub().world.getAgent(sourceId)?.name ?? sourceId}」听说了一个秘密：${text}`, location: null,
          gameTime: hub().time.state.totalMinutes, payload: { kind: 'rumor_seed', rumorId: id, text },
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      if (url.pathname === '/api/world/control' && req.method === 'POST') {
        const body = (await readBody(req)) as { action?: string; value?: number };
        const controlledWorlds = hubWorlds ?? [hub()];
        if (body.action === 'pause') {
          paused = true;
          if (controlledWorlds.length > 1) stopLoopGroup(controlledWorlds.map((world) => world.loop));
          else controlledWorlds[0].loop.stop();
        } else if (body.action === 'resume') {
          paused = false;
          if (controlledWorlds.length > 1) startLoopGroup(controlledWorlds.map((world) => world.loop));
          else controlledWorlds[0].loop.start();
        } else if (body.action === 'adaptive-speed' && opts.llm) {
          const performance = opts.llm.throughputSnapshot().sampleCount >= 2
            ? opts.llm.throughputSnapshot()
            : await opts.llm.calibrate();
          const timeline = timelineGovernor?.enableAdaptive(timelineWorlds());
          const speed = timeline?.selectedSpeed ?? performance.recommendedMaxWorldSpeed ?? 1;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, speed, performance, timeline }));
          return;
        } else if (
          body.action === 'speed' && typeof body.value === 'number'
          && Number.isFinite(body.value) && body.value > 0 && body.value <= MAX_WORLD_SPEED
        ) {
          timelineGovernor?.setManual(body.value, timelineWorlds());
          if (!timelineGovernor) {
            for (const world of controlledWorlds) world.time.gameMinutesPerTick = body.value * 0.5;
          }
        } else {
          res.writeHead(400);
          res.end('bad control');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
        const name = url.pathname.slice('/assets/'.length);
        if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/.test(name)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        return await file(res, resolve(publicDir, 'assets', name));
      }
      if (url.pathname === '/') return await file(res, resolve(publicDir, 'index.html'));
      if (url.pathname === '/stats.html') return await file(res, resolve(publicDir, 'stats.html'));
      if (url.pathname === '/logs.html') return await file(res, resolve(publicDir, 'logs.html'));
      if (url.pathname === '/client.js' || url.pathname === '/stats.js' || url.pathname === '/logs.js' || url.pathname === '/style.css') {
        return await file(res, resolve(publicDir, url.pathname.slice(1)));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      const message = e instanceof Error ? e.stack ?? e.message : String(e);
      opts.runtimeLog?.error('web', `${req.method ?? 'UNKNOWN'} ${url.pathname}: ${message}`);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(e instanceof Error ? e.message : String(e));
    }
  });

  async function file(res: ServerResponse, path: string): Promise<void> {
    const content = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  }
  async function readBody(req: IncomingMessage): Promise<unknown> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  opts.runtimeLog?.info('web', `研究控制台开始监听 http://127.0.0.1:${port}`);
  const interval = setInterval(() => {
    for (const snapshot of allSnapshots()) broadcast('snapshot', snapshot);
  }, snapshotMs);
  const timelineInterval = setInterval(() => {
    timelineGovernor?.reconcile(timelineWorlds());
  }, 2_000);
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.writableEnded || c.destroyed) clients.delete(c);
      else c.write(': ping\n\n');
    }
  }, 15_000);

  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        if (hubWorlds) {
          for (const w of hubWorlds) w.loop.stop();
        } else {
          hub().loop.stop();
        }
        clearHubResources();
        clearInterval(interval);
        clearInterval(timelineInterval);
        clearInterval(heartbeat);
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
