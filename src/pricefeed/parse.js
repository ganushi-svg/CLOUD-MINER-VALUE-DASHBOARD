// Price-list parser.
//
// Supplier price lists arrive as free text — one model per line, written a
// dozen different ways ("S21+ 235T $1269", "Antminer S21 XP Hyd (473Th) - 2850$",
// "$5.40/T S21+ mix"). The parser never guesses: a line becomes an observation
// only when a model phrase resolves to the fleet registry and a price is
// explicit. Everything else is returned as `unresolved` with the raw line, so
// a human can see exactly what was skipped and why.
//
// Resolution works on a (family, hashrate) pair rather than string similarity.
// The same tokenizer runs over the registry's own labels, so "Bitmain Antminer
// S21+ Hydro (395Th)" and "s21+ hyd 395t" meet at the same key by construction.

import { cleanText } from '../normalize/coerce.js';

export const Basis = Object.freeze({ USED: 'USED', FRESH: 'FRESH', UNKNOWN: 'UNKNOWN' });
export const Confidence = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM' });

const HASHRATE = /(\d+(?:\.\d+)?)\s*(th\/s|th|t|gh\/s|gh|g|mh\/s|mh|m)\b/i;
const UNIT = { t: 'T', th: 'T', 'th/s': 'T', g: 'G', gh: 'G', 'gh/s': 'G', m: 'M', mh: 'M', 'mh/s': 'M' };

/**
 * Tokenize a model phrase into a canonical family key plus hashrate.
 * Returns null when no recognisable base model is present.
 */
