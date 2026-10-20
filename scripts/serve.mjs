/**
 * The demo's server: one command, one URL.
 *
 * It builds the browser bundle and the lane, serves the page, and bridges the
 * page and the lane: the lane's events go out over a server-sent event
 * stream, and the page's acknowledgements go back to the lane.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { buildLane, publicDir, startLane } from "./lib.mjs";

await import("./build.mjs");
buildLane();

/** The clients that watch the lane. */
const clients = new Set();
/** The lane, while it runs. */
let lane = null;

/** Start the lane, if it is not running. */
function ensureLane() {
  if (lane !== null) {
    return;
  }
  lane = startLane();
  let buffered = "";
  lane.stdout.setEncoding("utf8");
  lane.stdout.on("data", (piece) => {
    buffered += piece;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line !== "") {
        broadcast(line);
      }
      newline = buffered.indexOf("\n");
    }
  });
  lane.on("exit", () => {
    lane = null;
  });
}

/** Tell every client what the lane said. */
function broadcast(line) {
  for (const client of clients) {
    client.write(`data: ${line}\n\n`);
  }
}

/** Send a line to the lane. */
function toLane(line) {
  ensureLane();
  if (lane === null) {
    return;
  }
  lane.stdin.write(`${line}\n`);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": the lane\n\n");
    clients.add(response);
    ensureLane();
    request.on("close", () => {
      clients.delete(response);
    });
    return;
  }
  if (path === "/ack" || path === "/repair") {
    let body = "";
    request.on("data", (piece) => {
      body += piece;
    });
    request.on("end", () => {
      toLane(body.trim());
      response.writeHead(204).end();
    });
    return;
  }
  if (path === "/run") {
    if (lane !== null) {
      lane.kill();
      lane = null;
    }
    ensureLane();
    response.writeHead(204).end();
    return;
  }
  const name = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const file = join(publicDir, normalize(name));
  if (!file.startsWith(publicDir)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  readFile(file)
    .then((body) => {
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    })
    .catch(() => {
      response.writeHead(404).end("not found");
    });
});

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
server.listen(port, () => {
  console.log(`mlp-demo: open http://localhost:${port}`);
});
