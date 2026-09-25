import Decimal from "decimal.js";
import { calculate, selectCommissionReviewRules, allocateManualOrderCosts, manualAllocationKey } from "../engine/calculate";
import type { Calculation, Line, Rule } from "../engine/types";
import type { CloudRecipient } from "./catalog";
import { supabase } from "./supabase";
import { periodReady, todayDate, type Coverage } from './coverage';
import {loadProductResolutions} from './imported-products';

export interface QuarterlyRecipient {
  id: string;
  name: string;
  commission: string;
  eligibleLines: number;
  blockedLines: number;
  reviewItems: QuarterlyReviewItem[];
  calculations: Calculation[];
}

export interface QuarterlyReviewItem {
  lineId: string;
  ruleId: string;
  orderNumber: string;
  productName: string;
  date: string;
  channel: Line["channel"];
  sku: string;
  reason: string;
}

export interface QuarterlyReport {
  coverage?: Coverage[];
  coverageComplete?: boolean;
  amountsAvailable?: boolean;
  provisional?: boolean;
  provisionalThrough?: string | null;
  finalization?: QuarterFinalization;
  throughDate?: string;
  year: number;
  quarter: number;
  startsOn: string;
  endsOn: string;
  grossSales: string;
  commissionTotal: string;
  orderLines: number;
  eligibleLines: number;
  noRuleLines: number;
  matchedNoRuleLines: number;
  blockedLines: number;
  unmatchedLines: number;
  unmatchedProducts: number;
  commissionRelevantUnmatchedLines: number;
  salesByChannel: Record<"shopify" | "etsy" | "faire", string>;
  recipients: QuarterlyRecipient[];
}

export interface QuarterFinalization {
  id: string;
  year: number;
  quarter: number;
  quarter_start: string;
  quarter_end: string;
  preliminary_sync_date: string;
  scheduled_final_sync_date: string;
  status: 'open'|'preliminary_sync_due'|'preliminary_sync_complete'|'final_sync_due'|'finalizing'|'retry_needed'|'finalized';
  preliminary_completed_at: string|null;
  finalized_at: string|null;
  retry_stage: 'preliminary'|'final'|null;
  shopify_result: Record<string,unknown>;
  etsy_result: Record<string,unknown>;
  faire_result: Record<string,unknown>;
  latest_error: string|null;
}

type RuleSetRow = {
  id: string;
  recipient_id: string;
  name: string;
  rule_versions: Array<{
    version: number;
    effective_start: string;
    effective_end: string | null;
    priority: number;
    active: boolean;
    currency: string;
    kind: Rule["kind"];
    rate: string | number;
    refund_policy: Rule["refundPolicy"];
    deductions: Rule["deductions"];
    manual_shipping: string | number | null;
    manual_other_costs: string | number | null;
    conditions: Rule["conditions"];
    notes: string;
  }>;
};

type ItemRow = {
  id: string;
  external_line_id: string;
  external_product_key: string | null;
  source_sku: string | null;
  sku_id: string | null;
  product_name: string;
  quantity: number;
  refunded_quantity: number;
  unit_price: string | number;
  discounts: string | number | null;
  refunds: string | number | null;
  shipping: string | number | null;
  platform_fees: string | number | null;
  platform_commissions: string | number | null;
  other_costs: string | number | null;
  order_revisions: {
    id: string;
    order_id: string;
    order_number: string;
    business_date: string;
    currency: string;
    source: string | null;
    referral: string | null;
    market: "retail" | "wholesale";
    cancelled: boolean;
    created_at: string;
    orders: {
      account_id: string;
      channel_accounts: { channel_id: Line["channel"] };
    };
  };
  skus: { sku: string; design_id: string } | null;
};

type AnalyticsItemRow = Omit<ItemRow, "order_revisions" | "skus"> & {
  order_id: string;
  order_number: string;
  business_date: string;
  currency: string;
  source: string | null;
  referral: string | null;
  market: "retail" | "wholesale";
  cancelled: boolean;
  account_id: string;
  channel_id: Line["channel"];
};

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const asMoney = (value: Decimal.Value) => new D(value).toFixed(2);
const scalar = (value: string | number | null) =>
  value === null ? null : String(value);

