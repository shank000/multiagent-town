import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/llm/gateway';
import { buildActionDecisionMessages, routineToText, ACTION_DECISION_TEMPLATE } from '../src/llm/prompts';
import { makeAgent, persona } from './helpers';
import type { LLMRequest } from '../src/llm/types';

test('routineToText 格式化作息为中文时段', () => {
  const p = persona({
    routine: [{ from: 450, to: 540, type: 'interact', target: 'obj:cafe_counter', verb: '开店准备' }],
  });
  assert.equal(routineToText(p), '07:30-09:00 在obj:cafe_counter开店准备');
});

test('buildActionDecisionMessages 含 persona/时钟/JSON 指令/M0_CONTEXT', () => {
  const agent = makeAgent({
    name: '林晚晴',
    persona: persona({ name: '林晚晴', occupation: '咖啡馆老板', routine: [{ from: 450, to: 540, type: 'interact', target: 'obj:cafe_counter', verb: '开店准备' }] }),
    locationId: 'obj:home',
  });
  const { messages } = buildActionDecisionMessages({
    agent,
    day: 1,
    minuteOfDay: 480,
    locationName: '家',
    objects: [{ id: 'obj:cafe_counter', name: '咖啡馆吧台' }],
    mockContext: { persona: agent.persona, minuteOfDay: 480, routine: agent.persona.routine },
  });
  const sys = messages.find((m) => m.role === 'system')!.content;
  assert.ok(sys.includes('林晚晴'));
  assert.ok(sys.includes('咖啡馆老板'));
  assert.ok(sys.includes('第1天 08:00'));
  assert.ok(sys.includes('只输出 JSON'));
  const user = messages.find((m) => m.role === 'user')!.content;
  assert.ok(user.includes('obj:cafe_counter'));
  assert.ok(user.includes('<M0_CONTEXT>'));
});

test('day 字段透传：第 2 天时钟正确', () => {
  const agent = makeAgent({ persona: persona({ name: '甲' }) });
  const { messages } = buildActionDecisionMessages({
    agent, day: 2, minuteOfDay: 480, locationName: '家',
    objects: [],
    mockContext: { persona: agent.persona, minuteOfDay: 480, routine: agent.persona.routine },
  });
  const sys = messages.find((m) => m.role === 'system')!.content;
  assert.ok(sys.includes('第2天 08:00'));
});

test('提示词 → mock 网关端到端产出合法动作', async () => {
  const agent = makeAgent({
    persona: persona({ name: '甲', routine: [{ from: 540, to: 720, type: 'interact', target: 'obj:cafe', verb: '煮咖啡' }] }),
  });
  const { messages } = buildActionDecisionMessages({
    agent, day: 1, minuteOfDay: 600, locationName: '家',
    objects: [{ id: 'obj:cafe', name: '咖啡馆' }],
    mockContext: { persona: agent.persona, minuteOfDay: 600, routine: agent.persona.routine },
  });
  const g = new LLMGateway({ provider: 'mock' });
  const req: LLMRequest = { tier: 'small', template: ACTION_DECISION_TEMPLATE, messages, jsonMode: true, maxTokens: 512 };
  const res = await g.complete(req);
  const d = res.parsed as { action: { type: string; target: string; verb: string } };
  assert.equal(d.action.type, 'interact');
  assert.equal(d.action.target, 'obj:cafe');
  assert.equal(d.action.verb, '煮咖啡');
});
