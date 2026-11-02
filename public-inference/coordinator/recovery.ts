/** Account-only owner recovery: no checkpoint, tokenizer, plan or journal needed. */
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
export type PublicAccount = {
  address: Address;
  owner: Address;
  data: Uint8Array;
  lamports: bigint;
};
export async function recoveryPlan(
  program: Address,
  owner: Address,
  accounts: readonly PublicAccount[],
): Promise<Instruction[]> {
  const enc = getAddressEncoder(),
    ownerBytes = Buffer.from(enc.encode(owner)),
    entries = new Map<Address, { a: PublicAccount; d: Buffer; kind: number }>();
  for (const a of accounts) {
    const d = Buffer.from(a.data);
    if (
      a.owner !== program ||
      d.length < 192 ||
      !d.subarray(16, 48).equals(ownerBytes)
    )
      throw Error("public_recovery_owner");
    const kind = d[9],
      magics: Record<number, string> = {
        1: "SLMPUM01",
        2: "SLMPUA01",
        3: "SLMPUS01",
        4: "SLMPUT01",
        5: "SLMPTR01",
        6: "SLMPTP01",
        7: "SLMPTX01",
      },
      magic = magics[kind];
    if (
      !magic ||
      d[8] !== 1 ||
      !d.subarray(0, 8).equals(Buffer.from(magic)) ||
      entries.has(a.address)
    )
      throw Error("public_recovery_header");
    const seeds =
      kind === 1
        ? [Buffer.from("slm-pu-model"), ownerBytes, d.subarray(48, 80)]
        : kind === 3
          ? [Buffer.from("slm-pu-session"), ownerBytes, d.subarray(80, 112)]
          : kind === 5
            ? [
                Buffer.from("slm-pu-tokenizer"),
                d.subarray(168, 200),
                d.subarray(112, 144),
              ]
            : kind === 7
              ? [Buffer.from("slm-pu-text"), d.subarray(48, 80)]
              : [
                  Buffer.from(
                    kind === 2
                      ? "slm-pu-artifact"
                      : kind === 6
                        ? "slm-pu-tokpage"
                        : "slm-pu-state",
                  ),
                  d.subarray(48, 80),
                  d.subarray(80, 84),
                ];
    const [key, bump] = await getProgramDerivedAddress({
      programAddress: program,
      seeds,
    });
    if (key !== a.address || bump !== d[11]) throw Error("public_recovery_pda");
    entries.set(a.address, { a, d, kind });
  }
  const result: Instruction[] = [];
  const instruction = (
    tag: number,
    parent: Address,
    child?: Address,
    index?: number,
  ) => {
    const data = Buffer.alloc(index === undefined ? 1 : 5);
    data[0] = tag;
    if (index !== undefined) data.writeUInt32LE(index, 1);
    return {
      programAddress: program,
      accounts: [
        { address: owner, role: AccountRole.WRITABLE_SIGNER },
        { address: parent, role: AccountRole.WRITABLE },
        ...(child ? [{ address: child, role: AccountRole.WRITABLE }] : []),
      ],
      data,
    };
  };
  for (const [parent, entry] of entries) {
    if (![1, 3, 5].includes(entry.kind)) continue;
    const registry = entry.kind !== 3,
      tokenizer = entry.kind === 5,
      children = [...entries.values()].filter(
        (v) =>
          [2, 4, 6, 7].includes(v.kind) &&
          v.d.subarray(48, 80).equals(Buffer.from(enc.encode(parent))),
      ),
      scratch = children.filter((v) => v.kind === 7),
      pages = children.filter((v) => v.kind !== 7);
    if (
      entry.d.length !== 384 ||
      pages.length !== entry.d.readUInt32LE(registry ? 148 : 192) ||
      (!registry && scratch.length !== entry.d.readUInt32LE(180)) ||
      (registry && scratch.length !== 0)
    )
      throw Error("public_recovery_incomplete");
    for (const child of pages) {
      const index = child.d.readUInt32LE(80),
        n = child.d.readUInt32LE(84);
      if (
        child.kind !== (registry ? (tokenizer ? 6 : 2) : 4) ||
        child.d.length !== 192 + n ||
        !child.d
          .subarray(registry ? 128 : 96, registry ? 160 : 128)
          .equals(
            entry.d.subarray(registry ? 80 : 144, registry ? 112 : 176),
          ) ||
        index >= (registry ? entry.d.readUInt32LE(144) : 5) ||
        (!registry && n !== (index === 0 ? 8192 : 3072)) ||
        (registry && (n < 1 || n > 8192))
      )
        throw Error("public_recovery_child");
      result.push(
        instruction(
          registry ? (tokenizer ? 19 : 5) : 12,
          parent,
          child.a.address,
          registry ? undefined : index,
        ),
      );
    }
    for (const child of scratch) {
      if (
        child.d.length !== 4260 ||
        entry.d[12] !== 1 ||
        !child.d.subarray(80, 112).equals(entry.d.subarray(144, 176))
      )
        throw Error("public_recovery_text");
      result.push(instruction(25, parent, child.a.address));
    }
    result.push(instruction(registry ? (tokenizer ? 20 : 6) : 13, parent));
  }
  if (result.length !== entries.size) throw Error("public_recovery_orphan");
  return result;
}
