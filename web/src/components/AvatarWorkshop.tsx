import { useEffect, useRef, useState } from "react";
import { apiAssetUrl } from "../api";
import type { WorkerState } from "../types";
import {
  AVATAR_HEIGHT,
  AVATAR_WIDTH,
  renderNormalizedAvatar,
  type AvatarControls,
} from "../avatar/normalizeAvatar";

type Props = {
  worker: WorkerState;
  onSave(workerId: string, dataBase64: string, mimeType: "image/png" | "image/gif"): Promise<string | null>;
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

export function AvatarWorkshop({ worker, onSave, onReset, onClose }: Props) {
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [fileName, setFileName] = useState("");
  const [gifFile, setGifFile] = useState<File | null>(null);
  const [gifPreviewUrl, setGifPreviewUrl] = useState<string | null>(null);
  const [controls, setControls] = useState(DEFAULT_CONTROLS);
  const [output, setOutput] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

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

  async function save() {
    if (!output && !gifFile) return;
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

  async function restoreDefault() {
    setSaving(true);
    setError(null);
    const resetError = await onReset(worker.id);
    setSaving(false);
    if (resetError) setError(resetError);
    else onClose();
  }

  const gifMode = Boolean(gifFile || (!source && worker.avatarId?.toLowerCase().endsWith(".gif")));

  return (
    <div className="avatar-workshop" role="dialog" aria-modal="true" aria-labelledby="avatar-workshop-title">
      <div className="avatar-workshop__card">
        <button type="button" className="avatar-workshop__close" onClick={onClose} aria-label="關閉角色工坊">×</button>
        <header className="avatar-workshop__header">
          <span className="avatar-workshop__eyebrow">AVATAR WORKSHOP · {AVATAR_WIDTH}×{AVATAR_HEIGHT}</span>
          <h2 id="avatar-workshop-title">替 {worker.name} 換一個樣子</h2>
          <p>
            {gifMode
              ? "GIF 會保留原始動畫，並自動適配 NPC 在辦公室裡的顯示尺寸。"
              : `圖片只在瀏覽器內縮圖與降色；伺服器只保存最後的 ${AVATAR_WIDTH}×${AVATAR_HEIGHT} PNG。`}
          </p>
        </header>

        <div className="avatar-workshop__body">
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
        </div>

        {error && <div className="avatar-workshop__error" role="alert">{error}</div>}
        <footer className="avatar-workshop__actions">
          <button type="button" className="avatar-workshop__reset" disabled={!worker.avatarId || saving} onClick={() => void restoreDefault()}>恢復預設角色</button>
          <span />
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="avatar-workshop__save" disabled={(!output && !gifFile) || saving} onClick={() => void save()}>{saving ? "儲存中…" : "套用角色"}</button>
        </footer>
      </div>
    </div>
  );
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
