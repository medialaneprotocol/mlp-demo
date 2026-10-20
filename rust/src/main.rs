//! The demo's lane: the sender, the lossy link, and the words between them.
//!
//! The lane is the sender's half of a media lane. It produces updates from a
//! capture, hands them to the crate's own lossy link, and reports what it
//! released. The receiver is the browser: it decodes the fragments with the
//! published browser package, applies them, and acknowledges what it applied.
//!
//! The lane speaks a line protocol, one line per event, on stdout:
//!
//! ```text
//! FRAGMENT <at_ms> <base64>          one fragment, as the carrier would carry it
//! CAPTURE <at_ms> <base64>           the capture's cells, in the codec's cell format
//! NOTE <at_ms> <text>                something worth saying
//! STATE <at_ms> <fields>             the counters
//! DONE <at_ms> <reason>              the run is over
//! ```
//!
//! and it reads the receiver's acknowledgements on stdin:
//!
//! ```text
//! ACK <highest> <bitmap> <epoch> <cells> <stale> <converged> <latency> <measured> <echo> <at>
//! REPAIR <held_update_id> <reason>   the receiver asks for a repair
//! ```

use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use mlp_core::media::cells::CellGrid;
use mlp_core::media::pdu::Carrier;
use mlp_core::media::scheduler::UpdateKind;
use mlp_core::media::sender::{
    EnqueueOutcome, MediaSenderConfig, MediaSenderMachine, MediaSenderEvent, UpdateRequest,
};
use mlp_core::media::MediaAck;
use mlp_core::testing::lossy_link::{Endpoint, LinkProfile, LossyLink, Tier};

/// The captured surface, in cells.
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const CELL_SIZE: u32 = 64;

/// The lane's tick, in milliseconds.
const TICK_MS: u64 = 10;
/// The capture changes this often, until it has changed this many times.
const CAPTURE_EVERY_MS: u64 = 300;
const CAPTURE_CHANGES: u32 = 8;
/// The fragment the lane drops on purpose: the loss the demo heals.
const DROP_FRAGMENT: u64 = 3;
/// How long the lane runs before it gives up.
const RUN_LIMIT_MS: u64 = 15_000;
/// How long the lane waits for the convergence to settle.
const SETTLE_MS: u64 = 400;

/// The lane.
struct Lane {
    sender: MediaSenderMachine,
    link: LossyLink,
    capture: Vec<u8>,
    changed: Vec<u32>,
    now_ms: u64,
    epoch: Instant,
    next_capture_ms: u64,
    captures: u32,
    released: u64,
    dropped: u64,
    updates_sent: u64,
    bytes_sent: u64,
    repairs: u64,
    last_state_ms: u64,
    converged_since: Option<u64>,
    cols_: u32,
    out: io::Stdout,
}

impl Lane {
    fn new() -> Self {
        let grid = CellGrid::with_cell_size(WIDTH, HEIGHT, CELL_SIZE);
        let mut profile = LinkProfile::tier(Tier::T2);
        // The lane's own loss is the one it drops on purpose; the link itself
        // carries everything with the tier's delay and rate.
        profile.loss_permille = 0;
        let epoch = Instant::now();
        let mut config = MediaSenderConfig::new(Carrier::Ws, grid);
        config.bwe.prior_bps = Some(profile.rate_bps_down);
        config.bwe.pace_floor_bps = 8_000;
        let sender = MediaSenderMachine::new(config, grid, epoch);
        let cols = grid.cols();
        Self {
            capture: vec![0; grid.cells() as usize * 3],
            changed: Vec::new(),
            sender,
            link: LossyLink::new(profile),
            now_ms: 0,
            epoch,
            next_capture_ms: CAPTURE_EVERY_MS,
            captures: 0,
            released: 0,
            dropped: 0,
            updates_sent: 0,
            bytes_sent: 0,
            repairs: 0,
            last_state_ms: 0,
            converged_since: None,
            out: io::stdout(),
            cols_: cols,
        }
    }

    fn instant(&self) -> Instant {
        self.epoch + Duration::from_millis(self.now_ms)
    }

