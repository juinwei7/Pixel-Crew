import { useMemo, useState } from "react";
import type { ProviderId } from "../types";
import { parseWorkflowDocument, updateWorkflowDocument, workflowText } from "../workflowDocument";

type Field = { key: string; label: string; placeholder: string };

const CLAUDE_FIELDS: Field[] = [
  { key: "description", label: "用途說明", placeholder: "這個指令適合在什麼情況使用" },
  { key: "argument-hint", label: "參數提示", placeholder: "例如 [branch] [issue]" },
  { key: "allowed-tools", label: "允許工具", placeholder: "例如 Read, Bash, WebSearch" },
  { key: "model", label: "指定模型", placeholder: "留空使用 NPC 選擇的模型" },
];

const CODEX_FIELDS: Field[] = [
  { key: "description", label: "觸發情境", placeholder: "描述 Codex 何時應該使用這個 Skill" },
];

export function WorkflowDocumentEditor({
  provider,
  content,
  onChange,
}: {
  provider: ProviderId;
  content: string;
  onChange(content: string): void;
}) {
  const [mode, setMode] = useState<"structured" | "raw">("structured");
  const parsed = useMemo(() => parseWorkflowDocument(content), [content]);
  const fields = provider === "claude" ? CLAUDE_FIELDS : CODEX_FIELDS;

  function updateField(key: string, value: string) {
    try {
      onChange(updateWorkflowDocument(content, { [key]: value }));
    } catch {
      setMode("raw");
    }
  }

  return (
    <div className="command-editor__document">
      <div className="command-editor__bar">
        <span>{provider === "claude" ? "COMMAND DOCUMENT" : "SKILL.md"}</span>
        <small>{mode === "structured" ? "結構化欄位 ＋ Prompt" : "完整 Markdown / YAML"}</small>
        <div className="workflow-mode" role="tablist" aria-label="編輯模式">
          <button type="button" className={mode === "structured" ? "workflow-mode--active" : ""} onClick={() => setMode("structured")}>欄位</button>
          <button type="button" className={mode === "raw" ? "workflow-mode--active" : ""} onClick={() => setMode("raw")}>RAW</button>
        </div>
      </div>

      {mode === "structured" ? (
        <div className="workflow-structured">
          {parsed.error ? (
            <div className="workflow-structured__error" role="alert">
              YAML 無法解析：{parsed.error}。請切換 RAW 修正內容。
            </div>
          ) : (
            <div className="workflow-fields">
              {fields.map((field) => (
                <label key={field.key}>
                  <span>{field.label}</span>
                  <input
                    value={workflowText(parsed.attributes[field.key])}
                    placeholder={field.placeholder}
                    onChange={(event) => updateField(field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          )}
          <label className="workflow-body">
            <span>PROMPT / INSTRUCTIONS</span>
            <textarea
              value={parsed.body}
              disabled={Boolean(parsed.error)}
              onChange={(event) => onChange(updateWorkflowDocument(content, {}, event.target.value))}
              spellCheck={false}
              aria-label="Workflow Prompt"
            />
          </label>
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-label={provider === "claude" ? "指令 Markdown" : "Skill Markdown"}
        />
      )}
    </div>
  );
}
