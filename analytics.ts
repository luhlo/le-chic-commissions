import Decimal from "decimal.js";
import { allocateManualOrderCosts, calculate, manualAllocationKey, selectCommissionReviewRules } from "../engine/calculate";
import type { Line, Rule } from "../engine/types";
import type { CloudDesign, CloudRecipient } from "./catalog";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type AnalyticsMetric = "units" | "sales" | "commission";
export type AnalyticsGrouping = "daily" | "weekly" | "monthly";
export const TOP_MOVERS_MIN_COMBINED_UNITS = 3;

export interface PeriodTotals { units: number; sales: number; commission: number; orders: number }
export interface AnalyticsPoint { bucket: string; units: Record<string, number>; sales: Record<string, number>; commission: Record<string, number> }
export interface BreakdownRow { id: string; name: string; units: number; sales: number; commission: number }
export interface Mover extends BreakdownRow { previous: number; current: number; change: number | null; isNew: boolean }
export interface AnalyticsResult {
  current: PeriodTotals; previous: PeriodTotals;
  recipientTrend: AnalyticsPoint[]; styleTrend: AnalyticsPoint[];
  recipientMix: BreakdownRow[]; stylesByRecipient: Record<string, BreakdownRow[]>;
  growth: Mover[]; decline: Mover[];
  blockedLines: number;
}

export function previousEqualRange(start: string, end: string) {
  const day = 86400000;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days = Math.floor((endMs - startMs) / day) + 1;
  const previousEnd = new Date(startMs - day);
  const previousStart = new Date(startMs - days * day);
  return { start: previousStart.toISOString().slice(0, 10), end: previousEnd.toISOString().slice(0, 10) };
}

function bucketFor(date: string, grouping: AnalyticsGrouping) {
  if (grouping === "daily") return date;
  const value = new Date(`${date}T00:00:00Z`);
  if (grouping === "monthly") return date.slice(0, 7);
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset);
  return value.toISOString().slice(0, 10);
}

const zero = (): BreakdownRow => ({ id: "", name: "", units: 0, sales: 0, commission: 0 });
const netUnits = (line: Line) => line.cancelled ? 0 : Math.max(0, line.quantity - line.refundedQuantity);
const netSales = (line: Line) => new D(line.unitPrice).mul(netUnits(line));

