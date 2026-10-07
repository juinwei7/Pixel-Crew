/* 鏡頭導引：使用者主動點名時把鏡頭滑到 NPC（focusOn）、雙擊 NPC 後慢慢跟拍（follow），
   以及畫面外待核准 NPC 的邊緣指示位置。全是純函式／小類別，不碰 Pixi 也不碰 DOM——
   scene.ts 每幀把目前平移量丟進 CameraDirector.step()，拿回新的平移量（或 null＝不用動）。

   設計原則（owner 審美）：動作短而安靜。
   - focusOn：固定 300ms、ease-in-out，終點每幀重算（NPC 在走也會落在他身上）。
   - follow：指數趨近＋速度上限，慢、不暈；NPC 停了鏡頭在半像素內就停，不再微抖。
   - prefers-reduced-motion：focusOn 直接到位，不滑。 */

export type Pt = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** SceneHandle 上的鏡頭導引 API（scene.ts 接線後由 SceneHandle 交叉進來）。 */
export type SceneCameraControls = {
  /** 平滑把 NPC 移到 anchor（canvas 座標；省略＝畫面正中）。只在使用者主動點擊時呼叫。 */
  focusOn(id: string, anchor?: Pt): void;
  /** 開始跟拍：鏡頭慢慢跟著這位 NPC 走。 */
  follow(id: string, anchor?: Pt): void;
  /** 結束跟拍（也取消進行中的 focusOn 滑動）。 */
  stopFollow(): void;
  /** 目前跟拍中的 NPC id；沒有則 null。拖曳、恢復預設視角、NPC 離場都會讓它變 null。 */
  followingId(): string | null;
};

export const FOCUS_MS = 300;
/** 跟拍的時間常數：越大越慢；約 0.9s 追上一半多的距離。 */
export const FOLLOW_TAU_MS = 900;
/** 跟拍時鏡頭每秒最多移動的螢幕像素。 */
export const FOLLOW_MAX_SPEED = 220;
/** 距離目標小於這個就視為到位，停止輸出（NPC 停、鏡頭也停）。 */
export const SETTLE_PX = 0.5;

export function easeInOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 與 scene.applyView 相同的平移邊界：房間永遠至少留 keep px 在畫面內。 */
export function clampPan(pan: Pt, view: {
  screenW: number; screenH: number; baseX: number; baseY: number; contentW: number; contentH: number; scale: number; keep?: number;
}): Pt {
  const keep = view.keep ?? 140;
  return {
    x: Math.min(view.screenW - keep - view.baseX, Math.max(keep - (view.baseX + view.contentW * view.scale), pan.x)),
    y: Math.min(view.screenH - keep - view.baseY, Math.max(keep - (view.baseY + view.contentH * view.scale), pan.y)),
  };
}

/**
 * 讓世界座標 (worldX, worldY) 落在 anchor（canvas 座標，預設畫面中心）所需的平移量，
 * 已套用既有的邊界限制——所以趨近時不會一直撞牆、白白每幀重排。
 */
export function centerPanOn(p: {
  worldX: number; worldY: number; scale: number;
  screenW: number; screenH: number; baseX: number; baseY: number;
  contentW: number; contentH: number;
  anchor?: Pt | null; keep?: number;
}): Pt {
  const ax = p.anchor?.x ?? p.screenW / 2;
  const ay = p.anchor?.y ?? p.screenH / 2;
  return clampPan(
    { x: ax - p.worldX * p.scale - p.baseX, y: ay - p.worldY * p.scale - p.baseY },
    { screenW: p.screenW, screenH: p.screenH, baseX: p.baseX, baseY: p.baseY, contentW: p.contentW, contentH: p.contentH, scale: p.scale, keep: p.keep },
  );
}

type TargetFn = (id: string, anchor: Pt | null) => Pt | null;

