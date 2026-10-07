import { t } from "../i18n";

/* 載入骨架：資料還沒回來時，先用低對比的灰塊排出內容的大致形狀，取代
   「讀取中…」一行字或轉圈。形狀照面板實際版面挑一種：

   - lines：段落／一般內容
   - list：一列一筆（記憶、排程、指令清單）
   - bars：標籤＋長條（成本圖）
   - tiles：一排數字格＋下方幾行（日報、診斷）
   - columns：看板四欄

   無障礙：外層 role=status＋aria-busy，螢幕報讀器唸出視覺隱藏的「讀取中…」；
   灰塊本身 aria-hidden。微光掃過的動畫在 prefers-reduced-motion 時停掉
   （styles/r2-modals.css）。 */

export type SkeletonVariant = "lines" | "list" | "bars" | "tiles" | "columns";

type Props = {
  variant?: SkeletonVariant;
  /** 列數（columns 為每欄卡數）。 */
  rows?: number;
  /** 給螢幕報讀器的文字，預設「讀取中…」。 */
  label?: string;
  className?: string;
};

// 固定的寬度序列：每次長得一樣（不閃），又不會整齊得像表格。
const WIDTHS = [92, 76, 84, 61, 88, 70, 80, 66];
const width = (index: number) => `${WIDTHS[index % WIDTHS.length]}%`;

function Line({ w, className = "" }: { w: string; className?: string }) {
  return <span className={`r2-skeleton__line ${className}`.trim()} style={{ width: w }} />;
}

export function Skeleton({ variant = "lines", rows, label, className = "" }: Props) {
  const count = rows ?? (variant === "columns" ? 3 : variant === "tiles" ? 3 : 4);
  const items = Array.from({ length: count }, (_, index) => index);
  let body;
  if (variant === "list") {
    body = items.map((index) => (
      <span key={index} className="r2-skeleton__item">
        <Line w={width(index)} />
        <Line w={width(index + 3)} className="r2-skeleton__line--sub" />
      </span>
    ));
  } else if (variant === "bars") {
    body = items.map((index) => (
      <span key={index} className="r2-skeleton__bar-row">
        <Line w="100%" className="r2-skeleton__line--label" />
        <Line w={width(index + 1)} className="r2-skeleton__line--bar" />
      </span>
    ));
  } else if (variant === "tiles") {
    body = <>
      <span className="r2-skeleton__tiles">
        {[0, 1, 2, 3].map((index) => <span key={index} className="r2-skeleton__tile"><Line w="46%" className="r2-skeleton__line--sub" /><Line w="64%" className="r2-skeleton__line--big" /></span>)}
      </span>
      {items.map((index) => <Line key={index} w={width(index)} />)}
    </>;
  } else if (variant === "columns") {
    body = <span className="r2-skeleton__columns">
      {[0, 1, 2, 3].map((column) => (
        <span key={column} className="r2-skeleton__column">
          <Line w="48%" className="r2-skeleton__line--head" />
          {items.slice(0, Math.max(1, count - (column % 2))).map((index) => (
            <span key={index} className="r2-skeleton__card">
              <Line w={width(index + column)} />
              <Line w={width(index + column + 4)} className="r2-skeleton__line--sub" />
            </span>
          ))}
        </span>
      ))}
    </span>;
  } else {
    body = items.map((index) => <Line key={index} w={width(index)} />);
  }
  return (
    <div className={`r2-skeleton r2-skeleton--${variant} ${className}`.trim()} role="status" aria-live="polite" aria-busy="true">
      <span className="r2-sr-only">{label ?? t("讀取中…")}</span>
      <span className="r2-skeleton__body" aria-hidden="true">{body}</span>
    </div>
  );
}
