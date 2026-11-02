/**
 * Model-layer types. Content/Part mirror Gemini's generateContent wire format, because tool
 * loops must append the model's parts verbatim (including functionCall ids and
 * thoughtSignature) to continue a turn.
 */

export interface FunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/** Gemini OpenAPI-3.0 schema subset. */
export interface GeminiSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  nullable?: boolean;
  propertyOrdering?: string[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

export type ThinkingLevel = 'low' | 'medium' | 'high';

/** Provider-reported token usage. null = unknown (never 0). */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  thinking: number | null;
  cached: number | null;
}

export interface LlmAttempt {
  provider: string;
  model: string;
  role: string;
  attempt: number;
  status: 'ok' | 'error';
  httpStatus: number | null;
  errorKind: LlmErrorKind | null;
  latencyMs: number;
  usage: TokenUsage | null;
  modelVersion: string | null;
}

export interface GenerateRequest {
  /** Agent role, for usage accounting. */
  role: string;
  system: string;
  contents: Content[];
  /** Structured output (mutually exclusive with tools). */
  responseSchema?: GeminiSchema;
  tools?: FunctionDeclaration[];
  /** ANY forces a function call every turn. */
  toolMode?: 'AUTO' | 'ANY';
  /** Restrict which declared functions may be called. Such a request misses the implicit cache. */
  allowedFunctions?: string[];
  thinkingLevel: ThinkingLevel;
  maxOutputTokens?: number;
  signal: AbortSignal;
  onAttempt?: (a: LlmAttempt) => void;
}

export interface GenerateResponse {
  /** The model's content, verbatim, to append to the conversation. */
  content: Content;
  /** Answer text (thought parts dropped). */
  text: string;
  functionCalls: FunctionCall[];
  usage: TokenUsage;
  modelVersion: string | null;
  finishReason: string | null;
  latencyMs: number;
  attempts: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export type LlmErrorKind = 'rate_limited' | 'server' | 'bad_request' | 'auth' | 'network' | 'aborted' | 'invalid_output' | 'blocked';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly attempts = 1,
  ) {
    super(message);
    this.name = 'LlmError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server' || this.kind === 'network';
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const add = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  return { input: add(a.input, b.input), output: add(a.output, b.output), thinking: add(a.thinking, b.thinking), cached: add(a.cached, b.cached) };
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, thinking: 0, cached: 0 };
