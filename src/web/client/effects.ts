// 轻量粒子系统：尘土/蒸汽/星光/Zzz/炊烟/萤火虫/纸屑（星露谷风动作与环境特效，上限 512）
export type ParticleKind = 'dust' | 'steam' | 'sparkle' | 'zzz' | 'smoke' | 'firefly' | 'paper' | 'rain' | 'splash';

export interface Particle {
  kind: ParticleKind;
  x: number; y: number;
  vx: number; vy: number;
  life: number;      // 剩余毫秒
  maxLife: number;
  size: number;
  color: string;
  phase: number;     // sin 相位
}

export class ParticleSystem {
  static readonly CAP = 512;
  particles: Particle[] = [];

  spawn(ps: Particle[]): void {
    for (const p of ps) {
      if (this.particles.length >= ParticleSystem.CAP) this.particles.shift();
      this.particles.push(p);
    }
  }

  update(dtMs: number): void {
    for (const p of this.particles) {
      p.life -= dtMs;
      p.x += p.vx * (dtMs / 1000);
      p.y += p.vy * (dtMs / 1000);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    // 注意：rain/splash 粒子由 main.ts drawRainScreen 在屏幕层绘制，此处不处理
    for (const p of this.particles) {
      const t = 1 - p.life / p.maxLife; // 0→1
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      if (p.kind === 'firefly' || p.kind === 'sparkle') {
        const pulse = 0.5 + 0.5 * Math.sin(nowMs / 200 + p.phase);
        ctx.globalAlpha = Math.max(0, 1 - t) * pulse;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else if (p.kind === 'zzz') {
        ctx.font = `${Math.round(10 + t * 6)}px monospace`;
        ctx.fillText('z', p.x, p.y);
      } else if (p.kind === 'paper') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.phase + t * 2);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + t * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** 落座尘土：环形扩散 */
export function sitDust(x: number, y: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI * 2 * i) / 6;
    out.push({
      kind: 'dust', x, y: y + 4,
      vx: Math.cos(ang) * 12, vy: -Math.abs(Math.sin(ang)) * 10 - 2,
      life: 500 + Math.random() * 300, maxLife: 800, size: 3, color: '#c9b79c', phase: i,
    });
  }
  return out;
}

/** 咖啡蒸汽 */
export function steamPuff(x: number, y: number): Particle[] {
  return [{
    kind: 'steam', x: x + (Math.random() * 8 - 4), y,
    vx: Math.random() * 4 - 2, vy: -14,
    life: 1600, maxLife: 1600, size: 4, color: 'rgba(255,255,255,0.9)', phase: Math.random() * 6,
  }];
}

/** 星光（写生/画画） */
export function sparkleBurst(x: number, y: number, color: string): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < 4; i++) {
    out.push({
      kind: 'sparkle', x: x + (Math.random() * 10 - 5), y: y + (Math.random() * 6 - 3),
      vx: 0, vy: -6, life: 700, maxLife: 700, size: 3, color, phase: i * 1.7,
    });
  }
  return out;
}

/** Zzz 气泡 */
export function zzzPuff(x: number, y: number): Particle[] {
  return [{ kind: 'zzz', x, y, vx: 4, vy: -10, life: 1400, maxLife: 1400, size: 8, color: '#ffffff', phase: 0 }];
}

/** 烟囱炊烟（Task 5 复用） */
export function smokePuff(x: number, y: number): Particle[] {
  return [{
    kind: 'smoke', x: x + (Math.random() * 4 - 2), y,
    vx: Math.random() * 6 - 3, vy: -18,
    life: 2600, maxLife: 2600, size: 5, color: 'rgba(120,120,120,0.5)', phase: Math.random() * 6,
  }];
}

/** 萤火虫（Task 5 复用） */
export function fireflySpawn(x: number, y: number): Particle[] {
  return [{
    kind: 'firefly', x, y,
    vx: Math.random() * 8 - 4, vy: Math.random() * 8 - 4,
    life: 5000, maxLife: 5000, size: 2, color: '#ffe9a8', phase: Math.random() * 6,
  }];
}

/** 信封纸屑（送信/分拣） */
export function paperFlutter(x: number, y: number): Particle[] {
  return [{
    kind: 'paper', x, y, vx: 6, vy: -12,
    life: 900, maxLife: 900, size: 3, color: '#f7ecd8', phase: Math.random() * 3,
  }];
}

/** 雨丝：斜向下落 */
export function rainDrop(x: number, y: number): Particle[] {
  return [{
    kind: 'rain', x, y,
    vx: -2, vy: 90,          // 单位 CSS px/s（屏幕层，落速 90）
    life: 900, maxLife: 900, size: 1, color: 'rgba(160,190,230,0.8)', phase: Math.random() * 6,
  }];
}

/** 落地水花 */
export function rainSplash(x: number, y: number): Particle[] {
  return [{
    kind: 'splash', x, y,
    vx: 0, vy: -6,
    life: 350, maxLife: 350, size: 2, color: 'rgba(160,190,230,0.6)', phase: Math.random() * 6,
  }];
}
