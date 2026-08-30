// M1 提示词库：动作决策（含记忆/洞察/计划）+ 记忆打分 + 日/小时计划 + 反思 + 对话 + 访谈

import type { Agent, Persona, RoutineSlot } from '../core/types';
import type { ReflectionMindState } from '../store/memory';
import type { ChatMessage } from './types';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';

export const ACTION_DECISION_TEMPLATE = 'action_decision';
export const IMPORTANCE_TEMPLATE = 'importance';
export const DAILY_PLAN_TEMPLATE = 'daily_plan';
export const HOUR_PLAN_TEMPLATE = 'hour_plan';
export const REFLECTION_QUESTIONS_TEMPLATE = 'reflection_questions';
export const REFLECTION_INSIGHTS_TEMPLATE = 'reflection_insights';
export const REFLECTION_JOURNAL_TEMPLATE = 'reflection_journal';

export const REFLECTION_JOURNAL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diary', 'mind_state', 'insights', 'beliefs', 'revisions', 'behavior_guidance'],
  properties: {
    diary: { type: 'string', minLength: 30, maxLength: 1200 },
    mind_state: {
      type: 'object',
      additionalProperties: false,
      required: ['valence', 'energy', 'stress', 'social_need', 'occupational_focus', 'summary'],
      properties: {
        valence: { type: 'number', minimum: -1, maximum: 1 },
        energy: { type: 'number', minimum: 0, maximum: 1 },
        stress: { type: 'number', minimum: 0, maximum: 1 },
        social_need: { type: 'number', minimum: 0, maximum: 1 },
        occupational_focus: { type: 'number', minimum: 0, maximum: 1 },
        summary: { type: 'string', minLength: 1, maxLength: 120 },
      },
    },
    insights: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 180 } },
    beliefs: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['statement', 'confidence', 'evidence_ids', 'status', 'supersedes'],
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 220 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence_ids: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
          status: { type: 'string', enum: ['new', 'reinforced', 'revised'] },
          supersedes: { type: ['string', 'null'] },
        },
      },
    },
    revisions: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        required: ['previous', 'revised', 'reason', 'evidence_ids'],
        properties: {
          previous: { type: 'string', minLength: 1, maxLength: 180 },
          revised: { type: 'string', minLength: 1, maxLength: 180 },
          reason: { type: 'string', minLength: 1, maxLength: 220 },
          evidence_ids: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
        },
      },
    },
    behavior_guidance: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 180 } },
  },
} as const;
export const DIALOGUE_TEMPLATE = 'dialogue';
export const DIALOGUE_SUMMARY_TEMPLATE = 'dialogue_summary';
export const INTERVIEW_TEMPLATE = 'interview';

export interface MemoryBrief { content: string; importance: number }

export interface MockContextPayload {
  persona: Persona;
  minuteOfDay: number;
  routine: RoutineSlot[];
  memories: MemoryBrief[];
  insights: string[];
  behaviorGuidance?: string[];
  mindState?: ReflectionMindState | null;
  agenda: string | null;
  playerInstruction: string | null;
  objects: ActionObjectContext[];
}

export interface ActionObjectContext {
  id: string;
  name: string;
  description?: string;
  affordances?: { verb: string; outcome: string }[];
  sensoryCues?: string[];
  state?: { label: string; detail: string };
}

export interface ActionDecisionInput {
  agent: Agent;
  day: number;
  minuteOfDay: number;
  locationName: string;
  objects: ActionObjectContext[];
  playerInstruction: string | null;
  mockContext: MockContextPayload;
}

export function routineToText(p: Persona): string {
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return p.routine.length
    ? p.routine.map((s) => `${hhmm(s.from)}-${hhmm(s.to)} 在${s.target ?? '原地'}${s.verb}`).join('；')
    : '自由安排';
}

export function personaText(p: Persona): string {
  const skills = Object.entries(p.skills).map(([k, v]) => `${k}(${v}/10)`).join('、');
  return `${p.name}，${p.age} 岁，${p.gender}，${p.occupation}。${p.background} 性格：${p.traits.join('、')}。爱好：${p.hobbies.join('、')}。技能：${skills}。价值观：${p.values.join('、')}。动机：${p.motivation}。目标：${p.goals.join('；')}。说话风格：${p.speechStyle}。`;
}

