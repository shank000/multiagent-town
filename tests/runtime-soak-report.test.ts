import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_SOAK_CONTRACT_NAMES,
  assessMemoryStability,
  evaluateRuntimeSoakContracts,
  serializeRuntimeSoakReport,
  type DatabaseAudit,
  type DiagnosticEvidence,
  type MemorySample,
  type RuntimeSoakAnalysisInput,
} from '../src/cli/runtime-soak-report';

const MiB = 1024 * 1024;

function memory(label: string, wave: number | null, heapUsed: number, rss = 100 * MiB + heapUsed): MemorySample {
  return {
    label,
    wave,
    postGc: true,
    rss,
    heapUsed,
    heapTotal: 128 * MiB,
    external: MiB,
    arrayBuffers: 0,
  };
}

function diagnostics(actualTimeoutFailures = 0): DiagnosticEvidence {
  return {
    total: actualTimeoutFailures || 1,
    completed: actualTimeoutFailures ? 0 : 1,
    failed: actualTimeoutFailures,
    actualTimeoutFailures,
    byTemplate: {},
    byScope: {},
    errors: actualTimeoutFailures
      ? [{ template: 'dialogue/v1', scopeId: 'runtime-soak-timeout', error: 'deadline exceeded' }]
      : [],
  };
}

function audit(label: string, expected: number): DatabaseAudit {
  return {
    label,
    path: `data/runtime-soak/${label}.sqlite`,
    integrityCheck: ['ok'],
    conversationCount: expected,
    expectedConversationCount: expected,
    expectedCoverage: true,
    lifecycleCoverage: true,
    activeRows: 0,
    endedBeforeStarted: 0,
    orphanMessages: 0,
    duplicateTurns: 0,
    outOfOrderTurns: 0,
    turnCountMismatches: 0,
  };
}

function goodInput(): RuntimeSoakAnalysisInput {
  const ids = ['c1', 'c2', 'c3'];
  return {
    provider: 'ollama',
    normalRunError: null,
    expectedNormalConversationIds: ids,
    normalConversations: ids.map((id) => ({
      id, status: 'completed', startedGameTime: 10, endedGameTime: 20, turnCount: 4,
    })),
    normalLifecycle: ids.map((conversationId) => ({
      conversationId, statuses: ['queued', 'started', 'completed'],
    })),
    normalScopes: ['runtime-soak-normal-w1'],
    simultaneousRequestsPerWave: 3,
    scheduler: {
      sampleCount: 20,
      maxConcurrent: 1,
      maxQueued: 6,
      peakActive: 1,
      peakQueued: 2,
      peakOldestActiveMs: 100,
      peakOldestWaitMs: 80,
      backpressureObserved: true,
      pressureReasons: ['cognitive_sync'],
      activeByPriority: { dialogue: 1, action: 0, planning: 0, reflection: 0, background: 1 },
      queuedByPriority: { dialogue: 2, action: 0, planning: 0, reflection: 0, background: 1 },
      byScope: { 'runtime-soak-normal-w1': 3 },
      overflowObserved: false,
      finalActive: 0,
      finalQueued: 0,
    },
    normalDiagnostics: diagnostics(),
    timeoutRunError: null,
    timeoutProvider: 'ollama',
    timeoutConversation: { id: 'timeout', status: 'completed', startedGameTime: 20, endedGameTime: 28, turnCount: 4 },
    timeoutLifecycle: { conversationId: 'timeout', statuses: ['queued', 'started', 'completed'] },
    timeoutSafeFallbackTurns: 4,
    timeoutActiveSessions: 0,
    timeoutDiagnostics: diagnostics(4),
    databases: [audit('normal', 3), audit('timeout', 1)],
    memory: assessMemoryStability([
      memory('baseline', null, 40 * MiB),
      memory('wave1', 1, 48 * MiB),
      memory('wave2', 2, 50 * MiB),
      memory('wave3', 3, 51 * MiB),
    ], 3, true),
    teardown: {
      normalSocialDisposed: true,
      normalMindDisposed: true,
      normalGatewayDrained: true,
      normalDatabasesClosed: true,
      timeoutSocialDisposed: true,
      timeoutDialogueDisposed: true,
      timeoutGatewayDrained: true,
      timeoutDatabaseClosed: true,
    },
  };
}

function contract(input: RuntimeSoakAnalysisInput, name: typeof RUNTIME_SOAK_CONTRACT_NAMES[number]): boolean {
  return evaluateRuntimeSoakContracts(input).find((entry) => entry.name === name)?.passed ?? false;
}

