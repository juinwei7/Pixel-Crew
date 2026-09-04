// Large enough for the daemon's bounded 1.5 MB scrollback even when JSON
// escaping expands control characters, but finite so a stalled browser cannot
// turn an unbounded command (for example `yes`) into unbounded server memory.
export const MAX_TERMINAL_CLIENT_BUFFER_BYTES = 12_000_000;

export function terminalClientBufferWouldOverflow(bufferedBytes: number, payloadBytes: number): boolean {
  return bufferedBytes < 0 || payloadBytes < 0 || bufferedBytes + payloadBytes > MAX_TERMINAL_CLIENT_BUFFER_BYTES;
}
