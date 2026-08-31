import { t } from "../i18n";
import { Modal } from "./Modal";

type Row = { keys: string[]; label: string };
type Group = { title: string; rows: Row[] };

const MOD = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘" : "Ctrl";

const GROUPS: Group[] = [
  {
    title: t("全域"),
    rows: [
      { keys: [MOD, "K"], label: t("命令面板 / 快速指令") },
      { keys: [MOD, "J"], label: t("展開 / 收合任務日誌") },
      { keys: [MOD, "⇧", "A"], label: t("跳到待核准的 NPC") },
      { keys: ["?"], label: t("顯示這張快捷鍵說明") },
      { keys: ["Esc"], label: t("關閉目前的面板 / 退出專心模式") },
    ],
  },
  {
    title: t("輸入框"),
    rows: [
      { keys: ["Enter"], label: t("送出指令") },
      { keys: ["⇧", "Enter"], label: t("換行") },
      { keys: ["/"], label: t("叫出指令選單（Claude）") },
      { keys: ["$"], label: t("叫出 Repo Skills（Codex）") },
    ],
  },
  {
    title: t("專心模式"),
    rows: [
      { keys: ["Alt", "1-9"], label: t("跳到第 N 個工作區") },
      { keys: ["Alt", "]"], label: t("切到下一個分割視窗") },
      { keys: ["Alt", "["], label: t("切到上一個分割視窗") },
    ],
  },
  {
    title: t("像素辦公室"),
    rows: [
      { keys: [t("點擊")], label: t("選取 NPC") },
      { keys: [t("雙擊")], label: t("開啟 NPC 任務日誌") },
      { keys: [t("右鍵")], label: t("NPC 快速選單") },
      { keys: [t("滾輪")], label: t("縮放視角") },
      { keys: [t("拖曳")], label: t("平移視角") },
      { keys: [t("雙擊地板")], label: t("重設視角") },
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose(): void }) {
  return (
    <Modal label={t("鍵盤快捷鍵")} overlayClassName="shortcuts-help" cardClassName="shortcuts-help__card" closeClassName="shortcuts-help__close" closeLabel={t("關閉")} onClose={onClose}>
        <div className="shortcuts-help__header">
          <span>KEYBOARD</span>
          <h2>{t("快捷鍵")}</h2>
          <p>{t("隨時按 ")}<kbd>?</kbd>{t(" 叫出這張表。")}</p>
        </div>
        <div className="shortcuts-help__groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-help__group">
              <h3>{group.title}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.label}>
                    <span className="shortcuts-help__keys">
                      {row.keys.map((key, index) => (
                        <kbd key={index}>{key}</kbd>
                      ))}
                    </span>
                    <span className="shortcuts-help__label">{row.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
    </Modal>
  );
}