export function buildActionDecisionMessages(input: ActionDecisionInput): { messages: ChatMessage[] } {
  const p = input.agent.persona;
  const clock = { day: input.day, minutesOfDay: input.minuteOfDay, totalMinutes: (input.day - 1) * MINUTES_PER_DAY + input.minuteOfDay };
  const activeRoutine = p.routine.find((slot) => slot.from <= input.minuteOfDay && input.minuteOfDay < slot.to);
  const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const activeRoutineText = activeRoutine
    ? `${hhmm(activeRoutine.from)}-${hhmm(activeRoutine.to)} 在 ${activeRoutine.target}「${activeRoutine.verb}」`
    : '当前没有固定作息槽，可依据计划、记忆与环境选择行动。';
  const memLines = input.mockContext.memories.slice(0, 10).map((m) => `- [重要度${m.importance}] ${m.content}`).join('\n') || '（暂无）';
  const insightText = input.mockContext.insights.join('；') || '（暂无）';
  const guidanceText = input.mockContext.behaviorGuidance?.join('；') || '（暂无）';
  const mindState = input.mockContext.mindState;
  const agendaText = input.mockContext.agenda ?? '（暂无，自由安排）';
  const actionTargetExample = input.objects.find((object) => object.id !== input.agent.locationId)?.id
    ?? input.objects[0]?.id
    ?? 'obj:available';
  const system = [
    `你是 ${personaText(p)}`,
    `当前时间：${TimeEngine.format(clock)}。你现在在「${input.locationName}」。`,
    `当前作息约束：${activeRoutineText}`,
    activeRoutine
      ? '没有玩家指令或明确紧急事件时，下一步必须承接当前作息槽；凌晨与夜间的睡眠时段不得改写为白天活动。'
      : '当前可自主安排，但仍须遵守现实时间与地点。',
    `你的一天安排（兜底作息）：${routineToText(p)}`,
    `你的价值观（决策时保持一致）：${p.values.join('、')}`,
    `今日计划（当前时段）：${agendaText}`,
    `近期记忆：\n${memLines}`,
    `自我认知（反思）：${insightText}`,
    `反思形成的行为指引：${guidanceText}`,
    `当前心态：${mindState ? `${mindState.summary}（情绪${mindState.valence.toFixed(2)}、精力${mindState.energy.toFixed(2)}、压力${mindState.stress.toFixed(2)}、社交需要${mindState.socialNeed.toFixed(2)}、职业专注${mindState.occupationalFocus.toFixed(2)}）` : '（暂无稳定评估）'}`,
    '行为指引用于调整下一步做法，但职业职责、现实位置、可用对象和明确指令仍是约束；不要把主观反思当成已经发生的事实。',
    `玩家指令（最高优先级，尽力执行）：${input.playerInstruction ?? '（无）'}`,
    `决定接下来 5~15 分钟做什么。地点必须从给定对象里选。`,
    'thought 只解释这一个即时行动，事实只能来自以上上下文；未来意图要写成“准备/打算”，不得把未观察到的事件写成已经发生，也不得描述 action 未编码的额外行动。',
    '动作字段必须匹配：idle 只能使用 JSON null 作为 target；move_to/interact 必须使用可用对象的 id 作为 target。',
    '带有 affordances 的公共物件可以被观察和使用；选择 interact 时优先采用与人物背景、当前记忆和现场状态相符的 affordance verb，不要机械轮换物件。',
    '对象中的 state 只会在你处于可感知范围内时出现，可把它当作当前亲眼看到、听到或闻到的现场线索。',
    'idle 示例：{"thought":"稍作休息","action":{"type":"idle","target":null,"verb":"休息"},"duration_minutes":10}',
    `非 idle 示例：{"thought":"去目标地点整理物品","action":{"type":"interact","target":${JSON.stringify(actionTargetExample)},"verb":"整理物品"},"duration_minutes":10}`,
    `只输出 JSON：一个符合上述约束的对象。`,
  ].join('\n');
  const user = `可用对象：${JSON.stringify(input.objects)}\n\n<M0_CONTEXT>\n${JSON.stringify(input.mockContext)}\n</M0_CONTEXT>`;
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/** 简单模板统一封装：system 提示词 + <M0_CONTEXT> JSON */
export function simpleMessages(system: string, ctx: unknown): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: `<M0_CONTEXT>\n${JSON.stringify(ctx)}\n</M0_CONTEXT>` },
  ];
}

