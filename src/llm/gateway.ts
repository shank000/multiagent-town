// LLMGateway：路由 + 重试 + 超时 + JSON 解析重试 + 按模板计量（design §7.1）

import type { LLMProvider, LLMRequest, LLMResponse } from './types';
import { DeepSeekProvider } from './deepseek';
import { OllamaProvider } from './ollama';
import { MockProvider } from './mock';

export interface GatewayConfig {
  provider?: LLMProvider | 'mock' | 'deepseek' | 'ollama';
  deepseek?: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number };
  ollama?: { baseUrl?: string; model?: string; smallModel?: string; timeoutMs?: number };
  retries?: number;   // 默认 2（共 3 次尝试）
  backoffMs?: number; // 默认 100，指数退避基数
}

export interface TemplateMetric {
  template: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costYuan: number;
}

export class LLMGateway {
  private provider: LLMProvider;
  private retries: number;
  private backoffMs: number;
  private metrics = new Map<string, TemplateMetric>();

  constructor(cfg: GatewayConfig) {
    this.retries = cfg.retries ?? 2;
    this.backoffMs = cfg.backoffMs ?? 100;
    const p = cfg.provider;
    if (p && typeof p !== 'string') {
      this.provider = p;
    } else if (p === 'deepseek') {
      if (!cfg.deepseek?.apiKey) throw new Error('provider=deepseek 需要 DEEPSEEK_API_KEY');
      this.provider = new DeepSeekProvider({
        apiKey: cfg.deepseek.apiKey,
        baseUrl: cfg.deepseek.baseUrl ?? 'https://api.deepseek.com',
        model: cfg.deepseek.model ?? 'deepseek-chat',
        timeoutMs: cfg.deepseek.timeoutMs ?? 30_000,
      });
    } else if (p === 'ollama') {
      this.provider = new OllamaProvider({
        baseUrl: cfg.ollama?.baseUrl ?? 'http://127.0.0.1:11434',
        model: cfg.ollama?.model ?? 'qwen2.5:7b',
        ...(cfg.ollama?.smallModel ? { smallModel: cfg.ollama.smallModel } : {}),
        timeoutMs: cfg.ollama?.timeoutMs ?? 120_000,
      });
    } else {
      this.provider = new MockProvider();
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.provider.complete(req);
        let parsed = res.parsed;
        if (req.jsonMode && parsed === null) {
          try {
            parsed = JSON.parse(res.content);
          } catch (e) {
            lastErr = e instanceof Error ? new Error(`JSON 解析失败: ${e.message}`) : new Error('JSON 解析失败');
            continue; // JSON 解析失败 → 计入重试次数，下一轮
          }
        }
        const final: LLMResponse = { ...res, parsed };
        this.record(req.template, final.usage);
        return final;
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) await sleep(this.backoffMs * 2 ** attempt);
      }
    }
    const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    if (err.name === 'TimeoutError' || /aborted due to timeout|timed out/i.test(err.message)) {
      // DOMException.message 是只读 getter，不能原地改写，改用带 cause 的包装 Error
      throw new Error(`${err.message}（${this.provider.name} 请求超时，已重试 ${this.retries} 次；本地 Ollama 可调大 OLLAMA_TIMEOUT_MS）`, { cause: err });
    }
    throw err;
  }

  private record(template: string, usage: LLMResponse['usage']): void {
    const m = this.metrics.get(template) ?? { template, calls: 0, inputTokens: 0, outputTokens: 0, costYuan: 0 };
    m.calls += 1;
    m.inputTokens += usage.inputTokens;
    m.outputTokens += usage.outputTokens;
    m.costYuan += usage.costYuan;
    this.metrics.set(template, m);
  }

  metricSummary(): TemplateMetric[] {
    return [...this.metrics.values()].sort((a, b) => a.template.localeCompare(b.template));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
