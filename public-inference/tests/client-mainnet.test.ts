import test from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { MainnetInferenceRpc } from "../client/mainnet-rpc";
import { TransactionCoordinator } from "../../private-inference/coordinator/transactions";

const program = address("11111111111111111111111111111111");
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

test("mainnet checks cluster and simulation before broadcasting exact bytes", async (t) => {
  const calls: { method: string; params: unknown[] }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      const result =
        request.method === "getGenesisHash"
          ? genesis
          : request.method === "getAccountInfo"
            ? { value: { executable: true } }
            : request.method === "simulateTransaction"
              ? { value: { err: null } }
              : "signature";
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  );
  const rpc = new MainnetInferenceRpc("https://rpc.example.invalid", program);
  assert.equal(await rpc.sendExact("wire"), "signature");
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      "getGenesisHash",
      "getAccountInfo",
      "simulateTransaction",
      "sendTransaction",
    ],
  );
  assert.equal(calls[2].params[0], calls[3].params[0]);
  await assert.rejects(rpc.rpc("requestAirdrop", []), /method_not_allowed/);
  assert.throws(
    () => new TransactionCoordinator("unused", rpc as never),
    /local_transport_required/,
  );
});

test("wrong cluster and failed simulation never broadcast", async (t) => {
  for (const failure of ["genesis", "simulation"]) {
    let sends = 0;
    const mock = t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "sendTransaction") sends++;
        const result =
          request.method === "getGenesisHash"
            ? failure === "genesis"
              ? "local"
              : genesis
            : request.method === "getAccountInfo"
              ? { value: { executable: true } }
              : { value: { err: { InstructionError: [0, "error"] } } };
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      },
    );
    await assert.rejects(
      new MainnetInferenceRpc("https://rpc.example.invalid", program).sendExact(
        "wire",
      ),
    );
    assert.equal(sends, 0);
    mock.mock.restore();
  }
});
