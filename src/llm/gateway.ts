// LLMGateway：路由 + 重试 + 超时 + JSON 解析重试 + 按模板计量（design §7.1）

import type { LLMProvider, LLMRequest, LLMRequestPriority, LLMResponse } from './types';
import { DeepSeekProvider } from './deepseek';
import { OllamaProvider } from './ollama';
import { MockProvider } from './mock';

export interface GatewayConfig {
  provider?: LLMProvider | 'mock' | 'deepseek' | 'ollama';
  deepseek?: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number };
  ollama?: {
    baseUrl?: string;
    model?: string;
    smallModel?: string;
    timeoutMs?: number;
    keepAlive?: string;
    agentModels?: Readonly<Record<string, string>>;
  };
  retries?: number;   // 默认 2（共 3 次尝试）
  backoffMs?: number; // 默认 100，指数退避基数
  maxConcurrent?: number; // 共享 provider 的最大并发；本地 Ollama 默认由环境配置为 1
  maxQueued?: number; // 有界等待队列；高优先级请求可替换最低优先级等待项
  highWaterMark?: number; // 世界时钟背压高水位
  lowWaterMark?: number; // 世界时钟背压解除水位
  expectedActiveAgents?: number; // 持续倍速估算所覆盖的居民数；三世界 Web 为 18
}

export interface TemplateMetric {
  template: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costYuan: number;
}

export interface SchedulerSnapshot {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  oldestWaitMs: number;
  backpressured: boolean;
  byPriority: Record<LLMRequestPriority, number>;
  byScope: Record<string, number>;
  performance: ThroughputSnapshot;
}

export interface ThroughputSnapshot {
  provider: string;
  sampleCount: number;
  generationTokensPerSecond: number | null;
  effectiveTokensPerSecond: number | null;
  p50LatencyMs: number | null;
  p90LatencyMs: number | null;
  recommendedMaxWorldSpeed: number | null;
  burstMaxWorldSpeed: 360;
  confidence: 'unavailable' | 'warming' | 'measured';
}

interface PerformanceSample {
  tier: LLMRequest['tier'];
  priority: LLMRequestPriority;
  wallMs: number;
  outputTokens: number;
  generationTokensPerSecond: number | null;
}

