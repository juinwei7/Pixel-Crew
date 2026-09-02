import { t } from "./i18n";

// 工作站主題的單一事實來源：像素風工作小窗（GameCanvas）使用這張表。
// label＝工作站名稱；plain＝大白話標題（非工程背景的人一看就懂 NPC 在幹嘛）；
// bg/fg＝小窗的面板底色/文字色；accent＝各處共用的主題色；
// kind=web 的小窗會放真實瀏覽器截圖(/api/webshot)，其餘顯示站點主題＋即時任務文字。
export type StationTheme = {
  label: string;
  plain: string;
  bg: string;
  fg: string;
  accent: string;
  kind: string;
};

export const STATION_THEME: Record<string, StationTheme> = {
  terminal: { label: t("終端機"), plain: t("正在執行指令"),   bg: "#0c1220", fg: "#bfe6cf", accent: "#58f08a", kind: "term" },
  code:     { label: t("編輯器"), plain: t("正在寫程式"),     bg: "#12151f", fg: "#d6def0", accent: "#7aa2ff", kind: "code" },
  web:      { label: t("瀏覽器"), plain: t("正在上網查資料"), bg: "#f3f6fb", fg: "#28323f", accent: "#3f8cff", kind: "web" },
  books:    { label: t("知識庫"), plain: t("正在查閱文件"),   bg: "#1c1710", fg: "#ead9c0", accent: "#e0b060", kind: "docs" },
  check:    { label: t("驗證"),   plain: t("正在驗證測試"),   bg: "#0f1719", fg: "#cfeae2", accent: "#35d0b0", kind: "check" },
  board:    { label: t("看板"),   plain: t("正在更新看板"),   bg: "#171226", fg: "#e4dcf3", accent: "#b98cff", kind: "board" },
  meeting:  { label: t("白板"),   plain: t("正在開會討論"),   bg: "#161a24", fg: "#dde4f0", accent: "#8fd0ff", kind: "board" },
};
