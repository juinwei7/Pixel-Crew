import { useEffect, useRef } from "react";
import * as THREE from "three";
import { encodeQr } from "../qr";

/** 「QR 像素夜城」：QR 的每個暗格＝一棟亮著窗燈的霓虹小高樓（Pixel Crew 天際線的
 *  迷你版），等角視角看是一座夜城，俯瞰時城市街區就是 QR 圖形。
 *  進場動畫：大樓由中心波紋長起、窗燈亮起→夜城停一拍→自動翻轉到正上空「空拍」視角、
 *  街道亮起路燈：透視鏡頭直直往下拍，屋頂對齊格子＝正方可掃 QR，但市中心的高樓牆面
 *  沿放射方向微微露出（樓高市中心最高、越靠邊越矮），看得到高低差與牆上窗燈——掃碼態
 *  仍是同一座立體夜城，不是攤平的色塊。點一下翻回街景逛夜城，再點翻回掃碼。
 *  動畫播完即停 RAF。WebGL 不可用退回 2D 靜態 QR。 */

const ENTER_MS = 1100;
const CITY_HOLD_MS = 250;  // 夜城亮相只停一小拍就翻掃碼態：QR 本體是給人掃的，等太久會不耐
const MORPH_MS = 700;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const backOut = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

const SKY_NIGHT = new THREE.Color("#0a0e1c");
const GROUND_NIGHT = new THREE.Color("#222a3d");
const ROOF_NIGHT = new THREE.Color("#39415e");
const STREET_GLOW = new THREE.Color("#f2f4f8"); // 掃碼態亮格＝中性白街區地面（不帶色偏）
const MODULE_DARK = new THREE.Color("#12172e");
const NEON = new THREE.Color("#37e0c8");