export function importanceMessages(text: string): ChatMessage[] {
  return simpleMessages(
    '你是记忆筛选器。给智能体的一条新记忆的重要性打分 1~10。打分标准：1~3 日常琐事；4~6 有信息量的事件；7~8 与目标/人际相关；9~10 改变人生的事件。只输出 JSON：{"importance": <int>}',
    { text }
  );
}

export function dailyPlanMessages(
  agent: Agent,
  day: number,
  memories: MemoryBrief[],
  insights: string[],
  adaptive: { guidance?: string[]; mindState?: ReflectionMindState | null; priorDiary?: string } = {},
): ChatMessage[] {
  const guidance = adaptive.guidance?.join('；') || '（暂无）';
  const mindset = adaptive.mindState?.summary ?? '（暂无稳定评估）';
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。你在一个 2D 小镇生活，需要安排第 ${day} 天。\n近期记忆：\n${memories.slice(0, 10).map((m) => `- ${m.content}`).join('\n') || '（暂无）'}\n自我认知：${insights.join('；') || '（暂无）'}\n上一份日记：${adaptive.priorDiary || '（暂无）'}\n当前心态：${mindset}\n经反思形成的行为指引：${guidance}\n生成今天的大计划（3~5 句，覆盖职业职责、人际回应、休息与个人目标）。计划可以根据反思调整，但不得声称尚未发生的事件。只输出 JSON：{"broad_plan": "..."}`,
    { persona: agent.persona, day, memories, insights, guidance: adaptive.guidance ?? [], mindState: adaptive.mindState ?? null, priorDiary: adaptive.priorDiary ?? '' }
  );
}

export function hourPlanMessages(agent: Agent, hour: number, broadPlan: string): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。现在是第 ${hour} 点。当天大计划：${broadPlan || '（暂无）'}\n把接下来 1 小时拆成 5~15 分钟的具体动作清单。只输出 JSON：{"agenda": [{"time": "HH:MM", "action": "...", "location": "<对象 id 或名字>"}]}`,
    { persona: agent.persona, hour, broadPlan }
  );
}

