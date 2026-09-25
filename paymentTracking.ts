import Decimal from "decimal.js";
import type { QuarterlyRecipient, QuarterlyReport } from "./quarterly";
import type { RecipientStatementModel } from "./statements";
import { supabase } from "./supabase";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const cents = (value: Decimal.Value) => new D(value).toDecimalPlaces(2).toFixed(2);

export const paymentMethods = ["Zelle", "ACH", "PayPal", "Check", "Cash", "Other"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export interface StatementPayout {
  id: string;
  statementId: string;
  amount: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string;
  note: string;
  createdAt: string;
}

export interface ApprovedStatement {
  id: string;
  recipientId: string;
  recipientName: string;
  year: number;
  quarter: number;
  startsOn: string;
  endsOn: string;
  approvedTotal: string;
  approvedAt: string;
  approvedBy: string;
  snapshot: { model: RecipientStatementModel; review: { recipientBlockedLines: number; amountsAvailable: boolean } };
  payouts: StatementPayout[];
}

export type RecipientPaymentStatus = "NOT READY" | "FINALIZED" | "APPROVED" | "PARTIALLY PAID" | "PAID";

export interface PaymentState {
  status: RecipientPaymentStatus;
  paid: string;
  remaining: string;
  lastPayment: StatementPayout | null;
}

export function paidTotal(statement: Pick<ApprovedStatement, "payouts">) {
  return statement.payouts.reduce((sum, payout) => sum.plus(payout.amount), new D(0)).toFixed(2);
}

export function paymentState(statement: ApprovedStatement | null, quarterFinalized: boolean): PaymentState {
  if (!statement)
    return { status: quarterFinalized ? "FINALIZED" : "NOT READY", paid: "0.00", remaining: "0.00", lastPayment: null };
  const paid = new D(paidTotal(statement));
  const remaining = D.max(new D(statement.approvedTotal).minus(paid), 0);
  const lastPayment = [...statement.payouts].sort((a, b) => b.paidOn.localeCompare(a.paidOn) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const status = remaining.eq(0) ? "PAID" : paid.gt(0) ? "PARTIALLY PAID" : "APPROVED";
  return { status, paid: paid.toFixed(2), remaining: remaining.toFixed(2), lastPayment };
}

export function validatePayment(statement: ApprovedStatement | null, amount: Decimal.Value) {
  if (!statement) throw new Error("Approve the statement before recording payment.");
  const payment = new D(amount);
  if (!payment.isFinite() || payment.lte(0)) throw new Error("Payment amount must be greater than zero.");
  const remaining = new D(statement.approvedTotal).minus(paidTotal(statement));
  if (payment.gt(remaining)) throw new Error("Payment exceeds the remaining approved amount.");
  return payment.toFixed(2);
}

export function approvalEligibility(report: QuarterlyReport, recipient: QuarterlyRecipient, model: RecipientStatementModel) {
  if (report.finalization?.status !== "finalized") return { allowed: false, reason: "The quarter must be finalized before approval." };
  if (!report.amountsAvailable) return { allowed: false, reason: "Verified commission amounts are not available." };
  if (recipient.blockedLines > 0) return { allowed: false, reason: "Resolve this recipient's blocking commission issues first." };
  if (model.status !== "FINAL") return { allowed: false, reason: "Only a final statement can be approved." };
  return { allowed: true, reason: "" };
}

export function discrepancy(statement: ApprovedStatement | null, currentAmount: Decimal.Value) {
  if (!statement) return null;
  const difference = new D(currentAmount).minus(statement.approvedTotal).toFixed(2);
  return difference === "0.00" ? null : {
    approved: cents(statement.approvedTotal),
    current: cents(currentAmount),
    difference,
  };
}

export function canRevokeApproval(statement: ApprovedStatement) {
  return statement.payouts.length === 0;
}

export function paymentSummary(statements: ApprovedStatement[], recipientCount: number) {
  let paidRecipients = 0;
  let partialRecipients = 0;
  let totalApproved = new D(0);
  let paid = new D(0);
  for (const statement of statements) {
    const state = paymentState(statement, true);
    totalApproved = totalApproved.plus(statement.approvedTotal);
    paid = paid.plus(state.paid);
    if (state.status === "PAID") paidRecipients += 1;
    else if (state.status === "PARTIALLY PAID") partialRecipients += 1;
  }
  return {
    recipientCount,
    paidRecipients,
    partialRecipients,
    awaitingRecipients: Math.max(recipientCount - paidRecipients - partialRecipients, 0),
    totalApproved: totalApproved.toFixed(2),
    paid: paid.toFixed(2),
    remaining: D.max(totalApproved.minus(paid), 0).toFixed(2),
  };
}

export function statementModelWithPayment(liveModel: RecipientStatementModel, statement: ApprovedStatement | null) {
  if (!statement) return { ...liveModel, payment: { status: "Not approved" as const, paid: "0.00", remaining: liveModel.commission, paidDate: null, method: null, reference: null } };
  const state = paymentState(statement, true);
  const model = structuredClone(statement.snapshot.model);
  return {
    ...model,
    payment: {
      status: state.status === "PAID" ? "Paid" as const : state.status === "PARTIALLY PAID" ? "Partially paid" as const : "Approved" as const,
      paid: state.paid,
      remaining: state.remaining,
      paidDate: state.status === "PAID" ? state.lastPayment?.paidOn ?? null : null,
      method: state.lastPayment?.method ?? null,
      reference: state.lastPayment?.reference || null,
    },
  };
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function loadApprovedStatements(year: number, quarter: number): Promise<ApprovedStatement[]> {
  const { data, error } = await client()
    .from("statements")
    .select("id,recipient_id,recipient_snapshot,calculation_snapshot,total,year,quarter,starts_on,ends_on,approved_at,approved_by,payouts(id,statement_id,amount,paid_on,method,reference,notes,created_at)")
    .eq("year", year)
    .eq("quarter", quarter)
    .order("approved_at", { ascending: false });
  if (error) throw new Error(`Cannot load approved statements: ${error.message}`);
  const ids = (data ?? []).map((row) => row.id);
  const revoked = new Set<string>();
  if (ids.length) {
    const { data: events, error: eventError } = await client()
      .from("audit_events")
      .select("entity_id")
      .eq("entity_table", "statements")
      .eq("action", "statement_approval_revoked")
      .in("entity_id", ids);
    if (eventError) throw new Error(`Cannot load statement history: ${eventError.message}`);
    for (const event of events ?? []) if (event.entity_id) revoked.add(event.entity_id);
  }
  const seen = new Set<string>();
  const results: ApprovedStatement[] = [];
  for (const row of data ?? []) {
    if (revoked.has(row.id) || seen.has(row.recipient_id)) continue;
    seen.add(row.recipient_id);
    const recipientSnapshot = row.recipient_snapshot as { name?: string };
    results.push({
      id: row.id,
      recipientId: row.recipient_id,
      recipientName: recipientSnapshot.name ?? "Recipient",
      year: row.year,
      quarter: row.quarter,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      approvedTotal: cents(row.total),
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      snapshot: row.calculation_snapshot as ApprovedStatement["snapshot"],
      payouts: (row.payouts ?? []).map((payout: Record<string, unknown>) => ({
        id: String(payout.id), statementId: String(payout.statement_id), amount: cents(String(payout.amount)),
        paidOn: String(payout.paid_on), method: String(payout.method) as PaymentMethod,
        reference: String(payout.reference ?? ""), note: String(payout.notes ?? ""), createdAt: String(payout.created_at),
      })),
    });
  }
  return results;
}

export async function approveRecipientStatement(recipient: QuarterlyRecipient, report: QuarterlyReport, model: RecipientStatementModel) {
  const eligibility = approvalEligibility(report, recipient, model);
  if (!eligibility.allowed) throw new Error(eligibility.reason);
  const { data, error } = await client().rpc("approve_recipient_statement", {
    p_recipient_id: recipient.id,
    p_year: report.year,
    p_quarter: report.quarter,
    p_recipient_snapshot: { id: recipient.id, name: recipient.name },
    p_calculation_snapshot: { model, review: { recipientBlockedLines: recipient.blockedLines, amountsAvailable: report.amountsAvailable === true } },
    p_commission_total: model.commission,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function recordStatementPayout(statementId: string, values: { amount: string; paidOn: string; method: PaymentMethod; reference: string; note: string }) {
  const { data, error } = await client().rpc("record_statement_payout", {
    p_statement_id: statementId,
    p_amount: values.amount,
    p_paid_on: values.paidOn,
    p_method: values.method,
    p_reference: values.reference,
    p_note: values.note,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeStatementApproval(statementId: string) {
  const { error } = await client().rpc("revoke_statement_approval", { p_statement_id: statementId });
  if (error) throw new Error(error.message);
}
