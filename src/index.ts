// 公共导出

export { TimeEngine, MINUTES_PER_DAY } from './core/time';
export { WorldState, GRID_W, GRID_H } from './core/world';
export { AgentExecutor } from './core/state-machine';
export { LLMGateway } from './llm/gateway';
export { MockProvider } from './llm/mock';
export { DeepSeekProvider } from './llm/deepseek';
export { OllamaProvider } from './llm/ollama';
export { providerNameFromEnv, gatewayConfigFromEnv } from './llm/provider-config';
export { openDb } from './store/db';
export { EventLog } from './store/events';
export { buildTown, TOWN_OBJECTS, LIN_PERSONA, CHEN_PERSONA, SHEN_PERSONA, ZHOU_PERSONA } from './engine/seed';
export { WorldLoop } from './engine/loop';
export type * from './core/types';
export type * from './llm/types';
