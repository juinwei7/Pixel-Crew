import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { GifSprite, type GifSource } from "pixi.js/gif";
import type { CharacterActivity } from "../types";
import { texFromMap } from "./pixels";
import { avatarPresetPalette, avatarPresetRows, normalizeAvatarPresetId } from "./avatarPresets";
import { t } from "../i18n";
import type { StationKey } from "../stations";
import type { Trait } from "./officeLife";
import { FRONT_IDLE_0, SHIRT_COLORS } from "./crewLook";
import { pickMicro } from "./microLife";

// Re-exported for existing importers inside the scene; UI code imports ./crewLook directly.
export { FRONT_IDLE_0, SHIRT_COLORS };

// ---------- Front (facing camera) ----------


const FRONT_IDLE_1 = [
  "............",
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const FRONT_WALK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBS..",
  "..PPPPPPPP..",
  ".PPP....ppp.",
  ".PPP....ppp.",
  ".FFF....FFF.",
  "............",
];

const FRONT_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  "..BBBBBBBBS.",
  ".SBbBBBBbBS.",
  ".SBBBBBBBB..",
  "..PPPPPPPP..",
  ".ppp....PPP.",
  ".ppp....PPP.",
  ".FFF....FFF.",
  "............",
];

// ---------- Side (profile, drawn facing right; flip for left) ----------

const SIDE_STRIDE_A = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "..SBBBBBB...",
  "...BBBBBBS..",
  "....BBBB....",
  "....PPPP....",
  "...pp..PP...",
  "..pp....PP..",
  "..FF....FF..",
  "............",
];

const SIDE_PASS = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "...BBBBBB...",
  "...SBBBBS...",
  "....BBBB....",
  "....PPPP....",
  "....PPpp....",
  "....PPpp....",
  "....FFFF....",
  "............",
];

const SIDE_STRIDE_B = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "...BBBBBBS..",
  "..SBBBBBB...",
  "....BBBB....",
  "....PPPP....",
  "...PP..pp...",
  "..PP....pp..",
  "..FF....FF..",
  "............",
];

// ---------- Back (facing away, working / walking away) ----------

const BACK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const BACK_TYPE_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  ".SBBBBBBBBS.",
  ".SBBBBBBBBS.",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const BACK_WALK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBS..",
  "..PPPPPPPP..",
  ".PPP....ppp.",
  ".PPP....ppp.",
  ".FFF....FFF.",
  "............",
];

const BACK_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  "..BBBBBBBBS.",
  ".SBbBBBBbBS.",
  ".SBBBBBBBB..",
  "..PPPPPPPP..",
  ".ppp....PPP.",
  ".ppp....PPP.",
  ".FFF....FFF.",
  "............",
];

