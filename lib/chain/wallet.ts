import { getWallets } from "@wallet-standard/app";
import type { WalletAccount } from "@wallet-standard/base";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import { address } from "@solana/kit";
import { VersionedTransaction } from "@solana/web3.js";
import { batchLimit } from "./batch";
export type Connected = {
  account: Pick<WalletAccount, "address">;
  disconnect: () => Promise<void>;
  sign: (wire: Uint8Array, cluster: string) => Promise<Uint8Array>;
  signAll: (
    wires: readonly Uint8Array[],
    cluster: string,
  ) => Promise<Uint8Array[]>;
  cleanup: () => void;
};
const chainFor = (cluster: string) =>
  cluster === "mainnet-beta"
    ? "solana:mainnet"
    : cluster === "localnet"
      ? "solana:devnet"
      : `solana:${cluster}`;

// Some Phantom releases expose sign-only methods only through the injected
// provider. Use the typed transaction API to receive a complete signed wire;
// low-level request responses are not necessarily serializable transactions.
// Never fall back to sign-and-send,
// which would bypass our pre-broadcast message and signature checks.
type Injected = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: VersionedTransaction): Promise<unknown>;
  signAllTransactions?(
    transactions: VersionedTransaction[],
  ): Promise<unknown[]>;
  on(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
};
async function signedResponse<T>(request: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Phantom did not return a signed transaction within two minutes. Close its pending prompt and prepare a fresh preview. This request did not broadcast anything.",
              ),
            ),
          120000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function serialized(result: unknown): Uint8Array {
  if (result instanceof Uint8Array) return Uint8Array.from(result);
  if (
    result &&
    typeof result === "object" &&
    "serialize" in result &&
    typeof result.serialize === "function"
  )
    return Uint8Array.from(result.serialize());
  throw new Error(
    "Phantom did not return a signed transaction; nothing was submitted",
  );
}
export async function connectPhantom(changed: () => void): Promise<Connected> {
  const wallet = getWallets()
    .get()
    .find(
      (w) =>
        w.name === "Phantom" &&
        w.features["standard:connect"] &&
        w.features["solana:signTransaction"],
    );
  if (wallet) {
    const features = wallet.features as StandardConnectFeature &
      StandardDisconnectFeature &
      StandardEventsFeature &
      SolanaSignTransactionFeature;
    const { accounts } = await features["standard:connect"].connect();
    const account = accounts.find((a) =>
      a.chains.some((c) => c.startsWith("solana:")),
    );
    if (!account) throw new Error("Phantom has no Solana account");
    if (
      !features["solana:signTransaction"].supportedTransactionVersions.includes(
        0,
      )
    )
      throw new Error("Phantom must support versioned Solana transactions");
    const cleanup = features["standard:events"].on("change", changed);
    const signAll = async (wires: readonly Uint8Array[], cluster: string) => {
      batchLimit(wires.length);
      const check = () => {
        if (!wallet.accounts.some((a) => a.address === account.address))
          throw new Error("Connected wallet changed; prepare a new preview");
      };
      check();
      const chain = chainFor(cluster) as `solana:${string}`;
      if (!account.chains.includes(chain))
        throw new Error("Wallet does not support the selected chain");
      // One Wallet Standard request with multiple inputs, not a loop of prompts.
      const results = await signedResponse(() =>
        features["solana:signTransaction"].signTransaction(
          ...wires.map((transaction) => ({ account, transaction, chain })),
        ),
      );
      check();
      if (results.length !== wires.length)
        throw new Error(
          "Phantom returned an incomplete batch; nothing was submitted",
        );
      return results.map((r) => Uint8Array.from(r.signedTransaction));
    };
    return {
      account,
      cleanup,
      disconnect: async () => {
        cleanup();
        await features["standard:disconnect"].disconnect();
      },
      signAll,
      sign: async (wire, cluster) => (await signAll([wire], cluster))[0],
    };
  }
  const provider = (window as Window & { phantom?: { solana?: Injected } })
    .phantom?.solana;
  if (!provider?.isPhantom || !provider.signTransaction)
    throw new Error(
      "Install/unlock Phantom with transaction signing, then refresh",
    );
  const account = {
    address: address((await provider.connect()).publicKey.toString()),
  };
  provider.on("accountChanged", changed);
  provider.on("disconnect", changed);
  const cleanup = () => {
    provider.removeListener("accountChanged", changed);
    provider.removeListener("disconnect", changed);
  };
  const signAll = async (wires: readonly Uint8Array[], cluster: string) => {
    batchLimit(wires.length);
    if (!["devnet", "localnet", "mainnet-beta"].includes(cluster))
      throw new Error("Unsupported cluster");
    const check = () => {
      if (provider.publicKey?.toString() !== account.address)
        throw new Error("Connected wallet changed; prepare a new preview");
    };
    check();
    const transactions = wires.map((w) => VersionedTransaction.deserialize(w));
    if (wires.length > 1 && !provider.signAllTransactions)
      throw new Error(
        "Phantom does not support batch signing. Select one transaction per request.",
      );
    const results = await signedResponse(async () =>
      wires.length === 1
        ? [await provider.signTransaction(transactions[0])]
        : await provider.signAllTransactions!(transactions),
    );
    check();
    if (!Array.isArray(results) || results.length !== wires.length)
      throw new Error(
        "Phantom returned an incomplete batch; nothing was submitted",
      );
    return results.map(serialized);
  };
  return {
    account,
    cleanup,
    disconnect: async () => {
      cleanup();
      await provider.disconnect();
    },
    signAll,
    sign: async (wire, cluster) => (await signAll([wire], cluster))[0],
  };
}
