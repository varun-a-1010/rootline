import { GoogleAuth, JWT } from 'google-auth-library';
import { AbortedError, sleep } from '../util/sleep.js';
import {
  LlmError,
  type Content,
  type FunctionCall,
  type GenerateRequest,
  type GenerateResponse,
  type LlmAttempt,
  type LlmErrorKind,
  type LlmProvider,
  type TokenUsage,
} from './types.js';

export interface VertexOptions {
  projectId: string;
  location: string;
  model: string;
  /** Base64 of a service-account JSON. Without it, Application Default Credentials are used. */
  serviceAccountB64?: string;
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** Per-attempt HTTP timeout. */
  requestTimeoutMs?: number;
  /** Override the access-token source (tests). */
  tokenProvider?: () => Promise<string>;
}

interface VertexResponse {
  candidates?: Array<{ content?: Content; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

/**
 * Gemini on Vertex AI, following the 3.8 Flash contract (brief §5):
 *  - no temperature/top_p/top_k/seed; reasoning via thinkingConfig.thinkingLevel
 *  - structured output via responseMimeType + responseSchema (never mixed with tools)
 *  - function calling continues by appending the model's parts verbatim
 *  - usage recorded raw; when usageMetadata is absent every count is null (unknown)
 *  - 429 and 5xx retried with bounded exponential backoff (max 3 attempts); 400 never retried
 */
export class VertexGeminiProvider implements LlmProvider {
  readonly name = 'vertex';
  readonly model: string;
  private readonly token: () => Promise<string>;
  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: VertexOptions) {
    this.model = opts.model;
    this.token = opts.tokenProvider ?? tokenSource(opts);
    const host = opts.location === 'global' ? 'aiplatform.googleapis.com' : `${opts.location}-aiplatform.googleapis.com`;
    this.url = `https://${host}/v1/projects/${opts.projectId}/locations/${opts.location}/publishers/google/models/${opts.model}:generateContent`;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 2000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    if (req.responseSchema && req.tools?.length) throw new LlmError('bad_request', 'responseSchema and tools cannot be combined');
    const body: Record<string, unknown> = {
      contents: req.contents,
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig: {
        thinkingConfig: { thinkingLevel: req.thinkingLevel.toUpperCase() },
        ...(req.responseSchema ? { responseMimeType: 'application/json', responseSchema: req.responseSchema } : {}),
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      },
      ...(req.tools?.length
        ? { tools: [{ functionDeclarations: req.tools }], toolConfig: { functionCallingConfig: { mode: req.toolMode ?? 'AUTO' } } }
        : {}),
    };
    const started = Date.now();
    let last: LlmError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (req.signal.aborted) throw new AbortedError();
      const t0 = Date.now();
      const record = (a: Omit<LlmAttempt, 'provider' | 'model' | 'role' | 'attempt' | 'latencyMs'>) =>
        req.onAttempt?.({ provider: this.name, model: this.model, role: req.role, attempt, latencyMs: Date.now() - t0, ...a });
      try {
        const token = await this.token();
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        req.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ctl.abort(), this.requestTimeoutMs);
        let res: Response;
        try {
          res = await fetch(this.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
          req.signal.removeEventListener('abort', onAbort);
        }
        if (req.signal.aborted) throw new AbortedError();
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const kind: LlmErrorKind = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server' : res.status === 401 || res.status === 403 ? 'auth' : 'bad_request';
          last = new LlmError(kind, `Vertex ${res.status}: ${summarizeError(text)}`, res.status, attempt);
          record({ status: 'error', httpStatus: res.status, errorKind: kind, usage: null, modelVersion: null });
          if (!last.retryable) throw last;
        } else {
          const json = (await res.json()) as VertexResponse;
          const parsed = parseResponse(json);
          record({ status: 'ok', httpStatus: res.status, errorKind: null, usage: parsed.usage, modelVersion: parsed.modelVersion });
          if (parsed.blocked) throw new LlmError('blocked', `response blocked: ${parsed.blocked}`, res.status, attempt);
          return { ...parsed.response, latencyMs: Date.now() - started, attempts: attempt };
        }
      } catch (e) {
        if (e instanceof AbortedError || req.signal.aborted) throw new AbortedError();
        if (e instanceof LlmError) {
          if (!e.retryable) throw e;
          last = e;
        } else {
          last = new LlmError('network', `Vertex request failed: ${(e as Error).message}`, null, attempt);
          record({ status: 'error', httpStatus: null, errorKind: 'network', usage: null, modelVersion: null });
        }
      }
      if (attempt < this.maxAttempts) await sleep(this.backoffBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), req.signal);
    }
    throw new LlmError(last?.kind ?? 'server', `${last?.message ?? 'failed'} (after ${this.maxAttempts} attempts)`, last?.httpStatus ?? null, this.maxAttempts);
  }
}

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/** Service-account JSON (base64) if given, else Application Default Credentials. */
function tokenSource(opts: VertexOptions): () => Promise<string> {
  if (opts.serviceAccountB64) {
    const sa = JSON.parse(Buffer.from(opts.serviceAccountB64, 'base64').toString('utf8')) as { client_email: string; private_key: string };
    const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES });
    return async () => {
      const t = await jwt.getAccessToken();
      if (!t.token) throw new LlmError('auth', 'could not obtain an access token from the service account');
      return t.token;
    };
  }
  const auth = new GoogleAuth({ projectId: opts.projectId, scopes: SCOPES });
  return async () => {
    const t = await auth.getAccessToken();
    if (!t) throw new LlmError('auth', 'could not obtain an access token from Application Default Credentials');
    return t;
  };
}

export function parseResponse(json: VertexResponse): {
  response: Omit<GenerateResponse, 'latencyMs' | 'attempts'>;
  usage: TokenUsage;
  modelVersion: string | null;
  blocked: string | null;
} {
  const u = json.usageMetadata;
  // Vertex omits zero-valued fields; absent metadata altogether means unknown.
  const usage: TokenUsage = u
    ? { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0 }
    : { input: null, output: null, thinking: null, cached: null };
  const cand = json.candidates?.[0];
  const modelVersion = json.modelVersion ?? null;
  if (!cand?.content) {
    return {
      response: { content: { role: 'model', parts: [] }, text: '', functionCalls: [], usage, modelVersion, finishReason: cand?.finishReason ?? null },
      usage,
      modelVersion,
      blocked: json.promptFeedback?.blockReason ?? cand?.finishReason ?? 'no candidates',
    };
  }
  const parts = cand.content.parts ?? [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const functionCalls: FunctionCall[] = parts.filter((p) => p.functionCall).map((p) => ({ ...p.functionCall!, args: p.functionCall!.args ?? {} }));
  return {
    response: { content: { role: 'model', parts }, text, functionCalls, usage, modelVersion, finishReason: cand.finishReason ?? null },
    usage,
    modelVersion,
    blocked: null,
  };
}

function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
    return `${j.error?.status ?? ''} ${j.error?.message ?? ''}`.trim().slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}
