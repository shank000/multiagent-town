import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentProfileDefinition } from '../engine/agent-profile';

export type AgentProfileConfig = Record<string, unknown>;

export function loadAgentProfileConfig(path: string | undefined): AgentProfileConfig {
  if (!path || !existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('居民档案配置必须是以稳定居民 ID 为键的对象');
  }
  return parsed as AgentProfileConfig;
}

export function saveAgentProfileConfig(
  path: string,
  profiles: Readonly<Record<string, AgentProfileDefinition>>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const ordered = Object.fromEntries(Object.entries(profiles).sort(([left], [right]) => left.localeCompare(right)));
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}
