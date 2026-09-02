import type { LLMRequestPriority } from '../llm/types';

export const RUNTIME_SOAK_CONTRACT_NAMES = [
  'provider.real',
  'normal.expected_conversations',
  'normal.terminal_valid',
  'normal.lifecycle_complete',
  'scheduler.pressure_observed_bounded',
  'timeout.actual_failure_observed',
  'timeout.fallback_completed',
  'database.integrity_and_timeline',
  'memory.stabilized',
  'teardown.clean',
] as const;

export type RuntimeSoakContractName = typeof RUNTIME_SOAK_CONTRACT_NAMES[number];

export interface ConversationEvidence {
  id: string;
  status: string;
  startedGameTime: number;
  endedGameTime: number | null;
  turnCount: number;
}

export interface LifecycleEvidence {
  conversationId: string;
  statuses: string[];
}

export interface SchedulerEvidence {
  sampleCount: number;
  maxConcurrent: number;
  maxQueued: number;
  peakActive: number;
  peakQueued: number;
  peakOldestActiveMs: number;
  peakOldestWaitMs: number;
  backpressureObserved: boolean;
  pressureReasons: string[];
  activeByPriority: Record<LLMRequestPriority, number>;
  queuedByPriority: Record<LLMRequestPriority, number>;
  byScope: Record<string, number>;
  overflowObserved: boolean;
  finalActive: number;
  finalQueued: number;
}

export interface DiagnosticEvidence {
  total: number;
  completed: number;
  failed: number;
  actualTimeoutFailures: number;
  byTemplate: Record<string, { completed: number; failed: number }>;
  byScope: Record<string, { completed: number; failed: number }>;
  errors: Array<{ template: string; scopeId: string; error: string }>;
}

export interface DatabaseAudit {
  label: string;
  path: string;
  integrityCheck: string[];
  conversationCount: number;
  expectedConversationCount: number;
  expectedCoverage: boolean;
  lifecycleCoverage: boolean;
  activeRows: number;
  endedBeforeStarted: number;
  orphanMessages: number;
  duplicateTurns: number;
  outOfOrderTurns: number;
  turnCountMismatches: number;
}

