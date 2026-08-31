import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/llm/gateway';
import {
  ACTION_DECISION_TEMPLATE,
  buildActionDecisionMessages,
  dialogueMessages,
  reflectionJournalMessages,
  routineToText,
} from '../src/llm/prompts';
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
    playerInstruction: null,
    objects: [{ id: 'obj:cafe_counter', name: '咖啡馆吧台' }],
    mockContext: { persona: agent.persona, minuteOfDay: 480, routine: agent.persona.routine, memories: [], insights: [], agenda: null, playerInstruction: null, objects: [] },
  });
  const sys = messages.find((m) => m.role === 'system')!.content;
  assert.ok(sys.includes('林晚晴'));
  assert.ok(sys.includes('咖啡馆老板'));
  assert.ok(sys.includes('第1天 08:00'));
  assert.ok(sys.includes('当前作息约束'));
  assert.ok(sys.includes('开店准备'));
  assert.ok(sys.includes('只输出 JSON'));
  assert.ok(sys.includes('近期记忆'));
  assert.ok(sys.includes('自我认知'));
  assert.ok(sys.includes('"type":"move_to","target":"obj:cafe_counter"'));
  assert.ok(!sys.includes('整理物品'));
  const user = messages.find((m) => m.role === 'user')!.content;
  assert.ok(user.includes('obj:cafe_counter'));
  assert.ok(user.includes('<M0_CONTEXT>'));
});

test('动作提示的 interact 示例逐字采用对象声明的 affordance', () => {
  const agent = makeAgent({ persona: persona({ name: '甲', routine: [] }) });
  const { messages } = buildActionDecisionMessages({
    agent, day: 1, minuteOfDay: 600, locationName: '公园', playerInstruction: null,
    objects: [{
      id: 'obj:easel', name: '公园画架',
      affordances: [{ verb: '在公园写生', outcome: '完成一幅街景速写' }],
    }],
    mockContext: {
      persona: agent.persona, minuteOfDay: 600, routine: [], memories: [], insights: [], agenda: null,
      playerInstruction: null, objects: [],
    },
  });
  const system = messages[0].content;
  assert.ok(system.includes('"target":"obj:easel","verb":"在公园写生"'));
  assert.ok(!system.includes('整理物品'));
});

test('day 字段透传：第 2 天时钟正确', () => {
  const agent = makeAgent({ persona: persona({ name: '甲' }) });
  const { messages } = buildActionDecisionMessages({
    agent, day: 2, minuteOfDay: 480, locationName: '家', playerInstruction: null,
    objects: [],
    mockContext: { persona: agent.persona, minuteOfDay: 480, routine: agent.persona.routine, memories: [], insights: [], agenda: null, playerInstruction: null, objects: [] },
  });
  const sys = messages.find((m) => m.role === 'system')!.content;
  assert.ok(sys.includes('第2天 08:00'));
});

test('真实模型动作提示只发送一份语义上下文并保留全部可用对象', () => {
  const agent = makeAgent({ persona: persona({ name: '甲', occupation: '邮递员' }) });
  const { messages } = buildActionDecisionMessages({
    agent, day: 1, minuteOfDay: 600, locationName: '邮局', playerInstruction: null,
    objects: [{ id: 'obj:post_office', name: '邮局' }, { id: 'obj:plaza', name: '广场' }],
    mockContext: {
      persona: agent.persona, minuteOfDay: 600, routine: [], memories: [{ content: '上午需要投递信件。', importance: 7 }],
      insights: ['按路线依次投递更稳妥。'], agenda: '整理邮件', playerInstruction: null, objects: [],
    },
    includeMockContext: false,
  });
  const user = messages[1].content;
  assert.ok(user.includes('obj:post_office'));
  assert.ok(user.includes('obj:plaza'));
  assert.ok(!user.includes('<M0_CONTEXT>'));
  assert.ok(messages[0].content.includes('上午需要投递信件'));
  assert.ok(messages[0].content.includes('按路线依次投递更稳妥'));
});

