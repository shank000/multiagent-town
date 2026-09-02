import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { buildTown } from '../engine/seed';
import { DialogueEngine } from '../engine/dialogue';
import { createManagedWorld, type ManagedWorld } from '../engine/world-factory';
import { SocialTicker } from '../engine/social';
import { LLMGateway, type GatewayConfig, type LLMGatewayDiagnostic, type SchedulerSnapshot } from '../llm/gateway';
import { gatewayConfigFromEnv, providerNameFromEnv } from '../llm/provider-config';
import { DIALOGUE_SUMMARY_TEMPLATE, DIALOGUE_TEMPLATE } from '../llm/prompts';
import type { LLMRequestPriority } from '../llm/types';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { MemoryStore } from '../store/memory';
import { RelationshipStore } from '../store/relationships';
import {
  RUNTIME_SOAK_CONTRACT_NAMES,
  assessMemoryStability,
  evaluateRuntimeSoakContracts,
  serializeRuntimeSoakReport,
  type ConversationEvidence,
  type DatabaseAudit,
  type DiagnosticEvidence,
  type LifecycleEvidence,
  type MemorySample,
  type RuntimeSoakAnalysisInput,
  type SchedulerEvidence,
} from './runtime-soak-report';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_ROOT = join(REPO_ROOT, 'data');
const PRIORITIES: LLMRequestPriority[] = ['dialogue', 'action', 'planning', 'reflection', 'background'];

interface RuntimeSoakOptions {
  worlds: number;
  waves: number;
  pairsPerWorld: number;
  forcedTimeoutMs: number;
  outputPath: string;
  runDirectory: string;
}

interface PhaseTeardown {
  socialDisposed: boolean;
  engineDisposed: boolean;
  gatewayDrained: boolean;
  databasesClosed: boolean;
}

interface NormalPhaseResult {
  error: string | null;
  expectedIds: string[];
  conversations: ConversationEvidence[];
  lifecycle: LifecycleEvidence[];
  scopes: string[];
  scheduler: SchedulerEvidence;
  diagnostics: DiagnosticEvidence;
  databases: DatabaseAudit[];
  teardown: PhaseTeardown;
}

interface TimeoutPhaseResult {
  error: string | null;
  provider: string;
  conversation: ConversationEvidence | null;
  lifecycle: LifecycleEvidence | null;
  safeFallbackTurns: number;
  activeSessions: number;
  diagnostics: DiagnosticEvidence;
  databases: DatabaseAudit[];
  teardown: PhaseTeardown;
}

interface RuntimeSoakReport {
  schemaVersion: 1;
  generatedAt: string;
  options: {
    worlds: number;
    waves: number;
    pairsPerWorld: number;
    forcedTimeoutMs: number;
    outputPath: string;
  };
  runtime: {
    provider: string;
    model: string | null;
    smallModel: string | null;
    gcAvailable: boolean;
  };
  normal: Omit<NormalPhaseResult, 'databases' | 'teardown'>;
  timeout: Omit<TimeoutPhaseResult, 'databases' | 'teardown'>;
  databases: DatabaseAudit[];
  memory: {
    samples: MemorySample[];
    assessment: ReturnType<typeof assessMemoryStability>;
  };
  teardown: RuntimeSoakAnalysisInput['teardown'];
  contracts: ReturnType<typeof evaluateRuntimeSoakContracts>;
  passedContracts: number;
  totalContracts: 10;
  overallPassed: boolean;
}

class DiagnosticCollector {
  private events: LLMGatewayDiagnostic[] = [];

  readonly observe = (event: LLMGatewayDiagnostic): void => {
    this.events.push({
      ...event,
      error: event.error ? safeError(event.error) : null,
    });
  };

