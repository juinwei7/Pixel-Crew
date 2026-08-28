import { useState } from "react";
import { apiRequest } from "../api";
import type { Persona, ProviderAuthState, ProviderId } from "../types";
import { roomName } from "../workspace";
import { t } from "../i18n";
import { Modal } from "./Modal";

type PlannedMember = Persona & { name: string };
type PlanResponse = {
  planToken: string;
  provider: ProviderId;
  workspacePath: string;
  purpose: string;
  plan: { summary: string; members: PlannedMember[] };
};

type Props = {
  initialProvider: ProviderId;
  initialWorkspacePath: string;
  recentPaths: string[];
  providers: Record<ProviderId, ProviderAuthState>;
  maxMembers: number;
  onBrowse(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  onCreated(workerIds: string[], purpose: string): void;
  onClose(): void;
};

export function DepartmentCreator({ initialProvider, initialWorkspacePath, recentPaths, providers, maxMembers, onBrowse, onCreated, onClose }: Props) {
  const [purpose, setPurpose] = useState("");
  const [count, setCount] = useState(Math.min(3, maxMembers));
  const [provider, setProvider] = useState(initialProvider);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [departmentName, setDepartmentName] = useState("");
  const [leadIndex, setLeadIndex] = useState(0);
  const [planning, setPlanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = planning || creating || browsing;
  // ×／Esc 共用同一個關閉入口：規劃中、建立中或瀏覽資料夾中不准關。
  function closeIfIdle() { if (!pending) onClose(); }

  async function browse() {
    if (pending) return;
    setBrowsing(true);
    setError(null);
    const result = await onBrowse();
    setBrowsing(false);
    if (result.error) setError(result.error);
    else if (result.path) setWorkspacePath(result.path);
  }

  async function generatePlan() {
    if (pending || !purpose.trim() || !workspacePath.trim()) return;
    setPlanning(true);
    setError(null);
    try {
      const data = await apiRequest<PlanResponse>("/api/departments/plan", {
        method: "POST",
        body: { purpose, count, provider, workspacePath },
        timeoutMs: 160_000,
      });
      setDepartmentName(t("{purpose}部門", { purpose: purpose.trim().slice(0, 20) }));
      setLeadIndex(0);
      setPlan(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function createDepartment() {
    if (!plan || pending) return;
    setCreating(true);
    setError(null);
    try {
      const data = await apiRequest<{ purpose: string; workers: Array<{ id: string }> }>("/api/departments", {
        method: "POST",
        body: { planToken: plan.planToken, name: departmentName, leadIndex, members: plan.plan.members },
        timeoutMs: 30_000,
      });
      onCreated(data.workers.map((worker) => worker.id), data.purpose);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal label={t("直接建立一個部門")} overlayClassName="department-creator" cardClassName="department-creator__card" closeClassName="department-creator__close" closeLabel={t("關閉建立部門")} onClose={closeIfIdle}>
        <header>
          <span>AI DEPARTMENT BUILDER</span>
          <h2>{t("直接建立一個部門")}</h2>
          <p>{t("告訴 AI 部門要做什麼、需要幾位 NPC，它會安排互補職務與個性，確認後一次建立。")}</p>
        </header>

        {!plan ? <form onSubmit={(event) => { event.preventDefault(); void generatePlan(); }}>
          <label className="department-creator__field">
            <span>{t("這是什麼部門？")}</span>
            <input value={purpose} maxLength={200} autoFocus placeholder={t("例如：負責電商產品開發與維護")} onChange={(event) => { setPurpose(event.target.value); setError(null); }} />
          </label>
          <div className="department-creator__setup-grid">
            <label className="department-creator__field">
              <span>{t("要新增的 NPC 數量")}</span>
              <input type="number" min={1} max={maxMembers} value={count} onChange={(event) => setCount(Math.max(1, Math.min(maxMembers, Number(event.target.value) || 1)))} />
              <small>{t("可再建立 {count} 位", { count: maxMembers })}</small>
            </label>
            <label className="department-creator__field">
              <span>{t("部門 AI Provider")}</span>
              <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
                {(["claude", "codex"] as ProviderId[]).map((id) => <option key={id} value={id} disabled={providers[id].status !== "authenticated"}>{providers[id].displayName}{providers[id].status === "authenticated" ? "" : t("（未登入）")}</option>)}
              </select>
              <small>{t("規劃與新 NPC 全部使用此 Provider 的預設模型")}</small>
            </label>
          </div>
          <label className="department-creator__field">
            <span>{t("工作位置")}</span>
            <select value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)}>
              {[...new Set([initialWorkspacePath, ...recentPaths].filter(Boolean))].map((path) => <option key={path} value={path}>{roomName(path)} · {path}</option>)}
            </select>
            <small>{t("同一工作位置可以建立多個獨立部門；它們共用同一份專案檔案。")}</small>
          </label>
          <button type="button" className="department-creator__browse" disabled={pending} onClick={() => void browse()}>{browsing ? t("正在開啟資料夾…") : t("選擇其他工作位置")}</button>
          {error && <div className="department-creator__error" role="alert">{error}</div>}
          <footer>
            <button type="button" disabled={pending} onClick={onClose}>{t("取消")}</button>
            <button type="submit" className="department-creator__primary" disabled={pending || !purpose.trim() || !workspacePath.trim() || maxMembers < 1}>{planning ? t("AI 正在安排職務…") : t("AI 規劃部門")}</button>
          </footer>
        </form> : <div className="department-creator__review">
          <label className="department-creator__field"><span>{t("部門名稱")}</span><input value={departmentName} maxLength={80} onChange={(event) => setDepartmentName(event.target.value)} /></label>
          <div className="department-creator__provider-note"><span>{t("部門 AI Provider")}</span><strong>{providers[plan.provider].displayName}</strong><small>{t("所有 NPC 使用此 Provider 的預設模型")}</small></div>
          <div className="department-creator__summary"><span>{plan.purpose}</span><strong>{plan.plan.summary || t("{count} 位 NPC 的互補配置", { count: plan.plan.members.length })}</strong></div>
          <div className="department-creator__members">
            {plan.plan.members.map((member, index) => <article key={`${member.name}-${index}`}>
              <b>{index + 1}</b><div>
                <label><input type="radio" name="department-lead" checked={leadIndex === index} onChange={() => setLeadIndex(index)} /> {t("部門主管")}</label>
                <label>{t("姓名")}<input value={member.name} maxLength={80} onChange={(event) => setPlan({ ...plan, plan: { ...plan.plan, members: plan.plan.members.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) } })} /></label>
                <label>{t("職位")}<input value={member.role} maxLength={120} onChange={(event) => setPlan({ ...plan, plan: { ...plan.plan, members: plan.plan.members.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value } : item) } })} /></label>
                <label>{t("個性與分工")}<textarea value={member.instructions} rows={3} maxLength={4000} onChange={(event) => setPlan({ ...plan, plan: { ...plan.plan, members: plan.plan.members.map((item, itemIndex) => itemIndex === index ? { ...item, instructions: event.target.value } : item) } })} /></label>
              </div>
            </article>)}
          </div>
          {error && <div className="department-creator__error" role="alert">{error}</div>}
          <footer>
            <button type="button" disabled={pending} onClick={() => setPlan(null)}>{t("返回修改")}</button>
            <button type="button" className="department-creator__primary" disabled={pending || !departmentName.trim() || plan.plan.members.some((member) => !member.name.trim() || !member.role.trim() || !member.instructions.trim())} onClick={() => void createDepartment()}>{creating ? t("正在建立部門…") : t("建立部門與 {count} 位 NPC", { count: plan.plan.members.length })}</button>
          </footer>
        </div>}
    </Modal>
  );
}
