//! Public onchain inference account lifecycle. Numeric inputs and outputs are public.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, hash::hashv, pubkey::Pubkey,
};
mod common;
mod execution_mode;
mod inference_memo;
mod model;
mod session;
mod text;
mod tokenizer_registry;
use common::*;
#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);
mod approved_signers;
pub fn process_instruction(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    approved_signers::check(a)?;
    if execution_mode::wrapped(ix) {
        return execution_mode::process(p, a, ix);
    }
    process_legacy(p, a, ix)
}
fn process_legacy(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    if ix.starts_with(&inference_memo::DISCRIMINATOR) {
        return inference_memo::process(a, ix);
    }
    require(!ix.is_empty(), 10)?;
    match ix[0] {
        0..=6 => model::process(p, a, ix),
        7..=13 | 26 => session::process(p, a, ix),
        14..=20 => tokenizer_registry::process(p, a, ix),
        21..=25 => text::process(p, a, ix),
        _ => Err(err(10)),
    }
}
