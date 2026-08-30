// OllamaProvider / 网关 ollama 路由 / 环境变量设置 测试
// 用本地临时 HTTP 服务模拟 Ollama /api/chat，不依赖真实 Ollama

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from '../src/llm/ollama';
import { LLMGateway } from '../src/llm/gateway';
import { providerNameFromEnv, gatewayConfigFromEnv } from '../src/llm/provider-config';
import type { ChatMessage, LLMRequest } from '../src/llm/types';

interface ChatPayload {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  format?: string | Record<string, unknown>;
  think?: boolean;
  keep_alive?: string;
  options: { temperature: number; num_predict: number; num_ctx: number };
}

interface Capture {
  url: string | undefined;
  body: ChatPayload | null;
}

async function startFakeOllama(opts: {
  onRequest?: (c: Capture) => void;
  responder?: (b: ChatPayload) => { content: string };
  status?: number;
  errorBody?: unknown;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: ChatPayload | null = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatPayload;
      } catch {
        /* 非 JSON 请求体，保持 null */
      }
      opts.onRequest?.({ url: req.url, body });
      if (opts.status !== undefined && opts.status >= 400) {
        res.writeHead(opts.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts.errorBody ?? { error: 'boom' }));
        return;
      }
      const content = body ? opts.responder?.(body)?.content ?? '{}' : '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body?.model ?? 'qwen2.5:7b',
          message: { role: 'assistant', content },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
          total_duration: 200_000_000,
          load_duration: 10_000_000,
          prompt_eval_duration: 90_000_000,
          eval_duration: 100_000_000,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function req(tier: 'small' | 'large', jsonMode: boolean, content = 'hi'): LLMRequest {
  return { tier, template: 'action_decision', messages: [{ role: 'user', content }], jsonMode, maxTokens: 512 };
}

test('OllamaProvider 走本地 /api/chat 并解析 content/usage（成本为 0）', async (t) => {
  const captures: Capture[] = [];
  const fake = await startFakeOllama({
    onRequest: (c) => captures.push(c),
    responder: () => ({ content: '{"ok":1}' }),
  });
  t.after(() => fake.close());

  const p = new OllamaProvider({ baseUrl: `${fake.url}///`, model: ' qwen2.5:7b ', smallModel: ' qwen2.5:1.5b ', timeoutMs: 5000 });
  const res = await p.complete(req('large', true));

  assert.equal(res.content, '{"ok":1}');
  assert.deepEqual(res.parsed, { ok: 1 });
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5, costYuan: 0 });
  assert.deepEqual(res.performance, {
    model: 'qwen2.5:7b', totalMs: 200, loadMs: 10, promptMs: 90,
    generationMs: 100, outputTokensPerSecond: 50,
  });

  const sent = captures[0];
  assert.equal(sent.url, '/api/chat');
  assert.equal(sent.body?.model, 'qwen2.5:7b'); // large → model
  assert.equal(sent.body?.format, 'json');      // jsonMode → format=json
  assert.equal(sent.body?.stream, false);
  assert.equal(sent.body?.think, false);        // 快速任务显式禁用 Thinking 预算
  assert.deepEqual(sent.body?.options, { temperature: 0.7, num_predict: 512, num_ctx: 8192 });
});

test('small tier 使用 smallModel；jsonMode=false 不带 format', async (t) => {
  const captures: Capture[] = [];
  const fake = await startFakeOllama({ onRequest: (c) => captures.push(c) });
  t.after(() => fake.close());

  const p = new OllamaProvider({ baseUrl: fake.url, model: 'qwen2.5:7b', smallModel: 'qwen2.5:1.5b', timeoutMs: 5000 });
  await p.complete(req('small', false));

  assert.equal(captures[0].body?.model, 'qwen2.5:1.5b'); // small → smallModel
  assert.equal('format' in (captures[0].body as ChatPayload), false);
  assert.equal(captures[0].body?.think, false);
});

test('Ollama structured outputs 原样发送请求级 JSON Schema', async (t) => {
  const captures: Capture[] = [];
  const fake = await startFakeOllama({ onRequest: (capture) => captures.push(capture) });
  t.after(() => fake.close());
  const schema = {
    type: 'object', required: ['utterance'], properties: { utterance: { type: 'string' } },
  };
  const provider = new OllamaProvider({ baseUrl: fake.url, model: 'qwen3:4b-instruct', timeoutMs: 5000 });
  await provider.complete({ ...req('small', true), jsonSchema: schema });
  assert.deepEqual(captures[0].body?.format, schema);
});