  evidence(): DiagnosticEvidence {
    const result: DiagnosticEvidence = {
      total: this.events.length,
      completed: 0,
      failed: 0,
      actualTimeoutFailures: 0,
      byTemplate: {},
      byScope: {},
      errors: [],
    };
    for (const event of this.events) {
      result[event.status] += 1;
      const template = result.byTemplate[event.template] ?? { completed: 0, failed: 0 };
      template[event.status] += 1;
      result.byTemplate[event.template] = template;
      const scope = result.byScope[event.scopeId] ?? { completed: 0, failed: 0 };
      scope[event.status] += 1;
      result.byScope[event.scopeId] = scope;
      if (event.status === 'failed' && event.error) {
        if (
          event.provider === 'ollama'
          && (event.template === DIALOGUE_TEMPLATE || event.template === DIALOGUE_SUMMARY_TEMPLATE)
          && /timeout|timed out|abort|deadline|超时|未完成生成/i.test(event.error)
        ) {
          result.actualTimeoutFailures += 1;
        }
        if (result.errors.length < 24) {
          result.errors.push({ template: event.template, scopeId: event.scopeId, error: event.error });
        }
      }
    }
    return result;
  }
}

class SchedulerCollector {
  private value: SchedulerEvidence = emptySchedulerEvidence();

  observe(snapshot: SchedulerSnapshot): void {
    this.value.sampleCount += 1;
    this.value.maxConcurrent = snapshot.maxConcurrent;
    this.value.maxQueued = snapshot.maxQueued;
    this.value.peakActive = Math.max(this.value.peakActive, snapshot.active);
    this.value.peakQueued = Math.max(this.value.peakQueued, snapshot.queued);
    this.value.peakOldestActiveMs = Math.max(this.value.peakOldestActiveMs, snapshot.oldestActiveMs);
    this.value.peakOldestWaitMs = Math.max(this.value.peakOldestWaitMs, snapshot.oldestWaitMs);
    this.value.backpressureObserved ||= snapshot.backpressured;
    if (snapshot.pressureReason && !this.value.pressureReasons.includes(snapshot.pressureReason)) {
      this.value.pressureReasons.push(snapshot.pressureReason);
    }
    for (const priority of PRIORITIES) {
      this.value.activeByPriority[priority] = Math.max(
        this.value.activeByPriority[priority],
        snapshot.activeByPriority[priority],
      );
      this.value.queuedByPriority[priority] = Math.max(
        this.value.queuedByPriority[priority],
        snapshot.byPriority[priority],
      );
    }
    for (const [scope, count] of Object.entries(snapshot.byScope)) {
      this.value.byScope[scope] = Math.max(this.value.byScope[scope] ?? 0, count);
    }
    this.value.overflowObserved ||= snapshot.active > snapshot.maxConcurrent || snapshot.queued > snapshot.maxQueued;
    this.value.finalActive = snapshot.active;
    this.value.finalQueued = snapshot.queued;
  }