export interface MemorySample {
  label: string;
  wave: number | null;
  postGc: boolean;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export type MemoryAssessmentStatus = 'stabilized' | 'growing' | 'insufficient' | 'gc_unavailable';

export interface MemoryAssessment {
  status: MemoryAssessmentStatus;
  passed: boolean;
  gcAvailable: boolean;
  waves: number;
  waveSamples: number;
  postWarmupWaveSamples: number;
  firstRss: number | null;
  lastRss: number | null;
  maxRss: number | null;
  firstHeapUsed: number | null;
  lastHeapUsed: number | null;
  maxHeapUsed: number | null;
  postWarmupRssGrowth: number | null;
  postWarmupRssSlopeBytesPerWave: number | null;
  postWarmupHeapGrowth: number | null;
  postWarmupHeapSlopeBytesPerWave: number | null;
  rssGrowthThresholdBytes: number | null;
  rssSlopeThresholdBytesPerWave: number | null;
  heapGrowthThresholdBytes: number | null;
  heapSlopeThresholdBytesPerWave: number | null;
  rationale: string;
}

export interface RuntimeSoakAnalysisInput {
  provider: string;
  normalRunError: string | null;
  expectedNormalConversationIds: string[];
  normalConversations: ConversationEvidence[];
  normalLifecycle: LifecycleEvidence[];
  normalScopes: string[];
  simultaneousRequestsPerWave: number;
  scheduler: SchedulerEvidence;
  normalDiagnostics: DiagnosticEvidence;
  timeoutRunError: string | null;
  timeoutProvider: string;
  timeoutConversation: ConversationEvidence | null;
  timeoutLifecycle: LifecycleEvidence | null;
  timeoutSafeFallbackTurns: number;
  timeoutActiveSessions: number;
  timeoutDiagnostics: DiagnosticEvidence;
  databases: DatabaseAudit[];
  memory: MemoryAssessment;
  teardown: {
    normalSocialDisposed: boolean;
    normalMindDisposed: boolean;
    normalGatewayDrained: boolean;
    normalDatabasesClosed: boolean;
    timeoutSocialDisposed: boolean;
    timeoutDialogueDisposed: boolean;
    timeoutGatewayDrained: boolean;
    timeoutDatabaseClosed: boolean;
  };
}

export interface ContractResult {
  name: RuntimeSoakContractName;
  passed: boolean;
}

export function assessMemoryStability(
  samples: readonly MemorySample[],
  waves: number,
  gcAvailable: boolean,
): MemoryAssessment {
  const postGc = samples.filter((sample) => sample.postGc);
  const waveSamples = postGc
    .filter((sample) => sample.wave !== null)
    .sort((left, right) => (left.wave ?? 0) - (right.wave ?? 0));
  const samplesByWave = new Map<number, MemorySample>();
  for (const sample of waveSamples) {
    if (sample.wave !== null && !samplesByWave.has(sample.wave)) samplesByWave.set(sample.wave, sample);
  }
  const completeWaveSequence = Array.from({ length: waves }, (_, index) => index + 1)
    .every((wave) => samplesByWave.has(wave));
  const postWarmup = Array.from({ length: Math.max(0, waves - 1) }, (_, index) => samplesByWave.get(index + 2))
    .filter((sample): sample is MemorySample => sample !== undefined);
  const rss = postGc.map((sample) => sample.rss);
  const heaps = postGc.map((sample) => sample.heapUsed);
  const base = {
    gcAvailable,
    waves,
    waveSamples: waveSamples.length,
    postWarmupWaveSamples: postWarmup.length,
    firstRss: rss[0] ?? null,
    lastRss: rss.at(-1) ?? null,
    maxRss: rss.length ? Math.max(...rss) : null,
    firstHeapUsed: heaps[0] ?? null,
    lastHeapUsed: heaps.at(-1) ?? null,
    maxHeapUsed: heaps.length ? Math.max(...heaps) : null,
  };
  if (!gcAvailable) {
    return {
      ...base, status: 'gc_unavailable', passed: false,
      postWarmupRssGrowth: null, postWarmupRssSlopeBytesPerWave: null,
      postWarmupHeapGrowth: null, postWarmupHeapSlopeBytesPerWave: null,
      rssGrowthThresholdBytes: null, rssSlopeThresholdBytesPerWave: null,
      heapGrowthThresholdBytes: null, heapSlopeThresholdBytesPerWave: null,
      rationale: 'global.gc 不可用，不能把普通堆波动解释为稳定性证据；请使用 --expose-gc。',
    };
  }
  if (waves < 3 || !completeWaveSequence) {
    return {
      ...base, status: 'insufficient', passed: false,
      postWarmupRssGrowth: null, postWarmupRssSlopeBytesPerWave: null,
      postWarmupHeapGrowth: null, postWarmupHeapSlopeBytesPerWave: null,
      rssGrowthThresholdBytes: null, rssSlopeThresholdBytesPerWave: null,
      heapGrowthThresholdBytes: null, heapSlopeThresholdBytesPerWave: null,
      rationale: '少于 3 个波次或逐波次 post-GC 检查点不完整时只能作为开发冒烟，不能声称长运行内存稳定。',
    };
  }
  const first = postWarmup[0];
  const last = postWarmup.at(-1)!;
  const rssGrowth = last.rss - first.rss;
  const rssSlope = linearSlope(postWarmup.map((sample) => ({
    x: sample.wave ?? 0,
    y: sample.rss,
  })));
  const heapGrowth = last.heapUsed - first.heapUsed;
  const heapSlope = linearSlope(postWarmup.map((sample) => ({
    x: sample.wave ?? 0,
    y: sample.heapUsed,
  })));
  // wave 1 完全排除为热身；wave 2 是稳定区间基线。V8 对象堆允许至少 32 MiB
  // 净增长和 16 MiB/波；包含 SQLite、native 与缓冲区的 RSS 使用加倍的绝对余量。
  // 百分比余量同时照顾较大但稳定的进程，并仍会拒绝持续的原生或 JS 堆增长。
  const heapGrowthThreshold = Math.max(32 * 1024 * 1024, Math.round(first.heapUsed * 0.25));
  const heapSlopeThreshold = Math.max(16 * 1024 * 1024, Math.round(first.heapUsed * 0.12));
  const rssGrowthThreshold = Math.max(64 * 1024 * 1024, Math.round(first.rss * 0.25));
  const rssSlopeThreshold = Math.max(32 * 1024 * 1024, Math.round(first.rss * 0.12));
  const passed = heapGrowth <= heapGrowthThreshold
    && heapSlope <= heapSlopeThreshold
    && rssGrowth <= rssGrowthThreshold
    && rssSlope <= rssSlopeThreshold;
  return {
    ...base,
    status: passed ? 'stabilized' : 'growing',
    passed,
    postWarmupRssGrowth: rssGrowth,
    postWarmupRssSlopeBytesPerWave: rssSlope,
    postWarmupHeapGrowth: heapGrowth,
    postWarmupHeapSlopeBytesPerWave: heapSlope,
    rssGrowthThresholdBytes: rssGrowthThreshold,
    rssSlopeThresholdBytesPerWave: rssSlopeThreshold,
    heapGrowthThresholdBytes: heapGrowthThreshold,
    heapSlopeThresholdBytesPerWave: heapSlopeThreshold,
    rationale: 'wave 1 完全排除为热身；以 wave 2 为基线，对 RSS 与 heap 的净增长和线性斜率分别设保守门限并共同判定。',
  };
}

export function evaluateRuntimeSoakContracts(input: RuntimeSoakAnalysisInput): ContractResult[] {
  const expected = new Set(input.expectedNormalConversationIds);
  const observed = new Set(input.normalConversations.map((conversation) => conversation.id));
  const normalExpected = input.normalRunError === null
    && expected.size > 0
    && input.normalConversations.length === expected.size
    && [...expected].every((id) => observed.has(id));
  const normalTerminal = normalExpected && input.normalConversations.every((conversation) => (
    conversation.status === 'completed'
    && conversation.turnCount >= 4
    && conversation.turnCount <= 6
    && conversation.endedGameTime !== null
    && conversation.endedGameTime >= conversation.startedGameTime
  ));
  const lifecycleById = new Map(input.normalLifecycle.map((entry) => [entry.conversationId, entry.statuses]));
  const lifecycleComplete = normalExpected && [...expected].every((id) => (
    arraysEqual(lifecycleById.get(id) ?? [], ['queued', 'started', 'completed'])
  ));
  const scheduler = input.scheduler;
  const allScopesObserved = input.normalScopes.every((scope) => (scheduler.byScope[scope] ?? 0) > 0);
  const queueWasObservable = input.simultaneousRequestsPerWave <= 1 || scheduler.peakQueued > 0;
  const schedulerPassed = scheduler.sampleCount > 0
    && scheduler.peakActive > 0
    && scheduler.peakActive <= scheduler.maxConcurrent
    && scheduler.peakQueued <= scheduler.maxQueued
    && !scheduler.overflowObserved
    && scheduler.backpressureObserved
    && (scheduler.activeByPriority.dialogue > 0 || scheduler.queuedByPriority.dialogue > 0)
    && allScopesObserved
    && queueWasObservable;
  const timeoutFailure = input.timeoutRunError === null
    && input.timeoutProvider === 'ollama'
    && input.timeoutDiagnostics.actualTimeoutFailures > 0;
  const timeoutFallback = input.timeoutRunError === null
    && input.timeoutConversation?.status === 'completed'
    && input.timeoutConversation.turnCount >= 4
    && input.timeoutConversation.turnCount <= 6
    && input.timeoutSafeFallbackTurns > 0
    && input.timeoutActiveSessions === 0
    && arraysEqual(input.timeoutLifecycle?.statuses ?? [], ['queued', 'started', 'completed']);
  const databasePassed = input.databases.length > 0 && input.databases.every((audit) => (
    audit.integrityCheck.length > 0
    && audit.integrityCheck.every((result) => result.toLowerCase() === 'ok')
    && audit.conversationCount === audit.expectedConversationCount
    && audit.expectedCoverage
    && audit.lifecycleCoverage
    && audit.activeRows === 0
    && audit.endedBeforeStarted === 0
    && audit.orphanMessages === 0
    && audit.duplicateTurns === 0
    && audit.outOfOrderTurns === 0
    && audit.turnCountMismatches === 0
  ));
  const cleanTeardown = Object.values(input.teardown).every(Boolean)
    && scheduler.finalActive === 0
    && scheduler.finalQueued === 0;

  const values: Record<RuntimeSoakContractName, boolean> = {
    'provider.real': input.provider === 'ollama',
    'normal.expected_conversations': normalExpected,
    'normal.terminal_valid': normalTerminal,
    'normal.lifecycle_complete': lifecycleComplete,
    'scheduler.pressure_observed_bounded': schedulerPassed,
    'timeout.actual_failure_observed': timeoutFailure,
    'timeout.fallback_completed': timeoutFallback,
    'database.integrity_and_timeline': databasePassed,
    'memory.stabilized': input.memory.passed,
    'teardown.clean': cleanTeardown,
  };
  return RUNTIME_SOAK_CONTRACT_NAMES.map((name) => ({ name, passed: values[name] }));
}

/** JSON 报告不允许携带提示正文、消息数组或凭据，即使调用方意外扩展了对象。 */
export function serializeRuntimeSoakReport(report: unknown): string {
  return `${JSON.stringify(redactForRuntimeSoakReport(report), null, 2)}\n`;
}

export function redactForRuntimeSoakReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForRuntimeSoakReport);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:prompt|prompts|message|messages|content|api_?key|credential|credentials|password|secret|authorization)$/i.test(key)) {
        continue;
      }
      output[key] = redactForRuntimeSoakReport(item);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]');
  }
  return value;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function linearSlope(points: readonly { x: number; y: number }[]): number {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  return denominator === 0 ? 0 : Math.round(numerator / denominator);
}
