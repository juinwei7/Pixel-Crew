export const MAX_COMPOSER_LINES = 10;

export function explicitComposerLineCount(value: string): number {
  return Math.max(1, Math.min(MAX_COMPOSER_LINES, value.split("\n").length));
}

export function composerTextareaHeight(value: string, lineHeight = 22, verticalPadding = 18): number {
  return explicitComposerLineCount(value) * lineHeight + verticalPadding;
}

export function shouldSubmitComposerKey(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing && !input.repeat;
}

export function newClientMessageIdentity(): { clientMessageId: string; idempotencyKey: string } {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return { clientMessageId: id, idempotencyKey: `message:${id}` };
}

// 語音轉寫結果不可覆蓋使用者已輸入的文字；空草稿直接取代，非空草稿在需要時補一個
// 空白再接上去，避免「你好世界」+「嗨」黏成「你好世界嗨」。
export function insertVoiceTranscript(current: string, transcript: string): string {
  if (!current.trim()) return transcript;
  return /\s$/.test(current) ? `${current}${transcript}` : `${current} ${transcript}`;
}
