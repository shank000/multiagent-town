// MockProvider：确定性离线决策，跑通全链路；上下文取自提示词中的 <M0_CONTEXT> JSON

import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from './types';
import type { Decision, RoutineSlot } from '../core/types';
import { MINUTES_PER_DAY } from '../core/time';

interface MockContext {
  minuteOfDay: number;
  routine: RoutineSlot[];
}

const CONTEXT_RE = /<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/;

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (req.template !== 'action_decision') {
      throw new Error(`mock 不支持模板: ${req.template}`);
    }
    const ctx = extractContext(req.messages);
    const d = decide(ctx);
    const wire = { thought: d.thought, action: d.action, duration_minutes: d.durationMinutes };
    return {
      content: JSON.stringify(wire),
      parsed: wire,
      usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 },
    };
  }
}

function extractContext(messages: ChatMessage[]): MockContext {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const match = CONTEXT_RE.exec(m.content);
    if (match) return JSON.parse(match[1]) as MockContext;
  }
  throw new Error('mock 找不到 <M0_CONTEXT>');
}

/** 确定性决策：命中当前时段作息槽 → 执行；否则原地小憩至下一时段 */
function decide(ctx: MockContext): Decision {
  const t = ctx.minuteOfDay;
  const hh = String(Math.floor(t / 60)).padStart(2, '0');
  const mm = String(t % 60).padStart(2, '0');
  const slot = ctx.routine.find((s) => t >= s.from && t < s.to);
  if (slot) {
    return {
      thought: `现在${hh}:${mm}，按作息安排去「${slot.verb}」。`,
      action: { type: slot.type, target: slot.target, verb: slot.verb },
      durationMinutes: Math.min(15, Math.max(1, slot.to - t)),
    };
  }
  const next = [...ctx.routine].sort((a, b) => a.from - b.from).find((s) => s.from > t);
  const untilNext = (next ? next.from : MINUTES_PER_DAY) - t;
  return {
    thought: '现在没有安排，休息一会儿。',
    action: { type: 'idle', target: null, verb: '休息' },
    durationMinutes: Math.max(1, Math.min(30, untilNext)),
  };
}