    /// One tick of the lane.
    fn tick(&mut self) {
        self.now_ms += TICK_MS;
        let now = self.instant();
        if self.captures < CAPTURE_CHANGES && self.now_ms >= self.next_capture_ms {
            self.change_capture();
        }
        self.encode(now);
        self.release(now);
        for delivery in self.link.advance(TICK_MS) {
            self.emit_fragment(&delivery.bytes, delivery.at_ms);
        }
        let timeout_events = self.sender.handle_timeout_events(now);
        self.note_sender_events(&timeout_events);
        let lane_events = self.sender.poll_lane(now);
        self.note_sender_events(&lane_events);
        self.report(now);
    }

    /// The capture changes: the block moves and takes a new colour.
    fn change_capture(&mut self) {
        self.captures += 1;
        self.next_capture_ms += CAPTURE_EVERY_MS;
        let mut next = self.capture.clone();
        paint_capture(&mut next, self.captures, self.cols_);
        let mut changed = Vec::new();
        for (cell, (before, after)) in self
            .capture
            .chunks_exact(3)
            .zip(next.chunks_exact(3))
            .enumerate()
        {
            if before != after {
                changed.push(cell as u32);
            }
        }
        self.capture = next;
        self.changed = changed;
        self.emit_capture();
    }

    /// The sender's half: plan an update and hand it to the queue.
    fn encode(&mut self, now: Instant) {
        let session_ms = self.sender.session_ms(now);
        let cadence = self
            .sender
            .scheduler()
            .timer()
            .due(session_ms, self.sender.target_fps(now));
        if !cadence || self.changed.is_empty() {
            return;
        }
        let fresh = self.changed.clone();
        let decision = self.sender.plan_next_update(&fresh, &[], now);
        if decision.cells.is_empty() {
            return;
        }
        let payload = encode_payload(&decision.cells, &self.capture);
        let kind = decision.kind;
        let cells = decision.cells.clone();
        let request = UpdateRequest {
            parts: vec![payload],
            cells: cells.clone(),
            anchor: decision.anchor,
            kind,
            reflects_input_seq: 0,
            update_bytes: decision.estimated_bytes,
            echo_critical: false,
            deadline_epoch_ms: None,
        };
        match self.sender.enqueue_update(request, now) {
            EnqueueOutcome::Accepted { .. } => {
                let update_id = self.sender.next_update_id() - 1;
                self.updates_sent += 1;
                if kind == UpdateKind::Repair {
                    self.repairs += 1;
                }
                self.changed.retain(|cell| !cells.contains(cell));
                self.sender
                    .scheduler_mut()
                    .plans_mut()
                    .unclaim(&decision.cells);
                self.note(&format!(
                    "update {update_id} ({}) carries {} cells",
                    kind.as_str(),
                    cells.len()
                ));
            }
            EnqueueOutcome::Oversize { bytes, cap } => {
                self.note(&format!(
                    "the update needed {bytes} bytes, over the cap of {cap}"
                ));
                self.sender.scheduler_mut().plans_mut().unclaim(&[]);
            }
            EnqueueOutcome::Deferred { reason } | EnqueueOutcome::Coalesced { reason } => {
                self.note(&format!("the update was not queued: {}", reason.as_str()));
                self.sender.scheduler_mut().plans_mut().unclaim(&[]);
            }
        }
    }

    /// The lane's half: release the fragments into the link.
    fn release(&mut self, now: Instant) {
        while let Some(fragment) = self.sender.poll_fragment(now) {
            self.released += 1;
            if self.released == DROP_FRAGMENT {
                self.dropped += 1;
                self.note("the lane dropped a fragment on purpose");
                continue;
            }
            self.bytes_sent += fragment.bytes.len() as u64;
            self.link.transmit(Endpoint::Sender, fragment.bytes);
        }
    }

