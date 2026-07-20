import { useEffect, useRef, useState } from "react";
import { apiAssetUrl } from "../api";
import type { WorkerState } from "../types";
import {
  AVATAR_HEIGHT,
  AVATAR_WIDTH,
  renderNormalizedAvatar,
  type AvatarControls,
} from "../avatar/normalizeAvatar";
import { AVATAR_PRESETS, paintPresetPreview, type AvatarPresetId } from "../game/avatarPresets";
import { FRONT_IDLE_0, SHIRT_COLORS } from "../game/person";
import { dragContainsFiles } from "./CommandComposer";

type Props = {
  worker: WorkerState;
  onSave(workerId: string, dataBase64: string, mimeType: "image/png" | "image/gif"): Promise<string | null>;
  onPreset(workerId: string, presetId: string): Promise<string | null>;
  onActivateCustom(workerId: string): Promise<string | null>;
  onReset(workerId: string): Promise<string | null>;
  onClose(): void;
};

const DEFAULT_CONTROLS: AvatarControls = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  paletteSize: 12,
  removeBackground: true,
};
const MAX_GIF_DIMENSION = 320;

export function AvatarWorkshop({ worker, onSave, onPreset, onActivateCustom, onReset, onClose }: Props) {
  const [mode, setMode] = useState<"official" | "custom">(worker.avatarKind === "custom" ? "custom" : "official");
  const [selectedPreset, setSelectedPreset] = useState<AvatarPresetId>((worker.avatarPresetId || "classic") as AvatarPresetId);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [fileName, setFileName] = useState("");
  const [gifFile, setGifFile] = useState<File | null>(null);
  const [gifPreviewUrl, setGifPreviewUrl] = useState<string | null>(null);
  const [controls, setControls] = useState(DEFAULT_CONTROLS);
  const [output, setOutput] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => () => source?.close(), [source]);
  useEffect(() => () => {
    if (gifPreviewUrl) URL.revokeObjectURL(gifPreviewUrl);
  }, [gifPreviewUrl]);

  useEffect(() => {
    if (!source) {
      setOutput(null);
      return;
    }
    try {
      setOutput(renderNormalizedAvatar(source, source.width, source.height, controls));
      setError(null);
    } catch (renderError) {
      setOutput(null);
      setError((renderError as Error).message);
    }
  }, [source, controls]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    host.replaceChildren();
    if (output) host.appendChild(output);
  }, [output]);

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError("請選擇 PNG、JPEG、WebP 或 GIF 圖片");
      return;
    }
    const maxSize = file.type === "image/gif" ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > maxSize) {
      setError(file.type === "image/gif" ? "GIF 最多 2 MiB" : "來源圖片最多 5 MiB");
      return;
    }
    if (file.type === "image/gif") {
      const url = URL.createObjectURL(file);
      try {
        const dimensions = await imageDimensions(url);
        if (dimensions.width > MAX_GIF_DIMENSION || dimensions.height > MAX_GIF_DIMENSION) {
          throw new Error(`GIF 尺寸最大為 ${MAX_GIF_DIMENSION} × ${MAX_GIF_DIMENSION}`);
        }
        source?.close();
        setSource(null);
        setOutput(null);
        setGifFile(file);
        setGifPreviewUrl(url);
        setFileName(file.name);
        setError(null);
      } catch (gifError) {
        URL.revokeObjectURL(url);
        setError((gifError as Error).message || "無法解析這個 GIF");
      }
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("來源圖片最多 5 MiB");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > 4096 || bitmap.height > 4096) {
        bitmap.close();
        setError("來源圖片最大尺寸為 4096 × 4096");
        return;
      }
      source?.close();
      setGifFile(null);
      setGifPreviewUrl(null);
      setSource(bitmap);
      setFileName(file.name);
      setControls(DEFAULT_CONTROLS);
      setError(null);
    } catch {
      setError("無法解析這張圖片，檔案可能已損壞");
    }
  }

  async function saveCustom() {
    if (!output && !gifFile) {
      if (!worker.avatarId) return;
      setSaving(true);
      setError(null);
      const activateError = await onActivateCustom(worker.id);
      setSaving(false);
      if (activateError) setError(activateError);
      else onClose();
      return;
    }
    setSaving(true);
    setError(null);
    const dataBase64 = gifFile
      ? arrayBufferToBase64(await gifFile.arrayBuffer())
      : output!.toDataURL("image/png").split(",", 2)[1];
    const saveError = await onSave(worker.id, dataBase64, gifFile ? "image/gif" : "image/png");
    setSaving(false);
    if (saveError) setError(saveError);
    else onClose();
  }

  async function saveOfficial() {
    setSaving(true);
    setError(null);
    const presetError = await onPreset(worker.id, selectedPreset);
    setSaving(false);
    if (presetError) setError(presetError);
    else onClose();
  }

  async function restoreDefault() {
    setSaving(true);
    setError(null);
    const resetError = await onReset(worker.id);
    setSaving(false);
    if (resetError) setError(resetError);
    else onClose();
  }

  const gifMode = Boolean(gifFile || (!source && worker.avatarId?.toLowerCase().endsWith(".gif")));

  function onDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!dragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setError("角色工坊一次只能接收一張圖片");
      return;
    }
    setMode("custom");
    void chooseFile(files[0]);
  }

  return (
    <div className={`avatar-workshop ${dragActive ? "avatar-workshop--drop-active" : ""}`} data-file-drop-owner="avatar" role="dialog" aria-modal="true" aria-labelledby="avatar-workshop-title" onDragEnter={onDragEnter} onDragOver={(event) => { if (dragContainsFiles(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } }} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragActive && <div className="avatar-workshop__drop-hint" role="status"><span>＋</span><strong>放開以設定自訂角色</strong><small>PNG、JPEG、WebP 或 GIF</small></div>}
      <div className="avatar-workshop__card">
        <button type="button" className="avatar-workshop__close" onClick={onClose} aria-label="關閉角色工坊">×</button>
        <header className="avatar-workshop__header">
          <span className="avatar-workshop__eyebrow">AVATAR WORKSHOP · {AVATAR_WIDTH}×{AVATAR_HEIGHT}</span>
          <h2 id="avatar-workshop-title">替 {worker.name} 換一個樣子</h2>
          <p>
            {mode === "official"
              ? "從官方隊員中選一位；每個造型都有完整辦公室動作，切換不會刪除你的自訂角色。"
              : gifMode
              ? "GIF 會保留原始動畫，並自動適配 NPC 在辦公室裡的顯示尺寸。"
              : `圖片只在瀏覽器內縮圖與降色；伺服器只保存最後的 ${AVATAR_WIDTH}×${AVATAR_HEIGHT} PNG。`}
          </p>
        </header>

        <div className="avatar-workshop__source-tabs" role="tablist" aria-label="角色來源">
          <button type="button" role="tab" aria-selected={mode === "official"} className={mode === "official" ? "is-active" : ""} onClick={() => setMode("official")}><span>OFFICIAL</span>官方角色</button>
          <button type="button" role="tab" aria-selected={mode === "custom"} className={mode === "custom" ? "is-active" : ""} onClick={() => setMode("custom")}><span>CUSTOM</span>自訂上傳{worker.avatarId && <i>已保存</i>}</button>
        </div>

        {mode === "official" ? (
          <section className="avatar-workshop__official" aria-label="官方角色選擇">
            <div className="avatar-workshop__official-copy">
              <strong>PIXEL CREW 官方隊員</strong>
              <span>每一位都保留走路、工作與歡呼動畫。</span>
            </div>
            <div className="avatar-workshop__preset-grid">
              {AVATAR_PRESETS.map((preset) => (
                <button key={preset.id} type="button" className={selectedPreset === preset.id ? "avatar-workshop__preset is-active" : "avatar-workshop__preset"} style={{ "--preset-accent": preset.accent } as React.CSSProperties} onClick={() => setSelectedPreset(preset.id)}>
                  <span className="avatar-workshop__preset-art"><PresetPreview presetId={preset.id} colorIndex={worker.colorIndex} /></span>
                  <span className="avatar-workshop__preset-copy"><strong>{preset.name}</strong><small>{preset.role}</small></span>
                  <span className="avatar-workshop__preset-check">{selectedPreset === preset.id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          </section>
        ) : <div className="avatar-workshop__body">
          <section className="avatar-workshop__preview-panel">
            <div className="avatar-workshop__preview-frame">
              {gifPreviewUrl ? (
                <img className="avatar-workshop__existing" src={gifPreviewUrl} alt="GIF 動態角色預覽" />
              ) : output ? (
                <div ref={previewRef} className="avatar-workshop__preview" />
              ) : worker.avatarId ? (
                <img className="avatar-workshop__existing" src={apiAssetUrl(`/api/avatars/${worker.avatarId}`)} alt={`${worker.name} 目前的自訂角色`} />
              ) : (
                <div className="avatar-workshop__empty">
                  <span>＋</span>
                  <strong>選一張角色圖片</strong>
                  <small>支援靜態圖片與動態 GIF</small>
                </div>
              )}
            </div>
            <div className="avatar-workshop__scale-note">
              {gifMode ? "GIF 保留原始動畫 · 顯示時自動適配" : `實際尺寸 ${AVATAR_WIDTH} × ${AVATAR_HEIGHT} px · 預覽放大 8 倍`}
            </div>
            <label className="avatar-workshop__upload">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <span>{fileName || "從電腦選擇圖片"}</span>
              <b>瀏覽…</b>
            </label>
          </section>

          {gifMode ? (
            <section className="avatar-workshop__gif-info">
              <div className="avatar-workshop__gif-mark">GIF</div>
              <div>
                <strong>保留原始動畫</strong>
                <p>GIF 不提供裁切、縮放、去背或降色調整，套用後會依比例自動適配 NPC 尺寸。</p>
              </div>
              <dl>
                <div><dt>最大尺寸</dt><dd>320 × 320</dd></div>
                <div><dt>檔案上限</dt><dd>2 MiB</dd></div>
                <div><dt>影格上限</dt><dd>120 幀</dd></div>
                <div><dt>解碼預算</dt><dd>800 萬像素</dd></div>
                <div><dt>播放方式</dt><dd>依原始幀時間循環</dd></div>
              </dl>
            </section>
          ) : (
          <section className={`avatar-workshop__controls ${source ? "" : "avatar-workshop__controls--disabled"}`}>
            <Control label="縮放" value={controls.zoom} min={0.5} max={4} step={0.05} display={`${Math.round(controls.zoom * 100)}%`} onChange={(zoom) => setControls((current) => ({ ...current, zoom }))} />
            <Control label="左右位置" value={controls.offsetX} min={-1} max={1} step={0.02} display={formatOffset(controls.offsetX)} onChange={(offsetX) => setControls((current) => ({ ...current, offsetX }))} />
            <Control label="上下位置" value={controls.offsetY} min={-1} max={1} step={0.02} display={formatOffset(controls.offsetY)} onChange={(offsetY) => setControls((current) => ({ ...current, offsetY }))} />

            <div className="avatar-workshop__field">
              <div className="avatar-workshop__field-title"><span>色彩數量</span><output>{controls.paletteSize} 色</output></div>
              <div className="avatar-workshop__segments">
                {([8, 12, 16] as const).map((size) => (
                  <button key={size} type="button" disabled={!source} className={controls.paletteSize === size ? "is-active" : ""} onClick={() => setControls((current) => ({ ...current, paletteSize: size }))}>{size}</button>
                ))}
              </div>
            </div>

            <label className="avatar-workshop__toggle">
              <input type="checkbox" checked={controls.removeBackground} disabled={!source} onChange={(event) => setControls((current) => ({ ...current, removeBackground: event.target.checked }))} />
              <span><strong>移除角落背景色</strong><small>適合單色底圖；透明圖不受影響</small></span>
            </label>
          </section>
          )}
        </div>}

        {error && <div className="avatar-workshop__error" role="alert">{error}</div>}
        <footer className="avatar-workshop__actions">
          {mode === "custom" ? <button type="button" className="avatar-workshop__reset" disabled={!worker.avatarId || saving} onClick={() => void restoreDefault()}>刪除自訂角色</button> : <span />}
          <span />
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          {mode === "official" ? (
            <button type="button" className="avatar-workshop__save" disabled={saving || (worker.avatarKind === "preset" && worker.avatarPresetId === selectedPreset)} onClick={() => void saveOfficial()}>{saving ? "儲存中…" : "套用官方角色"}</button>
          ) : (
            <button type="button" className="avatar-workshop__save" disabled={(!output && !gifFile && (!worker.avatarId || worker.avatarKind === "custom")) || saving} onClick={() => void saveCustom()}>{saving ? "儲存中…" : output || gifFile ? "上傳並套用" : "切回自訂角色"}</button>
          )}
        </footer>
      </div>
    </div>
  );
}

function PresetPreview({ presetId, colorIndex }: { presetId: string; colorIndex: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintPresetPreview(ref.current, FRONT_IDLE_0, presetId, colorIndex, SHIRT_COLORS);
  }, [presetId, colorIndex]);
  return <canvas ref={ref} aria-hidden="true" />;
}

function imageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("無法解析這個 GIF"));
    image.src = url;
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function Control({ label, value, min, max, step, display, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange(value: number): void;
}) {
  return (
    <label className="avatar-workshop__field">
      <span className="avatar-workshop__field-title"><span>{label}</span><output>{display}</output></span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function formatOffset(value: number): string {
  if (Math.abs(value) < 0.01) return "置中";
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)}`;
}
