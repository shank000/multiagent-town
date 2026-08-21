// 图集加载与绘制：ansimuz/LimeZu/Kenney 素材统一入口；每图独立 ready，未就绪由调用方回退程序化
export type SheetId = 'town' | 'forest' | 'interiors' | 'ui';

const SHEETS: Record<SheetId, { img: HTMLImageElement; src: string } | null> = {
  town: null, forest: null, interiors: null, ui: null,
};

// node 测试环境无 window：顶层初始化跳过，浏览器才注册
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  for (const [id, src] of Object.entries({
    town: '/assets/ansimuz-town.png',
    forest: '/assets/ansimuz-forest.png',
    ui: '/assets/kenney-ui.png',
    // interiors：LimeZu Modern Interiors（itch.io）许可复核/下载失败，已跳过，
    // 故不注册该图 —— sheetReady('interiors') 恒 false，由 Task 2/3 回退程序化。
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

// —— 命名坐标映射（C1 实现者按实际图集布局填写；数值为 16px 网格像素坐标）——
export interface TileMap {
  terrain: { grass: number[]; grassAlt: number[]; dirt: number[]; path: number[]; plaza: number[]; flowers: number[]; crops: number[] };
  water: { frames: number[][]; sheet: SheetId };
  tree: { frames: number[][]; sheet: SheetId };
  buildings: Record<string, { wall: number[]; roof: number[]; door: number[]; window: number[] }>;
  furniture: Record<string, { frames: number[][]; sw: number; sh: number }>; // 键: bed/sofa/table/counter
  interior: { floor: number[]; wallTile: number[]; sheet: SheetId };
}

// 坐标说明（详见 task-1-report.md）：
// - 图集均为 16px 网格；town=352×288(22×18)、forest=544×512(34×32)、interiors=未下载。
// - tree 指向 forest 图集 r02c02(32,32)，像素解码确认为树干（#75432e），为已确认的真实坐标。
// - 其余坐标为骨架占位：本环境无视觉能力/ImageMagick，无法逐砖确认语义（墙/顶/门/窗、水面、平地草/土/路），
//   forest 图集经解码不含水面砖（水面在演示中为背景色 #0000ff），town 透明图集不含独立平地草/土/路砖。
//   语义坐标待 Task 2/3（绘制分支）视觉复核后改真值；interiors 相关条目保持占位且 sheet 未注册。
export const TILE_MAP: TileMap = {
  terrain: {
    grass: [0, 0],
    grassAlt: [96, 0],
    dirt: [16, 0],
    path: [32, 0],
    plaza: [48, 0],
    flowers: [64, 0],
    crops: [80, 0],
  },
  water: { frames: [[0, 32], [16, 32]], sheet: 'forest' },
  tree: { frames: [[32, 32]], sheet: 'forest' },
  buildings: {
    cafe: { wall: [0, 0], roof: [16, 0], door: [32, 0], window: [48, 0] },
    bookstore: { wall: [0, 16], roof: [16, 16], door: [32, 16], window: [48, 16] },
    post_office: { wall: [0, 32], roof: [16, 32], door: [32, 32], window: [48, 32] },
    bakery: { wall: [0, 48], roof: [16, 48], door: [32, 48], window: [48, 48] },
    clinic: { wall: [0, 64], roof: [16, 64], door: [32, 64], window: [48, 64] },
    home: { wall: [0, 80], roof: [16, 80], door: [32, 80], window: [48, 80] },
  },
  furniture: {
    bed: { frames: [[0, 0]], sw: 16, sh: 32 },
    sofa: { frames: [[16, 0]], sw: 32, sh: 16 },
    table: { frames: [[48, 0]], sw: 16, sh: 16 },
    counter: { frames: [[64, 0]], sw: 32, sh: 16 },
  },
  interior: { floor: [0, 0], wallTile: [16, 0], sheet: 'interiors' },
};
