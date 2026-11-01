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
 * task's tool budget is used up, the next turn offers only the terminal function.
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
  const maxTurns = spec.maxToolCalls + 6;

  while (turns < maxTurns) {
    if (ctx.signal.aborted) throw new LlmError('aborted', 'run aborted');
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
    let res;
    try {
      res = await ctx.generate(spec.task.id, final ? spec.finalKind : spec.kind, {
        role: spec.agent,
        system: spec.system,
        contents,
        tools: final ? [terminalDecl] : decls,
        toolMode: 'ANY',
      });
    } catch (e) {
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
    contents.push({ role: 'user', parts: responses });
  }
  return { output: null, toolCalls, turns, failure: 'turn limit reached without findings', outOfBudget: false };
}

function fnResponse(c: { id?: string; name: string }, response: Record<string, unknown>): Part {
  return { functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response } };
}
