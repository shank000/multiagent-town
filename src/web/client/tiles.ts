// 图集加载与绘制：像素素材统一入口；每图独立 ready，未就绪由调用方回退程序化
// 图集来源（许可见 ATTRIBUTION.md）：
//   town      = medieval-town.png      (Calciumtrice "Medieval Tileset" 外景, CC-BY 3.0)
//   forest    = ansimuz-forest.png     (ansimuz "Tiny RPG - Forest", CC0)
//   interiors = medieval-interior.png  (Calciumtrice "Medieval Tileset" 内饰, CC-BY 3.0)
//   ui        = kenney-ui.png          (Kenney "Pixel UI Pack", CC0)
//   tinytown  = kenney-tinytown.png    (Kenney "Tiny Town", CC0)
//   tiny16    = sharm-tiny16.png       (Sharm/Lanea Zimmerman "Tiny 16: Basic", CC-BY 3.0)
//   limezu    = limezu-interiors.png  (LimeZu "Modern Interiors" 免费版, CC-BY 4.0)
//   sv_field  = sv-field.png      (LimeZu "Serene Village" 地形, CC-BY 4.0)
//   sv_house  = sv-house.png      (LimeZu "Serene Village" 房屋, CC-BY 4.0)
//   sv_nature = sv-nature.png     (LimeZu "Serene Village" 自然, CC-BY 4.0)
//   sv_floor  = sv-floor.png      (LimeZu "Serene Village" 地板, CC-BY 4.0)
//   dungeon   = (0x72 "DungeonTileset II" 仅 itch.io 发布，本环境不可达 → 未下载、未注册)
export type SheetId = 'town' | 'forest' | 'interiors' | 'ui' | 'tinytown' | 'tiny16' | 'limezu' | 'sv_field' | 'sv_house' | 'sv_nature' | 'sv_floor' | 'dungeon';

const SHEETS: Record<SheetId, { img: HTMLImageElement; src: string } | null> = {
  town: null, forest: null, interiors: null, ui: null, tinytown: null, tiny16: null, limezu: null,
  sv_field: null, sv_house: null, sv_nature: null, sv_floor: null, dungeon: null,
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
    limezu: '/assets/limezu-interiors.png',
    sv_field: '/assets/sv-field.png',
    sv_house: '/assets/sv-house.png',
    sv_nature: '/assets/sv-nature.png',
    sv_floor: '/assets/sv-floor.png',
  }) as [SheetId, string][]) {
    const img = new Image();
    img.onload = () => { SHEETS[id] = { img, src }; };
    img.src = src;
  }
}

// 完整小镇统一使用 Serene Village；TOWN_SHEET 仅服务旧外景回退分支。
//   INTERIOR_SHEET: dungeon > interiors（dungeon 未下载 → 'interiors'）
export const TOWN_SHEET: 'town' | 'tiny16' | 'tinytown' = 'tiny16';
export const INTERIOR_SHEET: 'interiors' | 'dungeon' = 'interiors';
/** 家具采用语义明确的程序化像素组件，保证床、沙发、桌台与交互目标一致。 */
export const PROGRAMMATIC_FURNITURE = true;

