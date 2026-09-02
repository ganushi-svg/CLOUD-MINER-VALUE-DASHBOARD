// Coercion primitives shared by every tab parser.
//
// Two rules drive this file:
//   1. Money never becomes a JS float. Prices are parsed into integer minor
//      units (cents for USD, micro-dollars for $/kWh rates) so that totals
//      reconcile exactly against the spreadsheet.
//   2. An absent value and an explicitly un-quoted value are different facts.
//      The sheet writes "N/Q" when a supplier had no listing for a model, and
//      leaves the cell blank when nobody looked. Collapsing both to null would
//      destroy the distinction the valuation depends on, so every money field
//      carries an availability flag alongside its value.

/** Cell is empty / whitespace / a placeholder dash. */
const EMPTY = new Set(['', '-', '--', '—', 'n/a', 'na', 'null', 'none']);
/** Sheet's explicit "no quote exists for this model" sentinel. */
const NOT_QUOTED = new Set(['n/q', 'nq', 'not quoted', 'no quote']);

export const Availability = Object.freeze({
  QUOTED: 'QUOTED',
  NOT_QUOTED: 'NOT_QUOTED',
  MISSING: 'MISSING',
  UNPARSEABLE: 'UNPARSEABLE',
});

/** Trim, collapse inner whitespace, drop the markdown-export escape slashes. */
export function cleanText(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\\/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Google Sheets renders a vertically-merged cell into the first row only; the
 * export we ingest marks the repeats with a "[merged]" prefix. Strip it but
 * remember it happened — a merged value is inherited, not independently stated,
 * and validation must not treat it as a separate observation.
 */
export function stripMerged(raw) {
  const t = cleanText(raw);
  const m = /^\[merged\]\s*(.*)$/i.exec(t);
  return m ? { text: m[1], merged: true } : { text: t, merged: false };
}

function classify(text) {
  const lower = text.toLowerCase();
  if (EMPTY.has(lower)) return Availability.MISSING;
  if (NOT_QUOTED.has(lower)) return Availability.NOT_QUOTED;
  return null;
}

/**
 * Parse a money cell into integer minor units.
 * @param {string} raw       cell text, e.g. "1,269.00" or "$5.40" or "N/Q"
 * @param {number} scale     decimal places in the minor unit (2 = cents)
 * @returns {{value:number|null, availability:string, raw:string, truncated?:boolean}}
 */
export function toMinorUnits(raw, { scale = 2 } = {}) {
  const { text } = stripMerged(raw);
  const sentinel = classify(text);
  if (sentinel) return { value: null, availability: sentinel, raw: text };

  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { value: null, availability: Availability.UNPARSEABLE, raw: text };
  }
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  // Flag rather than silently discard precision beyond the minor unit.
  const truncated = fraction.length > scale && /[1-9]/.test(fraction.slice(scale));
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || '0');
  return {
    value: Number(negative ? -units : units),
    availability: Availability.QUOTED,
    raw: text,
    truncated,
  };
}

/** Parse a physical quantity (hashrate TH/s, power W, percentages). */
export function toNumber(raw) {
  const { text } = stripMerged(raw);
  if (classify(text)) return null;
  const cleaned = text.replace(/[,%\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Parse a non-negative integer count (units, client counts). */
export function toCount(raw) {
  const n = toNumber(raw);
  if (n == null || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/** Accept only unambiguous ISO dates; the source writes YYYY-MM-DD throughout. */
export function toIsoDate(raw) {
  const { text } = stripMerged(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    return null; // rejects impossible calendar dates such as 2026-02-31
  }
  return text;
}

/** Format integer minor units back to a decimal string for display/reporting. */
export function formatMinorUnits(value, { scale = 2 } = {}) {
  if (value == null) return null;
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
