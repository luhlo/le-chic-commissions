import Decimal from "decimal.js";
import type { Calculation, CostKey } from "../engine/types";
import type { CloudDesign } from "./catalog";
import type { QuarterlyRecipient, QuarterlyReport } from "./quarterly";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface StatementStyleRow {
  id: string;
  name: string;
  units: number;
  commissionableRevenue: string;
  commission: string;
}

export interface RecipientStatementModel {
  recipientId: string;
  recipientName: string;
  year: number;
  quarter: number;
  startsOn: string;
  endsOn: string;
  status: "PROVISIONAL" | "FINAL";
  syncedThrough: string | null;
  units: number;
  commissionableRevenue: string;
  commission: string;
  styles: StatementStyleRow[];
  calculations: Calculation[];
  payment?: RecipientStatementPayment;
}

export interface RecipientStatementPayment {
  status: "Not approved" | "Approved" | "Partially paid" | "Paid";
  paid: string;
  remaining: string;
  paidDate: string | null;
  method: string | null;
  reference: string | null;
}

export const statementCostLabels: Record<CostKey, string> = {
  discounts: "Discounts",
  refunds: "Refunds",
  shipping: "Shipping paid",
  platformFees: "Platform fees",
  platformCommissions: "Platform commissions",
  otherCosts: "Other costs",
};

export function selectedStatementDeductions(calculation: Calculation) {
  return calculation.ruleSnapshot.deductions.map((key) => ({
    key,
    label: statementCostLabels[key],
    value: calculation.lineSnapshot.costs[key],
  }));
}

function fallbackStyle(calculation: Calculation) {
  const line = calculation.lineSnapshot;
  const identity = line.sku ?? line.productName ?? line.id;
  return {
    id: `unmapped:${identity}`,
    name: `Unmapped style · ${line.sku ?? line.productName ?? "Unknown item"}`,
  };
}

export function buildRecipientStatement(
  recipient: QuarterlyRecipient,
  report: QuarterlyReport,
  designs: CloudDesign[],
): RecipientStatementModel {
  const designNames = new Map(designs.map((design) => [design.id, design.name]));
  const styleTotals = new Map<string, { name: string; units: number; basis: Decimal; commission: Decimal }>();
  let units = 0;
  let basis = new D(0);
  let commission = new D(0);

  for (const calculation of recipient.calculations) {
    units += calculation.units;
    basis = basis.plus(calculation.basis);
    commission = commission.plus(calculation.commission);
    const designId = calculation.lineSnapshot.designId;
    const style = designId && designNames.has(designId)
      ? { id: designId, name: designNames.get(designId)! }
      : fallbackStyle(calculation);
    const row = styleTotals.get(style.id) ?? {
      name: style.name,
      units: 0,
      basis: new D(0),
      commission: new D(0),
    };
    row.units += calculation.units;
    row.basis = row.basis.plus(calculation.basis);
    row.commission = row.commission.plus(calculation.commission);
    styleTotals.set(style.id, row);
  }

  const expected = new D(recipient.commission).toFixed(2);
  const calculationTotal = commission.toFixed(2);
  if (calculationTotal !== expected)
    throw new Error("Statement totals do not reconcile with the quarterly report. Review the quarter before exporting.");

  const styles = [...styleTotals.entries()]
    .map(([id, row]) => ({
      id,
      name: row.name,
      units: row.units,
      commissionableRevenue: row.basis.toFixed(2),
      commission: row.commission.toFixed(2),
    }))
    .sort((a, b) => new D(b.commission).cmp(a.commission) || a.name.localeCompare(b.name));
  const styleCommission = styles.reduce((sum, row) => sum.plus(row.commission), new D(0)).toFixed(2);
  if (styleCommission !== expected)
    throw new Error("Statement totals do not reconcile with the quarterly report. Review the quarter before exporting.");

  return {
    recipientId: recipient.id,
    recipientName: recipient.name,
    year: report.year,
    quarter: report.quarter,
    startsOn: report.startsOn,
    endsOn: report.endsOn,
    status: report.finalization?.status === "finalized" ? "FINAL" : "PROVISIONAL",
    syncedThrough: report.finalization?.status === "finalized" ? report.endsOn : report.provisionalThrough ?? null,
    units,
    commissionableRevenue: basis.toFixed(2),
    commission: expected,
    styles,
    calculations: [...recipient.calculations],
  };
}

export function statementFilename(model: RecipientStatementModel) {
  const recipient = model.recipientName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "Recipient";
  return `Le-Chic-Miami-${recipient}-Q${model.quarter}-${model.year}-Commission-Statement.pdf`;
}

export function statementDate(value: string, full = false) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: full ? "long" : "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}
