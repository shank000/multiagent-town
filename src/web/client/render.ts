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
  if (!sheetReady(sheet)) {
    const fallback: Record<typeof key, string> = {
      grass: '#7ca968', dirt: '#b99568', path: '#b99568', plaza: '#c3a77b',
      flowers: '#789e61', crops: '#6f934c', flowerBed: '#829b55',
    };
    ctx.fillStyle = fallback[key];
    ctx.fillRect(px, py, pw, ph);
    return;
  }
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
  const shimmer = Math.round(Math.sin(nowMs / 700) * 8);
  ctx.fillRect(px + 10 + shimmer, py + 3, 6, 2);
  ctx.fillRect(px + pw - 20 - shimmer, py + ph - 6, 6, 2);
}

/** 装饰树：树冠随 sin 摇曳（phase 由位置 hash 决定，避免整齐划一） */
export function drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, nowMs: number, phase: number): void {
  const sway = Math.round(Math.sin(nowMs / 900 + phase));
  // 方块投影固定在树根，树冠轻摆时地面不会跟着漂移。
  ctx.fillStyle = 'rgba(35,68,38,.28)';
  ctx.fillRect(x - 10, y + 12, 20, 4);
  ctx.fillRect(x - 7, y + 16, 14, 2);
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(x - 3, y + 3, 6, 13);
  ctx.fillStyle = '#735137';
  ctx.fillRect(x - 1, y + 4, 2, 10);
  ctx.fillStyle = '#2f7a3a';
  ctx.fillRect(x - 11 + sway, y - 7, 22, 13);
  ctx.fillRect(x - 8 + sway, y - 12, 16, 8);
  ctx.fillStyle = '#3f9a4a';
  ctx.fillRect(x - 6 + sway, y - 15, 12, 8);
  ctx.fillRect(x + 4 + sway, y - 9, 8, 9);
  ctx.fillStyle = '#4f8a5a';
  ctx.fillRect(x - 14 + sway, y - 5, 9, 8);
  ctx.fillStyle = '#73b65d';
  ctx.fillRect(x - 4 + sway, y - 13, 4, 3);
  ctx.fillRect(x + 6 + sway, y - 6, 3, 3);
}

/** 路灯夜间暖光晕 */
export function drawLampGlow(ctx: CanvasRenderingContext2D, px: number, py: number, nowMs: number, night: boolean): void {
  const pulse = 0.85 + 0.15 * Math.sin(nowMs / 800);
  if (night) {
    const pool = ctx.createRadialGradient(px + 16, py + 30, 2, px + 16, py + 30, 38);
    pool.addColorStop(0, `rgba(255,196,104,${0.28 * pulse})`);
    pool.addColorStop(1, 'rgba(255,196,104,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(px - 24, py + 4, 80, 44);
    const aura = ctx.createRadialGradient(px + 16, py + 10, 3, px + 16, py + 10, 30);
    aura.addColorStop(0, `rgba(255,224,154,${0.48 * pulse})`);
    aura.addColorStop(1, 'rgba(255,224,154,0)');
    ctx.fillStyle = aura;
    ctx.fillRect(px - 16, py - 22, 64, 64);
  }
  // 铸铁底座、细灯杆、挑檐和玻璃灯室按像素层级绘制。
  ctx.fillStyle = 'rgba(35,38,42,.28)';
  ctx.fillRect(px + 7, py + 29, 20, 3);
  ctx.fillStyle = '#303842';
  ctx.fillRect(px + 10, py + 27, 12, 5);
  ctx.fillRect(px + 14, py + 11, 4, 18);
  ctx.fillRect(px + 9, py + 8, 14, 3);
  ctx.fillRect(px + 12, py + 2, 8, 2);
  ctx.fillRect(px + 10, py + 4, 12, 4);
  ctx.fillStyle = night ? '#ffd98d' : '#d5c697';
  ctx.fillRect(px + 12, py + 8, 8, 7);
  ctx.fillStyle = night ? '#fff0bd' : '#eee1b7';
  ctx.fillRect(px + 13 + (Math.floor(nowMs / 480) % 2), py + 9, 2, 4);
  ctx.fillStyle = '#56606a';
  ctx.fillRect(px + 10, py + 15, 12, 3);
}

const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // 草地以同一基础砖连续铺设，细小苔斑与草叶负责变化，保持远景连续性。
  if (sheetReady(TERRAIN_SHEETS.dirt) && sheetReady(TERRAIN_SHEETS.grass)) {
    const [gx, gy] = TILE_MAP.terrain.grass;
    for (let y = 0; y < h; y += TILE) {
      for (let x = 0; x < w; x += TILE) {
        drawTile(ctx, TERRAIN_SHEETS.grass, gx, gy, x, y, TILE);
      }
    }
  } else {
    // 程序化 fallback 使用连续底色，小尺度纹理由细节层统一生成。
    ctx.fillStyle = '#7ca968';
    ctx.fillRect(0, 0, w, h);
  }
  drawGrassDetails(ctx, w, h);
}

