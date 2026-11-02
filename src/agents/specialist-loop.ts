import type { z } from 'zod';
import type { TaskSpec } from '../contracts/agents.js';
import { TOOL_NAMES, type ToolName } from '../contracts/tools.js';
import type { LlmKind } from '../engine/budgets.js';
import { BudgetExhaustedError, type RunContext } from '../engine/context.js';
import { functionDeclaration } from '../llm/schema.js';
import { LlmError, type Content, type FunctionDeclaration, type Part } from '../llm/types.js';
import { TOOLS } from '../tools/registry.js';

export interface LoopSpec<T> {
  task: TaskSpec;
  agent: string;
  system: string;
  userText: string;
  tools: readonly ToolName[];
  terminal: { name: string; description: string; schema: z.ZodType<T> };
  maxToolCalls: number;
  /** Budget kind for normal turns, and for the forced final turn. */
  kind: LlmKind;
  finalKind: LlmKind;
  /** Message sent when the loop switches to the forced final turn. */
  finalNotice?: string;
  /**
   * If the run deadline aborts the loop, make one final terminal-only call with this much
   * grace (the baseline's equivalent of the multi-agent arms' final report call).
   */
  deadlineGraceMs?: number;
}

export interface LoopResult<T> {
  output: T | null;
  toolCalls: number;
  turns: number;
  /** Why no output was produced (budget, invalid output, ...). */
  failure: string | null;
  outOfBudget: boolean;
}

const declCache = new Map<string, FunctionDeclaration>();
export function toolDeclaration(name: ToolName): FunctionDeclaration {
  let d = declCache.get(name);
  if (!d) {
    const t = TOOLS[name];
    d = functionDeclaration(t.name, t.description, t.input);
    declCache.set(name, d);
  }
  return d;
}

/**
 * A bounded tool loop. The model must call a function every turn (toolMode ANY): either one of
 * its role's tools or the terminal function, whose parameters are the output schema. When the
 * task's tool budget is used up, a notice tells the model to finish; if it does not, or if the
 * budget allows only one more call, the turn permits only the terminal function.
 */
