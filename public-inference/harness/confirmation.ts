/** Confirmed execution is provisional. Only finalized observations release journal reservations. */
export type ConfirmationOptions = {
  confirmation?: "confirmed" | "finalized";
  pendingWindow?: number;
  timeoutMs?: number;
  pollMs?: number;
};
type Rpc = { rpc<T>(method: string, params: unknown[]): Promise<T> };
export type SignatureObservation = {
  slot: bigint;
  failed: boolean;
  finalized: boolean;
};
type Pending = {
  signature: string;
  observed?: SignatureObservation;
  settle: (observation: SignatureObservation) => Promise<void>;
};
const slot = (value: unknown) => {
  if (
    typeof value !== "bigint" &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  )
    throw Error("public_invalid_rpc_slot");
  const n = BigInt(value as bigint | number);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("public_invalid_rpc_slot");
  return n;
};
export { slot as rpcSlot };
export class ConfirmationWindow {
  readonly mode: "confirmed" | "finalized";
  readonly limit: number;
  readonly timeout: number;
  readonly poll: number;
  private pending: Pending[] = [];
  private floor = 0n;
  constructor(
    private rpc: Rpc,
    options: ConfirmationOptions = {},
  ) {
    this.mode = options.confirmation ?? "confirmed";
    this.limit = options.pendingWindow ?? 64;
    this.timeout = options.timeoutMs ?? 90000;
    this.poll = options.pollMs ?? 500;
    if (
      !["confirmed", "finalized"].includes(this.mode) ||
      !Number.isInteger(this.limit) ||
      this.limit < 1 ||
      this.limit > 128 ||
      !Number.isInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 90000 ||
      !Number.isInteger(this.poll) ||
      this.poll < 1 ||
      this.poll > 1000
    )
      throw Error("public_confirmation_options");
  }
  get minContextSlot() {
    return Number(this.floor);
  }
  get count() {
    return this.pending.length;
  }
  track(signature: string, settle: Pending["settle"]) {
    if (
      this.pending.some((p) => p.signature === signature) ||
      this.pending.length >= this.limit
    )
      throw Error("public_confirmation_window");
    this.pending.push({ signature, settle });
  }
  private async observation(
    signature: string,
  ): Promise<SignatureObservation | undefined> {
    const r = await this.rpc.rpc<{
      context: { slot: number | bigint };
      value: ({
        slot: number | bigint;
        confirmationStatus: string;
        err: unknown;
      } | null)[];
    }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    if (!r?.context || !Array.isArray(r.value) || r.value.length !== 1)
      throw Error("public_invalid_signature_status");
    const context = slot(r.context.slot),
      v = r.value[0];
    if (v === null) return undefined;
    if (
      !v ||
      !["processed", "confirmed", "finalized"].includes(v.confirmationStatus) ||
      !Object.hasOwn(v, "err")
    )
      throw Error("public_invalid_signature_status");
    const transactionSlot = slot(v.slot);
    if (context < transactionSlot)
      throw Error("public_invalid_signature_context");
    if (v.confirmationStatus === "processed") return undefined;
    return {
      slot: transactionSlot,
      failed: v.err !== null,
      finalized: v.confirmationStatus === "finalized",
    };
  }
  private async wait(p: Pending, finalized: boolean) {
    const end = Date.now() + this.timeout;
    while (Date.now() < end) {
      const v = await this.observation(p.signature);
      if (!v) {
        if (p.observed)
          throw Error("public_confirmation_lost_recovery_required");
      } else {
        if (p.observed && p.observed.slot !== v.slot)
          throw Error("public_confirmation_fork_changed");
        if (!p.observed && v.slot < this.floor)
          throw Error("public_confirmation_slot_regressed");
        p.observed = v;
        if (v.slot > this.floor) this.floor = v.slot;
        if (!finalized || v.finalized) return v;
      }
      await new Promise((resolve) => setTimeout(resolve, this.poll));
    }
    throw Error(
      finalized ? "public_finality_timeout" : "public_confirmation_timeout",
    );
  }
  async confirm(signature: string) {
    const p = this.pending.find((p) => p.signature === signature);
    if (!p) throw Error("public_confirmation_untracked");
    const v = await this.wait(p, this.mode === "finalized");
    if (v.failed) throw Error("public_transaction_failed");
    return v;
  }
  async checkpoint() {
    while (this.pending.length) {
      const p = this.pending[0],
        v = await this.wait(p, true);
      await p.settle(v);
      this.pending.shift();
    }
  }
}