export function quarterRange(year: number, quarter: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error("Select a valid year.");
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4)
    throw new Error("Select a valid quarter.");
  const startMonth = (quarter - 1) * 3;
  const startsOn = `${year}-${String(startMonth + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  const endsOn = end.toISOString().slice(0, 10);
  return { startsOn, endsOn };
}

export function quarterFinalSyncDate(year:number,quarter:number) {
  const {endsOn}=quarterRange(year,quarter);
  return new Date(Date.parse(`${endsOn}T00:00:00Z`)+11*86400000).toISOString().slice(0,10);
}

export function quarterPreliminarySyncDate(year:number,quarter:number) {
  const {endsOn}=quarterRange(year,quarter);
  return new Date(Date.parse(`${endsOn}T00:00:00Z`)+86400000).toISOString().slice(0,10);
}

export function buildQuarterlyReport(
  year: number,
  quarter: number,
  recipients: CloudRecipient[],
  lines: Line[],
  rules: Rule[],
): QuarterlyReport {
  const { startsOn, endsOn } = quarterRange(year, quarter);
  const quarterLines = lines.filter(
    (line) => line.date >= startsOn && line.date <= endsOn,
  );
  const quarterRecipients = recipients.filter(
    (recipient) =>
      recipient.startsOn <= endsOn &&
      (!recipient.endsOn || recipient.endsOn >= startsOn),
  );
  const totals = new Map(
    quarterRecipients.map((recipient) => [
      recipient.id,
      {
        amount: new D(0),
        eligibleLines: 0,
        blockedLines: 0,
        reviewItems: [] as QuarterlyReviewItem[],
        calculations: [] as Calculation[],
      },
    ]),
  );
  const blockedLineIds = new Set<string>();
  const eligibleLineIds = new Set<string>();
  let unmatchedLines = 0;
  let noRuleLines = 0;
  let matchedNoRuleLines = 0;
  let commissionRelevantUnmatchedLines = 0;
  const unmatchedProductKeys = new Set<string>();
  let grossSales = new D(0);
  const salesByChannel = {
    shopify: new D(0),
    etsy: new D(0),
    faire: new D(0),
  };

  const manualAllocations = allocateManualOrderCosts(quarterLines, rules);
  for (const line of quarterLines) {
    const gross = new D(line.unitPrice).mul(line.quantity);
    grossSales = grossSales.plus(gross);
    salesByChannel[line.channel] = salesByChannel[line.channel].plus(gross);
    if (!line.sku) {
      unmatchedLines += 1;
      unmatchedProductKeys.add(`${line.channel}:${line.externalProductKey ?? line.sourceSku ?? line.productName ?? line.id}`);
    }
    let selected: Rule[];
    try {
      selected = selectCommissionReviewRules(line, rules);
      if (!selected.length) {
        noRuleLines += 1;
        if (line.sku) matchedNoRuleLines += 1;
        continue;
      }
    } catch (error) {
      blockedLineIds.add(line.id);
      continue;
    }
    if (!line.sku) {
      commissionRelevantUnmatchedLines += 1;
      blockedLineIds.add(line.id);
      for (const rule of selected) {
        const recipient = totals.get(rule.recipientId);
        if (!recipient) continue;
        recipient.blockedLines += 1;
        recipient.reviewItems.push({
          lineId: line.id,
          ruleId: rule.id,
          orderNumber: line.externalOrderId,
          productName: line.productName ?? line.sourceSku ?? "Imported product",
          date: line.date,
          channel: line.channel,
          sku: line.sourceSku ?? "Not supplied",
          reason: "This unmatched source SKU is referenced by an active commission rule.",
        });
      }
      continue;
    }
    for (const rule of selected) {
      const recipient = totals.get(rule.recipientId);
      if (!recipient) continue;
      try {
        const result = calculate(line, rule, manualAllocations.get(manualAllocationKey(line, rule)));
        recipient.amount = recipient.amount.plus(result.commission);
        recipient.eligibleLines += 1;
        eligibleLineIds.add(line.id);
        recipient.calculations.push(result);
      } catch (error) {
        recipient.blockedLines += 1;
        recipient.reviewItems.push({
          lineId: line.id,
          ruleId: rule.id,
          orderNumber: line.externalOrderId,
          productName: line.productName ?? line.sku ?? "Imported product",
          date: line.date,
          channel: line.channel,
          sku: line.sku ?? "Not matched",
          reason: (error as Error).message,
        });
        blockedLineIds.add(line.id);
      }
    }
  }

  const reportRecipients = quarterRecipients
    .map((recipient) => {
      const result = totals.get(recipient.id)!;
      return {
        id: recipient.id,
        name: recipient.name,
        commission: result.amount.toFixed(2),
        eligibleLines: result.eligibleLines,
        blockedLines: result.blockedLines,
        reviewItems: result.reviewItems,
        calculations: result.calculations.sort((a, b) =>
          a.lineSnapshot.date.localeCompare(b.lineSnapshot.date) ||
          a.lineSnapshot.externalOrderId.localeCompare(b.lineSnapshot.externalOrderId) ||
          (a.lineSnapshot.sku ?? "").localeCompare(b.lineSnapshot.sku ?? ""),
        ),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    year,
    quarter,
    startsOn,
    endsOn,
    grossSales: grossSales.toFixed(2),
    commissionTotal: asMoney(
      reportRecipients.reduce(
        (sum, recipient) => sum.plus(recipient.commission),
        new D(0),
      ),
    ),
    orderLines: quarterLines.length,
    eligibleLines: eligibleLineIds.size,
    noRuleLines,
    matchedNoRuleLines,
    blockedLines: blockedLineIds.size,
    unmatchedLines,
    unmatchedProducts: unmatchedProductKeys.size,
    commissionRelevantUnmatchedLines,
    salesByChannel: {
      shopify: salesByChannel.shopify.toFixed(2),
      etsy: salesByChannel.etsy.toFixed(2),
      faire: salesByChannel.faire.toFixed(2),
    },
    recipients: reportRecipients,
  };
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function relation<T>(value: T | T[]): T {
  return Array.isArray(value) ? value[0] : value;
}

async function loadItems(startsOn: string, endsOn: string): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client()
      .from("order_items")
      .select(
        "id,external_line_id,external_product_key,source_sku,sku_id,product_name,quantity,refunded_quantity,unit_price,discounts,refunds,shipping,platform_fees,platform_commissions,other_costs,skus(sku,design_id),order_revisions!inner(id,order_id,order_number,business_date,currency,source,referral,market,cancelled,created_at,orders!inner(account_id,channel_accounts!inner(channel_id)))",
      )
      .gte("order_revisions.business_date", startsOn)
      .lte("order_revisions.business_date", endsOn)
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as ItemRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function loadAnalyticsItems(startsOn: string, endsOn: string): Promise<AnalyticsItemRow[]> {
  const rows: AnalyticsItemRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client()
      .rpc("analytics_period_lines", { p_start: startsOn, p_end: endsOn })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as AnalyticsItemRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export interface PeriodInputs {
  recipients: CloudRecipient[];
  rules: Rule[];
  lines: Line[];
}

/**
 * Load the same normalized, latest-revision-only inputs used by quarterly
 * reporting for any inclusive date range. Analytics deliberately consumes
 * this function so it cannot drift from the commission engine or product
 * resolution rules used by Overview and Statements.
 */
export async function loadPeriodInputs(startsOn: string, endsOn: string): Promise<PeriodInputs> {
  const [{ data: recipientData, error: recipientError }, { data: ruleData, error: ruleError }, resolutionData, itemRows] =
    await Promise.all([
      client().from("recipients").select("id,name,active,starts_on,ends_on,notes,created_at").order("name"),
      client().from("rule_sets").select("id,recipient_id,name,rule_versions(version,effective_start,effective_end,priority,active,currency,kind,rate,refund_policy,deductions,conditions,notes,manual_shipping,manual_other_costs)").is("deleted_at", null),
      loadProductResolutions(),
      loadAnalyticsItems(startsOn, endsOn),
    ]);
  if (recipientError) throw new Error(recipientError.message);
  if (ruleError) throw new Error(ruleError.message);
  const mappings = new Map(resolutionData.map(p => [`${p.account_id}:${p.external_key}`, p]));
  const recipients: CloudRecipient[] = (recipientData ?? []).map(row => ({
    id: row.id, name: row.name, active: row.active, startsOn: row.starts_on,
    endsOn: row.ends_on ?? "", notes: row.notes, createdAt: row.created_at,
  }));
  const rules: Rule[] = ((ruleData ?? []) as unknown as RuleSetRow[]).flatMap(set =>
    set.rule_versions.map(version => ({
      id: set.id, version: version.version, recipientId: set.recipient_id,
      name: set.name, active: version.active, startsOn: version.effective_start,
      endsOn: version.effective_end, priority: version.priority, currency: version.currency,
      kind: version.kind, rate: String(version.rate), deductions: version.deductions,
      ...(version.manual_shipping != null && version.manual_other_costs != null
        ? { manualOrderCosts: { shipping: String(version.manual_shipping), otherCosts: String(version.manual_other_costs) } }
        : {}),
      conditions: version.conditions, refundPolicy: version.refund_policy, notes: version.notes,
    })),
  );
  const lines: Line[] = itemRows.map(row => {
    const mappingKey = row.external_product_key || row.source_sku || `unidentified-line:${row.id}`;
    const resolved = mappings.get(`${row.account_id}:${mappingKey}`);
    const sku = resolved?.resolved_sku_id ? { sku: resolved.internal_sku, design_id: resolved.design_id } : null;
    return {
      id: row.id, externalOrderId: row.order_number, orderKey: row.order_id,
      externalLineId: row.external_line_id, productName: row.product_name,
      sourceSku: row.source_sku, externalProductKey: row.external_product_key,
      channel: row.channel_id, date: row.business_date, currency: row.currency,
      sku: sku?.sku ?? null, designId: sku?.design_id ?? null, source: row.source,
      referral: row.referral, market: row.market, quantity: row.quantity,
      refundedQuantity: row.refunded_quantity, unitPrice: String(row.unit_price),
      costs: {
        discounts: scalar(row.discounts) ?? "0.00", refunds: scalar(row.refunds) ?? "0.00",
        shipping: scalar(row.shipping), platformFees: scalar(row.platform_fees),
        platformCommissions: scalar(row.platform_commissions), otherCosts: scalar(row.other_costs),
      },
      cancelled: row.cancelled,
    };
  });
  return { recipients, rules, lines };
}

export async function loadQuarterlyReport(
  year: number,
  quarter: number,
): Promise<QuarterlyReport> {
  const { startsOn, endsOn } = quarterRange(year, quarter);
  const [{ data: recipientData, error: recipientError }, { data: ruleData, error: ruleError }, resolutionData, itemRows] =
    await Promise.all([
      client()
        .from("recipients")
        .select("id,name,active,starts_on,ends_on,notes,created_at")
        .order("name"),
      client()
        .from("rule_sets")
        .select(
          "id,recipient_id,name,rule_versions(version,effective_start,effective_end,priority,active,currency,kind,rate,refund_policy,deductions,conditions,notes,manual_shipping,manual_other_costs)",
        )
        .is("deleted_at", null),
      loadProductResolutions(),
      loadItems(startsOn, endsOn),
    ]);
  if (recipientError) throw new Error(recipientError.message);
  if (ruleError) throw new Error(ruleError.message);
  const mappings = new Map(resolutionData.map(p=>[`${p.account_id}:${p.external_key}`,p]));

  const recipients: CloudRecipient[] = (recipientData ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    startsOn: row.starts_on,
    endsOn: row.ends_on ?? "",
    notes: row.notes,
    createdAt: row.created_at,
  }));
  const rules: Rule[] = ((ruleData ?? []) as unknown as RuleSetRow[]).flatMap(
    (set) =>
      set.rule_versions.map((version) => ({
        id: set.id,
        version: version.version,
        recipientId: set.recipient_id,
        name: set.name,
        active: version.active,
        startsOn: version.effective_start,
        endsOn: version.effective_end,
        priority: version.priority,
        currency: version.currency,
        kind: version.kind,
        rate: String(version.rate),
        deductions: version.deductions,
      ...(version.manual_shipping != null && version.manual_other_costs != null ? { manualOrderCosts: { shipping: String(version.manual_shipping), otherCosts: String(version.manual_other_costs) } } : {}),
        conditions: version.conditions,
        refundPolicy: version.refund_policy,
        notes: version.notes,
      })),
  );

  const newestRevision = new Map<string, string>();
  const revisionDates = new Map<string, string>();
  for (const row of itemRows) {
    const revision = relation(row.order_revisions);
    const previous = revisionDates.get(revision.order_id);
    if (!previous || revision.created_at > previous) {
      revisionDates.set(revision.order_id, revision.created_at);
      newestRevision.set(revision.order_id, revision.id);
    }
  }
  const lines: Line[] = itemRows
    .filter((row) => {
      const revision = relation(row.order_revisions);
      return newestRevision.get(revision.order_id) === revision.id;
    })
    .map((row) => {
      const revision = relation(row.order_revisions);
      const order = relation(revision.orders);
      const account = relation(order.channel_accounts);
      const mappingKey = row.external_product_key || row.source_sku || `unidentified-line:${row.id}`;
      const resolved = mappings.get(`${order.account_id}:${mappingKey}`);
      // A conflict must not silently fall back to a historical assignment.
      const sku = resolved?.resolved_sku_id ? {sku:resolved.internal_sku,design_id:resolved.design_id} : null;
      return {
        id: row.id,
        externalOrderId: revision.order_number,
        orderKey: revision.order_id,
        externalLineId: row.external_line_id,
        productName: row.product_name,
        sourceSku: row.source_sku,
        externalProductKey: row.external_product_key,
        channel: account.channel_id,
        date: revision.business_date,
        currency: revision.currency,
        sku: sku?.sku ?? null,
        designId: sku?.design_id ?? null,
        source: revision.source,
        referral: revision.referral,
        market: revision.market,
        quantity: row.quantity,
        refundedQuantity: row.refunded_quantity,
        unitPrice: String(row.unit_price),
        costs: {
          // Connectors represent an absent discount/refund entry as null. That
          // means no such deduction was reported for the line, so its value is zero.
          discounts: scalar(row.discounts) ?? "0.00",
          refunds: scalar(row.refunds) ?? "0.00",
          shipping: scalar(row.shipping),
          platformFees: scalar(row.platform_fees),
          platformCommissions: scalar(row.platform_commissions),
          otherCosts: scalar(row.other_costs),
        },
        cancelled: revision.cancelled,
      };
    });

  const throughDate = endsOn < todayDate() ? endsOn : todayDate();
  const {data:coverage,error:coverageError} = await client().rpc('commission_coverage',{p_start:startsOn,p_end:throughDate});
  if(coverageError) throw new Error(`Cannot verify data coverage: ${coverageError.message}`);
  const {data:finalizationRows,error:finalizationError}=await client().rpc('quarter_finalization_status',{p_year:year,p_quarter:quarter});
  if(finalizationError) throw new Error(`Cannot load quarter finalization status: ${finalizationError.message}`);
  const finalization=(finalizationRows?.[0] ?? finalizationRows) as QuarterFinalization;
  const coverageComplete = startsOn <= throughDate && periodReady(coverage ?? []);
  const coverageRows = (coverage ?? []) as Coverage[];
  const verifiedThrough = coverageRows
    .filter((row) => row.coverage_through)
    .map((row) => row.coverage_through as string)
    .sort();
  const hasVerifiedSyncForEveryChannel = ['shopify','etsy','faire'].every(channel =>
    coverageRows.some(row => row.channel===channel && row.sync_status==='completed' && row.failed_orders===0 && row.last_success)
  );
  const amountsAvailable = coverageComplete || (lines.length>0 && hasVerifiedSyncForEveryChannel);
  const provisional = amountsAvailable && finalization?.status !== 'finalized';
  const provisionalThrough = provisional && verifiedThrough.length ? verifiedThrough[0] : null;
  return {...buildQuarterlyReport(year, quarter, recipients, lines, rules), coverage:coverageRows, coverageComplete, amountsAvailable, provisional, provisionalThrough, throughDate, finalization};
}
