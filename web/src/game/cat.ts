import { Container, Graphics } from "pixi.js";
import { ART_W, ART_H } from "./room";

type CatState = "wander" | "pause" | "sit" | "sleep";

/** Purely decorative pixel office cat: wanders the floor, sometimes sits or
 *  curls up for a nap. Never intercepts pointer events. */
export class Cat {
  readonly container = new Container();
  private readonly g = new Graphics();
  private x = 60;
  private y = 200;
  private targetX = 60;
  private targetY = 200;
  private facing = 1;
  private state: CatState = "pause";
  private stateMs = 1_200;
  private static readonly SPEED = 0.028; // art px per ms — slower than people

  constructor() {
    this.container.eventMode = "none";
    this.container.addChild(this.g);
    this.x = 20 + Math.random() * (ART_W - 40);
    this.y = 70 + Math.random() * (ART_H - 90);
    this.container.position.set(Math.round(this.x), Math.round(this.y));
  }

  update(tMs: number, dtMs: number): void {
    this.stateMs -= dtMs;

    if (this.state === "wander") {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);
      const step = Cat.SPEED * dtMs;
      if (dist <= step) {
        this.x = this.targetX;
        this.y = this.targetY;
        this.enter(Math.random() < 0.45 ? "sit" : "pause");
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.5) this.facing = Math.sign(dx);
      }
    } else if (this.stateMs <= 0) {
      if (this.state === "sit" && Math.random() < 0.4) {
        this.enter("sleep");
      } else if (this.state === "sleep" || Math.random() < 0.7) {
        this.targetX = 12 + Math.random() * (ART_W - 24);
        this.targetY = 62 + Math.random() * (ART_H - 74);
        this.enter("wander");
      } else {
        this.enter(this.state === "pause" ? "sit" : "pause");
      }
    }

    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.container.zIndex = this.y;
    this.draw(tMs);
  }

  private enter(state: CatState): void {
    this.state = state;
    this.stateMs = state === "sleep"
      ? 6_000 + Math.random() * 8_000
      : state === "sit"
        ? 2_500 + Math.random() * 3_500
        : 900 + Math.random() * 1_800;
  }

  private draw(tMs: number): void {
    const g = this.g;
    g.clear();
    const f = this.facing;
    const BODY = 0x2e2a3a;
    const DARK = 0x221f2c;
    const EYE = 0xffd166;

    g.ellipse(0, 0.6, 4, 1.2).fill({ color: 0x000000, alpha: 0.3 });

    if (this.state === "sleep") {
      // Curled up: oval body, tail wrapped, slow breathing via 1px lift.
      const breathe = Math.floor(tMs / 700) % 2;
      g.ellipse(0, -1.5 - breathe * 0.4, 4, 2.2).fill(BODY);
      g.ellipse(2 * f, -1, 1.6, 1.2).fill(DARK);
      const zt = Math.floor(tMs / 600) % 3;
      g.rect(3 + zt * 0.8, -6.5 - zt, 1, 1).fill({ color: 0x8fb8e8, alpha: 0.7 - zt * 0.18 });
      return;
    }

    const walking = this.state === "wander";
    const step = walking ? Math.floor(tMs / 140) % 2 : 0;

    if (this.state === "sit") {
      g.ellipse(0, -1.6, 2.4, 2.2).fill(BODY);
      g.rect(-1.6 * f - 1, -5.4, 2.6, 2.6).fill(BODY);
      g.rect(-2.4 * f - 0.5, -6.6, 1.2, 1.6).fill(BODY);
      g.rect(-0.4 * f - 0.5, -6.6, 1.2, 1.6).fill(BODY);
      const blink = Math.floor(tMs / 2_600) % 8 === 0;
      if (!blink) g.rect(-2 * f - 0.4, -4.6, 0.9, 0.9).fill(EYE);
      g.moveTo(2.2, -1).quadraticCurveTo(4.4, -2.4, 3.4, -4.2).stroke({ color: BODY, width: 1 });
      return;
    }

    // Walking / standing profile.
    g.rect(-3, -3 - (step ? 0.4 : 0), 6, 2.4).fill(BODY);
    g.rect(2.2 * f - 1.2, -4.8, 2.4, 2.4).fill(BODY);
    g.rect(1.4 * f - 0.5, -5.9, 1.1, 1.4).fill(BODY);
    g.rect(3 * f - 0.6, -5.9, 1.1, 1.4).fill(BODY);
    g.rect(2.6 * f - 0.4, -4, 0.8, 0.8).fill(EYE);
    g.rect(-2.6, -0.8, 1, 1 + (walking && step === 0 ? 0.4 : 0)).fill(DARK);
    g.rect(1.6, -0.8, 1, 1 + (walking && step === 1 ? 0.4 : 0)).fill(DARK);
    const tailUp = Math.floor(tMs / 400) % 2;
    g.rect(-3.8 * f - 0.5, -4.6 - tailUp * 0.5, 1, 2.4).fill(BODY);
  }
}
