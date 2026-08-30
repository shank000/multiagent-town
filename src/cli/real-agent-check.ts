import { performance } from 'node:perf_hooks';
import type { Agent } from '../core/types';
import { actionDecisionJsonSchema } from '../core/state-machine';
import { buildTown } from '../engine/seed';
import { reflectionDiaryOf } from '../engine/reflection';
import { personalityOf } from '../engine/town-model';
import { assessDialogueTurn, conservativeDialogueReply, dialogueRepairInstruction } from '../engine/dialogue-quality';
import { validateDecision } from '../llm/action-validator';
import { LLMGateway } from '../llm/gateway';
import {
  ACTION_DECISION_TEMPLATE,
  DIALOGUE_TEMPLATE,
  REFLECTION_JOURNAL_JSON_SCHEMA,
  REFLECTION_JOURNAL_TEMPLATE,
  buildActionDecisionMessages,
  dialogueMessages,
  reflectionJournalMessages,
} from '../llm/prompts';
import { gatewayConfigFromEnv, providerNameFromEnv } from '../llm/provider-config';

interface AgentScenario {
  question: string;
  dialogueFacts: string[];
  dialogueRelevance: RegExp;
  personaSignal: RegExp;
  evidence: [string, string, string];
  evidenceSignal: RegExp;
}

interface CheckResult {
  name: '行动' | '对话' | '反思';
  ok: boolean;
  latencyMs: number;
  detail: string;
  sample: string;
}

interface AgentResult {
  agentId: string;
  agentName: string;
  occupation: string;
  checks: CheckResult[];
}

const SCENARIOS: Readonly<Record<string, AgentScenario>> = {
  '林晚晴': {
    question: '今天第一位客人说手冲偏酸，你调整配方后最在意什么？',
    dialogueFacts: ['今天早上第一位客人说手冲偏酸，我据此调整了配方。'],
    dialogueRelevance: /最在意|在意的是|第一位客人|手冲|偏酸|调整.{0,8}配方|咖啡.{0,20}(?:客人|暖)|客人.{0,12}暖|让人.{0,12}暖|味道|口感/,
    personaSignal: /手冲|咖啡|客人|配方|倾听/,
    evidence: ['早上为第一位客人调整了手冲配方。', '陈默中午来送了一本新书。', '打烊前发现两位陌生客人因咖啡聊成了朋友。'],
    evidenceSignal: /手冲|陈默|陌生客人|咖啡/,
  },
  '陈默': {
    question: '最近在读什么书？你为什么喜欢它？',
    dialogueFacts: ['最近在读费孝通的《乡土中国》，喜欢其中对熟人社会的观察。'],
    dialogueRelevance: /乡土中国|费孝通|熟人社会/,
    personaSignal: /书|读|乡土中国|熟人社会|观察/,
    evidence: ['早上整理书架时发现三本新书放错了分类。', '林晚晴借走了一本人物传记。', '傍晚有学生说他按黑板上的推荐找到了喜欢的书。'],
    evidenceSignal: /书架|林晚晴|学生|黑板/,
  },
  '沈屿': {
    question: '你最近在读什么书？如果没有在读就直说没有；请先回答书名或没有，再说它是否让你想到画画。',
    dialogueFacts: ['最近没有在读书，主要精力都放在为画展补一幅雨天作品。'],
    dialogueRelevance: /没.{0,5}读|没有.{0,5}书|最近没有/,
    personaSignal: /画|颜色|光|速写|画布|素描/,
    evidence: ['清晨在公园画架前重画了湖面的反光。', '午后在咖啡馆完成了一张林晚晴的侧影速写。', '回家后发现画展还缺一幅表现雨天的作品。'],
    evidenceSignal: /湖面|林晚晴|画展|雨天/,
  },
  '周岚': {
    question: '今天送信路上遇到什么值得留意的事？',
    dialogueFacts: ['今天送信时发现一封信写着旧地址，后来在广场找到了收信人并核对姓名。'],
    dialogueRelevance: /旧地址|广场.{0,12}收信人|核对.{0,6}姓名/,
    personaSignal: /信|送|地址|广场|收信人|姓名/,
    evidence: ['分拣时发现一封寄往旧地址的信。', '在广场找到了收信人并当面核对姓名。', '下午骑车经过花店时帮白露捎了一束花。'],
    evidenceSignal: /旧地址|收信人|白露|花店/,
  },
  '白露': {
    question: '湖边那片野花现在怎么样了？',
    dialogueFacts: ['傍晚查看时，湖边新播的野花种子已经发芽，但还没有开花。'],
    dialogueRelevance: /发芽|冒芽|还没.{0,4}开|没有.{0,4}开花/,
    personaSignal: /野花|种子|发芽|开花|湖边/,
    evidence: ['早上剪掉了一批受损的花枝。', '中午为周岚包了一束便于骑车携带的小花。', '傍晚去湖边看见新播的野花种子已经发芽。'],
    evidenceSignal: /花枝|周岚|野花种子|发芽/,
  },
  '老周': {
    question: '你怎么看年轻人总是匆匆忙忙这件事？',
    dialogueFacts: ['傍晚在广场看见两个年轻人匆忙赶路。'],
    dialogueRelevance: /年轻|忙|慢|急|日子|时间/,
    personaSignal: /鱼|湖|船|风|码头|慢工|年轻人/,
    evidence: ['清晨看风向后决定把船留在码头附近。', '中午修好了小船一块松动的木板。', '傍晚在广场给两个年轻人讲了湖上旧桥的故事。'],
    evidenceSignal: /风向|码头|木板|旧桥/,
  },
};