test('动作决策提示包含日记形成的心态与行为指引，并区分主观解释与客观事实', () => {
  const agent = makeAgent({ persona: persona({ name: '甲', occupation: '邮递员' }) });
  const { messages } = buildActionDecisionMessages({
    agent, day: 2, minuteOfDay: 600, locationName: '邮局', playerInstruction: null,
    objects: [{ id: 'obj:plaza', name: '广场' }],
    mockContext: {
      persona: agent.persona, minuteOfDay: 600, routine: [], memories: [], insights: ['我需要修正昨天的判断。'],
      behaviorGuidance: ['去广场回应重要互动。'],
      mindState: { valence: -0.2, energy: 0.6, stress: 0.7, socialNeed: 0.8, occupationalFocus: 0.9, summary: '压力偏高但仍专注职责。' },
      agenda: null, playerInstruction: null, objects: [{ id: 'obj:plaza', name: '广场' }],
    },
  });
  const system = messages[0].content;
  assert.ok(system.includes('去广场回应重要互动'));
  assert.ok(system.includes('压力偏高但仍专注职责'));
  assert.ok(system.includes('不要把主观反思当成已经发生的事实'));
  assert.ok(system.includes('不得把未观察到的事件写成已经发生'));
});

test('提示词 → mock 网关端到端产出合法动作', async () => {
  const agent = makeAgent({
    persona: persona({ name: '甲', routine: [{ from: 540, to: 720, type: 'interact', target: 'obj:cafe', verb: '煮咖啡' }] }),
  });
  const { messages } = buildActionDecisionMessages({
    agent, day: 1, minuteOfDay: 600, locationName: '家', playerInstruction: null,
    objects: [{ id: 'obj:cafe', name: '咖啡馆' }],
    mockContext: { persona: agent.persona, minuteOfDay: 600, routine: agent.persona.routine, memories: [], insights: [], agenda: null, playerInstruction: null, objects: [] },
  });
  const g = new LLMGateway({ provider: 'mock' });
  const req: LLMRequest = { tier: 'small', template: ACTION_DECISION_TEMPLATE, messages, jsonMode: true, maxTokens: 512 };
  const res = await g.complete(req);
  const d = res.parsed as { action: { type: string; target: string; verb: string } };
  assert.equal(d.action.type, 'interact');
  assert.equal(d.action.target, 'obj:cafe');
  assert.equal(d.action.verb, '煮咖啡');
});

test('对话提示词允许结束对话（end_dialogue 非写死 false）', () => {
  const speakerPersona = persona({ name: '甲', occupation: '木匠', speechStyle: '简短直接' });
  const otherPersona = persona({ name: '乙', occupation: '医生' });
  const messages = dialogueMessages({
    speakerName: '甲', speakerPool: ['你好'], otherName: '乙', goal: '闲聊', turns: 1,
    rumors: [], affection: 0, honesty: 0.5,
    speakerPersona, otherPersona, locationId: 'obj:plaza', relationshipHistory: ['昨天约好修椅子。'],
    speakerMemories: ['今天修好了旧椅子的榫头。'],
    worldFacts: ['当前实际位置：中央广场', '小镇功能「花店服务台」：委托送花（功能存在不代表事件已经发生）'],
    conversationId: 'conversation:1', participants: ['agent:a', 'agent:b'],
    history: [{ turnIndex: 0, speakerName: '乙', listenerName: '甲', content: '你今天好吗？' }],
  });
  const sys = messages[0].content;
  assert.ok(sys.includes('end_dialogue": <true|false>'));
  assert.ok(!sys.includes('"end_dialogue": false"'));
  assert.ok(sys.includes('乙 → 甲：你今天好吗？'));
  assert.ok(sys.includes('必须承接对方最后一句'));
  assert.ok(sys.includes('甲，30 岁，女，木匠'));
  assert.ok(sys.includes('说话风格：简短直接'));
  assert.ok(sys.includes('昨天约好修椅子'));
  assert.ok(sys.includes('今天修好了旧椅子的榫头'));
  assert.ok(sys.includes('当前实际位置：中央广场'));
  assert.ok(sys.includes('功能存在不等于事件已发生'));
  assert.ok(sys.includes('任何已经发生的共同经历都必须有完成证据'));
  assert.ok(sys.includes('不要用「你刚才提到」'));
  assert.ok(sys.includes('第一句必须先给出答案'));
  assert.ok(sys.includes('禁止编造书名'));
});

