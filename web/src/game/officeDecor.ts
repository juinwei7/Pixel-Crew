import { Container, Graphics } from "pixi.js";
import { ART_W } from "./room";

/** Decorative office areas that do not represent agent tool destinations. */
export class OfficeDecor {
  readonly container = new Container();
  private readonly meeting = new Container();
  private readonly meetingGlow = new Graphics();
  private readonly coffee = new Container();

  private readonly milestones: Container[] = [new Container(), new Container(), new Container()];

  constructor() {
    this.container.zIndex = 132;
    this.drawMeetingArea();
    this.drawCoffeeArea();
    this.drawPlants();
    this.drawMilestones();
    this.container.addChild(this.meeting, this.coffee, ...this.milestones);
    this.setMilestone(0);
  }

  setWorkerCount(count: number, roundtableActive = false): void {
    // 會議桌已搬到最底部的專屬空地（不再跟部門桌搶位置），所以永遠顯示——
    // 它同時是可點擊的「作戰室」傢俱，常駐才有可發現性。
    this.meeting.visible = true;
    // 開會光暈：有人在會議桌（圓桌進行中）才亮起，散會就熄燈。
    this.meetingGlow.visible = roundtableActive;
  }

  /** Office growth unlocked by all-time completed turns — levels stack. */
  setMilestone(level: number): void {
    this.milestones.forEach((decor, index) => {
      decor.visible = level >= index + 1;
    });
  }

  private drawMilestones(): void {
    // Lv1 — framed award on the wall.
    const award = new Graphics();
    award.rect(158, 8, 12, 14).fill(0x6e5a2e);
    award.rect(159, 9, 10, 12).fill(0xf2e6c8);
    award.circle(164, 13, 2).fill(0xffd166);
    award.rect(162.6, 15.5, 1, 4).fill(0xd45c7a);
    award.rect(164.6, 15.5, 1, 4).fill(0xd45c7a);
    this.milestones[0].addChild(award);

    // Lv2 — trophy shelf.
    const shelf = new Graphics();
    shelf.rect(346, 20, 40, 3).fill(0x4a3d63);
    shelf.rect(348, 23, 2, 3).fill(0x3a3050);
    shelf.rect(382, 23, 2, 3).fill(0x3a3050);
    for (const [x, c] of [[353, 0xffd166], [365, 0xcfd8e6], [377, 0xd4915d]] as Array<[number, number]>) {
      shelf.rect(x - 3, 17, 6, 1.4).fill(c);
      shelf.rect(x - 2, 12, 4, 5).fill(c);
      shelf.rect(x - 3.6, 12.5, 1.4, 2.6).fill(c);
      shelf.rect(x + 2.2, 12.5, 1.4, 2.6).fill(c);
    }
    this.milestones[1].addChild(shelf);

    // Lv3 — neon sign over the middle of the wall.
    const neon = new Graphics();
    neon.roundRect(178, 5, 56, 15, 3).fill({ color: 0x0b1226, alpha: 0.9 }).stroke({ color: 0x4de3ff, width: 1, alpha: 0.9 });
    neon.roundRect(178, 5, 56, 15, 3).stroke({ color: 0x4de3ff, width: 2.6, alpha: 0.18 });
    // Abstract "P C" glyphs plus rising signal bars — readable at 4x zoom.
    neon.rect(184, 8, 2, 9).fill(0xff5c9d);
    neon.rect(186, 8, 4, 2).fill(0xff5c9d);
    neon.rect(188, 10, 2, 3).fill(0xff5c9d);
    neon.rect(186, 12, 2, 1).fill(0xff5c9d);
    neon.rect(195, 8, 5, 2).fill(0x4de3ff);
    neon.rect(195, 10, 2, 5).fill(0x4de3ff);
    neon.rect(195, 15, 5, 2).fill(0x4de3ff);
    for (let i = 0; i < 4; i++) {
      neon.rect(206 + i * 6, 15 - i * 2, 3, 2 + i * 2).fill({ color: 0x37d6a3, alpha: 0.5 + i * 0.12 });
    }
    this.milestones[2].addChild(neon);
  }

