// 全站互動手感（第三輪）：一個地方裝好，所有彈窗、選單、主要按鈕都吃得到。
//
//   1. 從按鈕長出來：記住「剛剛按的是哪顆」，接下來 2 秒內出現的 modal 卡片
//      或浮層，就把 transform-origin 設到那顆按鈕的中心——卡片從按鈕裡彈
//      出來；用 Esc / × 關閉時再縮回同一點（styles/motion-fx.css 的
//      [data-pop-origin]）。原生 <details> 選單走 toggle 事件、以 summary
//      當起點。手機（≤600px）的 modal 是貼底抽屜，不套。
//   2. 主要按鈕的像素火花：從手指／游標按下的那一點炸開 8 顆方塊＋一圈方框。
//   3. 延遲浮出的提示框：滑到有 title 的按鈕上 450ms 後浮出像素風提示，
//      連續滑過相鄰按鈕時不再等（暖機模式）。滑走就把 title 還回去。
//   4. 彩帶：任務完成時從那位 NPC 的隊員列（或手機 chip）噴出來。
//   5. 彩蛋：連點 PIXEL CREW 字樣 5 下。
//
// 純視覺：只動 DOM 上的 class / style，從不送請求、不改任何狀態。
// prefers-reduced-motion：火花、彩帶、彩蛋整個不做；彈窗退成淡入（CSS）。

import { t } from "./i18n";
import { shortcutLabel, takeShortcutHint } from "./uxMotion";

export type Rect = { left: number; top: number; width: number; height: number };

/** 浮層（modal 卡片、選單、popover）：出現時要從觸發鈕長出來的元素。 */
export const POP_SELECTOR = [
  ".ui-modal__card",
  ".top-bar__more-menu",
  ".top-bar__running-menu",
  ".health-popover",
  ".update-popover",
  ".focus-controls__panel",
  ".autopilot-config",
  ".composer-roundtable-menu",
  ".warroom-stances-panel",
  ".command-queue",
  ".command-palette",
  ".crew-row__menu",
  ".confirm-dialog__card",
].join(", ");

/** 會在按下點炸出火花的「主要」按鈕。刻意只挑會推進流程的那幾顆。 */
export const SPARK_SELECTOR = [
  ".command-composer__submit",
  ".workspace-picker__confirm",
  ".workspace-picker__default",
  ".department-creator__primary",
  ".avatar-workshop__save",
  ".persona-editor__save",
  ".confirm-dialog__btn--confirm",
  ".approval-card__allow",
  ".top-bar__boss",
  "[data-spark]",
].join(", ");

const TRIGGER_SELECTOR = "button, summary, a[href], [role='button'], [role='menuitem'], [role='tab']";
const TIP_SELECTOR = "button[title], summary[title], a[title], label[title], [role='button'][title], [data-tip]";
export const TRIGGER_TTL_MS = 2000;
export const TIP_DELAY_MS = 450;
const TIP_WARM_MS = 400;

/** 卡片要從哪一點長出來：觸發鈕中心，換算成卡片自己的座標（可以在卡片外面）。 */
export function popOriginFor(trigger: Rect, box: Rect): { x: number; y: number } {
  return {
    x: Math.round(trigger.left + trigger.width / 2 - box.left),
    y: Math.round(trigger.top + trigger.height / 2 - box.top),
  };
}

/** 提示框放哪：預設在按鈕下方置中，下方放不下就翻到上方；左右夾在視窗內。 */
export function tipPlacement(anchor: Rect, tip: { width: number; height: number }, viewport: { width: number; height: number }, gap = 8) {
  const margin = 6;
  let side: "below" | "above" = "below";
  let top = anchor.top + anchor.height + gap;
  if (top + tip.height > viewport.height - margin && anchor.top - gap - tip.height >= margin) {
    side = "above";
    top = anchor.top - gap - tip.height;
  }
  const centre = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(margin, centre - tip.width / 2), Math.max(margin, viewport.width - margin - tip.width));
  return { left: Math.round(left), top: Math.round(top), side, arrowX: Math.round(centre - left) };
}