test('对话提示仅携带有限会话窗口且 M0 上下文保持紧凑', () => {
  const messages = dialogueMessages({
    speakerName: '甲', speakerPool: Array.from({ length: 10 }, (_, index) => `问候${index}`),
    otherName: '乙', goal: '了解近况', turns: 12,
    rumors: Array.from({ length: 5 }, (_, index) => ({ id: `r${index}`, content: `传闻${index}` })),
    affection: 0.2, honesty: 0.7,
    speakerPersona: persona({ name: '甲' }), otherPersona: persona({ name: '乙' }),
    relationshipHistory: Array.from({ length: 6 }, (_, index) => `关系摘要${index}`),
    speakerMemories: Array.from({ length: 12 }, (_, index) => `个人记忆${index}`),
    worldFacts: Array.from({ length: 12 }, (_, index) => `世界事实${index}`),
    history: Array.from({ length: 12 }, (_, index) => ({
      turnIndex: index, speakerName: index % 2 ? '甲' : '乙', listenerName: index % 2 ? '乙' : '甲', content: `第${index + 1}句`,
    })),
  });
  assert.ok(!messages[0].content.includes('1. 乙 → 甲：第1句'));
  assert.ok(messages[0].content.includes('7. 乙 → 甲：第7句'));
  assert.ok(messages[0].content.includes('12. 甲 → 乙：第12句'));
  assert.ok(!messages[1].content.includes('speakerPersona'));
  assert.ok(!messages[1].content.includes('worldFacts'));
  assert.ok(messages[1].content.length < 1600);
});

test('可编辑长档案进入对话时保持有界且保留身份与说话风格', () => {
  const longPersona = persona({
    name: '甲', occupation: '社区工作者',
    background: '长期社区经历'.repeat(400),
    motivation: '希望理解邻里需求'.repeat(40),
    goals: Array.from({ length: 8 }, (_, index) => `目标${index}${'细节'.repeat(80)}`),
    values: Array.from({ length: 8 }, (_, index) => `价值${index}${'原则'.repeat(40)}`),
    speechStyle: `先回应问题，再谨慎说明依据，${'保持克制'.repeat(40)}`,
  });
  const messages = dialogueMessages({
    speakerName: '甲', speakerPool: [], otherName: '乙', goal: '了解对方今天的近况', turns: 6,
    rumors: Array.from({ length: 5 }, (_, index) => ({ id: `r${index}`, content: '传闻'.repeat(100) })),
    affection: 0.2, honesty: 0.8,
    speakerPersona: longPersona,
    otherPersona: { ...longPersona, name: '乙', background: '另一段社区经历'.repeat(400) },
    relationshipHistory: Array.from({ length: 6 }, () => '关系记忆'.repeat(100)),
    speakerMemories: Array.from({ length: 12 }, () => '个人记忆'.repeat(100)),
    worldFacts: Array.from({ length: 12 }, () => '现场事实'.repeat(100)),
    history: Array.from({ length: 12 }, (_, index) => ({
      turnIndex: index, speakerName: index % 2 ? '甲' : '乙', listenerName: index % 2 ? '乙' : '甲',
      content: '连续对话'.repeat(100),
    })),
  });
  const totalCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(totalCharacters < 7_000, `对话提示共 ${totalCharacters} 字符，超过有界窗口`);
  assert.ok(messages[0].content.includes('社区工作者'));
  assert.ok(messages[0].content.includes('先回应问题'));
  assert.ok(!messages[0].content.includes('长期社区经历'.repeat(100)));
});

test('反思日记提示规定紧凑且完整的证据约束 JSON', () => {
  const agent = makeAgent({ persona: persona({ name: '甲', occupation: '木匠' }) });
  const messages = reflectionJournalMessages({
    agent,
    day: 1,
    kind: 'daily',
    evidence: [{ id: 'e:1', content: '修好了一把旧椅子。', kind: 'action', importance: 8 }],
    questions: ['今天学到了什么？'],
    candidateInsights: ['我应该先检查木料。'],
    priorInsights: [],
    priorDiary: '',
    priorMindState: null,
  });
  const system = messages[0].content;
  assert.ok(system.includes('diary 80~180 字'));
  assert.ok(system.includes('完整闭合 JSON'));
  assert.ok(system.includes('没有修正时输出空 revisions 数组'));
  assert.ok(system.includes('不得添加证据中未出现的对话引语'));
});