test('网关 provider=ollama 路由、围栏 JSON 解析与计量', async (t) => {
  const fake = await startFakeOllama({ responder: () => ({ content: '```json\n{"z":1}\n```' }) });
  t.after(() => fake.close());

  const g = new LLMGateway({ provider: 'ollama', ollama: { baseUrl: fake.url, model: 'qwen2.5:7b', timeoutMs: 5000 } });
  const res = await g.complete(req('large', true));

  assert.deepEqual(res.parsed, { z: 1 });
  const m = g.metricSummary()[0];
  assert.equal(m.template, 'action_decision');
  assert.equal(m.calls, 1);
  assert.equal(m.inputTokens, 10);
  assert.equal(m.outputTokens, 5);
  assert.equal(m.costYuan, 0);
});

test('Ollama JSON 模式接受完整 json 围栏并保留原始 content', async (t) => {
  const fake = await startFakeOllama({ responder: () => ({ content: '\uFEFF  ```JSON\r\n{"nested":{"text":"} inside string"}}\r\n```  ' }) });
  t.after(() => fake.close());

  const provider = new OllamaProvider({ baseUrl: fake.url, model: 'qwen3:4b-instruct', timeoutMs: 5000 });
  const res = await provider.complete(req('small', true));

  assert.equal(res.content, '\uFEFF  ```JSON\r\n{"nested":{"text":"} inside string"}}\r\n```  ');
  assert.deepEqual(res.parsed, { nested: { text: '} inside string' } });
});

test('Ollama JSON 模式严格拒绝围栏外文本、多个值、非对象和破损围栏', async (t) => {
  const invalidContents = [
    '说明如下：\n{"ok":1}',
    '{"ok":1}\n{"extra":2}',
    '[{"ok":1}]',
    'null',
    '```json\n{"ok":1}',
    '```javascript\n{"ok":1}\n```',
  ];

  for (const content of invalidContents) {
    const fake = await startFakeOllama({ responder: () => ({ content }) });
    const provider = new OllamaProvider({ baseUrl: fake.url, model: 'qwen3:4b-instruct', timeoutMs: 5000 });
    try {
      await assert.rejects(() => provider.complete(req('small', true)), /Ollama JSON 输出无效/);
    } finally {
      await fake.close();
    }
  }
});

test('Ollama JSON 解析失败沿用网关重试与最终失败语义', async (t) => {
  let calls = 0;
  const fake = await startFakeOllama({
    onRequest: () => { calls += 1; },
    responder: () => ({ content: '```json\n{"unfinished":true' }),
  });
  t.after(() => fake.close());

  const gateway = new LLMGateway({
    provider: 'ollama',
    ollama: { baseUrl: fake.url, model: 'qwen3:4b-instruct', timeoutMs: 5000 },
    retries: 1,
    backoffMs: 1,
  });
  await assert.rejects(() => gateway.complete(req('small', true)), /Ollama JSON 输出无效/);
  assert.equal(calls, 2);
  assert.deepEqual(gateway.metricSummary(), []);
});

test('Ollama 非 200 响应抛出可读错误（网关可重试）', async (t) => {
  const fake = await startFakeOllama({ status: 503 });
  t.after(() => fake.close());

  const p = new OllamaProvider({ baseUrl: fake.url, model: 'qwen2.5:7b', timeoutMs: 5000 });
  await assert.rejects(() => p.complete(req('large', true)), /Ollama 503/);
});

test('Ollama 嵌套上下文错误展开为完整可操作诊断', async (t) => {
  const upstream = JSON.stringify({
    error: {
      code: 400,
      message: 'request (4149 tokens) exceeds the available context size (4096 tokens), try increasing it',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 4149,
    },
  });
  const fake = await startFakeOllama({ status: 400, errorBody: { error: upstream } });
  t.after(() => fake.close());
  const provider = new OllamaProvider({ baseUrl: fake.url, model: 'qwen3:4b-instruct', numCtx: 8192, timeoutMs: 5000 });
  await assert.rejects(
    () => provider.complete(req('small', true)),
    /提示词需要 4149 token，模型当前仅提供 4096 token 上下文；本次请求 num_ctx=8192.*OLLAMA_NUM_CTX/,
  );
});