export function buildAnalytics(
  lines: Line[], rules: Rule[], recipients: CloudRecipient[], designs: CloudDesign[],
  currentStart: string, currentEnd: string, grouping: AnalyticsGrouping,
  moverMetric: "units" | "sales" = "units", moverRecipientId = "all",
): AnalyticsResult {
  const previous = previousEqualRange(currentStart, currentEnd);
  const inCurrent = (line: Line) => line.date >= currentStart && line.date <= currentEnd;
  const inPrevious = (line: Line) => line.date >= previous.start && line.date <= previous.end;
  const relevant = lines.filter(line => inCurrent(line) || inPrevious(line));
  const allocations = allocateManualOrderCosts(relevant, rules);
  const recipientNames = new Map(recipients.map(r => [r.id, r.name]));
  const designNames = new Map(designs.map(d => [d.id, d.name]));
  const currentTotals: PeriodTotals = { units: 0, sales: 0, commission: 0, orders: 0 };
  const previousTotals: PeriodTotals = { units: 0, sales: 0, commission: 0, orders: 0 };
  const currentOrders = new Set<string>();
  const previousOrders = new Set<string>();
  const recipientMix = new Map<string, BreakdownRow>();
  const stylesByRecipient = new Map<string, Map<string, BreakdownRow>>();
  const recipientStyleIds = new Map<string, Set<string>>();
  const currentStyles = new Map<string, BreakdownRow>();
  const previousStyles = new Map<string, BreakdownRow>();
  const recipientTrend = new Map<string, Map<AnalyticsMetric, Map<string, number>>>();
  const styleTrend = new Map<string, Map<AnalyticsMetric, Map<string, number>>>();
  let blockedLines = 0;

  for (const line of relevant) {
    const current = inCurrent(line);
    const totals = current ? currentTotals : previousTotals;
    const units = netUnits(line);
    const sales = netSales(line);
    totals.units += units;
    totals.sales = new D(totals.sales).plus(sales).toNumber();
    if (units > 0) (current ? currentOrders : previousOrders).add(line.orderKey ?? `${line.channel}:${line.externalOrderId}`);
    let selected: Rule[] = [];
    try { selected = selectCommissionReviewRules(line, rules); }
    catch { blockedLines += current ? 1 : 0; continue; }
    const designId = line.designId;
    const bucket = bucketFor(line.date, grouping);
    if (selected.length && designId && line.sku) {
      const periodStyles = current ? currentStyles : previousStyles;
      const style = periodStyles.get(designId) ?? { ...zero(), id: designId, name: designNames.get(designId) ?? line.productName ?? line.sku };
      style.units += units; style.sales = new D(style.sales).plus(sales).toNumber();
      periodStyles.set(designId, style);
      if (current) {
        const trend = styleTrend.get(bucket) ?? new Map<AnalyticsMetric, Map<string, number>>();
        for (const [metric, value] of [["units", units], ["sales", sales.toNumber()]] as const) {
          const values = trend.get(metric) ?? new Map<string, number>();
          values.set(designId, new D(values.get(designId) ?? 0).plus(value).toNumber()); trend.set(metric, values);
        }
        styleTrend.set(bucket, trend);
      }
    }
    for (const rule of selected) {
      if (!line.sku) continue;
      try {
        const calc = calculate(line, rule, allocations.get(manualAllocationKey(line, rule)));
        const commission = Number(calc.commission);
        totals.commission = new D(totals.commission).plus(commission).toNumber();
        const recipientId = rule.recipientId;
        if (current) {
          const mix = recipientMix.get(recipientId) ?? { ...zero(), id: recipientId, name: recipientNames.get(recipientId) ?? "Unknown recipient" };
          mix.units += units; mix.sales = new D(mix.sales).plus(sales).toNumber(); mix.commission = new D(mix.commission).plus(commission).toNumber();
          recipientMix.set(recipientId, mix);
        }
        if (current) {
          const trend = recipientTrend.get(bucket) ?? new Map<AnalyticsMetric, Map<string, number>>();
          for (const [metric, value] of [["units", units], ["sales", sales.toNumber()], ["commission", commission]] as const) {
            const values = trend.get(metric) ?? new Map<string, number>();
            values.set(recipientId, new D(values.get(recipientId) ?? 0).plus(value).toNumber()); trend.set(metric, values);
          }
          recipientTrend.set(bucket, trend);
        }
        if (designId) {
          const periodStyles = current ? currentStyles : previousStyles;
          const style = periodStyles.get(designId) ?? { ...zero(), id: designId, name: designNames.get(designId) ?? line.productName ?? line.sku };
          style.commission = new D(style.commission).plus(commission).toNumber();
          periodStyles.set(designId, style);
          const owned = recipientStyleIds.get(recipientId) ?? new Set<string>(); owned.add(designId); recipientStyleIds.set(recipientId, owned);
          if (current) {
            const byStyle = stylesByRecipient.get(recipientId) ?? new Map<string, BreakdownRow>();
            const recipientStyle = byStyle.get(designId) ?? { ...zero(), id: designId, name: style.name };
            recipientStyle.units += units; recipientStyle.sales = new D(recipientStyle.sales).plus(sales).toNumber(); recipientStyle.commission = new D(recipientStyle.commission).plus(commission).toNumber();
            byStyle.set(designId, recipientStyle); stylesByRecipient.set(recipientId, byStyle);
          }
          if (current) {
            const trend = styleTrend.get(bucket) ?? new Map<AnalyticsMetric, Map<string, number>>();
            const values = trend.get("commission") ?? new Map<string, number>();
            values.set(designId, new D(values.get(designId) ?? 0).plus(commission).toNumber()); trend.set("commission", values);
            styleTrend.set(bucket, trend);
          }
        }
      } catch { blockedLines += current ? 1 : 0; }
    }
  }
  currentTotals.orders = currentOrders.size; previousTotals.orders = previousOrders.size;
  const pointRows = (source: Map<string, Map<AnalyticsMetric, Map<string, number>>>): AnalyticsPoint[] => [...source.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, values]) => ({
    bucket,
    units: Object.fromEntries(values.get("units") ?? []),
    sales: Object.fromEntries(values.get("sales") ?? []),
    commission: Object.fromEntries(values.get("commission") ?? []),
  }));
  const allStyleIds = new Set([...currentStyles.keys(), ...previousStyles.keys()]);
  const movers = [...allStyleIds].flatMap(id => {
    const cur = currentStyles.get(id) ?? { ...zero(), id, name: previousStyles.get(id)?.name ?? "Unknown style" };
    const prev = previousStyles.get(id) ?? { ...zero(), id, name: cur.name };
    if (moverRecipientId !== "all") {
      const allowed = recipientStyleIds.get(moverRecipientId)?.has(id);
      if (!allowed) return [];
    }
    if (cur.units + prev.units < TOP_MOVERS_MIN_COMBINED_UNITS) return [];
    const currentValue = cur[moverMetric]; const previousValue = prev[moverMetric];
    return [{ ...cur, previous: previousValue, current: currentValue, change: previousValue === 0 ? null : ((currentValue - previousValue) / previousValue) * 100, isNew: previousValue === 0 && currentValue > 0 }];
  });
  return {
    current: currentTotals, previous: previousTotals,
    recipientTrend: pointRows(recipientTrend), styleTrend: pointRows(styleTrend),
    recipientMix: [...recipientMix.values()].sort((a, b) => b.commission - a.commission),
    stylesByRecipient: Object.fromEntries([...stylesByRecipient].map(([id, rows]) => [id, [...rows.values()].sort((a, b) => b.commission - a.commission)])),
    growth: movers.filter(m => m.current > m.previous).sort((a, b) => (b.change ?? Infinity) - (a.change ?? Infinity)).slice(0, 5),
    decline: movers.filter(m => m.current < m.previous).sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).slice(0, 5),
    blockedLines,
  };
}

export function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? "New" : "No prior data";
  const value = ((current - previous) / previous) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