const FORBIDDEN_FORMULAS = /你刚才提到|围绕我们的话题|我认真想了想|我听明白了/;

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = performance.now();
  const value = await run();
  return { value, latencyMs: Math.round(performance.now() - started) };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

async function checkAction(llm: LLMGateway, agent: Agent): Promise<CheckResult> {
  const minuteOfDay = 600;
  const activeRoutine = agent.persona.routine.find((slot) => slot.from <= minuteOfDay && minuteOfDay < slot.to);
  const world = buildTown();
  const objects = world.allObjects().map((object) => ({ id: object.id, name: object.name }));
  const locationName = world.getObject(agent.locationId)?.name ?? agent.locationId;
  const { messages } = buildActionDecisionMessages({
    agent,
    day: 1,
    minuteOfDay,
    locationName,
    objects,
    playerInstruction: null,
    mockContext: {
      persona: agent.persona,
      minuteOfDay,
      routine: agent.persona.routine,
      memories: [{ content: `今天需要认真完成${activeRoutine?.verb ?? '职业工作'}。`, importance: 7 }],
      insights: [`我应该用${agent.persona.skills ? Object.keys(agent.persona.skills)[0] : '擅长的方式'}把工作做好。`],
      behaviorGuidance: [activeRoutine ? `优先去${activeRoutine.target}完成${activeRoutine.verb}。` : '根据当前环境选择具体行动。'],
      mindState: { valence: 0.2, energy: 0.75, stress: 0.2, socialNeed: 0.5, occupationalFocus: 0.9, summary: '精力良好，正专注于当前职责。' },
      agenda: activeRoutine ? `10:00 ${activeRoutine.verb}` : '自主安排',
      playerInstruction: null,
      objects,
    },
  });
  const { value: response, latencyMs } = await timed(() => llm.complete({
    tier: 'small', template: ACTION_DECISION_TEMPLATE, messages, jsonMode: true,
    jsonSchema: actionDecisionJsonSchema(objects.map((object) => object.id)),
    maxTokens: 512, temperature: 0.45, agentId: agent.id, reasoning: false,
  }));
  const validated = validateDecision(response.parsed, (id) => world.hasObject(id));
  const expectedTarget = activeRoutine?.target ?? null;
  const followsRoutine = !expectedTarget || validated.decision.action.target === expectedTarget;
  const ok = validated.ok && followsRoutine;
  return {
    name: '行动', ok, latencyMs,
    detail: !validated.ok ? validated.error ?? '决策结构非法' : followsRoutine ? '结构合法且承接当前职业日程' : `未承接当前日程目标 ${expectedTarget}`,
    sample: `${validated.decision.thought} → ${validated.decision.action.verb} @ ${validated.decision.action.target ?? '原地'}`,
  };
}

