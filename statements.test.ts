import { describe, expect, it } from "vitest";
import type { Calculation } from "../engine/types";
import type { CloudDesign } from "../src/catalog";
import type { QuarterlyRecipient, QuarterlyReport } from "../src/quarterly";
import { buildStatementPdfContent } from "../src/statementPdf";
import { buildRecipientStatement, selectedStatementDeductions, statementFilename } from "../src/statements";

const design: CloudDesign = {
  id: "design-1", name: "Monarch Butterfly", family: "", active: true, notes: "", createdAt: "2020-01-01",
  skus: [
    { id: "sku-1", sku: "MON-RED", variant: "Red", active: true, createdAt: "2020-01-01" },
    { id: "sku-2", sku: "MON-BLUE", variant: "Blue", active: true, createdAt: "2020-01-01" },
  ],
};

function calculation(id: string, sku: string, commission = "2.50", basis = "50.00", refundedQuantity = 0): Calculation {
  return {
    lineId: id, recipientId: "recipient-1", gross: "60.00", deducted: "10.00", basis,
    units: refundedQuantity ? 1 : 2, commission, currency: "USD", engineVersion: "test",
    ruleSnapshot: {
      id: "rule-1", version: 3, recipientId: "recipient-1", name: "Monarch 5%", active: true,
      startsOn: "2020-01-01", endsOn: null, priority: 1, currency: "USD", kind: "adjusted_percentage",
      rate: "5", deductions: ["discounts"], conditions: { designId: "design-1" }, refundPolicy: "net_units", notes: "",
    },
    lineSnapshot: {
      id, externalOrderId: `ORDER-${id}`, orderKey: `order-${id}`, externalLineId: id,
      productName: "Monarch Earrings", sourceSku: sku, externalProductKey: id, channel: "shopify",
      date: "2026-08-14", currency: "USD", sku, designId: "design-1", source: null, referral: null,
      market: "retail", quantity: 2, refundedQuantity, unitPrice: "30.00",
      costs: { discounts: "10.00", refunds: "30.00", shipping: "5.00", platformFees: "2.00", platformCommissions: "0.00", otherCosts: "0.00" },
      cancelled: false,
    },
  };
}

function recipient(calculations: Calculation[], commission?: string): QuarterlyRecipient {
  return {
    id: "recipient-1", name: "Ileana Chávez", commission: commission ?? calculations.reduce((sum, row) => sum + Number(row.commission), 0).toFixed(2),
    eligibleLines: calculations.length, blockedLines: 0, reviewItems: [], calculations,
  };
}

function report(person: QuarterlyRecipient, finalized = false): QuarterlyReport {
  return {
    year: 2026, quarter: 3, startsOn: "2026-07-01", endsOn: "2026-09-30", grossSales: "100.00",
    commissionTotal: person.commission, orderLines: person.calculations.length, eligibleLines: person.calculations.length,
    noRuleLines: 0, matchedNoRuleLines: 0, blockedLines: 0, unmatchedLines: 0, unmatchedProducts: 0,
    commissionRelevantUnmatchedLines: 0, salesByChannel: { shopify: "100.00", etsy: "0.00", faire: "0.00" },
    recipients: [person], amountsAvailable: true, coverageComplete: finalized, provisional: !finalized,
    provisionalThrough: finalized ? null : "2026-09-23",
    finalization: {
      year: 2026, quarter: 3, quarter_start: "2026-07-01", quarter_end: "2026-09-30",
      preliminary_sync_date: "2026-10-01", scheduled_final_sync_date: "2026-10-11",
      status: finalized ? "finalized" : "open", preliminary_completed_at: null,
      finalized_at: finalized ? "2026-10-11T12:00:00Z" : null, retry_stage: null,
      shopify_result: {}, etsy_result: {}, faire_result: {}, latest_error: null,
    },
  };
}

describe("recipient statements", () => {
  it("reconciles statement commission exactly to the quarterly recipient total", () => {
    const person = recipient([calculation("1", "MON-RED"), calculation("2", "MON-BLUE")]);
    expect(buildRecipientStatement(person, report(person), [design]).commission).toBe("5.00");
    expect(() => buildRecipientStatement({ ...person, commission: "5.01" }, report({ ...person, commission: "5.01" }), [design])).toThrow(/do not reconcile/);
  });

  it("sums commissionable revenue from calculation basis", () => {
    const person = recipient([calculation("1", "MON-RED", "2.50", "50.00"), calculation("2", "MON-BLUE", "1.25", "25.00")]);
    expect(buildRecipientStatement(person, report(person), [design]).commissionableRevenue).toBe("75.00");
  });

  it("sums commission units", () => {
    const person = recipient([calculation("1", "MON-RED"), calculation("2", "MON-BLUE", "1.50", "30.00", 1)]);
    expect(buildRecipientStatement(person, report(person), [design]).units).toBe(3);
  });

  it("aggregates multiple SKUs belonging to one design", () => {
    const person = recipient([calculation("1", "MON-RED"), calculation("2", "MON-BLUE")]);
    expect(buildRecipientStatement(person, report(person), [design]).styles).toEqual([{ id: "design-1", name: "Monarch Butterfly", units: 4, commissionableRevenue: "100.00", commission: "5.00" }]);
  });

  it("includes only deductions selected by the saved rule snapshot", () => {
    const row = calculation("1", "MON-RED");
    expect(selectedStatementDeductions(row).map(item => item.key)).toEqual(["discounts"]);
  });

  it("explains refunded quantities without changing the calculation", () => {
    const person = recipient([calculation("1", "MON-RED", "2.50", "50.00", 1)]);
    const content = buildStatementPdfContent(buildRecipientStatement(person, report(person), [design]));
    expect(content.orders[0].lines).toContain("Refunded quantity: 1");
    expect(content.orders[0].lines).toContain("Commission units: 1");
  });

  it("supports a zero-commission recipient", () => {
    const person = recipient([], "0.00");
    const model = buildRecipientStatement(person, report(person), [design]);
    expect(model).toMatchObject({ units: 0, commissionableRevenue: "0.00", commission: "0.00", styles: [], calculations: [] });
  });

  it("uses provisional status and sync coverage from the quarterly report", () => {
    const person = recipient([]);
    expect(buildRecipientStatement(person, report(person), [design])).toMatchObject({ status: "PROVISIONAL", syncedThrough: "2026-09-23" });
  });

  it("uses final status only from quarter finalization", () => {
    const person = recipient([]);
    expect(buildRecipientStatement(person, report(person, true), [design])).toMatchObject({ status: "FINAL", syncedThrough: "2026-09-30" });
  });

  it("sanitizes recipient names for PDF filenames", () => {
    const person = recipient([]);
    expect(statementFilename(buildRecipientStatement(person, report(person), [design]))).toBe("Le-Chic-Miami-Ileana-Chavez-Q3-2026-Commission-Statement.pdf");
  });

  it("includes every calculation without depending on browser details state", () => {
    const person = recipient([calculation("1", "MON-RED"), calculation("2", "MON-BLUE")]);
    const content = buildStatementPdfContent(buildRecipientStatement(person, report(person), [design]));
    expect(content.orders).toHaveLength(2);
  });

  it("does not mutate commission, order, or rule snapshots during PDF preparation", () => {
    const person = recipient([calculation("1", "MON-RED")]);
    const before = structuredClone(person);
    buildStatementPdfContent(buildRecipientStatement(person, report(person), [design]));
    expect(person).toEqual(before);
  });
});
