import { test } from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { createRpcForwarder } from "../lib/server/rpc";
import { rpcClient } from "../lib/chain/client";
import { createRpcLimiter } from "../lib/server/rpc-limiter";
import { rpcPolicy, DEFAULT_RPC_POLICY } from "../lib/chain/rpc-policy";

const payload = (method = "getSlot") => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: [],
});
const clock = () => {
  let time = Date.UTC(2026, 9, 27);
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    wait: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
};

test("paid RPC requests share overall and method limits under concurrent load", async () => {
  const timer = clock();
  const starts: { method: string; at: number }[] = [];
  const forward = createRpcForwarder({
    ...timer,
    getConfiguration: () => ({
      rpc: "https://provider.example",
      cluster: "devnet",
      rpcPolicy: { ...DEFAULT_RPC_POLICY, mode: "paid" },
    }),
    request: async (_url, init) => {
      starts.push({
        method: JSON.parse(String(init?.body)).method,
        at: timer.now(),
      });
      return Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
    },
  });
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      forward(
        payload(
          i % 4 === 0
            ? "sendTransaction"
            : i % 4 === 1
              ? "getProgramAccounts"
              : "getSlot",
        ),
      ),
    ),
  );
  for (const [method, gap] of [
    ["all", 20],
    ["sendTransaction", 200],
    ["getProgramAccounts", 40],
  ] as const) {
    const requests =
      method === "all" ? starts : starts.filter((p) => p.method === method);
    for (let i = 1; i < requests.length; i++)
      assert.ok(
        requests[i].at - requests[i - 1].at >= gap,
        `${method} exceeded its rate`,
      );
  }
  assert.ok(starts.at(-1)!.at - starts[0].at < 300 * 29);
});

test("RPC pacing is shared across clients and survives delayed timers and rate changes", async () => {
  let time = 0;
  const timer = {
    now: () => time,
    wait: async (ms: number) => {
      time += ms + 25;
    },
  };
  const limiter = createRpcLimiter(timer);
  const starts: number[] = [];
  let policy = { ...DEFAULT_RPC_POLICY, mode: "paid" as const };
  const client = () =>
    createRpcForwarder({
      ...timer,
      limiter,
      getConfiguration: () => ({
        rpc: "https://provider.example",
        cluster: "devnet",
        rpcPolicy: policy,
      }),
      request: async () => {
        starts.push(time);
        return Response.json({ result: 1 });
      },
    });
  const a = client(),
    b = client();
  await Promise.all([a(payload()), b(payload()), a(payload()), b(payload())]);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 20);
  policy = { mode: "paid", rps: 1, sendRps: 1, scanRps: 1 };
  await b(payload());
  assert.ok(starts.at(-1)! - starts.at(-2)! >= 1000);
});

test("paid mode validates limits, refuses public endpoints and honors cooldowns without rebroadcasting", async () => {
  for (const settings of [
    { ...DEFAULT_RPC_POLICY, rps: 0 },
    { ...DEFAULT_RPC_POLICY, rps: 1.5 },
    { ...DEFAULT_RPC_POLICY, sendRps: 51 },
    { ...DEFAULT_RPC_POLICY, mode: "fast" },
    { ...DEFAULT_RPC_POLICY, mode: ["paid"] },
  ])
    assert.throws(() => rpcPolicy(settings));
  const policy = { ...DEFAULT_RPC_POLICY, mode: "paid" as const };
  const refused = createRpcForwarder({
    getConfiguration: () => ({
      rpc: "https://api.devnet.solana.com",
      cluster: "devnet",
      rpcPolicy: policy,
    }),
    request: async () => {
      assert.fail("Public RPC must not receive paid traffic");
    },
  });
  await assert.rejects(refused(payload()), /private provider/);
  const timer = clock();
  const starts: number[] = [];
  const forward = createRpcForwarder({
    ...timer,
    getConfiguration: () => ({
      rpc: "https://provider.example",
      cluster: "devnet",
      rpcPolicy: policy,
    }),
    request: async () => {
      starts.push(timer.now());
      return starts.length === 1
        ? new Response("limited", {
            status: 429,
            headers: { "Retry-After": "3" },
          })
        : Response.json({ result: 1 });
    },
  });
  assert.equal((await forward(payload("sendTransaction"))).status, 429);
  assert.equal(starts.length, 1);
  await forward(payload());
  assert.equal(starts[1] - starts[0], 3000);
});
test("public RPC calls are paced and unsigned simulation retries honor Retry-After", async () => {
  const timer = clock();
  const requests: { at: number; body: string }[] = [];
  const forward = createRpcForwarder({
    ...timer,
    request: async (_url, init) => {
      requests.push({ at: timer.now(), body: String(init?.body) });
      return requests.length === 2
        ? new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "3" },
          })
        : Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
    },
  });
  assert.equal((await forward(payload())).status, 200);
  const simulation = { ...payload("simulateTransaction"), params: ["AA=="] };
  const response = await forward(simulation);
  assert.equal(response.status, 200);
  assert.deepEqual(timer.waits, [300, 3000]);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body, JSON.stringify(simulation));
  assert.equal(requests[2].body, requests[1].body);
  assert.equal(requests[2].at - requests[1].at, 3000);
});

test("rate-limit retries are bounded and long cooldowns are never shortened", async () => {
  for (const retryAfter of [null, "120", "Tue, 27 Oct 2026 00:01:00 GMT"]) {
    const timer = clock();
    let calls = 0;
    const forward = createRpcForwarder({
      ...timer,
      request: async () => {
        calls++;
        return new Response("private provider details", {
          status: 429,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        });
      },
    });
    const response = await forward(payload());
    assert.equal(response.status, 429);
    assert.equal(calls, retryAfter ? 1 : 3);
    assert.deepEqual(timer.waits, retryAfter ? [] : [2000, 4000]);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.text()).includes("private"), false);
  }
});

test("broadcasts are sent once even when throttled or the network outcome is uncertain", async () => {
  for (const uncertain of [false, true]) {
    let calls = 0;
    const timer = clock();
    const forward = createRpcForwarder({
      ...timer,
      request: async () => {
        calls++;
        if (uncertain)
          throw new Error("Failed https://provider.example/private-credential");
        return new Response("limited", { status: 429 });
      },
    });
    const response = await forward(payload("sendTransaction"));
    assert.equal(response.status, uncertain ? 502 : 429);
    assert.equal(calls, 1);
    assert.deepEqual(timer.waits, []);
    assert.equal((await response.text()).includes("credential"), false);
  }
});

test("unsupported RPC requests still fail before any upstream call", async () => {
  const forward = createRpcForwarder({
    request: async () => {
      assert.fail("Unexpected upstream call");
    },
  });
  await assert.rejects(forward(payload("requestAirdrop")), /Unsupported/);
  await assert.rejects(forward({ ...payload(), params: {} }), /Unsupported/);
});

test("client reports HTTP failures plainly while retaining lossless Solana decoding", async (t) => {
  let status = 429;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      status === 200
        ? '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":9007199254740993}}'
        : '{"error":"RPC request failed"}',
      { status, headers: { "Content-Type": "application/json" } },
    );
  });
  const rpc = rpcClient("http://127.0.0.1:3100/api/rpc");
  const balance = () =>
    rpc.getBalance(address("11111111111111111111111111111111")).send();
  await assert.rejects(balance(), /RPC rate limit reached \(429\).*journal/);
  assert.equal(calls, 1);
  status = 502;
  await assert.rejects(balance(), /Local RPC request failed \(HTTP 502\)/);
  status = 200;
  assert.equal((await balance()).value, 9007199254740993n);
});
