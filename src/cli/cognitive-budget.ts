import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createManagedWorld } from '../engine/world-factory';
import { LLMGateway } from '../llm/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../llm/types';
import {
  ACTION_DECISION_TEMPLATE,
  DAILY_PLAN_TEMPLATE,
  DIALOGUE_SUMMARY_TEMPLATE,
  DIALOGUE_TEMPLATE,
  HOUR_PLAN_TEMPLATE,
  IMPORTANCE_TEMPLATE,
  REFLECTION_INSIGHTS_TEMPLATE,
  REFLECTION_JOURNAL_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE,
} from '../llm/prompts';

const DAYS = 2;
const AGENT_COUNT = 6;
const TICK_MINUTES = 5;
const DIALOGUE_TEMPLATES = new Set([DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE]);

export interface CognitiveBudgetResult {
  schemaVersion: 1;
  days: number;
  agents: number;
  tickMinutes: number;
  callsByTemplate: Record<string, number>;
  providerCallsByTemplate: Record<string, number>;
  nonDialogueCalls: number;
  dialogueCalls: number;
  providerAndGatewayCountsMatch: boolean;
  plansExpected: number;
  plansPresent: number;
  agendasPresent: number;
  dailyReflectionsExpected: number;
  dailyReflectionsPresent: number;
  persistedReflections: number;
  dialogueCompleted: boolean;
  dialogueTurns: number;
  thinkingAgents: number;
  schedulerActive: number;
  schedulerQueued: number;
  cognitionBudget: { modelRequests: number; groundedContinuations: number; playerBypasses: number };
}

/**
 * A deterministic provider used only to measure actual gateway completions. It returns contract-shaped
 * data without copying prompts or credentials into the report and deliberately runs in custom mode.
 */
export class CountingContractProvider implements LLMProvider {
  readonly name = 'counting-contract';
  private readonly calls = new Map<string, number>();

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls.set(request.template, (this.calls.get(request.template) ?? 0) + 1);
    const parsed = responseFor(request);
    return {
      content: JSON.stringify(parsed),
      parsed,
      usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 },
    };
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.calls].sort(([left], [right]) => left.localeCompare(right)));
  }
}

export async function runCognitiveBudgetHarness(): Promise<CognitiveBudgetResult> {
  const provider = new CountingContractProvider();
  const gateway = new LLMGateway({
    provider,
    retries: 0,
    maxConcurrent: 32,
    maxQueued: 4096,
    expectedActiveAgents: AGENT_COUNT,
  });
  const managed = createManagedWorld('cognitive-budget', 'mem-on', {
    seed: 1701,
    gameMinutesPerTick: TICK_MINUTES,
    gateway,
    dbPath: ':memory:',
  });
  const totalMinutes = DAYS * 1440;
  try {
    await managed.loop.runUntil(totalMinutes);
    await managed.mind.drain();
    const pair = managed.world.allAgents().slice(0, 2);
    const reservation = managed.mind.dialogue.reserve(pair[0], pair[1], totalMinutes, {
      requireAdjacent: false,
      source: 'manual',
      world: managed.world,
    });
    managed.mind.dialogue.dispatchReservations(managed.world, totalMinutes);
    for (let turn = 1; turn <= 16; turn += 1) {
      await managed.mind.dialogue.drain();
      managed.mind.dialogue.tick(managed.world, 2, totalMinutes + turn * 2);
      const conversation = managed.mind.store.conversationsFor(pair[0].id, 20)
        .find((item) => item.id === reservation.conversationId);
      if (conversation && conversation.status !== 'active') break;
    }
    await managed.mind.drain();
    await gateway.drain();

    const callsByTemplate = Object.fromEntries(gateway.metricSummary()
      .map((metric) => [metric.template, metric.calls] as const)
      .sort(([left], [right]) => left.localeCompare(right)));
    const providerCallsByTemplate = provider.snapshot();
    const allTemplates = new Set([...Object.keys(callsByTemplate), ...Object.keys(providerCallsByTemplate)]);
    const providerAndGatewayCountsMatch = [...allTemplates].every(
      (template) => (callsByTemplate[template] ?? 0) === (providerCallsByTemplate[template] ?? 0),
    );
    const nonDialogueCalls = Object.entries(callsByTemplate)
      .filter(([template]) => !DIALOGUE_TEMPLATES.has(template))
      .reduce((sum, [, calls]) => sum + calls, 0);
    const dialogueCalls = Object.entries(callsByTemplate)
      .filter(([template]) => DIALOGUE_TEMPLATES.has(template))
      .reduce((sum, [, calls]) => sum + calls, 0);
    const agents = managed.world.allAgents();
    const expectedPlans = agents.flatMap((agent) => Array.from({ length: DAYS }, (_, index) => ({ agent, day: index + 1 })));
    const plans = expectedPlans.map(({ agent, day }) => managed.mind.store.planFor(agent.id, day));
    const reflections = agents.flatMap((agent) => managed.mind.store.reflectionsFor(agent.id));
    const conversation = managed.mind.store.conversationsFor(pair[0].id, 20)
      .find((item) => item.id === reservation.conversationId);
    const scheduler = gateway.schedulerSnapshot();
    return {
      schemaVersion: 1,
      days: DAYS,
      agents: agents.length,
      tickMinutes: TICK_MINUTES,
      callsByTemplate,
      providerCallsByTemplate,
      nonDialogueCalls,
      dialogueCalls,
      providerAndGatewayCountsMatch,
      plansExpected: expectedPlans.length,
      plansPresent: plans.filter(Boolean).length,
      agendasPresent: plans.filter((plan) => (plan?.hourly.length ?? 0) > 0).length,
      dailyReflectionsExpected: agents.length * DAYS,
      dailyReflectionsPresent: agents.reduce((count, agent) => count + Array.from({ length: DAYS }, (_, index) => (
        managed.mind.store.dailyReflectionFor(agent.id, index + 1) ? 1 : 0
      )).reduce<number>((sum, value) => sum + value, 0), 0),
      persistedReflections: reflections.length,
      dialogueCompleted: conversation?.status === 'completed',
      dialogueTurns: conversation?.turnCount ?? 0,
      thinkingAgents: agents.filter((agent) => agent.state === 'thinking').length,
      schedulerActive: scheduler.active,
      schedulerQueued: scheduler.queued,
      cognitionBudget: managed.loop.cognitionBudgetSnapshot(),
    };
  } finally {
    managed.social.dispose();
    await managed.loop.drain();
    await managed.mind.dispose({ gameTime: managed.time.state.totalMinutes, reason: '认知预算计数完成' });
    await gateway.drain();
    managed.db.raw.close();
  }
}

