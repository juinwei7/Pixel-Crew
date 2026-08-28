import assert from "node:assert/strict";
import test from "node:test";
import {
  composeConsultAsk,
  composeConsultDigest,
  composeConsultSection,
  selectConsultTargets,
  type ConsultCandidate,
} from "../src/consult.js";

const dept = { name: "獵蟲小隊", leadWorkerId: "lead", memberWorkerIds: ["lead", "m1", "m2"] };
const names: Record<string, string> = { lead: "隊長", m1: "修復手", m2: "驗證官" };
const workerName = (id: string) => names[id];

test("composeConsultSection injects the consult block for a lead with mates", () => {
  const section = composeConsultSection({ workerId: "lead", port: 8787, department: dept, workerName });
  assert.match(section, /【小隊商量】你是「獵蟲小隊」的隊長，隊員：修復手、驗證官。/);
  assert.match(section, /http:\/\/127\.0\.0\.1:8787\/api\/workers\/lead\/consult/);
  assert.match(section, /【隊員商量回報】/);
});

test("composeConsultSection is empty for non-leads, missing departments, and mate-less leads", () => {
  assert.equal(composeConsultSection({ workerId: "m1", port: 8787, department: dept, workerName }), "");
  assert.equal(composeConsultSection({ workerId: "lead", port: 8787, department: null, workerName }), "");
  const solo = { name: "單人部門", leadWorkerId: "lead", memberWorkerIds: ["lead"] };
  assert.equal(composeConsultSection({ workerId: "lead", port: 8787, department: solo, workerName }), "");
  // 隊員全都已離開（查不到名字）也不注入
  assert.equal(composeConsultSection({ workerId: "lead", port: 8787, department: dept, workerName: () => undefined }), "");
});

function candidate(overrides: Partial<ConsultCandidate> = {}): ConsultCandidate {
  return {
    name: "隊員",
    busy: false,
    autoApproveMode: "off",
    dailyBudgetUsd: () => null,
    todayCostUsd: () => 0,
    ...overrides,
  };
}

test("selectConsultTargets keeps idle members and skips the lead and departed workers", () => {
  const { targetIds, skipped } = selectConsultTargets("lead", ["lead", "m1", "gone", "m2"], (id) => {
    if (id === "gone") return null;
    return candidate({ name: names[id] ?? id });
  });
  assert.deepEqual(targetIds, ["m1", "m2"]);
  assert.deepEqual(skipped, []);
});

test("selectConsultTargets skips busy, invincible, and budget-exhausted members with reasons", () => {
  const roster: Record<string, ConsultCandidate> = {
    busy1: candidate({ name: "忙人", busy: true }),
    inv1: candidate({ name: "無敵俠", autoApproveMode: "invincible" }),
    broke1: candidate({ name: "月光族", dailyBudgetUsd: () => 5, todayCostUsd: () => 5 }),
    under: candidate({ name: "還有錢", dailyBudgetUsd: () => 5, todayCostUsd: () => 4.99 }),
    ok: candidate({ name: "空閒者" }),
  };
  const { targetIds, skipped } = selectConsultTargets("lead", Object.keys(roster), (id) => roster[id]);
  assert.deepEqual(targetIds, ["under", "ok"]);
  assert.deepEqual(skipped, ["忙人（忙碌中）", "無敵俠（⚡無限制模式不自動應答）", "月光族（今日預算已滿）"]);
});

test("selectConsultTargets only reads budget lazily for members that pass earlier gates", () => {
  let budgetReads = 0;
  const busyMate = candidate({ name: "忙人", busy: true, dailyBudgetUsd: () => { budgetReads++; return null; } });
  const invMate = candidate({ name: "無敵俠", autoApproveMode: "invincible", dailyBudgetUsd: () => { budgetReads++; return null; } });
  selectConsultTargets("lead", ["a", "b"], (id) => (id === "a" ? busyMate : invMate));
  assert.equal(budgetReads, 0); // 維持原邏輯的讀取時機：忙碌／無敵者不查預算
});

test("composeConsultAsk names the lead and forbids nested consults", () => {
  const ask = composeConsultAsk("隊長", "要不要導入 CI？");
  assert.match(ask, /【隊長商量】隊長「隊長」想聽你的專業意見/);
  assert.match(ask, /不要反問、不要發起任何商量或委派/);
  assert.match(ask, /問題：要不要導入 CI？$/);
});

test("composeConsultDigest assembles replies, fallback text, and the skipped roster", () => {
  const digest = composeConsultDigest(
    "要不要導入 CI？",
    [{ name: "修復手", text: "建議導入" }, { name: "驗證官", text: "" }],
    ["月光族（今日預算已滿）"],
  );
  assert.equal(digest, [
    "【隊員商量回報】你發起的商量「要不要導入 CI？」結果：",
    "",
    "▍修復手：",
    "建議導入",
    "",
    "▍驗證官：",
    "（逾時或未回覆）",
    "",
    "（未參與：月光族（今日預算已滿））",
    "",
    "請整合以上意見，給使用者你的結論。不要再發起新的商量。",
  ].join("\n"));
});

test("composeConsultDigest omits the skipped line when nobody was skipped", () => {
  const digest = composeConsultDigest("Q", [{ name: "A", text: "答" }], []);
  assert.doesNotMatch(digest, /未參與/);
});
