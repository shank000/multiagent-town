// MockProvider：全模板确定性离线输出（M1），上下文取自提示词中的 <M0_CONTEXT> JSON

import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from './types';
import type { Decision, RoutineSlot } from '../core/types';
import { MINUTES_PER_DAY } from '../core/time';
import {
  ACTION_DECISION_TEMPLATE, IMPORTANCE_TEMPLATE, DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE, DIALOGUE_TEMPLATE,
  DIALOGUE_SUMMARY_TEMPLATE, INTERVIEW_TEMPLATE,
} from './prompts';

const CONTEXT_RE = /<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/;

const DAILY_PLANS: Record<string, string> = {
  '林晚晴': '照常经营咖啡馆，午后去书店翻翻新书，傍晚到公园散步，晚上回家写小说笔记。',
  '陈默': '整理书店的新到书目，接待常客，傍晚去广场散步透透气。',
  '沈屿': '上午在公园写生，午后到咖啡馆喝咖啡画速写，晚上整理画稿。',
  '周岚': '上午在邮局分拣信件，之后骑车给广场、咖啡馆、书店送信，傍晚回家。',
};

export function mockImportance(text: string): number {
  if (/派对|读书会|集市|秘密|约定|邀请|结婚|事故|宝藏/.test(text)) return 9;
  if (/计划|反思|重要|决定|喜欢|讨厌/.test(text)) return 8;
  if (/说|闲聊|休息|散步|心想/.test(text)) return 4;
  return 6;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const ctx = extract(req.messages) as Record<string, unknown>;
    let out: unknown;
    switch (req.template) {
      case ACTION_DECISION_TEMPLATE: {
        const d = decideAction(ctx);
        out = { thought: d.thought, action: d.action, duration_minutes: d.durationMinutes };
        break;
      }
      case IMPORTANCE_TEMPLATE: out = { importance: mockImportance(String(ctx.text ?? '')) }; break;
      case DAILY_PLAN_TEMPLATE: out = { broad_plan: DAILY_PLANS[(ctx.persona as { name?: string } | undefined)?.name ?? ''] ?? '今天照常在小镇里度过，做点喜欢的事。' }; break;
      case HOUR_PLAN_TEMPLATE: out = { agenda: hourAgenda((ctx.persona as { routine?: RoutineSlot[] } | undefined)?.routine ?? [], Number(ctx.hour ?? 0)) }; break;
      case REFLECTION_QUESTIONS_TEMPLATE: out = { questions: ['我最近反复在做什么？', '我和谁走得近？', '我在为什么事分心？'] }; break;
      case REFLECTION_INSIGHTS_TEMPLATE: {
        const ev = Array.isArray(ctx.evidence) ? (ctx.evidence as string[]) : [];
        out = { insights: ev.slice(0, 5).map((c) => `我最近经历了「${c.slice(0, 18)}」这件事。`) };
        break;
      }
      case DIALOGUE_TEMPLATE: out = dialogueTurn(ctx); break;
      case DIALOGUE_SUMMARY_TEMPLATE: {
        const lines = Array.isArray(ctx.lines) ? (ctx.lines as string[]) : [];
        out = { summary: `聊到了「${(lines[0] ?? '').slice(0, 16)}」等话题，气氛不错。`, affection_delta: 0.1, respect_delta: 0.05 };
        break;
      }
      case INTERVIEW_TEMPLATE: {
        const mems = Array.isArray(ctx.memories) ? (ctx.memories as string[]) : [];
        out = { answer: `我记得：${mems.slice(0, 3).join('；')}` };
        break;
      }
      default: throw new Error(`mock 不支持模板: ${req.template}`);
    }
    return { content: JSON.stringify(out), parsed: out, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
  }
}

function extract(messages: ChatMessage[]): Record<string, unknown> {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const match = CONTEXT_RE.exec(m.content);
    if (match) return JSON.parse(match[1]) as Record<string, unknown>;
  }
  throw new Error('mock 找不到 <M0_CONTEXT>');
}

/** 确定性动作决策：玩家指令最优先；其次作息槽；否则原地小憩 */
function decideAction(ctx: Record<string, unknown>): Decision {
  const instruction = ctx.playerInstruction as string | null | undefined;
  if (instruction) {
    const objects = (ctx.objects ?? []) as { id: string; name: string }[];
    const hit = objects.find((o) => instruction.includes(o.name));
    if (hit) {
      return { thought: `按玩家的指令：${instruction}`, action: { type: 'interact', target: hit.id, verb: instruction.slice(0, 20) }, durationMinutes: 15 };
    }
    return { thought: `尝试执行玩家指令：${instruction}`, action: { type: 'idle', target: null, verb: instruction.slice(0, 20) }, durationMinutes: 10 };
  }
  const t = Number(ctx.minuteOfDay ?? 0);
  const routine = (ctx.routine as RoutineSlot[]) ?? [];
  const hh = String(Math.floor(t / 60)).padStart(2, '0');
  const mm = String(t % 60).padStart(2, '0');
  const slot = routine.find((s) => t >= s.from && t < s.to);
  if (slot) {
    return {
      thought: `现在${hh}:${mm}，按作息安排去「${slot.verb}」。`,
      action: { type: slot.type, target: slot.target, verb: slot.verb },
      durationMinutes: Math.min(15, Math.max(1, slot.to - t)),
    };
  }
  const next = [...routine].sort((a, b) => a.from - b.from).find((s) => s.from > t);
  const untilNext = (next ? next.from : MINUTES_PER_DAY) - t;
  return {
    thought: '现在没有安排，休息一会儿。',
    action: { type: 'idle', target: null, verb: '休息' },
    durationMinutes: Math.max(1, Math.min(30, untilNext)),
  };
}

function hourAgenda(routine: RoutineSlot[], hour: number): { time: string; action: string; location: string }[] {
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const hits = routine.filter((s) => s.from >= hour * 60 && s.from < (hour + 1) * 60);
  if (!hits.length) return [{ time: `${String(hour).padStart(2, '0')}:00`, action: '自由活动', location: '小镇' }];
  return hits.map((s) => ({ time: hhmm(s.from), action: s.verb, location: s.target ?? '小镇' }));
}

function dialogueTurn(ctx: Record<string, unknown>): { utterance: string; end_dialogue: boolean } {
  const rumors = Array.isArray(ctx.rumors) ? (ctx.rumors as { id: string; content: string }[]) : [];
  const affection = Number(ctx.affection ?? 0);
  const honesty = Number(ctx.honesty ?? 0.5);
  if (rumors.length && affection >= 0.3) {
    const rumor = rumors[0];
    const text = honesty >= 0.6 ? rumor.content : `听说${rumor.content}（转述）`;
    return { utterance: text, end_dialogue: Number(ctx.turns ?? 0) >= 2 };
  }
  const pool = Array.isArray(ctx.speakerPool) && (ctx.speakerPool as string[]).length ? (ctx.speakerPool as string[]) : ['你好呀！', '今天天气真不错。'];
  const turns = Number(ctx.turns ?? 0);
  return { utterance: pool[turns % pool.length], end_dialogue: turns >= 3 };
}
