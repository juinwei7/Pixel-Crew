import { useRef, type Ref } from "react";
import { t } from "../i18n";
import { paneAfterSwipe, swipeStep, SWIPE_MIN_DISTANCE_CHIP } from "../swipeGesture";

/* 工作模式切換（像素／專業／黑窗）。

   桌面是三顆並排的分段按鈕，一眼看得到全部、一下就換。手機不行：英文的
   「Pixel / Professional / Black Window」要 227px，一條 374px 的頂欄等於被它
   吃掉六成，剩下的控件只好擠到第二排。

   手機改成只顯示目前這一個，另外兩個收起來：
   - 左右滑 → 移到相鄰的模式（跟黑窗換 pane 同一套判定，見 swipeGesture.ts）
   - 點一下 → 展開三個選項直接選

   點擊刻意不做成「循環到下一個」。要到第三個得點兩次，而且中途一定會真的
   停在另一個模式一次——每停一次就掛載一次那個畫面，黑窗還會去接一個真的
   shell。滑動是給順手的人，展開是給看得到選項的人；兩條路都不會不小心經過
   一個你根本不想進去的模式。

   兩種版型都直接印在 DOM 裡、由 CSS 決定誰出現，不用 useIsPhone 之類的 JS
   判斷：版型用 JS 算會在轉向／拖視窗時閃一下，而且 SSR／測試那一輪拿不到
   正確答案（web 測試只看 renderToStaticMarkup 的輸出）。

   class 用中性的 ui-mode-*，頂欄與黑窗工具列共用同一份結構，各自的外觀由
   祖先選擇器覆寫（跟 Modal 的 ui-modal 同一個作法）——黑窗那排是終端機綠，
   頂欄那排是青色，但「收合成一顆、滑動換」的行為只寫一次。 */

type Props = {
  /** 0 像素 / 1 專業 / 2 黑窗。 */
  current: number;
  onSelect(index: number): void;
  professionalModeButtonRef?: Ref<HTMLButtonElement>;
};

/** 目前模式在 0/1/2 的哪一格。黑窗優先：它一開就蓋過專業模式。 */
export function modeIndex(professionalMode: boolean, blackWindowMode: boolean): number {
  if (blackWindowMode) return 2;
  return professionalMode ? 1 : 0;
}

export function ModeSwitch({ current, onSelect, professionalModeButtonRef }: Props) {
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const start = useRef<{ x: number; y: number; at: number } | null>(null);
  const swiped = useRef(false);

  const modes = [
    { label: t("像素"), title: t("像素辦公室：看得到每位 NPC 在做什麼") },
    { label: t("專業"), title: t("專業模式：只留對話與任務紀錄") },
    { label: t("黑窗"), title: t("直接連到目前工作資料夾的原始 shell；指令會立刻在本機執行") },
  ];

  const apply = (index: number) => { if (index !== current) onSelect(index); };
  const closePicker = () => { if (pickerRef.current) pickerRef.current.open = false; };

  // 滑動：只收起訖點，門檻交給 swipeGesture。setPointerCapture 讓手指滑出
  // 那顆 100px 的小鈕之後還收得到事件，不然稍微滑遠一點就沒有 pointerup 了。
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!event.isPrimary) return;
    start.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 不支援就算了 */ }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const from = start.current;
    start.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 同上 */ }
    if (!from) return;
    const step = swipeStep({
      dx: event.clientX - from.x,
      dy: event.clientY - from.y,
      elapsedMs: event.timeStamp - from.at,
    }, SWIPE_MIN_DISTANCE_CHIP);
    if (step === 0) return;
    // 這一下是滑動不是點擊。擋在 pointerup 沒有用——preventDefault 不會取消後面
    // 跟著發的 click，<summary> 照樣展開（實測滑完模式換了、選單也開了）。真正
    // 要擋的是那個 click。
    swiped.current = true;
    const next = paneAfterSwipe(current, modes.length, step);
    if (next !== current) apply(next);
  };
  const onSummaryClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!swiped.current) return;
    swiped.current = false;
    event.preventDefault();
  };

  return (
    <>
      <div className="ui-mode-switch" role="group" aria-label={t("工作模式")}>
        {modes.map((mode, index) => (
          <button
            key={mode.label}
            ref={index === 1 ? professionalModeButtonRef : undefined}
            type="button"
            className={index === current ? "active" : ""}
            aria-pressed={index === current}
            title={mode.title}
            onClick={() => apply(index)}
          >{mode.label}</button>
        ))}
      </div>

      <details className="ui-mode-picker" ref={pickerRef}>
        <summary
          aria-label={t("工作模式：{mode}（左右滑動切換）", { mode: modes[current].label })}
          title={modes[current].title}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { start.current = null; }}
          onClick={onSummaryClick}
        >{modes[current].label}</summary>
        <div className="ui-mode-picker__menu" role="group" aria-label={t("工作模式")}>
          {modes.map((mode, index) => (
            <button
              key={mode.label}
              type="button"
              className={index === current ? "active" : ""}
              aria-pressed={index === current}
              title={mode.title}
              onClick={() => { closePicker(); apply(index); }}
            >{mode.label}</button>
          ))}
        </div>
      </details>
    </>
  );
}
