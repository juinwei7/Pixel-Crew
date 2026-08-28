/** 零依賴 QR 產生器（ISO/IEC 18004）。
 *  範圍：byte 模式、EC level L、版本 1–5（單區塊，容量至 106 bytes），
 *  足夠任何 cloudflared / Tailscale 連線網址。回傳 module 矩陣（true=黑）。
 *  超過容量回傳 null（呼叫端自行退回純連結）。 */

// === GF(256) ===
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();
const gexp = (n: number) => EXP[n % 255];
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);

// === Reed–Solomon ===
function genPoly(ecLen: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], gexp(i));
    }
    poly = next;
  }
  return poly;
}
function ecCodewords(data: number[], ecLen: number): number[] {
  const gen = genPoly(ecLen);
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
  }
  return res.slice(data.length);
}

// === 版本表（EC level L，單區塊）: [總資料 codewords, EC codewords/區塊, 位元組容量] ===
const VER_L: Record<number, { data: number; ec: number; cap: number }> = {
  1: { data: 19, ec: 7, cap: 17 },
  2: { data: 34, ec: 10, cap: 32 },
  3: { data: 55, ec: 15, cap: 53 },
  4: { data: 80, ec: 20, cap: 78 },
  5: { data: 108, ec: 26, cap: 106 },
};
// 對齊圖樣中心座標（v2–5 各一組）
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30] };

// === 格式資訊 BCH（EC level L = 0b01）===
function bchDigit(v: number): number { let n = 0; while (v !== 0) { n++; v >>>= 1; } return n; }
function formatInfo(mask: number): number {
  const data = (1 << 3) | mask; // L(01) << 3 | mask
  let d = data << 10;
  const G15 = 0b10100110111;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ 0b101010000010010;
}

type Mat = { v: Int8Array; fn: Uint8Array; size: number };
const at = (m: Mat, r: number, c: number) => m.v[r * m.size + c];
const set = (m: Mat, r: number, c: number, val: number, isFn = false) => {
  m.v[r * m.size + c] = val;
  if (isFn) m.fn[r * m.size + c] = 1;
};

function placeFinder(m: Mat, r: number, c: number) {
  for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
    const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
    const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
    set(m, rr, cc, dark ? 1 : 0, true);
  }
}
function placeAlign(m: Mat, cr: number, cc: number) {
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    set(m, cr + dr, cc + dc, dark ? 1 : 0, true);
  }
}

const MASK = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number, _c: number) => r % 2 === 0,
  (_r: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function baseMatrix(version: number): Mat {
  const size = 17 + version * 4;
  const m: Mat = { v: new Int8Array(size * size).fill(-1), fn: new Uint8Array(size * size), size };
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  // timing
  for (let i = 8; i < size - 8; i++) {
    const d = i % 2 === 0 ? 1 : 0;
    if (at(m, 6, i) === -1) set(m, 6, i, d, true);
    if (at(m, i, 6) === -1) set(m, i, 6, d, true);
  }
  // alignment
  const coords = ALIGN[version];
  if (coords.length) {
    const first = coords[0], last = coords[coords.length - 1];
    for (const r of coords) for (const c of coords) {
      if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first)) continue;
      placeAlign(m, r, c);
    }
  }
  // dark module
  set(m, size - 8, 8, 1, true);
  // 保留格式資訊區（值稍後由 placeFormat 填）
  for (let i = 0; i <= 8; i++) {
    if (at(m, 8, i) === -1) set(m, 8, i, 0, true);
    if (at(m, i, 8) === -1) set(m, i, 8, 0, true);
  }
  for (let i = 0; i < 8; i++) {
    set(m, 8, size - 1 - i, 0, true);
    set(m, size - 1 - i, 8, 0, true);
  }
  return m;
}

function placeData(m: Mat, codewords: number[], mask: number) {
  const size = m.size;
  const maskFn = MASK[mask];
  let bitIndex = 7, byteIndex = 0, row = size - 1, inc = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (m.fn[row * size + x]) continue;
        let dark = 0;
        if (byteIndex < codewords.length) dark = (codewords[byteIndex] >>> bitIndex) & 1;
        if (maskFn(row, x)) dark ^= 1;
        set(m, row, x, dark);
        if (--bitIndex === -1) { byteIndex++; bitIndex = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

function placeFormat(m: Mat, mask: number) {
  const size = m.size;
  const fmt = formatInfo(mask);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    // 縱向（左上往下 + 左下往上）
    if (i < 6) m.v[i * size + 8] = bit;
    else if (i < 8) m.v[(i + 1) * size + 8] = bit;
    else m.v[(size - 15 + i) * size + 8] = bit;
    // 橫向（右上 + 左上往右）
    if (i < 8) m.v[8 * size + (size - 1 - i)] = bit;
    else if (i < 9) m.v[8 * size + (15 - i)] = bit;
    else m.v[8 * size + (15 - 1 - i)] = bit;
  }
}

function penalty(m: Mat): number {
  const size = m.size;
  const g = (r: number, c: number) => m.v[r * size + c];
  let p = 0;
  // 規則1：連續同色 >=5
  for (let r = 0; r < size; r++) {
    let runC = 1, runV = 1;
    for (let c = 1; c < size; c++) {
      if (g(r, c) === g(r, c - 1)) { runC++; } else { if (runC >= 5) p += 3 + (runC - 5); runC = 1; }
      if (g(c, r) === g(c - 1, r)) { runV++; } else { if (runV >= 5) p += 3 + (runV - 5); runV = 1; }
    }
    if (runC >= 5) p += 3 + (runC - 5);
    if (runV >= 5) p += 3 + (runV - 5);
  }
  // 規則2：2x2 同色
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = g(r, c);
    if (v === g(r, c + 1) && v === g(r + 1, c) && v === g(r + 1, c + 1)) p += 3;
  }
  // 規則3：1011101 兩側四淺
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (get: (i: number) => number, pat: number[], start: number) => {
    for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
    if (match((i) => g(r, i), p1, c) || match((i) => g(r, i), p2, c)) p += 40;
    if (match((i) => g(i, r), p1, c) || match((i) => g(i, r), p2, c)) p += 40;
  }
  // 規則4：暗色比例偏離 50%
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (m.v[i] === 1) dark++;
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

/** 產生 QR module 矩陣；容量不足回傳 null。 */
export function encodeQr(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 5; v++) if (bytes.length <= VER_L[v].cap) { version = v; break; }
  if (!version) return null;
  const { data: dataCw, ec: ecLen } = VER_L[version];

  // 位元流：mode(0100) + 長度(8) + 資料
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  // 終止符 + 補到位元組
  const cap = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // 轉 codewords
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    codewords.push(b);
  }
  // 補碼 0xEC / 0x11
  const pads = [0xec, 0x11];
  let pi = 0;
  while (codewords.length < dataCw) codewords.push(pads[pi++ % 2]);
  // EC
  const all = codewords.concat(ecCodewords(codewords, ecLen));

  // 選最佳遮罩（每個遮罩用一份乾淨底版）
  let best: Mat | null = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = baseMatrix(version);
    placeData(m, all, mask);
    placeFormat(m, mask);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  if (!best) return null;
  const size = best.size;
  const out: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(best.v[r * size + c] === 1);
    out.push(row);
  }
  return out;
}
