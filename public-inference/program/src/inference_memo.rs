//! Receipt commitment only: this instruction does not prove model execution.
use crate::common::require;
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    pubkey,
    pubkey::Pubkey,
};
pub const DISCRIMINATOR: [u8; 8] = [0xb2, 0x5b, 0x7e, 0xed, 0x62, 0x5a, 0x6b, 0xa1];
const MEMO: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
pub fn process(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(
        data.len() == 40 && data[..8] == DISCRIMINATOR && accounts.len() == 2,
        10,
    )?;
    let publisher = &accounts[0];
    let memo = &accounts[1];
    require(publisher.is_signer && !publisher.executable, 4)?;
    require(
        *memo.key == MEMO && memo.executable && !memo.is_writable && !memo.is_signer,
        6,
    )?;
    let mut text = b"slm:receipt:v1:".to_vec();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in &data[8..] {
        text.push(HEX[(byte >> 4) as usize]);
        text.push(HEX[(byte & 15) as usize]);
    }
    invoke(
        &Instruction {
            program_id: MEMO,
            accounts: vec![AccountMeta::new_readonly(*publisher.key, true)],
            data: text,
        },
        &[publisher.clone(), memo.clone()],
    )
}