export function dialogueMessages(ctx: {
  speakerName: string; speakerPool: string[]; otherName: string; goal: string; turns: number;
  rumors: { id: string; content: string }[]; affection: number; honesty: number;
  speakerPersona?: Persona;
  otherPersona?: Persona;
  locationId?: string;
  relationshipHistory?: string[];
  speakerMemories?: string[];
  worldFacts?: string[];
  conversationId?: string;
  participants?: [string, string];
  history?: { turnIndex: number; speakerName: string; listenerName: string; content: string }[];
}): ChatMessage[] {
  const rumors = ctx.rumors.slice(0, 2).map((rumor) => ({ ...rumor, content: compactDialogueText(rumor.content) }));
  const history = ctx.history?.slice(-6).map((turn) => ({ ...turn, content: compactDialogueText(turn.content) })) ?? [];
  const rumorLines = rumors.length
    ? `\n你可能听说了这些传闻（关系足够近才适合提起）：\n${rumors.map((r) => `- ${r.content}`).join('\n')}`
    : '';
  const transcript = history.length
    ? `\n本次会话前文（保留最近六句，按轮次，必须承接对方最后一句）：\n${history.map((turn) => (
      `${turn.turnIndex + 1}. ${turn.speakerName} → ${turn.listenerName}：${turn.content}`
    )).join('\n')}`
    : '\n本次会话尚无前文，请自然开启话题。';
  const identity = ctx.speakerPersona
    ? personaText(ctx.speakerPersona)
    : `小镇居民「${ctx.speakerName}」`;
  const otherProfile = ctx.otherPersona
    ? `\n对话对象背景（只用于理解对方，不要替对方发言）：${personaText(ctx.otherPersona)}`
    : '';
  const relationshipHistory = ctx.relationshipHistory?.length
    ? `\n你们过去互动的已知摘要：\n${ctx.relationshipHistory.slice(-2).map((item) => `- ${compactDialogueText(item)}`).join('\n')}`
    : '\n你们没有可用的既往互动摘要，不要虚构共同经历。';
  const speakerMemories = ctx.speakerMemories?.length
    ? `\n你近期可确认的个人记忆：\n${ctx.speakerMemories.slice(-4).map((item) => `- ${compactDialogueText(item)}`).join('\n')}`
    : '\n没有可确认的近期个人记忆。';
  const worldFacts = ctx.worldFacts?.length
    ? `\n当前场景与世界功能（功能存在不等于事件已发生）：\n${ctx.worldFacts.slice(0, 6).map((item) => `- ${compactDialogueText(item)}`).join('\n')}`
    : '\n没有额外的现场功能信息。';
  const location = ctx.locationId ? `\n当前会话地点：${ctx.locationId}。` : '';
  return simpleMessages(
    `你是 ${identity}\n你正在和「${ctx.otherName}」聊天，这是第 ${ctx.turns + 1} 句。你当前的目标：${ctx.goal}${otherProfile}${location}${worldFacts}${relationshipHistory}${speakerMemories}${rumorLines}${transcript}\n` +
    '规则：\n' +
    '1. 直接回应对方最后一句的信息、问题或情绪，然后再推进一个紧密相关的话题。对方提出明确问题时，第一句必须先给出答案；不知道或没有相关经历也要直说，回答之前不得转向别的话题。\n' +
    '2. 不要用「你刚才提到」「围绕我们的话题」「我认真想了想」等套话复述前文，也不要回避一个明确问题。\n' +
    '3. 保持人物的知识边界和说话风格，但不要为了显示职业或爱好而硬转话题。\n' +
    '4. 既往摘要只是回忆；已经说过的内容只有在追问、修正或兑现约定时才重提。\n' +
    '5. 每次只说 1~3 句，不要替对方说话；若已聊了 3 句以上或话头已尽，把 end_dialogue 设为 true。\n' +
    '6. 关于“最近做了什么、读了什么、谁说了什么”等事实，只能使用人物背景、近期记忆、既往摘要或本次前文中明确给出的内容；没有依据时自然说明不知道、没印象或最近没有，禁止编造书名、引语和共同经历。\n' +
    '7. 世界事件有明确状态边界：「活动预告（尚未发生）」只表示计划，不能说自己已经参加；只有「活动现场（已核验）」且名单包含自己时才能声称参加。只有「花店订单（已履约）」或明确的赠送/收到证据才能声称鲜花已经送达。场景功能清单只说明可执行条件；清单外活动只能作为愿望或提议，任何已经发生的共同经历都必须有完成证据。\n' +
    '只输出 JSON：{"utterance": "...", "end_dialogue": <true|false>}',
    {
      speakerName: ctx.speakerName,
      speakerPool: ctx.speakerPool.slice(0, 6).map(compactDialogueText),
      otherName: ctx.otherName,
      turns: ctx.turns,
      rumors,
      affection: ctx.affection,
      honesty: ctx.honesty,
      conversationId: ctx.conversationId,
      participants: ctx.participants,
      history,
    }
  );
}

function compactDialogueText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 120);
}

export function dialogueSummaryMessages(lines: string[]): ChatMessage[] {
  return simpleMessages(
    '总结以上对话（≤100 字，客观，含双方达成的约定/传递的信息），并给出双方关系的渐进变化量。只输出 JSON：{"summary": "...", "affection_delta": <float -0.2~0.2>, "respect_delta": <float -0.2~0.2>}',
    { lines }
  );
}

