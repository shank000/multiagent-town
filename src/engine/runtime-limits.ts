/** 真实本地模型模式的统一世界速度上限。 */
export const MAX_WORLD_SPEED = 60;

/**
 * 世界时间治理器使用的离散档位。
 *
 * 1× 表示每个现实秒推进 1 个游戏分钟。低于 1× 的档位用于本地小模型、
 * CPU 推理与高并发多世界，避免模型输出尚未完成时社会时间已经跨越数小时。
 */
export const WORLD_SPEED_PRESETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10, 30, 60] as const;

export const MIN_WORLD_SPEED = WORLD_SPEED_PRESETS[0];
