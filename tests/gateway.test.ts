import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMDeadlineExceededError, LLMGateway, LLMQueueFullError, LLMQueueWaitExceededError } from '../src/llm/gateway';
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

test('mock provider 在空闲时落实反思指引，并在高压力下先恢复精力', async () => {
  const g = new LLMGateway({ provider: 'mock' });
  const guided = await g.complete(req([ctxUser({
    minuteOfDay: 600,
    routine: [],
    objects: [{ id: 'obj:plaza', name: '广场' }],
    behaviorGuidance: ['去广场回应昨天的重要互动。'],
    mindState: { stress: 0.3, socialNeed: 0.6 },
  })]));
  assert.equal((guided.parsed as { action: { target: string } }).action.target, 'obj:plaza');

  const stressed = await g.complete(req([ctxUser({
    minuteOfDay: 600,
    routine: [],
    objects: [{ id: 'obj:plaza', name: '广场' }],
    behaviorGuidance: ['去广场回应昨天的重要互动。'],
    mindState: { stress: 0.9, socialNeed: 0.8 },
  })]));
  assert.equal((stressed.parsed as { action: { type: string; verb: string } }).action.type, 'idle');
  assert.equal((stressed.parsed as { action: { type: string; verb: string } }).action.verb, '调整心态并休息');
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

test('共享调度器限制并发并按对话、动作、规划优先级出队', async () => {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const provider: LLMProvider = {
    name: 'scheduled',
    async complete(request): Promise<LLMResponse> {
      started.push(request.template);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1, maxQueued: 8 });
  const planning = gateway.complete({ ...req([ctxUser(mockCtx)]), template: 'planning:first', priority: 'planning', scopeId: 'w1' });
  await waitFor(() => started.length === 1);
  const planningLater = gateway.complete({ ...req([ctxUser(mockCtx)]), template: 'planning:later', priority: 'planning', scopeId: 'w2' });
  const action = gateway.complete({ ...req([ctxUser(mockCtx)]), template: 'action:next', priority: 'action', scopeId: 'w3' });
  const dialogue = gateway.complete({ ...req([ctxUser(mockCtx)]), template: 'dialogue:now', priority: 'dialogue', scopeId: 'w1' });

  releases.shift()?.();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['planning:first', 'dialogue:now']);
  releases.shift()?.();
  await waitFor(() => started.length === 3);
  assert.equal(started[2], 'action:next');
  releases.shift()?.();
  await waitFor(() => started.length === 4);
  assert.equal(started[3], 'planning:later');
  releases.shift()?.();
  await Promise.all([planning, planningLater, action, dialogue]);
  assert.equal(gateway.schedulerSnapshot().active, 0);
});

test('同优先级请求按平行世界轮询而不是固定偏向 w1', async () => {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const provider: LLMProvider = {
    name: 'fair',
    async complete(request): Promise<LLMResponse> {
      started.push(`${request.scopeId}:${request.template}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1, maxQueued: 8 });
  const calls = [
    gateway.complete({ ...req([]), template: 'a', priority: 'action', scopeId: 'w1' }),
  ];
  await waitFor(() => started.length === 1);
  calls.push(gateway.complete({ ...req([]), template: 'b', priority: 'action', scopeId: 'w1' }));
  calls.push(gateway.complete({ ...req([]), template: 'c', priority: 'action', scopeId: 'w2' }));
  calls.push(gateway.complete({ ...req([]), template: 'd', priority: 'action', scopeId: 'w3' }));
  for (let count = 2; count <= 4; count++) {
    releases.shift()?.();
    await waitFor(() => started.length === count);
  }
  releases.shift()?.();
  await Promise.all(calls);
  assert.deepEqual(started, ['w1:a', 'w2:c', 'w3:d', 'w1:b']);
});

test('有界队列为高优先级对话释放容量，等待期限会清理过期请求', async () => {
  const releases: (() => void)[] = [];
  const provider: LLMProvider = {
    name: 'bounded',
    async complete(): Promise<LLMResponse> {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({
    provider, retries: 0, maxConcurrent: 1, maxQueued: 2, highWaterMark: 2, lowWaterMark: 0,
  });
  const active = gateway.complete({ ...req([]), template: 'active', priority: 'background' });
  await waitFor(() => gateway.schedulerSnapshot().active === 1);
  const oldBackground = gateway.complete({ ...req([]), template: 'old', priority: 'background' });
  const evictedResult = gateway.complete({ ...req([]), template: 'evicted', priority: 'background' }).catch((error: unknown) => error);
  const dialogue = gateway.complete({ ...req([]), template: 'dialogue', priority: 'dialogue', timeoutMs: 20 });
  const evicted = await evictedResult;
  assert.ok(evicted instanceof LLMQueueFullError);
  assert.equal(gateway.isBackpressured(), true);
  await assert.rejects(dialogue, (error: unknown) => (
    error instanceof LLMDeadlineExceededError && error instanceof LLMQueueWaitExceededError
  ));
  releases.shift()?.();
  await active;
  await waitFor(() => releases.length === 1);
  releases.shift()?.();
  await oldBackground;
  await gateway.drain();
  assert.equal(gateway.schedulerSnapshot().backpressured, false);
});

test('排队时间不占用 provider 生成期限', async () => {
  let releaseActive!: () => void;
  let dialogueQueueWaitMs = 0;
  const provider: LLMProvider = {
    name: 'separate-deadlines',
    async complete(request): Promise<LLMResponse> {
      if (request.template === 'active') {
        await new Promise<void>((resolve) => { releaseActive = resolve; });
      }
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1, maxQueued: 4 });
  const active = gateway.complete({ ...req([]), template: 'active', priority: 'background' });
  await waitFor(() => gateway.schedulerSnapshot().active === 1);
  const dialogue = gateway.complete({
    ...req([]), template: 'dialogue', priority: 'dialogue',
    timeoutMs: 20, queueTimeoutMs: 200,
    onDispatch: (queueWaitMs) => { dialogueQueueWaitMs = queueWaitMs; },
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  releaseActive();
  await Promise.all([active, dialogue]);
  assert.ok(dialogueQueueWaitMs >= 25);
});

test('非对话任务老化后仍不会抢占新到达的首轮对话', async () => {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const provider: LLMProvider = {
    name: 'strict-dialogue-priority',
    async complete(request): Promise<LLMResponse> {
      started.push(request.template);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1, maxQueued: 8, priorityAgingMs: 1 });
  const active = gateway.complete({ ...req([]), template: 'active', priority: 'background' });
  await waitFor(() => started.length === 1);
  const aged = gateway.complete({ ...req([]), template: 'aged-action', priority: 'action' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const dialogue = gateway.complete({ ...req([]), template: 'first-turn', priority: 'dialogue' });
  releases.shift()?.();
  await waitFor(() => started.length === 2);
  assert.equal(started[1], 'first-turn');
  releases.shift()?.();
  await waitFor(() => started.length === 3);
  assert.equal(started[2], 'aged-action');
  releases.shift()?.();
  await Promise.all([active, aged, dialogue]);
});

test('最老请求等待过久时触发世界时钟背压并公开原因', async () => {
  const releases: (() => void)[] = [];
  const provider: LLMProvider = {
    name: 'wait-pressure',
    async complete(): Promise<LLMResponse> {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { content: '{}', parsed: {}, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({
    provider, retries: 0, maxConcurrent: 1, maxQueued: 8,
    highWaterMark: 8, lowWaterMark: 0, backpressureWaitMs: 10, backpressureResumeWaitMs: 0,
  });
  const active = gateway.complete({ ...req([]), template: 'active', priority: 'background' });
  await waitFor(() => releases.length === 1);
  const queued = gateway.complete({ ...req([]), template: 'queued', priority: 'background' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const pressured = gateway.schedulerSnapshot();
  assert.equal(pressured.backpressured, true);
  assert.equal(pressured.pressureReason, 'queue_wait');
  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  releases.shift()?.();
  await Promise.all([active, queued]);
  assert.equal(gateway.schedulerSnapshot().pressureReason, null);
});

test('真实响应时序形成吞吐快照与可持续世界倍速建议', async () => {
  const provider: LLMProvider = {
    name: 'measured-local',
    async complete(): Promise<LLMResponse> {
      return {
        content: '{}', parsed: {}, usage: { inputTokens: 100, outputTokens: 60, costYuan: 0 },
        performance: { generationMs: 2_000, outputTokensPerSecond: 30 },
      };
    },
  };
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1 });
  await gateway.complete({ ...req([]), tier: 'small', template: 'dialogue', priority: 'dialogue' });
  const performance = gateway.throughputSnapshot();
  assert.equal(performance.provider, 'measured-local');
  assert.equal(performance.sampleCount, 1);
  assert.equal(performance.generationTokensPerSecond, 30);
  assert.ok((performance.effectiveTokensPerSecond ?? 0) > 0);
  assert.ok((performance.recommendedMaxWorldSpeed ?? 0) >= 1);
  assert.equal(performance.confidence, 'warming');
  assert.deepEqual(gateway.schedulerSnapshot().performance, performance);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
