import type { ScenarioDef } from './_lib/scenario.js';
import { s01 } from './s01-stale-nav.js';
import { s02 } from './s02-llm-throttling.js';
import { s03 } from './s03-compliance-prompt.js';
import { s04 } from './s04-broker-rate-limit.js';
import { s05 } from './s05-missing-holdings.js';
import { s06 } from './s06-sip-double-debit.js';
import { s07 } from './s07-stale-factsheet.js';
import { s08 } from './s08-paise-rupee.js';
import { s09 } from './s09-one-bank-mandates.js';
import { s10 } from './s10-past-incident-decoy.js';
import { s11 } from './s11-ist-timestamps.js';
import { s12 } from './s12-missing-auth-logs.js';
import { s13 } from './s13-payout-db-lock.js';
import { s14 } from './s14-kyc-conflicting-evidence.js';

/** All scenarios, in order. Evaluator-side only: src/ never imports this. */
export const SCENARIOS: ScenarioDef[] = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14];