export interface TerrainDetail {
  clusters: number;
  flower: boolean;
  pebble: boolean;
  shade: 0 | 1 | 2;
}

/** 单格草地细节由格坐标稳定派生，截图、回放与不同帧保持一致。 */
export function terrainDetailAt(tileX: number, tileY: number): TerrainDetail {
  const seed = hash(`grass:${tileX}:${tileY}`);
  return {
    clusters: 1 + seed % 3,
    flower: seed % 17 === 0,
    pebble: seed % 23 === 0,
    shade: (seed % 3) as 0 | 1 | 2,
  };
}

/** 草叶、低矮苔斑、野花与石粒：位置完全由格坐标决定。 */
function drawGrassDetails(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let y = 0; y < h; y += TILE) {
    for (let x = 0; x < w; x += TILE) {
      const seed = hash(`grass:${x}:${y}`);
      const detail = terrainDetailAt(x / TILE, y / TILE);
      ctx.fillStyle = detail.shade === 0 ? 'rgba(49,105,55,.16)' : 'rgba(196,219,132,.12)';
      ctx.fillRect(x + 3 + seed % 19, y + 4 + Math.floor(seed / 31) % 20, 5, 2);
      for (let cluster = 0; cluster < detail.clusters; cluster++) {
        const dx = x + 4 + (seed + cluster * 11) % 23;
        const dy = y + 7 + (Math.floor(seed / 23) + cluster * 7) % 18;
        ctx.fillStyle = (seed + cluster) % 2 ? 'rgba(47,105,54,.62)' : 'rgba(187,218,124,.56)';
        ctx.fillRect(dx, dy, 1, 3 + cluster % 2);
        ctx.fillRect(dx + 2, dy + 1, 1, 2);
        if (cluster === 2) ctx.fillRect(dx - 2, dy + 2, 1, 2);
      }
      if (detail.flower) {
        const dx = x + 7 + seed % 17;
        const dy = y + 9 + Math.floor(seed / 19) % 13;
        ctx.fillStyle = seed % 34 === 0 ? '#f1d77b' : '#eaa2aa';
        ctx.fillRect(dx - 1, dy - 2, 2, 2);
        ctx.fillStyle = '#4f8a48';
        ctx.fillRect(dx, dy, 1, 3);
      }
      if (detail.pebble) {
        ctx.fillStyle = 'rgba(104,113,91,.55)';
        ctx.fillRect(x + 22, y + 23, 3, 2);
        ctx.fillStyle = 'rgba(205,211,177,.45)';
        ctx.fillRect(x + 22, y + 23, 2, 1);
      }
    }
  }
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

export function roadAxis(pw: number, ph: number, plaza: boolean): 'plaza' | 'horizontal' | 'vertical' {
  if (plaza) return 'plaza';
  return pw >= ph ? 'horizontal' : 'vertical';
}