  evidence(): SchedulerEvidence {
    return structuredClone(this.value);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (existsSync(options.outputPath) || existsSync(options.runDirectory)) {
    throw new Error(`runtime soak 只写入新路径，请更换 --output：${options.outputPath}`);
  }
  mkdirSync(options.runDirectory, { recursive: true });
  const memorySamples: MemorySample[] = [await takeMemorySample('process_start', null, false)];
  let provider = 'invalid';
  let config: GatewayConfig | null = null;
  let configError: string | null = null;
  try {
    process.env.LLM_PROVIDER ??= 'ollama';
    process.env.OLLAMA_PROFILE ??= 'qwen3-balanced';
    provider = providerNameFromEnv();
    if (provider === 'mock') throw new Error('runtime soak 禁止 provider=mock');
    if (provider !== 'ollama') {
      throw new Error('runtime soak 的真实超时合同要求 provider=ollama；不能用 API provider 代替');
    }
    config = gatewayConfigFromEnv();
  } catch (error) {
    configError = safeError(error);
  }

  let normal = emptyNormal(configError);
  let timeout = emptyTimeout(configError);
  if (config) {
    normal = await runNormalPhase(options, config, memorySamples);
    memorySamples.push(await takeMemorySample('after_normal_teardown', null, true));
    timeout = await runTimeoutPhase(options, config);
    memorySamples.push(await takeMemorySample('after_timeout_teardown', null, true));
  }

  const memory = assessMemoryStability(
    memorySamples,
    options.waves,
    typeof (globalThis as { gc?: unknown }).gc === 'function',
  );
  const teardown: RuntimeSoakAnalysisInput['teardown'] = {
    normalSocialDisposed: normal.teardown.socialDisposed,
    normalMindDisposed: normal.teardown.engineDisposed,
    normalGatewayDrained: normal.teardown.gatewayDrained,
    normalDatabasesClosed: normal.teardown.databasesClosed,
    timeoutSocialDisposed: timeout.teardown.socialDisposed,
    timeoutDialogueDisposed: timeout.teardown.engineDisposed,
    timeoutGatewayDrained: timeout.teardown.gatewayDrained,
    timeoutDatabaseClosed: timeout.teardown.databasesClosed,
  };
  const databases = [...normal.databases, ...timeout.databases];
  const analysis: RuntimeSoakAnalysisInput = {
    provider,
    normalRunError: normal.error,
    expectedNormalConversationIds: normal.expectedIds,
    normalConversations: normal.conversations,
    normalLifecycle: normal.lifecycle,
    normalScopes: normal.scopes,
    simultaneousRequestsPerWave: options.worlds * options.pairsPerWorld,
    scheduler: normal.scheduler,
    normalDiagnostics: normal.diagnostics,
    timeoutRunError: timeout.error,
    timeoutProvider: timeout.provider,
    timeoutConversation: timeout.conversation,
    timeoutLifecycle: timeout.lifecycle,
    timeoutSafeFallbackTurns: timeout.safeFallbackTurns,
    timeoutActiveSessions: timeout.activeSessions,
    timeoutDiagnostics: timeout.diagnostics,
    databases,
    memory,
    teardown,
  };
  const contracts = evaluateRuntimeSoakContracts(analysis);
  const passedContracts = contracts.filter((contract) => contract.passed).length;
  const runtime = config ? new LLMGateway({ ...config, retries: 0, maxConcurrent: 1, maxQueued: 4 }).runtimeSnapshot() : null;
  const report: RuntimeSoakReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    options: {
      worlds: options.worlds,
      waves: options.waves,
      pairsPerWorld: options.pairsPerWorld,
      forcedTimeoutMs: options.forcedTimeoutMs,
      outputPath: options.outputPath,
    },
    runtime: {
      provider,
      model: runtime?.model ?? null,
      smallModel: runtime?.smallModel ?? null,
      gcAvailable: memory.gcAvailable,
    },
    normal: {
      error: normal.error,
      expectedIds: normal.expectedIds,
      conversations: normal.conversations,
      lifecycle: normal.lifecycle,
      scopes: normal.scopes,
      scheduler: normal.scheduler,
      diagnostics: normal.diagnostics,
    },
    timeout: {
      error: timeout.error,
      provider: timeout.provider,
      conversation: timeout.conversation,
      lifecycle: timeout.lifecycle,
      safeFallbackTurns: timeout.safeFallbackTurns,
      activeSessions: timeout.activeSessions,
      diagnostics: timeout.diagnostics,
    },
    databases,
    memory: { samples: memorySamples, assessment: memory },
    teardown,
    contracts,
    passedContracts,
    totalContracts: 10,
    overallPassed: passedContracts === 10,
  };
  atomicWriteReport(options.outputPath, serializeRuntimeSoakReport(report));
  console.log(`RUNTIME_SOAK_REPORT ${options.outputPath}`);
  console.log(`RUNTIME_SOAK_CONTRACTS ${passedContracts}/10 ${contracts.map((contract) => `${contract.passed ? 'PASS' : 'FAIL'}:${contract.name}`).join(' ')}`);
  if (!report.overallPassed) process.exitCode = 1;
}

