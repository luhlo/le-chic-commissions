import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CloudDesign, CloudRecipient } from "./catalog";
import type { Coverage } from "./coverage";
import { periodReady, todayDate } from "./coverage";
import { loadPeriodInputs } from "./quarterly";
import { supabase } from "./supabase";
import { buildAnalytics, percentChange, previousEqualRange, TOP_MOVERS_MIN_COMBINED_UNITS, type AnalyticsGrouping, type AnalyticsMetric, type AnalyticsResult } from "./analytics";

const colors = ["#164c46", "#c88a2b", "#7b9e87", "#875f71", "#477892", "#9b6d3f", "#5a6e52", "#a44f42"];
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
const formatDate = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
const iso = (date: Date) => date.toISOString().slice(0, 10);
const shiftDays = (date: string, days: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000));

function quickRange(kind: string) {
  const today = todayDate(); const now = new Date(`${today}T00:00:00Z`); const year = now.getUTCFullYear(); const month = now.getUTCMonth();
  if (kind === "30") return { start: shiftDays(today, -29), end: today };
  if (kind === "90") return { start: shiftDays(today, -89), end: today };
  if (kind === "ytd") return { start: `${year}-01-01`, end: today };
  const quarterStartMonth = Math.floor(month / 3) * 3;
  if (kind === "quarter") return { start: iso(new Date(Date.UTC(year, quarterStartMonth, 1))), end: today };
  const end = new Date(Date.UTC(year, quarterStartMonth, 0)); const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  return { start: iso(start), end: iso(end) };
}

