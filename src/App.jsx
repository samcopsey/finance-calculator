import { useState, useMemo, useCallback, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Area, AreaChart, ReferenceLine } from "recharts";

const TAX_FREE_ALLOWANCE = 12570;
const PA_TAPER_THRESHOLD = 100000;
const BASIC_RATE_LIMIT = 50270;
const HIGHER_RATE_LIMIT = 125140;
const BASIC_RATE = 0.20;
const HIGHER_RATE = 0.40;
const ADDITIONAL_RATE = 0.45;
const NI_LOWER = 12570;
const NI_UPPER = 50270;
const NI_RATE_MAIN = 0.08;
const NI_RATE_UPPER = 0.02;
const CLASS4_NI_LOWER = 12570;
const CLASS4_NI_UPPER = 50270;
const CLASS4_NI_RATE_MAIN = 0.06;
const CLASS4_NI_RATE_UPPER = 0.02;
const STUDENT_LOAN_RATE = 0.09;
const STUDENT_LOAN_PLAN = Object.freeze({ NONE: 0, PLAN_1: 1, PLAN_2: 2 });
const STUDENT_LOAN_THRESHOLDS = { [STUDENT_LOAN_PLAN.PLAN_1]: 26900, [STUDENT_LOAN_PLAN.PLAN_2]: 29385 };
const STUDENT_LOAN_OPTIONS = [
  { value: STUDENT_LOAN_PLAN.NONE, label: "None" },
  { value: STUDENT_LOAN_PLAN.PLAN_1, label: "Plan 1" },
  { value: STUDENT_LOAN_PLAN.PLAN_2, label: "Plan 2" },
];

const MODE = Object.freeze({ SINGLE: 0, HOUSEHOLD: 1 });
const SPLIT_MODE = Object.freeze({ EARNINGS_RATIO: 0, CUSTOM_PERCENT: 1 });

const SAVINGS_MODELS = [
  { name: "50/30/20", savingsRate: 0.2 },
  { name: "70/20/10", savingsRate: 0.2 },
  { name: "Pay Yourself First", savingsRate: null },
];
const SAVINGS_MODEL_PYF = 2;

function monthlySavings(modelIndex, includeModel, includePYF, income, pyfTarget) {
  const model = SAVINGS_MODELS[modelIndex];
  const modelSaving = includeModel ? (model?.savingsRate ? income * model.savingsRate : pyfTarget) : 0;
  const extraPYF = includePYF && !(includeModel && model === SAVINGS_MODELS[SAVINGS_MODEL_PYF]);
  return { modelName: model?.name, extraPYF, total: modelSaving + (extraPYF ? pyfTarget : 0) };
}

const STAMP_DUTY_BANDS = [
  { limit: 125000, rate: 0 },
  { limit: 250000, rate: 0.02 },
  { limit: 925000, rate: 0.05 },
  { limit: 1500000, rate: 0.10 },
  { limit: Infinity, rate: 0.12 },
];
const FTB_RELIEF_MAX_PRICE = 500000;
const STAMP_DUTY_FTB_BANDS = [
  { limit: 300000, rate: 0 },
  { limit: 500000, rate: 0.05 },
  { limit: 925000, rate: 0.05 },
  { limit: 1500000, rate: 0.10 },
  { limit: Infinity, rate: 0.12 },
];

function calculateIncomeTax(gross) {
  let personalAllowance = TAX_FREE_ALLOWANCE;
  if (gross > PA_TAPER_THRESHOLD) {
    personalAllowance = Math.max(0, TAX_FREE_ALLOWANCE - (gross - PA_TAPER_THRESHOLD) / 2);
  }
  // Bands apply to income above the allowance, so the £37,700 basic band doesn't widen as the allowance tapers.
  // The allowance is nil from £125,140, where taxable income equals gross.
  const taxable = Math.max(0, gross - personalAllowance);
  const basicBand = BASIC_RATE_LIMIT - TAX_FREE_ALLOWANCE;
  let tax = 0;
  const bands = [
    { from: 0, to: basicBand, rate: BASIC_RATE },
    { from: basicBand, to: HIGHER_RATE_LIMIT, rate: HIGHER_RATE },
    { from: HIGHER_RATE_LIMIT, to: Infinity, rate: ADDITIONAL_RATE },
  ];
  for (const b of bands) {
    if (taxable <= b.from) break;
    const inBand = Math.min(taxable, b.to) - b.from;
    if (inBand > 0) tax += inBand * b.rate;
  }
  return tax;
}

function calculateNI(gross) {
  let ni = 0;
  if (gross > NI_LOWER) {
    const mainBand = Math.min(gross, NI_UPPER) - NI_LOWER;
    ni += mainBand * NI_RATE_MAIN;
  }
  if (gross > NI_UPPER) {
    ni += (gross - NI_UPPER) * NI_RATE_UPPER;
  }
  return ni;
}

function calculateClass4NI(profit) {
  let ni = 0;
  if (profit > CLASS4_NI_LOWER) {
    const mainBand = Math.min(profit, CLASS4_NI_UPPER) - CLASS4_NI_LOWER;
    ni += mainBand * CLASS4_NI_RATE_MAIN;
  }
  if (profit > CLASS4_NI_UPPER) {
    ni += (profit - CLASS4_NI_UPPER) * CLASS4_NI_RATE_UPPER;
  }
  return ni;
}

function ftbReliefApplies(price, isFirstTimeBuyer) {
  return isFirstTimeBuyer && price <= FTB_RELIEF_MAX_PRICE;
}

function calculateStampDuty(price, isFirstTimeBuyer) {
  const bands = ftbReliefApplies(price, isFirstTimeBuyer) ? STAMP_DUTY_FTB_BANDS : STAMP_DUTY_BANDS;
  let duty = 0;
  let prev = 0;
  for (const band of bands) {
    if (price <= prev) break;
    const taxable = Math.min(price, band.limit) - prev;
    duty += taxable * band.rate;
    prev = band.limit;
  }
  return duty;
}

const MORTGAGE_EPS = 0.005;

// "advance" collects each payment at the start of the month, so interest accrues on the balance after it.
// Some lenders illustrate payments this way, which comes out slightly lower than the textbook "arrears" annuity.
function mortgagePayment(principal, annualRatePct, months, timing) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = Math.max(0, annualRatePct || 0) / 100 / 12;
  if (r === 0) return principal / months;
  const arrears = (principal * r) / (1 - Math.pow(1 + r, -months));
  return timing === "arrears" ? arrears : arrears / (1 + r);
}

function isFinalPaymentResidue(balance, due) {
  return balance < Math.max(1, due * 0.01);
}

function runMortgage(p, overpayMonthly, overpayAnnual, contractualFollowOnPayment) {
  const { principal, months, timing, rate, payment, firstPayment, stubInterest } = p;
  const followOnRate = p.followOnRate > 0 ? p.followOnRate : rate;
  const fixedMonths = p.fixedMonths >= 1 && p.fixedMonths <= months ? p.fixedMonths : months;
  const advance = timing !== "arrears";
  const rows = [{ month: 0, payment: 0, overpayment: 0, lump: 0, interest: 0, balance: principal }];
  let bal = principal, due = payment, followOn = contractualFollowOnPayment;
  let totalInterest = 0, totalPaid = 0, payoffMonth = null, negAmMonth = null;
  for (let m = 1; m <= months; m++) {
    if (m === fixedMonths + 1) {
      if (followOn === null) followOn = mortgagePayment(bal, followOnRate, months - fixedMonths, timing);
      due = followOn;
    }
    if (bal <= 0) {
      rows.push({ month: m, payment: 0, overpayment: 0, lump: 0, interest: 0, balance: 0 });
      continue;
    }
    const r = Math.max(0, m <= fixedMonths ? rate : followOnRate) / 100 / 12;
    const stub = m === 1 ? stubInterest : 0;
    const regular = Math.max(0, m === 1 ? firstPayment - stubInterest : due);
    const open = bal;
    let interest = advance ? 0 : bal * r;
    const avail = bal + interest;
    let pay = Math.min(regular, avail);
    const over = Math.min(Math.max(0, overpayMonthly), avail - pay);
    const lump = m % 12 === 0 ? Math.min(Math.max(0, overpayAnnual), avail - pay - over) : 0;
    if (advance) {
      bal -= pay + over + lump;
      interest = bal * r;
      bal += interest;
    } else {
      bal = avail - pay - over - lump;
    }
    if (m === months && isFinalPaymentResidue(bal, due)) {
      pay += bal;
      bal = 0;
    }
    if (bal <= MORTGAGE_EPS) bal = 0;
    if (negAmMonth === null && bal > open + MORTGAGE_EPS) negAmMonth = m;
    totalInterest += interest + stub;
    totalPaid += pay + stub + over + lump;
    rows.push({ month: m, payment: pay + stub, overpayment: over, lump, interest: interest + stub, balance: bal });
    if (bal === 0 && payoffMonth === null) payoffMonth = m;
  }
  return { rows, totalInterest, totalPaid, residual: bal, payoffMonth, negAmMonth, followOnPayment: followOn };
}

function negAmMonthIgnoringShortFirstPayment(run, shortFirstPayment) {
  if (!(shortFirstPayment && run.negAmMonth === 1)) return run.negAmMonth;
  const later = run.rows.findIndex((r, i) => i >= 2 && r.balance > run.rows[i - 1].balance + MORTGAGE_EPS);
  return later > 0 ? later : null;
}

