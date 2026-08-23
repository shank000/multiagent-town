// 从环境变量解析 LLM 网关配置（provider 选择与各项设置）
// 支持：LLM_PROVIDER=mock|deepseek|ollama（默认 mock）
//   deepseek：DEEPSEEK_API_KEY（必填）
//   ollama：OLLAMA_BASE_URL / OLLAMA_MODEL / OLLAMA_SMALL_MODEL / OLLAMA_TIMEOUT_MS

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
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 30_000),
    };
  }
  return cfg;
}