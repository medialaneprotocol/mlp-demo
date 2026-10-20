/**
 * The demo's headless run: the same receiver the browser runs, without a
 * browser.
 *
 * It is the demo's gate. It plays the receiver's half of a session against the
 * lane, and it asserts that the session carried updates, that the loss
 * happened, and that the repair healed it inside the demo's budget.
 */

import { BUDGETS } from "../dist/budgets.mjs";
import { LaneReceiver } from "../dist/receiver.mjs";
import { buildLane, startLane } from "./lib.mjs";

const failures = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

buildLane();
const lane = startLane();

const state = {
  updates: 0,
  bytes: 0,
  fragments: 0,
  dropped: 0,
  pending: 0,
  converged: false,
  droppedAt: -1,
  healedAt: -1,
  pendingAfterDrop: 0,
  done: "",
};

const receiver = new LaneReceiver({
  onAck: () => {
    lane.stdin.write(`${receiver.ackLine()}\n`);
  },
  onRepair: (held, reason) => {
    lane.stdin.write(`${receiver.repairLine(held, reason)}\n`);
  },
});

let buffered = "";
lane.stdout.setEncoding("utf8");
lane.stdout.on("data", (piece) => {
  buffered += piece;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line !== "") {
      handle(line);
    }
    newline = buffered.indexOf("\n");
  }
});

function handle(line) {
  const space = line.indexOf(" ");
  const kind = line.slice(0, space);
  const rest = line.slice(space + 1);
  if (kind === "FRAGMENT") {
    const at = rest.indexOf(" ");
    receiver.accept(Buffer.from(rest.slice(at + 1), "base64"));
    return;
  }
  if (kind === "CAPTURE") {
    const at = rest.indexOf(" ");
    receiver.setCapture(Buffer.from(rest.slice(at + 1), "base64"));
    return;
  }
  if (kind === "NOTE") {
    const at = rest.indexOf(" ");
    const atMs = Number.parseInt(rest.slice(0, at), 10);
    const text = rest.slice(at + 1);
    if (text.includes("dropped a fragment")) {
      state.droppedAt = atMs;
    }
    console.log(`${atMs} ms  ${text}`);
    return;
  }
  if (kind === "STATE") {
    const fields = rest.split(" ").map((value) => Number.parseInt(value, 10));
    state.updates = fields[1] ?? 0;
    state.bytes = fields[2] ?? 0;
    state.fragments = fields[3] ?? 0;
    state.dropped = fields[4] ?? 0;
    state.pending = fields[5] ?? 0;
    state.converged = (fields[6] ?? 0) === 1;
    if (state.droppedAt >= 0) {
      // The sender owes cells from the moment the loss happens, and owes none
      // once the receiver holds them again: that is the healing.
      state.pendingAfterDrop = Math.max(state.pendingAfterDrop, state.pending);
      if (state.healedAt < 0 && state.pendingAfterDrop > 0 && state.pending === 0) {
        state.healedAt = fields[0] ?? 0;
      }
    }
    return;
  }
  if (kind === "DONE") {
    state.done = rest.slice(rest.indexOf(" ") + 1);
  }
}

const finished = new Promise((resolve) => {
  lane.on("exit", () => {
    resolve();
  });
});

await finished;

const applied = receiver.applied.length;
const stale = receiver.staleCells;
const healMs = state.healedAt >= 0 && state.droppedAt >= 0 ? state.healedAt - state.droppedAt : -1;

console.log("");
console.log("the session");
console.log(`  updates sent      ${state.updates}`);
console.log(`  bytes sent        ${state.bytes}`);
console.log(`  fragments         ${state.fragments} released, ${state.dropped} dropped`);
console.log(`  updates applied   ${applied} (${receiver.applied.join(", ")})`);
console.log(`  pending cells     ${state.pending}`);
console.log(`  stale cells       ${stale}`);
console.log(`  missing updates   ${receiver.missingUpdates.join(", ") || "none"}`);
console.log(`  the healing       ${healMs} ms, the budget is ${BUDGETS.healMs} ms`);
console.log(`  the run           ${state.done}`);

check(applied >= 1, "the receiver applied no update: the round trip did not happen");
check(state.dropped >= 1, "the lane dropped nothing: there was no loss to heal");
check(state.healedAt >= 0, "the session never healed: the receiver's surface never met the capture");
check(healMs >= 0 && healMs <= BUDGETS.healMs, `the healing took ${healMs} ms, over the budget of ${BUDGETS.healMs} ms`);
check(stale === 0, `the receiver holds ${stale} stale cells`);
check(state.pending === 0, `the sender still owes ${state.pending} cells`);
check(state.done === "converged", `the run ended as "${state.done}"`);

console.log(
  `MEASURE mlp-demo headless: updates=${state.updates} applied=${applied} ` +
    `dropped=${state.dropped} pending=${state.pending} stale=${stale} ` +
    `heal_ms=${healMs} budget_ms=${BUDGETS.healMs}`,
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}
console.log("the session carried the updates, the loss was healed, and the healing was inside its budget");
