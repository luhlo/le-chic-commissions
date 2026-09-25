import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QuarterlyRecipient, QuarterlyReport } from "../src/quarterly";
import type { RecipientStatementModel } from "../src/statements";
import { buildStatementPdfContent } from "../src/statementPdf";
import {
  approvalEligibility,
  canRevokeApproval,
  discrepancy,
  paidTotal,
  paymentState,
  paymentSummary,
  statementModelWithPayment,
  validatePayment,
  type ApprovedStatement,
} from "../src/paymentTracking";

const model: RecipientStatementModel = {
  recipientId: "recipient-1", recipientName: "Ileana Chavez", year: 2026, quarter: 2,
  startsOn: "2026-04-01", endsOn: "2026-06-30", status: "FINAL", syncedThrough: "2026-06-30",
  units: 2, commissionableRevenue: "200.00", commission: "10.00", styles: [
    { id: "design-1", name: "Style", units: 2, commissionableRevenue: "200.00", commission: "10.00" },
  ], calculations: [],
};

const recipient: QuarterlyRecipient = {
  id: "recipient-1", name: "Ileana Chavez", commission: "10.00", eligibleLines: 1,
  blockedLines: 0, reviewItems: [], calculations: [],
};

const report: QuarterlyReport = {
  year: 2026, quarter: 2, startsOn: "2026-04-01", endsOn: "2026-06-30", grossSales: "200.00",
  commissionTotal: "10.00", orderLines: 1, eligibleLines: 1, noRuleLines: 0, matchedNoRuleLines: 0,
  blockedLines: 0, unmatchedLines: 0, unmatchedProducts: 0, commissionRelevantUnmatchedLines: 0,
  salesByChannel: { shopify: "200.00", etsy: "0.00", faire: "0.00" }, recipients: [recipient],
  amountsAvailable: true, coverageComplete: true, provisional: false,
  finalization: {
    id: "final-1", year: 2026, quarter: 2, quarter_start: "2026-04-01", quarter_end: "2026-06-30",
    preliminary_sync_date: "2026-07-01", scheduled_final_sync_date: "2026-07-11", status: "finalized",
    preliminary_completed_at: "2026-07-01T12:00:00Z", finalized_at: "2026-07-11T12:00:00Z", retry_stage: null,
    shopify_result: {}, etsy_result: {}, faire_result: {}, latest_error: null,
  },
};

function statement(payments: Array<{ amount: string; paidOn?: string }> = []): ApprovedStatement {
  return {
    id: "statement-1", recipientId: recipient.id, recipientName: recipient.name, year: 2026, quarter: 2,
    startsOn: report.startsOn, endsOn: report.endsOn, approvedTotal: "10.00",
    approvedAt: "2026-07-11T13:00:00Z", approvedBy: "admin-1",
    snapshot: { model: structuredClone(model), review: { recipientBlockedLines: 0, amountsAvailable: true } },
    payouts: payments.map((payment, index) => ({
      id: `payment-${index}`, statementId: "statement-1", amount: payment.amount,
      paidOn: payment.paidOn ?? `2026-07-${12 + index}`, method: "Zelle", reference: "", note: "",
      createdAt: `2026-07-${12 + index}T12:00:00Z`,
    })),
  };
}

describe("recipient statement approval and payment tracking", () => {
  it("cannot approve before quarter finalization", () => {
    expect(approvalEligibility({ ...report, finalization: { ...report.finalization!, status: "open" } }, recipient, { ...model, status: "PROVISIONAL" }).allowed).toBe(false);
  });

  it("can approve a finalized reconciled statement", () => {
    expect(approvalEligibility(report, recipient, model)).toEqual({ allowed: true, reason: "" });
  });

  it("approved statement stores the correct amount", () => {
    expect(statement().approvedTotal).toBe(model.commission);
  });

  it("approved snapshot does not change when live calculations later change", () => {
    const approved = statement();
    const changed = { ...model, commission: "7.00" };
    expect(approved.snapshot.model.commission).toBe("10.00");
    expect(changed.commission).toBe("7.00");
  });

  it("detects a late live-data discrepancy", () => {
    expect(discrepancy(statement(), "7.00")).toEqual({ approved: "10.00", current: "7.00", difference: "-3.00" });
  });

  it("does not report a discrepancy when totals match", () => {
    expect(discrepancy(statement(), "10.00")).toBeNull();
  });

  it("cannot mark an unapproved statement as paid", () => {
    expect(() => validatePayment(null, "5.00")).toThrow(/Approve the statement/);
  });

  it("full payment marks the statement paid", () => {
    expect(paymentState(statement([{ amount: "10.00" }]), true)).toMatchObject({ status: "PAID", paid: "10.00", remaining: "0.00" });
  });

  it("partial payment leaves the statement partially paid", () => {
    expect(paymentState(statement([{ amount: "4.00" }]), true)).toMatchObject({ status: "PARTIALLY PAID", paid: "4.00", remaining: "6.00" });
  });

  it("a second payment can complete the remaining balance", () => {
    expect(paymentState(statement([{ amount: "4.00" }, { amount: "6.00" }]), true).status).toBe("PAID");
  });

  it("blocks overpayment", () => {
    expect(() => validatePayment(statement([{ amount: "8.00" }]), "2.01")).toThrow(/exceeds/);
  });

  it("payment history totals exactly with decimal-safe math", () => {
    expect(paidTotal(statement([{ amount: "0.10" }, { amount: "0.20" }]))).toBe("0.30");
  });

  it("PDF payment status matches the stored payment state", () => {
    const exportModel = statementModelWithPayment(model, statement([{ amount: "4.00" }]));
    expect(buildStatementPdfContent(exportModel).payment).toEqual([
      "Payment status: Partially paid", "Paid: $4.00", "Remaining: $6.00", "Method: Zelle",
    ]);
  });

  it("approval revocation is available only before any payout", () => {
    expect(canRevokeApproval(statement())).toBe(true);
    expect(canRevokeApproval(statement([{ amount: "1.00" }]))).toBe(false);
  });

  it("database migration records approval, revocation, and payout audit events", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20260925222511_recipient_statement_payments.sql", import.meta.url), "utf8");
    expect(sql).toContain("statement_approved");
    expect(sql).toContain("statement_approval_revoked");
    expect(sql).toContain("payout_recorded");
  });

  it("summarizes paid, partial, awaiting, approved, and remaining amounts", () => {
    const summary = paymentSummary([statement([{ amount: "10.00" }]), { ...statement([{ amount: "4.00" }]), id: "statement-2", recipientId: "recipient-2" }], 3);
    expect(summary).toEqual({ recipientCount: 3, paidRecipients: 1, partialRecipients: 1, awaitingRecipients: 1, totalApproved: "20.00", paid: "14.00", remaining: "6.00" });
  });

  it("does not mutate existing commission calculations", () => {
    const live = structuredClone(model);
    const before = structuredClone(live);
    statementModelWithPayment(live, statement([{ amount: "4.00" }]));
    expect(live).toEqual(before);
  });
});