type Props = { designs: CloudDesign[] };
export function Analytics({ designs }: Props) {
  const initial = quickRange("90");
  const [start, setStart] = useState(initial.start); const [end, setEnd] = useState(initial.end);
  const [grouping, setGrouping] = useState<AnalyticsGrouping>("weekly");
  const [metric, setMetric] = useState<AnalyticsMetric>("units");
  const [compareBy, setCompareBy] = useState<"recipients" | "styles">("recipients");
  const [selected, setSelected] = useState<string[]>([]);
  const [mixMetric, setMixMetric] = useState<AnalyticsMetric>("commission");
  const [styleRecipient, setStyleRecipient] = useState("all");
  const [styleMetric, setStyleMetric] = useState<AnalyticsMetric>("units");
  const [moverMetric, setMoverMetric] = useState<"units" | "sales">("units");
  const [moverRecipient, setMoverRecipient] = useState("all");
  const [report, setReport] = useState<AnalyticsResult | null>(null);
  const [recipients, setRecipients] = useState<CloudRecipient[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!supabase || !start || !end || start > end) return;
      setLoading(true); setError("");
      try {
        const prior = previousEqualRange(start, end);
        const inputs = await loadPeriodInputs(prior.start, end);
        const built = buildAnalytics(inputs.lines, inputs.rules, inputs.recipients, designs, start, end, grouping, moverMetric, moverRecipient);
        const through = end < todayDate() ? end : todayDate();
        const { data, error: coverageError } = await supabase.rpc("commission_coverage", { p_start: start, p_end: through });
        if (coverageError) throw coverageError;
        if (!cancelled) { setReport(built); setRecipients(inputs.recipients); setCoverage((data ?? []) as Coverage[]); }
      } catch (cause) { if (!cancelled) setError((cause as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; };
  }, [start, end, grouping, moverMetric, moverRecipient, designs]);

  const entities = useMemo(() => compareBy === "recipients"
    ? recipients.map(r => ({ id: r.id, name: r.name }))
    : designs.map(d => ({ id: d.id, name: d.name })), [compareBy, recipients, designs]);
  useEffect(() => { setSelected(entities.slice(0, 5).map(e => e.id)); }, [compareBy, entities.length]);
  const trend = compareBy === "recipients" ? report?.recipientTrend : report?.styleTrend;
  const trendData = (trend ?? []).map(point => ({ bucket: point.bucket, ...point[metric] }));
  const styles = styleRecipient === "all"
    ? Object.values(report?.stylesByRecipient ?? {}).flat().reduce<Record<string, { id: string; name: string; units: number; sales: number; commission: number }>>((map, row) => {
        const current = map[row.id] ?? { ...row, units: 0, sales: 0, commission: 0 };
        current.units += row.units; current.sales += row.sales; current.commission += row.commission; map[row.id] = current; return map;
      }, {})
    : Object.fromEntries((report?.stylesByRecipient[styleRecipient] ?? []).map(row => [row.id, row]));
  const styleRows = Object.values(styles).sort((a, b) => b[styleMetric] - a[styleMetric]).slice(0, 12);
  const prior = previousEqualRange(start, end);
  const coverageComplete = periodReady(coverage);

  function chooseRange(kind: string) { const range = quickRange(kind); setStart(range.start); setEnd(range.end); }
  function toggle(id: string) { setSelected(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]); }
  const summary = [
    ["Units", report?.current.units ?? 0, report?.previous.units ?? 0, number],
    ["Sales", report?.current.sales ?? 0, report?.previous.sales ?? 0, money],
    ["Commission", report?.current.commission ?? 0, report?.previous.commission ?? 0, money],
    ["Orders", report?.current.orders ?? 0, report?.previous.orders ?? 0, number],
  ] as const;

  return <div className="analytics-page">
    <section className="panel analytics-controls">
      <div className="quick-ranges" aria-label="Quick date ranges">
        {[['30','Last 30 days'],['90','Last 90 days'],['ytd','Year to date'],['quarter','This quarter'],['previous','Previous quarter']].map(([value,label]) =>
          <button className="secondary compact" key={value} onClick={() => chooseRange(value)}>{label}</button>)}
      </div>
      <label className="field"><span>Start date</span><input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
      <label className="field"><span>End date</span><input type="date" value={end} max={todayDate()} onChange={e => setEnd(e.target.value)} /></label>
      <p className="comparison-copy">Compared with {formatDate(prior.start)}–{formatDate(prior.end)}</p>
    </section>
    {!coverageComplete && coverage.length > 0 && <div className="analytics-warning">Results are provisional. One or more channels do not fully cover this range; newer sales may not yet be included.</div>}
    {error && <div className="warning">{error}</div>}
    {loading && !report && <div className="panel empty">Loading analytics…</div>}
    {report && <>
      <div className="analytics-metrics">{summary.map(([label,current,previous,format]) => <article key={label}>
        <span>{label}</span><strong>{format(current)}</strong><small>{percentChange(current, previous)} vs previous equal period</small>
      </article>)}</div>
      <section className="panel analytics-chart-panel">
        <div className="section-title"><div><span className="eyebrow">PERFORMANCE OVER TIME</span><h2>Trend comparison</h2></div><div className="chart-switches">
          <select aria-label="Compare by" value={compareBy} onChange={e => setCompareBy(e.target.value as typeof compareBy)}><option value="recipients">Recipients</option><option value="styles">Styles</option></select>
          <select aria-label="Trend metric" value={metric} onChange={e => setMetric(e.target.value as AnalyticsMetric)}><option value="units">Units</option><option value="sales">Sales</option><option value="commission">Commission</option></select>
          <select aria-label="Time grouping" value={grouping} onChange={e => setGrouping(e.target.value as AnalyticsGrouping)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
        </div></div>
        <div className="entity-picker">{entities.map(entity => <label key={entity.id}><input type="checkbox" checked={selected.includes(entity.id)} onChange={() => toggle(entity.id)} />{entity.name}</label>)}</div>
        {trendData.length && selected.length ? <div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><LineChart data={trendData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="bucket" /><YAxis tickFormatter={metric === "units" ? number : value => `$${number(value)}`} /><Tooltip formatter={(value) => metric === "units" ? number(Number(value)) : money(Number(value))} /><Legend />{selected.map((id,index) => <Line key={id} dataKey={id} name={entities.find(e => e.id === id)?.name ?? id} stroke={colors[index % colors.length]} strokeWidth={2} dot={false} />)}</LineChart></ResponsiveContainer></div> : <div className="empty">No attributed activity for this selection.</div>}
      </section>
      <div className="analytics-grid">
        <section className="panel"><div className="section-title"><div><span className="eyebrow">RECIPIENT MIX</span><h2>Share of performance</h2></div><select value={mixMetric} onChange={e => setMixMetric(e.target.value as AnalyticsMetric)}><option value="units">Units</option><option value="sales">Sales</option><option value="commission">Commission</option></select></div>
          {report.recipientMix.some(row => row[mixMetric] > 0) ? <div className="chart-frame compact-chart"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={report.recipientMix.filter(row => row[mixMetric] > 0)} dataKey={mixMetric} nameKey="name" innerRadius={55} outerRadius={90}>{report.recipientMix.map((row,index) => <Cell key={row.id} fill={colors[index % colors.length]} />)}</Pie><Tooltip formatter={value => mixMetric === "units" ? number(Number(value)) : money(Number(value))} /><Legend /></PieChart></ResponsiveContainer></div> : <div className="empty">No recipient activity in this period.</div>}
        </section>
        <section className="panel"><div className="section-title"><div><span className="eyebrow">STYLE PERFORMANCE</span><h2>Styles by recipient</h2></div><div className="chart-switches"><select aria-label="Style recipient" value={styleRecipient} onChange={e => setStyleRecipient(e.target.value)}><option value="all">All recipients</option>{recipients.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select><select aria-label="Style metric" value={styleMetric} onChange={e => setStyleMetric(e.target.value as AnalyticsMetric)}><option value="units">Units</option><option value="sales">Sales</option><option value="commission">Commission</option></select></div></div>
          {styleRows.length ? <div className="chart-frame compact-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={styleRows} layout="vertical" margin={{ left: 10 }}><CartesianGrid strokeDasharray="3 3" /><XAxis type="number" tickFormatter={styleMetric === "units" ? number : value => `$${number(value)}`} /><YAxis type="category" dataKey="name" width={115} /><Tooltip formatter={value => styleMetric === "units" ? number(Number(value)) : money(Number(value))} /><Bar dataKey={styleMetric} fill="#164c46" /></BarChart></ResponsiveContainer></div> : <div className="empty">No styles are attributed to this recipient in the selected period.</div>}
        </section>
      </div>
      <section className="panel"><div className="section-title"><div><span className="eyebrow">TOP MOVERS</span><h2>Growth and decline</h2></div><div className="chart-switches"><select value={moverMetric} onChange={e => setMoverMetric(e.target.value as "units" | "sales")}><option value="units">Units</option><option value="sales">Sales</option></select><select value={moverRecipient} onChange={e => setMoverRecipient(e.target.value)}><option value="all">All recipients</option>{recipients.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select></div></div>
        <p className="comparison-copy">Current period versus the immediately preceding equal-length period. Styles need at least {TOP_MOVERS_MIN_COMBINED_UNITS} combined units.</p>
        <div className="movers-grid"><MoverList title="Growing" rows={report.growth} metric={moverMetric} /><MoverList title="Declining" rows={report.decline} metric={moverMetric} /></div>
      </section>
      {report.blockedLines > 0 && <div className="analytics-warning">{report.blockedLines} commission-impacting order line{report.blockedLines === 1 ? "" : "s"} could not be calculated. Review them in Overview.</div>}
    </>}
  </div>;
}

function MoverList({ title, rows, metric }: { title: string; rows: AnalyticsResult["growth"]; metric: "units" | "sales" }) {
  const value = (amount: number) => metric === "units" ? `${number(amount)} units` : money(amount);
  return <div><h3>{title}</h3>{rows.length ? rows.map(row => <div className="mover-row" key={row.id}><div><strong>{row.name}</strong><small>{value(row.current)} vs {value(row.previous)}</small></div><b className={row.current >= row.previous ? "positive" : "negative"}>{row.isNew ? "New" : `${row.change! >= 0 ? "+" : ""}${row.change!.toFixed(1)}%`}</b></div>) : <div className="empty">No qualifying {title.toLowerCase()} styles.</div>}</div>;
}
