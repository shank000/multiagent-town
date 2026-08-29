// 地图渲染：地形/建筑细节/湖水波光/昼夜着色

import type { ObjectView } from './types';
import { sheetReady, drawTile, drawTileW, TILE_MAP, TOWN_SHEET, TERRAIN_SHEETS, INTERIOR_SHEET, PROGRAMMATIC_FURNITURE, type SheetId } from './tiles';

export const TILE = 32;

/** 外景 sheet 回退链（TOWN_SHEET 优先，未就绪依次 tinytown→town）；均未就绪返回默认，drawTile 静默跳过由调用方走程序化 fallback */
export function activeTownSheet(): 'tiny16' | 'tinytown' | 'town' {
  if (sheetReady(TOWN_SHEET)) return TOWN_SHEET;
  if (sheetReady('tinytown')) return 'tinytown';
  if (sheetReady('town')) return 'town';
  return TOWN_SHEET;
}

export interface PixelSpriteRect { dx: number; dy: number; dw: number; dh: number }

/** 整房精灵按整数倍等比缩放并底部居中，保持每个源像素为规则方块。 */
export function fitPixelSprite(
  sw: number, sh: number,
  px: number, py: number, pw: number, ph: number
): PixelSpriteRect {
  const scale = Math.max(1, Math.floor(Math.min(pw / sw, ph / sh)));
  const dw = sw * scale;
  const dh = sh * scale;
  return {
    dx: Math.round(px + (pw - dw) / 2),
    dy: Math.round(py + ph - dh),
    dw,
    dh,
  };
}

function fillTerrainTile(
  ctx: CanvasRenderingContext2D,
  key: 'grass' | 'dirt' | 'path' | 'plaza' | 'flowers' | 'crops' | 'flowerBed',
  px: number, py: number, pw: number, ph: number
): void {
  const [sx, sy] = TILE_MAP.terrain[key];
  const sheet = TERRAIN_SHEETS[key];
  for (let y = py; y < py + ph; y += TILE) {
    for (let x = px; x < px + pw; x += TILE) drawTile(ctx, sheet, sx, sy, x, y, TILE);
  }
}

/** 昼夜着色状态（纯函数）：夜→昼（300~480）连续降、昼→夜（1020~1200）连续升，边界无跳变；夜 1200~1440/0~300 蓝 */
export function dayNightState(minuteOfDay: number): { color: string; alpha: number } {
  const m = minuteOfDay;
  if (m >= 300 && m < 480) {
    const t = (m - 300) / 180;
    return { color: '#1a2a4a', alpha: 0.32 * (1 - t) };   // 夜→昼连续降
  }
  if (m >= 1020 && m < 1200) {
    const t = (m - 1020) / 180;
    return { color: '#1a2a4a', alpha: 0.32 * t };         // 昼→夜连续升
  }
  if (m >= 1200 || m < 300) return { color: '#1a2a4a', alpha: 0.32 };
  return { color: '#000000', alpha: 0 };
}

/** 河流/湖水：底色 + 双层错相位高光条纹（正弦流动） */
export function drawRiver(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
  ctx.fillStyle = '#4e93c9';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  const shift = Math.floor(nowMs / 400) % 3;
  for (let y = py + 4; y < py + ph - 2; y += 10) {
    const off = (Math.floor((y - py) / 10) % 2 === 0) ? shift * 6 : -shift * 6;
    for (let x = px + off; x < px + pw; x += 26) ctx.fillRect(x, y, 8, 2);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  const shimmer = Math.sin(nowMs / 700);
  ctx.fillRect(px + 10 + shimmer * 8, py + 3, 6, 2);
  ctx.fillRect(px + pw - 20 - shimmer * 8, py + ph - 6, 6, 2);
}

/** 装饰树：树冠随 sin 摇曳（phase 由位置 hash 决定，避免整齐划一） */
export function drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, nowMs: number, phase: number): void {
  const sway = Math.round(Math.sin(nowMs / 900 + phase));
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(x - 2, y + 6, 4, 10);
  ctx.fillStyle = '#2f7a3a';
  ctx.fillRect(x - 9 + sway, y - 8, 18, 14);
  ctx.fillStyle = '#3f9a4a';
  ctx.fillRect(x - 6 + sway, y - 11, 12, 8);
  ctx.fillStyle = '#4f8a5a';
  ctx.fillRect(x - 14 + sway, y - 3, 10, 7);
}

