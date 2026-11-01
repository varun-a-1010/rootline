import type { DependencyEdge } from '../../src/contracts/world.js';
import type { Rng } from './rng.js';

/**
 * The fictional investing app's service catalog (brief §3). Every world shares it; scenarios
 * may change dependency metadata. All names (banks, broker, tickers, funds) are invented.
 */

export type Profile = 'market' | 'investor' | 'daytime' | 'assistant' | 'flat' | 'sip_batch' | 'payout_batch' | 'nightly';

export type MetricKind = 'rate' | 'pct_error' | 'pct_success' | 'latency' | 'gauge' | 'count' | 'constant' | 'age';

export interface LabelSpec {
  key: string;
  values: string[];
  weights?: number[];
}

export interface MetricDef {
  name: string;
  unit: string;
  description: string;
  kind: MetricKind;
  base: number;
  /** Relative noise (sd as a fraction of the value). */
  noise?: number;
  /** 0..1: how strongly the metric follows traffic. */
  load?: number;
  labels?: LabelSpec;
}

export interface LogTemplate {
  sev: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  w: number;
  msg: (r: Rng) => string;
  fields?: (r: Rng) => Record<string, string | number>;
}

export interface ServiceDef {
  id: string;
  name: string;
  kind: 'internal' | 'external';
  team: string;
  tier: 1 | 2 | 3;
  description: string;
  profile: Profile;
  version: string;
  /** Background log lines per minute at traffic factor 1. */
  logDensity: number;
  /** How this service's logger writes timestamps. */
  logTz: 'utc' | 'ist_offset';
  metrics: MetricDef[];
  logs: LogTemplate[];
}

export const BANKS = ['indus_valley', 'kaveri', 'northstar', 'gomti', 'sahyadri'] as const;
export const BANK_WEIGHTS = [0.31, 0.24, 0.2, 0.15, 0.1];
export const ROUTES = ['/v1/orders', '/v1/portfolio', '/v1/sip', '/v1/assistant/chat', '/v1/auth/otp', '/v1/mandates', '/v1/redemptions', '/v1/kyc'] as const;
const ROUTE_WEIGHTS = [0.14, 0.38, 0.08, 0.1, 0.06, 0.03, 0.03, 0.03];
export const SYMBOLS = ['SAHYPOWER', 'INDVLFIN', 'DECCANAUTO', 'GOMTICHEM', 'MERIDNBANK', 'KVRTEXT', 'NSTARINFRA', 'PALASHPHARMA', 'TUNGAFOODS', 'VEDHIKSTEEL'];
export const SCHEMES = ['Kaveri Bluechip Fund - Direct Growth', 'Northstar Flexi Cap - Direct', 'Sahyadri Midcap Opportunities - Direct', 'Gomti Liquid Fund - Direct', 'Indus Valley ELSS Tax Saver - Direct', 'Meridian Nifty Index - Direct', 'Deccan Small Cap - Direct', 'Palash Corporate Bond - Direct'];
const REGIONS = ['mum-a', 'mum-b', 'hyd-a'];

const id8 = (r: Rng) => r.hex(8);
const ms = (r: Rng, a: number, b: number) => Math.round(r.range(a, b));
const tr = (r: Rng) => ({ trace_id: r.hex(16), region: r.pick(REGIONS) });
const pickW = <T,>(r: Rng, xs: readonly T[], ws: number[]) => r.weighted(xs.map((x, i) => [x, ws[i]!] as const));

function std(rps: number, errPct: number, p50: number, p95: number, labels?: { rate?: LabelSpec; err?: LabelSpec; p95?: LabelSpec }): MetricDef[] {
  return [
    { name: 'request_rate', unit: 'req/s', description: 'Requests handled per second', kind: 'rate', base: rps, labels: labels?.rate },
    { name: 'error_rate', unit: '%', description: 'Share of requests that failed (5xx or internal error)', kind: 'pct_error', base: errPct, labels: labels?.err },
    { name: 'latency_p50_ms', unit: 'ms', description: 'Median request latency', kind: 'latency', base: p50, load: 0.15 },
    { name: 'latency_p95_ms', unit: 'ms', description: '95th percentile request latency', kind: 'latency', base: p95, load: 0.25, labels: labels?.p95 },
  ];
}

const bankLabel: LabelSpec = { key: 'bank', values: [...BANKS], weights: BANK_WEIGHTS };
const routeLabel: LabelSpec = { key: 'route', values: [...ROUTES], weights: ROUTE_WEIGHTS };

