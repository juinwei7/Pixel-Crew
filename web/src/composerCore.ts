export const MAX_COMPOSER_LINES = 6;

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