/** 路灯夜间暖光晕 */
export function drawLampGlow(ctx: CanvasRenderingContext2D, px: number, py: number, nowMs: number, night: boolean): void {
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(px + 10, py + 6, 12, 26);
  ctx.fillStyle = '#f5e9c8';
  ctx.fillRect(px + 12, py + 8, 8, 6);
  if (!night) return;
  const pulse = 0.85 + 0.15 * Math.sin(nowMs / 800);
  const g = ctx.createRadialGradient(px + 16, py + 12, 4, px + 16, py + 12, 34);
  g.addColorStop(0, `rgba(255,214,130,${0.45 * pulse})`);
  g.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(px - 18, py - 22, 68, 68);
}

const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Serene Village 画风：草地为小镇基底，深浅变体只用于打破重复感。
  if (sheetReady(TERRAIN_SHEETS.dirt) && sheetReady(TERRAIN_SHEETS.grass)) {
    const [gx, gy] = TILE_MAP.terrain.grass;
    const [gax, gay] = TILE_MAP.terrain.grassAlt;
    for (let y = 0; y < h; y += TILE) {
      for (let x = 0; x < w; x += TILE) {
        const v = hash(`${x},${y}`) % 10;
        if (v < 8) drawTile(ctx, TERRAIN_SHEETS.grass, gx, gy, x, y, TILE);
        else drawTile(ctx, TERRAIN_SHEETS.grass, gax, gay, x, y, TILE);
      }
    }
    return;
  }
  // —— 程序化 fallback ——
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, w, h);
}

export function drawLake(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
  ctx.fillStyle = '#5b9bd1';
  ctx.fillRect(px, py, pw, ph);
  const wave = Math.floor(nowMs / 400) % 2;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = px + 4 + wave * 6; x < px + pw; x += 12) {
    ctx.fillRect(x, py + 6, 5, 2);
    ctx.fillRect(x + 5, py + ph - 12, 5, 2);
  }
}

/** 木栅栏：木桩（深色竖桩）+ 双横杆（浅色上下横梁）；TILE_MAP 无 tiny16 栅栏砖，程序化绘制 */
export function drawFence(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number): void {
  // 木桩：每格一桩，等距分布
  ctx.fillStyle = '#6b4a2f';
  const posts = Math.max(2, Math.round(pw / TILE) + 1);
  for (let i = 0; i < posts; i++) {
    const x = px + (pw / (posts - 1)) * i - 2;
    ctx.fillRect(x, py, 4, ph);
  }
  // 双横杆：上下横梁
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(px, py + 5, pw, 3);
  ctx.fillRect(px, py + ph - 8, pw, 3);
}