function buildMortgageSchedule(p) {
  const base = runMortgage(p, 0, 0, null);
  const contractualFollowOnPayment = base.followOnPayment;
  const op = runMortgage(p, p.overpayMonthly, p.overpayAnnual, contractualFollowOnPayment);
  return { base, op };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isIsoDateOrEmpty(v) {
  return typeof v === "string" && (v === "" || ISO_DATE_RE.test(v));
}

function parseIsoDate(iso) {
  return iso.split("-").map(Number);
}

function calendarMonthsBetween(fromISO, toISO) {
  const [fy, fm] = parseIsoDate(fromISO);
  const [ty, tm] = parseIsoDate(toISO);
  return (ty - fy) * 12 + (tm - fm);
}

function wholeMonthsBetween(fromISO, toISO) {
  const [fy, fm, fd] = parseIsoDate(fromISO);
  const [ty, tm, td] = parseIsoDate(toISO);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

function dateAfterMonths(fromISO, months) {
  const [y, m] = parseIsoDate(fromISO);
  return new Date(y, m - 1 + months, 1);
}

const PLANNER_HORIZON_MONTHS = 120;

const COMPOUNDING_MODES = {
  monthly: { label: "Monthly", grow: (balance, contrib, rate) => balance * (1 + rate / 12) + contrib },
  annual: { label: "Annual", grow: (balance, contrib, rate, month) => (month % 12 === 0 ? (balance + contrib) * (1 + rate) : balance + contrib) },
  simple: { label: "Simple", grow: (balance, contrib, rate, month, principal) => balance + (contrib + principal * rate / 12) },
  none: { label: "None", grow: (balance, contrib) => balance + contrib },
};

const PURCHASE_DEFAULTS = {
  paymentTiming: "advance",
  firstPaymentDays: 30,
  paymentOverride: 0,
  firstPaymentOverride: 0,
  reserveFirstPayment: true,
  productFee: 0,
  productFeeAddToLoan: false,
  productFeePaid: false,
  fixedRateEndDate: "",
  followOnRate: 0,
  completionDate: "",
  depositPaid: false,
  stampDutyPaid: false,
  includeExtrasInProjection: true,
  councilTaxInBills: 0,
};

const DEFAULT_PURCHASE_COSTS = [
  { id: 1, name: "Solicitor / conveyancing", upfront: 1500, monthly: 0, payment: "upfront", renews: "once", category: "essential", splitType: "shared", paid: false },
  { id: 2, name: "Survey", upfront: 500, monthly: 0, payment: "upfront", renews: "once", category: "essential", splitType: "shared", paid: false },
  { id: 3, name: "Home insurance", upfront: 360, monthly: 30, payment: "monthly", renews: "yearly", category: "essential", splitType: "shared", paid: false },
  { id: 4, name: "Moving costs", upfront: 1000, monthly: 0, payment: "upfront", renews: "once", category: "extra", splitType: "shared", paid: false },
];

const QUICK_ADD_COSTS = [
  { name: "Valuation fee", renews: "once", category: "essential" },
  { name: "Land Registry fee", renews: "once", category: "essential" },
  { name: "Searches", renews: "once", category: "essential" },
  { name: "Broker fee", renews: "once", category: "essential" },
  { name: "Life & critical illness cover", renews: "yearly", category: "essential" },
  { name: "Removals", renews: "once", category: "extra" },
  { name: "Furnishings", renews: "once", category: "extra" },
];

function normalisePurchaseCost(c, i) {
  const renews = c.renews === "yearly" ? "yearly" : "once";
  return {
    id: c.id ?? Date.now() + i,
    name: c.name == null ? `Cost ${i + 1}` : String(c.name),
    upfront: Number(c.upfront) || 0,
    monthly: Number(c.monthly) || 0,
    payment: renews === "yearly" && c.payment === "monthly" ? "monthly" : "upfront",
    renews,
    category: c.category === "extra" ? "extra" : "essential",
    splitType: c.splitType === "p1" || c.splitType === "p2" ? c.splitType : "shared",
    paid: Boolean(c.paid),
  };
}

function fmt(n) {
  const v = Math.round(n);
  return (v < 0 ? "-" : "") + "£" + Math.abs(v).toLocaleString("en-GB");
}

function fmt2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return (v < 0 ? "-" : "") + "£" + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = parseIsoDate(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtMonthYear(date) {
  return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function fmtYearsMonths(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [];
  if (y > 0) parts.push(`${y} yr${y === 1 ? "" : "s"}`);
  if (m > 0 || y === 0) parts.push(`${m} mth${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function fmtSigned2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v === 0 ? "no change" : `${v > 0 ? "+" : "−"}${fmt2(Math.abs(v))}`;
}

const COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const TAB_STYLE = (active) => ({
  padding: "10px 16px",
  border: "none",
  borderBottom: active ? "3px solid #6366f1" : "3px solid transparent",
  background: active ? "#f0f0ff" : "transparent",
  color: active ? "#6366f1" : "#64748b",
  fontWeight: active ? 700 : 500,
  cursor: "pointer",
  fontSize: 14,
  whiteSpace: "nowrap",
  transition: "all 0.2s",
});
const HINT_STYLE = { fontSize: 11, color: "#94a3b8", marginTop: -12, marginBottom: 12, lineHeight: 1.4 };
const LINK_BTN = { background: "none", border: "none", padding: 0, color: "#6366f1", fontWeight: 700, fontSize: "inherit", cursor: "pointer", textDecoration: "underline" };
const PILL_STYLE = { fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#eef2ff", color: "#6366f1", fontWeight: 600, marginLeft: 6, textTransform: "uppercase" };
const INACTIVE_INPUT = { background: "#f8fafc", color: "#94a3b8" };
const CHIP_STYLE = { padding: "4px 10px", borderRadius: 99, border: "1px dashed #cbd5e1", background: "#fff", color: "#475569", fontSize: 12, cursor: "pointer" };
const WARNING_STYLES = {
  error: { background: "#fef2f2", border: "1px solid #fecaca", color: "#ef4444" },
  warn: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" },
  info: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" },
};

function InputGroup({ label, value, onChange, prefix = "£", suffix, type = "number", min, max, step }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {prefix && <span style={{ color: "#94a3b8", fontWeight: 600, fontSize: 15 }}>{prefix}</span>}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(type === "number" ? parseFloat(e.target.value) || 0 : e.target.value)}
          min={min}
          max={max}
          step={step || 1}
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            fontSize: 15,
            outline: "none",
          }}
        />
        {suffix && <span style={{ color: "#94a3b8", fontSize: 13, whiteSpace: "nowrap" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Card({ title, children, color = "#6366f1" }) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" }}>
      {title && <h3 style={{ margin: "0 0 16px 0", fontSize: 16, fontWeight: 700, color, borderBottom: `2px solid ${color}22`, paddingBottom: 8 }}>{title}</h3>}
      {children}
    </div>
  );
}

function StatBox({ label, value, color = "#1e293b", sub }) {
  return (
    <div style={{ textAlign: "center", padding: "12px 8px" }}>
      <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function InfoTip({ items, children }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && items && items.length > 0 && (
        <div style={{ position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)", background: "#1e293b", color: "#fff", borderRadius: 8, padding: "10px 14px", fontSize: 12, whiteSpace: "nowrap", zIndex: 999, boxShadow: "0 4px 12px rgba(0,0,0,0.2)", marginBottom: 6, minWidth: 180 }}>
          {items.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "2px 0", borderBottom: i < items.length - 1 ? "1px solid #334155" : "none" }}>
              <span style={{ opacity: 0.8 }}>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
          <div style={{ position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "6px solid #1e293b" }} />
        </div>
      )}
    </span>
  );
}

function Toggle({ value, onChange, labels }) {
  return (
    <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 10, padding: 3, gap: 2 }}>
      {labels.map((l, i) => (
        <button
          key={l}
          onClick={() => onChange(i)}
          style={{
            flex: 1,
            padding: "8px 16px",
            border: "none",
            borderRadius: 8,
            background: value === i ? "#6366f1" : "transparent",
            color: value === i ? "#fff" : "#64748b",
            fontWeight: value === i ? 700 : 500,
            cursor: "pointer",
            fontSize: 13,
            transition: "all 0.2s",
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export default function FinanceCalculator() {
  const [tab, setTab] = useState(0);
  const tabs = ["Overview", "Savings Models", "Mortgage", "Purchase Plan", "Savings & Investments", "Finance Agreements", "Projections", "Expense Log", "Report"];

  const [mode, setMode] = useState(MODE.SINGLE);

  const [salary1, setSalary1] = useState(35000);
  const [otherIncome1, setOtherIncome1] = useState(0);
  const [otherIncomeType1, setOtherIncomeType1] = useState("paye");
  const [pension1, setPension1] = useState(5);
  const [studentLoan1, setStudentLoan1] = useState(STUDENT_LOAN_PLAN.NONE);

  const [salary2, setSalary2] = useState(30000);
  const [otherIncome2, setOtherIncome2] = useState(0);
  const [otherIncomeType2, setOtherIncomeType2] = useState("paye");
  const [pension2, setPension2] = useState(5);
  const [studentLoan2, setStudentLoan2] = useState(STUDENT_LOAN_PLAN.NONE);

  const [splitMode, setSplitMode] = useState(SPLIT_MODE.EARNINGS_RATIO);
  const [customSplitP1, setCustomSplitP1] = useState(50);

  const [rent, setRent] = useState(900);
  const [bills, setBills] = useState(250);
  const [food, setFood] = useState(350);
  const [transport, setTransport] = useState(150);
  const [subscriptions, setSubscriptions] = useState(50);
  const [otherExpenses, setOtherExpenses] = useState(200);

  const [customExpenses, setCustomExpenses] = useState([]);
  const [newCustomExpName, setNewCustomExpName] = useState("");
  const [newCustomExpAmount, setNewCustomExpAmount] = useState(0);

  const addCustomExpense = () => {
    if (!newCustomExpName || newCustomExpAmount <= 0) return;
    setCustomExpenses([...customExpenses, { id: Date.now(), name: newCustomExpName, amount: newCustomExpAmount, splitType: "shared" }]);
    setNewCustomExpName("");
    setNewCustomExpAmount(0);
  };
  const removeCustomExpense = (id) => setCustomExpenses(customExpenses.filter((e) => e.id !== id));
  const updateCustomExpenseSplit = (id, splitType) => setCustomExpenses(customExpenses.map((e) => e.id === id ? { ...e, splitType } : e));
  const customExpensesTotal = customExpenses.reduce((s, e) => s + e.amount, 0);

  const [pyfSavingsTarget, setPyfSavingsTarget] = useState(500);

  const POT_TYPES = ["current", "savings", "isa", "lisa", "investment", "pension", "shareScheme", "other"];
  const POT_TYPE_LABELS = {
    current: "current",
    savings: "savings",
    isa: "ISA",
    lisa: "LISA",
    investment: "investment",
    pension: "pension",
    shareScheme: "share save",
    other: "other",
  };
  const POT_TYPE_COLORS = {
    current: "#64748b",
    savings: "#10b981",
    isa: "#8b5cf6",
    lisa: "#ec4899",
    investment: "#f59e0b",
    pension: "#6366f1",
    shareScheme: "#0ea5e9",
    other: "#94a3b8",
  };
  const defaultCompoundingFor = (type) => {
    switch (type) {
      case "current": return "none";
      case "savings": case "isa": case "lisa": return "annual";
      case "investment": case "pension": case "shareScheme": return "monthly";
      default: return "monthly";
    }
  };
  const defaultSalarySacrificeFor = (type) => type === "shareScheme";
  const defaultForPurchaseFor = (type) => type === "current" || type === "savings" || type === "isa" || type === "lisa";
  const [pots, setPots] = useState([
    { id: 1, name: "Current Account", owner: "p1", type: "current", startingBalance: 0, monthlyContribution: 0, rate: 0, compounding: "none", salarySacrifice: false, forPurchase: true },
    { id: 2, name: "S&S ISA", owner: "p1", type: "isa", startingBalance: 0, monthlyContribution: 0, rate: 7, compounding: "monthly", salarySacrifice: false, forPurchase: true },
  ]);
  const [newPotName, setNewPotName] = useState("");

  const addPot = () => {
    const id = Math.max(0, ...pots.map((p) => p.id || 0)) + 1;
    const type = "savings";
    setPots([...pots, { id, name: newPotName || `Pot ${id}`, owner: "p1", type, startingBalance: 0, monthlyContribution: 0, rate: 4, compounding: defaultCompoundingFor(type), salarySacrifice: defaultSalarySacrificeFor(type), forPurchase: defaultForPurchaseFor(type) }]);
    setNewPotName("");
  };
  const updatePot = (id, field, value) => setPots(pots.map((p) => {
    if (p.id !== id) return p;
    const next = { ...p, [field]: value };
    if (field === "type") {
      next.compounding = defaultCompoundingFor(value);
      next.salarySacrifice = defaultSalarySacrificeFor(value);
      next.forPurchase = defaultForPurchaseFor(value);
    }
    if (field === "owner" && value === "joint") next.salarySacrifice = false;
    return next;
  }));
  const removePot = (id) => setPots(pots.filter((p) => p.id !== id));

  const [housePrice, setHousePrice] = useState(250000);
  const [deposit, setDeposit] = useState(25000);
  const [mortgageTerm, setMortgageTerm] = useState(25);
  const [mortgageRate, setMortgageRate] = useState(4.5);
  const [firstTimeBuyer, setFirstTimeBuyer] = useState(1);
  const isFirstTimeBuyer = firstTimeBuyer === 1;
  const [overpayMonthly, setOverpayMonthly] = useState(0);
  const [overpayAnnual, setOverpayAnnual] = useState(0);
  const [councilTax, setCouncilTax] = useState(150);
  const [councilTaxInBills, setCouncilTaxInBills] = useState(PURCHASE_DEFAULTS.councilTaxInBills);
  const [housePriceGrowth, setHousePriceGrowth] = useState(3);

  const [paymentTiming, setPaymentTiming] = useState(PURCHASE_DEFAULTS.paymentTiming);
  const [firstPaymentDays, setFirstPaymentDays] = useState(PURCHASE_DEFAULTS.firstPaymentDays);
  const [paymentOverride, setPaymentOverride] = useState(PURCHASE_DEFAULTS.paymentOverride);
  const [firstPaymentOverride, setFirstPaymentOverride] = useState(PURCHASE_DEFAULTS.firstPaymentOverride);
  const [reserveFirstPayment, setReserveFirstPayment] = useState(PURCHASE_DEFAULTS.reserveFirstPayment);
  const [productFee, setProductFee] = useState(PURCHASE_DEFAULTS.productFee);
  const [productFeeAddToLoan, setProductFeeAddToLoan] = useState(PURCHASE_DEFAULTS.productFeeAddToLoan);
  const [productFeePaid, setProductFeePaid] = useState(PURCHASE_DEFAULTS.productFeePaid);
  const [fixedRateEndDate, setFixedRateEndDate] = useState(PURCHASE_DEFAULTS.fixedRateEndDate);
  const [followOnRate, setFollowOnRate] = useState(PURCHASE_DEFAULTS.followOnRate);

  const [completionDate, setCompletionDate] = useState(PURCHASE_DEFAULTS.completionDate);
  const [depositPaid, setDepositPaid] = useState(PURCHASE_DEFAULTS.depositPaid);
  const [stampDutyPaid, setStampDutyPaid] = useState(PURCHASE_DEFAULTS.stampDutyPaid);
  const [includeExtrasInProjection, setIncludeExtrasInProjection] = useState(PURCHASE_DEFAULTS.includeExtrasInProjection);
  const [purchaseCosts, setPurchaseCosts] = useState(DEFAULT_PURCHASE_COSTS);
  const [newCostName, setNewCostName] = useState("");
  const [newCostUpfront, setNewCostUpfront] = useState(0);
  const [todayISO] = useState(isoToday);

  const addPurchaseCost = (category, preset) => {
    const id = Math.max(0, ...purchaseCosts.map((c) => c.id || 0)) + 1;
    const name = preset ? preset.name : newCostName.trim() || "New cost";
    setPurchaseCosts([...purchaseCosts, { id, name, upfront: preset ? 0 : newCostUpfront, monthly: 0, payment: "upfront", renews: preset?.renews ?? "once", category, splitType: "shared", paid: false }]);
    if (!preset) {
      setNewCostName("");
      setNewCostUpfront(0);
    }
  };
  const updatePurchaseCost = (id, field, value) => setPurchaseCosts(purchaseCosts.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, [field]: value };
    if (field === "renews" && value === "once") next.payment = "upfront";
    return next;
  }));
  const removePurchaseCost = (id) => setPurchaseCosts(purchaseCosts.filter((c) => c.id !== id));

  const [investYears, setInvestYears] = useState(10);

  const [agreements, setAgreements] = useState([
    { name: "Car Finance", amount: 15000, rate: 6.9, termMonths: 48, monthlyPayment: 0 },
  ]);

  const [projectionMonths, setProjectionMonths] = useState(24);
  const [salaryGrowth, setSalaryGrowth] = useState(2);
  const [inflationRate, setInflationRate] = useState(3);
  const [projSavingsModel, setProjSavingsModel] = useState(0);

  const [projIncludePots, setProjIncludePots] = useState(true);
  const [projIncludeModel, setProjIncludeModel] = useState(true);
  const [projIncludePYF, setProjIncludePYF] = useState(false);

  const [expenseLog, setExpenseLog] = useState([]);
  const [newExpenseName, setNewExpenseName] = useState("");
  const [newExpenseAmount, setNewExpenseAmount] = useState(0);
  const [newExpenseCategory, setNewExpenseCategory] = useState("Other");
  const [newExpenseDate, setNewExpenseDate] = useState(isoToday);

  const [saveNotice, setSaveNotice] = useState("");
  const fileInputRef = useRef(null);

  const getAllState = () => ({
    _version: 3,
    _savedAt: new Date().toISOString(),
    mode, splitMode, customSplitP1,
    salary1, otherIncome1, otherIncomeType1, pension1, studentLoan1,
    salary2, otherIncome2, otherIncomeType2, pension2, studentLoan2,
    rent, bills, food, transport, subscriptions, otherExpenses, customExpenses,
    pyfSavingsTarget,
    pots,
    housePrice, deposit, mortgageTerm, mortgageRate, firstTimeBuyer,
    paymentTiming, firstPaymentDays, paymentOverride, firstPaymentOverride, reserveFirstPayment,
    productFee, productFeeAddToLoan, productFeePaid, fixedRateEndDate, followOnRate,
    overpayMonthly, overpayAnnual, councilTax, councilTaxInBills, housePriceGrowth,
    purchaseCosts, completionDate, depositPaid, stampDutyPaid, includeExtrasInProjection,
    investYears,
    agreements,
    projectionMonths, salaryGrowth, inflationRate, projSavingsModel,
    projIncludePots, projIncludeModel, projIncludePYF,
    expenseLog,
  });

  const loadState = (data) => {
    if (data.mode !== undefined) setMode(data.mode);
    if (data.splitMode !== undefined) setSplitMode(data.splitMode);
    if (data.customSplitP1 !== undefined) setCustomSplitP1(data.customSplitP1);
    if (data.salary1 !== undefined) setSalary1(data.salary1);
    if (data.otherIncome1 !== undefined) setOtherIncome1(data.otherIncome1);
    if (data.otherIncomeType1 !== undefined) setOtherIncomeType1(data.otherIncomeType1);
    if (data.pension1 !== undefined) setPension1(data.pension1);
    if (data.studentLoan1 !== undefined) setStudentLoan1(data.studentLoan1);
    if (data.salary2 !== undefined) setSalary2(data.salary2);
    if (data.otherIncome2 !== undefined) setOtherIncome2(data.otherIncome2);
    if (data.otherIncomeType2 !== undefined) setOtherIncomeType2(data.otherIncomeType2);
    if (data.pension2 !== undefined) setPension2(data.pension2);
    if (data.studentLoan2 !== undefined) setStudentLoan2(data.studentLoan2);
    if (data.rent !== undefined) setRent(data.rent);
    if (data.bills !== undefined) setBills(data.bills);
    if (data.food !== undefined) setFood(data.food);
    if (data.transport !== undefined) setTransport(data.transport);
    if (data.subscriptions !== undefined) setSubscriptions(data.subscriptions);
    if (data.otherExpenses !== undefined) setOtherExpenses(data.otherExpenses);
    if (data.customExpenses !== undefined) setCustomExpenses(data.customExpenses.map(e => ({ splitType: "shared", ...e })));
    if (data.pyfSavingsTarget !== undefined) setPyfSavingsTarget(data.pyfSavingsTarget);

    if (Array.isArray(data.pots)) {
      setPots(data.pots.map((p, i) => {
        const type = p.type ?? "savings";
        const owner = p.owner ?? "p1";
        return {
          id: p.id ?? Date.now() + i,
          name: p.name ?? `Pot ${i + 1}`,
          owner,
          type,
          startingBalance: p.startingBalance ?? 0,
          monthlyContribution: p.monthlyContribution ?? 0,
          rate: p.rate ?? 0,
          compounding: p.compounding ?? defaultCompoundingFor(type),
          salarySacrifice: owner !== "joint" && (p.salarySacrifice ?? false),
          forPurchase: typeof p.forPurchase === "boolean" ? p.forPurchase : defaultForPurchaseFor(type),
        };
      }));
    } else {
      const legacy = [];
      let nextId = 1;
      const mk = (type, fields) => ({ ...fields, type, compounding: defaultCompoundingFor(type), salarySacrifice: false, forPurchase: defaultForPurchaseFor(type) });
      if (data.currentAccount !== undefined && data.currentAccount !== null) {
        legacy.push(mk("current", { id: nextId++, name: "Current Account", owner: "p1", startingBalance: data.currentAccount, monthlyContribution: 0, rate: 0 }));
      }
      if (data.isaBalance !== undefined || data.isaMonthly !== undefined) {
        legacy.push({ id: nextId++, name: "S&S ISA", owner: "p1", type: "isa", startingBalance: data.isaBalance ?? 0, monthlyContribution: data.isaMonthly ?? 0, rate: data.isaReturnRate ?? 7, compounding: "monthly", salarySacrifice: false, forPurchase: defaultForPurchaseFor("isa") });
      }
      if (data.otherSavings !== undefined && data.otherSavings !== null && data.otherSavings !== 0) {
        legacy.push(mk("savings", { id: nextId++, name: "Other Savings", owner: "p1", startingBalance: data.otherSavings, monthlyContribution: 0, rate: 0 }));
      }
      if (data.investLumpSum !== undefined || data.investMonthly !== undefined) {
        legacy.push(mk("investment", { id: nextId++, name: "Investment", owner: "p1", startingBalance: data.investLumpSum ?? 0, monthlyContribution: data.investMonthly ?? 0, rate: data.investReturn ?? 7 }));
      }
      if (legacy.length > 0) setPots(legacy);
    }

    if (data.housePrice !== undefined) setHousePrice(data.housePrice);
    if (data.deposit !== undefined) setDeposit(data.deposit);
    if (data.mortgageTerm !== undefined) setMortgageTerm(data.mortgageTerm);
    if (data.mortgageRate !== undefined) setMortgageRate(data.mortgageRate);
    if (data.firstTimeBuyer !== undefined) setFirstTimeBuyer(data.firstTimeBuyer);
    if (data.overpayMonthly !== undefined) setOverpayMonthly(data.overpayMonthly);
    if (data.overpayAnnual !== undefined) setOverpayAnnual(data.overpayAnnual);
    if (data.councilTax !== undefined) setCouncilTax(data.councilTax);
    if (data.housePriceGrowth !== undefined) setHousePriceGrowth(data.housePriceGrowth);

    if (!Array.isArray(data.purchaseCosts)) {
      setPaymentTiming(PURCHASE_DEFAULTS.paymentTiming);
      setFirstPaymentDays(PURCHASE_DEFAULTS.firstPaymentDays);
      setPaymentOverride(PURCHASE_DEFAULTS.paymentOverride);
      setFirstPaymentOverride(PURCHASE_DEFAULTS.firstPaymentOverride);
      setReserveFirstPayment(PURCHASE_DEFAULTS.reserveFirstPayment);
      setProductFee(PURCHASE_DEFAULTS.productFee);
      setProductFeeAddToLoan(PURCHASE_DEFAULTS.productFeeAddToLoan);
      setProductFeePaid(PURCHASE_DEFAULTS.productFeePaid);
      setFixedRateEndDate(PURCHASE_DEFAULTS.fixedRateEndDate);
      setFollowOnRate(PURCHASE_DEFAULTS.followOnRate);
      setCompletionDate(PURCHASE_DEFAULTS.completionDate);
      setDepositPaid(PURCHASE_DEFAULTS.depositPaid);
      setStampDutyPaid(PURCHASE_DEFAULTS.stampDutyPaid);
      setIncludeExtrasInProjection(PURCHASE_DEFAULTS.includeExtrasInProjection);
      setCouncilTaxInBills(PURCHASE_DEFAULTS.councilTaxInBills);
    }
    if (data.paymentTiming === "advance" || data.paymentTiming === "arrears") setPaymentTiming(data.paymentTiming);
    if (data.firstPaymentDays !== undefined) setFirstPaymentDays(Math.max(0, Number(data.firstPaymentDays) || 0));
    if (data.paymentOverride !== undefined) setPaymentOverride(Number(data.paymentOverride) || 0);
    if (data.firstPaymentOverride !== undefined) setFirstPaymentOverride(Number(data.firstPaymentOverride) || 0);
    if (data.reserveFirstPayment !== undefined) setReserveFirstPayment(Boolean(data.reserveFirstPayment));
    if (data.productFee !== undefined) setProductFee(Number(data.productFee) || 0);
    if (data.productFeeAddToLoan !== undefined) setProductFeeAddToLoan(Boolean(data.productFeeAddToLoan));
    if (data.productFeePaid !== undefined) setProductFeePaid(Boolean(data.productFeePaid));
    if (isIsoDateOrEmpty(data.fixedRateEndDate)) setFixedRateEndDate(data.fixedRateEndDate);
    if (data.followOnRate !== undefined) setFollowOnRate(Number(data.followOnRate) || 0);
    if (isIsoDateOrEmpty(data.completionDate)) setCompletionDate(data.completionDate);
    if (data.depositPaid !== undefined) setDepositPaid(Boolean(data.depositPaid));
    if (data.stampDutyPaid !== undefined) setStampDutyPaid(Boolean(data.stampDutyPaid));
    if (data.includeExtrasInProjection !== undefined) setIncludeExtrasInProjection(Boolean(data.includeExtrasInProjection));
    if (data.councilTaxInBills !== undefined) setCouncilTaxInBills(Number(data.councilTaxInBills) || 0);

    if (Array.isArray(data.purchaseCosts)) {
      setPurchaseCosts(data.purchaseCosts.filter((c) => c && typeof c === "object").map(normalisePurchaseCost));
    } else {
      const legacyCosts = [];
      const pushLegacy = (fields) => legacyCosts.push(normalisePurchaseCost({ id: legacyCosts.length + 1, ...fields }, legacyCosts.length));
      if (data.solicitorFees !== undefined) pushLegacy({ name: "Solicitor / conveyancing", upfront: data.solicitorFees });
      if (data.surveyFees !== undefined) pushLegacy({ name: "Survey", upfront: data.surveyFees });
      if (data.homeInsurance !== undefined) {
        const monthly = Number(data.homeInsurance) || 0;
        pushLegacy({ name: "Home insurance", upfront: Math.round(monthly * 1200) / 100, monthly, payment: "monthly", renews: "yearly" });
      }
      if (data.movingCosts !== undefined) pushLegacy({ name: "Moving costs", upfront: data.movingCosts, category: "extra" });
      setPurchaseCosts(legacyCosts.length > 0 ? legacyCosts : DEFAULT_PURCHASE_COSTS);
    }
    if (data.investYears !== undefined) setInvestYears(data.investYears);
    if (data.agreements !== undefined) setAgreements(data.agreements);
    if (data.projectionMonths !== undefined) setProjectionMonths(data.projectionMonths);
    if (data.salaryGrowth !== undefined) setSalaryGrowth(data.salaryGrowth);
    if (data.inflationRate !== undefined) setInflationRate(data.inflationRate);
    if (data.projSavingsModel !== undefined) setProjSavingsModel(data.projSavingsModel);
    if (data.projIncludePots !== undefined) setProjIncludePots(data.projIncludePots);
    else if (data.projIncludeISA !== undefined || data.projIncludeInvest !== undefined) {
      setProjIncludePots(Boolean(data.projIncludeISA || data.projIncludeInvest));
    }
    if (data.projIncludeModel !== undefined) setProjIncludeModel(data.projIncludeModel);
    if (data.projIncludePYF !== undefined) setProjIncludePYF(data.projIncludePYF);
    if (data.expenseLog !== undefined) setExpenseLog(data.expenseLog);
  };

  const handleSave = () => {
    const json = JSON.stringify(getAllState(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finances-${isoToday()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveNotice("Saved!");
    setTimeout(() => setSaveNotice(""), 2000);
  };

  const handleLoad = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        loadState(data);
        setSaveNotice(`Loaded from ${data._savedAt ? new Date(data._savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "file"}`);
        setTimeout(() => setSaveNotice(""), 3000);
      } catch {
        setSaveNotice("Error: invalid file");
        setTimeout(() => setSaveNotice(""), 3000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const addExpenseEntry = () => {
    if (!newExpenseName || newExpenseAmount <= 0) return;
    setExpenseLog([
      { id: Date.now(), name: newExpenseName, amount: newExpenseAmount, category: newExpenseCategory, date: newExpenseDate },
      ...expenseLog,
    ]);
    setNewExpenseName("");
    setNewExpenseAmount(0);
  };

  const removeExpenseEntry = (id) => {
    setExpenseLog(expenseLog.filter((e) => e.id !== id));
  };

  const expenseLogTotal = expenseLog.reduce((s, e) => s + e.amount, 0);
  const expenseLogByCategory = useMemo(() => {
    const cats = {};
    expenseLog.forEach((e) => {
      cats[e.category] = (cats[e.category] || 0) + e.amount;
    });
    return Object.entries(cats).map(([name, value]) => ({ name, value }));
  }, [expenseLog]);

  const annualSacrificeP1 = useMemo(
    () => pots.filter((p) => p.owner === "p1" && p.salarySacrifice).reduce((s, p) => s + (p.monthlyContribution || 0) * 12, 0),
    [pots]
  );
  const annualSacrificeP2 = useMemo(
    () => pots.filter((p) => p.owner === "p2" && p.salarySacrifice).reduce((s, p) => s + (p.monthlyContribution || 0) * 12, 0),
    [pots]
  );

  const computeCalc = (salary, otherIncome, otherType, pensionPct, studentLoanPlan, sacrificeAmt) => {
    const seIncome = otherType === "selfEmployed" ? (otherIncome || 0) : 0;
    const payeOther = otherType === "selfEmployed" ? 0 : (otherIncome || 0);
    const fullGross = salary + (otherIncome || 0);
    const pensionAmt = salary * (pensionPct / 100);
    const payeTaxable = Math.max(0, salary + payeOther - pensionAmt - sacrificeAmt);
    const payeTax = calculateIncomeTax(payeTaxable);
    const payeNi = calculateNI(payeTaxable);
    const slThreshold = STUDENT_LOAN_THRESHOLDS[studentLoanPlan];
    const payeSL = slThreshold && payeTaxable > slThreshold ? (payeTaxable - slThreshold) * STUDENT_LOAN_RATE : 0;
    const payeNet = salary + payeOther - payeTax - payeNi - pensionAmt - sacrificeAmt - payeSL;

    let saExtraTax = 0, class4Ni = 0, saExtraSL = 0;
    if (seIncome > 0) {
      const combinedTaxable = payeTaxable + seIncome;
      saExtraTax = Math.max(0, calculateIncomeTax(combinedTaxable) - payeTax);
      class4Ni = calculateClass4NI(seIncome);
      if (slThreshold) {
        const totalSL = combinedTaxable > slThreshold ? (combinedTaxable - slThreshold) * STUDENT_LOAN_RATE : 0;
        saExtraSL = Math.max(0, totalSL - payeSL);
      }
    }
    const saTaxBill = saExtraTax + class4Ni + saExtraSL;
    const seNet = seIncome - saTaxBill;

    const tax = payeTax + saExtraTax;
    const ni = payeNi + class4Ni;
    const slRepay = payeSL + saExtraSL;
    const net = payeNet + seNet;
    return {
      gross: fullGross, pensionAmt, sacrificeAmt,
      tax, ni, slRepay, net, monthly: net / 12,
      payeNet, payeMonthly: payeNet / 12,
      seIncome, seNet, saTaxBill, class4Ni, saExtraTax, saExtraSL,
    };
  };

  const calc1 = useMemo(
    () => computeCalc(salary1, otherIncome1, otherIncomeType1, pension1, studentLoan1, annualSacrificeP1),
    [salary1, otherIncome1, otherIncomeType1, pension1, studentLoan1, annualSacrificeP1]
  );

  const calc2 = useMemo(() => {
    if (mode === MODE.SINGLE) return { gross: 0, pensionAmt: 0, sacrificeAmt: 0, tax: 0, ni: 0, slRepay: 0, net: 0, monthly: 0, payeNet: 0, payeMonthly: 0, seIncome: 0, seNet: 0, saTaxBill: 0, class4Ni: 0, saExtraTax: 0, saExtraSL: 0 };
    return computeCalc(salary2, otherIncome2, otherIncomeType2, pension2, studentLoan2, annualSacrificeP2);
  }, [salary2, otherIncome2, otherIncomeType2, pension2, studentLoan2, mode, annualSacrificeP2]);

  const totalMonthlyNet = calc1.monthly + calc2.monthly;
  const totalExpenses = rent + bills + food + transport + subscriptions + otherExpenses + customExpensesTotal;
  const disposable = totalMonthlyNet - totalExpenses;
  const councilTaxInBillsApplied = Math.min(Math.max(0, councilTaxInBills), bills);
  const postLivingExpenses = totalExpenses - rent - councilTaxInBillsApplied;

  const totalExistingSavings = useMemo(() => pots.reduce((s, p) => s + (p.startingBalance || 0), 0), [pots]);
  const totalMonthlyPotContributions = useMemo(() => pots.reduce((s, p) => s + (p.monthlyContribution || 0), 0), [pots]);
  const monthlySacrificedContributions = useMemo(
    () => pots.filter((p) => p.salarySacrifice).reduce((s, p) => s + (p.monthlyContribution || 0), 0),
    [pots]
  );
  const monthlyNonSacrificedPotContributions = totalMonthlyPotContributions - monthlySacrificedContributions;
  const blendedRate = useMemo(() => {
    const denom = pots.reduce((s, p) => s + (p.startingBalance || 0), 0);
    if (denom <= 0) {
      const cDenom = pots.reduce((s, p) => s + (p.monthlyContribution || 0), 0);
      if (cDenom <= 0) return 0;
      return pots.reduce((s, p) => s + (p.monthlyContribution || 0) * (p.rate || 0), 0) / cDenom;
    }
    return pots.reduce((s, p) => s + (p.startingBalance || 0) * (p.rate || 0), 0) / denom;
  }, [pots]);

  const potsByOwner = useMemo(() => {
    const owners = { p1: { starting: 0, monthly: 0, count: 0 }, p2: { starting: 0, monthly: 0, count: 0 }, joint: { starting: 0, monthly: 0, count: 0 } };
    pots.forEach((p) => {
      const o = owners[p.owner] || owners.p1;
      o.starting += p.startingBalance || 0;
      o.monthly += p.monthlyContribution || 0;
      o.count += 1;
    });
    return owners;
  }, [pots]);

  const projectPotsFrom = useCallback((sourcePots, monthsAhead, includeFlag = true) => {
    const months = Math.max(0, Math.floor(monthsAhead));
    const series = sourcePots.map((p) => ({ id: p.id, name: p.name, owner: p.owner, type: p.type, rate: p.rate, compounding: p.compounding || defaultCompoundingFor(p.type), history: [] }));
    const balances = sourcePots.map((p) => p.startingBalance || 0);
    const principals = sourcePots.map((p) => p.startingBalance || 0);
    for (let m = 0; m <= months; m++) {
      sourcePots.forEach((p, i) => {
        if (m > 0 && includeFlag) {
          const mode = p.compounding || defaultCompoundingFor(p.type);
          const { grow } = Object.hasOwn(COMPOUNDING_MODES, mode) ? COMPOUNDING_MODES[mode] : COMPOUNDING_MODES.none;
          balances[i] = grow(balances[i], p.monthlyContribution || 0, (p.rate || 0) / 100, m, principals[i]);
        }
        series[i].history.push(Math.round(balances[i]));
      });
    }
    const total = [];
    for (let m = 0; m <= months; m++) {
      total.push(series.reduce((s, p) => s + p.history[m], 0));
    }
    return { series, total };
  }, []);

  const buildPotsProjection = useCallback((monthsAhead, includeFlag = true) => projectPotsFrom(pots, monthsAhead, includeFlag), [projectPotsFrom, pots]);

  const drainPotsForUpfront = useCallback((amount) => {
    const isMonthlyCompounded = (p) => (p.compounding || defaultCompoundingFor(p.type)) === "monthly";
    const drainTiers = [
      (p) => p.type === "current",
      (p) => p.type === "savings",
      (p) => p.type === "lisa",
      (p) => p.type === "isa" && !isMonthlyCompounded(p),
      (p) => p.type === "isa" && isMonthlyCompounded(p),
      (p) => p.type === "other",
      (p) => p.type === "investment",
      (p) => p.type === "shareScheme",
      (p) => p.type === "pension",
      () => true,
    ];
    const next = pots.map((p) => ({ ...p }));
    const drawdown = {};
    let remaining = Math.max(0, amount);
    for (const matches of drainTiers) {
      if (remaining <= 0) break;
      for (const p of next) {
        if (remaining <= 0) break;
        if (!p.forPurchase || !matches(p)) continue;
        const take = Math.min(Math.max(0, p.startingBalance || 0), remaining);
        if (take > 0) {
          drawdown[p.id] = (drawdown[p.id] || 0) + take;
          p.startingBalance -= take;
          remaining -= take;
        }
      }
    }
    return { drainedPots: next, drawdown, shortfall: remaining };
  }, [pots]);

  const potsLongProjection = useMemo(() => buildPotsProjection(investYears * 12, true), [buildPotsProjection, investYears]);

  const splitP1Pct = useMemo(() => {
    if (mode === MODE.SINGLE) return 100;
    if (splitMode === SPLIT_MODE.CUSTOM_PERCENT) return customSplitP1;
    const total = calc1.monthly + calc2.monthly;
    return total > 0 ? (calc1.monthly / total) * 100 : 50;
  }, [mode, splitMode, customSplitP1, calc1.monthly, calc2.monthly]);
  const splitP2Pct = 100 - splitP1Pct;

  const splitExpenseRows = useMemo(() => {
    const standard = [
      { name: "Rent / Mortgage", amount: rent },
      { name: "Bills", amount: bills },
      { name: "Food & Groceries", amount: food },
      { name: "Transport", amount: transport },
      { name: "Subscriptions", amount: subscriptions },
      { name: "Other", amount: otherExpenses },
    ].map(e => ({ ...e, splitType: "shared" }));
    const custom = customExpenses.map(ce => ({ name: ce.name, amount: ce.amount, splitType: ce.splitType || "shared" }));
    return [...standard, ...custom].filter(e => e.amount > 0).map(e => {
      let p1, p2;
      if (e.splitType === "p1") { p1 = e.amount; p2 = 0; }
      else if (e.splitType === "p2") { p1 = 0; p2 = e.amount; }
      else { p1 = e.amount * splitP1Pct / 100; p2 = e.amount * splitP2Pct / 100; }
      return { ...e, p1, p2 };
    });
  }, [rent, bills, food, transport, subscriptions, otherExpenses, customExpenses, splitP1Pct, splitP2Pct]);
  const splitTotalP1 = splitExpenseRows.reduce((s, e) => s + e.p1, 0);
  const splitTotalP2 = splitExpenseRows.reduce((s, e) => s + e.p2, 0);

  const agreementPayments = useMemo(() => {
    return agreements.map((a) => {
      const r = a.rate / 100 / 12;
      const n = a.termMonths;
      if (r === 0) return { ...a, monthlyPayment: a.amount / n, totalCost: a.amount, totalInterest: 0 };
      const mp = (a.amount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      return { ...a, monthlyPayment: mp, totalCost: mp * n, totalInterest: mp * n - a.amount };
    });
  }, [agreements]);

  const totalAgreementMonthly = agreementPayments.reduce((s, a) => s + a.monthlyPayment, 0);

  const needsExpenses = rent + bills + food + transport;
  const wantsExpenses = subscriptions + otherExpenses + customExpensesTotal;
  const allExpenses = totalExpenses;

  const savingsModels = useMemo(() => {
    const income = totalMonthlyNet;
    const afterDebt = totalAgreementMonthly;
    return {
      "50/30/20": {
        needs: income * 0.5,
        wants: income * 0.3,
        savings: income * 0.2,
        actualNeeds: needsExpenses,
        actualWants: wantsExpenses,
        actualSavings: Math.max(0, income - allExpenses - afterDebt),
        needsGap: income * 0.5 - needsExpenses,
        wantsGap: income * 0.3 - wantsExpenses,
      },
      "70/20/10": {
        living: income * 0.7,
        savings: income * 0.2,
        debt: income * 0.1,
        actualLiving: allExpenses,
        actualDebt: afterDebt,
        actualSavings: Math.max(0, income - allExpenses - afterDebt),
        livingGap: income * 0.7 - allExpenses,
        debtGap: income * 0.1 - afterDebt,
      },
      "Pay Yourself First": {
        savings: pyfSavingsTarget,
        remaining: income - pyfSavingsTarget,
        actualAfterSavings: income - pyfSavingsTarget - allExpenses - afterDebt,
      },
    };
  }, [totalMonthlyNet, pyfSavingsTarget, needsExpenses, wantsExpenses, allExpenses, totalAgreementMonthly]);

  const mortgage = useMemo(() => {
    const requestedLoan = Math.max(0, housePrice - deposit);
    const feeAddedToLoan = productFeeAddToLoan ? Math.max(0, productFee) : 0;
    const totalBorrowing = requestedLoan + feeAddedToLoan;
    const n = Math.max(0, Math.round(mortgageTerm * 12));
    const fixedFromDate = fixedRateEndDate ? calendarMonthsBetween(completionDate || todayISO, fixedRateEndDate) : null;
    const fixExpired = fixedFromDate !== null && fixedFromDate <= 0;
    const followOnRateUsed = followOnRate > 0 ? followOnRate : Math.max(0, mortgageRate);
    const initialRate = fixExpired ? followOnRateUsed : Math.max(0, mortgageRate);
    const fixedMonths = fixedFromDate > 0 ? Math.min(fixedFromDate, n) : n;
    const hasFollowOn = fixedMonths < n;
    const paymentAdvance = mortgagePayment(totalBorrowing, initialRate, n, "advance");
    const paymentArrears = mortgagePayment(totalBorrowing, initialRate, n, "arrears");
    const calculatedPayment = paymentTiming === "arrears" ? paymentArrears : paymentAdvance;
    const isPaymentOverridden = paymentOverride > 0;
    const monthlyPayment = isPaymentOverridden ? paymentOverride : calculatedPayment;
    const dailyInterest = (totalBorrowing * initialRate) / 100 / 365;
    const autoStub = n > 0 ? dailyInterest * Math.max(0, firstPaymentDays) : 0;
    const calculatedFirstPayment = monthlyPayment + autoStub;
    const isFirstPaymentOverridden = firstPaymentOverride > 0;
    const firstPayment = isFirstPaymentOverridden ? firstPaymentOverride : calculatedFirstPayment;
    const stubInterest = isFirstPaymentOverridden ? Math.max(0, firstPaymentOverride - monthlyPayment) : autoStub;
    const scheduleInputs = { months: n, timing: paymentTiming, rate: initialRate, followOnRate: followOnRateUsed, fixedMonths };
    const schedule = buildMortgageSchedule({ ...scheduleInputs, principal: totalBorrowing, payment: monthlyPayment, firstPayment, stubInterest, overpayMonthly, overpayAnnual });
    const { base } = schedule;
    const repaidBeforeFixEnd = hasFollowOn && base.payoffMonth !== null && base.payoffMonth <= fixedMonths;
    const fixFromToday = fixedRateEndDate && completionDate > todayISO ? calendarMonthsBetween(todayISO, fixedRateEndDate) : null;
    const fixedMonthsToday = fixFromToday > 0 ? Math.min(fixFromToday, n) : fixedMonths;
    const projectionSchedule = !fixExpired && fixedMonthsToday !== fixedMonths
      ? buildMortgageSchedule({ ...scheduleInputs, fixedMonths: fixedMonthsToday, principal: totalBorrowing, payment: monthlyPayment, firstPayment, stubInterest, overpayMonthly, overpayAnnual })
      : schedule;

    let feeLoanCost = null;
    if (productFee > 0 && n > 0) {
      const runFor = (principal) => {
        const pay = mortgagePayment(principal, initialRate, n, paymentTiming);
        const stub = ((principal * initialRate) / 100 / 365) * Math.max(0, firstPaymentDays);
        return { pay, run: runMortgage({ ...scheduleInputs, principal, payment: pay, firstPayment: pay + stub, stubInterest: stub }, 0, 0, null) };
      };
      const withoutFee = runFor(requestedLoan);
      const withFee = runFor(requestedLoan + productFee);
      feeLoanCost = { monthly: withFee.pay - withoutFee.pay, interest: withFee.run.totalInterest - withoutFee.run.totalInterest };
    }

    const lowFirstPayment = isFirstPaymentOverridden && firstPaymentOverride < monthlyPayment - MORTGAGE_EPS;
    const negAmFrom = negAmMonthIgnoringShortFirstPayment(base, lowFirstPayment);

    const warnings = [];
    if (fixExpired) warnings.push({ level: "warn", text: `Your fixed rate ends before your first monthly payment, so the follow-on rate (${followOnRateUsed}%) is used from the start — check the dates.` });
    if (hasFollowOn && !repaidBeforeFixEnd && !(followOnRate > 0)) warnings.push({ level: "warn", text: `No follow-on rate entered, so ${mortgageRate}% is assumed after ${fmtDate(fixedRateEndDate)}. Add your lender's standard variable rate to see the likely payment.` });
    if (lowFirstPayment) warnings.push({ level: "warn", text: `Your manual first payment (${fmt2(firstPaymentOverride)}) is less than the monthly payment (${fmt2(monthlyPayment)}). Enter the full first payment shown on your mortgage offer or illustration (usually the monthly payment plus interest from completion), or leave it at 0 to use the calculated figure.` });
    if (negAmFrom) warnings.push({ level: "error", text: `From month ${negAmFrom} the payment doesn't cover the interest, so the balance grows.` });
    if (n > 0 && base.residual > MORTGAGE_EPS) {
      warnings.push({ level: "error", text: lowFirstPayment && !negAmFrom && !isPaymentOverridden
        ? `Because the first payment is short, about ${fmt2(base.residual)} would still be owed at the end of the ${mortgageTerm}-year term.`
        : `At this payment, ${fmt2(base.residual)} would still be owed at the end of the ${mortgageTerm}-year term.` });
    }
    if (isPaymentOverridden && base.payoffMonth && base.payoffMonth < n) warnings.push({ level: "info", text: `At this payment the mortgage would be repaid in ${fmtYearsMonths(base.payoffMonth)} — ${fmtYearsMonths(n - base.payoffMonth)} early.` });

    return {
      requestedLoan, feeAddedToLoan, totalBorrowing,
      ltv: housePrice > 0 ? ((requestedLoan / housePrice) * 100).toFixed(1) : "0.0",
      n, initialRate, paymentAdvance, paymentArrears, calculatedPayment, monthlyPayment, isPaymentOverridden,
      dailyInterest, stubInterest, calculatedFirstPayment, firstPayment, isFirstPaymentOverridden,
      fixedMonths, hasFollowOn, fixExpired, repaidBeforeFixEnd,
      followOnRateUsed: hasFollowOn ? followOnRateUsed : null,
      followOnPayment: hasFollowOn && !repaidBeforeFixEnd ? base.followOnPayment : null,
      totalInterest: base.totalInterest,
      totalRepaid: base.totalPaid + base.residual,
      residual: base.residual,
      payoffMonth: base.payoffMonth,
      stampDuty: calculateStampDuty(housePrice, isFirstTimeBuyer),
      feeLoanCost, schedule, projectionSchedule, warnings,
    };
  }, [housePrice, deposit, mortgageTerm, mortgageRate, isFirstTimeBuyer, productFee, productFeeAddToLoan, paymentTiming, paymentOverride, firstPaymentOverride, firstPaymentDays, completionDate, todayISO, fixedRateEndDate, followOnRate, overpayMonthly, overpayAnnual]);

  const purchasePlan = useMemo(() => {
    const autoRows = [
      { key: "deposit", name: "Deposit", amount: deposit, counted: true, paid: depositPaid, canMarkPaid: true },
      { key: "stampDuty", name: "Stamp duty", amount: mortgage.stampDuty, counted: true, paid: stampDutyPaid, canMarkPaid: true },
      { key: "firstPayment", name: "First mortgage payment", amount: mortgage.firstPayment, counted: reserveFirstPayment, paid: false, canMarkPaid: false },
    ];
    if (productFee > 0) autoRows.push({ key: "productFee", name: "Product fee", amount: productFee, counted: !productFeeAddToLoan, paid: productFeePaid && !productFeeAddToLoan, canMarkPaid: !productFeeAddToLoan });
    const upfrontRows = [
      ...autoRows.filter((r) => r.counted).map((r) => ({ key: r.key, name: r.name, amount: r.amount, category: "essential", paid: r.paid, isAuto: true })),
      ...purchaseCosts.filter((c) => c.payment === "upfront").map((c) => ({ key: `pc${c.id}`, id: c.id, name: c.name, amount: c.upfront || 0, category: c.category, paid: !!c.paid, isAuto: false })),
    ];
    const sumRows = (category, include) => upfrontRows.reduce((s, r) => s + (r.category === category && include(r) ? r.amount : 0), 0);
    const essentialsTotal = sumRows("essential", () => true);
    const extrasTotal = sumRows("extra", () => true);
    const essentialsPaid = sumRows("essential", (r) => r.paid);
    const extrasPaid = sumRows("extra", (r) => r.paid);
    const essentialsToPay = essentialsTotal - essentialsPaid;
    const extrasToPay = extrasTotal - extrasPaid;
    const idealToPay = essentialsToPay + extrasToPay;
    const drainAmount = essentialsToPay + (includeExtrasInProjection ? extrasToPay : 0);
    const otherEssentialRows = upfrontRows.filter((r) => !r.isAuto && r.category === "essential");

    const inProjection = (c) => c.category === "essential" || includeExtrasInProjection;
    const monthlyItems = purchaseCosts
      .filter((c) => c.payment === "monthly" && (c.monthly || 0) > 0)
      .map((c) => ({ id: c.id, name: c.name, label: c.name, monthly: c.monthly, splitType: c.splitType || "shared", category: c.category }));
    const monthlyTotal = monthlyItems.reduce((s, r) => s + r.monthly, 0);
    const monthlyProjectionTotal = monthlyItems.filter(inProjection).reduce((s, r) => s + r.monthly, 0);
    const annualItems = purchaseCosts
      .filter((c) => c.payment === "upfront" && c.renews === "yearly" && (c.upfront || 0) > 0)
      .map((c) => ({ id: c.id, name: c.name, annual: c.upfront, category: c.category }));
    const annualTotal = annualItems.reduce((s, r) => s + r.annual, 0);
    const annualRenewalTotal = annualItems.filter(inProjection).reduce((s, r) => s + r.annual, 0);

    const ownerKey = (o) => (o === "p2" || o === "joint" ? o : "p1");
    const byOwner = () => ({ p1: 0, p2: 0, joint: 0 });
    const ownerSum = (o) => o.p1 + o.p2 + o.joint;
    const tickedPots = pots.filter((p) => p.forPurchase);
    const availableTodayByOwner = byOwner();
    const tickedMonthlyByOwner = byOwner();
    tickedPots.forEach((p) => {
      availableTodayByOwner[ownerKey(p.owner)] += Math.max(0, p.startingBalance || 0);
      tickedMonthlyByOwner[ownerKey(p.owner)] += p.monthlyContribution || 0;
    });
    const availableToday = ownerSum(availableTodayByOwner);
    const tickedMonthly = ownerSum(tickedMonthlyByOwner);

    const completionAhead = !!completionDate && completionDate > todayISO;
    const monthsToCompletion = completionAhead ? Math.min(1200, Math.max(0, wholeMonthsBetween(todayISO, completionDate))) : 0;
    const completionInFuture = monthsToCompletion > 0;
    const horizon = Math.max(PLANNER_HORIZON_MONTHS, monthsToCompletion);
    const projection = projectPotsFrom(pots, horizon, true);
    const tickedSeries = projection.series.filter((s) => pots.find((p) => p.id === s.id)?.forPurchase);
    const tickedTotalAt = (m) => tickedSeries.reduce((s, x) => s + Math.max(0, x.history[m] || 0), 0);
    const potAtCompletion = {};
    projection.series.forEach((s) => { potAtCompletion[s.id] = Math.max(0, s.history[monthsToCompletion] || 0); });
    const availableAtCompletionByOwner = byOwner();
    if (completionInFuture) {
      tickedSeries.forEach((s) => { availableAtCompletionByOwner[ownerKey(s.owner)] += potAtCompletion[s.id]; });
    } else {
      Object.assign(availableAtCompletionByOwner, availableTodayByOwner);
    }
    const availableAtCompletion = ownerSum(availableAtCompletionByOwner);
    const available = completionInFuture ? availableAtCompletion : availableToday;
    const availableByOwner = completionInFuture ? availableAtCompletionByOwner : availableTodayByOwner;

    const gap = essentialsToPay - available;
    const gapIdeal = idealToPay - available;
    const closeMonth = (need) => {
      if (need <= availableToday + MORTGAGE_EPS) return 0;
      for (let m = 1; m <= horizon; m++) if (tickedTotalAt(m) >= need) return m;
      return null;
    };
    const gapCloseMonth = closeMonth(essentialsToPay);
    const gapIdealCloseMonth = closeMonth(idealToPay);
    const extraNeeded = (g) => (completionInFuture && g > MORTGAGE_EPS ? g / monthsToCompletion : null);

    const comparisonRows = purchaseCosts
      .filter((c) => c.renews === "yearly" && (c.upfront || 0) > 0 && (c.monthly || 0) > 0)
      .map((c) => ({ id: c.id, name: c.name, upfront: c.upfront, monthly: c.monthly, annualMonthly: c.monthly * 12, saving: c.monthly * 12 - c.upfront, payment: c.payment, paid: !!c.paid, category: c.category }));

    return {
      autoRows, upfrontRows,
      essentialsTotal, extrasTotal, idealTotal: essentialsTotal + extrasTotal,
      essentialsPaid, extrasPaid, paidTotal: essentialsPaid + extrasPaid,
      essentialsToPay, extrasToPay, idealToPay, drainAmount,
      otherEssentialsTotal: otherEssentialRows.reduce((s, r) => s + r.amount, 0),
      otherEssentialsCount: otherEssentialRows.length,
      extrasCount: upfrontRows.filter((r) => r.category === "extra").length,
      monthlyItems, monthlyTotal, monthlyProjectionTotal, annualItems, annualTotal, annualRenewalTotal,
      tickedCount: tickedPots.length, tickedMonthly, tickedMonthlyByOwner,
      availableToday, availableTodayByOwner,
      monthsToCompletion, completionInFuture, completionSoon: completionAhead && !completionInFuture,
      potAtCompletion, availableAtCompletion, availableAtCompletionByOwner, available, availableByOwner,
      gap, gapIdeal,
      gapToday: essentialsToPay - availableToday,
      gapIdealToday: idealToPay - availableToday,
      gapDrainToday: drainAmount - availableToday,
      gapCloseMonth, gapIdealCloseMonth,
      gapCloseDate: gapCloseMonth === null ? null : dateAfterMonths(todayISO, gapCloseMonth),
      gapIdealCloseDate: gapIdealCloseMonth === null ? null : dateAfterMonths(todayISO, gapIdealCloseMonth),
      extraMonthlyNeeded: extraNeeded(gap),
      extraMonthlyNeededIdeal: extraNeeded(gapIdeal),
      comparisonRows,
    };
  }, [deposit, depositPaid, stampDutyPaid, mortgage.stampDuty, mortgage.firstPayment, reserveFirstPayment, productFee, productFeeAddToLoan, productFeePaid, purchaseCosts, includeExtrasInProjection, pots, completionDate, todayISO, projectPotsFrom]);

  const coverText = (month, date) => {
    if (month === 0) return "Now";
    if (month === null) return "Not within 10 years";
    return `${fmtMonthYear(date)} (in ${month} month${month === 1 ? "" : "s"})`;
  };

  const postMortgageSplitRows = useMemo(() => {
    const standard = [
      { name: "Mortgage Payment", amount: mortgage.monthlyPayment },
      { name: "Council Tax", amount: councilTax },
      { name: councilTaxInBillsApplied > 0 ? "Bills (excl. current council tax)" : "Bills", amount: bills - councilTaxInBillsApplied },
      { name: "Food & Groceries", amount: food },
      { name: "Transport", amount: transport },
      { name: "Subscriptions", amount: subscriptions },
      { name: "Other", amount: otherExpenses },
    ].map(e => ({ ...e, splitType: "shared" }));
    if (overpayMonthly > 0) standard.push({ name: "Mortgage Overpayment", amount: overpayMonthly, splitType: "shared" });
    const purchaseMonthly = purchasePlan.monthlyItems.map((c) => ({ name: c.label, amount: c.monthly, splitType: c.splitType }));
    const custom = customExpenses.map(ce => ({ name: ce.name, amount: ce.amount, splitType: ce.splitType || "shared" }));
    return [...standard, ...purchaseMonthly, ...custom].filter(e => e.amount > 0).map(e => {
      let p1, p2;
      if (e.splitType === "p1") { p1 = e.amount; p2 = 0; }
      else if (e.splitType === "p2") { p1 = 0; p2 = e.amount; }
      else { p1 = e.amount * splitP1Pct / 100; p2 = e.amount * splitP2Pct / 100; }
      return { ...e, p1, p2 };
    });
  }, [mortgage.monthlyPayment, councilTax, councilTaxInBillsApplied, bills, food, transport, subscriptions, otherExpenses, overpayMonthly, purchasePlan.monthlyItems, customExpenses, splitP1Pct, splitP2Pct]);
  const postSplitTotalP1 = postMortgageSplitRows.reduce((s, e) => s + e.p1, 0);
  const postSplitTotalP2 = postMortgageSplitRows.reduce((s, e) => s + e.p2, 0);
  const postSplitTotal = postMortgageSplitRows.reduce((s, e) => s + e.amount, 0);

  const activeSavingsGoal = useMemo(() => {
    const { modelName, total } = monthlySavings(projSavingsModel, projIncludeModel, projIncludePYF, totalMonthlyNet, pyfSavingsTarget);
    return { amount: total, label: projIncludeModel ? modelName : (projIncludePYF ? "Pay Yourself First" : "") };
  }, [projSavingsModel, projIncludeModel, projIncludePYF, totalMonthlyNet, pyfSavingsTarget]);

  const personalCommitmentRows = useMemo(() => {
    const rows = [];
    if (activeSavingsGoal.amount > 0) rows.push({ name: `Savings Goal (${activeSavingsGoal.label})`, amount: activeSavingsGoal.amount, person: "p1" });
    if (projIncludePots) {
      pots.forEach((p) => {
        if ((p.monthlyContribution || 0) > 0) {
          rows.push({ name: `${p.name} (${p.type})`, amount: p.monthlyContribution, person: p.owner === "p2" ? "p2" : p.owner === "joint" ? "joint" : "p1" });
        }
      });
    }
    if (totalAgreementMonthly > 0) rows.push({ name: "Finance Agreements", amount: totalAgreementMonthly, person: "p1" });
    return rows;
  }, [activeSavingsGoal, projIncludePots, pots, totalAgreementMonthly]);
  const commitP1 = personalCommitmentRows.reduce((s, r) => s + (r.person === "p1" ? r.amount : r.person === "joint" ? r.amount * splitP1Pct / 100 : 0), 0);
  const commitP2 = personalCommitmentRows.reduce((s, r) => s + (r.person === "p2" ? r.amount : r.person === "joint" ? r.amount * splitP2Pct / 100 : 0), 0);
  const commitTotal = commitP1 + commitP2;

  const projectionPotSeries = useMemo(() => buildPotsProjection(projectionMonths, projIncludePots), [buildPotsProjection, projectionMonths, projIncludePots]);

  const projectionData = useMemo(() => {
    const data = [];
    let cashSavings = 0;
    let monthlyIncome = totalMonthlyNet;
    let monthlyExp = totalExpenses;

    for (let m = 0; m <= projectionMonths; m++) {
      if (m > 0 && m % 12 === 0) monthlyIncome *= 1 + salaryGrowth / 100;
      if (m > 0) monthlyExp *= 1 + inflationRate / 100 / 12;

      const totalMonthlyTarget = monthlySavings(projSavingsModel, projIncludeModel, projIncludePYF, monthlyIncome, pyfSavingsTarget).total;
      const activePotsMonthly = projIncludePots ? monthlyNonSacrificedPotContributions : 0;
      const afterExpenses = monthlyIncome - monthlyExp - totalAgreementMonthly;
      const afterCommitments = afterExpenses - activePotsMonthly;
      const actualSaving = Math.min(totalMonthlyTarget, Math.max(0, afterCommitments));

      if (m > 0) cashSavings += actualSaving;

      const potsTotal = projectionPotSeries.total[m] || 0;
      data.push({
        month: m,
        label: `M${m}`,
        income: Math.round(monthlyIncome),
        expenses: Math.round(monthlyExp + totalAgreementMonthly),
        saving: Math.round(actualSaving),
        cashSavings: Math.round(cashSavings),
        potsValue: Math.round(potsTotal),
        totalSavings: Math.round(cashSavings + potsTotal),
        disposable: Math.round(afterCommitments - actualSaving),
      });
    }
    return data;
  }, [projectionMonths, totalMonthlyNet, totalExpenses, totalAgreementMonthly, salaryGrowth, inflationRate, projSavingsModel, pyfSavingsTarget, projIncludeModel, projIncludePYF, projIncludePots, monthlyNonSacrificedPotContributions, projectionPotSeries]);

  const mortgageAmortisation = useMemo(() => {
    const { base, op } = mortgage.schedule;
    const n = mortgage.n;
    const data = [];
    let totalInt = 0;
    let totalIntOp = 0;
    for (let y = 1; y <= Math.ceil(n / 12); y++) {
      const to = Math.min(12 * y, n);
      let yearInterest = 0;
      let yearInterestOp = 0;
      for (let m = 12 * (y - 1) + 1; m <= to; m++) {
        yearInterest += base.rows[m].interest;
        yearInterestOp += op.rows[m].interest;
      }
      totalInt += yearInterest;
      totalIntOp += yearInterestOp;
      data.push({
        year: y,
        balance: Math.round(base.rows[to].balance),
        balanceOp: Math.round(op.rows[to].balance),
        interest: Math.round(yearInterest),
        interestOp: Math.round(yearInterestOp),
        totalInterest: Math.round(totalInt),
        totalInterestOp: Math.round(totalIntOp),
      });
    }
    const monthsReduced = Math.max(0, (base.payoffMonth ?? n) - (op.payoffMonth ?? n));
    return {
      data,
      totalInterest: base.totalInterest,
      totalInterestOp: op.totalInterest,
      interestSaved: base.totalInterest - op.totalInterest,
      paidOffYear: op.payoffMonth ? Math.ceil(op.payoffMonth / 12) : 0,
      payoffMonthOp: op.payoffMonth,
      monthsReduced,
      yearsReduced: Math.floor(monthsReduced / 12),
      fixEndYear: mortgage.hasFollowOn ? Math.ceil(mortgage.fixedMonths / 12) : null,
    };
  }, [mortgage]);

  const postPurchasePots = useMemo(() => {
    const { drainedPots, drawdown, shortfall } = drainPotsForUpfront(purchasePlan.drainAmount);
    const projection = projectPotsFrom(drainedPots, projectionMonths, projIncludePots);
    return { projection, drawdown, shortfall, drainAmount: purchasePlan.drainAmount };
  }, [drainPotsForUpfront, projectPotsFrom, purchasePlan.drainAmount, projectionMonths, projIncludePots]);

  const postPurchaseData = useMemo(() => {
    const data = [];
    let cash = -postPurchasePots.shortfall;
    let monthlyIncome = totalMonthlyNet;
    let livingCosts = postLivingExpenses + councilTax + purchasePlan.monthlyProjectionTotal;
    const potsProj = postPurchasePots.projection;
    const { op } = mortgage.projectionSchedule;
    let propertyValue = housePrice;

    for (let m = 0; m <= projectionMonths; m++) {
      if (m > 0 && m % 12 === 0) monthlyIncome *= 1 + salaryGrowth / 100;
      if (m > 0) livingCosts *= 1 + inflationRate / 100 / 12;

      const row = m >= 1 && m <= mortgage.n ? op.rows[m] : null;
      const firstFromIncome = m === 1 && !reserveFirstPayment && row ? row.payment : 0;
      let recurringMortgage = 0;
      if (m === 0) recurringMortgage = mortgage.monthlyPayment + overpayMonthly;
      else if (row) recurringMortgage = (m === 1 ? 0 : row.payment) + row.overpayment;
      const renewal = m > 0 && m % 12 === 0 ? purchasePlan.annualRenewalTotal : 0;
      const oneOff = firstFromIncome + (row ? row.lump : 0) + renewal;

      const totalMonthlyTarget = monthlySavings(projSavingsModel, projIncludeModel, projIncludePYF, monthlyIncome, pyfSavingsTarget).total;
      const activePotsMonthly = projIncludePots ? monthlyNonSacrificedPotContributions : 0;
      const afterExpenses = monthlyIncome - livingCosts - recurringMortgage - totalAgreementMonthly - activePotsMonthly;
      const actualSaving = Math.min(totalMonthlyTarget, Math.max(0, afterExpenses));

      if (m > 0) {
        cash += actualSaving - oneOff;
        propertyValue *= 1 + housePriceGrowth / 100 / 12;
      }

      const mortgageBalance = op.rows[Math.min(m, mortgage.n)].balance;
      const potsTotal = potsProj.total[m] || 0;
      const equity = propertyValue - mortgageBalance;

      data.push({
        month: m,
        label: `M${m}`,
        income: Math.round(monthlyIncome),
        expenses: Math.round(livingCosts + recurringMortgage + firstFromIncome + totalAgreementMonthly),
        mortgagePaid: Math.round(recurringMortgage + firstFromIncome),
        oneOffPaid: Math.round(oneOff),
        saving: Math.round(actualSaving),
        cashSavings: Math.round(Math.max(0, cash)),
        cashShortfall: Math.round(Math.max(0, -cash)),
        potsValue: Math.round(potsTotal),
        totalSavings: Math.round(cash + potsTotal),
        disposable: Math.round(afterExpenses - actualSaving),
        propertyValue: Math.round(propertyValue),
        mortgageBalance: Math.round(mortgageBalance),
        equity: Math.round(equity),
        netWealth: Math.round(cash + potsTotal + equity),
      });
    }
    return data;
  }, [projectionMonths, totalMonthlyNet, postLivingExpenses, councilTax, purchasePlan.monthlyProjectionTotal, purchasePlan.annualRenewalTotal, mortgage, reserveFirstPayment, overpayMonthly, totalAgreementMonthly, salaryGrowth, inflationRate, projSavingsModel, pyfSavingsTarget, projIncludeModel, projIncludePYF, projIncludePots, monthlyNonSacrificedPotContributions, postPurchasePots, housePrice, housePriceGrowth]);

  const addAgreement = () => {
    setAgreements([...agreements, { name: "New Agreement", amount: 5000, rate: 5, termMonths: 24 }]);
  };

  const updateAgreement = (idx, field, value) => {
    const updated = [...agreements];
    updated[idx] = { ...updated[idx], [field]: value };
    setAgreements(updated);
  };

  const removeAgreement = (idx) => {
    setAgreements(agreements.filter((_, i) => i !== idx));
  };

  const snapshot = useMemo(() => {
    const { modelName: selectedModel, extraPYF, total: monthlySavingsGoal } = monthlySavings(projSavingsModel, projIncludeModel, projIncludePYF, totalMonthlyNet, pyfSavingsTarget);
    const activePotsMonthly = projIncludePots ? monthlyNonSacrificedPotContributions : 0;
    const monthlyMortgage = mortgage.monthlyPayment;

    const preCommitted = totalExpenses + totalAgreementMonthly + monthlySavingsGoal + activePotsMonthly;
    const preDisposable = totalMonthlyNet - preCommitted;

    const postHousingMonthly = monthlyMortgage + overpayMonthly + councilTax + purchasePlan.monthlyTotal;
    const postCommitted = postLivingExpenses + postHousingMonthly + totalAgreementMonthly + monthlySavingsGoal + activePotsMonthly;
    const postDisposable = totalMonthlyNet - postCommitted;

    const projEnd = projectionData[projectionData.length - 1];
    const activeVehicles = [];
    if (projIncludePots && pots.length > 0) {
      const activePotCount = pots.filter((p) => (p.monthlyContribution || 0) > 0 || (p.startingBalance || 0) > 0).length;
      if (activePotCount > 0) activeVehicles.push(`${activePotCount} pot${activePotCount === 1 ? "" : "s"} (${fmt(activePotsMonthly)}/mo)`);
    }
    if (projIncludeModel) activeVehicles.push(selectedModel);
    if (extraPYF) activeVehicles.push(`PYF (${fmt(pyfSavingsTarget)}/mo)`);
    return { monthlySavingsGoal, monthlyMortgage, preCommitted, preDisposable, postHousingMonthly, postCommitted, postDisposable, projEnd, selectedModel, activeVehicles, activePotsMonthly };
  }, [totalMonthlyNet, totalExpenses, totalAgreementMonthly, projSavingsModel, pyfSavingsTarget, mortgage.monthlyPayment, postLivingExpenses, overpayMonthly, councilTax, purchasePlan.monthlyTotal, projectionData, projIncludeModel, projIncludePYF, projIncludePots, monthlyNonSacrificedPotContributions, pots]);

  const expensePieData = [
    { name: "Rent/Mortgage", value: rent },
    { name: "Bills", value: bills },
    { name: "Food", value: food },
    { name: "Transport", value: transport },
    { name: "Subscriptions", value: subscriptions },
    { name: "Other", value: otherExpenses },
    ...customExpenses.map((ce) => ({ name: ce.name, value: ce.amount })),
  ].filter((d) => d.value > 0);

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#f8fafc", minHeight: "100vh", color: "#1e293b" }}>
      <div style={{ background: "linear-gradient(135deg, #6366f1, #8b5cf6)", padding: "24px 32px", color: "#fff" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Personal Finance Calculator</h1>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <p style={{ margin: "4px 0 0 0", opacity: 0.85, fontSize: 14 }}>UK Tax Year 2026/27 · Model your finances, plan your future</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {saveNotice && <span style={{ fontSize: 13, background: "#ffffff33", padding: "4px 12px", borderRadius: 6 }}>{saveNotice}</span>}
              <button onClick={handleSave} style={{ padding: "8px 16px", background: "#ffffff22", border: "1px solid #ffffff44", borderRadius: 8, color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                Save Data
              </button>
              <button onClick={() => fileInputRef.current?.click()} style={{ padding: "8px 16px", background: "#ffffff22", border: "1px solid #ffffff44", borderRadius: 8, color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                Load Data
              </button>
              <input ref={fileInputRef} type="file" accept=".json" onChange={handleLoad} style={{ display: "none" }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Toggle value={mode} onChange={setMode} labels={["Single Person", "Household"]} />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", borderBottom: "1px solid #e2e8f0", display: "flex", overflowX: "auto", background: "#fff" }}>
        {tabs.map((t, i) => (
          <button key={t} style={TAB_STYLE(tab === i)} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
        {tab === 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card title="Income — Person 1" color="#6366f1">
              <InputGroup label="Annual Salary" value={salary1} onChange={setSalary1} />
              <InputGroup label="Other Annual Income" value={otherIncome1} onChange={setOtherIncome1} />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Other Income Type</label>
                <select
                  value={otherIncomeType1}
                  onChange={(e) => setOtherIncomeType1(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15 }}
                  title="PAYE: bonus / second job taxed through payroll. Self-Employed: sole-trader / freelance profit — taxed via Self Assessment, no PAYE NI but Class 4 NI applies"
                >
                  <option value="paye">PAYE (bonus / second job)</option>
                  <option value="selfEmployed">Self-Employed (Self Assessment)</option>
                </select>
              </div>
              <InputGroup label="Pension Contribution" value={pension1} onChange={setPension1} prefix="" suffix="%" step={0.5} />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Student Loan</label>
                <select
                  value={studentLoan1}
                  onChange={(e) => setStudentLoan1(parseInt(e.target.value))}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15 }}
                >
                  {STUDENT_LOAN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </Card>

            {mode === MODE.HOUSEHOLD ? (
              <Card title="Income — Person 2" color="#8b5cf6">
                <InputGroup label="Annual Salary" value={salary2} onChange={setSalary2} />
                <InputGroup label="Other Annual Income" value={otherIncome2} onChange={setOtherIncome2} />
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Other Income Type</label>
                  <select
                    value={otherIncomeType2}
                    onChange={(e) => setOtherIncomeType2(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15 }}
                  >
                    <option value="paye">PAYE (bonus / second job)</option>
                    <option value="selfEmployed">Self-Employed (Self Assessment)</option>
                  </select>
                </div>
                <InputGroup label="Pension Contribution" value={pension2} onChange={setPension2} prefix="" suffix="%" step={0.5} />
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Student Loan</label>
                  <select
                    value={studentLoan2}
                    onChange={(e) => setStudentLoan2(parseInt(e.target.value))}
                    style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15 }}
                  >
                    {STUDENT_LOAN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </Card>
            ) : (
              <Card title="Take-Home Breakdown" color="#10b981">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <StatBox label="Gross" value={fmt(calc1.gross)} />
                  <StatBox label="Income Tax" value={fmt(calc1.tax)} color="#ef4444" />
                  <StatBox label="National Insurance" value={fmt(calc1.ni)} color="#f59e0b" />
                  <StatBox label="Pension" value={fmt(calc1.pensionAmt)} color="#8b5cf6" />
                  {calc1.sacrificeAmt > 0 && <StatBox label="Salary Sacrifice" value={fmt(calc1.sacrificeAmt)} color="#0ea5e9" />}
                  {calc1.slRepay > 0 && <StatBox label="Student Loan" value={fmt(calc1.slRepay)} color="#ec4899" />}
                  {calc1.seIncome > 0 ? (
                    <>
                      <StatBox label="PAYE Monthly" value={fmt(calc1.payeMonthly)} color="#10b981" sub="bank deposit" />
                      <StatBox label="SE Income" value={fmt(calc1.seIncome)} color="#0ea5e9" sub="annual, paid separately" />
                      <StatBox label="SA Tax Bill" value={fmt(calc1.saTaxBill)} color="#ef4444" sub="due via Self Assessment" />
                      <StatBox label="Total Annual Net" value={fmt(calc1.net)} color="#10b981" />
                    </>
                  ) : (
                    <>
                      <StatBox label="Annual Net" value={fmt(calc1.net)} color="#10b981" />
                      <StatBox label="Monthly Net" value={fmt(calc1.monthly)} color="#10b981" sub="per month" />
                    </>
                  )}
                </div>
              </Card>
            )}

            {mode === MODE.HOUSEHOLD && (
              <>
                <Card title="Take-Home — Person 1" color="#10b981">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <StatBox label="Gross" value={fmt(calc1.gross)} />
                    <StatBox label="Tax + NI" value={fmt(calc1.tax + calc1.ni)} color="#ef4444" />
                    <StatBox label="Pension" value={fmt(calc1.pensionAmt)} color="#8b5cf6" />
                    {calc1.sacrificeAmt > 0 && <StatBox label="Salary Sacrifice" value={fmt(calc1.sacrificeAmt)} color="#0ea5e9" />}
                    {calc1.slRepay > 0 && <StatBox label="Student Loan" value={fmt(calc1.slRepay)} color="#ec4899" />}
                    {calc1.seIncome > 0 ? (
                      <>
                        <StatBox label="PAYE Monthly" value={fmt(calc1.payeMonthly)} color="#10b981" sub="bank deposit" />
                        <StatBox label="SE + SA / mo" value={fmt(calc1.seNet / 12)} color="#0ea5e9" sub="smoothed SE − SA" />
                      </>
                    ) : (
                      <StatBox label="Monthly Net" value={fmt(calc1.monthly)} color="#10b981" />
                    )}
                  </div>
                </Card>
                <Card title="Take-Home — Person 2" color="#10b981">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <StatBox label="Gross" value={fmt(calc2.gross)} />
                    <StatBox label="Tax + NI" value={fmt(calc2.tax + calc2.ni)} color="#ef4444" />
                    <StatBox label="Pension" value={fmt(calc2.pensionAmt)} color="#8b5cf6" />
                    {calc2.sacrificeAmt > 0 && <StatBox label="Salary Sacrifice" value={fmt(calc2.sacrificeAmt)} color="#0ea5e9" />}
                    {calc2.slRepay > 0 && <StatBox label="Student Loan" value={fmt(calc2.slRepay)} color="#ec4899" />}
                    {calc2.seIncome > 0 ? (
                      <>
                        <StatBox label="PAYE Monthly" value={fmt(calc2.payeMonthly)} color="#10b981" sub="bank deposit" />
                        <StatBox label="SE + SA / mo" value={fmt(calc2.seNet / 12)} color="#0ea5e9" sub="smoothed SE − SA" />
                      </>
                    ) : (
                      <StatBox label="Monthly Net" value={fmt(calc2.monthly)} color="#10b981" />
                    )}
                  </div>
                </Card>
              </>
            )}

            {mode === MODE.HOUSEHOLD && (
              <div style={{ gridColumn: "1 / -1" }}>
                <Card title="Household Contribution Split" color="#ec4899">
                  <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: "0 0 280px" }}>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Split Method</label>
                        <Toggle value={splitMode} onChange={setSplitMode} labels={["Ratio of Earnings", "Custom %"]} />
                      </div>
                      {splitMode === SPLIT_MODE.CUSTOM_PERCENT && (
                        <InputGroup label="Person 1 Contribution %" value={customSplitP1} onChange={setCustomSplitP1} prefix="" suffix="%" min={0} max={100} />
                      )}
                      <div style={{ background: "#fdf2f8", borderRadius: 8, padding: 12, fontSize: 13 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span>Person 1 pays</span><strong style={{ color: "#6366f1" }}>{splitP1Pct.toFixed(1)}%</strong>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>Person 2 pays</span><strong style={{ color: "#8b5cf6" }}>{splitP2Pct.toFixed(1)}%</strong>
                        </div>
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 300 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
                            <th style={{ padding: "6px 8px", textAlign: "left", color: "#64748b" }}>Expense</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "#64748b" }}>Total</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "#6366f1" }}>Person 1</th>
                            <th style={{ padding: "6px 8px", textAlign: "right", color: "#8b5cf6" }}>Person 2</th>
                          </tr>
                        </thead>
                        <tbody>
                          {splitExpenseRows.map((e, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "6px 8px" }}>
                                {e.name}
                                {e.splitType !== "shared" && <span style={{ fontSize: 10, marginLeft: 6, padding: "1px 5px", borderRadius: 4, background: e.splitType === "p1" ? "#eef2ff" : "#f5f3ff", color: e.splitType === "p1" ? "#6366f1" : "#8b5cf6", fontWeight: 600 }}>{e.splitType === "p1" ? "P1" : "P2"} only</span>}
                              </td>
                              <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>{fmt(e.amount)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(e.p1)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(e.p2)}</td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: "1px solid #e2e8f0", fontWeight: 600, background: "#fdf2f8" }}>
                            <td style={{ padding: "6px 8px", color: "#64748b" }}>Household Expenses</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(totalExpenses)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#6366f1" }}>{fmt(splitTotalP1)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#8b5cf6" }}>{fmt(splitTotalP2)}</td>
                          </tr>
                          {personalCommitmentRows.map((r, i) => (
                            <tr key={`c${i}`} style={{ borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
                              <td style={{ padding: "6px 8px", fontStyle: "italic" }}>{r.name}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>{fmt(r.amount)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(r.person === "p1" ? r.amount : 0)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(r.person === "p2" ? r.amount : 0)}</td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: "2px solid #ec4899", fontWeight: 700 }}>
                            <td style={{ padding: "8px 8px" }}>Total All Commitments</td>
                            <td style={{ padding: "8px 8px", textAlign: "right" }}>{fmt(totalExpenses + commitTotal)}</td>
                            <td style={{ padding: "8px 8px", textAlign: "right", color: "#6366f1" }}>{fmt(splitTotalP1 + commitP1)}</td>
                            <td style={{ padding: "8px 8px", textAlign: "right", color: "#8b5cf6" }}>{fmt(splitTotalP2 + commitP2)}</td>
                          </tr>
                        </tbody>
                      </table>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                        <div style={{ background: "#eef2ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                          <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>P1 REMAINING</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: calc1.monthly - splitTotalP1 - commitP1 >= 0 ? "#10b981" : "#ef4444" }}>
                            {fmt(calc1.monthly - splitTotalP1 - commitP1)}
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>after all commitments</div>
                        </div>
                        <div style={{ background: "#f5f3ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                          <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>P2 REMAINING</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: calc2.monthly - splitTotalP2 - commitP2 >= 0 ? "#10b981" : "#ef4444" }}>
                            {fmt(calc2.monthly - splitTotalP2 - commitP2)}
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>after contributions</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            )}

            <Card title="Savings & Investment Pots" color="#8b5cf6">
              {pots.length === 0 ? (
                <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px 0" }}>No pots yet — add accounts, ISAs and investments on the <strong>Savings &amp; Investments</strong> tab.</p>
              ) : (
                <div style={{ marginBottom: 12, maxHeight: 240, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e2e8f0", color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        <th style={{ padding: "6px 8px", textAlign: "left" }}>Pot</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Balance</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Monthly</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pots.map((p) => (
                        <tr key={p.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ padding: "6px 8px" }}>
                            <span style={{ display: "inline-block", width: 8, height: 8, background: POT_TYPE_COLORS[p.type] || "#94a3b8", borderRadius: "50%", marginRight: 8 }} />
                            <strong>{p.name}</strong>
                            <span style={{ marginLeft: 6, fontSize: 10, color: "#94a3b8", textTransform: "uppercase" }}>{p.type} · {p.owner}</span>
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(p.startingBalance)}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right", color: "#10b981" }}>{p.monthlyContribution > 0 ? fmt(p.monthlyContribution) : "—"}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right", color: "#8b5cf6" }}>{p.rate.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ background: "#f5f3ff", borderRadius: 8, padding: 12, marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700 }}>
                  <span style={{ color: "#8b5cf6" }}>Total Existing Savings</span>
                  <span style={{ color: "#8b5cf6" }}>{fmt(totalExistingSavings)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748b", marginTop: 4 }}>
                  <span>Monthly contributions</span>
                  <strong>{fmt(totalMonthlyPotContributions)}/mo</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  <span>Money-weighted blended return</span>
                  <strong>{blendedRate.toFixed(2)}%</strong>
                </div>
              </div>
            </Card>

            <Card title="Monthly Expenses" color="#f59e0b">
              <InputGroup label="Rent / Mortgage" value={rent} onChange={setRent} />
              <InputGroup label="Bills (council tax, utilities, etc.)" value={bills} onChange={setBills} />
              <InputGroup label="Food & Groceries" value={food} onChange={setFood} />
              <InputGroup label="Transport" value={transport} onChange={setTransport} />
              <InputGroup label="Subscriptions" value={subscriptions} onChange={setSubscriptions} />
              <InputGroup label="Other" value={otherExpenses} onChange={setOtherExpenses} />

              {customExpenses.length > 0 && (
                <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 12, marginTop: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 8 }}>Custom Expenses</div>
                  {customExpenses.map((ce) => (
                    <div key={ce.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap", gap: 4 }}>
                      <span style={{ fontSize: 14, flex: "1 1 auto" }}>{ce.name}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {mode === MODE.HOUSEHOLD && (
                          <select
                            value={ce.splitType || "shared"}
                            onChange={(e) => updateCustomExpenseSplit(ce.id, e.target.value)}
                            style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: "1px solid #cbd5e1", background: ce.splitType === "p1" ? "#eef2ff" : ce.splitType === "p2" ? "#f5f3ff" : "#f0fdf4", color: "#475569", cursor: "pointer" }}
                          >
                            <option value="shared">Shared</option>
                            <option value="p1">P1 Only</option>
                            <option value="p2">P2 Only</option>
                          </select>
                        )}
                        <strong style={{ fontSize: 14 }}>{fmt(ce.amount)}</strong>
                        <button onClick={() => removeCustomExpense(ce.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: 700, fontSize: 16, padding: "0 4px" }}>×</button>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, fontSize: 13, fontWeight: 700, color: "#f59e0b" }}>
                    <span>Custom total</span>
                    <span>{fmt(customExpensesTotal)}/mo</span>
                  </div>
                </div>
              )}

              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 12, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 8 }}>Add Custom Expense</div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 2 }}>
                    <input type="text" placeholder="e.g. Gym membership" value={newCustomExpName} onChange={(e) => setNewCustomExpName(e.target.value)} style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "#94a3b8", fontWeight: 600 }}>£</span>
                      <input type="number" placeholder="0" value={newCustomExpAmount || ""} onChange={(e) => setNewCustomExpAmount(parseFloat(e.target.value) || 0)} style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14 }} />
                    </div>
                  </div>
                  <button onClick={addCustomExpense} style={{ padding: "8px 14px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}>+</button>
                </div>
              </div>
            </Card>

            <div>
              <Card title="Monthly Summary" color="#10b981">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                  <StatBox label="Total Net Income" value={fmt(totalMonthlyNet)} color="#10b981" sub="/month" />
                  <StatBox label="Total Expenses" value={fmt(totalExpenses)} color="#ef4444" sub="/month" />
                  <StatBox label="Finance Payments" value={fmt(totalAgreementMonthly)} color="#f59e0b" sub="/month" />
                  <StatBox label="Disposable" value={fmt(disposable - totalAgreementMonthly)} color={disposable - totalAgreementMonthly >= 0 ? "#10b981" : "#ef4444"} sub="/month" />
                </div>
                {totalExistingSavings > 0 && (
                  <div style={{ background: "#f5f3ff", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#64748b" }}>Existing Savings Pot</span>
                    <strong style={{ color: "#8b5cf6", fontSize: 18 }}>{fmt(totalExistingSavings)}</strong>
                  </div>
                )}
              </Card>
              <div style={{ marginTop: 24 }}>
                <Card title="Expense Breakdown">
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie data={expensePieData} cx="50%" cy="50%" innerRadius={50} outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                        {expensePieData.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </Card>
              </div>
            </div>
          </div>
        )}

        {tab === 1 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
            <Card title="50 / 30 / 20 Rule" color="#6366f1">
              <p style={{ fontSize: 13, color: "#64748b", marginTop: 0 }}>50% Needs · 30% Wants · 20% Savings</p>
              <div style={{ background: "#f8fafc", borderRadius: 8, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                  <StatBox label="Needs Budget" value={fmt(savingsModels["50/30/20"].needs)} color="#6366f1" sub="50% target" />
                  <InfoTip items={[{ label: "Rent/Mortgage", value: fmt(rent) }, { label: "Bills", value: fmt(bills) }, { label: "Food", value: fmt(food) }, { label: "Transport", value: fmt(transport) }]}>
                    <StatBox label="Your Needs ⓘ" value={fmt(savingsModels["50/30/20"].actualNeeds)} color={savingsModels["50/30/20"].needsGap >= 0 ? "#10b981" : "#ef4444"} sub="hover for breakdown" />
                  </InfoTip>
                  <StatBox label="Wants Budget" value={fmt(savingsModels["50/30/20"].wants)} color="#f59e0b" sub="30% target" />
                  <InfoTip items={[{ label: "Subscriptions", value: fmt(subscriptions) }, { label: "Other", value: fmt(otherExpenses) }, ...customExpenses.map(ce => ({ label: ce.name, value: fmt(ce.amount) }))]}>
                    <StatBox label="Your Wants ⓘ" value={fmt(savingsModels["50/30/20"].actualWants)} color={savingsModels["50/30/20"].wantsGap >= 0 ? "#10b981" : "#ef4444"} sub="hover for breakdown" />
                  </InfoTip>
                  <StatBox label="Savings Target" value={fmt(savingsModels["50/30/20"].savings)} color="#10b981" sub="20% target" />
                  <InfoTip items={[{ label: "Net Income", value: fmt(totalMonthlyNet) }, { label: "− Expenses", value: fmt(totalExpenses) }, { label: "− Agreements", value: fmt(totalAgreementMonthly) }, { label: "= Available", value: fmt(totalMonthlyNet - totalExpenses - totalAgreementMonthly) }]}>
                    <StatBox label="Actual Savings ⓘ" value={fmt(savingsModels["50/30/20"].actualSavings)} color={savingsModels["50/30/20"].actualSavings >= savingsModels["50/30/20"].savings ? "#10b981" : "#ef4444"} sub="hover for breakdown" />
                  </InfoTip>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8 }}>
                <span style={{ color: savingsModels["50/30/20"].needsGap >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                  {savingsModels["50/30/20"].needsGap >= 0 ? `✓ Needs: ${fmt(savingsModels["50/30/20"].needsGap)} under budget` : `✗ Needs: ${fmt(-savingsModels["50/30/20"].needsGap)} over budget`}
                </span><br />
                <span style={{ color: savingsModels["50/30/20"].wantsGap >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                  {savingsModels["50/30/20"].wantsGap >= 0 ? `✓ Wants: ${fmt(savingsModels["50/30/20"].wantsGap)} under budget` : `✗ Wants: ${fmt(-savingsModels["50/30/20"].wantsGap)} over budget`}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={[{ name: "Needs", budget: Math.round(savingsModels["50/30/20"].needs), actual: Math.round(savingsModels["50/30/20"].actualNeeds) }, { name: "Wants", budget: Math.round(savingsModels["50/30/20"].wants), actual: Math.round(savingsModels["50/30/20"].actualWants) }, { name: "Savings", budget: Math.round(savingsModels["50/30/20"].savings), actual: Math.round(savingsModels["50/30/20"].actualSavings) }]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `£${v}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Legend />
                  <Bar dataKey="budget" name="Budget" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual" name="Actual" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="70 / 20 / 10 Rule" color="#f59e0b">
              <p style={{ fontSize: 13, color: "#64748b", marginTop: 0 }}>70% Living · 20% Savings · 10% Debt/Giving</p>
              <div style={{ background: "#f8fafc", borderRadius: 8, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                  <StatBox label="Living Budget" value={fmt(savingsModels["70/20/10"].living)} color="#f59e0b" sub="70% target" />
                  <InfoTip items={[{ label: "Rent/Mortgage", value: fmt(rent) }, { label: "Bills", value: fmt(bills) }, { label: "Food", value: fmt(food) }, { label: "Transport", value: fmt(transport) }, { label: "Subscriptions", value: fmt(subscriptions) }, { label: "Other", value: fmt(otherExpenses) }, ...customExpenses.map(ce => ({ label: ce.name, value: fmt(ce.amount) }))]}>
                    <StatBox label="Your Living ⓘ" value={fmt(savingsModels["70/20/10"].actualLiving)} color={savingsModels["70/20/10"].livingGap >= 0 ? "#10b981" : "#ef4444"} sub="hover for breakdown" />
                  </InfoTip>
                  <StatBox label="Savings Target" value={fmt(savingsModels["70/20/10"].savings)} color="#10b981" sub="20% target" />
                  <StatBox label="Actual Savings" value={fmt(savingsModels["70/20/10"].actualSavings)} color={savingsModels["70/20/10"].actualSavings >= savingsModels["70/20/10"].savings ? "#10b981" : "#ef4444"} sub="what you'd save" />
                  <StatBox label="Debt Budget" value={fmt(savingsModels["70/20/10"].debt)} color="#8b5cf6" sub="10% target" />
                  <InfoTip items={agreementPayments.map(a => ({ label: a.name, value: fmt(a.monthlyPayment) }))}>
                    <StatBox label="Your Debt ⓘ" value={fmt(savingsModels["70/20/10"].actualDebt)} color={savingsModels["70/20/10"].debtGap >= 0 ? "#10b981" : "#ef4444"} sub="hover for breakdown" />
                  </InfoTip>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8 }}>
                <span style={{ color: savingsModels["70/20/10"].livingGap >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                  {savingsModels["70/20/10"].livingGap >= 0 ? `✓ Living: ${fmt(savingsModels["70/20/10"].livingGap)} under budget` : `✗ Living: ${fmt(-savingsModels["70/20/10"].livingGap)} over budget`}
                </span><br />
                <span style={{ color: savingsModels["70/20/10"].debtGap >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                  {savingsModels["70/20/10"].debtGap >= 0 ? `✓ Debt: ${fmt(savingsModels["70/20/10"].debtGap)} under budget` : `✗ Debt: ${fmt(-savingsModels["70/20/10"].debtGap)} over budget`}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={[{ name: "Living", budget: Math.round(savingsModels["70/20/10"].living), actual: Math.round(savingsModels["70/20/10"].actualLiving) }, { name: "Savings", budget: Math.round(savingsModels["70/20/10"].savings), actual: Math.round(savingsModels["70/20/10"].actualSavings) }, { name: "Debt", budget: Math.round(savingsModels["70/20/10"].debt), actual: Math.round(savingsModels["70/20/10"].actualDebt) }]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `£${v}`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Legend />
                  <Bar dataKey="budget" name="Budget" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual" name="Actual" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Pay Yourself First" color="#10b981">
              <p style={{ fontSize: 13, color: "#64748b", marginTop: 0 }}>Set your savings goal, live on the rest</p>
              <InputGroup label="Monthly Savings Target" value={pyfSavingsTarget} onChange={setPyfSavingsTarget} />
              <div style={{ background: "#f8fafc", borderRadius: 8, padding: 16, marginBottom: 12 }}>
                <StatBox label="Savings" value={fmt(savingsModels["Pay Yourself First"].savings)} color="#10b981" sub="your target" />
                <StatBox label="Remaining for Life" value={fmt(savingsModels["Pay Yourself First"].remaining)} color="#6366f1" sub="income minus savings" />
                <StatBox label="After All Costs" value={fmt(savingsModels["Pay Yourself First"].actualAfterSavings)} color={savingsModels["Pay Yourself First"].actualAfterSavings >= 0 ? "#10b981" : "#ef4444"} sub="what's actually left" />
              </div>
              <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8 }}>
                <strong>Your expenses:</strong> {fmt(totalExpenses)}/mo<br />
                <strong>Finance agreements:</strong> {fmt(totalAgreementMonthly)}/mo<br />
                <span style={{ color: savingsModels["Pay Yourself First"].actualAfterSavings >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>
                  {savingsModels["Pay Yourself First"].actualAfterSavings >= 0
                    ? `✓ Target achievable — ${fmt(savingsModels["Pay Yourself First"].actualAfterSavings)}/mo buffer`
                    : `✗ Short by ${fmt(-savingsModels["Pay Yourself First"].actualAfterSavings)}/mo — reduce target or expenses`}
                </span>
              </div>
            </Card>

            <div style={{ gridColumn: "1 / -1" }}>
              <Card title="Model Comparison — Budget vs Actual Savings" color="#8b5cf6">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={[
                      { model: "50/30/20", target: Math.round(savingsModels["50/30/20"].savings), actual: Math.round(savingsModels["50/30/20"].actualSavings), annualTarget: Math.round(savingsModels["50/30/20"].savings * 12), annualActual: Math.round(savingsModels["50/30/20"].actualSavings * 12) },
                      { model: "70/20/10", target: Math.round(savingsModels["70/20/10"].savings), actual: Math.round(savingsModels["70/20/10"].actualSavings), annualTarget: Math.round(savingsModels["70/20/10"].savings * 12), annualActual: Math.round(savingsModels["70/20/10"].actualSavings * 12) },
                      { model: "Pay Yourself First", target: Math.round(pyfSavingsTarget), actual: Math.round(Math.min(pyfSavingsTarget, Math.max(0, totalMonthlyNet - totalExpenses - totalAgreementMonthly))), annualTarget: Math.round(pyfSavingsTarget * 12), annualActual: Math.round(Math.min(pyfSavingsTarget, Math.max(0, totalMonthlyNet - totalExpenses - totalAgreementMonthly)) * 12) },
                    ]}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="model" />
                    <YAxis tickFormatter={(v) => `£${v}`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Bar dataKey="target" name="Monthly Target" fill="#6366f1" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="actual" name="Monthly Actual" fill="#10b981" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="annualTarget" name="Annual Target" fill="#6366f166" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="annualActual" name="Annual Actual" fill="#10b98166" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        )}

        {tab === 2 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card title="Property Details" color="#6366f1">
              <InputGroup label="Property Price" value={housePrice} onChange={setHousePrice} />
              <InputGroup label="Deposit" value={deposit} onChange={setDeposit} />
              <InputGroup label="Mortgage Term" value={mortgageTerm} onChange={setMortgageTerm} prefix="" suffix="years" />
              <InputGroup label="Initial Interest Rate" value={mortgageRate} onChange={setMortgageRate} prefix="" suffix="%" step={0.01} />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>First Time Buyer?</label>
                <Toggle value={firstTimeBuyer} onChange={setFirstTimeBuyer} labels={["No", "Yes"]} />
              </div>

              <div style={{ borderTop: "2px solid #8b5cf6", paddingTop: 16, marginTop: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700, color: "#8b5cf6" }}>Lender Deal</h4>
                <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Match these to your mortgage offer or illustration so the payments here agree with your lender's.</p>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>
                  Payment calculation{" "}
                  <InfoTip items={[
                    { label: "In advance", value: fmt2(mortgage.paymentAdvance) },
                    { label: "Standard (in arrears)", value: fmt2(mortgage.paymentArrears) },
                    { label: "Difference", value: `${fmt2(mortgage.paymentArrears - mortgage.paymentAdvance)}/mo` },
                    { label: "Daily interest", value: fmt2(mortgage.dailyInterest) },
                    { label: `First payment (${firstPaymentDays} days)`, value: fmt2(mortgage.calculatedFirstPayment) },
                  ]}>
                    <span style={{ color: "#8b5cf6", cursor: "help" }}>ⓘ</span>
                  </InfoTip>
                </div>
                <Toggle value={paymentTiming === "advance" ? 0 : 1} onChange={(i) => setPaymentTiming(i === 0 ? "advance" : "arrears")} labels={["In advance", "Standard (in arrears)"]} />
                <p style={{ fontSize: 12, color: "#64748b", margin: "8px 0 16px", lineHeight: 1.5 }}>
                  Paying in advance means each month's payment is collected first, so interest is charged on the balance after that payment. Some lenders illustrate payments this way, so choose whichever method matches your mortgage illustration. The standard formula charges a full month's interest before each payment, giving {fmt2(mortgage.paymentArrears)} rather than {fmt2(mortgage.paymentAdvance)} on {fmt(mortgage.totalBorrowing)} at {mortgage.initialRate}% over {mortgageTerm} years. A product fee paid upfront doesn't change the payment; adding it to the loan raises it.
                  {mortgage.isFirstPaymentOverridden
                    ? ` Your first payment of ${fmt2(mortgage.firstPayment)} is your own figure${mortgage.firstPayment - mortgage.monthlyPayment > 0.005 ? ` — ${fmt2(mortgage.firstPayment - mortgage.monthlyPayment)} more than a normal month` : ""}.`
                    : ` Your first payment also covers ${firstPaymentDays} days' interest from completion (${fmt2(mortgage.stubInterest)}).`}
                </p>
                <InputGroup label="First payment interest" value={firstPaymentDays} onChange={setFirstPaymentDays} prefix="" suffix="days" min={0} max={62} />
                <div style={HINT_STYLE}>Interest from completion to the start of your first full month: {firstPaymentDays} days' interest is {fmt2(mortgage.dailyInterest * Math.max(0, firstPaymentDays))}{mortgage.isFirstPaymentOverridden ? " (calculated — your manual first payment is used instead)." : ", added to your first payment."}</div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>First payment in your upfront costs?</label>
                  <Toggle value={reserveFirstPayment ? 0 : 1} onChange={(i) => setReserveFirstPayment(i === 0)} labels={["Set aside upfront", "Pay from income"]} />
                </div>
                <InputGroup label="Product fee" value={productFee} onChange={setProductFee} step={0.01} />
                {productFee > 0 && (
                  <div style={{ marginTop: -8, marginBottom: 16 }}>
                    <Toggle value={productFeeAddToLoan ? 1 : 0} onChange={(i) => setProductFeeAddToLoan(i === 1)} labels={["Pay upfront", "Add to loan"]} />
                    {!productFeeAddToLoan && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569", marginTop: 8, cursor: "pointer" }} title="Tick if you've already paid it — it won't count towards the cash you still need">
                        <input type="checkbox" checked={productFeePaid} onChange={(e) => setProductFeePaid(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#10b981", cursor: "pointer" }} />
                        Already paid
                      </label>
                    )}
                    {mortgage.feeLoanCost && (
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, lineHeight: 1.4 }}>
                        {productFeeAddToLoan
                          ? `Adding it to the loan costs ${fmt2(mortgage.feeLoanCost.monthly)} a month more and about ${fmt(mortgage.feeLoanCost.interest)} in extra interest over the full term.`
                          : `Counted in your essentials on the Purchase Plan tab. Adding it to the loan instead would cost ${fmt2(mortgage.feeLoanCost.monthly)} a month more and about ${fmt(mortgage.feeLoanCost.interest)} in extra interest over the full term.`}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <InputGroup label="Fixed rate until" value={fixedRateEndDate} onChange={(v) => { if (isIsoDateOrEmpty(v)) setFixedRateEndDate(v); }} prefix="" type="date" max="9999-12-31" />
                  <InputGroup label="Follow-on rate" value={followOnRate} onChange={setFollowOnRate} prefix="" suffix="%" step={0.01} />
                </div>
                <div style={HINT_STYLE}>
                  {mortgage.fixExpired
                    ? `Your fixed rate ends before your first monthly payment, so the follow-on rate (${mortgage.initialRate}%) applies from the start.`
                    : mortgage.hasFollowOn
                      ? `Fixed for ${mortgage.fixedMonths} monthly payments after ${completionDate ? `completion on ${fmtDate(completionDate)}` : "completing today"}${mortgage.followOnPayment != null ? `, then ${fmt2(mortgage.followOnPayment)} a month at ${mortgage.followOnRateUsed}%` : " — at this payment the mortgage is repaid before the fixed rate ends"}.`
                      : fixedRateEndDate
                        ? "The fixed rate lasts for the whole term."
                        : "Leave the date blank if the rate lasts the whole term. The follow-on rate is usually the lender's standard variable rate (SVR); 0 keeps the initial rate."}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#475569", margin: "4px 0 8px" }}>Manual overrides</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <InputGroup label="Monthly payment" value={paymentOverride} onChange={setPaymentOverride} step={0.01} />
                    <div style={HINT_STYLE}>Calculated: {fmt2(mortgage.calculatedPayment)}</div>
                  </div>
                  <div>
                    <InputGroup label="First payment" value={firstPaymentOverride} onChange={setFirstPaymentOverride} step={0.01} />
                    <div style={HINT_STYLE}>Calculated: {fmt2(mortgage.calculatedFirstPayment)}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>To use the exact figures from your illustration, enter them here. Leave at 0 to use the calculated figures.</div>
              </div>

              <div style={{ borderTop: "2px solid #f59e0b", paddingTop: 16, marginTop: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700, color: "#f59e0b" }}>Ongoing Homeowner Costs</h4>
                <InputGroup label="Council Tax at the new home (monthly)" value={councilTax} onChange={setCouncilTax} step={0.01} />
                <InputGroup label="Council tax you pay now (included in Bills)" value={councilTaxInBills} onChange={setCouncilTaxInBills} step={0.01} />
                <div style={HINT_STYLE}>Taken out of Bills after you move, so the new council tax replaces it rather than adding to it.</div>
                <InputGroup label="House Price Growth (annual)" value={housePriceGrowth} onChange={setHousePriceGrowth} prefix="" suffix="%" step={0.5} />
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                  Home insurance, solicitor, survey and moving costs go on the <button style={LINK_BTN} onClick={() => setTab(3)}>Purchase Plan</button> tab, where yearly costs can be paid upfront or monthly.
                </div>
              </div>

              <div style={{ borderTop: "2px solid #10b981", paddingTop: 16, marginTop: 16 }}>
                <h4 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 700, color: "#10b981" }}>Overpayment Modelling</h4>
                <InputGroup label="Monthly Overpayment" value={overpayMonthly} onChange={setOverpayMonthly} />
                <InputGroup label="Annual Lump Sum Overpayment" value={overpayAnnual} onChange={setOverpayAnnual} />
                {(overpayMonthly > 0 || overpayAnnual > 0) && mortgage.totalBorrowing > 0 && (
                  <div style={HINT_STYLE}>
                    Year 1 overpayments: {fmt(overpayMonthly * 12 + overpayAnnual)} ({(((overpayMonthly * 12 + overpayAnnual) / mortgage.totalBorrowing) * 100).toFixed(1)}% of the loan). Most fixed-rate deals allow up to 10% a year without an early repayment charge — check your offer.
                  </div>
                )}
              </div>
            </Card>

            <div>
              <Card title="Mortgage Summary" color="#10b981">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: mortgage.warnings.length > 0 ? 8 : 16 }}>
                  <StatBox label="Requested Loan" value={fmt(mortgage.requestedLoan)} sub="price − deposit" />
                  <StatBox label="LTV" value={`${mortgage.ltv}%`} color={parseFloat(mortgage.ltv) > 90 ? "#ef4444" : "#10b981"} sub="on requested loan" />
                  <StatBox label="Total Borrowing" value={fmt(mortgage.totalBorrowing)} sub={mortgage.feeAddedToLoan > 0 ? `incl. ${fmt2(mortgage.feeAddedToLoan)} fee` : "no fees added"} />
                  <StatBox label="Monthly Payment" value={fmt2(mortgage.monthlyPayment)} color="#6366f1" sub={mortgage.isPaymentOverridden ? "manual figure" : mortgage.hasFollowOn ? `until ${fmtDate(fixedRateEndDate)}` : "/month"} />
                  <StatBox label="First Payment" value={fmt2(mortgage.firstPayment)} color="#6366f1" sub={mortgage.isFirstPaymentOverridden ? "manual figure" : `incl. ${firstPaymentDays} days' interest`} />
                  <StatBox label="After Fixed Rate" value={mortgage.followOnPayment != null ? fmt2(mortgage.followOnPayment) : "—"} color="#8b5cf6" sub={mortgage.followOnPayment != null ? `at ${mortgage.followOnRateUsed}%` : mortgage.fixExpired ? "follow-on rate from the start" : mortgage.repaidBeforeFixEnd ? "repaid before the fix ends" : fixedRateEndDate ? "no follow-on period" : "no fixed end date"} />
                  <StatBox label="Total Interest" value={fmt(mortgage.totalInterest)} color="#ef4444" sub="full term" />
                  <StatBox label="Total Repaid" value={fmt(mortgage.totalRepaid)} />
                  <StatBox label="Stamp Duty" value={fmt(mortgage.stampDuty)} color="#f59e0b" sub={ftbReliefApplies(housePrice, isFirstTimeBuyer) ? "first-time buyer relief" : "standard rates"} />
                </div>
                {mortgage.warnings.map((w, i) => (
                  <div key={i} style={{ ...WARNING_STYLES[w.level], marginTop: 8, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{w.text}</div>
                ))}
              </Card>

              <div style={{ marginTop: 24 }}>
                <Card title="Purchase Costs" color="#f59e0b">
                  <div style={{ fontSize: 14, lineHeight: 2 }}>
                    {purchasePlan.autoRows.filter((r) => r.counted).map((r) => (
                      <div key={r.key} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{r.name}{r.paid ? " (paid)" : ""}</span>
                        <strong>{fmt2(r.amount)}</strong>
                      </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Other essentials ({purchasePlan.otherEssentialsCount})</span>
                      <strong>{fmt2(purchasePlan.otherEssentialsTotal)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #6366f1", paddingTop: 8, marginTop: 8 }}>
                      <strong style={{ color: "#6366f1" }}>Essentials total</strong>
                      <strong style={{ color: "#6366f1", fontSize: 18 }}>{fmt2(purchasePlan.essentialsTotal)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Extras ({purchasePlan.extrasCount})</span>
                      <strong>{fmt2(purchasePlan.extrasTotal)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <strong>Total ideal</strong>
                      <strong>{fmt2(purchasePlan.idealTotal)}</strong>
                    </div>
                    {purchasePlan.paidTotal > 0.005 && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#10b981" }}>
                        <span>Already paid (not in the gap)</span>
                        <strong>−{fmt2(purchasePlan.paidTotal)}</strong>
                      </div>
                    )}
                    {purchasePlan.monthlyTotal > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
                        <span>Paid monthly</span>
                        <strong>{fmt2(purchasePlan.monthlyTotal)}/mo</strong>
                      </div>
                    )}
                    {purchasePlan.annualTotal > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b" }}>
                        <span>Paid annually (renews from savings)</span>
                        <strong>{fmt2(purchasePlan.annualTotal)}/yr</strong>
                      </div>
                    )}
                  </div>
                  {(() => {
                    const short = purchasePlan.gap > 0.005;
                    const idealShort = purchasePlan.gapIdeal > 0.005;
                    const text = short
                      ? `Gap: ${fmt2(purchasePlan.gap)} short for essentials (${fmt2(purchasePlan.gapIdeal)} incl. extras).`
                      : idealShort
                        ? `Essentials covered with ${fmt2(-purchasePlan.gap)} spare; ${fmt2(purchasePlan.gapIdeal)} short incl. extras.`
                        : `Covered: ${fmt2(-purchasePlan.gapIdeal)} spare after essentials and extras.`;
                    return (
                      <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, background: short ? "#fef2f2" : "#f0fdf4", border: `1px solid ${short ? "#fecaca" : "#bbf7d0"}`, color: short ? "#991b1b" : "#166534" }}>
                        {text}
                      </div>
                    );
                  })()}
                  <button onClick={() => setTab(3)} style={{ marginTop: 12, width: "100%", padding: 10, background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
                    Open Purchase Plan →
                  </button>
                </Card>
              </div>

              <div style={{ marginTop: 24 }}>
                <Card title="Full Affordability Picture" color="#8b5cf6">
                  <div style={{ fontSize: 14, lineHeight: 2 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Monthly Net Income</span>
                      <strong>{fmt(totalMonthlyNet)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Mortgage Payment{mortgage.hasFollowOn ? " (fixed period)" : ""}</span>
                      <strong style={{ color: "#ef4444" }}>-{fmt(mortgage.monthlyPayment)}</strong>
                    </div>
                    {overpayMonthly > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Mortgage Overpayment</span>
                        <strong style={{ color: "#ef4444" }}>-{fmt(overpayMonthly)}</strong>
                      </div>
                    )}
                    {councilTax > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Council Tax</span>
                        <strong style={{ color: "#ef4444" }}>-{fmt(councilTax)}</strong>
                      </div>
                    )}
                    {purchasePlan.monthlyItems.map((c) => (
                      <div key={`pm${c.id}`} style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>{c.label}</span>
                        <strong style={{ color: "#ef4444" }}>-{fmt(c.monthly)}</strong>
                      </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Other Expenses (excl. rent{councilTaxInBillsApplied > 0 ? " & current council tax" : ""})</span>
                      <strong style={{ color: "#ef4444" }}>-{fmt(postLivingExpenses)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Finance Agreements</span>
                      <strong style={{ color: "#ef4444" }}>-{fmt(totalAgreementMonthly)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Savings Goal ({snapshot.selectedModel})</span>
                      <strong style={{ color: "#ef4444" }}>-{fmt(snapshot.monthlySavingsGoal)}</strong>
                    </div>
                    {snapshot.activePotsMonthly > 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Pot Contributions ({pots.filter((p) => (p.monthlyContribution || 0) > 0).length} active)</span>
                        <strong style={{ color: "#ef4444" }}>-{fmt(snapshot.activePotsMonthly)}</strong>
                      </div>
                    )}
                    {(() => {
                      const remaining = snapshot.postDisposable;
                      return (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px solid #8b5cf6", paddingTop: 8, marginTop: 8 }}>
                            <strong style={{ color: "#8b5cf6" }}>True Remaining</strong>
                            <strong style={{ color: remaining >= 0 ? "#10b981" : "#ef4444", fontSize: 18 }}>{fmt(remaining)}</strong>
                          </div>
                          {remaining < 0 && (
                            <div style={{ marginTop: 4, fontSize: 12, color: "#ef4444", fontWeight: 600 }}>
                              You'd be {fmt(-remaining)}/mo short with all commitments. Consider reducing savings goals or overpayments.
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {mortgage.followOnPayment != null && Math.abs(mortgage.followOnPayment - mortgage.monthlyPayment) >= MORTGAGE_EPS && (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                        After {fmtDate(fixedRateEndDate)} the mortgage becomes {fmt2(mortgage.followOnPayment)} a month ({fmtSigned2(mortgage.followOnPayment - mortgage.monthlyPayment)}).
                      </div>
                    )}
                    {purchasePlan.annualTotal > 0 && (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                        Costs paid annually ({fmt2(purchasePlan.annualTotal)} a year, ≈ {fmt2(purchasePlan.annualTotal / 12)}/mo) aren't included above — they're paid upfront and renew from savings each year.
                      </div>
                    )}
                    {overpayAnnual > 0 && (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                        Your {fmt(overpayAnnual)} yearly lump-sum overpayment isn't included above — it's assumed to come from savings (≈ {fmt(overpayAnnual / 12)}/mo).
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 13, color: "#64748b" }}>
                      Mortgage is <strong>{((mortgage.monthlyPayment / totalMonthlyNet) * 100).toFixed(1)}%</strong> of net income
                      {mortgage.monthlyPayment / totalMonthlyNet > 0.35 && <span style={{ color: "#ef4444", fontWeight: 700 }}> — lenders typically want this below 35%</span>}
                    </div>
                  </div>
                </Card>
              </div>
            </div>

            {(overpayMonthly > 0 || overpayAnnual > 0) && (
              <div style={{ gridColumn: "1 / -1" }}>
                <Card title="Overpayment Impact" color="#10b981">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                    <StatBox label="Interest Without" value={fmt(mortgageAmortisation.totalInterest)} color="#ef4444" sub="no overpayments" />
                    <StatBox label="Interest With" value={fmt(mortgageAmortisation.totalInterestOp)} color="#10b981" sub="with overpayments" />
                    <StatBox label="Interest Saved" value={fmt(mortgageAmortisation.interestSaved)} color="#6366f1" sub="total saved" />
                    <StatBox label="Term Reduced" value={mortgageAmortisation.monthsReduced > 0 ? fmtYearsMonths(mortgageAmortisation.monthsReduced) : "—"} color="#8b5cf6" sub={mortgageAmortisation.payoffMonthOp ? `repaid after ${fmtYearsMonths(mortgageAmortisation.payoffMonthOp)}` : `full ${mortgageTerm} yr term`} />
                  </div>
                  <div style={{ fontSize: 13, color: "#64748b", padding: "8px 12px", background: "#f0fdf4", borderRadius: 8 }}>
                    Overpaying <strong>{[overpayMonthly > 0 ? `${fmt(overpayMonthly)} a month` : null, overpayAnnual > 0 ? `a ${fmt(overpayAnnual)} lump sum each year` : null].filter(Boolean).join(" plus ")}</strong> saves you <strong style={{ color: "#10b981" }}>{fmt(mortgageAmortisation.interestSaved)}</strong> in interest
                    {mortgageAmortisation.monthsReduced > 0 && <> and clears your mortgage <strong style={{ color: "#10b981" }}>{fmtYearsMonths(mortgageAmortisation.monthsReduced)} early</strong></>}.
                    {overpayMonthly > 0 && <> That's {fmt(overpayMonthly * 12)} a year in monthly overpayments.</>}
                    {mortgage.hasFollowOn && <> Assumes you keep paying the standard payment after the fixed rate ends.</>}
                  </div>
                </Card>
              </div>
            )}

            <div style={{ gridColumn: "1 / -1" }}>
              <Card title={overpayMonthly > 0 || overpayAnnual > 0 ? "Mortgage Balance — Standard vs Overpayment" : "Mortgage Balance Over Time"} color="#6366f1">
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={mortgageAmortisation.data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="year" label={{ value: "Year", position: "insideBottom", offset: -5 }} />
                    <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Area type="monotone" dataKey="balance" name="Standard Balance" fill="#6366f122" stroke="#6366f1" strokeWidth={2} />
                    {(overpayMonthly > 0 || overpayAnnual > 0) && (
                      <Area type="monotone" dataKey="balanceOp" name="With Overpayments" fill="#10b98122" stroke="#10b981" strokeWidth={2} strokeDasharray="6 3" />
                    )}
                    <Area type="monotone" dataKey="interest" name="Yearly Interest" fill="#ef444422" stroke="#ef4444" strokeWidth={1} />
                    {mortgageAmortisation.fixEndYear && (
                      <ReferenceLine x={mortgageAmortisation.fixEndYear} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: "Fixed rate ends", position: "insideTopRight", fill: "#92400e", fontSize: 11 }} />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        )}

        {tab === 3 && (() => {
          const pp = purchasePlan;
          const costCols = mode === MODE.HOUSEHOLD
            ? "minmax(180px, 2fr) 120px 110px 96px 104px 104px 104px 56px 32px"
            : "minmax(180px, 2fr) 120px 110px 96px 104px 104px 56px 32px";
          const cellInput = { padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, minWidth: 0, width: "100%" };
          const cellSelect = { ...cellInput, fontSize: 12, padding: "6px 6px" };
          const dash = <span style={{ textAlign: "center", color: "#cbd5e1" }}>—</span>;
          const isShort = (v) => v > 0.005;
          const paidSetters = { deposit: setDepositPaid, stampDuty: setStampDutyPaid, productFee: setProductFeePaid };
          const monthlyFor = (category) => pp.monthlyItems.filter((r) => r.category === category).reduce((s, r) => s + r.monthly, 0);
          const existingNames = new Set(purchaseCosts.map((c) => c.name.trim().toLowerCase()));
          const quickAdd = QUICK_ADD_COSTS.filter((q) => !existingNames.has(q.name.toLowerCase()));
          const ownerGroups = mode === MODE.HOUSEHOLD
            ? [{ key: "p1", label: "Person 1", color: "#6366f1" }, { key: "p2", label: "Person 2", color: "#8b5cf6" }, { key: "joint", label: "Joint", color: "#ec4899" }]
            : [{ key: "all", label: "", color: "#10b981" }];
          const fundCols = `32px minmax(140px, 1fr) 104px 90px${pp.completionInFuture ? " 110px" : ""}`;

          const bandTile = (t) => {
            const tile = (
              <div style={{ background: t.bg, borderRadius: 12, padding: 14, textAlign: "center", border: `1px solid ${t.border}`, height: "100%" }}>
                <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{t.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: t.color }}>{t.value}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{t.sub}</div>
              </div>
            );
            return t.items ? <InfoTip key={t.key} items={t.items}>{tile}</InfoTip> : <div key={t.key}>{tile}</div>;
          };
          const red = { bg: "#fef2f2", border: "#fecaca", color: "#ef4444" };
          const green = { bg: "#f0fdf4", border: "#bbf7d0", color: "#10b981" };
          const availableItems = [
            ...(mode === MODE.HOUSEHOLD ? ownerGroups.filter((g) => pp.availableByOwner[g.key] > 0).map((g) => ({ label: g.label, value: fmt2(pp.availableByOwner[g.key]) })) : []),
            ...(pp.completionInFuture ? [{ label: "Today", value: fmt2(pp.availableToday) }] : []),
          ];
          const tiles = [
            { key: "need", label: "CASH NEEDED", value: fmt2(pp.essentialsToPay), sub: `essentials still to pay${pp.essentialsPaid > 0.005 ? ` · ${fmt2(pp.essentialsPaid)} paid` : ""}`, bg: "#fffbeb", border: "#fde68a", color: "#f59e0b" },
            { key: "ideal", label: "INCL. EXTRAS", value: fmt2(pp.idealToPay), sub: `+ ${fmt2(pp.extrasToPay)} extras`, bg: "#f5f3ff", border: "#ddd6fe", color: "#8b5cf6" },
            { key: "available", label: availableItems.length > 0 ? "AVAILABLE ⓘ" : "AVAILABLE", value: fmt2(pp.available), sub: pp.completionInFuture ? `forecast for ${fmtDate(completionDate)}` : `${pp.tickedCount} ticked pot${pp.tickedCount === 1 ? "" : "s"}, today`, bg: "#eef2ff", border: "#c7d2fe", color: "#6366f1", items: availableItems.length > 0 ? availableItems : null },
            { key: "gap", label: "GAP ⓘ", value: fmt2(Math.abs(pp.gap)), sub: isShort(pp.gap) ? "short for essentials" : "spare after essentials", ...(isShort(pp.gap) ? red : green), items: [{ label: "Essentials still to pay", value: fmt2(pp.essentialsToPay) }, { label: "− Available", value: fmt2(pp.available) }, { label: isShort(pp.gap) ? "= Short" : "= Spare", value: fmt2(Math.abs(pp.gap)) }] },
            { key: "gapIdeal", label: "GAP TO IDEAL ⓘ", value: fmt2(Math.abs(pp.gapIdeal)), sub: isShort(pp.gapIdeal) ? "short incl. extras" : "spare incl. extras", ...(isShort(pp.gapIdeal) ? red : green), items: [{ label: "Incl. extras still to pay", value: fmt2(pp.idealToPay) }, { label: "− Available", value: fmt2(pp.available) }, { label: isShort(pp.gapIdeal) ? "= Short" : "= Spare", value: fmt2(Math.abs(pp.gapIdeal)) }] },
          ];

          const autoRowView = (r) => {
            let pill = "calculated";
            let sub = "";
            let payCell = <span style={{ fontSize: 12, color: "#64748b" }}>Upfront</span>;
            if (r.key === "deposit") {
              pill = "Mortgage tab";
              sub = housePrice > 0 ? `${((deposit / housePrice) * 100).toFixed(1)}% of ${fmt(housePrice)}` : "";
            } else if (r.key === "stampDuty") {
              sub = ftbReliefApplies(housePrice, isFirstTimeBuyer) ? "First-time buyer relief" : "Standard rates";
            } else if (r.key === "firstPayment") {
              sub = !r.counted ? "Paid from income in month 1 — not counted here" : mortgage.isFirstPaymentOverridden ? "Your figure from the Mortgage tab" : `${fmt2(mortgage.monthlyPayment)} + ${firstPaymentDays} days' interest`;
              payCell = (
                <select value={reserveFirstPayment ? "reserve" : "income"} onChange={(e) => setReserveFirstPayment(e.target.value === "reserve")} style={cellSelect}>
                  <option value="reserve">Set aside</option>
                  <option value="income">From income</option>
                </select>
              );
            } else if (r.key === "productFee") {
              pill = "Mortgage tab";
              sub = productFeeAddToLoan ? `Added to the loan — total borrowing ${fmt(mortgage.totalBorrowing)}` : r.paid ? "Already paid — not in cash still needed" : "Usually paid on application or at completion";
              payCell = (
                <select value={productFeeAddToLoan ? "loan" : "upfront"} onChange={(e) => setProductFeeAddToLoan(e.target.value === "loan")} style={cellSelect}>
                  <option value="upfront">Upfront</option>
                  <option value="loan">Add to loan</option>
                </select>
              );
            }
            return (
              <div key={r.key} style={{ display: "grid", gridTemplateColumns: costCols, gap: 8, alignItems: "center", padding: "8px 4px", borderBottom: "1px solid #f1f5f9", background: r.paid ? "#f0fdf4" : "#f8fafc" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>{r.name}</strong>
                  <span style={PILL_STYLE}>{pill}</span>
                  {sub && <div style={{ fontSize: 11, color: "#94a3b8" }}>{sub}</div>}
                </div>
                <span style={{ textAlign: "right", fontWeight: 700, fontSize: 13, color: !r.counted || r.paid ? "#94a3b8" : "#1e293b" }}>{r.counted ? fmt2(r.amount) : "—"}</span>
                {dash}
                <span style={{ fontSize: 12, color: "#64748b" }}>Once</span>
                {payCell}
                <span style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>Essential</span>
                {mode === MODE.HOUSEHOLD && dash}
                {r.canMarkPaid ? (
                  <label style={{ display: "flex", justifyContent: "center", cursor: "pointer" }} title="Already paid — no longer counts towards the cash you still need">
                    <input type="checkbox" checked={!!r.paid} onChange={(e) => paidSetters[r.key](e.target.checked)} style={{ width: 18, height: 18, accentColor: "#10b981", cursor: "pointer" }} />
                  </label>
                ) : dash}
                <span />
              </div>
            );
          };

          const costRowView = (c) => {
            const yearly = c.renews === "yearly";
            const upfrontActive = c.payment === "upfront";
            const essential = c.category === "essential";
            return (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: costCols, gap: 8, alignItems: "center", padding: "8px 4px", borderBottom: "1px solid #f1f5f9", background: c.paid && upfrontActive ? "#f0fdf4" : "transparent" }}>
                <input type="text" value={c.name} onChange={(e) => updatePurchaseCost(c.id, "name", e.target.value)} style={cellInput} />
                <input type="number" step={0.01} value={c.upfront} onChange={(e) => updatePurchaseCost(c.id, "upfront", parseFloat(e.target.value) || 0)} style={{ ...cellInput, textAlign: "right", ...(upfrontActive ? {} : INACTIVE_INPUT) }} title={yearly ? "Annual price if paid upfront each year" : "One-off cost"} />
                {yearly ? (
                  <input type="number" step={0.01} value={c.monthly} onChange={(e) => updatePurchaseCost(c.id, "monthly", parseFloat(e.target.value) || 0)} style={{ ...cellInput, textAlign: "right", ...(upfrontActive ? INACTIVE_INPUT : {}) }} title="Monthly price if paid monthly" />
                ) : dash}
                <select value={c.renews} onChange={(e) => updatePurchaseCost(c.id, "renews", e.target.value)} style={cellSelect} title="Once: a one-off cost. Yearly: renews every year (e.g. insurance), so it can be paid annually or monthly.">
                  <option value="once">Once</option>
                  <option value="yearly">Yearly</option>
                </select>
                {yearly ? (
                  <select value={c.payment} onChange={(e) => updatePurchaseCost(c.id, "payment", e.target.value)} style={cellSelect}>
                    <option value="upfront">Annually</option>
                    <option value="monthly">Monthly</option>
                  </select>
                ) : <span style={{ fontSize: 12, color: "#64748b" }}>Upfront</span>}
                <select value={c.category} onChange={(e) => updatePurchaseCost(c.id, "category", e.target.value)} style={{ ...cellSelect, background: essential ? "#eef2ff" : "#f5f3ff", color: essential ? "#6366f1" : "#8b5cf6", fontWeight: 600 }}>
                  <option value="essential">Essential</option>
                  <option value="extra">Extra</option>
                </select>
                {mode === MODE.HOUSEHOLD && (yearly && c.payment === "monthly" ? (
                  <select value={c.splitType || "shared"} onChange={(e) => updatePurchaseCost(c.id, "splitType", e.target.value)} style={{ ...cellSelect, background: c.splitType === "p1" ? "#eef2ff" : c.splitType === "p2" ? "#f5f3ff" : "#f0fdf4" }} title="Who pays this cost each month after you move in">
                    <option value="shared">Shared</option>
                    <option value="p1">P1 only</option>
                    <option value="p2">P2 only</option>
                  </select>
                ) : dash)}
                <label style={{ display: "flex", justifyContent: "center", alignItems: "center", opacity: upfrontActive ? 1 : 0.4, cursor: upfrontActive ? "pointer" : "not-allowed" }} title={upfrontActive ? "Already paid — no longer counts towards the cash you still need" : "Only upfront costs can be marked as paid"}>
                  <input type="checkbox" checked={!!c.paid} disabled={!upfrontActive} onChange={(e) => updatePurchaseCost(c.id, "paid", e.target.checked)} style={{ width: 18, height: 18, accentColor: "#10b981", cursor: upfrontActive ? "pointer" : "not-allowed" }} />
                </label>
                <button onClick={() => removePurchaseCost(c.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: 700, fontSize: 18, padding: 0 }}>×</button>
              </div>
            );
          };

          const sectionHead = (text, color) => (
            <div style={{ padding: "12px 4px 4px", fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${color}33` }}>{text}</div>
          );
          const subtotalRow = (label, upfront, monthly, bg, color) => (
            <div style={{ display: "grid", gridTemplateColumns: costCols, gap: 8, alignItems: "center", padding: "8px 4px", background: bg, fontWeight: 700, fontSize: 13 }}>
              <span style={{ color }}>{label}</span>
              <span style={{ textAlign: "right", color }}>{fmt2(upfront)}</span>
              <span style={{ textAlign: "right", fontSize: 12, color: "#64748b", fontWeight: 600 }}>{monthly > 0.005 ? `${fmt2(monthly)}/mo` : ""}</span>
            </div>
          );
          const coverLabel = (month, date) => {
            const late = month !== null && month > 0 && !!completionDate && month > pp.monthsToCompletion;
            const color = month === null || late ? "#ef4444" : "#10b981";
            const monthsLate = late ? month - pp.monthsToCompletion : 0;
            return <strong style={{ color }}>{coverText(month, date)}{late ? ` — ${monthsLate} month${monthsLate === 1 ? "" : "s"} after completion` : ""}</strong>;
          };
          const fundRow = (p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: fundCols, gap: 8, alignItems: "center", padding: "6px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
              <label style={{ display: "flex", justifyContent: "center" }} title="Use this pot for the purchase">
                <input type="checkbox" checked={!!p.forPurchase} onChange={(e) => updatePot(p.id, "forPurchase", e.target.checked)} style={{ width: 18, height: 18, accentColor: "#10b981", cursor: "pointer" }} />
              </label>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, background: POT_TYPE_COLORS[p.type] || "#94a3b8", borderRadius: "50%", marginRight: 6 }} />
                <strong>{p.name}</strong>
                <span style={{ marginLeft: 6, fontSize: 10, color: "#94a3b8", textTransform: "uppercase" }}>{POT_TYPE_LABELS[p.type] || p.type}</span>
              </span>
              <span style={{ textAlign: "right", color: p.forPurchase ? "#1e293b" : "#94a3b8" }}>{fmt2(p.startingBalance || 0)}</span>
              <span style={{ textAlign: "right", color: p.forPurchase ? "#10b981" : "#94a3b8" }}>{(p.monthlyContribution || 0) > 0 ? fmt2(p.monthlyContribution) : "—"}</span>
              {pp.completionInFuture && <span style={{ textAlign: "right", color: p.forPurchase ? "#1e293b" : "#94a3b8" }}>{fmt2(pp.potAtCompletion[p.id] || 0)}</span>}
            </div>
          );

          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 24 }}>
                {tiles.map(bandTile)}
              </div>

              <div style={{ marginBottom: 24 }}>
                <Card title="Purchase Costs" color="#f59e0b">
                  <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                    Everything you need to pay to buy. Deposit, stamp duty, the first mortgage payment and the product fee come from the <button style={LINK_BTN} onClick={() => setTab(2)}>Mortgage</button> tab. For yearly costs like insurance, enter both the annual and the monthly price and choose how you'll pay — only the chosen one counts. Paying annually comes out of savings (now and at each renewal); paying monthly comes out of your monthly budget. One-off costs are paid upfront; to spread one (e.g. furniture on finance), add it under <button style={LINK_BTN} onClick={() => setTab(5)}>Finance Agreements</button> instead.
                  </p>
                  <div style={{ overflowX: "auto" }}>
                    <div style={{ minWidth: mode === MODE.HOUSEHOLD ? 980 : 870 }}>
                      <div style={{ display: "grid", gridTemplateColumns: costCols, gap: 8, alignItems: "center", padding: "0 4px 6px 4px", borderBottom: "2px solid #e2e8f0", fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        <span>Item</span>
                        <span style={{ textAlign: "right" }}>Upfront £</span>
                        <span style={{ textAlign: "right" }}>Monthly £</span>
                        <span>Renews</span>
                        <span>Pay</span>
                        <span>Type</span>
                        {mode === MODE.HOUSEHOLD && <span title="Who pays this cost each month after you move in">Split</span>}
                        <span style={{ textAlign: "center" }} title="Already paid — no longer counts towards the cash you still need">Paid</span>
                        <span></span>
                      </div>
                      {sectionHead("Essentials", "#6366f1")}
                      {pp.autoRows.map(autoRowView)}
                      {productFee <= 0 && (
                        <div style={{ fontSize: 12, color: "#94a3b8", padding: "6px 4px" }}>
                          No product fee entered — add one under <button style={LINK_BTN} onClick={() => setTab(2)}>Lender Deal</button> on the Mortgage tab.
                        </div>
                      )}
                      {purchaseCosts.filter((c) => c.category === "essential").map(costRowView)}
                      {subtotalRow("Essentials total", pp.essentialsTotal, monthlyFor("essential"), "#eef2ff", "#6366f1")}
                      {sectionHead("Extras", "#8b5cf6")}
                      {purchaseCosts.filter((c) => c.category === "extra").map(costRowView)}
                      {purchaseCosts.every((c) => c.category !== "extra") && (
                        <div style={{ fontSize: 13, color: "#94a3b8", padding: "8px 4px" }}>No extras yet — add furnishings, removals or decorating with + Extra.</div>
                      )}
                      {subtotalRow("Extras total", pp.extrasTotal, monthlyFor("extra"), "#f5f3ff", "#8b5cf6")}
                      <div style={{ display: "grid", gridTemplateColumns: costCols, gap: 8, alignItems: "center", padding: "10px 4px", borderTop: "2px solid #6366f1" }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: "#6366f1" }}>Total ideal</span>
                        <span style={{ textAlign: "right", fontSize: 16, fontWeight: 800, color: "#6366f1" }}>{fmt2(pp.idealTotal)}</span>
                        <span style={{ textAlign: "right", fontSize: 12, color: "#64748b", fontWeight: 600 }}>{pp.monthlyTotal > 0.005 ? `${fmt2(pp.monthlyTotal)}/mo` : ""}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <input type="text" placeholder="New cost (e.g. Valuation fee)" value={newCostName} onChange={(e) => setNewCostName(e.target.value)} style={{ flex: "2 1 220px", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14 }} />
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 140px" }}>
                      <span style={{ color: "#94a3b8", fontWeight: 600 }}>£</span>
                      <input type="number" step={0.01} placeholder="Upfront" value={newCostUpfront || ""} onChange={(e) => setNewCostUpfront(parseFloat(e.target.value) || 0)} style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14 }} />
                    </div>
                    <button onClick={() => addPurchaseCost("essential")} style={{ padding: "8px 14px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}>+ Essential</button>
                    <button onClick={() => addPurchaseCost("extra")} style={{ padding: "8px 14px", background: "#8b5cf6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}>+ Extra</button>
                  </div>
                  {quickAdd.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                      <span style={{ fontSize: 12, color: "#64748b" }}>Common costs:</span>
                      {quickAdd.map((q) => (
                        <button key={q.name} onClick={() => addPurchaseCost(q.category, q)} style={CHIP_STYLE}>+ {q.name}</button>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 16, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>Buy projection uses</span>
                    <div style={{ minWidth: 260 }}>
                      <Toggle value={includeExtrasInProjection ? 1 : 0} onChange={(i) => setIncludeExtrasInProjection(i === 1)} labels={["Essentials only", "Include extras"]} />
                    </div>
                    <span style={{ fontSize: 12, color: "#64748b", flex: "1 1 260px" }}>
                      Projections and the Report take {fmt2(pp.drainAmount)} from your ticked pots on day one{postPurchasePots.shortfall > 0.005 ? `, leaving a ${fmt2(postPurchasePots.shortfall)} shortfall to recover from monthly savings` : ""}.
                    </span>
                  </div>

                  {(pp.paidTotal > 0.005 || pp.monthlyTotal > 0.005 || pp.annualTotal > 0.005) && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12, padding: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13 }}>
                      <div><div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>ALREADY PAID</div><strong style={{ color: "#10b981" }}>{fmt2(pp.paidTotal)}</strong></div>
                      <div><div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>STILL TO PAY</div><strong>{fmt2(pp.essentialsToPay)}</strong> <span style={{ color: "#64748b" }}>· {fmt2(pp.idealToPay)} with extras</span></div>
                      <div><div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>ONGOING</div><strong>{fmt2(pp.monthlyTotal)}/mo</strong>{pp.annualTotal > 0.005 && <span style={{ color: "#64748b" }}> · {fmt2(pp.annualTotal)}/yr from savings</span>}</div>
                    </div>
                  )}
                </Card>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
                <Card title="Funding" color="#10b981">
                  <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                    Tick the pots you'll use for the purchase. Balances come from the <button style={LINK_BTN} onClick={() => setTab(4)}>Savings &amp; Investments</button> tab.{pp.completionInFuture ? " The forecast assumes each pot's rate and monthly contribution carry on until completion." : ""}
                  </p>
                  {pots.length === 0 ? (
                    <p style={{ color: "#94a3b8", textAlign: "center", padding: 12, fontSize: 13 }}>No pots yet — add your savings on the Savings &amp; Investments tab.</p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <div style={{ minWidth: pp.completionInFuture ? 520 : 410 }}>
                        <div style={{ display: "grid", gridTemplateColumns: fundCols, gap: 8, alignItems: "center", padding: "0 4px 6px 4px", borderBottom: "2px solid #e2e8f0", fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          <span style={{ textAlign: "center" }}>Use</span>
                          <span>Pot</span>
                          <span style={{ textAlign: "right" }}>Today £</span>
                          <span style={{ textAlign: "right" }}>Monthly £</span>
                          {pp.completionInFuture && <span style={{ textAlign: "right" }}>At completion £</span>}
                        </div>
                        {ownerGroups.map((g) => {
                          const groupPots = g.key === "all" ? pots : pots.filter((p) => (p.owner === "p2" || p.owner === "joint" ? p.owner : "p1") === g.key);
                          if (groupPots.length === 0) return null;
                          return (
                            <div key={g.key}>
                              {g.label && <div style={{ padding: "10px 4px 4px", fontSize: 11, fontWeight: 700, color: g.color, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `1px solid ${g.color}33` }}>{g.label}</div>}
                              {groupPots.map(fundRow)}
                              {g.key !== "all" && (
                                <div style={{ display: "grid", gridTemplateColumns: fundCols, gap: 8, alignItems: "center", padding: "6px 4px", background: `${g.color}11`, fontWeight: 700, fontSize: 13, color: g.color }}>
                                  <span />
                                  <span>{g.label} — for purchase</span>
                                  <span style={{ textAlign: "right" }}>{fmt2(pp.availableTodayByOwner[g.key])}</span>
                                  <span style={{ textAlign: "right" }}>{fmt2(pp.tickedMonthlyByOwner[g.key])}</span>
                                  {pp.completionInFuture && <span style={{ textAlign: "right" }}>{fmt2(pp.availableAtCompletionByOwner[g.key])}</span>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div style={{ display: "grid", gridTemplateColumns: fundCols, gap: 8, alignItems: "center", padding: "8px 4px", borderTop: "2px solid #10b981", fontWeight: 800, fontSize: 13, color: "#10b981" }}>
                          <span />
                          <span>Available for the purchase</span>
                          <span style={{ textAlign: "right" }}>{fmt2(pp.availableToday)}</span>
                          <span style={{ textAlign: "right" }}>{fmt2(pp.tickedMonthly)}</span>
                          {pp.completionInFuture && <span style={{ textAlign: "right" }}>{fmt2(pp.availableAtCompletion)}</span>}
                        </div>
                      </div>
                    </div>
                  )}
                  {pots.length > 0 && pp.tickedCount === 0 && (
                    <div style={{ marginTop: 12, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: 12, color: "#92400e", fontWeight: 600 }}>
                      No pots are ticked, so nothing counts as available yet.
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 10, lineHeight: 1.5 }}>
                    Current accounts, savings, ISAs and LISAs are ticked by default; investments, pensions and share schemes aren't. Untick any stocks &amp; shares ISA you don't plan to sell. Changing a pot's type resets its tick.
                  </div>
                </Card>

                <Card title="Completion Forecast" color="#6366f1">
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <InputGroup label="Completion date" value={completionDate} onChange={(v) => { if (isIsoDateOrEmpty(v)) setCompletionDate(v); }} prefix="" type="date" max="9999-12-31" />
                    </div>
                    {completionDate && (
                      <button onClick={() => setCompletionDate("")} style={{ marginBottom: 16, padding: "8px 12px", background: "#f1f5f9", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Clear</button>
                    )}
                  </div>
                  {!pp.completionInFuture && (
                    <div style={HINT_STYLE}>
                      {!completionDate ? "No date set — figures assume you complete today." : completionDate === todayISO ? "Completing today — figures use today's balances." : pp.completionSoon ? "Less than a month away — figures use today's balances." : "That date has passed — figures use today's balances."}
                    </div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <StatBox label="Months to Go" value={pp.monthsToCompletion} sub={completionDate ? fmtDate(completionDate) : "completing today"} />
                    <StatBox label="Funds at Completion" value={fmt2(pp.available)} color="#10b981" sub={pp.completionInFuture ? "forecast, ticked pots" : "today, ticked pots"} />
                    <StatBox label="Into Ticked Pots" value={fmt2(pp.tickedMonthly)} color="#8b5cf6" sub="per month" />
                    <StatBox label="Gap at Completion" value={fmt2(Math.abs(pp.gap))} color={isShort(pp.gap) ? "#ef4444" : "#10b981"} sub={isShort(pp.gap) ? "short for essentials" : "spare after essentials"} />
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 2, marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span>Essentials covered</span>
                      {coverLabel(pp.gapCloseMonth, pp.gapCloseDate)}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span>Ideal (incl. extras) covered</span>
                      {coverLabel(pp.gapIdealCloseMonth, pp.gapIdealCloseDate)}
                    </div>
                  </div>
                  {(() => {
                    if (isShort(pp.gap) && pp.completionInFuture) {
                      return (
                        <div style={{ marginTop: 8, padding: 12, borderRadius: 8, fontSize: 13, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>
                          To close the gap by {fmtDate(completionDate)}, save an extra <strong>{fmt2(pp.extraMonthlyNeeded)}</strong> a month into your ticked pots.
                          {isShort(pp.gapIdeal) && <> {fmt2(pp.extraMonthlyNeededIdeal)} a month would cover the extras too.</>}
                        </div>
                      );
                    }
                    if (isShort(pp.gap) && completionDate) {
                      return (
                        <div style={{ marginTop: 8, padding: 12, borderRadius: 8, fontSize: 13, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>
                          {completionDate > todayISO ? "Completion is less than a month away" : "Your completion date isn't in the future"}, so monthly saving can't close the {fmt2(pp.gap)} gap in time — you'd need it from other savings, by unticking fewer pots, or by cutting costs.
                        </div>
                      );
                    }
                    if (isShort(pp.gap)) {
                      return (
                        <div style={{ marginTop: 8, padding: 12, borderRadius: 8, fontSize: 13, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" }}>
                          Set a completion date to see how much extra you'd need to save each month.
                        </div>
                      );
                    }
                    return (
                      <div style={{ marginTop: 8, padding: 12, borderRadius: 8, fontSize: 13, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" }}>
                        {isShort(pp.gapIdeal)
                          ? `Your ticked pots cover the essentials. The extras need another ${fmt2(pp.gapIdeal)}.`
                          : `Your ticked pots cover the essentials and the extras${pp.completionInFuture ? " by completion" : ""}.`}
                      </div>
                    );
                  })()}
                  {mortgage.followOnPayment != null && (
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
                      Your fixed rate ends on {fmtDate(fixedRateEndDate)}, {mortgage.fixedMonths} monthly payments after completion.
                    </div>
                  )}
                </Card>
              </div>

              <Card title="Upfront or Monthly?" color="#8b5cf6">
                <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Some costs, like insurance, can be paid once a year or monthly. Paying annually comes out of savings — more cash before you move and again at each renewal — but frees up your monthly budget. Paying monthly keeps the cash but adds to your monthly outgoings.</p>
                {pp.comparisonRows.length === 0 ? (
                  <p style={{ color: "#94a3b8", textAlign: "center", padding: 12, fontSize: 13 }}>Mark a cost as Yearly and enter both an annual and a monthly price (for example, insurance quotes) to compare them here.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e2e8f0", color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          <th style={{ padding: "6px 8px", textAlign: "left" }}>Cost</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Annually</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Monthly × 12</th>
                          <th style={{ padding: "6px 8px", textAlign: "right" }}>Difference a year</th>
                          <th style={{ padding: "6px 8px", textAlign: "center" }}>Paying</th>
                          <th style={{ padding: "6px 8px" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pp.comparisonRows.map((r) => {
                          const payingMonthly = r.payment === "monthly";
                          const cashLabel = r.category === "extra" ? "cash needed incl. extras" : "cash needed";
                          const cashNow = r.paid ? "already paid, so cash needed is unchanged" : `${payingMonthly ? "+" : "−"}${fmt2(r.upfront)} ${cashLabel} now`;
                          return (
                            <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "8px" }}>
                                <strong>{r.name}</strong>
                                <div style={{ fontSize: 11, color: "#94a3b8" }}>
                                  {payingMonthly
                                    ? `Paying annually instead: ${cashNow} (then each renewal from savings), ${fmt2(r.monthly)} a month off your budget`
                                    : `Paying monthly instead: ${cashNow}, ${fmt2(r.monthly)} a month added to your budget`}
                                </div>
                              </td>
                              <td style={{ padding: "8px", textAlign: "right" }}>{fmt2(r.upfront)}</td>
                              <td style={{ padding: "8px", textAlign: "right" }}>
                                {fmt2(r.annualMonthly)}
                                <div style={{ fontSize: 11, color: "#94a3b8" }}>12 × {fmt2(r.monthly)}</div>
                              </td>
                              <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, color: Math.abs(r.saving) > 0.005 ? "#10b981" : "#94a3b8" }}>
                                {r.saving > 0.005 ? `Annually saves ${fmt2(r.saving)}` : r.saving < -0.005 ? `Monthly saves ${fmt2(-r.saving)}` : "Same either way"}
                              </td>
                              <td style={{ padding: "8px", textAlign: "center" }}>
                                <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, fontWeight: 600, background: payingMonthly ? "#fffbeb" : "#eef2ff", color: payingMonthly ? "#92400e" : "#6366f1" }}>{payingMonthly ? "Monthly" : "Annually"}</span>
                              </td>
                              <td style={{ padding: "8px", textAlign: "right" }}>
                                <button onClick={() => updatePurchaseCost(r.id, "payment", payingMonthly ? "upfront" : "monthly")} style={{ padding: "4px 10px", background: "#f5f3ff", color: "#8b5cf6", border: "1px solid #ddd6fe", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>
                                  {payingMonthly ? "Pay annually" : "Pay monthly"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          );
        })()}

        {tab === 4 && (() => {
          const months = investYears * 12;
          const longSeries = potsLongProjection.series;
          const longTotal = potsLongProjection.total;
          const sampleStep = investYears > 10 ? 6 : investYears > 4 ? 3 : 1;
          const chartData = [];
          for (let m = 0; m <= months; m += sampleStep) {
            const point = { month: m, total: longTotal[m] };
            longSeries.forEach((s) => { point[`pot_${s.id}`] = s.history[m]; });
            chartData.push(point);
          }
          if (chartData[chartData.length - 1]?.month !== months) {
            const point = { month: months, total: longTotal[months] };
            longSeries.forEach((s) => { point[`pot_${s.id}`] = s.history[months]; });
            chartData.push(point);
          }
          const totalContributed = pots.reduce((s, p) => s + (p.startingBalance || 0) + (p.monthlyContribution || 0) * months, 0);
          const finalValue = longTotal[months] || 0;
          const growth = finalValue - totalContributed;
          const blendedFwd = (() => {
            const totalIn = pots.reduce((s, p) => s + (p.startingBalance || 0) + (p.monthlyContribution || 0) * months, 0);
            if (totalIn <= 0) return 0;
            return pots.reduce((s, p) => {
              const w = (p.startingBalance || 0) + (p.monthlyContribution || 0) * months;
              return s + w * (p.rate || 0);
            }, 0) / totalIn;
          })();

          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                <div style={{ background: "#f5f3ff", borderRadius: 12, padding: 14, textAlign: "center", border: "1px solid #ddd6fe" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>TOTAL BALANCE TODAY</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#8b5cf6" }}>{fmt(totalExistingSavings)}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{pots.length} pot{pots.length === 1 ? "" : "s"}</div>
                </div>
                <div style={{ background: "#f0fdf4", borderRadius: 12, padding: 14, textAlign: "center", border: "1px solid #bbf7d0" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>MONTHLY CONTRIBUTIONS</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#10b981" }}>{fmt(totalMonthlyPotContributions)}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>across all pots</div>
                </div>
                <div style={{ background: "#fffbeb", borderRadius: 12, padding: 14, textAlign: "center", border: "1px solid #fde68a" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>BLENDED RETURN</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#f59e0b" }}>{blendedRate.toFixed(2)}%</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>weighted by balance</div>
                </div>
                <div style={{ background: "#eef2ff", borderRadius: 12, padding: 14, textAlign: "center", border: "1px solid #c7d2fe" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>VALUE AT {investYears}Y</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#6366f1" }}>{fmt(finalValue)}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>+{fmt(growth)} growth</div>
                </div>
              </div>

              <div style={{ marginBottom: 24 }}>
                <Card title="Manage Pots" color="#8b5cf6">
                  <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Each pot compounds at its own rate and cadence. Cash ISAs and most savings accounts pay interest <strong>annually</strong>; stocks &amp; shares ISAs, investments and pensions effectively compound <strong>monthly</strong>. Tick <strong>Sacrifice</strong> for pots paid from gross pay before tax, such as Share Incentive Plan (SIP) partnership shares, so the contribution reduces income tax & NI. A pension entered as Pension Contribution % on the Overview tab is already taken before tax, so don't tick Sacrifice for it too. Pots ticked <strong>Purchase</strong> count towards buying a house on the Purchase Plan tab; current accounts, savings, ISAs and LISAs start ticked.</p>
                  <div style={{ overflowX: "auto" }}>
                    <div style={{ minWidth: 1230 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 2fr) 130px 120px 120px 120px 90px 120px 80px 80px 110px 32px", gap: 8, alignItems: "center", padding: "0 4px 6px 4px", borderBottom: "2px solid #e2e8f0", fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        <span>Name</span>
                        <span>Type</span>
                        <span>Owner</span>
                        <span style={{ textAlign: "right" }}>Starting £</span>
                        <span style={{ textAlign: "right" }}>Monthly £</span>
                        <span style={{ textAlign: "right" }}>Rate %</span>
                        <span>Compounding</span>
                        <span style={{ textAlign: "center" }} title="Salary sacrifice — contribution comes from gross pay, reducing tax & NI">Sacrifice</span>
                        <span style={{ textAlign: "center" }} title="Use this pot to fund the house purchase (Purchase Plan tab)">Purchase</span>
                        <span style={{ textAlign: "right" }}>End £</span>
                        <span></span>
                      </div>
                      {pots.length === 0 && <p style={{ color: "#94a3b8", textAlign: "center", padding: 20 }}>No pots yet — add one below.</p>}
                      {pots.map((p) => {
                        const series = longSeries.find((s) => s.id === p.id);
                        const endVal = series ? series.history[months] : 0;
                        const compounding = p.compounding || defaultCompoundingFor(p.type);
                        const sacrificeAllowed = p.owner !== "joint";
                        return (
                          <div key={p.id} style={{ display: "grid", gridTemplateColumns: "minmax(160px, 2fr) 130px 120px 120px 120px 90px 120px 80px 80px 110px 32px", gap: 8, alignItems: "center", padding: "8px 4px", borderBottom: "1px solid #f1f5f9" }}>
                            <input type="text" value={p.name} onChange={(e) => updatePot(p.id, "name", e.target.value)} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, minWidth: 0, width: "100%" }} />
                            <select value={p.type} onChange={(e) => updatePot(p.id, "type", e.target.value)} style={{ padding: "6px 6px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12, background: `${POT_TYPE_COLORS[p.type]}15`, color: POT_TYPE_COLORS[p.type], fontWeight: 600, minWidth: 0, width: "100%" }}>
                              {POT_TYPES.map((t) => <option key={t} value={t}>{POT_TYPE_LABELS[t]}</option>)}
                            </select>
                            <select value={p.owner} onChange={(e) => updatePot(p.id, "owner", e.target.value)} style={{ padding: "6px 6px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12, minWidth: 0, width: "100%" }}>
                              <option value="p1">Person 1</option>
                              {mode === MODE.HOUSEHOLD && <option value="p2">Person 2</option>}
                              {mode === MODE.HOUSEHOLD && <option value="joint">Joint</option>}
                            </select>
                            <input type="number" value={p.startingBalance} onChange={(e) => updatePot(p.id, "startingBalance", parseFloat(e.target.value) || 0)} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, minWidth: 0, width: "100%", textAlign: "right" }} />
                            <input type="number" value={p.monthlyContribution} onChange={(e) => updatePot(p.id, "monthlyContribution", parseFloat(e.target.value) || 0)} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, minWidth: 0, width: "100%", textAlign: "right" }} />
                            <input type="number" step={0.1} value={p.rate} onChange={(e) => updatePot(p.id, "rate", parseFloat(e.target.value) || 0)} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, minWidth: 0, width: "100%", textAlign: "right" }} />
                            <select value={compounding} onChange={(e) => updatePot(p.id, "compounding", e.target.value)} title="How interest is applied to this pot" style={{ padding: "6px 6px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12, minWidth: 0, width: "100%" }}>
                              {Object.entries(COMPOUNDING_MODES).map(([c, { label }]) => <option key={c} value={c}>{label}</option>)}
                            </select>
                            <label style={{ display: "flex", justifyContent: "center", alignItems: "center", cursor: sacrificeAllowed ? "pointer" : "not-allowed", opacity: sacrificeAllowed ? 1 : 0.4 }} title={sacrificeAllowed ? "Treat monthly contribution as salary sacrifice — reduces taxable gross" : "Joint pots can't be salary-sacrificed"}>
                              <input type="checkbox" checked={!!p.salarySacrifice} disabled={!sacrificeAllowed} onChange={(e) => updatePot(p.id, "salarySacrifice", e.target.checked)} style={{ width: 18, height: 18, cursor: sacrificeAllowed ? "pointer" : "not-allowed", accentColor: "#0ea5e9" }} />
                            </label>
                            <label style={{ display: "flex", justifyContent: "center", alignItems: "center", cursor: "pointer" }} title="Use this pot to fund the house purchase">
                              <input type="checkbox" checked={!!p.forPurchase} onChange={(e) => updatePot(p.id, "forPurchase", e.target.checked)} style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#10b981" }} />
                            </label>
                            <span style={{ textAlign: "right", fontWeight: 700, color: "#10b981", fontSize: 13, whiteSpace: "nowrap" }}>{fmt(endVal)}</span>
                            <button onClick={() => removePot(p.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: 700, fontSize: 18, padding: 0 }}>×</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
                    <input type="text" placeholder="New pot name (e.g. Help to Buy ISA)" value={newPotName} onChange={(e) => setNewPotName(e.target.value)} style={{ flex: 1, padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14 }} />
                    <button onClick={addPot} style={{ padding: "8px 18px", background: "#8b5cf6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 14 }}>+ Add Pot</button>
                  </div>
                </Card>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 24, marginBottom: 24 }}>
                <Card title="Per-Owner Subtotals" color="#6366f1">
                  <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Money-weighted view across pot ownership. Joint pots are shown separately.</p>
                  {(() => {
                    const visibleOwners = ["p1", "p2", "joint"].filter((owner) => {
                      if (mode === MODE.SINGLE && owner !== "p1") return false;
                      return potsByOwner[owner].count > 0;
                    });
                    if (visibleOwners.length === 0) {
                      return <p style={{ color: "#94a3b8", textAlign: "center", padding: 12, fontSize: 13 }}>No pots assigned yet.</p>;
                    }
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: `repeat(${visibleOwners.length}, 1fr)`, gap: 12 }}>
                        {visibleOwners.map((owner) => {
                          const o = potsByOwner[owner];
                          const ownerColor = owner === "p1" ? "#6366f1" : owner === "p2" ? "#8b5cf6" : "#ec4899";
                          const ownerLabel = owner === "p1" ? "Person 1" : owner === "p2" ? "Person 2" : "Joint";
                          const ownerEnd = pots.filter((p) => p.owner === owner).reduce((s, p) => {
                            const series = longSeries.find((sx) => sx.id === p.id);
                            return s + (series ? series.history[months] : 0);
                          }, 0);
                          return (
                            <div key={owner} style={{ background: `${ownerColor}11`, borderRadius: 10, padding: 12, border: `1px solid ${ownerColor}33` }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                                <strong style={{ color: ownerColor, fontSize: 14 }}>{ownerLabel}</strong>
                                <span style={{ fontSize: 11, color: "#94a3b8" }}>{o.count} pot{o.count === 1 ? "" : "s"}</span>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#475569" }}>
                                <span>Starting</span><strong>{fmt(o.starting)}</strong>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#475569" }}>
                                <span>Monthly</span><strong>{fmt(o.monthly)}/mo</strong>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: ownerColor, fontWeight: 700, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${ownerColor}33` }}>
                                <span>At {investYears}y</span><strong>{fmt(ownerEnd)}</strong>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  <div style={{ marginTop: 12, padding: 12, background: "#f8fafc", borderRadius: 8, fontSize: 12, color: "#64748b", border: "1px solid #e2e8f0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>Total contributed over {investYears}y</span><strong>{fmt(totalContributed)}</strong></div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>Forward blended return</span><strong>{blendedFwd.toFixed(2)}%</strong></div>
                  </div>
                </Card>
              </div>

              <Card title={`Pot Growth Over ${investYears} Years`} color="#10b981">
                <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>Horizon</label>
                  <input type="range" min={1} max={40} value={investYears} onChange={(e) => setInvestYears(parseInt(e.target.value))} style={{ flex: 1 }} />
                  <strong style={{ minWidth: 60, textAlign: "right" }}>{investYears} years</strong>
                </div>
                <ResponsiveContainer width="100%" height={400}>
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tickFormatter={(m) => (m < 12 ? `${m}m` : `${(m / 12).toFixed(0)}y`)} />
                    <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => fmt(v)} labelFormatter={(m) => (m < 12 ? `Month ${m}` : `Year ${(m / 12).toFixed(1)}`)} />
                    <Legend />
                    {pots.map((p, i) => (
                      <Area key={p.id} type="monotone" dataKey={`pot_${p.id}`} name={p.name} stackId="1" fill={POT_TYPE_COLORS[p.type] || COLORS[i % COLORS.length]} fillOpacity={0.6} stroke={POT_TYPE_COLORS[p.type] || COLORS[i % COLORS.length]} strokeWidth={1.5} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
                <p style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 8 }}>
                  Each pot stacks to show the combined balance. Forecasts use each pot's own rate and compounding. Past performance does not guarantee future results.
                </p>
              </Card>
            </div>
          );
        })()}

        {tab === 5 && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
              {agreementPayments.map((a, idx) => (
                <Card key={idx} title={a.name} color={COLORS[idx % COLORS.length]}>
                  <InputGroup label="Name" value={a.name} onChange={(v) => updateAgreement(idx, "name", v)} prefix="" type="text" />
                  <InputGroup label="Total Amount" value={a.amount} onChange={(v) => updateAgreement(idx, "amount", v)} />
                  <InputGroup label="APR" value={a.rate} onChange={(v) => updateAgreement(idx, "rate", v)} prefix="" suffix="%" step={0.1} />
                  <InputGroup label="Term" value={a.termMonths} onChange={(v) => updateAgreement(idx, "termMonths", v)} prefix="" suffix="months" />

                  <div style={{ background: "#f8fafc", borderRadius: 8, padding: 16, marginTop: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <StatBox label="Monthly Payment" value={fmt(a.monthlyPayment)} color="#6366f1" />
                      <StatBox label="Total Interest" value={fmt(a.totalInterest)} color="#ef4444" />
                      <StatBox label="Total Cost" value={fmt(a.totalCost)} />
                    </div>
                  </div>

                  <button onClick={() => removeAgreement(idx)} style={{ marginTop: 12, padding: "8px 16px", background: "#fee2e2", color: "#ef4444", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                    Remove
                  </button>
                </Card>
              ))}
            </div>

            <button onClick={addAgreement} style={{ padding: "12px 24px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 700, fontSize: 14 }}>
              + Add Finance Agreement
            </button>

            {agreementPayments.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <Card title="Impact on Monthly Budget" color="#ef4444">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                    <StatBox label="Net Income" value={fmt(totalMonthlyNet)} color="#10b981" />
                    <StatBox label="Expenses" value={fmt(totalExpenses)} color="#f59e0b" />
                    <StatBox label="Agreement Payments" value={fmt(totalAgreementMonthly)} color="#ef4444" />
                    <StatBox label="Remaining" value={fmt(totalMonthlyNet - totalExpenses - totalAgreementMonthly)} color={totalMonthlyNet - totalExpenses - totalAgreementMonthly >= 0 ? "#10b981" : "#ef4444"} />
                  </div>
                  <div style={{ marginTop: 16, padding: 12, background: "#fef2f2", borderRadius: 8, fontSize: 13, color: "#64748b" }}>
                    Finance agreements consume <strong style={{ color: "#ef4444" }}>{((totalAgreementMonthly / totalMonthlyNet) * 100).toFixed(1)}%</strong> of your monthly net income.
                    {totalAgreementMonthly / totalMonthlyNet > 0.2 && <span style={{ color: "#ef4444" }}> Consider whether this level of debt servicing is sustainable.</span>}
                  </div>
                </Card>
              </div>
            )}
          </div>
        )}

        {tab === 6 && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
              <Card title="Projection Settings" color="#6366f1">
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Projection Period</label>
                  <Toggle value={projectionMonths === 12 ? 0 : 1} onChange={(v) => setProjectionMonths(v === 0 ? 12 : 24)} labels={["12 Months", "24 Months"]} />
                </div>
                <InputGroup label="Annual Salary Growth" value={salaryGrowth} onChange={setSalaryGrowth} prefix="" suffix="%" step={0.5} />
                <InputGroup label="Annual Inflation Rate" value={inflationRate} onChange={setInflationRate} prefix="" suffix="%" step={0.5} />
              </Card>

              <Card title="Savings Vehicles" color="#8b5cf6">
                <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Toggle which savings strategies to include in the projection. Layer multiple to see combined impact.</p>
                {[
                  { key: "pots", label: `Savings Pots (${pots.length})`, sub: pots.length === 0 ? "No pots configured" : `${fmt(totalMonthlyPotContributions)}/mo across ${pots.length} pot${pots.length === 1 ? "" : "s"} · ${blendedRate.toFixed(2)}% blended`, active: projIncludePots, set: setProjIncludePots, color: "#8b5cf6" },
                  { key: "model", label: "Savings Model", sub: `${SAVINGS_MODELS[projSavingsModel]?.name}`, active: projIncludeModel, set: setProjIncludeModel, color: "#6366f1" },
                  { key: "pyf", label: "Pay Yourself First (Extra)", sub: `${fmt(pyfSavingsTarget)}/mo fixed target`, active: projIncludePYF, set: setProjIncludePYF, color: "#ec4899", disabled: projIncludeModel && projSavingsModel === SAVINGS_MODEL_PYF },
                ].map(v => (
                  <label key={v.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: v.active ? `${v.color}11` : "#f8fafc", borderRadius: 10, marginBottom: 6, cursor: v.disabled ? "not-allowed" : "pointer", border: v.active ? `2px solid ${v.color}` : "2px solid #e2e8f0", opacity: v.disabled ? 0.5 : 1, transition: "all 0.15s" }}>
                    <div style={{ position: "relative", width: 40, height: 22, background: v.active ? v.color : "#cbd5e1", borderRadius: 11, flexShrink: 0, transition: "background 0.2s", cursor: v.disabled ? "not-allowed" : "pointer" }}
                      onClick={(e) => { e.preventDefault(); if (!v.disabled) v.set(!v.active); }}>
                      <div style={{ position: "absolute", top: 2, left: v.active ? 20 : 2, width: 18, height: 18, background: "#fff", borderRadius: "50%", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: v.active ? v.color : "#64748b" }}>{v.label}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>{v.sub}</div>
                    </div>
                  </label>
                ))}
                {projIncludePYF && projIncludeModel && projSavingsModel === SAVINGS_MODEL_PYF && (
                  <div style={{ fontSize: 11, color: "#f59e0b", padding: "4px 8px", background: "#fffbeb", borderRadius: 6, marginTop: 4 }}>
                    PYF is already included via the savings model — extra PYF toggle disabled to avoid double-counting.
                  </div>
                )}
              </Card>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
              <Card title="Savings Model Selection" color="#6366f1">
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 8 }}>Apply Model to Projection</label>
                  {SAVINGS_MODELS.map(({ name: m }, i) => (
                    <label key={m} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: projSavingsModel === i ? "#f0f0ff" : "#f8fafc", borderRadius: 8, marginBottom: 4, cursor: "pointer", border: projSavingsModel === i ? "2px solid #6366f1" : "2px solid transparent", opacity: projIncludeModel ? 1 : 0.5 }}>
                      <input type="radio" checked={projSavingsModel === i} onChange={() => setProjSavingsModel(i)} disabled={!projIncludeModel} />
                      <span style={{ fontWeight: projSavingsModel === i ? 700 : 500 }}>{m}</span>
                    </label>
                  ))}
                </div>
                {projSavingsModel === SAVINGS_MODEL_PYF && projIncludeModel && (
                  <InputGroup label="PYF Monthly Target" value={pyfSavingsTarget} onChange={setPyfSavingsTarget} />
                )}
                {projIncludePYF && !(projIncludeModel && projSavingsModel === SAVINGS_MODEL_PYF) && (
                  <InputGroup label="Extra PYF Monthly Target" value={pyfSavingsTarget} onChange={setPyfSavingsTarget} />
                )}
                {!projIncludeModel && <p style={{ fontSize: 12, color: "#94a3b8", margin: "8px 0 0 0" }}>Enable the "Savings Model" vehicle above to use this.</p>}
              </Card>

              <Card title="Projected Outcomes" color="#10b981">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <StatBox label={`Total at ${projectionMonths}m`} value={fmt(projectionData[projectionData.length - 1]?.totalSavings || 0)} color="#10b981" />
                  <StatBox label="Avg Monthly Saving" value={fmt(((projectionData[projectionData.length - 1]?.totalSavings || 0) - totalExistingSavings) / projectionMonths)} color="#6366f1" />
                  <StatBox label={`Income at M${projectionMonths}`} value={fmt(projectionData[projectionData.length - 1]?.income || 0)} color="#8b5cf6" sub="/month" />
                  <StatBox label={`Expenses at M${projectionMonths}`} value={fmt(projectionData[projectionData.length - 1]?.expenses || 0)} color="#f59e0b" sub="with inflation" />
                </div>
                {snapshot.activeVehicles.length > 0 && (
                  <div style={{ marginTop: 12, padding: "8px 12px", background: "#f0fdf4", borderRadius: 8, fontSize: 12, color: "#166534" }}>
                    <strong>Active:</strong> {snapshot.activeVehicles.join(" + ")}
                  </div>
                )}
                <div style={{ marginTop: 8, padding: "8px 12px", background: "#eef2ff", borderRadius: 8, fontSize: 12, color: "#4338ca" }}>
                  <strong>Monthly commitments:</strong> {fmt(snapshot.activePotsMonthly + snapshot.monthlySavingsGoal)} total ({[
                    snapshot.monthlySavingsGoal > 0 ? `${fmt(snapshot.monthlySavingsGoal)} model savings` : null,
                    snapshot.activePotsMonthly > 0 ? `${fmt(snapshot.activePotsMonthly)} pots` : null,
                  ].filter(Boolean).join(" + ") || "none"})
                </div>
              </Card>
            </div>

            <div style={{ marginBottom: 24 }}>
              <Card title="House Deposit Tracker" color="#ec4899">
                <div style={{ fontSize: 14, marginBottom: 12 }}>
                  <span style={{ color: "#64748b" }}>Cash still needed: </span>
                  <strong style={{ color: "#6366f1" }}>{fmt(purchasePlan.essentialsToPay)}</strong>
                  <span style={{ color: "#64748b" }}> essentials · {fmt(purchasePlan.idealToPay)} with extras</span>
                  <br />
                  <span style={{ color: "#8b5cf6", fontSize: 13 }}>
                    {purchasePlan.tickedCount > 0
                      ? `${fmt(purchasePlan.availableToday)} today in ${purchasePlan.tickedCount} pot${purchasePlan.tickedCount === 1 ? "" : "s"} ticked for the purchase`
                      : "No pots ticked for the purchase yet"}
                  </span>
                </div>
                {(() => {
                  const target = purchasePlan.essentialsToPay;
                  const progress = target > 0 ? Math.min(100, (purchasePlan.availableToday / target) * 100) : 100;
                  const m = purchasePlan.gapCloseMonth;
                  const late = m !== null && m > 0 && !!completionDate && m > purchasePlan.monthsToCompletion;
                  const monthsLate = late ? m - purchasePlan.monthsToCompletion : 0;
                  const good = m === 0 || (m !== null && !late);
                  let status;
                  if (m === 0) status = `Your ticked pots already cover the essentials${purchasePlan.gapIdealCloseMonth === 0 ? " and extras" : ""}.`;
                  else if (m === null) status = "At current contributions your ticked pots won't cover the essentials within 10 years. Tick more pots or increase contributions on the Savings & Investments tab.";
                  else status = `Your ticked pots should cover the essentials in about ${m} month${m === 1 ? "" : "s"} (${fmtMonthYear(purchasePlan.gapCloseDate)})${completionDate ? (late ? `, ${monthsLate} month${monthsLate === 1 ? "" : "s"} after your completion date` : ", before your completion date") : ""}.`;
                  return (
                    <>
                      <div style={{ background: "#f1f5f9", borderRadius: 99, height: 24, overflow: "hidden", marginBottom: 8 }}>
                        <div style={{ background: "linear-gradient(90deg, #6366f1, #ec4899)", height: "100%", width: `${progress}%`, borderRadius: 99, transition: "width 0.5s" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#64748b" }}>
                        <span>{fmt(purchasePlan.availableToday)} available today</span>
                        <span>{progress.toFixed(1)}% of essentials</span>
                      </div>
                      <div style={{ marginTop: 8, padding: 12, background: good ? "#f0fdf4" : "#fef2f2", borderRadius: 8, fontSize: 13, color: good ? "#10b981" : "#ef4444", fontWeight: 600 }}>
                        {status}
                      </div>
                    </>
                  );
                })()}
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <button style={LINK_BTN} onClick={() => setTab(3)}>Open Purchase Plan</button>
                </div>
              </Card>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 24 }}>
              <Card title="Savings Accumulation" color="#10b981">
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={projectionData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(1)}k`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Area type="monotone" dataKey="totalSavings" name="Total Savings" fill="#10b98133" stroke="#10b981" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Monthly Income vs Expenses vs Savings" color="#6366f1">
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={projectionData.filter((_, i) => i > 0)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis tickFormatter={(v) => `£${v}`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Bar dataKey="income" name="Income" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="saving" name="Savings" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Post-Purchase Scenario — If You Completed Today" color="#ec4899">
                <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 12px 0", lineHeight: 1.6 }}>
                  If you completed today, {fmt(postPurchasePots.drainAmount)} of upfront costs{includeExtrasInProjection ? " (including extras)" : " (essentials only)"} would come out of your ticked pots{postPurchasePots.shortfall > 0.005 ? `, leaving ${fmt(postPurchasePots.shortfall)} to recover from monthly savings` : ""}.
                  Rent ({fmt(rent)}/mo) is replaced by the mortgage ({fmt2(mortgage.monthlyPayment)}/mo{overpayMonthly > 0 ? ` + ${fmt(overpayMonthly)} overpayment` : ""}), council tax ({fmt(councilTax)}){purchasePlan.monthlyProjectionTotal > 0 ? ` and ${fmt(purchasePlan.monthlyProjectionTotal)}/mo of purchase costs paid monthly` : ""}.
                  {" "}{reserveFirstPayment ? "The first mortgage payment is already set aside in the upfront costs." : `Month 1 pays the full first payment of ${fmt2(mortgage.firstPayment)} from income.`}
                  {overpayAnnual > 0 ? ` The ${fmt(overpayAnnual)} yearly lump sum comes out of savings.` : ""}
                  {purchasePlan.annualRenewalTotal > 0 ? ` Annual renewals (${fmt(purchasePlan.annualRenewalTotal)}) come out of savings each year.` : ""}
                  {" "}Property appreciates at {housePriceGrowth}% p.a.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                  <StatBox label="Day 1 Savings" value={fmt(postPurchaseData[0]?.totalSavings || 0)} color={postPurchasePots.shortfall > 0.005 ? "#ef4444" : "#10b981"} sub={postPurchasePots.shortfall > 0.005 ? `${fmt(postPurchasePots.shortfall)} not covered by ticked pots` : "after upfront costs"} />
                  <StatBox label={`Savings at ${projectionMonths}m`} value={fmt(postPurchaseData[postPurchaseData.length - 1]?.totalSavings || 0)} color="#ec4899" sub="pots + cash" />
                  <StatBox label={`Equity at ${projectionMonths}m`} value={fmt(postPurchaseData[postPurchaseData.length - 1]?.equity || 0)} color="#10b981" sub="property equity" />
                  <StatBox label={`Net Wealth at ${projectionMonths}m`} value={fmt(postPurchaseData[postPurchaseData.length - 1]?.netWealth || 0)} color="#6366f1" sub="savings + equity" />
                </div>
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={projectionData.map((d, i) => ({ label: d.label, rentSavings: d.totalSavings, buySavings: postPurchaseData[i]?.totalSavings || 0, buyNetWealth: postPurchaseData[i]?.netWealth || 0 }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend />
                    <Area type="monotone" dataKey="rentSavings" name="Renting — Savings" fill="#6366f122" stroke="#6366f1" strokeWidth={2} />
                    <Area type="monotone" dataKey="buySavings" name="Buying today — Savings" fill="#ec489922" stroke="#ec4899" strokeWidth={2} strokeDasharray="6 3" />
                    <Area type="monotone" dataKey="buyNetWealth" name="Buying today — Net Wealth" fill="#10b98122" stroke="#10b981" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </div>
        )}

        {tab === 7 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card title="Log an Expense" color="#6366f1">
              <InputGroup label="Description" value={newExpenseName} onChange={setNewExpenseName} prefix="" type="text" />
              <InputGroup label="Amount" value={newExpenseAmount} onChange={setNewExpenseAmount} />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 4 }}>Category</label>
                <select
                  value={newExpenseCategory}
                  onChange={(e) => setNewExpenseCategory(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15 }}
                >
                  {["Rent/Housing", "Bills", "Food", "Transport", "Entertainment", "Clothing", "Health", "Subscriptions", "One-off Purchase", "Other"].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <InputGroup label="Date" value={newExpenseDate} onChange={setNewExpenseDate} prefix="" type="date" />
              <button
                onClick={addExpenseEntry}
                style={{ width: "100%", padding: "12px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 700, fontSize: 14, marginTop: 8 }}
              >
                + Add Expense
              </button>
              <div style={{ marginTop: 16, padding: 12, background: "#f0f0ff", borderRadius: 8, fontSize: 13, color: "#64748b" }}>
                Use this log to track actual spending. All entries are included when you <strong>Save Data</strong> and restored when you <strong>Load Data</strong>.
              </div>
            </Card>

            <div>
              <Card title="Spending Summary" color="#10b981">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                  <StatBox label="Total Logged" value={fmt(expenseLogTotal)} color="#6366f1" />
                  <StatBox label="Entries" value={expenseLog.length} color="#64748b" />
                </div>
                {expenseLogByCategory.length > 0 && (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={expenseLogByCategory} cx="50%" cy="50%" innerRadius={40} outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                        {expenseLogByCategory.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </Card>
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <Card title="Expense History" color="#8b5cf6">
                {expenseLog.length === 0 ? (
                  <p style={{ color: "#94a3b8", textAlign: "center", padding: 24 }}>No expenses logged yet. Add one above to get started.</p>
                ) : (
                  <div style={{ maxHeight: 500, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                          <th style={{ padding: "8px 12px", color: "#64748b", fontWeight: 600 }}>Date</th>
                          <th style={{ padding: "8px 12px", color: "#64748b", fontWeight: 600 }}>Description</th>
                          <th style={{ padding: "8px 12px", color: "#64748b", fontWeight: 600 }}>Category</th>
                          <th style={{ padding: "8px 12px", color: "#64748b", fontWeight: 600, textAlign: "right" }}>Amount</th>
                          <th style={{ padding: "8px 12px", width: 60 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {expenseLog.map((entry) => (
                          <tr key={entry.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "10px 12px", color: "#64748b" }}>{entry.date}</td>
                            <td style={{ padding: "10px 12px", fontWeight: 600 }}>{entry.name}</td>
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{ background: "#f1f5f9", padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, color: "#6366f1" }}>
                                {entry.category}
                              </span>
                            </td>
                            <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700 }}>{fmt(entry.amount)}</td>
                            <td style={{ padding: "10px 12px" }}>
                              <button
                                onClick={() => removeExpenseEntry(entry.id)}
                                style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontWeight: 700, fontSize: 16 }}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab === 8 && (() => {
          const rLine = (label, value, color) => (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f1f5f9" }}>
              <span style={{ color: "#475569" }}>{label}</span>
              <strong style={{ color: color || "#1e293b" }}>{value}</strong>
            </div>
          );
          const projEnd = projectionData[projectionData.length - 1];
          const postProjEnd = postPurchaseData[postPurchaseData.length - 1];
          const rPotsMonthly = snapshot.activePotsMonthly;
          const activeContribPots = pots.filter((p) => (p.monthlyContribution || 0) > 0);
          const potEndValues = (projectionPotSeries?.series || []).reduce((m, s) => { m[s.id] = s.history[s.history.length - 1] || 0; return m; }, {});
          const postPotEndValues = (postPurchasePots?.projection?.series || []).reduce((m, s) => { m[s.id] = s.history[s.history.length - 1] || 0; return m; }, {});
          const upfrontDrawdown = postPurchasePots?.drawdown || {};
          const sectionNum = (() => { let n = 0; return () => ++n; })();

          const SectionHeader = ({ num, title, subtitle, color }) => (
            <div style={{ gridColumn: "1 / -1", marginTop: num > 1 ? 12 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: color || "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14, flexShrink: 0 }}>{num}</div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1e293b" }}>{title}</h3>
                  {subtitle && <p style={{ margin: 0, fontSize: 11, color: "#94a3b8" }}>{subtitle}</p>}
                </div>
              </div>
              <div style={{ height: 2, background: `linear-gradient(to right, ${color || "#6366f1"}, transparent)`, marginBottom: 12 }} />
            </div>
          );

          const SubHead = ({ text, color }) => (
            <div style={{ fontSize: 12, fontWeight: 700, color: color || "#6366f1", textTransform: "uppercase", letterSpacing: "0.05em", margin: "14px 0 6px 0", borderBottom: `1px solid ${color || "#6366f1"}33`, paddingBottom: 3 }}>{text}</div>
          );

          const expenseRows = splitExpenseRows;

          const secIncome = sectionNum();
          const secExpenses = sectionNum();
          const secHousehold = mode === MODE.HOUSEHOLD ? sectionNum() : null;
          const secSavings = sectionNum();
          const secMortgage = sectionNum();
          const secPurchase = sectionNum();
          const secBudget = sectionNum();
          const secCharts = sectionNum();
          const secProjection = sectionNum();

          return (
            <div>
              <div style={{ background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)", borderRadius: 16, padding: "28px 32px", marginBottom: 24, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Personal Finance Report</h2>
                  <p style={{ margin: "6px 0 0 0", fontSize: 13, opacity: 0.85 }}>
                    {mode === MODE.HOUSEHOLD ? "Household" : "Individual"} · {snapshot.activeVehicles.length > 0 ? snapshot.activeVehicles.join(" + ") : "No savings vehicles"} · {projectionMonths}-Month Outlook
                  </p>
                  <p style={{ margin: "2px 0 0 0", fontSize: 12, opacity: 0.7 }}>
                    Generated {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                </div>
                <button
                  onClick={() => window.print()}
                  style={{ padding: "10px 24px", background: "rgba(255,255,255,0.2)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 10, cursor: "pointer", fontWeight: 700, fontSize: 14, backdropFilter: "blur(4px)" }}
                >
                  Print / Save as PDF
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
                <div style={{ background: "#f0fdf4", borderRadius: 12, padding: "14px 16px", textAlign: "center", border: "1px solid #bbf7d0" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Monthly Net Income</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#10b981" }}>{fmt(totalMonthlyNet)}</div>
                </div>
                <div style={{ background: "#fef2f2", borderRadius: 12, padding: "14px 16px", textAlign: "center", border: "1px solid #fecaca" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Monthly Expenses</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#ef4444" }}>{fmt(totalExpenses)}</div>
                </div>
                <div style={{ background: "#eef2ff", borderRadius: 12, padding: "14px 16px", textAlign: "center", border: "1px solid #c7d2fe" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Disposable Now</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: snapshot.preDisposable >= 0 ? "#6366f1" : "#ef4444" }}>{fmt(snapshot.preDisposable)}</div>
                  <div style={{ fontSize: 10, color: "#94a3b8" }}>with rent & all commitments</div>
                </div>
                <div style={{ background: "#fdf4ff", borderRadius: 12, padding: "14px 16px", textAlign: "center", border: "1px solid #f0abfc" }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase" }}>Disposable Post-Mortgage</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: snapshot.postDisposable >= 0 ? "#8b5cf6" : "#ef4444" }}>{fmt(snapshot.postDisposable)}</div>
                  <div style={{ fontSize: 10, color: "#94a3b8" }}>rent → mortgage + council tax{purchasePlan.monthlyTotal > 0 ? " + monthly costs" : ""}</div>
                </div>
              </div>

              <div id="report-content" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 13 }}>

                <SectionHeader num={secIncome} title="Income Breakdown" subtitle="Tax, NI, pension & student loan deductions" color="#10b981" />

                <Card title="Person 1 — Income">
                  {rLine("Gross Annual Salary", fmt(calc1.gross))}
                  {calc1.seIncome > 0 && rLine("↳ of which Self-Employed", fmt(calc1.seIncome), "#0ea5e9")}
                  {rLine("Income Tax", fmt(calc1.tax), "#ef4444")}
                  {rLine("National Insurance", fmt(calc1.ni), "#ef4444")}
                  {calc1.class4Ni > 0 && rLine("↳ of which Class 4 NI (SA)", fmt(calc1.class4Ni), "#ef4444")}
                  {rLine("Pension Contribution", fmt(calc1.pensionAmt), "#8b5cf6")}
                  {calc1.sacrificeAmt > 0 && rLine("Salary Sacrifice", fmt(calc1.sacrificeAmt), "#0ea5e9")}
                  {calc1.slRepay > 0 && rLine("Student Loan Repayment", fmt(calc1.slRepay), "#ec4899")}
                  {calc1.saTaxBill > 0 && rLine("Self Assessment Bill (annual)", fmt(calc1.saTaxBill), "#ef4444")}
                  <div style={{ borderTop: "2px solid #10b981", marginTop: 8, paddingTop: 6 }}>
                    {calc1.seIncome > 0 && rLine("PAYE Monthly Take-Home", fmt(calc1.payeMonthly), "#10b981")}
                    {rLine(calc1.seIncome > 0 ? "Total Monthly (smoothed)" : "Monthly Take-Home", fmt(calc1.monthly), "#10b981")}
                    {rLine("Annual Take-Home", fmt(calc1.net), "#10b981")}
                  </div>
                </Card>

                {mode === MODE.HOUSEHOLD ? (
                  <Card title="Person 2 — Income">
                    {rLine("Gross Annual Salary", fmt(calc2.gross))}
                    {calc2.seIncome > 0 && rLine("↳ of which Self-Employed", fmt(calc2.seIncome), "#0ea5e9")}
                    {rLine("Income Tax", fmt(calc2.tax), "#ef4444")}
                    {rLine("National Insurance", fmt(calc2.ni), "#ef4444")}
                    {calc2.class4Ni > 0 && rLine("↳ of which Class 4 NI (SA)", fmt(calc2.class4Ni), "#ef4444")}
                    {rLine("Pension Contribution", fmt(calc2.pensionAmt), "#8b5cf6")}
                    {calc2.sacrificeAmt > 0 && rLine("Salary Sacrifice", fmt(calc2.sacrificeAmt), "#0ea5e9")}
                    {calc2.slRepay > 0 && rLine("Student Loan Repayment", fmt(calc2.slRepay), "#ec4899")}
                    {calc2.saTaxBill > 0 && rLine("Self Assessment Bill (annual)", fmt(calc2.saTaxBill), "#ef4444")}
                    <div style={{ borderTop: "2px solid #10b981", marginTop: 8, paddingTop: 6 }}>
                      {rLine("Monthly Take-Home", fmt(calc2.monthly), "#10b981")}
                      {rLine("Annual Take-Home", fmt(calc2.monthly * 12), "#10b981")}
                    </div>
                  </Card>
                ) : (
                  <Card title="Income Summary">
                    <div style={{ background: "#f0fdf4", borderRadius: 8, padding: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>EFFECTIVE TAX RATE</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: "#ef4444" }}>{((calc1.tax + calc1.ni) / calc1.gross * 100).toFixed(1)}%</div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      {rLine("Total Deductions", fmt(calc1.tax + calc1.ni + calc1.pensionAmt + calc1.slRepay), "#ef4444")}
                      {rLine("Monthly Net", fmt(calc1.monthly), "#10b981")}
                    </div>
                  </Card>
                )}

                {mode === MODE.HOUSEHOLD && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "10px 20px", display: "flex", justifyContent: "space-around", alignItems: "center", border: "1px solid #bbf7d0" }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 1 NET</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#6366f1" }}>{fmt(calc1.monthly)}</div>
                      </div>
                      <div style={{ fontSize: 20, color: "#94a3b8" }}>+</div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 2 NET</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#8b5cf6" }}>{fmt(calc2.monthly)}</div>
                      </div>
                      <div style={{ fontSize: 20, color: "#94a3b8" }}>=</div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>HOUSEHOLD NET</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#10b981" }}>{fmt(totalMonthlyNet)}</div>
                      </div>
                    </div>
                  </div>
                )}

                <SectionHeader num={secExpenses} title="Monthly Expenses" subtitle="Living costs, subscriptions & finance agreements" color="#f59e0b" />

                <Card title="Expense Breakdown">
                  {expenseRows.map((e, i) => <div key={i}>{rLine(e.name, fmt(e.amount))}</div>)}
                  <div style={{ borderTop: "2px solid #f59e0b", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total Monthly Expenses", fmt(totalExpenses), "#ef4444")}
                  </div>
                </Card>

                <Card title="Expense Distribution">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={expensePieData} cx="50%" cy="50%" innerRadius={40} outerRadius={75} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} style={{ fontSize: 10 }}>
                        {expensePieData.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </Card>

                {totalAgreementMonthly > 0 && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Card title="Finance Agreements">
                      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(agreementPayments.length, 4)}, 1fr)`, gap: 12 }}>
                        {agreementPayments.map((a, i) => (
                          <div key={i} style={{ background: "#fffbeb", borderRadius: 8, padding: 12, border: "1px solid #fde68a" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>{a.name}</div>
                            {rLine("Monthly", fmt(a.monthlyPayment))}
                            {rLine("Total Interest", fmt(a.totalInterest))}
                          </div>
                        ))}
                      </div>
                      <div style={{ borderTop: "2px solid #f59e0b", marginTop: 12, paddingTop: 6 }}>
                        {rLine("Total Agreement Payments", fmt(totalAgreementMonthly), "#ef4444")}
                      </div>
                    </Card>
                  </div>
                )}

                {mode === MODE.HOUSEHOLD && (
                  <>
                    <SectionHeader num={secHousehold} title="Household Contribution Split" subtitle={`Split method: ${splitMode === SPLIT_MODE.EARNINGS_RATIO ? "Ratio of Earnings" : "Custom %"} — Person 1: ${splitP1Pct.toFixed(1)}% · Person 2: ${splitP2Pct.toFixed(1)}%`} color="#ec4899" />

                    <div style={{ gridColumn: "1 / -1" }}>
                      <Card title="Expense-by-Expense Breakdown">
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e2e8f0", background: "#fdf2f8" }}>
                              <th style={{ padding: "8px 10px", textAlign: "left", color: "#64748b", fontWeight: 700 }}>Expense</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#64748b", fontWeight: 700 }}>Total</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#6366f1", fontWeight: 700 }}>Person 1 ({splitP1Pct.toFixed(1)}%)</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 700 }}>Person 2 ({splitP2Pct.toFixed(1)}%)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expenseRows.map((e, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                                <td style={{ padding: "6px 10px" }}>
                                  {e.name}
                                  {e.splitType !== "shared" && <span style={{ fontSize: 9, marginLeft: 6, padding: "1px 4px", borderRadius: 3, background: e.splitType === "p1" ? "#eef2ff" : "#f5f3ff", color: e.splitType === "p1" ? "#6366f1" : "#8b5cf6", fontWeight: 600 }}>{e.splitType === "p1" ? "P1" : "P2"} only</span>}
                                </td>
                                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>{fmt(e.amount)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(e.p1)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(e.p2)}</td>
                              </tr>
                            ))}
                            <tr style={{ borderTop: "1px solid #e2e8f0", fontWeight: 600, background: "#fdf2f8" }}>
                              <td style={{ padding: "6px 10px", color: "#64748b" }}>Household Expenses</td>
                              <td style={{ padding: "6px 10px", textAlign: "right" }}>{fmt(totalExpenses)}</td>
                              <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1" }}>{fmt(splitTotalP1)}</td>
                              <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6" }}>{fmt(splitTotalP2)}</td>
                            </tr>
                            {personalCommitmentRows.map((r, i) => (
                              <tr key={`c${i}`} style={{ borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
                                <td style={{ padding: "6px 10px", fontStyle: "italic" }}>{r.name}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>{fmt(r.amount)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(r.person === "p1" ? r.amount : 0)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(r.person === "p2" ? r.amount : 0)}</td>
                              </tr>
                            ))}
                            <tr style={{ borderTop: "2px solid #ec4899", fontWeight: 700, background: "#fdf2f8" }}>
                              <td style={{ padding: "8px 10px" }}>Total All Commitments</td>
                              <td style={{ padding: "8px 10px", textAlign: "right" }}>{fmt(totalExpenses + commitTotal)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#6366f1" }}>{fmt(splitTotalP1 + commitP1)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#8b5cf6" }}>{fmt(splitTotalP2 + commitP2)}</td>
                            </tr>
                          </tbody>
                        </table>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
                          <div style={{ background: "#eef2ff", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #c7d2fe" }}>
                            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 1 — REMAINING AFTER ALL COMMITMENTS</div>
                            <div style={{ fontSize: 22, fontWeight: 800, color: calc1.monthly - splitTotalP1 - commitP1 >= 0 ? "#10b981" : "#ef4444" }}>
                              {fmt(calc1.monthly - splitTotalP1 - commitP1)}
                            </div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>from {fmt(calc1.monthly)} take-home</div>
                          </div>
                          <div style={{ background: "#f5f3ff", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #ddd6fe" }}>
                            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 2 — REMAINING AFTER ALL COMMITMENTS</div>
                            <div style={{ fontSize: 22, fontWeight: 800, color: calc2.monthly - splitTotalP2 - commitP2 >= 0 ? "#10b981" : "#ef4444" }}>
                              {fmt(calc2.monthly - splitTotalP2 - commitP2)}
                            </div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>from {fmt(calc2.monthly)} take-home</div>
                          </div>
                        </div>
                      </Card>
                    </div>

                    <div style={{ gridColumn: "1 / -1" }}>
                      <Card title="Post-Mortgage Contribution Split" color="#10b981">
                        <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 12px 0" }}>Projected household costs after purchase — rent replaced by the mortgage, plus council tax and any purchase costs paid monthly</p>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e2e8f0", background: "#f0fdf4" }}>
                              <th style={{ padding: "8px 10px", textAlign: "left", color: "#64748b", fontWeight: 700 }}>Expense</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#64748b", fontWeight: 700 }}>Total</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#6366f1", fontWeight: 700 }}>Person 1 ({splitP1Pct.toFixed(1)}%)</th>
                              <th style={{ padding: "8px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 700 }}>Person 2 ({splitP2Pct.toFixed(1)}%)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {postMortgageSplitRows.map((e, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                                <td style={{ padding: "6px 10px" }}>
                                  {e.name}
                                  {e.splitType !== "shared" && <span style={{ fontSize: 9, marginLeft: 6, padding: "1px 4px", borderRadius: 3, background: e.splitType === "p1" ? "#eef2ff" : "#f5f3ff", color: e.splitType === "p1" ? "#6366f1" : "#8b5cf6", fontWeight: 600 }}>{e.splitType === "p1" ? "P1" : "P2"} only</span>}
                                </td>
                                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>{fmt(e.amount)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(e.p1)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(e.p2)}</td>
                              </tr>
                            ))}
                            <tr style={{ borderTop: "1px solid #e2e8f0", fontWeight: 600, background: "#f0fdf4" }}>
                              <td style={{ padding: "6px 10px", color: "#64748b" }}>Household Expenses</td>
                              <td style={{ padding: "6px 10px", textAlign: "right" }}>{fmt(postSplitTotal)}</td>
                              <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1" }}>{fmt(postSplitTotalP1)}</td>
                              <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6" }}>{fmt(postSplitTotalP2)}</td>
                            </tr>
                            {personalCommitmentRows.map((r, i) => (
                              <tr key={`c${i}`} style={{ borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
                                <td style={{ padding: "6px 10px", fontStyle: "italic" }}>{r.name}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>{fmt(r.amount)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{fmt(r.person === "p1" ? r.amount : 0)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b5cf6", fontWeight: 600 }}>{fmt(r.person === "p2" ? r.amount : 0)}</td>
                              </tr>
                            ))}
                            <tr style={{ borderTop: "2px solid #10b981", fontWeight: 700, background: "#f0fdf4" }}>
                              <td style={{ padding: "8px 10px" }}>Total All Commitments</td>
                              <td style={{ padding: "8px 10px", textAlign: "right" }}>{fmt(postSplitTotal + commitTotal)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#6366f1" }}>{fmt(postSplitTotalP1 + commitP1)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#8b5cf6" }}>{fmt(postSplitTotalP2 + commitP2)}</td>
                            </tr>
                          </tbody>
                        </table>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
                          <div style={{ background: "#eef2ff", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #c7d2fe" }}>
                            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 1 — REMAINING POST-MORTGAGE</div>
                            <div style={{ fontSize: 22, fontWeight: 800, color: calc1.monthly - postSplitTotalP1 - commitP1 >= 0 ? "#10b981" : "#ef4444" }}>
                              {fmt(calc1.monthly - postSplitTotalP1 - commitP1)}
                            </div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>from {fmt(calc1.monthly)} take-home</div>
                          </div>
                          <div style={{ background: "#f5f3ff", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #ddd6fe" }}>
                            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PERSON 2 — REMAINING POST-MORTGAGE</div>
                            <div style={{ fontSize: 22, fontWeight: 800, color: calc2.monthly - postSplitTotalP2 - commitP2 >= 0 ? "#10b981" : "#ef4444" }}>
                              {fmt(calc2.monthly - postSplitTotalP2 - commitP2)}
                            </div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>from {fmt(calc2.monthly)} take-home</div>
                          </div>
                        </div>
                        <div style={{ background: "#f0fdf4", borderRadius: 8, padding: 10, marginTop: 12, textAlign: "center", border: "1px solid #bbf7d0" }}>
                          <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>MONTHLY DIFFERENCE VS CURRENT</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: postSplitTotal <= totalExpenses ? "#10b981" : "#ef4444" }}>
                            {postSplitTotal > totalExpenses ? "+" : ""}{fmt(postSplitTotal - totalExpenses)}/mo
                          </div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>({fmt(totalExpenses)} current → {fmt(postSplitTotal)} post-mortgage)</div>
                        </div>
                      </Card>
                    </div>
                  </>
                )}

                <SectionHeader num={secSavings} title="Savings & Investments" subtitle="Current balances, goals & projected growth" color="#8b5cf6" />

                <Card title="Current Position">
                  <SubHead text="Pot Balances" color="#8b5cf6" />
                  {pots.length === 0 && rLine("No pots configured", "—", "#94a3b8")}
                  {pots.map((p) => <div key={p.id}>{rLine(`${p.name} (${p.type}${mode === MODE.HOUSEHOLD ? ` · ${p.owner === "joint" ? "Joint" : p.owner === "p2" ? "P2" : "P1"}` : ""})`, fmt(p.startingBalance || 0), POT_TYPE_COLORS[p.type])}</div>)}
                  <div style={{ borderTop: "2px solid #8b5cf6", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total Existing Savings", fmt(totalExistingSavings), "#8b5cf6")}
                  </div>
                  {mode === MODE.HOUSEHOLD && (
                    <>
                      <SubHead text="By Owner" color="#8b5cf6" />
                      {potsByOwner.p1.count > 0 && rLine(`Person 1 (${potsByOwner.p1.count} pot${potsByOwner.p1.count === 1 ? "" : "s"})`, fmt(potsByOwner.p1.starting), "#6366f1")}
                      {potsByOwner.p2.count > 0 && rLine(`Person 2 (${potsByOwner.p2.count} pot${potsByOwner.p2.count === 1 ? "" : "s"})`, fmt(potsByOwner.p2.starting), "#8b5cf6")}
                      {potsByOwner.joint.count > 0 && rLine(`Joint (${potsByOwner.joint.count} pot${potsByOwner.joint.count === 1 ? "" : "s"})`, fmt(potsByOwner.joint.starting), "#ec4899")}
                    </>
                  )}
                  <SubHead text="Active Savings Vehicles" color="#8b5cf6" />
                  {snapshot.activeVehicles.map((v, i) => <div key={i}>{rLine(v, "Active", "#10b981")}</div>)}
                  {snapshot.activeVehicles.length === 0 && rLine("No savings vehicles enabled", "—", "#94a3b8")}
                  <SubHead text="Monthly Saving Commitments" color="#8b5cf6" />
                  {snapshot.monthlySavingsGoal > 0 && rLine(`Savings Goal (${snapshot.selectedModel})`, fmt(snapshot.monthlySavingsGoal))}
                  {activeContribPots.map((p) => <div key={p.id}>{rLine(`${p.name} (${p.type})`, fmt(p.monthlyContribution), POT_TYPE_COLORS[p.type])}</div>)}
                  <div style={{ borderTop: "2px solid #6366f1", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total Monthly Commitments", fmt(snapshot.monthlySavingsGoal + rPotsMonthly), "#6366f1")}
                  </div>
                </Card>

                <Card title={`Projected at ${projectionMonths} Months`}>
                  <SubHead text="Without Buying — Keep Renting" color="#6366f1" />
                  <div style={{ background: "#f5f3ff", borderRadius: 10, padding: 14, textAlign: "center", marginBottom: 12, border: "1px solid #ddd6fe" }}>
                    <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>PROJECTED TOTAL SAVINGS</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: "#8b5cf6" }}>{fmt(projEnd?.totalSavings || 0)}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>up from {fmt(totalExistingSavings)}</div>
                  </div>
                  {projIncludePots && rLine("Pots Projected Value", fmt(projEnd?.potsValue || 0), "#8b5cf6")}
                  {projIncludePots && pots.length > 0 && (
                    <div style={{ marginLeft: 12, marginTop: 4 }}>
                      {pots.map((p) => <div key={p.id}>{rLine(`↳ ${p.name}`, fmt(potEndValues[p.id] || 0), POT_TYPE_COLORS[p.type])}</div>)}
                    </div>
                  )}
                  {rLine("Cash Savings (model)", fmt(projEnd?.cashSavings || 0), "#10b981")}
                  {rLine(`Income at Month ${projectionMonths}`, fmt(projEnd?.income || 0))}
                  {rLine(`Expenses at Month ${projectionMonths}`, fmt(projEnd?.expenses || 0), "#ef4444")}

                  <SubHead text="Deposit Readiness" color="#6366f1" />
                  {rLine("Cash Still Needed (essentials)", fmt(purchasePlan.essentialsToPay))}
                  {rLine(purchasePlan.completionInFuture ? "Ticked Pots at Completion" : "Ticked Pots Today", fmt(purchasePlan.available))}
                  {rLine("Essentials Covered", coverText(purchasePlan.gapCloseMonth, purchasePlan.gapCloseDate))}
                  {purchasePlan.gap <= 0.005
                    ? <div style={{ background: "#f0fdf4", borderRadius: 8, padding: "8px 12px", marginTop: 6, display: "flex", justifyContent: "space-between", border: "1px solid #bbf7d0" }}><span style={{ color: "#166534" }}>Spare (essentials)</span><strong style={{ color: "#10b981" }}>{fmt(-purchasePlan.gap)}</strong></div>
                    : <div style={{ background: "#fef2f2", borderRadius: 8, padding: "8px 12px", marginTop: 6, display: "flex", justifyContent: "space-between", border: "1px solid #fecaca" }}><span style={{ color: "#991b1b" }}>Gap (essentials)</span><strong style={{ color: "#ef4444" }}>{fmt(purchasePlan.gap)}</strong></div>}

                  <SubHead text="After Buying (if completed today) — Savings & Wealth" color="#ec4899" />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div style={{ background: "#fdf2f8", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #f0abfc" }}>
                      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>SAVINGS AT {projectionMonths}M</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#ec4899" }}>{fmt(postProjEnd?.totalSavings || 0)}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>{postPurchasePots.shortfall > 0.005 ? `after ${fmt(postPurchasePots.shortfall)} of today's upfront costs${includeExtrasInProjection ? " (incl. extras)" : ""} not covered by ticked pots` : "pots + cash after upfront costs"}</div>
                    </div>
                    <div style={{ background: "#f0fdf4", borderRadius: 10, padding: 14, textAlign: "center", border: "1px solid #bbf7d0" }}>
                      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>TOTAL NET WEALTH AT {projectionMonths}M</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#10b981" }}>{fmt(postProjEnd?.netWealth || 0)}</div>
                      <div style={{ fontSize: 10, color: "#94a3b8" }}>savings + property equity</div>
                    </div>
                  </div>
                  <SubHead text="Property Equity Breakdown" color="#10b981" />
                  {rLine(`Property Value at ${projectionMonths}m`, fmt(postProjEnd?.propertyValue || 0), "#10b981")}
                  {rLine(`Appreciation (${housePriceGrowth}% p.a.)`, fmt((postProjEnd?.propertyValue || 0) - housePrice), "#10b981")}
                  {rLine(`Remaining Mortgage`, fmt(postProjEnd?.mortgageBalance || 0), "#ef4444")}
                  <div style={{ borderTop: "2px solid #10b981", marginTop: 6, paddingTop: 6 }}>
                    {rLine("Property Equity", fmt(postProjEnd?.equity || 0), "#10b981")}
                  </div>
                  {projIncludePots && rLine("Pots Projected Value", fmt(postProjEnd?.potsValue || 0), "#8b5cf6")}
                  {projIncludePots && pots.length > 0 && (
                    <div style={{ marginLeft: 12, marginTop: 4 }}>
                      {pots.map((p) => <div key={p.id}>{rLine(`↳ ${p.name}${upfrontDrawdown[p.id] ? ` (−${fmt(upfrontDrawdown[p.id])} drawn)` : ""}`, fmt(postPotEndValues[p.id] || 0), POT_TYPE_COLORS[p.type])}</div>)}
                    </div>
                  )}
                  {rLine(`Monthly Outgoings`, fmt(postProjEnd?.expenses || 0), "#ef4444")}

                  <div style={{ background: "#f8fafc", borderRadius: 8, padding: 12, marginTop: 12, border: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Wealth Comparison at {projectionMonths} Months</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ background: "#eef2ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>KEEP RENTING</div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>Cash Only</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: "#6366f1" }}>{fmt(projEnd?.totalSavings || 0)}</div>
                      </div>
                      <div style={{ background: "#f0fdf4", borderRadius: 8, padding: 10, textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>BUY HOUSE</div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>Cash + Property Equity</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: "#10b981" }}>{fmt(postProjEnd?.netWealth || 0)}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center", marginTop: 8 }}>
                      <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>NET WEALTH DIFFERENCE</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: (postProjEnd?.netWealth || 0) >= (projEnd?.totalSavings || 0) ? "#10b981" : "#ef4444" }}>
                        {(postProjEnd?.netWealth || 0) >= (projEnd?.totalSavings || 0) ? "+" : ""}{fmt((postProjEnd?.netWealth || 0) - (projEnd?.totalSavings || 0))}
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                        {(postProjEnd?.netWealth || 0) >= (projEnd?.totalSavings || 0) ? "Buying builds more wealth" : "Renting & saving builds more wealth"} over {projectionMonths} months at {housePriceGrowth}% growth
                      </div>
                    </div>
                  </div>
                </Card>

                <SectionHeader num={secMortgage} title="Mortgage Scenario" subtitle="Loan, lender deal, stamp duty & overpayment impact" color="#6366f1" />

                <Card title="Property & Loan">
                  {rLine("Property Price", fmt(housePrice))}
                  {rLine("Deposit", fmt(deposit))}
                  {rLine("Requested Loan", fmt(mortgage.requestedLoan))}
                  {mortgage.feeAddedToLoan > 0 && rLine("Product Fee Added to Loan", fmt2(mortgage.feeAddedToLoan))}
                  {mortgage.feeAddedToLoan > 0 && rLine("Total Borrowing", fmt(mortgage.totalBorrowing))}
                  {rLine("Loan-to-Value (LTV)", `${mortgage.ltv}%`)}
                  {mortgage.fixExpired
                    ? rLine("Rate", `${mortgage.initialRate}% (follow-on — fixed rate ended ${fmtDate(fixedRateEndDate)})`)
                    : rLine("Initial Rate", `${mortgageRate}%${mortgage.hasFollowOn ? ` until ${fmtDate(fixedRateEndDate)}` : ""}`)}
                  {mortgage.hasFollowOn && rLine("Follow-on Rate", `${mortgage.followOnRateUsed}%`)}
                  {rLine("Mortgage Term", `${mortgageTerm} years`)}
                  {rLine("Payment Method", paymentTiming === "arrears" ? "Standard (in arrears)" : "In advance")}
                  <div style={{ borderTop: "2px solid #6366f1", marginTop: 8, paddingTop: 6 }}>
                    {rLine(`Monthly Payment${mortgage.isPaymentOverridden ? " (manual)" : ""}`, fmt2(mortgage.monthlyPayment), "#6366f1")}
                    {rLine(`First Payment${mortgage.isFirstPaymentOverridden ? " (manual)" : ` (incl. ${firstPaymentDays} days' interest)`}`, fmt2(mortgage.firstPayment), "#6366f1")}
                    {mortgage.followOnPayment != null && rLine("Payment After Fixed Rate", fmt2(mortgage.followOnPayment), "#8b5cf6")}
                  </div>
                  <SubHead text="Costs" color="#f59e0b" />
                  {rLine("Stamp Duty", fmt(mortgage.stampDuty), "#f59e0b")}
                  {productFee > 0 && rLine(`Product Fee (${productFeeAddToLoan ? "added to loan" : productFeePaid ? "paid" : "upfront"})`, fmt2(productFee), "#f59e0b")}
                  {rLine("Total Interest (full term)", fmt(mortgage.totalInterest), "#ef4444")}
                  {rLine("Total Repaid", fmt(mortgage.totalRepaid))}
                  {rLine("Essential Upfront Costs", fmt2(purchasePlan.essentialsTotal), "#6366f1")}
                  {mortgage.warnings.filter((w) => w.level !== "info").map((w, i) => (
                    <div key={i} style={{ fontSize: 11, fontWeight: 600, color: w.level === "error" ? "#ef4444" : "#92400e", marginTop: 6 }}>{w.text}</div>
                  ))}
                </Card>

                {(overpayMonthly > 0 || overpayAnnual > 0) ? (
                  <Card title="Overpayment Impact">
                    <div style={{ background: "#f0fdf4", borderRadius: 10, padding: 14, textAlign: "center", marginBottom: 12, border: "1px solid #bbf7d0" }}>
                      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>INTEREST SAVED</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: "#10b981" }}>{fmt(mortgageAmortisation.interestSaved)}</div>
                      {mortgageAmortisation.monthsReduced > 0 && <div style={{ fontSize: 12, color: "#166534", marginTop: 2 }}>{fmtYearsMonths(mortgageAmortisation.monthsReduced)} off the term</div>}
                    </div>
                    {overpayMonthly > 0 && rLine("Monthly Overpayment", fmt(overpayMonthly))}
                    {overpayAnnual > 0 && rLine("Annual Lump Sum", fmt(overpayAnnual))}
                    {rLine("Original Total Interest", fmt(mortgageAmortisation.totalInterest), "#ef4444")}
                    {rLine("Reduced Total Interest", fmt(mortgageAmortisation.totalInterestOp), "#10b981")}
                    {mortgage.hasFollowOn && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>Assumes you keep paying the standard payment after the fixed rate ends.</div>}
                  </Card>
                ) : (
                  <Card title="Overpayment Impact">
                    <div style={{ textAlign: "center", padding: 24, color: "#94a3b8", fontSize: 13 }}>
                      No overpayments configured. Add overpayments in the Mortgage tab to see the impact here.
                    </div>
                  </Card>
                )}

                <SectionHeader num={secPurchase} title="Purchase Plan" subtitle={`Cash needed to buy, savings set aside and the gap · ${completionDate ? `completion ${fmtDate(completionDate)}` : "assumes completion today"}`} color="#f59e0b" />

                <Card title="Upfront Costs">
                  <SubHead text="Essentials" color="#6366f1" />
                  {purchasePlan.upfrontRows.filter((r) => r.category === "essential").map((r) => (
                    <div key={r.key}>{rLine(`${r.name}${r.paid ? " (paid)" : ""}`, fmt2(r.amount), r.paid ? "#94a3b8" : undefined)}</div>
                  ))}
                  <div style={{ borderTop: "2px solid #6366f1", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total (essentials)", fmt2(purchasePlan.essentialsTotal), "#6366f1")}
                  </div>
                  <SubHead text="Extras" color="#8b5cf6" />
                  {purchasePlan.upfrontRows.filter((r) => r.category === "extra").map((r) => (
                    <div key={r.key}>{rLine(`${r.name}${r.paid ? " (paid)" : ""}`, fmt2(r.amount), r.paid ? "#94a3b8" : undefined)}</div>
                  ))}
                  {purchasePlan.extrasCount === 0 && rLine("No extras", "—", "#94a3b8")}
                  <div style={{ borderTop: "2px solid #8b5cf6", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Extras total", fmt2(purchasePlan.extrasTotal), "#8b5cf6")}
                  </div>
                  <div style={{ borderTop: "2px solid #1e293b", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total ideal", fmt2(purchasePlan.idealTotal))}
                  </div>
                  {productFee > 0 && productFeeAddToLoan && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>Product fee of {fmt2(productFee)} added to the loan, not paid upfront.</div>}
                  {!reserveFirstPayment && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>First mortgage payment of {fmt2(mortgage.firstPayment)} paid from income in month 1.</div>}
                </Card>

                <Card title="Savings & Gap">
                  <SubHead text="Savings for the purchase" color="#10b981" />
                  {mode === MODE.HOUSEHOLD ? (
                    [{ key: "p1", label: "Person 1", color: "#6366f1" }, { key: "p2", label: "Person 2", color: "#8b5cf6" }, { key: "joint", label: "Joint", color: "#ec4899" }].map((g) => {
                      const groupPots = pots.filter((p) => p.forPurchase && (p.owner === "p2" || p.owner === "joint" ? p.owner : "p1") === g.key);
                      if (groupPots.length === 0) return null;
                      return (
                        <div key={g.key}>
                          {rLine(g.label, fmt2(purchasePlan.availableTodayByOwner[g.key]), g.color)}
                          <div style={{ marginLeft: 12 }}>
                            {groupPots.map((p) => <div key={p.id}>{rLine(`↳ ${p.name}`, fmt2(Math.max(0, p.startingBalance || 0)), POT_TYPE_COLORS[p.type])}</div>)}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    pots.filter((p) => p.forPurchase).map((p) => <div key={p.id}>{rLine(p.name, fmt2(Math.max(0, p.startingBalance || 0)), POT_TYPE_COLORS[p.type])}</div>)
                  )}
                  {purchasePlan.tickedCount === 0 && rLine("No pots ticked for the purchase", "—", "#94a3b8")}
                  <div style={{ borderTop: "2px solid #10b981", marginTop: 8, paddingTop: 6 }}>
                    {rLine("Total", fmt2(purchasePlan.availableToday), "#10b981")}
                    {purchasePlan.completionInFuture && rLine(`Forecast at completion (${fmtDate(completionDate)})`, fmt2(purchasePlan.availableAtCompletion), "#10b981")}
                  </div>
                  <SubHead text="Gap" color="#ef4444" />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {[{ label: "Gap", value: purchasePlan.gap, note: "essentials" }, { label: "Gap to ideal", value: purchasePlan.gapIdeal, note: "incl. extras" }].map((g) => {
                      const short = g.value > 0.005;
                      return (
                        <div key={g.label} style={{ background: short ? "#fef2f2" : "#f0fdf4", borderRadius: 8, padding: "8px 12px", textAlign: "center", border: `1px solid ${short ? "#fecaca" : "#bbf7d0"}` }}>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{g.label.toUpperCase()}</div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: short ? "#ef4444" : "#10b981" }}>{fmt2(Math.abs(g.value))}</div>
                          <div style={{ fontSize: 10, color: "#94a3b8" }}>{short ? "short" : "spare"} · {g.note}</div>
                        </div>
                      );
                    })}
                  </div>
                  {purchasePlan.paidTotal > 0.005 && rLine("Already paid (not in the gap)", fmt2(purchasePlan.paidTotal), "#10b981")}
                  {(purchasePlan.monthlyItems.length > 0 || purchasePlan.annualItems.length > 0) && (
                    <>
                      <SubHead text="Ongoing costs" color="#8b5cf6" />
                      {purchasePlan.monthlyItems.map((c) => <div key={`rm${c.id}`}>{rLine(`${c.label} (monthly budget)`, `${fmt2(c.monthly)}/mo`)}</div>)}
                      {purchasePlan.annualItems.map((c) => <div key={`ra${c.id}`}>{rLine(`${c.name} (annually, from savings)`, `${fmt2(c.annual)}/yr`)}</div>)}
                    </>
                  )}
                  <SubHead text="Timing" color="#6366f1" />
                  {rLine("Completion", completionDate ? fmtDate(completionDate) : "Not set (today)")}
                  {rLine("Essentials covered", coverText(purchasePlan.gapCloseMonth, purchasePlan.gapCloseDate))}
                  {purchasePlan.extraMonthlyNeeded != null && rLine("Extra saving needed by completion", `${fmt2(purchasePlan.extraMonthlyNeeded)}/mo`, "#ef4444")}
                </Card>

                <SectionHeader num={secBudget} title="Complete Monthly Budget" subtitle="Full picture after mortgage, savings, investments & agreements" color="#0ea5e9" />

                <div style={{ gridColumn: "1 / -1" }}>
                  <Card title="Monthly Budget Comparison — Current vs Post-Mortgage">
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                      <div>
                        <SubHead text="Current (Renting)" color="#6366f1" />
                        {rLine("Total Net Income", fmt(totalMonthlyNet), "#10b981")}
                        <div style={{ marginTop: 6 }} />
                        {rLine("Rent", fmt(rent))}
                        {rLine("Living Expenses (excl. rent)", fmt(totalExpenses - rent))}
                        {totalAgreementMonthly > 0 && rLine("Finance Agreements", fmt(totalAgreementMonthly))}
                        {snapshot.monthlySavingsGoal > 0 && rLine(`Savings (${snapshot.selectedModel})`, fmt(snapshot.monthlySavingsGoal))}
                        {activeContribPots.map((p) => <div key={p.id}>{rLine(`${p.name} (${p.type})`, fmt(p.monthlyContribution), POT_TYPE_COLORS[p.type])}</div>)}
                        <div style={{ borderTop: "2px solid #6366f1", marginTop: 8, paddingTop: 6 }}>
                          {rLine("Total Outgoings", fmt(snapshot.preCommitted), "#6366f1")}
                        </div>
                        <div style={{ background: snapshot.preDisposable >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 8, padding: 12, textAlign: "center", marginTop: 8, border: `1px solid ${snapshot.preDisposable >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>DISPOSABLE</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color: snapshot.preDisposable >= 0 ? "#10b981" : "#ef4444" }}>{fmt(snapshot.preDisposable)}</div>
                        </div>
                      </div>
                      <div>
                        <SubHead text="Post-Purchase (Mortgage)" color="#ec4899" />
                        {rLine("Total Net Income", fmt(totalMonthlyNet), "#10b981")}
                        <div style={{ marginTop: 6 }} />
                        {rLine("Mortgage Payment", fmt2(mortgage.monthlyPayment))}
                        {overpayMonthly > 0 && rLine("Mortgage Overpayment", fmt(overpayMonthly))}
                        {rLine("Council Tax", fmt(councilTax))}
                        {purchasePlan.monthlyItems.map((c) => <div key={`bm${c.id}`}>{rLine(c.label, fmt(c.monthly))}</div>)}
                        {rLine(`Living Expenses (excl. rent${councilTaxInBillsApplied > 0 ? " & current council tax" : ""})`, fmt(postLivingExpenses))}
                        {totalAgreementMonthly > 0 && rLine("Finance Agreements", fmt(totalAgreementMonthly))}
                        {snapshot.monthlySavingsGoal > 0 && rLine(`Savings (${snapshot.selectedModel})`, fmt(snapshot.monthlySavingsGoal))}
                        {activeContribPots.map((p) => <div key={p.id}>{rLine(`${p.name} (${p.type})`, fmt(p.monthlyContribution), POT_TYPE_COLORS[p.type])}</div>)}
                        <div style={{ borderTop: "2px solid #ec4899", marginTop: 8, paddingTop: 6 }}>
                          {rLine("Total Outgoings", fmt(snapshot.postCommitted), "#ec4899")}
                        </div>
                        <div style={{ background: snapshot.postDisposable >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 8, padding: 12, textAlign: "center", marginTop: 8, border: `1px solid ${snapshot.postDisposable >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>DISPOSABLE</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color: snapshot.postDisposable >= 0 ? "#10b981" : "#ef4444" }}>{fmt(snapshot.postDisposable)}</div>
                        </div>
                        {purchasePlan.annualTotal > 0 && (
                          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
                            Not included: {fmt(purchasePlan.annualTotal)} a year paid annually from savings (≈ {fmt(purchasePlan.annualTotal / 12)}/mo).
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ background: "#f8fafc", borderRadius: 8, padding: 12, marginTop: 14, border: "1px solid #e2e8f0" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
                        <div>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>MONTHLY COST CHANGE</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: snapshot.postCommitted > snapshot.preCommitted ? "#ef4444" : "#10b981" }}>
                            {snapshot.postCommitted > snapshot.preCommitted ? "+" : ""}{fmt(snapshot.postCommitted - snapshot.preCommitted)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>DISPOSABLE CHANGE</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: snapshot.postDisposable < snapshot.preDisposable ? "#ef4444" : "#10b981" }}>
                            {snapshot.postDisposable - snapshot.preDisposable >= 0 ? "+" : ""}{fmt(snapshot.postDisposable - snapshot.preDisposable)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>ANNUAL IMPACT</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: snapshot.postDisposable < snapshot.preDisposable ? "#ef4444" : "#10b981" }}>
                            {(snapshot.postDisposable - snapshot.preDisposable) * 12 >= 0 ? "+" : ""}{fmt((snapshot.postDisposable - snapshot.preDisposable) * 12)}
                          </div>
                        </div>
                      </div>
                    </div>
                    {mode === MODE.HOUSEHOLD && (
                      <div style={{ marginTop: 12 }}>
                        <SubHead text="Per-Person View (Post-Mortgage)" color="#ec4899" />
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          <div style={{ background: "#eef2ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>P1 TOTAL COMMITMENTS</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: "#6366f1" }}>{fmt(postSplitTotalP1 + commitP1)}</div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>remaining: {fmt(calc1.monthly - postSplitTotalP1 - commitP1)}</div>
                          </div>
                          <div style={{ background: "#f5f3ff", borderRadius: 8, padding: 10, textAlign: "center" }}>
                            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>P2 TOTAL COMMITMENTS</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: "#8b5cf6" }}>{fmt(postSplitTotalP2 + commitP2)}</div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>remaining: {fmt(calc2.monthly - postSplitTotalP2 - commitP2)}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </Card>
                </div>

                <SectionHeader num={secCharts} title="Visual Analysis" subtitle="Charts showing savings trajectory and mortgage impact" color="#ec4899" />

                <div style={{ gridColumn: "1 / -1" }}>
                  <Card title="Wealth Projection — Renting vs Buying">
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={projectionData.map((d, i) => ({ label: d.label, rentSavings: d.totalSavings, buySavings: postPurchaseData[i]?.totalSavings || 0, buyNetWealth: postPurchaseData[i]?.netWealth || 0 }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" />
                        <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} />
                        <Tooltip formatter={(v) => fmt(v)} />
                        <Legend />
                        <Area type="monotone" dataKey="rentSavings" name="Renting — Savings" fill="#6366f122" stroke="#6366f1" strokeWidth={2} />
                        <Area type="monotone" dataKey="buySavings" name="Buying today — Savings" fill="#ec489922" stroke="#ec4899" strokeWidth={2} strokeDasharray="6 3" />
                        <Area type="monotone" dataKey="buyNetWealth" name="Buying today — Net Wealth (incl. equity)" fill="#10b98122" stroke="#10b981" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                    <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 4 }}>
                      Net wealth includes cash savings + property equity ({housePriceGrowth}% annual appreciation, mortgage paydown)
                    </div>
                  </Card>
                </div>

                {(overpayMonthly > 0 || overpayAnnual > 0) && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Card title="Mortgage Balance — Standard vs Overpayment">
                      <ResponsiveContainer width="100%" height={260}>
                        <AreaChart data={mortgageAmortisation.data.filter((_, i) => i % 2 === 0 || i === mortgageAmortisation.data.length - 1)}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="year" />
                          <YAxis tickFormatter={(v) => `£${(v / 1000).toFixed(0)}k`} />
                          <Tooltip formatter={(v) => fmt(v)} />
                          <Legend />
                          <Area type="monotone" dataKey="balance" name="Standard" fill="#6366f122" stroke="#6366f1" strokeWidth={2} />
                          <Area type="monotone" dataKey="balanceOp" name="With Overpayments" fill="#10b98122" stroke="#10b981" strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </Card>
                  </div>
                )}

                <SectionHeader num={secProjection} title={`${projectionMonths}-Month Projection`} subtitle={`Vehicles: ${snapshot.activeVehicles.length > 0 ? snapshot.activeVehicles.join(" + ") : "None"} · ${salaryGrowth}% salary growth · ${inflationRate}% inflation`} color="#0ea5e9" />

                <div style={{ gridColumn: "1 / -1" }}>
                  <Card title="Month-by-Month Projection">
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #e2e8f0", background: "#f8fafc" }}>
                            <th style={{ padding: "5px 8px", textAlign: "left", color: "#64748b", fontWeight: 700 }}>Month</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#64748b", fontWeight: 700 }}>Income</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#64748b", fontWeight: 700 }}>Expenses</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#6366f1", fontWeight: 700 }}>Rent Savings</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#ec4899", fontWeight: 700 }}>Buy Savings</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#10b981", fontWeight: 700 }}>Equity</th>
                            <th style={{ padding: "5px 8px", textAlign: "right", color: "#10b981", fontWeight: 700 }}>Net Wealth</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectionData.filter((_, i) => i > 0 && (i % 3 === 0 || i === projectionData.length - 1)).map((d, idx) => {
                            const ppd = postPurchaseData[d.month];
                            return (
                              <tr key={d.month} style={{ borderBottom: "1px solid #f1f5f9", background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                                <td style={{ padding: "4px 8px", fontWeight: 600 }}>M{d.month}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right" }}>{fmt(d.income)}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right" }}>{fmt(d.expenses)}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600, color: "#6366f1" }}>{fmt(d.totalSavings)}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right", color: "#ec4899" }}>{fmt(ppd?.totalSavings || 0)}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right", color: "#10b981" }}>{fmt(ppd?.equity || 0)}</td>
                                <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600, color: "#10b981" }}>{fmt(ppd?.netWealth || 0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>
              </div>

              <div style={{ textAlign: "center", marginTop: 24, fontSize: 11, color: "#94a3b8", borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
                For illustrative purposes only — not financial advice · Generated by Personal Finance Calculator · UK Tax Year 2026/27
              </div>
            </div>
          );
        })()}
      </div>

      <div style={{ textAlign: "center", padding: "24px 16px", color: "#94a3b8", fontSize: 12, borderTop: "1px solid #e2e8f0", marginTop: 32 }}>
        Personal Finance Calculator · UK Tax Year 2026/27 · For illustrative purposes only — not financial advice
      </div>
    </div>
  );
}
