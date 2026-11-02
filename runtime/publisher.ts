import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  getTransactionEncoder,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
export type SignedMemo = {
  wire: string;
  signature: string;
  lastValidBlockHeight: string;
  fee: string;
};
export type Evidence = {
  network: string;
  receiptHash: string;
  transactionSignature: string;
  publisher: string;
  slot: number;
  finalizedAt: string;
};
export type Inspection =
  | { state: "pending" | "uncertain" | "failed" }
  | { state: "finalized"; evidence: Evidence };
export type Publisher = {
  prepare(hash: string): Promise<SignedMemo>;
  broadcast(signed: SignedMemo): Promise<void>;
  inspect(signed: SignedMemo, hash: string): Promise<Inspection>;
};
import { HASH, memo } from "./receipt";
export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
// sha256("global:inference_memo")[0..8], followed by the 32-byte receipt hash.
export const INFERENCE_MEMO_DISCRIMINATOR = "b25b7eed625a6ba1";
export function inferenceMemoData(hash: string) {
  if (!HASH.test(hash)) throw Error("invalid_hash");
  return Buffer.from(INFERENCE_MEMO_DISCRIMINATOR + hash, "hex");
}
export type RpcCall = <T>(method: string, params?: unknown[]) => Promise<T>;
export function rpcCall(url: string): RpcCall {
  const endpoint = new URL(url);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("invalid_rpc_url");
  return async <T>(method: string, params: unknown[] = []) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!r.ok) throw new Error("rpc_unavailable");
    if (!r.body) throw new Error("rpc_unavailable");
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) throw new Error("rpc_response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const data = JSON.parse(text);
    if (data.error || !Object.hasOwn(data, "result"))
      throw new Error("rpc_unavailable");
    return data.result as T;
  };
}
export function memoPublisher(options: {
  rpc: RpcCall;
  signer: KeyPairSigner;
  network: string;
  genesisHash: string;
  forbiddenAuthorities: string[];
  maxFeeLamports: bigint;
  programId?: string;
}): Publisher {
  const { rpc, signer } = options;
  const programId = options.programId ? address(options.programId) : undefined;
  if (
    programId === MEMO ||
    programId === signer.address ||
    programId === "11111111111111111111111111111111"
  )
    throw Error("invalid_receipt_program");
  for (const authority of options.forbiddenAuthorities) address(authority);
  if (
    !options.forbiddenAuthorities.length ||
    options.forbiddenAuthorities.includes(signer.address)
  )
    throw new Error("publisher_must_be_separate");
  const network = async () => {
    if ((await rpc<string>("getGenesisHash")) !== options.genesisHash)
      throw new Error("wrong_network");
  };
  // Check durable bytes before every broadcast/reconciliation, including after restart.
  async function check(signed: SignedMemo, hash?: string) {
    const tx = getTransactionDecoder().decode(
      Buffer.from(signed.wire, "base64"),
    );
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const signature = tx.signatures[signer.address];
    if (
      m.version !== "legacy" ||
      m.header.numSignerAccounts !== 1 ||
      ![2, 3].includes(m.staticAccounts.length) ||
      m.staticAccounts[0] !== signer.address ||
      m.instructions.length !== 1 ||
      !signature ||
      getBase58Decoder().decode(signature) !== signed.signature
    )
      throw new Error("invalid_saved_transaction");
    const ix = m.instructions[0];
    const target = m.staticAccounts[ix.programAddressIndex];
    const data = Buffer.from(ix.data ?? []);
    const direct = target === MEMO;
    const hashBytes = data.subarray(8).toString("hex");
    if (direct) {
      const text = data.toString("utf8");
      if (
        m.staticAccounts.length !== 2 ||
        m.header.numReadonlyNonSignerAccounts !== 1 ||
        ix.accountIndices?.length !== 1 ||
        ix.accountIndices[0] !== 0 ||
        !/^slm:receipt:v1:[0-9a-f]{64}$/.test(text) ||
        (hash && text !== memo(hash))
      )
        throw Error("invalid_saved_memo");
    } else if (
      !programId ||
      target !== programId ||
      m.staticAccounts.length !== 3 ||
      new Set(m.staticAccounts).size !== 3 ||
      m.header.numReadonlyNonSignerAccounts !== 2 ||
      ix.accountIndices?.length !== 2 ||
      ix.accountIndices[0] !== 0 ||
      m.staticAccounts[ix.accountIndices[1]] !== MEMO ||
      data.length !== 40 ||
      data.subarray(0, 8).toString("hex") !== INFERENCE_MEMO_DISCRIMINATOR ||
      (hash && hashBytes !== hash)
    )
      throw Error("invalid_saved_memo");
    return { wrapped: !direct, keys: m.staticAccounts, memoIndex: 0 };
  }
  const memoInstruction = (hash: string) => ({
    programAddress: programId ?? address(MEMO),
    accounts: [
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
      ...(programId
        ? [{ address: address(MEMO), role: AccountRole.READONLY }]
        : []),
    ],
    data: programId ? inferenceMemoData(hash) : Buffer.from(memo(hash)),
  });
  return {
    async prepare(hash) {
      if (!HASH.test(hash)) throw new Error("invalid_hash");
      await network();
      if (programId) {
        const account = await rpc<{ value: { executable: boolean } | null }>(
          "getAccountInfo",
          [programId, { encoding: "base64", commitment: "finalized" }],
        );
        if (account.value?.executable !== true)
          throw Error("receipt_program_unavailable");
      }
      const { value: life } = await rpc<{
        value: { blockhash: string; lastValidBlockHeight: number };
      }>("getLatestBlockhash", [{ commitment: "finalized" }]);
      const message = appendTransactionMessageInstructions(
        [memoInstruction(hash)],
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: life.blockhash as Blockhash,
            lastValidBlockHeight: BigInt(life.lastValidBlockHeight),
          },
          setTransactionMessageFeePayer(
            signer.address,
            createTransactionMessage({ version: "legacy" }),
          ),
        ),
      );
      const tx = compileTransaction(message);
      if (getTransactionEncoder().encode(tx).length > 1232)
        throw Error("transaction_too_large");
      const fee = await rpc<{ value: number | null }>("getFeeForMessage", [
        Buffer.from(tx.messageBytes).toString("base64"),
        { commitment: "finalized" },
      ]);
      if (
        fee.value === null ||
        !Number.isSafeInteger(fee.value) ||
        fee.value < 0 ||
        BigInt(fee.value) > options.maxFeeLamports
      )
        throw new Error("fee_limit");
      const signed = await signTransaction([signer.keyPair], tx);
      const result = {
        wire: getBase64EncodedWireTransaction(signed),
        signature: getBase58Decoder().decode(
          signed.signatures[signer.address]!,
        ),
        lastValidBlockHeight: String(life.lastValidBlockHeight),
        fee: String(fee.value),
      };
      await check(result, hash);
      return result;
    },
    async broadcast(signed) {
      await check(signed);
      await network();
      if (
        (await rpc<number>("getBlockHeight", [{ commitment: "finalized" }])) >
        Number(signed.lastValidBlockHeight)
      )
        return;
      await rpc("sendTransaction", [
        signed.wire,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "finalized",
          maxRetries: 0,
        },
      ]);
    },
    async inspect(signed, hash): Promise<Inspection> {
      const checked = await check(signed, hash);
      await network();
      const tx = await rpc<null | {
        slot: number;
        version?: string | number;
        meta: {
          err: unknown;
          innerInstructions?: {
            index: number;
            instructions: {
              programIdIndex: number;
              accounts: number[];
              data: string;
              stackHeight?: number;
            }[];
          }[];
        } | null;
        transaction: [string, string];
      }>("getTransaction", [
        signed.signature,
        {
          encoding: "base64",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (tx) {
        if (!tx.meta) return { state: "uncertain" };
        if (tx.meta.err !== null) return { state: "failed" };
        if (
          (tx.version !== undefined && tx.version !== "legacy") ||
          tx.transaction[1] !== "base64" ||
          tx.transaction[0] !== signed.wire ||
          !Number.isSafeInteger(tx.slot) ||
          tx.slot < 0
        )
          throw new Error("invalid_finalized_evidence");
        if (checked.wrapped) {
          const groups = tx.meta.innerInstructions?.filter(
            (group) => group.index === checked.memoIndex,
          );
          const inner = groups?.[0]?.instructions;
          if (
            groups?.length !== 1 ||
            inner?.length !== 1 ||
            inner[0].stackHeight !== 2 ||
            checked.keys[inner[0].programIdIndex] !== MEMO ||
            inner[0].accounts.length !== 1 ||
            inner[0].accounts[0] !== 0 ||
            Buffer.from(getBase58Encoder().encode(inner[0].data)).toString(
              "utf8",
            ) !== memo(hash)
          )
            throw Error("invalid_finalized_evidence");
        }
        return {
          state: "finalized",
          evidence: {
            network: options.network,
            receiptHash: hash,
            transactionSignature: signed.signature,
            publisher: signer.address,
            slot: tx.slot,
            finalizedAt: new Date().toISOString(),
          },
        };
      }
      const statuses = await rpc<{
        value: (null | { confirmationStatus: string; err: unknown })[];
      }>("getSignatureStatuses", [
        [signed.signature],
        { searchTransactionHistory: true },
      ]);
      const status = statuses.value[0];
      if (status?.confirmationStatus === "finalized" && status.err !== null)
        return { state: "failed" };
      // Finalized status alone is insufficient: fetch and inspect successful transaction bytes.
      if (status) return { state: "uncertain" };
      const height = await rpc<number>("getBlockHeight", [
        { commitment: "finalized" },
      ]);
      return {
        state:
          height > Number(signed.lastValidBlockHeight)
            ? "uncertain"
            : "pending",
      };
    },
  };
}
