// 图集加载与绘制：像素素材统一入口；每图独立 ready，未就绪由调用方回退程序化
// 图集来源（许可见 ATTRIBUTION.md）：
//   town      = medieval-town.png      (Calciumtrice "Medieval Tileset" 外景, CC-BY 3.0)
//   forest    = ansimuz-forest.png     (ansimuz "Tiny RPG - Forest", CC0)
//   interiors = medieval-interior.png  (Calciumtrice "Medieval Tileset" 内饰, CC-BY 3.0)
//   ui        = kenney-ui.png          (Kenney "Pixel UI Pack", CC0)
//   tinytown  = kenney-tinytown.png    (Kenney "Tiny Town", CC0)
//   tiny16    = sharm-tiny16.png       (Sharm/Lanea Zimmerman "Tiny 16: Basic", CC-BY 3.0)
//   dungeon   = (0x72 "DungeonTileset II" 仅 itch.io 发布，本环境不可达 → 未下载、未注册)
export type SheetId = 'town' | 'forest' | 'interiors' | 'ui' | 'tinytown' | 'tiny16' | 'dungeon';

const SHEETS: Record<SheetId, { img: HTMLImageElement; src: string } | null> = {
  town: null, forest: null, interiors: null, ui: null, tinytown: null, tiny16: null, dungeon: null,
};
// ui 素材暂无消费方、dungeon（0x72）不可达，均未注册以避免空载（对应 assets/ATTRIBUTION 条目按实际保留/标注）

// node 测试环境无 window：顶层初始化跳过，浏览器才注册
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  for (const [id, src] of Object.entries({
    town: '/assets/medieval-town.png',
    forest: '/assets/ansimuz-forest.png',
    interiors: '/assets/medieval-interior.png',
    tiny16: '/assets/sharm-tiny16.png',
    tinytown: '/assets/kenney-tinytown.png',
  }) as [SheetId, string][]) {
    const img = new Image();
    img.onload = () => { SHEETS[id] = { img, src }; };
    img.src = src;
  }
}

// 外景/内饰首选包（默认取已下载包中的优先级；调用方再按 sheetReady 做回退链）
//   TOWN_SHEET: tiny16 > tinytown > town（tiny16 已下载 → 'tiny16'）
//   INTERIOR_SHEET: dungeon > interiors（dungeon 未下载 → 'interiors'）
export const TOWN_SHEET: 'town' | 'tiny16' | 'tinytown' = 'tiny16';
export const INTERIOR_SHEET: 'interiors' | 'dungeon' = 'interiors';

// 地形坐标键 → 所属图集：各键自描述所属图集，绘制方按 sheetReady 判定并回退（与 TILE_MAP.terrain 消费键一致）
export const TERRAIN_SHEETS: Record<'grass' | 'dirt' | 'path' | 'plaza' | 'flowers' | 'crops' | 'tree2' | 'flowerBed', SheetId> = {
  grass: 'town',       // town r00c0 草地
  dirt: 'tiny16',      // tiny16 沙土路
  path: 'tiny16',      // tiny16 沙土路
  plaza: 'tiny16',     // tiny16 沙土路
  flowers: 'tiny16',   // tiny16 白色花簇
  crops: 'tiny16',     // tiny16 深绿作物行
  tree2: 'tiny16',     // tiny16 针叶树
  flowerBed: 'tiny16', // tiny16 黄色花丛
};

export function sheetReady(id: SheetId): boolean {
  const s = SHEETS[id];
  return !!s && s.img.complete && s.img.naturalWidth > 0;
}

export function drawTile(ctx: CanvasRenderingContext2D, id: SheetId, sx: number, sy: number, dx: number, dy: number, size: number): void {
  drawTileW(ctx, id, sx, sy, 16, 16, dx, dy, size, size);
}

export function drawTileW(
  ctx: CanvasRenderingContext2D, id: SheetId,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number
): void {
  const s = SHEETS[id];
  if (!s || !sheetReady(id)) return; // 未就绪：静默跳过，调用方负责回退
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s.img, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = prev;
}

// —— 命名坐标映射（数值为 16px 网格像素坐标，依据见 task-1-report.md 的像素解码记录）——
export interface TileMap {
  terrain: { grass: number[]; grassAlt: number[]; dirt: number[]; path: number[]; plaza: number[]; flowers: number[]; crops: number[]; tree2: number[]; flowerBed: number[] };
  water: { frames: number[][]; sheet: SheetId };
  tree: { frames: number[][]; sheet: SheetId };
  buildings: Record<string, { wall: number[]; roof: number[]; door: number[]; window: number[]; sheet: SheetId }>;
  furniture: Record<string, { frames: number[][]; sw: number; sh: number }>; // 键: bed/sofa/table/counter
  interior: { floor: number[]; wallTile: number[]; sheet: SheetId };
}

