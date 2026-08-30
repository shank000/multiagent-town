import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/llm/gateway';
import {
  IMPORTANCE_TEMPLATE, DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE, REFLECTION_JOURNAL_TEMPLATE,
  DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, INTERVIEW_TEMPLATE,
  importanceMessages, dailyPlanMessages, hourPlanMessages, reflectionQuestionsMessages,
  reflectionInsightsMessages, reflectionJournalMessages, dialogueMessages, dialogueSummaryMessages, interviewMessages,
} from '../src/llm/prompts';
import { mockImportance } from '../src/llm/mock';
import { makeAgent, persona } from './helpers';

const g = new LLMGateway({ provider: 'mock' });

test('importance：mock 规则打分', async () => {
  assert.equal(mockImportance('今晚湖边派对，邀请所有人'), 9);
  assert.equal(mockImportance('开始煮咖啡'), 6);
  assert.equal(mockImportance('在公园散步'), 4);
  const res = await g.complete({ tier: 'small', template: IMPORTANCE_TEMPLATE, jsonMode: true, maxTokens: 64, messages: importanceMessages('筹备秘密画展') });
  assert.equal((res.parsed as { importance: number }).importance, 9);
});

test('daily_plan 与 hour_plan：确定性输出', async () => {
  const agent = makeAgent({ name: '林晚晴', persona: persona({ name: '林晚晴', routine: [{ from: 540, to: 600, type: 'interact', target: 'obj:cafe_counter', verb: '煮咖啡' }] }) });
  const r1 = await g.complete({ tier: 'large', template: DAILY_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: dailyPlanMessages(agent, 1, [], []) });
  assert.ok((r1.parsed as { broad_plan: string }).broad_plan.includes('咖啡馆'));
  const r2 = await g.complete({ tier: 'large', template: HOUR_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: hourPlanMessages(agent, 9, '照常经营') });
  const agenda = (r2.parsed as { agenda: { time: string; action: string }[] }).agenda;
  assert.equal(agenda[0].action, '煮咖啡');
  assert.equal(agenda[0].time, '09:00');
});

test('reflection 模板：3 问 + 证据洞察', async () => {
  const r1 = await g.complete({ tier: 'large', template: REFLECTION_QUESTIONS_TEMPLATE, jsonMode: true, maxTokens: 512, messages: reflectionQuestionsMessages(['在咖啡馆煮咖啡', '在公园散步']) });
  assert.equal((r1.parsed as { questions: string[] }).questions.length, 3);
  const r2 = await g.complete({ tier: 'large', template: REFLECTION_INSIGHTS_TEMPLATE, jsonMode: true, maxTokens: 512, messages: reflectionInsightsMessages('我常去哪？', ['在咖啡馆煮咖啡', '在公园散步']) });
  const insights = (r2.parsed as { insights: string[] }).insights;
  assert.equal(insights.length, 2);
  assert.ok(insights[0].startsWith('我'));
});

test('reflection journal：输出证据约束日记、心态、信念与行为指引', async () => {
  const agent = makeAgent({ name: '林晚晴', persona: persona({ name: '林晚晴', occupation: '咖啡馆老板' }) });
  const res = await g.complete({
    tier: 'large', template: REFLECTION_JOURNAL_TEMPLATE, jsonMode: true, maxTokens: 900, reasoning: true,
    messages: reflectionJournalMessages({
      agent, day: 1, kind: 'daily',
      evidence: [{ id: 'm1', content: '第1天 顺利完成咖啡馆工作并帮助朋友。', kind: 'observation', importance: 8 }],
      questions: ['今天做得怎样？'], candidateInsights: ['我重视稳定地完成工作。'],
      priorInsights: [], priorDiary: '', priorMindState: null,
    }),
  });
  const journal = res.parsed as { diary: string; mind_state: { stress: number }; beliefs: unknown[]; behavior_guidance: string[] };
  assert.ok(journal.diary.includes('咖啡馆老板'));
  assert.ok(journal.mind_state.stress >= 0 && journal.mind_state.stress <= 1);
  assert.ok(journal.beliefs.length >= 1);
  assert.ok(journal.behavior_guidance.some((item) => item.includes('咖啡馆老板')));
});

test('dialogue 与 summary：轮换台词、4 句后结束', async () => {
  const ctx = { speakerName: '林晚晴', speakerPool: ['你好呀！', '咖啡很香。', '常来坐坐。', '再见啦。'], otherName: '陈默', goal: '经营咖啡馆', turns: 0, rumors: [], affection: 0, honesty: 0.5 };
  const r1 = await g.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages(ctx) });
  const d1 = r1.parsed as { utterance: string; end_dialogue: boolean };
  assert.equal(d1.utterance, '你好呀！');
  assert.equal(d1.end_dialogue, false);
  const r2 = await g.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages({ ...ctx, turns: 3 }) });
  assert.equal((r2.parsed as { end_dialogue: boolean }).end_dialogue, true);
  const response = await g.complete({
    tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256,
    messages: dialogueMessages({
      ...ctx,
      turns: 1,
      history: [{ turnIndex: 0, speakerName: '陈默', listenerName: '林晚晴', content: '你今天在咖啡馆忙吗？' }],
    }),
  });
  const responseLine = (response.parsed as { utterance: string }).utterance;
  assert.match(responseLine, /你今天在咖啡馆忙吗/);
  assert.match(responseLine, /咖啡很香/);
  const followUp = await g.complete({
    tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256,
    messages: dialogueMessages({
      ...ctx,
      turns: 2,
      history: [
        { turnIndex: 0, speakerName: '陈默', listenerName: '林晚晴', content: '你今天在咖啡馆忙吗？' },
        { turnIndex: 1, speakerName: '林晚晴', listenerName: '陈默', content: responseLine },
      ],
    }),
  });
  const followUpLine = (followUp.parsed as { utterance: string }).utterance;
  assert.match(followUpLine, /你刚才提到「咖啡很香/);
  assert.match(followUpLine, /围绕我们的话题「你今天在咖啡馆忙吗/);
  assert.match(followUpLine, /常来坐坐/);
  const r3 = await g.complete({ tier: 'large', template: DIALOGUE_SUMMARY_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueSummaryMessages(['你好呀！', '咖啡很香。']) });
  assert.match((r3.parsed as { summary: string }).summary, /你好呀/);
});

test('interview：拼装记忆作答', async () => {
  const agent = makeAgent({ name: '林晚晴', persona: persona({ name: '林晚晴' }) });
  const res = await g.complete({ tier: 'large', template: INTERVIEW_TEMPLATE, jsonMode: true, maxTokens: 512, messages: interviewMessages(agent, '今天做了什么', ['在咖啡馆煮咖啡', '去书店看书'], []) });
  const ans = (res.parsed as { answer: string }).answer;
  assert.ok(ans.includes('我记得'));
  assert.ok(ans.includes('在咖啡馆煮咖啡'));
});