// 地形坐标键 → 所属图集：各键自描述所属图集，绘制方按 sheetReady 判定并回退（与 TILE_MAP.terrain 消费键一致）
export const TERRAIN_SHEETS: Record<'grass' | 'dirt' | 'path' | 'plaza' | 'flowers' | 'crops' | 'tree2' | 'flowerBed', SheetId> = {
  grass: 'sv_field',
  dirt: 'sv_field',
  path: 'sv_field',
  plaza: 'sv_field',
  flowers: 'sv_nature',
  crops: 'sv_field',
  tree2: 'sv_nature',
  flowerBed: 'sv_nature',
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

// —— 命名坐标映射：地表取 48×48 autotile 组的可平铺中心 16×16；整房保留原始矩形 ——
export interface TileMap {
  terrain: { grass: number[]; grassAlt: number[]; dirt: number[]; path: number[]; plaza: number[]; flowers: number[]; crops: number[]; tree2: number[]; flowerBed: number[] };
  water: { frames: number[][]; sheet: SheetId };
  tree: { frames: number[][]; sheet: SheetId };
  buildings: Record<string, { sprite: number[]; sheet: SheetId }>; // 整房精灵 [sx, sy, sw, sh]
  furniture: Record<string, { frames: number[][]; sw: number; sh: number; sheet: SheetId }>; // 键: bed/sofa/table/counter
  interior: { floor: number[]; floorSheet: SheetId; wallTile: number[]; wallSheet: SheetId };
}

// 坐标依据（目视核对图集网格 + 平均色矩阵，16px 单位）：
//   town   (medieval-town.png 384×256=24×16)：草地 r00c0=(0,0)；红砖顶 r12c01=(192,16)；白墙房 wall=r09c04=(144,64)、door=r11c05=(176,80)、window=白墙(144,64)；灰石房 wall=r17c04=(272,64)、door=r19c05=(304,80)、window=r21c05=(336,80)。
//   tiny16 (sharm-tiny16.png 384×224=24×14)：沙土路 path=r10c05=(160,80)、plaza=r11c05=(176,80)、dirt=r04c05=(64,80)；针叶树 tree2=r00c01=(0,16)；白色花簇 flowers=r00c07=(0,112)；黄色花丛 flowerBed=r00c11=(0,176)；作物行 crops=r12c12=(192,192)；木板桥 pier=r10c11=(160,176)；粉砖房 wall=r10c01=(160,16)、roof=r10c00=(160,0)、door=r12c03=(192,48)；蓝石房 wall=r03c01=(48,16)、roof=r02c01=(32,16)、door=r03c02=(48,32)。
//   forest (ansimuz-forest.png 544×512=34×32)：树冠 tree=r01c30=(480,16)。
//   interiors (medieval-interior.png 320×320=20×20)：完整木地板 floor=(16,144)、完整石墙 wallTile=(16,16)。
//   程序化回退：water 与家具（对应图集无语义砖）。
export const TILE_MAP: TileMap = {
  terrain: {
    grass: [16, 64],     // sv_field 浅绿草地中心
    grassAlt: [16, 112], // sv_field 深绿草地中心
    dirt: [16, 16],      // sv_field 沙地中心
    path: [16, 16],      // sv_field 沙地中心
    plaza: [16, 16],     // sv_field 沙地中心
    flowers: [48, 176],  // sv_nature 红花
    crops: [16, 112],    // sv_field 深绿草地（农田绿毯）
    tree2: [0, 0],       // sv_nature 树木
    flowerBed: [0, 224], // sv_nature 成簇花草
  },
  water: { frames: [[0, 32], [16, 32]], sheet: 'forest' }, // 水保持程序化
  tree: { frames: [[480, 16]], sheet: 'forest' },          // forest 树冠（备选）
  buildings: {
    cafe:        { sprite: [0, 0, 64, 48],   sheet: 'sv_house' }, // 橙顶商铺
    bookstore:   { sprite: [128, 0, 64, 48], sheet: 'sv_house' }, // 木墙商铺
    post_office: { sprite: [192, 0, 64, 48], sheet: 'sv_house' }, // 粉色门面
    bakery:      { sprite: [0, 0, 64, 48],   sheet: 'sv_house' },
    clinic:      { sprite: [128, 0, 64, 48], sheet: 'sv_house' },
    home:        { sprite: [128, 0, 64, 48], sheet: 'sv_house' },
    pier:        { sprite: [160, 176, 16, 16], sheet: 'tiny16' },   // 木板砖；zone 专用
    flower_shop: { sprite: [192, 0, 64, 48], sheet: 'sv_house' },
    grocer:      { sprite: [0, 0, 64, 48], sheet: 'sv_house' },
  },
  furniture: {
    bed:     { frames: [[0, 192]], sw: 32, sh: 64, sheet: 'limezu' },   // 白床左列（床头+枕+被）
    sofa:    { frames: [[352, 160]], sw: 64, sh: 32, sheet: 'limezu' }, // 青色双人沙发
    table:   { frames: [[32, 320]], sw: 32, sh: 32, sheet: 'limezu' },  // 木圆桌
    counter: { frames: [[384, 896]], sw: 64, sh: 32, sheet: 'limezu' }, // 厨房台面
  },
  interior: { floor: [16, 144], floorSheet: 'interiors', wallTile: [16, 16], wallSheet: 'interiors' }, // 木地板 + 石墙
}
