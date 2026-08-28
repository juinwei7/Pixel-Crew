import { useMemo, useState } from "react";
import { apiRequest } from "../api";
import type { ProviderId } from "../types";
import { SQUAD_TEMPLATES, type SquadTemplate } from "../squads";
import { roomName } from "../workspace";
import { t } from "../i18n";
import { Modal } from "./Modal";

type Props = {
  provider: ProviderId;
  initialWorkspacePath: string;
  recentPaths: string[];
  capacity: number;
  existingNames: string[];
  onBrowse(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  onCreated(workerIds: string[], leadId: string, squadName: string): void;
  onClose(): void;
};

const MODEL_BADGE: Record<string, string> = { opus: "OPUS", sonnet: "SONNET", haiku: "HAIKU" };

/** 隊員撞名時自動加編號，整隊失敗改成無感避讓 */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLocaleLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}號`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base}${Date.now() % 1000}`;
}

export function SquadModal({ provider, initialWorkspacePath, recentPaths, capacity, existingNames, onBrowse, onCreated, onClose }: Props) {
  const [selected, setSelected] = useState<SquadTemplate | null>(null);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const [squadName, setSquadName] = useState("");
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = creating || browsing;
  // ×／Esc 共用同一個關閉入口：忙碌中（成軍中或瀏覽資料夾中）不准關，避免誤丟已填的表單。
  function closeIfIdle() { if (!pending) onClose(); }

  const takenNames = useMemo(
    () => new Set(existingNames.map((name) => name.toLocaleLowerCase())),
    [existingNames],
  );

  function pick(template: SquadTemplate) {
    setSelected(template);
    setSquadName(template.name);
    setError(null);
  }

  async function browse() {
    if (pending) return;
    setBrowsing(true);
    setError(null);
    const result = await onBrowse();
    setBrowsing(false);
    if (result.error) setError(result.error);
    else if (result.path) setWorkspacePath(result.path);
  }

  async function create() {
    if (!selected || pending) return;
    if (!workspacePath.trim()) { setError(t("請先選擇工作資料夾")); return; }
    setCreating(true);
    setError(null);
    const batchTaken = new Set(takenNames);
    const members = selected.members.map((member) => {
      const name = uniqueName(member.name, batchTaken);
      batchTaken.add(name.toLocaleLowerCase());
      return { name, role: member.role, instructions: member.instructions, model: member.model, autoApprove: member.autoApprove };
    });
    try {
      const data = await apiRequest<{ workers: Array<{ id: string }> }>("/api/squads", {
        method: "POST",
        body: {
          name: squadName.trim() || selected.name,
          purpose: selected.purpose,
          provider,
          workspacePath,
          leadIndex: selected.leadIndex,
          members,
        },
        timeoutMs: 30_000,
      });
      const ids = data.workers.map((worker) => worker.id);
      onCreated(ids, ids[selected.leadIndex] ?? ids[0], squadName.trim() || selected.name);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <Modal label={t("一鍵成軍")} eyebrow="🫡 SQUAD UP" title={t("一鍵成軍")} cardClassName="warroom-result__card squad-modal" onClose={closeIfIdle}>
        <p className="squad-modal__hint">{t("挑一組配好角色與分工的小隊，整隊直接進駐辦公室。每位隊員的個性都會以系統提示長駐，換模型、清空對話都不會忘記自己是誰。")}</p>

        {!selected && (
          <div className="squad-modal__grid">
            {SQUAD_TEMPLATES.map((template) => {
              const overCap = template.members.length > capacity;
              return (
                <button
                  key={template.id}
                  type="button"
                  className="squad-modal__tile"
                  disabled={overCap}
                  onClick={() => pick(template)}
                  title={overCap ? t("名額不足：需要 {need} 位，只剩 {left} 位空位", { need: template.members.length, left: capacity }) : template.tagline}
                >
                  <span className="squad-modal__tile-emoji">{template.emoji}</span>
                  <strong>{template.name}</strong>
                  <small>{template.tagline}</small>
                  <span className="squad-modal__tile-roster">
                    {template.members.map((member) => (
                      <em key={member.name}>{member.role.split("・")[0]} <b>{MODEL_BADGE[member.model]}</b></em>
                    ))}
                  </span>
                  {overCap && <span className="squad-modal__tile-full">{t("名額不足")}</span>}
                </button>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="squad-modal__detail">
            <button type="button" className="squad-modal__back" onClick={() => { if (!pending) setSelected(null); }}>{t("← 換一隊")}</button>
            <h3>{selected.emoji} {selected.name}</h3>
            <ul className="squad-modal__members">
              {selected.members.map((member, index) => (
                <li key={member.name}>
                  <strong>{member.name}{index === selected.leadIndex ? t("（隊長）") : ""}</strong>
                  <span className="squad-modal__member-role">{member.role}</span>
                  <b className={`squad-modal__model squad-modal__model--${member.model}`}>{MODEL_BADGE[member.model]}</b>
                </li>
              ))}
            </ul>
            <label className="squad-modal__field">
              <span>{t("隊名")}</span>
              <input value={squadName} maxLength={30} onChange={(event) => setSquadName(event.target.value)} disabled={pending} />
            </label>
            <div className="squad-modal__field">
              <span>{t("工作資料夾")}</span>
              <div className="squad-modal__workspace">
                <select value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} disabled={pending}>
                  {workspacePath && !recentPaths.includes(workspacePath) && <option value={workspacePath}>{roomName(workspacePath)}</option>}
                  {recentPaths.map((path) => <option key={path} value={path}>{roomName(path)}</option>)}
                </select>
                <button type="button" onClick={() => void browse()} disabled={pending}>{browsing ? "…" : t("瀏覽")}</button>
              </div>
            </div>
            <p className="squad-modal__first-order">{t("成軍後可以直接對隊長下第一道指令，例如：")}<em>{selected.firstOrder.split("\n")[0]}</em></p>
            {error && <p className="squad-modal__error">{error}</p>}
            <button type="button" className="squad-modal__go" onClick={() => void create()} disabled={pending}>
              {creating ? t("成軍中…") : t("🫡 成軍！（{count} 位進駐）", { count: selected.members.length })}
            </button>
          </div>
        )}
    </Modal>
  );
}
