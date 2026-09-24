import { describe, expect, it } from "vitest";
import type { Line, Rule } from "../engine/types";
import type { CloudDesign, CloudRecipient } from "../src/catalog";
import { buildAnalytics, percentChange, previousEqualRange, TOP_MOVERS_MIN_COMBINED_UNITS } from "../src/analytics";

const recipients: CloudRecipient[] = ["r1", "r2"].map((id, index) => ({ id, name: `Recipient ${index + 1}`, active: true, startsOn: "2020-01-01", endsOn: "", notes: "", createdAt: "2020-01-01" }));
const designs: CloudDesign[] = [{ id: "d1", name: "Dragonfly", family: "", active: true, notes: "", createdAt: "2020-01-01", skus: [] }];
const rule = (recipientId: string, rate = "1.00"): Rule => ({ id: `rule-${recipientId}`, version: 1, recipientId, name: "Commission", active: true, startsOn: "2020-01-01", endsOn: null, priority: 1, currency: "USD", kind: "fixed", rate, deductions: [], conditions: { designId: "d1" }, refundPolicy: "net_units", notes: "" });
const line = (id: string, date: string, quantity = 1, refundedQuantity = 0, cancelled = false): Line => ({ id, externalOrderId: id, orderKey: id, externalLineId: id, productName: "Dragonfly", sourceSku: "SKU-1", externalProductKey: id, channel: "shopify", date, currency: "USD", sku: "SKU-1", designId: "d1", source: null, referral: null, market: "retail", quantity, refundedQuantity, unitPrice: "10.00", costs: { discounts: "0.00", refunds: "0.00", shipping: "0.00", platformFees: "0.00", platformCommissions: "0.00", otherCosts: "0.00" }, cancelled });

describe("analytics", () => {
  it("builds an immediately preceding equal-length comparison period", () => {
    expect(previousEqualRange("2026-07-01", "2026-07-31")).toEqual({ start: "2026-05-31", end: "2026-06-30" });
  });

  it("adjusts units and sales for refunds and cancellations", () => {
    const result = buildAnalytics([line("sale", "2026-07-02", 3, 1), line("cancel", "2026-07-03", 2, 0, true)], [rule("r1")], recipients, designs, "2026-07-01", "2026-07-31", "daily");
    expect(result.current).toMatchObject({ units: 2, sales: 20, commission: 2, orders: 1 });
  });

  it("attributes one style to every recipient with an applicable saved rule", () => {
    const result = buildAnalytics([line("sale", "2026-07-02", 2)], [rule("r1"), rule("r2", "2.00")], recipients, designs, "2026-07-01", "2026-07-31", "daily");
    expect(result.recipientMix.map(row => [row.id, row.commission])).toEqual([["r2", 4], ["r1", 2]]);
    expect(result.stylesByRecipient.r1[0].name).toBe("Dragonfly");
    expect(result.stylesByRecipient.r2[0].name).toBe("Dragonfly");
  });

  it("marks a qualifying style as New and enforces the minimum volume", () => {
    const result = buildAnalytics([line("sale", "2026-07-02", TOP_MOVERS_MIN_COMBINED_UNITS)], [rule("r1")], recipients, designs, "2026-07-01", "2026-07-31", "daily");
    expect(result.growth[0]).toMatchObject({ name: "Dragonfly", isNew: true });
    const low = buildAnalytics([line("sale", "2026-07-02", TOP_MOVERS_MIN_COMBINED_UNITS - 1)], [rule("r1")], recipients, designs, "2026-07-01", "2026-07-31", "daily");
    expect(low.growth).toEqual([]);
  });

  it("aggregates multiple SKUs under one design in monthly style trends", () => {
    const first = line("one", "2026-07-02", 2);
    const second = { ...line("two", "2026-07-20", 3), sku: "SKU-2", sourceSku: "SKU-2" };
    const result = buildAnalytics([first, second], [rule("r1")], recipients, designs, "2026-07-01", "2026-07-31", "monthly");
    expect(result.styleTrend).toEqual([{ bucket: "2026-07", units: { d1: 5 }, sales: { d1: 50 }, commission: { d1: 5 } }]);
  });

  it("handles a zero previous period without dividing by zero", () => {
    expect(percentChange(25, 0)).toBe("New");
    expect(percentChange(0, 0)).toBe("No prior data");
  });
});