export const SERVICES: ServiceDef[] = [
  {
    id: 'api-gateway', name: 'API Gateway', kind: 'internal', team: 'platform', tier: 1, profile: 'investor', version: '3.18.2', logDensity: 6, logTz: 'utc',
    description: 'Front door for the mobile and web apps; routes requests to backend services.',
    metrics: std(1800, 0.3, 45, 220, { rate: routeLabel, err: routeLabel }),
    logs: [
      { sev: 'INFO', w: 80, msg: (r) => { const route = pickW(r, ROUTES, ROUTE_WEIGHTS); return `GET ${route} 200`; }, fields: (r) => ({ ...tr(r), route: pickW(r, ROUTES, ROUTE_WEIGHTS), status: 200, latency_ms: ms(r, 15, 260) }) },
      { sev: 'WARN', w: 4, msg: (r) => `upstream slow on ${r.pick(ROUTES)}: ${ms(r, 900, 2400)}ms`, fields: (r) => ({ ...tr(r), route: r.pick(ROUTES) }) },
      { sev: 'ERROR', w: 1.2, msg: () => 'client closed connection before response (499)', fields: (r) => ({ ...tr(r), route: r.pick(ROUTES), status: 499 }) },
      { sev: 'ERROR', w: 0.3, msg: () => 'rejected request: JWT signature invalid', fields: (r) => ({ ...tr(r), status: 401 }) },
    ],
  },
  {
    id: 'auth-service', name: 'Auth Service', kind: 'internal', team: 'identity', tier: 1, profile: 'daytime', version: '2.9.4', logDensity: 2, logTz: 'utc',
    description: 'OTP login and session management. Sends OTPs through notification-service and the SMS provider.',
    metrics: [
      ...std(40, 0.5, 60, 300),
      { name: 'otp_success_rate', unit: '%', description: 'OTP logins that completed successfully', kind: 'pct_success', base: 97.4 },
      { name: 'otp_sent_per_min', unit: 'count/min', description: 'OTPs requested per minute', kind: 'count', base: 900 },
    ],
    logs: [
      { sev: 'INFO', w: 40, msg: (r) => `OTP sent for session s_${id8(r)} via notification-service`, fields: (r) => ({ ...tr(r), route: '/v1/auth/otp' }) },
      { sev: 'INFO', w: 38, msg: (r) => `OTP verified for session s_${id8(r)}`, fields: (r) => ({ ...tr(r), route: '/v1/auth/otp', status: 200 }) },
      { sev: 'WARN', w: 5, msg: (r) => `OTP verification failed for session s_${id8(r)}: code mismatch (attempt ${r.int(1, 3)}/3)`, fields: (r) => ({ ...tr(r), status: 401 }) },
      { sev: 'ERROR', w: 0.8, msg: (r) => `device fingerprint mismatch for session s_${id8(r)}; forcing re-login`, fields: (r) => ({ ...tr(r), status: 403 }) },
    ],
  },
  {
    id: 'order-service', name: 'Order Service', kind: 'internal', team: 'trading', tier: 1, profile: 'market', version: '5.4.1', logDensity: 5, logTz: 'utc',
    description: 'Accepts stock orders, runs risk checks and hands orders to broker-connector.',
    metrics: [
      ...std(220, 0.4, 80, 350),
      { name: 'order_success_rate', unit: '%', description: 'Orders accepted by the broker', kind: 'pct_success', base: 99.2 },
      { name: 'orders_per_min', unit: 'count/min', description: 'Orders submitted per minute', kind: 'count', base: 9000 },
      { name: 'cpu_utilization', unit: '%', description: 'Average CPU across order-service pods', kind: 'gauge', base: 34, load: 0.45 },
      { name: 'db_pool_in_use', unit: 'connections', description: 'Database connections checked out from the pool', kind: 'gauge', base: 18, load: 0.6 },
      { name: 'db_pool_wait_ms', unit: 'ms', description: 'Time requests wait for a pooled DB connection (p95)', kind: 'latency', base: 3, load: 0.3 },
    ],
    logs: [
      { sev: 'INFO', w: 45, msg: (r) => `order OR-${r.int(100000, 999999)} placed: ${r.pick(['BUY', 'SELL'])} ${r.int(1, 200)} ${r.pick(SYMBOLS)} ${r.pick(['MARKET', 'LIMIT'])}`, fields: (r) => ({ ...tr(r), route: '/v1/orders', status: 201 }) },
      { sev: 'INFO', w: 40, msg: (r) => `order OR-${r.int(100000, 999999)} acknowledged by broker in ${ms(r, 30, 180)}ms`, fields: (r) => ({ ...tr(r), provider: 'broker-api' }) },
      { sev: 'WARN', w: 6, msg: (r) => `order OR-${r.int(100000, 999999)} rejected by risk check: insufficient margin`, fields: (r) => ({ ...tr(r), status: 422 }) },
      { sev: 'ERROR', w: 0.6, msg: () => 'failed to publish order event to message-queue; will retry', fields: (r) => tr(r) },
    ],
  },
  {
    id: 'broker-connector', name: 'Broker Connector', kind: 'internal', team: 'trading', tier: 1, profile: 'market', version: '1.22.0', logDensity: 4, logTz: 'utc',
    description: 'Adapter to the external broker/exchange API (orders, quotes, holdings).',
    metrics: [
      ...std(200, 0.2, 40, 160),
      { name: 'upstream_latency_p95_ms', unit: 'ms', description: 'p95 latency of calls to broker-api', kind: 'latency', base: 140, load: 0.2, labels: { key: 'endpoint', values: ['orders', 'quotes', 'holdings'], weights: [0.45, 0.4, 0.15] } },
      { name: 'rate_limited_count', unit: 'count/min', description: 'HTTP 429 responses received from broker-api', kind: 'count', base: 0.2, labels: { key: 'endpoint', values: ['orders', 'quotes', 'holdings'], weights: [0.45, 0.4, 0.15] } },
      { name: 'retry_count', unit: 'count/min', description: 'Retried calls to broker-api', kind: 'count', base: 2 },
    ],
    logs: [
      { sev: 'INFO', w: 50, msg: (r) => `POST /orders -> 200 in ${ms(r, 25, 160)}ms`, fields: (r) => ({ ...tr(r), provider: 'broker-api', endpoint: 'orders', status: 200 }) },
      { sev: 'INFO', w: 30, msg: (r) => `quote snapshot refreshed for ${r.int(200, 900)} symbols`, fields: (r) => ({ ...tr(r), provider: 'broker-api', endpoint: 'quotes' }) },
      { sev: 'WARN', w: 3, msg: (r) => `broker-api responded slowly: ${ms(r, 600, 1500)}ms on /holdings`, fields: (r) => ({ ...tr(r), provider: 'broker-api', endpoint: 'holdings' }) },
      { sev: 'ERROR', w: 0.5, msg: () => 'broker-api returned 500 on /quotes; served cached snapshot', fields: (r) => ({ ...tr(r), provider: 'broker-api', endpoint: 'quotes', status: 500 }) },
    ],
  },
  {
    id: 'mf-order-service', name: 'Mutual Fund Order Service', kind: 'internal', team: 'mutual-funds', tier: 1, profile: 'daytime', version: '4.0.7', logDensity: 2, logTz: 'utc',
    description: 'Mutual fund purchases, redemptions requests and SIP instalment orders (to the RTA).',
    metrics: [
      ...std(35, 0.3, 90, 400),
      { name: 'mf_orders_per_min', unit: 'count/min', description: 'Fund orders created per minute', kind: 'count', base: 600 },
      { name: 'order_success_rate', unit: '%', description: 'Fund orders accepted by the RTA', kind: 'pct_success', base: 99.5 },
    ],
    logs: [
      { sev: 'INFO', w: 45, msg: (r) => `SIP instalment order created for folio F-${r.int(10000000, 99999999)} scheme "${r.pick(SCHEMES)}"`, fields: (r) => ({ ...tr(r), route: '/v1/sip' }) },
      { sev: 'INFO', w: 40, msg: (r) => `lumpsum purchase MF-${r.int(100000, 999999)} submitted to RTA`, fields: (r) => tr(r) },
      { sev: 'WARN', w: 4, msg: (r) => `scheme "${r.pick(SCHEMES)}" cut-off passed; order queued for next NAV date`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 0.5, msg: () => 'RTA acknowledgement parse error; retrying', fields: (r) => tr(r) },
    ],
  },
  {
    id: 'mandate-service', name: 'Mandate Service', kind: 'internal', team: 'payments', tier: 1, profile: 'daytime', version: '2.3.0', logDensity: 1.5, logTz: 'ist_offset',
    description: 'UPI autopay and e-mandate registration through NPCI and the banks.',
    metrics: [
      ...std(6, 1.0, 300, 1800),
      { name: 'mandate_success_rate', unit: '%', description: 'Mandate registrations approved', kind: 'pct_success', base: 96.6, labels: bankLabel },
      { name: 'mandate_requests_per_min', unit: 'count/min', description: 'Mandate registrations started per minute', kind: 'count', base: 140, labels: bankLabel },
    ],
    logs: [
      { sev: 'INFO', w: 40, msg: (r) => `mandate MD-${r.int(1000000, 9999999)} submitted to npci`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), provider: 'npci' }) },
      { sev: 'INFO', w: 38, msg: (r) => `mandate MD-${r.int(1000000, 9999999)} approved in ${ms(r, 400, 2600)}ms`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), status: 'approved' }) },
      { sev: 'WARN', w: 8, msg: (r) => `mandate MD-${r.int(1000000, 9999999)} pending user authorisation in bank app`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS) }) },
      { sev: 'ERROR', w: 2, msg: (r) => `mandate MD-${r.int(1000000, 9999999)} rejected: account holder name mismatch`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), error_code: 'NAME_MISMATCH' }) },
    ],
  },
  {
    id: 'payment-service', name: 'Payment Service', kind: 'internal', team: 'payments', tier: 1, profile: 'daytime', version: '6.1.3', logDensity: 2, logTz: 'utc',
    description: 'UPI collect and payment capture for lumpsum purchases.',
    metrics: [...std(50, 0.4, 120, 600), { name: 'payment_success_rate', unit: '%', description: 'Payments captured successfully', kind: 'pct_success', base: 98.9 }],
    logs: [
      { sev: 'INFO', w: 60, msg: (r) => `payment PY-${r.int(1000000, 9999999)} captured via UPI in ${ms(r, 300, 2500)}ms`, fields: (r) => ({ ...tr(r), provider: 'npci' }) },
      { sev: 'WARN', w: 6, msg: (r) => `payment PY-${r.int(1000000, 9999999)} pending: awaiting bank confirmation`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 1.5, msg: (r) => `payment PY-${r.int(1000000, 9999999)} failed: user declined collect request`, fields: (r) => ({ ...tr(r), error_code: 'U30' }) },
    ],
  },
  {
    id: 'debit-worker', name: 'Debit Worker', kind: 'internal', team: 'payments', tier: 1, profile: 'sip_batch', version: '3.7.2', logDensity: 3, logTz: 'ist_offset',
    description: 'Collects SIP instalments by presenting debits against mandates through bank-connector. Runs in early-morning batches.',
    metrics: [
      ...std(40, 0.6, 900, 2600),
      { name: 'debit_count', unit: 'count/min', description: 'Debit requests presented to banks per minute', kind: 'count', base: 1200, labels: bankLabel },
      { name: 'debit_success_rate', unit: '%', description: 'Debits confirmed by the bank', kind: 'pct_success', base: 98.4, labels: bankLabel },
      { name: 'retry_count', unit: 'count/min', description: 'Debit submissions retried after no confirmation', kind: 'count', base: 6, labels: bankLabel },
    ],
    logs: [
      { sev: 'INFO', w: 45, msg: (r) => `debit DB-${r.int(10000000, 99999999)} for mandate MD-${r.int(1000000, 9999999)} submitted amount=INR ${r.pick([500, 1000, 2000, 2500, 5000, 10000])}`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), attempt: 1 }) },
      { sev: 'INFO', w: 42, msg: (r) => `debit DB-${r.int(10000000, 99999999)} confirmed by bank in ${ms(r, 500, 2400)}ms`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS) }) },
      { sev: 'WARN', w: 3, msg: (r) => `debit DB-${r.int(10000000, 99999999)} confirmation slow (${ms(r, 3000, 5000)}ms)`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS) }) },
      { sev: 'ERROR', w: 1.5, msg: (r) => `debit DB-${r.int(10000000, 99999999)} failed: insufficient funds`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), error_code: 'INSUFFICIENT_FUNDS' }) },
    ],
  },
  {
    id: 'bank-connector', name: 'Bank Connector', kind: 'internal', team: 'payments', tier: 1, profile: 'sip_batch', version: '2.12.5', logDensity: 3, logTz: 'ist_offset',
    description: 'Adapter to partner bank APIs for debits, mandate checks and payouts.',
    metrics: [
      ...std(60, 0.5, 700, 2400),
      { name: 'bank_latency_p95_ms', unit: 'ms', description: 'p95 latency of bank API calls', kind: 'latency', base: 2300, load: 0.2, labels: bankLabel },
      { name: 'bank_error_rate', unit: '%', description: 'Bank API calls returning errors', kind: 'pct_error', base: 0.7, labels: bankLabel },
      { name: 'timeout_count', unit: 'count/min', description: 'Bank API calls abandoned at the client timeout', kind: 'count', base: 1.5, labels: bankLabel },
    ],
    logs: [
      { sev: 'INFO', w: 60, msg: (r) => `POST /debits -> 200 in ${ms(r, 400, 2500)}ms`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), provider: 'bank-apis', status: 200 }) },
      { sev: 'WARN', w: 4, msg: (r) => `bank responded in ${ms(r, 3000, 4500)}ms (p95 budget 3000ms)`, fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), provider: 'bank-apis' }) },
      { sev: 'ERROR', w: 0.6, msg: () => 'bank returned 503 Service Unavailable; will retry', fields: (r) => ({ ...tr(r), bank: pickW(r, BANKS, BANK_WEIGHTS), provider: 'bank-apis', status: 503 }) },
    ],
  },
  {
    id: 'portfolio-service', name: 'Portfolio Service', kind: 'internal', team: 'portfolio', tier: 1, profile: 'investor', version: '7.2.0', logDensity: 5, logTz: 'utc',
    description: 'Holdings, current values and P&L. Prices come from market-data-service (stock prices and fund NAVs).',
    metrics: [
      ...std(900, 0.2, 35, 140),
      { name: 'valuation_errors', unit: 'count/min', description: 'Valuations that failed and fell back to last snapshot', kind: 'count', base: 1 },
      { name: 'displayed_value_total_cr', unit: 'INR crore', description: 'Sum of portfolio values shown to users (sampled)', kind: 'gauge', base: 4850, noise: 0.004 },
      { name: 'price_age_s', unit: 's', description: 'Age of the stock prices used in valuations', kind: 'gauge', base: 2, noise: 0.3 },
    ],
    logs: [
      { sev: 'INFO', w: 55, msg: (r) => `valuation computed: ${r.int(2, 40)} holdings in ${ms(r, 12, 120)}ms`, fields: (r) => ({ ...tr(r), route: '/v1/portfolio' }) },
      { sev: 'INFO', w: 30, msg: () => 'holdings snapshot served from cache', fields: (r) => ({ ...tr(r), route: '/v1/portfolio' }) },
      { sev: 'WARN', w: 3, msg: (r) => `price missing for ${r.pick(SYMBOLS)}; using last close`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 0.6, msg: (r) => `failed to load corporate actions for ${r.pick(SYMBOLS)}: not found`, fields: (r) => tr(r) },
    ],
  },
  {
    id: 'market-data-service', name: 'Market Data Service', kind: 'internal', team: 'market-data', tier: 1, profile: 'flat', version: '3.3.9', logDensity: 3, logTz: 'utc',
    description: 'Live stock prices from the broker feed and daily fund NAVs imported from the AMFI feed by a nightly job.',
    metrics: [
      ...std(300, 0.1, 8, 30),
      { name: 'nav_age_s', unit: 's', description: 'Age of the newest fund NAV set being served', kind: 'age', base: 0 },
      { name: 'price_feed_lag_ms', unit: 'ms', description: 'Delay between exchange tick and our price update', kind: 'latency', base: 450, load: 0.3 },
    ],
    logs: [
      { sev: 'INFO', w: 50, msg: (r) => `price tick batch processed: ${r.int(300, 1800)} symbols, lag ${ms(r, 200, 900)}ms`, fields: (r) => ({ ...tr(r), provider: 'broker-api' }) },
      { sev: 'INFO', w: 25, msg: (r) => `NAV lookup served for "${r.pick(SCHEMES)}"`, fields: (r) => tr(r) },
      { sev: 'WARN', w: 2, msg: (r) => `price feed reconnecting (attempt ${r.int(1, 3)})`, fields: (r) => ({ ...tr(r), provider: 'broker-api' }) },
      { sev: 'ERROR', w: 0.4, msg: (r) => `symbol ${r.pick(SYMBOLS)}-BE not found in security master`, fields: (r) => tr(r) },
    ],
  },
  {
    id: 'payout-service', name: 'Payout Service', kind: 'internal', team: 'payments', tier: 1, profile: 'payout_batch', version: '2.6.1', logDensity: 2, logTz: 'utc',
    description: 'Sends redemption proceeds to users\' bank accounts in scheduled batches (10:00 and 14:00 IST).',
    metrics: [
      ...std(5, 0.5, 200, 900),
      { name: 'payouts_pending', unit: 'count', description: 'Redemptions waiting for payout', kind: 'gauge', base: 220, noise: 0.05 },
      { name: 'payouts_completed_per_min', unit: 'count/min', description: 'Payouts sent per minute', kind: 'count', base: 60 },
      { name: 'batch_duration_s', unit: 's', description: 'Duration of the most recent payout batch', kind: 'gauge', base: 840, noise: 0.05 },
    ],
    logs: [
      { sev: 'INFO', w: 50, msg: (r) => `payout PO-${r.int(1000000, 9999999)} initiated to account ****${r.int(1000, 9999)} amount INR ${r.int(500, 250000)}`, fields: (r) => ({ ...tr(r), provider: 'bank-apis' }) },
      { sev: 'WARN', w: 4, msg: (r) => `payout PO-${r.int(1000000, 9999999)} held for manual review: name mismatch`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 1, msg: (r) => `payout PO-${r.int(1000000, 9999999)} failed: beneficiary account closed`, fields: (r) => ({ ...tr(r), error_code: 'ACCOUNT_CLOSED' }) },
    ],
  },
  {
    id: 'kyc-service', name: 'KYC Service', kind: 'internal', team: 'identity', tier: 2, profile: 'daytime', version: '1.15.3', logDensity: 1.5, logTz: 'utc',
    description: 'Submits KYC to the KYC registration agency and receives status updates via webhook.',
    metrics: [
      ...std(12, 0.4, 150, 700),
      { name: 'kyc_pending_count', unit: 'count', description: 'KYC applications waiting for an agency decision', kind: 'gauge', base: 340, noise: 0.03 },
      { name: 'webhook_received_per_min', unit: 'count/min', description: 'Status webhooks received from the KYC agency', kind: 'count', base: 80 },
      { name: 'webhook_errors', unit: 'count/min', description: 'Webhook deliveries we failed to process', kind: 'count', base: 0.4 },
      { name: 'agency_latency_p95_ms', unit: 'ms', description: 'p95 latency of KYC agency API calls', kind: 'latency', base: 1800, load: 0.1 },
    ],
    logs: [
      { sev: 'INFO', w: 40, msg: (r) => `KYC KY-${r.int(100000, 999999)} submitted to kyc-agency`, fields: (r) => ({ ...tr(r), provider: 'kyc-agency' }) },
      { sev: 'INFO', w: 40, msg: (r) => `KYC KY-${r.int(100000, 999999)} status webhook processed: ${r.pick(['verified', 'verified', 'verified', 'on_hold'])}`, fields: (r) => ({ ...tr(r), route: '/hooks/kyc', status: 200 }) },
      { sev: 'WARN', w: 5, msg: (r) => `KYC KY-${r.int(100000, 999999)} documents unclear; requested re-upload`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 0.8, msg: (r) => `KYC KY-${r.int(100000, 999999)} PAN-Aadhaar link check failed`, fields: (r) => ({ ...tr(r), error_code: 'PAN_NOT_LINKED' }) },
    ],
  },
  {
    id: 'notification-service', name: 'Notification Service', kind: 'internal', team: 'platform', tier: 2, profile: 'daytime', version: '4.4.0', logDensity: 3, logTz: 'utc',
    description: 'Sends SMS (through the SMS provider), push notifications and email.',
    metrics: [
      ...std(300, 0.3, 25, 120),
      { name: 'sms_send_failures', unit: 'count/min', description: 'SMS sends rejected or failed at the provider', kind: 'count', base: 3 },
      { name: 'push_send_failures', unit: 'count/min', description: 'Push notifications that failed', kind: 'count', base: 5 },
    ],
    logs: [
      { sev: 'INFO', w: 45, msg: (r) => `push sent to device d_${id8(r)} (template=${r.pick(['order_filled', 'sip_reminder', 'price_alert', 'nav_update'])})`, fields: (r) => tr(r) },
      { sev: 'INFO', w: 35, msg: (r) => `sms accepted by sms-provider (template=${r.pick(['otp', 'sip_debit', 'payout_sent'])})`, fields: (r) => ({ ...tr(r), provider: 'sms-provider' }) },
      { sev: 'WARN', w: 4, msg: (r) => `push token expired for device d_${id8(r)}; removing`, fields: (r) => tr(r) },
      { sev: 'ERROR', w: 1, msg: () => 'email bounced: mailbox unavailable', fields: (r) => tr(r) },
    ],
  },
  {
    id: 'assistant-orchestrator', name: 'Assistant Orchestrator', kind: 'internal', team: 'assistant', tier: 1, profile: 'assistant', version: '0.42.0', logDensity: 4, logTz: 'utc',
    description: 'Runs each assistant conversation: gathers user context, retrieves documents, calls the LLM provider and passes answers through the compliance filter.',
    metrics: [
      ...std(25, 0.5, 2400, 6500),
      { name: 'llm_latency_p95_ms', unit: 'ms', description: 'p95 latency of LLM provider calls', kind: 'latency', base: 5200, load: 0.15 },
      { name: 'llm_tokens_per_min', unit: 'tokens/min', description: 'LLM tokens consumed per minute', kind: 'count', base: 240000 },
      { name: 'rate_limited_count', unit: 'count/min', description: 'HTTP 429 responses from the LLM provider', kind: 'count', base: 0.1 },
      { name: 'retry_count', unit: 'count/min', description: 'Retried LLM calls', kind: 'count', base: 1 },
    ],
    logs: [
      { sev: 'INFO', w: 45, msg: (r) => `conversation c_${id8(r)} turn ${r.int(1, 6)} answered in ${ms(r, 1200, 6000)}ms (tokens in=${r.int(1500, 6000)} out=${r.int(80, 600)})`, fields: (r) => ({ ...tr(r), provider: 'llm-provider', model: 'lumen-large-2026-08' }) },
      { sev: 'INFO', w: 35, msg: (r) => `retrieved ${r.int(3, 8)} passages from knowledge-index in ${ms(r, 20, 90)}ms`, fields: (r) => tr(r) },
      { sev: 'WARN', w: 3, msg: (r) => `response truncated at max tokens for c_${id8(r)}`, fields: (r) => ({ ...tr(r), provider: 'llm-provider' }) },
      { sev: 'ERROR', w: 0.6, msg: () => 'tool-call arguments failed schema validation; regenerating turn', fields: (r) => ({ ...tr(r), provider: 'llm-provider' }) },
    ],
  },
  {
    id: 'knowledge-index', name: 'Knowledge Index', kind: 'internal', team: 'assistant', tier: 2, profile: 'assistant', version: '1.8.0', logDensity: 2, logTz: 'utc',
    description: 'Search index over fund factsheets and help articles used by the assistant.',
    metrics: [
      ...std(60, 0.1, 25, 85),
      { name: 'index_version', unit: 'build', description: 'Build number of the index currently serving', kind: 'constant', base: 4120 },
      { name: 'docs_count', unit: 'count', description: 'Documents in the serving index', kind: 'constant', base: 18450 },
    ],
    logs: [
      { sev: 'INFO', w: 70, msg: (r) => `search q_${r.hex(10)} returned ${r.int(0, 12)} hits in ${ms(r, 8, 80)}ms`, fields: (r) => tr(r) },
      { sev: 'WARN', w: 2, msg: (r) => `slow search ${ms(r, 300, 700)}ms for q_${r.hex(10)}`, fields: (r) => tr(r) },
    ],
  },
  {
    id: 'indexing-pipeline', name: 'Indexing Pipeline', kind: 'internal', team: 'assistant', tier: 3, profile: 'flat', version: '0.19.4', logDensity: 0.6, logTz: 'utc',
    description: 'Ingests fund factsheets and help articles into the knowledge index.',
    metrics: [
      { name: 'docs_ingested_per_min', unit: 'count/min', description: 'Documents ingested into index builds', kind: 'count', base: 4 },
      { name: 'ingest_errors', unit: 'count/min', description: 'Documents that failed ingestion', kind: 'count', base: 0.05 },
      { name: 'queue_lag_s', unit: 's', description: 'Age of the oldest document waiting to be ingested', kind: 'gauge', base: 30, noise: 0.3 },
    ],
    logs: [
      { sev: 'INFO', w: 60, msg: (r) => `ingested document ${r.pick(['help', 'factsheet', 'faq'])}/${r.hex(6)} into build ${r.int(4100, 4120)}`, fields: (r) => tr(r) },
      { sev: 'INFO', w: 20, msg: (r) => `document ${r.pick(['help', 'faq'])}/${r.hex(6)} unchanged since last run; skipped`, fields: (r) => tr(r) },
    ],
  },
  {
    id: 'user-context-service', name: 'User Context Service', kind: 'internal', team: 'assistant', tier: 2, profile: 'assistant', version: '1.4.2', logDensity: 2, logTz: 'utc',
    description: 'Builds the user\'s holdings/SIP context for personal assistant answers (reads portfolio-service, cached).',
    metrics: [
      ...std(30, 0.3, 40, 180),
      { name: 'missing_context_rate', unit: '%', description: 'Assistant turns answered without user context', kind: 'pct_error', base: 0.8 },
      { name: 'timeout_count', unit: 'count/min', description: 'Context builds that hit the timeout', kind: 'count', base: 0.4 },
    ],
    logs: [
      { sev: 'INFO', w: 60, msg: (r) => `context built: ${r.int(0, 30)} holdings, ${r.int(0, 6)} SIPs in ${ms(r, 15, 160)}ms`, fields: (r) => tr(r) },
      { sev: 'INFO', w: 25, msg: () => 'context served from cache', fields: (r) => tr(r) },
      { sev: 'WARN', w: 3, msg: (r) => `holdings fetch slow (${ms(r, 400, 900)}ms)`, fields: (r) => tr(r) },
    ],
  },
  {
    id: 'compliance-filter', name: 'Compliance Filter', kind: 'internal', team: 'assistant', tier: 1, profile: 'assistant', version: '2.1.0', logDensity: 2, logTz: 'utc',
    description: 'Checks assistant answers and blocks direct buy/sell advice (not allowed without an investment-advisory licence).',
    metrics: [
      ...std(30, 0.1, 30, 110),
      { name: 'block_rate', unit: '%', description: 'Assistant answers blocked or rewritten as advice', kind: 'pct_error', base: 1.9 },
    ],
    logs: [
      { sev: 'INFO', w: 80, msg: () => 'answer checked: pass', fields: (r) => ({ ...tr(r), version: 'rules-v31' }) },
      { sev: 'INFO', w: 2, msg: () => 'answer blocked: direct buy/sell recommendation', fields: (r) => ({ ...tr(r), error_code: 'ADVICE_BLOCKED' }) },
    ],
  },
  {
    id: 'cache', name: 'Cache Cluster', kind: 'internal', team: 'platform', tier: 1, profile: 'flat', version: '7.2.4', logDensity: 0.8, logTz: 'utc',
    description: 'Shared in-memory cache (sessions, user context, NAVs, prices, factsheets).',
    metrics: [
      { name: 'request_rate', unit: 'ops/s', description: 'Cache operations per second', kind: 'rate', base: 9000 },
      { name: 'latency_p95_ms', unit: 'ms', description: 'p95 command latency', kind: 'latency', base: 1.2, load: 0.1 },
      { name: 'cache_hit_rate', unit: '%', description: 'Reads served from cache', kind: 'pct_success', base: 94, labels: { key: 'keyspace', values: ['sessions', 'user_context', 'nav', 'prices', 'factsheets'], weights: [0.3, 0.15, 0.15, 0.3, 0.1] } },
      { name: 'evictions_per_min', unit: 'count/min', description: 'Keys evicted under memory pressure', kind: 'count', base: 40 },
      { name: 'memory_used_pct', unit: '%', description: 'Memory used', kind: 'gauge', base: 62, noise: 0.01 },
    ],
    logs: [
      { sev: 'INFO', w: 50, msg: (r) => `evicted ${r.int(20, 400)} keys (policy=allkeys-lru)`, fields: () => ({}) },
      { sev: 'WARN', w: 3, msg: (r) => `slow command GET ${ms(r, 12, 40)}ms`, fields: () => ({}) },
    ],
  },
  {
    id: 'database', name: 'Primary Database', kind: 'internal', team: 'platform', tier: 1, profile: 'flat', version: '16.4', logDensity: 1, logTz: 'utc',
    description: 'Primary relational database (orders, folios, payouts, mandates).',
    metrics: [
      { name: 'request_rate', unit: 'queries/s', description: 'Queries per second', kind: 'rate', base: 4200 },
      { name: 'db_lock_wait_ms', unit: 'ms', description: 'p95 time queries wait for locks', kind: 'latency', base: 4, load: 0.2 },
      { name: 'active_connections', unit: 'connections', description: 'Open client connections', kind: 'gauge', base: 180, load: 0.5 },
      { name: 'cpu_utilization', unit: '%', description: 'Database CPU', kind: 'gauge', base: 38, load: 0.6 },
      { name: 'slow_queries_per_min', unit: 'count/min', description: 'Queries slower than 1 s', kind: 'count', base: 3 },
    ],
    logs: [
      { sev: 'INFO', w: 40, msg: (r) => `checkpoint complete: wrote ${r.int(800, 9000)} buffers`, fields: () => ({}) },
      { sev: 'WARN', w: 8, msg: (r) => `slow query ${ms(r, 1000, 2600)}ms: SELECT ... FROM ${r.pick(['orders', 'folios', 'sip_schedules', 'holdings'])}`, fields: () => ({}) },
      { sev: 'ERROR', w: 0.8, msg: () => 'canceling statement due to user request', fields: () => ({}) },
    ],
  },
  {
    id: 'job-scheduler', name: 'Job Scheduler', kind: 'internal', team: 'platform', tier: 2, profile: 'nightly', version: '1.6.0', logDensity: 0.3, logTz: 'utc',
    description: 'Runs scheduled jobs (NAV import, SIP debit batch, payout batches, reconciliation, factsheet sync).',
    metrics: [
      { name: 'jobs_running', unit: 'count', description: 'Scheduled jobs currently running', kind: 'gauge', base: 0, noise: 0 },
      { name: 'jobs_failed', unit: 'count/min', description: 'Scheduled job runs that ended in failure', kind: 'count', base: 0 },
    ],
    logs: [{ sev: 'INFO', w: 1, msg: () => 'heartbeat ok', fields: () => ({}) }],
  },
  {
    id: 'message-queue', name: 'Message Queue', kind: 'internal', team: 'platform', tier: 1, profile: 'flat', version: '3.7.1', logDensity: 0.4, logTz: 'utc',
    description: 'Async messaging between services (orders, notifications, debits, KYC webhooks, indexing).',
    metrics: [
      { name: 'queue_depth', unit: 'messages', description: 'Messages waiting', kind: 'gauge', base: 120, noise: 0.2, labels: { key: 'queue', values: ['orders', 'notifications', 'debits', 'kyc_webhooks', 'indexing'], weights: [0.3, 0.3, 0.2, 0.1, 0.1] } },
      { name: 'consumer_lag_s', unit: 's', description: 'Age of the oldest unconsumed message', kind: 'gauge', base: 2, noise: 0.3 },
    ],
    logs: [{ sev: 'INFO', w: 1, msg: (r) => `consumer group ${r.pick(['notif-workers', 'order-events', 'kyc-hooks'])} rebalanced`, fields: () => ({}) }],
  },
  // ------------------------------------------------------------------ external partners
  ...(
    [
      ['llm-provider', 'LLM Provider', 'Hosted large-language-model API used by the assistant.'],
      ['bank-apis', 'Partner Bank APIs', 'Partner banks\' debit, mandate and payout APIs.'],
      ['npci', 'NPCI', 'UPI and e-mandate network.'],
      ['broker-api', 'Broker / Exchange API', 'Broker and exchange order, quote and holdings API.'],
      ['amfi-nav-feed', 'AMFI NAV Feed', 'Daily mutual fund NAV publication.'],
      ['kyc-agency', 'KYC Registration Agency', 'Verifies KYC applications and sends status webhooks.'],
      ['sms-provider', 'SMS Provider', 'Delivers OTP and transactional SMS.'],
    ] as const
  ).map(
    ([id, name, description]): ServiceDef => ({
      id, name, kind: 'external', team: 'external', tier: 1, profile: 'flat', version: 'n/a', logDensity: 0, logTz: 'utc',
      description: `${description} External: observed only through our connectors' metrics and logs.`,
      metrics: [], logs: [],
    }),
  ),
];

