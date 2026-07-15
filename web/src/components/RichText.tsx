import Markdown from "react-markdown";
import { isValidElement, useState, type ReactNode } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rich-code">
      <button type="button" aria-label="複製程式碼" title="複製程式碼" onClick={() => {
        void navigator.clipboard?.writeText(nodeText(children).replace(/\n$/, "")).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}>{copied ? "已複製" : "複製"}</button>
      <pre>{children}</pre>
    </div>
  );
}

export function RichText({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={`rich-text ${compact ? "rich-text--compact" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          pre({ node: _node, children }) {
            return <CodeBlock>{children}</CodeBlock>;
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