async function checkDialogue(llm: LLMGateway, agent: Agent, other: Agent, scenario: AgentScenario): Promise<CheckResult> {
  const history = [{ turnIndex: 0, speakerName: other.name, listenerName: agent.name, content: scenario.question }];
  const messages = dialogueMessages({
    speakerName: agent.name,
    speakerPool: agent.persona.greetingPool ?? [],
    otherName: other.name,
    goal: agent.persona.goals[0] ?? '自然交流',
    turns: 1,
    rumors: [],
    affection: 0.2,
    honesty: personalityOf(agent.persona).honesty,
    speakerPersona: agent.persona,
    otherPersona: other.persona,
    locationId: 'obj:plaza',
    relationshipHistory: [`上次交流时，${other.name}认真听完了${agent.name}的近期计划。`],
    speakerMemories: scenario.dialogueFacts,
    conversationId: `real-check:${agent.id}`,
    participants: [agent.id, other.id],
    history,
  });
  const schema = {
    type: 'object', additionalProperties: false, required: ['utterance', 'end_dialogue'],
    properties: { utterance: { type: 'string', minLength: 1, maxLength: 120 }, end_dialogue: { type: 'boolean' } },
  } as const;
  const started = performance.now();
  let utterance = '';
  let endDialogue: unknown;
  let rejectedReasons: string[] = [];
  let attempts = 0;
  for (attempts = 1; attempts <= 2; attempts += 1) {
    const candidateMessages = messages.map((message) => ({ ...message }));
    if (attempts > 1) candidateMessages[candidateMessages.length - 1].content += dialogueRepairInstruction(rejectedReasons);
    const response = await llm.complete({
      tier: 'small', template: DIALOGUE_TEMPLATE, messages: candidateMessages, jsonMode: true,
      jsonSchema: schema, maxTokens: 192, temperature: attempts === 1 ? 0.25 : 0.1,
      agentId: agent.id, reasoning: false, priority: 'dialogue', scopeId: 'real-agent-check', timeoutMs: 90_000,
    });
    const parsed = response.parsed as { utterance?: unknown; end_dialogue?: unknown } | null;
    utterance = typeof parsed?.utterance === 'string' ? parsed.utterance.trim() : '';
    endDialogue = parsed?.end_dialogue;
    const assessment = assessDialogueTurn({
      utterance,
      latestPrompt: scenario.question,
      priorTurns: [scenario.question],
      evidence: scenario.dialogueFacts,
      speakerName: agent.name,
      otherName: other.name,
      knownResidentNames: buildTown().allAgents().map((resident) => resident.name),
    });
    if (assessment.ok) break;
    rejectedReasons = assessment.reasons;
  }
  if (rejectedReasons.length && attempts > 2) utterance = conservativeDialogueReply(scenario.question, scenario.dialogueFacts);
  const latencyMs = Math.round(performance.now() - started);
  const finalAssessment = assessDialogueTurn({
    utterance,
    latestPrompt: scenario.question,
    priorTurns: [scenario.question],
    evidence: scenario.dialogueFacts,
    speakerName: agent.name,
    otherName: other.name,
    knownResidentNames: buildTown().allAgents().map((resident) => resident.name),
  });
  const schemaOk = utterance.length > 0 && utterance.length <= 120 && (typeof endDialogue === 'boolean' || attempts > 2);
  const relevant = scenario.dialogueRelevance.test(utterance);
  const personalized = scenario.personaSignal.test(utterance);
  const natural = !FORBIDDEN_FORMULAS.test(utterance) && utterance !== scenario.question;
  const ok = schemaOk && relevant && personalized && natural && finalAssessment.ok;
  const failures = [
    schemaOk ? '' : '结构或长度非法',
    relevant ? '' : '未直接回应问题',
    personalized ? '' : '人物信号不足',
    natural ? '' : '出现机械复述',
    finalAssessment.ok ? '' : finalAssessment.reasons.join('；'),
  ].filter(Boolean);
  return {
    name: '对话', ok, latencyMs,
    detail: failures.length ? failures.join('；') : `承接前文、事实有据且符合人设（${Math.min(attempts, 2)} 次生成）`,
    sample: utterance,
  };
}