async function runNormalPhase(
  options: RuntimeSoakOptions,
  baseConfig: GatewayConfig,
  memorySamples: MemorySample[],
): Promise<NormalPhaseResult> {
  const diagnostics = new DiagnosticCollector();
  const scheduler = new SchedulerCollector();
  const scopes = Array.from({ length: options.worlds }, (_, index) => `runtime-soak-normal-w${index + 1}`);
  const queueSize = Math.max(4, options.worlds * options.pairsPerWorld * 2);
  const gateway = new LLMGateway({
    ...baseConfig,
    retries: 0,
    maxConcurrent: 1,
    maxQueued: queueSize,
    highWaterMark: Math.min(queueSize, Math.max(1, options.worlds * options.pairsPerWorld - 1)),
    lowWaterMark: 0,
    backpressureWaitMs: 100,
    backpressureResumeWaitMs: 25,
    onDiagnostic: diagnostics.observe,
  });
  const worlds: ManagedWorld[] = [];
  const expectedIds: string[] = [];
  const finalGameTimes = new Map<string, number>();
  const audits: DatabaseAuditWithSnapshots[] = [];
  const expectedIdsByWorld = new Map<ManagedWorld, string[]>();
  const teardown: PhaseTeardown = {
    socialDisposed: false,
    engineDisposed: false,
    gatewayDrained: false,
    databasesClosed: false,
  };
  let error: string | null = null;
  let sampler: ReturnType<typeof setInterval> | null = setInterval(() => scheduler.observe(gateway.schedulerSnapshot()), 10);
  try {
    for (let index = 0; index < options.worlds; index += 1) {
      const dbPath = join(options.runDirectory, `normal-world-${index + 1}.sqlite`);
      const managed = createManagedWorld(scopes[index], 'mem-on', {
        seed: 20_260_902 + index,
        gateway,
        dbPath,
      });
      worlds.push(managed);
    }
    memorySamples.push(await takeMemorySample('normal_baseline', null, true));
    let gameTime = 10;
    for (let wave = 1; wave <= options.waves; wave += 1) {
      const waveIds = new Map<ManagedWorld, string[]>();
      for (const world of worlds) {
        const agents = world.world.allAgents();
        const ids: string[] = [];
        for (let pair = 0; pair < options.pairsPerWorld; pair += 1) {
          const left = agents[pair * 2];
          const right = agents[pair * 2 + 1];
          const reservation = world.mind.dialogue.reserve(left, right, gameTime, {
            requireAdjacent: false,
            source: 'experiment',
            world: world.world,
          });
          ids.push(reservation.conversationId);
          expectedIds.push(reservation.conversationId);
          const accumulated = expectedIdsByWorld.get(world) ?? [];
          accumulated.push(reservation.conversationId);
          expectedIdsByWorld.set(world, accumulated);
        }
        waveIds.set(world, ids);
      }
      for (const world of worlds) world.mind.dialogue.dispatchReservations(world.world, gameTime);
      scheduler.observe(gateway.schedulerSnapshot());
      gameTime = await driveManagedDialogues(worlds, waveIds, gameTime, gateway, scheduler);
      await Promise.all(worlds.map((world) => world.mind.drain()));
      await gateway.drain();
      scheduler.observe(gateway.schedulerSnapshot());
      memorySamples.push(await takeMemorySample(`normal_wave_${wave}`, wave, true));
      for (const world of worlds) finalGameTimes.set(world.meta.id, gameTime);
      gameTime += 10;
    }
  } catch (phaseError) {
    error = safeError(phaseError);
  } finally {
    if (sampler) clearInterval(sampler);
    sampler = null;
    try {
      for (const world of worlds) world.social.dispose();
      teardown.socialDisposed = true;
    } catch (disposeError) {
      error ??= safeError(disposeError);
    }
    try {
      await Promise.all(worlds.map((world) => world.loop.drain()));
      await Promise.all(worlds.map((world) => world.mind.dispose({
        gameTime: finalGameTimes.get(world.meta.id) ?? 0,
        reason: 'runtime soak normal phase completed',
      })));
      teardown.engineDisposed = true;
    } catch (disposeError) {
      error ??= safeError(disposeError);
    }
    try {
      await gateway.drain();
      teardown.gatewayDrained = true;
    } catch (drainError) {
      error ??= safeError(drainError);
    }
    scheduler.observe(gateway.schedulerSnapshot());
    for (const world of worlds) {
      const ids = expectedIdsByWorld.get(world) ?? [];
      try {
        audits.push(auditDatabase(world.meta.id, world.dbPath, world.db.raw, ids));
      } catch (auditError) {
        error ??= safeError(auditError);
      }
    }
    let closeSucceeded = true;
    for (const world of worlds) {
      try { world.db.raw.close(); } catch { closeSucceeded = false; }
    }
    teardown.databasesClosed = closeSucceeded && worlds.length === options.worlds;
  }
  const auditedConversations = audits.flatMap((audit) => auditConversationSnapshot(audit));
  return {
    error,
    expectedIds,
    conversations: auditedConversations,
    lifecycle: audits.flatMap((audit) => auditLifecycleSnapshot(audit)),
    scopes,
    scheduler: scheduler.evidence(),
    diagnostics: diagnostics.evidence(),
    databases: audits.map(stripAuditSnapshots),
    teardown,
  };
}