function drawRoadFinish(
  ctx: CanvasRenderingContext2D,
  px: number, py: number, pw: number, ph: number,
  plaza: boolean
): void {
  ctx.fillStyle = 'rgba(105,72,42,.28)';
  ctx.fillRect(px, py, pw, 2);
  ctx.fillRect(px, py + ph - 2, pw, 2);
  ctx.fillRect(px, py, 2, ph);
  ctx.fillRect(px + pw - 2, py, 2, ph);
  // 草土交界用断续边缘与小草簇过渡，避免道路像贴在地面上的纯色矩形。
  for (let x = px + 5; x < px + pw - 4; x += 19) {
    const topInset = hash(`road-edge-top:${x}:${py}`) % 3;
    const bottomInset = hash(`road-edge-bottom:${x}:${py}`) % 3;
    ctx.fillStyle = 'rgba(90,112,60,.44)';
    ctx.fillRect(x, py + topInset, 3, 2);
    ctx.fillRect(x + 7, py + ph - 2 - bottomInset, 2, 2);
  }
  for (let y = py + 7; y < py + ph - 4; y += 21) {
    ctx.fillStyle = 'rgba(90,112,60,.38)';
    ctx.fillRect(px, y, 2, 3);
    ctx.fillRect(px + pw - 2, y + 6, 2, 3);
  }
  if (plaza) {
    // 广场用错列石缝与少量亮面砖形成铺装层次。
    for (let y = py + 8; y < py + ph - 4; y += 16) {
      const offset = Math.floor((y - py) / 16) % 2 ? 8 : 0;
      for (let x = px + 6 + offset; x < px + pw - 4; x += 16) {
        ctx.fillStyle = 'rgba(110,78,48,.22)';
        ctx.fillRect(x, y, 8, 1);
        ctx.fillRect(x, y, 1, 6);
        if (hash(`plaza:${x}:${y}`) % 5 === 0) {
          ctx.fillStyle = 'rgba(255,236,181,.24)';
          ctx.fillRect(x + 3, y + 2, 3, 2);
        }
      }
    }
  } else {
    // 主街车辙始终沿道路长轴，横纵道路都保持自然通行方向。
    const axis = roadAxis(pw, ph, false);
    ctx.fillStyle = 'rgba(130,91,50,.18)';
    if (axis === 'horizontal') {
      ctx.fillRect(px + 4, py + Math.floor(ph * .32), Math.max(1, pw - 8), 2);
      ctx.fillRect(px + 4, py + Math.floor(ph * .68), Math.max(1, pw - 8), 2);
    } else {
      ctx.fillRect(px + Math.floor(pw * .32), py + 4, 2, Math.max(1, ph - 8));
      ctx.fillRect(px + Math.floor(pw * .68), py + 4, 2, Math.max(1, ph - 8));
    }
    const length = axis === 'horizontal' ? pw : ph;
    for (let along = 10; along < length - 6; along += 29) {
      const across = 6 + hash(`road:${px}:${py}:${along}`) % Math.max(1, (axis === 'horizontal' ? ph : pw) - 12);
      ctx.fillStyle = 'rgba(92,66,43,.35)';
      ctx.fillRect(axis === 'horizontal' ? px + along : px + across, axis === 'horizontal' ? py + across : py + along, 3, 2);
    }
  }
}

function drawForestFloor(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, dense: boolean): void {
  ctx.fillStyle = dense ? 'rgba(27,70,38,.20)' : 'rgba(75,95,43,.14)';
  for (let y = py + 4; y < py + ph; y += dense ? 24 : 32) {
    for (let x = px + 4; x < px + pw; x += dense ? 24 : 32) {
      if (hash(`forest-shadow:${x}:${y}`) % 3 === 0) continue;
      ctx.fillRect(x, y, dense ? 18 : 14, dense ? 8 : 6);
    }
  }
}

function drawUndergrowth(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, dense: boolean): void {
  const spacing = dense ? 27 : 39;
  for (let y = py + 14; y < py + ph - 4; y += spacing) {
    for (let x = px + 10; x < px + pw - 4; x += spacing) {
      const seed = hash(`undergrowth:${x}:${y}`);
      const dx = x + seed % 9;
      const dy = y + Math.floor(seed / 13) % 7;
      ctx.fillStyle = seed % 2 ? '#326f3c' : '#4f8a48';
      ctx.fillRect(dx, dy, 2, 5);
      ctx.fillRect(dx - 2, dy + 2, 2, 3);
      ctx.fillRect(dx + 2, dy + 1, 2, 4);
      if (seed % 11 === 0) {
        ctx.fillStyle = '#d9c77a';
        ctx.fillRect(dx + 4, dy + 3, 2, 2);
      }
    }
  }
}

