import type { CSSProperties } from "react";
import { t } from "../i18n";

type WarRoomAction = { priority: "P1" | "P2" | "P3" | "P4"; title: string; how: string };
type WarRoomDispute = { point: string; ruling: string };
type WarRoomMetric = { label: string; value: string; note?: string };
type WarRoomChart = { type: "line" | "bar" | "donut"; title: string; labels: string[]; values: number[]; unit?: string };
export type WarRoomResult = { verdict: string; consensus: string[]; disputes: WarRoomDispute[]; actions: WarRoomAction[]; metrics?: WarRoomMetric[]; charts?: WarRoomChart[]; structured: boolean; costUsd?: number };

const CHART_COLORS = ["#00e5ff", "#ffb000", "#00ffa3", "#ff2e88", "#a855ff", "#93a5ba"];

function WarroomChartView({ chart }: { chart: WarRoomChart }) {
  const { type, labels, values, unit } = chart;
  const fmt = (value: number) => `${Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ?? ""}`;
  if (type === "donut") {
    const total = values.reduce((sum, value) => sum + Math.abs(value), 0) || 1;
    const radius = 34, circumference = 2 * Math.PI * radius;
    let accumulated = 0;
    return <div className="warroom-chart"><h4>{chart.title}</h4><div className="warroom-chart__donut">
      <svg viewBox="0 0 100 100" width="96" height="96">{values.map((value, index) => {
        const fraction = Math.abs(value) / total;
        const dash = fraction * circumference;
        const circle = <circle key={index} cx="50" cy="50" r={radius} fill="none" stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth="13" strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-accumulated * circumference} transform="rotate(-90 50 50)" />;
        accumulated += fraction;
        return circle;
      })}</svg>
      <ul>{labels.map((label, index) => <li key={index}><i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />{label} <b>{fmt(values[index])}</b><em>{Math.round(Math.abs(values[index]) / total * 100)}%</em></li>)}</ul>
    </div></div>;
  }

  const width = 280, height = 110, padX = 8, padTop = 16, padBottom = 22;
  const max = Math.max(...values, 0), min = Math.min(...values, 0), span = max - min || 1;
  const y = (value: number) => padTop + (max - value) / span * (height - padTop - padBottom);
  const zeroY = y(0);
  if (type === "bar") {
    const barWidth = Math.min(28, (width - padX * 2) / values.length * 0.62), step = (width - padX * 2) / values.length;
    return <div className="warroom-chart"><h4>{chart.title}</h4><svg viewBox={`0 0 ${width} ${height}`} className="warroom-chart__svg">
      <line x1={padX} y1={zeroY} x2={width - padX} y2={zeroY} stroke="rgba(147,165,186,.35)" strokeWidth="1" />
      {values.map((value, index) => {
        const x = padX + step * index + (step - barWidth) / 2, top = Math.min(y(value), zeroY), barHeight = Math.max(2, Math.abs(y(value) - zeroY));
        return <g key={index}><rect x={x} y={top} width={barWidth} height={barHeight} rx="2" fill={value >= 0 ? "#00e5ff" : "#ff2e88"} opacity="0.85" /><text x={x + barWidth / 2} y={top - 3} textAnchor="middle" fontSize="7.5" fill="#cfdbea">{fmt(value)}</text><text x={x + barWidth / 2} y={height - 8} textAnchor="middle" fontSize="7.5" fill="#7d93ab">{labels[index]?.slice(0, 6)}</text></g>;
      })}
    </svg></div>;
  }

  const step = (width - padX * 2) / Math.max(1, values.length - 1);
  const points = values.map((value, index) => [padX + step * index, y(value)] as const);
  const polyline = points.map(([x, pointY]) => `${x},${pointY}`).join(" ");
  const area = `${padX},${height - padBottom} ${polyline} ${width - padX},${height - padBottom}`;
  const color = values[values.length - 1] >= values[0] ? "#00ffa3" : "#ff2e88";
  return <div className="warroom-chart"><h4>{chart.title}</h4><svg viewBox={`0 0 ${width} ${height}`} className="warroom-chart__svg">
    <polygon points={area} fill={color} opacity="0.1" /><polyline points={polyline} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    {points.map(([x, pointY], index) => <circle key={index} cx={x} cy={pointY} r="2" fill={color} />)}
    <text x={points[0][0]} y={points[0][1] - 5} fontSize="7.5" fill="#cfdbea">{fmt(values[0])}</text><text x={points[points.length - 1][0]} y={points[points.length - 1][1] - 5} textAnchor="end" fontSize="7.5" fill="#cfdbea">{fmt(values[values.length - 1])}</text><text x={padX} y={height - 8} fontSize="7.5" fill="#7d93ab">{labels[0]}</text><text x={width - padX} y={height - 8} textAnchor="end" fontSize="7.5" fill="#7d93ab">{labels[labels.length - 1]}</text>
  </svg></div>;
}

export function WarroomVerdictBody({ result }: { result: WarRoomResult }) {
  const metrics = result.metrics ?? [], charts = result.charts ?? [];
  return <>
    {metrics.length > 0 && <div className="warroom-metrics">{metrics.map((metric, index) => <div key={index} className="warroom-metric" style={{ "--i": index } as CSSProperties}><small>{metric.label}</small><strong>{metric.value}</strong>{metric.note && <em className={metric.note.trim().startsWith("-") ? "is-down" : metric.note.trim().startsWith("+") ? "is-up" : ""}>{metric.note}</em>}</div>)}</div>}
    {charts.length > 0 && <div className="warroom-charts">{charts.map((chart, index) => <WarroomChartView key={index} chart={chart} />)}</div>}
    <p className="warroom-result__verdict">{result.verdict}</p>
    {result.consensus.length > 0 && <section><h3>{t("✅ 共識")}</h3><ul>{result.consensus.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    {result.disputes.length > 0 && <section><h3>{t("⚖️ 分歧與裁決")}</h3><ul>{result.disputes.map((item, index) => <li key={index}><strong>{item.point}</strong> → {item.ruling}</li>)}</ul></section>}
    {result.actions.length > 0 && <section><h3>{t("➡️ 可執行下一步")}</h3><ol>{result.actions.map((action, index) => <li key={index}><span className={`warroom-result__prio warroom-result__prio--${action.priority}`}>{action.priority}</span> <strong>{action.title}</strong>{action.how && <small>{action.how}</small>}</li>)}</ol></section>}
    {!result.structured && <p className="warroom-result__note">{t("（NPC 未回傳結構化格式，以上為原始裁決文字）")}</p>}
  </>;
}
