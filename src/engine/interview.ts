// 访谈：上帝视角向任意 agent 提问，第一人称基于记忆回答（spec §10.2 的自动化版）

import type { Agent } from '../core/types';
import type { LLMGateway } from '../llm/gateway';
import type { MemoryStore } from '../store/memory';
import { INTERVIEW_TEMPLATE, interviewMessages } from '../llm/prompts';

export interface InterviewOptions {
  agent: Agent;
  question: string;
  llm: LLMGateway;
  store: MemoryStore;
  now: number;
  scopeId?: string;
}

export async function interviewAgent(opts: InterviewOptions): Promise<string> {
  const memories = opts.store.retrieve(opts.agent.id, opts.question, opts.now, 20).map((m) => m.content);
  const insights = opts.store.recentInsights(opts.agent.id, 5);
  const res = await opts.llm.complete({
    tier: 'small', template: INTERVIEW_TEMPLATE, jsonMode: true, maxTokens: 512, temperature: 0.3,
    messages: interviewMessages(opts.agent, opts.question, memories, insights),
    agentId: opts.agent.id,
    reasoning: false,
    priority: 'dialogue',
    scopeId: opts.scopeId ?? 'interview',
    timeoutMs: 60_000,
  });
  return ((res.parsed as { answer?: string } | null)?.answer) ?? '（我不知道）';
}
