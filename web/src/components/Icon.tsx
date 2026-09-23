/* 全 app 唯一的 icon 來源。

   以前介面用 emoji 當圖示（🧠 全域記憶、📋 任務看板、🎤…）。emoji 的字形由
   作業系統決定：同一顆字在 macOS / Windows / Android 長得完全不一樣，吃不到
   currentColor，也沒辦法跟著設計 token 調粗細與大小——在這個深色終端機風格
   的介面裡尤其突兀。改成一套自己的線性 icon：24 格、stroke 1.8、統一用
   currentColor，大小由 size 控制。

   語意規則（跟著旁邊有沒有文字走，不是跟著圖案走）：
   - 旁邊已經有可見文字 → 裝飾性，aria-hidden（預設就是這樣）
   - 單獨當按鈕內容 → 由按鈕自己帶 aria-label，icon 仍然 aria-hidden
   新增圖示時沿用同樣的 24 格與筆畫，不要混入填色或不同粗細的圖案。 */

export type IconName =
  | "globe" | "bell" | "brain" | "key" | "board" | "chart" | "moon" | "box"
  | "link" | "help" | "speech" | "warroom" | "mic" | "gear"
  | "shield" | "refresh" | "warning" | "user" | "building"
  | "wrench" | "search" | "paperclip" | "image" | "file" | "table" | "archive"
  | "code" | "flag" | "target" | "fire" | "running" | "cat" | "lock"
  | "cloud" | "phone" | "thought" | "check" | "trash"
  | "power" | "star" | "clock" | "stop";

const PATHS: Record<IconName, JSX.Element> = {
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></>,
  bell: <><path d="M6 10a6 6 0 1 1 12 0c0 4 1 5 2 6H4c1-1 2-2 2-6Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
  brain: <><rect x="8" y="8" width="8" height="8" rx="2" /><path d="M12 4v4M12 16v4M4 12h4M16 12h4M7 7l1.5 1.5M17 7l-1.5 1.5M7 17l1.5-1.5M17 17l-1.5-1.5" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15 12v2" /></>,
  board: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 17v-5M12 17V8M16 17v-7" /></>,
  moon: <path d="M20 14a8 8 0 1 1-10-10a7 7 0 0 0 10 10Z" />,
  box: <><path d="M3 8l9-4 9 4v8l-9 4-9-4Z" /><path d="M3 8l9 4 9-4M12 12v8" /></>,
  link: <><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.5v1.5" /><path d="M12 17h.01" /></>,
  speech: <><path d="M4 5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-5 3V5Z" /><path d="M19 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v3l-3-3" /></>,
  warroom: <><path d="M3 20h18M4 20V9M9 20V9M15 20V9M20 20V9" /><path d="M2 9l10-5 10 5Z" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
  warning: <><path d="M12 4 2.5 20h19Z" /><path d="M12 10v4M12 17h.01" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></>,
  wrench: <path d="M15 4a5 5 0 0 0-5 6.5L4 16.5V20h3.5l6-6A5 5 0 0 0 20 9l-3 3-2-2 3-3a5 5 0 0 0-3-3Z" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  paperclip: <path d="M20 11 12 19a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>,
  file: <><path d="M6 3h8l5 5v13H6Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16M15 4v16" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>,
  code: <path d="m9 8-5 4 5 4M15 8l5 4-5 4M13 5l-2 14" />,
  flag: <><path d="M6 21V4" /><path d="M6 5h11l-2 3.5L17 12H6Z" /></>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
  fire: <path d="M12 3c3 4 5 5.5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4c.3 1.4 1 2 2 2c0-3-1-5 1-7Z" />,
  running: <><circle cx="15" cy="5" r="2" /><path d="m9 21 2.5-6L9 12l1-4 3 2 3 1M7 11l3-3M13 14l3 2 1 5" /></>,
  cat: <><path d="M5 7 4 3l4 2h8l4-2-1 4" /><path d="M4 11a8 8 0 0 0 16 0v-1a8 8 0 0 0-16 0Z" /><path d="M9 11h.01M15 11h.01M11 15h2" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  cloud: <path d="M7 19a4 4 0 0 1 0-8a5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 19Z" />,
  phone: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  thought: <><path d="M7 14a4 4 0 0 1 .5-8a4.5 4.5 0 0 1 8.5 1a3.5 3.5 0 0 1-.5 7Z" /><circle cx="6" cy="18" r="1.4" /><circle cx="3" cy="21" r="1" /></>,
  check: <path d="m4 12 5 5L20 6" />,
  trash: <><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>,
  power: <><path d="M12 3v9" /><path d="M6.5 7a8 8 0 1 0 11 0" /></>,
  star: <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4 6.4 20.3l1.1-6.2L3 9.7l6.2-.9Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
};

type Props = {
  name: IconName;
  /** 預設 16px，跟介面 10–12px 的 mono 字級搭。工具列的單圖示鈕用 18–20。 */
  size?: number;
  className?: string;
};

export function Icon({ name, size = 16, className }: Props) {
  return (
    <svg
      className={className ? `ui-icon ${className}` : "ui-icon"}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
