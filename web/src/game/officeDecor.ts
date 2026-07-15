import { Container, Graphics } from "pixi.js";

/** Decorative office areas that do not represent agent tool destinations. */
export class OfficeDecor {
  readonly container = new Container();
  private readonly meeting = new Container();
  private readonly coffee = new Container();

  constructor() {
    this.container.zIndex = 132;
    this.drawMeetingArea();
    this.drawCoffeeArea();
    this.drawPlants();
    this.container.addChild(this.meeting, this.coffee);
  }

  setWorkerCount(count: number): void {
    // At high density the same floor area becomes extra desk space.
    const showSharedNooks = count <= 8;
    this.meeting.visible = showSharedNooks;
    this.coffee.visible = showSharedNooks;
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
