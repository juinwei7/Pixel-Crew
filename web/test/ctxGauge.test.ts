import assert from "node:assert/strict";
import test from "node:test";
import { computeCtxGauge, SWAP_THRESHOLD_TOKENS } from "../src/ctxGauge";

test("空序列回 null", () => {
  assert.equal(computeCtxGauge([]), null);
});

test("單筆＝出生底盤，顯示 0%", () => {
  const gauge = computeCtxGauge([42_000]);
  assert.deepEqual(gauge, { pct: 0, baselineTokens: 42_000, currentTokens: 42_000 });
});

test("同 session 漸增：以第一筆當底盤換算", () => {
  const gauge = computeCtxGauge([50_000, 90_000, 110_000]);
  assert.equal(gauge?.baselineTokens, 50_000);
  // (110k − 50k) / (170k − 50k) = 50%
  assert.equal(gauge?.pct, 50);
});

test("到達換腦門檻＝100%，超過也封頂", () => {
  assert.equal(computeCtxGauge([50_000, SWAP_THRESHOLD_TOKENS])?.pct, 100);
  assert.equal(computeCtxGauge([50_000, 190_000])?.pct, 100);
});

test("換腦後大幅下降：重設底盤，條回到低點", () => {
  const gauge = computeCtxGauge([50_000, 168_000, 44_000, 60_000]);
  assert.equal(gauge?.baselineTokens, 44_000);
  // (60k − 44k) / (170k − 44k) ≈ 13%
  assert.equal(gauge?.pct, 13);
});

test("小幅回落（雜訊）不當成換腦", () => {
  const gauge = computeCtxGauge([50_000, 100_000, 92_000]);
  assert.equal(gauge?.baselineTokens, 50_000);
});

test("底盤本身高於門檻：直接 100%", () => {
  assert.equal(computeCtxGauge([180_000])?.pct, 100);
});

test("server 帶下來的門檻覆蓋預設值", () => {
  // (60k − 20k) / (100k − 20k) = 50%
  assert.equal(computeCtxGauge([20_000, 60_000], 100_000)?.pct, 50);
  assert.equal(computeCtxGauge([20_000, 100_000], 100_000)?.pct, 100);
});
