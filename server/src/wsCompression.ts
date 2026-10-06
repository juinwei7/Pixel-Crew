import type { PerMessageDeflateOptions } from "ws";

// /ws 的 permessage-deflate 設定（index.ts 的 WebSocketServer 使用；抽出來方便單元測試）。
// 只壓 >1KB 的訊息：初始 snapshot（數 MB JSON）可縮到約 1/5~1/10，手機遠端連線最受惠；
// 小訊息（串流 delta、狀態更新）不壓，省 CPU 與延遲。不保留壓縮 context＝每連線不常駐 zlib
// 視窗記憶體。瀏覽器原生支援；不支援的 client 協商時自動退回不壓縮（向後相容）。
export const WS_COMPRESSION_THRESHOLD_BYTES = 1024;

export const wsPerMessageDeflate: PerMessageDeflateOptions = {
  threshold: WS_COMPRESSION_THRESHOLD_BYTES,
  zlibDeflateOptions: { level: 3, memLevel: 7, chunkSize: 16 * 1024 },
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 10,
};
