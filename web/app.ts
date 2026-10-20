/**
 * The demo's browser page: the sender's surface, the receiver's surface, and
 * what happened between them.
 */

import { BUDGETS } from "./budgets";
import { CELLS, COLS, ROWS, LaneReceiver, type ReceiverEvent } from "./receiver";

const CELL_PX = 14;

const capture = document.getElementById("capture") as HTMLCanvasElement;
const surface = document.getElementById("surface") as HTMLCanvasElement;
const log = document.getElementById("log") as HTMLPreElement;
const report = document.getElementById("report") as HTMLPreElement;
const again = document.getElementById("again") as HTMLButtonElement;

again.addEventListener("click", () => {
  void fetch("./run", { method: "POST" });
});

capture.width = COLS * CELL_PX;
capture.height = ROWS * CELL_PX;
surface.width = COLS * CELL_PX;
surface.height = ROWS * CELL_PX;

const lines: string[] = [];
const state = {
  updates: 0,
  bytes: 0,
  fragments: 0,
  dropped: 0,
  pending: 0,
  converged: false,
  pace: 0,
  budget: 0,
  done: "",
  applied: 0,
  missing: [] as number[],
  stale: CELLS,
  droppedAt: -1,
  healedAt: -1,
  pendingAfterDrop: 0,
};

function note(text: string): void {
  lines.push(text);
  if (lines.length > 200) {
    lines.shift();
  }
  log.textContent = lines.join("\n");
  log.scrollTop = log.scrollHeight;
}

/** Draw a surface: three bytes per cell. */
function draw(canvas: HTMLCanvasElement, cells: Uint8Array): void {
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let cell = 0; cell < COLS * ROWS; cell += 1) {
    const offset = cell * 3;
    const red = cells[offset] ?? 0;
    const green = cells[offset + 1] ?? 0;
    const blue = cells[offset + 2] ?? 0;
    if (red === 0 && green === 0 && blue === 0) {
      continue;
    }
    context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    const x = (cell % COLS) * CELL_PX;
    const y = Math.floor(cell / COLS) * CELL_PX;
    context.fillRect(x, y, CELL_PX, CELL_PX);
  }
}

/** The sender's surface, and the receiver that holds the other one. */
let captureCells: Uint8Array | null = null;
let receiver = newReceiver();

function newReceiver(): LaneReceiver {
  return new LaneReceiver({
    onAck: () => {
      void fetch("./ack", { method: "POST", body: receiver.ackLine() });
    },
    onRepair: (held, reason) => {
      void fetch("./repair", { method: "POST", body: receiver.repairLine(held, reason) });
    },
    onEvent: (event: ReceiverEvent) => {
      if (event.kind === "applied") {
        state.applied += 1;
        note(
          `the receiver applied update ${event.updateId}: ${event.cells} cells` +
            (event.anchor ? " (an anchor)" : ""),
        );
      } else if (event.kind === "refused") {
        note(
          `the receiver refused update ${event.updateId}: it continues update ${event.base}, which it does not hold`,
        );
      } else {
        note(`the receiver rejected a fragment: ${event.reason}`);
      }
      draw(surface, receiver.surface);
    },
  });
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const source = new EventSource("./events");
source.onmessage = (event) => {
  const line = event.data;
  const space = line.indexOf(" ");
  if (space < 0) {
    return;
  }
  const kind = line.slice(0, space);
  const rest = line.slice(space + 1);
  if (kind === "FRAGMENT") {
    const at = rest.indexOf(" ");
    const bytes = fromBase64(rest.slice(at + 1));
    receiver.accept(bytes);
    return;
  }
  if (kind === "CAPTURE") {
    const at = rest.indexOf(" ");
    captureCells = fromBase64(rest.slice(at + 1));
    receiver.setCapture(captureCells);
    draw(capture, captureCells);
    draw(surface, receiver.surface);
    return;
  }
  if (kind === "NOTE") {
    const at = rest.indexOf(" ");
    const text = rest.slice(at + 1);
    if (text.includes("the lane is live")) {
      // A new session starts: the receiver, the counters and the surfaces
      // belong to that session.
      receiver = newReceiver();
      if (captureCells !== null) {
        receiver.setCapture(captureCells);
      }
      state.updates = 0;
      state.bytes = 0;
      state.fragments = 0;
      state.dropped = 0;
      state.pending = 0;
      state.converged = false;
      state.applied = 0;
      state.missing = [];
      state.done = "";
      state.droppedAt = -1;
      state.healedAt = -1;
      state.pendingAfterDrop = 0;
      draw(surface, receiver.surface);
    }
    if (text.includes("dropped a fragment")) {
      state.droppedAt = Number.parseInt(rest.slice(0, at), 10);
    }
    note(`${rest.slice(0, at)} ms  ${text}`);
    return;
  }
  if (kind === "STATE") {
    const fields = rest.split(" ").map((value: string) => Number.parseInt(value, 10));
    state.updates = fields[1] ?? 0;
    state.bytes = fields[2] ?? 0;
    state.fragments = fields[3] ?? 0;
    state.dropped = fields[4] ?? 0;
    state.pending = fields[5] ?? 0;
    state.converged = (fields[6] ?? 0) === 1;
    state.pace = fields[7] ?? 0;
    state.budget = fields[8] ?? 0;
    state.stale = receiver.staleCells;
    state.missing = receiver.missingUpdates;
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
    note(`the run is over: ${state.done}`);
  }
  render();
};

function render(): void {
  const healed = state.healedAt >= 0 ? `${state.healedAt - state.droppedAt} ms` : "not yet";
  const lines: string[] = [];
  lines.push(`updates sent      ${state.updates}`);
  lines.push(`bytes sent        ${state.bytes}`);
  lines.push(`fragments         ${state.fragments} released, ${state.dropped} dropped`);
  lines.push(`pending cells     ${state.pending}`);
  lines.push(`stale cells       ${state.stale} of ${COLS * ROWS}`);
  lines.push(`missing updates   ${state.missing.length > 0 ? state.missing.join(", ") : "none"}`);
  lines.push(`the pace          ${state.pace} bit/s, the budget ${state.budget} bytes per update`);
  lines.push(`the healing       ${healed} (the budget is ${BUDGETS.healMs} ms)`);
  lines.push(`the run           ${state.done === "" ? "running" : state.done}`);
  report.textContent = lines.join("\n");
}

render();
