import {
  address,
  AccountRole,
  createAddressWithSeed,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  type Blockhash,
} from "@solana/kit";
import { concat, u32, u64, utf8, SYSTEM } from "./protocol";

// Loader-v3's stable bincode instruction/layout ABI. Program creation and
// deployment must be atomic; only the owner signs, including seeded creation.
export const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const BUFFER_HEADER = 37,
  PROGRAM_SIZE = 36,
  PROGRAM_DATA_HEADER = 45;
export const PROGRAM_CHUNK = 768;
const bytes = (a: Address) => Uint8Array.from(getAddressEncoder().encode(a));
const meta = (a: Address, role = AccountRole.READONLY) => ({
  address: a,
  role,
});
export async function loaderAddresses(owner: Address, nonce: string) {
  if (!/^[a-f0-9]{30}$/.test(nonce))
    throw new Error("Invalid deployment nonce");
  const bufferSeed = `b-${nonce}`,
    programSeed = `p-${nonce}`;
  const buffer = await createAddressWithSeed({
    baseAddress: owner,
    programAddress: LOADER,
    seed: bufferSeed,
  });
  const program = await createAddressWithSeed({
    baseAddress: owner,
    programAddress: LOADER,
    seed: programSeed,
  });
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [bytes(program)],
  });
  return { buffer, program, programData, bufferSeed, programSeed };
}
export function createSeeded(
  owner: Address,
  target: Address,
  seed: string,
  size: number,
  rent: bigint,
): Instruction {
  const encoded = utf8.encode(seed);
  if (encoded.length > 32) throw new Error("Seed too long");
  return {
    programAddress: SYSTEM,
    accounts: [
      meta(owner, AccountRole.WRITABLE_SIGNER),
      meta(target, AccountRole.WRITABLE),
      meta(owner, AccountRole.READONLY_SIGNER),
    ],
    data: concat(
      u32(3),
      bytes(owner),
      u64(BigInt(encoded.length)),
      encoded,
      u64(rent),
      u64(BigInt(size)),
      bytes(LOADER),
    ),
  };
}
export function initializeBuffer(owner: Address, buffer: Address): Instruction {
  return {
    programAddress: LOADER,
    accounts: [meta(buffer, AccountRole.WRITABLE), meta(owner)],
    data: u32(0),
  };
}
export function writeBuffer(
  owner: Address,
  buffer: Address,
  offset: number,
  data: Uint8Array,
): Instruction {
  if (!data.length || data.length > PROGRAM_CHUNK)
    throw new Error("Invalid program chunk");
  return {
    programAddress: LOADER,
    accounts: [
      meta(buffer, AccountRole.WRITABLE),
      meta(owner, AccountRole.READONLY_SIGNER),
    ],
    data: concat(u32(1), u32(offset), u64(BigInt(data.length)), data),
  };
}
export function deployProgram(
  owner: Address,
  a: Awaited<ReturnType<typeof loaderAddresses>>,
  size: number,
): Instruction {
  return {
    programAddress: LOADER,
    accounts: [
      meta(owner, AccountRole.WRITABLE_SIGNER),
      meta(a.programData, AccountRole.WRITABLE),
      meta(a.program, AccountRole.WRITABLE),
      meta(a.buffer, AccountRole.WRITABLE),
      meta(address("SysvarRent111111111111111111111111111111111")),
      meta(address("SysvarC1ock11111111111111111111111111111111")),
      meta(SYSTEM),
      meta(owner, AccountRole.READONLY_SIGNER),
    ],
    data: concat(u32(2), u64(BigInt(size))),
  };
}
export function closeBuffer(owner: Address, buffer: Address): Instruction {
  return {
    programAddress: LOADER,
    accounts: [
      meta(buffer, AccountRole.WRITABLE),
      meta(owner, AccountRole.WRITABLE),
      meta(owner, AccountRole.READONLY_SIGNER),
    ],
    data: u32(5),
  };
}
export function loaderTransaction(
  owner: Address,
  instructions: Instruction[],
  life: { blockhash: Blockhash; lastValidBlockHeight: bigint },
) {
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      life,
      setTransactionMessageFeePayer(
        owner,
        setTransactionMessageComputeUnitPrice(
          0n,
          setTransactionMessageComputeUnitLimit(
            500_000,
            createTransactionMessage({ version: 0 }),
          ),
        ),
      ),
    ),
  );
  const tx = compileTransaction(message);
  const wire = Uint8Array.from(getTransactionEncoder().encode(tx));
  if (wire.length > 1232)
    throw new Error("Program transaction exceeds wire limit");
  return { tx, wire };
}