const LIFE_OBJECT_IDS = new Set([
  'obj:notice_board', 'obj:market_stall', 'obj:plaza_fountain', 'obj:park_bench',
  'obj:bird_feeder', 'obj:water_pump', 'obj:community_garden', 'obj:tool_rack', 'obj:bus_stop',
]);

/** 公共生活物件使用独立像素轮廓，保证缩放后仍能一眼辨认其功能。 */
function drawLifeObject(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  ctx.fillStyle = 'rgba(25,35,29,.22)';
  ctx.fillRect(px + 3, py + ph - 5, Math.max(8, pw - 6), 5);
  if (o.id === 'obj:notice_board') {
    ctx.fillStyle = '#6f4930'; ctx.fillRect(px + 5, py + 5, 22, 17); ctx.fillRect(px + 8, py + 22, 4, 10); ctx.fillRect(px + 21, py + 22, 4, 10);
    ctx.fillStyle = '#d7b77e'; ctx.fillRect(px + 8, py + 8, 16, 11);
    ctx.fillStyle = '#f3e7c7'; ctx.fillRect(px + 10, py + 10, 6, 7); ctx.fillRect(px + 18, py + 9, 4, 5);
    ctx.fillStyle = '#b44942'; ctx.fillRect(px + 12, py + 9, 2, 2); ctx.fillRect(px + 19, py + 8, 2, 2);
  } else if (o.id === 'obj:market_stall') {
    ctx.fillStyle = '#765039'; ctx.fillRect(px + 5, py + 15, pw - 10, 11); ctx.fillRect(px + 8, py + 26, 4, 6); ctx.fillRect(px + pw - 12, py + 26, 4, 6);
    for (let x = px + 3, i = 0; x < px + pw - 3; x += 10, i++) { ctx.fillStyle = i % 2 ? '#f1d38a' : '#b9544d'; ctx.fillRect(x, py + 4, 10, 9); }
    for (let x = px + 10, i = 0; x < px + pw - 7; x += 9, i++) { ctx.fillStyle = ['#d2684f', '#efb447', '#76a655'][i % 3]; ctx.fillRect(x, py + 18, 5, 5); }
  } else if (o.id === 'obj:plaza_fountain') {
    ctx.fillStyle = '#8d948f'; ctx.fillRect(px + 4, py + 20, 24, 8); ctx.fillRect(px + 8, py + 16, 16, 5); ctx.fillRect(px + 14, py + 7, 4, 10);
    ctx.fillStyle = '#5fb7d8'; ctx.fillRect(px + 7, py + 20, 18, 3);
    const drop = Math.floor(nowMs / 260) % 5; ctx.fillRect(px + 12, py + 8 + drop, 2, 5); ctx.fillRect(px + 19, py + 10 + (4 - drop), 2, 4);
  } else if (o.id === 'obj:park_bench') {
    ctx.fillStyle = '#60432f'; ctx.fillRect(px + 5, py + 7, pw - 10, 5); ctx.fillRect(px + 5, py + 15, pw - 10, 6); ctx.fillRect(px + 10, py + 21, 4, 8); ctx.fillRect(px + pw - 14, py + 21, 4, 8);
    ctx.fillStyle = '#947050'; ctx.fillRect(px + 7, py + 8, pw - 14, 2); ctx.fillRect(px + 7, py + 16, pw - 14, 2);
  } else if (o.id === 'obj:bird_feeder') {
    ctx.fillStyle = '#65472e'; ctx.fillRect(px + 14, py + 15, 4, 16); ctx.fillRect(px + 7, py + 14, 18, 4);
    ctx.fillStyle = '#9b6c42'; ctx.fillRect(px + 9, py + 7, 14, 9); ctx.fillStyle = '#5c3c29'; ctx.fillRect(px + 7, py + 5, 18, 4);
    ctx.fillStyle = '#e2c674'; ctx.fillRect(px + 10, py + 20, 2, 2); ctx.fillRect(px + 21, py + 19, 2, 2);
  } else if (o.id === 'obj:water_pump') {
    ctx.fillStyle = '#63747b'; ctx.fillRect(px + 10, py + 8, 10, 21); ctx.fillRect(px + 18, py + 12, 8, 5); ctx.fillRect(px + 23, py + 15, 4, 7);
    ctx.fillStyle = '#87979b'; ctx.fillRect(px + 7, py + 5, 15, 4); ctx.fillRect(px + 5, py + 3, 4, 9);
    if (o.state) { ctx.fillStyle = '#55b9d8'; ctx.fillRect(px + 26, py + 21, 2, 5 + Math.floor(nowMs / 220) % 3); }
  } else if (o.id === 'obj:community_garden') {
    ctx.fillStyle = '#765239'; ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);
    for (let y = py + 8; y < py + ph - 3; y += 14) { ctx.fillStyle = '#9b7049'; ctx.fillRect(px + 4, y, pw - 8, 5); }
    for (let y = py + 7; y < py + ph - 4; y += 14) for (let x = px + 10; x < px + pw - 4; x += 15) {
      ctx.fillStyle = '#4f913f'; ctx.fillRect(x, y, 3, 8); ctx.fillRect(x - 3, y + 2, 3, 4); ctx.fillRect(x + 3, y + 1, 3, 4);
    }
  } else if (o.id === 'obj:tool_rack') {
    ctx.fillStyle = '#6d4a32'; ctx.fillRect(px + 4, py + 5, 24, 22); ctx.fillStyle = '#9a704b'; ctx.fillRect(px + 7, py + 8, 18, 3); ctx.fillRect(px + 7, py + 20, 18, 3);
    ctx.fillStyle = '#b4b8b3'; ctx.fillRect(px + 10, py + 10, 3, 12); ctx.fillRect(px + 19, py + 10, 3, 11); ctx.fillStyle = '#5a3927'; ctx.fillRect(px + 9, py + 18, 5, 8); ctx.fillRect(px + 18, py + 17, 5, 9);
  } else if (o.id === 'obj:bus_stop') {
    ctx.fillStyle = '#53666d'; ctx.fillRect(px + 3, py + 5, 26, 5); ctx.fillRect(px + 5, py + 10, 4, 48); ctx.fillRect(px + 25, py + 10, 4, 48);
    ctx.fillStyle = 'rgba(141,196,205,.34)'; ctx.fillRect(px + 9, py + 11, 16, 24);
    ctx.fillStyle = '#a66d45'; ctx.fillRect(px + 9, py + 39, 16, 5); ctx.fillRect(px + 11, py + 44, 3, 7); ctx.fillRect(px + 21, py + 44, 3, 7);
    ctx.fillStyle = '#f1d278'; ctx.fillRect(px + 10, py + 15, 10, 12); ctx.fillStyle = '#6b5a48'; ctx.fillRect(px + 12, py + 18, 6, 2); ctx.fillRect(px + 12, py + 22, 4, 2);
  }
  if (o.state) {
    const pulse = Math.floor(nowMs / 360) % 2;
    ctx.fillStyle = pulse ? '#ffe29a' : '#66dec9';
    ctx.fillRect(px + pw - 6, py + 3, 3, 3);
  }
}

