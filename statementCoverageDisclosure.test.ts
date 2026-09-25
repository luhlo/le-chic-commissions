import { describe, expect, it } from "vitest";
import {
  statementCoverageHasProblem,
  statementCoverageSummary,
} from "../src/App";
import type { QuarterlyReport } from "../src/quarterly";

function report(overrides: Partial<QuarterlyReport> = {}): QuarterlyReport {
  return {
    year: 2026,
    quarter: 3,
    startsOn: "2026-07-01",
    endsOn: "2026-09-30",
    grossSales: "0.00",
    commissionTotal: "0.00",
    orderLines: 0,
    eligibleLines: 0,
    noRuleLines: 0,
    matchedNoRuleLines: 0,
    blockedLines: 0,
    unmatchedLines: 0,
    unmatchedProducts: 0,
    commissionRelevantUnmatchedLines: 0,
    salesByChannel: { shopify: "0.00", etsy: "0.00", faire: "0.00" },
    recipients: [],
    coverageComplete: false,
    amountsAvailable: true,
    provisional: true,
    provisionalThrough: "2026-09-23",
    coverage: ["shopify", "etsy", "faire"].map((channel) => ({
      channel,
      earliest: "2026-07-01",
      latest: "2026-09-23",
      order_count: 1,
      last_success: "2026-09-24T12:00:00Z",
      sync_status: "completed",
      complete: false,
      failed_orders: 0,
      backfill_status: "completed",
      coverage_through: "2026-09-23",
    })),
    ...overrides,
  };
}

describe("Statements coverage disclosure", () => {
  it("treats a verified open quarter as healthy and summarizes its sync date", () => {
    const healthy = report();
    expect(statementCoverageHasProblem(healthy, "")).toBe(false);
    expect(statementCoverageSummary(healthy, "")).toBe(
      "All channels synced through Sep 23, 2026",
    );
  });

  it("opens for missing coverage, failed orders, or a scheduled retry", () => {
    const healthy = report();
    expect(
      statementCoverageHasProblem(
        report({ coverage: healthy.coverage?.slice(0, 2) }),
        "",
      ),
    ).toBe(true);
    expect(
      statementCoverageHasProblem(
        report({
          coverage: healthy.coverage?.map((row, index) =>
            index === 0 ? { ...row, failed_orders: 1 } : row,
          ),
        }),
        "",
      ),
    ).toBe(true);
    expect(
      statementCoverageSummary(report(), "Cannot verify data coverage"),
    ).toBe("Sync issue · review coverage details");
  });
});