interface QueueItem {
  sequence: number;
  request: LLMRequest;
  priority: LLMRequestPriority;
  scopeId: string;
  enqueuedAt: number;
  deadlineAt: number | null;
  resolve: (response: LLMResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const PRIORITY_RANK: Record<LLMRequestPriority, number> = {
  dialogue: 0,
  action: 1,
  planning: 2,
  reflection: 3,
  background: 4,
};

const PRIORITIES = Object.keys(PRIORITY_RANK) as LLMRequestPriority[];

export class LLMQueueFullError extends Error {
  override readonly name = 'LLMQueueFullError';
}

export class LLMDeadlineExceededError extends Error {
  override readonly name = 'LLMDeadlineExceededError';
}

export class LLMGateway {
  private provider: LLMProvider;
  private retries: number;
  private backoffMs: number;
  private maxConcurrent: number;
  private maxQueued: number;
  private highWaterMark: number;
  private lowWaterMark: number;
  private metrics = new Map<string, TemplateMetric>();
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private sequence = 0;
  private lastScopeByRank = new Map<number, string>();
  private drainWaiters = new Set<() => void>();
  private pressureLatched = false;
  private expectedActiveAgents: number;
  private performanceSamples: PerformanceSample[] = [];
  private calibrationTask: Promise<ThroughputSnapshot> | null = null;

  constructor(cfg: GatewayConfig) {
    this.retries = cfg.retries ?? 2;
    this.backoffMs = cfg.backoffMs ?? 100;
    this.maxConcurrent = boundedInteger(cfg.maxConcurrent ?? 8, 'maxConcurrent', 1, 64);
    this.maxQueued = boundedInteger(cfg.maxQueued ?? 256, 'maxQueued', 1, 10_000);
    this.highWaterMark = boundedInteger(
      cfg.highWaterMark ?? Math.max(1, Math.ceil(this.maxQueued * 0.75)),
      'highWaterMark',
      1,
      this.maxQueued,
    );
    this.lowWaterMark = boundedInteger(
      cfg.lowWaterMark ?? Math.max(1, Math.floor(this.highWaterMark * 0.5)),
      'lowWaterMark',
      0,
      this.highWaterMark,
    );
    this.expectedActiveAgents = boundedInteger(cfg.expectedActiveAgents ?? 6, 'expectedActiveAgents', 1, 10_000);
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
        model: cfg.ollama?.model ?? 'qwen3:4b',
        ...(cfg.ollama?.smallModel ? { smallModel: cfg.ollama.smallModel } : {}),
        ...(cfg.ollama?.keepAlive ? { keepAlive: cfg.ollama.keepAlive } : {}),
        ...(cfg.ollama?.agentModels ? { agentModels: cfg.ollama.agentModels } : {}),
        timeoutMs: cfg.ollama?.timeoutMs ?? 120_000,
      });
    } else {
      this.provider = new MockProvider();
    }
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    validateRequestTimeout(req.timeoutMs);
    return new Promise<LLMResponse>((resolve, reject) => {
      const now = Date.now();
      const priority = req.priority ?? inferPriority(req.template);
      const item: QueueItem = {
        sequence: ++this.sequence,
        request: req,
        priority,
        scopeId: req.scopeId?.trim() || 'default',
        enqueuedAt: now,
        deadlineAt: req.timeoutMs === undefined ? null : now + req.timeoutMs,
        resolve,
        reject,
        timer: null,
      };
      if (!this.admit(item)) return;
      if (item.deadlineAt !== null) {
        item.timer = setTimeout(() => this.expireQueued(item), Math.max(1, item.deadlineAt - now));
      }
      this.queue.push(item);
      this.updatePressure();
      this.pump();
    });
  }

  private async completeWithRetry(req: LLMRequest, deadlineAt: number | null): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const startedAt = Date.now();
        const remaining = remainingMs(deadlineAt);
        if (remaining !== null && remaining <= 0) throw deadlineError(req);
        const providerRequest = remaining === null ? req : { ...req, timeoutMs: remaining };
        const res = await withDeadline(this.provider.complete(providerRequest), remaining, req);
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
        this.recordPerformance(req, final, Math.max(1, Date.now() - startedAt));
        return final;
      } catch (e) {
        lastErr = e;
        if (e instanceof LLMDeadlineExceededError) break;
        if (attempt < this.retries) {
          const delay = this.backoffMs * 2 ** attempt;
          const remaining = remainingMs(deadlineAt);
          if (remaining !== null && remaining <= delay) break;
          await sleep(delay);
        }
      }
    }
    const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    if (err.name === 'TimeoutError' || /aborted due to timeout|timed out/i.test(err.message)) {
      // DOMException.message 是只读 getter，不能原地改写，改用带 cause 的包装 Error
      const hint = this.provider.name === 'ollama' ? '；可通过 OLLAMA_TIMEOUT_MS 调整本地推理上限' : '';
      throw new Error(`${err.message}（${this.provider.name} 请求超时，已重试 ${this.retries} 次${hint}）`, { cause: err });
    }
    throw err;
  }

  /** 等待已发出的模型调用全部结算；停止世界循环后用于安全关闭。 */
  async drain(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  schedulerSnapshot(now = Date.now()): SchedulerSnapshot {
    const byPriority = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0])) as Record<LLMRequestPriority, number>;
    const byScope: Record<string, number> = {};
    for (const item of this.queue) {
      byPriority[item.priority] += 1;
      byScope[item.scopeId] = (byScope[item.scopeId] ?? 0) + 1;
    }
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      oldestWaitMs: this.queue.length ? Math.max(0, now - Math.min(...this.queue.map((item) => item.enqueuedAt))) : 0,
      backpressured: this.isBackpressured(),
      byPriority,
      byScope,
      performance: this.throughputSnapshot(),
    };
  }

  /** 运行两次不写入世界状态的代表性 structured-output 探针，并返回安全倍速建议。 */
  calibrate(): Promise<ThroughputSnapshot> {
    if (this.calibrationTask) return this.calibrationTask;
    this.calibrationTask = (async () => {
      const schema = {
        type: 'object', additionalProperties: false, required: ['sample'],
        properties: { sample: { type: 'string', minLength: 40, maxLength: 160 } },
      } as const;
      const probes = [
        '用 60 到 100 个汉字概括：可靠的社会模拟需要让人物只陈述可由记忆支持的事实，并直接回应上一句。',
        '用 60 到 100 个汉字概括：智能体行动应同时考虑职业作息、当前地点、近期记忆与可执行对象。',
      ];
      for (const prompt of probes) {
        await this.complete({
          tier: 'small', template: 'throughput_calibration', jsonMode: true, jsonSchema: schema,
          maxTokens: 192, temperature: 0, reasoning: false, priority: 'dialogue',
          scopeId: 'calibration', timeoutMs: 120_000,
          messages: [
            { role: 'system', content: '你是本地模型吞吐校准器。只输出符合 schema 的 JSON，不解释。' },
            { role: 'user', content: prompt },
          ],
        });
      }
      return this.throughputSnapshot();
    })().finally(() => { this.calibrationTask = null; });
    return this.calibrationTask;
  }

  /** 高速世界循环据此暂缓虚拟时间，先让真实模型清理认知积压。 */
  isBackpressured(): boolean {
    this.updatePressure();
    return this.pressureLatched;
  }

  private admit(incoming: QueueItem): boolean {
    if (this.queue.length < this.maxQueued) return true;
    const incomingRank = PRIORITY_RANK[incoming.priority];
    const candidates = this.queue
      .filter((item) => PRIORITY_RANK[item.priority] > incomingRank)
      .sort((left, right) => PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority]
        || right.sequence - left.sequence);
    const evicted = candidates[0];
    if (!evicted) {
      incoming.reject(new LLMQueueFullError(`LLM 等待队列已满（${this.maxQueued}），${incoming.priority} 请求未进入队列`));
      return false;
    }
    this.removeQueued(evicted, false);
    evicted.reject(new LLMQueueFullError(`LLM 等待队列为更高优先级的 ${incoming.priority} 请求释放容量`));
    return true;
  }

  private expireQueued(item: QueueItem): void {
    if (!this.queue.includes(item)) return;
    this.removeQueued(item);
    item.reject(deadlineError(item.request));
    this.pump();
  }

  private removeQueued(item: QueueItem, resolveDrain = true): void {
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
    if (item.timer) clearTimeout(item.timer);
    item.timer = null;
    this.updatePressure();
    if (resolveDrain) this.resolveDrainIfIdle();
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const item = this.takeNext();
      if (!item) break;
      if (item.timer) clearTimeout(item.timer);
      item.timer = null;
      if (item.deadlineAt !== null && item.deadlineAt <= Date.now()) {
        item.reject(deadlineError(item.request));
        continue;
      }
      this.activeCount += 1;
      this.updatePressure();
      void this.completeWithRetry(item.request, item.deadlineAt).then(item.resolve, item.reject).finally(() => {
        this.activeCount -= 1;
        this.updatePressure();
        this.pump();
        this.resolveDrainIfIdle();
      });
    }
    this.resolveDrainIfIdle();
  }

  private takeNext(now = Date.now()): QueueItem | null {
    if (!this.queue.length) return null;
    const effectiveRank = (item: QueueItem) => Math.max(0, PRIORITY_RANK[item.priority] - Math.floor((now - item.enqueuedAt) / 30_000));
    const bestRank = Math.min(...this.queue.map(effectiveRank));
    const eligible = this.queue.filter((item) => effectiveRank(item) === bestRank).sort((a, b) => a.sequence - b.sequence);
    const lastScope = this.lastScopeByRank.get(bestRank);
    const eligibleScopes = new Set(eligible.map((item) => item.scopeId));
    const scopeOrder = [...new Set([
      ...this.queue.map((item) => item.scopeId),
      ...(lastScope ? [lastScope] : []),
    ])].sort((left, right) => left.localeCompare(right));
    const lastIndex = lastScope ? scopeOrder.indexOf(lastScope) : -1;
    let scope = eligible[0].scopeId;
    for (let offset = 1; offset <= scopeOrder.length; offset++) {
      const candidate = scopeOrder[(lastIndex + offset) % scopeOrder.length];
      if (eligibleScopes.has(candidate)) {
        scope = candidate;
        break;
      }
    }
    const chosen = eligible.find((item) => item.scopeId === scope) ?? eligible[0];
    this.lastScopeByRank.set(bestRank, chosen.scopeId);
    this.removeQueued(chosen, false);
    return chosen;
  }

  private updatePressure(): void {
    const load = this.activeCount + this.queue.length;
    if (!this.pressureLatched && load >= this.highWaterMark) this.pressureLatched = true;
    else if (this.pressureLatched && load <= this.lowWaterMark) this.pressureLatched = false;
  }

  private resolveDrainIfIdle(): void {
    if (this.activeCount !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
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

  throughputSnapshot(): ThroughputSnapshot {
    const eligible = this.performanceSamples.filter((sample) => sample.priority !== 'background' && sample.outputTokens > 0);
    if (!eligible.length) {
      return {
        provider: this.provider.name, sampleCount: 0, generationTokensPerSecond: null,
        effectiveTokensPerSecond: null, p50LatencyMs: null, p90LatencyMs: null,
        recommendedMaxWorldSpeed: null, burstMaxWorldSpeed: 360, confidence: 'unavailable',
      };
    }
    const generationRates = eligible.map((sample) => sample.generationTokensPerSecond).filter((value): value is number => value !== null);
    const effectiveRates = eligible.map((sample) => sample.outputTokens / (sample.wallMs / 1000));
    const latencies = eligible.map((sample) => sample.wallMs);
    const effective = percentile(effectiveRates, 0.25);
    const p90 = percentile(latencies, 0.9);
    const hasLargeSample = eligible.some((sample) => sample.tier === 'large');
    const rawRecommendation = recommendedSpeed(
      effective,
      p90,
      this.maxConcurrent,
      this.expectedActiveAgents,
    );
    return {
      provider: this.provider.name,
      sampleCount: eligible.length,
      generationTokensPerSecond: generationRates.length ? round1(percentile(generationRates, 0.5)) : null,
      effectiveTokensPerSecond: round1(percentile(effectiveRates, 0.5)),
      p50LatencyMs: Math.round(percentile(latencies, 0.5)),
      p90LatencyMs: Math.round(p90),
      // 冷启动探针只覆盖高频 small 层；在首次深反思完成前保持保守上限。
      recommendedMaxWorldSpeed: hasLargeSample ? rawRecommendation : Math.min(10, rawRecommendation),
      burstMaxWorldSpeed: 360,
      confidence: eligible.length >= 12 && hasLargeSample ? 'measured' : 'warming',
    };
  }

  private recordPerformance(req: LLMRequest, response: LLMResponse, wallMs: number): void {
    const generationRate = response.performance?.outputTokensPerSecond;
    this.performanceSamples.push({
      tier: req.tier,
      priority: req.priority ?? inferPriority(req.template),
      wallMs,
      outputTokens: response.usage.outputTokens,
      generationTokensPerSecond: typeof generationRate === 'number' && Number.isFinite(generationRate) && generationRate > 0
        ? generationRate
        : null,
    });
    if (this.performanceSamples.length > 120) this.performanceSamples.splice(0, this.performanceSamples.length - 120);
  }
}

function recommendedSpeed(
  effectiveTokensPerSecond: number,
  p90LatencyMs: number,
  maxConcurrent: number,
  expectedActiveAgents: number,
): number {
  // 每位居民约每 30 游戏分钟一次行动决策、每 60 分钟一次小时规划；
  // 65% 容量预算给日记、对话摘要、重写与突发会话保留余量。
  const requestCapacityPerSecond = maxConcurrent / Math.max(0.001, p90LatencyMs / 1000);
  const expectedRequestsPerGameMinute = expectedActiveAgents / 30 + expectedActiveAgents / 60;
  const workloadBound = requestCapacityPerSecond * 0.65 / expectedRequestsPerGameMinute;
  let rateBound = 1;
  if (effectiveTokensPerSecond >= 80 && p90LatencyMs <= 1_200) rateBound = 360;
  else if (effectiveTokensPerSecond >= 45 && p90LatencyMs <= 2_500) rateBound = 120;
  else if (effectiveTokensPerSecond >= 25 && p90LatencyMs <= 5_000) rateBound = 60;
  else if (effectiveTokensPerSecond >= 15 && p90LatencyMs <= 8_000) rateBound = 30;
  else if (effectiveTokensPerSecond >= 8 && p90LatencyMs <= 15_000) rateBound = 10;
  else if (effectiveTokensPerSecond >= 4 && p90LatencyMs <= 30_000) rateBound = 5;
  const presets = [1, 5, 10, 30, 60, 120, 360];
  return [...presets].reverse().find((speed) => speed <= workloadBound && speed <= rateBound) ?? 1;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function inferPriority(template: string): LLMRequestPriority {
  if (/dialogue|interview/i.test(template)) return 'dialogue';
  if (/action/i.test(template)) return 'action';
  if (/plan/i.test(template)) return 'planning';
  if (/reflection/i.test(template)) return 'reflection';
  return 'background';
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}

function validateRequestTimeout(value: number | undefined): void {
  if (value === undefined) return;
  boundedInteger(value, 'LLMRequest.timeoutMs', 1, 2_147_483_647);
}

function remainingMs(deadlineAt: number | null): number | null {
  return deadlineAt === null ? null : Math.max(0, deadlineAt - Date.now());
}

function deadlineError(req: LLMRequest): LLMDeadlineExceededError {
  return new LLMDeadlineExceededError(`${req.template} 在 ${req.timeoutMs ?? 0}ms 墙钟期限内未完成`);
}

async function withDeadline<T>(task: Promise<T>, timeoutMs: number | null, req: LLMRequest): Promise<T> {
  if (timeoutMs === null) return task;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError(req)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
