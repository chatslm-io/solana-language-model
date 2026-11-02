// Shared owner-funded allocation and full-refund helpers.
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
pub(crate) fn err(n: u32) -> ProgramError {
    ProgramError::Custom(n)
}
pub(crate) fn require(b: bool, n: u32) -> ProgramResult {
    if b {
        Ok(())
    } else {
        Err(err(n))
    }
}
pub(crate) fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
pub(crate) fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
pub(crate) fn put32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes())
}
pub(crate) fn writable(a: &AccountInfo) -> ProgramResult {
    require(a.is_writable, 1)
}
pub(crate) fn allocate<'a>(
    payer: &AccountInfo<'a>,
    a: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    p: &Pubkey,
    n: usize,
    cap: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    writable(payer)?;
    writable(a)?;
    require(*system.key == system_program::id() && system.executable, 6)?;
    require(*a.owner == system_program::id() && a.data_is_empty(), 2)?;
    let debit = Rent::get()?.minimum_balance(n).saturating_sub(a.lamports());
    require(debit <= cap, 7)?;
    if debit > 0 {
        invoke(
            &system_instruction::transfer(payer.key, a.key, debit),
            &[payer.clone(), a.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(a.key, n as u64),
        &[a.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(a.key, p),
        &[a.clone(), system.clone()],
        &[seeds],
    )
}
pub(crate) fn close(a: &AccountInfo, to: &AccountInfo) -> ProgramResult {
    writable(a)?;
    writable(to)?;
    require(a.key != to.key, 8)?;
    let n = to.lamports().checked_add(a.lamports()).ok_or(err(9))?;
    **to.try_borrow_mut_lamports()? = n;
    **a.try_borrow_mut_lamports()? = 0;
    a.realloc(0, false)?;
    a.assign(&system_program::id());
    Ok(())
}
