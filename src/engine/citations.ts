import type { EvidenceLedger } from './ledger.js';

export interface CitationCheck {
  valid: string[];
  invalid: string[];
}

const ID = /^ev_\d+$/;

/** Split cited ids into ones that exist in this run's ledger and ones that do not. */
export function checkCitations(ids: readonly string[], ledger: EvidenceLedger): CitationCheck {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (ID.test(id) && ledger.has(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else invalid.push(id);
  }
  return { valid, invalid };
}
