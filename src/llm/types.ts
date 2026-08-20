// LLM 网关类型（design §7.1 的 M0 子集）

export type Tier = 'small' | 'large';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  tier: Tier;
  template: string;      // 计量与路由分组
  messages: ChatMessage[];
  jsonMode: boolean;
  maxTokens: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  costYuan: number;      // 按 DeepSeek ¥2/M 入、¥8/M 出估算；mock 为 0
}

export interface LLMResponse {
  content: string;       // 原始文本
  parsed: unknown;       // jsonMode 时解析后的对象（provider 可自行预解析）
  usage: LLMUsage;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}
