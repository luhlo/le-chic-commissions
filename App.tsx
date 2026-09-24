import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  calculate,
  selectCommissionReviewRules,
  allocateManualOrderCosts,
  manualAllocationKey,
  total,
  validateRule,
} from "../engine/calculate";
import { costKeys, type Calculation, type Rule, type Line } from "../engine/types";
import { initialState, sampleLines, type DemoState } from "./demo";
import { importBatch } from "../integrations/normalize";
import { supabase } from "./supabase";
import {
  addCloudSku,
  createCloudDesign,
  findCloudSkuId,
  loadCloudCatalog,
  loadCloudRecipients,
  saveCloudRecipient,
  setCloudDesignActive,
  setCloudRecipientActive,
  updateCloudDesign,
  updateCloudSku,
  type CloudDesign,
  type CloudRecipient,
  type CloudSku,
} from "./catalog";
import {
  checkShopify,
  syncShopify,
  syncShopifyProducts,
  syncShopifySkuCatalog,
  type ShopifyStatus,
} from "./shopify";
import { authorizeEtsy, checkEtsy, syncEtsy, type EtsyStatus } from "./etsy";
import { checkFaire, syncFaire, retryFaire, type FaireStatus } from "./faire";
import { syncAll } from "./syncAll";
import { HistoricalBackfill } from './HistoricalBackfill';
import { todayDate, type SyncRequest } from './coverage';
import { deleteCloudRule, loadCloudRules, saveCloudRule } from "./rules";
import {
  loadImportedProducts,
  saveProductMapping,
  type ImportedProduct,
} from "./imported-products";
import {
  loadQuarterlyReport,
  quarterRange,
  type QuarterlyReport,
} from "./quarterly";
const Analytics = lazy(() => import('./AnalyticsPage').then(module => ({default: module.Analytics})));
const pages = [
  "Overview",
  "Analytics",
  "Designs & SKUs",
  "Recipients",
  "Commission rules",
  "Orders & imports",
  "Unmatched products",
  "Statements",
  "Connection",
] as const;
type Page = (typeof pages)[number];
const money = (v: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v),
  );
const costLabel: Record<(typeof costKeys)[number], string> = {
  discounts: "Discounts",
  refunds: "Refunds",
  shipping: "Shipping paid",
  platformFees: "Platform fees",
  platformCommissions: "Platform commissions",
  otherCosts: "Other costs",
};
const platformLabel = (value: string) =>
  value ? value.slice(0, 1).toUpperCase() + value.slice(1) : "Unknown";
const reportDate = (value: string | null | undefined) => value
  ? new Intl.DateTimeFormat("en-US", {timeZone:"UTC",month:"short",day:"numeric",year:"numeric"}).format(new Date(`${value}T00:00:00Z`))
  : "No imported orders";
