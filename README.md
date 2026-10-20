# mlp-demo

A demo of the **Media Lane Protocol (MLP)**: a session that carries updates,
acknowledges them, and heals a loss.

MLP is a transport for real-time interactive media over links that are slow,
lossy, or both. A *lane* carries three kinds of traffic and keeps them apart:

- **control** — the handshake, the session's continuity, and its teardown;
- **media** — the updates a sender produces, moved whole and in order;
- **feedback** — what the receiver applied, how fast the link is, and what an
  intermediary dropped.

The design goal is that a receiver never holds a state it cannot verify, and a
sender always knows what to re-send, under a rate it measured.

This repository is the shortest honest path from nothing to that working: a
sender that produces updates, a lane that carries them, a receiver that
applies and acknowledges them, a link that loses something on purpose, and the
repair that heals it.

## Running it

You need Node 20.11 or newer and a Rust toolchain (1.85 or newer).

```bash
git clone https://github.com/medialaneprotocol/mlp-demo
cd mlp-demo
npm install
npm start
```

Then open <http://localhost:8080>.

`npm start` builds the browser bundle and the lane, and serves the page. The
page opens the lane, and the session takes about three seconds.

## What it shows

The page has two panes, a table and a log.

- **The sender's capture** — the surface the sender holds: a block that moves
  and changes colour.
- **The receiver's surface** — the surface the receiver painted from the
  updates it was sent.
- **The table** — the counters: the updates and the bytes that were sent, the
  fragments that were dropped, the cells the sender still owes, the cells the
  receiver believes are stale, the updates the acknowledgement does not cover,
  the sender's pace and its per-update budget, and how long the healing took.
- **The log** — the session, line by line: what the sender sent, what the lane
  dropped, what the receiver applied, and what it acknowledged.

The session runs like this:

```
 300 ms  update 1 (delta) carries 6 cells
 390 ms  the receiver acknowledged up to update 1 (0 cells stale)
 600 ms  update 2 (delta) carries 12 cells
 730 ms  the receiver acknowledged up to update 2 (0 cells stale)
 900 ms  update 3 (delta) carries 12 cells
 900 ms  the lane dropped a fragment on purpose
1200 ms  update 4 (anchor) carries 16 cells
1270 ms  the receiver acknowledged up to update 4 (0 cells stale)
```

The third update never arrives. The receiver's acknowledgement does not cover
it, so the sender still owes its cells; after the repair delay the sender
sends them again — as an anchor, because the receiver may not be able to chain
them — and the surfaces meet. The table says how long that took.

The lane drops the third fragment on purpose, so the loss is always the thing
you see. Everything else about the link is the protocol crate's own T2
profile: a 150 ms round trip, one megabit down, and the crate's own pacing.

## The budgets

Every number the page prints is measured, and every measurement is printed next
to the budget it is held to.

| measurement | budget | where it comes from |
|---|---|---|
| the bytes of one update | the sender's per-update budget (8 192 bytes at the T2 pace) | the protocol's own estimator |
| the healing | 2 000 ms | the demo's budget |
| the acknowledgement's window | 64 updates | the protocol's own window |

The byte budget is the sender's: the lane reports the estimator's budget, and
the sender's accounting enforces it. The healing budget is the demo's, and it
is declared in `web/budgets.ts`.

## The headless run

The same receiver, without a browser:

```bash
npm run headless
```

It plays the receiver's half of a session against the lane, and it asserts
that the session carried the updates, that the loss happened, that the repair
healed it inside the budget, and that the two surfaces met.

```
the session
  updates sent      9
  bytes sent        1124
  fragments         9 released, 1 dropped
  updates applied   8 (1, 2, 4, 5, 6, 7, 8, 9)
  pending cells     0
  stale cells       0
  missing updates   3
  the healing       500 ms, the budget is 2000 ms
  the run           converged
```

The gate that checks all of it:

```bash
bash scripts/verify.sh
```

It type-checks the demo, builds the bundle and the lane, and runs the headless
run.

## The layout

| path | what it holds |
|---|---|
| `rust/src/main.rs` | the lane: it captures a surface, encodes updates with the protocol's sender, carries them over the protocol's lossy link, and drops one fragment on purpose |
| `web/receiver.ts` | the receiver: it decodes the fragments with the published browser package, applies what the protocol delivered, and acknowledges it |
| `web/app.ts` | the browser page |
| `web/budgets.ts` | the budgets, and where they come from |
| `scripts/serve.mjs` | the server: the page, the event stream, and the acknowledgements |
| `scripts/headless.mjs` | the headless run, and the assertions |
| `scripts/verify.sh` | the gate |

The lane and the receiver speak a line protocol: the lane's events go out on
its stdout, and the receiver's acknowledgements come back on its stdin. The
protocol's own bytes travel inside it, untouched.

## The revisions this demo pins

| what | repository | revision |
|---|---|---|
| the protocol (the sender) | [`mlp-core`](https://github.com/medialaneprotocol/mlp-core) | `d1c257d0bed5e2ae23371217cde8bda87f0656aa` |
| the protocol (the browser) | [`mlp-ts`](https://github.com/medialaneprotocol/mlp-ts) | `d758302034026805155d296173d4772f7935b01b` |
| the wire schemas | [`mlp-proto`](https://github.com/medialaneprotocol/mlp-proto) | `624865f57952ec4fb730fca6b14fa93a89152cda` |

The demo consumes them the way any consumer does: it depends on them at a
pinned revision and it carries no copy of any of them.

## The rest of the protocol

| repository | what it holds |
|---|---|
| [`mlp`](https://github.com/medialaneprotocol/mlp) | the specification |
| [`mlp-core`](https://github.com/medialaneprotocol/mlp-core) | the Rust implementation, the source of truth for every number and every rule |
| [`mlp-ts`](https://github.com/medialaneprotocol/mlp-ts) | the browser implementation |
| [`mlp-proto`](https://github.com/medialaneprotocol/mlp-proto) | the wire schemas |
| [`mlp-conformance`](https://github.com/medialaneprotocol/mlp-conformance) | the conformance corpus and its gate |

## Licence

Apache-2.0. See [LICENSE](LICENSE).
