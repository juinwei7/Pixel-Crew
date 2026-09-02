import Markdown from "react-markdown";
import { isValidElement, useState, type ReactNode } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { t } from "../i18n";

export type MarkdownHeading = { id: string; level: number; label: string };
type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const sanitizeSchema = {
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
};

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

export function RichText({ text, compact = false, headingPrefix, highlight = "" }: { text: string; compact?: boolean; headingPrefix?: string; highlight?: string }) {
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
    <div className={`rich-text ${compact ? "rich-text--compact" : ""}`}>
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
        {text}
      </Markdown>
    </div>
  );
}
