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
  dirt: 'town',        // 占位砖坐标落在 town 范围
  path: 'town',        // 占位砖坐标落在 town 范围
  plaza: 'town',       // 占位砖坐标落在 town 范围
  flowers: 'forest',   // forest r18c2 粉色花簇
  crops: 'town',       // 占位砖坐标落在 town 范围
  tree2: 'tiny16',     // tiny16 r01c21 树冠
  flowerBed: 'tiny16', // tiny16 r03c19 黄花草地
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

// 已确认（Task 2 程序化像素解码，平均色证据见 task-2-report.md）：
//   town   (medieval-town.png 384×256=24×16) 草地 r00c0-c3=#6d8c54/#6b8b53/#6f8d54/#6c8c53；墙=橄榄/棕石砖(r01-r14c0-c7)；屋顶=浅米色(r04-r14c8-c15)；门=暗红(r01-r03c12-c15)。无 path/plaza/dirt/crops 砖。
//   forest (ansimuz-forest.png 544×512=34×32) 树冠=橄榄黄绿(r01c30=(480,16)=#928924 等)；树干(r02c02=(32,32)=#75432e)；粉色花(r18c2=(32,288)=#6e2746)。图集无水面砖、无草地砖（水/草为演示背景色）。
//   interiors (medieval-interior.png 320×320=20×20) floor r00c00=(0,0)=#191919 深色地板；wall r01c00=(0,16)=#746772。
// 占位/程序化回退（本图集无对应语义砖）：
//   terrain.dirt/path/plaza/crops、water、furniture（medieval 内饰无床/沙发/桌/柜家具砖）、building.window（外景无独立窗砖，取浅色石砖近似）。
export const TILE_MAP: TileMap = {
  terrain: {
    grass: [0, 0],      // town r00c0 草地（确认）
    grassAlt: [16, 0],  // town r00c1 草地变体（确认）
    dirt: [0, 16],      // 占位（无独立土砖，drawTerrain 保持程序化）
    path: [0, 32],      // 占位（无独立路砖）
    plaza: [0, 48],     // 占位（无独立广场砖）
    flowers: [32, 288], // forest r18c2 粉色花簇（确认，约 25% 不透明、透明背景平铺于草地上呈散点花）
    crops: [0, 96],     // 占位（无农田作物砖，farm_east 保持程序化）
    tree2: [336, 16],   // tiny16 r01c21 树冠（深棕+橙叶，avg #6e3e31，证据见 task-1-report.md）
    flowerBed: [304, 48], // tiny16 r03c19 黄花草地（avg #b2b85f，证据见 task-1-report.md）
  },
  water: { frames: [[0, 32], [16, 32]], sheet: 'forest' }, // 占位（forest 无水面砖，水保持程序化）
  tree: { frames: [[480, 16]], sheet: 'forest' },          // forest r01c30 树冠（橄榄黄绿，确认）
  buildings: {
    cafe:        { wall: [0, 16],   roof: [128, 64], door: [192, 16], window: [192, 64], sheet: 'town' },
    bookstore:   { wall: [0, 32],   roof: [144, 64], door: [208, 16], window: [208, 64], sheet: 'town' },
    post_office: { wall: [0, 48],   roof: [160, 64], door: [192, 32], window: [224, 64], sheet: 'town' },
    bakery:      { wall: [0, 64],   roof: [176, 64], door: [208, 32], window: [240, 64], sheet: 'town' },
    clinic:      { wall: [64, 16],  roof: [144, 80], door: [224, 32], window: [192, 80], sheet: 'town' },
    home:        { wall: [0, 96],   roof: [160, 80], door: [240, 32], window: [240, 80], sheet: 'town' },
    pier:        { wall: [64, 64],  roof: [64, 64],  door: [64, 64],  window: [64, 64],  sheet: 'tiny16' }, // tiny16 r04c04 木板；zone 专用（building 分支不消费）
    flower_shop: { wall: [48, 16],  roof: [32, 16],  door: [64, 64],  window: [96, 16],  sheet: 'tiny16' }, // tiny16 灰石屋（证据见 task-3-report.md）
    grocer:      { wall: [192, 16], roof: [176, 0],  door: [64, 64],  window: [160, 16], sheet: 'tiny16' }, // tiny16 红砖屋（证据见 task-3-report.md）
  },
  furniture: {
    bed:     { frames: [[0, 0]], sw: 16, sh: 32 },  // 占位（内饰无家具砖，回退程序化）
    sofa:    { frames: [[16, 0]], sw: 32, sh: 16 },
    table:   { frames: [[48, 0]], sw: 16, sh: 16 },
    counter: { frames: [[64, 0]], sw: 32, sh: 16 },
  },
  interior: { floor: [0, 0], wallTile: [0, 16], sheet: 'interiors' }, // floor/wallTile 确认
};