async function checkReflection(llm: LLMGateway, agent: Agent, scenario: AgentScenario): Promise<CheckResult> {
  const evidence = scenario.evidence.map((content, index) => ({
    id: `evidence:${agent.id}:${index + 1}`,
    content,
    kind: index === 2 ? 'observation' : 'action',
    importance: 7 + (index % 2),
  }));
  const messages = reflectionJournalMessages({
    agent,
    day: 1,
    kind: 'daily',
    evidence,
    questions: ['今天哪件事最能帮助我修正明天的行动？'],
    candidateInsights: [`我需要把${agent.persona.occupation}的职责和对他人的关心放在同一份计划里。`],
    priorInsights: [],
    priorDiary: '',
    priorMindState: null,
  });
  const { value: response, latencyMs } = await timed(() => llm.complete({
    tier: 'large', template: REFLECTION_JOURNAL_TEMPLATE, messages, jsonMode: true,
    jsonSchema: REFLECTION_JOURNAL_JSON_SCHEMA,
    maxTokens: 1024, temperature: 0.2, agentId: agent.id, reasoning: false,
  }));
  const parsed = response.parsed as Record<string, unknown> | null;
  const generatedDiary = typeof parsed?.diary === 'string' ? parsed.diary.trim() : '';
  const mind = parsed?.mind_state as Record<string, unknown> | null;
  const numericRanges: [string, number, number][] = [
    ['valence', -1, 1], ['energy', 0, 1], ['stress', 0, 1],
    ['social_need', 0, 1], ['occupational_focus', 0, 1],
  ];
  const mindOk = !!mind && numericRanges.every(([key, low, high]) => (
    typeof mind[key] === 'number' && Number.isFinite(mind[key]) && Number(mind[key]) >= low && Number(mind[key]) <= high
  )) && typeof mind.summary === 'string' && mind.summary.trim().length > 0;
  const arraysOk = !!stringArray(parsed?.insights)
    && Array.isArray(parsed?.beliefs)
    && Array.isArray(parsed?.revisions)
    && !!stringArray(parsed?.behavior_guidance)
    && (stringArray(parsed?.behavior_guidance)?.length ?? 0) > 0;
  const projectedDiary = reflectionDiaryOf(agent, 1, evidence.map((item, index) => ({
    content: item.content, importance: item.importance, createdGameTime: index,
  })), mindOk ? {
    valence: Number(mind?.valence), energy: Number(mind?.energy), stress: Number(mind?.stress),
    socialNeed: Number(mind?.social_need), occupationalFocus: Number(mind?.occupational_focus),
    summary: String(mind?.summary),
  } : { valence: 0, energy: 0.5, stress: 0.5, socialNeed: 0.5, occupationalFocus: 0.7, summary: '保持观察' });
  const grounded = scenario.evidenceSignal.test(projectedDiary);
  const personalized = projectedDiary.includes(agent.persona.occupation) || scenario.personaSignal.test(projectedDiary);
  const schemaOk = generatedDiary.length >= 30 && mindOk && arraysOk;
  const ok = schemaOk && grounded && personalized;
  const failures = [
    schemaOk ? '' : '日记或心态 schema 不完整',
    grounded ? '' : '未引用当日证据',
    personalized ? '' : '职业与人设不明显',
  ].filter(Boolean);
  return {
    name: '反思', ok, latencyMs,
    detail: failures.length ? failures.join('；') : '证据有根据、心态完整且形成可执行指引',
    sample: projectedDiary || JSON.stringify(response.parsed),
  };
}

