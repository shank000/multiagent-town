// 免费本地推理模型预设。所有居民共享 Ollama 服务与模型权重，persona/记忆/心智状态保持逐居民隔离。

export type OllamaProfileName = 'qwen3-single' | 'qwen3-balanced' | 'qwen3-tiered' | 'deepseek-tiered';

export interface OllamaModelProfile {
  name: OllamaProfileName;
  label: string;
  model: string;
  smallModel: string;
  description: string;
}

export const OLLAMA_MODEL_PROFILES: Readonly<Record<OllamaProfileName, OllamaModelProfile>> = {
  'qwen3-single': {
    name: 'qwen3-single',
    label: '单模型轻量推理',
    model: 'qwen3:4b',
    smallModel: 'qwen3:4b',
    description: '所有任务共享 Qwen3 4B，避免模型切换与重复显存占用。',
  },
  'qwen3-balanced': {
    name: 'qwen3-balanced',
    label: 'Qwen3 实时与深思分层',
    model: 'qwen3:4b',
    smallModel: 'qwen3:4b-instruct',
    description: '日记反思使用 Qwen3 4B Thinking，行动、规划与对话使用同系 4B Instruct。',
  },
  'qwen3-tiered': {
    name: 'qwen3-tiered',
    label: 'Qwen3 分层推理',
    model: 'qwen3:8b',
    smallModel: 'qwen3:1.7b',
    description: '规划、日记与反思使用 8B，即时动作和记忆评分使用 1.7B。',
  },
  'deepseek-tiered': {
    name: 'deepseek-tiered',
    label: 'DeepSeek-R1 分层推理',
    model: 'deepseek-r1:8b',
    smallModel: 'qwen3:1.7b',
    description: '复杂心智任务使用 DeepSeek-R1 8B，低延迟任务使用 Qwen3 1.7B。',
  },
};

export function resolveOllamaProfile(value: string | undefined): OllamaModelProfile {
  const name = value || 'qwen3-single';
  if (!(name in OLLAMA_MODEL_PROFILES)) {
    throw new Error(`未知的 OLLAMA_PROFILE=${name}，支持：${Object.keys(OLLAMA_MODEL_PROFILES).join(' | ')}`);
  }
  return OLLAMA_MODEL_PROFILES[name as OllamaProfileName];
}