    /// What the sender says.
    fn note_sender_events(&mut self, events: &[MediaSenderEvent]) {
        for event in events {
            match event {
                MediaSenderEvent::PlanStarted {
                    reason, cells, ..
                } => self.note(&format!(
                    "a repair plan ({}) started for {cells} cells",
                    reason.as_str()
                )),
                MediaSenderEvent::PlanOverdue { plan_id } => {
                    self.note(&format!("the repair plan {plan_id} ran past its deadline"));
                }
                MediaSenderEvent::LaneStateChanged(state) => {
                    self.note(&format!("the lane is {}", state.as_str()));
                }
                MediaSenderEvent::ObjectOversize { bytes, cap } => {
                    self.note(&format!("an object of {bytes} bytes was over the cap of {cap}"));
                }
                MediaSenderEvent::ObjectCoalesced { object_id, reason } => {
                    self.note(&format!("the object {object_id} was coalesced: {}", reason.as_str()));
                }
                MediaSenderEvent::DuplicateScheduled { object_id, .. } => {
                    self.note(&format!("the object {object_id} is duplicated on purpose"));
                }
                MediaSenderEvent::InboundDropped { object_id, reason } => {
                    self.note(&format!(
                        "an inbound object was dropped: {}",
                        reason.as_str()
                    ));
                    let _ = object_id;
                }
                MediaSenderEvent::CloseRequested { .. } => {
                    self.note("the lane asked to close");
                }
                MediaSenderEvent::ProbeDue { .. } => {}
            }
        }
    }

    /// The counters.
    fn report(&mut self, _now: Instant) {
        if self.now_ms < self.last_state_ms + 200 {
            return;
        }
        self.last_state_ms = self.now_ms;
        let accounting = self.sender.accounting();
        let estimate = self.sender.estimate();
        let line = format!(
            "STATE {} {} {} {} {} {} {} {} {}",
            self.now_ms,
            self.updates_sent,
            self.bytes_sent,
            self.released,
            self.dropped,
            accounting.pending_count(),
            u8::from(accounting.converged()),
            estimate.pace_bps,
            estimate.budget_bytes,
        );
        self.write(&line);
    }

    /// Whether the run is over.
    fn finished(&mut self) -> Option<&'static str> {
        if self.now_ms >= RUN_LIMIT_MS {
            return Some("timeout");
        }
        if self.captures < CAPTURE_CHANGES {
            return None;
        }
        let converged = self.sender.accounting().converged();
        if !converged {
            self.converged_since = None;
            return None;
        }
        let since = *self.converged_since.get_or_insert(self.now_ms);
        if self.now_ms >= since + SETTLE_MS {
            return Some("converged");
        }
        None
    }

    /// The receiver's acknowledgement.
    fn on_ack(&mut self, line: &str) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.first() != Some(&"ACK") {
            return;
        }
        let number = |index: usize| -> Option<&str> { fields.get(index + 1).copied() };
        let highest = number(0).and_then(|value| value.parse().ok()).unwrap_or(0);
        let bitmap = number(1)
            .and_then(|value| u64::from_str_radix(value.trim_start_matches("0x"), 16).ok())
            .unwrap_or(0);
        let epoch = number(2).and_then(|value| value.parse().ok()).unwrap_or(0);
        let cells = number(3).and_then(|value| value.parse().ok()).unwrap_or(0);
        let stale = number(4).and_then(|value| value.parse().ok()).unwrap_or(0);
        let converged = number(5) == Some("1");
        let latency = number(6).and_then(|value| value.parse().ok()).unwrap_or(0.0);
        let measured = number(7) == Some("1");
        let echo = number(8).and_then(|value| value.parse().ok()).unwrap_or(0);
        let at = number(9).and_then(|value| value.parse().ok()).unwrap_or(0);
        let ack = MediaAck {
            highest_applied_update_id: highest,
            ack_bitmap: bitmap,
            chain_epoch: epoch,
            applied_cell_count: cells,
            stale_cells: stale,
            converged,
            render_latency_ms: latency,
            has_render_latency_ms: measured,
            echo_of_input_seq: echo,
            ack_epoch_ms: at,
        };
        if ack.validate().is_err() {
            self.note("the acknowledgement was refused: it does not hold the rules");
            return;
        }
        self.note(&format!(
            "the receiver acknowledged up to update {} ({} cells stale)",
            ack.highest_applied_update_id, ack.stale_cells
        ));
        let events = self.sender.on_ack(ack, self.instant());
        self.note_sender_events(&events);
    }

    /// The receiver's repair request.
    fn on_repair(&mut self, line: &str) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.first() != Some(&"REPAIR") {
            return;
        }
        let held = fields.get(1).and_then(|value| value.parse().ok()).unwrap_or(0);
        self.note(&format!("the receiver asks for a repair; it holds update {held}"));
        self.sender
            .request_plan(mlp_core::media::scheduler::PlanStartReason::Pending);
        let events = self.sender.poll_plans(self.instant());
        self.note_sender_events(&events);
    }

    fn note(&mut self, text: &str) {
        let line = format!("NOTE {} {text}", self.now_ms);
        self.write(&line);
    }

    fn emit_fragment(&mut self, bytes: &[u8], at_ms: u64) {
        let line = format!("FRAGMENT {at_ms} {}", base64(bytes));
        self.write(&line);
    }

    fn emit_capture(&mut self) {
        let line = format!("CAPTURE {} {}", self.now_ms, base64(&self.capture));
        self.write(&line);
    }

    fn write(&mut self, line: &str) {
        let _ = writeln!(self.out, "{line}");
        let _ = self.out.flush();
    }
}