async function main(): Promise<void> {
  process.env.LLM_PROVIDER ??= 'ollama';
  if (process.env.LLM_PROVIDER === 'ollama') process.env.OLLAMA_PROFILE ??= 'qwen3-balanced';
  const provider = providerNameFromEnv();
  if (provider === 'mock') {
    throw new Error('真实居民验收禁止使用 mock；请设置 LLM_PROVIDER=ollama 或 deepseek。');
  }
  const config = gatewayConfigFromEnv();
  const model = provider === 'ollama'
    ? `${config.ollama?.model ?? '未知'} / small=${config.ollama?.smallModel ?? config.ollama?.model ?? '未知'}`
    : config.deepseek?.model ?? 'deepseek-chat';
  const llm = new LLMGateway({ ...config, retries: 1, backoffMs: 250 });
  const world = buildTown();
  const allAgents = world.allAgents();
  const requestedNames = new Set((process.env.REAL_AGENT_NAMES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean));
  const agents = requestedNames.size
    ? allAgents.filter((agent) => requestedNames.has(agent.name))
    : allAgents;
  if (agents.length === 0) throw new Error(`REAL_AGENT_NAMES 未匹配居民：${[...requestedNames].join(', ')}`);
  const requestedChecks = new Set((process.env.REAL_AGENT_CHECKS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
  const validChecks = new Set(['action', 'dialogue', 'reflection']);
  if ([...requestedChecks].some((name) => !validChecks.has(name))) {
    throw new Error(`REAL_AGENT_CHECKS 仅支持 action,dialogue,reflection：${[...requestedChecks].join(', ')}`);
  }
  const results: AgentResult[] = [];

  console.log(`真实模型居民验收 provider=${provider} model=${model}`);
  console.log(`居民数=${agents.length}，执行方式=单并发顺序验收`);

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index];
    const worldIndex = allAgents.findIndex((candidate) => candidate.id === agent.id);
    const other = allAgents[(worldIndex + 1) % allAgents.length];
    const scenario = SCENARIOS[agent.name];
    if (!scenario) throw new Error(`缺少居民验收场景：${agent.name}`);
    const checks: CheckResult[] = [];
    const runs: { key: string; name: CheckResult['name']; run: () => Promise<CheckResult> }[] = [
      { key: 'action', name: '行动', run: () => checkAction(llm, agent) },
      { key: 'dialogue', name: '对话', run: () => checkDialogue(llm, agent, other, scenario) },
      { key: 'reflection', name: '反思', run: () => checkReflection(llm, agent, scenario) },
    ];
    for (const candidate of runs) {
      if (requestedChecks.size && !requestedChecks.has(candidate.key)) continue;
      try {
        const check = await candidate.run();
        checks.push(check);
        console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${agent.name} / ${check.name} / ${check.latencyMs}ms / ${check.detail}`);
        console.log(`  ${check.sample.replace(/\s+/g, ' ').slice(0, 240)}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        checks.push({ name: candidate.name, ok: false, latencyMs: 0, detail, sample: '' });
        console.log(`[FAIL] ${agent.name} / ${checks.at(-1)?.name} / ${detail}`);
      }
    }
    results.push({ agentId: agent.id, agentName: agent.name, occupation: agent.persona.occupation, checks });
  }

  const checks = results.flatMap((result) => result.checks);
  const passed = checks.filter((check) => check.ok).length;
  const summary = {
    provider,
    model,
    agents: results.length,
    checks: checks.length,
    passed,
    failed: checks.length - passed,
    gatewayMetrics: llm.metricSummary(),
    results,
  };
  console.log(`REAL_AGENT_CHECK_SUMMARY ${JSON.stringify(summary)}`);
  if (passed !== checks.length) process.exitCode = 1;
}

await main();