  private drawMeetingArea(): void {
    // ---- 地毯（最底層）：暗紅絨面＋金色鑲邊＋菱形織紋，給作戰室一塊「領地感」 ----
    const rug = new Graphics();
    rug.roundRect(-64, -26, 128, 58, 6).fill(0x3a2230);
    rug.roundRect(-64, -26, 128, 58, 6).stroke({ width: 2, color: 0x8a6d3b, alpha: 0.9 });
    rug.roundRect(-58, -21, 116, 48, 4).stroke({ width: 1, color: 0x6b4f63, alpha: 0.8 });
    for (let x = -48; x <= 48; x += 16) {
      // 菱形織紋：上下緣交錯點綴，遠看是低調的紋理
      rug.poly([x, -16, x + 3, -13, x, -10, x - 3, -13]).fill({ color: 0x5a3a50, alpha: 0.9 });
      rug.poly([x + 8, 22, x + 11, 25, x + 8, 28, x + 5, 25]).fill({ color: 0x5a3a50, alpha: 0.9 });
    }

    // ---- 開會光暈（地毯之上、桌子之下）：暖色燈池，只在圓桌進行時亮起（setWorkerCount 控制） ----
    const glow = this.meetingGlow;
    glow.ellipse(0, -2, 70, 30).fill({ color: 0xffc44d, alpha: 0.05 });
    glow.ellipse(0, -2, 55, 23).fill({ color: 0xffc44d, alpha: 0.07 });
    glow.ellipse(0, -2, 38, 16).fill({ color: 0xffd97a, alpha: 0.09 });
    glow.visible = false;

    const g = new Graphics();
    // Chairs first so the tabletop naturally overlaps them.
    // 大長會議桌（作戰室）——上下兩排椅子 + 長桌面 + 幾個小螢幕/文件。椅子先畫，桌面蓋在上面。
    for (const cx of [-40, -20, 0, 20, 40]) {
      g.rect(cx - 4, -19, 8, 5).fill(0x263754); // 上排椅子
      g.rect(cx - 4, 9, 8, 5).fill(0x263754);   // 下排椅子
    }
    g.roundRect(-52, -12, 104, 20, 7).fill(0x35496c); // 桌體
    g.roundRect(-49, -10, 98, 15, 6).fill(0x40577d);  // 桌面
    g.rect(-38, -6, 10, 6).fill(0x17223a); g.rect(-36, -5, 6, 1).fill(0x4de3ff);
    g.rect(-8, -7, 9, 7).fill(0x202e49); g.rect(-6, -6, 4, 1).fill(0xffd166);
    g.rect(24, -6, 10, 6).fill(0x17223a); g.rect(26, -5, 6, 1).fill(0x4de3ff);

    // 放到畫面最底下的空地，NPC 會走過來圍著它討論（避開上方部門排，才不會擠在一起）。
    this.meeting.position.set(120, 306);
    this.meeting.addChild(rug, glow, g);
  }

  private drawCoffeeArea(): void {
    const g = new Graphics();
    g.rect(-19, -17, 38, 17).fill(0x2b3d5c);
    g.rect(-19, -17, 38, 3).fill(0x40577d);
    g.rect(-13, -14, 12, 10).fill(0x111b30);
    g.rect(-11, -12, 8, 5).fill(0x1d2c48);
    g.rect(-9, -11, 4, 1).fill(0x37d6a3);
    g.rect(5, -11, 5, 6).fill(0x17223a);
    g.rect(11, -10, 4, 5).fill(0x17223a);
    g.rect(6, -9, 3, 1).fill(0xffd166);
    g.rect(12, -8, 2, 1).fill(0x4de3ff);
    g.rect(-16, 0, 3, 7).fill(0x23334f);
    g.rect(13, 0, 3, 7).fill(0x23334f);

    this.coffee.position.set(402, 84);
    this.coffee.addChild(g);
  }

  private drawPlants(): void {
    const g = new Graphics();
    for (const x of [16, ART_W - 7]) {
      g.rect(x - 4, 73, 8, 6).fill(0x354566);
      g.rect(x - 3, 71, 6, 4).fill(0x273957);
      g.rect(x - 1, 64, 2, 8).fill(0x27967a);
      g.rect(x - 5, 64, 5, 3).fill(0x37d6a3);
      g.rect(x, 61, 5, 4).fill(0x37d6a3);
      g.rect(x - 4, 59, 4, 4).fill(0x2db88d);
    }
    this.container.addChild(g);
  }
}
