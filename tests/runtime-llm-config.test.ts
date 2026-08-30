import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayConfigFromRuntimeInput, probeGatewayConfig } from '../src/llm/runtime-config';

test('UI 三种模型运行方式映射为安全的共享网关配置', () => {
  assert.deepEqual(gatewayConfigFromRuntimeInput({ mode: 'mock' }), {
    provider: 'mock', maxConcurrent: 8, maxQueued: 256, expectedActiveAgents: 18,
  });
  assert.deepEqual(gatewayConfigFromRuntimeInput({
    mode: 'ollama', baseUrl: 'http://127.0.0.1:11434/',
    model: 'qwen3:4b', smallModel: 'qwen3:4b-instruct', numCtx: 8192, timeoutMs: 120000,
  }), {
    provider: 'ollama',
    ollama: {
      baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', smallModel: 'qwen3:4b-instruct',
      numCtx: 8192, timeoutMs: 120000, keepAlive: '10m',
    },
    maxConcurrent: 1, maxQueued: 96, expectedActiveAgents: 18,
  });
  assert.deepEqual(gatewayConfigFromRuntimeInput({
    mode: 'api', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    apiKey: 'secret', timeoutMs: 60000,
  }), {
    provider: 'deepseek',
    deepseek: { apiKey: 'secret', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', timeoutMs: 60000 },
    maxConcurrent: 4, maxQueued: 256, expectedActiveAgents: 18,
  });
});

test('UI 模型配置拒绝未知模式、空凭据和危险端点', () => {
  assert.throws(() => gatewayConfigFromRuntimeInput({ mode: 'unknown' }), /mock、ollama 或 api/);
  assert.throws(() => gatewayConfigFromRuntimeInput({ mode: 'api', apiKey: '' }), /API Key/);
  assert.throws(() => gatewayConfigFromRuntimeInput({ mode: 'api', apiKey: 'x', baseUrl: 'file:///tmp/model' }), /HTTP\(S\)/);
  assert.throws(() => gatewayConfigFromRuntimeInput({ mode: 'api', apiKey: 'x', baseUrl: 'https://key@example.com/v1' }), /内嵌凭据/);
  assert.throws(() => gatewayConfigFromRuntimeInput({ mode: 'ollama', numCtx: 1024 }), /上下文窗口/);
});

test('Mock 连接探针不写世界状态并返回可展示结果', async () => {
  const result = await probeGatewayConfig(gatewayConfigFromRuntimeInput({ mode: 'mock' }));
  assert.equal(result.mode, 'mock');
  assert.equal(result.provider, 'mock');
  assert.equal(result.model, 'deterministic-simulation');
  assert.ok(result.latencyMs >= 1);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
});
