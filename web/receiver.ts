/**
 * The demo's receiver: the browser's half of a media lane.
 *
 * The published package does the protocol's work: the fragment codec parses
 * the wire bytes, the object assembler joins the fragments of an object, and
 * the receiver machine holds the applied-update window and builds the
 * acknowledgement. This module is the application around them: it applies what
 * the protocol delivered, and it reports what it applied.
 *
 * The application owns the surface. The protocol never looks inside a media
 * body (MLP spec §5.1), so the cells an update carries are this demo's own
 * format: a list of cell indices and their colours.
 */

import {
  decodeMediaMessage,
  defaultObjectAssemblerConfig,
  MediaFragmentFlags,
  MediaObjectAssembler,
  MediaTlv,
  readTlvU16Pair,
  readTlvU32,
  readTlvU64,
  type MediaObject,
} from "@medialaneprotocol/mlp/pdu";
import { MediaReceiverMachine, type ViewerAck } from "@medialaneprotocol/mlp/receiver";

/** The demo's grid: the cells of the surface. */
export const COLS = 30;
export const ROWS = 17;
export const CELLS = COLS * ROWS;

/** What the receiver did with what the lane delivered. */
export type ReceiverEvent =
  | { kind: "applied"; updateId: number; cells: number; anchor: boolean }
  | { kind: "refused"; updateId: number; base: number; reason: string }
  | { kind: "rejected"; reason: string };

/** How the receiver is set up. */
export type ReceiverOptions = {
  /** The millisecond clock. */
  now?: () => number;
  /** The round-trip time the link has, in milliseconds. */
  rttMs?: number;
  /** Called with the acknowledgement, whenever it moves. */
  onAck?: (ack: ViewerAck) => void;
  /** Called when the receiver asks for a repair. */
  onRepair?: (heldUpdateId: number, reason: string) => void;
  /** Called for every thing the receiver did. */
  onEvent?: (event: ReceiverEvent) => void;
};

export class LaneReceiver {
  /** The protocol's machine: the applied window and the acknowledgement. */
  readonly machine: MediaReceiverMachine;
  /** The surface the receiver holds: three bytes per cell. */
  readonly surface = new Uint8Array(CELLS * 3);
  /** The sender's surface, when the lane has announced it. */
  capture: Uint8Array | null = null;

  private readonly assembler: MediaObjectAssembler;
  private readonly onAck: ((ack: ViewerAck) => void) | undefined;
  private readonly onRepair: ((heldUpdateId: number, reason: string) => void) | undefined;
  private readonly onEvent: ((event: ReceiverEvent) => void) | undefined;
  /** The update the surface holds. */
  private held = 0;
  /** The updates that were applied, in order. */
  readonly applied: number[] = [];