async function runTimeoutPhase(options: RuntimeSoakOptions, baseConfig: GatewayConfig): Promise<TimeoutPhaseResult> {
  const diagnostics = new DiagnosticCollector();
  const gateway = new LLMGateway({
    ...baseConfig,
    retries: 0,
    maxConcurrent: 1,
    maxQueued: 4,
    onDiagnostic: diagnostics.observe,
  });
  const dbPath = join(options.runDirectory, 'timeout-world.sqlite');
  const db = openDb(dbPath);
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const rels = new RelationshipStore(db);
  const world = buildTown();
  const scopeId = 'runtime-soak-timeout';
  const dialogue = new DialogueEngine(gateway, store, log, 6, rels, undefined, {
    scopeId,
    turnTimeoutMs: options.forcedTimeoutMs,
    turnQueueTimeoutMs: Math.max(1_000, options.forcedTimeoutMs * 20),
    summaryTimeoutMs: options.forcedTimeoutMs,
    summaryQueueTimeoutMs: Math.max(1_000, options.forcedTimeoutMs * 20),
  });
  const social = new SocialTicker(log, {}, dialogue, rels);
  const teardown: PhaseTeardown = {
    socialDisposed: false,
    engineDisposed: false,
    gatewayDrained: false,
    databasesClosed: false,
  };
  let error: string | null = null;
  let conversationId = '';
  let conversation: ConversationEvidence | null = null;
  let lifecycle: LifecycleEvidence | null = null;
  let safeFallbackTurns = 0;
  let activeSessions = 0;
  let audit: DatabaseAudit | null = null;
  let gameTime = 20;
  try {
    const [left, right] = world.allAgents();
    conversationId = dialogue.reserve(left, right, gameTime, {
      requireAdjacent: false,
      source: 'manual',
      world,
    }).conversationId;
    dialogue.dispatchReservations(world, gameTime);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      gameTime += 2;
      dialogue.tick(world, 2, gameTime);
      const row = readConversation(db.raw, conversationId);
      if (row?.status === 'completed' && dialogue.activeSessions().length === 0) break;
      await delay(10);
    }
    await dialogue.drain();
    dialogue.tick(world, 0, gameTime);
    conversation = readConversation(db.raw, conversationId);
    if (conversation?.status !== 'completed') throw new Error('forced-timeout 会话未在 120 秒内完成 fallback 终态');
    lifecycle = readLifecycle(db.raw, conversationId);
    safeFallbackTurns = countSafeFallbackTurns(db.raw, conversationId);
    activeSessions = dialogue.activeSessions().length;
  } catch (phaseError) {
    error = safeError(phaseError);
  } finally {
    try {
      social.dispose();
      teardown.socialDisposed = true;
    } catch (disposeError) {
      error ??= safeError(disposeError);
    }
    try {
      await dialogue.terminate(gameTime, 'runtime soak timeout phase completed');
      await dialogue.drain();
      teardown.engineDisposed = true;
    } catch (disposeError) {
      error ??= safeError(disposeError);
    }
    try {
      await gateway.drain();
      teardown.gatewayDrained = true;
    } catch (drainError) {
      error ??= safeError(drainError);
    }
    if (conversationId) {
      conversation = readConversation(db.raw, conversationId);
      lifecycle = readLifecycle(db.raw, conversationId);
      safeFallbackTurns = countSafeFallbackTurns(db.raw, conversationId);
      activeSessions = dialogue.activeSessions().length;
    }
    try {
      audit = auditDatabase(scopeId, dbPath, db.raw, conversationId ? [conversationId] : []);
    } catch (auditError) {
      error ??= safeError(auditError);
    }
    try {
      db.raw.close();
      teardown.databasesClosed = true;
    } catch {
      teardown.databasesClosed = false;
    }
  }
  return {
    error,
    provider: gateway.runtimeSnapshot().provider,
    conversation,
    lifecycle,
    safeFallbackTurns,
    activeSessions,
    diagnostics: diagnostics.evidence(),
    databases: audit ? [stripAuditSnapshots(audit)] : [],
    teardown,
  };
}

