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
  let hubWorlds: HubAccess[] | null = null;
  if (opts.worlds && opts.worlds.length) {
    hubWorlds = (opts.worlds as HubAccess[]).map((w) => ({
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
  }
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
  let paused = false;

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
  const perceptionWorlds = hubWorlds ?? [hub()];
  for (const selected of perceptionWorlds) {
    perceptionByWorld.set(selected.meta.id, new PerceptionEngine(selected.world, selected.log));
  }
  const unsubLogs: (() => void)[] = [];
  if (hubWorlds) {
    for (const w of hubWorlds) unsubLogs.push(w.log.subscribe((e: GameEvent) => broadcast('event', { ...e, worldId: w.meta.id })));
  } else {
    unsubLogs.push(opts.log.subscribe((e: GameEvent) => broadcast('event', e)));
  }

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
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!hub().mind.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const standing = computeStanding(hub().mind.rels.allPairs());
        const list = [...standing.entries()]
          .map(([id, score]) => ({ id, name: hub().world.allAgents().find((a) => a.id === id)?.name ?? id, score }))
          .sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(list));
        return;
      }
      if (url.pathname === '/api/llm/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(opts.llm?.schedulerSnapshot() ?? {
          active: 0, queued: 0, maxConcurrent: 0, maxQueued: 0,
          oldestWaitMs: 0, backpressured: false, byPriority: {}, byScope: {},
          performance: {
            provider: 'none', sampleCount: 0, generationTokensPerSecond: null,
            effectiveTokensPerSecond: null, p50LatencyMs: null, p90LatencyMs: null,
            recommendedMaxWorldSpeed: null, burstMaxWorldSpeed: 360, confidence: 'unavailable',
          },
        }));
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
        const standings = [...computeStanding(selected.mind.rels.allPairs()).entries()]
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
            hub().mind.dialogue.start(guest, other, now);
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
      if (url.pathname === '/api/worlds' && req.method === 'GET') {
        const list = hubWorlds
          ? hubWorlds.map((x) => ({ ...x.meta, clock: `${x.time.state.day}天 ${x.time.state.minutesOfDay}分` }))
          : [{ ...hub().meta, clock: `${hub().time.state.day}天 ${hub().time.state.minutesOfDay}分` }];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, active: activeId, worlds: list }));
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
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, worldId: selected.meta.id, items }));
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
          const speed = performance.recommendedMaxWorldSpeed ?? 1;
          for (const world of controlledWorlds) world.time.gameMinutesPerTick = speed * 0.5;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, speed, performance }));
          return;
        } else if (
          body.action === 'speed' && typeof body.value === 'number'
          && Number.isFinite(body.value) && body.value > 0 && body.value <= 360
        ) {
          for (const world of controlledWorlds) world.time.gameMinutesPerTick = body.value * 0.5;
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
      if (url.pathname === '/client.js' || url.pathname === '/stats.js' || url.pathname === '/style.css') {
        return await file(res, resolve(publicDir, url.pathname.slice(1)));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(e instanceof Error ? e.message : String(e));
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
  const interval = setInterval(() => {
    for (const snapshot of allSnapshots()) broadcast('snapshot', snapshot);
  }, snapshotMs);
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
          for (const u of unsubLogs) u();
        } else {
          hub().loop.stop();
          for (const u of unsubLogs) u();
        }
        for (const perception of perceptionByWorld.values()) perception.dispose();
        clearInterval(interval);
        clearInterval(heartbeat);
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
