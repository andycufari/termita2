// Tiny event emitter the engine uses to push state to the UI. Synchronous
// fan-out; the UI subscribes and re-renders. Keeps engine free of UI imports.

export const EVENTS = {
  TOKEN: 'token', // { text }            assistant text streaming
  REASONING: 'reasoning', // { text }    thinking trace streaming
  ASSISTANT_DONE: 'assistant_done', // { text, reasoning, ms }
  TOOL_PROPOSED: 'tool_proposed', // { id, name, args, gate }
  TOOL_AWAIT: 'tool_await', // { id }    waiting on a human decision
  TOOL_RUNNING: 'tool_running', // { id }
  TOOL_OUTPUT: 'tool_output', // { id, chunk }   live stream chunk
  TOOL_DONE: 'tool_done', // { id, output, meta, decision }
  TURN_DONE: 'turn_done', // {}          control back to user
  ERROR: 'error', // { message, kind }
  STATUS: 'status', // { text }          transient status line
  NOTICE: 'notice', // { text, level }   inline notice (allowlist etc.)
};

export class Emitter {
  constructor() {
    this.handlers = new Set();
  }
  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  emit(type, data = {}) {
    for (const fn of this.handlers) {
      try { fn({ type, ...data }); } catch { /* a bad listener shouldn't break the engine */ }
    }
  }
}
