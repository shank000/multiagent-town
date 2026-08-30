// 从环境变量解析 LLM 网关配置（provider 选择与各项设置）
// 支持：LLM_PROVIDER=mock|deepseek|ollama（默认 mock）
//   deepseek：DEEPSEEK_API_KEY（必填）
//   ollama：OLLAMA_PROFILE / OLLAMA_MODEL / OLLAMA_SMALL_MODEL / OLLAMA_AGENT_MODELS /
//           OLLAMA_KEEP_ALIVE / OLLAMA_TIMEOUT_MS / LLM_MAX_CONCURRENCY / LLM_MAX_QUEUE

import type { GatewayConfig } from './gateway';
import { resolveOllamaProfile } from './model-profiles';

export type ProviderName = 'mock' | 'deepseek' | 'ollama';

export function providerNameFromEnv(): ProviderName {
  const name = (process.env.LLM_PROVIDER ?? 'mock') as ProviderName;
  if (name !== 'mock' && name !== 'deepseek' && name !== 'ollama') {
    throw new Error(`未知的 LLM_PROVIDER=${name}，支持：mock | deepseek | ollama`);
  }
  return name;
}

export function gatewayConfigFromEnv(): GatewayConfig {
  const provider = providerNameFromEnv();
  const cfg: GatewayConfig = {
    provider,
    retries: 2,
    maxConcurrent: provider === 'ollama' ? boundedIntegerFromEnv('LLM_MAX_CONCURRENCY', 1, 1, 64) : 8,
    maxQueued: boundedIntegerFromEnv('LLM_MAX_QUEUE', provider === 'ollama' ? 96 : 256, 1, 10_000),
  };
  if (provider === 'deepseek') {
    cfg.deepseek = { apiKey: process.env.DEEPSEEK_API_KEY ?? '' };
  } else if (provider === 'ollama') {
    const profile = resolveOllamaProfile(process.env.OLLAMA_PROFILE);
    const agentModels = agentModelsFromEnv(process.env.OLLAMA_AGENT_MODELS);
    cfg.ollama = {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL ?? profile.model,
      smallModel: process.env.OLLAMA_SMALL_MODEL ?? profile.smallModel,
      keepAlive: process.env.OLLAMA_KEEP_ALIVE ?? '10m',
      ...(agentModels ? { agentModels } : {}),
      timeoutMs: positiveIntegerFromEnv('OLLAMA_TIMEOUT_MS', 120_000),
    };
  }
  return cfg;
}

function agentModelsFromEnv(raw: string | undefined): Readonly<Record<string, string>> | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('OLLAMA_AGENT_MODELS 必须是 JSON 对象'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OLLAMA_AGENT_MODELS 必须是 JSON 对象');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error('OLLAMA_AGENT_MODELS 最多配置 64 位居民');
  const result: Record<string, string> = {};
  for (const [agentId, model] of entries) {
    if (!agentId.trim() || typeof model !== 'string' || !model.trim()) {
      throw new Error('OLLAMA_AGENT_MODELS 的居民 ID 与模型名必须是非空字符串');
    }
    result[agentId.trim()] = model.trim();
  }
  return result;
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} 必须是 1..2147483647 的整数毫秒值`);
  }
  return value;
}

function boundedIntegerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}
