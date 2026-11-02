//! Arithmetic compatibility benchmark only: no encryption, no secret inputs.
#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hash,
    log::sol_log_compute_units, program::set_return_data, program_error::ProgramError,
    pubkey::Pubkey,
};
use tfhe_ntt::prime32::Plan;
entrypoint!(process);
// The local benchmark always requests the full 256KiB heap. No deployed API.
#[cfg(target_os = "solana")]
#[global_allocator]
#[allow(deprecated)]
static ALLOCATOR: solana_program::entrypoint::BumpAllocator =
    solana_program::entrypoint::BumpAllocator {
        start: solana_program::entrypoint::HEAP_START_ADDRESS as usize,
        len: 256 * 1024,
    };

// Upstream documentation's public prime; supports these negacyclic sizes.
const P: u32 = 1_062_862_849;
pub fn process(_: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if !accounts.is_empty() || data.len() < 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let n = u16::from_le_bytes([data[1], data[2]]) as usize;
    if !matches!(n, 32 | 64 | 128 | 256 | 512 | 1024 | 2048 | 4096) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut values = Vec::with_capacity(2 * n);
    match data[0] {
        0 if n <= 256 && data.len() == 3 + 8 * n => {
            for bytes in data[3..].chunks_exact(4) {
                let x = u32::from_le_bytes(bytes.try_into().unwrap());
                if x >= P {
                    return Err(ProgramError::InvalidInstructionData);
                }
                values.push(x);
            }
        }
        1 if data.len() == 7 => {
            // Public deterministic benchmark vectors, not cryptographic randomness.
            let seed = u32::from_le_bytes(data[3..7].try_into().unwrap());
            for i in 0..2 * n {
                values.push(seed.wrapping_add((i as u32).wrapping_mul(17)) % 251);
            }
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
    sol_log_compute_units();
    let plan = Plan::try_new(n, P).ok_or(ProgramError::InvalidArgument)?;
    sol_log_compute_units();
    let (lhs, rhs) = values.split_at_mut(n);
    plan.fwd(lhs);
    plan.fwd(rhs);
    sol_log_compute_units();
    plan.mul_assign_normalize(lhs, rhs);
    sol_log_compute_units();
    plan.inv(lhs);
    sol_log_compute_units();
    let mut out = Vec::with_capacity(4 * n);
    for x in lhs.iter() {
        out.extend_from_slice(&x.to_le_bytes());
    }
    if data[0] == 0 {
        set_return_data(&out);
    } else {
        set_return_data(hash(&out).as_ref());
    }
    Ok(())
}
