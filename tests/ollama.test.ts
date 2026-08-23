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
  format?: string;
  options: { temperature: number; num_predict: number };
}

interface Capture {
  url: string | undefined;
  body: ChatPayload | null;
}

async function startFakeOllama(opts: {
  onRequest?: (c: Capture) => void;
  responder?: (b: ChatPayload) => { content: string };
  status?: number;
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
        res.end(JSON.stringify({ error: 'boom' }));
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

  const p = new OllamaProvider({ baseUrl: fake.url, model: 'qwen2.5:7b', smallModel: 'qwen2.5:1.5b', timeoutMs: 5000 });
  const res = await p.complete(req('large', true));

  assert.equal(res.content, '{"ok":1}');
  assert.equal(res.parsed, null); // 由网关统一解析
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5, costYuan: 0 });

  const sent = captures[0];
  assert.equal(sent.url, '/api/chat');
  assert.equal(sent.body?.model, 'qwen2.5:7b'); // large → model
  assert.equal(sent.body?.format, 'json');      // jsonMode → format=json
  assert.equal(sent.body?.stream, false);
  assert.deepEqual(sent.body?.options, { temperature: 0.7, num_predict: 512 });
});

test('small tier 使用 smallModel；jsonMode=false 不带 format', async (t) => {
  const captures: Capture[] = [];
  const fake = await startFakeOllama({ onRequest: (c) => captures.push(c) });
  t.after(() => fake.close());

  const p = new OllamaProvider({ baseUrl: fake.url, model: 'qwen2.5:7b', smallModel: 'qwen2.5:1.5b', timeoutMs: 5000 });
  await p.complete(req('small', false));

  assert.equal(captures[0].body?.model, 'qwen2.5:1.5b'); // small → smallModel
  assert.equal('format' in (captures[0].body as ChatPayload), false);
});

test('网关 provider=ollama 路由、计量并统一解析 JSON', async (t) => {
  const fake = await startFakeOllama({ responder: () => ({ content: '{"z":1}' }) });
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

test('Ollama 非 200 响应抛出可读错误（网关可重试）', async (t) => {
  const fake = await startFakeOllama({ status: 503 });
  t.after(() => fake.close());

  const p = new OllamaProvider({ baseUrl: fake.url, model: 'qwen2.5:7b', timeoutMs: 5000 });
  await assert.rejects(() => p.complete(req('large', true)), /Ollama 503/);
});

test('gatewayConfigFromEnv 解析 ollama 环境变量设置', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = ['LLM_PROVIDER', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_SMALL_MODEL', 'OLLAMA_TIMEOUT_MS'];
  for (const k of keys) prev[k] = process.env[k];
  process.env.LLM_PROVIDER = 'ollama';
  process.env.OLLAMA_BASE_URL = 'http://example.local:11434';
  process.env.OLLAMA_MODEL = 'llama3.1';
  process.env.OLLAMA_SMALL_MODEL = 'qwen2.5:1.5b';
  process.env.OLLAMA_TIMEOUT_MS = '7000';
  try {
    assert.equal(providerNameFromEnv(), 'ollama');
    const cfg = gatewayConfigFromEnv();
    assert.equal(cfg.provider, 'ollama');
    assert.deepEqual(cfg.ollama, {
      baseUrl: 'http://example.local:11434',
      model: 'llama3.1',
      smallModel: 'qwen2.5:1.5b',
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