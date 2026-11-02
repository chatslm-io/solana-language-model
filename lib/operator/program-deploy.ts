import { randomBytes } from "node:crypto";
import {
  address,
  getAddressDecoder,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type KeyPairSigner,
  type Instruction,
  type TransactionMessageBytesBase64,
  type Base64EncodedWireTransaction,
  signature,
} from "@solana/kit";
import {
  account,
  chainCheck,
  describeRpcError,
  verifyClosure,
  type RPC,
} from "@/lib/chain/client";
import { base64, sha256 } from "@/lib/chain/protocol";
import {
  LOADER,
  BUFFER_HEADER,
  PROGRAM_SIZE,
  PROGRAM_DATA_HEADER,
  PROGRAM_CHUNK,
  loaderAddresses,
  createSeeded,
  initializeBuffer,
  writeBuffer,
  deployProgram,
  closeBuffer,
  loaderTransaction,
} from "@/lib/chain/loader";
import type { OperatorConfig } from "./config";
import type {
  ProgramJob,
  ProgramReceipt,
  PublicProgramJob,
} from "./program-types";
import { mapConcurrent } from "@/lib/chain/parallel";

const digest = (bytes: Uint8Array) => sha256(bytes);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
export function publicProgram(
  job: ProgramJob,
  busy: boolean,
): PublicProgramJob {
  const { journal, nonce, ...view } = job;
  void nonce;
  if (!busy && view.phase === "running") {
    view.phase = "paused";
    view.message =
      "Process stopped. Resume checks saved signatures before continuing.";
  }
  return { ...view, lastSignature: journal.at(-1)?.signature };
}
export async function quoteProgram(
  config: OperatorConfig,
  rpc: RPC,
  signer: KeyPairSigner,
  binary: Uint8Array,
): Promise<ProgramJob> {
  await chainCheck(rpc, { ...config, program: LOADER });
  const nonce = randomBytes(15).toString("hex"),
    a = await loaderAddresses(signer.address, nonce);
  const [bufferRent, programRent, codeRent] = await Promise.all(
    [
      BUFFER_HEADER + binary.length,
      PROGRAM_SIZE,
      PROGRAM_DATA_HEADER + binary.length,
    ].map((size) => rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()),
  );
  const life = (
    await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  ).value;
  const { tx } = loaderTransaction(
    signer.address,
    [
      createSeeded(
        signer.address,
        a.buffer,
        a.bufferSeed,
        BUFFER_HEADER + binary.length,
        bufferRent,
      ),
      initializeBuffer(signer.address, a.buffer),
    ],
    life,
  );
  const fee = (
    await rpc
      .getFeeForMessage(
        base64(
          Uint8Array.from(tx.messageBytes),
        ) as TransactionMessageBytesBase64,
        { commitment: "confirmed" },
      )
      .send()
  ).value;
  if (fee === null) throw new Error("Program deployment fee quote unavailable");
  const total = Math.ceil(binary.length / PROGRAM_CHUNK) + 2;
  const estimatedFees = fee * BigInt(total),
    feeBudget = min(estimatedFees * 2n, BigInt(config.maxFees));
  const deposit = max(bufferRent, programRent + codeRent);
  if (
    deposit > BigInt(config.maxDeposit) ||
    feeBudget < estimatedFees ||
    total > config.maxTransactions
  )
    throw new Error(
      "Program deployment exceeds the configured deposit, fee or transaction cap",
    );
  return {
    id: randomBytes(32).toString("hex"),
    cluster: config.cluster,
    owner: signer.address,
    nonce,
    program: a.program,
    programData: a.programData,
    buffer: a.buffer,
    binaryHash: await digest(binary),
    binaryBytes: binary.length,
    bufferRent: String(bufferRent),
    programRent: String(programRent),
    codeRent: String(codeRent),
    deposit: String(deposit),
    estimatedFees: String(estimatedFees),
    feeBudget: String(feeBudget),
    feesReserved: "0",
    recoveryFeeBudget: String(fee * 2n),
    recoveryFeesReserved: "0",
    transactionBudget: Math.min(total * 2, config.maxTransactions),
    transactions: 0,
    totalTransactions: total,
    completedTransactions: 0,
    writtenBytes: 0,
    quotedAt: Date.now(),
    approved: false,
    phase: "ready",
    intent: "deploy",
    journal: [],
    message:
      "Review the program deposit and fee limit, then deploy. Your wallet retains upgrade authority.",
  };
}
type Context = {
  job: ProgramJob;
  config: OperatorConfig;
  signer: KeyPairSigner;
  rpc: RPC;
  binary(): Promise<Uint8Array>;
  save(): void;
  stopped(): boolean;
  pin(program: string): void;
  signing?: Promise<void>;
  failed?: boolean;
};
function bufferMatches(
  a: NonNullable<Awaited<ReturnType<typeof account>>>,
  owner: string,
  size: number,
) {
  const bytes = a.bytes;
  return (
    a.owner === LOADER &&
    !a.executable &&
    bytes.length === BUFFER_HEADER + size &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) === 1 &&
    bytes[4] === 1 &&
    getAddressDecoder().decode(bytes.subarray(5, 37)) === owner
  );
}
async function checkReceipt(
  c: Pick<Context, "rpc" | "job" | "save">,
  entry: ProgramReceipt,
) {
  const status = (
    await c.rpc
      .getSignatureStatuses([signature(entry.signature)], {
        searchTransactionHistory: true,
      })
      .send()
  ).value[0];
  if (!status) {
    if (
      (await c.rpc.getBlockHeight({ commitment: "finalized" }).send()) >
      BigInt(entry.lastValidBlockHeight)
    ) {
      entry.status = "expired";
      c.save();
      return true;
    }
    return false;
  }
  if (status.confirmationStatus !== "finalized") return false;
  if (status.err) {
    entry.status = "failed";
    c.save();
    return true;
  }
  const receipt = await c.rpc
    .getTransaction(signature(entry.signature), {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!receipt?.meta || receipt.meta.err)
    throw new Error(
      "Finalized program receipt unavailable. Resume to reconcile.",
    );
  if (receipt.meta.fee !== BigInt(entry.fee))
    throw new Error("Program fee receipt differs from the approved message");
  const keys = receipt.transaction.message.accountKeys;
  const wi = keys.indexOf(address(c.job.owner));
  if (wi < 0) throw new Error("Program receipt owner mismatch");
  const debit =
    receipt.meta.preBalances[wi] -
    receipt.meta.postBalances[wi] -
    receipt.meta.fee;
  if (entry.kind === "buffer" && debit !== BigInt(c.job.bufferRent))
    throw new Error("Program buffer funding receipt mismatch");
  if (entry.kind === "write" && debit !== 0n)
    throw new Error("Unexpected outlay while writing program bytes");
  if (entry.kind === "deploy") {
    const pi = keys.indexOf(address(c.job.program)),
      di = keys.indexOf(address(c.job.programData)),
      bi = keys.indexOf(address(c.job.buffer));
    if (
      pi < 0 ||
      di < 0 ||
      bi < 0 ||
      receipt.meta.postBalances[bi] !== 0n ||
      receipt.meta.postBalances[pi] !== BigInt(c.job.programRent) ||
      receipt.meta.postBalances[di] !== BigInt(c.job.codeRent) ||
      debit !==
        BigInt(c.job.programRent) +
          BigInt(c.job.codeRent) -
          receipt.meta.preBalances[bi]
    )
      throw new Error("Program deployment deposit/refund receipt mismatch");
  }
  if (entry.kind === "recover")
    await verifyClosure(
      c.rpc,
      {
        authority: address(c.job.owner),
        operation: {
          account: address(c.job.buffer),
          reclaim: BigInt(entry.reclaim!),
        },
      },
      signature(entry.signature),
    );
  entry.status = "finalized";
  c.save();
  return true;
}
export async function reconcileProgram(
  c: Pick<Context, "rpc" | "job" | "save">,
) {
  for (const entry of c.job.journal) {
    if (entry.status !== "signed") continue;
    if (!(await checkReceipt(c, entry)))
      throw new Error(
        "A saved program transaction is still pending. Wait and resume; no new transaction was signed.",
      );
  }
}
export async function refreshProgramRecovery(
  job: ProgramJob,
  rpc: RPC,
  config: OperatorConfig,
  save: () => void,
) {
  await chainCheck(rpc, { ...config, program: LOADER });
  await reconcileProgram({ job, rpc, save });
  if (await account(rpc, address(job.program)))
    throw new Error("Buffer recovery never retires a deployed program");
  const life = (
    await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  ).value;
  const { tx } = loaderTransaction(
    address(job.owner),
    [closeBuffer(address(job.owner), address(job.buffer))],
    life,
  );
  const fee = (
    await rpc
      .getFeeForMessage(
        base64(
          Uint8Array.from(tx.messageBytes),
        ) as TransactionMessageBytesBase64,
        { commitment: "confirmed" },
      )
      .send()
  ).value;
  if (fee === null) throw new Error("Buffer recovery fee quote unavailable");
  const budget = BigInt(job.recoveryFeesReserved) + fee * 2n;
  if (budget > BigInt(config.maxFees))
    throw new Error(
      "Recovery quote exceeds the external fee cap; review that cap before retrying",
    );
  job.recoveryFeeBudget = String(budget);
  job.phase = "paused";
  job.message =
    "Recovery fee quote refreshed. Review the remaining fee allowance, then resume buffer recovery.";
  save();
}
async function send(
  c: Context,
  kind: ProgramReceipt["kind"],
  instructions: Instruction[],
  cost: bigint,
  offset?: number,
  reclaim?: bigint,
) {
  if (c.stopped() || c.failed) return;
  const life = (
    await c.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  ).value;
  const { tx, wire } = loaderTransaction(c.signer.address, instructions, life);
  const fee = (
    await c.rpc
      .getFeeForMessage(
        base64(
          Uint8Array.from(tx.messageBytes),
        ) as TransactionMessageBytesBase64,
        { commitment: "confirmed" },
      )
      .send()
  ).value;
  if (fee === null) throw new Error("Program transaction fee unavailable");
  const recovering = kind === "recover";
  const spent = BigInt(
    recovering ? c.job.recoveryFeesReserved : c.job.feesReserved,
  );
  const budget = BigInt(recovering ? c.job.recoveryFeeBudget : c.job.feeBudget);
  if (
    spent + fee > budget ||
    (!recovering && c.job.transactions >= c.job.transactionBudget)
  )
    throw new Error(
      "Approved program fee/transaction budget exhausted. Reclaim the unfinished buffer before preparing again.",
    );
  const balance = (
    await c.rpc.getBalance(c.signer.address, { commitment: "finalized" }).send()
  ).value;
  if (balance < cost + fee)
    throw new Error(
      "Wallet cannot cover the approved program deposit and transaction fee",
    );
  const simulation = (
    await c.rpc
      .simulateTransaction(base64(wire) as Base64EncodedWireTransaction, {
        encoding: "base64",
        sigVerify: false,
        commitment: "confirmed",
      })
      .send()
  ).value;
  if (simulation.err)
    throw new Error(
      `Program simulation failed: ${describeRpcError(simulation.err)}`,
    );
  const previous = c.signing || Promise.resolve();
  let unlock!: () => void;
  c.signing = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  let signed, entry: ProgramReceipt;
  try {
    if (c.stopped() || c.failed) return;
    const reserved = BigInt(
      recovering ? c.job.recoveryFeesReserved : c.job.feesReserved,
    );
    if (
      reserved + fee > budget ||
      (!recovering && c.job.transactions >= c.job.transactionBudget)
    )
      throw new Error("Approved program fee/transaction budget exhausted");
    signed = await signTransaction([c.signer.keyPair], tx);
    if (!Buffer.from(signed.messageBytes).equals(Buffer.from(tx.messageBytes)))
      throw new Error("Program message changed during signing");
    const sig = getSignatureFromTransaction(signed);
    entry = {
      signature: sig,
      lastValidBlockHeight: String(life.lastValidBlockHeight),
      kind,
      offset,
      status: "signed",
      fee: String(fee),
      ...(reclaim === undefined ? {} : { reclaim: String(reclaim) }),
    };
    c.job.journal.push(entry);
    if (recovering) c.job.recoveryFeesReserved = String(reserved + fee);
    else {
      c.job.feesReserved = String(reserved + fee);
      c.job.transactions++;
    }
    c.save(); // Durable reservation and signature BEFORE any broadcast.
  } finally {
    unlock();
  }
  const returned = await c.rpc
    .sendTransaction(
      base64(
        Uint8Array.from(getTransactionEncoder().encode(signed)),
      ) as Base64EncodedWireTransaction,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0n,
      },
    )
    .send();
  if (returned !== entry.signature)
    throw new Error("RPC returned a different program transaction signature");
  for (let attempts = 0; attempts < 80; attempts++) {
    if (await checkReceipt(c, entry)) {
      if (entry.status !== "finalized")
        throw new Error(
          "Program transaction failed or expired. Resume checks chain state before retrying.",
        );
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    "Program confirmation pending. Resume to reconcile the saved signature.",
  );
}
export async function runProgram(c: Context) {
  const { job, rpc, signer } = c;
  if (signer.address !== job.owner || c.config.cluster !== job.cluster)
    throw new Error("Program owner or network changed");
  await chainCheck(rpc, { ...c.config, program: LOADER });
  const a = await loaderAddresses(signer.address, job.nonce);
  if (
    a.buffer !== job.buffer ||
    a.program !== job.program ||
    a.programData !== job.programData
  )
    throw new Error("Saved program addresses changed");
  await reconcileProgram(c);
  const existing = await account(rpc, a.program);
  // A lost deploy reply may look like an interrupted upload. If deployment
  // landed, recovery must only verify/pin it, never retire the live program.
  if (job.intent === "recover" && existing) {
    job.intent = "deploy";
    c.save();
  }
  if (job.intent === "recover") {
    const buffer = await account(rpc, a.buffer);
    if (buffer) {
      if (!bufferMatches(buffer, signer.address, job.binaryBytes))
        throw new Error("Buffer authority or allocation mismatch");
      job.message = "Reclaiming the unfinished program buffer…";
      c.save();
      await send(
        c,
        "recover",
        [closeBuffer(signer.address, a.buffer)],
        0n,
        undefined,
        buffer.lamports,
      );
      if (c.stopped()) return;
      if (await account(rpc, a.buffer))
        throw new Error("Program buffer remains onchain");
    }
    // If a previously funded buffer vanished, its saved closure receipt must
    // prove the refund; disappearance alone is never reported as recovery.
    if (
      job.journal.some(
        (e) => e.kind === "buffer" && e.status === "finalized",
      ) &&
      !job.journal.some((e) => e.kind === "recover" && e.status === "finalized")
    )
      throw new Error("Missing finalized buffer refund receipt");
    job.phase = "recovered";
    job.message =
      "Unfinished program buffer reclaimed. No program was deployed.";
    c.save();
    return;
  }
  const binary = await c.binary();
  if (
    binary.length !== job.binaryBytes ||
    (await digest(binary)) !== job.binaryHash
  )
    throw new Error(
      "Reviewed binary changed. Restore it to resume, or reclaim the buffer.",
    );
  if (!existing) {
    let buffer = await account(rpc, a.buffer);
    if (!buffer) {
      if (
        job.journal.some((e) => e.kind === "buffer" && e.status === "finalized")
      )
        throw new Error(
          "Previously funded buffer is missing; inspect its recovery before continuing",
        );
      job.message = "Creating the recoverable program buffer…";
      c.save();
      await send(
        c,
        "buffer",
        [
          createSeeded(
            signer.address,
            a.buffer,
            a.bufferSeed,
            BUFFER_HEADER + binary.length,
            BigInt(job.bufferRent),
          ),
          initializeBuffer(signer.address, a.buffer),
        ],
        BigInt(job.bufferRent),
      );
      if (c.stopped()) return;
      buffer = await account(rpc, a.buffer);
    }
    if (!buffer || !bufferMatches(buffer, signer.address, binary.length))
      throw new Error("Program buffer authority or allocation mismatch");
    job.completedTransactions = 1;
    job.writtenBytes = 0;
    const offsets = Array.from(
      { length: Math.ceil(binary.length / PROGRAM_CHUNK) },
      (_, i) => i * PROGRAM_CHUNK,
    );
    const concurrency =
      c.config.rpcPolicy.mode === "paid"
        ? Math.min(8, c.config.rpcPolicy.sendRps, c.config.rpcPolicy.rps)
        : 3;
    await mapConcurrent(offsets, concurrency, async (offset) => {
      if (c.stopped() || c.failed) return;
      const part = binary.subarray(offset, offset + PROGRAM_CHUNK);
      if (
        !Buffer.from(
          buffer!.bytes.subarray(
            BUFFER_HEADER + offset,
            BUFFER_HEADER + offset + part.length,
          ),
        ).equals(Buffer.from(part))
      ) {
        job.message = `Uploading program: ${offset.toLocaleString()} / ${binary.length.toLocaleString()} bytes`;
        c.save();
        try {
          await send(
            c,
            "write",
            [writeBuffer(signer.address, a.buffer, offset, part)],
            0n,
            offset,
          );
        } catch (error) {
          c.failed = true;
          throw error;
        }
        if (c.stopped() || c.failed) return;
      }
      job.writtenBytes += part.length;
      job.completedTransactions++;
      c.save();
    });
    if (c.stopped()) return;
    const complete = await account(rpc, a.buffer);
    if (
      !complete ||
      !bufferMatches(complete, signer.address, binary.length) ||
      (await digest(complete.bytes.subarray(BUFFER_HEADER))) !== job.binaryHash
    )
      throw new Error("Uploaded program buffer checksum failed");
    job.message = "Deploying and verifying the program…";
    c.save();
    const currentRent = await rpc
      .getMinimumBalanceForRentExemption(
        BigInt(PROGRAM_DATA_HEADER + binary.length),
      )
      .send();
    if (currentRent !== BigInt(job.codeRent))
      throw new Error(
        "Program rent changed after approval; reclaim the buffer and review a fresh quote",
      );
    // Creation + deploy are one atomic transaction. The loader refunds buffer
    // rent to the payer before allocating ProgramData, so only the difference
    // is additional outlay. No separately stranded Program account is created.
    await send(
      c,
      "deploy",
      [
        createSeeded(
          signer.address,
          a.program,
          a.programSeed,
          PROGRAM_SIZE,
          BigInt(job.programRent),
        ),
        deployProgram(signer.address, a, binary.length),
      ],
      BigInt(job.programRent) +
        max(0n, BigInt(job.codeRent) - complete.lamports),
    );
    if (c.stopped()) return;
  }
  const [program, data, buffer] = await Promise.all([
    account(rpc, a.program),
    account(rpc, a.programData),
    account(rpc, a.buffer),
  ]);
  if (
    !program?.executable ||
    program.owner !== LOADER ||
    program.bytes.length !== PROGRAM_SIZE ||
    new DataView(program.bytes.buffer, program.bytes.byteOffset).getUint32(
      0,
      true,
    ) !== 2 ||
    getAddressDecoder().decode(program.bytes.subarray(4)) !== a.programData
  )
    throw new Error("Deployed program metadata failed verification");
  if (
    !data ||
    data.owner !== LOADER ||
    data.bytes.length !== PROGRAM_DATA_HEADER + binary.length ||
    new DataView(data.bytes.buffer, data.bytes.byteOffset).getUint32(
      0,
      true,
    ) !== 3 ||
    data.bytes[12] !== 1 ||
    getAddressDecoder().decode(data.bytes.subarray(13, 45)) !==
      signer.address ||
    (await digest(data.bytes.subarray(PROGRAM_DATA_HEADER))) !== job.binaryHash
  )
    throw new Error(
      "Deployed binary or retained upgrade authority failed verification",
    );
  if (buffer) throw new Error("Deployment buffer was not reclaimed");
  job.phase = "complete";
  job.completedTransactions = job.totalTransactions;
  job.writtenBytes = binary.length;
  job.message =
    "Program verified and configured. Run Test to prove storage recovery on this network.";
  c.pin(job.program);
  c.save();
}