export function drawObjectDetail(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number, minuteOfDay = -1): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.type === 'zone') {
    if (o.id === 'obj:path_main' || o.id === 'obj:plaza') {
      fillTerrainTile(ctx, o.id === 'obj:plaza' ? 'plaza' : 'path', px, py, pw, ph);
      if (o.id === 'obj:plaza') {
        ctx.strokeStyle = 'rgba(119, 82, 45, .28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
      }
    } else if (o.id === 'obj:park') {
      fillTerrainTile(ctx, 'grass', px, py, pw, ph);
      if (sheetReady(TERRAIN_SHEETS.tree2)) {
        const [tx0, ty0] = TILE_MAP.terrain.tree2;
        for (const [tx, ty] of [[px + 16, py + 16], [px + pw - 48, py + ph - 48]]) {
          drawTileW(ctx, TERRAIN_SHEETS.tree2, tx0, ty0, 32, 32, tx, ty, 32, 32);
        }
      } else {
        for (const [tx, ty] of [[px + 10, py + 10], [px + pw - 22, py + ph - 24]]) {
          ctx.fillStyle = '#4a3520';
          ctx.fillRect(tx, ty, 6, 16);
          ctx.fillStyle = '#2f7a3a';
          ctx.fillRect(tx - 7, ty - 10, 20, 14);
        }
      }
    } else if (o.id === 'obj:lake') {
      drawLake(ctx, px, py, pw, ph, nowMs);
    } else if (o.id === 'obj:orchard' || o.id === 'obj:forest_ne') {
      fillTerrainTile(ctx, 'grass', px, py, pw, ph);
      const dense = o.id === 'obj:forest_ne';
      // Serene Village 树木保持原生 32×32；树林交替针叶树和低冠树。
      if (sheetReady(TERRAIN_SHEETS.tree2)) {
        for (let ty = py + 8; ty < py + ph - 8; ty += dense ? 40 : 52) {
          for (let tx = px + 8; tx < px + pw - 8; tx += dense ? 40 : 52) {
            const bx = tx + ((hash(o.id + tx + ty) % 16) - 8);
            const sway = Math.round(Math.sin(nowMs / 900 + (hash(o.id + tx + ty) % 6) * 1.1));
            const variantX = dense ? ((hash(`${tx}:${ty}`) % 2) ? 32 : 96) : 0;
            drawTileW(ctx, TERRAIN_SHEETS.tree2, variantX, 0, 32, 32, bx + sway - 16, ty - 16, 32, 32);
          }
        }
      } else {
        for (let ty = py + 8; ty < py + ph - 8; ty += dense ? 20 : 26) {
          for (let tx = px + 8; tx < px + pw - 8; tx += dense ? 20 : 26) {
            drawTree(ctx, tx + ((hash(o.id + tx + ty) % 8) - 4), ty, nowMs, (hash(o.id + tx + ty) % 6) * 1.1);
          }
        }
      }
    } else if (o.id === 'obj:farm' || o.id === 'obj:farm_east') {
      fillTerrainTile(ctx, 'crops', px, py, pw, ph);
      ctx.fillStyle = '#8a6a3a';
      ctx.globalAlpha = .5;
      ctx.fillStyle = '#c9a06a';
      for (let ty = py + 6; ty < py + ph; ty += 12) ctx.fillRect(px + 4, ty, pw - 8, 5);
      ctx.fillStyle = '#5f8f3f';
      for (let tx = px + 8; tx < px + pw; tx += 12) for (let ty = py + 8; ty < py + ph; ty += 12) ctx.fillRect(tx, ty, 4, 4);
      ctx.globalAlpha = 1;
    } else if (o.id === 'obj:meadow_s') {
      fillTerrainTile(ctx, 'grass', px, py, pw, ph);
      // 花地在草地基底上叠放透明花簇。
      if (sheetReady(TERRAIN_SHEETS.flowerBed)) {
        const [fx, fy] = TILE_MAP.terrain.flowerBed;
        for (let y = py; y < py + ph; y += TILE) {
          for (let x = px; x < px + pw; x += TILE) drawTile(ctx, TERRAIN_SHEETS.flowerBed, fx, fy, x, y, TILE);
        }
      } else if (sheetReady(TERRAIN_SHEETS.flowers)) {
        const [fx, fy] = TILE_MAP.terrain.flowers;
        for (let y = py; y < py + ph; y += TILE) {
          for (let x = px; x < px + pw; x += TILE) drawTile(ctx, TERRAIN_SHEETS.flowers, fx, fy, x, y, TILE);
        }
      } else {
        ctx.fillStyle = '#7fb069';
        ctx.fillRect(px, py, pw, ph);
        ctx.fillStyle = '#e8d5a0';
        for (let i = 0; i < 10; i++) ctx.fillRect(px + ((i * 17) % pw), py + ((i * 11) % ph), 2, 2);
      }
    } else if (o.id === 'obj:flowerbed') {
      // 广场花坛（zone 2×2）：按 flowerBed 键所属图集（tiny16），未就绪程序化
      if (sheetReady(TERRAIN_SHEETS.flowerBed)) {
        const [fx, fy] = TILE_MAP.terrain.flowerBed;
        for (let y = py; y < py + ph; y += TILE) {
          for (let x = px; x < px + pw; x += TILE) drawTile(ctx, TERRAIN_SHEETS.flowerBed, fx, fy, x, y, TILE);
        }
      } else {
        ctx.fillStyle = '#b2b85f';
        ctx.fillRect(px, py, pw, ph);
        ctx.fillStyle = '#d04d47';
        for (let i = 0; i < 8; i++) ctx.fillRect(px + ((i * 13) % pw), py + ((i * 7) % ph), 3, 3);
      }
    } else if (o.id === 'obj:pier') {
      // 码头（zone，不走建筑渲染器）：tiny16 木板砖平铺 4×2
      const [wx, wy] = TILE_MAP.buildings.pier.sprite;
      if (sheetReady('tiny16')) {
        for (let y = py; y < py + ph; y += TILE) {
          for (let x = px; x < px + pw; x += TILE) drawTile(ctx, 'tiny16', wx, wy, x, y, TILE);
        }
      } else {
        ctx.fillStyle = '#7d4d3a';
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = '#5f3a28';
        for (let x = px + 4; x < px + pw; x += 8) ctx.strokeRect(x, py, 1, ph);
      }
    } else if (o.id === 'obj:fence_lake') {
      // 湖边栅栏：drawFence 程序化（TILE_MAP 无 tiny16 栅栏砖，回退程序化）
      drawFence(ctx, px, py, pw, ph);
    } else if (o.id.startsWith('obj:lamp')) {
      drawLampGlow(ctx, px, py, nowMs, minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300));
    } else {
      ctx.fillStyle = '#c9b79c';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#a3937a';
      for (let x = px + 8; x < px + pw; x += 16) {
        for (let y = py + 8; y < py + ph; y += 16) ctx.strokeRect(x, y, 16, 16);
      }
      ctx.fillStyle = '#6b9bd1';
      ctx.fillRect(px + pw / 2 - 10, py + ph / 2 - 10, 20, 20);
    }
  } else if (o.type === 'building') {
    const key = o.id.replace('obj:', '');
    const b = TILE_MAP.buildings[key] ?? TILE_MAP.buildings.home;
    // 建筑条目自描述所属图集，图集就绪即绘制，未就绪回退程序化
    const sheet: SheetId = b.sheet;
    if (sheetReady(sheet)) {
      // 门前区域先铺沙地，整房随后以整数倍等比缩放并底部居中。
      const [sx, sy, sw, sh] = b.sprite;
      fillTerrainTile(ctx, 'dirt', px, py, pw, ph);
      const fitted = fitPixelSprite(sw, sh, px, py, pw, ph);
      drawTileW(ctx, sheet, sx, sy, sw, sh, fitted.dx, fitted.dy, fitted.dw, fitted.dh);
      // 夜间窗户点亮：暖色覆盖房体两侧窗位
      const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
      if (night) {
        ctx.fillStyle = 'rgba(255,217,138,0.30)';
        ctx.fillRect(fitted.dx + 18, fitted.dy + fitted.dh * .48, 14, 10);
        ctx.fillRect(fitted.dx + fitted.dw - 32, fitted.dy + fitted.dh * .48, 14, 10);
      }
      drawMapLabel(ctx, o.name, px + pw / 2, py + ph - 5);
      return;
    }
    /* 现有程序化建筑分支原样保留为 fallback */
    ctx.fillStyle = '#e8d5b7';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = ROOFS[hash(o.id) % ROOFS.length];
    ctx.fillRect(px, py, pw, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(px + 4, py + 3, pw - 8, 3);
    // 窗（夜间点亮）
    const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
    ctx.fillStyle = night ? '#ffd98a' : '#7a5a3a';
    for (let wx = px + 8; wx < px + pw - 8; wx += 16) {
      ctx.fillRect(wx, py + 16, 8, 8);
      ctx.strokeStyle = '#4a3520';
      ctx.strokeRect(wx, py + 16, 8, 8);
    }
    // 门
    ctx.fillStyle = '#6b4a2f';
    const doorX = px + pw / 2 - 6;
    ctx.fillRect(doorX, py + ph - 14, 12, 14);
    // 招牌
    if (o.id === 'obj:cafe' || o.id === 'obj:bookstore' || o.id === 'obj:post_office') {
      ctx.fillStyle = '#e3b23c';
      ctx.fillRect(px + pw - 16, py + 2, 12, 8);
    }
  } else if (o.type === 'room') {
    ctx.fillStyle = '#d9b48f';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#a97c50';
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
  } else if (o.type === 'water') {
    // 种子中 obj:river 为 type 'water'（非 zone），故需单独分支渲染水波
    drawRiver(ctx, px, py, pw, ph, nowMs);
  } else if (o.type === 'furniture' && o.id === 'obj:boat') {
    // 小船（码头南缘）：船身 + 舱内水面 + 底沿
    ctx.fillStyle = '#8a5a3a';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = '#4e93c9';
    ctx.fillRect(px + 6, py + 4, pw - 12, ph - 9);
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(px, py + ph - 5, pw, 5);
  } else {
    ctx.fillStyle = '#8a6f4d';
    ctx.fillRect(px + 6, py + 6, pw - 12, ph - 12);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '11px monospace';
  ctx.fillText(o.name, px + 3, py + 24);
}

function drawMapLabel(ctx: CanvasRenderingContext2D, name: string, cx: number, baseline: number): void {
  ctx.save();
  ctx.font = 'bold 11px "Microsoft YaHei UI", sans-serif';
  ctx.textAlign = 'center';
  const width = Math.ceil(ctx.measureText(name).width) + 10;
  ctx.fillStyle = 'rgba(15, 20, 24, .78)';
  ctx.fillRect(Math.round(cx - width / 2), baseline - 14, width, 16);
  ctx.fillStyle = '#fff5d8';
  ctx.fillText(name, cx, baseline - 2);
  ctx.restore();
}

// 家具像素样式：按名称区分床/沙发/咖啡桌/柜台
export function drawFurniture(ctx: CanvasRenderingContext2D, o: ObjectView): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  const key = o.name === '床' ? 'bed' : o.name === '沙发' ? 'sofa' : o.name === '咖啡桌' ? 'table' : 'counter';
  const f = TILE_MAP.furniture[key];
  // 素材优先：LimeZu 内饰家具（32px 原生尺寸按家具几何比例绘制），未就绪回退程序化
  if (!PROGRAMMATIC_FURNITURE && f && sheetReady(f.sheet)) {
    const [sx, sy] = f.frames[0];
    drawTileW(ctx, f.sheet, sx, sy, f.sw, f.sh, px, py, pw, ph);
    return;
  }
  if (o.name === '床') {
    // 床头板 + 床单 + 枕头
    ctx.fillStyle = '#8a5a3a';
    ctx.fillRect(px, py, pw, 6);
    ctx.fillStyle = '#e8e0f0';
    ctx.fillRect(px, py + 6, pw, ph - 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, py + 6, 10, 8);
  } else if (o.name === '沙发') {
    ctx.fillStyle = '#b35d45';
    ctx.fillRect(px, py, pw, 6); // 靠背
    ctx.fillStyle = '#d98a6a';
    ctx.fillRect(px, py + 6, pw, ph - 6);
    ctx.fillStyle = '#b35d45';
    ctx.fillRect(px, py + ph - 6, pw, 6);
  } else if (o.name === '咖啡桌') {
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(px + 8, py + 8, pw - 16, ph - 16); // 桌面
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(px + 10, py + 20, 4, 8);
    ctx.fillRect(px + pw - 14, py + 20, 4, 8);
  } else {
    // 柜台/吧台类
    ctx.fillStyle = '#a97c50';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = '#e3b23c';
    ctx.fillRect(px + 4, py + 4, pw - 8, 4); // 台面高光
  }
}

