import { t } from "../i18n";

export const AVATAR_WIDTH = 24;
export const AVATAR_HEIGHT = 32;

export type AvatarControls = {
  zoom: number;
  offsetX: number;
  offsetY: number;
  paletteSize: 8 | 12 | 16;
  removeBackground: boolean;
};

type Color = [number, number, number];

export function renderNormalizedAvatar(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  controls: AvatarControls,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_WIDTH;
  canvas.height = AVATAR_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error(t("瀏覽器無法建立圖片畫布"));
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, AVATAR_WIDTH, AVATAR_HEIGHT);

  const fit = Math.min(AVATAR_WIDTH / sourceWidth, AVATAR_HEIGHT / sourceHeight);
  const width = sourceWidth * fit * controls.zoom;
  const height = sourceHeight * fit * controls.zoom;
  const x = (AVATAR_WIDTH - width) / 2 + controls.offsetX * AVATAR_WIDTH * 0.5;
  const y = (AVATAR_HEIGHT - height) / 2 + controls.offsetY * AVATAR_HEIGHT * 0.5;
  context.drawImage(source, x, y, width, height);

  const image = context.getImageData(0, 0, AVATAR_WIDTH, AVATAR_HEIGHT);
  if (controls.removeBackground) removeCornerBackground(image.data, AVATAR_WIDTH, AVATAR_HEIGHT);
  quantizePixels(image.data, controls.paletteSize);
  context.putImageData(image, 0, 0);
  return canvas;
}

export function removeCornerBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 52,
): void {
  const samples: Color[] = [];
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    const index = (y * width + x) * 4;
    if (pixels[index + 3] >= 128) samples.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
  }
  if (samples.length < 2) return;
  const background: Color = [
    average(samples.map((sample) => sample[0])),
    average(samples.map((sample) => sample[1])),
    average(samples.map((sample) => sample[2])),
  ];
  const maxDistance = threshold * threshold;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) {
      pixels[index + 3] = 0;
      continue;
    }
    const dr = pixels[index] - background[0];
    const dg = pixels[index + 1] - background[1];
    const db = pixels[index + 2] - background[2];
    if (dr * dr + dg * dg + db * db <= maxDistance) pixels[index + 3] = 0;
  }
}

export function quantizePixels(pixels: Uint8ClampedArray, maxColors: number): void {
  const counts = new Map<string, number>();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    const key = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts].map(([key, count]) => ({
    color: key.split(",").map(Number) as Color,
    count,
  }));
  if (colors.length <= maxColors) return;

  const centroids: Color[] = [colors.sort((a, b) => b.count - a.count)[0].color];
  while (centroids.length < Math.min(maxColors, colors.length)) {
    let candidate = colors[0].color;
    let score = -1;
    for (const item of colors) {
      const nearest = Math.min(...centroids.map((centroid) => colorDistance(item.color, centroid)));
      const weighted = nearest * Math.sqrt(item.count);
      if (weighted > score) {
        candidate = item.color;
        score = weighted;
      }
    }
    centroids.push([...candidate] as Color);
  }

  for (let iteration = 0; iteration < 8; iteration++) {
    const totals = centroids.map(() => [0, 0, 0, 0]);
    for (const item of colors) {
      const cluster = nearestColor(item.color, centroids);
      totals[cluster][0] += item.color[0] * item.count;
      totals[cluster][1] += item.color[1] * item.count;
      totals[cluster][2] += item.color[2] * item.count;
      totals[cluster][3] += item.count;
    }
    totals.forEach((total, index) => {
      if (!total[3]) return;
      centroids[index] = [
        Math.round(total[0] / total[3]),
        Math.round(total[1] / total[3]),
        Math.round(total[2] / total[3]),
      ];
    });
  }

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) {
      pixels[index + 3] = 0;
      continue;
    }
    const color: Color = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const replacement = centroids[nearestColor(color, centroids)];
    pixels[index] = replacement[0];
    pixels[index + 1] = replacement[1];
    pixels[index + 2] = replacement[2];
    pixels[index + 3] = 255;
  }
}

function nearestColor(color: Color, palette: Color[]): number {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const next = colorDistance(color, candidate);
    if (next < distance) {
      nearest = index;
      distance = next;
    }
  });
  return nearest;
}

function colorDistance(a: Color, b: Color): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function average(values: number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