// 大樓側面的窗燈貼圖：深夜牆面＋隨機亮著的琥珀/青色小窗。
function makeWindowTexture(): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = 16; cv.height = 48;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#10162a";
  ctx.fillRect(0, 0, 16, 48);
  let seed = 97;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 2; y < 46; y += 5) {
    for (let x = 2; x < 14; x += 5) {
      const r = rnd();
      if (r < 0.42) ctx.fillStyle = "#ffc46a";
      else if (r < 0.58) ctx.fillStyle = "#7fd8ff";
      else continue;
      ctx.fillRect(x, y, 3, 3);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function pixelTexture(cv: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter; // 不做 mipmap 平均，讓小窗亮點在縮小時仍保留
  tex.generateMipmaps = false;
  return tex;
}

// 定格後暗格的「日間屋頂」：深藍屋頂＋微亮邊框，資料模組再加角落幾扇還亮的小窗。
// 亮窗只放角落、模組中心整片保持純深色，掃碼器的取樣點不會踩到亮點。
function makeRoofDayTexture(withWindows: boolean): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = 16; cv.height = 16;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#111730";
  ctx.fillRect(0, 0, 16, 16);
  // 像素風浮雕：左上受光邊、右下陰影邊——小尺寸下最有效的立體線索
  ctx.fillStyle = "#2e3a66";
  ctx.fillRect(0, 0, 16, 2); ctx.fillRect(0, 2, 2, 14);
  ctx.fillStyle = "#080c1c";
  ctx.fillRect(2, 14, 14, 2); ctx.fillRect(14, 2, 2, 12);
  if (withWindows) {
    // 窗燈只留色相、亮度壓在 40%：俯角視圖下實測再亮就會干擾放大掃描的二值化
    ctx.fillStyle = "#4f3819"; ctx.fillRect(2, 2, 3, 3);
    ctx.fillStyle = "#13454b"; ctx.fillRect(11, 2, 3, 3);
    ctx.fillStyle = "#382b15"; ctx.fillRect(2, 11, 3, 3);
  }
  return pixelTexture(cv);
}

// 掃碼態亮格的「街區地面」：中性近白、每格深淺微差（廣場/路面/停車場的質感），
// 不畫格線——整面格線會看起來像方格紙而不是城市。亮度全 >0.9，二值化仍是亮格。
function makeStreetTexture(totalCells: number): THREE.Texture {
  const cv = document.createElement("canvas");
  const u = 4;
  cv.width = cv.height = totalCells * u;
  const ctx = cv.getContext("2d")!;
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shades = ["#f4f6f9", "#eef1f6", "#f7f8fb", "#f0f3f8"];
  for (let r = 0; r < totalCells; r++)
    for (let c = 0; c < totalCells; c++) {
      ctx.fillStyle = shades[(rnd() * shades.length) | 0];
      ctx.fillRect(c * u, r * u, u, u);
    }
  return pixelTexture(cv);
}

export function QrTree({ text, px = 150 }: { text: string; px?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mods = encodeQr(text);
    if (!mods) return; // 網址過長：不顯示（呼叫端仍可複製連結）

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      draw2dFallback(host, mods, px);
      return;
    }
    const n = mods.length;
    const cell = 2 / n;              // QR 區佔 [-1,1]
    const sB = 1 + 4 * cell;         // 底座外緣＝安靜區
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(px, px);
    renderer.setClearColor(SKY_NIGHT, 1);
    renderer.domElement.style.borderRadius = "10px";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "pointer";
    renderer.domElement.setAttribute("data-qr", "1");
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 30); // 透視：空拍時牆面放射微露＝立體感
    const amb = new THREE.AmbientLight(0xffffff, 0.62);
    const sun = new THREE.DirectionalLight(0x9fb8ff, 0.85); // 夜城月光偏藍
    sun.position.set(2.5, 4, 1.5);
    scene.add(amb, sun);

    let seed = 20260827;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    // === 地面（夜間柏油 → 攤平變白紙）===
    const baseH = 0.1;
    const baseMat = new THREE.MeshLambertMaterial({ color: GROUND_NIGHT.clone() });
    const baseGeo = new THREE.BoxGeometry(sB * 2, baseH, sB * 2);
    const base: THREE.Mesh = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = -baseH / 2;
    scene.add(base);
    // 廣場邊緣的霓虹燈帶（攤平時熄滅，不吃安靜區）
    const neonMat = new THREE.MeshBasicMaterial({ color: NEON, transparent: true, opacity: 0.9 });
    const strips: THREE.Mesh[] = [];
    const sw = cell * 0.5;
    for (let k = 0; k < 4; k++) {
      const horiz = k < 2;
      const g = new THREE.BoxGeometry(horiz ? sB * 2 : sw, 0.015, horiz ? sw : sB * 2);
      const m = new THREE.Mesh(g, neonMat);
      const off = sB - sw / 2;
      m.position.set(horiz ? 0 : (k === 2 ? -off : off), 0.008, horiz ? (k === 0 ? -off : off) : 0);
      strips.push(m);
      scene.add(m);
    }

    // === 大樓：每個暗格一棟 ===
    const inFinder = (r: number, c: number) =>
      (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    // 掃描器賴以定位的模組（定位角、時序線、對位點）定格後屋頂必須純深色；
    // 實測這些模組混進亮窗會讓放大掃描的定位失敗，亮窗只留給一般資料模組。
    const isAnchor = (r: number, c: number) =>
      inFinder(r, c) || r === 6 || c === 6 ||
      (r >= n - 9 && r <= n - 5 && c >= n - 9 && c <= n - 5);
    const dark: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (mods[r][c] && isAnchor(r, c)) dark.push([r, c]);
    const P = dark.length; // 前 P 棟＝定位模組（日間無亮窗）
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (mods[r][c] && !isAnchor(r, c)) dark.push([r, c]);
    const N = dark.length;
    const winTex = makeWindowTexture();
    const sideMat = new THREE.MeshBasicMaterial({ map: winTex }); // 自發光窗燈（貼圖不透明，不必進透明排序）
    const roofMat = new THREE.MeshLambertMaterial({ color: ROOF_NIGHT.clone() });
    const botMat = new THREE.MeshBasicMaterial({ color: 0x0c1020 });
    // 定格用的日間材質：不受光照、顏色精準，掃描對比可控
    const roofDayTex = makeRoofDayTexture(true);
    const roofDayMat = new THREE.MeshBasicMaterial({ map: roofDayTex });
    const roofDayPlainTex = makeRoofDayTexture(false);
    const roofDayPlainMat = new THREE.MeshBasicMaterial({ map: roofDayPlainTex });
    const streetTex = makeStreetTexture(n + 8);
    const baseDayMat = new THREE.MeshBasicMaterial({ map: streetTex });
    // BoxGeometry 面順序：+x -x +y -y +z -z
    const bGeo = new THREE.BoxGeometry(cell * 0.88, 1, cell * 0.88); // 高度用 scaleY 控
    // 拆兩組：定位模組（日間純深屋頂）與資料模組（日間亮窗屋頂），夜間材質共用
    const anchorBld = new THREE.InstancedMesh(bGeo, [sideMat, sideMat, roofMat, botMat, sideMat, sideMat], P);
    const dataBld = new THREE.InstancedMesh(bGeo, [sideMat, sideMat, roofMat, botMat, sideMat, sideMat], N - P);
    scene.add(anchorBld, dataBld);
    // 每棟資料樓屋頂深淺略異：像真實街區而非複製方塊（暗格亮度仍壓在深色域，不影響二值化）
    const tint = new THREE.Color();
    for (let i = 0; i < N - P; i++) {
      const v = 0.85 + ((i * 2654435761) % 97) / 97 * 0.35;
      dataBld.setColorAt(i, tint.setRGB(v, v, Math.min(1.25, v * 1.06)));
    }
    const bx = new Float32Array(N), bz = new Float32Array(N), bh = new Float32Array(N), bDelay = new Float32Array(N);
    const towers: number[] = []; // 高塔（配天線）
    for (let i = 0; i < N; i++) {
      const [r, c] = dark[i];
      bx[i] = -1 + (c + 0.5) * cell;
      bz[i] = -1 + (r + 0.5) * cell;
      if (inFinder(r, c)) bh[i] = 0.34; // 定位角＝整齊的環狀街廓，俯瞰就是回字
      else {
        const t = rnd();
        bh[i] = t < 0.06 ? 0.5 + rnd() * 0.16 : 0.1 + rnd() * 0.26;
        if (bh[i] > 0.5) towers.push(i);
      }
      bDelay[i] = (Math.hypot(bx[i], bz[i]) / Math.SQRT2) * 0.55 + rnd() * 0.1;
    }
    // 掃碼態樓高＝「市中心天際線」：越靠中心越高（立體感來源），越靠邊越矮。
    // 透視下牆面放射位移 ∝ 樓高×離軸半徑，邊緣的定位圖形必須幾乎零位移掃描才穩；
    // 定位/時序模組一律最矮最整齊。
    const dayH = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = Math.hypot(bx[i], bz[i]);
      const core = Math.max(0, 1 - r / 0.9);
      dayH[i] = i < P ? 0.055 : 0.07 + bh[i] * 0.12 + core * core * 0.3;
    }
    // 高塔天線：細桿＋跟大樓一起長、翻掃碼態時收回
    const antGeo = new THREE.BoxGeometry(cell * 0.1, 1, cell * 0.1);
    const antMat = new THREE.MeshBasicMaterial({ color: 0x8fa3c8 });
    const ants = new THREE.InstancedMesh(antGeo, antMat, Math.max(1, towers.length));
    scene.add(ants);

    // === 鏡頭 ===
    const isoDir = new THREE.Vector3(1, 0.9, 1).normalize();
    const topDir = new THREE.Vector3(0, 1, 0); // 掃碼態＝正上空垂直空拍：屋頂陣列對齊格子＝正方 QR
    const upIso = new THREE.Vector3(0, 1, 0);
    const upTop = new THREE.Vector3(0, 0, -1);
    const ISO_VIEW = 1.5, FLAT_VIEW = sB + cell * 0.8; // 多留邊：透視下高樓屋頂向外放射位移
    const dir = new THREE.Vector3(), up = new THREE.Vector3();
    let azim = 0; // 街景態拖曳環繞的方位角；掃碼態乘 (1-e) 歸零＝QR 永遠正對格線
    function setCamera(f: number) {
      const e = easeInOut(f);
      dir.copy(isoDir).applyAxisAngle(upIso, azim * (1 - e)).lerp(topDir, e).normalize();
      up.copy(upIso).lerp(upTop, e).normalize();
      const D = 6 - 1.2 * e; // 掃碼態鏡頭略降：透視露出牆面但不讓市中心糊成一團
      cam.position.copy(dir).multiplyScalar(D);
      cam.up.copy(up);
      cam.lookAt(0, 0.14 * (1 - e), 0);
      const half = ISO_VIEW + (FLAT_VIEW - ISO_VIEW) * e;
      cam.fov = (2 * Math.atan(half / D) * 180) / Math.PI;
      cam.updateProjectionMatrix();
    }

    const dummy = new THREE.Object3D();
    let dayOn = false;
    function layout(enterT: number, F: number) {
      const e = easeInOut(F);
      for (let i = 0; i < N; i++) {
        const p = clamp01((enterT - bDelay[i]) / 0.35);
        const rise = enterT >= 1 ? 1 : Math.max(0.0001, backOut(p));
        const h = (bh[i] * rise) * (1 - e) + dayH[i] * e; // 翻轉時過渡到天際線核心＋邊緣矮樓
        dummy.position.set(bx[i], h / 2, bz[i]);
        const sxz = 1 + (1 / 0.88 - 1) * e; // 掃碼態補滿格距：相鄰暗格無縫，避免亮縫變中間調干擾掃描
        dummy.scale.set(sxz, h, sxz);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        if (i < P) anchorBld.setMatrixAt(i, dummy.matrix);
        else dataBld.setMatrixAt(i - P, dummy.matrix);
      }
      anchorBld.instanceMatrix.needsUpdate = true;
      dataBld.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < towers.length; k++) {
        const i = towers[k];
        const p = clamp01((enterT - bDelay[i]) / 0.35);
        const rise = enterT >= 1 ? 1 : Math.max(0.0001, backOut(p));
        const bTop = (bh[i] * rise) * (1 - e) + dayH[i] * e;
        const ah = 0.12 * rise * (1 - e) + 0.0001;
        dummy.position.set(bx[i], bTop + ah / 2, bz[i]);
        dummy.scale.set(1, ah, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        ants.setMatrixAt(k, dummy.matrix);
      }
      ants.instanceMatrix.needsUpdate = true;
      // 翻轉時城市不變裝：牆面窗燈常亮（正上方看不到牆，過場中仍是夜城）、天線收回、
      // 街道亮起路燈（底色漸亮，翻到頂換成發光街道貼圖）、背景維持夜空
      antMat.opacity = 1 - e;
      antMat.transparent = true;
      roofMat.color.copy(ROOF_NIGHT).lerp(MODULE_DARK, e);
      baseMat.color.copy(GROUND_NIGHT).lerp(STREET_GLOW, e);
      // 翻轉近尾聲換成掃碼貼圖材質（屋頂窗燈＋街道格線）；翻回時換回夜間材質
      const day = e >= 0.96;
      if (day !== dayOn) {
        dayOn = day;
        (anchorBld.material as THREE.Material[])[2] = day ? roofDayPlainMat : roofMat;
        (dataBld.material as THREE.Material[])[2] = day ? roofDayMat : roofMat;
        base.material = day ? baseDayMat : baseMat;
      }
      // 霓虹：翻轉時稍暗，掃碼態重亮為外框（位於安靜區外緣，掃描器容忍彩色外框）
      neonMat.opacity = 0.9 * (1 - e) * (enterT >= 1 ? 1 : easeOut(clamp01(enterT * 2))) + 0.55 * clamp01((e - 0.9) / 0.1);
      amb.intensity = 0.62 + 0.68 * e;
      sun.intensity = 0.85 * (1 - e);
      setCamera(F);
    }

    // === 狀態機：進場長出夜城→停一拍自動翻轉成掃碼態；點一下翻回街景，再點翻回掃碼 ===
    let raf = 0, running = false;
    const enterStart = performance.now();
    let F = 0, target = 0, morphFrom = 0, morphStart = 0;

    function frame(now: number) {
      const enterT = clamp01((now - enterStart) / ENTER_MS);
      const mp = clamp01((now - morphStart) / MORPH_MS);
      F = morphFrom + (target - morphFrom) * mp;
      layout(enterT, F);
      renderer.render(scene, cam);
      if (enterT < 1 || mp < 1) raf = requestAnimationFrame(frame);
      else running = false;
    }
    const kick = () => { if (!running) { running = true; raf = requestAnimationFrame(frame); } };
    kick();

    const toggle = () => {
      window.clearTimeout(autoFlip);
      target = target === 1 ? 0 : 1;
      morphFrom = F; morphStart = performance.now();
      kick();
    };
    // 夜城亮相停一拍後自動翻轉成可掃碼；使用者先點擊/拖曳就交還手動控制
    const autoFlip = window.setTimeout(toggle, ENTER_MS + CITY_HOLD_MS);
    // 拖曳＝環繞夜城（水平轉一圈看街景）；位移沒超過門檻的放開才算點擊＝翻面
    const el = renderer.domElement;
    el.style.touchAction = "none"; // 手機上拖曳轉城，不觸發頁面捲動
    let dragging = false, movedPx = 0, lastX = 0;
    const onDown = (ev: PointerEvent) => {
      dragging = true; movedPx = 0; lastX = ev.clientX;
      try { el.setPointerCapture(ev.pointerId); } catch { /* 合成事件無作用中 pointer */ }
    };
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      movedPx += Math.abs(dx);
      if (movedPx < 5) return;               // 門檻內仍視為點擊
      window.clearTimeout(autoFlip);          // 使用者開始逛街景就不自動翻面
      azim -= dx * 0.012;
      kick();                                 // 動畫已停時逐事件重繪一幀（不開常駐 RAF）
    };
    const onUp = (ev: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(ev.pointerId); } catch { /* 同上 */ }
      if (movedPx < 5) toggle();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(autoFlip);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      baseGeo.dispose(); baseMat.dispose(); bGeo.dispose(); antGeo.dispose();
      sideMat.dispose(); roofMat.dispose(); botMat.dispose(); antMat.dispose();
      roofDayMat.dispose(); baseDayMat.dispose(); roofDayTex.dispose(); streetTex.dispose();
      roofDayPlainMat.dispose(); roofDayPlainTex.dispose();
      neonMat.dispose(); winTex.dispose();
      strips.forEach((s) => s.geometry.dispose());
      renderer.dispose();
      renderer.forceContextLoss(); // modal 反覆開關不累積 WebGL context（瀏覽器同時上限約 16 個）
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, [text, px]);

  return (
    <div
      ref={hostRef}
      style={{ width: px, height: px, margin: "0 auto", borderRadius: 10, overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,.4)" }}
    />
  );
}

// WebGL 不可用時：把 module 矩陣畫到 2D canvas（靜態、仍可掃）。
function draw2dFallback(host: HTMLDivElement, mods: boolean[][], px: number) {
  const n = mods.length, quiet = 4, total = n + quiet * 2;
  const cv = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = px * dpr; cv.height = px * dpr;
  cv.style.width = cv.style.height = `${px}px`;
  cv.style.borderRadius = "10px";
  const ctx = cv.getContext("2d");
  if (ctx) {
    const u = (px * dpr) / total;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#0a0a0a";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (mods[r][c]) ctx.fillRect((c + quiet) * u, (r + quiet) * u, u + 0.5, u + 0.5);
  }
  host.appendChild(cv);
}