  constructor(options: ReceiverOptions = {}) {
    const now = options.now ?? (() => performance.now());
    const rttMs = options.rttMs ?? 150;
    this.assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(rttMs));
    this.onAck = options.onAck;
    this.onRepair = options.onRepair;
    this.onEvent = options.onEvent;
    this.machine = new MediaReceiverMachine({
      now,
      rttMs: () => rttMs,
      appliedCellCount: () => CELLS,
      onAck: (ack) => {
        this.onAck?.(ack);
      },
      onRepair: (request) => {
        this.onRepair?.(request.heldUpdateId, request.reason);
      },
    });
  }

  /** The update the surface holds. */
  get heldUpdateId(): number {
    return this.held;
  }

  /** The cells the receiver believes are stale: the ones that differ. */
  get staleCells(): number {
    const capture = this.capture;
    if (capture === null) {
      return CELLS;
    }
    let stale = 0;
    for (let cell = 0; cell < CELLS; cell += 1) {
      const offset = cell * 3;
      if (
        this.surface[offset] !== capture[offset] ||
        this.surface[offset + 1] !== capture[offset + 1] ||
        this.surface[offset + 2] !== capture[offset + 2]
      ) {
        stale += 1;
      }
    }
    return stale;
  }

  /** Whether the receiver holds the sender's surface. */
  get converged(): boolean {
    return this.staleCells === 0;
  }

  /** The updates the acknowledgement does not cover: the holes in its window. */
  get missingUpdates(): number[] {
    const ack = this.machine.ack;
    const missing: number[] = [];
    for (let distance = 1; distance < 64; distance += 1) {
      const updateId = ack.highestAppliedUpdateId - distance;
      if (updateId < 1) {
        break;
      }
      if ((ack.ackBitmap & (1n << BigInt(distance))) === 0n) {
        missing.push(updateId);
      }
    }
    return missing;
  }

  /** The sender's surface, as the lane announced it. */
  setCapture(cells: Uint8Array): void {
    this.capture = cells;
  }

  /** The acknowledgement, as the lane's line protocol carries it. */
  ackLine(): string {
    const ack = this.machine.ack;
    return [
      "ACK",
      ack.highestAppliedUpdateId,
      ack.ackBitmap.toString(16),
      ack.chainEpoch,
      ack.appliedCellCount,
      ack.staleCells,
      ack.converged ? "1" : "0",
      ack.renderLatencyMs.toFixed(3),
      ack.hasRenderLatencyMs ? "1" : "0",
      ack.echoOfInputSeq,
      ack.ackEpochMs,
    ].join(" ");
  }

  /** The repair request, as the lane's line protocol carries it. */
  repairLine(heldUpdateId: number, reason: string): string {
    return `REPAIR ${heldUpdateId} ${reason}`;
  }

  /** Take one fragment from the lane. */
  accept(bytes: Uint8Array): void {
    const verdict = decodeMediaMessage(bytes, "stream");
    if (!verdict.ok) {
      this.onEvent?.({ kind: "rejected", reason: verdict.reason });
      return;
    }
    for (const fragment of verdict.fragments) {
      const outcome = this.assembler.accept(fragment, Date.now(), this.machine.sessionMs);
      if (outcome.kind === "object") {
        this.onObject(outcome.object);
      }
    }
  }

  /** Take one object: the transport's metadata, and then the content. */
  private onObject(object: MediaObject): void {
    const header = { headerExt: object.headerExt };
    const updateId = readTlvU64(header, MediaTlv.UPDATE_ID) ?? 0;
    const base = readTlvU64(header, MediaTlv.UPDATE_BASE) ?? 0;
    const epoch = readTlvU32(header, MediaTlv.CHAIN_EPOCH) ?? 0;
    const part = readTlvU16Pair(header, MediaTlv.PART);
    const anchor = (object.flags & MediaFragmentFlags.ANCHOR) !== 0;
    this.machine.onMediaObject({ objectId: object.objectId, chainEpoch: epoch });

    if (!anchor && base !== 0 && base !== this.held) {
      // The update continues a surface the receiver does not hold: it is
      // refused, and the receiver asks for a repair rather than painting a
      // state it cannot verify (MLP spec §6.6).
      this.onEvent?.({ kind: "refused", updateId, base, reason: "the base is not held" });
      this.machine.requestRepair("REPORTED_INCOMPLETE", this.held);
      return;
    }

    const cells = this.applyPayload(object.payload);
    this.held = updateId;
    this.applied.push(updateId);
    this.machine.noteApplied(updateId, part?.first ?? 0);
    this.machine.setViewerState(this.staleCells, CELLS, this.converged);
    this.onEvent?.({ kind: "applied", updateId, cells, anchor });
  }

  /** Apply the media body: the demo's own list of cells and their colours. */
  private applyPayload(payload: Uint8Array): number {
    if (payload.byteLength < 2) {
      return 0;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint16(0, true);
    let applied = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = 2 + index * 5;
      if (offset + 5 > payload.byteLength) {
        break;
      }
      const cell = view.getUint16(offset, true);
      if (cell >= CELLS) {
        continue;
      }
      const target = cell * 3;
      this.surface[target] = view.getUint8(offset + 2);
      this.surface[target + 1] = view.getUint8(offset + 3);
      this.surface[target + 2] = view.getUint8(offset + 4);
      applied += 1;
    }
    return applied;
  }
}
