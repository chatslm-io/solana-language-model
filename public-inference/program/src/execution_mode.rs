//! Mode 0 executes onchain. Values 1..=255 are reserved and rejected.
//! The 64-byte execution envelope and legacy account formats are unchanged.
use super::*;
use solana_program::{
    instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    log::sol_log_data,
    program::set_return_data,
    sysvar::instructions::{load_instruction_at_checked, ID},
};
pub const MAGIC: &[u8] = b"SLMM";
pub fn supported(tag: u8) -> bool {
    matches!(tag, 7..=13 | 21..=26)
}
pub fn wrapped(ix: &[u8]) -> bool {
    ix.len() >= 5
        && supported(ix[0])
        && !(ix[0] == 7 && ix.len() == 153 || ix[0] == 21 && ix.len() == 129)
        && &ix[1..5] == MAGIC
}
pub fn process(p: &Pubkey, accounts: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() >= 64 && ix[5] == 1 && ix[6] == 0 && ix[7] == 0, 10)?;
    require(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, 10)?;
    let (sys, a) = accounts.split_last().ok_or(err(10))?;
    require(*sys.key == ID && !sys.is_writable && !sys.is_signer, 10)?;
    require(!a.is_empty() && a[0].is_signer && !a[0].executable, 4)?;
    // All execution calls to this program in one transaction must use the same mode.
    let data = sys.try_borrow_data()?;
    require(data.len() >= 2, 10)?;
    let count = u16::from_le_bytes([data[0], data[1]]) as usize;
    drop(data);
    for i in 0..count {
        let other = load_instruction_at_checked(i, sys)?;
        if other.program_id == *p && !other.data.starts_with(&inference_memo::DISCRIMINATOR) {
            require(
                wrapped(&other.data) && other.data.len() >= 64 && other.data[6] == ix[6],
                10,
            )?;
        }
    }
    let mut legacy = Vec::with_capacity(ix.len() - 63);
    legacy.push(ix[0]);
    legacy.extend_from_slice(&ix[64..]);
    let mut result = [0u8; 64];
    result.copy_from_slice(&ix[..64]);
    require(ix[24..64].iter().all(|v| *v == 0), 10)?;
    process_legacy(p, a, &legacy)?;
    // Report post-execution session state; closed sessions retain zero fields.
    if a.len() > 1 && a[1].owner == p {
        let d = a[1].try_borrow_data()?;
        if d.len() == 384 && &d[..8] == b"SLMPUS01" {
            result[24..56].copy_from_slice(&d[208..240]);
            result[56..60].copy_from_slice(&d[184..188]);
            result[60..64].copy_from_slice(&d[248..252]);
        }
    }
    // Logs retain every call; return data retains the last 64-byte record.
    sol_log_data(&[b"slm:execution:v1", &result]);
    set_return_data(&result);
    Ok(())
}
