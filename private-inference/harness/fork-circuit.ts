/** Experimental bounded-circuit rehearsal, never a transformer/chat fallback. */
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type Blockhash,
} from "@solana/kit";
import { CircuitBuilder } from "../compiler/circuit";
import { prepareCircuit } from "../client/circuit";
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { verifyCompletedCircuitBytes } from "../protocol/circuit-state";
import { recoveryPlan } from "../coordinator/recovery";
import { TransactionCoordinator } from "../coordinator/transactions";
import { type OwnedLocalRpc } from "./transport";
import { verifiedBinary } from "./build.mjs";
import { createProgress, type TestProgress } from "./progress";
const program = getAddressDecoder().decode(new Uint8Array(32).fill(182)),
  enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111");
const hex = (a: Address) => Buffer.from(enc.encode(a)).toString("hex");
const u32 = (x: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(x);
  return b;
};
const u64 = (x: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(x);
  return b;
};
const zero = "00".repeat(32);
type Transport = Pick<
  OwnedLocalRpc,
  "rpc" | "beforeSigning" | "status" | "sendExact" | "localOnly"
>;
type JournalFactory = (path: string, rpc: Transport) => TransactionCoordinator;
export async function runForkCircuit(
  rpc: Transport,
  state: string,
  progress: TestProgress = createProgress("local circuit"),
  scenario = { left: -128, right: 127, interruptAfterStep: false },
  createJournal: JournalFactory = (p, r) => new TransactionCoordinator(p, r),
) {
  const signer = await generateKeyPairSigner();
  await rpc.beforeSigning();
  const wait = async (sig: string) => {
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const v = await rpc.status(sig);
      if (v === "failed") throw Error("circuit_transaction_failed");
      if (v === "finalized") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("circuit_finality_timeout");
  };
  await progress.run("Funding fresh circuit wallet locally", async () =>
    wait(
      await rpc.rpc<string>("requestAirdrop", [signer.address, 2_000_000_000]),
    ),
  );
  const balance = async (a: Address) =>
    Number(
      (
        await rpc.rpc<{ value: number | bigint }>("getBalance", [
          a,
          { commitment: "finalized" },
        ])
      ).value,
    );
  const before = await balance(signer.address),
    nonce = randomBytes(32),
    builder = new CircuitBuilder(16);
  const aa = Array.from({ length: 8 }, (_, i) => i),
    bb = aa.map((i) => i + 8),
    less = builder.signedLess(aa, bb),
    sum = builder.add(aa, bb),
    selected = builder.muxWord(less, aa, bb),
    graph = builder.finish([less, ...sum, ...selected]);
  const key = await prepareCircuit(graph, nonce);
  const bits = (n: number) =>
    Array.from({ length: 8 }, (_, i) => Boolean((n >> i) & 1));
  const artifact = Buffer.from(
    key.encode([...bits(scenario.left), ...bits(scenario.right)]),
  );
  const chunks: Buffer[] = [];
  for (let i = 0; i < artifact.length; i += 8192)
    chunks.push(artifact.subarray(i, i + 8192));
  let journal = createJournal(join(state, "transactions.json"), rpc);
  await journal.initialize({
    feeAllowance: "1000000",
    rentAllowance: "200000000",
    cleanupReserve: "100000",
    available: String(before),
  });
  let cleanup: (() => Promise<void>) | undefined;
  let fees = 0;
  const transactions: {
    operation: string;
    computeUnits: number;
    fee: number;
    wireBytes: number;
    signature: string;
  }[] = [];
  try {
    const genesis = await rpc.rpc<string>("getGenesisHash"),
      slot = Number(
        await rpc.rpc<number | bigint>("getSlot", [
          { commitment: "finalized" },
        ]),
      );
    const binding: SessionBinding = {
      genesis: hex(address(genesis)),
      program: hex(program),
      codeHash: createHash("sha256")
        .update(verifiedBinary("circuit"))
        .digest("hex"),
      owner: hex(signer.address),
      executor: hex(signer.address),
      sessionNonce: nonce.toString("hex"),
      deployment: zero,
      storageManifest: zero,
      modelPlanRoot: zero,
      paramsRoot: zero,
      evalKeyRoot: zero,
      inputRoot: pagesCommitment(chunks.map((x, i) => pageCommitment(i, 1, x))),
      inputBound: 16,
      outputBound: 17,
      maxSteps: Math.ceil(graph.gates.length / 32),
      expirySlot: BigInt(slot + 10000),
    };
    const [session] = await getProgramDerivedAddress({
      programAddress: program,
      seeds: [Buffer.from("slm-pi-session"), enc.encode(signer.address), nonce],
    });
    const pages = await Promise.all(
      chunks.map(
        async (_, i) =>
          (
            await getProgramDerivedAddress({
              programAddress: program,
              seeds: [Buffer.from("slm-pi-page"), enc.encode(session), u32(i)],
            })
          )[0],
      ),
    );
    const [scratch, scratchBump] = await getProgramDerivedAddress({
      programAddress: program,
      seeds: [Buffer.from("slm-pi-wires"), enc.encode(session)],
    });
    const ix = (data: Uint8Array, extra: Address[] = []): Instruction => ({
      programAddress: program,
      data,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: session, role: AccountRole.WRITABLE },
        ...extra.map((a) => ({
          address: a,
          role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
        })),
      ],
    });
    const read = async (a: Address) => {
      const r = await rpc.rpc<{
        value: {
          owner: string;
          data: [string, string];
          lamports: number | bigint;
        } | null;
      }>("getAccountInfo", [
        a,
        { encoding: "base64", commitment: "finalized" },
      ]);
      if (!r.value || r.value.owner !== program || r.value.data[1] !== "base64")
        throw Error("circuit_account_owner");
      return Buffer.from(r.value.data[0], "base64");
    };
    const send = async (
      operation: string,
      instruction: Instruction,
      rent = 0,
      store = journal,
    ) => {
      await rpc.beforeSigning();
      const b = (
        await rpc.rpc<{
          value: {
            blockhash: Blockhash;
            lastValidBlockHeight: number | bigint;
          };
        }>("getLatestBlockhash", [{ commitment: "finalized" }])
      ).value;
      const base = setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: b.blockhash,
          lastValidBlockHeight: BigInt(b.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          signer.address,
          createTransactionMessage({ version: 0 }),
        ),
      );
      const budget: Instruction = {
        programAddress: address("ComputeBudget111111111111111111111111111111"),
        data: Buffer.concat([Buffer.from([2]), u32(200000)]),
      };
      const message = appendTransactionMessageInstruction(
        instruction,
        appendTransactionMessageInstruction(budget, base),
      );
      const signed = await signTransaction(
          [signer.keyPair],
          compileTransaction(message),
        ),
        wire = getTransactionEncoder().encode(signed),
        signature = getSignatureFromTransaction(signed);
      if (wire.length > 1232) throw Error("circuit_wire_limit");
      await progress.run(
        `${operation}: reserve, submit locally and await finality`,
        async () => {
          await store.submit({
            operation,
            signature,
            wireBase64: Buffer.from(wire).toString("base64"),
            fee: "10000",
            rent: String(rent),
          });
          await wait(signature);
          await store.reconcile(operation);
        },
      );
      const detail = await rpc.rpc<{
        meta: {
          err: unknown;
          fee: number | bigint;
          computeUnitsConsumed: number | bigint;
        };
      }>("getTransaction", [
        signature,
        {
          encoding: "json",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (
        !detail ||
        detail.meta.err ||
        Number(detail.meta.computeUnitsConsumed) > 200000
      )
        throw Error("circuit_finalized_execution");
      const fee = Number(detail.meta.fee);
      fees += fee;
      transactions.push({
        operation,
        signature,
        fee,
        computeUnits: Number(detail.meta.computeUnitsConsumed),
        wireBytes: wire.length,
      });
    };
    cleanup = async () => {
      const rows = await rpc.rpc<
        {
          pubkey: string;
          account: {
            owner: string;
            data: [string, string];
            lamports: number | bigint;
          };
        }[]
      >("getProgramAccounts", [
        program,
        {
          encoding: "base64",
          commitment: "finalized",
          filters: [{ memcmp: { offset: 16, bytes: signer.address } }],
        },
      ]);
      const plan = await recoveryPlan(
        program,
        signer.address,
        rows.map((r) => ({
          address: address(r.pubkey),
          owner: address(r.account.owner),
          data: Buffer.from(r.account.data[0], "base64"),
          lamports: BigInt(r.account.lamports),
        })),
      );
      if (!plan.instructions.length) return;
      const store = createJournal(
          join(state, "cleanup", "transactions.json"),
          rpc,
        ),
        start = await balance(signer.address),
        previousFees = fees;
      await store.initialize({
        feeAllowance: "100000",
        rentAllowance: "0",
        cleanupReserve: "0",
        available: String(start),
      });
      for (let i = 0; i < plan.instructions.length; i++)
        await send(`recover-${i}`, plan.instructions[i], 0, store);
      if (
        BigInt(await balance(signer.address)) - BigInt(start) !==
        plan.refundableLamports - BigInt(fees - previousFees)
      )
        throw Error("circuit_refund_mismatch");
    };
    const rent = async (n: number) =>
      Number(
        await rpc.rpc<number | bigint>("getMinimumBalanceForRentExemption", [
          n,
        ]),
      );
    const sr = await rent(256);
    await send(
      "create-session",
      ix(
        Buffer.concat([
          Buffer.from([0]),
          encodeSession(binding),
          u32(chunks.length),
          u64(BigInt(sr)),
        ]),
        [system],
      ),
      sr,
    );
    for (let i = 0; i < chunks.length; i++) {
      const pr = await rent(192 + chunks[i].length);
      await send(
        `create-page-${i}`,
        ix(
          Buffer.concat([
            Buffer.from([1]),
            u32(i),
            u32(1),
            u32(chunks[i].length),
            Buffer.from(pageCommitment(i, 1, chunks[i]), "hex"),
            u64(BigInt(pr)),
          ]),
          [pages[i], system],
        ),
        pr,
      );
      for (let offset = 0; offset < chunks[i].length; offset += 700)
        await send(
          `upload-${i}-${offset}`,
          ix(
            Buffer.concat([
              Buffer.from([2]),
              u32(offset),
              chunks[i].subarray(offset, offset + 700),
            ]),
            [pages[i]],
          ),
        );
      await send(`seal-page-${i}`, ix(Buffer.from([3]), [pages[i]]));
    }
    await send("seal-session", ix(Buffer.from([4]), pages));
    const wr = await rent(256 + (graph.inputCount + graph.gates.length) * 32);
    await send(
      "initialize-wires",
      ix(Buffer.concat([Buffer.from([9]), u64(BigInt(wr))]), [
        scratch,
        system,
        ...pages,
      ]),
      wr,
    );
    for (let sequence = 0; sequence < binding.maxSteps; sequence++) {
      const sd = await read(session);
      await send(
        `step-${sequence}`,
        ix(
          Buffer.concat([
            Buffer.from([5]),
            encodeStep({
              bindingHash: sessionCommitment(binding),
              expectedStateRoot: sd.subarray(176, 208).toString("hex"),
              sequence,
              workUnits: Math.min(32, graph.gates.length - sequence * 32),
            }),
          ]),
          [scratch, ...pages],
        ),
      );
      journal = createJournal(join(state, "transactions.json"), rpc); // Re-open durable coordinator after each finalized bounded step.
      if (scenario.interruptAfterStep) {
        progress.log(
          "Destroying decoding state and recovering interrupted circuit",
        );
        key.destroy();
        await cleanup();
        cleanup = undefined;
        const result = {
          scope: "interrupted encrypted circuit recovery",
          refundVerified: before - (await balance(signer.address)) === fees,
          clientDecodingKeyDestroyed: true,
          totalFees: fees,
          transactions,
        };
        if (!result.refundVerified) throw Error("circuit_total_refund");
        await writeFile(
          join(state, "circuit-evidence.json"),
          JSON.stringify(result, null, 2) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        return result;
      }
    }
    const sd = await read(session),
      wd = await read(scratch);
    if (
      sd.length !== 256 ||
      sd[10] !== 3 ||
      sd.subarray(112, 144).toString("hex") !== sessionCommitment(binding) ||
      wd.length !== 256 + (graph.inputCount + graph.gates.length) * 32 ||
      !wd.subarray(0, 8).equals(Buffer.from("SLMPIW01")) ||
      wd[10] !== 3 ||
      wd.readUInt32LE(156) !== graph.gates.length ||
      !wd
        .subarray(80, 112)
        .equals(Buffer.from(sessionCommitment(binding), "hex")) ||
      !wd.subarray(160, 192).equals(sd.subarray(176, 208))
    )
      throw Error("circuit_completed_binding");
    const verifiedInputRoot = pagesCommitment(
      chunks.map((payload, index) => pageCommitment(index, 1, payload)),
    );
    if (
      verifiedInputRoot !== binding.inputRoot ||
      sd.subarray(144, 176).toString("hex") !== verifiedInputRoot
    )
      throw Error("circuit_artifact_binding");
    const verifiedLabels = await verifyCompletedCircuitBytes({
      scratch: wd,
      session: sd,
      sessionAddress: Uint8Array.from(enc.encode(session)),
      scratchBump,
      artifact,
    });
    const out = key.decode(verifiedLabels);
    const value = (bits: boolean[]) =>
      bits.reduce((n, x, i) => n + (x ? 2 ** i : 0), 0);
    if (
      out[0] !== scenario.left < scenario.right ||
      value(out.slice(1, 9)) !== ((scenario.left + scenario.right) & 255) ||
      value(out.slice(9, 17)) !==
        (Math.min(scenario.left, scenario.right) & 255)
    )
      throw Error("circuit_decryption_parity");
    await cleanup();
    cleanup = undefined;
    if (before - (await balance(signer.address)) !== fees)
      throw Error("circuit_total_refund");
    const result = {
      scope:
        "real compiled encrypted signed8 comparator/add/mux; not transformer/chat",
      parity: true,
      refundVerified: true,
      gates: graph.gates.length,
      steps: binding.maxSteps,
      artifactBytes: artifact.length,
      totalFees: fees,
      transactions,
    };
    await writeFile(
      join(state, "circuit-evidence.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return result;
  } finally {
    try {
      await cleanup?.();
    } finally {
      key.destroy();
    }
  }
}
