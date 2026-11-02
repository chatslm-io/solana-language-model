import { createProgress, type TestProgress } from "./progress";
/** One real encrypted gate on an owned validator, with finalized balance accounting. Not chat. */
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { prepareSingleUseAnd } from "../client/halfgates";
import { recoveryPlan } from "../coordinator/recovery";
import { TransactionCoordinator } from "../coordinator/transactions";
import { verifiedBinary } from "./build.mjs";
import { type OwnedLocalRpc } from "./transport";
const program = getAddressDecoder().decode(new Uint8Array(32).fill(182));
const enc = getAddressEncoder(),
  sys = address("11111111111111111111111111111111");
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
type PrimitiveTransport = Pick<
  OwnedLocalRpc,
  "rpc" | "beforeSigning" | "status" | "sendExact" | "localOnly"
>;
// Dependency injection is only for in-process SBF tests; the CLI always uses protected journals.
type JournalFactory = (
  path: string,
  rpc: PrimitiveTransport,
) => TransactionCoordinator;
const protectedJournal: JournalFactory = (path, rpc) =>
  new TransactionCoordinator(path, rpc);
export type PrimitiveScenario = {
  a: boolean;
  b: boolean;
  interruptUpload?: boolean;
};

export async function runForkPrimitive(
  rpc: PrimitiveTransport,
  state: string,
  progress: TestProgress = createProgress("local fork"),
  scenario: PrimitiveScenario = { a: true, b: false },
  createJournal: JournalFactory = protectedJournal,
) {
  const transactionCount = scenario.interruptUpload ? 5 : 8;
  progress.log(
    `Preparing fresh memory-only local wallet; ${transactionCount} transactions follow funding`,
  );
  const signer = await generateKeyPairSigner();
  await rpc.beforeSigning();
  const wait = async (signature: string) => {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const s = await rpc.status(signature);
      if (s === "failed") throw Error("local_transaction_failed");
      if (s === "finalized") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("local_finalization_timeout");
  };
  await progress.run(
    "Funding local wallet and waiting for finalized airdrop (90s timeout)",
    async () => {
      await wait(
        await rpc.rpc<string>("requestAirdrop", [
          signer.address,
          2_000_000_000,
        ]),
      );
    },
  );
  const balance = async (a: Address) =>
    (
      await rpc.rpc<{ value: number }>("getBalance", [
        a,
        { commitment: "finalized" },
      ])
    ).value;
  const before = await balance(signer.address);
  progress.log(
    "Preparing fresh encrypted AND input and protected transaction journal",
  );
  const nonce = randomBytes(32);
  const key = await prepareSingleUseAnd(nonce, 0);
  let fees = 0;
  let journal = createJournal(join(state, "transactions.json"), rpc);
  await journal.initialize({
    feeAllowance: "100000",
    rentAllowance: "100000000",
    cleanupReserve: "100000",
    available: String(before),
  });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const input = Buffer.from(key.encode(scenario.a, scenario.b));
    const digest = pageCommitment(0, 1, input);
    const genesis = await rpc.rpc<string>("getGenesisHash");
    const slot = await rpc.rpc<number>("getSlot", [
      { commitment: "finalized" },
    ]);
    const binding: SessionBinding = {
      genesis: hex(address(genesis)),
      program: hex(program),
      codeHash: createHash("sha256")
        .update(verifiedBinary("experimental"))
        .digest("hex"),
      owner: hex(signer.address),
      executor: hex(signer.address),
      sessionNonce: nonce.toString("hex"),
      deployment: zero,
      storageManifest: zero,
      modelPlanRoot: zero,
      paramsRoot: zero,
      evalKeyRoot: zero,
      inputRoot: pagesCommitment([digest]),
      inputBound: 1,
      outputBound: 1,
      maxSteps: 1,
      expirySlot: BigInt(slot + 10000),
    };
    const [session] = await getProgramDerivedAddress({
      programAddress: program,
      seeds: [Buffer.from("slm-pi-session"), enc.encode(signer.address), nonce],
    });
    const [page] = await getProgramDerivedAddress({
      programAddress: program,
      seeds: [Buffer.from("slm-pi-page"), enc.encode(session), u32(0)],
    });
    const ix = (data: Uint8Array, extra: Address[] = []): Instruction => ({
      programAddress: program,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: session, role: AccountRole.WRITABLE },
        ...extra.map((a) => ({
          address: a,
          role: a === sys ? AccountRole.READONLY : AccountRole.WRITABLE,
        })),
      ],
      data,
    });
    const receipts: {
      operation: string;
      signature: string;
      computeUnits: number;
      wireBytes: number;
      fee: number;
    }[] = [];
    const send = async (
      operation: string,
      instruction: Instruction,
      rent = 0,
      transactionJournal = journal,
    ) => {
      progress.log(
        `${operation}: preparing transaction (${receipts.length}/${transactionCount} transactions finalized)`,
      );
      await rpc.beforeSigning();
      const latest = await rpc.rpc<{
        value: { blockhash: Blockhash; lastValidBlockHeight: number };
      }>("getLatestBlockhash", [{ commitment: "finalized" }]);
      const message = appendTransactionMessageInstruction(
        instruction,
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: latest.value.blockhash,
            lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
          },
          setTransactionMessageFeePayer(
            signer.address,
            createTransactionMessage({ version: 0 }),
          ),
        ),
      );
      const tx = await signTransaction(
        [signer.keyPair],
        compileTransaction(message),
      );
      const wire = getTransactionEncoder().encode(tx);
      if (wire.length > 1232) throw Error("wire_limit");
      const signature = getSignatureFromTransaction(tx);
      await progress.run(
        `${operation}: reserving budget and submitting locally`,
        () =>
          transactionJournal.submit({
            operation,
            signature,
            wireBase64: Buffer.from(wire).toString("base64"),
            fee: "10000",
            rent: String(rent),
          }),
      );
      await progress.run(
        `${operation}: waiting for finalization (90s timeout)`,
        () => wait(signature),
      );
      await transactionJournal.reconcile(operation);
      const detail = await rpc.rpc<{
        meta: { err: unknown; fee: number; computeUnitsConsumed: number };
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
        detail.meta.computeUnitsConsumed > 200000
      )
        throw Error("finalized_execution_invalid");
      fees += detail.meta.fee;
      receipts.push({
        operation,
        signature,
        computeUnits: detail.meta.computeUnitsConsumed,
        wireBytes: wire.length,
        fee: detail.meta.fee,
      });
    };
    cleanup = async () => {
      progress.log("Recovery scan: checking for remaining owner accounts");
      const discovered = await rpc.rpc<
        {
          pubkey: string;
          account: { owner: string; data: [string, string]; lamports: number };
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
        discovered.map((a) => ({
          address: address(a.pubkey),
          owner: address(a.account.owner),
          data: Buffer.from(a.account.data[0], "base64"),
          lamports: BigInt(a.account.lamports),
        })),
      );
      if (!plan.instructions.length) {
        progress.log("Recovery scan complete: no accounts remain");
        return;
      }
      progress.log(
        `Recovery required: ${plan.instructions.length} close transactions`,
      );
      const recoveryJournal = createJournal(
        join(state, "cleanup", "transactions.json"),
        rpc,
      );
      const recoveryBefore = await balance(signer.address),
        feesBefore = fees;
      await recoveryJournal.initialize({
        feeAllowance: "100000",
        rentAllowance: "0",
        cleanupReserve: "0",
        available: String(recoveryBefore),
      });
      for (let i = 0; i < plan.instructions.length; i++)
        await send(`recovery-${i}`, plan.instructions[i], 0, recoveryJournal);
      if (
        BigInt(await balance(signer.address)) - BigInt(recoveryBefore) !==
        plan.refundableLamports - BigInt(fees - feesBefore)
      )
        throw Error("cleanup_refund_mismatch");
    };
    const sessionRent = await rpc.rpc<number>(
      "getMinimumBalanceForRentExemption",
      [256],
    );
    const pageRent = await rpc.rpc<number>(
      "getMinimumBalanceForRentExemption",
      [192 + input.length],
    );
    await send(
      "create",
      ix(
        Buffer.concat([
          Buffer.from([0]),
          encodeSession(binding),
          u32(1),
          u64(BigInt(sessionRent)),
        ]),
        [sys],
      ),
      sessionRent,
    );
    await send(
      "page",
      ix(
        Buffer.concat([
          Buffer.from([1]),
          u32(0),
          u32(1),
          u32(input.length),
          Buffer.from(digest, "hex"),
          u64(BigInt(pageRent)),
        ]),
        [page, sys],
      ),
      pageRent,
    );
    await send(
      "upload",
      ix(
        Buffer.concat([
          Buffer.from([2]),
          u32(0),
          scenario.interruptUpload ? input.subarray(0, 64) : input,
        ]),
        [page],
      ),
    );
    if (scenario.interruptUpload) {
      progress.log(
        "Interrupting partial upload deliberately; destroying client decoding key before recovery",
      );
      key.destroy();
      await cleanup();
      if (before - (await balance(signer.address)) !== fees)
        throw Error("interrupted_refund_balance_mismatch");
      for (const account of [session, page]) {
        const closed = await rpc.rpc<{ value: unknown }>("getAccountInfo", [
          account,
          { commitment: "finalized" },
        ]);
        if (closed.value !== null)
          throw Error("interrupted_account_not_closed");
      }
      const evidence = {
        scope:
          "deliberately interrupted partial upload; discovery recovery without client decoding key",
        interruptedBeforeEvaluation: true,
        clientDecodingKeyDestroyed: true,
        refundVerified: true,
        totalFees: fees,
        recoveredRent: sessionRent + pageRent,
        transactions: receipts,
      };
      await writeFile(
        join(state, "primitive-evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      progress.log(
        `PASS: interrupted upload recovered ${sessionRent + pageRent} rent lamports; fees ${fees}`,
      );
      return evidence;
    }
    progress.log(
      "Reopening the durable coordinator journal after upload (client and validator remain running)",
    );
    journal = createJournal(join(state, "transactions.json"), rpc);
    await send("seal-page", ix(Buffer.from([3]), [page]));
    await send("seal-session", ix(Buffer.from([4]), [page]));
    await send(
      "evaluate",
      ix(
        Buffer.concat([
          Buffer.from([5]),
          encodeStep({
            bindingHash: sessionCommitment(binding),
            expectedStateRoot: zero,
            sequence: 0,
            workUnits: 1,
          }),
        ]),
        [page],
      ),
    );
    progress.log("Verifying finalized output bindings and decrypting locally");
    const result = await rpc.rpc<{
      value: { owner: string; data: [string, string] } | null;
    }>("getAccountInfo", [
      session,
      { encoding: "base64", commitment: "finalized" },
    ]);
    if (!result.value || result.value.owner !== program)
      throw Error("result_owner");
    const data = Buffer.from(result.value.data[0], "base64");
    if (
      data.length !== 256 ||
      data[10] !== 3 ||
      data.subarray(112, 144).toString("hex") !== sessionCommitment(binding)
    )
      throw Error("result_binding");
    if (key.decode(data.subarray(176, 208)) !== (scenario.a && scenario.b))
      throw Error("decryption_parity");
    await send("close-page", ix(Buffer.from([7]), [page]));
    await send("close-session", ix(Buffer.from([8])));
    progress.log("Verifying finalized refund balances and closed accounts");
    if (before - (await balance(signer.address)) !== fees)
      throw Error("refund_balance_mismatch");
    for (const a of [session, page]) {
      const value = await rpc.rpc<{ value: unknown }>("getAccountInfo", [
        a,
        { commitment: "finalized" },
      ]);
      if (value.value !== null) throw Error("account_not_closed");
    }
    const evidence = {
      scope:
        "real single encrypted AND in local validator; not transformer/chat",
      truthTableCase: `${scenario.a} AND ${scenario.b}`,
      parity: true,
      refundVerified: true,
      totalFees: fees,
      recoveredRent: sessionRent + pageRent,
      transactions: receipts,
    };
    await writeFile(
      join(state, "primitive-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    progress.log(
      `Verified rent recovery: ${sessionRent + pageRent} lamports; fees: ${fees} local lamports`,
    );
    return evidence;
  } finally {
    try {
      await cleanup?.();
    } finally {
      key.destroy();
    }
  }
}