async function driveManagedDialogues(
  worlds: readonly ManagedWorld[],
  expected: ReadonlyMap<ManagedWorld, readonly string[]>,
  initialGameTime: number,
  gateway: LLMGateway,
  scheduler: SchedulerCollector,
): Promise<number> {
  const expectedCount = [...expected.values()].reduce((sum, ids) => sum + ids.length, 0);
  const deadline = Date.now() + Math.max(120_000, expectedCount * 7 * 90_000);
  let gameTime = initialGameTime;
  while (Date.now() < deadline) {
    gameTime += 2;
    for (const world of worlds) world.mind.dialogue.tick(world.world, 2, gameTime);
    scheduler.observe(gateway.schedulerSnapshot());
    const completed = [...expected].every(([world, ids]) => ids.every((id) => (
      readConversation(world.db.raw, id)?.status === 'completed'
    )) && world.mind.dialogue.activeSessions().length === 0);
    if (completed) return gameTime;
    await delay(10);
  }
  throw new Error(`normal dialogue wave 未在截止时间内完成（expected=${expectedCount}）`);
}

interface DatabaseAuditWithSnapshots extends DatabaseAudit {
  _conversations?: ConversationEvidence[];
  _lifecycle?: LifecycleEvidence[];
}

function auditDatabase(
  label: string,
  path: string,
  db: DatabaseSync,
  expectedIds: readonly string[],
): DatabaseAuditWithSnapshots {
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as unknown as Array<Record<string, unknown>>;
  const integrityCheck = integrityRows.flatMap((row) => Object.values(row).map(String));
  const allConversations = db.prepare(
    `SELECT id, status, started_game_time, ended_game_time, turn_count
     FROM conversations ORDER BY rowid`,
  ).all() as unknown as Array<{
    id: string; status: string; started_game_time: number; ended_game_time: number | null; turn_count: number;
  }>;
  const conversations = allConversations.map((row) => ({
    id: row.id,
    status: row.status,
    startedGameTime: row.started_game_time,
    endedGameTime: row.ended_game_time,
    turnCount: row.turn_count,
  }));
  const lifecycle = expectedIds.map((id) => readLifecycle(db, id));
  const observedIds = new Set(conversations.map((conversation) => conversation.id));
  return {
    label,
    path,
    integrityCheck,
    conversationCount: conversations.length,
    expectedConversationCount: expectedIds.length,
    expectedCoverage: expectedIds.length > 0 && expectedIds.every((id) => observedIds.has(id)),
    lifecycleCoverage: expectedIds.length > 0 && lifecycle.every((entry) => (
      entry.statuses.join(',') === 'queued,started,completed'
    )),
    activeRows: scalarCount(db, "SELECT COUNT(*) AS n FROM conversations WHERE status = 'active'"),
    endedBeforeStarted: scalarCount(db, 'SELECT COUNT(*) AS n FROM conversations WHERE ended_game_time < started_game_time'),
    orphanMessages: scalarCount(db, `
      SELECT COUNT(*) AS n FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id IS NOT NULL AND c.id IS NULL
    `),
    duplicateTurns: scalarCount(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT conversation_id, turn_index FROM messages
        WHERE conversation_id IS NOT NULL
        GROUP BY conversation_id, turn_index HAVING COUNT(*) > 1
      )
    `),
    outOfOrderTurns: scalarCount(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT conversation_id, turn_index,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY turn_index, rowid) - 1 AS expected_turn
        FROM messages WHERE conversation_id IS NOT NULL
      ) WHERE turn_index IS NULL OR turn_index <> expected_turn
    `),
    turnCountMismatches: scalarCount(db, `
      SELECT COUNT(*) AS n FROM conversations c
      LEFT JOIN (
        SELECT conversation_id, COUNT(*) AS message_count
        FROM messages WHERE conversation_id IS NOT NULL GROUP BY conversation_id
      ) m ON m.conversation_id = c.id
      WHERE c.turn_count <> COALESCE(m.message_count, 0)
    `),
    _conversations: conversations,
    _lifecycle: lifecycle,
  };
}

