// 現代主題的 3D 娃娃屋場景（模擬人生風）。從 sims-real.html 原型移植成可掛載的控制器。
// 只在 theme==="modern" 時由 Office3D.tsx 動態載入，故 three.js 不會進到像素風的包。
// 對外提供 createOfficeScene()，回傳可 setWorkers / setActive / resize / dispose 的控制器。
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";

export type WorkerLite = {
  id: string;
  name: string;
  busy: boolean;
  departmentId?: string | null;
  departmentLabel?: string | null;
  colorIndex: number;
  station?: string;  // 目前活動站點（home/terminal/code/books/web/check/board/meeting）＝NPC 該走去哪
  activity?: string; // idle/walking/working/thinking（僅用於挑動畫）
  speech?: string;   // 即時任務/狀態文字＝工作小窗要顯示的真內容
  mood?: "neutral" | "success" | "error"; // 小窗狀態燈顏色
  webQuery?: string; // 上網查的查詢字/網址＝小窗抓真實瀏覽器截圖用（Tier 3）
};

export type OfficeSceneOptions = {
  canvas: HTMLCanvasElement;
  onSelect?: (id: string) => void;
  onExpand?: (id: string) => void; // 點頭頂工作小窗＝選取＋展開焦點大螢幕
  quality?: "high" | "low"; // low = 手機省效能（關陰影、降解析度）
};

export type OfficeSceneController = {
  setWorkers: (workers: WorkerLite[]) => void;
  setActive: (id: string | null) => void;
  resize: () => void;
  dispose: () => void;
};

const BASE = import.meta.env.BASE_URL || "/";
const CHAR_FILES = ["suit_f", "worker_f", "woman1", "woman2", "punk"];
const IDLE_CLIPS = ["Idle_Neutral", "Idle", "Interact", "Wave"];
const BUSY_CLIPS = ["Interact", "Wave", "Idle_Neutral"];

// ---- 動態隔間排布參數（脊椎式中央走廊佈局）----
// 每個 departmentId 排成一間獨立房間：桌貼近鏡頭側、角色坐桌後面向鏡頭；房內桌數超過 ROOM_COLS 往後疊一排。
// 房間分列中央走廊左右兩欄、由前(入口)往後排，房寬房深統一，門開在走廊側牆，作戰室封走廊底端。
const ROOM_COLS = 3;       // 一間房一排最多幾張桌
const DESK_PITCH = 2.2;    // 同排相鄰桌間距（拉開＝坐下互動有肘部呼吸感）
const ROW_PITCH = 2.6;     // 房內多排的排距（拉開＝前後排不貼背）
const DESK_W = 1.5;        // 單張桌縮放目標
const ROOM_PAD_X = 1.0;    // 房間左右內邊
const ROOM_BACK = 0.95;    // 最後排桌到後牆
const ROOM_FRONT = 1.05;   // 最前排桌到前牆（門那側）
const SEAT_BACK = 0.92;    // 座位在桌「後方」多遠（角色面向鏡頭）
const CORRIDOR_W = 2.6;    // 中央主走廊寬（脊椎式佈局：房間分列走廊兩側）
const DOOR_W = 1.7;        // 房門洞寬（開在走廊側牆）
const LOT_MARGIN = 2.0;    // 房間群到建物外圍地坪的邊距（後／左右）
const FRONT_MARGIN = 5.2;  // 前庭（查東西活動站廣場）深度：比側邊深很多，給互動熱點大留白
const ROOM_SPARE = 2;      // 每間房多留幾張空工位（桌＋椅），新增 NPC 一來就有空位可自動入座

type Actor = {
  id: string;
  name: string;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  pb: THREE.Mesh;
  label: THREE.Sprite;
  shadow: THREE.Mesh;
  phase: number;
  gltfAnimations: THREE.AnimationClip[];
  busy: boolean;
  baseAction: THREE.AnimationAction | null;
  walkAction: THREE.AnimationAction | null;
  state: "home" | "toWander" | "atWander" | "toHome";
  home: { x: number; z: number };
  target: { x: number; z: number } | null;
  path: { x: number; z: number }[];   // 剩餘路徑點（沿走廊/門，逐點走完）
  returnAt: number;
  emoting: boolean;
  bubble: THREE.Sprite;
  bubbleUntil: number;
  visitHost: string | null; // 這趟外出若是去找某同事聊天，記其 id；抵達時兩人互相打招呼
  reported: boolean;        // 臨時 NPC（🔍研究員/🏛圓桌）查完是否已走去 host 回報過（只做一次）
  stationKey: string;       // 目前指派站位的識別（站點+座標）；變了才重新走過去
  homeRy: number;           // 抵達 home/站位後要面向的角度
  lastDist?: number;        // 卡住自癒：朝目前 target 的最近距離；正常追擊會單調變小
  stuckSince?: number;      // 上次「有靠近」的時間戳；持續沒進展超過門檻＝死結，瞬移收尾
  // 工作小窗（SAMS 風）：忙碌站定工作時頭上浮出的螢幕面板，顯示站點主題＋即時任務文字。
  panel: THREE.Sprite;      // canvas 貼圖的 billboard 面板（永遠面向鏡頭）
  panelTex: THREE.CanvasTexture;
  panelCtx: CanvasRenderingContext2D;
  panelVis: number;         // 目前淡入淡出的不透明度
  panelKey: string;         // 上次繪製內容的識別，變了才重畫（免每幀重繪）
  station?: string;         // 目前站點（挑小窗主題用）
  speech?: string;          // 目前任務文字
  mood?: "neutral" | "success" | "error";
  webQuery?: string;        // 上網查的查詢字＝抓真實瀏覽器截圖用
  stickyWebQuery?: string;  // 黏著用：最後一次上網查的查詢字
  webUntil?: number;        // 黏著到此時間戳（ms）＝角色切走後仍續留 web 截圖，讓結果補上來
  doneUntil?: number;       // >0＝剛完成，小窗顯示「✓ 完成」直到此時間戳（報告用）
};