const e = (from: string, to: string, kind: DependencyEdge['kind'], critical: boolean, timeoutMs: number | null = null, retries: number | null = null, notes: string | null = null): DependencyEdge =>
  ({ from, to, kind, critical, timeoutMs, retries, notes });

export function baseDependencies(): DependencyEdge[] {
  return [
    e('api-gateway', 'auth-service', 'sync', true, 2000, 1),
    e('api-gateway', 'order-service', 'sync', true, 3000, 0),
    e('api-gateway', 'portfolio-service', 'sync', true, 2000, 1),
    e('api-gateway', 'mf-order-service', 'sync', true, 3000, 0),
    e('api-gateway', 'mandate-service', 'sync', true, 5000, 0),
    e('api-gateway', 'payout-service', 'sync', false, 3000, 0),
    e('api-gateway', 'kyc-service', 'sync', false, 3000, 0),
    e('api-gateway', 'assistant-orchestrator', 'sync', true, 30000, 0),
    e('auth-service', 'notification-service', 'async', true),
    e('auth-service', 'cache', 'cache', true, 50, 1),
    e('auth-service', 'database', 'datastore', true, 1000, 0),
    e('notification-service', 'sms-provider', 'external_api', true, 4000, 2),
    e('notification-service', 'message-queue', 'async', true),
    e('order-service', 'broker-connector', 'sync', true, 2000, 0),
    e('order-service', 'database', 'datastore', true, 1000, 0, 'connection pool: max 100'),
    e('order-service', 'message-queue', 'async', false),
    e('broker-connector', 'broker-api', 'external_api', true, 1500, 1, 'broker enforces a per-second order rate limit'),
    e('mf-order-service', 'database', 'datastore', true, 1000, 0),
    e('mf-order-service', 'mandate-service', 'sync', false, 3000, 0),
    e('mandate-service', 'npci', 'external_api', true, 8000, 1),
    e('mandate-service', 'bank-connector', 'sync', true, 8000, 0),
    e('mandate-service', 'database', 'datastore', true, 1000, 0),
    e('payment-service', 'npci', 'external_api', true, 10000, 0),
    e('payment-service', 'database', 'datastore', true, 1000, 0),
    e('job-scheduler', 'debit-worker', 'async', true, null, null, 'triggers sip-debit-batch Mon-Fri 06:00 IST'),
    e('debit-worker', 'bank-connector', 'sync', true, 8000, 2, 'resubmits a debit if no confirmation within the timeout'),
    e('debit-worker', 'database', 'datastore', true, 1000, 0),
    e('debit-worker', 'message-queue', 'async', true),
    e('bank-connector', 'bank-apis', 'external_api', true, 8000, 0),
    e('portfolio-service', 'market-data-service', 'sync', true, 500, 1),
    e('portfolio-service', 'cache', 'cache', true, 50, 0),
    e('portfolio-service', 'database', 'datastore', true, 1000, 0),
    e('market-data-service', 'broker-api', 'external_api', true, 1000, 2, 'live price feed'),
    e('market-data-service', 'amfi-nav-feed', 'external_api', true, 30000, 3, 'NAV import job nav-import runs Mon-Fri at 23:30 IST (scheduled by job-scheduler)'),
    e('market-data-service', 'cache', 'cache', true, 50, 0),
    e('job-scheduler', 'market-data-service', 'async', true, null, null, 'triggers nav-import Mon-Fri 23:30 IST'),
    e('job-scheduler', 'payout-service', 'async', true, null, null, 'triggers payout batches Mon-Fri 10:00 and 14:00 IST'),
    e('job-scheduler', 'indexing-pipeline', 'async', false, null, null, 'triggers factsheet-sync (monthly, first business days, 07:00 IST) and index builds'),
    e('payout-service', 'bank-connector', 'sync', true, 8000, 1),
    e('payout-service', 'database', 'datastore', true, 1000, 0),
    e('kyc-service', 'kyc-agency', 'external_api', true, 5000, 1),
    e('kyc-agency', 'kyc-service', 'external_api', true, null, null, 'status webhooks to /hooks/kyc'),
    e('kyc-service', 'database', 'datastore', true, 1000, 0),
    e('kyc-service', 'message-queue', 'async', true),
    e('assistant-orchestrator', 'llm-provider', 'external_api', true, 25000, 2),
    e('assistant-orchestrator', 'knowledge-index', 'sync', true, 800, 0),
    e('assistant-orchestrator', 'user-context-service', 'sync', true, 1200, 0),
    e('assistant-orchestrator', 'compliance-filter', 'sync', true, 1000, 0),
    e('user-context-service', 'portfolio-service', 'sync', true, 1000, 0),
    e('user-context-service', 'cache', 'cache', true, 50, 0),
    e('indexing-pipeline', 'knowledge-index', 'sync', true, 10000, 2),
    e('indexing-pipeline', 'message-queue', 'async', true),
  ];
}

export function serviceDef(id: string): ServiceDef {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown service ${id}`);
  return s;
}