/** 連點計數：只留 windowMs 內的點擊，達到 n 下就觸發並清空。 */
export function clickStreak(times: number[], now: number, n = 5, windowMs = 1800): { times: number[]; fired: boolean } {
  const kept = [...times.filter((at) => now - at <= windowMs), now];
  return kept.length >= n ? { times: [], fired: true } : { times: kept, fired: false };
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function isPhone(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
}

// ── 從按鈕長出來 ────────────────────────────────────────────────────────
let lastTrigger: { rect: Rect; at: number } | null = null;

function snapshot(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** 給程式自己指定起點（例如快捷鍵打開、或示範面板）。 */
export function setPopTrigger(el: Element | Rect | null): void {
  if (!el) { lastTrigger = null; return; }
  lastTrigger = { rect: el instanceof Element ? snapshot(el) : el, at: performance.now() };
}

export function applyPopOrigin(el: HTMLElement, trigger: Rect): void {
  if (isPhone() && el.classList.contains("ui-modal__card")) return;
  // 量的時候先拿掉動畫：入場第一幀是縮小的，量到的框會是錯的。
  const previous = el.style.animation;
  el.style.animation = "none";
  const box = el.getBoundingClientRect();
  el.style.animation = previous;
  if (!box.width || !box.height) return;
  const { x, y } = popOriginFor(trigger, box);
  el.style.setProperty("--pop-ox", `${x}px`);
  el.style.setProperty("--pop-oy", `${y}px`);
  // 換一個值讓同一個（常駐的 <details>）元素每次打開都重播。
  el.dataset.popOrigin = el.dataset.popOrigin === "a" ? "b" : "a";
}

function freshTrigger(): Rect | null {
  if (!lastTrigger || performance.now() - lastTrigger.at > TRIGGER_TTL_MS) return null;
  return lastTrigger.rect;
}

// ── 火花／彩帶 ──────────────────────────────────────────────────────────
type BurstKind = "spark" | "confetti";
const CONFETTI_COLORS = ["#00e5ff", "#00ffa3", "#ffcb5b", "#ff2e88", "#a855ff", "#e8ecf8"];

export function burstAt(x: number, y: number, kind: BurstKind = "spark", color?: string): void {
  if (typeof document === "undefined" || reducedMotion()) return;
  const host = document.createElement("div");
  host.className = `pc-burst pc-burst--${kind}`;
  host.setAttribute("aria-hidden", "true");
  host.style.left = `${Math.round(x)}px`;
  host.style.top = `${Math.round(y)}px`;
  if (color) host.style.setProperty("--burst-c", color);
  const count = kind === "spark" ? 8 : 22;
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("i");
    if (kind === "spark") {
      const angle = (i / count) * Math.PI * 2 + 0.2;
      const dist = 16 + (i % 2) * 7;
      piece.style.setProperty("--dx", `${Math.round(Math.cos(angle) * dist)}px`);
      piece.style.setProperty("--dy", `${Math.round(Math.sin(angle) * dist)}px`);
    } else {
      const spread = (Math.random() - 0.5) * 2;
      piece.style.setProperty("--dx", `${Math.round(spread * 90)}px`);
      piece.style.setProperty("--up", `${Math.round(-40 - Math.random() * 60)}px`);
      piece.style.setProperty("--down", `${Math.round(40 + Math.random() * 70)}px`);
      piece.style.setProperty("--rot", `${Math.round((Math.random() - 0.5) * 720)}deg`);
      piece.style.setProperty("--d", `${Math.round(Math.random() * 90)}ms`);
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    }
    host.appendChild(piece);
  }
  if (kind === "spark") host.appendChild(document.createElement("b"));
  document.body.appendChild(host);
  window.setTimeout(() => host.remove(), kind === "spark" ? 650 : 1500);
}

export function burstFrom(el: Element, kind: BurstKind = "confetti"): void {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  burstAt(r.left + Math.min(r.width / 2, 60), r.top + r.height / 2, kind);
}

/** 任務完成：從那位 NPC 看得到的入口（隊員列、手機 chip）噴彩帶；都看不到就不噴。 */
export function celebrateWorker(workerId: string): void {
  if (typeof document === "undefined") return;
  const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(workerId) : workerId;
  for (const el of document.querySelectorAll(`[data-crew-id="${safe}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && r.bottom > 0 && r.top < innerHeight) {
      burstFrom(el, "confetti");
      el.classList.remove("pc-celebrate");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("pc-celebrate");
      window.setTimeout(() => el.classList.remove("pc-celebrate"), 1200);
      return;
    }
  }
}

// ── 彩蛋 ────────────────────────────────────────────────────────────────
export function playLogoEgg(brand: Element): void {
  if (reducedMotion()) return;
  brand.classList.remove("pc-egg");
  void (brand as HTMLElement).offsetWidth;
  brand.classList.add("pc-egg");
  burstFrom(brand, "confetti");
  window.setTimeout(() => burstFrom(brand, "confetti"), 380);
  window.setTimeout(() => brand.classList.remove("pc-egg"), 2600);
}

// ── 抵達高亮：跳到某個東西時，等它出現、平滑捲到眼前、亮一下 ─────────────
/** 例如「前往核准」：切到那位 NPC 後，等批准卡畫出來，捲到畫面中間並閃一圈。
 *  最多等 1.5 秒；找不到就算了。 */
export function flashArrival(selector: string, within: ParentNode | null = null): void {
  if (typeof document === "undefined") return;
  const started = performance.now();
  const look = () => {
    const el = (within ?? document).querySelector<HTMLElement>(selector);
    if (el && el.getClientRects().length) {
      el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      el.classList.remove("pc-arrive");
      void el.offsetWidth;
      el.classList.add("pc-arrive");
      // 外框閃光放在元素裡的一個暫時 span（元素自己的 ::before/::after 常常已經有用途）。
      el.querySelector(":scope > .pc-arrive-ring")?.remove();
      const ring = document.createElement("span");
      ring.className = "pc-arrive-ring";
      ring.setAttribute("aria-hidden", "true");
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      el.appendChild(ring);
      window.setTimeout(() => { el.classList.remove("pc-arrive"); ring.remove(); }, 1700);
      return;
    }
    if (performance.now() - started < 1500) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

// ── 快捷鍵提示：用滑鼠做了有快捷鍵的事，就在按鈕旁浮出一次 ─────────────────
const hintsSeen = new Set<string>();
const hintStore = {
  has: (id: string) => {
    if (hintsSeen.has(id)) return true;
    try { return sessionStorage.getItem(`pixel-crew:hint:${id}`) === "1"; } catch { return false; }
  },
  add: (id: string) => {
    hintsSeen.add(id);
    try { sessionStorage.setItem(`pixel-crew:hint:${id}`, "1"); } catch { /* 無痕模式 */ }
  },
};

export function showShortcutHint(anchor: Element, id: string, force = false): void {
  if (typeof document === "undefined") return;
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
  const label = shortcutLabel(id, mac);
  if (!label) return;
  if (!force && !takeShortcutHint(id, hintStore)) return;
  const r = anchor.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "pc-kbd-hint";
  bubble.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = t("下次可以按");
  bubble.appendChild(text);
  for (const key of label.split(" ")) {
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    bubble.appendChild(kbd);
  }
  document.body.appendChild(bubble);
  const size = bubble.getBoundingClientRect();
  const place = tipPlacement({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: size.width, height: size.height }, { width: innerWidth, height: innerHeight });
  bubble.style.left = `${place.left}px`;
  bubble.style.top = `${place.top}px`;
  bubble.dataset.side = place.side;
  window.setTimeout(() => bubble.classList.add("pc-kbd-hint--out"), 2600);
  window.setTimeout(() => bubble.remove(), 2900);
}

// ── 安裝 ────────────────────────────────────────────────────────────────
let installed = false;

export function installInteractionFx(): () => void {
  if (installed || typeof document === "undefined") return () => {};
  installed = true;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(type: K, fn: (event: DocumentEventMap[K]) => void, capture = true) => {
    document.addEventListener(type, fn, capture);
    cleanups.push(() => document.removeEventListener(type, fn, capture));
  };

  // 1. 記住按了哪顆；<details> 打開時直接用 summary 當起點。
  // <details> 打開後下一幀、畫面出來之前套上起點；toggle 事件比較晚（下一個
  // task），只當程式打開（頂欄 menuRequest）時的後備。
  const openDetails = (details: HTMLDetailsElement) => {
    const summary = details.querySelector(":scope > summary");
    const panel = details.querySelector<HTMLElement>(`:scope > :is(${POP_SELECTOR})`);
    if (!summary || !panel) return;
    if (performance.now() - Number(panel.dataset.popAt ?? 0) < 300) return;
    panel.dataset.popAt = String(performance.now());
    applyPopOrigin(panel, snapshot(summary));
  };
  on("click", (event) => {
    const target = (event.target as Element | null)?.closest?.(TRIGGER_SELECTOR);
    if (!target) return;
    setPopTrigger(target);
    const details = target.tagName === "SUMMARY" ? target.parentElement : null;
    if (details instanceof HTMLDetailsElement && !details.open) {
      requestAnimationFrame(() => { if (details.open) openDetails(details); });
    }
  });
  on("toggle", (event) => {
    const details = event.target as HTMLDetailsElement;
    if (details instanceof HTMLDetailsElement && details.open) openDetails(details);
  });
  const observer = new MutationObserver((records) => {
    const trigger = freshTrigger();
    if (!trigger) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const hits = node.matches(POP_SELECTOR) ? [node] : Array.from(node.querySelectorAll<HTMLElement>(POP_SELECTOR));
        for (const hit of hits) if (!hit.closest("details:not([open])")) applyPopOrigin(hit, trigger);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => observer.disconnect());

  // 2. 主要按鈕的火花。
  on("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = (event.target as Element | null)?.closest?.(SPARK_SELECTOR) as HTMLButtonElement | null;
    if (!target || target.disabled || target.getAttribute("aria-disabled") === "true") return;
    burstAt(event.clientX, event.clientY, "spark");
  });

  // 3. 延遲浮出的提示框。
  const tip = document.createElement("div");
  tip.className = "pc-tip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);
  cleanups.push(() => tip.remove());
  let tipFor: HTMLElement | null = null;
  let tipTimer = 0;
  let lastHide = 0;
  const restoreTitle = (el: HTMLElement) => {
    const text = el.dataset.pcTitle;
    if (text !== undefined && !el.hasAttribute("title")) el.setAttribute("title", text);
    delete el.dataset.pcTitle;
  };
  const hideTip = () => {
    window.clearTimeout(tipTimer);
    if (tipFor) {
      restoreTitle(tipFor);
      if (tip.dataset.show) lastHide = performance.now();
    }
    tipFor = null;
    delete tip.dataset.show;
  };
  const showTip = (el: HTMLElement, text: string) => {
    if (!el.isConnected || tipFor !== el) return;
    tip.textContent = text;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const size = tip.getBoundingClientRect();
    const place = tipPlacement(snapshot(el), { width: size.width, height: size.height }, { width: innerWidth, height: innerHeight });
    tip.style.left = `${place.left}px`;
    tip.style.top = `${place.top}px`;
    tip.style.setProperty("--tip-x", `${place.arrowX}px`);
    tip.dataset.side = place.side;
    tip.dataset.show = tip.dataset.show === "a" ? "b" : "a";
  };
  on("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const el = (event.target as Element | null)?.closest?.(TIP_SELECTOR) as HTMLElement | null;
    if (!el || el === tipFor) return;
    hideTip();
    const text = el.dataset.tip ?? el.getAttribute("title") ?? "";
    if (!text.trim()) return;
    if (el.hasAttribute("title")) {
      el.dataset.pcTitle = el.getAttribute("title") ?? "";
      el.removeAttribute("title"); // 不然原生 title 會跟著跳出來，兩個提示疊在一起
    }
    tipFor = el;
    const warm = performance.now() - lastHide < TIP_WARM_MS;
    tipTimer = window.setTimeout(() => showTip(el, text), warm ? 0 : TIP_DELAY_MS);
  });
  on("pointerout", (event) => {
    if (!tipFor) return;
    const next = event.relatedTarget as Node | null;
    if (next && tipFor.contains(next)) return;
    hideTip();
  });
  on("pointerdown", hideTip);
  on("keydown", hideTip);
  on("scroll", hideTip);

  // 6. 快捷鍵提示：只算滑鼠／觸控的點擊（detail > 0），鍵盤觸發的不提示。
  on("click", (event) => {
    if (event.detail === 0) return;
    const el = (event.target as Element | null)?.closest?.("[data-shortcut-hint]");
    const id = el?.getAttribute("data-shortcut-hint");
    if (el && id) window.setTimeout(() => { if (el.isConnected) showShortcutHint(el, id); }, 250);
  });

  // 5. 彩蛋：連點 PIXEL CREW 5 下。
  let logoClicks: number[] = [];
  on("click", (event) => {
    const brand = (event.target as Element | null)?.closest?.(".top-bar__brand");
    if (!brand) return;
    const result = clickStreak(logoClicks, performance.now());
    logoClicks = result.times;
    if (result.fired) playLogoEgg(brand);
  });

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    installed = false;
  };
}