function reducedMotionDefault(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class CameraDirector {
  private tween: { id: string; anchor: Pt | null; elapsed: number; duration: number } | null = null;
  private follow_: { id: string; anchor: Pt | null } | null = null;
  private readonly reduced: () => boolean;

  constructor(options: { reducedMotion?: () => boolean } = {}) {
    this.reduced = options.reducedMotion ?? reducedMotionDefault;
  }

  focusOn(id: string, anchor?: Pt | null): void {
    // 點了別人就不再跟拍原本那位；點同一位則跟拍照舊（滑完繼續跟）。
    if (this.follow_ && this.follow_.id !== id) this.follow_ = null;
    this.tween = { id, anchor: anchor ?? null, elapsed: 0, duration: this.reduced() ? 0 : FOCUS_MS };
  }

  follow(id: string, anchor?: Pt | null): void {
    this.follow_ = { id, anchor: anchor ?? null };
  }

  stopFollow(): void {
    this.follow_ = null;
    this.tween = null;
  }

  followingId(): string | null {
    return this.follow_?.id ?? null;
  }

  /** 有沒有在動（測試／除錯用）。 */
  get active(): boolean {
    return this.tween !== null || this.follow_ !== null;
  }

  /**
   * 每幀呼叫。pan＝目前平移量；target(id, anchor)＝把該 NPC 置於 anchor 的平移量（已夾邊界），
   * NPC 不在了回 null。回傳新的平移量；不需要動時回 null（呼叫端就不必 applyView）。
   */
  step(dtMs: number, pan: Pt, target: TargetFn): Pt | null {
    const dt = Math.max(0, Math.min(100, dtMs));
    if (this.tween) {
      const tw = this.tween;
      const goal = target(tw.id, tw.anchor);
      if (!goal) {
        this.tween = null;
      } else {
        // 用「剩餘距離的比例」推進，而不是固定起點：滑動途中使用者縮放或 NPC 走動
        // 都不會跳格，最後一幀一定剛好落在目標上。
        const before = tw.duration <= 0 ? 1 : easeInOutCubic(tw.elapsed / tw.duration);
        tw.elapsed += dt;
        const after = tw.duration <= 0 ? 1 : easeInOutCubic(tw.elapsed / tw.duration);
        const k = before >= 1 ? 1 : (after - before) / (1 - before);
        if (after >= 1) this.tween = null;
        return { x: pan.x + (goal.x - pan.x) * k, y: pan.y + (goal.y - pan.y) * k };
      }
    }
    if (this.follow_) {
      const goal = target(this.follow_.id, this.follow_.anchor);
      if (!goal) {
        this.follow_ = null;
        return null;
      }
      const dx = goal.x - pan.x;
      const dy = goal.y - pan.y;
      const dist = Math.hypot(dx, dy);
      if (dist < SETTLE_PX) return null;
      let move = dist * (1 - Math.exp(-dt / FOLLOW_TAU_MS));
      move = Math.min(move, (FOLLOW_MAX_SPEED * dt) / 1000);
      // 最後一小段直接貼上，免得指數尾巴拖很久還在 0.x px 地動。
      if (dist - move < SETTLE_PX) move = dist;
      return { x: pan.x + (dx / dist) * move, y: pan.y + (dy / dist) * move };
    }
    return null;
  }
}

/* ── 可視範圍：canvas 被側欄／任務日誌／頂欄蓋住的部分不算「看得到」。 ── */

/**
 * 從 view（canvas 的螢幕矩形）扣掉貼邊的遮擋面板，回傳真正看得到的矩形。
 * 只有「貼著某一邊、且沿那一邊佔了大半」的面板才算遮擋（側欄、日誌、頂欄、底部抽屜）；
 * 小按鈕列不影響。結果太窄（< minSize）就退回原 view，避免算出一條縫。
 */
export function clearViewRect(view: Rect, obstacles: Rect[], minSize = 160): Rect {
  const out = { ...view };
  const w = view.right - view.left;
  const h = view.bottom - view.top;
  const edgeTol = 48;
  for (const o of obstacles) {
    const ix = Math.min(o.right, view.right) - Math.max(o.left, view.left);
    const iy = Math.min(o.bottom, view.bottom) - Math.max(o.top, view.top);
    if (ix <= 0 || iy <= 0) continue;
    const tallish = iy >= h * 0.5;
    const widish = ix >= w * 0.5;
    if (tallish && o.left - view.left <= edgeTol && o.right < view.right - w * 0.2) out.left = Math.max(out.left, o.right);
    else if (tallish && view.right - o.right <= edgeTol && o.left > view.left + w * 0.2) out.right = Math.min(out.right, o.left);
    else if (widish && o.top - view.top <= edgeTol && o.bottom < view.bottom - h * 0.2) out.top = Math.max(out.top, o.bottom);
    else if (widish && view.bottom - o.bottom <= edgeTol && o.top > view.top + h * 0.2) out.bottom = Math.min(out.bottom, o.top);
  }
  if (out.right - out.left < minSize || out.bottom - out.top < minSize) return { ...view };
  return out;
}

export function rectCenter(r: Rect): Pt {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/**
 * 畫面外判定（含遲滯，避免在邊界上來回閃）：原本在畫面內的，要超出 rect 外 outside px 才算出去；
 * 原本在外面的，要進到 rect 內 inside px 才算回來。
 */
export function isOffscreen(p: Pt, rect: Rect, wasOff: boolean, outside = 6, inside = 24): boolean {
  if (wasOff) {
    return !(p.x > rect.left + inside && p.x < rect.right - inside && p.y > rect.top + inside && p.y < rect.bottom - inside);
  }
  return p.x < rect.left - outside || p.x > rect.right + outside || p.y < rect.top - outside || p.y > rect.bottom + outside;
}

export type EdgeMarker = { id: string; x: number; y: number; angle: number };

/**
 * 畫面外 NPC 的邊緣指示：從可視範圍中心往 NPC 射一條線，停在內縮 inset 的框上；
 * angle（弧度）指向 NPC。落進 keepouts（縮放列、分流條）就沿邊推開；同一處擠在一起的依序錯開。
 */
export function edgeMarkers(points: Array<{ id: string; x: number; y: number }>, rect: Rect, options: { inset?: number; size?: number; keepouts?: Rect[] } = {}): EdgeMarker[] {
  const inset = options.inset ?? 22;
  const size = options.size ?? 26;
  const keepouts = options.keepouts ?? [];
  const c = rectCenter(rect);
  const minX = rect.left + inset;
  const maxX = rect.right - inset;
  const minY = rect.top + inset;
  const maxY = rect.bottom - inset;
  const placed: EdgeMarker[] = [];
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const angle = Math.atan2(dy, dx);
    const hx = (maxX - minX) / 2;
    const hy = (maxY - minY) / 2;
    const t = Math.min(dx === 0 ? Infinity : hx / Math.abs(dx), dy === 0 ? Infinity : hy / Math.abs(dy));
    let x = Number.isFinite(t) ? c.x + dx * t : c.x;
    let y = Number.isFinite(t) ? c.y + dy * t : c.y;
    x = Math.max(minX, Math.min(maxX, x));
    y = Math.max(minY, Math.min(maxY, y));
    for (const k of keepouts) {
      const half = size / 2 + 4;
      if (x + half > k.left && x - half < k.right && y + half > k.top && y - half < k.bottom) {
        // 往上推到那塊上方（縮放列與分流條都在底部）。
        y = Math.max(minY, k.top - half);
      }
    }
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const hit = placed.find((m) => Math.abs(m.x - x) < size + 2 && Math.abs(m.y - y) < size + 2);
      if (!hit) break;
      // 沿著所在的那條邊錯開。
      const onSide = Math.abs(x - minX) < 1 || Math.abs(x - maxX) < 1;
      if (onSide) y = Math.max(minY, Math.min(maxY, hit.y + (y >= hit.y ? 1 : -1) * (size + 4)));
      else x = Math.max(minX, Math.min(maxX, hit.x + (x >= hit.x ? 1 : -1) * (size + 4)));
    }
    placed.push({ id: p.id, x, y, angle });
  }
  return placed;
}

/** 頭像上的縮寫：中日韓取第一個字，拉丁字取前兩個字母（大寫）。 */
export function nameInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0];
  if (/[぀-ヿ㐀-鿿가-힯]/.test(first)) return first;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : Array.from(trimmed).slice(0, 2).join("");
  return letters.toUpperCase();
}
