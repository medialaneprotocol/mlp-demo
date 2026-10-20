/**
 * The budgets the demo holds itself to.
 *
 * The byte budget is the lane's own: the sender's per-update budget, which
 * the lane reports and the sender's accounting enforces. The healing budget
 * is the demo's, and it is declared here so the run prints the number it was
 * measured against.
 */

export const BUDGETS = {
  /** The demo's budget: the loss heals within this many milliseconds. */
  healMs: 2_000,
  /** The receiver's acknowledgement window: 64 updates. */
  ackWindow: 64,
} as const;
