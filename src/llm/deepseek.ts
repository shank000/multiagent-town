// DeepSeekProvider：OpenAI 兼容 /chat/completions

import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;   // 默认 https://api.deepseek.com
  model: string;     // 默认 deepseek-chat
  timeoutMs: number; // 默认 30000
}

export const PRICE_IN_PER_M = 2;  // 人民币元 / 百万 token（输入）
export const PRICE_OUT_PER_M = 8; // 人民币元 / 百万 token（输出）

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';

  constructor(private cfg: DeepSeekConfig) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages,
        temperature: 0.7,
        max_tokens: req.maxTokens,
        ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    return {
      content,
      parsed: null, // 由网关统一 JSON 解析
      usage: {
        inputTokens,
        outputTokens,
        costYuan: (inputTokens * PRICE_IN_PER_M + outputTokens * PRICE_OUT_PER_M) / 1_000_000,
      },
    };
  }
}