// 建筑内饰：素材优先（内饰图集地板平铺 + 顶部墙砖行），家具保持程序化（内饰图集无家具砖），回退程序化
export function drawInterior(
  ctx: CanvasRenderingContext2D,
  building: ObjectView,
  children: ObjectView[],
  nowMs: number
): void {
  const px = building.x * TILE, py = building.y * TILE, pw = building.w * TILE, ph = building.h * TILE;
  if (sheetReady(TILE_MAP.interior.floorSheet) && sheetReady(TILE_MAP.interior.wallSheet)) {
    // 素材优先：木地板（Serene Village）平铺 + 顶部墙砖行
    const [fx, fy] = TILE_MAP.interior.floor;
    for (let y = py; y < py + ph; y += TILE) {
      for (let x = px; x < px + pw; x += TILE) drawTile(ctx, TILE_MAP.interior.floorSheet, fx, fy, x, y, TILE);
    }
    const [wx, wy] = TILE_MAP.interior.wallTile;
    for (let x = px; x < px + pw; x += TILE) drawTile(ctx, TILE_MAP.interior.wallSheet, wx, wy, x, py, TILE);
    // 家具素材优先（LimeZu），未就绪回退程序化 drawFurniture
    for (const c of children) {
      if (c.type === 'furniture' || c.type === 'room') drawFurniture(ctx, c);
    }
    // 墙边框
    ctx.strokeStyle = '#7a5a3a';
    ctx.lineWidth = 4;
    ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    void nowMs;
    return;
  }
  /* 现有程序化内饰原样保留为 fallback */
  ctx.fillStyle = '#d9b48f';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = '#c9a06a';
  for (let x = px + 4; x < px + pw; x += 8) {
    for (let y = py + 4; y < py + ph; y += 8) ctx.fillRect(x, y, 3, 3); // 木纹点
  }
  for (const c of children) {
    if (c.type === 'furniture' || c.type === 'room') drawFurniture(ctx, c);
  }
  // 墙边框
  ctx.strokeStyle = '#7a5a3a';
  ctx.lineWidth = 4;
  ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
  void nowMs;
}

export function applyDayNight(ctx: CanvasRenderingContext2D, w: number, h: number, minuteOfDay: number): void {
  const s = dayNightState(minuteOfDay);
  if (s.alpha > 0) {
    ctx.fillStyle = s.color;
    ctx.globalAlpha = s.alpha;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
