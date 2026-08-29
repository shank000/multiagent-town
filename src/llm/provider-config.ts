// 从环境变量解析 LLM 网关配置（provider 选择与各项设置）
// 支持：LLM_PROVIDER=mock|deepseek|ollama（默认 mock）
//   deepseek：DEEPSEEK_API_KEY（必填）
//   ollama：OLLAMA_BASE_URL / OLLAMA_MODEL / OLLAMA_SMALL_MODEL / OLLAMA_TIMEOUT_MS（默认 120000，本地推理需给足时间）

import type { GatewayConfig } from './gateway';

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
  const cfg: GatewayConfig = { provider, retries: 2 };
  if (provider === 'deepseek') {
    cfg.deepseek = { apiKey: process.env.DEEPSEEK_API_KEY ?? '' };
  } else if (provider === 'ollama') {
    cfg.ollama = {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
      ...(process.env.OLLAMA_SMALL_MODEL ? { smallModel: process.env.OLLAMA_SMALL_MODEL } : {}),
      timeoutMs: positiveIntegerFromEnv('OLLAMA_TIMEOUT_MS', 120_000),
    };
  }
  return cfg;
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
