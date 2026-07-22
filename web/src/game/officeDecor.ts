import { Container, Graphics } from "pixi.js";
import { ART_W } from "./room";

/** Decorative office areas that do not represent agent tool destinations. */
export class OfficeDecor {
  readonly container = new Container();
  private readonly meeting = new Container();
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

  setWorkerCount(count: number): void {
    // The break-corner meeting table yields to wide department rows; the
    // coffee bar lives on the wall strip and never conflicts with desks.
    this.meeting.visible = count <= 4;
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
    const g = new Graphics();
    // Chairs first so the tabletop naturally overlaps them.
    g.rect(-17, -15, 8, 5).fill(0x263754);
    g.rect(9, -15, 8, 5).fill(0x263754);
    g.rect(-17, 3, 8, 5).fill(0x263754);
    g.rect(9, 3, 8, 5).fill(0x263754);
    g.roundRect(-23, -11, 46, 15, 5).fill(0x35496c);
    g.roundRect(-20, -9, 40, 11, 4).fill(0x40577d);
    g.rect(-13, -5, 9, 5).fill(0x17223a);
    g.rect(-11, -4, 5, 1).fill(0x4de3ff);
    g.rect(6, -6, 7, 6).fill(0x202e49);
    g.rect(8, -5, 3, 1).fill(0xffd166);
    g.rect(-15, 4, 3, 6).fill(0x293956);
    g.rect(12, 4, 3, 6).fill(0x293956);

    this.meeting.position.set(398, 118);
    this.meeting.addChild(g);
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
