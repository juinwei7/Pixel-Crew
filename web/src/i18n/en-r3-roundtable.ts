// 第三輪（R3）roundtable 新增字串的英文翻譯。
export const enR3Roundtable: Record<string, string> = {
  // roundtablePrompt.ts
  "【快速圓桌】": "[Quick Roundtable]",
  "【快速圓桌・反方檢驗】": "[Quick Roundtable · Counter-check]",
  "【快速圓桌・照結論執行】": "[Quick Roundtable · Execute]",
  "重要限制（為了省時省 token）：這是一次性的內部模擬討論，在這一則回覆內完成。不要派工、不要開其他 Agent；除了下面允許的少量唯讀查閱，不要呼叫任何工具。":
    "Important constraint (to save time and tokens): this is a one-shot internal simulated discussion, finished within this single reply. Don't dispatch work or start other agents; apart from the few read-only lookups allowed below, don't call any tools.",
  "專案脈絡：先用你在這段對話裡已知的專案狀況。主題若指涉目前工作區（「這個專案／這個工具／我們的程式」之類），而你還沒看過相關內容，就先做最多 {n} 次唯讀查閱（讀檔、搜尋、列目錄合計，優先看 README 與主要入口檔）再上桌，別用猜的；與專案無關的主題不必查。不得寫檔、不得執行會改變狀態的指令、不碰 Git 寫入或設定。查不到就寫明你的假設，不要為了查證拉長。":
    "Project context: start from what you already know about the project in this conversation. If the topic refers to the current workspace (\"this project / this tool / our code\") and you haven't seen the relevant parts yet, first make at most {n} read-only lookups (reading files, searching, listing directories combined; start with the README and the main entry file) before the discussion — don't guess. Topics unrelated to the project need no lookups. Don't write files, don't run commands that change state, and don't touch Git writes or settings. If you can't find something, state your assumption instead of dragging the discussion out to verify it.",
  "上桌規則：依這個主題挑 2–4 個「真的會意見相左」的具體角色（例如「負責半夜值班的維運」比「工程」好），其中一位必須是反方，專門反駁最可能的結論。":
    "Seating rules: for this topic, pick 2–4 specific roles that would genuinely disagree (e.g. \"the on-call ops engineer who gets paged at night\" beats \"engineering\"); one of them must be the opposition, dedicated to arguing against the most likely conclusion. ",
  "每位講出主張、自己最在意的取捨標準、一個具體理由（能引用專案事實更好）。觀點該衝突就衝突，不要每個人都說「看情況」。":
    "Each states a position, the trade-off criterion they care about most, and one concrete reason (citing project facts is better). Let viewpoints clash where they should; don't let everyone say \"it depends.\"",
  "最後你以主持人身分下判斷：先講做／不做／選哪個，再講用了哪個取捨標準、犧牲了什麼。使用者最在意「結論」，要具體、能直接照做，不要打太極。":
    "Finally, as moderator, make the call: first say do / don't / which option, then which trade-off criterion decided it and what was sacrificed. The user cares most about the \"conclusion,\" so be concrete and directly actionable — don't hedge.",
  "主張；在意：取捨標準；理由": "Position; cares about: trade-off criterion; reason",
  "（列 2–4 個角色，至少一位反方）": "(list 2–4 roles, at least one in opposition)",
  "第一句直接下判斷；再用一兩句講取捨標準與犧牲了什麼。":
    "Open with the decision itself; then one or two sentences on the deciding criterion and what was sacrificed.",
  "信心": "Confidence",
  "高／中／低（擇一）— 一句理由。若信心低，或這是代價高、難以撤回的決定，請在這裡建議「升級作戰室」。":
    "High / Medium / Low (pick one) — one-sentence reason. If confidence is low, or this is a costly decision that's hard to walk back, recommend \"escalate to the war room\" here.",
  "什麼情況會改變結論": "What would change the conclusion",
  "1–3 個具體、可觀察的訊號": "1–3 concrete, observable signals",
  "1–3 個可直接照做的行動，第一個今天就能動手": "1–3 directly actionable steps; the first one can start today",
  "對剛才那場快速圓桌的結論做一次反方壓力測試。你現在是最強的反對者，目標是找出它會失敗的方式，而不是附和。":
    "Stress-test the conclusion of the quick roundtable you just held. You are now its strongest opponent: your goal is to find how it fails, not to agree with it.",
  "待檢驗的結論：{conclusion}": "Conclusion under test: {conclusion}",
  "最強反對論點": "Strongest objections",
  "1–3 點，每點附「如果發生會怎樣」": "1–3 points, each with \"what happens if it occurs\"",
  "第一句寫「維持」或「修正」；修正就直接給新的結論。": "Open with \"Keep\" or \"Revise\"; if revising, give the new conclusion directly.",
  "高／中／低（擇一）— 一句理由。": "High / Medium / Low (pick one) — one-sentence reason.",
  "1–3 個可直接照做的行動": "1–3 directly actionable steps",
  "照剛才快速圓桌的結論開始執行，這次可以正常動手做事。":
    "Start carrying out the conclusion of the quick roundtable you just held; this time you may work normally.",
  "結論：{conclusion}": "Conclusion: {conclusion}",
  "依序處理：": "Handle in order:",
  "執行中若發現下列任一情況成立，先停下來回報，不要硬做：":
    "If any of the following turns out to be true while working, stop and report first instead of pushing on:",
  "做完回報實際做了什麼、驗證結果，以及還沒做的部分。":
    "When done, report what you actually did, how it was verified, and what is still left.",
  "（信心：{level}）": " (confidence: {level})",
  "快速圓桌初判：{conclusion}{confidence}。請重點檢驗這個初判是否站得住。":
    "Quick roundtable's initial call: {conclusion}{confidence}. Focus on testing whether this call holds up.",

  // roundtableResult.ts
  "高": "High",
  "中": "Medium",
  "低": "Low",

  // components/RoundtableFollowUp.tsx
  "圓桌結論": "Roundtable verdict",
  "信心 {level}": "Confidence {level}",
  "照結論執行": "Execute it",
  "反方檢驗": "Counter-check",
  "升級作戰室": "Escalate to War Room",
  "升級作戰室（建議）": "Escalate to War Room (recommended)",
  "把結論與下一步交給這位 NPC 直接動手；遇到會改變結論的情況會先停下回報":
    "Hand the conclusion and next steps to this NPC to carry out; it stops and reports first if something would change the conclusion",
  "再花一回合，由同一位 NPC 專門攻擊這個結論，判斷維持或修正":
    "Spend one more turn having the same NPC attack this conclusion, then keep or revise it",
  "建議：信心不足或代價高，交給作戰室由多位同儕深辯；約需數分鐘並使用該 LLM 用量":
    "Recommended: confidence is low or the stakes are high — hand it to the War Room for a deeper debate among several peers; takes a few minutes and uses that LLM's quota",
  "交給作戰室由多位同儕深辯，會附上這次的初判；約需數分鐘並使用該 LLM 用量":
    "Hand it to the War Room for a deeper debate among several peers, with this initial call attached; takes a few minutes and uses that LLM's quota",
};
