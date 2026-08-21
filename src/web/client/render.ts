// 地图渲染：地形/建筑细节/湖水波光/昼夜着色

import type { ObjectView } from './types';

export const TILE = 32;

/** 昼夜着色状态（纯函数）：黎明 300~480 淡橙；黄昏 1020~1200 渐深橙；夜 1200~1440/0~300 蓝 */
export function dayNightState(minuteOfDay: number): { color: string; alpha: number } {
  const m = minuteOfDay;
  if (m >= 300 && m < 480) {
    const t = (m - 300) / 180;
    return { color: '#ff9a3c', alpha: Math.sin(t * Math.PI) * 0.12 };
  }
  if (m >= 1020 && m < 1200) {
    const t = (m - 1020) / 180;
    return { color: '#ff7a3c', alpha: 0.04 + t * 0.16 };
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
  ctx.fillStyle = g as unknown as string;
  ctx.fillRect(px - 18, py - 22, 68, 68);
}

const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, w, h);
  // 石板小径：中央十字
  ctx.fillStyle = '#c9b79c';
  for (let x = 0; x < w; x += TILE) {
    ctx.fillRect(x, 4 * TILE + 8, TILE, 8);
    ctx.fillRect(x + 4, 4 * TILE, 8, TILE);
  }
  // 花点
  ctx.fillStyle = '#e8d5a0';
  for (let i = 0; i < 12; i++) {
    const fx = (i * 37) % w;
    const fy = ((i * 53) % h);
    ctx.fillRect(fx, fy, 2, 2);
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

export function drawObjectDetail(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number, minuteOfDay = -1): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.type === 'zone') {
    if (o.id === 'obj:park') {
      ctx.fillStyle = '#6aa84f';
      ctx.fillRect(px, py, pw, ph);
      for (const [tx, ty] of [[px + 10, py + 10], [px + pw - 22, py + ph - 24]]) {
        ctx.fillStyle = '#4a3520';
        ctx.fillRect(tx, ty, 6, 16);
        ctx.fillStyle = '#2f7a3a';
        ctx.fillRect(tx - 7, ty - 10, 20, 14);
      }
    } else if (o.id === 'obj:lake') {
      drawLake(ctx, px, py, pw, ph, nowMs);
    } else if (o.id === 'obj:river') {
      drawRiver(ctx, px, py, pw, ph, nowMs);
    } else if (o.id === 'obj:orchard' || o.id === 'obj:forest_ne') {
      ctx.fillStyle = '#6aa84f';
      ctx.fillRect(px, py, pw, ph);
      const dense = o.id === 'obj:forest_ne';
      for (let ty = py + 8; ty < py + ph - 8; ty += dense ? 20 : 26) {
        for (let tx = px + 8; tx < px + pw - 8; tx += dense ? 20 : 26) {
          drawTree(ctx, tx + ((hash(o.id + tx + ty) % 8) - 4), ty, nowMs, (hash(o.id + tx + ty) % 6) * 1.1);
        }
      }
    } else if (o.id === 'obj:farm_east') {
      ctx.fillStyle = '#8a6a3a';
      ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = '#c9a06a';
      for (let ty = py + 6; ty < py + ph; ty += 12) ctx.fillRect(px + 4, ty, pw - 8, 5);
      ctx.fillStyle = '#5f8f3f';
      for (let tx = px + 8; tx < px + pw; tx += 12) for (let ty = py + 8; ty < py + ph; ty += 12) ctx.fillRect(tx, ty, 4, 4);
    } else if (o.id === 'obj:meadow_s') {
      ctx.fillStyle = '#7fb069';
      ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = '#e8d5a0';
      for (let i = 0; i < 10; i++) ctx.fillRect(px + ((i * 17) % pw), py + ((i * 11) % ph), 2, 2);
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
  } else {
    ctx.fillStyle = '#8a6f4d';
    ctx.fillRect(px + 6, py + 6, pw - 12, ph - 12);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '11px monospace';
  ctx.fillText(o.name, px + 3, py + 24);
}

// 家具像素样式：按名称区分床/沙发/咖啡桌/柜台
export function drawFurniture(ctx: CanvasRenderingContext2D, o: ObjectView): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
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

// 建筑内饰：浅木色地板 + 木纹点 + 内部家具 + 墙边框
export function drawInterior(
  ctx: CanvasRenderingContext2D,
  building: ObjectView,
  children: ObjectView[],
  nowMs: number
): void {
  const px = building.x * TILE, py = building.y * TILE, pw = building.w * TILE, ph = building.h * TILE;
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