const CHEER = [
  ".S..HHHH..S.",
  ".S.HHHHHH.S.",
  ".SHHHHHHHHS.",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  "..BBBBBBBB..",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// ---------- Body language (front) ----------

// Thinking: the classic "thinker" — one forearm across the belly holding the
// other elbow, that hand up on the chin, eyes glancing aside. The crossed arm
// is skin-coloured so it reads against the shirt even at 2x zoom.
const THINK_CHIN = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSSESSEH..",
  "..HSSSSSSH..",
  "...SSSSSSSS.",
  "..BBBBBBBBS.",
  "..BBBBBBBBS.",
  "..BSSSSSSSS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// Same pose, eyes drifting up toward the thought cloud — "hmm…".
const THINK_UP = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSESSEH..",
  "..HSSSSSSH..",
  "..HSSSSSSH..",
  "...SSSSSSSS.",
  "..BBBBBBBBS.",
  "..BBBBBBBBS.",
  "..BSSSSSSSS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// Hand up — "over here!". Two frames make a slow wave; used while waiting on
// an approval and to wave back at a hovering cursor.
const HAND_UP_0 = [
  "....HHHH..S.",
  "...HHHHHH.S.",
  "..HHHHHHHHB.",
  "..HSSSSSSHB.",
  "..HSESSESHB.",
  "..HSSSSSSHB.",
  "...SSSSSSB..",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const HAND_UP_1 = [
  "....HHHH...S",
  "...HHHHHH.SB",
  "..HHHHHHHHB.",
  "..HSSSSSSHB.",
  "..HSESSESHB.",
  "..HSSSSSSHB.",
  "...SSSSSSB..",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// Arms open, mouth an "o" — ready to catch something dragged over / flying in.
const OPEN_ARMS = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSXXSSH..",
  "S..SSSSSS..S",
  ".BBBBBBBBBB.",
  "..BBBBBBBB..",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// Tired: a wide yawn, then a full stretch — long context, long day.
const YAWN_OPEN = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HShSShSH..",
  "..HSSXXSSH..",
  "...SSXXSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const YAWN_STRETCH = [
  ".S..HHHH..S.",
  ".S.HHHHHH.S.",
  ".SHHHHHHHHS.",
  "..HSSSSSSH..",
  "..HShSShSH..",
  "..HSSXXSSH..",
  "...SSXXSS...",
  "..BBBBBBBB..",
  "..BBBBBBBB..",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

// Error: scratching the head, two frames for the rubbing motion.
const SCRATCH_0 = [
  "....HHHHS...",
  "...HHHHHHS..",
  "..HHHHHHHHS.",
  "..HSSSSSSHS.",
  "..HSESSESHS.",
  "..HSSSSSSHS.",
  "...SSSSSS.S.",
  "..BBBBBBBBB.",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const SCRATCH_1 = [
  "....HHHH....",
  "...HHHHHHSS.",
  "..HHHHHHHHS.",
  "..HSSSSSSHS.",
  "..HSESSESHS.",
  "..HSSSSSSHS.",
  "...SSSSSS.S.",
  "..BBBBBBBBB.",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

/** A copy of `base` with some rows replaced — most body-language frames only move the arms. */
function patch(base: string[], rows: Record<number, string>): string[] {
  return base.map((row, y) => rows[y] ?? row);
}

// ---------- Desk life (back view: typing, stretching, sipping) ----------

// Typing with the hands visibly alternating at the sides of the body.
const BACK_TYPE_A = patch(BACK_0, { 7: ".SBBBBBBBB..", 8: ".SBBBBBBBBS.", 9: "..BbBBBBbBS." });
const BACK_TYPE_B = patch(BACK_0, { 7: "..BBBBBBBBS.", 8: ".SBBBBBBBBS.", 9: ".SBbBBBBbB.." });
// Both hands forward on the keyboard (hidden by the back) — "Enter", knuckle crack.
const BACK_ARMS_IN = patch(BACK_0, { 7: "..BBBBBBBB..", 8: "..BBBBBBBB..", 9: "..BbBBBBbB.." });
// Arms straight up over the chair back.
const BACK_STRETCH = patch(BACK_0, {
  0: ".S..HHHH..S.", 1: ".S.HHHHHH.S.", 2: ".SHHHHHHHHS.",
  7: "..BBBBBBBB..", 8: "..BBBBBBBB..", 9: "..BbBBBBbB..",
});
// Right hand up at the side of the head (mug to the lips / moving a card).
const BACK_SIP = patch(BACK_0, {
  4: "..HhHHHHhHS.", 5: "..HHHHHHHHS.", 6: "...hHHHHh.B.", 7: "..BBBBBBBBB.", 8: ".SBBBBBBBB..", 9: ".SBbBBBBbB..",
});

// ---------- Front-facing activities ----------

// Reading a book held at the chest, eyes down on the page.
const FRONT_READ = patch(FRONT_IDLE_0, {
  4: "..HSSSSSSH..", 5: "..HSESSESH..", 8: ".BBBBBBBBBB.", 9: ".BSBBBBBBSB.",
});
// Rubbing tired eyes with both forearms up (two frames for the rub).
const FRONT_RUB_0 = patch(FRONT_IDLE_0, {
  4: "..HBSSSSBH..", 5: "..HBSSSSBH..", 6: "...BSSSSB...", 7: "..BBBBBBBB..", 8: "..BBBBBBBB..", 9: "..BbBBBBbB..",
});
const FRONT_RUB_1 = patch(FRONT_RUB_0, { 4: "..HSBSSBSH..", 5: "..HSBSSBSH..", 6: "...SBSSBS..." });
// Head down over a phone held in both hands.
const FRONT_PHONE = patch(FRONT_IDLE_0, {
  4: "..HSSSSSSH..", 5: "..HSESSESH..", 8: "..BBBBBBBB..", 9: "..BBSSSSBB..",
});
// Impatient: tapping a foot (right foot lifted a pixel)…
const FRONT_TAP = patch(FRONT_IDLE_0, { 13: "..PPP..FFF..", 14: "..FFF......." });
// …and glancing down at the watch on the left wrist.
const FRONT_WATCH = patch(FRONT_IDLE_0, { 4: "..HSSSSSSH..", 5: "..HSESSESH..", 8: ".SBBBBBBBB..", 9: ".SBbBBBSSB.." });

// Arm out to the right at shoulder height (watering can), eyes following it.
const FRONT_REACH = patch(FRONT_IDLE_0, { 4: "..HSSESSEH..", 7: "..BBBBBBBBBS", 8: ".SBBBBBBBB.." });
// Bending to pet something on the floor to the right.
const FRONT_PET = patch(FRONT_IDLE_0, {
  4: "..HSSSSSSH..", 5: "..HSSESSEH..", 8: ".SBBBBBBBBB.", 9: ".SBbBBBBbBB.", 10: "..BBBBBBBBBS",
});

/** Eyes shut for a blink: eye pixels painted over with skin. */
function closeEyes(rows: string[]): string[] {
  return rows.map((row) => row.replace(/E/g, "S"));
}

/** Eyes slid one pixel sideways (-1 left / 1 right) — glancing at the cursor. */
function shiftEyes(rows: string[], dir: -1 | 1): string[] {
  return rows.map((row) => {
    if (!row.includes("E")) return row;
    const src = [...row];
    const out = src.map((pixel) => (pixel === "E" ? "S" : pixel));
    src.forEach((pixel, x) => {
      if (pixel === "E" && (src[x + dir] === "S" || src[x + dir] === "E")) out[x + dir] = "E";
      else if (pixel === "E") out[x] = "E";
    });
    return out.join("");
  });
}

// Some players turn off motion system-wide; respect it by dropping the
// procedural extras (squash, breathing, jumps, desk fx) and keeping frames.
const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Gait = "side" | "front" | "back";


export type EmoteKind = "question" | "cloud" | "chat" | "coffee" | "spark" | "alert" | "bang" | "heart" | "hi" | "bye" | "angry" | "thumb" | "moon";

/**
 * Small self-contained bits of life. Desk ones play while working (back to
 * camera), idle ones while standing around; "water" and "pet" are started by
 * the scene once it has walked the NPC over to a plant / the cat.
 */
export type MicroAct =
  | "stretch" | "sip" | "knuckles" | "swivel" | "rubEyes"
  | "phone" | "spin" | "idleStretch" | "doze"
  | "read" | "dust" | "bounce" | "game" | "sneeze"
  | "nod" | "neckRoll" | "lookAway" | "ponder" | "glasses"
  | "water" | "pet";

const MICRO_MS: Record<MicroAct, number> = {
  stretch: 1_300, sip: 1_800, knuckles: 1_000, swivel: 1_400, rubEyes: 1_700,
  phone: 4_400, spin: 1_100, idleStretch: 1_500, doze: 5_600,
  read: 5_200, dust: 2_600, bounce: 1_600, game: 4_200, sneeze: 1_300,
  nod: 1_700, neckRoll: 1_800, lookAway: 2_800, ponder: 2_600, glasses: 1_100,
  water: 2_800, pet: 2_800,
};
/** Idle habits per personality — each NPC drifts toward their own. */
const TRAIT_IDLE: Record<Trait, MicroAct[]> = {
  energetic: ["bounce", "spin", "idleStretch", "bounce", "phone", "neckRoll"],
  sleepy: ["doze", "doze", "idleStretch", "phone", "lookAway", "neckRoll"],
  nerdy: ["game", "read", "phone", "game", "glasses", "ponder"],
  tidy: ["dust", "dust", "idleStretch", "phone", "glasses", "lookAway"],
  social: ["phone", "spin", "idleStretch", "phone", "lookAway"],
  chill: ["phone", "spin", "idleStretch", "doze", "phone", "lookAway", "ponder"],
};
/** Walking pace and how often they fidget, per personality. */
const TRAIT_PACE: Record<Trait, number> = { energetic: 1.25, sleepy: 0.8, nerdy: 1, tidy: 1, social: 1.05, chill: 0.9 };
const TRAIT_FIDGET: Record<Trait, number> = { energetic: 0.65, sleepy: 1.1, nerdy: 1, tidy: 0.9, social: 0.9, chill: 1.2 };
export type Celebration = "jump" | "fistpump" | "dance" | "big";
const DESK_MICROS: MicroAct[] = ["stretch", "sip", "knuckles", "swivel", "rubEyes", "sip", "nod", "neckRoll"];
const BOOK_MICROS: MicroAct[] = ["idleStretch", "rubEyes", "nod", "nod"];
const IDLE_MICROS: MicroAct[] = ["phone", "spin", "idleStretch", "doze", "phone", "lookAway", "ponder"];
/** Micros allowed to keep running while the NPC is working (everything else is idle-only). */
const WORK_MICROS = new Set<MicroAct>([...DESK_MICROS, ...BOOK_MICROS, "sneeze"]);
const SCENE_MICROS = new Set<MicroAct>(["water", "pet"]);

/** Stations worked at a monitor on a desk (everything except reading and the meeting table). */
const SCREEN_STATIONS = new Set<StationKey>(["terminal", "code", "web", "check", "board", "desk", "home"]);
/** Colour each station's screen throws on the worker. */
const SCREEN_TINT: Partial<Record<StationKey, number>> = {
  terminal: 0x5dff9c, code: 0x4de3ff, web: 0x8fc4ff, check: 0x37d6a3, board: 0xffd166, desk: 0xf29e4c, home: 0x4de3ff,
};
const CONFETTI_COLORS = [0xffd166, 0xff4dd8, 0x4de3ff, 0x37d6a3, 0x9b7bff, 0xf29e4c];
const SYNTAX = [0xff79c6, 0x8be9fd, 0xf1fa8c, 0x50fa7b, 0xbd93f9, 0xffb86c];
// Monitor screen (art px, relative to the feet): sits on a desk slab above the head.
const SCR_L = -7;
const SCR_T = -31;
const SCR_W = 14;
const SCR_H = 9;
/** How far emotes / the active marker move up while a monitor is shown. */
const SCREEN_LIFT = 13;

type Confetto = { x: number; y: number; vx: number; vy: number; color: number; life: number; size: number };

/** Small per-NPC look so a room of 10+ never feels like clones (picked from the id hash). */
export type Accessory = "none" | "cap" | "beanie" | "headband" | "bow" | "glasses" | "scarf" | "flower";
export const ACCESSORIES: Accessory[] = ["none", "cap", "beanie", "headband", "bow", "glasses", "scarf", "flower", "none", "glasses"];
const ACCENT_COLORS = [0xff5d73, 0x4de3ff, 0xffd166, 0x37d6a3, 0x9b7bff, 0xf29e4c, 0xff8fc8];
type View = "front" | "back" | "side";

type PresetFrames = ReturnType<typeof createPresetFrames>;

export class Person {
  readonly container = new Container();
  private readonly shadow = new Graphics();
  /** Floor ring under the feet (drag-and-drop target highlight). */
  private readonly underG = new Graphics();
  private readonly sprite: Sprite;
  /** Held props drawn over the body (the deliverable box). */
  private readonly propG = new Graphics();
  private readonly thinkDots = new Graphics();
  private readonly marker = new Graphics();
  private readonly emoteG = new Graphics();
  private readonly haloG = new Graphics();
  private emoteKind: EmoteKind | null = null;
  private emoteT = 0;
  private emoteMs = 0;
  active = false;

  private f: PresetFrames;
  private presetKey: string;
  private customTexture: Texture | null = null;
  private gifSprite: GifSprite | null = null;
  private customScale = 1;
  private avatarLoadVersion = 0;
  private avatarUrl: string | null = null;
  private destroyed = false;

  x = 232;
  y = 154;
  private path: Array<{ x: number; y: number }> = [];
  private facing = 1;
  private walkCycleT = 0;

  activity: CharacterActivity = "idle";
  private animT = 0;
  private flashColor = 0xffffff;
  private flashT = 0;
  private cheerT = 0;

  /** Where the worker is standing — picks the body language while working. */
  station: StationKey = "home";
  /** Waiting on the owner (tool approval): hand up, small hops. Set by the scene. */
  handRaised = false;
  /** Something is being dragged over this NPC: arms open, ring on the floor. */
  reaching = false;
  /** Carrying a deliverable box over to the outbox shelf. */
  carrying = false;
  /** Which side of the head the cursor is on (-1/0/1); idle NPCs glance at it. */
  gaze: -1 | 0 | 1 = 0;
  private readonly fxG = new Graphics();
  private wasMoving = false;
  private wasCheering = false;
  private lastStepIdx = -1;
  // Damped-spring squash: positive squashes, the rebound stretches.
  private squashAmt = 0;
  private squashT = 0;
  private turnT = 0;
  private scratchT = 0;
  private hopT = 0;
  private reachT = 0;
  private yawnT = 0;
  private coffeeAfterYawn = false;
  private waveT = 0;
  private waveCooldown = 0;
  private haloT = 0;
  private blinkT = 0;
  private nextBlinkAt = 1500 + Math.random() * 3000;
  /** Behind the body: the monitor + desk at a workstation, its glow, result screens, the beam-in column. */
  private readonly stationG = new Graphics();
  /** Per-NPC phase offset so a room full of workers never types, nods or stretches in sync. */
  private readonly seed = Math.random();
  private micro: MicroAct | null = null;
  private microT = 0;
  private microDir: 1 | -1 = 1;
  private nextMicroAt = 5_000 + Math.random() * 9_000;
  /** Random desk / idle micro-actions on their own timer. The scene may switch them off. */
  idleLife = true;
  /** Personality (from the id hash, see officeLife.traitFor). */
  trait: Trait = "chill";
  /** Carried while walking between stations — the scene picks one per trip. */
  walkProp: "laptop" | "papers" | null = null;
  /** Long stretch of work: headphones on, a quiet focus aura, the odd sweat drop. */
  deepFocus = false;
  /** Easter egg (poked 20 times): shades on for the rest of the session. */
  sunglasses = false;
  private rushT = 0;
  /** Waiting on an approval for a long time: foot tapping, watch checking. */
  impatient = false;
  /** Lots of tokens used: droopy, eye bags, slower, the odd sigh. */
  tired = false;
  accessory: Accessory = "none";
  accessoryColor = 0xff5d73;
  private errKind: "facepalm" | "kick" | "glare" = "facepalm";
  private errT = 0;
  private comboN = 0;
  private comboT = 0;
  /** One-shot beat inside a micro-action (the coffee-spill reaction fires once). */
  private sneezeBeat = 0;
  /** animT of the last sneeze; starts at 0 so nobody sneezes in their first few minutes either. */
  private lastSneezeAt = 0;
  private spill = false;
  private danceT = 0;
  private fistT = 0;
  private highFiveT = 0;
  private highFiveDir: 1 | -1 = 1;
  private fireworksT = 0;
  private fwX = 0;
  private fwY = 0;
  /** Power cut (link to the server down): dozing at the desk until wake(). */
  asleep = false;
  /** Show our own "z z" while dozing; the scene draws them above its dimmer instead during a power cut. */
  snoreVisible = true;
  private resultKind: "success" | "error" | null = null;
  private resultT = 0;
  private resultX = 0;
  private resultY = 0;
  private readonly confetti: Confetto[] = [];
  private arriveT = 0;
  private farewellT = 0;
  private farewellStarted = false;
  private bulbWas = false;
  private wasMovingProp = false;
  /** Monitor booting after a power cut (logo + bar before the work content comes back). */
  private bootT = 0;
  /** Startled awake → stretch this many ms later. */
  private stretchIn = 0;
  /** Pointer is over this NPC: faint ring under the feet. Set by the scene. */
  hovered = false;
  // Poke reactions.
  private shooT = 0;
  private shakeT = 0;
  private dizzyT = 0;
  // Short speech line ("在忙！"), drawn as a pixel bubble with a crisp tiny Text.
  private readonly sayG = new Graphics();
  private sayText: Text | null = null;
  private sayT = 0;
  private sayMs = 0;

  private static readonly SPEED = 0.05; // art px per ms
  private static readonly TURN_MS = 140;
  private static readonly CHEER_MS = 900;
  private static readonly JUMP_MS = 380;
  private static readonly HOP_MS = 300;
  private static readonly YAWN_MS = 1700;
  private static readonly WAVE_MS = 1300;
  private static readonly HALO_MS = 1100;
  private static readonly RESULT_MS = 1_800;
  private static readonly ARRIVE_MS = 1_500;
  private static readonly FAREWELL_MS = 1_700;

  constructor(colorIndex = 0, presetId = "classic") {
    this.f = createPresetFrames(presetId, colorIndex);
    this.presetKey = `${presetId}:${colorIndex}`;

    this.sprite = new Sprite(this.f.idleFrames[0]);
    this.sprite.anchor.set(0.5, 1);
    this.shadow.ellipse(0, 0, 5.5, 1.8).fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(
      this.shadow, this.underG, this.stationG, this.sprite, this.propG, this.fxG,
      this.thinkDots, this.marker, this.haloG, this.emoteG,
    );
    for (let i = 0; i < 18; i++) this.confetti.push({ x: 0, y: 0, vx: 0, vy: 0, color: 0, life: 0, size: 1 });
  }

  /**
   * Play a small bit of life now (also used by the scene for "water" / "pet"
   * and the poke reactions). `dir` mirrors side-facing acts (-1 = to the left).
   */
  microAct(kind: MicroAct, dir: 1 | -1 = 1): void {
    this.micro = kind;
    this.microT = MICRO_MS[kind];
    this.microDir = dir;
    if (kind === "pet") this.emote("heart", MICRO_MS.pet);
    // Now and then the coffee goes everywhere.
    this.spill = kind === "sip" && Math.random() < 0.05;
    this.sneezeBeat = 0;
    if (kind === "sneeze") this.lastSneezeAt = this.animT;
    this.nextMicroAt = this.animT + this.microGap();
  }

  get acting(): MicroAct | null {
    return this.micro;
  }

  /** Power back: the light over them comes on — a startled hop, then a good stretch; their monitor boots. */
  wake(): void {
    if (!this.asleep) return;
    this.asleep = false;
    this.hop();
    this.kick(0.16);
    this.stretchIn = REDUCE_MOTION ? 0 : 420;
    if (this.facesScreen()) this.bootT = 950;
  }

  /**
   * Someone clicked (poked) this NPC. `level` counts rapid repeat pokes; past
   * a few they get annoyed, then dizzy. Purely visual — never selects or sends anything.
   */
  poke(level: number): void {
    const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
    if (this.asleep) {
      this.say(pick(["呼嚕…", "再五分鐘…"]), 1_300);
      this.kick(0.08);
      return;
    }
    if (level >= 5) {
      this.dizzyT = 2_400;
      this.micro = null;
      this.say(pick(["頭好暈…", "@_@"]), 2_000);
      this.kick(0.16);
      return;
    }
    if (level >= 3) {
      this.shakeT = 650;
      this.emote("angry", 1_600);
      this.say(pick(["別戳我！", "很癢欸！", "夠了喔"]), 1_500);
      this.kick(0.12);
      return;
    }
    if (this.activity === "working" || this.activity === "thinking") {
      // Busy: wave you off without leaving the desk.
      if (this.facesScreen()) this.shooT = 1_100;
      else this.kick(0.08);
      this.say(pick(["在忙！", "等一下…", "手上有事"]), 1_300);
      return;
    }
    switch (Math.floor(Math.random() * 5)) {
      case 0:
        this.hop();
        this.emote("bang", 900);
        break;
      case 1:
        this.emote("question", 1_300);
        this.kick(0.08);
        break;
      case 2:
        this.microAct("spin");
        this.say("咻～", 900);
        break;
      case 3:
        this.waveT = Person.WAVE_MS;
        this.waveCooldown = 4_000;
        this.say("嗨～", 1_300);
        break;
      default:
        this.hop();
        this.say(pick(["幹嘛？", "有事嗎？", "我在！"]), 1_300);
    }
  }

  /** A short line in a speech bubble over the head. */
  say(text: string, ms: number): void {
    if (!this.sayText) {
      this.sayText = new Text({
        text,
        style: {
          fontFamily: "'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
          fontSize: 6,
          fontWeight: "700",
          fill: 0xeef4ff,
        },
        resolution: 8,
      });
      this.sayText.anchor.set(0.5, 0);
      this.container.addChild(this.sayG, this.sayText);
    } else {
      this.sayText.text = text;
    }
    this.sayT = ms;
    this.sayMs = ms;
  }

  /** Hurry: a little run (faster steps, dust puffs) — e.g. just dispatched. */
  rush(ms: number): void {
    this.rushT = Math.max(this.rushT, ms);
  }

  /** Dance in place (party, small celebrations). */
  dance(ms: number): void {
    this.danceT = Math.max(this.danceT, ms);
    this.micro = null;
  }

  /** High five toward `dir` (1 = partner on the right): raised hand, a hop as the palms meet. */
  highFive(dir: 1 | -1): void {
    this.highFiveT = 800;
    this.highFiveDir = dir;
    this.micro = null;
  }

  /** A teammate nearby finished: thumbs up and a little hop. */
  thumbsUp(): void {
    this.emote("thumb", 1_500);
    this.hop();
  }

  /** Turn finished: a little jump, a fist pump, a dance — or now and then the big one with fireworks. */
  celebrate(kind: Celebration): void {
    if (kind === "jump" || kind === "big") this.cheerT = Person.CHEER_MS;
    if (kind === "fistpump") this.fistT = 1_000;
    if (kind === "dance") this.dance(1_500);
    if (kind === "big" && !REDUCE_MOTION) {
      this.fireworksT = 1_700;
      this.fwX = Math.round(this.x);
      this.fwY = Math.round(this.y);
    }
  }

  /**
   * Turn finished: the monitor shows a big check (success) or glitches red and
   * smokes (error). Confetti only for the occasional big celebration.
   */
  showResult(success: boolean, big = false): void {
    this.resultKind = success ? "success" : "error";
    this.resultT = Person.RESULT_MS;
    this.resultX = Math.round(this.x);
    this.resultY = Math.round(this.y);
    if (!success || !big || REDUCE_MOTION) return;
    // Confetti pops out of the top of the screen and flutters down.
    this.confetti.forEach((c, i) => {
      c.x = this.resultX + SCR_L + Math.random() * SCR_W;
      c.y = this.resultY + SCR_T;
      c.vx = (Math.random() - 0.5) * 0.07;
      c.vy = -0.05 - Math.random() * 0.06;
      c.color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      c.life = 1_100 + Math.random() * 600;
      c.size = 1;
    });
  }

  /** A brand-new teammate beams in: light column, materialise, then a "HI" wave. */
  arrive(): void {
    this.arriveT = REDUCE_MOTION ? 1 : Person.ARRIVE_MS;
    this.farewellT = 0;
    this.farewellStarted = false;
  }

  /** Someone left the crew: a wave and "BYE", then a poof of smoke. Check `farewellDone`. */
  farewell(): void {
    if (this.farewellStarted) return;
    this.farewellStarted = true;
    this.farewellT = REDUCE_MOTION ? 400 : Person.FAREWELL_MS;
    this.emote("bye", this.farewellT);
  }

  get farewellDone(): boolean {
    return this.farewellStarted && this.farewellT <= 0;
  }

  private microGap(): number {
    const working = this.activity === "working";
    const base = working ? 7_000 + Math.random() * 9_000 : 11_000 + Math.random() * 16_000;
    return base * TRAIT_FIDGET[this.trait];
  }

  /** Working at a desk monitor (back to the camera)? */
  private facesScreen(): boolean {
    return this.activity === "working" && SCREEN_STATIONS.has(this.station);
  }

  setPreset(presetId: string, colorIndex: number): void {
    const nextKey = `${presetId}:${colorIndex}`;
    if (nextKey === this.presetKey) return;
    const previous = this.presetTextures();
    this.f = createPresetFrames(presetId, colorIndex);
    this.presetKey = nextKey;
    if (!this.customTexture) this.sprite.texture = this.f.idleFrames[0];
    for (const texture of previous) texture.destroy(true);
  }

  /** Walk like a person in a room: horizontal leg first, then vertical. */
  setTarget(x: number, y: number): void {
    this.path = [];
    if (Math.abs(x - this.x) > 0.5) this.path.push({ x, y: this.y });
    if (Math.abs(y - this.y) > 0.5) this.path.push({ x, y });
  }

  get isMoving(): boolean {
    return this.path.length > 0;
  }

  flash(color: number, cheer: boolean): void {
    this.flashColor = color;
    this.flashT = 650;
    if (cheer) this.cheerT = Person.CHEER_MS;
  }

  /** Cheer pose without the colour flash — e.g. neighbours applauding. */
  cheer(): void {
    this.cheerT = Person.CHEER_MS;
  }

  /** Head-scratch after a failed turn — the body-language half of the "cloud". */
  scratch(): void {
    this.scratchT = 1800;
  }

  /**
   * A turn failed. First time: a facepalm, a kick at the desk (the monitor
   * shakes) or a head scratch. Again soon after (level >= 2): a long glare at
   * the monitor. Returns the line they mutter, for the scene's talk limiter.
   */
  reactError(level: number): string {
    const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
    this.micro = null;
    if (level >= 2) {
      this.errKind = "glare";
      this.errT = 2_600;
      this.emote("angry", 2_400);
      return pick(["又來？", "…你認真？", "第二次了喔"]);
    }
    const roll = Math.random();
    if (roll < 0.35) {
      this.errKind = "facepalm";
      this.errT = 1_800;
      this.emote("cloud", 2_400);
      return pick(["唉…", "怎麼會…"]);
    }
    if (roll < 0.7 && this.facesScreen()) {
      this.errKind = "kick";
      this.errT = 1_100;
      this.kick(0.15);
      return pick(["可惡！", "蛤？"]);
    }
    this.scratch();
    this.emote("cloud", 4_000);
    return pick(["怪了…", "蛤？"]);
  }

  /** A long chain of tool calls: "COMBO xN" pops over the head. */
  combo(n: number): void {
    this.comboN = n;
    this.comboT = 1_300;
  }

  /** A small on-the-spot hop (approval nag, catching a task). */
  hop(): void {
    if (this.hopT <= 0) this.hopT = Person.HOP_MS;
  }

  /** Open the arms for a moment — something is about to land in them. */
  reachFor(ms: number): void {
    this.reachT = Math.max(this.reachT, ms);
  }

  /** Caught a task (paper plane / drop): hop plus a quick "!". */
  catchIt(): void {
    this.reachT = 0;
    this.hop();
    this.kick(0.12);
    this.emote("bang", 1_100);
  }

  /** Long-context fatigue: yawn and stretch, then reach for a coffee. */
  yawn(): void {
    this.yawnT = Person.YAWN_MS;
    this.coffeeAfterYawn = true;
  }

  /** Wave back at the cursor; rate-limited so hovering doesn't spam it. */
  wave(): void {
    if (this.waveCooldown > 0) return;
    this.waveT = Person.WAVE_MS;
    this.waveCooldown = 9_000;
  }

  /** Context reset (brain swap / new session): halo + scan line, then a dizzy stagger — "who am I?". */
  brainReset(): void {
    this.haloT = Person.HALO_MS;
    this.kick(0.1);
    this.dizzyT = Math.max(this.dizzyT, 1_800);
    this.say("我是誰？", 1_800);
  }

  /** Pixel emote bubble above the head; ms <= 0 clears it. */
  emote(kind: EmoteKind, ms: number): void {
    if (ms <= 0) {
      this.emoteKind = null;
      this.emoteT = 0;
      this.emoteG.clear();
      return;
    }
    // Re-arming the same emote (e.g. the scene keeping "!" alive) must not
    // restart its pop-in animation.
    if (this.emoteKind !== kind) this.emoteMs = ms;
    else this.emoteMs = Math.max(this.emoteMs, ms + (this.emoteMs - this.emoteT));
    this.emoteKind = kind;
    this.emoteT = ms;
  }

  get emoting(): EmoteKind | null {
    return this.emoteKind;
  }

  async setAvatar(url: string | null): Promise<string | null> {
    const version = ++this.avatarLoadVersion;
    await this.releaseAvatar();
    if (this.destroyed || version !== this.avatarLoadVersion) return null;
    this.sprite.visible = true;
    if (!url) {
      this.customTexture = null;
      this.customScale = 1;
      return null;
    }
    this.customTexture = null;
    try {
      if (url.toLowerCase().endsWith(".gif")) {
        const source = await Assets.load<GifSource>({
          src: url,
          data: { fps: 20, scaleMode: "nearest", autoGenerateMipmaps: false },
        });
        const gif = new GifSprite({ source, autoPlay: true, loop: true, autoUpdate: true });
        if (!this.destroyed && version === this.avatarLoadVersion) {
          gif.anchor.set(0.5, 1);
          this.gifSprite = gif;
          this.avatarUrl = url;
          this.customScale = Math.min(12 / source.width, 16 / source.height);
          this.sprite.visible = false;
          this.container.addChildAt(gif, this.container.getChildIndex(this.sprite));
        } else {
          gif.destroy();
          await unloadAvatar(url);
        }
      } else {
        const texture = await Assets.load<Texture>(url);
        if (!this.destroyed && version === this.avatarLoadVersion) {
          this.customTexture = texture;
          this.avatarUrl = url;
          this.customScale = Math.min(12 / texture.width, 16 / texture.height);
        } else {
          await unloadAvatar(url);
        }
      }
      return null;
    } catch (error) {
      await unloadAvatar(url);
      if (!this.destroyed && version === this.avatarLoadVersion) {
        this.customTexture = null;
        this.sprite.visible = true;
        return t("無法載入自訂角色：{detail}", { detail: (error as Error).message || t("圖片解碼失敗") });
      }
      return null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.avatarLoadVersion++;
    const url = this.avatarUrl;
    this.avatarUrl = null;
    this.clearGifSprite();
    this.customTexture = null;
    if (url) void unloadAvatar(url);
    this.container.destroy({ children: true });
    for (const texture of this.presetTextures()) {
      texture.destroy(true);
    }
  }

  private presetTextures(): Set<Texture> {
    const out = new Set<Texture>();
    for (const value of Object.values(this.f)) {
      for (const texture of Array.isArray(value) ? value : [value]) out.add(texture);
    }
    return out;
  }

  private async releaseAvatar(): Promise<void> {
    const url = this.avatarUrl;
    this.avatarUrl = null;
    this.clearGifSprite();
    this.sprite.texture = this.f.idleFrames[0];
    this.sprite.visible = true;
    this.customTexture = null;
    this.customScale = 1;
    if (url) await unloadAvatar(url);
  }

  private clearGifSprite(): void {
    if (!this.gifSprite) return;
    this.gifSprite.stop();
    this.gifSprite.destroy();
    this.gifSprite = null;
  }

  update(tMs: number, dtMs: number): void {
    let dx = 0;
    let dy = 0;
    let moving = false;

    if (this.rushT > 0) this.rushT -= dtMs;
    let budget = Person.SPEED * TRAIT_PACE[this.trait] * (this.rushT > 0 ? 1.9 : this.tired ? 0.8 : 1) * dtMs;
    while (budget > 0 && this.path.length > 0) {
      const wp = this.path[0];
      dx = wp.x - this.x;
      dy = wp.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        this.x = wp.x;
        this.y = wp.y;
        budget -= dist;
        this.path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        budget = 0;
      }
      moving = true;
    }

    if (moving) {
      if (Math.abs(dx) > 0.5) {
        const nextFacing = Math.sign(dx);
        // Turning around: a quick "card flip" through the profile instead of
        // snapping the sprite mirror in a single frame.
        if (nextFacing !== this.facing) this.turnT = Person.TURN_MS;
        this.facing = nextFacing;
      }
      this.walkCycleT += dtMs * (this.rushT > 0 ? 1.7 : 1) * TRAIT_PACE[this.trait];
    } else {
      this.walkCycleT = 0;
      this.lastStepIdx = -1;
    }
    // Weight shift when setting off, and a settle when arriving.
    if (moving !== this.wasMoving) this.kick(moving ? 0.08 : 0.12);
    this.wasMoving = moving;

    const prevCheerT = this.cheerT;
    const prevHopT = this.hopT;
    const prevArriveT = this.arriveT;
    if (this.flashT > 0) this.flashT -= dtMs;
    if (this.cheerT > 0) this.cheerT -= dtMs;
    if (this.scratchT > 0) this.scratchT -= dtMs;
    if (this.hopT > 0) this.hopT -= dtMs;
    if (this.reachT > 0) this.reachT -= dtMs;
    if (this.waveT > 0) this.waveT -= dtMs;
    if (this.waveCooldown > 0) this.waveCooldown -= dtMs;
    if (this.haloT > 0) this.haloT -= dtMs;
    if (this.resultT > 0) this.resultT -= dtMs;
    if (this.arriveT > 0) this.arriveT -= dtMs;
    if (this.farewellT > 0) this.farewellT -= dtMs;
    if (this.yawnT > 0) {
      this.yawnT -= dtMs;
      if (this.yawnT <= 0 && this.coffeeAfterYawn) {
        this.coffeeAfterYawn = false;
        this.emote("coffee", 2_600);
      }
    }
    if (this.microT > 0) {
      this.microT -= dtMs;
      if (this.microT <= 0) {
        if (this.micro === "doze") this.kick(0.14); // jolts awake
        this.micro = null;
      }
    }
    if (this.bootT > 0) this.bootT -= dtMs;
    if (this.shooT > 0) this.shooT -= dtMs;
    if (this.shakeT > 0) this.shakeT -= dtMs;
    if (this.dizzyT > 0) this.dizzyT -= dtMs;
    if (this.sayT > 0) this.sayT -= dtMs;
    if (this.stretchIn > 0) {
      this.stretchIn -= dtMs;
      if (this.stretchIn <= 0 && !this.asleep) this.microAct(this.facesScreen() ? "stretch" : "idleStretch");
    }
    if (this.danceT > 0) this.danceT -= dtMs;
    if (this.errT > 0) this.errT -= dtMs;
    if (this.comboT > 0) this.comboT -= dtMs;
    if (this.fistT > 0) this.fistT -= dtMs;
    if (this.highFiveT > 0) {
      const before = this.highFiveT;
      this.highFiveT -= dtMs;
      if (before > 400 && this.highFiveT <= 400) this.kick(0.14); // slap!
    }
    if (this.fireworksT > 0) this.fireworksT -= dtMs;
    if (this.turnT > 0) this.turnT = Math.max(0, this.turnT - dtMs);
    this.squashT += dtMs;
    this.animT += dtMs;
    this.stepConfetti(dtMs);

    // Blink every few seconds (sometimes twice) on front-facing poses.
    if (this.blinkT > 0) this.blinkT -= dtMs;
    else if (this.animT >= this.nextBlinkAt) {
      // Tired eyes blink slower and more often.
      this.blinkT = this.tired ? 320 : 120;
      this.nextBlinkAt = this.animT + (Math.random() < 0.2 ? 260 : (this.tired ? 1_200 : 2_400) + Math.random() * 3600);
    }
    const blinking = this.blinkT > 0;

    // Beaming in: once materialised, wave "HI" at the room.
    const arriveWaveAt = Person.ARRIVE_MS * 0.4;
    if (prevArriveT > arriveWaveAt && this.arriveT <= arriveWaveAt) {
      this.waveT = Person.WAVE_MS;
      this.waveCooldown = 9_000;
      this.emote("hi", 1_900);
      this.kick(0.12);
    }

    let bobY = 0;
    let offX = 0;
    let jump = 0;
    let breathe = false;
    let flip = 1;
    let view: View = "front";
    let screen = false;
    let reading = false;
    const still = !moving;
    const materialising = this.arriveT > arriveWaveAt;
    const leaving = this.farewellStarted;
    const cheering = this.cheerT > 0 && still && !leaving;
    const asleep = this.asleep && still && !cheering && !materialising && !leaving;
    const reach = (this.reaching || this.reachT > 0) && still && !cheering && !asleep;
    const scratching = this.scratchT > 0 && still && !cheering && !reach && !asleep;
    const yawning = this.yawnT > 0 && still && !cheering && !reach && !scratching && !this.carrying && !asleep;
    const waving = this.waveT > 0;
    const handUp = (this.handRaised || waving) && still && !cheering && !reach && !scratching && !yawning && !this.carrying && !asleep;
    const thinking = this.activity === "thinking" && still && !cheering && !reach && !scratching && !yawning && !handUp && !asleep;

    // Micro-actions: drop one the moment something more important happens (or
    // the work it belonged to ends); otherwise start a new one now and then.
    const blocked = moving || cheering || asleep || reach || scratching || yawning || handUp || this.carrying || materialising || leaving;
    if (this.micro) {
      const sceneAct = SCENE_MICROS.has(this.micro);
      const deskAct = !sceneAct && WORK_MICROS.has(this.micro) && this.activity === "working";
      const idleAct = !sceneAct && this.activity === "idle";
      if (blocked || (!sceneAct && !deskAct && !idleAct)) this.micro = null;
    } else if (this.idleLife && !REDUCE_MOTION && !blocked && this.animT >= this.nextMicroAt) {
      const pool = this.activity === "working"
        ? this.station === "books" ? BOOK_MICROS : SCREEN_STATIONS.has(this.station) ? DESK_MICROS : null
        : this.activity === "idle" && this.gaze === 0 && this.emoteKind === null ? TRAIT_IDLE[this.trait] ?? IDLE_MICROS : null;
      if (pool) {
        const kind = pickMicro(pool, {
          nowMs: this.animT,
          lastSneezeAtMs: this.lastSneezeAt,
          sneezeRoll: Math.random(),
          pickRoll: Math.random(),
          wearsGlasses: (this.accessory === "glasses" || this.sunglasses) && !this.customTexture && !this.gifSprite,
          sneeze: "sneeze",
          fallback: "neckRoll",
          needsGlasses: "glasses",
        });
        this.microAct(kind, Math.random() < 0.5 ? -1 : 1);
      }
      else this.nextMicroAt = this.animT + this.microGap();
    }

    const bulb = thinking && !REDUCE_MOTION ? this.bulbAge() : -1;
    if (bulb >= 0 && !this.bulbWas) this.hop(); // "aha!"
    this.bulbWas = bulb >= 0;

    const f = this.f;
    // Work rhythms run on a per-NPC clock so neighbours never move in lockstep.
    const wt = this.animT + this.seed * 10_000;
    if (materialising) {
      this.sprite.texture = f.idleFrames[0];
    } else if (leaving) {
      this.sprite.texture = f.handUp[Math.floor(this.animT / 170) % 2];
    } else if (this.danceT > 0 && still && !asleep) {
      // Little dance: arms up, turn, other side, wave — bouncing on the beat.
      const beat = Math.floor((this.animT + this.seed * 800) / 210) % 4;
      const moves: Array<[Texture, number]> = [[f.cheerFrame, 1], [f.sidePass, -1], [f.handUp[0], 1], [f.sidePass, 1]];
      this.sprite.texture = moves[beat][0];
      flip = moves[beat][1];
      bobY = beat % 2 === 0 ? -1 : 0;
      view = beat % 2 === 0 ? "front" : "side";
    } else if (this.errT > 0 && still && !asleep && !cheering) {
      if (this.errKind === "facepalm") {
        this.sprite.texture = f.rubFrames[0];
        bobY = 1;
      } else if (this.errKind === "kick") {
        // Kicks the desk: the body jolts, the monitor shakes (see stationG below).
        this.sprite.texture = Math.floor(this.errT / 120) % 2 ? f.typeFrames[0] : f.backArmsIn;
        offX = Math.floor(this.errT / 120) % 2 ? 1 : 0;
        view = "back";
        screen = this.facesScreen();
      } else if (this.facesScreen()) {
        // Glare: leaning in, staring the monitor down.
        this.sprite.texture = f.workFrames[0];
        bobY = 1;
        view = "back";
        screen = true;
      } else {
        this.sprite.texture = f.idleFrames[0];
      }
    } else if (this.highFiveT > 0 && still && !asleep) {
      this.sprite.texture = f.handUp[0];
      flip = this.highFiveDir;
      bobY = this.highFiveT < 400 && this.highFiveT > 250 ? -1 : 0;
    } else if (this.fistT > 0 && still && !asleep) {
      // Fist pump: the arm punches up twice.
      this.sprite.texture = f.handUp[Math.floor(this.fistT / 130) % 2];
      bobY = Math.floor(this.fistT / 260) % 2 === 0 ? -1 : 0;
    } else if (cheering) {
      this.sprite.texture = f.cheerFrame;
      const airborne = Person.CHEER_MS - this.cheerT;
      if (airborne < Person.JUMP_MS) {
        jump = Math.sin((Math.PI * airborne) / Person.JUMP_MS) * 4;
      } else {
        if (prevCheerT > Person.CHEER_MS - Person.JUMP_MS) this.kick(0.16); // landing
        bobY = Math.floor(this.cheerT / 150) % 2 === 0 ? -1 : 0;
      }
    } else if (moving) {
      const gait = this.gaitFor(dx, dy);
      view = gait;
      if (gait === "side") {
        const idx = Math.floor(this.walkCycleT / 110) % 4;
        this.sprite.texture = f.sideWalk[idx];
        if (idx % 2 === 1) bobY = -1; // passing pose lifts the body
        else if (idx !== this.lastStepIdx) this.kick(0.05); // heel strike
        this.lastStepIdx = idx;
        flip = this.facing;
      } else {
        const frames = gait === "front" ? f.frontWalk : f.backWalk;
        const idx = Math.floor(this.walkCycleT / 130) % 2;
        this.sprite.texture = frames[idx];
        bobY = idx === 0 ? 0 : -1;
        if (idx === 0 && idx !== this.lastStepIdx) this.kick(0.04);
        this.lastStepIdx = idx;
      }
    } else if (asleep) {
      // Power cut: slumped over the dark monitor, or nodding off standing up.
      if (this.facesScreen()) {
        this.sprite.texture = f.workFrames[0];
        bobY = 1;
        view = "back";
        screen = true;
      } else {
        this.sprite.texture = f.idleBlink[0];
        bobY = Math.floor((this.animT + this.seed * 1_400) / 1_400) % 2;
        breathe = true;
      }
    } else if (reach) {
      this.sprite.texture = f.openArms;
      bobY = Math.floor(this.animT / 260) % 2 === 0 ? 0 : -1;
    } else if (scratching) {
      this.sprite.texture = f.scratchFrames[Math.floor(this.scratchT / 160) % 2];
    } else if (yawning) {
      const p = 1 - this.yawnT / Person.YAWN_MS;
      this.sprite.texture = p > 0.3 && p < 0.8 ? f.yawnStretch : f.yawnOpen;
      if (p > 0.3 && p < 0.8) bobY = -1; // up on the toes for the stretch
    } else if (handUp) {
      // Waving back is brisk; the approval hand sways slowly, like holding it up.
      const period = waving ? 200 : 520;
      this.sprite.texture = f.handUp[Math.floor(this.animT / period) % 2];
      if (this.impatient && !waving && this.handRaised) {
        // Waiting too long: hand down to tap a foot, then a look at the watch.
        const phase = (this.animT + this.seed * 4_000) % 4_200;
        if (phase > 2_200 && phase < 3_400) this.sprite.texture = Math.floor(phase / 180) % 2 ? f.tapFoot : f.idleFrames[0];
        else if (phase >= 3_400) this.sprite.texture = f.watch;
      }
      flip = 1;
      breathe = true;
    } else if (this.shooT > 0 && this.facesScreen()) {
      // Waved off from the desk: a hand flaps back over the shoulder, still facing the screen.
      this.sprite.texture = Math.floor(this.shooT / 140) % 2 ? f.backSip : f.workFrames[0];
      view = "back";
      screen = true;
    } else if (this.micro) {
      const m = this.microPose();
      this.sprite.texture = m.tex;
      bobY = m.bobY;
      offX = m.offX;
      flip = m.flip;
      view = m.view;
      screen = this.facesScreen();
    } else if (thinking) {
      const idx = bulb >= 0 ? 1 : Math.floor(this.animT / 1400) % 2;
      this.sprite.texture = idx === 0 && blinking ? f.thinkBlink : f.thinkFrames[idx];
      breathe = true;
    } else if (this.activity === "working") {
      if (this.station === "books") {
        // Reading: eyes run along the lines, a little nod as each page turns.
        const c = wt % 2_600;
        this.sprite.texture = f.readFrames[Math.floor(wt / 650) % 2];
        bobY = c > 2_200 && c < 2_380 ? 1 : 0;
        breathe = true;
        reading = true;
      } else {
        const work = this.workPose(wt);
        this.sprite.texture = work.tex;
        bobY = work.bobY;
        offX = work.offX;
        view = "back";
        screen = SCREEN_STATIONS.has(this.station);
      }
    } else {
      // Calm resting breath (the dip frame is a whole pixel; quicker reads as jittery bouncing).
      const idx = Math.floor((this.animT + this.seed * 1_100) / 1_100) % 2;
      const frames = blinking ? f.idleBlink
        : this.gaze < 0 ? f.lookLeft
        : this.gaze > 0 ? f.lookRight
        : f.idleFrames;
      this.sprite.texture = frames[idx];
      breathe = true;
    }

    if (this.hopT > 0) {
      jump = Math.max(jump, Math.sin(Math.PI * (1 - this.hopT / Person.HOP_MS)) * 3);
    } else if (prevHopT > 0) {
      this.kick(0.1); // landing
    }

    if (this.customTexture) {
      this.sprite.texture = this.customTexture;
      if (moving) {
        const sideMovement = Math.abs(dx) >= Math.abs(dy);
        flip = sideMovement ? this.facing : 1;
        bobY = Math.floor(this.walkCycleT / 130) % 2 === 0 ? 0 : -1;
      } else if (cheering) {
        if (!jump) bobY = Math.floor(this.cheerT / 150) % 2 === 0 ? -1 : 0;
      } else if (this.activity === "working") {
        bobY = Math.floor(this.animT / 260) % 2 === 0 ? 0 : -1;
      }
    }

    let sx = 1;
    let sy = 1;
    let bodyAlpha = 1;
    if (!REDUCE_MOTION) {
      const s = this.squash();
      sx = 1 + s * 0.6;
      sy = 1 - s;
      if (jump > 0) sy *= 1 + jump * 0.015; // stretch in the air
      // Pixel crew already breathe through their two-frame dip; a fractional stretch on top only
      // makes rows shimmer. Uploaded avatars have no such frames, so they keep the soft stretch.
      if (breathe && (this.customTexture || this.gifSprite)) sy *= 1 + Math.sin((this.animT / 2600) * Math.PI * 2) * 0.022;
      if (this.turnT > 0) {
        // -1 -> 1 across the turn; never quite 0 so the sprite doesn't vanish.
        const v = 1 - 2 * (this.turnT / Person.TURN_MS);
        sx *= (v < 0 ? -1 : 1) * Math.max(0.18, Math.abs(v));
      }
      if (this.micro === "pet") sy *= 0.94; // crouched
      if (this.shakeT > 0) offX += Math.floor(this.animT / 45) % 2 ? 1 : -1; // annoyed shake
      if (this.dizzyT > 0) offX += Math.round(Math.sin(this.animT / 120) * 1.2); // swaying
    } else {
      jump = 0;
      offX = 0;
    }
    if (this.arriveT > 0) {
      // Built up from the feet inside the light column.
      const p = 1 - this.arriveT / Person.ARRIVE_MS;
      const k = Math.max(0, Math.min(1, (p - 0.22) / 0.36));
      sy *= Math.max(0.04, k);
      bodyAlpha = k;
    }
    if (leaving) {
      // Poof: squeezed down to nothing inside the smoke.
      const p = 1 - Math.max(0, this.farewellT) / (REDUCE_MOTION ? 400 : Person.FAREWELL_MS);
      const k = Math.max(0, Math.min(1, (p - 0.55) / 0.16));
      sx *= 1 - k * 0.5;
      sy *= 1 - k;
      bodyAlpha = 1 - k;
    }

    const visual = this.gifSprite ?? this.sprite;
    const avatarScale = this.customTexture || this.gifSprite ? this.customScale : 1;
    visual.scale.set(flip * avatarScale * sx, avatarScale * sy);
    visual.position.set(offX, bobY - jump);
    visual.tint = this.flashT > 0 ? this.flashColor : 0xffffff;
    visual.alpha = bodyAlpha;
    // The shadow stays on the floor and shrinks while airborne.
    this.shadow.scale.set(1 - jump * 0.07);
    this.shadow.alpha = bodyAlpha;

    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.container.zIndex = this.y;

    if (this.emoteT > 0) {
      this.emoteT -= dtMs;
      if (this.emoteT <= 0) {
        this.emoteKind = null;
        this.emoteG.clear();
      }
    }

    // Culled by the scene (off screen): keep moving and ticking, skip all drawing.
    if (!this.container.visible) return;
    const lift = Math.round(bobY - jump);
    const resultHere = this.resultT > 0 &&
      Math.abs(this.resultX - Math.round(this.x)) < 6 && Math.abs(this.resultY - Math.round(this.y)) < 6;
    const raise = screen || resultHere ? SCREEN_LIFT : 0;
    this.drawStation(wt, screen, view, lift, asleep, reading);
    if (!moving && this.wasMovingProp) this.walkProp = null; // arrived: put it down
    this.wasMovingProp = moving;
    this.drawProps(moving ? this.gaitFor(dx, dy) : "front", lift, moving);
    this.drawDropRing(tMs, reach && this.reaching);
    this.drawThought(tMs, thinking, bulb);
    this.drawMarker(tMs, raise);
    this.drawHalo(lift);
    this.drawEmote(tMs, lift - raise);
    this.drawDizzy(lift);
    // Things worn on the head follow the head: the frame's baked-in dip plus any squash of the body.
    const head = headAnchorY(HEAD_DROP.get(this.sprite.texture) ?? 0, bobY - jump, sy);
    this.drawFocus(head, view, offX);
    this.drawAccessory(view, head, offX, flip);
    if (this.tired && view === "front" && !this.customTexture && !this.gifSprite) {
      // Eye bags, and now and then a sigh.
      this.fxG.rect(offX - 2, -11 + head, 1, 0.6).fill({ color: 0x8a6f8a, alpha: 0.7 });
      this.fxG.rect(offX + 1, -11 + head, 1, 0.6).fill({ color: 0x8a6f8a, alpha: 0.7 });
      const sigh = (this.animT + this.seed * 5_000) % 6_000;
      if (sigh < 700 && !REDUCE_MOTION) this.fxG.circle(offX + 4 + sigh / 200, -10 + head - sigh / 300, 1 + sigh / 700).fill({ color: 0xc4ccdc, alpha: 0.5 * (1 - sigh / 700) });
    }
    if (this.errT > 0 && this.errKind === "glare" && screen && !REDUCE_MOTION) {
      // Stare lines from the head to the screen.
      for (let k = 0; k < 2; k++) this.fxG.rect(offX - 2 + k * 3, -19 - (Math.floor(this.animT / 150) % 2), 1, 2).fill({ color: 0xff5d73, alpha: 0.9 });
    }
    this.stationG.x = this.errT > 0 && this.errKind === "kick" && !REDUCE_MOTION ? Math.round(Math.sin(this.errT / 25)) : 0;
    this.drawCombo(lift);
    const lowEyes = this.sprite.texture === f.phone || this.sprite.texture === f.pet || this.sprite.texture === f.readFrames[0] || this.sprite.texture === f.readFrames[1];
    const faceVisible = this.sprite.texture !== f.rubFrames[0] && this.sprite.texture !== f.rubFrames[1];
    if (faceVisible) this.drawShades(view, lowEyes ? -11 : -12, head, offX);
    this.drawFireworks();
    if (moving && this.rushT > 0 && !REDUCE_MOTION && Math.floor(this.walkCycleT / 90) % 2 === 0) {
      // Little dust puffs kicked up behind the feet.
      this.fxG.rect(-this.facing * 4, -1, 1, 1).fill({ color: 0xb8c2d6, alpha: 0.8 });
      this.fxG.rect(-this.facing * 6, -2, 1, 1).fill({ color: 0xb8c2d6, alpha: 0.5 });
    }
    this.drawSay(lift - raise);
  }

  /** Stars circling the head after one poke too many. */
  private drawDizzy(lift: number): void {
    if (this.dizzyT <= 0) return;
    const g = this.fxG;
    const fade = Math.min(1, this.dizzyT / 300);
    const spin = REDUCE_MOTION ? 0 : this.animT / 180;
    for (let k = 0; k < 3; k++) {
      const a = spin + (k / 3) * Math.PI * 2;
      const x = Math.round(Math.cos(a) * 6);
      const y = Math.round(-18 + Math.sin(a) * 2) + lift;
      const c = { color: 0xffd166, alpha: fade * (Math.sin(a) > 0 ? 1 : 0.6) };
      g.rect(x, y - 1, 1, 3).fill(c);
      g.rect(x - 1, y, 3, 1).fill(c);
    }
  }

  /** Speech bubble with the current line; pops in, fades out. */
  private drawSay(lift: number): void {
    const g = this.sayG;
    g.clear();
    const text = this.sayText;
    if (!text) return;
    text.visible = this.sayT > 0;
    if (this.sayT <= 0) return;
    const age = this.sayMs - this.sayT;
    const pop = REDUCE_MOTION ? 0 : Math.max(0, 1 - age / 140) * 2;
    const alpha = this.sayT < 200 ? this.sayT / 200 : 1;
    // Sits above any emote so both can show.
    const top = -27 + lift - (this.emoteKind ? 10 : 0) - Math.round(pop);
    const w = Math.ceil(text.width) + 5;
    g.roundRect(-w / 2, top, w, 9, 2.5).fill({ color: 0x0d1a30, alpha: 0.94 * alpha }).stroke({ color: 0x9eeaff, width: 0.6, alpha: 0.85 * alpha });
    g.rect(-1, top + 9, 2, 1.2).fill({ color: 0x0d1a30, alpha: 0.94 * alpha });
    text.position.set(0, top + 0.6);
    text.alpha = alpha;
  }

  private kick(amount: number): void {
    this.squashAmt = amount;
    this.squashT = 0;
  }

  /** Damped spring: squash, small overshoot into a stretch, then settle. */
  private squash(): number {
    if (this.squashAmt === 0) return 0;
    const t = this.squashT;
    if (t > 420) {
      this.squashAmt = 0;
      return 0;
    }
    return this.squashAmt * Math.exp(-t / 110) * Math.cos(t / 48);
  }

  /** ms into the lightbulb moment of a thinking cycle, or -1 while still mulling it over. */
  private bulbAge(): number {
    const cycle = 5_200 + this.seed * 1_800;
    const phase = (this.animT + this.seed * 7_000) % cycle;
    return phase > cycle - 1_500 ? phase - (cycle - 1_500) : -1;
  }

  /** Station-specific desk body language (back view). `t` is the per-NPC work clock. */
  private workPose(t: number): { tex: Texture; bobY: number; offX: number } {
    const f = this.f;
    switch (this.station) {
      case "terminal": { // rapid-fire two-handed typing, a hard "Enter" at the end of each line
        const enter = t % 1_680 > 1_520;
        return { tex: enter ? f.backArmsIn : f.typeFrames[Math.floor(t / 90) % 2], bobY: enter ? 1 : 0, offX: 0 };
      }
      case "code": { // steady typing; every few seconds leans in to read it back
        const lean = t % 4_400 < 1_200;
        return {
          tex: lean ? f.workFrames[0] : f.typeFrames[Math.floor(t / 150) % 2],
          bobY: lean ? 1 : 0,
          offX: lean ? Math.round(Math.sin(t / 260) * 0.8) : 0,
        };
      }
      case "web": { // one hand on the mouse: scroll, click; the head follows the page
        const click = t % 1_100 < 130;
        return { tex: click ? f.typeFrames[1] : f.workFrames[0], bobY: 0, offX: Math.round(Math.sin(t / 700)) };
      }
      case "check": { // one nod + tap per ticked row, then the stamp slams down
        const c = t % CHECK_CYCLE;
        const row = c - CHECK_FIRST;
        const nod = row >= 0 && row < CHECK_GAP * 4 && row % CHECK_GAP < 150;
        const stamp = c >= CHECK_STAMP && c < CHECK_STAMP + 220;
        return { tex: stamp ? f.backArmsIn : nod ? f.typeFrames[1] : f.workFrames[0], bobY: nod || stamp ? 1 : 0, offX: 0 };
      }
      case "board": { // reach up and slide a card across the board
        const c = t % 3_000;
        const sliding = c > 800 && c < 2_200;
        return { tex: sliding ? f.backSip : f.workFrames[0], bobY: 0, offX: sliding ? Math.round(((c - 800) / 1_400) * 3 - 1) : 0 };
      }
      default:
        return { tex: f.typeFrames[Math.floor(t / 210) % 2], bobY: 0, offX: 0 };
    }
  }

  /** Pose for the running micro-action. */
  private microPose(): { tex: Texture; bobY: number; offX: number; flip: number; view: View } {
    const f = this.f;
    const kind = this.micro!;
    const p = 1 - this.microT / MICRO_MS[kind];
    const atDesk = this.facesScreen();
    switch (kind) {
      case "stretch": {
        const up = p > 0.15 && p < 0.85;
        return { tex: up ? f.backStretch : f.workFrames[0], bobY: up ? -1 : 0, offX: 0, flip: 1, view: "back" };
      }
      case "sip":
        return { tex: p > 0.12 && p < 0.88 ? f.backSip : f.workFrames[0], bobY: 0, offX: 0, flip: 1, view: "back" };
      case "knuckles":
        return { tex: Math.floor(this.microT / 110) % 2 ? f.backArmsIn : f.typeFrames[0], bobY: 0, offX: 0, flip: 1, view: "back" };
      case "swivel": {
        // A full lap on the office chair: back → side → facing us → other side → back.
        const step = Math.floor(p * 5);
        if (step === 1) return { tex: f.sidePass, bobY: 0, offX: 0, flip: -1, view: "side" };
        if (step === 2) return { tex: f.idleFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
        if (step === 3) return { tex: f.sidePass, bobY: 0, offX: 0, flip: 1, view: "side" };
        return { tex: f.workFrames[0], bobY: 0, offX: 0, flip: 1, view: "back" };
      }
      case "rubEyes": {
        // At a monitor they swivel round to face us for the rub, then back.
        if (atDesk && (p < 0.14 || p > 0.86)) return { tex: f.sidePass, bobY: 0, offX: 0, flip: p < 0.5 ? -1 : 1, view: "side" };
        return { tex: f.rubFrames[Math.floor(this.microT / 180) % 2], bobY: 0, offX: 0, flip: 1, view: "front" };
      }
      case "phone":
        return { tex: f.phone, bobY: 0, offX: 0, flip: 1, view: "front" };
      case "spin": {
        const step = Math.floor(p * 4);
        const frames: Array<[Texture, number, View]> = [
          [f.sidePass, -1, "side"], [f.workFrames[0], 1, "back"], [f.sidePass, 1, "side"], [f.idleFrames[0], 1, "front"],
        ];
        const [tex, flip, view] = frames[Math.min(3, step)];
        return { tex, bobY: step < 3 ? -1 : 0, offX: 0, flip, view };
      }
      case "idleStretch": {
        const up = p > 0.12 && p < 0.88;
        return { tex: up ? f.frontStretch : f.idleBlink[0], bobY: up ? -1 : 0, offX: 0, flip: 1, view: "front" };
      }
      case "doze":
        // Head drooping lower and lower, then a little jerk back up.
        return { tex: f.idleBlink[0], bobY: Math.floor(this.microT / 900) % 3 === 0 ? 0 : 1, offX: 0, flip: 1, view: "front" };
      case "read":
        return { tex: f.readFrames[Math.floor(this.microT / 650) % 2], bobY: 0, offX: 0, flip: 1, view: "front" };
      case "dust":
        // Tidy: wiping the desk edge with a cloth, back and forth.
        return { tex: f.reachOut, bobY: 0, offX: Math.round(Math.sin(this.microT / 140)), flip: Math.floor(this.microT / 1_300) % 2 ? 1 : -1, view: "front" };
      case "bounce":
        // Energetic: bouncing on the spot.
        return { tex: f.idleFrames[0], bobY: -Math.round(Math.abs(Math.sin(this.microT / 130)) * 2), offX: 0, flip: 1, view: "front" };
      case "game":
        return { tex: f.phone, bobY: Math.floor(this.microT / 500) % 4 === 0 ? 1 : 0, offX: 0, flip: 1, view: "front" };
      case "sneeze": {
        // Quiet and in place: head tips back a pixel, a small dip, a hand to the nose.
        // No speech, no hop, nothing thrown across the room.
        const back = atDesk && this.activity === "working";
        if (p < 0.4) return { tex: back ? f.workFrames[0] : f.idleFrames[0], bobY: p > 0.15 ? -1 : 0, offX: 0, flip: 1, view: back ? "back" : "front" };
        if (p < 0.58) {
          if (this.sneezeBeat === 0) { this.sneezeBeat = 1; this.kick(0.05); }
          return { tex: back ? f.workFrames[0] : f.idleBlink[0], bobY: 1, offX: 0, flip: 1, view: back ? "back" : "front" };
        }
        if (back) return { tex: f.workFrames[0], bobY: 0, offX: 0, flip: 1, view: "back" };
        return { tex: p < 0.85 ? f.rubFrames[0] : f.idleFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
      }
      case "nod": {
        // Two small nods: agreeing with what is on the screen / the page.
        const dip = (p > 0.2 && p < 0.34) || (p > 0.5 && p < 0.64);
        if (this.station === "books" && this.activity === "working") {
          return { tex: f.readFrames[0], bobY: dip ? 1 : 0, offX: 0, flip: 1, view: "front" };
        }
        if (atDesk) return { tex: f.workFrames[0], bobY: dip ? 1 : 0, offX: 0, flip: 1, view: "back" };
        return { tex: f.idleFrames[0], bobY: dip ? 1 : 0, offX: 0, flip: 1, view: "front" };
      }
      case "neckRoll": {
        // Easing a stiff neck: a pixel to one side, then the other, then settle.
        const lean = p < 0.12 || p > 0.82 ? 0 : p < 0.47 ? -this.microDir : this.microDir;
        return { tex: atDesk ? f.workFrames[0] : f.idleFrames[0], bobY: lean !== 0 ? 1 : 0, offX: lean, flip: 1, view: atDesk ? "back" : "front" };
      }
      case "lookAway":
        // Turns aside and gazes off for a moment (out of the window, into space).
        if (p < 0.1 || p > 0.9) return { tex: f.idleFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
        return { tex: f.sidePass, bobY: 0, offX: 0, flip: this.microDir, view: "side" };
      case "ponder":
        // Hand to the chin, mulling something over — no thought bubble.
        if (p < 0.1 || p > 0.9) return { tex: f.idleFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
        return { tex: f.thinkFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
      case "glasses":
        // A quick push of the glasses up the nose (glint drawn in drawMicroProps).
        return { tex: p > 0.25 && p < 0.6 ? f.rubFrames[0] : f.idleFrames[0], bobY: 0, offX: 0, flip: 1, view: "front" };
      case "water":
        return { tex: f.reachOut, bobY: 0, offX: 0, flip: this.microDir, view: "front" };
      case "pet":
        return { tex: f.pet, bobY: 1, offX: 0, flip: this.microDir, view: "front" };
    }
  }

  private stepConfetti(dtMs: number): void {
    for (const c of this.confetti) {
      if (c.life <= 0) continue;
      c.life -= dtMs;
      c.vy += 0.00016 * dtMs;
      c.vx *= 0.995;
      c.x += c.vx * dtMs;
      c.y += c.vy * dtMs;
    }
  }

  /**
   * Everything around the worker that says what they're doing: the desk with
   * its animated monitor (behind the body), the light it throws on them and
   * the office chair (in front, when seen from behind), the book in their
   * hands, small props for micro-actions, result screens, the beam-in column.
   */
  private drawStation(wt: number, screen: boolean, view: View, lift: number, asleep: boolean, reading: boolean): void {
    const g = this.stationG;
    const fx = this.fxG;
    g.clear();
    fx.clear();
    this.drawArrival(g, fx);
    if (screen) {
      const tint = SCREEN_TINT[this.station] ?? 0x4de3ff;
      const flicker = REDUCE_MOTION || asleep ? 1 : 0.8 + 0.2 * hash01(Math.floor(wt / 110));
      if (!asleep) {
        // Glow spilling round the bezel.
        g.roundRect(-13, -37, 26, 21, 5).fill({ color: tint, alpha: 0.06 * flicker });
        g.roundRect(-11, -35, 22, 17, 4).fill({ color: tint, alpha: 0.08 * flicker });
      }
      // Desk slab and keyboard, monitor on its stand.
      g.rect(-10, -18, 20, 2).fill(0x3a4766);
      g.rect(-10, -18, 20, 1).fill(0x4d5d85);
      g.rect(-4, -18, 8, 1).fill(0x8fa3c8);
      g.rect(-1, -21, 2, 3).fill(0x2a3550);
      g.rect(SCR_L - 1, SCR_T - 1, SCR_W + 2, SCR_H + 2).fill(0x24304d);
      if (asleep) this.drawStandby(g, wt);
      else if (this.bootT > 0) this.drawBoot(g);
      else this.drawScreen(g, wt);
      // Key flashes on the keyboard while typing.
      if (!asleep && !REDUCE_MOTION && !this.micro && (this.station === "terminal" || this.station === "code" || this.station === "desk")) {
        const k = Math.floor(wt / (this.station === "terminal" ? 90 : 150));
        g.rect(-4 + Math.floor(hash01(k) * 8), -18, 1, 1).fill({ color: 0xffffff, alpha: 0.9 });
      }
      if (!asleep && view === "back") {
        // Seen from behind, the screen lights the top of the head and the shoulders.
        fx.poly([SCR_L, SCR_T + SCR_H, SCR_L + SCR_W, SCR_T + SCR_H, 8, -8 + lift, -8, -8 + lift])
          .fill({ color: tint, alpha: 0.08 * flicker });
        fx.rect(-2, -16 + lift, 4, 1).fill({ color: tint, alpha: 0.5 * flicker });
        fx.rect(-3, -15 + lift, 1, 1).fill({ color: tint, alpha: 0.35 * flicker });
        fx.rect(2, -15 + lift, 1, 1).fill({ color: tint, alpha: 0.35 * flicker });
      }
      this.drawChair(view === "back" ? fx : g, view);
    }
    if (reading || (this.activity === "working" && this.station === "books" && this.micro)) this.drawBooks(g, fx, wt, lift, reading);
    this.drawMicroProps(fx, lift, asleep);
    this.drawResult(g, fx);
  }

  /** Office chair: the backrest hides the legs from behind (reads as "sitting"); facing us it peeks out at the sides. */
  private drawChair(g: Graphics, view: View): void {
    const swing = this.micro === "swivel" ? Math.round(Math.sin((1 - this.microT / MICRO_MS.swivel) * Math.PI * 2)) : 0;
    if (view === "back") {
      g.rect(-4 + swing, -7, 8, 5).fill(0x2a3550);
      g.rect(-4 + swing, -7, 8, 1).fill(0x3d4d75);
      g.rect(-4 + swing, -7, 1, 5).fill(0x334166);
    } else {
      g.rect(-5, -9, 10, 7).fill(0x2a3550);
      g.rect(-5, -9, 10, 1).fill(0x3d4d75);
    }
    g.rect(-0.5, -2, 1, 1).fill(0x1a2238);
    g.rect(-4, -1, 8, 1).fill(0x1a2238);
    g.rect(-4, 0, 1, 1).fill(0x0f1526);
    g.rect(3, 0, 1, 1).fill(0x0f1526);
  }

  /** Monitor content per station — readable as "what they're doing" even as a thumbnail. */
  private drawScreen(g: Graphics, wt: number): void {
    const L = SCR_L;
    const T = SCR_T;
    switch (this.station) {
      case "terminal": {
        // Green lines scrolling up a black console, the bottom one being typed, blinking cursor.
        g.rect(L, T, SCR_W, SCR_H).fill(0x03110a);
        const step = 420;
        const line = Math.floor(wt / step);
        for (let i = 0; i < 4; i++) {
          const n = line - 3 + i;
          const len = 3 + Math.floor(hash01(n * 7.13) * 9);
          const shown = i === 3 ? Math.floor(((wt % step) / step) * len) : len;
          const y = T + 1 + i * 2;
          g.rect(L + 1, y, 1, 1).fill({ color: 0xffd166, alpha: 0.85 });
          if (shown > 0) g.rect(L + 3, y, Math.min(shown, SCR_W - 4), 1).fill({ color: 0x5dff9c, alpha: 0.45 + i * 0.17 });
          if (i === 3 && Math.floor(wt / 260) % 2 === 0) g.rect(L + 3 + Math.min(shown, SCR_W - 5), y - 0.5, 1, 1.5).fill(0xc8ffd9);
        }
        break;
      }
      case "code": {
        // Syntax-coloured lines growing token by token; the file scrolls as it fills.
        g.rect(L, T, SCR_W, SCR_H).fill(0x0b1430);
        g.rect(L, T, 2, SCR_H).fill(0x15214a);
        const step = 1_500;
        const line = Math.floor(wt / step);
        const prog = (wt % step) / step;
        for (let i = 0; i < 4; i++) {
          const n = line - 3 + i;
          const y = T + 1 + i * 2;
          g.rect(L + 0.5, y, 1, 1).fill({ color: 0x4a5a8a, alpha: 0.9 });
          let x = L + 3 + Math.floor(hash01(n * 3.3) * 3);
          const tokens = 2 + Math.floor(hash01(n * 5.7) * 2);
          let budget = i === 3 ? Math.ceil(prog * 9) : 99;
          for (let k = 0; k < tokens && budget > 0 && x < L + SCR_W - 1; k++) {
            const len = Math.min(1 + Math.floor(hash01(n * 11 + k) * 4), budget, L + SCR_W - 1 - x);
            g.rect(x, y, len, 1).fill(SYNTAX[Math.floor(hash01(n * 13 + k * 3) * SYNTAX.length)]);
            budget -= len;
            x += len + 1;
          }
          if (i === 3 && Math.floor(wt / 300) % 2 === 0) g.rect(Math.min(x, L + SCR_W - 1), y - 0.5, 0.8, 1.5).fill(0xffffff);
        }
        break;
      }
      case "web": {
        // Browser: chrome + URL bar; loading bar and spinning globe, then the page scrolls by.
        const cycle = 4_200;
        const c = wt % cycle;
        const page = Math.floor(wt / cycle);
        g.rect(L, T, SCR_W, SCR_H).fill(0xe9eef8);
        g.rect(L, T, SCR_W, 2).fill(0x3b4a6b);
        g.rect(L + 0.5, T + 0.5, 1, 1).fill(0xff5d73);
        g.rect(L + 2, T + 0.5, 1, 1).fill(0xffd166);
        g.rect(L + 3.5, T + 0.5, 1, 1).fill(0x37d6a3);
        g.rect(L + 6, T + 0.5, SCR_W - 7, 1).fill(0x6f7fa3);
        if (c < 1_300) {
          g.rect(L, T + 2, SCR_W * (c / 1_300), 0.8).fill(0x4de3ff);
          const cx = 0;
          const cy = T + 6;
          g.circle(cx, cy, 2.5).fill(0x6fb6ff);
          const w = REDUCE_MOTION ? 1.2 : Math.abs(Math.cos(c / 160)) * 2.5;
          g.ellipse(cx, cy, Math.max(0.3, w), 2.5).stroke({ color: 0xe9eef8, width: 0.6 });
          g.rect(cx - 2.5, cy - 0.3, 5, 0.6).fill(0xe9eef8);
        } else {
          const hero = CONFETTI_COLORS[Math.floor(hash01(page * 1.7) * CONFETTI_COLORS.length)];
          const scroll = REDUCE_MOTION ? 0 : Math.floor((c - 1_300) / 600);
          const rows: Array<[number, number, number]> = [ // [x, width, colour]
            [L + 1, SCR_W - 2, hero], [L + 1, 4, 0x9fb6cf], [L + 6, 6, 0x9aa6bd], [L + 1, 9, 0x9aa6bd],
            [L + 1, 4, hero], [L + 6, 5, 0x9aa6bd], [L + 1, 10, 0x9aa6bd], [L + 1, 7, 0x9aa6bd],
          ];
          for (let i = 0; i < rows.length; i++) {
            const y = T + 3 + i * 1.5 - scroll * 1.5;
            if (y < T + 2.5 || y > T + SCR_H - 1) continue;
            const [x, w, color] = rows[i];
            g.rect(x, y, w, i === 0 ? 1.5 : 1).fill(color);
          }
          // The mouse pointer wandering over links.
          const mx = L + 3 + Math.round(((Math.sin(wt / 500) + 1) / 2) * 8);
          g.rect(mx, T + 5 + (page % 3), 1, 1.5).fill(0x1d2740);
        }
        break;
      }
      case "check": {
        // Checklist: ticks appear one by one, then an "approved" stamp slams down.
        const c = wt % CHECK_CYCLE;
        g.rect(L, T, SCR_W, SCR_H).fill(0x0d1f1a);
        for (let i = 0; i < 4; i++) {
          const y = T + 1 + i * 2;
          const tickAt = CHECK_FIRST + i * CHECK_GAP;
          const ticked = c >= tickAt;
          if (ticked && c - tickAt < 200) g.rect(L, y - 0.5, SCR_W, 2).fill({ color: 0x37d6a3, alpha: 0.25 });
          g.rect(L + 1, y, 1.5, 1).fill(ticked ? 0x5dffb8 : 0x2f5a4c);
          if (ticked) g.rect(L + 2, y - 0.6, 0.8, 0.8).fill(0x5dffb8);
          g.rect(L + 4, y, 5 + (i % 2) * 3, 1).fill({ color: 0x7fa89a, alpha: ticked ? 0.9 : 0.5 });
        }
        if (c >= CHECK_STAMP && c < CHECK_CYCLE - 150) {
          const k = REDUCE_MOTION ? 1 : Math.min(1, (c - CHECK_STAMP) / 110);
          const s = 1.7 - 0.7 * k;
          const w = 9 * s;
          const h = 5 * s;
          const cx = 2;
          const cy = T + 4.5;
          g.rect(cx - w / 2, cy - h / 2, w, h).fill({ color: 0x37d6a3, alpha: 0.25 + 0.25 * k })
            .stroke({ color: 0x8dffd0, width: 0.8, alpha: k });
          // A bold tick inside the stamp.
          g.rect(cx - 2 * s, cy, s, s).fill({ color: 0xeafff5, alpha: k });
          g.rect(cx - 1 * s, cy + 0.8 * s, s, s).fill({ color: 0xeafff5, alpha: k });
          g.rect(cx, cy - 0.2 * s, s, s).fill({ color: 0xeafff5, alpha: k });
          g.rect(cx + 1 * s, cy - 1.2 * s, s, s).fill({ color: 0xeafff5, alpha: k });
          if (k >= 1 && c - CHECK_STAMP < 220) g.rect(L, T, SCR_W, SCR_H).fill({ color: 0xffffff, alpha: 0.18 });
        }
        break;
      }
      case "board": {
        // Kanban: To do / Doing / Done columns, a card sliding across.
        g.rect(L, T, SCR_W, SCR_H).fill(0x101a33);
        const heads = [0xff5d73, 0xffd166, 0x37d6a3];
        for (let col = 0; col < 3; col++) {
          const x = L + 0.5 + col * 4.6;
          g.rect(x, T + 0.5, 4, 1).fill(heads[col]);
          if (col > 0) g.rect(x - 0.6, T + 1, 0.4, SCR_H - 1.5).fill(0x22305a);
        }
        const c = wt % 3_000;
        const done = 1 + (Math.floor(wt / 3_000) % 2);
        for (let i = 0; i < 2; i++) g.rect(L + 1, T + 2.5 + i * 2, 3, 1.4).fill(0xdfe9f8);
        g.rect(L + 5.6, T + 2.5, 3, 1.4).fill(0xdfe9f8);
        for (let i = 0; i < done; i++) g.rect(L + 10.2, T + 4.5 + i * 2, 3, 1.4).fill(0xb8f5dc);
        const p = Math.max(0, Math.min(1, (c - 800) / 1_400));
        g.rect(L + 1 + p * 9.2, T + 2.5 + p * 0 + (p > 0 && p < 1 ? -0.5 : 0), 3, 1.4).fill(c > 800 && c < 2_200 ? 0xffe9a8 : 0xdfe9f8);
        break;
      }
      default: {
        // Generic tools: a gear spinning beside a progress bar and a log.
        g.rect(L, T, SCR_W, SCR_H).fill(0x161d2e);
        const cx = L + 3.5;
        const cy = T + 4.5;
        const a0 = REDUCE_MOTION ? 0 : wt / 260;
        for (let k = 0; k < 8; k++) {
          const a = a0 + (k * Math.PI) / 4;
          g.rect(cx + Math.cos(a) * 2.4 - 0.5, cy + Math.sin(a) * 2.4 - 0.5, 1, 1).fill(0xf29e4c);
        }
        g.circle(cx, cy, 1.8).fill(0xf29e4c);
        g.circle(cx, cy, 0.7).fill(0x161d2e);
        const prog = (wt % 2_400) / 2_400;
        g.rect(L + 7, T + 2, 6, 1).fill(0x2a3550);
        g.rect(L + 7, T + 2, 6 * prog, 1).fill(0xffd166);
        for (let i = 0; i < 3; i++) g.rect(L + 7, T + 4.5 + i * 1.5, 2 + Math.floor(hash01(Math.floor(wt / 600) + i) * 4), 0.8).fill(0x8fa3c8);
      }
    }
    // Faint scanline sheen over every screen.
    g.rect(L, T + ((Math.floor(wt / 90) % SCR_H)), SCR_W, 0.5).fill({ color: 0xffffff, alpha: REDUCE_MOTION ? 0 : 0.06 });
  }

  /** Power back: black screen, a small logo and a boot bar, then the work comes back. */
  private drawBoot(g: Graphics): void {
    const s = 950 - this.bootT;
    g.rect(SCR_L, SCR_T, SCR_W, SCR_H).fill(0x05070d);
    if (s < 300) return;
    const blink = REDUCE_MOTION || Math.floor(s / 160) % 2 === 0;
    g.rect(-1, SCR_T + 2.5, 2, 2).fill({ color: 0x4de3ff, alpha: blink ? 0.95 : 0.6 });
    g.rect(-0.5, SCR_T + 2, 1, 1).fill({ color: 0xffffff, alpha: 0.7 });
    const p = Math.min(1, (s - 300) / 500);
    g.rect(SCR_L + 3, SCR_T + 6.5, SCR_W - 6, 1).fill(0x1a2a44);
    g.rect(SCR_L + 3, SCR_T + 6.5, (SCR_W - 6) * p, 1).fill(0x4de3ff);
  }

  /** Power cut: black screen with a slowly blinking amber standby light. */
  private drawStandby(g: Graphics, wt: number): void {
    g.rect(SCR_L, SCR_T, SCR_W, SCR_H).fill(0x05070d);
    const on = REDUCE_MOTION || Math.floor(wt / 900) % 2 === 0;
    g.rect(SCR_L + SCR_W - 2, SCR_T + SCR_H - 2, 1, 1).fill({ color: 0xffb547, alpha: on ? 0.95 : 0.25 });
  }

  /** Just the open book held at the chest (idle reading). */
  private drawBookInHands(fx: Graphics, lift: number): void {
    const top = -10 + lift;
    fx.rect(-5, top, 10, 5).fill(CONFETTI_COLORS[Math.floor(this.seed * CONFETTI_COLORS.length)]);
    fx.rect(-4, top, 4, 4).fill(0xf3f0e6);
    fx.rect(0, top, 4, 4).fill(0xe2dcc8);
    fx.rect(-0.5, top, 1, 4.5).fill(0x8a5f33);
    fx.rect(-3.5, top + 1, 2.5, 0.6).fill(0xa9a294);
    fx.rect(1, top + 2.5, 2.5, 0.6).fill(0xa9a294);
  }

  /** Reading: an open book in both hands (pages turn, a magnifier sweeps by), a stack at their feet. */
  private drawBooks(g: Graphics, fx: Graphics, wt: number, lift: number, inHands: boolean): void {
    g.rect(6, -2, 6, 2).fill(0x6f52c9);
    g.rect(7, -4, 5, 2).fill(0xf29e4c);
    g.rect(6, -6, 6, 2).fill(0x27967a);
    g.rect(6, -6, 6, 0.6).fill(0x37d6a3);
    if (!inHands) return;
    const top = -10 + lift;
    fx.rect(-5, top, 10, 5).fill(CONFETTI_COLORS[Math.floor(this.seed * CONFETTI_COLORS.length)]);
    fx.rect(-4, top, 4, 4).fill(0xf3f0e6);
    fx.rect(0, top, 4, 4).fill(0xe2dcc8);
    fx.rect(-0.5, top, 1, 4.5).fill(0x8a5f33);
    for (let i = 0; i < 2; i++) {
      fx.rect(-3.5, top + 1 + i * 1.5, 2.5, 0.6).fill(0xa9a294);
      fx.rect(1, top + 1 + i * 1.5, 2.5, 0.6).fill(0xa9a294);
    }
    // Thumbs on the covers.
    fx.rect(-5.5, top + 2, 1, 1.5).fill(0xf2c9a0);
    fx.rect(4.5, top + 2, 1, 1.5).fill(0xf2c9a0);
    const c = wt % 2_600;
    if (c > 2_200 && !REDUCE_MOTION) {
      // Page flip: the right page swings over the spine to the left.
      const p = (c - 2_200) / 400;
      const w = Math.cos(p * Math.PI) * 4;
      const rise = Math.sin(p * Math.PI) * 1.5;
      fx.rect(w >= 0 ? 0 : w, top - rise, Math.max(0.4, Math.abs(w)), 4).fill(0xffffff);
      fx.rect(2, top - 1 - (c - 2_200) / 90, 1, 1).fill({ color: 0xfff3c4, alpha: 1 - p });
    } else if (Math.floor(wt / 2_600) % 3 === 1 && c > 300 && c < 2_100) {
      // Every third page, a magnifying glass sweeps along the lines.
      const q = (c - 300) / 1_800;
      const mx = -3 + q * 6;
      const my = top + 1.5 + Math.sin(q * Math.PI * 3) * 0.6;
      fx.circle(mx, my, 1.8).fill({ color: 0xdff6ff, alpha: 0.35 }).stroke({ color: 0xcfe3f7, width: 0.6 });
      fx.rect(mx + 1.2, my + 1.2, 1, 1).fill(0x8a5f33);
      fx.rect(mx + 2, my + 2, 1, 1).fill(0x8a5f33);
    }
  }

  /** Little props that make the micro-actions readable (mug, phone, watering can, "z z"). */
  private drawMicroProps(fx: Graphics, lift: number, asleep: boolean): void {
    const kind = this.micro;
    if ((asleep || kind === "doze") && this.snoreVisible) this.drawSnore(fx, lift);
    if (!kind) return;
    const p = 1 - this.microT / MICRO_MS[kind];
    if (kind === "sip" && this.spill && p > 0.45) {
      // Fumble: the mug tips over, coffee spreads across the desk, a startled hop.
      if (this.sneezeBeat === 0) { this.sneezeBeat = 1; this.hop(); this.say("啊！", 900); }
      const q = Math.min(1, (p - 0.45) / 0.3);
      fx.rect(3, -19, 3, 2).fill(0xb56f2f);
      fx.rect(2 - q * 4, -18, 3 + q * 7, 1).fill({ color: 0x6e4218, alpha: 0.9 });
      if (q < 1) fx.rect(6 + q * 2, -17 + q * 4, 1, 1).fill(0x6e4218);
    } else if (kind === "sip" && p > 0.12 && p < 0.88) {
      fx.rect(4, -13 + lift, 3, 3).fill(0xb56f2f);
      fx.rect(4, -13 + lift, 3, 0.8).fill(0x6e4218);
      fx.rect(7, -12 + lift, 1, 1.4).fill(0xb56f2f);
      if (!REDUCE_MOTION) {
        const s = Math.floor(this.microT / 220) % 3;
        fx.rect(5, -15 - s + lift, 1, 1).fill({ color: 0xcfe3f7, alpha: 0.75 });
        fx.rect(6, -16 - ((s + 1) % 3) + lift, 1, 1).fill({ color: 0xcfe3f7, alpha: 0.55 });
      }
    } else if (kind === "knuckles" && Math.floor(this.microT / 220) % 2 === 0) {
      // "crack!" — little white ticks flying off the hands.
      for (const side of [-1, 1]) {
        fx.rect(side * 6 - 0.5, -10 + lift, 1, 1).fill(0xffffff);
        fx.rect(side * 7 - 0.5, -11 + lift, 1, 1).fill({ color: 0xffffff, alpha: 0.6 });
      }
    } else if (kind === "phone") {
      const glow = REDUCE_MOTION ? 1 : 0.7 + 0.3 * hash01(Math.floor(this.microT / 300));
      fx.rect(-3, -12 + lift, 6, 3).fill({ color: 0x9ff3ff, alpha: 0.13 * glow }); // screen light on the face
      fx.rect(-2, -9 + lift, 4, 2).fill(0x1a2238);
      fx.rect(-1.5, -8.7 + lift, 3, 1.3).fill({ color: 0x6fe8ff, alpha: glow });
      if (p > 0.45 && p < 0.85 && !REDUCE_MOTION) {
        // Something nice on the feed: a heart floats up.
        const q = (p - 0.45) / 0.4;
        this.drawHeart(fx, 3, -14 - q * 6 + lift, 1 - q);
      }
    } else if (kind === "read" || (kind === "nod" && this.station === "books" && this.activity === "working")) {
      this.drawBookInHands(fx, lift);
    } else if (kind === "sneeze" && p > 0.42 && p < 0.72 && !this.facesScreen()) {
      // One faint pixel of breath drifting off — the only particle.
      const q = (p - 0.42) / 0.3;
      fx.rect(3 + Math.round(q * 2), -13 + lift, 1, 1).fill({ color: 0xdfe8f5, alpha: 0.45 * (1 - q) });
    } else if (kind === "dust") {
      // Cloth in the outstretched hand, a glint where it has wiped.
      const d = Math.floor(this.microT / 1_300) % 2 ? 1 : -1;
      fx.rect(d * 5 + (d > 0 ? 0 : -2), -9 + lift, 2, 2).fill(0xffd166);
      if (Math.floor(this.microT / 260) % 3 === 0) fx.rect(d * 9, -7 + lift, 1, 1).fill(0xffffff);
    } else if (kind === "game") {
      // Handheld console: wider than a phone, green screen, beeps.
      fx.rect(-3, -9 + lift, 6, 2.4).fill(0x6f52c9);
      fx.rect(-1.5, -8.7 + lift, 3, 1.6).fill(0x9dff9c);
      fx.rect(-2.6, -8.4 + lift, 0.8, 0.8).fill(0xffd166);
      fx.rect(1.9, -8.4 + lift, 0.8, 0.8).fill(0xff5d73);
      if (!REDUCE_MOTION && Math.floor(this.microT / 450) % 3 === 0) {
        fx.rect(4, -13 + lift - (this.microT % 450) / 150, 1, 1).fill({ color: 0x9dff9c, alpha: 0.8 });
      }
    } else if (kind === "water") {
      const d = this.microDir;
      const hx = 5 * d;
      // Can hanging from the outstretched hand, spout tipped toward the plant.
      fx.rect(d > 0 ? hx : hx - 4, -9 + lift, 4, 3).fill(0x6fb6ff);
      fx.rect(d > 0 ? hx : hx - 4, -9 + lift, 4, 0.8).fill(0xa8d6ff);
      fx.rect(d > 0 ? hx + 4 : hx - 6, -9 + lift, 2, 1).fill(0x6fb6ff);
      if (!REDUCE_MOTION) {
        for (let i = 0; i < 3; i++) {
          const q = ((this.microT + i * 200) % 600) / 600;
          fx.rect(hx + d * 6 + (i - 1) * 0.6, -8 + q * 8, 0.8, 1.2).fill({ color: 0x9ff3ff, alpha: 1 - q * 0.5 });
        }
      }
    }
  }

  private drawSnore(g: Graphics, lift: number): void {
    const t = this.animT + this.seed * 3_000;
    for (let i = 0; i < 2; i++) {
      const q = REDUCE_MOTION ? 0.4 + i * 0.3 : ((t / 1_600 + i * 0.5) % 1);
      drawZ(g, 4 + q * 4 + i, -18 - q * 9 + lift, i === 0 ? 3 : 4, 1 - q * 0.8);
    }
  }

  private drawHeart(g: Graphics, x: number, y: number, alpha: number): void {
    const c = { color: 0xff5d9e, alpha };
    g.rect(x - 1, y, 1, 1).fill(c);
    g.rect(x + 1, y, 1, 1).fill(c);
    g.rect(x - 1, y + 1, 3, 1).fill(c);
    g.rect(x, y + 2, 1, 1).fill(c);
  }

  /** Result screen, left at the spot where the turn ended: big check + confetti, or red glitch + smoke. */
  private drawResult(g: Graphics, fx: Graphics): void {
    const rx = Math.round(this.x);
    const ry = Math.round(this.y);
    for (const c of this.confetti) {
      if (c.life <= 0) continue;
      const tall = Math.floor(c.life / 90) % 2 === 0;
      fx.rect(Math.round(c.x - rx), Math.round(c.y - ry), c.size, tall ? c.size * 1.5 : c.size * 0.8)
        .fill({ color: c.color, alpha: Math.min(1, c.life / 300) });
    }
    if (this.resultT <= 0 || !this.resultKind) return;
    const p = 1 - this.resultT / Person.RESULT_MS;
    const alpha = p > 0.8 ? (1 - p) / 0.2 : 1;
    const pop = REDUCE_MOTION ? 0 : Math.max(0, 1 - p / 0.07);
    const error = this.resultKind === "error";
    const shake = error && !REDUCE_MOTION && p < 0.3 ? Math.round(Math.sin(p * 120)) : 0;
    const ox = this.resultX - rx + shake;
    const oy = this.resultY - ry;
    const L = ox + SCR_L;
    const T = oy + SCR_T;
    const glow = error ? 0xff5d73 : 0x37d6a3;
    g.roundRect(L - 4, T - 4, SCR_W + 8, SCR_H + 8, 4).fill({ color: glow, alpha: (0.16 + 0.3 * pop) * alpha });
    g.rect(ox - 10, oy - 18, 20, 2).fill({ color: 0x3a4766, alpha });
    g.rect(ox - 1, oy - 21, 2, 3).fill({ color: 0x2a3550, alpha });
    g.rect(L - 1, T - 1, SCR_W + 2, SCR_H + 2).fill({ color: 0x24304d, alpha });
    if (!error) {
      g.rect(L, T, SCR_W, SCR_H).fill({ color: pop > 0 ? 0xdfffee : 0x0f3d2e, alpha });
      // The big tick draws itself in, stroke by stroke.
      const pts: Array<[number, number]> = [[-4, -27], [-3, -26], [-2, -25], [-1, -26], [0, -27], [1, -28], [2, -29], [3, -30]];
      const n = REDUCE_MOTION ? pts.length : Math.ceil(Math.min(1, p / 0.22) * pts.length);
      for (let i = 0; i < n; i++) g.rect(ox + pts[i][0], oy + pts[i][1], 2, 2).fill({ color: 0x7dffc4, alpha });
      // Rays.
      if (!REDUCE_MOTION && p < 0.6) {
        const r = 9 + p * 10;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          g.rect(ox + Math.cos(a) * r, oy - 26.5 + Math.sin(a) * r * 0.7, 1, 1).fill({ color: 0xb6ffe0, alpha: 1 - p / 0.6 });
        }
      }
    } else {
      // Glitching red screen with a big X; smoke curls out of the top.
      const tick = Math.floor(p * Person.RESULT_MS / 70);
      g.rect(L, T, SCR_W, SCR_H).fill({ color: tick % 3 === 0 ? 0x5a1020 : 0x3a0d16, alpha });
      if (!REDUCE_MOTION) {
        for (let k = 0; k < 3; k++) {
          const y = T + Math.floor(hash01(tick * 3 + k) * (SCR_H - 1));
          const shift = Math.round((hash01(tick * 7 + k) - 0.5) * 4);
          g.rect(Math.max(L, L + 2 + shift), y, 8, 1).fill({ color: k === 1 ? 0x4de3ff : 0xff5d73, alpha: 0.75 * alpha });
        }
      }
      for (let i = 0; i < 6; i++) {
        g.rect(ox - 3 + i, oy - 30 + i * 1.4, 1.4, 1.4).fill({ color: 0xffd0d6, alpha });
        g.rect(ox + 2 - i, oy - 30 + i * 1.4, 1.4, 1.4).fill({ color: 0xffd0d6, alpha });
      }
      if (!REDUCE_MOTION) {
        for (let k = 0; k < 3; k++) {
          const age = p * Person.RESULT_MS - k * 380;
          if (age < 0 || age > 1_100) continue;
          const q = age / 1_100;
          fx.circle(ox + 5 + q * 3 + k, T - 1 - q * 9, 1.2 + q * 2.2).fill({ color: 0x6b7488, alpha: 0.7 * (1 - q) * alpha });
        }
      }
    }
  }

  /** Beam-in: a light column drops from the ceiling, rings rise up the body, sparkles orbit. */
  private drawArrival(g: Graphics, fx: Graphics): void {
    if (this.arriveT > 0 && !REDUCE_MOTION) {
      const p = 1 - this.arriveT / Person.ARRIVE_MS;
      const top = -48;
      const drop = Math.min(1, p / 0.2);
      const fade = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
      const w = 6 * fade;
      const h = -top * drop;
      g.ellipse(0, 0, 9, 3).fill({ color: 0x4de3ff, alpha: 0.35 * fade });
      g.rect(-w / 2 - 2, top, w + 4, h).fill({ color: 0x4de3ff, alpha: 0.18 * fade });
      g.rect(-w / 2, top, w, h).fill({ color: 0x9ff3ff, alpha: 0.5 * fade });
      g.rect(-0.5, top, 1, h).fill({ color: 0xffffff, alpha: 0.8 * fade });
      for (let k = 0; k < 3; k++) {
        const q = (p * 2.5 + k / 3) % 1;
        fx.ellipse(0, -q * 18, 6 - q * 1.5, 1.6).stroke({ color: 0xbff6ff, width: 0.6, alpha: 0.8 * fade * (1 - q) });
      }
      for (let k = 0; k < 4; k++) {
        const a = p * 9 + (k * Math.PI) / 2;
        fx.rect(Math.round(Math.cos(a) * 8), Math.round(-8 + Math.sin(a) * 6), 1, 1).fill({ color: 0xffffff, alpha: fade });
      }
    }
    if (this.farewellStarted && !REDUCE_MOTION) {
      const p = 1 - Math.max(0, this.farewellT) / Person.FAREWELL_MS;
      if (p > 0.5) {
        const q = (p - 0.5) / 0.5;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + 0.4;
          const d = 2 + q * 7;
          fx.circle(Math.cos(a) * d, -7 + Math.sin(a) * d * 0.7, Math.max(0.2, (1.6 + q * 2.4) * (1 - q * 0.4)))
            .fill({ color: 0xc4ccdc, alpha: 0.85 * (1 - q) });
        }
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2;
          const d = 4 + q * 11;
          fx.rect(Math.round(Math.cos(a) * d), Math.round(-8 + Math.sin(a) * d * 0.8), 1, 1).fill({ color: 0xffe9a8, alpha: 1 - q });
        }
      }
    }
  }

  /** The deliverable box, hugged at chest height (pushed to the leading side in profile). */
  private drawProps(gait: Gait, lift: number, moving: boolean): void {
    const g = this.propG;
    g.clear();
    if (!this.carrying) {
      if (moving && this.walkProp) this.drawWalkProp(g, gait, lift);
      return;
    }
    const cx = gait === "side" ? this.facing * 2 : 0;
    const top = -10 + lift;
    // Walking away: the box is in front of them, mostly hidden by the back.
    const alpha = gait === "back" ? 0.55 : 1;
    g.rect(cx - 3, top, 6, 5).fill({ color: 0xc8955a, alpha });
    g.rect(cx - 3, top, 6, 1).fill({ color: 0xe6b97c, alpha });
    g.rect(cx - 0.5, top, 1, 5).fill({ color: 0x8a5f33, alpha });
    g.rect(cx - 3, top + 4, 6, 1).fill({ color: 0x9c6c3c, alpha });
  }

  /** Laptop tucked under the arm, or a stack of papers whose top sheet flutters. */
  private drawWalkProp(g: Graphics, gait: Gait, lift: number): void {
    const alpha = gait === "back" ? 0.55 : 1;
    const side = gait === "side";
    const cx = side ? this.facing * 3 : 4;
    const top = -9 + lift;
    if (this.walkProp === "laptop") {
      if (side) {
        g.rect(cx - 3, top + 1, 6, 1.6).fill({ color: 0x9fb6cf, alpha });
        g.rect(cx - 3, top + 2.6, 6, 0.6).fill({ color: 0x4de3ff, alpha: 0.7 * alpha });
      } else {
        g.rect(cx - 0.5, top - 1, 1.6, 6).fill({ color: 0x9fb6cf, alpha });
      }
    } else {
      const flutter = REDUCE_MOTION ? 0 : Math.floor(this.walkCycleT / 120) % 2;
      g.rect(cx - 2, top, 4, 3).fill({ color: 0xe2dcc8, alpha });
      g.rect(cx - 2 + flutter * 0.6, top - 0.8 - flutter * 0.4, 4, 0.8).fill({ color: 0xffffff, alpha });
      g.rect(cx - 1.4, top + 1, 2.6, 0.5).fill({ color: 0xa9a294, alpha });
    }
  }

  /** Hat / band / glasses / scarf / flower — small, follows the head, hidden for custom avatars. */
  private drawAccessory(view: View, lift: number, offX: number, flip: number): void {
    const a = this.accessory;
    if (a === "none" || this.customTexture || this.gifSprite) return;
    const g = this.fxG;
    const c = this.accessoryColor;
    const x = offX;
    const y = lift;
    const hat = !this.deepFocus; // headphones win over hats
    if (a === "cap" && hat) {
      g.rect(x - 3, -17 + y, 6, 2).fill(c);
      if (view === "front") g.rect(x - 4, -15 + y, 8, 1).fill(c);
      else if (view === "side") g.rect(x + flip * 2, -15 + y, flip * 3, 1).fill(c);
    } else if (a === "beanie" && hat) {
      g.rect(x - 3, -17 + y, 6, 2).fill(c);
      g.rect(x - 4, -15 + y, 8, 1).fill({ color: c, alpha: 0.85 });
      g.rect(x - 0.5, -18 + y, 1, 1).fill(0xffffff);
    } else if (a === "headband") {
      g.rect(x - 4, -14 + y, 8, 1).fill(c);
    } else if (a === "bow") {
      g.rect(x + 2, -16 + y, 1, 1).fill(c);
      g.rect(x + 4, -16 + y, 1, 1).fill(c);
      g.rect(x + 3, -16 + y, 1, 1).fill(0xffffff);
    } else if (a === "glasses" && view === "front" && !this.sunglasses) {
      g.rect(x - 3, -12 + y, 2, 1).fill({ color: 0xcfe3f7, alpha: 0.55 });
      g.rect(x + 1, -12 + y, 2, 1).fill({ color: 0xcfe3f7, alpha: 0.55 });
      g.rect(x - 1, -12 + y, 2, 0.5).fill(0x2a3550);
      if (this.micro === "glasses") {
        // Just pushed them up: a one-pixel glint on the lens.
        const p = 1 - this.microT / MICRO_MS.glasses;
        if (p > 0.6 && p < 0.8) g.rect(x + 2, -12 + y, 1, 1).fill({ color: 0xffffff, alpha: 0.85 });
      }
    } else if (a === "scarf") {
      g.rect(x - 3, -10 + y, 6, 1).fill(c);
      if (view !== "back") g.rect(x + 1, -9 + y, 1, 2).fill(c);
    } else if (a === "flower" && view !== "back") {
      g.rect(x - 3, -16 + y, 1, 1).fill(c);
      g.rect(x - 4, -16 + y, 1, 1).fill({ color: c, alpha: 0.6 });
      g.rect(x - 3, -17 + y, 1, 1).fill({ color: c, alpha: 0.6 });
    }
  }

  /** "COMBO xN" in gold, popping in with a bounce. */
  private drawCombo(lift: number): void {
    if (this.comboT <= 0) return;
    const g = this.fxG;
    const age = 1_300 - this.comboT;
    const s = REDUCE_MOTION ? 1 : age < 160 ? 1.4 - (age / 160) * 0.4 : 1;
    const alpha = this.comboT < 250 ? this.comboT / 250 : 1;
    const word = `COMBO X${this.comboN}`;
    const w = word.length * 4 * s;
    const top = -38 + lift - Math.round(Math.min(1, age / 300) * 3);
    g.roundRect(-w / 2 - 2, top - 1.5, w + 3, 5 * s + 3, 2).fill({ color: 0x0d1a30, alpha: 0.85 * alpha });
    drawWord(g, word, -w / 2, top, 0xffd166, s, alpha);
  }

  /** Long focus: headphones, a faint aura, an occasional sweat drop. Kept very small and quiet. */
  private drawFocus(lift: number, view: View, offX: number): void {
    if (!this.deepFocus || this.asleep) return;
    const g = this.fxG;
    const x = offX;
    g.rect(x - 4, -17 + lift, 8, 1).fill(0x2a3550);
    if (view !== "side") {
      g.rect(x - 5, -13 + lift, 2, 3).fill(0xff5d73);
      g.rect(x + 3, -13 + lift, 2, 3).fill(0xff5d73);
    } else {
      g.rect(x - 1, -13 + lift, 2, 3).fill(0xff5d73);
    }
    if (REDUCE_MOTION) return;
    const t = this.animT + this.seed * 4_000;
    // Two violet motes drifting up beside them.
    for (let k = 0; k < 2; k++) {
      const q = ((t / 2_200) + k * 0.5) % 1;
      g.rect(x + (k ? 6 : -7), Math.round(-3 - q * 15) + lift, 1, 1).fill({ color: 0xb59cff, alpha: 0.7 * Math.sin(q * Math.PI) });
    }
    // A sweat drop slides down the temple now and then.
    const s = t % 4_200;
    if (s < 700) g.rect(x + 4, -14 + lift + (s / 700) * 3, 1, 1.6).fill({ color: 0x9ff3ff, alpha: 1 - s / 900 });
  }

  /** Shades over the eyes (front-facing poses only). */
  private drawShades(view: View, faceY: number, lift: number, offX: number): void {
    if (!this.sunglasses || view !== "front" || this.customTexture || this.gifSprite) return;
    const g = this.fxG;
    const y = faceY + lift;
    g.rect(offX - 3, y, 6, 0.8).fill(0x101418);
    g.rect(offX - 3, y, 2.4, 1.6).fill(0x101418);
    g.rect(offX + 0.6, y, 2.4, 1.6).fill(0x101418);
    g.rect(offX - 2.6, y + 0.2, 0.8, 0.5).fill({ color: 0xffffff, alpha: 0.8 });
    g.rect(offX + 1, y + 0.2, 0.8, 0.5).fill({ color: 0xffffff, alpha: 0.8 });
  }

  /** Big celebration: three small fireworks pop over the monitor. */
  private drawFireworks(): void {
    if (this.fireworksT <= 0) return;
    const g = this.fxG;
    const t = 1_700 - this.fireworksT;
    const ox = this.fwX - Math.round(this.x);
    const oy = this.fwY - Math.round(this.y);
    const bursts: Array<[number, number, number, number]> = [[0, -9, -44, 0xffd166], [330, 8, -48, 0xff4dd8], [650, -1, -52, 0x4de3ff]];
    for (const [delay, bx, by, color] of bursts) {
      const s = t - delay;
      if (s < 0 || s > 900) continue;
      if (s < 220) {
        // Rocket trail going up.
        const q = s / 220;
        g.rect(ox + bx, oy + by + 14 * (1 - q), 1, 2).fill({ color: 0xfff3c4, alpha: 0.9 });
        continue;
      }
      const q = (s - 220) / 680;
      const r = 2 + q * 7;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        g.rect(Math.round(ox + bx + Math.cos(a) * r), Math.round(oy + by + Math.sin(a) * r + q * q * 3), 1, 1)
          .fill({ color, alpha: 1 - q });
      }
      g.rect(ox + bx, oy + by, 1, 1).fill({ color: 0xffffff, alpha: 1 - q });
    }
  }

  /** Dashed ring on the floor while a drag hovers this NPC: "drop it on me". */
  private drawDropRing(tMs: number, on: boolean): void {
    const g = this.underG;
    g.clear();
    if (!on) {
      // Hover affordance: a faint ring under the feet says "you can click me".
      if (this.hovered) g.ellipse(0, 0.5, 7, 2.4).stroke({ color: 0xdfe9f8, width: 0.6, alpha: 0.55 });
      return;
    }
    const pulse = REDUCE_MOTION ? 0.7 : 0.55 + 0.35 * Math.sin(tMs / 160);
    g.ellipse(0, 0, 8.5, 2.8).fill({ color: 0x4de3ff, alpha: 0.14 });
    const n = 14;
    const spin = REDUCE_MOTION ? 0 : tMs / 900;
    for (let i = 0; i < n; i += 2) {
      const a = (i / n) * Math.PI * 2 + spin;
      g.rect(Math.round(Math.cos(a) * 8.5) - 0.5, Math.round(Math.sin(a) * 2.8) - 0.5, 1, 1)
        .fill({ color: 0x9ff3ff, alpha: pulse });
    }
  }

  /** Context-reset halo: a ring snaps on over the head and a scan line wipes down the face. */
  private drawHalo(lift: number): void {
    const g = this.haloG;
    g.clear();
    if (this.haloT <= 0) return;
    const p = 1 - this.haloT / Person.HALO_MS; // 0 -> 1
    const fade = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
    const top = -18 + lift;
    if (REDUCE_MOTION) {
      g.ellipse(0, top - 1, 5, 1.4).stroke({ color: 0xbff6ff, width: 0.8, alpha: 0.8 * fade });
      return;
    }
    const grow = Math.min(1, p / 0.18);
    g.ellipse(0, top - 1, 5.5 * grow, 1.6 * grow).stroke({ color: 0xbff6ff, width: 0.9, alpha: 0.95 * fade });
    g.ellipse(0, top - 1, 7 * grow, 2.2 * grow).stroke({ color: 0x4de3ff, width: 0.6, alpha: 0.35 * fade });
    // Scan line sweeping down over the head (0.1 → 0.6 of the effect).
    const s = (p - 0.1) / 0.5;
    if (s > 0 && s < 1) {
      g.rect(-5, top + Math.round(s * 9), 10, 1).fill({ color: 0xdffbff, alpha: 0.75 * (1 - s * 0.5) });
    }
    // Four sparkles flung outward.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const r = 4 + p * 7;
      g.rect(Math.round(Math.cos(a) * r), Math.round(top + 4 + Math.sin(a) * r * 0.7), 1, 1)
        .fill({ color: 0xffffff, alpha: fade * (1 - p) });
    }
  }

  /** Small pixel-art emote hovering above the head. */
  private drawEmote(tMs: number, lift: number): void {
    const g = this.emoteG;
    g.clear();
    if (!this.emoteKind) return;
    const bob = Math.floor((tMs % 800) / 400); // 0 or 1
    const top = -27 - bob + lift;
    if (this.emoteKind === "question") {
      // Yellow "?" built from pixels.
      g.rect(-2, top, 4, 1.4).fill(0xffd166);
      g.rect(1, top + 1.4, 1.4, 1.6).fill(0xffd166);
      g.rect(-0.4, top + 3, 1.8, 1.4).fill(0xffd166);
      g.rect(-0.4, top + 5.2, 1.6, 1.6).fill(0xffd166);
    } else if (this.emoteKind === "alert") {
      // Amber "!" with a slow glow pulse — "I need you". Sits a little higher
      // than the other emotes so it clears the raised hand.
      const pulse = REDUCE_MOTION ? 0.5 : 0.5 + 0.5 * Math.sin(tMs / 260);
      const y = top - 2;
      g.roundRect(-3, y - 1, 6, 9, 2).fill({ color: 0xffb547, alpha: 0.12 + 0.16 * pulse });
      g.rect(-1, y, 2, 4.4).fill(0xffb547);
      g.rect(-1, y + 5.4, 2, 1.8).fill(0xffb547);
      g.rect(-1, y, 1, 4.4).fill({ color: 0xffe2a8, alpha: 0.5 + 0.5 * pulse });
    } else if (this.emoteKind === "bang") {
      // Quick cyan "!" that pops up and settles — "got it".
      const age = this.emoteMs - this.emoteT;
      const pop = REDUCE_MOTION ? 0 : Math.max(0, 1 - age / 180) * 3;
      const y = top - Math.round(pop);
      g.rect(-1.5, y - 0.5, 3, 5.4).fill({ color: 0x0d1a30, alpha: 0.85 });
      g.rect(-1.5, y + 5.6, 3, 2.6).fill({ color: 0x0d1a30, alpha: 0.85 });
      g.rect(-0.8, y, 1.6, 4.4).fill(0x9ff3ff);
      g.rect(-0.8, y + 6, 1.6, 1.6).fill(0x9ff3ff);
    } else if (this.emoteKind === "cloud") {
      // Grey storm cloud with a couple of rain pixels.
      g.ellipse(-2, top + 2.5, 3, 2).fill(0x5a6a83);
      g.ellipse(1.6, top + 2, 2.6, 2.2).fill(0x677894);
      g.ellipse(0, top + 3.4, 4.2, 1.8).fill(0x4d5c74);
      const drip = Math.floor(tMs / 320) % 2;
      g.rect(-2.5, top + 5.6 + drip, 1, 1.4).fill(0x4de3ff);
      g.rect(1.5, top + 6.2 - drip, 1, 1.4).fill(0x4de3ff);
    } else if (this.emoteKind === "chat") {
      // Tiny speech bubble with animated dots.
      g.roundRect(-4.5, top, 9, 5.4, 1.6).fill({ color: 0x0d1a30, alpha: 0.92 }).stroke({ color: 0x4de3ff, width: 0.5, alpha: 0.6 });
      g.rect(-1, top + 5.4, 1.6, 1.2).fill({ color: 0x0d1a30, alpha: 0.92 });
      const active = Math.floor(tMs / 300) % 3;
      for (let i = 0; i < 3; i++) {
        g.rect(-2.6 + i * 2.2, top + 2.2, 1.2, 1.2).fill({ color: 0x9eeaff, alpha: i === active ? 1 : 0.4 });
      }
    } else if (this.emoteKind === "coffee") {
      // Mug with rising steam.
      g.rect(-2, top + 2.4, 4, 3.4).fill(0xb56f2f);
      g.rect(2, top + 3, 1.2, 1.8).fill(0xb56f2f);
      g.rect(-2, top + 2.4, 4, 0.9).fill(0x6e4218);
      const s = Math.floor(tMs / 260) % 2;
      g.rect(-1.4, top + s * 0.6, 0.9, 1.2).fill({ color: 0xcfe3f7, alpha: 0.8 });
      g.rect(0.6, top + 1 - s * 0.6, 0.9, 1.2).fill({ color: 0xcfe3f7, alpha: 0.8 });
    } else if (this.emoteKind === "thumb") {
      // Thumbs up: a fist with the thumb sticking up.
      const c = 0xf2c9a0;
      g.rect(-2, top + 3, 4, 3.5).fill(c);
      g.rect(-1, top, 1.6, 3.4).fill(c);
      g.rect(-2, top + 3, 4, 0.6).fill(0xd9a87e);
      g.rect(2, top + 3.5, 1, 3).fill(0x3fc9e8);
    } else if (this.emoteKind === "moon") {
      // "Go to sleep": a crescent moon and a little z.
      g.circle(0, top + 3, 3).fill(0xffe27a);
      g.circle(1.4, top + 2.2, 2.6).fill(0x0d1a30);
      drawZ(g, 3, top - 2, 3, 0.9);
    } else if (this.emoteKind === "angry") {
      // Manga anger mark: four red corner brackets that throb.
      const s = REDUCE_MOTION ? 0 : Math.floor(tMs / 200) % 2;
      const c = 0xff5d73;
      const r = 2 + s * 0.5;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>) {
        const cx = 4 + sx * r;
        const cy = top + 3 + sy * r;
        g.rect(cx - (sx > 0 ? 0 : 1), cy - 0.5, 2, 1).fill(c);
        g.rect(cx - 0.5, cy - (sy > 0 ? 0 : 1), 1, 2).fill(c);
      }
    } else if (this.emoteKind === "heart") {
      // Pixel heart that pulses — petting the cat.
      const beat = REDUCE_MOTION ? 0 : Math.floor(tMs / 260) % 2;
      const c = 0xff5d9e;
      g.rect(-3 - beat * 0.5, top + 1, 2.6, 2).fill(c);
      g.rect(0.4 + beat * 0.5, top + 1, 2.6, 2).fill(c);
      g.rect(-3 - beat * 0.5, top + 2.5, 6 + beat, 1.6).fill(c);
      g.rect(-2, top + 4, 4, 1.4).fill(c);
      g.rect(-1, top + 5.2, 2, 1.2).fill(c);
      g.rect(-2.2, top + 1.6, 0.9, 0.9).fill(0xffd0e4);
    } else if (this.emoteKind === "hi" || this.emoteKind === "bye") {
      // Speech bubble with pixel letters: "HI" for a new teammate, "BYE" on the way out.
      const word = this.emoteKind === "hi" ? "HI" : "BYE";
      const w = word.length * 4 + 3;
      const age = this.emoteMs - this.emoteT;
      const pop = REDUCE_MOTION ? 0 : Math.max(0, 1 - age / 160) * 2;
      const y = top - 1 - Math.round(pop);
      g.roundRect(-w / 2, y, w, 8, 2).fill({ color: 0x0d1a30, alpha: 0.94 }).stroke({ color: 0xffd166, width: 0.6, alpha: 0.9 });
      g.rect(-1, y + 8, 2, 1.2).fill({ color: 0x0d1a30, alpha: 0.94 });
      drawWord(g, word, -w / 2 + 2, y + 1.5, this.emoteKind === "hi" ? 0xffd166 : 0x9eeaff);
    } else if (this.emoteKind === "spark") {
      // Green success check with a couple of twinkling sparkles — the happy
      // counterpart to the "cloud" shown on a failed turn.
      const check: Array<[number, number]> = [
        [-2, 2.6], [-1, 3.6], [0, 4.4], [1, 3.2], [2, 1.8], [3, 0.6],
      ];
      for (const [cx, cy] of check) g.rect(cx - 0.7, top + cy, 1.5, 1.5).fill(0x37d6a3);
      const tw = Math.floor(tMs / 200) % 2;
      g.rect(-3.6, top + (tw ? 0 : 0.8), 1, 1).fill({ color: 0x9effd4, alpha: tw ? 1 : 0.4 });
      g.rect(3.4, top + 4 + (tw ? 0.6 : 0), 1, 1).fill({ color: 0x9effd4, alpha: tw ? 0.4 : 1 });
    }
  }

  /** Yellow pixel arrow above the active worker's head. */
  private drawMarker(tMs: number, raise: number): void {
    const g = this.marker;
    g.clear();
    if (!this.active) return;
    const bob = Math.floor((tMs % 900) / 450); // 0 or 1
    const top = -24 - bob - raise;
    g.rect(-3, top, 6, 2).fill(0xffd166);
    g.rect(-2, top + 2, 4, 2).fill(0xffd166);
    g.rect(-1, top + 4, 2, 2).fill(0xffd166);
  }

  private gaitFor(dx: number, dy: number): Gait {
    if (Math.abs(dx) >= Math.abs(dy)) return "side";
    return dy < 0 ? "back" : "front";
  }

  /**
   * Thought cloud rising off the chin-hand side: two puffs, then a pixel cloud
   * with "…" ticking inside. Replaces the old three floating dots, which read
   * as noise at small zoom. Kept off-centre so it never covers the marker.
   */
  private drawThought(tMs: number, on: boolean, bulb: number): void {
    const g = this.thinkDots;
    g.clear();
    if (!on) return;
    const drift = REDUCE_MOTION ? 0 : Math.floor((tMs % 2400) / 1200); // 1px float
    const y = -30 - drift;
    const ink = 0xdfe9f8;
    g.rect(5, -19, 1, 1).fill({ color: ink, alpha: 0.7 });
    g.rect(6, -22 - drift, 2, 2).fill({ color: ink, alpha: 0.85 });
    if (bulb >= 0) {
      // The idea arrives: the cloud becomes a lit bulb that pings.
      const cx = 11;
      const cy = y + 3;
      const ping = Math.min(1, bulb / 700);
      g.circle(cx, cy, 3 + ping * 9).stroke({ color: 0xffe27a, width: 0.8, alpha: 0.8 * (1 - ping) });
      g.circle(cx, cy, 5).fill({ color: 0xffd166, alpha: 0.18 });
      g.circle(cx, cy, 3).fill(0xffe27a);
      g.rect(cx - 1.5, cy - 1.5, 1, 1).fill(0xffffff);
      g.rect(cx - 1.5, cy + 2.5, 3, 1).fill(0x9fb6cf);
      g.rect(cx - 1, cy + 3.5, 2, 1).fill(0x6f7fa3);
      const flash = Math.floor(bulb / 150) % 2 === 0;
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + ((k - 2.5) / 6) * Math.PI * 1.6;
        const r = flash ? 5 : 5.6;
        g.rect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1).fill({ color: 0xfff3c4, alpha: flash ? 1 : 0.6 });
      }
      return;
    }
    g.rect(7, y + 1, 9, 5).fill({ color: ink, alpha: 0.95 });
    g.rect(8, y, 7, 7).fill({ color: ink, alpha: 0.95 });
    const on3 = REDUCE_MOTION ? 2 : Math.floor(tMs / 380) % 4; // 0..3 dots lit
    for (let i = 0; i < 3; i++) {
      g.rect(9 + i * 2, y + 3, 1, 1).fill({ color: i < on3 ? 0x2b6f8f : 0x9fb6cf, alpha: 1 });
    }
  }
}

/**
 * How far a frame's head sits below the base idle pose, in art px. Some frames
 * bake the breathing dip into the pixel map (FRONT_IDLE_1 starts one row lower),
 * and everything drawn on the head separately — hats, glasses, headphones — has
 * to sink with it or it slides off the face every other frame.
 */
const HEAD_DROP = new WeakMap<object, number>();
/** First row with hair in it: the top of the head. */
export const hairTop = (rows: string[]) => Math.max(0, rows.findIndex((row) => /[Hh]/.test(row)));
/** The recorded head drop of a frame built by {@link buildPresetFrames}; undefined if it bypassed the builder. */
export const frameHeadDrop = (frame: object): number | undefined => HEAD_DROP.get(frame);

const SPRITE_ROWS = 16;
/**
 * Where head-worn things go, relative to the base pose's head. Mirrors exactly how the body
 * sprite lands: anchored at the feet, moved by `bodyY` (bob minus jump, unrounded) and squashed
 * by `sy` — so a hat stays on the hair through every dip, heel-strike squash and hop.
 */
export function headAnchorY(drop: number, bodyY: number, sy: number): number {
  return bodyY + SPRITE_ROWS * (1 - sy) + drop * sy;
}

/** Every pixel-crew frame for a preset. All of them go through `make` here, and get their head drop recorded. */
export function buildPresetFrames<T extends object>(presetId: string, make: (rows: string[]) => T) {
  const baseTop = hairTop(avatarPresetRows(FRONT_IDLE_0, presetId));
  const tex = (rows: string[]) => {
    const decorated = avatarPresetRows(rows, presetId);
    const frame = make(decorated);
    HEAD_DROP.set(frame, hairTop(decorated) - baseTop);
    return frame;
  };
  // The cyber visor is one solid band, so a "blink" would just erase it.
  const blink = (rows: string[]) => tex(normalizeAvatarPresetId(presetId) === "cyber" ? rows : closeEyes(rows));
  return {
    idleFrames: [tex(FRONT_IDLE_0), tex(FRONT_IDLE_1)],
    sideWalk: [
      tex(SIDE_STRIDE_A),
      tex(SIDE_PASS),
      tex(SIDE_STRIDE_B),
      tex(SIDE_PASS),
    ],
    frontWalk: [tex(FRONT_WALK_0), tex(FRONT_WALK_1)],
    backWalk: [tex(BACK_WALK_0), tex(BACK_WALK_1)],
    workFrames: [tex(BACK_0), tex(BACK_TYPE_1)],
    cheerFrame: tex(CHEER),
    idleBlink: [blink(FRONT_IDLE_0), blink(FRONT_IDLE_1)],
    lookLeft: [tex(shiftEyes(FRONT_IDLE_0, -1)), tex(shiftEyes(FRONT_IDLE_1, -1))],
    lookRight: [tex(shiftEyes(FRONT_IDLE_0, 1)), tex(shiftEyes(FRONT_IDLE_1, 1))],
    thinkFrames: [tex(THINK_CHIN), tex(THINK_UP)],
    thinkBlink: blink(THINK_CHIN),
    scratchFrames: [tex(SCRATCH_0), tex(SCRATCH_1)],
    handUp: [tex(HAND_UP_0), tex(HAND_UP_1)],
    openArms: tex(OPEN_ARMS),
    yawnOpen: tex(YAWN_OPEN),
    yawnStretch: tex(YAWN_STRETCH),
    typeFrames: [tex(BACK_TYPE_A), tex(BACK_TYPE_B)],
    backArmsIn: tex(BACK_ARMS_IN),
    backStretch: tex(BACK_STRETCH),
    backSip: tex(BACK_SIP),
    readFrames: [tex(FRONT_READ), tex(shiftEyes(FRONT_READ, 1))],
    rubFrames: [tex(FRONT_RUB_0), tex(FRONT_RUB_1)],
    phone: tex(FRONT_PHONE),
    tapFoot: tex(FRONT_TAP),
    watch: tex(FRONT_WATCH),
    frontStretch: blink(CHEER),
    reachOut: tex(FRONT_REACH),
    pet: tex(FRONT_PET),
    sidePass: tex(SIDE_PASS),
  };
}

function createPresetFrames(presetId: string, colorIndex: number) {
  const pal = avatarPresetPalette(presetId, colorIndex, SHIRT_COLORS);
  return buildPresetFrames(presetId, (rows) => texFromMap(rows, pal));
}

async function unloadAvatar(url: string): Promise<void> {
  try {
    await Assets.unload(url);
  } catch {
    // The load may have failed before the URL entered Pixi's cache.
  }
}

/** A 3x3 / 4x4 pixel "z" for dozing NPCs. */
export function drawZ(g: Graphics, x: number, y: number, size: 3 | 4, alpha: number): void {
  const c = { color: 0xdfe9f8, alpha };
  const X = Math.round(x);
  const Y = Math.round(y);
  g.rect(X, Y, size, 1).fill(c);
  for (let i = 1; i < size - 1; i++) g.rect(X + size - 1 - i, Y + i, 1, 1).fill(c);
  g.rect(X, Y + size - 1, size, 1).fill(c);
}

const GLYPHS: Record<string, string[]> = {
  H: ["1.1", "1.1", "111", "1.1", "1.1"],
  I: ["111", ".1.", ".1.", ".1.", "111"],
  B: ["11.", "1.1", "11.", "1.1", "11."],
  Y: ["1.1", "1.1", ".1.", ".1.", ".1."],
  E: ["111", "1..", "11.", "1..", "111"],
  C: ["111", "1..", "1..", "1..", "111"],
  O: ["111", "1.1", "1.1", "1.1", "111"],
  M: ["1.1", "111", "111", "1.1", "1.1"],
  X: ["1.1", "1.1", ".1.", "1.1", "1.1"],
  " ": ["...", "...", "...", "...", "..."],
  "0": ["111", "1.1", "1.1", "1.1", "111"],
  "1": [".1.", "11.", ".1.", ".1.", "111"],
  "2": ["111", "..1", "111", "1..", "111"],
  "3": ["111", "..1", ".11", "..1", "111"],
  "4": ["1.1", "1.1", "111", "..1", "..1"],
  "5": ["111", "1..", "111", "..1", "111"],
  "6": ["111", "1..", "111", "1.1", "111"],
  "7": ["111", "..1", ".1.", ".1.", ".1."],
  "8": ["111", "1.1", "111", "1.1", "111"],
  "9": ["111", "1.1", "111", "..1", "111"],
};

/** Tiny 3x5 pixel font (HI / BYE bubbles, COMBO counter); `s` scales it for pop-in. */
function drawWord(g: Graphics, word: string, x: number, y: number, color: number, s = 1, alpha = 1): void {
  [...word].forEach((ch, i) => {
    const rows = GLYPHS[ch];
    if (!rows) return;
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) {
        if (row[rx] === "1") g.rect(x + (i * 4 + rx) * s, y + ry * s, s, s).fill({ color, alpha });
      }
    });
  });
}

// Checklist screen timing (shared by the nod rhythm and the screen content).
const CHECK_CYCLE = 3_300;
const CHECK_FIRST = 300;
const CHECK_GAP = 420;
const CHECK_STAMP = 2_150;

/** Cheap deterministic 0..1 noise so desk sparks don't need Math.random per frame. */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
