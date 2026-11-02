/** Recovery inventory derives only from program accounts, never model/key/journal state. */
import {
  AccountRole,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
export type RecoveryAccount = {
  address: Address;
  owner: Address;
  data: Uint8Array;
  lamports: bigint;
};
export async function recoveryPlan(
  program: Address,
  owner: Address,
  accounts: RecoveryAccount[],
): Promise<{ instructions: Instruction[]; refundableLamports: bigint }> {
  const encode = getAddressEncoder(),
    decode = getAddressDecoder();
  const seen = new Set<string>();
  const sessions = new Map<Address, RecoveryAccount>();
  const pages: RecoveryAccount[] = [];
  const scratch: RecoveryAccount[] = [];
  const slotPages: RecoveryAccount[] = [];
  const windows: RecoveryAccount[] = [];
  let total = 0n;
  for (const a of accounts) {
    if (
      seen.has(a.address) ||
      a.owner !== program ||
      a.data.length < 192 ||
      a.lamports < 0n
    )
      throw Error("invalid_recovery_inventory");
    seen.add(a.address);
    const d = Buffer.from(a.data);
    if (
      (d[8] !== 1 && d[8] !== 2) ||
      !d.subarray(16, 48).equals(Buffer.from(encode.encode(owner)))
    )
      throw Error("recovery_authority");
    if (
      d.subarray(0, 8).equals(Buffer.from("SLMPIS01")) &&
      d[8] === 1 &&
      d[9] === 1 &&
      d.length === 256 &&
      d[10] <= 4 &&
      d.readUInt32LE(212) > 0 &&
      d.readUInt32LE(212) <= 16 &&
      d.readUInt32LE(216) <= d.readUInt32LE(212) &&
      d.readUInt32LE(228) <= 2 &&
      d.readUInt32LE(240) <= 1
    ) {
      const [expected, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [
          Buffer.from("slm-pi-session"),
          encode.encode(owner),
          d.subarray(80, 112),
        ],
      });
      if (expected !== a.address || bump !== d[11]) throw Error("recovery_pda");
      sessions.set(a.address, a);
    } else if (
      d.subarray(0, 8).equals(Buffer.from("SLMPIP01")) &&
      d[8] === 1 &&
      d[9] === 2 &&
      d.length === 192 + d.readUInt32LE(84) &&
      d.readUInt32LE(84) > 0 &&
      d.readUInt32LE(84) <= 8192 &&
      d[10] <= 1 &&
      d.readUInt32LE(92) === 1 &&
      d.readUInt32LE(88) <= d.readUInt32LE(84)
    ) {
      const [expected, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [
          Buffer.from("slm-pi-page"),
          d.subarray(48, 80),
          d.subarray(80, 84),
        ],
      });
      if (expected !== a.address || bump !== d[11]) throw Error("recovery_pda");
      pages.push(a);
    } else if (
      d.subarray(0, 8).equals(Buffer.from("SLMPIW01")) &&
      d[8] === 1 &&
      d[9] === 3 &&
      d.length >= 256 &&
      (d[10] === 1 || d[10] === 3) &&
      d.readUInt32LE(144) > 1 &&
      d.readUInt32LE(144) <= 256 &&
      d.length === 256 + d.readUInt32LE(144) * 32
    ) {
      const [expected, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [Buffer.from("slm-pi-wires"), d.subarray(48, 80)],
      });
      if (expected !== a.address || bump !== d[11]) throw Error("recovery_pda");
      scratch.push(a);
    } else if (
      d.subarray(0, 8).equals(Buffer.from("SLMPSL02")) &&
      d[8] === 2 &&
      d[9] === 4 &&
      d.length >= 256 &&
      (d[10] === 1 || d[10] === 3)
    ) {
      const index = d.readUInt32LE(144),
        total = d.readUInt32LE(156),
        count = Math.min(128, Math.max(0, total - index * 128));
      if (
        index > 1 ||
        total < 1 ||
        total > 256 ||
        d.readUInt32LE(148) !== index * 128 ||
        d.readUInt32LE(152) !== count ||
        d.length !== 256 + count * 40
      )
        throw Error("recovery_slot_layout");
      const indexBytes = Buffer.alloc(4);
      indexBytes.writeUInt32LE(index);
      const [expected, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [Buffer.from("slm-pi-slot"), d.subarray(48, 80), indexBytes],
      });
      if (expected !== a.address || bump !== d[11]) throw Error("recovery_pda");
      slotPages.push(a);
    } else if (
      d.subarray(0, 8).equals(Buffer.from("SLMPWN02")) &&
      d[8] === 2 &&
      d[9] === 5 &&
      d.length === 3328 &&
      d[10] <= 2 &&
      d.readUInt32LE(148) <= 32 &&
      d.readUInt32LE(156) === d.readUInt32LE(148) * 96 &&
      d.readUInt32LE(152) <= d.readUInt32LE(156)
    ) {
      const [expected, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [Buffer.from("slm-pi-window"), d.subarray(48, 80)],
      });
      if (expected !== a.address || bump !== d[11]) throw Error("recovery_pda");
      windows.push(a);
    } else throw Error("recovery_account_layout");
    total += a.lamports;
  }
  const instructions: Instruction[] = [];
  const count = new Map<Address, number>();
  const ix = (tag: number, session: Address, page?: Address): Instruction => ({
    programAddress: program,
    data: Uint8Array.of(tag),
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: session, role: AccountRole.WRITABLE },
      ...(page ? [{ address: page, role: AccountRole.WRITABLE }] : []),
    ],
  });
  for (const p of pages) {
    const d = Buffer.from(p.data),
      sid = decode.decode(d.subarray(48, 80)),
      s = sessions.get(sid);
    if (
      !s ||
      d.readUInt32LE(80) >= Buffer.from(s.data).readUInt32LE(212) ||
      !d.subarray(128, 160).equals(Buffer.from(s.data).subarray(112, 144))
    )
      throw Error("recovery_missing_or_substituted_session");
    count.set(sid, (count.get(sid) || 0) + 1);
    instructions.push(ix(7, sid, p.address));
  }
  const scratchSessions = new Set<Address>();
  for (const a of scratch) {
    const d = Buffer.from(a.data),
      sid = decode.decode(d.subarray(48, 80)),
      s = sessions.get(sid);
    if (
      !s ||
      scratchSessions.has(sid) ||
      !d.subarray(80, 112).equals(Buffer.from(s.data).subarray(112, 144)) ||
      !d.subarray(112, 144).equals(Buffer.from(s.data).subarray(144, 176)) ||
      Buffer.from(s.data).readUInt32LE(228) !== 1
    )
      throw Error("recovery_scratch_binding");
    scratchSessions.add(sid);
    instructions.push(ix(10, sid, a.address));
  }
  const slotCounts = new Map<Address, number>();
  const windowSessions = new Set<Address>();
  for (const a of [...slotPages, ...windows]) {
    const d = Buffer.from(a.data),
      sid = decode.decode(d.subarray(48, 80)),
      s = sessions.get(sid);
    if (
      !s ||
      scratchSessions.has(sid) ||
      !d.subarray(80, 112).equals(Buffer.from(s.data).subarray(112, 144)) ||
      !d.subarray(112, 144).equals(Buffer.from(s.data).subarray(144, 176))
    )
      throw Error("recovery_stream_binding");
    if (d[9] === 4) {
      slotCounts.set(sid, (slotCounts.get(sid) || 0) + 1);
      const instruction = ix(17, sid, a.address),
        data = Buffer.alloc(5);
      data[0] = 17;
      data.writeUInt32LE(d.readUInt32LE(144), 1);
      instructions.push({ ...instruction, data });
    } else {
      if (windowSessions.has(sid)) throw Error("recovery_duplicate_window");
      windowSessions.add(sid);
      instructions.push(ix(18, sid, a.address));
    }
  }
  for (const [sid, s] of sessions) {
    if (
      Number(windowSessions.has(sid)) !== Buffer.from(s.data).readUInt32LE(240)
    )
      throw Error("recovery_incomplete_window_discovery");
    if (
      Number(scratchSessions.has(sid)) + (slotCounts.get(sid) || 0) !==
      Buffer.from(s.data).readUInt32LE(228)
    )
      throw Error("recovery_incomplete_scratch_discovery");
    if ((count.get(sid) || 0) !== Buffer.from(s.data).readUInt32LE(216))
      throw Error("recovery_incomplete_discovery");
    instructions.push(ix(8, sid));
  }
  return { instructions, refundableLamports: total };
}
