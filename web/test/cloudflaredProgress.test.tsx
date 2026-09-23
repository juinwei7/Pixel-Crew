import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type CfInfo, describeDownload, formatBytes, formatEta } from "../src/cloudflaredProgress";
import { CloudflaredDownload } from "../src/components/RemoteAccessModal";

function info(progress: CfInfo["progress"]): CfInfo {
  return { installed: false, running: false, url: "", downloading: true, progress };
}

test("位元組換算挑得出合適的單位", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(19_217_478), "18.3 MB");
});

test("剩餘時間按量級換單位", () => {
  assert.equal(formatEta(0), "0 秒");
  assert.equal(formatEta(45), "45 秒");
  assert.equal(formatEta(61), "2 分鐘");
  assert.equal(formatEta(7200), "2 小時");
});

test("有總長度時給百分比、大小、速度、ETA", () => {
  const d = describeDownload(info({ received: 4_194_304, total: 19_217_478, pct: 21, bytesPerSec: 1_048_576, etaSec: 14 }));
  assert.equal(d.pct, 21);
  assert.equal(d.headline, "21%");
  assert.equal(d.size, "4.0 MB / 18.3 MB");
  assert.equal(d.speed, "1.0 MB/s");
  assert.equal(d.eta, "剩餘約 14 秒");
});

// 伺服器沒給 content-length 時停在 0% 會讓人以為當掉了——改成不確定進度。
test("沒有總長度＝不確定進度，只報已下載量", () => {
  const d = describeDownload(info({ received: 1_048_576, total: 0, pct: null, bytesPerSec: 0, etaSec: null }));
  assert.equal(d.pct, null);
  assert.equal(d.headline, "下載中…");
  assert.equal(d.size, "1.0 MB");
  assert.equal(d.speed, "");
  assert.equal(d.eta, "");
});

test("還沒收到任何進度也不會炸", () => {
  const d = describeDownload(null);
  assert.equal(d.pct, null);
  assert.equal(d.size, "0 B");
});

test("百分比被夾在 0〜100", () => {
  assert.equal(describeDownload(info({ received: 9, total: 10, pct: 140, bytesPerSec: 1, etaSec: 0 })).pct, 100);
  assert.equal(describeDownload(info({ received: 0, total: 10, pct: -5, bytesPerSec: 0, etaSec: null })).pct, 0);
});

test("進度條畫出百分比寬度與可讀狀態", () => {
  const html = renderToStaticMarkup(
    <CloudflaredDownload info={info({ received: 4_194_304, total: 19_217_478, pct: 21, bytesPerSec: 1_048_576, etaSec: 14 })} />,
  );
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="21"/);
  assert.match(html, /width:21%/);
  assert.match(html, /4\.0 MB \/ 18\.3 MB/);
  assert.match(html, /剩餘約 14 秒/);
});

test("不確定進度不報 aria-valuenow", () => {
  const html = renderToStaticMarkup(<CloudflaredDownload info={info(null)} />);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.match(html, /width:100%/);
});

test("有取消回呼才長出取消按鈕", () => {
  const withCancel = renderToStaticMarkup(<CloudflaredDownload info={info(null)} onCancel={async () => {}} />);
  assert.match(withCancel, /取消下載/);
  assert.doesNotMatch(renderToStaticMarkup(<CloudflaredDownload info={info(null)} />), /取消下載/);
});
