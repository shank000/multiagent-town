// MockProvider：全模板确定性离线输出（M1），上下文取自提示词中的 <M0_CONTEXT> JSON

import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from './types';
import type { Decision, RoutineSlot } from '../core/types';
import { MINUTES_PER_DAY } from '../core/time';
import {
  ACTION_DECISION_TEMPLATE, IMPORTANCE_TEMPLATE, DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE, DIALOGUE_TEMPLATE,
  REFLECTION_JOURNAL_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, INTERVIEW_TEMPLATE,
} from './prompts';

const CONTEXT_RE = /<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/;

export function mockImportance(text: string): number {
  if (/派对|读书会|集市|秘密|约定|邀请|结婚|事故|宝藏/.test(text)) return 9;
  if (/计划|反思|重要|决定|喜欢|讨厌/.test(text)) return 8;
  if (/说|闲聊|休息|散步|心想/.test(text)) return 4;
  return 6;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const ctx = req.template === 'throughput_calibration'
      ? {}
      : extract(req.messages) as Record<string, unknown>;
    let out: unknown;
    switch (req.template) {
      case ACTION_DECISION_TEMPLATE: {
        const d = decideAction(ctx);
        out = { thought: d.thought, action: d.action, duration_minutes: d.durationMinutes };
        break;
      }
      case IMPORTANCE_TEMPLATE: out = { importance: mockImportance(String(ctx.text ?? '')) }; break;
      case DAILY_PLAN_TEMPLATE: {
        const options = planningOptions(ctx);
        out = { option_ids: options.slice(0, 5).map((option) => option.id) };
        break;
      }
      case HOUR_PLAN_TEMPLATE: {
        const hour = Number(ctx.hour ?? 0);
        const minute = hour * 60;
        const options = planningOptions(ctx);
        const selected = options.find((option) => option.fromMinute !== null && option.toMinute !== null
          && option.fromMinute <= minute && minute < option.toMinute) ?? options[0];
        out = { agenda: selected ? [{ time: `${String(hour).padStart(2, '0')}:00`, option_id: selected.id }] : [] };
        break;
      }
      case REFLECTION_QUESTIONS_TEMPLATE: out = { questions: ['我最近反复在做什么？', '我和谁走得近？', '我在为什么事分心？'] }; break;
      case REFLECTION_INSIGHTS_TEMPLATE: {
        const ev = Array.isArray(ctx.evidence) ? (ctx.evidence as string[]) : [];
        out = { insights: ev.slice(0, 5).map((c) => `我最近经历了「${c.slice(0, 18)}」这件事。`) };
        break;
      }
      case REFLECTION_JOURNAL_TEMPLATE: out = journalReflection(ctx); break;
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
      case 'throughput_calibration': {
        out = { sample: '本地吞吐校准只测量结构化输出速度，不进入居民记忆、关系、行动或正式研究数据。' };
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

function planningOptions(ctx: Record<string, unknown>): { id: string; fromMinute: number | null; toMinute: number | null }[] {
  if (!Array.isArray(ctx.planningOptions)) return [];
  return (ctx.planningOptions as unknown[]).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const option = value as Record<string, unknown>;
    if (typeof option.id !== 'string') return [];
    return [{
      id: option.id,
      fromMinute: typeof option.fromMinute === 'number' ? option.fromMinute : null,
      toMinute: typeof option.toMinute === 'number' ? option.toMinute : null,
    }];
  });
}

/** 确定性动作决策：玩家指令最优先；其次作息槽；否则原地小憩 */
function decideAction(ctx: Record<string, unknown>): Decision {
  const instruction = ctx.playerInstruction as string | null | undefined;
  if (instruction) {
    const objects = (ctx.objects ?? []) as { id: string; name: string; affordances?: { verb: string }[] }[];
    const hit = objects.find((o) => instruction.includes(o.name));
    if (hit) {
      return { thought: `按玩家的指令：${instruction}`, action: { type: 'interact', target: hit.id, verb: instruction.slice(0, 20) }, durationMinutes: 15 };
    }
    return { thought: `尝试执行玩家指令：${instruction}`, action: { type: 'idle', target: null, verb: instruction.slice(0, 20) }, durationMinutes: 10 };
  }
  const t = Number(ctx.minuteOfDay ?? 0);
  const routine = (ctx.routine as RoutineSlot[]) ?? [];
  const guidance = Array.isArray(ctx.behaviorGuidance) ? (ctx.behaviorGuidance as string[]).filter(Boolean) : [];
  const mindState = (ctx.mindState ?? null) as { stress?: number; socialNeed?: number } | null;
  const objects = (ctx.objects ?? []) as { id: string; name: string; affordances?: { verb: string }[] }[];
  const hh = String(Math.floor(t / 60)).padStart(2, '0');
  const mm = String(t % 60).padStart(2, '0');
  const slot = routine.find((s) => t >= s.from && t < s.to);
  if (slot) {
    return {
      thought: `现在${hh}:${mm}，按作息安排去「${slot.verb}」。${guidance[0] ? `我会同时记住：${guidance[0]}` : ''}`,
      action: { type: slot.type, target: slot.target, verb: slot.verb },
      durationMinutes: Math.min(15, Math.max(1, slot.to - t)),
    };
  }
  if (Number(mindState?.stress ?? 0) >= 0.78) {
    return {
      thought: '我感到压力偏高，先短暂恢复精力，再继续履行职责。',
      action: { type: 'idle', target: null, verb: '调整心态并休息' },
      durationMinutes: 10,
    };
  }
  const guidedTarget = guidance.length
    ? objects.find((object) => guidance.some((item) => item.includes(object.name) || item.includes(object.id)))
    : undefined;
  if (guidedTarget) {
    const groundedVerb = guidedTarget.affordances?.[0]?.verb;
    return {
      thought: `根据最近的反思，我准备落实「${guidance[0]}」。`,
      action: groundedVerb
        ? { type: 'interact', target: guidedTarget.id, verb: groundedVerb }
        : { type: 'move_to', target: guidedTarget.id, verb: '前往落实反思安排' },
      durationMinutes: 10,
    };
  }
  if (Number(mindState?.socialNeed ?? 0) >= 0.75) {
    const socialPlace = objects.find((object) => /广场|咖啡馆|酒馆|公园/.test(object.name));
    if (socialPlace) {
      return {
        thought: '我想和镇上的人保持联系，去公共场所看看。',
        action: { type: 'move_to', target: socialPlace.id, verb: '寻找交流机会' },
        durationMinutes: 10,
      };
    }
  }
  const next = [...routine].sort((a, b) => a.from - b.from).find((s) => s.from > t);
  const untilNext = (next ? next.from : MINUTES_PER_DAY) - t;
  return {
    thought: '现在没有安排，休息一会儿。',
    action: { type: 'idle', target: null, verb: '休息' },
    durationMinutes: Math.max(1, Math.min(30, untilNext)),
  };
}

function journalReflection(ctx: Record<string, unknown>): Record<string, unknown> {
  const evidence = Array.isArray(ctx.evidence)
    ? (ctx.evidence as { id?: unknown; content?: unknown; importance?: unknown }[])
      .filter((item) => typeof item.id === 'string' && typeof item.content === 'string')
      .map((item) => ({ id: String(item.id), content: String(item.content), importance: Number(item.importance ?? 5) }))
    : [];
  const persona = (ctx.persona ?? {}) as { occupation?: string; personality?: { extraversion?: number }; goals?: string[] };
  const priorInsights = Array.isArray(ctx.priorInsights) ? (ctx.priorInsights as string[]).filter(Boolean) : [];
  const candidateInsights = Array.isArray(ctx.candidateInsights) ? (ctx.candidateInsights as string[]).filter(Boolean) : [];
  const joined = evidence.map((item) => item.content).join('；');
  const positive = (joined.match(/顺利|完成|喜欢|邀请|帮助|愉快|不错|成功|收到|感谢/g) ?? []).length;
  const negative = (joined.match(/失败|争执|拒绝|堵住|压力|疲惫|讨厌|误会|事故|取消/g) ?? []).length;
  const social = (joined.match(/聊天|对话|邀请|帮助|一起|朋友|关系|说/g) ?? []).length;
  const work = (joined.match(/工作|经营|送信|写生|画|咖啡|书店|邮局|诊所|农场|修理/g) ?? []).length;
  const total = Math.max(1, evidence.length);
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const clampSigned = (value: number) => Math.max(-1, Math.min(1, value));
  const valence = clampSigned((positive - negative) / Math.max(2, positive + negative));
  const stress = clamp01(0.25 + negative * 0.12 + Math.max(0, evidence.length - 12) * 0.015);
  const energy = clamp01(0.72 - stress * 0.35);
  const socialNeed = clamp01(0.35 + Number(persona.personality?.extraversion ?? 0.5) * 0.35 - Math.min(0.25, social / total * 0.2));
  const occupationalFocus = clamp01(0.45 + Math.min(0.45, work / total * 0.7));
  const source = evidence.slice(-4).map((item) => item.content.replace(/^第\d+天\s*/, '')).join('；');
  const occupation = persona.occupation || '小镇居民';
  const diary = evidence.length
    ? `今天作为${occupation}，我记下了这些经历：${source}。这是我的主观看法：${valence >= 0 ? '整体还算踏实' : '有些事情需要重新消化'}，明天要在职责、关系和休息之间做得更稳。`
    : `今天作为${occupation}，我没有足够的事件证据可供总结。我会保持原有职责，并继续观察自己的状态。`;
  const insights = (candidateInsights.length
    ? candidateInsights
    : evidence.slice(-3).map((item) => `我注意到「${item.content.slice(0, 48)}」影响了今天的判断。`)
  ).slice(0, 5);
  const evidenceIds = evidence.slice(-5).map((item) => item.id);
  const contradictsPrior = /不再|改变|误会|失败|拒绝|争执|却|但是/.test(joined);
  const revisions = contradictsPrior && priorInsights[0] && insights[0]
    ? [{ previous: priorInsights[0], revised: insights[0], reason: '今天出现了与旧判断不完全一致的新证据。', evidence_ids: evidenceIds }]
    : [];
  const guidance = [
    `优先履行${occupation}的核心职责，并在行动后检查结果。`,
    stress >= 0.65 ? '安排一次短暂休息，避免在高压力下连续决策。' : '保持稳定节奏，给个人目标留出时间。',
    socialNeed >= 0.65 ? '到广场或其他公共空间主动维持一段重要关系。' : '对今天的重要互动做一次有针对性的回应。',
  ];
  return {
    diary,
    mind_state: {
      valence, energy, stress, social_need: socialNeed, occupational_focus: occupationalFocus,
      summary: `${valence >= 0 ? '情绪较平稳' : '情绪略低'}，${stress >= 0.65 ? '压力偏高' : '压力可控'}，对${occupation}职责的投入度${occupationalFocus >= 0.65 ? '较高' : '一般'}。`,
    },
    insights,
    beliefs: insights.slice(0, 3).map((statement, index) => ({
      statement,
      confidence: Math.min(0.9, 0.55 + evidenceIds.length * 0.05),
      evidence_ids: evidenceIds,
      status: revisions.length && index === 0 ? 'revised' : priorInsights.includes(statement) ? 'reinforced' : 'new',
      supersedes: revisions.length && index === 0 ? priorInsights[0] : null,
    })),
    revisions,
    behavior_guidance: guidance,
  };
}

function dialogueTurn(ctx: Record<string, unknown>): { utterance: string; end_dialogue: boolean } {
  const rumors = Array.isArray(ctx.rumors) ? (ctx.rumors as { id: string; content: string }[]) : [];
  const affection = Number(ctx.affection ?? 0);
  const honesty = Number(ctx.honesty ?? 0.5);
  if (rumors.length && affection >= 0.2) {
    const rumor = rumors[0];
    const text = honesty >= 0.6 ? rumor.content : `听说${rumor.content}（转述）`;
    return { utterance: text, end_dialogue: Number(ctx.turns ?? 0) >= 2 };
  }
  const pool = Array.isArray(ctx.speakerPool) && (ctx.speakerPool as string[]).length ? (ctx.speakerPool as string[]) : ['你好呀！', '今天天气真不错。'];
  const turns = Number(ctx.turns ?? 0);
  const base = pool[turns % pool.length];
  const history = Array.isArray(ctx.history) ? ctx.history as { content?: unknown }[] : [];
  const last = history.at(-1)?.content;
  if (turns > 0 && typeof last === 'string' && last.trim()) {
    return {
      utterance: deterministicDialogueResponse(last.trim(), base, turns).slice(0, 120),
      end_dialogue: turns >= 3,
    };
  }
  return { utterance: base, end_dialogue: turns >= 3 };
}

function deterministicDialogueResponse(prompt: string, base: string, turns: number): string {
  if (/读.{0,4}(?:什么|哪本|书)|什么书/u.test(prompt)) {
    return turns % 2 === 0 ? '最近没有特别在读哪本书，有合适的我再告诉你。' : '我最近没在读什么书，暂时不想随口编一个书名。';
  }
  if (/咖啡馆.{0,6}(?:忙|累)|(?:忙|累).{0,6}咖啡馆/u.test(prompt)) {
    return turns % 2 === 0 ? '今天还算忙，不过现在能和你聊两句。' : '今天不算太忙，手头的事情还应付得来。';
  }
  if (/谁|哪位/u.test(prompt)) return '具体是谁我还不能确定，先不乱猜。';
  if (/为什么|为何/u.test(prompt)) return '原因我还没有想清楚，暂时不能确定。';
  if (/怎么看|如何看|你觉得/u.test(prompt)) return '我现在还没有形成明确看法。';
  if (/[？?]|吗|呢/u.test(prompt)) return turns % 2 === 0 ? '这件事我现在还说不准。' : '我暂时没有把握回答。';
  const acknowledgements = ['听起来确实如此。', '这件事我记住了。', '嗯，我明白你的意思。'];
  const acknowledgement = acknowledgements[(turns - 1) % acknowledgements.length];
  return normalizeMockLine(base) === normalizeMockLine(prompt) ? acknowledgement : `${acknowledgement}${base}`;
}

function normalizeMockLine(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase('zh-CN');
}
