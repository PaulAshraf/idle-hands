import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createInterface } from "node:readline";

test(
  "follow buffers during backfill, reconnects, and deduplicates overlapping sequences",
  { timeout: 10000 },
  async (t) => {
    let connections = 0;
    const cursors: string[] = [];
    const event = (seq: number) => ({
      type: "event",
      event: { seq, goalId: "tsp", type: "message.created", data: { body: "test" } },
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      assert.equal(url.searchParams.get("goalId"), "tsp");
      const after = url.searchParams.get("after");
      const seq = after === null ? [1] : after === "1" ? [2, 3] : [4, 5];
      if (after !== null) cursors.push(after);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ events: seq.map((i) => event(i).event), latestSeq: seq.at(-1) }));
    });
    server.on("upgrade", (req, socket) => {
      connections++;
      const accept = createHash("sha1")
        .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Accept: " + accept,
          "",
          "",
        ].join("\r\n"),
      );
      const frame = Buffer.from(JSON.stringify(event(connections === 1 ? 3 : 6)));
      socket.write(Buffer.concat([Buffer.from([0x81, frame.length]), frame]));
      if (connections === 1) setTimeout(() => socket.end(Buffer.from([0x88, 0])), 200);
      t.after(() => socket.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "feed",
      "--goal",
      "tsp",
      "--follow",
      "--json",
      "--server",
      "http://127.0.0.1:" + address.port,
    ]);
    t.after(() => child.kill());
    const seq: number[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      seq.push(JSON.parse(line).seq);
      if (seq.at(-1) === 6) break;
    }
    assert.deepEqual(seq, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(cursors, ["1", "3"]);
  },
);
