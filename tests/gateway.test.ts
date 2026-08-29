import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/llm/gateway';
import { StubProvider } from './helpers';
import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';

function ctxUser(ctx: object): ChatMessage {
  return { role: 'user', content: `可用对象：[]\n\n<M0_CONTEXT>\n${JSON.stringify(ctx)}\n</M0_CONTEXT>` };
}

const mockCtx = {
  minuteOfDay: 600,
  routine: [{ from: 540, to: 720, type: 'interact', target: 'obj:a', verb: '工作' }],
};

function req(messages: ChatMessage[], jsonMode = true): LLMRequest {
  return { tier: 'small', template: 'action_decision', messages, jsonMode, maxTokens: 512 };
}

test('mock provider 按作息输出确定性决策并计量', async () => {
  const g = new LLMGateway({ provider: 'mock' });
  const res = await g.complete(req([ctxUser(mockCtx)]));
  assert.deepEqual(res.parsed, {
    thought: '现在10:00，按作息安排去「工作」。',
    action: { type: 'interact', target: 'obj:a', verb: '工作' },
    duration_minutes: 15,
  });
  const summary = g.metricSummary();
  assert.equal(summary.length, 1);
  assert.equal(summary[0].template, 'action_decision');
  assert.equal(summary[0].calls, 1);
});

test('网关重试：前两次失败第三次成功', async () => {
  const stub = new StubProvider([new Error('a'), new Error('b'), { content: '{"ok":1}', parsed: { ok: 1 } }]);
  const g = new LLMGateway({ provider: stub, retries: 2, backoffMs: 1 });
  const res = await g.complete(req([ctxUser(mockCtx)]));
  assert.equal(stub.calls, 3);
  assert.equal(res.content, '{"ok":1}');
});

test('JSON 解析失败自动重试一次', async () => {
  const stub = new StubProvider([{ content: 'not json' }, { content: '{"ok":2}' }]);
  const g = new LLMGateway({ provider: stub, retries: 1, backoffMs: 1 });
  const res = await g.complete(req([ctxUser(mockCtx)]));
  assert.deepEqual(res.parsed, { ok: 2 });
  assert.equal(stub.calls, 2);
});

test('JSON 解析重试耗尽后抛出可读错误', async () => {
  const stub = new StubProvider([{ content: 'bad' }, { content: 'bad2' }]);
  const g = new LLMGateway({ provider: stub, retries: 1, backoffMs: 1 });
  await assert.rejects(() => g.complete(req([ctxUser(mockCtx)])), /JSON 解析失败/);
  assert.equal(stub.calls, 2);
});

test('重试耗尽后抛出最后一次错误', async () => {
  const stub = new StubProvider([new Error('x1'), new Error('x2'), new Error('x3')]);
  const g = new LLMGateway({ provider: stub, retries: 2, backoffMs: 1 });
  await assert.rejects(() => g.complete(req([ctxUser(mockCtx)])), /x3/);
  assert.equal(stub.calls, 3);
});

test('deepseek 模式缺 API key 直接报错', () => {
  assert.throws(
    () => new LLMGateway({ provider: 'deepseek', deepseek: { apiKey: '' } }),
    /DEEPSEEK_API_KEY/
  );
});

test('drain 等待关闭前已发出的模型调用完成', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: LLMProvider = {
    name: 'delayed',
    async complete(): Promise<LLMResponse> {
      await gate;
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider });
  const completion = gateway.complete(req([ctxUser(mockCtx)]));
  let drained = false;
  const draining = gateway.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([completion, draining]);
  assert.equal(drained, true);
});