export async function runToolLoop<T>(ctx: RunContext, spec: LoopSpec<T>): Promise<LoopResult<T>> {
  const allowed = new Set<string>(spec.tools);
  const terminalDecl = functionDeclaration(spec.terminal.name, spec.terminal.description, spec.terminal.schema);
  const decls = [...spec.tools.map(toolDeclaration), terminalDecl];
  const contents: Content[] = [{ role: 'user', parts: [{ text: spec.userText }] }];
  let toolCalls = 0;
  let turns = 0;
  let nudges = 0;
  let badTerminal = 0;
  let finalNoticeSent = false;
  let finalTurns = 0;
  const maxTurns = spec.maxToolCalls + 6;

  let grace: AbortSignal | null = null;
  const deadlineFinal = (): boolean => {
    if (grace || !spec.deadlineGraceMs || !ctx.signal.aborted || !ctx.budget.deadlinePassed()) return false;
    grace = AbortSignal.timeout(spec.deadlineGraceMs);
    // Always its own user turn: Vertex rejects text inside a function-response turn.
    contents.push({ role: 'user', parts: [{ text: spec.finalNotice ?? `Time is up. Call ${spec.terminal.name} now with what you have.` }] });
    finalNoticeSent = true;
    return true;
  };
  while (turns < maxTurns) {
    if (ctx.signal.aborted && !grace && !deadlineFinal()) throw new LlmError('aborted', 'run aborted');
    if (grace) {
      turns += 1;
      const res = await ctx.generate(spec.task.id, 'report', { role: spec.agent, system: spec.system, contents, tools: decls, toolMode: 'ANY', allowedFunctions: [spec.terminal.name] }, grace);
      const call = res.functionCalls.find((c) => c.name === spec.terminal.name);
      const parsed = call ? spec.terminal.schema.safeParse(call.args) : null;
      if (parsed?.success) return { output: parsed.data, toolCalls, turns, failure: null, outOfBudget: false };
      return { output: null, toolCalls, turns, failure: 'deadline reached and the final submission was invalid', outOfBudget: true };
    }
    const runToolsLeft = ctx.budget.canToolCall();
    if (!runToolsLeft) ctx.budget.refuseToolCall();
    const toolsLeft = toolCalls < spec.maxToolCalls && runToolsLeft;
    let final = !toolsLeft || !ctx.budget.canLlmCall(spec.kind);
    if (final && !ctx.budget.canLlmCall(spec.finalKind)) {
      return { output: null, toolCalls, turns, failure: 'model-call budget exhausted before findings were submitted', outOfBudget: true };
    }
    if (final && !finalNoticeSent) {
      finalNoticeSent = true;
      contents.push({ role: 'user', parts: [{ text: spec.finalNotice ?? `Your tool budget for this task is used up. Call ${spec.terminal.name} now with what you have, and list what you could not check as gaps.` }] });
    }
    turns += 1;
    if (final) finalTurns += 1;
    // Restricting functions disables implicit caching, and this is the loop's largest call. So the
    // first forced turn is an ordinary request, unless the budget allows no second try.
    const mustFinish = final && (finalTurns > 1 || !ctx.budget.canLlmCall(spec.finalKind, 1));
    let res;
    try {
      res = await ctx.generate(spec.task.id, final ? spec.finalKind : spec.kind, {
        role: spec.agent,
        system: spec.system,
        contents,
        tools: decls,
        toolMode: 'ANY',
        ...(mustFinish ? { allowedFunctions: [spec.terminal.name] } : {}),
      });
    } catch (e) {
      if (ctx.signal.aborted && deadlineFinal()) continue;
      if (e instanceof BudgetExhaustedError) {
        if (!final && ctx.budget.canLlmCall(spec.finalKind)) {
          final = true;
          continue;
        }
        return { output: null, toolCalls, turns, failure: `budget exhausted (${e.reason}) before findings were submitted`, outOfBudget: true };
      }
      throw e;
    }
    contents.push(res.content.parts.length ? res.content : { role: 'model', parts: [{ text: res.text || '(no output)' }] });
    const calls = res.functionCalls;
    if (calls.length === 0) {
      nudges += 1;
      if (nudges > 2) return { output: null, toolCalls, turns, failure: 'model stopped calling functions', outOfBudget: false };
      contents.push({ role: 'user', parts: [{ text: `Call one of your tools, or ${spec.terminal.name} to finish.` }] });
      continue;
    }

    const responses: Part[] = new Array(calls.length);
    const terminalIdx = calls.findIndex((c) => c.name === spec.terminal.name);
    if (terminalIdx >= 0) {
      const parsed = spec.terminal.schema.safeParse(calls[terminalIdx]!.args);
      if (parsed.success) return { output: parsed.data, toolCalls, turns, failure: null, outOfBudget: false };
      badTerminal += 1;
      if (badTerminal > 1) return { output: null, toolCalls, turns, failure: `invalid ${spec.terminal.name} arguments: ${parsed.error.issues[0]?.message ?? ''}`, outOfBudget: false };
      const msg = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      responses[terminalIdx] = fnResponse(calls[terminalIdx]!, { error: `arguments failed validation: ${msg}. Call ${spec.terminal.name} again with corrected arguments.` });
    }

    try {
    await Promise.all(
      calls.map(async (c, i) => {
        if (i === terminalIdx) return;
        if (!(TOOL_NAMES as readonly string[]).includes(c.name) || !allowed.has(c.name)) {
          responses[i] = fnResponse(c, { error: `tool "${c.name}" is not available to the ${spec.agent} role` });
          return;
        }
        if (toolCalls >= spec.maxToolCalls || !ctx.budget.canToolCall()) {
          if (!ctx.budget.canToolCall()) ctx.budget.refuseToolCall();
          responses[i] = fnResponse(c, { error: `tool budget exhausted; call ${spec.terminal.name}` });
          return;
        }
        toolCalls += 1;
        try {
          const result = await ctx.callTool(spec.task, spec.agent, c.name, c.args, 'model');
          const view = ctx.toolViewHook && result.evidence ? await ctx.toolViewHook(ctx, spec.task, result) : result.modelView;
          responses[i] = fnResponse(c, view);
        } catch (e) {
          if (e instanceof BudgetExhaustedError) {
            responses[i] = fnResponse(c, { error: `run budget exhausted (${e.reason}); call ${spec.terminal.name}` });
            return;
          }
          throw e;
        }
      }),
    );
    } catch (e) {
      // Deadline during tool calls: answer the pending calls so the conversation stays valid.
      if (ctx.signal.aborted && spec.deadlineGraceMs && ctx.budget.deadlinePassed()) {
        calls.forEach((c, i) => (responses[i] ??= fnResponse(c, { error: 'not run: the run deadline was reached' })));
        contents.push({ role: 'user', parts: responses });
        if (deadlineFinal()) continue;
      }
      throw e;
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { output: null, toolCalls, turns, failure: 'turn limit reached without findings', outOfBudget: false };
}

function fnResponse(c: { id?: string; name: string }, response: Record<string, unknown>): Part {
  return { functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response } };
}
