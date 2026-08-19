// M0 提示词：动作决策（design §6.4 的 M0 简化版，无记忆检索）

import type { Agent, Persona, RoutineSlot } from '../core/types';
import type { ChatMessage } from './types';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';

export const ACTION_DECISION_TEMPLATE = 'action_decision';

export interface MockContextPayload {
  persona: Persona;
  minuteOfDay: number;
  routine: RoutineSlot[];
}

export interface ActionDecisionInput {
  agent: Agent;
  day: number;          // 第几天（1 起）
  minuteOfDay: number;
  locationName: string;
  objects: { id: string; name: string }[];
  mockContext: MockContextPayload;
}

export function routineToText(p: Persona): string {
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return p.routine.length
    ? p.routine.map((s) => `${hhmm(s.from)}-${hhmm(s.to)} 在${s.target ?? '原地'}${s.verb}`).join('；')
    : '自由安排';
}

export function buildActionDecisionMessages(input: ActionDecisionInput): { messages: ChatMessage[] } {
  const p = input.agent.persona;
  const personaText = `${p.name}，${p.age} 岁，${p.occupation}。${p.background} 性格：${p.traits.join('、')}。目标：${p.goals.join('；')}。`;
  const clock = { day: input.day, minutesOfDay: input.minuteOfDay, totalMinutes: (input.day - 1) * MINUTES_PER_DAY + input.minuteOfDay };
  const system = [
    `你是 ${personaText}`,
    `当前时间：${TimeEngine.format(clock)}。你现在在「${input.locationName}」。`,
    `你的一天安排：${routineToText(p)}`,
    `决定接下来 5~15 分钟做什么。地点必须从给定对象里选。`,
    `只输出 JSON：{"thought": "...", "action": {"type": "move_to|interact|idle", "target": "<object_id 或 null>", "verb": "..."}, "duration_minutes": <int>}`,
  ].join('\n');
  const user = `可用对象：${JSON.stringify(input.objects)}\n\n<M0_CONTEXT>\n${JSON.stringify(input.mockContext)}\n</M0_CONTEXT>`;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}