function finalizationLabel(report: QuarterlyReport | null) {
  const finalization=report?.finalization;
  if(!finalization) return '';
  if(finalization.status==='finalized') return `Finalized ${new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(finalization.finalized_at!))}`;
  if(finalization.status==='finalizing') return finalization.retry_stage==='preliminary' ? 'Preliminary quarter sync in progress' : 'Final quarter sync in progress';
  if(finalization.status==='retry_needed') return `${finalization.retry_stage==='preliminary'?'Preliminary':'Final'} sync needs retry`;
  if(finalization.status==='preliminary_sync_due') return `Quarter closed · Preliminary sync scheduled for ${reportDate(finalization.preliminary_sync_date)}`;
  if(finalization.status==='preliminary_sync_complete') return `Preliminary sync complete · Final sync scheduled for ${reportDate(finalization.scheduled_final_sync_date)}`;
  if(finalization.status==='final_sync_due') return `Final sync scheduled for ${reportDate(finalization.scheduled_final_sync_date)}`;
  return `Provisional · synced through ${reportDate(report?.provisionalThrough)}`;
}
function calculationFormula(c: Calculation) {
  const rate = c.ruleSnapshot.rate;
  if (c.ruleSnapshot.kind === "fixed")
    return `${c.units} unit${c.units === 1 ? "" : "s"} × ${money(rate)} = ${money(c.commission)}`;
  if (c.ruleSnapshot.kind === "percentage")
    return `${money(c.gross)} × ${rate}% = ${money(c.commission)}`;
  return `(${money(c.gross)} − ${money(c.deducted)}) × ${rate}% = ${money(c.commission)}`;
}
const today = () => new Date().toISOString().slice(0, 10);
const currentYear = new Date().getFullYear();
const currentQuarter = Math.floor(new Date().getMonth() / 3) + 1;
const uid = () => crypto.randomUUID();
const input = (f: HTMLFormElement, key: string) =>
  String(new FormData(f).get(key) ?? "").trim();
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}
function LoginScreen({
  message,
  onMessage,
}: {
  message: string;
  onMessage: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!supabase) return;
    const form = e.currentTarget;
    setSubmitting(true);
    onMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email: input(form, "email"),
      password: input(form, "password"),
    });
    if (error) onMessage("The email or password was not accepted.");
    setSubmitting(false);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="monogram">LC</span>
          <div>
            Le Chic Miami<small>COMMISSIONS</small>
          </div>
        </div>
        <div className="eyebrow">PRIVATE WORKSPACE</div>
        <h1>Sign in</h1>
        <p>Use your authorized Le Chic Commissions account.</p>
        <form onSubmit={signIn}>
          <Field label="Email address">
            <input name="email" type="email" autoComplete="username" required />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {message && (
            <div className="auth-error" role="alert">
              {message}
            </div>
          )}
          <button disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <small>
          Accounts are created by an administrator. Public registration is not
          available.
        </small>
      </section>
    </main>
  );
}
function csvExport(rows: string[][]) {
  const safe = (v: string) =>
    '"' + (/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""') + '"';
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + rows.map((r) => r.map(safe).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "le-chic-quarterly-commissions.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const [state, setState] = useState<DemoState>(() => {
    try {
      const s = localStorage.getItem("le-chic-demo-v1");
      return s ? JSON.parse(s) : initialState();
    } catch {
      return initialState();
    }
  });
  const [page, setPage] = useState<Page>(() =>
    new URLSearchParams(window.location.search).has("etsy") ? "Connection" : "Overview",
  );
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("all");
  const [cloudDesigns, setCloudDesigns] = useState<CloudDesign[]>([]);
  const [cloudRecipients, setCloudRecipients] = useState<CloudRecipient[]>([]);
  const [cloudRules, setCloudRules] = useState<Rule[]>([]);
  const [importedProducts, setImportedProducts] = useState<ImportedProduct[]>([]);
  const [matchedProducts, setMatchedProducts] = useState<ImportedProduct[]>([]);
  const [selectedImportedProduct, setSelectedImportedProduct] =
    useState<ImportedProduct | null>(null);
  const [importedProductSearch, setImportedProductSearch] = useState("");
  const [cloudLoading, setCloudLoading] = useState(false);
  const [editDesign, setEditDesign] = useState<CloudDesign | null>(null);
  const [showDesign, setShowDesign] = useState(false);
  const [skuDesign, setSkuDesign] = useState<CloudDesign | null>(null);
  const [editSku, setEditSku] = useState<CloudSku | null>(null);
  const [editRecipient, setEditRecipient] = useState<CloudRecipient | null>(
    null,
  );
  const [showRecipient, setShowRecipient] = useState(false);
  const [editRule, setEditRule] = useState<Rule | null>(null);
  const [showRule, setShowRule] = useState(false);
  const [manualCostsEnabled, setManualCostsEnabled] = useState(false);
  const [ruleKind, setRuleKind] = useState<Rule["kind"]>("adjusted_percentage");
  const [ruleSkuSearch, setRuleSkuSearch] = useState("");
  const [periodId, setPeriodId] = useState(state.periods[0].id);
  const [recipientFilter, setRecipientFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [skuFilter, setSkuFilter] = useState("");
  const [unmatchedSearch, setUnmatchedSearch] = useState("");
  const [unmatchedLimit, setUnmatchedLimit] = useState(25);
  const [sessionEmail, setSessionEmail] = useState("");
  const [authReady, setAuthReady] = useState(!supabase);
  const [adminStatus, setAdminStatus] = useState<
    "checking" | "authorized" | "denied"
  >("checking");
  const [cloudMessage, setCloudMessage] = useState("");
  const [shopifyStatus, setShopifyStatus] = useState<ShopifyStatus | null>(null);
  const [shopifyBusy, setShopifyBusy] = useState(false);
  const [etsyStatus, setEtsyStatus] = useState<EtsyStatus | null>(null);
  const [etsyBusy, setEtsyBusy] = useState(false);
  const [faireStatus, setFaireStatus] = useState<FaireStatus | null>(null);
  const [faireBusy, setFaireBusy] = useState(false);
  const [connectionsChecked, setConnectionsChecked] = useState(false);
  const [reportYear, setReportYear] = useState(currentYear);
  const [reportQuarter, setReportQuarter] = useState(currentQuarter);
  const [quarterlyReport, setQuarterlyReport] =
    useState<QuarterlyReport | null>(null);
  const [quarterlyLoading, setQuarterlyLoading] = useState(false);
  const [quarterlyError, setQuarterlyError] = useState("");
  const [reviewRecipientId, setReviewRecipientId] = useState<string | null>(null);
  const [overviewRecipientId, setOverviewRecipientId] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("le-chic-demo-v1", JSON.stringify(state));
    } catch {
      setNotice("Demo changes could not be saved in this browser.");
    }
  }, [state]);
  useEffect(() => {
    if (!supabase) return;
    const authClient = supabase;
    let active = true;
    async function applySession(session: Session | null) {
      if (!active) return;
      setSessionEmail(session?.user.email ?? "");
      if (!session) {
        setAdminStatus("denied");
        setAuthReady(true);
        return;
      }
      setAdminStatus("checking");
      const { data, error } = await authClient
        .from("admin_members")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (!active) return;
      setAdminStatus(!error && data ? "authorized" : "denied");
      setAuthReady(true);
    }
    authClient.auth.getSession().then(({ data }) => applySession(data.session));
    const { data } = authClient.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => void applySession(session), 0);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (adminStatus === "authorized") void reloadCloudData();
  }, [adminStatus]);
  useEffect(() => {
    if (
      adminStatus === "authorized" &&
      (page === "Connection" || page === "Orders & imports")
    )
      void refreshConnections();
  }, [adminStatus, page]);
  useEffect(() => {
    if (adminStatus === "authorized" && page === "Overview")
      void refreshQuarterlyReport();
  }, [adminStatus, page, reportYear, reportQuarter]);

  async function refreshQuarterlyReport() {
    setQuarterlyLoading(true);
    setQuarterlyError("");
    try {
      setQuarterlyReport(await loadQuarterlyReport(reportYear, reportQuarter));
    } catch (error) {
      setQuarterlyReport(null);
      setQuarterlyError((error as Error).message);
    } finally {
      setQuarterlyLoading(false);
    }
  }

  async function reloadCloudData() {
    setCloudLoading(true);
    try {
      const [designs, recipients, rules, products] = await Promise.all([
        loadCloudCatalog(),
        loadCloudRecipients(),
        loadCloudRules(),
        loadImportedProducts(),
      ]);
      setCloudDesigns(designs);
      setCloudRecipients(recipients);
      setCloudRules(rules);
      setImportedProducts(products.filter(p=>!p.matchedSkuId));
      setMatchedProducts(products.filter(p=>p.matchedSkuId));
    } catch (error) {
      setNotice(`Cloud data could not be loaded: ${(error as Error).message}`);
    } finally {
      setCloudLoading(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) setNotice("Sign out failed. Please try again.");
  }
  function requestedSync(backfill = false): SyncRequest {
    const {startsOn,endsOn} = quarterRange(reportYear,reportQuarter);
    const today = todayDate();
    const currentStart = `${today.slice(0,4)}-${String(Math.floor((Number(today.slice(5,7))-1)/3)*3+1).padStart(2,'0')}-01`;
    return backfill ? {startDate:'2000-01-01',endDate:new Date(Date.parse(currentStart)-86400000).toISOString().slice(0,10),syncType:'historical_backfill'}
      : {startDate:startsOn,endDate:endsOn<today ? endsOn:today,syncType:'current_period'};
  }
  async function runShopify(action: "check" | "sync" | "backfill") {
    setShopifyBusy(true);
    try {
      const request = requestedSync(action==='backfill');
      const result = action === "check" ? await checkShopify() : action === 'backfill' ? await syncShopify(request) : await syncAll(() => syncShopify(request), r => {
        setNotice(`Shopify: ${r.imported} imported, ${r.duplicates} unchanged. ${r.moreAvailable ? 'Continuing through this period—keep this page open.' : ''}`);
      });
      setShopifyStatus(result);
      if (action === "check" && result.message) setNotice(result.message);
      if (action !== "check" && result.connected)
        setNotice(
          `Shopify sync ${result.status}: ${result.imported ?? 0} imported, ${result.duplicates ?? 0} unchanged, ${result.failed ?? 0} failed. ${result.message ?? ''}`,
        );
      if (action !== "check" && result.connected) {
        await reloadCloudData();
        await refreshQuarterlyReport();
      }
    } catch (error) {
      setShopifyStatus(null);
      setNotice(`Shopify: ${(error as Error).message}`);
    } finally {
      setShopifyBusy(false);
    }
  }
  async function refreshShopifyProducts() {
    setShopifyBusy(true);
    try {
      const result = await syncShopifyProducts();
      const catalog = await syncShopifySkuCatalog();
      setShopifyStatus(result);
      await reloadCloudData();
      setNotice(
        `${result.productsSynced ?? 0} Shopify variants refreshed. ${catalog.designs_created} design${catalog.designs_created === 1 ? "" : "s"} and ${catalog.skus_added} current SKU${catalog.skus_added === 1 ? "" : "s"} added; ${catalog.matching.auto_matched} product${catalog.matching.auto_matched === 1 ? "" : "s"} resolved. Genuine SKU conflicts remain for review.`,
      );
    } catch (error) {
      setNotice(`Shopify products: ${(error as Error).message}`);
    } finally {
      setShopifyBusy(false);
    }
  }
  async function runEtsy(action: "check" | "connect" | "sync" | "backfill") {
    setEtsyBusy(true);
    try {
      if (action === "connect") {
        await authorizeEtsy();
        return;
      }
      const request = requestedSync(action==='backfill');
      const result = action === "check" ? await checkEtsy() : action === 'backfill' ? await syncEtsy(request) : await syncAll(() => syncEtsy(request), r => {
        setNotice(`Etsy: ${r.imported} imported, ${r.duplicates} unchanged. ${r.moreAvailable ? 'Continuing through this period—keep this page open.' : ''}`);
      });
      setEtsyStatus(result);
      if (action !== "check" && result.connected)
        setNotice(
          `Etsy sync ${result.status}: ${result.imported ?? 0} imported, ${result.duplicates ?? 0} unchanged, ${result.failed ?? 0} failed.`,
        );
      if (action !== "check" && result.connected) {
        await reloadCloudData();
        await refreshQuarterlyReport();
      }
    } catch (error) {
      const message = (error as Error).message;
      setEtsyStatus({ status: "setup_required", connected: false, message });
      setNotice(`Etsy: ${message}`);
    } finally {
      setEtsyBusy(false);
    }
  }
  async function runFaire(action: "check" | "sync" | "backfill" | "retry") {
    setFaireBusy(true);
    try {
      const request = requestedSync(action==='backfill');
      const result = action === "check" ? await checkFaire() : action === 'retry' ? await retryFaire() : action === 'backfill' ? await syncFaire(request) : await syncAll(() => syncFaire(request), r => {
        setNotice(`Faire: ${r.imported} imported, ${r.duplicates} unchanged. ${r.moreAvailable ? 'Continuing through this period—keep this page open.' : ''}`);
      });
      setFaireStatus(result);
      if (action !== "check" && result.connected)
        setNotice(
          `Faire sync ${result.status}: ${result.imported ?? 0} imported, ${result.duplicates ?? 0} unchanged, ${result.failed ?? 0} failed.`,
        );
      if (action !== "check" && result.connected) {
        await reloadCloudData();
        await refreshQuarterlyReport();
      }
    } catch (error) {
      const message = (error as Error).message;
      setFaireStatus({ status: "setup_required", connected: false, message });
      setNotice(`Faire: ${message}`);
    } finally {
      setFaireBusy(false);
    }
  }
  async function refreshConnections() {
    setShopifyBusy(true);
    setEtsyBusy(true);
    setFaireBusy(true);
    const results = await Promise.allSettled([checkShopify(), checkEtsy(), checkFaire()]);
    const [shopify, etsy, faire] = results;
    setShopifyStatus(
      shopify.status === "fulfilled"
        ? shopify.value
        : { status: "setup_required", connected: false, message: "Disconnected — setup required." },
    );
    setEtsyStatus(
      etsy.status === "fulfilled"
        ? etsy.value
        : { status: "setup_required", connected: false, message: "Disconnected — setup required." },
    );
    setFaireStatus(
      faire.status === "fulfilled"
        ? faire.value
        : { status: "setup_required", connected: false, message: "Disconnected — setup required." },
    );
    setConnectionsChecked(true);
    setShopifyBusy(false);
    setEtsyBusy(false);
    setFaireBusy(false);
  }
  function connectionLabel(connected: boolean | undefined, checking: boolean) {
    if (checking || !connectionsChecked) return "Checking…";
    return connected ? "Connected" : "Disconnected — setup required";
  }

  if (supabase && !authReady)
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p>Checking your secure session…</p>
        </section>
      </main>
    );
  if (supabase && !sessionEmail)
    return <LoginScreen message={cloudMessage} onMessage={setCloudMessage} />;
  if (supabase && adminStatus !== "authorized")
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="eyebrow">ACCESS REQUIRED</div>
          <h1>Account not authorized</h1>
          <p>
            <strong>{sessionEmail}</strong> is signed in, but it has not been
            added as a Le Chic Commissions administrator.
          </p>
          <button onClick={signOut}>Sign out</button>
        </section>
      </main>
    );
  const period =
    state.periods.find((p) => p.id === periodId) ?? state.periods[0];
  const frozen = ["finalized", "paid"].includes(period.status);
  const periodLines = state.lines.filter(
    (l) => l.date >= period.startsOn && l.date <= period.endsOn,
  );
  let computed: Calculation[] = [];
  const blockers: string[] = [];
  const manualAllocations = allocateManualOrderCosts(periodLines, state.rules);
  for (const line of periodLines) {
    try {
      const rules = selectCommissionReviewRules(line, state.rules);
      if (!rules.length) continue;
      if (!line.sku) throw new Error("Unmatched source SKU is referenced by an active commission rule");
      for (const rule of rules) computed.push(calculate(line, rule, manualAllocations.get(manualAllocationKey(line, rule))));
    } catch (e) {
      blockers.push(`${line.externalOrderId}: ${(e as Error).message}`);
    }
  }
  const calculations = frozen ? period.snapshot : computed;
  const filtered = calculations.filter(
    (c) =>
      (!recipientFilter || c.recipientId === recipientFilter) &&
      (!channelFilter || c.lineSnapshot.channel === channelFilter) &&
      (!skuFilter || c.lineSnapshot.sku === skuFilter),
  );
  const adjustments = period.adjustments.filter(
    (a) => !recipientFilter || a.recipientId === recipientFilter,
  );
  const commissionTotal = total(calculations.map((c) => c.commission));
  const filteredCommission = total(filtered.map((c) => c.commission));
  const recipientName = (id: string) =>
    frozen
      ? (period.recipientNames[id] ?? id)
      : (state.recipients.find((r) => r.id === id)?.name ?? id);
  function change(mutator: (draft: DemoState) => void) {
    const draft = structuredClone(state);
    mutator(draft);
    if (
      ["designs", "recipients", "rules", "lines"].some(
        (k) =>
          JSON.stringify(draft[k as keyof DemoState]) !==
          JSON.stringify(state[k as keyof DemoState]),
      )
    )
      draft.periods.forEach((p) => {
        if (p.status === "reviewed") p.status = "draft";
      });
    setState(draft);
  }
  function report(action: () => void) {
    try {
      action();
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function navigate(p: Page) {
    setPage(p);
    setSearch("");
    setNotice("");
  }
  async function saveDesign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    setCloudLoading(true);
    try {
      const values = {
        name: input(f, "name"),
        family: input(f, "family"),
        notes: input(f, "notes"),
      };
      if (editDesign) await updateCloudDesign(editDesign.id, values);
      else {
        const sku = input(f, "sku");
        const designId = await createCloudDesign({
          ...values,
          sku,
          variant: input(f, "variant"),
        });
        if (selectedImportedProduct) {
          const skuId = await findCloudSkuId(designId, sku);
          await saveProductMapping(selectedImportedProduct, skuId);
        }
      }
      setShowDesign(false);
      setEditDesign(null);
      setSelectedImportedProduct(null);
      await reloadCloudData();
      await refreshQuarterlyReport();
      setNotice(
        editDesign
          ? "Design updated in Supabase."
          : selectedImportedProduct
            ? "Imported product saved as a design and matched to its SKU."
            : "Design and SKU saved in Supabase.",
      );
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  async function saveSku(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!skuDesign) return;
    setCloudLoading(true);
    try {
      const values = { sku: input(f, "sku"), variant: input(f, "variant") };
      if (editSku) await updateCloudSku(editSku.id, values);
      else await addCloudSku(skuDesign.id, values);
      setSkuDesign(null);
      setEditSku(null);
      await reloadCloudData();
      setNotice(
        editSku ? "SKU updated in Supabase." : "SKU added in Supabase.",
      );
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  async function saveRecipient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const values = {
      name: input(f, "name"),
      startsOn: input(f, "startsOn"),
      endsOn: input(f, "endsOn"),
      notes: input(f, "notes"),
    };
    try {
      if (values.endsOn && values.endsOn < values.startsOn)
        throw new Error("End date must follow start date.");
      setCloudLoading(true);
      await saveCloudRecipient(editRecipient?.id ?? null, values);
      setShowRecipient(false);
      setEditRecipient(null);
      await reloadCloudData();
      setNotice("Recipient saved in Supabase.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  async function toggleDesign(design: CloudDesign) {
    try {
      setCloudLoading(true);
      await setCloudDesignActive(design.id, !design.active);
      await reloadCloudData();
      setNotice(`Design ${design.active ? "deactivated" : "reactivated"}.`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  async function toggleSku(sku: CloudSku) {
    try {
      setCloudLoading(true);
      await updateCloudSku(sku.id, { active: !sku.active });
      await reloadCloudData();
      setNotice(`SKU ${sku.active ? "deactivated" : "reactivated"}.`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  async function toggleRecipient(recipient: CloudRecipient) {
    try {
      setCloudLoading(true);
      await setCloudRecipientActive(recipient.id, !recipient.active);
      await reloadCloudData();
      setNotice(
        `Recipient ${recipient.active ? "deactivated" : "reactivated"}.`,
      );
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }
  async function matchImportedProduct(
    event: FormEvent<HTMLFormElement>,
    product: ImportedProduct,
  ) {
    event.preventDefault();
    try {
      setCloudLoading(true);
      await saveProductMapping(product, input(event.currentTarget, "skuId"));
      await reloadCloudData();
      await refreshQuarterlyReport();
      setNotice(`${product.name} is now matched to its internal SKU.`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }

  function createFromImportedProduct(product: ImportedProduct) {
    setSelectedImportedProduct(product);
    setEditDesign(null);
    setShowDesign(true);
    navigate("Designs & SKUs");
  }

  function chooseImportedProduct(product: ImportedProduct | null) {
    setSelectedImportedProduct(product);
    setEditDesign(null);
    setShowDesign(Boolean(product));
    if (product) setImportedProductSearch("");
  }
  async function saveRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const conditions: Rule["conditions"] = {};
      const formData = new FormData(f);
      const selectedSkus = formData
        .getAll("sku")
        .map(String)
        .filter(Boolean);
      if (selectedSkus.length) conditions.sku = selectedSkus;
      for (const key of [
        "designId",
        "channel",
        "source",
        "referral",
        "market",
      ] as const) {
        const v = input(f, key);
        if (v) conditions[key] = v;
      }
      const r: Rule = {
        id: editRule?.id ?? uid(),
        version: editRule
          ? Math.max(
              ...cloudRules
                .filter((r) => r.id === editRule.id)
                .map((r) => r.version),
            ) + 1
          : 1,
        name: input(f, "name"),
        recipientId: input(f, "recipientId"),
        kind: ruleKind,
        rate: input(f, "rate"),
        priority: Number(input(f, "priority")),
        startsOn: input(f, "startsOn"),
        endsOn: input(f, "endsOn") || null,
        active: input(f, "active") === "yes",
        currency: "USD",
        conditions,
        deductions:
          ruleKind === "adjusted_percentage"
            ? costKeys.filter((k) => formData.has(k) && !(manualCostsEnabled && (k === "shipping" || k === "otherCosts")))
            : [],
        ...(ruleKind === "adjusted_percentage" && manualCostsEnabled ? { manualOrderCosts: {
          shipping: input(f, "manualShipping"), otherCosts: input(f, "manualOtherCosts"),
        }} : {}),
        refundPolicy: input(f, "refundPolicy") as Rule["refundPolicy"],
        notes: input(f, "notes"),
      };
      validateRule(r);
      setCloudLoading(true);
      await saveCloudRule(r, Boolean(editRule));
      setShowRule(false);
      setEditRule(null);
      await reloadCloudData();
      await refreshQuarterlyReport();
      setNotice("Commission rule version saved in Supabase.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCloudLoading(false);
    }
  }
  async function removeRule(rule: Rule) {
    if (!window.confirm(`Delete the commission rule “${rule.name}”?`)) return;
    try {
      setCloudLoading(true);
      await deleteCloudRule(rule.id);
      if (editRule?.id === rule.id) {
        setShowRule(false);
        setEditRule(null);
      }
      await reloadCloudData();
      await refreshQuarterlyReport();
      setNotice("Commission rule deleted.");
    } catch (error) {
      setNotice(`Rule could not be deleted: ${(error as Error).message}`);
    } finally {
      setCloudLoading(false);
    }
  }
  const currentRules = cloudRules.filter(
    (r) =>
      !cloudRules.some(
        (other) => other.id === r.id && other.version > r.version,
      ),
  );
  function openRuleFromReview(ruleId: string) {
    const rule = currentRules.find((candidate) => candidate.id === ruleId);
    if (!rule) {
      setNotice("That commission rule could not be found. Refresh and try again.");
      return;
    }
    setEditRule(rule);
    setManualCostsEnabled(Boolean(rule.manualOrderCosts));
    setRuleKind(rule.kind);
    setRuleSkuSearch("");
    setShowRule(true);
    navigate("Commission rules");
  }
  const visibleImportedProducts = importedProducts.filter((product) =>
    `${product.name} ${product.sku} ${product.variant} ${product.channel}`
      .toLowerCase()
      .includes(importedProductSearch.trim().toLowerCase()),
  );
  function setPeriodStatus(status: "reviewed" | "finalized") {
    report(() => {
      if (blockers.length)
        throw new Error(
          "Resolve all calculation blockers before reviewing or finalizing.",
        );
      if (!calculations.length)
        throw new Error("There are no eligible calculations.");
      if (status === "finalized" && period.status !== "reviewed")
        throw new Error("Review the period first.");
      change((s) => {
        const p = s.periods.find((p) => p.id === period.id)!;
        p.status = status;
        if (status === "finalized") {
          p.snapshot = structuredClone(calculations);
          p.recipientNames = Object.fromEntries(
            s.recipients.map((r) => [r.id, r.name]),
          );
        }
      });
      setNotice(
        status === "finalized"
          ? "Demo statement frozen."
          : "Demo period marked reviewed.",
      );
    });
  }
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <span className="monogram">LC</span>
          <div>
            Le Chic Miami<small>COMMISSIONS</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {pages.map((p, i) => (
            <button
              key={p}
              className={page === p ? "selected" : ""}
              onClick={() => navigate(p)}
            >
              <span className="nav-number">0{i + 1}</span>
              {p}
              {p === "Unmatched products" && importedProducts.length > 0 && (
                <b className="count">{importedProducts.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="sidebar-label">SIGNED IN</span>
          <span className="sidebar-email" title={sessionEmail}>
            {sessionEmail}
          </span>
          <button className="signout-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <div className="demo-banner live-banner">
          <strong>LIVE DATA</strong>
          <span>
            Recipients, products, orders, rules, and quarterly commissions use
            your secure Supabase workspace.
          </span>
        </div>
        <header>
          <div>
            <div className="eyebrow">LE CHIC COMMISSIONS</div>
            <h1>{page}</h1>
            <p>
              {page === "Overview"
                ? "A clear view of sales, commissions, and what needs your attention."
                : page === "Analytics"
                  ? "Explore sales and commission performance across any date range."
                : page === "Commission rules"
                  ? "Define how each person earns. Every edit creates a new version."
                  : page === "Statements"
                    ? "Review and export the live commission totals for any quarter."
                    : "Keep your commission records organized and easy to audit."}
            </p>
          </div>
          <div className="header-actions">
            <Badge>USD</Badge>
            <span>Cloud quarterly reporting</span>
          </div>
        </header>
        {notice && (
          <div role="status" className="notice">
            {notice}
            <button onClick={() => setNotice("")} aria-label="Dismiss message">
              ×
            </button>
          </div>
        )}
        {page === "Overview" && (
          <>
            <div className="quarter-controls panel">
              <div>
                <span className="eyebrow">REPORTING PERIOD</span>
                <h2>
                  Q{reportQuarter} {reportYear}
                </h2>
                <small>
                  {quarterlyReport
                    ? `${quarterlyReport.startsOn} through ${quarterlyReport.endsOn}`
                    : "Choose a calendar quarter"}
                </small>
              </div>
              <Field label="Year">
                <select
                  value={reportYear}
                  onChange={(event) => setReportYear(Number(event.target.value))}
                >
                  {Array.from({ length: 7 }, (_, index) => currentYear + 1 - index).map(
                    (year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="Quarter">
                <select
                  value={reportQuarter}
                  onChange={(event) => setReportQuarter(Number(event.target.value))}
                >
                  <option value={1}>Q1 · Jan–Mar</option>
                  <option value={2}>Q2 · Apr–Jun</option>
                  <option value={3}>Q3 · Jul–Sep</option>
                  <option value={4}>Q4 · Oct–Dec</option>
                </select>
              </Field>
              <button
                className="secondary"
                disabled={quarterlyLoading}
                onClick={() => void refreshQuarterlyReport()}
              >
                {quarterlyLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {quarterlyError && <div className="warning">{quarterlyError}</div>}
            <div className="metrics">
              <article>
                <span>Imported product sales</span>
                <strong>{money(quarterlyReport?.grossSales ?? "0")}</strong>
                <small>
                  {quarterlyReport?.orderLines ?? 0} order lines · before deductions
                </small>
              </article>
              <article>
                <span>Calculated commissions</span>
                <strong>{quarterlyReport?.amountsAvailable ? money(quarterlyReport.commissionTotal) : 'Awaiting sync'}</strong>
                <small>
                  {quarterlyLoading
                    ? "Loading cloud data…"
                    : quarterlyReport?.finalization
                      ? finalizationLabel(quarterlyReport)
                    : quarterlyReport?.blockedLines
                      ? `${quarterlyReport.blockedLines} commission-impacting line${quarterlyReport.blockedLines === 1 ? "" : "s"} require review`
                      : `${quarterlyReport?.eligibleLines ?? 0} commission line${(quarterlyReport?.eligibleLines ?? 0) === 1 ? "" : "s"} calculated · no blocking issues`}
                </small>
              </article>
              <article>
                <span>Recipients this quarter</span>
                <strong>{quarterlyReport?.recipients.length ?? 0}</strong>
                <small>Everyone is shown, including $0 amounts</small>
              </article>
            </div>
            <div className="columns">
              <section className="panel">
                <div className="section-title">
                  <h2>Commissions for Q{reportQuarter}</h2>
                  <button
                    className="text-button"
                    onClick={() => navigate("Recipients")}
                  >
                    Manage recipients →
                  </button>
                </div>
                {quarterlyReport?.recipients.map((recipient) => (
                  <div className="recipient-summary" key={recipient.id}>
                    <div className="summary-row">
                      <div className="avatar">
                        {recipient.name.trim().slice(0, 1).toUpperCase()}
                      </div>
                      <div className="grow">
                        <strong>{recipient.name}</strong>
                        <small className="recipient-line-status">
                          {recipient.eligibleLines} eligible order line
                          {recipient.eligibleLines === 1 ? "" : "s"}
                          {recipient.calculations.length > 0 && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="inline-review-button"
                                aria-expanded={overviewRecipientId === recipient.id}
                                onClick={() =>
                                  setOverviewRecipientId((current) =>
                                    current === recipient.id ? null : recipient.id,
                                  )
                                }
                              >
                                {overviewRecipientId === recipient.id ? "Hide orders" : "Show orders"}
                              </button>
                            </>
                          )}
                          {recipient.blockedLines > 0 && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="inline-review-button"
                                aria-expanded={reviewRecipientId === recipient.id}
                                onClick={() =>
                                  setReviewRecipientId((current) =>
                                    current === recipient.id ? null : recipient.id,
                                  )
                                }
                              >
                                Review {recipient.blockedLines} line
                                {recipient.blockedLines === 1 ? "" : "s"}
                              </button>
                            </>
                          )}
                        </small>
                      </div>
                      <strong>{quarterlyReport?.amountsAvailable ? money(recipient.commission) : 'Awaiting sync'}</strong>
                    </div>
                    {overviewRecipientId === recipient.id && (
                      <div className="overview-orders">
                        <div className="review-heading">
                          <strong>Orders included in {recipient.name}’s commission</strong>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => navigate("Statements")}
                          >
                            Open full statement →
                          </button>
                        </div>
                        {recipient.calculations.map((calculation) => (
                          <details className="calculation" key={`${calculation.lineId}-${calculation.recipientId}`}>
                            <summary>
                              <span>
                                <strong>{calculation.lineSnapshot.productName ?? calculation.lineSnapshot.sku ?? "Imported item"}</strong>
                                <small>
                                  {calculation.lineSnapshot.date} · Order {calculation.lineSnapshot.externalOrderId} · {platformLabel(calculation.lineSnapshot.channel)} · SKU {calculation.lineSnapshot.sku ?? "not supplied"}
                                </small>
                              </span>
                              <strong>{money(calculation.commission)}</strong>
                            </summary>
                            <div className="audit-grid">
                              <span>Quantity × item price</span><b>{calculation.lineSnapshot.quantity} × {money(calculation.lineSnapshot.unitPrice)}</b>
                              <span>Gross item sales</span><b>{money(calculation.gross)}</b>
                              {calculation.ruleSnapshot.deductions.map((key) => (
                                <span className="audit-deduction" key={key}>
                                  <span>− {costLabel[key]}</span>
                                  <b>{calculation.lineSnapshot.costs[key] == null ? "Needs review" : money(calculation.lineSnapshot.costs[key]!)}</b>
                                </span>
                              ))}
                              {calculation.manualDeductions && <>
                                <span>− Manual shipping share</span><b>{money(calculation.manualDeductions.shipping)}</b>
                                <span>− Manual other-cost share</span><b>{money(calculation.manualDeductions.otherCosts)}</b>
                              </>}
                              <span>Total deductions</span><b>−{money(calculation.deducted)}</b>
                              <span>Commissionable amount</span><b>{money(calculation.basis)}</b>
                              <span>Calculation</span><b>{calculationFormula(calculation)}</b>
                            </div>
                          </details>
                        ))}
                      </div>
                    )}
                    {reviewRecipientId === recipient.id && (
                      <div className="review-details">
                        <div className="review-heading">
                          <strong>What needs review</strong>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => navigate("Commission rules")}
                          >
                            Edit commission rule →
                          </button>
                        </div>
                        <div className="review-list">
                          {recipient.reviewItems.map((item) => (
                            <article key={`${recipient.id}-${item.lineId}`}>
                              <div className="review-item-heading">
                                <strong>{item.productName}</strong>
                                <button
                                  type="button"
                                  className="secondary review-edit-button"
                                  onClick={() => openRuleFromReview(item.ruleId)}
                                >
                                  Edit rule
                                </button>
                              </div>
                              <span>{item.reason}</span>
                              <small>
                                Order {item.orderNumber} · {item.channel} · {item.date} · SKU {item.sku}
                              </small>
                            </article>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {!quarterlyLoading &&
                  quarterlyReport?.recipients.length === 0 && (
                    <div className="empty">
                      <h3>No recipients for this quarter</h3>
                      <p>
                        Add recipients with their start dates, then they will appear
                        here even when their commission is $0.
                      </p>
                      <button onClick={() => navigate("Recipients")}>
                        Add a recipient
                      </button>
                    </div>
                  )}
              </section>
              <section className="panel attention">
                <span className="eyebrow">NEEDS ATTENTION</span>
                <h2>
                  {quarterlyReport?.blockedLines ?? 0} commission issue
                  {(quarterlyReport?.blockedLines ?? 0) === 1 ? "" : "s"}
                </h2>
                <p>
                  {quarterlyReport?.blockedLines
                    ? "Only rule-referenced unmatched lines, missing required costs, or rule conflicts block this period."
                    : "No commission-impacting issues block this reporting period."}
                </p>
                <small>
                  {quarterlyReport?.unmatchedLines ?? 0} unmatched order line{(quarterlyReport?.unmatchedLines ?? 0) === 1 ? "" : "s"} across {quarterlyReport?.unmatchedProducts ?? 0} distinct product{(quarterlyReport?.unmatchedProducts ?? 0) === 1 ? "" : "s"}; {quarterlyReport?.commissionRelevantUnmatchedLines ?? 0} affect active commission rules.
                </small>
                {!!quarterlyReport?.commissionRelevantUnmatchedLines && <button onClick={() => navigate("Unmatched products")}>
                  Review commission products →
                </button>}
              </section>
            </div>
            <div className="columns">
              <section className="panel">
                <h2>Sales by channel</h2>
                {(["shopify", "etsy", "faire"] as const).map((channel) => {
                  const amount = quarterlyReport?.salesByChannel[channel] ?? "0";
                  const gross = Number(quarterlyReport?.grossSales ?? 0);
                  return (
                    <div className="channel" key={channel}>
                      <div>
                        <span className="capitalize">{channel}</span>
                        <strong>{money(amount)}</strong>
                      </div>
                      <div className="bar">
                        <span
                          style={{
                            width: `${gross ? Math.min(100, (Number(amount) / gross) * 100) : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </section>
              <section className="panel">
                <h2>Quarter status</h2>
                <div className="summary-row">
                  <div className="grow">
                    <strong>Imported lines</strong>
                    <small>Shopify, Etsy, and Faire sales in this quarter</small>
                  </div>
                  <strong>{quarterlyReport?.orderLines ?? 0}</strong>
                </div>
                <div className="summary-row">
                  <div className="grow">
                    <strong>Lines needing review</strong>
                    <small>Only commission-relevant SKU gaps, required cost gaps, or rule conflicts</small>
                  </div>
                  <strong>{quarterlyReport?.blockedLines ?? 0}</strong>
                </div>
                <div className="summary-row">
                  <div className="grow">
                    <strong>Commission-eligible order lines</strong>
                    <small>Lines with an active rule for this quarter</small>
                  </div>
                  <strong>{quarterlyReport?.eligibleLines ?? 0}</strong>
                </div>
                <div className="summary-row">
                  <div className="grow">
                    <strong>Order lines with no commission rule</strong>
                    <small>Evaluated as $0 and do not require review</small>
                  </div>
                  <strong>{quarterlyReport?.matchedNoRuleLines ?? 0}</strong>
                </div>
              </section>
            </div>
          </>
        )}
        {page === "Analytics" && <Suspense fallback={<div className="panel empty">Loading analytics…</div>}><Analytics designs={cloudDesigns} /></Suspense>}
        {['Overview','Statements','Orders & imports','Connection'].includes(page) && (
          <section className="panel">
            <h2>Commission data coverage · Q{reportQuarter} {reportYear}</h2>
            <p>Official quarter: {reportDate(quarterRange(reportYear,reportQuarter).startsOn)} – {reportDate(quarterRange(reportYear,reportQuarter).endsOn)}</p>
            {quarterlyError && <div className="warning">{quarterlyError}</div>}
            {quarterlyReport?.finalization?.status==='open' && quarterlyReport.provisional && <div className="warning">Amounts are provisional through {reportDate(quarterlyReport.provisionalThrough)}. Newer sales may not yet be included. Sync the current period to bring every channel up to date.</div>}
            {quarterlyReport?.finalization?.status==='preliminary_sync_due' && <div className="warning">Quarter closed · Preliminary sync scheduled for {reportDate(quarterlyReport.finalization.preliminary_sync_date)}. The current amount remains visible.</div>}
            {quarterlyReport?.finalization?.status==='preliminary_sync_complete' && <div className="warning">Preliminary quarter sync complete · Final sync scheduled for {reportDate(quarterlyReport.finalization.scheduled_final_sync_date)}. Amounts remain provisional.</div>}
            {quarterlyReport?.finalization?.status==='final_sync_due' && <div className="warning">Final quarter sync is due and will run automatically.</div>}
            {quarterlyReport?.finalization?.status==='finalizing' && <div className="warning">{quarterlyReport.finalization.retry_stage==='preliminary'?'Preliminary':'Final'} quarter sync in progress. Provider progress is saved and will resume automatically if interrupted.</div>}
            {quarterlyReport?.finalization?.status==='retry_needed' && <div className="warning">{quarterlyReport.finalization.retry_stage==='preliminary'?'Preliminary':'Final'} quarter sync needs retry. It will retry automatically on the next scheduled run; you can also sync the provider rows below.</div>}
            {quarterlyReport?.finalization?.status==='finalized' && <p><strong>Finalized</strong> {new Date(quarterlyReport.finalization.finalized_at!).toLocaleString()}</p>}
            {!quarterlyReport?.coverageComplete && !quarterlyReport?.amountsAvailable && <div className="warning">There is not enough verified imported coverage to calculate this period reliably. Missing channels: {quarterlyReport?.coverage?.filter(c=>!c.complete).map(c=>platformLabel(c.channel as Line['channel'])).join(', ') || 'coverage not yet verified'}.</div>}
            {quarterlyReport?.coverageComplete && <p>All channels completely cover this reporting period. {quarterlyReport.endsOn >= todayDate() ? 'This quarter is still open; amounts remain provisional until it closes.' : 'Review unmatched products and missing costs before payment.'}</p>}
            {quarterlyReport?.coverage?.map(c=><div className="summary-row" key={c.channel}>
              <div className="grow"><strong>{platformLabel(c.channel as Line['channel'])} — Q{reportQuarter} {reportYear}</strong>
                <p>Quarter: {reportDate(quarterRange(reportYear,reportQuarter).startsOn)} – {reportDate(quarterRange(reportYear,reportQuarter).endsOn)}</p>
                <p>{c.complete ? 'Complete' : `Coverage pending · Last run: ${c.sync_status}`}</p>
                <p>Sync coverage through: {reportDate(c.coverage_through)} · Latest order: {reportDate(c.latest)}</p>
                <small>{c.order_count} orders in period · First order: {reportDate(c.earliest)} · Last successful sync: {c.last_success ? new Date(c.last_success).toLocaleString() : 'none'} · {c.failed_orders} failed orders</small>
              </div>
              <button disabled={shopifyBusy || etsyBusy || faireBusy || requestedSync().startDate>requestedSync().endDate} onClick={()=>void (c.channel==='shopify'?runShopify('sync'):c.channel==='etsy'?runEtsy('sync'):runFaire('sync'))}>Sync {platformLabel(c.channel as Line['channel'])} period</button>
            </div>)}
          </section>
        )}
        {sessionEmail && <HistoricalBackfill user={sessionEmail} show={['Overview','Statements','Orders & imports','Connection'].includes(page)} currentBusy={shopifyBusy || etsyBusy || faireBusy} onComplete={async()=>{await reloadCloudData();await refreshQuarterlyReport();}} />}
        {page === "Designs & SKUs" && (
          <>
            <section className="panel imported-product-picker">
              <div>
                <span className="eyebrow">FROM YOUR SALES CHANNELS</span>
                <h2>Select an imported product</h2>
                <p>
                  Its design name, SKU, and variant will be filled in for you.
                </p>
                <button
                  className="secondary"
                  disabled={shopifyBusy}
                  onClick={() => void refreshShopifyProducts()}
                >
                  {shopifyBusy ? "Syncing products…" : "Sync latest Shopify products"}
                </button>
              </div>
              <input
                type="search"
                aria-label="Search imported products"
                placeholder="Search product, SKU, variant, or channel"
                value={importedProductSearch}
                onChange={(event) => setImportedProductSearch(event.target.value)}
              />
              <select
                aria-label="Select an imported product"
                value={selectedImportedProduct?.key ?? ""}
                disabled={cloudLoading || importedProducts.length === 0}
                onChange={(event) => {
                  const product = importedProducts.find(
                    (item) => item.key === event.target.value,
                  );
                  chooseImportedProduct(product ?? null);
                }}
              >
                <option value="">
                  {importedProducts.length
                    ? "Choose a product / SKU"
                    : "Sync sales first to discover products"}
                </option>
                {visibleImportedProducts.map((product) => (
                  <option key={product.key} value={product.key}>
                    {product.channel.toUpperCase()} · {product.sku || "No SKU"} · {product.name}
                  </option>
                ))}
              </select>
              {importedProductSearch.trim() && (
                <div className="imported-search-results" role="listbox" aria-label="Imported product search results">
                  <small>
                    {visibleImportedProducts.length} matching product
                    {visibleImportedProducts.length === 1 ? "" : "s"}
                  </small>
                  {visibleImportedProducts.slice(0, 30).map((product) => (
                    <button
                      type="button"
                      className="imported-result"
                      key={product.key}
                      onClick={() => chooseImportedProduct(product)}
                    >
                      <span>
                        <strong>{product.name}</strong>
                        <small>{product.variant || "No variant"}</small>
                      </span>
                      <span>
                        <strong>{product.sku || "No SKU"}</strong>
                        <small>{product.channel.toUpperCase()}</small>
                      </span>
                    </button>
                  ))}
                  {visibleImportedProducts.length === 0 && (
                    <p>No imported products match that search.</p>
                  )}
                  {visibleImportedProducts.length > 30 && (
                    <small>Keep typing to narrow the results.</small>
                  )}
                </div>
              )}
            </section>
            <div className="toolbar">
              <input
                aria-label="Search designs"
                placeholder="Search name, family, or SKU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="Filter design status"
                value={active}
                onChange={(e) => setActive(e.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <button
                disabled={cloudLoading}
                onClick={() => {
                  setSelectedImportedProduct(null);
                  setEditDesign(null);
                  setShowDesign(true);
                }}
              >
                + Add design / SKU
              </button>
            </div>
            {showDesign && (
              <form
                className="panel form-grid"
                key={editDesign?.id ?? selectedImportedProduct?.key ?? "new"}
                onSubmit={saveDesign}
              >
                <Field label="Design name">
                  <input
                    name="name"
                    required
                    defaultValue={editDesign?.name ?? selectedImportedProduct?.name}
                  />
                </Field>
                <Field label="Product family">
                  <input name="family" defaultValue={editDesign?.family} />
                </Field>
                {!editDesign && (
                  <>
                    <Field label="First SKU (business identifier)">
                      <input
                        name="sku"
                        required
                        defaultValue={selectedImportedProduct?.sku}
                      />
                    </Field>
                    <Field label="Variant">
                      <input
                        name="variant"
                        defaultValue={selectedImportedProduct?.variant}
                      />
                    </Field>
                  </>
                )}
                <Field label="Notes">
                  <input name="notes" defaultValue={editDesign?.notes} />
                </Field>
                <div className="form-actions">
                  <button disabled={cloudLoading}>
                    {cloudLoading ? "Saving…" : "Save to Supabase"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setShowDesign(false);
                      setSelectedImportedProduct(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {skuDesign && (
              <form
                className="panel form-grid"
                key={editSku?.id ?? `new-${skuDesign.id}`}
                onSubmit={saveSku}
              >
                <div className="full">
                  <h2>{editSku ? "Edit SKU" : "Add another SKU"}</h2>
                  <p>{skuDesign.name}</p>
                </div>
                <Field label="SKU (business identifier)">
                  <input name="sku" required defaultValue={editSku?.sku} />
                </Field>
                <Field label="Variant">
                  <input name="variant" defaultValue={editSku?.variant} />
                </Field>
                <div className="form-actions">
                  <button disabled={cloudLoading}>
                    {cloudLoading ? "Saving…" : "Save SKU"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSkuDesign(null);
                      setEditSku(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Design</th>
                    <th>SKU / Variant</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cloudDesigns
                    .filter(
                      (d) =>
                        (active === "all" ||
                          d.active === (active === "active")) &&
                        `${d.name} ${d.family} ${d.skus
                          .map((sku) => `${sku.sku} ${sku.variant}`)
                          .join(" ")}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    )
                    .map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.name}</strong>
                          <small>{d.family}</small>
                          {d.notes && <small>{d.notes}</small>}
                        </td>
                        <td>
                          <div className="sku-list">
                            {d.skus.map((sku) => (
                              <div className="sku-line" key={sku.id}>
                                <div>
                                  <strong>{sku.sku}</strong>
                                  {sku.variant && <small>{sku.variant}</small>}
                                </div>
                                <Badge>
                                  {sku.active ? "Active" : "Inactive"}
                                </Badge>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setSkuDesign(d);
                                    setEditSku(sku);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="text-button"
                                  disabled={cloudLoading}
                                  onClick={() => void toggleSku(sku)}
                                >
                                  {sku.active ? "Deactivate" : "Reactivate"}
                                </button>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <Badge>{d.active ? "Active" : "Inactive"}</Badge>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => {
                              setEditDesign(d);
                              setShowDesign(true);
                            }}
                          >
                            Edit design
                          </button>
                          <button
                            className="text-button"
                            onClick={() => {
                              setSkuDesign(d);
                              setEditSku(null);
                            }}
                          >
                            Add SKU
                          </button>
                          <button
                            className="text-button"
                            disabled={cloudLoading}
                            onClick={() => void toggleDesign(d)}
                          >
                            {d.active ? "Deactivate" : "Reactivate"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  {!cloudLoading && cloudDesigns.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No designs yet. Add the first design and SKU above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        {page === "Recipients" && (
          <>
            <div className="toolbar">
              <p>Former recipients remain available in historical reports.</p>
              <button
                disabled={cloudLoading}
                onClick={() => {
                  setEditRecipient(null);
                  setShowRecipient(true);
                }}
              >
                + Add recipient
              </button>
            </div>
            {showRecipient && (
              <form
                className="panel form-grid"
                key={editRecipient?.id ?? "new"}
                onSubmit={saveRecipient}
              >
                <Field label="Name">
                  <input
                    name="name"
                    required
                    defaultValue={editRecipient?.name}
                  />
                </Field>
                <Field label="Start date">
                  <input
                    name="startsOn"
                    type="date"
                    required
                    defaultValue={editRecipient?.startsOn ?? today()}
                  />
                </Field>
                <Field label="End date (optional)">
                  <input
                    name="endsOn"
                    type="date"
                    defaultValue={editRecipient?.endsOn}
                  />
                </Field>
                <Field label="Notes">
                  <input name="notes" defaultValue={editRecipient?.notes} />
                </Field>
                <div className="form-actions">
                  <button disabled={cloudLoading}>
                    {cloudLoading ? "Saving…" : "Save to Supabase"}
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setShowRecipient(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <div className="panel">
              {cloudRecipients.map((r) => (
                <div className="summary-row" key={r.id}>
                  <div className="grow">
                    <h3>{r.name}</h3>
                    <small>
                      Since {r.startsOn}
                      {r.endsOn && ` · Until ${r.endsOn}`}
                    </small>
                    <p>{r.notes}</p>
                  </div>
                  <Badge>{r.active ? "Active" : "Inactive"}</Badge>
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditRecipient(r);
                      setShowRecipient(true);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="text-button"
                    disabled={cloudLoading}
                    onClick={() => void toggleRecipient(r)}
                  >
                    {r.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ))}
              {!cloudLoading && cloudRecipients.length === 0 && (
                <p className="empty">
                  No commission recipients yet. Add the first person above.
                </p>
              )}
            </div>
          </>
        )}
        {page === "Commission rules" && (
          <>
            <div className="toolbar">
              <p>Rules save to Supabase and feed the quarterly report.</p>
              <button
                disabled={cloudLoading || cloudRecipients.length === 0}
                onClick={() => {
                  setEditRule(null);
                  setManualCostsEnabled(false);
                  setRuleKind("adjusted_percentage");
                  setRuleSkuSearch("");
                  setShowRule(true);
                }}
              >
                + Create rule
              </button>
            </div>
            {showRule && (
              <form
                className="panel form-grid"
                key={editRule ? `${editRule.id}-${editRule.version}` : "new"}
                onSubmit={saveRule}
              >
                <Field label="Rule name">
                  <input name="name" required defaultValue={editRule?.name} />
                </Field>
                <Field label="Recipient">
                  <select
                    name="recipientId"
                    defaultValue={editRule?.recipientId}
                  >
                    {cloudRecipients.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Calculation">
                  <select
                    value={ruleKind}
                    onChange={(e) =>
                      setRuleKind(e.target.value as Rule["kind"])
                    }
                  >
                    <option value="adjusted_percentage">
                      Percentage of adjusted revenue
                    </option>
                    <option value="percentage">
                      Percentage of gross revenue
                    </option>
                    <option value="fixed">Fixed dollars per unit</option>
                  </select>
                </Field>
                <Field
                  label={
                    ruleKind === "fixed" ? "Dollars per unit" : "Percentage"
                  }
                >
                  <input
                    name="rate"
                    inputMode="decimal"
                    required
                    defaultValue={editRule?.rate ?? ""}
                  />
                </Field>
                <Field label="Effective start">
                  <input
                    name="startsOn"
                    type="date"
                    required
                    defaultValue={editRule?.startsOn ?? today()}
                  />
                </Field>
                <Field label="Effective end (inclusive)">
                  <input
                    name="endsOn"
                    type="date"
                    defaultValue={editRule?.endsOn ?? ""}
                  />
                </Field>
                <Field label="Priority (higher wins)">
                  <input
                    name="priority"
                    type="number"
                    step="1"
                    required
                    defaultValue={editRule?.priority ?? 10}
                  />
                </Field>
                <Field label="Status">
                  <select
                    name="active"
                    defaultValue={editRule?.active === false ? "no" : "yes"}
                  >
                    <option value="yes">Active</option>
                    <option value="no">Inactive</option>
                  </select>
                </Field>
                <Field label="SKU conditions (select all that earn this commission)">
                  <input
                    type="search"
                    placeholder="Search SKUs or design names"
                    value={ruleSkuSearch}
                    onChange={(event) => setRuleSkuSearch(event.target.value)}
                  />
                  <div className="sku-condition-list">
                    {cloudDesigns.flatMap((design) =>
                      design.skus
                        .filter((sku) =>
                          `${sku.sku} ${design.name} ${sku.variant}`
                            .toLowerCase()
                            .includes(ruleSkuSearch.trim().toLowerCase()),
                        )
                        .map((sku) => {
                          const selected = editRule?.conditions.sku;
                          const selectedSkus = Array.isArray(selected)
                            ? selected
                            : selected
                              ? [selected]
                              : [];
                          return (
                            <label className="checkbox sku-choice" key={sku.id}>
                              <input
                                type="checkbox"
                                name="sku"
                                value={sku.sku}
                                defaultChecked={selectedSkus.includes(sku.sku)}
                              />
                              <span>
                                <strong>{sku.sku}</strong>
                                <small>{design.name}{sku.variant ? ` · ${sku.variant}` : ""}</small>
                              </span>
                            </label>
                          );
                        }),
                    )}
                  </div>
                  <small>Leave every SKU unchecked to apply the rule to any SKU.</small>
                </Field>
                <Field label="Design condition">
                  <select
                    name="designId"
                    defaultValue={editRule?.conditions.designId ?? ""}
                  >
                    <option value="">Any design</option>
                    {cloudDesigns.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Channel condition">
                  <select
                    name="channel"
                    defaultValue={editRule?.conditions.channel ?? ""}
                  >
                    <option value="">Any channel</option>
                    {["shopify", "etsy", "faire"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Retail / wholesale">
                  <select
                    name="market"
                    defaultValue={editRule?.conditions.market ?? ""}
                  >
                    <option value="">Either</option>
                    <option>retail</option>
                    <option>wholesale</option>
                  </select>
                </Field>
                <Field label="Order source (exact match)">
                  <input
                    name="source"
                    defaultValue={editRule?.conditions.source}
                  />
                </Field>
                <Field label="Referral (exact match)">
                  <input
                    name="referral"
                    defaultValue={editRule?.conditions.referral}
                  />
                </Field>
                <Field label="Units after refunds">
                  <select
                    name="refundPolicy"
                    defaultValue={editRule?.refundPolicy ?? "net_units"}
                  >
                    <option value="net_units">Subtract refunded units</option>
                    <option value="sold_units">Keep original sold units</option>
                  </select>
                </Field>
                <Field label="Notes">
                  <input
                    name="notes"
                    defaultValue={editRule?.notes ?? ""}
                  />
                </Field>
                {ruleKind === "adjusted_percentage" && (
                  <fieldset className="full">
                    <legend>Deduct before calculating commission</legend>
                    {costKeys.map((k) => (
                      <label className="checkbox" key={k === "shipping" || k === "otherCosts" ? `${k}-${manualCostsEnabled}` : k}>
                        <input
                          type="checkbox"
                          name={k}
                          disabled={manualCostsEnabled && (k === "shipping" || k === "otherCosts")}
                          defaultChecked={!(manualCostsEnabled && (k === "shipping" || k === "otherCosts")) && editRule?.deductions.includes(k)}
                        />
                        {k.replace(/([A-Z])/g, " $1")}
                      </label>
                    ))}
                    <label className="checkbox">
                      <input type="checkbox" checked={manualCostsEnabled} onChange={e => setManualCostsEnabled(e.target.checked)} />
                      Manually enter amounts per order
                    </label>
                    {manualCostsEnabled && <div className="form-grid">
                      <Field label="Shipping per order (USD)">
                        <input name="manualShipping" type="number" min="0" step="0.01" required defaultValue={editRule?.manualOrderCosts?.shipping ?? "0.00"} />
                      </Field>
                      <Field label="Other costs per order (USD)">
                        <input name="manualOtherCosts" type="number" min="0" step="0.01" required defaultValue={editRule?.manualOrderCosts?.otherCosts ?? "0.00"} />
                      </Field>
                      <p className="full muted">Deducted once per order for this rule, shared across its matching items. These amounts replace imported shipping and other costs. For example, $5 shipping stays $5 for an order with three matching items.</p>
                    </div>}
                  </fieldset>
                )}
                <div className="form-actions full">
                  <button disabled={cloudLoading}>
                    {cloudLoading ? "Saving…" : "Save rule version"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShowRule(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <div className="panel">
              {currentRules.map((r) => (
                <div className="rule-row" key={r.id}>
                  <div className="grow">
                    <h3>
                      {r.name} <Badge>v{r.version}</Badge>
                    </h3>
                    {r.manualOrderCosts && <p>Manual deductions per order: {money(r.manualOrderCosts.shipping)} shipping + {money(r.manualOrderCosts.otherCosts)} other costs.</p>}
                    <p>
                      {
                        cloudRecipients.find((p) => p.id === r.recipientId)
                          ?.name
                      }{" "}
                      · {r.conditions.channel ?? "All channels"} ·{" "}
                      {Array.isArray(r.conditions.sku)
                        ? `${r.conditions.sku.length} SKUs`
                        : r.conditions.sku ?? "All SKUs"}
                    </p>
                    <small>
                      {r.startsOn} → {r.endsOn ?? "No end date"} · Priority{" "}
                      {r.priority} · {r.active ? "Active" : "Inactive"}
                    </small>
                  </div>
                  <div className="rate">
                    {r.kind === "fixed"
                      ? `${money(r.rate)} / unit`
                      : `${r.rate}%`}
                    <small>{r.kind.replaceAll("_", " ")}</small>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditRule(r);
                      setManualCostsEnabled(Boolean(r.manualOrderCosts));
                      setRuleKind(r.kind);
                      setRuleSkuSearch("");
                      setShowRule(true);
                    }}
                  >
                    New version
                  </button>
                  <button
                    className="danger-button"
                    disabled={cloudLoading}
                    onClick={() => void removeRule(r)}
                  >
                    Delete
                  </button>
                </div>
              ))}
              {!cloudLoading && currentRules.length === 0 && (
                <div className="empty">
                  <h3>No commission rules yet</h3>
                  <p>Add a recipient first, then create their commission rule.</p>
                </div>
              )}
            </div>
          </>
        )}
        {false && page === "Orders & imports" && (
          <>
            <div className="toolbar">
              <p>Shopify, Etsy, and Faire are not connected yet.</p>
              <button
                onClick={() => {
                  const result = importBatch(state.lines, sampleLines());
                  change((s) => {
                    s.lines = result.lines;
                    s.imports.push({
                      date: today(),
                      message: `Demo import: ${result.lines.length - state.lines.length} added, ${result.duplicates} duplicates skipped, ${result.conflicts.length} source changes flagged`,
                    });
                  });
                  setNotice(
                    "Demo import complete. See the import log for results.",
                  );
                }}
              >
                Import demo orders again
              </button>
            </div>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Channel</th>
                    <th>SKU</th>
                    <th>Units</th>
                    <th>Gross sales</th>
                  </tr>
                </thead>
                <tbody>
                  {state.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.externalOrderId}
                        <small>{l.date}</small>
                      </td>
                      <td className="capitalize">{l.channel}</td>
                      <td>{l.sku ?? <Badge>Needs matching</Badge>}</td>
                      <td>{l.quantity}</td>
                      <td>{money(calculateGross(l.unitPrice, l.quantity))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <section className="panel">
              <h2>Import log</h2>
              {state.imports
                .slice()
                .reverse()
                .map((r, i) => (
                  <p key={i}>
                    {r.date} · {r.message}
                  </p>
                ))}
            </section>
          </>
        )}
        {false && page === "Unmatched products" && (
          <section className="panel">
            <h2>Match products to your internal SKUs</h2>
            <p>Selections are explicit. No product names are guessed.</p>
            {state.lines
              .filter((l) => !l.sku)
              .map((l) => (
                <form
                  className="match-row"
                  key={l.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const sku = input(e.currentTarget, "sku");
                    const d = state.designs.find((d) => d.sku === sku);
                    if (!d) return;
                    change((s) => {
                      const target = s.lines.find((x) => x.id === l.id)!;
                      target.sku = d.sku;
                      target.designId = d.id;
                      s.mappings[
                        `${l.channel}:${l.externalOrderId}:${l.externalLineId}`
                      ] = d.sku;
                    });
                    setNotice(
                      "Demo line matched. Production mappings use platform product or variant IDs.",
                    );
                  }}
                >
                  <div className="grow">
                    <strong>{l.externalOrderId}</strong>
                    <small>
                      {l.channel} · External line {l.externalLineId} ·{" "}
                      {l.quantity} unit(s)
                    </small>
                  </div>
                  <select
                    name="sku"
                    required
                    aria-label={`SKU for ${l.externalOrderId}`}
                  >
                    <option value="">Choose internal SKU</option>
                    {state.designs.map((d) => (
                      <option key={d.sku} value={d.sku}>
                        {d.name} — {d.sku}
                      </option>
                    ))}
                  </select>
                  <button>Save match</button>
                </form>
              ))}
            {!state.lines.some((l) => !l.sku) && (
              <div className="empty">
                <h3>Every imported product is matched</h3>
                <p>Your demo orders are ready for commission review.</p>
                <button onClick={() => navigate("Statements")}>
                  Review statements →
                </button>
              </div>
            )}
          </section>
        )}
        {false && page === "Statements" && (
          <>
            <div className="toolbar no-print">
              <Field label="Commission period">
                <select
                  value={period.id}
                  onChange={(e) => setPeriodId(e.target.value)}
                >
                  {state.periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Recipient">
                <select
                  value={recipientFilter}
                  onChange={(e) => setRecipientFilter(e.target.value)}
                >
                  <option value="">All recipients</option>
                  {state.recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {recipientName(r.id)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Channel">
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                >
                  <option value="">All channels</option>
                  {["shopify", "etsy", "faire"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="SKU">
                <select
                  value={skuFilter}
                  onChange={(e) => setSkuFilter(e.target.value)}
                >
                  <option value="">All SKUs</option>
                  {state.designs.map((d) => (
                    <option key={d.sku}>{d.sku}</option>
                  ))}
                </select>
              </Field>
            </div>
            <details className="panel no-print">
              <summary>Create a custom period</summary>
              <form
                className="form-grid"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  report(() => {
                    const start = input(f, "start"),
                      end = input(f, "end");
                    if (end < start)
                      throw new Error("End date must follow start date.");
                    if (
                      state.periods.some(
                        (p) => start <= p.endsOn && end >= p.startsOn,
                      )
                    )
                      throw new Error(
                        "Periods cannot overlap in this foundation.",
                      );
                    const id = uid();
                    change((s) =>
                      s.periods.push({
                        id,
                        name: input(f, "name"),
                        startsOn: start,
                        endsOn: end,
                        status: "draft",
                        snapshot: [],
                        adjustments: [],
                        recipientNames: {},
                        payments: [],
                      }),
                    );
                    setPeriodId(id);
                  });
                }}
              >
                <Field label="Name">
                  <input name="name" required />
                </Field>
                <Field label="Start">
                  <input type="date" name="start" required />
                </Field>
                <Field label="End">
                  <input type="date" name="end" required />
                </Field>
                <button>Create draft</button>
              </form>
            </details>
            <section className="panel statement">
              <div className="section-title">
                <div>
                  <div className="eyebrow">LE CHIC MIAMI · DEMO STATEMENT</div>
                  <h2>
                    {recipientFilter
                      ? recipientName(recipientFilter)
                      : "All recipients"}{" "}
                    · {period.name}
                  </h2>
                  <p>
                    {period.startsOn} through {period.endsOn}
                  </p>
                </div>
                <Badge>{period.status}</Badge>
              </div>
              {!frozen && blockers.length > 0 && (
                <div className="warning no-print">
                  <strong>Review needed before finalization</strong>
                  {blockers.map((b) => (
                    <p key={b}>{b}</p>
                  ))}
                </div>
              )}
              <div className="statement-total">
                <span>
                  {channelFilter || skuFilter
                    ? "Filtered commission subtotal"
                    : "Total commission and adjustments"}
                </span>
                <strong>
                  {money(
                    channelFilter || skuFilter
                      ? filteredCommission
                      : total([
                          filteredCommission,
                          ...adjustments.map((a) => a.amount),
                        ]),
                  )}
                </strong>
              </div>
              <p className="muted">
                {channelFilter || skuFilter
                  ? "Adjustments are period-level and excluded from this filtered subtotal."
                  : "Click a calculation to see its source amounts and rule snapshot."}
              </p>
              {filtered.map((c) => (
                <details
                  className="calculation"
                  key={`${c.lineId}-${c.recipientId}`}
                >
                  <summary>
                    <span>
                      <strong>{c.lineSnapshot.sku}</strong>
                      <small>
                        {recipientName(c.recipientId)} ·{" "}
                        {c.lineSnapshot.externalOrderId} ·{" "}
                        {c.lineSnapshot.channel}
                      </small>
                    </span>
                    <strong>{money(c.commission)}</strong>
                  </summary>
                  <div className="audit-grid">
                    <span>Units</span>
                    <b>{c.units}</b>
                    <span>Gross product revenue</span>
                    <b>{money(c.gross)}</b>
                    <span>Selected deductions</span>
                    <b>−{money(c.deducted)}</b>
                    {c.ruleSnapshot.deductions.map((k) => (
                      <span className="full" key={k}>
                        {k}: {money(c.lineSnapshot.costs[k] ?? "0")}
                      </span>
                    ))}
                    {c.manualDeductions && <>
                      <span>Manual shipping (this item’s share)</span><b>−{money(c.manualDeductions.shipping)}</b>
                      <span>Manual other costs (this item’s share)</span><b>−{money(c.manualDeductions.otherCosts)}</b>
                    </>}
                    <span>Commissionable revenue</span>
                    <b>{money(c.basis)}</b>
                    <span>Rate / rule</span>
                    <b>
                      {c.ruleSnapshot.rate}
                      {c.ruleSnapshot.kind === "fixed" ? " USD/unit" : "%"} · v
                      {c.ruleSnapshot.version}
                    </b>
                    <span>Engine</span>
                    <b>{c.engineVersion}</b>
                  </div>
                </details>
              ))}
              {!filtered.length && (
                <p>No matching calculations in this view.</p>
              )}
              {adjustments.length > 0 && (
                <>
                  <h3>Period adjustments</h3>
                  {adjustments.map((a) => (
                    <p key={a.id}>
                      {recipientName(a.recipientId)} · {a.reason} ·{" "}
                      {money(a.amount)}{" "}
                      <small>
                        {a.date} · {a.createdBy}
                      </small>
                    </p>
                  ))}
                </>
              )}
              <div className="form-actions no-print">
                <button
                  className="secondary"
                  onClick={() =>
                    csvExport([
                      ["DEMO ONLY — Not a payment statement"],
                      [
                        "Recipient",
                        "Order",
                        "SKU",
                        "Channel",
                        "Units",
                        "Basis USD",
                        "Commission USD",
                      ],
                      ...filtered.map((c) => [
                        recipientName(c.recipientId),
                        c.lineSnapshot.externalOrderId,
                        c.lineSnapshot.sku ?? "",
                        c.lineSnapshot.channel,
                        String(c.units),
                        c.basis,
                        c.commission,
                      ]),
                      ...(!channelFilter && !skuFilter
                        ? adjustments.map((a) => [
                            recipientName(a.recipientId),
                            "Adjustment",
                            a.reason,
                            "",
                            "",
                            "",
                            a.amount,
                          ])
                        : []),
                    ])
                  }
                >
                  Export CSV
                </button>
                <button className="secondary" onClick={() => window.print()}>
                  Print / Save as PDF
                </button>
                {period.status === "draft" && (
                  <button onClick={() => setPeriodStatus("reviewed")}>
                    Mark reviewed
                  </button>
                )}
                {period.status === "reviewed" && (
                  <button onClick={() => setPeriodStatus("finalized")}>
                    Finalize demo period
                  </button>
                )}
              </div>
            </section>
            {!frozen && (
              <details className="panel no-print">
                <summary>Add a manual adjustment</summary>
                <form
                  className="form-grid"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = e.currentTarget;
                    report(() => {
                      const amount = input(f, "amount");
                      if (
                        !/^-?\d+(\.\d{1,2})?$/.test(amount) ||
                        Number(amount) === 0
                      )
                        throw new Error(
                          "Enter a nonzero amount with at most two decimals.",
                        );
                      change((s) => {
                        const p = s.periods.find((p) => p.id === period.id)!;
                        p.status = "draft";
                        p.adjustments.push({
                          id: uid(),
                          recipientId: input(f, "recipientId"),
                          amount,
                          date: input(f, "date"),
                          reason: input(f, "reason"),
                          notes: input(f, "notes"),
                          createdBy: "Demo admin",
                        });
                      });
                      setNotice("Demo adjustment added.");
                      f.reset();
                    });
                  }}
                >
                  <Field label="Recipient">
                    <select name="recipientId">
                      {state.recipients.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount USD (negative for deductions)">
                    <input name="amount" required inputMode="decimal" />
                  </Field>
                  <Field label="Date">
                    <input
                      name="date"
                      type="date"
                      defaultValue={today()}
                      required
                    />
                  </Field>
                  <Field label="Reason">
                    <input name="reason" required />
                  </Field>
                  <Field label="Notes">
                    <input name="notes" />
                  </Field>
                  <button>Save demo adjustment</button>
                </form>
              </details>
            )}
          </>
        )}
        {page === "Orders & imports" && (
          <>
            <section className="panel">
              <div className="section-title">
                <div>
                  <h2>Sync live orders</h2>
                  <p>Sync Q{reportQuarter} {reportYear}: {requestedSync().startDate} through {requestedSync().endDate}. Every page continues automatically; keep this page open. Choose a different quarter in Overview.</p>
                </div>
                <button className="secondary" onClick={() => navigate("Connection")}>Connection settings</button>
              </div>
              <div className="summary-row">
                <div className="grow">
                  <strong>Shopify</strong>
                  <small>{connectionLabel(shopifyStatus?.connected, shopifyBusy)}</small>
                </div>
                <button disabled={shopifyBusy || !shopifyStatus?.connected} onClick={() => void runShopify("sync")}>
                  {shopifyBusy ? "Syncing…" : shopifyStatus?.moreAvailable ? "Resume period sync" : "Sync commission period"}
                </button>
              </div>
              <div className="summary-row">
                <div className="grow">
                  <strong>Etsy</strong>
                  <small>{connectionLabel(etsyStatus?.connected, etsyBusy)}</small>
                </div>
                <button disabled={etsyBusy || !etsyStatus?.connected} onClick={() => void runEtsy("sync")}>
                  {etsyBusy ? "Syncing…" : etsyStatus?.moreAvailable ? "Resume period sync" : "Sync commission period"}
                </button>
              </div>
              <div className="summary-row">
                <div className="grow">
                  <strong>Faire</strong>
                  <small>{connectionLabel(faireStatus?.connected, faireBusy)}</small>
                </div>
                <button disabled={faireBusy || !faireStatus?.connected} onClick={() => void runFaire("sync")}>
                  {faireBusy ? "Syncing…" : faireStatus?.moreAvailable ? "Resume period sync" : "Sync commission period"}
                </button>
              </div>
            </section>
            <section className="panel">
              <h2>Imported data for Q{reportQuarter} {reportYear}</h2>
              <div className="metrics compact-metrics">
                <article>
                  <span>Order lines</span>
                  <strong>{quarterlyReport?.orderLines ?? 0}</strong>
                </article>
                <article>
                  <span>Product sales</span>
                  <strong>{money(quarterlyReport?.grossSales ?? "0")}</strong>
                </article>
                <article>
                  <span>Products to match</span>
                  <strong>{importedProducts.length}</strong>
                </article>
              </div>
              {importedProducts.length > 0 && (
                <button onClick={() => navigate("Designs & SKUs")}>Select imported products →</button>
              )}
            </section>
          </>
        )}
        {page === "Unmatched products" && (
          <section className="panel">
            <div className="section-title">
              <div>
                <h2>Match imported products</h2>
                <p>Exact SKU matches, saved aliases, and existing mappings resolve automatically. Only unresolved products appear below.</p>
                <button className="secondary" disabled={cloudLoading} onClick={()=>void reloadCloudData()}>Refresh matching</button>
              </div>
            </div>
            <Field label="Search unmatched products">
              <input value={unmatchedSearch} placeholder="Product, source SKU, or platform" onChange={event=>{setUnmatchedSearch(event.target.value);setUnmatchedLimit(25);}} />
            </Field>
            {importedProducts.filter(product=>`${product.name} ${product.sourceSkus.join(' ')} ${product.channel} ${product.variant ?? ''}`.toLowerCase().includes(unmatchedSearch.trim().toLowerCase())).slice(0,unmatchedLimit).map((product) => (
              <form
                className="match-row"
                key={product.key}
                onSubmit={(event) => void matchImportedProduct(event, product)}
              >
                <div className="grow">
                  <strong>{product.name}</strong>
                  <small>
                    {product.channel} · Source SKU: {product.sourceSkus.join(', ') || "not supplied"} · {product.variant || "No variant"} · {product.orderLines} order line{product.orderLines === 1 ? "" : "s"}
                  </small>
                  <small>{product.matchReason}</small>
                </div>
                <select name="skuId" required aria-label={`Internal SKU for ${product.name}`}>
                  <option value="">Choose existing SKU</option>
                  {cloudDesigns.filter(design=>design.active).flatMap((design) =>
                    design.skus.filter(sku=>sku.active).map((sku) => (
                      <option key={sku.id} value={sku.id}>{design.name} — {sku.sku}</option>
                    )),
                  )}
                </select>
                <button disabled={cloudLoading}>Save match</button>
                <button type="button" className="secondary" onClick={() => createFromImportedProduct(product)}>
                  Create design
                </button>
              </form>
            ))}
            {importedProducts.filter(product=>`${product.name} ${product.sourceSkus.join(' ')} ${product.channel} ${product.variant ?? ''}`.toLowerCase().includes(unmatchedSearch.trim().toLowerCase())).length > unmatchedLimit && <button className="secondary" onClick={()=>setUnmatchedLimit(limit=>limit+25)}>Show 25 more products</button>}
            {!cloudLoading && importedProducts.length === 0 && (
              <div className="empty">
                <h3>Every imported product is matched</h3>
                <p>Sync orders again whenever new products are added to a sales channel.</p>
                <button onClick={() => navigate("Overview")}>View quarterly commissions →</button>
              </div>
            )}
            <details>
              <summary>Resolved products ({matchedProducts.length})</summary>
              {matchedProducts.map(product=><div className="summary-row" key={product.key}>
                <div className="grow"><strong>{product.name}</strong><small>{product.channel} · Source SKU: {product.sourceSkus.join(', ') || 'not supplied'} → Internal SKU: {product.matchedSku}</small></div>
                <Badge>{product.matchMethod}</Badge>
              </div>)}
            </details>
          </section>
        )}
        {page === "Statements" && (
          <>
            <div className="quarter-controls panel no-print">
              <div>
                <span className="eyebrow">LIVE COMMISSION REPORT</span>
                <h2>Q{reportQuarter} {reportYear}</h2>
                <small>{quarterlyReport?.startsOn} through {quarterlyReport?.endsOn}</small>
              </div>
              <Field label="Year">
                <select value={reportYear} onChange={(event) => setReportYear(Number(event.target.value))}>
                  {Array.from({ length: 7 }, (_, index) => currentYear + 1 - index).map((year) => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
              </Field>
              <Field label="Quarter">
                <select value={reportQuarter} onChange={(event) => setReportQuarter(Number(event.target.value))}>
                  <option value={1}>Q1 · Jan–Mar</option>
                  <option value={2}>Q2 · Apr–Jun</option>
                  <option value={3}>Q3 · Jul–Sep</option>
                  <option value={4}>Q4 · Oct–Dec</option>
                </select>
              </Field>
              <button className="secondary" disabled={quarterlyLoading} onClick={() => void refreshQuarterlyReport()}>
                {quarterlyLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <section className="panel statement">
              <div className="section-title">
                <div>
                  <div className="eyebrow">LE CHIC MIAMI · COMMISSIONS</div>
                  <h2>All recipients · Q{reportQuarter} {reportYear}</h2>
                </div>
                <Badge>Live</Badge>
              </div>
              {(quarterlyReport?.blockedLines ?? 0) > 0 && (
                <div className="warning">
                  {quarterlyReport?.blockedLines} commission-impacting line{quarterlyReport?.blockedLines === 1 ? "" : "s"} need a rule-referenced SKU match, required cost value, or rule-conflict resolution before payment.
                </div>
              )}
              <div className="statement-total">
                <span>Total commissions</span>
                <strong>{quarterlyReport?.amountsAvailable ? money(quarterlyReport.commissionTotal) : "Awaiting sync"}</strong>
              </div>
              {quarterlyReport?.recipients.map((recipient) => (
                <details className="recipient-statement" key={recipient.id}>
                  <summary className="summary-row">
                    <div className="avatar">{recipient.name.slice(0, 1).toUpperCase()}</div>
                    <div className="grow">
                      <strong>{recipient.name}</strong>
                      <small>
                        {recipient.eligibleLines} eligible order line{recipient.eligibleLines === 1 ? "" : "s"}
                        {recipient.blockedLines ? ` · ${recipient.blockedLines} need review` : ""}
                      </small>
                    </div>
                    <strong>{quarterlyReport?.amountsAvailable ? money(recipient.commission) : 'Awaiting sync'}</strong>
                  </summary>
                  <div className="recipient-statement-body">
                    <div className="statement-meta">
                      <span><b>Recipient</b>{recipient.name}</span>
                      <span><b>Period</b>Q{reportQuarter} {reportYear}</span>
                      <span><b>Dates</b>{quarterlyReport.startsOn} through {quarterlyReport.endsOn}</span>
                      <span><b>Total</b>{quarterlyReport?.amountsAvailable ? money(recipient.commission) : 'Awaiting sync'}</span>
                    </div>
                    {recipient.calculations.map((calculation) => (
                      <details className="calculation" key={`${calculation.lineId}-${calculation.recipientId}`}>
                        <summary>
                          <span>
                            <strong>{calculation.lineSnapshot.productName ?? calculation.lineSnapshot.sku ?? "Imported item"}</strong>
                            <small>
                              {calculation.lineSnapshot.date} · {calculation.lineSnapshot.externalOrderId} · {platformLabel(calculation.lineSnapshot.channel)} · SKU {calculation.lineSnapshot.sku ?? "not supplied"}
                            </small>
                          </span>
                          <strong>{money(calculation.commission)}</strong>
                        </summary>
                        <div className="audit-grid">
                          <span>Date</span><b>{calculation.lineSnapshot.date}</b>
                          <span>Platform</span><b>{platformLabel(calculation.lineSnapshot.channel)}</b>
                          <span>Order</span><b>{calculation.lineSnapshot.externalOrderId}</b>
                          <span>Item / SKU</span><b>{calculation.lineSnapshot.productName ?? "Imported item"} · {calculation.lineSnapshot.sku ?? "No SKU"}</b>
                          <span>Quantity × item price</span><b>{calculation.lineSnapshot.quantity} × {money(calculation.lineSnapshot.unitPrice)}</b>
                          <span>Gross item sales</span><b>{money(calculation.gross)}</b>
                          {calculation.ruleSnapshot.deductions.map((key) => (
                            <span className="audit-deduction" key={key}>
                              <span>− {costLabel[key]}</span>
                              <b>{calculation.lineSnapshot.costs[key] == null ? "Needs review" : money(calculation.lineSnapshot.costs[key]!)}</b>
                            </span>
                          ))}
                          {calculation.manualDeductions && <>
                            <span>− Manual shipping share</span><b>{money(calculation.manualDeductions.shipping)}</b>
                            <span>− Manual other-cost share</span><b>{money(calculation.manualDeductions.otherCosts)}</b>
                          </>}
                          <span>Total deductions</span><b>−{money(calculation.deducted)}</b>
                          <span>Commissionable amount</span><b>{money(calculation.basis)}</b>
                          <span>Rule</span><b>{calculation.ruleSnapshot.name} · version {calculation.ruleSnapshot.version}</b>
                          <span>Calculation</span><b>{calculationFormula(calculation)}</b>
                        </div>
                      </details>
                    ))}
                    {!recipient.calculations.length && <p className="muted">No eligible sales for this recipient in this quarter.</p>}
                  </div>
                </details>
              ))}
              {!quarterlyLoading && quarterlyReport?.recipients.length === 0 && (
                <p className="empty">No recipients are active in this quarter.</p>
              )}
              <div className="form-actions no-print">
                <button
                  className="secondary"
                  disabled={!quarterlyReport?.coverageComplete}
                  onClick={() =>
                    csvExport([
                      ["Recipient", "Date", "Order", "Platform", "Item", "SKU", "Quantity", "Unit price USD", "Gross USD", "Discounts USD", "Refunds USD", "Shipping USD", "Platform fees USD", "Platform commissions USD", "Other costs USD", "Manual shipping share USD", "Manual other-cost share USD", "Total deductions USD", "Commissionable USD", "Rule", "Rate", "Commission USD"],
                      ...(quarterlyReport?.recipients ?? []).flatMap((recipient) =>
                        recipient.calculations.map((calculation) => [
                          recipient.name,
                          calculation.lineSnapshot.date,
                          calculation.lineSnapshot.externalOrderId,
                          calculation.lineSnapshot.channel,
                          calculation.lineSnapshot.productName ?? "",
                          calculation.lineSnapshot.sku ?? "",
                          String(calculation.lineSnapshot.quantity),
                          calculation.lineSnapshot.unitPrice,
                          calculation.gross,
                          calculation.lineSnapshot.costs.discounts ?? "",
                          calculation.lineSnapshot.costs.refunds ?? "",
                          calculation.lineSnapshot.costs.shipping ?? "",
                          calculation.lineSnapshot.costs.platformFees ?? "",
                          calculation.lineSnapshot.costs.platformCommissions ?? "",
                          calculation.lineSnapshot.costs.otherCosts ?? "",
                          calculation.manualDeductions?.shipping ?? "",
                          calculation.manualDeductions?.otherCosts ?? "",
                          calculation.deducted,
                          calculation.basis,
                          calculation.ruleSnapshot.name,
                          calculation.ruleSnapshot.rate,
                          calculation.commission,
                        ]),
                      ),
                    ])
                  }
                >
                  Export CSV
                </button>
                <button className="secondary" disabled={!quarterlyReport?.coverageComplete} onClick={() => window.print()}>Print / Save as PDF</button>
              </div>
            </section>
          </>
        )}
        {page === "Connection" && (
          <>
            <section className="panel">
              <h2>Supabase connection</h2>
              <p>
                All workspace data is stored in the private Le Chic Commissions
                Supabase project.
              </p>
              {!supabase ? (
                <div className="warning">
                  No Supabase project is configured. The database migration and
                  Auth client are included with the foundation.
                </div>
              ) : sessionEmail ? (
                <>
                  <p>Signed in as {sessionEmail}</p>
                  <div className="form-actions">
                    <button
                      onClick={async () => {
                        const { data, error } = await supabase!
                          .from("admin_members")
                          .select("user_id");
                        setCloudMessage(
                          error
                            ? error.message
                            : data.length
                              ? "Your account is an authorized admin."
                              : "Signed in, but this account is not an authorized admin.",
                        );
                      }}
                    >
                      Check admin access
                    </button>
                    <button className="secondary" onClick={signOut}>
                      Sign out
                    </button>
                  </div>
                </>
              ) : (
                <form
                  className="form-grid"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = e.currentTarget;
                    const { error } = await supabase!.auth.signInWithPassword({
                      email: input(f, "email"),
                      password: input(f, "password"),
                    });
                    setCloudMessage(error ? error.message : "Signed in.");
                  }}
                >
                  <Field label="Email">
                    <input
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                    />
                  </Field>
                  <Field label="Password">
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </Field>
                  <button>Sign in</button>
                </form>
              )}
              {cloudMessage && <p role="status">{cloudMessage}</p>}
            </section>
            <section className="panel">
              <h2>Integration readiness</h2>
              <div className="summary-row">
                <div className="grow">
                  <strong>Shopify</strong>
                  <small>
                    {shopifyStatus?.connected
                      ? `${shopifyStatus.shop} · ${shopifyStatus.domain ?? "secure Admin API"}`
                      : shopifyStatus?.message ?? "Secure connector is ready for Shopify credentials."}
                  </small>
                  {shopifyStatus?.connected && shopifyStatus.message && <small role="status">{shopifyStatus.message}</small>}
                </div>
                <Badge>{connectionLabel(shopifyStatus?.connected, shopifyBusy)}</Badge>
                <button className="secondary" disabled={shopifyBusy} onClick={() => void runShopify("check")}>
                  {shopifyBusy ? "Checking…" : "Check connection"}
                </button>
                <button disabled={shopifyBusy || !shopifyStatus?.connected} onClick={() => void runShopify("sync")}>
                  {shopifyStatus?.moreAvailable ? "Resume period sync" : "Sync commission period"}
                </button>
              </div>
              <div className="summary-row">
                <div className="grow">
                  <strong>Etsy</strong>
                  <small>
                    {etsyStatus?.connected
                      ? `${etsyStatus.shop} · secure OAuth connection`
                      : etsyStatus?.message ?? "Secure OAuth connector is ready for Etsy app credentials."}
                  </small>
                </div>
                <Badge>{connectionLabel(etsyStatus?.connected, etsyBusy)}</Badge>
                <button className="secondary" disabled={etsyBusy} onClick={() => void runEtsy("check")}>
                  {etsyBusy ? "Checking…" : "Check connection"}
                </button>
                {etsyStatus?.connected ? (
                  <button disabled={etsyBusy} onClick={() => void runEtsy("sync")}>
                    {etsyStatus.moreAvailable ? "Resume period sync" : "Sync commission period"}
                  </button>
                ) : (
                  <button disabled={etsyBusy} onClick={() => void runEtsy("connect")}>
                    Connect Etsy
                  </button>
                )}
              </div>
              <div className="summary-row">
                <div className="grow">
                  <strong>Faire</strong>
                  <small>
                    {faireStatus?.connected
                      ? `${faireStatus.shop ?? "Le Chic Miami"} · secure brand API connection`
                      : faireStatus?.message ?? "Secure connector is ready for a Faire brand access token."}
                  </small>
                </div>
                <Badge>{connectionLabel(faireStatus?.connected, faireBusy)}</Badge>
                <button className="secondary" disabled={faireBusy} onClick={() => void runFaire("check")}>
                  {faireBusy ? "Checking…" : "Check connection"}
                </button>
                <button disabled={faireBusy || !faireStatus?.connected} onClick={() => void runFaire("sync")}>
                  {faireStatus?.moreAvailable ? "Resume period sync" : "Sync commission period"}
                </button>
              </div>
              <p>
                Each platform has its own adapter boundary. The calculation
                engine uses normalized sales data.
              </p>
              <small>
                The term “Etsy” is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.
              </small>
            </section>
          </>
        )}
        <footer>
          Le Chic Miami · Live commission workspace · USD · Line-level half-up rounding
        </footer>
      </main>
    </div>
  );
}
function calculateGross(price: string, quantity: number) {
  return total(Array.from({ length: quantity }, () => price));
}
