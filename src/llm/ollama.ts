// OllamaProvider：本地 Ollama（http://127.0.0.1:11434）原生 /api/chat 实现
// - 按 tier 路由模型：small → smallModel ?? model；large → model
// - jsonMode 时用 Ollama 的 format=json 强制 JSON 输出
// - 本地推理，成本 costYuan 记 0（不产生 API 费用）

import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export interface OllamaConfig {
  baseUrl: string;     // 默认 http://127.0.0.1:11434
  model: string;       // 默认 qwen2.5:7b（large 层）
  smallModel?: string; // 可选：small 层用小模型，默认同 model
  timeoutMs: number;   // 默认 120000（本地推理慢，需给足时间）
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(private cfg: OllamaConfig) {}

  private pickModel(req: LLMRequest): string {
    return req.tier === 'small' ? (this.cfg.smallModel ?? this.cfg.model) : this.cfg.model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.pickModel(req);
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: false,
        ...(req.jsonMode ? { format: 'json' } : {}),
        options: {
          temperature: 0.7,
          num_predict: req.maxTokens,
        },
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      message?: { role?: string; content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = data.message?.content ?? '';
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return {
      content,
      parsed: null, // 由网关统一 JSON 解析（format=json 下 content 通常是纯 JSON）
      usage: {
        inputTokens,
        outputTokens,
        costYuan: 0, // 本地推理不计费
      },
    };
  }
}