test('good lifecycle evidence evaluates exactly the ten named contracts', () => {
  const contracts = evaluateRuntimeSoakContracts(goodInput());
  assert.deepEqual(contracts.map((entry) => entry.name), [...RUNTIME_SOAK_CONTRACT_NAMES]);
  assert.equal(contracts.length, 10);
  assert.ok(contracts.every((entry) => entry.passed));
});

test('missing or bad lifecycle evidence cannot pass lifecycle contracts', () => {
  const input = goodInput();
  input.normalLifecycle[1].statuses = ['queued', 'failed'];
  assert.equal(contract(input, 'normal.lifecycle_complete'), false);
  assert.equal(contract(input, 'normal.expected_conversations'), true);

  input.normalConversations[0].status = 'active';
  assert.equal(contract(input, 'normal.terminal_valid'), false);
});

test('queue overflow and absent timeout diagnostics fail their independent contracts', () => {
  const input = goodInput();
  input.scheduler.overflowObserved = true;
  input.scheduler.peakQueued = input.scheduler.maxQueued + 1;
  input.timeoutDiagnostics = diagnostics(0);
  assert.equal(contract(input, 'scheduler.pressure_observed_bounded'), false);
  assert.equal(contract(input, 'timeout.actual_failure_observed'), false);
  assert.equal(contract(input, 'timeout.fallback_completed'), true);
});

test('SQLite violations fail the combined integrity and timeline contract', () => {
  const input = goodInput();
  input.databases[0] = {
    ...input.databases[0],
    integrityCheck: ['row 12 missing'],
    activeRows: 1,
    endedBeforeStarted: 1,
    orphanMessages: 1,
    duplicateTurns: 1,
    outOfOrderTurns: 1,
    turnCountMismatches: 1,
  };
  assert.equal(contract(input, 'database.integrity_and_timeline'), false);
});

test('memory assessment distinguishes one-wave smoke, stable multi-wave, and sustained growth', () => {
  const oneWave = assessMemoryStability([memory('wave1', 1, 40 * MiB)], 1, true);
  assert.equal(oneWave.status, 'insufficient');
  assert.equal(oneWave.passed, false);

  const stable = assessMemoryStability([
    memory('wave1', 1, 400 * MiB, 700 * MiB),
    memory('wave2', 2, 44 * MiB),
    memory('wave3', 3, 45 * MiB),
  ], 3, true);
  assert.equal(stable.status, 'stabilized');
  assert.equal(stable.passed, true);
  assert.equal(stable.postWarmupWaveSamples, 2);
  assert.equal(stable.postWarmupHeapGrowth, MiB, 'wave 1 必须完全排除，wave 2 才是稳定区间基线');
  assert.equal(stable.postWarmupRssGrowth, MiB);
  assert.equal(typeof stable.heapGrowthThresholdBytes, 'number');
  assert.equal(typeof stable.rssGrowthThresholdBytes, 'number');

  const growing = assessMemoryStability([
    memory('wave1', 1, 40 * MiB),
    memory('wave2', 2, 80 * MiB),
    memory('wave3', 3, 125 * MiB),
  ], 3, true);
  assert.equal(growing.status, 'growing');
  assert.equal(growing.passed, false);

  const rssOnlyGrowth = assessMemoryStability([
    memory('wave1', 1, 50 * MiB, 160 * MiB),
    memory('wave2', 2, 50 * MiB, 200 * MiB),
    memory('wave3', 3, 50 * MiB, 280 * MiB),
  ], 3, true);
  assert.equal(rssOnlyGrowth.postWarmupHeapGrowth, 0);
  assert.equal(rssOnlyGrowth.postWarmupRssGrowth, 80 * MiB);
  assert.equal(rssOnlyGrowth.status, 'growing');
  assert.equal(rssOnlyGrowth.passed, false, 'SQLite/native/buffer RSS 单独持续增长也必须失败');
});

test('report serialization strips prompt bodies and credentials without deleting token counts', () => {
  const serialized = serializeRuntimeSoakReport({
    provider: 'ollama',
    durationMs: 1234,
    prompt: 'private prompt body',
    messages: [{ content: 'private user text' }],
    apiKey: 'secret-key',
    authorization: 'Bearer top.secret',
    inputTokens: 42,
    error: 'request failed at https://alice:password@localhost/api?token=secret',
  });
  assert.doesNotMatch(serialized, /private prompt body|private user text|secret-key|top\.secret|alice:password|token=secret/);
  assert.match(serialized, /"inputTokens": 42/);
  assert.match(serialized, /"durationMs": 1234/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotThrow(() => JSON.parse(serialized));
});