function stripAuditSnapshots(audit: DatabaseAuditWithSnapshots): DatabaseAudit {
  const { _conversations: _ignoredConversations, _lifecycle: _ignoredLifecycle, ...publicAudit } = audit;
  return publicAudit;
}

function auditConversationSnapshot(audit: DatabaseAudit): ConversationEvidence[] {
  return (audit as DatabaseAuditWithSnapshots)._conversations ?? [];
}

function auditLifecycleSnapshot(audit: DatabaseAudit): LifecycleEvidence[] {
  return (audit as DatabaseAuditWithSnapshots)._lifecycle ?? [];
}

function readConversation(db: DatabaseSync, id: string): ConversationEvidence | null {
  const row = db.prepare(
    `SELECT id, status, started_game_time, ended_game_time, turn_count FROM conversations WHERE id = ?`,
  ).get(id) as unknown as {
    id: string; status: string; started_game_time: number; ended_game_time: number | null; turn_count: number;
  } | undefined;
  return row ? {
    id: row.id,
    status: row.status,
    startedGameTime: row.started_game_time,
    endedGameTime: row.ended_game_time,
    turnCount: row.turn_count,
  } : null;
}

function readLifecycle(db: DatabaseSync, conversationId: string): LifecycleEvidence {
  const rows = db.prepare(`
    SELECT json_extract(payload_json, '$.status') AS status
    FROM events
    WHERE json_extract(payload_json, '$.kind') = 'dialogue_lifecycle'
      AND json_extract(payload_json, '$.conversationId') = ?
    ORDER BY rowid
  `).all(conversationId) as unknown as Array<{ status: string }>;
  return { conversationId, statuses: rows.map((row) => String(row.status)) };
}

function countSafeFallbackTurns(db: DatabaseSync, conversationId: string): number {
  return scalarCount(db, `
    SELECT COUNT(*) AS n FROM events
    WHERE json_extract(payload_json, '$.kind') = 'chat'
      AND json_extract(payload_json, '$.conversationId') = ?
      AND json_extract(payload_json, '$.quality.status') = 'safe_fallback'
  `, conversationId);
}

function scalarCount(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as unknown as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

async function takeMemorySample(label: string, wave: number | null, stabilize: boolean): Promise<MemorySample> {
  const gc = (globalThis as { gc?: () => void }).gc;
  const postGc = stabilize && typeof gc === 'function';
  if (postGc) {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      gc();
      await new Promise<void>((resolveNow) => setImmediate(resolveNow));
    }
  }
  const usage = process.memoryUsage();
  return {
    label,
    wave,
    postGc,
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function parseArgs(args: readonly string[]): RuntimeSoakOptions {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const values = new Map<string, string>();
  const supported = new Set(['--worlds', '--waves', '--pairs-per-world', '--forced-timeout-ms', '--output']);
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (!supported.has(key)) throw new Error(`未知参数：${key ?? '(empty)'}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} 缺少值`);
    if (values.has(key)) throw new Error(`参数重复：${key}`);
    values.set(key, value);
  }
  const worlds = boundedInteger(values.get('--worlds') ?? '1', '--worlds', 1, 3);
  const waves = boundedInteger(values.get('--waves') ?? '3', '--waves', 1, 8);
  const pairsPerWorld = boundedInteger(values.get('--pairs-per-world') ?? '3', '--pairs-per-world', 1, 3);
  const forcedTimeoutMs = boundedInteger(values.get('--forced-timeout-ms') ?? '5', '--forced-timeout-ms', 1, 1_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawOutput = values.get('--output') ?? join('data', 'runtime-soak', stamp);
  const absolute = resolveOutput(rawOutput);
  const isJson = extname(absolute).toLowerCase() === '.json';
  const outputPath = isJson ? absolute : join(absolute, 'report.json');
  const runDirectory = isJson
    ? join(dirname(absolute), `${basename(absolute, extname(absolute))}-files`)
    : absolute;
  return { worlds, waves, pairsPerWorld, forcedTimeoutMs, outputPath, runDirectory };
}

function resolveOutput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('\0')) throw new Error('--output 必须是非空安全路径');
  const absolute = resolve(isAbsolute(trimmed) ? trimmed : join(REPO_ROOT, trimmed));
  const fromData = relative(DATA_ROOT, absolute);
  if (fromData === '' || fromData.startsWith('..') || isAbsolute(fromData)) {
    throw new Error(`--output 必须位于忽略提交的 data/ 目录内：${DATA_ROOT}`);
  }
  return absolute;
}

