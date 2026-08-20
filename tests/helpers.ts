// 测试共用工具（仅测试代码引用）

import type { Agent, Persona } from '../src/core/types';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';

export function persona(over: Partial<Persona> = {}): Persona {
  return {
    name: '测试员', age: 30, occupation: '测试', background: '无',
    traits: [], goals: [], speechStyle: '', routine: [],
    ...over,
  };
}

export function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:test', name: '测试员', persona: persona(),
    homeObjectId: 'obj:home', state: 'idle', locationId: 'obj:home',
    x: 0, y: 0, path: [], pathProgress: 0, action: null,
    actionEndsAt: 0, lastDecisionAt: 0, thought: null,
    ...over,
  };
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export interface StubItem { content: string; parsed?: unknown }

/** 脚本化 provider：队列里放 Error 抛错，或 {content, parsed?} 作为响应 */
export class StubProvider implements LLMProvider {
  name = 'stub';
  calls = 0;
  constructor(private queue: (Error | StubItem)[]) {}

  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const item = next ?? { content: '{}', parsed: {} };
    return {
      content: item.content,
      parsed: item.parsed ?? null,
      usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 },
    };
  }
}