export function drawObjectDetail(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number, minuteOfDay = -1): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.type === 'zone') {
    if (o.id === 'obj:path_main' || o.id === 'obj:plaza') {
      fillTerrainTile(ctx, o.id === 'obj:plaza' ? 'plaza' : 'path', px, py, pw, ph);
      drawRoadFinish(ctx, px, py, pw, ph, o.id === 'obj:plaza');
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
      drawForestFloor(ctx, px, py, pw, ph, dense);
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
      drawUndergrowth(ctx, px, py, pw, ph, dense);
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
      ctx.fillStyle = 'rgba(31,37,31,.28)';
      ctx.fillRect(fitted.dx + 5, fitted.dy + fitted.dh - 5, fitted.dw - 10, 8);
      drawTileW(ctx, sheet, sx, sy, sw, sh, fitted.dx, fitted.dy, fitted.dw, fitted.dh);
      drawBuildingAccents(ctx, o, fitted.dx, fitted.dy, fitted.dw, fitted.dh);
      // 夜间窗户点亮：暖色覆盖房体两侧窗位
      const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
      if (night) {
        const windowY = Math.round(fitted.dy + fitted.dh * .48);
        ctx.fillStyle = 'rgba(255,217,138,0.30)';
        ctx.fillRect(fitted.dx + 18, windowY, 14, 10);
        ctx.fillRect(fitted.dx + fitted.dw - 32, windowY, 14, 10);
      }
      return;
    }
    // 程序化建筑 fallback：地基、屋檐、墙面、窗框与门阶分层。
    ctx.fillStyle = 'rgba(35,45,36,.30)';
    ctx.fillRect(px + 5, py + ph - 4, pw - 10, 8);
    ctx.fillStyle = '#e8d5b7';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = ROOFS[hash(o.id) % ROOFS.length];
    ctx.fillRect(px - 2, py, pw + 4, 11);
    ctx.fillStyle = 'rgba(54,38,29,.35)';
    ctx.fillRect(px - 2, py + 9, pw + 4, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(px + 4, py + 3, pw - 8, 3);
    ctx.fillStyle = 'rgba(142,104,71,.16)';
    for (let wy = py + 14; wy < py + ph - 10; wy += 12) ctx.fillRect(px + 3, wy, pw - 6, 1);
    // 窗（夜间点亮）
    const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
    ctx.fillStyle = night ? '#ffd98a' : '#7a5a3a';
    for (let wx = px + 8; wx < px + pw - 8; wx += 16) {
      ctx.fillRect(wx, py + 16, 8, 8);
      ctx.strokeStyle = '#4a3520';
      ctx.strokeRect(wx, py + 16, 8, 8);
      ctx.fillRect(wx + 3, py + 16, 1, 8);
      ctx.fillRect(wx, py + 19, 8, 1);
    }
    // 门
    ctx.fillStyle = '#6b4a2f';
    const doorX = px + pw / 2 - 6;
    ctx.fillRect(doorX, py + ph - 14, 12, 14);
    ctx.fillStyle = '#d4af63';
    ctx.fillRect(doorX + 8, py + ph - 8, 2, 2);
    ctx.fillStyle = '#8c6a45';
    ctx.fillRect(doorX - 3, py + ph - 2, 18, 3);
    // 招牌
    if (o.id === 'obj:cafe' || o.id === 'obj:bookstore' || o.id === 'obj:post_office') {
      ctx.fillStyle = '#e3b23c';
      ctx.fillRect(px + pw - 16, py + 2, 12, 8);
    }
    drawBuildingAccents(ctx, o, px, py, pw, ph);
  } else if (o.type === 'room') {
    ctx.fillStyle = '#d9b48f';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#a97c50';
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
  } else if (o.type === 'water') {
    // 种子中 obj:river 为 type 'water'（非 zone），故需单独分支渲染水波
    drawRiver(ctx, px, py, pw, ph, nowMs);
  } else if (o.type === 'furniture' && LIFE_OBJECT_IDS.has(o.id)) {
    drawLifeObject(ctx, o, nowMs);
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
}

function drawBuildingAccents(
  ctx: CanvasRenderingContext2D,
  o: ObjectView,
  px: number, py: number, pw: number, ph: number
): void {
  const seed = hash(o.id);
  // 门阶与两侧植被把房体压在地面上，坐标均取整。
  ctx.fillStyle = '#806044';
  ctx.fillRect(Math.round(px + pw / 2 - 9), py + ph - 4, 18, 4);
  ctx.fillStyle = seed % 2 ? '#3c7d45' : '#577d3f';
  ctx.fillRect(px + 5, py + ph - 7, 5, 5);
  ctx.fillRect(px + pw - 10, py + ph - 6, 5, 4);
  ctx.fillStyle = seed % 3 === 0 ? '#f0c86e' : '#dd8d82';
  ctx.fillRect(px + 6, py + ph - 9, 2, 2);
}

/** 选中对象只绘制轮廓；名称由屏幕 tooltip 与右侧检查器承载。 */
export function drawObjectSelection(ctx: CanvasRenderingContext2D, o: ObjectView): void {
  const px = o.x * TILE;
  const py = o.y * TILE;
  const pw = o.w * TILE;
  const ph = o.h * TILE;
  ctx.save();
  ctx.strokeStyle = '#ffe09a';
  ctx.lineWidth = 2;
  ctx.strokeRect(px + 2, py + 2, Math.max(1, pw - 4), Math.max(1, ph - 4));
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
