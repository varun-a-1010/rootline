import type { StopReason } from '../contracts/agents.js';
import type { TokenUsage } from '../llm/types.js';

export interface BudgetLimits {
  maxToolCalls: number;
  maxLlmCalls: number;
  maxTokens: number;
  deadlineMs: number;
  /** LLM calls held back from specialists so synthesis (reasoning, critic, report) can still run. */
  synthesisReserve: number;
}

export type LlmKind = 'specialist' | 'synthesis' | 'report';

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: StopReason) {
    super(`budget exhausted: ${reason}`);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Execution limits, checked before every call. The same limits apply to every arm and the
 * baseline. The first exhausted budget becomes the run's stop reason if nothing stops it first.
 */
export class Budget {
  readonly used = { toolCalls: 0, llmCalls: 0, tokens: 0 };
  readonly startedAt: number;
  private firstExhausted: StopReason | null = null;

  constructor(
    readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
    private readonly onExhausted: (budget: 'tool_calls' | 'llm_calls' | 'tokens' | 'deadline', used: number, limit: number) => void = () => {},
  ) {
    this.startedAt = now();
  }

  get deadlineAt(): number {
    return this.startedAt + this.limits.deadlineMs;
  }

  private exhaust(reason: StopReason, budget: 'tool_calls' | 'llm_calls' | 'tokens' | 'deadline', used: number, limit: number): void {
    if (!this.firstExhausted) this.firstExhausted = reason;
    this.onExhausted(budget, used, limit);
  }

  /** The stop reason implied by budgets, if any is exhausted. */
  get exhausted(): StopReason | null {
    return this.firstExhausted;
  }

  deadlinePassed(): boolean {
    return this.now() >= this.deadlineAt;
  }

  /** Throws BudgetExhaustedError when no tool call is allowed. Counts the call otherwise. */
  takeToolCall(): void {
    if (this.deadlinePassed()) {
      this.exhaust('deadline', 'deadline', this.now() - this.startedAt, this.limits.deadlineMs);
      throw new BudgetExhaustedError('deadline');
    }
    if (this.used.toolCalls >= this.limits.maxToolCalls) {
      this.exhaust('budget_tool_calls', 'tool_calls', this.used.toolCalls, this.limits.maxToolCalls);
      throw new BudgetExhaustedError('budget_tool_calls');
    }
    this.used.toolCalls += 1;
  }

  /** Record that a tool call was refused because the run budget (or deadline) is spent. */
  refuseToolCall(): void {
    if (this.deadlinePassed()) this.exhaust('deadline', 'deadline', this.now() - this.startedAt, this.limits.deadlineMs);
    else if (this.used.toolCalls >= this.limits.maxToolCalls) this.exhaust('budget_tool_calls', 'tool_calls', this.used.toolCalls, this.limits.maxToolCalls);
  }

  canToolCall(): boolean {
    return !this.deadlinePassed() && this.used.toolCalls < this.limits.maxToolCalls;
  }

  /**
   * Throws when no LLM call of this kind is allowed; counts it otherwise. Specialists may not
   * dip into the synthesis reserve. The final report call is always allowed once, even after
   * the LLM-call budget is used up (the same rule for every arm and the baseline), so every run
   * ends with a report.
   */
  takeLlmCall(kind: LlmKind): void {
    if (kind === 'report') {
      this.used.llmCalls += 1;
      return;
    }
    if (this.deadlinePassed()) {
      this.exhaust('deadline', 'deadline', this.now() - this.startedAt, this.limits.deadlineMs);
      throw new BudgetExhaustedError('deadline');
    }
    if (this.used.tokens >= this.limits.maxTokens) {
      this.exhaust('budget_tokens', 'tokens', this.used.tokens, this.limits.maxTokens);
      throw new BudgetExhaustedError('budget_tokens');
    }
    const ceiling = kind === 'specialist' ? this.limits.maxLlmCalls - this.limits.synthesisReserve : this.limits.maxLlmCalls;
    if (this.used.llmCalls >= ceiling) {
      this.exhaust('budget_llm_calls', 'llm_calls', this.used.llmCalls, this.limits.maxLlmCalls);
      throw new BudgetExhaustedError('budget_llm_calls');
    }
    this.used.llmCalls += 1;
  }

  canLlmCall(kind: LlmKind): boolean {
    if (kind === 'report') return true;
    if (this.deadlinePassed() || this.used.tokens >= this.limits.maxTokens) return false;
    const ceiling = kind === 'specialist' ? this.limits.maxLlmCalls - this.limits.synthesisReserve : this.limits.maxLlmCalls;
    return this.used.llmCalls < ceiling;
  }

  addUsage(u: TokenUsage | null): void {
    if (!u) return;
    this.used.tokens += (u.input ?? 0) + (u.output ?? 0) + (u.thinking ?? 0);
  }

  remaining() {
    return {
      toolCalls: Math.max(0, this.limits.maxToolCalls - this.used.toolCalls),
      llmCalls: Math.max(0, this.limits.maxLlmCalls - this.used.llmCalls),
      tokens: Math.max(0, this.limits.maxTokens - this.used.tokens),
      msLeft: Math.max(0, this.deadlineAt - this.now()),
    };
  }
}
