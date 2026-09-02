// Client identity.
//
// The sheet writes clients as "144. George Pastakis" — an operator-assigned
// client code followed by a display name. Not every row carries a code
// ("DELTA ROCKHOLD EE", "Chatzifrantzeskou Marina"), and the separator is
// inconsistent ("186.Maxwell Takura Makara" has no space). Codes are the
// stable join key where present; where absent we fall back to a slug of the
// name and mark the record so downstream joins can treat it as weaker.

import { cleanText } from './coerce.js';

const CODED = /^(\d{1,4})\s*\.\s*(.+)$/;

export function nameSlug(name) {
  return cleanText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @returns {{key:string, code:string|null, name:string, coded:boolean, raw:string}}
 */
export function parseClient(raw) {
  const text = cleanText(raw);
  if (!text) return { key: '', code: null, name: '', coded: false, raw: text };

  const m = CODED.exec(text);
  if (m) {
    const code = m[1].padStart(3, '0'); // "40" and "040" are the same client
    return { key: `c:${code}`, code, name: cleanText(m[2]), coded: true, raw: text };
  }
  return { key: `n:${nameSlug(text)}`, code: null, name: text, coded: false, raw: text };
}
