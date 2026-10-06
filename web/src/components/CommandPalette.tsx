import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { isCompositionKey } from "../keyboardInput";
import { t, tc } from "../i18n";

// Ctrl/⌘ K 指令面板：搜尋 NPC 並切換、換房間／視圖、對某位 NPC 預填指令、打開
// 現有的設定面板與工具。全部只是呼叫 App 既有的 handler——這裡不打任何 API、
// 不改任何設定；「對某人下指令」只會把字填進輸入框，送出永遠由使用者自己按。
//
// 輸入「@名字 內容」＝直接對那位 NPC 預填；沒有 @ 時，最後一列是「把這段字
// 填進目前 NPC 的輸入框」，Enter 一下就能接著打。

export type PaletteStatus = "idle" | "busy" | "approval" | "error";

export type PaletteEntry = {
  id: string;
  group: string;
  label: string;
  /** 名稱後面的灰字（職務、房間…），也參與搜尋。 */
  detail?: string;
  /** 右側的灰字（狀態、所在群組）。 */
  meta?: string;
  status?: PaletteStatus;
  icon: IconName;
  /** 額外的搜尋字（英文名、別名），不顯示。 */
  keywords?: string;
  run(): void;
};

export type PaletteWorker = { id: string; name: string; detail?: string; status: PaletteStatus };

type Props = {
  entries: PaletteEntry[];
  workers: PaletteWorker[];
  activeWorker?: { id: string; name: string } | null;
  onComposeTo(workerId: string, text: string): void;
  onClose(): void;
};

// 退場時長，跟 styles/responsive.css 的 .ui-modal[data-closing] 一致。
const EXIT_MS = 120;
const MAX_RESULTS = 60;

export type PaletteMatch = { score: number; hits: number[] };

/** 模糊比對：連續子字串優先（越靠前分數越高），否則退回「依序出現的字元」
 *  （字元之間的空隙越大分數越低）。回傳命中字元的位置供標示。比不到回 null。 */
export function paletteMatch(query: string, text: string): PaletteMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hay = text.toLowerCase();
  const at = hay.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s·/_-]/.test(hay[at - 1]);
    return { score: 1000 - at + (wordStart ? 200 : 0) - hay.length * 0.1, hits: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  const hits: number[] = [];
  let from = 0;
  for (const char of q) {
    if (char === " ") continue;
    const index = hay.indexOf(char, from);
    if (index < 0) return null;
    hits.push(index);
    from = index + 1;
  }
  const spread = hits[hits.length - 1] - hits[0] - (hits.length - 1);
  return { score: 400 - spread * 6 - hits[0], hits };
}

/** 「@名字 內容」：回傳名字片段與要預填的內容；不是 @ 開頭回 null。 */
export function parseMention(query: string): { who: string; text: string } | null {
  const match = /^@(\S*)\s*([\s\S]*)$/.exec(query.trimStart());
  return match ? { who: match[1], text: match[2] } : null;
}

type Row = { entry: PaletteEntry; hits: number[] };

