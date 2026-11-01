import type { EvidenceRecord } from '../contracts/evidence.js';

/**
 * The run's evidence ledger. Evidence IDs (ev_1, ev_2, ...) are minted here, by the tool
 * runner, never by a model. Model text never becomes evidence.
 */
export class EvidenceLedger {
  private n = 0;
  private readonly records = new Map<string, EvidenceRecord>();

  mint(rec: Omit<EvidenceRecord, 'evidenceId'>): EvidenceRecord {
    this.n += 1;
    const full: EvidenceRecord = { evidenceId: `ev_${this.n}`, ...rec };
    this.records.set(full.evidenceId, full);
    return full;
  }

  /** Re-insert a recorded record (replay/fold). */
  restore(rec: EvidenceRecord): void {
    this.records.set(rec.evidenceId, rec);
    const k = Number(rec.evidenceId.slice(3));
    if (k > this.n) this.n = k;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.get(id);
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }
}
