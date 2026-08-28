/** NPC 回覆是 markdown 原文；對話泡泡／工作小窗畫在 canvas 或單行 DOM 上，
 *  排不了富文字，直接把標記拿掉、留下可讀內容。清單符號換成「•」保留結構感。 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^```[^\n]*$/gm, "")                 // fenced code 圍欄行（保留程式碼內容）
    .replace(/`([^`\n]+)`/g, "$1")                // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")     // 圖片 → alt 文字
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")      // 連結 → 連結文字
    .replace(/^#{1,6}\s+/gm, "")                  // 標題
    .replace(/^\s*>\s?/gm, "")                    // 引用
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")          // 無序清單
    .replace(/\*\*(?![\s/])(.+?)(?<![\s/])\*\*/g, "$1")                       // 粗體 **（避開 shell glob src/**/*.ts）
    .replace(/(?<![A-Za-z0-9])__(?![A-Za-z0-9\s])(.+?)(?<!\s)__(?![A-Za-z0-9])/g, "$1") // 粗體 __（避開 __init__.py 這類識別字）
    .replace(/~~(.+?)~~/g, "$1")                  // 刪除線
    .replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s）)。，,.!?！？]|$)/gm, "$1$2") // 斜體（避開乘號等裸 *）
    .replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, "") // 分隔線
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
