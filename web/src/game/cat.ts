import { Container, Graphics, Text } from "pixi.js";
import { ART_W, ART_H } from "./room";
import { sessionFlag, setSessionFlag } from "./officeLife";
import { t } from "../i18n";

type CatState = "wander" | "pause" | "sit" | "sleep" | "stretch";
/** Waking from a nap: a long, low stretch before it pads off. */
const STRETCH_MS = 900;

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
  /** Walking over to someone who called it (to be petted); sits there once arrived. */
  private visiting = false;
  // Poked: a hop, a "meow" bubble and a purr heart.
  private hopT = 0;
  private meowT = 0;
  private readonly meowG = new Graphics();
  private meowText: Text | null = null;
  // Easter eggs: ten clicks earn a party hat (kept for the browser session);
  // once in a long while a mouse scurries across the floor and the cat gives chase.
  private readonly hatG = new Graphics();
  private pokes = 0;
  partyHat = sessionFlag("cathat");
  private mouse: { x: number; y: number; dir: 1 | -1; end: number } | null = null;
  private speedMul = 1;

  constructor() {
    this.container.eventMode = "none";
    this.container.addChild(this.g, this.hatG);
    this.x = 20 + Math.random() * (ART_W - 40);
    this.y = 70 + Math.random() * (ART_H - 90);
    this.container.position.set(Math.round(this.x), Math.round(this.y));
  }

  get pos(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Curled up asleep — won't come when called. */
  get asleep(): boolean {
    return this.state === "sleep";
  }

  /** Arrived next to whoever called it and sitting there. */
  get settled(): boolean {
    return !this.visiting && this.state === "sit";
  }

  /** Clicked: wakes up if asleep, hops, meows, purrs. Purely visual. */
  poke(): void {
    this.pokes += 1;
    if (this.pokes === 10 && !this.partyHat) {
      this.partyHat = true;
      setSessionFlag("cathat");
    }
    const sleepy = this.state === "sleep";
    if (sleepy) this.enter("sit");
    else if (this.state === "wander") this.enter("pause");
    this.hopT = 320;
    this.meowT = 1_500;
    const line = sleepy ? t("喵？") : Math.random() < 0.5 ? t("喵～") : t("呼嚕～");
    if (!this.meowText) {
      this.meowText = new Text({
        text: line,
        style: { fontFamily: "'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', sans-serif", fontSize: 6, fontWeight: "700", fill: 0xffe2f0 },
        resolution: 8,
      });
      this.meowText.anchor.set(0.5, 0);
      this.container.addChild(this.meowG, this.meowText);
    } else {
      this.meowText.text = line;
    }
  }

  /** Trot over to (x, y) and sit for a pat. Returns false if it's asleep. */
  visit(x: number, y: number): boolean {
    if (this.state === "sleep") return false;
    this.targetX = x;
    this.targetY = y;
    this.visiting = true;
    this.state = "wander";
    return true;
  }

  /** Rare idle event: a mouse dashes across the floor, the cat right behind it. */
  chaseMouse(): void {
    if (this.mouse) return;
    const dir: 1 | -1 = this.x < ART_W / 2 ? 1 : -1;
    // The mouse runs off the edge of the room.
    const end = dir > 0 ? ART_W + 10 : -10;
    this.mouse = { x: this.x + dir * 16, y: this.y, dir, end };
    this.visiting = false;
    this.state = "wander";
  }

  update(tMs: number, dtMs: number): void {
    if (this.mouse) {
      // Mouse scurries to the edge of the room; the cat bounds after it.
      const m = this.mouse;
      m.x += m.dir * 0.11 * dtMs;
      // Bounding after it at ~3.5x the usual amble (the wander step below does the moving).
      this.speedMul = 3.5;
      this.state = "wander";
      this.targetX = m.x - m.dir * 9;
      this.targetY = this.y;
      if ((m.dir > 0 && m.x > m.end) || (m.dir < 0 && m.x < m.end)) {
        this.mouse = null;
        this.speedMul = 1;
        this.enter("sit");
      }
    }
    this.stateMs -= dtMs;

    if (this.state === "wander") {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);
      const step = Cat.SPEED * this.speedMul * dtMs;
      if (dist <= step) {
        this.x = this.targetX;
        this.y = this.targetY;
        if (this.visiting) {
          this.visiting = false;
          this.enter("sit");
          this.stateMs = 4_500; // long enough for a proper pat
        } else {
          this.enter(Math.random() < 0.45 ? "sit" : "pause");
        }
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.5) this.facing = Math.sign(dx);
      }
    } else if (this.stateMs <= 0) {
      if (this.state === "sit" && Math.random() < 0.4) {
        this.enter("sleep");
      } else if (this.state === "sleep") {
        this.enter("stretch");
      } else if (this.state === "stretch" || Math.random() < 0.7) {
        this.targetX = 12 + Math.random() * (ART_W - 24);
        this.targetY = 62 + Math.random() * (ART_H - 74);
        this.enter("wander");
      } else {
        this.enter(this.state === "pause" ? "sit" : "pause");
      }
    }

    if (this.hopT > 0) this.hopT -= dtMs;
    if (this.meowT > 0) this.meowT -= dtMs;
    const hop = this.hopT > 0 ? Math.round(Math.sin(Math.PI * (1 - this.hopT / 320)) * 3) : 0;
    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.container.zIndex = this.y;
    this.draw(tMs);
    this.g.y = -hop;
    this.drawMeow();
    this.drawHat();
    if (this.mouse) {
      // The mouse: grey body, pink ear, tail flicking.
      const m = this.mouse;
      const mx = Math.round(m.x - this.x);
      const step = Math.floor(tMs / 80) % 2;
      this.g.rect(mx - 1.5, -2 - step * 0.5, 3, 1.6).fill(0x9aa6bd);
      this.g.rect(mx + m.dir * 1.5, -2.6, 1, 1).fill(0xff9ec4);
      this.g.rect(mx - m.dir * 3, -1.5 + step * 0.4, 1.5, 0.5).fill(0x9aa6bd);
    }
  }

  /** Pink-striped party hat on the head, following the pose. */
  private drawHat(): void {
    const g = this.hatG;
    g.clear();
    if (!this.partyHat) return;
    const f = this.facing;
    const [hx, hy] = this.state === "sleep" ? [2 * f, -3.2]
      : this.state === "sit" ? [-1.4 * f, -6.4]
      : this.state === "stretch" ? [3.6 * f, -4.4]
      : [2.2 * f, -5.6];
    g.y = this.g.y;
    g.poly([hx - 1.6, hy, hx + 1.6, hy, hx, hy - 4]).fill(0xff4dd8);
    g.rect(hx - 1, hy - 1.6, 2, 0.6).fill(0xffd166);
    g.rect(hx - 0.5, hy - 4.8, 1, 1).fill(0x4de3ff);
  }

  private drawMeow(): void {
    const g = this.meowG;
    g.clear();
    const text = this.meowText;
    if (!text) return;
    text.visible = this.meowT > 0;
    if (this.meowT <= 0) return;
    const alpha = this.meowT < 250 ? this.meowT / 250 : 1;
    const w = Math.ceil(text.width) + 4;
    const top = -18;
    g.roundRect(-w / 2, top, w, 8.5, 2.5).fill({ color: 0x2a1830, alpha: 0.92 * alpha }).stroke({ color: 0xff8fc8, width: 0.6, alpha });
    g.rect(-0.5, top + 8.5, 1.5, 1).fill({ color: 0x2a1830, alpha: 0.92 * alpha });
    text.position.set(0, top + 0.5);
    text.alpha = alpha;
    // A purr heart floats up beside the bubble.
    const q = 1 - this.meowT / 1_500;
    const hx = Math.ceil(w / 2) + 2;
    const hy = Math.round(-12 - q * 8);
    const c = { color: 0xff5d9e, alpha: alpha * (1 - q * 0.5) };
    g.rect(hx, hy, 1, 1).fill(c);
    g.rect(hx + 2, hy, 1, 1).fill(c);
    g.rect(hx, hy + 1, 3, 1).fill(c);
    g.rect(hx + 1, hy + 2, 1, 1).fill(c);
  }

  private enter(state: CatState): void {
    this.state = state;
    this.stateMs = state === "stretch"
      ? STRETCH_MS
      : state === "sleep"
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
      // A slow cat-blink (short, every ~8 s) rather than eyes shut for seconds.
      const blink = tMs % 8_300 < 260;
      if (!blink) g.rect(-2 * f - 0.4, -4.6, 0.9, 0.9).fill(EYE);
      // Tail curls up behind it, on the side away from the head; the tip flicks
      // once every few seconds — the only motion while it sits.
      const flick = tMs % 4_700 < 380 ? 1 : 0;
      g.moveTo(2.2 * f, -1).quadraticCurveTo(4.4 * f, -2.4, (3.4 + flick * 0.8) * f, -4.2 - flick * 0.6).stroke({ color: BODY, width: 1 });
      return;
    }

    if (this.state === "stretch") {
      // Front paws reaching out, chest low, rear up, tail high — then it pads off.
      const X = (x: number, w: number) => (f > 0 ? x : -x - w);
      g.rect(X(-3, 3), -3.6, 3, 2.4).fill(BODY);
      g.rect(X(0, 3), -2.4, 3, 1.6).fill(BODY);
      g.rect(X(2.4, 2.4), -3.2, 2.4, 2.2).fill(BODY);
      g.rect(X(2.5, 1.1), -4.3, 1.1, 1.2).fill(BODY);
      g.rect(X(3.9, 1.1), -4.3, 1.1, 1.2).fill(BODY);
      g.rect(X(3.6, 0.8), -2.2, 0.8, 0.4).fill(DARK); // eyes squeezed shut
      g.rect(X(3.4, 2.6), -0.8, 2.6, 0.8).fill(DARK);
      g.rect(X(-2.6, 1), -1.2, 1, 1.2).fill(DARK);
      g.rect(X(-3.8, 1), -6.2, 1, 2.8).fill(BODY);
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
    // Tail swishes with the gait while walking; standing still it sways lazily.
    const tailUp = Math.floor(tMs / (walking ? 400 : 1_300)) % 2;
    g.rect(-3.8 * f - 0.5, -4.6 - tailUp * 0.5, 1, 2.4).fill(BODY);
  }
}
