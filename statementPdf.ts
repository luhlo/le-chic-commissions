import type { Calculation } from "../engine/types";
import {
  selectedStatementDeductions,
  statementDate,
  statementFilename,
  type RecipientStatementModel,
} from "./statements";

const money = (value: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
const platform = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1);

export interface PdfOrderBlock {
  heading: string;
  lines: string[];
}

export function buildStatementPdfContent(model: RecipientStatementModel) {
  const payment = model.payment ?? { status: "Not approved", paid: "0.00", remaining: model.commission, paidDate: null, method: null, reference: null };
  return {
    title: "COMMISSION STATEMENT",
    filename: statementFilename(model),
    styles: model.styles.map((style) => [
      style.name,
      `${style.units}`,
      money(style.commissionableRevenue),
      money(style.commission),
    ]),
    orders: model.calculations.map(calculationPdfBlock),
    payment: [
      `Payment status: ${payment.status}`,
      ...(payment.status === "Partially paid" || payment.status === "Paid" ? [`Paid: ${money(payment.paid)}`, `Remaining: ${money(payment.remaining)}`] : []),
      ...(payment.paidDate ? [`Paid date: ${statementDate(payment.paidDate)}`] : []),
      ...(payment.method ? [`Method: ${payment.method}`] : []),
      ...(payment.reference ? [`Reference: ${payment.reference}`] : []),
    ],
  };
}

function calculationPdfBlock(calculation: Calculation): PdfOrderBlock {
  const line = calculation.lineSnapshot;
  const rows = [
    `Product: ${line.productName ?? "Imported item"}`,
    `SKU: ${line.sku ?? "No SKU"}`,
    `Units: ${calculation.units}`,
    `Gross item sales: ${money(calculation.gross)}`,
  ];
  if (line.refundedQuantity > 0) {
    rows.push(`Original quantity: ${line.quantity}`);
    rows.push(`Refunded quantity: ${line.refundedQuantity}`);
    rows.push(`Commission units: ${calculation.units}`);
  }
  for (const deduction of selectedStatementDeductions(calculation))
    rows.push(`${deduction.label}: ${deduction.value == null ? "Needs review" : `-${money(deduction.value)}`}`);
  if (calculation.manualDeductions) {
    rows.push(`Manual shipping share: -${money(calculation.manualDeductions.shipping)}`);
    rows.push(`Manual other-cost share: -${money(calculation.manualDeductions.otherCosts)}`);
  }
  rows.push(`Total deductions: -${money(calculation.deducted)}`);
  rows.push(`Commissionable revenue: ${money(calculation.basis)}`);
  rows.push(`Rate: ${calculation.ruleSnapshot.kind === "fixed" ? `${money(calculation.ruleSnapshot.rate)} per unit` : `${calculation.ruleSnapshot.rate}%`}`);
  rows.push(`Commission: ${money(calculation.commission)}`);
  rows.push(`Rule: ${calculation.ruleSnapshot.name} · version ${calculation.ruleSnapshot.version}`);
  return {
    heading: `${statementDate(line.date)} · ${platform(line.channel)} · Order ${line.externalOrderId}`,
    lines: rows,
  };
}

export async function downloadRecipientStatementPdf(model: RecipientStatementModel) {
  const { jsPDF } = await import("jspdf");
  const content = buildStatementPdfContent(model);
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 54;
  const right = pageWidth - 54;
  const bottom = pageHeight - 48;
  let y = 54;

  const page = () => { doc.addPage("letter", "portrait"); y = 54; };
  const ensure = (height: number) => { if (y + height > bottom) page(); };
  const divider = () => { doc.setDrawColor(210, 220, 216); doc.line(left, y, right, y); y += 16; };
  const heading = (text: string) => {
    ensure(34); doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(31, 76, 70);
    doc.text(text, left, y); y += 18; doc.setTextColor(25, 45, 43);
  };
  const row = (label: string, value: string, strong = false) => {
    ensure(18); doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90, 108, 104); doc.text(label, left, y);
    doc.setFont("helvetica", strong ? "bold" : "normal"); doc.setTextColor(25, 45, 43); doc.text(value, right, y, { align: "right" }); y += 17;
  };

  doc.setTextColor(24, 62, 58); doc.setFont("times", "bold"); doc.setFontSize(19); doc.text("LE CHIC MIAMI", left, y); y += 21;
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setCharSpace(1.4); doc.text(content.title, left, y); doc.setCharSpace(0); y += 28;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(50, 70, 67);
  doc.text(`Recipient: ${model.recipientName}`, left, y); y += 16;
  doc.text(`Period: Q${model.quarter} ${model.year}`, left, y); y += 16;
  doc.text(`Dates: ${statementDate(model.startsOn, true)} – ${statementDate(model.endsOn, true)}`, left, y); y += 16;
  doc.setFont("helvetica", "bold"); doc.text(model.status === "FINAL" ? "FINAL STATEMENT" : "PROVISIONAL", left, y); y += 16;
  if (model.status === "PROVISIONAL") {
    doc.setFont("helvetica", "normal");
    doc.text(`Synced through: ${model.syncedThrough ? statementDate(model.syncedThrough) : "Coverage not yet verified"}`, left, y); y += 15;
    doc.setTextColor(120, 86, 31); doc.text("This statement may change until the quarter is finalized.", left, y); y += 22;
  }
  divider();
  heading("STATEMENT SUMMARY");
  row("Commission units", String(model.units));
  row("Commissionable revenue", money(model.commissionableRevenue));
  row("TOTAL COMMISSION", money(model.commission), true);
  y += 8; divider();

  heading("PAYMENT STATUS");
  for (const line of content.payment) {
    ensure(16); doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(50, 70, 67); doc.text(line, left, y); y += 15;
  }
  y += 5; divider();

  heading("STYLE SUMMARY");
  if (!model.styles.length) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text("No commission-eligible sales were recorded for this recipient during this period.", left, y); y += 22;
  } else {
    for (const style of model.styles) {
      ensure(28); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text(style.name, left, y, { maxWidth: 250 });
      doc.setFont("helvetica", "normal"); doc.text(`${style.units} units`, left + 270, y); doc.text(money(style.commissionableRevenue), left + 355, y, { align: "right" }); doc.text(money(style.commission), right, y, { align: "right" }); y += 20;
    }
  }
  y += 5; divider();

  heading("ORDER DETAILS");
  for (const order of content.orders) {
    const estimated = 29 + order.lines.length * 13;
    ensure(Math.min(estimated, bottom - 54));
    doc.setFillColor(246, 249, 248); doc.roundedRect(left, y - 10, right - left, estimated, 4, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(24, 62, 58); doc.text(order.heading, left + 10, y + 3); y += 19;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(48, 65, 62);
    for (const line of order.lines) { doc.text(line, left + 10, y); y += 13; }
    y += 12;
  }
  ensure(50); divider();
  doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(24, 62, 58); doc.text("TOTAL COMMISSION", left, y); doc.text(money(model.commission), right, y, { align: "right" });
  doc.save(content.filename);
}
