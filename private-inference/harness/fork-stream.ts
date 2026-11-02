/** Actual local-RPC streaming rehearsal. No transformer/chat or public-network fallback. */
import { createHash, randomBytes } from "node:crypto";
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
import { prepareStreamingCircuit } from "../client/streaming";
import { decodeStreamingDescriptor } from "../protocol/streaming";
import { verifyCompletedStreamingBytes } from "../protocol/streaming-state";
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { recoveryPlan } from "../coordinator/recovery";
import { TransactionCoordinator } from "../coordinator/transactions";
import type { OwnedLocalRpc } from "./transport";
import { verifiedBinary } from "./build.mjs";
import { createProgress, type TestProgress } from "./progress";
const program = getAddressDecoder().decode(new Uint8Array(32).fill(182)),
  enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111"),
  zero = "00".repeat(32);
const hex = (a: Address) => Buffer.from(enc.encode(a)).toString("hex");
const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const inputBits = (value: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((value >>> i) & 1));
const float = (bits: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
};
const raw = (value: number) => {
  if (Number.isNaN(value)) return 0x7fc00000;
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
export type ForkStreamTransport = Pick<
  OwnedLocalRpc,
  "rpc" | "beforeSigning" | "status" | "sendExact" | "localOnly"
>;
export type ForkStreamJournalFactory = (
  path: string,
  rpc: ForkStreamTransport,
) => TransactionCoordinator;
export type ForkStreamScenario = {
  operation: "compare" | "add" | "multiply";
  aBits: number;
  bBits: number;
  interruptAfterWindow?: boolean;
};
export async function runForkStream(
  rpc: ForkStreamTransport,
  state: string,
  progress: TestProgress = createProgress("local stream"),
  scenario: ForkStreamScenario = {
    operation: "compare",
    aBits: 0xbf800000,
    bBits: 0x3f800000,
  },
  createJournal: ForkStreamJournalFactory = (path, transport) =>
    new TransactionCoordinator(path, transport),
) {
  if (
    rpc.localOnly !== true ||
    !["compare", "add", "multiply"].includes(scenario.operation) ||
    [scenario.aBits, scenario.bBits].some(
      (value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff,
    )
  )
    throw Error("stream_local_scenario_required");
  await rpc.beforeSigning();
  const started = performance.now(),
    nonce = randomBytes(32),
    compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32);
  const plan = compiler.finishPlan(
    scenario.operation === "compare"
      ? [compiler.float32OrderedLess(a, b)]
      : scenario.operation === "add"
        ? compiler.float32Add(a, b)
        : compiler.float32Multiply(a, b),
  );
  const key = await progress.run("Prepare fresh whole-circuit garbling", () =>
    prepareStreamingCircuit(plan, nonce, (stage) => {
      if (
        stage.completedGates === 0 ||
        stage.completedGates === stage.totalGates
      )
        progress.log(
          `${stage.stage}: ${stage.completedGates}/${stage.totalGates} public gates, ${stage.windows} windows`,
        );
    }),
  );
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const encoded = key.encode([
        ...inputBits(scenario.aBits),
        ...inputBits(scenario.bBits),
      ]),
      descriptor = Buffer.from(encoded.descriptor),
      shape = decodeStreamingDescriptor(descriptor),
      windowCount = scenario.interruptAfterWindow ? 1 : encoded.windows.length;
    const setupTransactions = 7 + Math.ceil(descriptor.length / 700),
      windowTransactions = encoded.windows
        .slice(0, windowCount)
        .reduce(
          (sum, window) => sum + 3 + Math.ceil(window.records.length / 700),
          0,
        ),
      cleanupTransactions = 5,
      expectedTransactions =
        setupTransactions + windowTransactions + cleanupTransactions;
    const preflight = {
      operation: scenario.operation,
      gates: shape.gateCount,
      windows: encoded.windows.length,
      executedWindows: windowCount,
      physicalSlots: shape.slotCount,
      descriptorBytes: descriptor.length,
      recordBytes: key.resources.recordBytes,
      expectedTransactions,
      estimatedFinalitySeconds: expectedTransactions * 14,
      feeAllowanceLamports: String(
        (expectedTransactions - cleanupTransactions) * 10000,
      ),
      cleanupReserveLamports: "100000",
    };
    progress.log(
      `Preflight: ${preflight.gates} gates/${preflight.executedWindows} windows; ${expectedTransactions} transactions including cleanup. At an illustrative 14s finality/transaction: ${(preflight.estimatedFinalitySeconds / 60).toFixed(1)} minutes. Actual finality remains enabled.`,
    );
    const codeHash = createHash("sha256")
        .update(verifiedBinary("stream"))
        .digest("hex"),
      signer = await generateKeyPairSigner();
    const rent = async (size: number) =>
      Number(
        await rpc.rpc<number | bigint>("getMinimumBalanceForRentExemption", [
          size,
        ]),
      );
    const deposits = await Promise.all(
      [
        256,
        192 + descriptor.length,
        256 + Math.min(128, shape.slotCount) * 40,
        256 + Math.max(0, shape.slotCount - 128) * 40,
        3328,
      ].map(rent),
    );
    let journal = createJournal(join(state, "transactions.json"), rpc);
    // Protected journal creation and concrete budgets precede local funding.
    await journal.initialize({
      feeAllowance: preflight.feeAllowanceLamports,
      rentAllowance: String(deposits.reduce((sum, n) => sum + n, 0)),
      cleanupReserve: preflight.cleanupReserveLamports,
      available: "2000000000",
    });
    const wait = async (signature: string) => {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const status = await rpc.status(signature);
        if (status === "failed") throw Error("stream_transaction_failed");
        if (status === "finalized") return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw Error("stream_finality_timeout");
    };
    await rpc.beforeSigning();
    await progress.run(
      "Fund fresh streaming wallet with locally minted SOL (90s finality timeout)",
      async () =>
        wait(
          await rpc.rpc<string>("requestAirdrop", [signer.address, 2000000000]),
        ),
    );
    const balance = async (account: Address) =>
        Number(
          (
            await rpc.rpc<{ value: number | bigint }>("getBalance", [
              account,
              { commitment: "finalized" },
            ])
          ).value,
        ),
      before = await balance(signer.address);
    if (before < 2000000000) throw Error("stream_local_funding_incomplete");
    const genesis = await rpc.rpc<string>("getGenesisHash"),
      slot = Number(
        await rpc.rpc<number | bigint>("getSlot", [
          { commitment: "finalized" },
        ]),
      );
    const binding: SessionBinding = {
      genesis: hex(address(genesis)),
      program: hex(program),
      codeHash,
      owner: hex(signer.address),
      executor: hex(signer.address),
      sessionNonce: nonce.toString("hex"),
      deployment: zero,
      storageManifest: zero,
      modelPlanRoot: zero,
      paramsRoot: zero,
      evalKeyRoot: zero,
      inputRoot: pagesCommitment([pageCommitment(0, 1, descriptor)]),
      inputBound: 64,
      outputBound: shape.outputs.length,
      maxSteps: encoded.windows.length,
      expirySlot: BigInt(slot + Math.max(10000, expectedTransactions * 200)),
    };
    const [session] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [
          Buffer.from("slm-pi-session"),
          enc.encode(signer.address),
          nonce,
        ],
      }),
      [page] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [Buffer.from("slm-pi-page"), enc.encode(session), u32(0)],
      }),
      slots = await Promise.all(
        [0, 1].map((index) =>
          getProgramDerivedAddress({
            programAddress: program,
            seeds: [
              Buffer.from("slm-pi-slot"),
              enc.encode(session),
              u32(index),
            ],
          }),
        ),
      ),
      [windowAccount] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [Buffer.from("slm-pi-window"), enc.encode(session)],
      });
    const instruction = (
      data: Uint8Array,
      extra: Address[] = [],
    ): Instruction => ({
      programAddress: program,
      data,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: session, role: AccountRole.WRITABLE },
        ...extra.map((account) => ({
          address: account,
          role:
            account === system ? AccountRole.READONLY : AccountRole.WRITABLE,
        })),
      ],
    });
    const read = async (account: Address) => {
      const reply = await rpc.rpc<{
        value: { owner: string; data: [string, string] } | null;
      }>("getAccountInfo", [
        account,
        { encoding: "base64", commitment: "finalized" },
      ]);
      if (
        !reply.value ||
        reply.value.owner !== program ||
        reply.value.data[1] !== "base64"
      )
        throw Error("stream_account_owner");
      return Buffer.from(reply.value.data[0], "base64");
    };
    let fees = 0;
    let refundedLamports = 0n,
      closedAccounts = 0;
    const transactions: {
      operation: string;
      computeUnits: number;
      fee: number;
      wireBytes: number;
      signature: string;
    }[] = [];
    const send = async (
      operation: string,
      ix: Instruction,
      deposit = 0,
      store = journal,
    ) => {
      await rpc.beforeSigning();
      const lifetime = (
        await rpc.rpc<{
          value: {
            blockhash: Blockhash;
            lastValidBlockHeight: number | bigint;
          };
        }>("getLatestBlockhash", [{ commitment: "finalized" }])
      ).value;
      const base = setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: lifetime.blockhash,
            lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
          },
          setTransactionMessageFeePayer(
            signer.address,
            createTransactionMessage({ version: 0 }),
          ),
        ),
        budget: Instruction = {
          programAddress: address(
            "ComputeBudget111111111111111111111111111111",
          ),
          data: Buffer.concat([Buffer.from([2]), u32(200000)]),
        };
      const message = appendTransactionMessageInstruction(
          ix,
          appendTransactionMessageInstruction(budget, base),
        ),
        signed = await signTransaction(
          [signer.keyPair],
          compileTransaction(message),
        ),
        wire = getTransactionEncoder().encode(signed),
        signature = getSignatureFromTransaction(signed);
      if (wire.length > 1232) throw Error("stream_wire_limit");
      await progress.run(
        `${operation}: reserve, submit locally, await finality (90s timeout)`,
        async () => {
          await store.submit({
            operation,
            signature,
            wireBase64: Buffer.from(wire).toString("base64"),
            fee: "10000",
            rent: String(deposit),
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
        throw Error("stream_finalized_execution");
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
    const discover = () =>
      rpc.rpc<
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
    cleanup = async () => {
      const rows = await discover();
      if (rows.some((row) => row.account.data[1] !== "base64"))
        throw Error("stream_recovery_encoding");
      const recovery = await recoveryPlan(
        program,
        signer.address,
        rows.map((row) => ({
          address: address(row.pubkey),
          owner: address(row.account.owner),
          data: Buffer.from(row.account.data[0], "base64"),
          lamports: BigInt(row.account.lamports),
        })),
      );
      if (!recovery.instructions.length) return;
      const store = createJournal(
          join(state, "cleanup", "transactions.json"),
          rpc,
        ),
        start = await balance(signer.address),
        priorFees = fees;
      await store.initialize({
        feeAllowance: "100000",
        rentAllowance: "0",
        cleanupReserve: "0",
        available: String(start),
      });
      for (let index = 0; index < recovery.instructions.length; index++)
        await send(`recover-${index}`, recovery.instructions[index], 0, store);
      if (
        BigInt(await balance(signer.address)) - BigInt(start) !==
        recovery.refundableLamports - BigInt(fees - priorFees)
      )
        throw Error("stream_refund_mismatch");
      if ((await discover()).length !== 0)
        throw Error("stream_recovery_accounts_remain");
      refundedLamports += recovery.refundableLamports;
      closedAccounts += recovery.instructions.length;
    };
    await send(
      "create-session",
      instruction(
        Buffer.concat([
          Buffer.from([0]),
          encodeSession(binding),
          u32(1),
          u64(BigInt(deposits[0])),
        ]),
        [system],
      ),
      deposits[0],
    );
    await send(
      "create-descriptor",
      instruction(
        Buffer.concat([
          Buffer.from([1]),
          u32(0),
          u32(1),
          u32(descriptor.length),
          Buffer.from(pageCommitment(0, 1, descriptor), "hex"),
          u64(BigInt(deposits[1])),
        ]),
        [page, system],
      ),
      deposits[1],
    );
    for (let offset = 0; offset < descriptor.length; offset += 700)
      await send(
        `descriptor-upload-${offset}`,
        instruction(
          Buffer.concat([
            Buffer.from([2]),
            u32(offset),
            descriptor.subarray(offset, offset + 700),
          ]),
          [page],
        ),
      );
    await send("seal-descriptor", instruction(Buffer.from([3]), [page]));
    await send("seal-session", instruction(Buffer.from([4]), [page]));
    for (let index = 0; index < 2; index++)
      await send(
        `create-slot-${index}`,
        instruction(
          Buffer.concat([
            Buffer.from([11]),
            u32(index),
            u64(BigInt(deposits[2 + index])),
          ]),
          [page, slots[index][0], system],
        ),
        deposits[2 + index],
      );
    await send(
      "create-window",
      instruction(
        Buffer.concat([Buffer.from([12]), u64(BigInt(deposits[4]))]),
        [page, windowAccount, slots[0][0], slots[1][0], system],
      ),
      deposits[4],
    );
    for (let index = 0; index < windowCount; index++) {
      progress.log(
        `Execute authenticated window ${index + 1}/${windowCount} (${Math.min(32, shape.gateCount - index * 32)} gates)`,
      );
      const window = encoded.windows[index];
      await send(
        `window-${index}-begin`,
        instruction(Buffer.concat([Buffer.from([13]), u32(index)]), [
          page,
          windowAccount,
        ]),
      );
      for (let offset = 0; offset < window.records.length; offset += 700)
        await send(
          `window-${index}-upload-${offset}`,
          instruction(
            Buffer.concat([
              Buffer.from([14]),
              u32(offset),
              window.records.subarray(offset, offset + 700),
            ]),
            [windowAccount],
          ),
        );
      await send(
        `window-${index}-seal`,
        instruction(
          Buffer.concat([
            Buffer.from([15]),
            ...window.proof.map((hash) => Buffer.from(hash)),
          ]),
          [page, windowAccount],
        ),
      );
      const stateBytes = await read(session);
      await send(
        `window-${index}-step`,
        instruction(
          Buffer.concat([
            Buffer.from([16]),
            encodeStep({
              bindingHash: sessionCommitment(binding),
              expectedStateRoot: stateBytes.subarray(176, 208).toString("hex"),
              sequence: index,
              workUnits: Math.min(32, shape.gateCount - index * 32),
            }),
          ]),
          [page, windowAccount, slots[0][0], slots[1][0]],
        ),
      );
      journal = createJournal(join(state, "transactions.json"), rpc); // Re-open durable coordinator after every finalized continuation.
    }
    let parity = false;
    if (scenario.interruptAfterWindow) {
      progress.log(
        "Destroy decoding state and recover interrupted streaming session by owner discovery",
      );
      key.destroy();
    } else {
      const sessionBytes = await read(session);
      if (
        sessionBytes.length !== 256 ||
        sessionBytes.subarray(112, 144).toString("hex") !==
          sessionCommitment(binding) ||
        sessionBytes.subarray(144, 176).toString("hex") !== binding.inputRoot
      )
        throw Error("stream_completed_binding");
      const labels = await verifyCompletedStreamingBytes({
        session: sessionBytes,
        sessionAddress: Uint8Array.from(enc.encode(session)),
        slots: [await read(slots[0][0]), await read(slots[1][0])],
        slotBumps: [slots[0][1], slots[1][1]],
        descriptor,
      });
      const output = key.decode(labels);
      const expectedComparison = float(scenario.aBits) < float(scenario.bBits);
      parity =
        scenario.operation === "compare"
          ? output[0] === expectedComparison
          : output.reduce(
              (value, bit, index) => (value + (bit ? 2 ** index : 0)) >>> 0,
              0,
            ) ===
            raw(
              Math.fround(
                scenario.operation === "add"
                  ? float(scenario.aBits) + float(scenario.bBits)
                  : float(scenario.aBits) * float(scenario.bBits),
              ),
            );
      if (!parity) throw Error("stream_decryption_parity");
    }
    const completeCleanup = cleanup;
    cleanup = undefined;
    await completeCleanup();
    if (before - (await balance(signer.address)) !== fees)
      throw Error("stream_total_refund");
    if (transactions.length !== expectedTransactions)
      throw Error("stream_transaction_plan_mismatch");
    const result = {
      scope: scenario.interruptAfterWindow
        ? "interrupted encrypted binary32 streaming recovery"
        : "real encrypted binary32 streaming; not transformer/chat",
      operation: scenario.operation,
      parity,
      refundVerified: true,
      clientDecodingKeyDestroyed: !!scenario.interruptAfterWindow,
      gates: shape.gateCount,
      windows: windowCount,
      physicalSlots: shape.slotCount,
      preflight,
      elapsedMs: Math.round(performance.now() - started),
      totalFees: fees,
      recoverableDepositsLamports: String(
        deposits.reduce((sum, n) => sum + n, 0),
      ),
      refundedLamports: String(refundedLamports),
      closedAccounts,
      permanentDepositsLamports: "0",
      worstComputeUnits: Math.max(
        ...transactions.map((transaction) => transaction.computeUnits),
      ),
      worstWireBytes: Math.max(
        ...transactions.map((transaction) => transaction.wireBytes),
      ),
      transactions,
    };
    await writeFile(
      join(state, "stream-evidence.json"),
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
