// M1 提示词库：动作决策（含记忆/洞察/计划）+ 记忆打分 + 日/小时计划 + 反思 + 对话 + 访谈

import type { Agent, Persona, RoutineSlot } from '../core/types';
import type { ChatMessage } from './types';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';

export const ACTION_DECISION_TEMPLATE = 'action_decision';
export const IMPORTANCE_TEMPLATE = 'importance';
export const DAILY_PLAN_TEMPLATE = 'daily_plan';
export const HOUR_PLAN_TEMPLATE = 'hour_plan';
export const REFLECTION_QUESTIONS_TEMPLATE = 'reflection_questions';
export const REFLECTION_INSIGHTS_TEMPLATE = 'reflection_insights';
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
  agenda: string | null;
  playerInstruction: string | null;
  objects: { id: string; name: string }[];
}

export interface ActionDecisionInput {
  agent: Agent;
  day: number;
  minuteOfDay: number;
  locationName: string;
  objects: { id: string; name: string }[];
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
  return `${p.name}，${p.age} 岁，${p.occupation}。${p.background} 性格：${p.traits.join('、')}。目标：${p.goals.join('；')}。`;
}

export function buildActionDecisionMessages(input: ActionDecisionInput): { messages: ChatMessage[] } {
  const p = input.agent.persona;
  const clock = { day: input.day, minutesOfDay: input.minuteOfDay, totalMinutes: (input.day - 1) * MINUTES_PER_DAY + input.minuteOfDay };
  const memLines = input.mockContext.memories.slice(0, 10).map((m) => `- [重要度${m.importance}] ${m.content}`).join('\n') || '（暂无）';
  const insightText = input.mockContext.insights.join('；') || '（暂无）';
  const agendaText = input.mockContext.agenda ?? '（暂无，自由安排）';
  const system = [
    `你是 ${personaText(p)}`,
    `当前时间：${TimeEngine.format(clock)}。你现在在「${input.locationName}」。`,
    `你的一天安排（兜底作息）：${routineToText(p)}`,
    `今日计划（当前时段）：${agendaText}`,
    `近期记忆：\n${memLines}`,
    `自我认知（反思）：${insightText}`,
    `玩家指令（最高优先级，尽力执行）：${input.playerInstruction ?? '（无）'}`,
    `决定接下来 5~15 分钟做什么。地点必须从给定对象里选。`,
    `只输出 JSON：{"thought": "...", "action": {"type": "move_to|interact|idle", "target": "<object_id 或 null>", "verb": "..."}, "duration_minutes": <int>}`,
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

export function dailyPlanMessages(agent: Agent, day: number, memories: MemoryBrief[], insights: string[]): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。你在一个 2D 小镇生活，需要安排第 ${day} 天。\n近期记忆：\n${memories.slice(0, 10).map((m) => `- ${m.content}`).join('\n') || '（暂无）'}\n自我认知：${insights.join('；') || '（暂无）'}\n生成你今天的大计划（3~5 句，覆盖上午/下午/晚上，自然语言）。只输出 JSON：{"broad_plan": "..."}`,
    { persona: agent.persona, day, memories, insights }
  );
}

export function hourPlanMessages(agent: Agent, hour: number, broadPlan: string): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。现在是第 ${hour} 点。当天大计划：${broadPlan || '（暂无）'}\n把接下来 1 小时拆成 5~15 分钟的具体动作清单。只输出 JSON：{"agenda": [{"time": "HH:MM", "action": "...", "location": "<对象 id 或名字>"}]}`,
    { persona: agent.persona, hour, broadPlan }
  );
}

export function dialogueMessages(ctx: { speakerName: string; speakerPool: string[]; otherName: string; goal: string; turns: number }): ChatMessage[] {
  return simpleMessages(
    `你是小镇居民「${ctx.speakerName}」。你正在和「${ctx.otherName}」聊天，这是第 ${ctx.turns + 1} 句。你当前的目标：${ctx.goal}\n规则：每次只说 1~3 句；不要替对方说话；若已聊了 3 句以上或话头已尽，把 end_dialogue 设为 true。只输出 JSON：{"utterance": "...", "end_dialogue": <true|false>}`,
    ctx
  );
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

export function interviewMessages(agent: Agent, question: string, memories: string[], insights: string[]): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。有人问你：「${question}」\n你的记忆：\n${memories.map((m) => `- ${m}`).join('\n') || '（暂无）'}\n你的自我认知：${insights.join('；') || '（暂无）'}\n请以第一人称诚实回答（基于记忆，不编造）。只输出 JSON：{"answer": "..."}`,
    { question, memories, insights }
  );
}
