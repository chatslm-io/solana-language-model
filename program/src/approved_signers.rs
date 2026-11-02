use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

static APPROVED_SIGNERS: [Pubkey; 2] = [
    Pubkey::from_str_const(env!("SLM_APPROVED_SIGNER_1")),
    Pubkey::from_str_const(env!("SLM_APPROVED_SIGNER_2")),
];

pub fn check(accounts: &[AccountInfo]) -> ProgramResult {
    match accounts.first() {
        Some(authority)
            if authority.is_signer
                && core::hint::black_box(&APPROVED_SIGNERS).contains(authority.key) =>
        {
            Ok(())
        }
        _ => Err(ProgramError::Custom(4)),
    }
}
