// OllamaProvider：本地 Ollama（http://127.0.0.1:11434）原生 /api/chat 实现
// - 按 tier 路由模型：small → smallModel ?? model；large → model
// - jsonMode 时用 Ollama 的 format=json 强制 JSON 输出
// - 本地推理，成本 costYuan 记 0（不产生 API 费用）

import type { LLMProvider, LLMRequest, LLMResponse } from './types';

/**
 * 解析 Ollama 的结构化输出。接受纯 JSON 对象与完整的 ```json 围栏；
 * 其余文本、多个 JSON 值、数组和标量均保持失败，以便网关按既有策略重试。
 */
function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  // 以围栏起始但不符合完整 json 围栏时，不退化为宽松文本提取。
  if (trimmed.startsWith('```') && !fenced) {
    throw new Error('Ollama JSON 输出无效：代码围栏必须是完整的 ```json 围栏');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (cause) {
    const detail = cause instanceof Error ? `：${cause.message}` : '';
    throw new Error(`Ollama JSON 输出无效${detail}`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ollama JSON 输出无效：必须是单个 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export interface OllamaConfig {
  baseUrl: string;     // 默认 http://127.0.0.1:11434
  model: string;       // large 层推理模型
  smallModel?: string; // 可选：small 层用小模型，默认同 model
  keepAlive?: string;  // Ollama 模型驻留时长，如 10m
  numCtx?: number;     // 每次请求的上下文窗口，默认 8192
  agentModels?: Readonly<Record<string, string>>; // 可选居民级覆盖，不复制模型服务
  timeoutMs: number;   // 默认 120000（本地推理慢，需给足时间）
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private cfg: OllamaConfig;

  constructor(cfg: OllamaConfig) {
    const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
    const model = cfg.model.trim();
    const smallModel = cfg.smallModel?.trim();
    const keepAlive = cfg.keepAlive?.trim();
    const numCtx = cfg.numCtx ?? 8192;
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new Error('Ollama baseUrl 必须是有效的 HTTP(S) URL');
    if (!model) throw new Error('Ollama model 不能为空');
    if (cfg.smallModel !== undefined && !smallModel) throw new Error('Ollama smallModel 不能为空');
    if (cfg.keepAlive !== undefined && (!keepAlive || !/^(?:\d+(?:ms|s|m|h)|-?\d+)$/.test(keepAlive))) {
      throw new Error('Ollama keepAlive 必须是时长（如 10m）或整数秒');
    }
    if (!Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0 || cfg.timeoutMs > 2_147_483_647) {
      throw new Error('Ollama timeoutMs 必须是 1..2147483647 的整数毫秒值');
    }
    if (!Number.isSafeInteger(numCtx) || numCtx < 2048 || numCtx > 262_144) {
      throw new Error('Ollama numCtx 必须是 2048..262144 的整数 token 数');
    }
    const agentModels = Object.fromEntries(Object.entries(cfg.agentModels ?? {}).map(([agentId, value]) => {
      const normalizedId = agentId.trim();
      const normalizedModel = value.trim();
      if (!normalizedId || !normalizedModel) throw new Error('Ollama agentModels 的居民 ID 与模型名不能为空');
      return [normalizedId, normalizedModel];
    }));
    this.cfg = {
      ...cfg,
      baseUrl,
      model,
      ...(smallModel ? { smallModel } : {}),
      ...(keepAlive ? { keepAlive } : {}),
      numCtx,
      ...(Object.keys(agentModels).length ? { agentModels } : {}),
    };
  }

  private pickModel(req: LLMRequest): string {
    if (req.agentId && this.cfg.agentModels?.[req.agentId]) return this.cfg.agentModels[req.agentId];
    return req.tier === 'small' ? (this.cfg.smallModel ?? this.cfg.model) : this.cfg.model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = this.pickModel(req);
    const temperature = req.temperature ?? 0.7;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error('Ollama temperature 必须是 0..2 的有限数值');
    }
    const res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: false,
        ...(req.jsonMode ? { format: req.jsonSchema ?? 'json' } : {}),
        // 显式关闭快速任务的思考模式。Thinking 模型若省略该字段，
        // 可能把整个 num_predict 预算用于隐式推理，留下空的 JSON content。
        think: req.reasoning === true,
        ...(this.cfg.keepAlive ? { keep_alive: this.cfg.keepAlive } : {}),
        options: {
          temperature,
          num_predict: req.maxTokens,
          // 服务端的 OLLAMA_CONTEXT_LENGTH 只提供默认值；请求级设置保证
          // 桌面版、命令行和外部启动的 Ollama 都使用相同研究条件。
          num_ctx: this.cfg.numCtx,
        },
      }),
      signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, req.timeoutMs ?? this.cfg.timeoutMs)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(ollamaHttpError(res.status, body, this.cfg.numCtx ?? 8192));
    }
    const data = (await res.json()) as {
      message?: { role?: string; content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      model?: string;
      total_duration?: number;
      load_duration?: number;
      prompt_eval_duration?: number;
      eval_duration?: number;
    };
    const content = data.message?.content ?? '';
    const parsed = req.jsonMode ? parseJsonObject(content) : null;
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return {
      content,
      parsed,
      usage: {
        inputTokens,
        outputTokens,
        costYuan: 0, // 本地推理不计费
      },
      performance: ollamaPerformance(data),
    };
  }
}

function ollamaHttpError(status: number, body: string, numCtx: number): string {
  const detail = unwrapOllamaError(body);
  const context = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(detail);
  if (context) {
    return `Ollama ${status}: 提示词需要 ${context[1]} token，模型当前仅提供 ${context[2]} token 上下文；本次请求 num_ctx=${numCtx}。请确认 Ollama 支持该窗口，或提高 OLLAMA_NUM_CTX。`;
  }
  return `Ollama ${status}: ${detail.slice(0, 500) || '请求失败且服务未返回错误详情'}`;
}

function unwrapOllamaError(body: string): string {
  let value: unknown = body.trim();
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof value === 'string') {
      const textValue = value;
      try {
        value = JSON.parse(textValue) as unknown;
        continue;
      } catch {
        return textValue;
      }
    }
    if (value && typeof value === 'object' && 'error' in value) {
      value = (value as { error: unknown }).error;
      continue;
    }
    if (value && typeof value === 'object' && 'message' in value) {
      const message = (value as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
    break;
  }
  return typeof value === 'string' ? value : body.trim();
}

function ollamaPerformance(data: {
  model?: string;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}): LLMResponse['performance'] {
  const generationMs = nsToMs(data.eval_duration);
  const outputTokensPerSecond = generationMs && data.eval_count
    ? data.eval_count / (generationMs / 1000)
    : undefined;
  return {
    ...(data.model ? { model: data.model } : {}),
    ...(nsToMs(data.total_duration) !== undefined ? { totalMs: nsToMs(data.total_duration) } : {}),
    ...(nsToMs(data.load_duration) !== undefined ? { loadMs: nsToMs(data.load_duration) } : {}),
    ...(nsToMs(data.prompt_eval_duration) !== undefined ? { promptMs: nsToMs(data.prompt_eval_duration) } : {}),
    ...(generationMs !== undefined ? { generationMs } : {}),
    ...(outputTokensPerSecond !== undefined ? { outputTokensPerSecond } : {}),
  };
}

function nsToMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1_000_000 : undefined;
}
