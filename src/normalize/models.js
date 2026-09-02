// Canonical miner-model registry.
//
// The same physical model is written three different ways across the workbook
// ("Bitmain Antminer S21+ Hydro (395Th)", "Antminer S21+ HYD (358TH)",
// "Bitmain Antminer S21+ 235TH"). The Fleet View tab is the authority: it is
// the only tab that states hashrate AND power per model, so it defines the
// registry and the other two tabs resolve into it.
//
// Resolution is deliberately staged and never guesses: exact string, then
// normalized slug, then nothing. An unresolved reference is reported as a
// finding rather than silently dropped or fuzzily attached to a neighbour.

import { cleanText } from './coerce.js';

/**
 * Collapse vendor prefixes, hydro spellings and punctuation so that the three
 * spellings above converge. Keeps "+" — it distinguishes S21 from S21+.
 */
export function modelSlug(raw) {
  return cleanText(raw)
    .toLowerCase()
    .replace(/\bbitmain\b/g, ' ')
    .replace(/\bhydro\b|\bhyd\b/g, 'hyd')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9+.]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

export class ModelRegistry {
  constructor(models) {
    this.models = models;
    this.byLabel = new Map();
    this.bySlug = new Map();
    this.unresolved = new Map();
    for (const model of models) {
      this.byLabel.set(cleanText(model.label), model);
      // First writer wins; a slug collision is surfaced by validation, not here.
      if (!this.bySlug.has(model.slug)) this.bySlug.set(model.slug, model);
    }
  }

  /** @returns {{modelKey:string|null, matchedBy:'label'|'slug'|null}} */
  resolve(raw) {
    const text = cleanText(raw);
    if (!text) return { modelKey: null, matchedBy: null };

    const exact = this.byLabel.get(text);
    if (exact) return { modelKey: exact.modelKey, matchedBy: 'label' };

    const bySlug = this.bySlug.get(modelSlug(text));
    if (bySlug) return { modelKey: bySlug.modelKey, matchedBy: 'slug' };

    this.unresolved.set(text, (this.unresolved.get(text) ?? 0) + 1);
    return { modelKey: null, matchedBy: null };
  }

  /** Model strings that matched nothing, with how often each occurred. */
  unresolvedReferences() {
    return [...this.unresolved.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }
}