export async function createOfficeScene(opts: OfficeSceneOptions): Promise<OfficeSceneController> {
  const { canvas, onSelect, onExpand } = opts;
  const low = opts.quality === "low";

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, alpha: true, powerPreference: "high-performance" });
  const RES_SCALE = 1;                                            // 內部渲染解析度縮放（1＝全解析度）。降低可省 GPU 但畫面變柔，使用者偏好畫質，維持 1
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * RES_SCALE);
  renderer.shadowMap.enabled = !low;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;   // 不每幀重算陰影，改由動畫迴圈每兩幀手動觸發（15fps 陰影，NPC 慢走肉眼無感）
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;

  const scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // 正交等角相機（俯角35° / 方位45°）
  const EL = THREE.MathUtils.degToRad(35);
  const R = 40;
  const TARGET = new THREE.Vector3(0, 0.8, 0);
  let D = 7.6;
  let az = Math.PI * 0.25;
  let azTarget = az;
  const cam = new THREE.OrthographicCamera(-D, D, D, -D, 0.1, 120);
  function placeCam() {
    cam.position.set(
      TARGET.x + R * Math.cos(EL) * Math.sin(az),
      TARGET.y + R * Math.sin(EL),
      TARGET.z + R * Math.cos(EL) * Math.cos(az),
    );
    cam.lookAt(TARGET);
  }
  placeCam();
  // 接地陰影用：layer 1＝「不投接地陰影」的物件（地面/大地坪/天空/灰塵/blob/名牌/浮牌/泡泡/選取環/接影平面）。
  // 主相機同時看 layer 0＋1（照常全看），朝下的接影相機只看 layer 0，故上述物件不會在半空投出鬼影。
  cam.layers.enable(1);
  const noCast = (o: THREE.Object3D) => o.traverse((c) => c.layers.set(1));

  // 光
  const hemi = new THREE.HemisphereLight(0xfff2da, 0xbfa98c, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe9c4, 2.1);
  key.position.set(7, 13, 6);
  key.castShadow = !low;
  key.shadow.mapSize.set(1024, 1024);   // 1024 已足夠（俯視鏡頭），比 2048 省 4 倍陰影填充
  const sc = key.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 54;
  key.shadow.bias = -0.0004; key.shadow.radius = 6;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.28);
  fill.position.set(-6, 4, -4);
  scene.add(fill);

  // 漸層天空：一顆大半球罩，垂直漸層（頂→地平），顏色隨日夜連續 lerp。取代原本透明底，
  // 讓遠景城市大樓後面有真正的天空。靜態掛在 scene（不隨佈局重建），BackSide、不寫深度。
  const skyUni = {
    topColor: { value: new THREE.Color(0x8fbce8) },
    botColor: { value: new THREE.Color(0xdfeaf3) },
  };
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(80, 24, 12),
    new THREE.ShaderMaterial({
      uniforms: skyUni,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 topColor; uniform vec3 botColor; varying vec3 vDir;
        void main(){ float t = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0); t = pow(t, 0.7);
        gl_FragColor = vec4(mix(botColor, topColor, t), 1.0); }`,
    }),
  );
  skyDome.renderOrder = -1;
  noCast(skyDome);
  scene.add(skyDome);
  const daySkyTop = new THREE.Color(0x8fbce8), ngtSkyTop = new THREE.Color(0x0d1430);
  const daySkyBot = new THREE.Color(0xdfeaf3), ngtSkyBot = new THREE.Color(0x2a3654);

  // 日夜光影：沿用像素風的真實時鐘關鍵影格（night 0~1），連續調光強/色溫/曝光，
  // 讓 3D 現代主題和像素風同一個白天/黃昏/夜晚。室內不打死黑，夜晚只轉冷變暗維持可讀。
  const DAY_NIGHT: Array<[number, number]> = [[0, 1], [5, 1], [6.5, 0], [9, 0], [17, 0], [18.5, 0], [20, 1], [24, 1]];
  function nightFactor(h: number): number {
    let p = DAY_NIGHT[0];
    for (const k of DAY_NIGHT) { if (h <= k[0]) { const t = k[0] === p[0] ? 0 : (h - p[0]) / (k[0] - p[0]); return p[1] + (k[1] - p[1]) * t; } p = k; }
    return 1;
  }
  // 夜燈（落地燈＋外圍路燈）：夜晚才亮，佈局重建時重掛，intensity 依 userData.max 縮放。
  const lampLights: THREE.PointLight[] = [];
  let clockHour: THREE.Object3D | null = null, clockMin: THREE.Object3D | null = null; // 牆上時鐘指針樞紐（跟真實時間）
  function setClockHands() {
    if (!clockHour || !clockMin) return;
    const d = new Date(), m = d.getMinutes(), h = d.getHours() % 12;
    clockMin.rotation.z = -(m / 60) * Math.PI * 2;
    clockHour.rotation.z = -((h + m / 60) / 12) * Math.PI * 2;
  }
  const dayKeyC = new THREE.Color(0xffe9c4), ngtKeyC = new THREE.Color(0xaec4f0);
  const dayHemiS = new THREE.Color(0xfff2da), ngtHemiS = new THREE.Color(0x9fb0d0);
  const dayHemiG = new THREE.Color(0xbfa98c), ngtHemiG = new THREE.Color(0x5a5f70);
  function applyDaylight() {
    const now = new Date();
    const f = nightFactor(now.getHours() + now.getMinutes() / 60);
    key.intensity = 2.1 + (0.85 - 2.1) * f;
    key.color.copy(dayKeyC).lerp(ngtKeyC, f);
    hemi.intensity = 0.55 + (0.38 - 0.55) * f;
    hemi.color.copy(dayHemiS).lerp(ngtHemiS, f);
    hemi.groundColor.copy(dayHemiG).lerp(ngtHemiG, f);
    renderer.toneMappingExposure = 0.82 + (0.66 - 0.82) * f;
    skyUni.topColor.value.copy(daySkyTop).lerp(ngtSkyTop, f);
    skyUni.botColor.value.copy(daySkyBot).lerp(ngtSkyBot, f);
    for (const L of lampLights) L.intensity = f * (L.userData.max as number);
    setClockHands();
  }
  applyDaylight();

  // 後製：低效能裝置維持直出（省效能、行為不變）；否則走 EffectComposer。管線：
  //   SSAOPass（自己 render 場景＋環境光遮蔽，材質已套 ACES tone mapping → tonemapped-linear）
  //   → UnrealBloomPass（門檻式輝光，只有很亮的像素＝夜燈/螢幕/高光才發光）
  //   → SMAA 抗鋸齒（composer 會停掉 MSAA，必須自己補）
  //   → 最後一道自訂 pass 做色彩分級＋暗角＋線性轉 sRGB（分級固定，不隨日夜，維持電影感）。
  let composer: EffectComposer | null = null;
  let smaaPass: SMAAPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  if (!low) {
    composer = new EffectComposer(renderer);
    // SSAO 已移除：俯視正交視角下環境光遮蔽貢獻小，卻是單幀最貴的 pass（多渲染一次場景），
    // 由 RenderPass 直接出場景，接地陰影＋真陰影已提供立體感。
    composer.addPass(new RenderPass(scene, cam));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.5, 0.82);
    composer.addPass(bloomPass);
    smaaPass = new SMAAPass(1, 1);
    composer.addPass(smaaPass);
    const gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        gain: { value: new THREE.Vector3(1.05, 1.01, 0.96) },
        lift: { value: new THREE.Vector3(0.004, 0.0, 0.012) },
        saturation: { value: 1.12 },
        vignette: { value: 1.15 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 gain; uniform vec3 lift;
        uniform float saturation; uniform float vignette; varying vec2 vUv;
        vec3 lin2srgb(vec3 c){ return mix(c*12.92, 1.055*pow(clamp(c,0.0,1.0),vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
        void main(){
          vec4 src = texture2D(tDiffuse, vUv);
          vec3 col = src.rgb * gain + lift;
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, saturation);
          vec2 d = vUv - 0.5;
          float v = smoothstep(0.85, 0.25, length(d) * vignette);
          col *= mix(1.0, v, 0.55);
          gl_FragColor = vec4(lin2srgb(col), src.a);
        }`,
    });
    composer.addPass(gradePass);
  }

  const disposables: { dispose: () => void }[] = [];
  function track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T {
    disposables.push(x as unknown as { dispose: () => void });
    return x;
  }

  // 工具
  const mm = (color: number, o?: THREE.MeshStandardMaterialParameters) =>
    track(new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0 }, o || {})));
  function box(w: number, h: number, d: number, mat: THREE.Material) {
    const x = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat);
    x.castShadow = true; x.receiveShadow = true; return x;
  }
  function bat(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
    const b = box(w, h, d, mat); b.position.set(x, y, z); return b;
  }
  function rmesh(w: number, h: number, d: number, mat: THREE.Material, r?: number) {
    const rr = Math.min(r ?? Math.min(w, h, d) * 0.18, Math.min(w, h, d) / 2 - 0.001);
    const g = new THREE.Mesh(track(new RoundedBoxGeometry(w, h, d, 3, rr)), mat);
    g.castShadow = true; g.receiveShadow = true; return g;
  }
  function rat(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, r?: number) {
    const b = rmesh(w, h, d, mat, r); b.position.set(x, y, z); return b;
  }
  function cyl(rt: number, rb: number, h: number, seg: number, mat: THREE.Material) {
    const c = new THREE.Mesh(track(new THREE.CylinderGeometry(rt, rb, h, seg)), mat);
    c.castShadow = true; c.receiveShadow = true; return c;
  }
  const world = new THREE.Group();
  scene.add(world);

  // 佈局是隨名冊重建的：所有動態物件（房間牆/地板/桌椅/路燈/外圍/招牌）都掛進 world 並登記在
  // layoutObjects，重建時整批移除、dispose 自建幾何（GLB 複製體標記 keepGeo 只移除不 dispose，
  // 因其幾何與來源共用）。材質/貼圖多為共用，故只 dispose 幾何避免誤傷。
  const layoutObjects: THREE.Object3D[] = [];
  function add<T extends THREE.Object3D>(o: T): T { world.add(o); layoutObjects.push(o); return o; }
  function disposeObj(o: THREE.Object3D) {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if ((m.userData && m.userData.keepGeo) || !m.isMesh) return;
      if (m.geometry && typeof m.geometry.dispose === "function") m.geometry.dispose();
    });
  }

  // 貼圖
  function makeTex(draw: (ctx: CanvasRenderingContext2D, s: number) => void, rep: number) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    draw(c.getContext("2d")!, 128);
    const tx = track(new THREE.CanvasTexture(c));
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(rep, rep); tx.anisotropy = 4; return tx;
  }
  const woodTex = (base: string, rep: number) => makeTex((x, s) => {
    x.fillStyle = base; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 4; i++) {
      const y = i * s / 4;
      x.strokeStyle = "rgba(110,75,40,.35)"; x.lineWidth = 2; x.beginPath(); x.moveTo(0, y); x.lineTo(s, y); x.stroke();
      x.fillStyle = "rgba(150,110,70,.18)";
      for (let k = 0; k < 7; k++) x.fillRect(Math.random() * s, y + 3 + Math.random() * (s / 4 - 6), 10 + Math.random() * 24, 1);
    }
  }, rep);
  const tileTex = (a: string, b: string, rep: number) => makeTex((x, s) => {
    x.fillStyle = a; x.fillRect(0, 0, s, s); x.fillStyle = b; x.fillRect(0, 0, s / 2, s / 2); x.fillRect(s / 2, s / 2, s / 2, s / 2);
    x.strokeStyle = "rgba(255,255,255,.45)"; x.lineWidth = 3;
    for (const p of [[0, 0], [s / 2, 0], [0, s / 2], [s / 2, s / 2]]) x.strokeRect(p[0], p[1], s / 2, s / 2);
  }, rep);
  const carpetTex = (base: string, rep: number) => makeTex((x, s) => {
    x.fillStyle = base; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) { x.fillStyle = "rgba(0,0,0," + (Math.random() * 0.05) + ")"; x.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
  }, rep);
  const paperTex = (base: string, rep: number) => makeTex((x, s) => {
    x.fillStyle = base; x.fillRect(0, 0, s, s); x.fillStyle = "rgba(255,255,255,.10)";
    for (let i = 0; i < s; i += 18) x.fillRect(i, 0, 9, s);
  }, rep);

  // 接地陰影
  const blobTex = makeTex((x, s) => {
    const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(50,35,18,.42)"); g.addColorStop(1, "rgba(50,35,18,0)");
    x.fillStyle = g; x.fillRect(0, 0, s, s);
  }, 1);
  // 非 low 走真接地陰影渲染，blob 全隱藏（opacity 0）；low 維持 blob 當接地陰影。
  const blobMat = track(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: low ? 1 : 0, depthWrite: false }));
  // 角色接地陰影：共用一份 geometry / material（不隨重建配置，免洩漏），每個角色掛一片跟著腳走
  const charBlobGeo = track(new THREE.PlaneGeometry(0.5, 0.5));
  const charBlobMat = track(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: low ? 0.75 : 0, depthWrite: false }));
  function blob(x: number, z: number, w: number, d?: number) {
    const p = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d || w)), blobMat);
    p.rotation.x = -Math.PI / 2; p.position.set(x, 0.085, z); p.renderOrder = 1; noCast(p); add(p); return p;
  }

  // 灰塵微粒：整個空間漂浮的細小亮點，加性混合、隨光緩慢上飄，給空氣感（不隨佈局重建，靜態掛 scene）。
  const DUST_N = 160, DUST_R = 13, DUST_H = 6;
  const dustTex = makeTex((x, s) => {
    const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.4, "rgba(255,250,235,.5)"); g.addColorStop(1, "rgba(255,250,235,0)");
    x.fillStyle = g; x.fillRect(0, 0, s, s);
  }, 1);
  const dustPos = new Float32Array(DUST_N * 3);
  const dustVel = new Float32Array(DUST_N);
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = (Math.random() * 2 - 1) * DUST_R;
    dustPos[i * 3 + 1] = Math.random() * DUST_H + 0.4;
    dustPos[i * 3 + 2] = (Math.random() * 2 - 1) * DUST_R;
    dustVel[i] = 0.05 + Math.random() * 0.12;
  }
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, track(new THREE.PointsMaterial({
    map: dustTex, size: 0.055, transparent: true, opacity: 0.5, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  })));
  dust.frustumCulled = false;
  noCast(dust);
  scene.add(dust);

  // 電影級接地陰影：一台朝下正交相機把「會投影的實體」(角色/傢俱/薄牆＝layer 0) 用純黑 override 渲到白底 RT，
  // 其餘 layer 1 物件（地面/天空/灰塵/名牌/浮牌/泡泡/選取環/blob）跳過不投；再水平＋垂直高斯模糊成柔影，
  // 投到地面一張透明平面上——平面在片段著色器裡把世界座標投回接影相機的 uv 取樣，免手動對齊。
  // 只非 low 啟用；每幀多一次「純色 override＋不更新陰影貼圖」的淺渲染＋兩道全螢幕模糊（桌機可接受）。
  let updateContactShadow: (() => void) | null = null;
  let csDispose: (() => void) | null = null;
  if (!low) {
    const CS_R = 16, CS_H = 3.4, CS_SIZE = 512, CS_DARK = 0.62, CS_BLUR = 1.4;
    const csRT = new THREE.WebGLRenderTarget(CS_SIZE, CS_SIZE);
    const csBlurRT = new THREE.WebGLRenderTarget(CS_SIZE, CS_SIZE);
    const csCam = new THREE.OrthographicCamera(-CS_R, CS_R, CS_R, -CS_R, 0, CS_H);
    csCam.position.set(0, CS_H, 0); csCam.up.set(0, 0, -1); csCam.lookAt(0, 0, 0); csCam.updateMatrixWorld();
    const csVP = new THREE.Matrix4().multiplyMatrices(csCam.projectionMatrix, csCam.matrixWorldInverse);
    const csDark = new THREE.MeshBasicMaterial({ color: 0x000000 });
    // 全螢幕模糊：一個 2x2 quad ＋兩支內建 blur shader，交替寫入兩張 RT
    const blurScene = new THREE.Scene();
    const blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const hMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(HorizontalBlurShader.uniforms), vertexShader: HorizontalBlurShader.vertexShader, fragmentShader: HorizontalBlurShader.fragmentShader });
    const vMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(VerticalBlurShader.uniforms), vertexShader: VerticalBlurShader.vertexShader, fragmentShader: VerticalBlurShader.fragmentShader });
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(quadGeo, hMat); blurScene.add(quad);
    // 接影平面（覆蓋接影相機視野）：白→透明、黑→暗，投影出界則 discard
    const csPlaneMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { tShadow: { value: csRT.texture }, csVP: { value: csVP }, darkness: { value: CS_DARK } },
      vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D tShadow; uniform mat4 csVP; uniform float darkness; varying vec3 vW;
        void main(){ vec4 c = csVP * vec4(vW,1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          float s = 1.0 - texture2D(tShadow, uv).r;
          gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(s * darkness, 0.0, 1.0)); }`,
    });
    const csPlane = new THREE.Mesh(new THREE.PlaneGeometry(CS_R * 2, CS_R * 2), csPlaneMat);
    csPlane.rotation.x = -Math.PI / 2; csPlane.position.y = 0.045; csPlane.renderOrder = 2; noCast(csPlane); scene.add(csPlane);
    const _cc = new THREE.Color();
    updateContactShadow = () => {
      const prevRT = renderer.getRenderTarget();
      renderer.getClearColor(_cc); const prevA = renderer.getClearAlpha();
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false; // 遮擋物走純黑 override，燈光/陰影無意義，省一次陰影貼圖
      scene.overrideMaterial = csDark;
      renderer.setRenderTarget(csRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, csCam);
      scene.overrideMaterial = null;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      hMat.uniforms.tDiffuse.value = csRT.texture; hMat.uniforms.h.value = CS_BLUR / CS_SIZE; quad.material = hMat;
      renderer.setRenderTarget(csBlurRT); renderer.clear(); renderer.render(blurScene, blurCam);
      vMat.uniforms.tDiffuse.value = csBlurRT.texture; vMat.uniforms.v.value = CS_BLUR / CS_SIZE; quad.material = vMat;
      renderer.setRenderTarget(csRT); renderer.clear(); renderer.render(blurScene, blurCam);
      renderer.setRenderTarget(prevRT); renderer.setClearColor(_cc, prevA);
    };
    csDispose = () => {
      csRT.dispose(); csBlurRT.dispose(); csDark.dispose(); hMat.dispose(); vMat.dispose();
      quadGeo.dispose(); csPlaneMat.dispose(); (csPlane.geometry as THREE.BufferGeometry).dispose();
    };
  }

  // 共用貼圖/材質（建立一次，跨重建重用；房間地板輪流換木地板/磁磚/地毯）
  const floorMat = (tex: THREE.Texture) => track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  const roomFloorMats = [
    floorMat(woodTex("#b9813f", 4)),
    floorMat(tileTex("#c9cfd6", "#b3bdc9", 5)),
    floorMat(carpetTex("#cbaf7c", 3)),
  ];
  const lotMat = mm(0x8b94a0, { roughness: 0.98 }); // 建物外圍地坪（水泥）
  const foundMat = mm(0x5b6472, { roughness: 1 });  // 大樓地基（外圍露出的一圈厚邊，給「一棟大樓」的量體感）
  const paperShared = [paperTex("#e9dcc4", 3), paperTex("#dfe4ea", 3), paperTex("#ecdccb", 3)];
  // 大樓外牆貼圖：米色牆面＋整排窗，讓外圍讀起來像一棟辦公大樓的立面（呼應參考遊戲）
  const facadeTex = makeTex((x, s) => {
    x.fillStyle = "#d3c8b4"; x.fillRect(0, 0, s, s);
    const cols = 4, rows = 3, gx = s * 0.09, gy = s * 0.12;
    const ww = (s - gx * (cols + 1)) / cols, wh = (s - gy * (rows + 1)) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const px = gx + c * (ww + gx), py = gy + r * (wh + gy);
      x.fillStyle = "#33465f"; x.fillRect(px, py, ww, wh);
      x.fillStyle = "rgba(150,190,230,.45)"; x.fillRect(px + 2, py + 2, ww - 4, wh * 0.42);
      x.strokeStyle = "#b6a98f"; x.lineWidth = 3; x.strokeRect(px, py, ww, wh);
    }
  }, 2);
  const baseboardMat = mm(0xf5f0e6);

  // 玻璃帷幕貼圖：藍綠玻璃＋直豎料＋橫向樑帶（每面板恰一格＝一層樓的窗），塔身與本層落地窗共用一張。
  const glassTex = makeTex((x, s) => {
    const g = x.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, "#2b5670"); g.addColorStop(0.42, "#35708c"); g.addColorStop(0.5, "#4d90aa"); g.addColorStop(0.62, "#2f6076"); g.addColorStop(1, "#1c3d52");
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    x.fillStyle = "rgba(190,225,245,.20)"; x.fillRect(0, s * 0.10, s, s * 0.16);   // 天空反光帶
    x.strokeStyle = "rgba(150,170,185,.9)"; x.lineWidth = 2;                        // 直豎料
    const cols = 5; for (let c = 0; c <= cols; c++) { const px = c * (s / cols); x.beginPath(); x.moveTo(px, 0); x.lineTo(px, s); x.stroke(); }
    x.strokeStyle = "rgba(70,90,105,.95)"; x.lineWidth = 4;                         // 上下橫樑
    for (const y of [3, s * 0.5, s - 3]) { x.beginPath(); x.moveTo(0, y); x.lineTo(s, y); x.stroke(); }
  }, 1);
  const roofMat = mm(0x3a444e, { roughness: 0.92, metalness: 0.15 });     // 頂樓女兒牆
  const mechMat = mm(0x565f68, { roughness: 0.8, metalness: 0.25 });      // 頂樓機房/空調
  const slabMat = mm(0xd2d7de, { roughness: 0.82, metalness: 0.12 });     // 樓板環帶（外突的淺灰樓板飾帶，給塔身層次感）

  // 頭頂對話泡泡貼圖（共用一組，角色只換 material.map；呼應參考遊戲到處飄的泡泡）
  function bubbleTex(draw: (ctx: CanvasRenderingContext2D) => void) {
    const c = document.createElement("canvas"); c.width = 96; c.height = 92;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 6, 6, 84, 58, 18); ctx.fill();
    ctx.beginPath(); ctx.moveTo(34, 60); ctx.lineTo(52, 60); ctx.lineTo(38, 84); ctx.closePath(); ctx.fill();
    draw(ctx);
    const t = track(new THREE.CanvasTexture(c)); t.anisotropy = 4; return t;
  }
  const bubGlyph = (g: string, color: string) => bubbleTex((ctx) => {
    ctx.fillStyle = color; ctx.font = "bold 42px 'PingFang TC','Microsoft JhengHei',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(g, 48, 33);
  });
  const bubDots = bubbleTex((ctx) => { ctx.fillStyle = "#5b6b82"; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(27 + i * 21, 34, 6, 0, Math.PI * 2); ctx.fill(); } });
  const bubCheck = bubbleTex((ctx) => { ctx.strokeStyle = "#2fae66"; ctx.lineWidth = 7; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(30, 34); ctx.lineTo(43, 47); ctx.lineTo(66, 20); ctx.stroke(); });
  const busyBubbles = [bubDots, bubGlyph("?", "#4a7ac0"), bubGlyph("★", "#e0a63a")];
  const idleBubbles = [bubCheck, bubGlyph("♪", "#8a73e8"), bubGlyph("z", "#7b93b8")];
  function floor(x: number, z: number, w: number, d: number, mat: THREE.Material, y = 0) {
    const f = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.08, d)), mat); f.receiveShadow = true; f.position.set(x, y, z); noCast(f); add(f); return f;
  }

  // 靜態背景大地坪：空名冊時不至於一片虛空
  const groundMat = mm(0x47563f, { roughness: 1 }); // 大樓外的草地（深綠，呼應參考圖）
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(80, 80)), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true; noCast(ground); world.add(ground);

  // ---- 周邊場景（樹/灌木/車/遠景大樓/馬路）：讓大樓不再孤零零、像坐落在街區裡 ----
  function cone(r: number, h: number, seg: number, mat: THREE.Material) {
    const c = new THREE.Mesh(track(new THREE.ConeGeometry(r, h, seg)), mat); c.castShadow = true; c.receiveShadow = true; return c;
  }
  const treeTrunkMat = mm(0x6b4a2e, { roughness: 1 });
  const treeFoliageMats = [mm(0x3f8f4a), mm(0x4fa65a), mm(0x357c42)];
  const hedgeMat = mm(0x3c7a44, { roughness: 1 });
  const asphaltMat = mm(0x33383f, { roughness: 1 });
  const sidewalkMat = mm(0xb8bcc4, { roughness: 0.95 });
  const laneMat = mm(0xdccf96, { roughness: 0.9 });
  const cityMats = [mm(0x8790a0), mm(0x9aa2b0), mm(0x7c8492), mm(0xa7b0c0)];
  const cityCapMat = mm(0x6b7280);
  const carBodyMats = [mm(0xc0392b, { metalness: 0.35, roughness: 0.4 }), mm(0x2980b9, { metalness: 0.35, roughness: 0.4 }), mm(0xecf0f1, { metalness: 0.35, roughness: 0.4 }), mm(0xf1c40f, { metalness: 0.35, roughness: 0.4 })];
  const carGlassMat = mm(0x22303f, { roughness: 0.2, metalness: 0.5 });
  const wheelMat = mm(0x181a1d);
  // 低多邊形錐狀樹（一柱幹＋三疊錐葉，隨機轉向與葉色）
  function treeProp(x: number, z: number, s: number) {
    const g = new THREE.Group();
    const tr = cyl(0.09 * s, 0.14 * s, 0.85 * s, 7, treeTrunkMat); tr.position.y = 0.42 * s; g.add(tr);
    const fm = treeFoliageMats[Math.floor(Math.random() * treeFoliageMats.length)];
    const c1 = cone(0.62 * s, 0.85 * s, 7, fm); c1.position.y = 1.02 * s; g.add(c1);
    const c2 = cone(0.5 * s, 0.72 * s, 7, fm); c2.position.y = 1.42 * s; g.add(c2);
    const c3 = cone(0.34 * s, 0.6 * s, 7, fm); c3.position.y = 1.82 * s; g.add(c3);
    g.position.set(x, 0, z); g.rotation.y = Math.random() * Math.PI; add(g); blob(x, z, 1.3 * s);
  }
  // 圓灌木
  function bushProp(x: number, z: number, s: number) {
    const b = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.4 * s, 0)), hedgeMat);
    b.position.set(x, 0.3 * s, z); b.scale.y = 0.8; b.castShadow = true; b.receiveShadow = true; add(b); blob(x, z, 0.9 * s);
  }
  // 簡易小車（車身＋車艙玻璃＋四輪）
  function carProp(x: number, z: number, ry: number, s: number) {
    const g = new THREE.Group();
    const body = carBodyMats[Math.floor(Math.random() * carBodyMats.length)];
    g.add(rat(1.9 * s, 0.5 * s, 0.92 * s, body, 0, 0.42 * s, 0, 0.12 * s));
    g.add(rat(1.0 * s, 0.42 * s, 0.84 * s, body, -0.05 * s, 0.78 * s, 0, 0.1 * s));
    g.add(rat(0.98 * s, 0.3 * s, 0.72 * s, carGlassMat, -0.05 * s, 0.8 * s, 0, 0.06 * s));
    for (const wx of [0.62 * s, -0.62 * s]) for (const wz of [0.46 * s, -0.46 * s]) {
      const wl = cyl(0.2 * s, 0.2 * s, 0.14 * s, 10, wheelMat); wl.rotation.x = Math.PI / 2; wl.position.set(wx, 0.2 * s, wz); g.add(wl);
    }
    g.position.set(x, 0, z); g.rotation.y = ry;
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    add(g); blob(x, z, 2.1 * s, 1.2 * s);
  }
  // 遠景大樓量體（純色塊＋頂簷，給城市天際線）
  function cityBlock(x: number, z: number, w: number, h: number, d: number) {
    const b = box(w, h, d, cityMats[Math.floor(Math.random() * cityMats.length)]); b.position.set(x, h / 2, z); add(b);
    const cap = box(w * 1.06, 0.22, d * 1.06, cityCapMat); cap.position.set(x, h + 0.11, z); add(cap);
  }
  // 依建物外框在四周擺樹/灌木/車＋前方鋪馬路人行道＋遠處排幾棟大樓
  function buildSurroundings(minX: number, maxX: number, minZ: number, maxZ: number, lotCx: number) {
    const L = minX - LOT_MARGIN, Rr = maxX + LOT_MARGIN, B = minZ - LOT_MARGIN, F = maxZ + FRONT_MARGIN;
    // 前方：人行道 + 馬路 + 車道虛線 + 通往大門的走道
    floor(lotCx, F + 1.0, (Rr - L) + 6, 2.0, sidewalkMat, -0.03);
    floor(lotCx, F + 3.4, (Rr - L) + 16, 2.8, asphaltMat, -0.035);
    for (let i = -6; i <= 6; i++) floor(lotCx + i * 1.6, F + 3.4, 0.7, 0.12, laneMat, -0.03);
    floor(lotCx, F + 0.4, 1.6, (F + 1.6) - maxZ, sidewalkMat, -0.028); // 大門走道
    // 前方沿人行道停兩台車
    carProp(lotCx - (Rr - L) * 0.28, F + 2.1, Math.PI / 2, 0.62);
    carProp(lotCx + (Rr - L) * 0.30, F + 2.1, -Math.PI / 2, 0.62);
    // 灌木：沿前牆基座排一列（避開大門走道）
    for (let x = L + 1; x <= Rr - 1; x += 1.5) { if (Math.abs(x - lotCx) < 1.3) continue; bushProp(x, F + 0.35, 0.9); }
    // 樹：後方與左右兩側草地各排一排
    for (let x = L; x <= Rr; x += 2.6) { treeProp(x, B - 1.6, 0.9 + Math.random() * 0.5); }
    for (let z = B; z <= F; z += 2.8) { treeProp(L - 1.7, z, 0.85 + Math.random() * 0.5); treeProp(Rr + 1.7, z, 0.85 + Math.random() * 0.5); }
    // 遠景大樓：後方一排 + 左右遠端各一棟，拉出街區縱深。
    // 高度要跟自家塔身(13.5+)同量級、且參差夾雜更高棟，整片天際線才讀成「摩天樓群」而非塔身孤高。
    let tallEvery = 0;
    for (let x = L - 2; x <= Rr + 2; x += 4.2) {
      const h = ++tallEvery % 3 === 0 ? 14 + Math.random() * 6 : 7 + Math.random() * 6;
      cityBlock(x, B - 9 - Math.random() * 3, 2.6 + Math.random() * 1.4, h, 2.6 + Math.random() * 1.4);
    }
    cityBlock(L - 9, lotCx, 3, 10 + Math.random() * 6, 3);
    cityBlock(Rr + 9, lotCx, 3, 10 + Math.random() * 6, 3);
  }

  // 牆（近牆淡出）——動態房間與外圍共用；tex 由呼叫端給共用貼圖
  const WALLH = 2.6;
  const walls: THREE.Mesh[] = [];
  const wallByKey = new Map<string, THREE.Mesh>();   // 相鄰房間會在共用邊界各蓋一片同位置的牆＝z-fighting，用位置去重只留一片
  type WallUser = { normal: THREE.Vector3; members: THREE.Object3D[] };
  function wall(x: number, z: number, len: number, axis: "x" | "z", tex: THREE.Texture, nx: number, nz: number) {
    const key = `${axis}|${Math.round(x * 20)}|${Math.round(z * 20)}|${Math.round(len * 20)}`;
    const dup = wallByKey.get(key);
    if (dup) return dup;                              // 已有同位置牆＝共用邊界，回傳既有那片，掛物照樣附上去
    const g = axis === "x" ? track(new THREE.BoxGeometry(len, WALLH, 0.2)) : track(new THREE.BoxGeometry(0.2, WALLH, len));
    const w = new THREE.Mesh(g, track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.97, transparent: false, opacity: 1 })));
    w.position.set(x, WALLH / 2, z); w.castShadow = true; w.receiveShadow = true;
    w.userData = { normal: new THREE.Vector3(nx, 0, nz), members: [] } as WallUser;
    add(w); walls.push(w); wallByKey.set(key, w);
    const st = axis === "x" ? track(new THREE.BoxGeometry(len, 0.22, 0.26)) : track(new THREE.BoxGeometry(0.26, 0.22, len));
    const base = new THREE.Mesh(st, baseboardMat); base.castShadow = true; base.position.set(x, 0.11, z); add(base);
    (w.userData as WallUser).members.push(base);
    return w;
  }

  // 玻璃帷幕面板：與實牆共用近牆淡出系統（推進 walls），但標記 glass＝近側全穿透看進室內、遠側維持半透明玻璃（不變全實心）。
  function glassPanel(px: number, py: number, pz: number, len: number, height: number, axis: "x" | "z", nx: number, nz: number) {
    const g = axis === "x" ? track(new THREE.BoxGeometry(len, height, 0.1)) : track(new THREE.BoxGeometry(0.1, height, len));
    const mat = track(new THREE.MeshStandardMaterial({ map: glassTex, color: 0x9fc4d8, roughness: 0.1, metalness: 0.42, transparent: true, opacity: 0.42, depthWrite: false, envMapIntensity: 0.5 }));
    const m = new THREE.Mesh(g, mat);
    m.position.set(px, py, pz);
    m.userData = { normal: new THREE.Vector3(nx, 0, nz), members: [], glass: true } as WallUser & { glass: boolean };
    m.castShadow = false; m.receiveShadow = false;
    add(m); walls.push(m);
    return m;
  }

  // 玻璃塔身：本層外圍往上疊數層玻璃樓層＋頂樓女兒牆/機房，讓這層讀成「摩天樓中的一層」而非孤零平房。
  // 四面玻璃都推進淡出系統：使用者旋轉時近側自動看穿、遠側玻璃透出城市與塔身。
  function buildTower(lx: number, rx: number, bz: number, fz: number) {
    const cx = (lx + rx) / 2, cz = (bz + fz) / 2, w = rx - lx, d = fz - bz;
    const STOREY = 2.7, FLOORS = 5;                 // 含本層在內共 5 層（本層 s=0＝落地窗）
    for (let s = 0; s < FLOORS; s++) {
      const yc = s * STOREY + STOREY / 2;
      glassPanel(cx, yc, bz, w, STOREY, "x", 0, -1);   // 後 -z
      glassPanel(cx, yc, fz, w, STOREY, "x", 0, 1);    // 前 +z
      glassPanel(lx, yc, cz, d, STOREY, "z", -1, 0);   // 左 -x
      glassPanel(rx, yc, cz, d, STOREY, "z", 1, 0);    // 右 +x
    }
    // pass-2 樓板環帶：每層交界繞塔身一圈外突的樓板飾帶＝清楚讀出「一層一層」，塔身更立體/摩天。
    // 帶薄(0.16)且落在樓層交界線(y=s*STOREY)，都在各房天花以上，不擋俯視看進房間。
    const bt = 0.12, bandH = 0.16, over = 0.1;   // 帶厚、帶高、外突量
    const slabRing = (y: number) => {
      add(rat((rx - lx) + over * 2 + bt, bandH, bt + over, slabMat, (lx + rx) / 2, y, bz, 0.03)); // 後 -z
      add(rat((rx - lx) + over * 2 + bt, bandH, bt + over, slabMat, (lx + rx) / 2, y, fz, 0.03)); // 前 +z
      add(rat(bt + over, bandH, (fz - bz) + over * 2 + bt, slabMat, lx, y, (bz + fz) / 2, 0.03));  // 左 -x
      add(rat(bt + over, bandH, (fz - bz) + over * 2 + bt, slabMat, rx, y, (bz + fz) / 2, 0.03));  // 右 +x
    };
    for (let s = 1; s < FLOORS; s++) slabRing(s * STOREY);   // 各層交界（本層頂 2.7、往上每 STOREY 一圈）
    // 頂樓：女兒牆一圈 + 兩台空調機房 + 天線
    const yTop = FLOORS * STOREY;
    const parap = 0.5, pt = 0.12;
    add(rat(w + pt, parap, pt, roofMat, cx, yTop + parap / 2, bz, 0.03));
    add(rat(w + pt, parap, pt, roofMat, cx, yTop + parap / 2, fz, 0.03));
    add(rat(pt, parap, d + pt, roofMat, lx, yTop + parap / 2, cz, 0.03));
    add(rat(pt, parap, d + pt, roofMat, rx, yTop + parap / 2, cz, 0.03));
    // 不加整片屋頂板：俯視娃娃屋忌諱有「蓋子」；只在後緣角落擺機房，其餘留開放玻璃層＝塔身往上延伸不擋視線。
    // 每台機組/天線下各墊一塊小屋頂板＝設備踩實不浮空，又不會變成整片蓋子。
    add(rat(2.1, 0.12, 1.5, roofMat, cx - w * 0.18, yTop + 0.06, cz - d * 0.12, 0.03));
    add(rat(1.5, 0.12, 1.3, roofMat, cx + w * 0.22, yTop + 0.06, cz + d * 0.08, 0.03));
    add(rat(0.7, 0.12, 0.7, roofMat, cx + w * 0.28, yTop + 0.06, cz - d * 0.2, 0.03));
    add(rat(1.6, 0.7, 1.1, mechMat, cx - w * 0.18, yTop + 0.47, cz - d * 0.12, 0.04));   // 空調機組
    add(rat(1.1, 0.5, 0.9, mechMat, cx + w * 0.22, yTop + 0.37, cz + d * 0.08, 0.04));
    const mast = cyl(0.03, 0.05, 1.8, 6, mechMat); mast.position.set(cx + w * 0.28, yTop + 1.02, cz - d * 0.2); add(mast);
  }

  // 牆掛物
  function mountOnWall(wo: THREE.Mesh, g: THREE.Group, along: number, y: number) {
    const n = (wo.userData as WallUser).normal;
    if (Math.abs(n.z) > 0.5) { g.rotation.y = n.z < 0 ? 0 : Math.PI; g.position.set(along, y, wo.position.z + (n.z < 0 ? 0.11 : -0.11)); }
    else { g.rotation.y = n.x < 0 ? Math.PI / 2 : -Math.PI / 2; g.position.set(wo.position.x + (n.x < 0 ? 0.11 : -0.11), y, along); }
    g.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; } });
    add(g); (wo.userData as WallUser).members.push(g);
  }
  function clockFace() {
    const g = new THREE.Group();
    const rim = cyl(0.36, 0.36, 0.05, 24, mm(0x5a4632)); rim.rotation.x = Math.PI / 2; g.add(rim);
    const face = cyl(0.32, 0.32, 0.06, 24, mm(0xf7f4ee)); face.rotation.x = Math.PI / 2; face.position.z = 0.012; g.add(face);
    const hour = new THREE.Object3D(); hour.position.set(0, 0, 0.05);
    hour.add(bat(0.034, 0.11, 0.02, mm(0x333333), 0, 0.055, 0)); g.add(hour);
    const min = new THREE.Object3D(); min.position.set(0, 0, 0.06);
    min.add(bat(0.026, 0.17, 0.02, mm(0x333333), 0, 0.085, 0)); g.add(min);
    const hub = cyl(0.03, 0.03, 0.035, 12, mm(0xc0392b)); hub.rotation.x = Math.PI / 2; hub.position.z = 0.075; g.add(hub);
    clockHour = hour; clockMin = min; setClockHands();
    return g;
  }
  function corkBoard(w: number, h: number) {
    const g = new THREE.Group();
    g.add(rmesh(w, h, 0.06, mm(0x6b4a2a), 0.02));
    const cork = rmesh(w * 0.9, h * 0.82, 0.04, mm(0xcdaa72), 0.01); cork.position.z = 0.02; g.add(cork);
    const cols = [0xef8f7a, 0xf3d06a, 0x8fd0e0, 0xa6e08a, 0xe0a6d0, 0xf0b48a, 0xbfa6e0];
    for (let i = 0; i < 7; i++) {
      const s = 0.15 + Math.random() * 0.05, nt = rmesh(s, s, 0.02, mm(cols[i % cols.length]), 0.006);
      nt.position.set(-w * 0.30 + (i % 4) * (w * 0.2), h * 0.20 - Math.floor(i / 4) * h * 0.34 + (Math.random() - 0.5) * 0.05, 0.055);
      nt.rotation.z = (Math.random() - 0.5) * 0.22; g.add(nt);
    }
    return g;
  }

  // 房間名牌：半透明浮在各房上方（sprite 永遠面向鏡頭）
  function roomSign(text: string, x: number, z: number) {
    const c = document.createElement("canvas"); const ctx = c.getContext("2d")!;
    const font = "600 40px 'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif";
    ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 30; c.width = w; c.height = 60;
    ctx.font = font; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(52,66,86,.34)"; roundRect(ctx, 0, 6, w, 48, 12); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.94)"; ctx.fillText(text, 15, 33);
    const tex = track(new THREE.CanvasTexture(c)); tex.anisotropy = 4;
    const spr = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.82 })));
    spr.scale.set(w / 60 * 0.5, 0.5, 1); spr.position.set(x, 2.45, z); spr.renderOrder = 4; noCast(spr); add(spr);
  }

  // 桌面雜物共用材質（建立一次、跨所有桌重用，避免每張桌新建一堆材質）
  const deskMat = {
    plastic: mm(0x2b2f36),   // 螢幕支架/底座塑膠
    panel: mm(0x24282e),     // 螢幕機身
    paper: mm(0xf3ece0),     // 文件紙堆
    cup: mm(0x4a5568),       // 筆筒
    pot: mm(0xb5651d),       // 小盆栽陶盆
    leaf: mm(0x4f9d5a),      // 盆栽葉
  };
  const folderCols = [0xef8f7a, 0x6fb0e0, 0x8ac98a, 0xe0b45a, 0xb79ae0];
  const noteCols = [0xffe066, 0xff9fb0, 0x9fe0c0, 0xbfa6ff];

  // 桌面擺設：主螢幕＋鍵盤＋馬克杯，再加雜物（副螢幕/文件夾堆/筆筒或小盆栽/便利貼），
  // 每張桌用輕微隨機錯開＝辦公室看起來真的有人在用、桌桌不一樣。只在建佈局時跑一次。
  function deskSet(x: number, deskObj: THREE.Object3D, z: number, glow: number) {
    const ty = new THREE.Box3().setFromObject(deskObj).max.y, g = new THREE.Group();
    const stand = cyl(0.04, 0.06, 0.13, 10, deskMat.plastic); stand.position.y = 0.065; g.add(stand);
    g.add(rat(0.22, 0.03, 0.14, deskMat.plastic, 0, 0.015, 0, 0.01));
    g.add(rat(0.62, 0.40, 0.05, deskMat.panel, 0, 0.33, 0, 0.03));
    const scr = new THREE.Mesh(track(new THREE.PlaneGeometry(0.54, 0.32)), track(new THREE.MeshStandardMaterial({ color: 0x9fdfff, emissive: glow, emissiveIntensity: 0.85, roughness: 0.4 })));
    scr.position.set(0, 0.33, -0.027); scr.rotation.y = Math.PI; g.add(scr); // 螢幕朝向桌後的角色（-z）
    g.add(rat(0.46, 0.03, 0.16, mm(0x33383f), 0, 0.02, -0.30, 0.01));
    const mug = cyl(0.05, 0.045, 0.11, 12, mm(0xef7f5a)); mug.position.set(0.34, 0.055, -0.26); g.add(mug);

    // 副螢幕：斜擺主螢幕一側、略小＝雙螢幕工位（螢幕同樣朝角色）
    const side = Math.random() < 0.5 ? -1 : 1;
    const m2 = new THREE.Group();
    m2.add(rat(0.16, 0.03, 0.11, deskMat.plastic, 0, 0.015, 0, 0.01));
    const arm2 = cyl(0.028, 0.036, 0.1, 8, deskMat.plastic); arm2.position.y = 0.06; m2.add(arm2);
    m2.add(rat(0.42, 0.28, 0.045, deskMat.panel, 0, 0.24, 0, 0.02));
    const scr2 = new THREE.Mesh(track(new THREE.PlaneGeometry(0.36, 0.22)), track(new THREE.MeshStandardMaterial({ color: 0x9fdfff, emissive: glow, emissiveIntensity: 0.7, roughness: 0.4 })));
    scr2.position.set(0, 0.24, -0.024); scr2.rotation.y = Math.PI; m2.add(scr2);
    m2.position.set(side * 0.48, 0, 0.02); m2.rotation.y = side * 0.5; g.add(m2);

    // 文件夾堆：擺在角色左手邊、朝鏡頭的桌緣（+z 側看得到），彩色資料夾錯開疊放
    const dx = -side * 0.34;
    g.add(rat(0.26, 0.05, 0.32, deskMat.paper, dx, 0.025, 0.2, 0.006));
    const folder = rat(0.24, 0.025, 0.3, mm(folderCols[Math.floor(Math.random() * folderCols.length)]), dx + 0.01, 0.065, 0.21, 0.006);
    folder.rotation.y = (Math.random() - 0.5) * 0.3; g.add(folder);

    // 筆筒或小盆栽（隨機）：擺在桌角
    if (Math.random() < 0.5) {
      const cup = cyl(0.05, 0.042, 0.11, 10, deskMat.cup); cup.position.set(0.3, 0.055, 0.24); g.add(cup);
      for (let i = 0; i < 3; i++) { const pen = cyl(0.008, 0.008, 0.16, 6, mm([0x2c3e50, 0xc0392b, 0x2980b9][i])); pen.position.set(0.3 + (i - 1) * 0.015, 0.12, 0.24); pen.rotation.z = (i - 1) * 0.12; g.add(pen); }
    } else {
      const pot = cyl(0.055, 0.045, 0.08, 8, deskMat.pot); pot.position.set(0.3, 0.04, 0.24); g.add(pot);
      const leaf = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 8, 6)), deskMat.leaf); leaf.scale.y = 1.3; leaf.position.set(0.3, 0.13, 0.24); g.add(leaf);
    }

    // 便利貼：貼在主螢幕背面（+z 面向鏡頭）1~2 張
    const notes = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < notes; i++) {
      const note = new THREE.Mesh(track(new THREE.PlaneGeometry(0.07, 0.07)), mm(noteCols[Math.floor(Math.random() * noteCols.length)]));
      note.position.set((i === 0 ? 0.2 : -0.2), 0.34 + (Math.random() - 0.5) * 0.08, 0.026);
      note.rotation.z = (Math.random() - 0.5) * 0.3; g.add(note);
    }

    g.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { me.castShadow = true; me.receiveShadow = true; const mat = me.material as THREE.MeshStandardMaterial; if (mat && "envMapIntensity" in mat) mat.envMapIntensity = 0.16; } });
    g.position.set(x, ty, z); add(g);
  }

  // ---- 載入 GLB（傢俱 + 角色）----
  // 角色 GLB 已離線剝除未用到的動畫（24→僅保留 Walk/Idle/Idle_Neutral/Interact/Wave），三 原生載入、免任何 WASM 解碼器
  // （本環境 CSP script-src 'self' 禁 WebAssembly，故不能用 meshopt/draco 這類需 wasm 的壓縮）。
  const loader = new GLTFLoader();
  const loadGlb = (url: string) => new Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTF>((res, rej) => loader.load(url, res, undefined, rej));
  const furnKinds = ["office_desk", "office_chair", "couch", "potted_plant", "bookshelf", "filing_drawers", "coffee_table", "floor_lamp", "trash_can", "rug", "water_cooler"] as const;
  const [furnGltfs, charGltfs] = await Promise.all([
    Promise.all(furnKinds.map((f) => loadGlb(`${BASE}models/furniture/${f}.glb`))),
    Promise.all(CHAR_FILES.map((f) => loadGlb(`${BASE}models/chars/${f}.glb`))),
  ]);
  const FUR: Record<string, import("three/examples/jsm/loaders/GLTFLoader.js").GLTF> = {};
  furnKinds.forEach((k, i) => { FUR[k] = furnGltfs[i]; });

  const FLOORTOP = 0.045;
  function furn(kind: string, x: number, z: number, ry: number, targetMax: number, lift?: number) {
    const obj = FUR[kind].scene.clone(true);
    // 標記 keepGeo：GLB 複製體的幾何與來源共用，重建時只移除不可 dispose
    obj.traverse((o) => { const me = o as THREE.Mesh; me.userData.keepGeo = true; if (me.isMesh) { me.castShadow = true; me.receiveShadow = true; const mat = me.material as THREE.MeshStandardMaterial; if (mat && "envMapIntensity" in mat) mat.envMapIntensity = 0.16; } });
    obj.rotation.y = ry || 0; add(obj); obj.updateWorldMatrix(true, true);
    const sz = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    const s = targetMax / Math.max(sz.x, sz.y, sz.z); obj.scale.setScalar(s); obj.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(obj), c = b.getCenter(new THREE.Vector3());
    obj.position.x += x - c.x; obj.position.z += z - c.z; obj.position.y += -b.min.y + FLOORTOP + (lift || 0);
    blob(x, z, sz.x * s * 1.15, sz.z * s * 1.15);
    return obj;
  }

  // 外圍路燈：夜晚才亮
  function streetLight(x: number, z: number) {
    const g = new THREE.Group();
    const pole = cyl(0.06, 0.08, 2.7, 10, mm(0x2a2f36)); pole.position.y = 1.35; g.add(pole);
    const head = rat(0.34, 0.14, 0.34, mm(0x3a3f47), 0, 2.62, 0, 0.05); g.add(head);
    const bulb = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 10, 8)), track(new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffb060, emissiveIntensity: 1 })));
    bulb.position.set(0, 2.5, 0); g.add(bulb);
    g.position.set(x, 0, z); add(g);
    const L = new THREE.PointLight(0xffd39a, 0, 8, 2); L.position.set(x, 2.5, z); L.userData.max = 1.5; scene.add(L); lampLights.push(L);
  }

  // ---- 動態佈局：依 departmentId 建房 ----
  const seatMap = new Map<string, { x: number; z: number; ry: number }>();
  const wanderPoints: { x: number; z: number; tag?: "eat" | "wc" }[] = [];   // tag＝生活動線點（午餐偏好 eat、偶爾去 wc）
  // 活動站點座標池：station key → 一組站位（NPC 依 character.station 走過去；home 用各自 seatMap）
  const stationSpots = new Map<string, { x: number; z: number; ry: number }[]>();
  const pushSpot = (key: string, x: number, z: number, ry: number) => {
    const arr = stationSpots.get(key); if (arr) arr.push({ x, z, ry }); else stationSpots.set(key, [{ x, z, ry }]);
  };
  const DESK_GLOWS = [0x8fe6ff, 0x9fffb0, 0xffcf8f, 0xff9fd0, 0xc0a0ff];
  let camFitted = false;

  // ---- 走動路徑（沿中央走廊 x=0 脊椎＋房門，避免直線穿牆）----
  type NavRoom = { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number; doorSide: "+x" | "-x" | "+z" };
  const navRooms: NavRoom[] = [];
  let navFrontZ = 0;               // 建物前緣 z（走廊出口＝往前庭的關卡）
  let bossSpot: { x: number; z: number; ry: number } | null = null;  // 老闆桌前的報告點：臨時 NPC 做完走來這裡揮手回報再消失
  // 作戰室中央大桌範圍＝室內走動要繞開的障礙（進出都沿側邊車道，不穿桌）
  let warNav: { cx: number; cz: number; frontZ: number; halfTW: number } | null = null;
  const roomAt = (x: number, z: number): NavRoom | null =>
    navRooms.find((r) => x > r.minX + 0.15 && x < r.maxX - 0.15 && z > r.minZ + 0.15 && z < r.maxZ - 0.15) || null;
  // 房門的內/外站點（外＝走廊側）
  function doorPts(r: NavRoom) {
    if (r.doorSide === "+x") return { inner: { x: r.maxX - 0.45, z: r.cz }, outer: { x: r.maxX + 0.45, z: r.cz } };
    if (r.doorSide === "-x") return { inner: { x: r.minX + 0.45, z: r.cz }, outer: { x: r.minX - 0.45, z: r.cz } };
    return { inner: { x: r.cx, z: r.maxZ - 0.45 }, outer: { x: r.cx, z: r.maxZ + 0.45 } }; // +z（作戰室）
  }
  // 從 (sx,sz) 到 (tx,tz) 的路徑點：先出發房的門→走廊脊椎(x=0)→目標房的門→目標
  function routeTo(sx: number, sz: number, tx: number, tz: number): { x: number; z: number }[] {
    const Rs = roomAt(sx, sz), Rt = roomAt(tx, tz);
    if (Rs === Rt) return [{ x: tx, z: tz }];                // 同房或都在戶外＝直走
    const pts: { x: number; z: number }[] = [];
    if (Rs) {
      const d = doorPts(Rs);
      if (Rs.doorSide === "+z" && warNav) {                  // 離開作戰室：先橫移到側邊車道、沿車道回到門前，不穿桌
        const laneX = warNav.cx + (sx >= warNav.cx ? 1 : -1) * (warNav.halfTW + 0.66);
        pts.push({ x: laneX, z: sz }, { x: laneX, z: warNav.frontZ });
      } else if (Rs.doorSide === "+z") pts.push({ x: Rs.cx, z: sz });
      else pts.push({ x: sx, z: Rs.cz });
      pts.push(d.inner, d.outer, { x: 0, z: d.outer.z });    // 出門→走到走廊中線
    } else {
      pts.push({ x: 0, z: sz });                             // 戶外先靠到走廊中線
    }
    if (Rt) {
      const d = doorPts(Rt);
      pts.push({ x: 0, z: d.outer.z }, d.outer, d.inner);    // 沿脊椎到目標門→進門
      if (Rt.doorSide === "+z" && warNav) {                  // 進作戰室：門前橫移到側邊車道、沿車道到座位 z，最後才橫進座位，不穿桌
        const laneX = warNav.cx + (tx >= warNav.cx ? 1 : -1) * (warNav.halfTW + 0.66);
        pts.push({ x: laneX, z: warNav.frontZ }, { x: laneX, z: tz });
      } else if (Rt.doorSide === "+z") pts.push({ x: Rt.cx, z: tz });
      else pts.push({ x: tx, z: Rt.cz });
    } else {
      pts.push({ x: 0, z: navFrontZ });                      // 出走廊前口再散到前庭
    }
    pts.push({ x: tx, z: tz });
    return pts;
  }

  function clearLayout() {
    for (const o of layoutObjects) { world.remove(o); disposeObj(o); }
    layoutObjects.length = 0;
    walls.length = 0;
    for (const L of lampLights) scene.remove(L);
    lampLights.length = 0;
    clockHour = null; clockMin = null;
    seatMap.clear();
    wanderPoints.length = 0;
    stationSpots.clear();
    navRooms.length = 0;
    warNav = null;
  }

  function buildLayout(workers: WorkerLite[]) {
    clearLayout();

    // 依 departmentId 分組（保順序）
    const groups = new Map<string, WorkerLite[]>();
    for (const w of workers) {
      const key = w.departmentId || "未分組";
      const g = groups.get(key);
      if (g) g.push(w); else groups.set(key, [w]);
    }

    // Pass1（脊椎式）：中央走廊沿 Z(x=0)，部門房分左右兩欄、由前(+z 入口側)往後(-z)排；
    // 全部朝 +z（面向鏡頭）＝桌向統一，門一律開在走廊側牆，房寬房深全部一致 → 整齊有節奏＋明確動線。
    // 奇數部門時最後一格留給茶水/休息區（社交區有家）；作戰室跨走廊置中封在走廊底端＝協作核。
    type Room = { kind: "dept" | "command" | "lounge" | "wc" | "dining" | "store"; key: string; label: string; members: WorkerLite[]; cols: number; rows: number; w: number; d: number; cx: number; cz: number; doorSide: "+x" | "-x" | "+z" };
    const deptList = [...groups.entries()];
    if (!deptList.length) { applyDaylight(); return; }
    const ROOM_W = (ROOM_COLS - 1) * DESK_PITCH + DESK_W + ROOM_PAD_X * 2;
    let maxRows = 1;
    for (const [, m] of deptList) maxRows = Math.max(maxRows, Math.ceil((m.length + ROOM_SPARE) / ROOM_COLS));
    const ROOM_D = ROOM_BACK + maxRows * ROW_PITCH + ROOM_FRONT; // 房深統一，前後緣對齊
    const colX = { L: -(CORRIDOR_W / 2 + ROOM_W / 2), R: CORRIDOR_W / 2 + ROOM_W / 2 };
    // 房間配置依 space planning 研究結論（方案A）：
    // 廁所＝服務核心→插進走廊「中段」格（全樓層等距可達，不與用餐區相鄰）；
    // 餐廳＋休息區＝社交錨點→後端一排面對面相鄰（茶水間併入，不再另開）；作戰室仍在最深處（內部會議慣例）。
    type Cell = { kind: Room["kind"]; key: string; label: string; members: WorkerLite[] };
    const cells: Cell[] = deptList.map(([key, members]) => ({ kind: "dept", key, label: members.find((m) => m.departmentLabel)?.departmentLabel || key, members }));
    cells.splice(Math.min(2, cells.length), 0, { kind: "wc", key: "__wc__", label: "廁所", members: [] });
    if (cells.length % 2 === 1) cells.push({ kind: "store", key: "__store__", label: "儲藏室", members: [] });   // 補滿格＝建物矩形完整
    const nGridRows = Math.ceil(cells.length / 2);
    const rooms: Room[] = cells.map((c, i) => {
      const gr = Math.floor(i / 2), side: "L" | "R" = i % 2 === 0 ? "L" : "R";
      const cols = c.kind === "dept" ? Math.min(Math.max(c.members.length + ROOM_SPARE, 1), ROOM_COLS) : 0;
      const rows = c.kind === "dept" ? Math.ceil((c.members.length + ROOM_SPARE) / ROOM_COLS) : 0;
      return { kind: c.kind, key: c.key, label: c.label, members: c.members, cols, rows, w: ROOM_W, d: ROOM_D, cx: colX[side], cz: -gr * ROOM_D - ROOM_D / 2, doorSide: side === "L" ? "+x" as const : "-x" as const };
    });
    // 社交錨點排：左休息區＋右餐廳，相鄰面對面；緊鄰作戰室＝會議茶點動線
    const svcCz = -nGridRows * ROOM_D - ROOM_D / 2;
    rooms.push({ kind: "lounge", key: "__lounge__", label: "休息區", members: [], cols: 0, rows: 0, w: ROOM_W, d: ROOM_D, cx: colX.L, cz: svcCz, doorSide: "+x" });
    rooms.push({ kind: "dining", key: "__dining__", label: "餐廳", members: [], cols: 0, rows: 0, w: ROOM_W, d: ROOM_D, cx: colX.R, cz: svcCz, doorSide: "-x" });
    // 作戰室：跨滿兩欄寬度、置中封在走廊底端（門朝 +z 面向走廊）＝協作核
    // 跨滿寬度＝不在後段兩側留空地坪，且圓桌開會圈四周有大量留白（社交/協作互動點的留白）。
    const bldgHalfW = colX.R + ROOM_W / 2;   // 兩欄外緣半寬
    const WAR_D = 7.8;                        // 作戰室深（往後推＝開會圈、洽談區、後牆展示牆都有充裕前後距）
    const war: Room = { kind: "command", key: "__war__", label: "作戰室", members: [], cols: 0, rows: 0, w: bldgHalfW * 2, d: WAR_D, cx: 0, cz: -(nGridRows + 1) * ROOM_D - WAR_D / 2, doorSide: "+z" };
    rooms.push(war);

    // 建物置中：算外框中心，全部平移使中心落在世界原點
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of rooms) { minX = Math.min(minX, r.cx - r.w / 2); maxX = Math.max(maxX, r.cx + r.w / 2); minZ = Math.min(minZ, r.cz - r.d / 2); maxZ = Math.max(maxZ, r.cz + r.d / 2); }
    const bcx = (minX + maxX) / 2, bcz = (minZ + maxZ) / 2;
    for (const r of rooms) { r.cx -= bcx; r.cz -= bcz; }
    minX -= bcx; maxX -= bcx; minZ -= bcz; maxZ -= bcz;

    // 登記房間矩形給走動路由（避免 NPC 直線穿牆）；前緣＝走廊往前庭的出口
    navFrontZ = maxZ + 0.6;
    for (const r of rooms) navRooms.push({ minX: r.cx - r.w / 2, maxX: r.cx + r.w / 2, minZ: r.cz - r.d / 2, maxZ: r.cz + r.d / 2, cx: r.cx, cz: r.cz, doorSide: r.doorSide });

    // 外圍地坪（前庭較深＝互動廣場留白，後／左右維持緊湊）
    const backZ = minZ - LOT_MARGIN, frontZ = maxZ + FRONT_MARGIN;
    const lotW = maxX - minX + LOT_MARGIN * 2, lotD = frontZ - backZ;
    const lotCz = (backZ + frontZ) / 2;
    floor((minX + maxX) / 2, lotCz, lotW, lotD, lotMat, -0.06);   // 大地坪壓到最低，跟房間地板拉開足夠深度差避免旋轉時 z-fighting
    // 中央走廊地坪（磁磚讀成走道），從最前排房前緣延伸到作戰室前緣。壓到房間地板下方 → 房間地板永遠贏、走廊只在房間之間的空隙露出，兩片不再同高打架
    const corrZ0 = maxZ, corrZ1 = war.cz + war.d / 2;
    floor(0, (corrZ0 + corrZ1) / 2, CORRIDOR_W, corrZ0 - corrZ1, roomFloorMats[1], -0.015);

    // Pass2：逐房蓋牆(門開走廊側)、地板、桌椅、招牌、座位
    let firstBackWall: THREE.Mesh | null = null;
    let secondBackWall: THREE.Mesh | null = null;
    rooms.forEach((room, ri) => {
      const { cx, cz, w, d, cols, doorSide } = room;
      const hw = w / 2, hd = d / 2, tex = paperShared[ri % paperShared.length];
      // 地板
      floor(cx, cz, w, d, roomFloorMats[ri % roomFloorMats.length]);
      // 四面牆，門開在 doorSide（走廊側）
      const sides: Array<["+z" | "-z" | "+x" | "-x", number, number, number, "x" | "z", number, number]> = [
        ["-z", cx, cz - hd, w, "x", 0, -1],
        ["+z", cx, cz + hd, w, "x", 0, 1],
        ["-x", cx - hw, cz, d, "z", -1, 0],
        ["+x", cx + hw, cz, d, "z", 1, 0],
      ];
      for (const [sk, wx, wz, len, axis, nx, nz] of sides) {
        if (sk === doorSide) {
          const seg = (len - DOOR_W) / 2;
          if (seg > 0.35) {
            if (axis === "x") { wall(wx - (DOOR_W / 2 + seg / 2), wz, seg, "x", tex, nx, nz); wall(wx + (DOOR_W / 2 + seg / 2), wz, seg, "x", tex, nx, nz); }
            else { wall(wx, wz - (DOOR_W / 2 + seg / 2), seg, "z", tex, nx, nz); wall(wx, wz + (DOOR_W / 2 + seg / 2), seg, "z", tex, nx, nz); }
          }
        } else {
          // 最後一排房（服務排）的後牆正好落在作戰室前牆所在平面（作戰室橫跨整寬），兩片共平面部分重疊＝z-fighting；
          // 這道邊界交給作戰室前牆封，該房這面跳過不蓋（作戰室前牆已完整覆蓋此處，不會有缺口）。
          if (sk === "-z" && room.kind !== "command" && Math.abs(wz - (war.cz + war.d / 2)) < 0.06) continue;
          const wo = wall(wx, wz, len, axis, tex, nx, nz);
          if (sk === "-z" && room.kind === "dept") { if (!firstBackWall) firstBackWall = wo; else if (!secondBackWall) secondBackWall = wo; }
        }
      }
      // 招牌
      roomSign(room.label, cx, cz);

      if (room.kind === "lounge") {
        // 茶水/休息區：中央沙發圍茶几的社交群＋飲水機＋植栽（社交互動點＝周圍留白、多個休息位）
        furn("rug", cx, cz, 0, 2.6);                                   // 中央地毯定義社交圈
        furn("coffee_table", cx, cz, 0, 1.0);                          // 茶几中心
        furn("couch", cx - 1.4, cz, Math.PI / 2, 1.05);               // 兩張沙發面朝茶几
        furn("couch", cx + 1.4, cz, -Math.PI / 2, 1.05);
        // 娛樂牆：後牆掛電視＋下方矮櫃＝休息「玩樂」焦點
        const tvw = Math.min(w * 0.42, 2.6);
        add(rat(tvw + 0.14, 1.26, 0.08, mm(0x14181f), cx, 1.5, cz - hd + 0.12, 0.04));
        const tv = new THREE.Mesh(track(new THREE.PlaneGeometry(tvw, 1.08)), track(new THREE.MeshStandardMaterial({ color: 0x0b1420, emissive: 0x3a86ff, emissiveIntensity: 0.55, roughness: 0.35 })));
        tv.position.set(cx, 1.5, cz - hd + 0.17); add(tv);
        furn("filing_drawers", cx, cz - hd + 0.55, 0, 0.9);           // 電視下矮櫃
        furn("couch", cx, cz + 1.6, Math.PI, 1.05);                   // 面向電視的沙發
        furn("water_cooler", cx - hw + 0.6, cz - hd + 0.7, Math.PI / 2, 1.35);
        furn("potted_plant", cx + hw - 0.5, cz - hd + 0.6, 0, 1.1);
        furn("potted_plant", cx - hw + 0.5, cz + hd - 0.6, 0, 0.95);
        furn("floor_lamp", cx + hw - 0.5, cz + hd - 0.7, 0, 1.6);
        const ll = new THREE.PointLight(0xffd39a, 0, 6.5, 2); ll.position.set(cx + hw - 0.5, 1.55, cz + hd - 0.7); ll.userData.max = 1.4; scene.add(ll); lampLights.push(ll);
        wanderPoints.push({ x: cx, z: cz });
        wanderPoints.push({ x: cx, z: cz - hd + 1.1 });               // 飲水機那頭也晃晃
        // 多個休息位分散在沙發旁與飲水機旁＝多人放鬆不擠一堆
        pushSpot("rest", cx - 1.0, cz, Math.PI / 2);
        pushSpot("rest", cx + 1.0, cz, -Math.PI / 2);
        pushSpot("rest", cx, cz - hd + 1.3, 0);
        blob(cx, cz, 2.8);                                            // 社交圈淨空
        return;
      }

      if (room.kind === "wc") {
        // 廁所（走廊中段格＝服務核心）：隔間馬桶＋洗手台鏡子；門內一片屏風牆＝走廊看不進去（IPC 前室慣例）
        const dir = doorSide === "+x" ? 1 : -1;                       // 門在哪側，內裝鏡像擺到對側
        const cer = mm(0xf2f4f6, { roughness: 0.35 });                // 白瓷
        const stallMat = mm(0x8fa3b0, { roughness: 0.8 });            // 隔板藍灰
        const stallD = 1.35, stallW = 1.2;                            // 隔間佔後牆遠離門那側
        for (let i = 0; i < 3; i++) add(rat(0.07, 1.9, stallD, stallMat, cx + dir * (-3.0 + i * stallW), 0.97, cz - hd + stallD / 2 + 0.05, 0.02));
        for (let i = 0; i < 2; i++) {
          const tx = cx + dir * (-3.0 + stallW * (i + 0.5));
          const bowl = cyl(0.21, 0.15, 0.42, 12, cer); bowl.position.set(tx, 0.21, cz - hd + 0.6); bowl.castShadow = true; add(bowl);
          add(rat(0.4, 0.52, 0.16, cer, tx, 0.55, cz - hd + 0.24, 0.04));   // 水箱靠牆
          const door = rat(stallW - 0.16, 1.7, 0.05, stallMat, 0, 0, 0, 0.02);
          door.position.set(tx + 0.3 * dir, 0.95, cz - hd + stallD + 0.28); door.rotation.y = 0.65 * dir; add(door);   // 門半開
          blob(tx, cz - hd + 0.7, 1.0);
        }
        // 洗手台沿前牆、遠離門那半：櫃體＋兩個盆＋鏡面
        add(rat(2.0, 0.8, 0.52, mm(0x9aa7b4, { roughness: 0.7 }), cx - dir * 2.2, 0.4, cz + hd - 0.4, 0.03));
        for (const bx of [cx - dir * 2.7, cx - dir * 1.7]) { const basin = cyl(0.17, 0.13, 0.12, 12, cer); basin.position.set(bx, 0.86, cz + hd - 0.4); add(basin); }
        const mirror = new THREE.Mesh(track(new THREE.PlaneGeometry(1.8, 0.7)), track(new THREE.MeshStandardMaterial({ color: 0xcfe0ea, metalness: 0.9, roughness: 0.06 })));
        mirror.position.set(cx - dir * 2.2, 1.55, cz + hd - 0.08); mirror.rotation.y = Math.PI; add(mirror);
        blob(cx - dir * 2.2, cz + hd - 0.5, 2.2, 1.0);
        add(rat(0.07, 2.0, 1.9, stallMat, cx + dir * (hw - 1.0), 1.0, cz, 0.02));   // 門內屏風牆：擋住走廊直視隔間
        furn("potted_plant", cx + dir * (hw - 0.5), cz - hd + 0.5, 0, 0.9);
        wanderPoints.push({ x: cx - dir * 0.6, z: cz - hd + 1.9, tag: "wc" });      // 隔間前
        wanderPoints.push({ x: cx - dir * 2.2, z: cz + hd - 1.2, tag: "wc" });      // 洗手台前
        return;
      }

      if (room.kind === "store") {
        // 儲藏室：格數為奇數時補滿最後一格的低調機能房——層架＋紙箱堆
        furn("bookshelf", cx - hw + 0.55, cz - hd + 0.65, Math.PI / 2, 1.8);
        furn("bookshelf", cx - hw + 0.55, cz + hd - 0.95, Math.PI / 2, 1.8);
        furn("filing_drawers", cx + hw - 0.6, cz + hd - 0.6, -Math.PI / 2, 0.95);
        const card = mm(0xb8926a, { roughness: 0.9 });                // 紙箱
        const bx0 = cx + 0.5, bz0 = cz - hd + 0.55;
        add(rat(0.62, 0.5, 0.55, card, bx0, 0.25, bz0, 0.02));
        add(rat(0.5, 0.44, 0.48, card, bx0 - 0.72, 0.22, bz0 + 0.06, 0.02));
        add(rat(0.46, 0.4, 0.42, card, bx0 - 0.34, 0.72, bz0 + 0.02, 0.02));  // 疊上層
        blob(bx0 - 0.3, bz0, 2.0, 0.9);
        furn("trash_can", cx + hw - 0.55, cz - hd + 0.5, 0, 0.5);
        return;
      }

      if (room.kind === "dining") {
        // 餐廳：兩張圓桌配椅＋後牆廚房線(冰箱/檯面/微波爐)＋發光販賣機；午餐時段 NPC 優先過來
        const tblTop = mm(0xd8c6a8, { roughness: 0.6 });
        for (const sx of [-1.4, 1.4]) {
          const tx = cx + sx, tz = cz + 0.55;
          const ped = cyl(0.09, 0.14, 0.7, 10, mm(0x6b737d)); ped.position.set(tx, 0.35, tz); add(ped);
          const top = cyl(0.6, 0.6, 0.06, 18, tblTop); top.position.set(tx, 0.73, tz); top.castShadow = true; add(top);
          for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * Math.PI * 2 + 0.45;
            const chx = tx + Math.cos(ang) * 0.98, chz = tz + Math.sin(ang) * 0.98;
            furn("office_chair", chx, chz, Math.atan2(tx - chx, tz - chz), 0.9);
          }
          blob(tx, tz, 1.6);
          wanderPoints.push({ x: tx, z: tz + 1.25, tag: "eat" });
          pushSpot("rest", tx, tz + 1.1, Math.atan2(0, -1));          // 休息站位：站在桌旁（面向桌）
        }
        // 廚房線沿後牆：冰箱＋檯面＋微波爐；販賣機靠外側牆、正面發光（夜裡是餐廳的光點）
        const steel = mm(0xdfe3e8, { metalness: 0.5, roughness: 0.35 });
        add(rat(0.85, 1.75, 0.68, steel, cx - hw + 0.65, 0.9, cz - hd + 0.45, 0.05));                 // 冰箱
        add(rat(0.05, 0.5, 0.05, mm(0x8a9098), cx - hw + 0.28, 1.1, cz - hd + 0.12, 0.02));           // 冰箱把手
        add(rat(2.3, 0.85, 0.6, mm(0x7c8794, { roughness: 0.75 }), cx - hw + 2.35, 0.43, cz - hd + 0.42, 0.03)); // 檯面櫃
        add(rat(2.3, 0.05, 0.64, steel, cx - hw + 2.35, 0.88, cz - hd + 0.42, 0.01));                 // 不鏽鋼檯面
        add(rat(0.5, 0.3, 0.4, mm(0x2b2f36), cx - hw + 1.7, 1.05, cz - hd + 0.42, 0.03));             // 微波爐
        const vend = rat(0.95, 1.8, 0.7, mm(0x1d2733), cx + hw - 0.7, 0.92, cz - hd + 0.47, 0.04); add(vend);
        const vendFace = new THREE.Mesh(track(new THREE.PlaneGeometry(0.66, 1.35)), track(new THREE.MeshStandardMaterial({ color: 0x0c1626, emissive: 0x5fc9ff, emissiveIntensity: 0.7, roughness: 0.4 })));
        vendFace.position.set(cx + hw - 0.7, 1.0, cz - hd + 0.83); add(vendFace);
        blob(cx - hw + 1.6, cz - hd + 0.5, 3.6, 1.1); blob(cx + hw - 0.7, cz - hd + 0.6, 1.2);
        furn("water_cooler", cx + hw - 0.55, cz + hd - 0.7, -Math.PI / 2, 1.3);
        furn("potted_plant", cx - hw + 0.5, cz + hd - 0.6, 0, 1.0);
        furn("floor_lamp", cx + hw - 1.5, cz + hd - 0.55, 0, 1.6);
        const dl = new THREE.PointLight(0xffd39a, 0, 6.5, 2); dl.position.set(cx + hw - 1.5, 1.55, cz + hd - 0.55); dl.userData.max = 1.4; scene.add(dl); lampLights.push(dl);
        wanderPoints.push({ x: cx - hw + 1.7, z: cz - hd + 1.5, tag: "eat" });  // 檯面前（裝咖啡）
        return;
      }

      if (room.kind === "command") {
        // 作戰室：橢圓長桌 + 環桌座椅 + 桌面螢幕（呼應像素風作戰室，全隊開會的地方）
        // 桌尺寸獨立設上限＝房間跨滿寬度時桌不會跟著爆大，四周留白給人流與圍站。
        const tw = Math.min(w * 0.42, 6.0), td = Math.min(d * 0.5, 2.7), ty = 0.72;
        warNav = { cx, cz, frontZ: cz + hd - 0.45, halfTW: tw / 2 };   // 記錄大桌範圍給 routeTo 繞行
        const ped = cyl(td * 0.42, td * 0.5, ty, 18, mm(0x2c3a52)); ped.position.set(cx, ty / 2, cz); add(ped);
        const topG = new THREE.Group();
        topG.add(rat(tw, 0.12, td, mm(0x3f5170), 0, 0, 0, Math.min(td, tw) * 0.45));
        // 三片嵌入桌面的發光螢幕
        [[-tw * 0.26, 0x8fe6ff], [0, 0xffd27a], [tw * 0.26, 0x8fe6ff]].forEach(([sx, gl]) => {
          const scr = new THREE.Mesh(track(new THREE.PlaneGeometry(tw * 0.16, td * 0.4)), track(new THREE.MeshStandardMaterial({ color: 0x0c1626, emissive: gl as number, emissiveIntensity: 0.8, roughness: 0.4 })));
          scr.rotation.x = -Math.PI / 2; scr.position.set(sx as number, 0.065, 0); topG.add(scr);
        });
        topG.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { me.castShadow = true; me.receiveShadow = true; } });
        topG.position.set(cx, ty, cz); add(topG);
        // 環桌 8 椅，面朝桌心；每張椅同時登記成一個 meeting 站位（NPC 開會走過來、面朝桌心圍站）
        const N = 8;
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * Math.PI * 2;
          const chx = cx + Math.cos(ang) * (tw / 2 + 0.42), chz = cz + Math.sin(ang) * (td / 2 + 0.42);
          const ry = Math.atan2(cx - chx, cz - chz);
          furn("office_chair", chx, chz, ry, 0.95);
          pushSpot("meeting", cx + Math.cos(ang) * (tw / 2 + 0.66), cz + Math.sin(ang) * (td / 2 + 0.66), ry);
        }
        blob(cx, cz, tw * 1.3, td * 1.5);
        // 桌下大地毯：把圓桌區錨在大廳中央（寬敞感＝行政指揮大廳，不是空曠）
        furn("rug", cx, cz, 0, Math.min(w * 0.42, 6.6));
        // 後牆大型顯示牆（含外框）＝視覺焦點，填掉後方空白
        const dw = Math.min(w * 0.3, 4.2);
        add(rat(dw + 0.18, 1.7, 0.09, mm(0x1a2334), cx, 1.62, cz - hd + 0.12, 0.04));
        const disp = new THREE.Mesh(track(new THREE.PlaneGeometry(dw, 1.5)), track(new THREE.MeshStandardMaterial({ color: 0x0b1420, emissive: 0x2f6bff, emissiveIntensity: 0.6, roughness: 0.35 })));
        disp.position.set(cx, 1.62, cz - hd + 0.17); add(disp);
        // 左側空檔：洽談沙發角落（沙發面向 +z、前擺茶几＋地毯）＝把大廳一側做成非正式討論區
        const bx = cx - hw * 0.6;
        furn("rug", bx, cz + 0.1, 0, 2.6);
        furn("couch", bx, cz - 0.7, 0, 1.05);
        furn("coffee_table", bx, cz + 0.7, 0, 0.85);
        furn("potted_plant", bx - 1.3, cz - hd + 0.7, 0, 1.15);
        // 右側空檔：長書櫃靠後牆 + 落地燈 + 植栽，平衡另一側
        const rx = cx + hw * 0.6;
        furn("bookshelf", rx, cz - hd + 0.5, 0, 1.7);
        furn("potted_plant", rx - 1.1, cz + hd - 0.9, 0, 1.15);
        furn("floor_lamp", rx + 1.1, cz + hd - 0.9, 0, 1.6);
        const wl = new THREE.PointLight(0xffd39a, 0, 6.5, 2); wl.position.set(rx + 1.1, 1.55, cz + hd - 0.9); wl.userData.max = 1.4; scene.add(wl); lampLights.push(wl);
        // 兩前角植栽收邊
        furn("potted_plant", cx - hw + 0.7, cz + hd - 0.8, 0, 1.15);
        furn("potted_plant", cx + hw - 0.7, cz - hd + 0.7, 0, 1.15);
        wanderPoints.push({ x: bx, z: cz + 0.7 }); // 閒置去沙發區晃晃
        wanderPoints.push({ x: cx, z: cz + hd - 0.7 }); // 開會集合點
        return;
      }

      // 部門房：排成完整工位方格（桌貼近鏡頭側+z，角色坐桌後-z 面向鏡頭 ry=PI）。
      // 沒人的位子也擺一張帶發光螢幕的空桌＝辦公室工位永遠多於人、每台都亮著（像參考圖那樣塞滿）。
      const glow = DESK_GLOWS[ri % DESK_GLOWS.length];
      const n = room.members.length;
      for (let r = 0; r < room.rows; r++) {
        const deskZ = cz + hd - ROOM_FRONT - r * ROW_PITCH;
        const seatZ = deskZ - SEAT_BACK;
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const x = cx + (c - (cols - 1) / 2) * DESK_PITCH;
          const desk = furn("office_desk", x, deskZ, 0, DESK_W);
          deskSet(x, desk, deskZ, glow);
          // 每張桌都配一張椅＝空位也是「可坐的空工位」；新增 NPC 時 roster 變→重建，
          // 新人依部門順序排到 idx=n 這格＝原本的空位，等於自動入座空的位子。
          furn("office_chair", x, seatZ, 0, 0.95);   // 椅面朝 +z 桌子（椅背在後）＝與 NPC 同向
          if (idx < n) seatMap.set(room.members[idx].id, { x, z: seatZ, ry: Math.PI });
        }
      }
      // 佈置：靠後牆置物櫃/書櫃＋角落盆栽（＋大房加垃圾桶），讓房間看起來真的有人在用
      furn(ri % 2 ? "bookshelf" : "filing_drawers", cx - hw + 0.55, cz - hd + 0.55, Math.PI / 2, ri % 2 ? 1.8 : 0.95);
      furn("potted_plant", cx + hw - 0.45, cz + hd - 0.7, 0, 0.95);
      if (w > 4.6) furn("trash_can", cx - hw + 0.5, cz + hd - 0.7, 0, 0.5);
    });

    // 牆掛物：時鐘、佈告欄（掛在前兩間房後牆）
    if (firstBackWall) mountOnWall(firstBackWall, clockFace(), (firstBackWall as THREE.Mesh).position.x - 0.7, 2.05);
    if (secondBackWall) mountOnWall(secondBackWall, corkBoard(1.1, 0.85), (secondBackWall as THREE.Mesh).position.x + 0.6, 1.75);
    else if (firstBackWall) mountOnWall(firstBackWall, corkBoard(1.1, 0.85), (firstBackWall as THREE.Mesh).position.x + 0.7, 1.75);

    // 前庭活動站：一排「終端機／寫程式／讀檔案／上網查／查核／任務板」站點，
    // NPC 依目前用的工具（character.station）走過來站定＝呼應像素風那排會走過去的活動站點。
    // 三面外牆已把前庭圍住，鋪上室內木地板＋房名＝把整排站點收成一間「共用工作區」，不再像戶外散站。
    floor((minX + maxX) / 2, (maxZ + frontZ) / 2, lotW - 0.3, FRONT_MARGIN - 0.3, roomFloorMats[0]);
    roomSign("共用工作區", (minX + maxX) / 2, maxZ + 0.8);
    const yardZ = maxZ + FRONT_MARGIN * 0.42;       // 站點線（前庭偏房間側，前方留一段開闊廣場）
    const standZ = yardZ - 0.95;                    // NPC 站位（房間側，面朝 +z 的站點與鏡頭）
    const stDefs: Array<[string, string, string, number]> = [
      ["terminal", "終端機", "office_desk", 0x8fe6ff],
      ["code", "寫程式", "office_desk", 0x9fffb0],
      ["books", "讀檔案", "bookshelf", 0xffcf8f],
      ["web", "上網查", "office_desk", 0x8fd0ff],
      ["check", "查核", "filing_drawers", 0xff9fd0],
      ["board", "任務板", "", 0xffe14a],
    ];
    const yardW = Math.max(maxX - minX - 0.6, stDefs.length * 2.0);
    const step = yardW / stDefs.length, yardX0 = (minX + maxX) / 2 - yardW / 2;
    stDefs.forEach(([key, label, kind, glow], i) => {
      const x = yardX0 + step * (i + 0.5);
      if (kind === "office_desk") { const d = furn(kind, x, yardZ, Math.PI, 1.0); deskSet(x, d, yardZ, glow); }
      else if (kind) { furn(kind, x, yardZ, Math.PI, kind === "bookshelf" ? 1.6 : 1.0); }
      else {
        // 任務板：立柱式佈告欄
        const post = cyl(0.06, 0.07, 1.0, 8, mm(0x5a4632)); post.position.set(x, 0.5, yardZ); add(post);
        const cb = corkBoard(0.9, 0.7); cb.position.set(x, 1.2, yardZ); cb.rotation.y = Math.PI; add(cb);
      }
      roomSign(label, x, yardZ);                    // 站點浮牌
      pushSpot(key, x - 0.6, standZ, Math.PI);      // 每站兩個站位＝多人同工具也排得下（拉開＝互動不擠不誤觸）
      pushSpot(key, x + 0.6, standZ, Math.PI);
      blob(x, standZ, 1.5);                         // 站點淨空圈：外圍留白，焦點突出
    });
    // 飲水機＋角落植栽/落地燈：保留一點生活感與夜燈
    if (lotW > 4) {
      furn("water_cooler", maxX + LOT_MARGIN * 0.55, yardZ, -Math.PI / 2, 1.35);
      furn("potted_plant", minX - LOT_MARGIN * 0.5, yardZ, 0, 1.1);
      furn("floor_lamp", minX - LOT_MARGIN * 0.3, yardZ - 0.6, 0, 1.6);
      const lamp = new THREE.PointLight(0xffd39a, 0, 6.5, 2); lamp.position.set(minX - LOT_MARGIN * 0.3, 1.55, yardZ - 0.6); lamp.userData.max = 1.6; scene.add(lamp); lampLights.push(lamp);
      wanderPoints.push({ x: maxX + LOT_MARGIN * 0.55 - 0.55, z: yardZ - 0.2 });  // 閒置去飲水機晃晃
    }

    // 大樓外殼：地基厚邊 + 一圈開窗外牆，把散落的房間包成「一棟辦公大樓」（前緣留大門進出、近鏡頭淡出）
    const lotCx = (minX + maxX) / 2, foundH = 0.7;
    const found = new THREE.Mesh(track(new THREE.BoxGeometry(lotW, foundH, lotD)), foundMat);
    found.position.set(lotCx, -foundH / 2 + 0.02, lotCz); found.castShadow = true; found.receiveShadow = true; add(found);
    // 外圍改成玻璃帷幕塔身：本層落地窗 + 上方數層玻璃樓層 + 頂樓機房（取代原不透明外牆＋大門，讓這層讀成摩天樓中的一層）
    buildTower(minX - LOT_MARGIN, maxX + LOT_MARGIN, backZ, frontZ);
    const gate = 3.6;

    // 大門口兩側植栽
    furn("potted_plant", -gate / 2 - 0.3, frontZ - 0.15, 0, 1.1);
    furn("potted_plant", gate / 2 + 0.3, frontZ - 0.15, 0, 1.1);

    // 老闆桌：擺在前庭廣場靠大門處、面向辦公室（＝你這個 BOSS 的位置）。臨時 NPC 做完走來這裡揮手回報再消失。
    const bossZ = frontZ - 1.5;
    const bdesk = furn("office_desk", lotCx, bossZ, 0, 1.2); deskSet(lotCx, bdesk, bossZ, 0xffd24a);
    furn("office_chair", lotCx, bossZ + 0.75, Math.PI, 1.0);   // 老闆椅在桌後（+z 側，面向 -z 辦公室）
    furn("potted_plant", lotCx - 1.5, bossZ, 0, 1.0);
    roomSign("👑 BOSS", lotCx, bossZ - 0.2);
    bossSpot = { x: lotCx, z: bossZ - 1.1, ry: 0 };            // 報告站位：桌子辦公室側 1.1m，面向 +z 的老闆桌
    blob(lotCx, bossZ, 1.8);

    // 外圍四角路燈
    const ex = maxX + LOT_MARGIN * 0.85, iz = frontZ - 0.4, nz = backZ + 0.3, nx = minX - LOT_MARGIN * 0.85;
    streetLight(nx, nz); streetLight(ex, nz); streetLight(nx, iz); streetLight(ex, iz);

    // 周邊街區：樹/灌木/停車/馬路人行道/遠景大樓，讓大樓坐落在有縱深的環境裡
    buildSurroundings(minX, maxX, minZ, maxZ, lotCx);

    // 降環境反射避免泛白
    world.traverse((o) => { const me = o as THREE.Mesh; const mat = me.material as THREE.MeshStandardMaterial; if (mat && "envMapIntensity" in mat && mat.envMapIntensity === 1) mat.envMapIntensity = 0.16; });

    // 首次佈局依建物大小把鏡頭縮放對好（之後保留使用者縮放）
    if (!camFitted) {
      const ext = Math.max(maxX - minX, maxZ - minZ) + LOT_MARGIN;
      // Portrait frames by width (see updateProj), so D is a horizontal half-extent
      // there and needs a wider cap to fit the whole floorplate.
      D = Dtarget = camAspect < 1
        ? THREE.MathUtils.clamp(ext * 0.62, 6, 18)
        : THREE.MathUtils.clamp(ext * 0.6, 5, 11);
      updateProj();
      camFitted = true;
    }
    applyDaylight();
  }

  // ---- 角色 ----
  const SCALE = 1.0;
  const PB_Y = 2.05 * SCALE;
  function plumbob() {
    const geo = track(new THREE.OctahedronGeometry(0.14));
    const pb = new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({ color: 0x39ff14, emissive: 0x1fbf2a, emissiveIntensity: 0.7, roughness: 0.25, transparent: true, opacity: 0.9 })));
    pb.scale.set(0.7, 1.4, 0.7); noCast(pb); return pb;
  }
  function nameSprite(text: string) {
    const c = document.createElement("canvas"); const ctx = c.getContext("2d")!;
    const font = "600 44px 'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif";
    ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 36; c.width = w; c.height = 72;
    ctx.font = font; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(28,36,52,.72)"; roundRect(ctx, 0, 8, w, 56, 14); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(text, 18, 38);
    const tex = track(new THREE.CanvasTexture(c)); tex.anisotropy = 4;
    const spr = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })));
    spr.scale.set(w / 72 * 0.5, 0.5, 1); spr.renderOrder = 5; noCast(spr); return spr;
  }
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function pickClip(clips: THREE.AnimationClip[], names: string[]): THREE.AnimationClip | null {
    for (const n of names) {
      const c = clips.find((cl) => cl.name.endsWith("|" + n)) || clips.find((cl) => cl.name.includes(n));
      if (c) return c;
    }
    return clips[0] || null;
  }

  const charGroup = new THREE.Group(); world.add(charGroup);
  const actors: Actor[] = [];
  const pickTargets: THREE.Object3D[] = []; // 隱形點擊代理（skinned mesh 直接 raycast 會漏，改用 box 代理）
  let activeId: string | null = null;
  let focusId: string | null = null; // 雙擊聚焦跟隨的角色（null＝看向中心）

  // 選取地面光環（跟著被選的 NPC、脈動）
  const selRing = new THREE.Mesh(
    track(new THREE.RingGeometry(0.32, 0.46, 40)),
    track(new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, depthTest: false })),
  );
  selRing.rotation.x = -Math.PI / 2; selRing.position.y = 0.12; selRing.visible = false; selRing.renderOrder = 20; noCast(selRing); world.add(selRing);

  function clearActors() {
    for (const a of actors) { a.mixer.stopAllAction(); charGroup.remove(a.root); charGroup.remove(a.pb); charGroup.remove(a.label); charGroup.remove(a.shadow); charGroup.remove(a.bubble); (a.bubble.material as THREE.SpriteMaterial).dispose(); charGroup.remove(a.panel); (a.panel.material as THREE.SpriteMaterial).dispose(); }
    actors.length = 0;
    pickTargets.length = 0;
  }

  // ---- 工作小窗（SAMS 風）：NPC 忙碌站定工作時頭上浮出的螢幕面板，顯示站點主題＋即時任務文字 ----
  // label＝工作站名稱；plain＝大白話標題（頭頂小窗直接顯示這句，一看就懂 NPC 在幹嘛）。
  const STATION_THEME: Record<string, { label: string; plain: string; bg: string; fg: string; accent: string; kind: string }> = {
    terminal: { label: "終端機", plain: "正在執行指令",   bg: "#0c1220", fg: "#bfe6cf", accent: "#58f08a", kind: "term" },
    code:     { label: "編輯器", plain: "正在寫程式",     bg: "#12151f", fg: "#d6def0", accent: "#7aa2ff", kind: "code" },
    web:      { label: "瀏覽器", plain: "正在上網查資料", bg: "#f3f6fb", fg: "#28323f", accent: "#3f8cff", kind: "web" },
    books:    { label: "知識庫", plain: "正在查閱文件",   bg: "#1c1710", fg: "#ead9c0", accent: "#e0b060", kind: "docs" },
    check:    { label: "驗證",   plain: "正在驗證測試",   bg: "#0f1719", fg: "#cfeae2", accent: "#35d0b0", kind: "check" },
    board:    { label: "看板",   plain: "正在更新看板",   bg: "#171226", fg: "#e4dcf3", accent: "#b98cff", kind: "board" },
    meeting:  { label: "白板",   plain: "正在開會討論",   bg: "#161a24", fg: "#dde4f0", accent: "#8fd0ff", kind: "board" },
  };
  const PANW = 400, PANH = 340;   // 加大＝瀏覽器截圖區更大、字讀得出來（web 站點最需要）
  // Tier 3：真實瀏覽器截圖快取（查詢字 → <img>）。載到才畫進小窗；快取上限 40 筆避免無邊界成長。
  const shotCache = new Map<string, { img: HTMLImageElement; ready: boolean; failed: boolean }>();
  function getShot(query: string) {
    const k = query.slice(0, 300);
    let e = shotCache.get(k);
    if (!e) {
      const img = new Image();
      e = { img, ready: false, failed: false };
      const entry = e;
      img.onload = () => { entry.ready = true; };
      img.onerror = () => { entry.failed = true; };
      img.src = "/api/webshot?q=" + encodeURIComponent(query);
      shotCache.set(k, e);
      if (shotCache.size > 40) { const old = shotCache.keys().next().value; if (old) shotCache.delete(old); }
    }
    return e;
  }
  function makePanel(): { sprite: THREE.Sprite; tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D } {
    const c = document.createElement("canvas"); c.width = PANW; c.height = PANH;
    const ctx = c.getContext("2d")!;
    const tex = track(new THREE.CanvasTexture(c)); tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, opacity: 0 }));
    spr.scale.set(2.3, 2.3 * PANH / PANW, 1); spr.renderOrder = 7; spr.visible = false; noCast(spr);
    return { sprite: spr, tex, ctx };
  }
  function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, max: number): string[] {
    const out: string[] = []; let line = "";
    for (const ch of text) {
      if (ch === "\n") { out.push(line); line = ""; if (out.length >= max) break; continue; }
      if (ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; if (out.length >= max) break; }
      else line += ch;
    }
    if (line && out.length < max) out.push(line);
    if (out.length === max && line) out[max - 1] = out[max - 1].replace(/.$/, "…");
    return out;
  }
  function drawPanel(a: Actor) {
    const done = (a.doneUntil ?? 0) > 0;
    let st = a.station || "home";
    let query = a.webQuery;
    // web 截圖黏著：station 已切走但黏著窗未過＝續用 web 主題＋最後查詢字，讓慢回的截圖補上來
    if (!done && (a.webUntil ?? 0) > performance.now() && a.stickyWebQuery && STATION_THEME[st]?.kind !== "web") {
      st = "web"; query = a.stickyWebQuery;
    }
    const th = STATION_THEME[st];
    // web 站點且有查詢字＝要抓真實截圖；把載入狀態併進 key，圖到了下一幀自動重畫。
    const shot = (th?.kind === "web" && !done && query) ? getShot(query) : null;
    const shotState = shot ? (shot.ready ? 2 : shot.failed ? 1 : 0) : -1;
    const key = `${st}|${a.speech ?? ""}|${a.mood ?? ""}|${done ? 1 : 0}|${query ?? ""}|${shotState}`;
    if (key === a.panelKey) return;
    a.panelKey = key;
    const ctx = a.panelCtx;
    ctx.clearRect(0, 0, PANW, PANH);
    if (!th) { a.panelTex.needsUpdate = true; return; }
    // 底 + 邊框
    ctx.fillStyle = th.bg; roundRect(ctx, 5, 5, PANW - 10, PANH - 10, 16); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = done ? "#39d96b" : th.accent; ctx.stroke();
    // 標題列
    ctx.save(); roundRect(ctx, 5, 5, PANW - 10, 44, 16); ctx.clip();
    ctx.fillStyle = th.accent; ctx.fillRect(5, 5, PANW - 10, 44); ctx.restore();
    ctx.fillStyle = "#0b0f16"; ctx.textBaseline = "middle";
    ctx.font = "700 22px 'PingFang TC','Microsoft JhengHei',sans-serif"; ctx.fillText(done ? "✓ 完成，回報中" : th.plain, 20, 28);
    // 狀態燈
    ctx.beginPath(); ctx.arc(PANW - 28, 27, 9, 0, Math.PI * 2);
    ctx.fillStyle = done ? "#0a7e37" : (a.mood === "error" ? "#c0392b" : a.mood === "success" ? "#0a7e37" : "#0b0f16"); ctx.fill();
    // 內文
    const body = done ? "✓ 完成，走去回報…" : (a.speech || "執行中…");
    ctx.fillStyle = th.fg;
    let bodyY = 74, bodyX = 22, bodyW = PANW - 44;
    if (th.kind === "web" && !done) {   // 瀏覽器：網址列 ＋ 真實截圖視窗（Tier 3）
      ctx.fillStyle = "#dfe6ee"; roundRect(ctx, 18, 60, PANW - 36, 26, 8); ctx.fill();
      ctx.fillStyle = "#7c8a99"; ctx.beginPath(); ctx.arc(34, 73, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#4a5a68"; ctx.font = "500 15px 'PingFang TC',sans-serif";
      const urlText = query ? (/^https?:\/\//i.test(query) ? query : "search · " + query) : "search · " + (a.name || "");
      ctx.fillText(wrapLines(ctx, urlText, PANW - 90, 1)[0] ?? "", 48, 74);
      // 截圖視窗
      const vx = 18, vy = 92, vw = PANW - 36, vh = PANH - 92 - 10;
      ctx.save(); roundRect(ctx, vx, vy, vw, vh, 8); ctx.clip();
      ctx.fillStyle = "#ffffff"; ctx.fillRect(vx, vy, vw, vh);
      const img = shot?.ready ? shot.img : null;
      if (img && img.naturalWidth) {
        const s = Math.max(vw / img.naturalWidth, vh / img.naturalHeight); // cover，對齊頂部
        ctx.drawImage(img, vx + (vw - img.naturalWidth * s) / 2, vy, img.naturalWidth * s, img.naturalHeight * s);
      } else {
        ctx.fillStyle = "#9aa7b4"; ctx.font = "500 15px 'PingFang TC',sans-serif"; ctx.textAlign = "center";
        ctx.fillText(shot?.failed ? "（截圖失敗）" : "載入實時畫面…", vx + vw / 2, vy + vh / 2);
        ctx.textAlign = "left";
      }
      ctx.restore();
      a.panelTex.needsUpdate = true;
      return;   // 瀏覽器小窗自己畫完整塊，不走下面通用文字排版
    }
    const mono = th.kind === "term" || th.kind === "code";
    ctx.font = (mono ? "500 18px 'Menlo','Consolas',monospace" : "500 19px 'PingFang TC','Microsoft JhengHei',sans-serif");
    const prefix = th.kind === "term" ? "$ " : th.kind === "check" ? "☑ " : th.kind === "board" ? "• " : "";
    const lines = wrapLines(ctx, prefix + body, bodyW, 4);
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bodyX, bodyY + i * 27);
    a.panelTex.needsUpdate = true;
  }

  function buildActors(workers: WorkerLite[]) {
    clearActors();
    workers.forEach((w, i) => {
      const g = charGltfs[((w.colorIndex ?? i) % CHAR_FILES.length + CHAR_FILES.length) % CHAR_FILES.length];
      const seat = seatMap.get(w.id) ?? { x: (i % 6) * 1.6 - 4, z: 3.6 + Math.floor(i / 6) * 1.6, ry: Math.PI };
      const rig = skClone(g.scene);
      rig.traverse((o) => {
        const me = o as THREE.Mesh;
        if (me.isMesh) { me.castShadow = true; me.receiveShadow = true; me.frustumCulled = false; const mat = me.material as THREE.MeshStandardMaterial; if (mat && "envMapIntensity" in mat) mat.envMapIntensity = 0.5; }
      });
      rig.scale.setScalar(SCALE); rig.position.set(seat.x, 0, seat.z); rig.rotation.y = seat.ry;
      rig.userData.workerId = w.id;
      charGroup.add(rig);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.7, 0.62), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      proxy.position.set(0, 0.85, 0); proxy.userData.workerId = w.id; rig.add(proxy);
      pickTargets.push(proxy);
      const pb = plumbob(); pb.position.set(seat.x, PB_Y, seat.z); charGroup.add(pb);
      const label = nameSprite(w.name); label.position.set(seat.x, PB_Y + 0.42, seat.z); charGroup.add(label);
      const shadow = new THREE.Mesh(charBlobGeo, charBlobMat); shadow.rotation.x = -Math.PI / 2; shadow.position.set(seat.x, 0.06, seat.z); shadow.renderOrder = 1; noCast(shadow); charGroup.add(shadow);
      const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: busyBubbles[0], transparent: true, depthTest: false, depthWrite: false, opacity: 0.97 }));
      bubble.scale.set(0.62, 0.6, 1); bubble.position.set(seat.x, PB_Y + 1.0, seat.z); bubble.visible = false; bubble.renderOrder = 6; noCast(bubble); charGroup.add(bubble);
      const pan = makePanel(); pan.sprite.position.set(seat.x + 0.15, 3.15, seat.z); pan.sprite.userData.workerId = w.id; charGroup.add(pan.sprite);
      const mixer = new THREE.AnimationMixer(rig);
      const clip = pickClip(g.animations, w.busy ? BUSY_CLIPS : IDLE_CLIPS);
      let baseAction: THREE.AnimationAction | null = null;
      if (clip) { baseAction = mixer.clipAction(clip); baseAction.time = Math.random() * 2; baseAction.play(); }
      actors.push({ id: w.id, name: w.name, root: rig, mixer, pb, label, shadow, phase: Math.random() * 6, gltfAnimations: g.animations, busy: w.busy, baseAction, walkAction: null, state: "home", home: { x: seat.x, z: seat.z }, target: null, path: [], returnAt: 0, emoting: false, bubble, bubbleUntil: Math.random() * 3, visitHost: null, reported: false, stationKey: "", homeRy: seat.ry, panel: pan.sprite, panelTex: pan.tex, panelCtx: pan.ctx, panelVis: 0, panelKey: "", station: w.station, speech: w.speech, mood: w.mood, webQuery: w.webQuery });
    });
    applyActive();
  }

  function applyActive() {
    for (const a of actors) {
      const on = a.id === activeId;
      (a.pb.material as THREE.MeshStandardMaterial).color.set(on ? 0xffe14a : 0x39ff14);
      (a.pb.material as THREE.MeshStandardMaterial).emissive.set(on ? 0xffb020 : 0x1fbf2a);
      a.pb.scale.setScalar(on ? 1.35 : 1).multiply(new THREE.Vector3(0.7, 1.4, 0.7));
    }
  }

  // 依 character.station 把每個 NPC 指派到對應站位，站點變了就起身走過去（home/desk＝回自己桌）。
  // 同一站多人時 round-robin 分到不同站位；找不到站點就退回自己桌。這是「NPC 會走過去」的驅動核心。
  function assignStations(workers: WorkerLite[]) {
    const cursor = new Map<string, number>();
    for (const w of workers) {
      const a = actors.find((x) => x.id === w.id);
      if (!a) continue;
      if (a.reported) continue;   // 已去 host 回報的臨時 NPC 就留在 host 旁等移除，別再被派回自己座位
      const st = w.station || "home";
      let spot: { x: number; z: number; ry: number } | undefined;
      if (st === "home" || st === "desk") spot = seatMap.get(w.id);
      else {
        const pool = stationSpots.get(st);
        if (pool && pool.length) { const k = cursor.get(st) || 0; spot = pool[k % pool.length]; cursor.set(st, k + 1); }
      }
      if (!spot) spot = seatMap.get(w.id);
      if (!spot) continue;
      const key = `${st}:${spot.x.toFixed(2)},${spot.z.toFixed(2)}`;
      if (a.stationKey === key) continue;      // 站位沒變＝不重新走
      a.stationKey = key;
      a.home = { x: spot.x, z: spot.z };
      a.homeRy = spot.ry;
      // 沒在忙著走/情緒動作時就起身走過去；已在返程則直接改目標＝平順轉向
      if (a.state === "home" || a.state === "atWander") { a.emoting = false; startWalk(a, spot.x, spot.z, true); }
      else if (a.state === "toHome") { a.emoting = false; startWalk(a, spot.x, spot.z, true); } // 返程中改站位＝重新路由
    }
  }

  // ---- 角色動作 / 走動 ----
  const WALK_SPEED = 1.15;
  const STUCK_S = 4;   // 追擊時 dist 本應每幀變小；連續這麼久沒再靠近＝路徑死結，直接瞬移到終點收尾（純安全網，正常永不觸發）
  const isEphemeral = (n: string) => n.startsWith("\u{1F50D}") || n.startsWith("\u{1F3DB}"); // 🔍研究員 / 🏛圓桌＝短命工
  function playBase(a: Actor, names: string[]) {
    const clip = pickClip(a.gltfAnimations, names); if (!clip) return;
    const next = a.mixer.clipAction(clip);
    next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false;
    if (a.baseAction && a.baseAction !== next) a.baseAction.fadeOut(0.3);
    next.reset().fadeIn(0.3).play();
    a.baseAction = next;
  }
  function startWalk(a: Actor, tx: number, tz: number, toHome: boolean) {
    const wps = routeTo(a.root.position.x, a.root.position.z, tx, tz);
    a.target = wps[0]; a.path = wps.slice(1);       // 沿走廊/門逐點走，最後一點＝目的地
    a.state = toHome ? "toHome" : "toWander";
    a.lastDist = Infinity;                           // 新一段行走＝重置卡住偵測（首幀必判為有進展）
    const clip = pickClip(a.gltfAnimations, ["Walk"]);
    if (clip) {
      a.walkAction = a.mixer.clipAction(clip);
      a.baseAction?.fadeOut(0.2);
      a.walkAction.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.2).play();
    }
  }
  function onArrive(a: Actor, tt: number) {
    a.walkAction?.fadeOut(0.2);
    playBase(a, a.busy ? BUSY_CLIPS : IDLE_CLIPS);
    a.target = null;
    if (a.state !== "toWander") { a.root.rotation.y = a.homeRy; } // 回到 home/站位＝面向該站的螢幕/桌心/鏡頭
    if (a.state === "toWander") {
      a.state = "atWander"; a.returnAt = tt + 3 + Math.random() * 4;
      emote(a);
      // 去找同事的話：訪客轉身面向對方，並讓還在座位上的同事也回個招呼＝兩人「聊兩句」
      if (a.visitHost) {
        const host = actors.find((h) => h.id === a.visitHost);
        if (host && !host.busy && host.state === "home") {
          a.root.rotation.y = Math.atan2(host.root.position.x - a.root.position.x, host.root.position.z - a.root.position.z);
          emote(host);
        }
        a.visitHost = null;
      }
    }
    else { a.state = "home"; }
  }
  function emote(a: Actor) {
    if (a.busy || a.emoting || a.state === "toWander" || a.state === "toHome" || !a.baseAction) return;
    const clip = pickClip(a.gltfAnimations, ["Wave", "Interact"]);
    if (!clip) return;
    const act = a.mixer.clipAction(clip);
    act.reset(); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true;
    const base = a.baseAction;
    base.fadeOut(0.3);
    act.fadeIn(0.3).play();
    a.emoting = true;
    const onFin = (e: { action: THREE.AnimationAction }) => {
      if (e.action !== act) return;
      a.mixer.removeEventListener("finished", onFin as never);
      act.fadeOut(0.3);
      base.reset().fadeIn(0.3).play();
      a.emoting = false;
    };
    a.mixer.addEventListener("finished", onFin as never);
  }
  let nextEmoteAt = 3;
  let nextWanderAt = 4;
  let daylightAccum = 0;

  // hover 提示
  const tip = document.createElement("div");
  tip.style.cssText = "position:fixed;left:0;top:0;z-index:50;pointer-events:none;padding:4px 9px;border-radius:8px;font:600 12px/1.3 'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif;color:#fff;background:rgba(28,36,52,.86);box-shadow:0 2px 8px rgba(0,0,0,.3);transform:translate(-50%,-140%);white-space:nowrap;display:none";
  document.body.appendChild(tip);

  // ---- Event log（SAMS 風）：左下角浮一條彩色活動流，記 NPC 走去哪個站點／做完什麼 ----
  const LOG_PALETTE = ["#7ad0ff", "#8affc0", "#ffcf6a", "#ff9ecb", "#b79bff", "#ff9f7a", "#6ee7d0", "#ffe14a"];
  const logBox = document.createElement("div");
  logBox.style.cssText = "position:fixed;left:76px;bottom:104px;z-index:40;pointer-events:none;max-width:280px;display:flex;flex-direction:column-reverse;gap:3px;font:500 11.5px/1.35 'Menlo','PingFang TC','Microsoft JhengHei',monospace;text-shadow:0 1px 3px rgba(0,0,0,.6)";
  document.body.appendChild(logBox);
  function pushLog(name: string, text: string, colorIndex: number) {
    const line = document.createElement("div");
    const col = LOG_PALETTE[((colorIndex % LOG_PALETTE.length) + LOG_PALETTE.length) % LOG_PALETTE.length];
    line.style.cssText = `color:${col};opacity:0;transition:opacity .3s;background:rgba(12,18,30,.5);padding:2px 8px;border-radius:6px;border-left:2px solid ${col};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
    line.textContent = `${name} ${text}`;
    logBox.prepend(line);
    requestAnimationFrame(() => { line.style.opacity = "1"; });
    while (logBox.childElementCount > 5) logBox.lastElementChild?.remove();
    setTimeout(() => { line.style.opacity = "0"; setTimeout(() => line.remove(), 400); }, 9000);
  }

  // 點選角色
  const raycaster = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  // 目前可見的頭頂工作小窗（sprite）＝可點放大的目標
  function visiblePanels(): THREE.Object3D[] {
    return actors.filter((a) => a.panel.visible && a.panelVis > 0.3).map((a) => a.panel);
  }
  function onClick(e: PointerEvent) {
    if (dragMoved) return;
    const rect = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ptr, cam);
    // 先判頭頂工作小窗：點它＝選取＋展開焦點大螢幕（想看再放大）
    const pHits = raycaster.intersectObjects(visiblePanels(), false);
    if (pHits.length && pHits[0].object.userData.workerId) {
      const id = pHits[0].object.userData.workerId as string;
      onSelect?.(id); onExpand?.(id); return;
    }
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length && hits[0].object.userData.workerId) onSelect?.(hits[0].object.userData.workerId as string);
  }
  function onDblClick(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ptr, cam);
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length && hits[0].object.userData.workerId) {
      focusId = hits[0].object.userData.workerId as string;
      onSelect?.(focusId);
      Dtarget = 5.2;
    } else {
      focusId = null;
      panX = 0; panZ = 0;                  // 雙擊空白＝回到辦公室中心並取消平移
      Dtarget = camFitted ? D : 7.6;
    }
  }

  // 拖曳旋轉（左鍵）／平移（右鍵）
  let drag = false, lx = 0, ly = 0, dragMoved = false;
  let panning = false;
  let panX = 0, panZ = 0;                 // 使用者平移後的視野中心（world XZ），null focus 時 TARGET 收斂到這
  const PAN_LIMIT = 12;                   // 限制在辦公室範圍內，避免拖到空地
  function onDown(e: PointerEvent) {
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {          // 右鍵 或 Shift+左鍵 ＝平移
      panning = true; lx = e.clientX; ly = e.clientY; dragMoved = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    drag = true; lx = e.clientX; dragMoved = false;
  }
  function onMove(e: PointerEvent) {
    if (panning) {
      const mdx = e.clientX - lx, mdy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      const wpp = (2 * D) / (canvas.clientHeight || 640);   // 正交相機每像素對應的 world 距離
      const r = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0); r.y = 0; r.normalize();  // 螢幕右＝地面右
      const u = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1); u.y = 0; u.normalize();  // 螢幕上＝地面前（含俯角壓縮，除以 sin(EL) 還原）
      panX += (-r.x * mdx + u.x * mdy / Math.sin(EL)) * wpp;
      panZ += (-r.z * mdx + u.z * mdy / Math.sin(EL)) * wpp;
      panX = THREE.MathUtils.clamp(panX, -PAN_LIMIT, PAN_LIMIT);
      panZ = THREE.MathUtils.clamp(panZ, -PAN_LIMIT, PAN_LIMIT);
      focusId = null;                       // 平移即脫離角色跟隨
      tip.style.display = "none"; return;
    }
    if (drag) { const dx = e.clientX - lx; if (Math.abs(dx) > 3) dragMoved = true; azTarget += dx * 0.01; lx = e.clientX; tip.style.display = "none"; return; }
    const rect = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ptr, cam);
    // 頭頂工作小窗優先：懸停提示「點擊放大」，讓「可點」這件事看得出來
    const pHit = raycaster.intersectObjects(visiblePanels(), false);
    const pid = pHit.length ? (pHit[0].object.userData.workerId as string | undefined) : undefined;
    if (pid) {
      canvas.style.cursor = "pointer";
      const a = actors.find((x) => x.id === pid);
      if (a) { const pl = STATION_THEME[a.station || "home"]?.plain; tip.textContent = a.name + (pl ? "・" + pl : "") + "（🔍 點擊放大）"; tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; tip.style.display = "block"; }
      return;
    }
    const hit = raycaster.intersectObjects(pickTargets, false);
    const wid = hit.length ? (hit[0].object.userData.workerId as string | undefined) : undefined;
    if (wid) {
      canvas.style.cursor = "pointer";
      const a = actors.find((x) => x.id === wid);
      if (a) { tip.textContent = a.name + (a.busy ? "・工作中" : "・待命"); tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; tip.style.display = "block"; }
    } else { canvas.style.cursor = "default"; tip.style.display = "none"; }
  }
  function onUp() { drag = false; panning = false; }
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());   // 右鍵拖曳平移，屏蔽選單
  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("click", onClick as EventListener);
  canvas.addEventListener("dblclick", onDblClick as EventListener);

  // resize / 縮放
  let camAspect = 880 / 640;
  let Dtarget = D;
  function updateProj() {
    if (camAspect < 1) {
      // Portrait phones: the landscape formula (horizontal = D·aspect) shrinks the
      // horizontal view to a thin slice, cutting off the side desks/NPCs. Frame by
      // width instead — D is the horizontal half-extent — so the whole office fits
      // left-to-right; the extra room spills vertically into the sky.
      cam.left = -D; cam.right = D; cam.top = D / camAspect; cam.bottom = -D / camAspect;
    } else {
      cam.left = -D * camAspect; cam.right = D * camAspect; cam.top = D; cam.bottom = -D;
    }
    cam.updateProjectionMatrix();
  }
  function resize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 880;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 640;
    renderer.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
    camAspect = w / h; updateProj();
  }
  resize();
  function onWheel(e: WheelEvent) { e.preventDefault(); Dtarget = THREE.MathUtils.clamp(Dtarget + e.deltaY * 0.006, 4.5, 22); }
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // 動畫迴圈
  const clock = new THREE.Clock();
  const toCam = new THREE.Vector3();
  let raf = 0;
  let disposed = false;
  // 幀率上限：有操作時 30fps 順暢，閒置逾 3 秒降 15fps＝被動觀看時 GPU 砍半（實測證實每幀成本低、渲染次數才是 GPU 主因）
  const FRAME_ACTIVE = 1 / 24, FRAME_IDLE = 1 / 10, IDLE_AFTER = 3000, DORMANT_AFTER = 45000;
  let lastActive = performance.now();
  let frameAcc = 0;
  let idleFrozen = false;   // 無人值守逾 DORMANT_AFTER＝完全停止渲染（GPU~0）；任何互動或場景變化都會 wake() 喚醒
  function wake() {
    lastActive = performance.now();
    if (idleFrozen && !disposed) { idleFrozen = false; clock.getDelta(); frameAcc = 0; raf = requestAnimationFrame(animate); }
  }
  const onActivity = () => wake();
  window.addEventListener("pointermove", onActivity, { passive: true });
  window.addEventListener("pointerdown", onActivity, { passive: true });
  window.addEventListener("wheel", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity);
  const onVisible = () => { if (!document.hidden) wake(); };
  document.addEventListener("visibilitychange", onVisible);
  let csTick = 0;                // 接地陰影更新計數（每兩幀一次）
  let shTick = 0;                // 方向光陰影更新計數（每兩幀一次）
  function animate() {
    if (disposed) return;
    raf = requestAnimationFrame(animate);
    if (document.hidden) { clock.getDelta(); return; }   // 分頁切到背景就不渲染（吃掉 delta 避免回來時瞬移）
    frameAcc += clock.getDelta();
    const frameMin = (performance.now() - lastActive > IDLE_AFTER) ? FRAME_IDLE : FRAME_ACTIVE;
    if (frameAcc < frameMin) return;                       // 未到下一幀時間就跳過，讓 GPU 喘息
    const dt = Math.min(frameAcc, 0.1); frameAcc = 0;      // 夾住 dt，避免背景回來大跳動
    const tt = clock.elapsedTime;
    const ambientOK = performance.now() - lastActive < DORMANT_AFTER;   // 無人值守後就不再「起新」的閒逛/比手勢，讓 NPC 回位靜止＝迴圈才凍得下來
    daylightAccum += dt; if (daylightAccum >= 20) { daylightAccum = 0; applyDaylight(); }
    az += (azTarget - az) * 0.12;
    const foc = focusId ? actors.find((a) => a.id === focusId) : null;
    const fx = foc ? foc.root.position.x : panX, fz = foc ? foc.root.position.z : panZ;
    TARGET.x += (fx - TARGET.x) * 0.1; TARGET.z += (fz - TARGET.z) * 0.1;
    // 拉遠超過娃娃屋框(D>11)就順勢把注視點沿塔身往上抬＝鏡頭仰起欣賞整棟塔身；拉近則回落地面看房間。
    const targetY = 0.8 + THREE.MathUtils.clamp((D - 11) / 11, 0, 1) * 6.2;
    TARGET.y += (targetY - TARGET.y) * 0.1;
    placeCam();
    if (Math.abs(D - Dtarget) > 0.002) { D += (Dtarget - D) * 0.15; updateProj(); }
    for (const w of walls) {
      toCam.copy(cam.position).sub(w.position).normalize();
      const near = (w.userData as WallUser).normal.dot(toCam) > 0.2;
      const isGlass = (w.userData as { glass?: boolean }).glass === true;
      // 實牆：近側淡到 0.06、遠側全實心。玻璃帷幕：近側全穿透(0)＝看進室內、遠側維持半透明玻璃(0.42)＝透出城市與塔身。
      const target = isGlass ? (near ? 0 : 0.42) : (near ? 0.06 : 1);
      const wmat = w.material as THREE.MeshStandardMaterial;
      wmat.opacity += (target - wmat.opacity) * 0.15;
      const wantTrans = isGlass ? true : wmat.opacity < 0.985;   // 玻璃恆半透明；實牆只有淡出中才走半透明，遠側維持實體避免排序翻轉閃
      // 淡出中的近牆同時關掉 depthWrite：近乎透明牆若仍寫深度，會遮擋它後方的桌椅地板＝破圖。玻璃恆不寫深度（外殼看穿室內）。
      if (wmat.transparent !== wantTrans) { wmat.transparent = wantTrans; wmat.depthWrite = isGlass ? false : !wantTrans; wmat.needsUpdate = true; }
      w.castShadow = !isGlass && wmat.opacity > 0.5;
      const vis = wmat.opacity > 0.4;
      for (const mmb of (w.userData as WallUser).members) mmb.visible = vis;
    }
    if (ambientOK && tt > nextWanderAt) {
      nextWanderAt = tt + 5 + Math.random() * 6;
      const cands = actors.filter((a) => !a.busy && a.state === "home" && !a.emoting);
      if (cands.length) {
        const a = cands[Math.floor(Math.random() * cands.length)];
        a.visitHost = null;
        // 一半機率去找同事桌邊聊兩句（走到對方旁邊、抵達時兩人互相打招呼），否則去休息區/飲水機晃晃
        const mates = cands.filter((m) => m !== a && !m.visitHost);
        if (mates.length && Math.random() < 0.5) {
          const host = mates[Math.floor(Math.random() * mates.length)];
          const dx = a.home.x - host.home.x, dz = a.home.z - host.home.z, d = Math.hypot(dx, dz) || 1;
          a.visitHost = host.id;
          startWalk(a, host.home.x + dx / d * 0.85, host.home.z + dz / d * 0.85, false);
        } else if (wanderPoints.length) {
          // 生活動線：午餐時段(12點檔)大多去餐廳；平時偶爾去上個廁所，其餘照舊隨機晃
          let pool = wanderPoints;
          const hr = new Date().getHours();
          if (hr === 12) { const eats = wanderPoints.filter((p) => p.tag === "eat"); if (eats.length && Math.random() < 0.75) pool = eats; }
          else if (Math.random() < 0.15) { const wcs = wanderPoints.filter((p) => p.tag === "wc"); if (wcs.length) pool = wcs; }
          const wp = pool[Math.floor(Math.random() * pool.length)];
          startWalk(a, wp.x, wp.z, false);
        }
      }
    }
    if (ambientOK && tt > nextEmoteAt) {
      nextEmoteAt = tt + 4 + Math.random() * 5;
      const cands = actors.filter((a) => !a.busy && !a.emoting && (a.state === "home" || a.state === "atWander"));
      if (cands.length) emote(cands[Math.floor(Math.random() * cands.length)]);
    }
    for (const a of actors) {
      a.mixer.update(dt);
      if (a.state === "atWander" && (a.busy || tt > a.returnAt)) startWalk(a, a.home.x, a.home.z, true);
      else if (a.busy && a.state === "toWander") startWalk(a, a.home.x, a.home.z, true);
      if ((a.state === "toWander" || a.state === "toHome") && a.target) {
        const dx = a.target.x - a.root.position.x, dz = a.target.z - a.root.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.08) {
          a.root.position.x = a.target.x; a.root.position.z = a.target.z;
          if (a.path.length) { a.target = a.path.shift()!; a.lastDist = Infinity; }   // 走到中繼點＝接續下一段，重置卡住偵測
          else onArrive(a, tt);
        }
        else {
          // 卡住自癒：dist 有再變小＝有進展，記下時間；連續 STUCK_S 秒沒進展＝死結，瞬移到最終目的地並收尾
          if (dist < (a.lastDist ?? Infinity) - 1e-3) { a.lastDist = dist; a.stuckSince = tt; }
          if (tt - (a.stuckSince ?? tt) > STUCK_S) {
            const end = a.path.length ? a.path[a.path.length - 1] : a.target;
            a.path.length = 0; a.target = end;
            a.root.position.x = end.x; a.root.position.z = end.z;
            onArrive(a, tt);
          }
          else { const sp = Math.min(WALK_SPEED * dt, dist); a.root.position.x += dx / dist * sp; a.root.position.z += dz / dist * sp; a.root.rotation.y = Math.atan2(dx, dz); }
        }
      }
      a.pb.position.set(a.root.position.x, PB_Y + Math.sin(tt * 2 + a.phase) * 0.05, a.root.position.z);
      a.pb.rotation.y = tt * 1.6 + a.phase;
      a.label.position.set(a.root.position.x, PB_Y + 0.42, a.root.position.z);
      a.shadow.position.set(a.root.position.x, 0.06, a.root.position.z);
      // 頭頂對話泡泡：工作中常冒（…／?／★），待命偶爾冒（✓／♪／z），輪換內容＋輕微浮動
      if (tt > a.bubbleUntil) {
        a.bubbleUntil = tt + (a.bubble.visible ? 1.4 + Math.random() * 1.8 : 2 + Math.random() * 3.5);
        if (!a.emoting && Math.random() < (a.busy ? 0.72 : 0.22)) {
          const pool = a.busy ? busyBubbles : idleBubbles;
          const mat = a.bubble.material as THREE.SpriteMaterial;
          mat.map = pool[Math.floor(Math.random() * pool.length)]; mat.needsUpdate = true;
          a.bubble.visible = true;
        } else a.bubble.visible = false;
      }
      if (a.bubble.visible) a.bubble.position.set(a.root.position.x, PB_Y + 1.0 + Math.sin(tt * 3 + a.phase) * 0.03, a.root.position.z);
      // 工作小窗：忙碌站定工作、或剛完成回報中＝浮出頭頂；否則淡出。內容變了才重畫（見 drawPanel）。
      if ((a.doneUntil ?? 0) > 0 && tt > (a.doneUntil ?? 0)) a.doneUntil = 0;
      // 忙碌站定、剛完成回報中、或 web 截圖黏著窗未過（讓慢回的截圖補上來）＝浮出頭頂
      const webSticky = (a.webUntil ?? 0) > performance.now() && !!a.stickyWebQuery;
      const showPanel = (STATION_THEME[a.station || "home"] !== undefined && (a.busy || (a.doneUntil ?? 0) > 0)) || webSticky;
      a.panelVis += ((showPanel ? 1 : 0) - a.panelVis) * 0.16;
      if (a.panelVis < 0.02 && !showPanel) a.panel.visible = false;
      else {
        a.panel.visible = true;
        drawPanel(a);
        (a.panel.material as THREE.SpriteMaterial).opacity = a.panelVis;
        a.panel.position.set(a.root.position.x + 0.1, 3.15 + Math.sin(tt * 1.5 + a.phase) * 0.03, a.root.position.z);
      }
    }
    const sel = activeId ? actors.find((a) => a.id === activeId) : null;
    if (sel) { selRing.visible = true; selRing.position.set(sel.root.position.x, 0.09, sel.root.position.z); (selRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(tt * 4) * 0.28; }
    else selRing.visible = false;
    // 灰塵緩慢上飄＋微幅橫移，飄出頂端就回到底部（範圍固定、O(N) 有界）
    for (let i = 0; i < DUST_N; i++) {
      let y = dustPos[i * 3 + 1] + dustVel[i] * dt;
      if (y > DUST_H + 0.4) { y = 0.4; dustPos[i * 3] = (Math.random() * 2 - 1) * DUST_R; dustPos[i * 3 + 2] = (Math.random() * 2 - 1) * DUST_R; }
      dustPos[i * 3 + 1] = y;
      dustPos[i * 3] += Math.sin(tt * 0.3 + i) * 0.0015;
    }
    dustGeo.attributes.position.needsUpdate = true;
    if (updateContactShadow && (csTick++ & 1) === 0) updateContactShadow();  // 每兩幀更新（~15fps），軟陰影肉眼無感
    if (!low) renderer.shadowMap.needsUpdate = (shTick++ & 1) === 0;          // 每兩幀重算一次方向光陰影（放在接地陰影之後，避免在黑色 override 那次誤更新）
    if (composer) composer.render(dt); else renderer.render(scene, cam);
    // 無人值守偵測：沒操作、沒 NPC 在移動/比手勢、鏡頭已停 → 停掉迴圈完全不渲染（GPU~0），等 wake() 喚醒。
    // 保守條件避免 stale frame：只要還有人在走或鏡頭還在滑就不凍；喚醒源已涵蓋互動/可見性/setWorkers/setActive/resize。
    // 只要鏡頭已停 + 逾 DORMANT_AFTER 沒真互動就凍結；不看 NPC 是否在走（環境閒逛純裝飾，凍在原地也無妨，
    // 任務驅動的走動會經 setWorkers→wake() 讓 lastActive 保持新鮮、幾秒內走完，不會被凍到）。
    const camMoving = panning || drag || Math.abs(az - azTarget) > 1e-3 || Math.abs(D - Dtarget) > 1e-3;
    if (!camMoving && performance.now() - lastActive > DORMANT_AFTER) { cancelAnimationFrame(raf); raf = 0; idleFrozen = true; }
  }
  // WebGL context 復原：瀏覽器在背景/顯卡吃緊時可能丟掉 context。preventDefault 讓它之後能還原（否則永久遺失＝黑屏且要重整）；
  // 還原時重建 composer render target（resize）、重畫陰影、重啟迴圈，避免黑屏或殘影。
  function onCtxLost(e: Event) { if (disposed) return; e.preventDefault(); cancelAnimationFrame(raf); raf = 0; }
  function onCtxRestored() { if (disposed) return; csTick = 0; shTick = 0; resize(); renderer.shadowMap.needsUpdate = true; frameAcc = 0; clock.getDelta(); idleFrozen = false; raf = requestAnimationFrame(animate); }
  canvas.addEventListener("webglcontextlost", onCtxLost, false);
  canvas.addEventListener("webglcontextrestored", onCtxRestored, false);
  animate();

  let currentWorkers: WorkerLite[] = [];
  return {
    setWorkers(workers) {
      // 名冊（人員/模型/名字/部門）變了才重建房間＋角色；只有忙碌狀態變就地更新。
      // 只在「真的有變」時 wake()——這方法被 server 每次心跳的 props 變動打到，若無條件喚醒會讓 lastActive 永不過期＝永遠凍不下來。
      const rosterKey = (list: WorkerLite[]) => list.map((w) => `${w.id}:${w.colorIndex}:${w.name}:${w.departmentId ?? ""}`).join("|");
      if (rosterKey(workers) !== rosterKey(currentWorkers)) {
        wake();
        currentWorkers = workers.slice();
        buildLayout(workers);
        buildActors(workers);
        assignStations(workers); // 開場就依站點把該去別處的 NPC 派過去
        return;
      }
      for (const w of workers) {
        const a = actors.find((x) => x.id === w.id);
        if (!a) continue;
        const prevStation = a.station;
        a.station = w.station; a.speech = w.speech; a.mood = w.mood; a.webQuery = w.webQuery;   // 每次心跳同步即時任務文字＝小窗內容跟著更新
        // web 截圖黏著：抓到查詢字就記下並延長黏著窗（8s），角色切走後仍續顯示，讓慢回的截圖補上來
        if (w.station === "web" && w.webQuery) { a.stickyWebQuery = w.webQuery; a.webUntil = performance.now() + 8000; }
        // Event log：換了工作站＝記一筆「→ 站點」
        if (w.busy && w.station && w.station !== prevStation && STATION_THEME[w.station]) {
          pushLog(a.name, `→ ${STATION_THEME[w.station].label}`, w.colorIndex);
        }
        if (a.busy !== w.busy) {
          wake();   // 忙碌狀態真的翻轉（含任務起身走動/回報）＝喚醒凍結中的迴圈
          const justDone = a.busy && !w.busy;   // 由忙轉閒＝這趟工作剛結束
          a.busy = w.busy;
          if (justDone) {
            a.doneUntil = clock.elapsedTime + 8;   // 小窗切「✓完成，走去回報」顯示一段時間＝報告可見
            pushLog(a.name, `✓ ${(w.speech || "完成").slice(0, 22)}`, w.colorIndex);
          }
          if (a.state === "home" || a.state === "atWander") playBase(a, w.busy ? BUSY_CLIPS : IDLE_CLIPS);
          // 臨時 NPC（🔍研究員/🏛圓桌）查完＝走去老闆桌揮手回報，再讓 server 到點把它移除（＝走過來報告完才消失）。
          // 沒有老闆桌就退回走去某位常駐同事旁回報（舊行為）。
          if (justDone && !a.reported && isEphemeral(a.name)) {
            a.reported = true;
            if (bossSpot) {
              a.visitHost = null;
              startWalk(a, bossSpot.x, bossSpot.z, false);   // toWander → onArrive 會 emote 揮手＝回報
            } else {
              const host = actors.find((h) => h.id === activeId && !isEphemeral(h.name))
                ?? actors.find((h) => !isEphemeral(h.name) && h.id !== a.id);
              if (host) {
                a.visitHost = host.id;
                const dx = a.home.x - host.home.x, dz = a.home.z - host.home.z, d = Math.hypot(dx, dz) || 1;
                startWalk(a, host.home.x + dx / d * 0.85, host.home.z + dz / d * 0.85, false);
              }
            }
          }
        }
      }
      assignStations(workers);   // 站點變了＝起身走去對應活動站（終端機/讀檔/上網/作戰室…）
      currentWorkers = workers.slice();
    },
    setActive(id) {
      if (id !== activeId) wake();   // 選取真的變了＝喚醒，讓選取環/聚焦即時反映（無條件喚醒會被重複 setActive 打到而凍不下來）
      if (id && id !== activeId) { const a = actors.find((x) => x.id === id); if (a) emote(a); }
      activeId = id; applyActive();
    },
    resize: () => { wake(); resize(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("click", onClick as EventListener);
      canvas.removeEventListener("dblclick", onDblClick as EventListener);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("keydown", onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      canvas.removeEventListener("webglcontextlost", onCtxLost);
      canvas.removeEventListener("webglcontextrestored", onCtxRestored);
      tip.remove();
      logBox.remove();
      clearActors();
      for (const d of disposables) { try { d.dispose(); } catch { /* noop */ } }
      skyDome.geometry.dispose();
      (skyDome.material as THREE.Material).dispose();
      if (csDispose) csDispose();
      if (composer) composer.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();   // 切回像素風時徹底歸還 WebGL context＝顯卡資源不殘留（dispose 只釋放快取，context 仍在）
    },
  };
}
