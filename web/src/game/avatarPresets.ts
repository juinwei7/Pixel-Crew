import { PAL, type Palette } from "./pixels";

export type AvatarPresetId = "classic" | "cyber" | "signal" | "spark" | "ops";

export type AvatarPreset = {
  id: AvatarPresetId;
  name: string;
  role: string;
  accent: string;
  palette: Partial<Palette> | null;
};

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: "classic", name: "經典隊員", role: "原始制服 · 隨隊員配色", accent: "#4de3ff", palette: null },
  { id: "cyber", name: "霓虹工程師", role: "深藍髮 · 青藍制服", accent: "#35e3dc", palette: { H: 0x182b4a, h: 0x101c34, B: 0x35e3dc, b: 0x168f9b, P: 0x2b4770, p: 0x1d3152 } },
  { id: "signal", name: "訊號分析師", role: "銀灰髮 · 紫羅蘭制服", accent: "#a98bff", palette: { H: 0xb9c8dd, h: 0x7787a3, B: 0xa98bff, b: 0x7355c7, P: 0x384064, p: 0x292f4e } },
  { id: "spark", name: "火花設計師", role: "暖棕髮 · 桃紅制服", accent: "#ff69cf", palette: { H: 0x7a3d45, h: 0x4c2731, S: 0xe8b58f, B: 0xff69cf, b: 0xb8348d, P: 0x53375f, p: 0x38263f } },
  { id: "ops", name: "夜班維運", role: "黑藍髮 · 金橘制服", accent: "#ffc857", palette: { H: 0x17243b, h: 0x0d1526, S: 0xc98f6d, B: 0xffc857, b: 0xb77a21, P: 0x333c54, p: 0x22293d } },
];

const PRESET_IDS = new Set(AVATAR_PRESETS.map((preset) => preset.id));

export function normalizeAvatarPresetId(value: string | null | undefined): AvatarPresetId {
  return PRESET_IDS.has(value as AvatarPresetId) ? value as AvatarPresetId : "classic";
}

export function avatarPresetPalette(presetId: string, colorIndex: number, shirtColors: Array<[number, number]>): Palette {
  const preset = AVATAR_PRESETS.find((item) => item.id === normalizeAvatarPresetId(presetId))!;
  const [shirt, shade] = shirtColors[colorIndex % shirtColors.length];
  return { ...PAL, B: shirt, b: shade, ...(preset.palette ?? {}) };
}

export function avatarPresetRows(rows: string[], presetId: string): string[] {
  const id = normalizeAvatarPresetId(presetId);
  if (id === "classic") return rows;
  return rows.map((row, y) => {
    const pixels = [...row];
    const eyes = pixels.flatMap((pixel, index) => pixel === "E" ? [index] : []);
    if (id === "cyber" && eyes.length > 0) {
      const start = eyes[0];
      const end = eyes[eyes.length - 1];
      for (let x = start; x <= end; x++) {
        if (pixels[x] === "S" || pixels[x] === "E") pixels[x] = x % 2 === 0 ? "C" : "c";
      }
    }
    if (id === "signal" && eyes.length > 0) {
      for (const eye of eyes) {
        pixels[eye] = "X";
        if (pixels[eye - 1] === "S") pixels[eye - 1] = "W";
        if (pixels[eye + 1] === "S") pixels[eye + 1] = "W";
      }
    }
    if (id === "spark" && y >= 1 && y <= 6) {
      const firstHair = pixels.indexOf("H");
      const lastHair = pixels.lastIndexOf("H");
      if (firstHair > 0 && pixels[firstHair - 1] === ".") pixels[firstHair - 1] = "H";
      if (lastHair >= 0 && lastHair + 1 < pixels.length && pixels[lastHair + 1] === ".") pixels[lastHair + 1] = y >= 3 ? "h" : "H";
    }
    if (id === "ops" && eyes.length > 0) {
      const firstHair = pixels.indexOf("H");
      const lastSkin = pixels.lastIndexOf("S");
      if (firstHair > 0) pixels[firstHair - 1] = "C";
      if (lastSkin + 1 < pixels.length) pixels[lastSkin + 1] = "c";
    }
    return pixels.join("");
  });
}

export function paintPresetPreview(
  canvas: HTMLCanvasElement,
  rows: string[],
  presetId: string,
  colorIndex: number,
  shirtColors: Array<[number, number]>,
): void {
  const palette = avatarPresetPalette(presetId, colorIndex, shirtColors);
  const decoratedRows = avatarPresetRows(rows, presetId);
  canvas.width = rows[0]?.length ?? 12;
  canvas.height = rows.length;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < decoratedRows.length; y++) {
    for (let x = 0; x < decoratedRows[y].length; x++) {
      const color = palette[decoratedRows[y][x]];
      if (color === undefined) continue;
      context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      context.fillRect(x, y, 1, 1);
    }
  }
}