/// The capture: a black field and a block that moves and changes colour.
///
/// The field is black because that is what a receiver holds before the first
/// update: the surface the two sides compare is the block, and the block is
/// what a lost update leaves behind.
fn paint_capture(cells: &mut [u8], step: u32, cols: u32) {
    for cell in cells.chunks_exact_mut(3) {
        cell.copy_from_slice(&[0, 0, 0]);
    }
    let colours: [[u8; 3]; 5] = [
        [235, 150, 40],
        [60, 200, 90],
        [60, 120, 235],
        [220, 210, 70],
        [200, 80, 210],
    ];
    let colour = colours[(step as usize - 1) % colours.len()];
    let left = 2 + (step % 9) * 3;
    let top = 7;
    for row in top..top + 2 {
        for column in left..left + 3 {
            let index = (row * cols + column) as usize * 3;
            if index + 2 < cells.len() {
                cells[index..index + 3].copy_from_slice(&colour);
            }
        }
    }
}

/// The media payload: the cells an update carries, and their colours.
///
/// The protocol never looks inside a media body (MLP spec §5.1): this format
/// is the demo application's own, and the transport carries it as it is.
fn encode_payload(cells: &[u32], capture: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + cells.len() * 5);
    out.extend_from_slice(&(cells.len() as u16).to_le_bytes());
    for index in cells {
        let offset = *index as usize * 3;
        out.extend_from_slice(&(*index as u16).to_le_bytes());
        out.extend_from_slice(capture.get(offset..offset + 3).unwrap_or(&[0, 0, 0]));
    }
    out
}

/// Base64, without a dependency.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let first = group[0];
        let second = group.get(1).copied().unwrap_or(0);
        let third = group.get(2).copied().unwrap_or(0);
        let triple = (u32::from(first) << 16) | (u32::from(second) << 8) | u32::from(third);
        out.push(char::from(ALPHABET[(triple >> 18) as usize & 0x3f]));
        out.push(char::from(ALPHABET[(triple >> 12) as usize & 0x3f]));
        if group.len() > 1 {
            out.push(char::from(ALPHABET[(triple >> 6) as usize & 0x3f]));
        } else {
            out.push('=');
        }
        if group.len() > 2 {
            out.push(char::from(ALPHABET[triple as usize & 0x3f]));
        } else {
            out.push('=');
        }
    }
    out
}

fn main() -> io::Result<()> {
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    let mut lane = Lane::new();
    let commands = receiver;
    lane.emit_capture();
    loop {
        match commands.try_recv() {
            Ok(line) => {
                if line.starts_with("ACK") {
                    lane.on_ack(&line);
                } else if line.starts_with("REPAIR") {
                    lane.on_repair(&line);
                }
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => break,
        }
        lane.tick();
        if let Some(reason) = lane.finished() {
            let line = format!("DONE {} {reason}", lane.now_ms);
            lane.write(&line);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(TICK_MS));
    }
    Ok(())
}
