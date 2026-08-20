// 玩家扮演：自然语言指令覆盖 agent 决策（60 游戏分钟内最高优先级）

export class PlayerDirector {
  private overrides = new Map<string, { instruction: string; since: number }>();

  act(agentId: string, instruction: string, now: number): void {
    this.overrides.set(agentId, { instruction: instruction.slice(0, 120), since: now });
  }

  clear(agentId: string): void {
    this.overrides.delete(agentId);
  }

  current(agentId: string, now: number): string | null {
    const o = this.overrides.get(agentId);
    if (!o) return null;
    if (now - o.since > 60) {
      this.overrides.delete(agentId);
      return null;
    }
    return o.instruction;
  }
}
