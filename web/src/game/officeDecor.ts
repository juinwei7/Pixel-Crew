import { Container, Graphics } from "pixi.js";

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
    // At high density the same floor area becomes extra desk space.
    const showSharedNooks = count <= 8;
    this.meeting.visible = showSharedNooks;
    this.coffee.visible = showSharedNooks;
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
    award.rect(133, 8, 12, 14).fill(0x6e5a2e);
    award.rect(134, 9, 10, 12).fill(0xf2e6c8);
    award.circle(139, 13, 2).fill(0xffd166);
    award.rect(137.6, 15.5, 1, 4).fill(0xd45c7a);
    award.rect(139.6, 15.5, 1, 4).fill(0xd45c7a);
    this.milestones[0].addChild(award);

    // Lv2 — trophy shelf.
    const shelf = new Graphics();
    shelf.rect(252, 20, 40, 3).fill(0x4a3d63);
    shelf.rect(254, 23, 2, 3).fill(0x3a3050);
    shelf.rect(288, 23, 2, 3).fill(0x3a3050);
    for (const [x, c] of [[259, 0xffd166], [271, 0xcfd8e6], [283, 0xd4915d]] as Array<[number, number]>) {
      shelf.rect(x - 3, 17, 6, 1.4).fill(c);
      shelf.rect(x - 2, 12, 4, 5).fill(c);
      shelf.rect(x - 3.6, 12.5, 1.4, 2.6).fill(c);
      shelf.rect(x + 2.2, 12.5, 1.4, 2.6).fill(c);
    }
    this.milestones[1].addChild(shelf);

    // Lv3 — neon sign over the middle of the wall.
    const neon = new Graphics();
    neon.roundRect(84, 5, 56, 15, 3).fill({ color: 0x0b1226, alpha: 0.9 }).stroke({ color: 0x4de3ff, width: 1, alpha: 0.9 });
    neon.roundRect(84, 5, 56, 15, 3).stroke({ color: 0x4de3ff, width: 2.6, alpha: 0.18 });
    // Abstract "P C" glyphs plus rising signal bars — readable at 4x zoom.
    neon.rect(90, 8, 2, 9).fill(0xff5c9d);
    neon.rect(92, 8, 4, 2).fill(0xff5c9d);
    neon.rect(94, 10, 2, 3).fill(0xff5c9d);
    neon.rect(92, 12, 2, 1).fill(0xff5c9d);
    neon.rect(101, 8, 5, 2).fill(0x4de3ff);
    neon.rect(101, 10, 2, 5).fill(0x4de3ff);
    neon.rect(101, 15, 5, 2).fill(0x4de3ff);
    for (let i = 0; i < 4; i++) {
      neon.rect(112 + i * 6, 15 - i * 2, 3, 2 + i * 2).fill({ color: 0x37d6a3, alpha: 0.5 + i * 0.12 });
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

    this.meeting.position.set(45, 128);
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

    this.coffee.position.set(282, 130);
    this.coffee.addChild(g);
  }

  private drawPlants(): void {
    const g = new Graphics();
    for (const x of [16, 304]) {
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
