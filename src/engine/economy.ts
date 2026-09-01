// 小镇经济：金币收入 + 物品购买/赠送（馈礼→关系升温，与伙伴选择实验 2×2 因子联动）

export interface ItemDef { name: string; cost: number; affectionDelta: number }

export const ITEMS: Record<string, ItemDef> = {
  flower: { name: '鲜花', cost: 5, affectionDelta: 0.1 },
  coffee: { name: '咖啡', cost: 3, affectionDelta: 0.05 },
};

export interface EconomyCheckpoint {
  schemaVersion: 1;
  money: Array<[string, number]>;
  items: Array<[string, Record<string, number>]>;
}

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

  checkpoint(): EconomyCheckpoint {
    return {
      schemaVersion: 1,
      money: [...this.money].map(([agentId, balance]) => [agentId, balance] as [string, number])
        .sort(([left], [right]) => left.localeCompare(right)),
      items: [...this.items].map(([agentId, inventory]) => [agentId, { ...inventory }] as [string, Record<string, number>])
        .sort(([left], [right]) => left.localeCompare(right)),
    };
  }

  restore(input: unknown, validAgentIds: ReadonlySet<string>): void {
    const checkpoint = validateEconomyCheckpoint(input, validAgentIds);
    this.money = new Map(checkpoint.money);
    this.items = new Map(checkpoint.items.map(([agentId, inventory]) => [agentId, { ...inventory }]));
  }
}

export function validateEconomyCheckpoint(input: unknown, validAgentIds: ReadonlySet<string>): EconomyCheckpoint {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('经济检查点必须是对象');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.money) || !Array.isArray(value.items)) {
    throw new Error('经济检查点版本或结构无效');
  }
  const moneyIds = new Set<string>();
  const money = value.money.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !validAgentIds.has(entry[0]) || moneyIds.has(entry[0])
        || !Number.isSafeInteger(entry[1]) || entry[1] < 0) {
      throw new Error('经济检查点包含未知居民、重复余额或非法金额');
    }
    moneyIds.add(entry[0]);
    return [entry[0], entry[1]] as [string, number];
  });
  const itemIds = new Set<string>();
  const items = value.items.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !validAgentIds.has(entry[0]) || itemIds.has(entry[0])
        || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) {
      throw new Error('经济检查点包含未知居民、重复库存或非法库存');
    }
    itemIds.add(entry[0]);
    const inventory: Record<string, number> = {};
    for (const [itemKey, rawCount] of Object.entries(entry[1] as Record<string, unknown>)) {
      if (!Object.hasOwn(ITEMS, itemKey) || !Number.isSafeInteger(rawCount) || (rawCount as number) < 0) {
        throw new Error('经济检查点包含未知物品或非法库存数量');
      }
      inventory[itemKey] = rawCount as number;
    }
    return [entry[0], inventory] as [string, Record<string, number>];
  });
  return { schemaVersion: 1, money, items };
}
