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

// SSRF：yt-dlp 的 generic extractor 會抓任何網址，指向本機／內網的連結必須在啟動 yt-dlp 前擋下。
test("downloadVideoFromUrl 擋下指向本機與內網的連結", async () => {
  for (const url of [
    "http://127.0.0.1:8787/api/backup/export",
    "http://localhost:8787/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/video.mp4",
    "http://10.0.0.5/a.mp4",
  ]) {
    await assert.rejects(
      () => downloadVideoFromUrl(url, { ytDlpBin: "/nonexistent/yt-dlp" }),
      (error) => error instanceof VideoDownloadError && /內部位址/.test(error.message),
      url,
    );
  }
});
