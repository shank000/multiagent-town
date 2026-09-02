// 玩家扮演：自然语言指令覆盖 agent 决策（60 游戏分钟内最高优先级）

export class PlayerDirector {
  private overrides = new Map<string, { instruction: string; since: number; revision: number }>();
  private nextRevision = 1;

  act(agentId: string, instruction: string, now: number): void {
    this.overrides.set(agentId, { instruction: instruction.slice(0, 120), since: now, revision: this.nextRevision++ });
  }

  clear(agentId: string): void {
    this.overrides.delete(agentId);
  }

  current(agentId: string, now: number): string | null {
    return this.currentDirective(agentId, now)?.instruction ?? null;
  }

  currentDirective(agentId: string, now: number): { instruction: string; revision: number } | null {
    const o = this.overrides.get(agentId);
    if (!o) return null;
    if (now - o.since > 60) {
      this.overrides.delete(agentId);
      return null;
    }
    return { instruction: o.instruction, revision: o.revision };
  }
}
