import type Anthropic from '@anthropic-ai/sdk';

/**
 * A pending write the agent proposed. The server holds these and surfaces the
 * `plan` as a confirm dialog; nothing mutates the account until the user
 * confirms and `execute` is called. This is the human-in-the-loop gate.
 */
export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  /** Ordered, human-readable steps this action will perform. */
  plan: string[];
  /** Runs the write. Returns a user-facing result string. */
  execute: () => Promise<string>;
}

export interface ToolContext {
  /** Register a pending write and return the confirmation token. */
  propose: (action: Omit<PendingAction, 'id'>) => string;
}

export interface GhostTool {
  definition: Anthropic.Tool;
  /** READ tools run immediately; WRITE tools call ctx.propose and return a token. */
  readonly kind: 'read' | 'write';
  handler: (input: any, ctx: ToolContext) => Promise<string>;
}