export function reflectionQuestionsMessages(memories: string[]): ChatMessage[] {
  return simpleMessages(
    `下面是最近发生在你身上的事（按时间）：\n${memories.map((m) => `- ${m}`).join('\n')}\n提出 3 个关于你自己的开放式问题（关于目标、人际关系、重复出现的主题）。只输出 JSON：{"questions": ["...", "...", "..."]}`,
    { memories }
  );
}

export function reflectionInsightsMessages(question: string, evidence: string[]): ChatMessage[] {
  return simpleMessages(
    `问题：${question}\n证据（只能使用以下内容，禁止编造）：\n${evidence.map((e) => `- ${e}`).join('\n')}\n基于证据给出最多 5 条对自己的洞察，每条 ≤ 1 句，用「我」开头。只输出 JSON：{"insights": ["...", ...]}`,
    { question, evidence }
  );
}

export interface ReflectionJournalInput {
  agent: Agent;
  day: number;
  kind: 'triggered' | 'daily';
  evidence: { id: string; content: string; kind: string; importance: number }[];
  questions: string[];
  candidateInsights: string[];
  priorInsights: string[];
  priorDiary: string;
  priorMindState: ReflectionMindState | null;
}

export function reflectionJournalMessages(input: ReflectionJournalInput): ChatMessage[] {
  const evidenceLines = input.evidence.length
    ? input.evidence.map((item) => `- [${item.id}] ${item.content}`).join('\n')
    : '（本日没有足够的事件证据）';
  return simpleMessages(
    `你是 ${personaText(input.agent.persona)}。请完成第 ${input.day} 天的${input.kind === 'daily' ? '日终日记' : '事件触发反思'}。\n` +
    `证据：\n${evidenceLines}\n` +
    `此前洞察：${input.priorInsights.join('；') || '（暂无）'}\n` +
    `上一份日记：${input.priorDiary || '（暂无）'}\n` +
    `候选新洞察：${input.candidateInsights.join('；') || '（暂无）'}\n` +
    '规则：日记使用第一人称，结合职业、价值观和心态解释当天经历；事实只能来自证据。主观感受要明确写成感受。只有新证据确实改变旧判断时才填写 revisions。行为指引必须具体、可执行，并服务于后续计划。' +
    ' 当日事实按证据顺序逐条直接转述，每条证据最多一句；随后再写主观感受和总结。不得添加证据中未出现的对话引语、物品、人物行动、数量、时间、结果、动机或因果关系。人物背景只能解释心态与目标，不能改写成今天发生的事件。' +
    ' 保持输出紧凑并完整闭合 JSON：diary 80~180 字；mind_state.summary 不超过 50 字；insights 1~2 条；beliefs 1~2 条；revisions 0~1 条；behavior_guidance 1~3 条；数组中的每段文字不超过 70 字。没有修正时输出空 revisions 数组。' +
    '\n只输出 JSON：{' +
    '"diary":"...",' +
    '"mind_state":{"valence":<-1..1>,"energy":<0..1>,"stress":<0..1>,"social_need":<0..1>,"occupational_focus":<0..1>,"summary":"..."},' +
    '"insights":["..."],' +
    '"beliefs":[{"statement":"...","confidence":<0..1>,"evidence_ids":["..."],"status":"new|reinforced|revised","supersedes":null}],'+
    '"revisions":[{"previous":"...","revised":"...","reason":"...","evidence_ids":["..."]}],' +
    '"behavior_guidance":["..."]}',
    {
      persona: input.agent.persona,
      day: input.day,
      kind: input.kind,
      evidence: input.evidence,
      questions: input.questions,
      candidateInsights: input.candidateInsights,
      priorInsights: input.priorInsights,
      priorDiary: input.priorDiary,
      priorMindState: input.priorMindState,
    },
  );
}

export function interviewMessages(agent: Agent, question: string, memories: string[], insights: string[]): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。有人问你：「${question}」\n你的记忆：\n${memories.map((m) => `- ${m}`).join('\n') || '（暂无）'}\n你的自我认知：${insights.join('；') || '（暂无）'}\n请以第一人称诚实回答（基于记忆，不编造）。只输出 JSON：{"answer": "..."}`,
    { question, memories, insights }
  );
}