test('gatewayConfigFromEnv 解析 ollama 环境变量设置', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = ['LLM_PROVIDER', 'OLLAMA_PROFILE', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_SMALL_MODEL', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_NUM_CTX', 'OLLAMA_AGENT_MODELS', 'OLLAMA_TIMEOUT_MS', 'LLM_MAX_CONCURRENCY', 'LLM_MAX_QUEUE'];
  for (const k of keys) prev[k] = process.env[k];
  process.env.LLM_PROVIDER = 'ollama';
  process.env.OLLAMA_PROFILE = 'qwen3-single';
  process.env.OLLAMA_BASE_URL = 'http://example.local:11434';
  process.env.OLLAMA_MODEL = 'llama3.1';
  process.env.OLLAMA_SMALL_MODEL = 'qwen2.5:1.5b';
  process.env.OLLAMA_KEEP_ALIVE = '12m';
  process.env.OLLAMA_NUM_CTX = '16384';
  process.env.OLLAMA_AGENT_MODELS = '{"agent:lin":"deepseek-r1:8b"}';
  process.env.OLLAMA_TIMEOUT_MS = '7000';
  process.env.LLM_MAX_CONCURRENCY = '2';
  process.env.LLM_MAX_QUEUE = '48';
  try {
    assert.equal(providerNameFromEnv(), 'ollama');
    const cfg = gatewayConfigFromEnv();
    assert.equal(cfg.provider, 'ollama');
    assert.equal(cfg.maxConcurrent, 2);
    assert.equal(cfg.maxQueued, 48);
    assert.deepEqual(cfg.ollama, {
      baseUrl: 'http://example.local:11434',
      model: 'llama3.1',
      smallModel: 'qwen2.5:1.5b',
      keepAlive: '12m',
      numCtx: 16384,
      agentModels: { 'agent:lin': 'deepseek-r1:8b' },
      timeoutMs: 7000,
    });
  } finally {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Ollama 免费推理预设默认单模型共享，并支持分层选择', () => {
  const keys = ['LLM_PROVIDER', 'OLLAMA_PROFILE', 'OLLAMA_MODEL', 'OLLAMA_SMALL_MODEL', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_NUM_CTX', 'OLLAMA_AGENT_MODELS', 'LLM_MAX_CONCURRENCY', 'LLM_MAX_QUEUE'];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.LLM_PROVIDER = 'ollama';
  for (const key of keys.slice(1)) delete process.env[key];
  try {
    assert.deepEqual(gatewayConfigFromEnv().ollama, {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:4b',
      smallModel: 'qwen3:4b',
      keepAlive: '10m',
      numCtx: 8192,
      timeoutMs: 120000,
    });
    assert.equal(gatewayConfigFromEnv().maxConcurrent, 1);
    assert.equal(gatewayConfigFromEnv().maxQueued, 96);
    process.env.OLLAMA_PROFILE = 'deepseek-tiered';
    const tiered = gatewayConfigFromEnv().ollama;
    assert.equal(tiered?.model, 'deepseek-r1:8b');
    assert.equal(tiered?.smallModel, 'qwen3:1.7b');
    process.env.OLLAMA_PROFILE = 'qwen3-balanced';
    const balanced = gatewayConfigFromEnv().ollama;
    assert.equal(balanced?.model, 'qwen3:4b');
    assert.equal(balanced?.smallModel, 'qwen3:4b-instruct');
  } finally {
    for (const key of keys) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('本地调度并发与队列环境变量只接受安全边界内整数', () => {
  const previous = {
    provider: process.env.LLM_PROVIDER,
    concurrency: process.env.LLM_MAX_CONCURRENCY,
    queue: process.env.LLM_MAX_QUEUE,
  };
  process.env.LLM_PROVIDER = 'ollama';
  try {
    for (const value of ['0', '1.5', '65']) {
      process.env.LLM_MAX_CONCURRENCY = value;
      assert.throws(() => gatewayConfigFromEnv(), /LLM_MAX_CONCURRENCY/);
    }
    process.env.LLM_MAX_CONCURRENCY = '1';
    for (const value of ['0', '1.5', '10001']) {
      process.env.LLM_MAX_QUEUE = value;
      assert.throws(() => gatewayConfigFromEnv(), /LLM_MAX_QUEUE/);
    }
  } finally {
    if (previous.provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous.provider;
    if (previous.concurrency === undefined) delete process.env.LLM_MAX_CONCURRENCY; else process.env.LLM_MAX_CONCURRENCY = previous.concurrency;
    if (previous.queue === undefined) delete process.env.LLM_MAX_QUEUE; else process.env.LLM_MAX_QUEUE = previous.queue;
  }
});

test('Ollama 居民级模型覆盖与推理模式进入官方 chat 请求字段', async (t) => {
  const captures: Capture[] = [];
  const fake = await startFakeOllama({ onRequest: (capture) => captures.push(capture) });
  t.after(() => fake.close());
  const provider = new OllamaProvider({
    baseUrl: fake.url,
    model: 'deepseek-r1:8b',
    smallModel: 'qwen3:1.7b',
    keepAlive: '10m',
    agentModels: { 'agent:lin': 'qwen3:4b' },
    timeoutMs: 5000,
  });
  await provider.complete({ ...req('large', true), temperature: 0.2, agentId: 'agent:lin', reasoning: true });
  assert.equal(captures[0].body?.model, 'qwen3:4b');
  assert.equal(captures[0].body?.think, true);
  assert.equal(captures[0].body?.keep_alive, '10m');
  assert.equal(captures[0].body?.options.temperature, 0.2);
});

test('未设置 LLM_PROVIDER 时默认 mock；未知值直接报错', () => {
  const prev = process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER;
  try {
    assert.equal(providerNameFromEnv(), 'mock');
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prev;
  }

  process.env.LLM_PROVIDER = 'gpt';
  try {
    assert.throws(() => gatewayConfigFromEnv(), /未知的 LLM_PROVIDER=gpt/);
  } finally {
    if (prev === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prev;
  }
});

test('Ollama 配置拒绝无效 URL、模型和超时', () => {
  assert.throws(() => new OllamaProvider({ baseUrl: 'file:///tmp/ollama', model: 'qwen', timeoutMs: 5000 }), /HTTP\(S\) URL/);
  assert.throws(() => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: '  ', timeoutMs: 5000 }), /model 不能为空/);
  assert.throws(() => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen', timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen', keepAlive: 'forever', timeoutMs: 5000 }), /keepAlive/);
  assert.throws(() => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen', agentModels: { 'agent:a': ' ' }, timeoutMs: 5000 }), /agentModels/);
  assert.throws(() => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen', numCtx: 1024, timeoutMs: 5000 }), /numCtx/);
});

test('Ollama 请求拒绝越界采样温度', async () => {
  const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen', timeoutMs: 5000 });
  await assert.rejects(() => provider.complete({ ...req('small', true), temperature: -0.1 }), /temperature/);
  await assert.rejects(() => provider.complete({ ...req('small', true), temperature: Number.NaN }), /temperature/);
});

test('无效推理预设和居民模型映射会被拒绝', () => {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousProfile = process.env.OLLAMA_PROFILE;
  const previousAgentModels = process.env.OLLAMA_AGENT_MODELS;
  process.env.LLM_PROVIDER = 'ollama';
  try {
    process.env.OLLAMA_PROFILE = 'unknown';
    assert.throws(() => gatewayConfigFromEnv(), /OLLAMA_PROFILE/);
    process.env.OLLAMA_PROFILE = 'qwen3-single';
    process.env.OLLAMA_AGENT_MODELS = '[]';
    assert.throws(() => gatewayConfigFromEnv(), /JSON 对象/);
    process.env.OLLAMA_AGENT_MODELS = '{"agent:a":""}';
    assert.throws(() => gatewayConfigFromEnv(), /非空字符串/);
  } finally {
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previousProvider;
    if (previousProfile === undefined) delete process.env.OLLAMA_PROFILE; else process.env.OLLAMA_PROFILE = previousProfile;
    if (previousAgentModels === undefined) delete process.env.OLLAMA_AGENT_MODELS; else process.env.OLLAMA_AGENT_MODELS = previousAgentModels;
  }
});

test('OLLAMA_TIMEOUT_MS 只接受正安全整数', () => {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousTimeout = process.env.OLLAMA_TIMEOUT_MS;
  process.env.LLM_PROVIDER = 'ollama';
  try {
    for (const value of ['0', '-1', '1.5', 'NaN', '2147483648']) {
      process.env.OLLAMA_TIMEOUT_MS = value;
      assert.throws(() => gatewayConfigFromEnv(), /OLLAMA_TIMEOUT_MS/);
    }
  } finally {
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previousProvider;
    if (previousTimeout === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
    else process.env.OLLAMA_TIMEOUT_MS = previousTimeout;
  }
});

test('OLLAMA_NUM_CTX 只接受安全上下文窗口', () => {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousNumCtx = process.env.OLLAMA_NUM_CTX;
  process.env.LLM_PROVIDER = 'ollama';
  try {
    for (const value of ['1024', '8192.5', '262145']) {
      process.env.OLLAMA_NUM_CTX = value;
      assert.throws(() => gatewayConfigFromEnv(), /OLLAMA_NUM_CTX/);
    }
  } finally {
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previousProvider;
    if (previousNumCtx === undefined) delete process.env.OLLAMA_NUM_CTX;
    else process.env.OLLAMA_NUM_CTX = previousNumCtx;
  }
});