function highlight(label: string, hits: number[]): ReactNode {
  if (!hits.length) return label;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(marked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  [...label].forEach((char, index) => {
    const hit = set.has(index);
    if (hit !== marked) { flush(index); marked = hit; }
    run += char;
  });
  flush(label.length);
  return out;
}

export function CommandPalette({ entries, workers, activeWorker, onComposeTo, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const returnFocusRef = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeTimerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const rows = useMemo<Row[]>(() => {
    const mention = parseMention(query);
    if (mention) {
      return workers
        .map((worker) => ({ worker, match: paletteMatch(mention.who, worker.name) }))
        .filter((candidate): candidate is { worker: PaletteWorker; match: PaletteMatch } => candidate.match !== null)
        .sort((a, b) => b.match.score - a.match.score)
        .map(({ worker }) => ({
          hits: [],
          entry: {
            id: `compose:${worker.id}`,
            group: t("對 NPC 下指令"),
            label: t("對 {name} 下指令", { name: worker.name }),
            detail: mention.text ? `${tc("punct", "「")}${mention.text.length > 40 ? `${mention.text.slice(0, 40)}…` : mention.text}${tc("punct", "」")}` : worker.detail,
            meta: t("只預填，不送出"),
            status: worker.status,
            icon: "send" as const,
            run: () => onComposeTo(worker.id, mention.text),
          },
        }));
    }
    if (!query.trim()) return entries.slice(0, MAX_RESULTS).map((entry) => ({ entry, hits: [] }));
    const scored = entries
      .map((entry) => {
        const onLabel = paletteMatch(query, entry.label);
        const onRest = paletteMatch(query, `${entry.detail ?? ""} ${entry.keywords ?? ""} ${entry.group}`);
        const best = onLabel && (!onRest || onLabel.score >= onRest.score - 150) ? onLabel : onRest ? { score: onRest.score - 150, hits: [] } : null;
        return best ? { entry, hits: best.hits, score: best.score } : null;
      })
      .filter((row): row is Row & { score: number } => row !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);
    const results: Row[] = scored.map(({ entry, hits }) => ({ entry: { ...entry, meta: entry.meta ?? entry.group }, hits }));
    if (activeWorker) {
      results.push({
        hits: [],
        entry: {
          id: "compose:active",
          group: t("對 NPC 下指令"),
          label: t("填進 {name} 的輸入框", { name: activeWorker.name }),
          detail: `${tc("punct", "「")}${query.trim().length > 40 ? `${query.trim().slice(0, 40)}…` : query.trim()}${tc("punct", "」")}`,
          meta: t("只預填，不送出"),
          icon: "enter",
          run: () => onComposeTo(activeWorker.id, query.trim()),
        },
      });
    }
    return results;
  }, [activeWorker, entries, onComposeTo, query, workers]);

  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);
  useEffect(() => () => { if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current); }, []);

  function requestClose() {
    if (closeTimerRef.current !== null) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      // 動作本身若已經把焦點移走（例如聚焦到輸入框），就不要再搶回來。
      const focus = document.activeElement;
      if (!focus || focus === document.body || panelRef.current?.contains(focus)) {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      }
      onCloseRef.current();
    }, EXIT_MS);
  }

  function runRow(row: Row | undefined) {
    if (!row || closing) return;
    row.entry.run();
    requestClose();
  }

  // Esc／再按一次 ⌘K：在捕獲階段吃掉，免得同一個按鍵又讓底下的專業模式或
  // 其他 modal 跟著關掉（ConfirmDialog 也是同一個作法）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const toggle = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (event.key !== "Escape" && !toggle) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // 選取游標：一塊底色滑到選中的那一列（而不是每列各自亮起），並把那一列捲進視野。
  useLayoutEffect(() => {
    const item = itemRefs.current[selected];
    const cursor = cursorRef.current;
    if (!cursor) return;
    if (!item) { cursor.style.opacity = "0"; return; }
    cursor.style.opacity = "1";
    cursor.style.height = `${item.offsetHeight}px`;
    cursor.style.translate = `0 ${item.offsetTop}px`;
    item.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (isCompositionKey(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      setSelected((index) => rows.length ? (index + 1) % rows.length : 0);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      setSelected((index) => rows.length ? (index - 1 + rows.length) % rows.length : 0);
    } else if (event.key === "Home" && rows.length) {
      event.preventDefault();
      setSelected(0);
    } else if (event.key === "End" && rows.length) {
      event.preventDefault();
      setSelected(rows.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runRow(rows[selected]);
    }
  }

  let lastGroup = "";
  const grouped = !query.trim();
  itemRefs.current = [];

  return (
    <div className="ui-modal pc-palette" role="dialog" aria-modal="true" aria-label={t("指令面板")} data-closing={closing ? "true" : undefined} onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="pc-palette__panel" ref={panelRef}>
        <div className="pc-palette__search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="pc-palette-list"
            aria-activedescendant={rows[selected] ? `pc-palette-${selected}` : undefined}
            aria-label={t("搜尋 NPC、房間、視圖與工具")}
            placeholder={t("搜尋 NPC、房間、視圖與工具…（@名字 直接對他下指令）")}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pc-palette__list" id="pc-palette-list" role="listbox" ref={listRef} aria-label={t("指令面板")}>
          <div className="pc-palette__cursor" ref={cursorRef} aria-hidden="true" />
          {rows.length === 0 && <div className="pc-palette__empty">{t("找不到相符的項目")}</div>}
          {rows.map((row, index) => {
            const header = grouped && row.entry.group !== lastGroup ? row.entry.group : null;
            lastGroup = row.entry.group;
            return (
              <div key={row.entry.id} role="presentation">
                {header && <div className="pc-palette__group" role="presentation">{header}</div>}
                <button
                  ref={(element) => { itemRefs.current[index] = element; }}
                  id={`pc-palette-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selected}
                  className="pc-palette__item"
                  style={{ "--i": index } as React.CSSProperties}
                  onPointerMove={() => { if (index !== selected) setSelected(index); }}
                  onClick={() => runRow(row)}
                >
                  <Icon name={row.entry.icon} />
                  <span className="pc-palette__label">{highlight(row.entry.label, row.hits)}{row.entry.detail && <small>{row.entry.detail}</small>}</span>
                  <span className="pc-palette__meta">
                    {row.entry.meta}
                    {row.entry.status && row.entry.status !== "idle" && <i className={`pc-palette__dot pc-palette__dot--${row.entry.status}`} aria-hidden="true" />}
                    <span className="pc-palette__enter" aria-hidden="true"><Icon name="enter" size={13} /></span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="pc-palette__foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t("選擇")}</span>
          <span><kbd>↵</kbd>{t("執行")}</span>
          <span><kbd>@</kbd>{t("對某位 NPC 下指令")}</span>
          <span><kbd>Esc</kbd>{t("關閉")}</span>
        </div>
      </div>
    </div>
  );
}
