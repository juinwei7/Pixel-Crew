import { Graphics } from "pixi.js";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
  gravity: number;
};

const MAX_PARTICLES = 400;

export class ParticleSystem {
  readonly g = new Graphics();
  private list: Particle[] = [];

  spawn(p: Omit<Particle, "life"> & { life?: number }): void {
    if (this.list.length >= MAX_PARTICLES) return;
    this.list.push({ ...p, life: p.life ?? p.maxLife });
  }

  /** Radial burst, e.g. success/error flash. Coordinates are art pixels. */
  burst(x: number, y: number, color: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const sp = speed * (0.5 + Math.random() * 0.8);
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * sp,
        vy: Math.sin(angle) * sp - speed * 0.4,
        maxLife: 500 + Math.random() * 400,
        size: 1 + Math.random(),
        color,
        gravity: 0.00008,
      });
    }
  }

  /** Slow upward drift, e.g. active station shimmer. Coordinates are art pixels. */
  rise(x: number, y: number, color: number, spread: number): void {
    this.spawn({
      x: x + (Math.random() - 0.5) * spread,
      y,
      vx: (Math.random() - 0.5) * 0.004,
      vy: -0.008 - Math.random() * 0.012,
      maxLife: 700 + Math.random() * 500,
      size: 1,
      color,
      gravity: 0,
    });
  }

  update(dtMs: number): void {
    const g = this.g;
    g.clear();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dtMs;
      if (p.life <= 0) {
        this.list.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dtMs;
      p.x += p.vx * dtMs;
      p.y += p.vy * dtMs;
      const a = Math.min(1, p.life / p.maxLife) * 0.9;
      // Square pixels for the pixel-art look
      g.rect(Math.round(p.x), Math.round(p.y), p.size, p.size).fill({ color: p.color, alpha: a });
    }
  }
}