function boundedInteger(raw: string, label: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`${label} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum}..${maximum} 的整数`);
  }
  return value;
}

function atomicWriteReport(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

function safeError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 800);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function emptyPriorityRecord(): Record<LLMRequestPriority, number> {
  return { dialogue: 0, action: 0, planning: 0, reflection: 0, background: 0 };
}

function emptySchedulerEvidence(): SchedulerEvidence {
  return {
    sampleCount: 0,
    maxConcurrent: 1,
    maxQueued: 1,
    peakActive: 0,
    peakQueued: 0,
    peakOldestActiveMs: 0,
    peakOldestWaitMs: 0,
    backpressureObserved: false,
    pressureReasons: [],
    activeByPriority: emptyPriorityRecord(),
    queuedByPriority: emptyPriorityRecord(),
    byScope: {},
    overflowObserved: false,
    finalActive: 0,
    finalQueued: 0,
  };
}

function emptyDiagnosticEvidence(): DiagnosticEvidence {
  return { total: 0, completed: 0, failed: 0, actualTimeoutFailures: 0, byTemplate: {}, byScope: {}, errors: [] };
}

function emptyNormal(error: string | null): NormalPhaseResult {
  return {
    error,
    expectedIds: [],
    conversations: [],
    lifecycle: [],
    scopes: [],
    scheduler: emptySchedulerEvidence(),
    diagnostics: emptyDiagnosticEvidence(),
    databases: [],
    teardown: { socialDisposed: false, engineDisposed: false, gatewayDrained: false, databasesClosed: false },
  };
}

function emptyTimeout(error: string | null): TimeoutPhaseResult {
  return {
    error,
    provider: 'invalid',
    conversation: null,
    lifecycle: null,
    safeFallbackTurns: 0,
    activeSessions: 0,
    diagnostics: emptyDiagnosticEvidence(),
    databases: [],
    teardown: { socialDisposed: false, engineDisposed: false, gatewayDrained: false, databasesClosed: false },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function entrypoint(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const outputPath = fallbackFailureOutput(process.argv.slice(2));
    const contracts = RUNTIME_SOAK_CONTRACT_NAMES.map((name) => ({ name, passed: false }));
    atomicWriteReport(outputPath, serializeRuntimeSoakReport({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      error: safeError(error),
      contracts,
      passedContracts: 0,
      totalContracts: 10,
      overallPassed: false,
    }));
    console.error(`RUNTIME_SOAK_ERROR ${safeError(error)}`);
    console.log(`RUNTIME_SOAK_REPORT ${outputPath}`);
    process.exitCode = 1;
  }
}

function fallbackFailureOutput(args: readonly string[]): string {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const outputIndex = normalizedArgs.indexOf('--output');
  const candidate = outputIndex >= 0 ? normalizedArgs[outputIndex + 1] : undefined;
  if (candidate) {
    try {
      const absolute = resolveOutput(candidate);
      const output = extname(absolute).toLowerCase() === '.json' ? absolute : join(absolute, 'report.json');
      if (!existsSync(output)) return output;
    } catch {
      /* 非法输出路径不能扩大写入范围，回退到固定 ignored data 路径。 */
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(DATA_ROOT, 'runtime-soak', `invalid-${stamp}`, 'report.json');
}

await entrypoint();