// 坐标依据（目视核对图集网格 + 平均色矩阵，16px 单位）：
//   town   (medieval-town.png 384×256=24×16)：草地 r00c0=(0,0)；红砖顶 r12c01=(192,16)；白墙房 wall=r09c04=(144,64)、door=r11c05=(176,80)、window=白墙(144,64)；灰石房 wall=r17c04=(272,64)、door=r19c05=(304,80)、window=r21c05=(336,80)。
//   tiny16 (sharm-tiny16.png 384×224=24×14)：沙土路 path=r10c05=(160,80)、plaza=r11c05=(176,80)、dirt=r04c05=(64,80)；针叶树 tree2=r00c01=(0,16)；白色花簇 flowers=r00c07=(0,112)；黄色花丛 flowerBed=r00c11=(0,176)；作物行 crops=r12c12=(192,192)；木板桥 pier=r10c11=(160,176)；粉砖房 wall=r10c01=(160,16)、roof=r10c00=(160,0)、door=r12c03=(192,48)；蓝石房 wall=r03c01=(48,16)、roof=r02c01=(32,16)、door=r03c02=(48,32)。
//   forest (ansimuz-forest.png 544×512=34×32)：树冠 tree=r01c30=(480,16)。
//   interiors (medieval-interior.png 320×320=20×20)：地板 floor=r00c00=(0,0)、墙砖 wallTile=r01c00=(0,16)。
//   程序化回退：water 与家具（对应图集无语义砖）。
export const TILE_MAP: TileMap = {
  terrain: {
    grass: [0, 0],      // town 草地
    grassAlt: [16, 0],  // town 草地变体
    dirt: [64, 80],     // tiny16 沙土路
    path: [160, 80],    // tiny16 沙土路
    plaza: [176, 80],   // tiny16 沙土路
    flowers: [0, 112],  // tiny16 白色花簇
    crops: [192, 192],  // tiny16 深绿作物行
    tree2: [0, 16],     // tiny16 针叶树
    flowerBed: [0, 176], // tiny16 黄色花丛
  },
  water: { frames: [[0, 32], [16, 32]], sheet: 'forest' }, // 图集无水面砖，水保持程序化
  tree: { frames: [[480, 16]], sheet: 'forest' },          // forest 树冠
  buildings: {
    cafe:        { wall: [144, 64], roof: [192, 16], door: [176, 80], window: [144, 64], sheet: 'town' }, // 白墙房
    bookstore:   { wall: [272, 64], roof: [192, 16], door: [304, 80], window: [336, 80], sheet: 'town' }, // 灰石房
    post_office: { wall: [144, 64], roof: [192, 16], door: [176, 80], window: [144, 64], sheet: 'town' },
    bakery:      { wall: [272, 64], roof: [192, 16], door: [304, 80], window: [336, 80], sheet: 'town' },
    clinic:      { wall: [144, 64], roof: [192, 16], door: [176, 80], window: [144, 64], sheet: 'town' },
    home:        { wall: [272, 64], roof: [192, 16], door: [304, 80], window: [336, 80], sheet: 'town' },
    pier:        { wall: [160, 176], roof: [160, 176], door: [160, 176], window: [160, 176], sheet: 'tiny16' }, // 木板桥砖；zone 专用（building 分支不消费）
    flower_shop: { wall: [160, 16], roof: [160, 0],  door: [192, 48], window: [176, 32], sheet: 'tiny16' }, // 粉砖房
    grocer:      { wall: [48, 16],  roof: [32, 16],  door: [48, 32],  window: [80, 16],  sheet: 'tiny16' }, // 蓝石房
  },
  furniture: {
    bed:     { frames: [[0, 0]], sw: 16, sh: 32 },  // 内饰图集无家具砖，回退程序化
    sofa:    { frames: [[16, 0]], sw: 32, sh: 16 },
    table:   { frames: [[48, 0]], sw: 16, sh: 16 },
    counter: { frames: [[64, 0]], sw: 32, sh: 16 },
  },
  interior: { floor: [0, 0], wallTile: [0, 16], sheet: 'interiors' }, // 地板/墙砖
};
