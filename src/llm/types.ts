// LLM 网关类型（design §7.1 的 M0 子集）

export type Tier = 'small' | 'large';
export type LLMRequestPriority = 'dialogue' | 'action' | 'planning' | 'reflection' | 'background';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  tier: Tier;
  template: string;      // 计量与路由分组
  messages: ChatMessage[];
  jsonMode: boolean;
  /** Ollama structured outputs 使用的 JSON Schema；其他 provider 可继续采用 JSON object 模式。 */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  /** 采样温度；事实约束任务使用较低值，开放式规划保留适度变化。 */
  temperature?: number;
  /** 本地 provider 可据此使用居民级模型覆盖；其他 provider 可安全忽略。 */
  agentId?: string;
  /** 复杂规划/反思可请求推理模式；不保存或展示模型的隐式推理文本。 */
  reasoning?: boolean;
  /** 调度优先级：交互对话最高，后台记忆评分最低。 */
  priority?: LLMRequestPriority;
  /** 平行世界调度范围；同优先级按范围轮询，避免固定世界长期先发。 */
  scopeId?: string;
  /** 从进入网关到得到结果的墙钟时间上限，包含排队与重试。 */
  timeoutMs?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  costYuan: number;      // 按 DeepSeek ¥2/M 入、¥8/M 出估算；mock 为 0
}

export interface LLMPerformance {
  model?: string;
  totalMs?: number;
  loadMs?: number;
  promptMs?: number;
  generationMs?: number;
  outputTokensPerSecond?: number;
}

export interface LLMResponse {
  content: string;       // 原始文本
  parsed: unknown;       // jsonMode 时解析后的对象（provider 可自行预解析）
  usage: LLMUsage;
  /** provider 原生时序；用于吞吐校准，不进入人物记忆或研究处理变量。 */
  performance?: LLMPerformance;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}
