import { createSolanaRpcFromTransport } from "@solana/kit";
import {
  parseJsonWithBigInts,
  stringifyJsonWithBigInts,
} from "@solana/rpc-spec-types";
import { createRpcForwarder } from "@/lib/server/rpc";
import type { OperatorConfig } from "./config";
import type { RPC } from "@/lib/chain/client";
import { createRpcLimiter } from "@/lib/server/rpc-limiter";
const clients = new Map<string, RPC>();
const limiter = createRpcLimiter();
export function operatorRpc(config: OperatorConfig): RPC {
  const key = `${config.cluster}:${config.rpc}:${JSON.stringify(config.rpcPolicy)}`;
  const existing = clients.get(key);
  if (existing) return existing;
  const forward = createRpcForwarder({
    getConfiguration: () => config,
    limiter,
  });
  const rpc = createSolanaRpcFromTransport(
    async <T>({ payload }: { payload: unknown }) => {
      const response = await forward(
        JSON.parse(stringifyJsonWithBigInts(payload)),
      );
      if (!response.ok)
        throw new Error(
          `Solana RPC unavailable (HTTP ${response.status}). Pause and resume after the provider recovers.`,
        );
      return parseJsonWithBigInts(await response.text()) as T;
    },
  );
  clients.set(key, rpc);
  return rpc;
}
