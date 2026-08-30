// 小镇经济：金币收入 + 物品购买/赠送（馈礼→关系升温，与伙伴选择实验 2×2 因子联动）

export interface ItemDef { name: string; cost: number; affectionDelta: number }

export const ITEMS: Record<string, ItemDef> = {
  flower: { name: '鲜花', cost: 5, affectionDelta: 0.1 },
  coffee: { name: '咖啡', cost: 3, affectionDelta: 0.05 },
};

const DAILY_WAGE = 10; // 每日工作收入

export class Economy {
  private money = new Map<string, number>();
  private items = new Map<string, Record<string, number>>();

  /** 每日工资入账 */
  earnDaily(agentId: string): void {
    this.money.set(agentId, (this.money.get(agentId) ?? 0) + DAILY_WAGE);
    void agentId;
  }

  getMoney(agentId: string): number {
    return this.money.get(agentId) ?? 0;
  }

  /** 购买物品（现金足够则扣款并入包） */
  buy(agentId: string, itemKey: string): boolean {
    const item = ITEMS[itemKey];
    if (!item) return false;
    if (this.getMoney(agentId) < item.cost) return false;
    this.money.set(agentId, this.getMoney(agentId) - item.cost);
    const inv = this.items.get(agentId) ?? {};
    inv[itemKey] = (inv[itemKey] ?? 0) + 1;
    this.items.set(agentId, inv);
    return true;
  }

  /** 赠送物品：赠礼者移出、收礼者入库，关系效应由调用方按 ItemDef 更新。 */
  give(gifterId: string, receiverId: string, itemKey: string): number | null {
    const inv = this.items.get(gifterId);
    if (!inv || (inv[itemKey] ?? 0) < 1) return null;
    inv[itemKey] -= 1;
    const receiverInventory = this.items.get(receiverId) ?? {};
    receiverInventory[itemKey] = (receiverInventory[itemKey] ?? 0) + 1;
    this.items.set(receiverId, receiverInventory);
    return ITEMS[itemKey]?.affectionDelta ?? 0;
  }

  inventoryOf(agentId: string): Record<string, number> {
    return { ...(this.items.get(agentId) ?? {}) };
  }
}
