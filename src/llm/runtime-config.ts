import type { GatewayConfig, LLMRuntimeMode } from './gateway';
import { LLMGateway } from './gateway';

export type ConfigurableLLMMode = Exclude<LLMRuntimeMode, 'custom'>;

export interface LLMConfigProbeResult {
  mode: ConfigurableLLMMode;
  provider: string;
  model: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** 将 UI 的不可信输入规范化为共享网关配置。 */
export function gatewayConfigFromRuntimeInput(input: unknown): GatewayConfig {
  const value = recordOf(input, '模型配置');
  const mode = value.mode;
  if (mode === 'mock') {
    return { provider: 'mock', maxConcurrent: 8, maxQueued: 256, expectedActiveAgents: 18 };
  }
  if (mode === 'ollama') {
    const baseUrl = endpointOf(value.baseUrl, 'Ollama 地址', 'http://127.0.0.1:11434');
    const model = textOf(value.model, '主模型', 1, 160, 'qwen3:4b');
    const smallModel = textOf(value.smallModel, '高频模型', 1, 160, model);
    const numCtx = integerOf(value.numCtx, '上下文窗口', 2048, 262_144, 8192);
    const timeoutMs = integerOf(value.timeoutMs, '请求超时', 1_000, 2_147_483_647, 120_000);
    return {
      provider: 'ollama',
      ollama: { baseUrl, model, smallModel, numCtx, timeoutMs, keepAlive: '10m' },
      maxConcurrent: 1,
      maxQueued: 96,
      expectedActiveAgents: 18,
    };
  }
  if (mode === 'api') {
    const baseUrl = endpointOf(value.baseUrl, 'API 地址', 'https://api.deepseek.com');
    const model = textOf(value.model, 'API 模型', 1, 160, 'deepseek-chat');
    const apiKey = textOf(value.apiKey, 'API Key', 1, 4096);
    const timeoutMs = integerOf(value.timeoutMs, '请求超时', 1_000, 2_147_483_647, 60_000);
    return {
      provider: 'deepseek',
      deepseek: { apiKey, baseUrl, model, timeoutMs },
      maxConcurrent: 4,
      maxQueued: 256,
      expectedActiveAgents: 18,
    };
  }
  throw new Error('模型运行方式必须是 mock、ollama 或 api');
}

/** 发出一次不写入世界状态的结构化探针，确认候选配置可实际生成。 */
export async function probeGatewayConfig(config: GatewayConfig): Promise<LLMConfigProbeResult> {
  const probe = new LLMGateway({ ...config, retries: 0, maxConcurrent: 1, maxQueued: 4 });
  const runtime = probe.runtimeSnapshot();
  const startedAt = Date.now();
  const response = await probe.complete({
    tier: 'small',
    template: 'throughput_calibration',
    jsonMode: true,
    jsonSchema: {
      type: 'object', additionalProperties: false, required: ['sample'],
      properties: { sample: { type: 'string', minLength: 8, maxLength: 160 } },
    },
    maxTokens: 96,
    temperature: 0,
    reasoning: false,
    priority: 'dialogue',
    scopeId: 'runtime-config-probe',
    timeoutMs: runtime.timeoutMs || 30_000,
    messages: [
      { role: 'system', content: '你是模型连接检测器。只输出符合 schema 的 JSON，不解释。' },
      { role: 'user', content: '用一句简短中文确认：模型已连接，可支持居民行动、规划、对话与反思。' },
    ],
  });
  const parsed = response.parsed as { sample?: unknown } | null;
  if (typeof parsed?.sample !== 'string' || parsed.sample.trim().length < 8) {
    throw new Error('模型连接成功，但结构化输出不符合要求');
  }
  return {
    mode: runtime.mode as ConfigurableLLMMode,
    provider: runtime.provider,
    model: runtime.smallModel ?? runtime.model,
    latencyMs: Math.max(1, Date.now() - startedAt),
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  };
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function textOf(value: unknown, label: string, min: number, max: number, fallback?: string): string {
  const text = typeof value === 'string' ? value.trim() : fallback ?? '';
  if (text.length < min || text.length > max) throw new Error(`${label}长度必须为 ${min}..${max}`);
  return text;
}

function integerOf(value: unknown, label: string, min: number, max: number, fallback: number): number {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}必须是 ${min}..${max} 的整数`);
  }
  return number;
}

function endpointOf(value: unknown, label: string, fallback: string): string {
  const text = textOf(value, label, 1, 2048, fallback).replace(/\/+$/, '');
  let endpoint: URL;
  try { endpoint = new URL(text); } catch { throw new Error(`${label}必须是有效的 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new Error(`${label}必须是无内嵌凭据、查询参数和片段的 HTTP(S) URL`);
  }
  return endpoint.toString().replace(/\/+$/, '');
}
