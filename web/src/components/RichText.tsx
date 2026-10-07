import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";

export type MarkdownHeading = { id: string; level: number; label: string };
type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

// ── 延後載入 markdown 引擎 ─────────────────────────────────────────────
// react-markdown＋remark/rehype 一整串是全站最重的文字依賴（vite 的 rich-text chunk）。
// 改成動態 import：首屏不必等它，第一次要渲染 Markdown（或瀏覽器閒下來）才抓；
// 還沒到之前先用純文字（保留換行）頂著，內容立刻看得到、不會空白。
type MarkdownModule = typeof import("react-markdown");
type GfmModule = typeof import("remark-gfm");
type RawModule = typeof import("rehype-raw");
type SanitizeModule = typeof import("rehype-sanitize");
type MarkdownLib = {
  Markdown: MarkdownModule["default"];
  remarkGfm: GfmModule["default"];
  rehypeRaw: RawModule["default"];
  rehypeSanitize: SanitizeModule["default"];
  sanitizeSchema: SanitizeModule["defaultSchema"];
};

function buildLib(markdown: MarkdownModule, gfm: GfmModule, raw: RawModule, sanitize: SanitizeModule): MarkdownLib {
  const { defaultSchema } = sanitize;
  return {
    Markdown: markdown.default,
    remarkGfm: gfm.default,
    rehypeRaw: raw.default,
    rehypeSanitize: sanitize.default,
    sanitizeSchema: {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        code: [
          ...(defaultSchema.attributes?.code ?? []),
          ["className", /^language-[A-Za-z0-9_-]+$/],
        ],
      },
      protocols: {
        ...defaultSchema.protocols,
        href: ["http", "https", "mailto"],
        src: ["http", "https"],
      },
    },
  };
}

let markdownLib: MarkdownLib | null = null;
let markdownLibPromise: Promise<MarkdownLib> | null = null;

type NodeProcessLike = { versions?: { node?: string }; getBuiltinModule?: (id: string) => unknown };

/** 伺服器端／Node 測試環境：同步 require（Node 22+ 支援 require ESM），讓 renderToStaticMarkup
 *  一次就拿到完整 Markdown。瀏覽器裡沒有 process，這段直接略過。 */
function loadMarkdownLibSync(): MarkdownLib | null {
  const nodeProcess = (globalThis as { process?: NodeProcessLike }).process;
  if (!nodeProcess?.versions?.node || typeof nodeProcess.getBuiltinModule !== "function") return null;
  try {
    const { createRequire } = nodeProcess.getBuiltinModule("module") as { createRequire(url: string): (id: string) => unknown };
    const load = createRequire(import.meta.url);
    return buildLib(
      load("react-markdown") as MarkdownModule,
      load("remark-gfm") as GfmModule,
      load("rehype-raw") as RawModule,
      load("rehype-sanitize") as SanitizeModule,
    );
  } catch {
    return null;
  }
}

function currentMarkdownLib(): MarkdownLib | null {
  if (!markdownLib) markdownLib = loadMarkdownLibSync();
  return markdownLib;
}

/** 預先載入 markdown 引擎（重複呼叫共用同一個請求）。 */
export function preloadRichText(): Promise<void> {
  if (currentMarkdownLib()) return Promise.resolve();
  markdownLibPromise ??= Promise.all([import("react-markdown"), import("remark-gfm"), import("rehype-raw"), import("rehype-sanitize")])
    .then(([markdown, gfm, raw, sanitize]) => (markdownLib = buildLib(markdown, gfm, raw, sanitize)))
    .catch((error: unknown) => { markdownLibPromise = null; throw error; });
  return markdownLibPromise.then(() => undefined);
}

/** markdown 引擎是否已就緒。 */
export function isRichTextReady(): boolean {
  return currentMarkdownLib() !== null;
}

// 瀏覽器閒下來就先抓：多數情況使用者打開任務記錄時引擎已經在了，不會看到純文字閃一下。
if (typeof window !== "undefined" && typeof document !== "undefined" && !isRichTextReady()) {
  const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  const warm = () => { void preloadRichText().catch(() => {}); };
  if (typeof idle === "function") idle.call(window, warm, { timeout: 2500 });
  else window.setTimeout(warm, 1200);
}

// ── 串流節流 ───────────────────────────────────────────────────────────
// 串流中每個 token 都整篇重跑 remark/rehype 很貴（長回覆一秒幾十次）。串流時最多每
// STREAM_RENDER_INTERVAL_MS 重算一次（再對齊下一個 animation frame）；串流一結束立刻用
// 完整文字渲染一次，不等計時器。
export const STREAM_RENDER_INTERVAL_MS = 100;

/** 距離上次渲染還要等多久才能再渲染；0＝現在就可以。 */
export function streamRenderDelay(lastRenderAt: number, now: number, interval = STREAM_RENDER_INTERVAL_MS): number {
  return Math.max(0, lastRenderAt + interval - now);
}

function useStreamThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const latestRef = useRef(text);
  const lastRenderAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  latestRef.current = text;

  useEffect(() => {
    const cancel = () => {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      if (frameRef.current !== null) { window.cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    };
    if (!streaming) {
      cancel();
      lastRenderAtRef.current = 0;
      setShown(text);
      return;
    }
    // 已排好下一次：到時會讀 latestRef 的最新文字，不必重排。
    if (timerRef.current !== null || frameRef.current !== null) return;
    const flush = () => {
      timerRef.current = null;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        lastRenderAtRef.current = Date.now();
        setShown(latestRef.current);
      });
    };
    const wait = streamRenderDelay(lastRenderAtRef.current, Date.now());
    if (wait === 0) flush();
    else timerRef.current = window.setTimeout(flush, wait);
  }, [text, streaming]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  // 不在串流：永遠直接用完整文字（結束那一刻就是完整渲染，不會慢一拍）。
  return streaming ? shown : text;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function headingSlug(label: string): string {
  return label.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

function headingId(prefix: string, label: string, occurrence: number): string {
  return `${prefix}-heading-${headingSlug(label)}-${occurrence}`;
}

export function extractMarkdownHeadings(text: string, prefix: string): MarkdownHeading[] {
  const counts = new Map<string, number>();
  const headings: MarkdownHeading[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const addHeading = (rawLabel: string, level: number) => {
    const label = rawLabel.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1").replace(/[*_~`]/g, "").trim();
    if (!label) return;
    const slug = headingSlug(label);
    const occurrence = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, occurrence);
    headings.push({ id: headingId(prefix, label, occurrence), level, label });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      addHeading(match[2], match[1].length);
      continue;
    }
    const setext = /^\s*(=+|-+)\s*$/.exec(lines[index + 1] ?? "");
    if (line && setext) {
      addHeading(line, setext[1][0] === "=" ? 1 : 2);
      index += 1;
    }
  }
  return headings;
}

function rehypeHighlightSearch(options?: { query?: string }) {
  const query = options?.query?.trim();
  return (tree: HastNode) => {
    if (!query) return;
    const needle = query.toLocaleLowerCase();
    const walk = (node: HastNode, skipped = false) => {
      const skipChildren = skipped || (node.type === "element" && ["code", "pre", "style", "script"].includes(node.tagName ?? ""));
      if (!node.children || skipChildren) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          walk(child, skipChildren);
          next.push(child);
          continue;
        }
        const lower = child.value.toLocaleLowerCase();
        let cursor = 0;
        let index = lower.indexOf(needle);
        if (index < 0) {
          next.push(child);
          continue;
        }
        while (index >= 0) {
          if (index > cursor) next.push({ type: "text", value: child.value.slice(cursor, index) });
          next.push({ type: "element", tagName: "mark", properties: { className: ["search-highlight"] }, children: [{ type: "text", value: child.value.slice(index, index + query.length) }] });
          cursor = index + query.length;
          index = lower.indexOf(needle, cursor);
        }
        if (cursor < child.value.length) next.push({ type: "text", value: child.value.slice(cursor) });
      }
      node.children = next;
    };
    walk(tree);
  };
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rich-code">
      <button type="button" aria-label={t("複製程式碼")} title={t("複製程式碼")} onClick={() => {
        void navigator.clipboard?.writeText(nodeText(children).replace(/\n$/, "")).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}>{copied ? t("已複製") : t("複製")}</button>
      <pre>{children}</pre>
    </div>
  );
}

type RichTextProps = {
  text: string;
  compact?: boolean;
  headingPrefix?: string;
  highlight?: string;
  /** 這段文字還在串流長出來：Markdown 重算節流，結束後一次完整渲染。 */
  streaming?: boolean;
};

export const RichText = memo(function RichText({ text, compact = false, headingPrefix, highlight = "", streaming = false }: RichTextProps) {
  const [lib, setLib] = useState<MarkdownLib | null>(currentMarkdownLib);
  const renderedText = useStreamThrottledText(text, streaming);

  useEffect(() => {
    if (lib) return;
    let alive = true;
    preloadRichText().then(() => { if (alive) setLib(currentMarkdownLib()); }).catch(() => { /* 載入失敗：留在純文字，內容仍完整可讀 */ });
    return () => { alive = false; };
  }, [lib]);

  const body = useMemo(() => {
    if (!lib) return <div className="rich-text__plain">{renderedText}</div>;
    const { Markdown, remarkGfm, rehypeRaw, rehypeSanitize, sanitizeSchema } = lib;
    const headingCounts = new Map<string, number>();
    const nextHeadingId = (children: ReactNode) => {
      if (!headingPrefix) return undefined;
      const label = nodeText(children);
      const slug = headingSlug(label);
      const occurrence = (headingCounts.get(slug) ?? 0) + 1;
      headingCounts.set(slug, occurrence);
      return headingId(headingPrefix, label, occurrence);
    };
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeHighlightSearch, { query: highlight }]]}
        components={{
          h1({ node: _node, children, ...props }) { return <h1 {...props} id={nextHeadingId(children)}>{children}</h1>; },
          h2({ node: _node, children, ...props }) { return <h2 {...props} id={nextHeadingId(children)}>{children}</h2>; },
          h3({ node: _node, children, ...props }) { return <h3 {...props} id={nextHeadingId(children)}>{children}</h3>; },
          pre({ node: _node, children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
          table({ node: _node, children, ...props }) {
            // Task reports often contain wide Issue tables. Preserve their
            // columns and scroll the wrapper instead of crushing every cell.
            return <div className="rich-text__table-scroll" tabIndex={0}><table {...props}>{children}</table></div>;
          },
          a({ node: _node, href, children, ...props }) {
            const external = Boolean(href && !href.startsWith("#"));
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
          img({ node: _node, src, alt, ...props }) {
            return (
              <img
                {...props}
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            );
          },
        }}
      >
        {renderedText}
      </Markdown>
    );
  }, [lib, renderedText, headingPrefix, highlight]);

  return (
    <div className={`rich-text ${compact ? "rich-text--compact" : ""}`} data-streaming={streaming ? "true" : undefined}>
      {body}
    </div>
  );
});