function responseFor(request: LLMRequest): Record<string, unknown> {
  switch (request.template) {
    case ACTION_DECISION_TEMPLATE:
      return { thought: '我先观察周围，等待下一项安排。', action: { type: 'idle', target: null, verb: '观察周围' }, duration_minutes: 10 };
    case IMPORTANCE_TEMPLATE:
      return { importance: 5 };
    case DAILY_PLAN_TEMPLATE:
      return { option_ids: enumValuesAt(request.jsonSchema, ['properties', 'option_ids', 'items']).slice(0, 5) };
    case HOUR_PLAN_TEMPLATE: {
      const option = enumValuesAt(request.jsonSchema, ['properties', 'agenda', 'items', 'properties', 'option_id'])[0];
      const match = request.messages.map((message) => message.content).join('\n').match(/第\s*(\d{1,2})\s*点/u);
      return { agenda: option ? [{ time: `${String(Number(match?.[1] ?? 0)).padStart(2, '0')}:00`, option_id: option }] : [] };
    }
    case REFLECTION_QUESTIONS_TEMPLATE:
      return { questions: ['我今天履行了哪些安排？', '哪些互动值得继续关注？', '明天怎样保持稳定节奏？'] };
    case REFLECTION_INSIGHTS_TEMPLATE:
      return { insights: ['我注意到今天的行动都应以已发生的事情为依据。'] };
    case REFLECTION_JOURNAL_TEMPLATE: {
      const evidenceIds = evidenceIdsFrom(request);
      const questions = ['我今天履行了哪些安排？', '哪些互动值得继续关注？', '明天怎样保持稳定节奏？'];
      return {
        questions,
        diary: evidenceIds.length
          ? '今天我按小镇里的实际安排生活，也留意了行动和互动带来的变化。明天我会继续依据眼前事实稳步行动。'
          : '今天没有足够的事件证据可供总结。我会保持原有职责，并继续观察自己的状态。',
        mind_state: { valence: 0.1, energy: 0.7, stress: 0.2, social_need: 0.4, occupational_focus: 0.7, summary: '状态平稳，继续履行当前职责。' },
        insights: ['我应继续依据已经发生的事情调整行动。'],
        beliefs: evidenceIds.length ? [{ statement: '我应继续依据已经发生的事情调整行动。', confidence: 0.7, evidence_ids: evidenceIds.slice(0, 3), status: 'new', supersedes: null }] : [],
        revisions: [],
        behavior_guidance: ['按已确认的日计划继续行动。'],
      };
    }
    case DIALOGUE_TEMPLATE: {
      const text = request.messages.map((message) => message.content).join('\n');
      const turn = Number(text.match(/这是第\s*(\d+)\s*句/u)?.[1] ?? 1);
      const utterances = ['你好，今天过得怎么样？', '还算平稳，我正按安排做事。', '那就好，之后有空再聊聊。', '好，我先去忙，回头见。'];
      return { utterance: utterances[(turn - 1) % utterances.length], end_dialogue: turn >= 4 };
    }
    case DIALOGUE_SUMMARY_TEMPLATE:
      return { summary: '两位居民简短问候，并约定之后再聊。', affection_delta: 0.02, respect_delta: 0.01 };
    default:
      if (request.template === 'throughput_calibration') return { sample: '结构化吞吐校准。' };
      throw new Error(`计数 provider 不支持模板：${request.template}`);
  }
}

function enumValuesAt(schema: Record<string, unknown> | undefined, path: readonly string[]): string[] {
  let value: unknown = schema;
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    value = (value as Record<string, unknown>)[key];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const values = (value as Record<string, unknown>).enum;
  return Array.isArray(values) ? values.filter((item): item is string => typeof item === 'string') : [];
}

function evidenceIdsFrom(request: LLMRequest): string[] {
  const ids = new Set<string>();
  const joined = request.messages.map((message) => message.content).join('\n');
  for (const match of joined.matchAll(/\[([\w:-]{8,80})\]/gu)) ids.add(match[1]);
  return [...ids].slice(0, 5);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  runCognitiveBudgetHarness()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
