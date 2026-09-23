import assert from "node:assert/strict";
import test from "node:test";

import { isProbableVideoUrl, VideoDownloadError, downloadVideoFromUrl } from "../src/videoDownload.js";

// isProbableVideoUrl 是貼連結看影片的第一道守門：只放行 http(s)，擋掉 file://、javascript:、
// 純文字等會被 yt-dlp 誤解析或有安全疑慮的輸入。錯放會把非影片 URL 送進外部下載器。
test("isProbableVideoUrl 只接受 http(s) 且格式合法的網址", () => {
  assert.equal(isProbableVideoUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(isProbableVideoUrl("http://example.com/a.mp4"), true);
  assert.equal(isProbableVideoUrl("  https://youtu.be/abc  "), true); // 前後空白會被 trim
});

test("isProbableVideoUrl 擋掉非 http(s) 與無效輸入", () => {
  assert.equal(isProbableVideoUrl("file:///C:/secret.mp4"), false);
  assert.equal(isProbableVideoUrl("javascript:alert(1)"), false);
  assert.equal(isProbableVideoUrl("ftp://host/x"), false);
  assert.equal(isProbableVideoUrl("not a url"), false);
  assert.equal(isProbableVideoUrl(""), false);
  assert.equal(isProbableVideoUrl("httpsomething"), false);
});

// 非法連結必須在觸發 yt-dlp 前就被擋下並丟 VideoDownloadError（而非啟動子行程）。
test("downloadVideoFromUrl 對非法連結立即丟 VideoDownloadError", async () => {
  await assert.rejects(() => downloadVideoFromUrl("file:///etc/passwd"), VideoDownloadError);
  await assert.rejects(() => downloadVideoFromUrl("   "), VideoDownloadError);
});
