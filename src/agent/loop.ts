import Anthropic from '@anthropic-ai/sdk';
import { GHOST_MODEL, anthropicApiKey } from '../bungie/config.js';
import { readTools } from '../tools/read-tools.js';
import { writeTools } from '../tools/write-tools.js';
import type { GhostTool, PendingAction, ToolContext } from '../tools/types.js';
import { SYSTEM_PROMPT } from './prompt.js';

const ALL_TOOLS: GhostTool[] = [...readTools, ...writeTools];
const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.definition.name, t]));

/** Tool defs sent to the model — frozen + cache-marked (last block) for caching. */
const TOOL_DEFS: Anthropic.Tool[] = ALL_TOOLS.map((t, i) =>
  i === ALL_TOOLS.length - 1
    ? { ...t.definition, cache_control: { type: 'ephemeral' } }
    : t.definition,
);

const client = new Anthropic({ apiKey: anthropicApiKey() });

/**
 * A conversation holds message history and the pending writes proposed this
 * turn. One instance per chat session (the web server keeps them per-connection).
 */
export class GhostConversation {
  private messages: Anthropic.MessageParam[] = [];
  private pending = new Map<string, PendingAction>();
  private tokenSeq = 0;

  private ctx: ToolContext = {
    propose: (action) => {
      const id = `act_${++this.tokenSeq}`;
      this.pending.set(id, { ...action, id });
      return id;
    },
  };

  /** Pending writes proposed during the last turn, for the UI to render. */
  pendingActions(): PendingAction[] {
    return [...this.pending.values()];
  }

  /** Confirm and run one proposed write; returns its result string. */
  async confirm(id: string): Promise<string> {
    const action = this.pending.get(id);
    if (!action) throw new Error(`No pending action ${id}.`);
    const result = await action.execute();
    this.pending.delete(id);
    // Record the outcome so the model has context on the next turn.
    this.messages.push({ role: 'user', content: `[system] Executed ${action.summary}: ${result}` });
    return result;
  }

  /** Discard a proposed write without running it. */
  cancel(id: string): void {
    this.pending.delete(id);
  }

  /**
   * Run one user turn to completion: the manual tool-use loop. Read tools run
   * in parallel; write tools register pending actions (no mutation here).
   * Returns Ghost's final text plus any pending actions for confirmation.
   */
  async send(userText: string): Promise<{ text: string; pending: PendingAction[] }> {
    this.pending.clear();
    this.messages.push({ role: 'user', content: userText });

    for (let guard = 0; guard < 12; guard++) {
      const res = await client.messages.create({
        model: GHOST_MODEL,
        max_tokens: 8000,
        // Adaptive thinking is required on Opus 4.8; the SDK version pinned here
        // predates the `adaptive` literal in its types, so cast the wire value.
        thinking: { type: 'adaptive' } as unknown as Anthropic.ThinkingConfigParam,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOL_DEFS,
        messages: this.messages,
      });

      this.messages.push({ role: 'assistant', content: res.content });

      if (res.stop_reason !== 'tool_use') {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return { text, pending: this.pendingActions() };
      }

      // Execute every tool_use block. Read tools are parallel-safe; writes just
      // register pending actions, so running them together is fine.
      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const results = await Promise.all(
        toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
          const tool = TOOLS_BY_NAME.get(use.name);
          if (!tool) {
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Unknown tool ${use.name}`,
              is_error: true,
            };
          }
          try {
            const out = await tool.handler(use.input, this.ctx);
            return { type: 'tool_result', tool_use_id: use.id, content: out };
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              content: err instanceof Error ? err.message : String(err),
              is_error: true,
            };
          }
        }),
      );

      this.messages.push({ role: 'user', content: results });
    }

    return {
      text: "I got stuck in a tool loop and stopped to avoid runaway calls. Try rephrasing?",
      pending: this.pendingActions(),
    };
  }
}
