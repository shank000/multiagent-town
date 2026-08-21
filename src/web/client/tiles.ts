// 图集加载与绘制：像素素材统一入口；每图独立 ready，未就绪由调用方回退程序化
// 图集来源（许可见 ATTRIBUTION.md）：
//   town      = medieval-town.png      (Calciumtrice "Medieval Tileset" 外景, CC-BY 3.0)
//   forest    = ansimuz-forest.png     (ansimuz "Tiny RPG - Forest", CC0)
//   interiors = medieval-interior.png  (Calciumtrice "Medieval Tileset" 内饰, CC-BY 3.0)
//   ui        = kenney-ui.png          (Kenney "Pixel UI Pack", CC0)
export type SheetId = 'town' | 'forest' | 'interiors' | 'ui';

const SHEETS: Record<SheetId, { img: HTMLImageElement; src: string } | null> = {
  town: null, forest: null, interiors: null, ui: null,
};

// node 测试环境无 window：顶层初始化跳过，浏览器才注册
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  for (const [id, src] of Object.entries({
    town: '/assets/medieval-town.png',
    forest: '/assets/ansimuz-forest.png',
    interiors: '/assets/medieval-interior.png',
    ui: '/assets/kenney-ui.png',
  }) as [SheetId, string][]) {
    const img = new Image();
    img.onload = () => { SHEETS[id] = { img, src }; };
    img.src = src;
  }
}

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
  terrain: { grass: number[]; grassAlt: number[]; dirt: number[]; path: number[]; plaza: number[]; flowers: number[]; crops: number[] };
  water: { frames: number[][]; sheet: SheetId };
  tree: { frames: number[][]; sheet: SheetId };
  buildings: Record<string, { wall: number[]; roof: number[]; door: number[]; window: number[] }>;
  furniture: Record<string, { frames: number[][]; sw: number; sh: number }>; // 键: bed/sofa/table/counter
  interior: { floor: number[]; wallTile: number[]; sheet: SheetId };
}

// 已确认（像素解码）：
//   town   (medieval-town.png 384×256=24×16) 草地 r00c0/c1=#6d8c54/#6b8b53；墙=橄榄/棕石砖；屋顶=浅米色；门=暗红。
//   forest (ansimuz-forest.png 544×512=34×32) tree r02c02=(32,32)=#75432e 树干；图集无水面砖（水为演示背景色）。
//   interiors (medieval-interior.png 320×320=20×20) floor r00c00=(0,0)=#191919 深色地板；wall r01c00=(0,16)=#746772。
// 占位/待回退（本图集无对应语义砖，Task 2/3 程序化回退或视觉复核后改真值）：
//   terrain.dirt/path/plaza/flowers/crops、water、furniture（medieval 内饰无床/沙发/桌/柜家具砖）、building.window（外景无独立窗砖，取浅色石砖近似）。
export const TILE_MAP: TileMap = {
  terrain: {
    grass: [0, 0],      // town r00c0 草地（确认）
    grassAlt: [16, 0],  // town r00c1 草地变体（确认）
    dirt: [0, 16],      // 占位（无独立土砖）
    path: [0, 32],      // 占位
    plaza: [0, 48],     // 占位
    flowers: [0, 64],   // 占位
    crops: [0, 96],     // 占位
  },
  water: { frames: [[0, 32], [16, 32]], sheet: 'forest' }, // 占位（forest 无水面砖）
  tree: { frames: [[32, 32]], sheet: 'forest' },           // forest r02c02 树干（确认）
  buildings: {
    cafe:        { wall: [0, 16],   roof: [128, 64], door: [192, 16], window: [192, 64] },
    bookstore:   { wall: [0, 32],   roof: [144, 64], door: [208, 16], window: [208, 64] },
    post_office: { wall: [0, 48],   roof: [160, 64], door: [192, 32], window: [224, 64] },
    bakery:      { wall: [0, 64],   roof: [176, 64], door: [208, 32], window: [240, 64] },
    clinic:      { wall: [64, 16],  roof: [144, 80], door: [224, 32], window: [192, 80] },
    home:        { wall: [0, 96],   roof: [160, 80], door: [240, 32], window: [240, 80] },
  },
  furniture: {
    bed:     { frames: [[0, 0]], sw: 16, sh: 32 },  // 占位（内饰无家具砖，回退程序化）
    sofa:    { frames: [[16, 0]], sw: 32, sh: 16 },
    table:   { frames: [[48, 0]], sw: 16, sh: 16 },
    counter: { frames: [[64, 0]], sw: 32, sh: 16 },
  },
  interior: { floor: [0, 0], wallTile: [0, 16], sheet: 'interiors' }, // floor/wallTile 确认
};