export function parseModelPhrase(raw) {
  let text = cleanText(raw).toLowerCase().replace(/[()\[\],:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let hashrate = null, unit = null;
  const h = HASHRATE.exec(text);
  if (h) { hashrate = Number(h[1]); unit = UNIT[h[2].toLowerCase()]; text = text.replace(h[0], ' '); }

  text = text.replace(/\b(bitmain|antminer|miner|asic|bitdeer|whatsminer|microbt|elphapex)\b/g, ' ').replace(/\s+/g, ' ').trim();

  let vendor = null, base = null, m;
  if ((m = /\b(s\d{2}[ejk]?)\s*(\+|plus)?/.exec(text))) { vendor = 'antminer'; base = m[1] + (m[2] ? '+' : ''); text = text.replace(m[0], ' '); }
  else if ((m = /\b(t\d{2})\b/.exec(text))) { vendor = 'antminer'; base = m[1]; text = text.replace(m[0], ' '); }
  else if ((m = /\b(ks\d)\b/.exec(text))) { vendor = 'antminer'; base = m[1]; text = text.replace(m[0], ' '); }
  else if ((m = /\b(l\d)\b/.exec(text))) { vendor = 'antminer'; base = m[1]; text = text.replace(m[0], ' '); }
  else if ((m = /\bsealminer\s*(a\d)\b/.exec(text))) { vendor = 'bitdeer-sealminer'; base = m[1]; text = text.replace(m[0], ' '); }
  else if ((m = /\b(m\d{2}s?\+*)\b/.exec(text))) { vendor = 'whatsminer'; base = m[1]; text = text.replace(m[0], ' '); }
  else if ((m = /\b(dg\d\+?)\b/.exec(text))) { vendor = 'elphapex'; base = m[1]; text = text.replace(m[0], ' '); }
  if (!base) return null;

  const mods = [];
  if (/\bpro\b/.test(text)) mods.push('pro');
  if (/\bxp\s*\+|\bxp\+/.test(text)) mods.push('xp+'); else if (/\bxp\b/.test(text)) mods.push('xp');
  if (/\b(hyd|hydro)\b/.test(text)) mods.push('hyd');

  return { family: [vendor, base, ...mods].join('-'), hashrate, unit };
}

/** Basis from condition words; UNKNOWN when the line says nothing. */
export function parseBasis(text) {
  const t = text.toLowerCase();
  if (/\b(used|second[- ]?hand|2nd|mix(ed)?|refurb\w*|pre[- ]?owned)\b/.test(t)) return Basis.USED;
  if (/\b(brand[- ]?new|new|fresh|sealed|bnib|\bbn\b)\b/.test(t)) return Basis.FRESH;
  return Basis.UNKNOWN;
}

/**
 * Extract a USD price from a line. Returns {minor, perTh} — perTh true when
 * the figure is quoted per terahash ("$5.40/T"), to be multiplied by hashrate.
 */
export function parsePrice(text) {
  const t = text.replace(/ /g, ' ');
  let m;
  if ((m = /(?:\$|usd\s*|usdt\s*)?(\d+(?:[.,]\d+)?)\s*(?:\$|usd|usdt)?\s*\/\s*(?:th|t)\b/i.exec(t)) && /\$|usd/i.test(m[0])) {
    return { minor: Math.round(Number(m[1].replace(',', '.')) * 100), perTh: true };
  }
  if ((m = /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?\b/i.exec(t)) ||
      (m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?\s*(?:\$|usd\b|usdt\b|u\b)/i.exec(t)) ||
      (m = /(?:usd|usdt)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?\b/i.exec(t))) {
    const whole = Number(m[1].replace(/,/g, ''));
    const cents = m[2] ? Number((m[2] + '0').slice(0, 2)) : 0;
    let minor = whole * 100 + cents;
    if (m[3]) minor *= 1000;
    return { minor, perTh: false };
  }
  return null;
}

/** Split one physical line into candidate segments when it holds several quotes. */
function segments(line) {
  const parts = line.split(/\s*[|;]\s*|\s{3,}/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [line];
}

/**
 * Build a resolver over the registry. Families are computed with the same
 * tokenizer, so matching is structural rather than fuzzy.
 */
export function buildResolver(models) {
  const byFamily = new Map();
  for (const model of models) {
    const p = parseModelPhrase(model.label);
    if (!p) continue;
    if (!byFamily.has(p.family)) byFamily.set(p.family, []);
    // Index both the rated hashrate and the figure written in the label: the
    // sheet says "S21 Pro (234T)" but rates it 239 TH, and a supplier may write either.
    byFamily.get(p.family).push({ modelKey: model.modelKey, label: model.label, hashrateTh: model.hashrateTh, labelHashrate: p.unit === 'T' ? p.hashrate : null });
  }
  return function resolve(phrase) {
    const p = parseModelPhrase(phrase);
    if (!p) return { modelKey: null, reason: 'no model phrase' };
    const candidates = byFamily.get(p.family);
    if (!candidates) return { modelKey: null, reason: `family ${p.family} not in registry`, family: p.family, hashrate: p.hashrate };
    if (p.hashrate != null && p.unit === 'T') {
      const exact = candidates.find((c) => c.hashrateTh === p.hashrate || c.labelHashrate === p.hashrate);
      if (exact) return { ...exact, confidence: Confidence.HIGH, hashrate: p.hashrate };
      // The registry itself carries small label-vs-rating drift (S21 Pro 234T is
      // rated 239 TH). Accept within 3%, and say so.
      const near = candidates.map((c) => ({ c, d: Math.abs(c.hashrateTh - p.hashrate) / c.hashrateTh })).filter((x) => x.d <= 0.03).sort((a, b) => a.d - b.d)[0];
      if (near) return { ...near.c, confidence: Confidence.MEDIUM, hashrate: p.hashrate, note: `hashrate ${p.hashrate}T matched to ${near.c.hashrateTh}T` };
      return { modelKey: null, reason: `${p.family} ${p.hashrate}T not in registry`, family: p.family, hashrate: p.hashrate };
    }
    if (candidates.length === 1) return { ...candidates[0], confidence: Confidence.MEDIUM, hashrate: null, note: 'hashrate not stated; family has one registry entry' };
    return { modelKey: null, reason: `${p.family} has ${candidates.length} variants; hashrate needed`, family: p.family, hashrate: p.hashrate };
  };
}

/**
 * Parse a whole message.
 * @param {string} text            the raw message body
 * @param {object} meta            { source, sender, observedAt (ISO), messageId }
 * @param {Function} resolve       from buildResolver()
 * @returns {{observations: object[], unresolved: object[]}}
 */
export function parsePriceList(text, meta, resolve) {
  const observations = [], unresolved = [];
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    for (const seg of segments(line)) {
      const price = parsePrice(seg);
      if (!price) { if (parseModelPhrase(seg)) unresolved.push({ line: seg, reason: 'no price' }); continue; }
      const r = resolve(seg);
      if (!r.modelKey) { unresolved.push({ line: seg, reason: r.reason }); continue; }
      const hashrate = r.hashrate ?? r.hashrateTh;
      const unitPriceMinor = price.perTh ? Math.round(price.minor * hashrate) : price.minor;
      observations.push({
        modelKey: r.modelKey,
        modelLabel: r.label,
        hashrateTh: hashrate,
        unitPriceMinor,
        currency: 'USD',
        basis: parseBasis(seg),
        confidence: price.perTh && r.confidence === Confidence.HIGH ? Confidence.MEDIUM : r.confidence,
        perTh: price.perTh,
        note: [r.note, price.perTh ? 'derived from a per-TH quote' : null].filter(Boolean).join('; ') || null,
        source: meta.source ?? null,
        sender: meta.sender ?? null,
        observedAt: meta.observedAt ?? new Date().toISOString(),
        messageId: meta.messageId ?? null,
        raw: seg,
      });
    }
  }
  return { observations, unresolved };
}
