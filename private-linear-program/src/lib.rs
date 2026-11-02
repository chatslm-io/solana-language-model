//! Experimental, stateless encrypted linear evaluation, not a transformer or FHE.
//! Ciphertexts are exponential ElGamal over canonical Ristretto255 points.
//! No plaintext, decryption key, account allocation, CPI, or mutable state is used.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    hash::{hash, hashv},
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub const INPUT_BYTES: usize = 328;
pub const OUTPUT_BYTES: usize = 136;
const INPUT_MAGIC: &[u8; 8] = b"SLMHEI01";
const OUTPUT_MAGIC: &[u8; 8] = b"SLMHEO01";
const DOMAIN: &[u8] = b"slm-private-linear:v1\n";
const MODEL: &[u8] =
    b"slm-private-linear:v1;inputs=4;weights=3,-2,5,1;bias=7;input-range=-255..255";
const BASEPOINT: [u8; 32] = [
    0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
    0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76,
];
const IDENTITY: [u8; 32] = [0; 32];
const RISTRETTO: u64 = 1;
const ADD: u64 = 0;
const SUBTRACT: u64 = 1;
const MULTIPLY: u64 = 2;

fn error(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

fn valid_point(point: &[u8; 32]) -> bool {
    #[cfg(target_os = "solana")]
    {
        let mut unused_result = 0u8;
        // The syscall validates canonical Ristretto compression, not Edwards bytes.
        unsafe {
            solana_program::syscalls::sol_curve_validate_point(
                RISTRETTO,
                point.as_ptr(),
                &mut unused_result,
            ) == 0
        }
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = point;
        false
    }
}

fn operation(op: u64, left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    #[cfg(target_os = "solana")]
    {
        let mut output = [0u8; 32];
        let result = unsafe {
            solana_program::syscalls::sol_curve_group_op(
                RISTRETTO,
                op,
                left.as_ptr(),
                right.as_ptr(),
                output.as_mut_ptr(),
            )
        };
        if result != 0 {
            return Err(error(4));
        }
        Ok(output)
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = (op, left, right);
        Err(error(4))
    }
}

fn multiply_small(value: u8, point: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let mut scalar = [0u8; 32];
    scalar[0] = value; // Canonical positive scalar, never signed/two's-complement.
    operation(MULTIPLY, &scalar, point)
}

pub fn process_instruction(
    _program: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    if input.len() != INPUT_BYTES || &input[..8] != INPUT_MAGIC {
        return Err(error(1));
    }
    // Fee-payer privilege promotion can make this account writable. We never mutate it.
    if accounts.len() != 1 || !accounts[0].is_signer {
        return Err(error(2));
    }
    let public_key: &[u8; 32] = input[8..40].try_into().map_err(|_| error(1))?;
    if public_key == &IDENTITY || !valid_point(public_key) {
        return Err(error(3));
    }

    let mut rs = [[0u8; 32]; 4];
    let mut cs = [[0u8; 32]; 4];
    for i in 0..4 {
        let at = 72 + i * 64;
        rs[i].copy_from_slice(&input[at..at + 32]);
        cs[i].copy_from_slice(&input[at + 32..at + 64]);
        if rs[i] == IDENTITY || !valid_point(&rs[i]) || !valid_point(&cs[i]) {
            return Err(error(3));
        }
        if rs[..i].contains(&rs[i]) {
            return Err(error(5));
        }
    }
    // Evaluate precisely 3*x0 - 2*x1 + 5*x2 + x3 + 7 on encrypted group elements.
    // Input range is a client contract; there is no encrypted range proof here.
    let mut output_r = multiply_small(3, &rs[0])?;
    let mut output_c = multiply_small(3, &cs[0])?;
    for (i, coefficient, op) in [(1usize, 2u8, SUBTRACT), (2usize, 5u8, ADD)] {
        output_r = operation(op, &output_r, &multiply_small(coefficient, &rs[i])?)?;
        output_c = operation(op, &output_c, &multiply_small(coefficient, &cs[i])?)?;
    }
    output_r = operation(ADD, &output_r, &rs[3])?;
    output_c = operation(ADD, &output_c, &cs[3])?;
    output_c = operation(ADD, &output_c, &multiply_small(7, &BASEPOINT)?)?;

    // Zero aggregate blinding would expose the bounded output through discrete log.
    // Honest clients must re-encrypt with fresh randomness if this rare case occurs.
    if output_r == IDENTITY {
        return Err(error(5));
    }
    let mut output = [0u8; OUTPUT_BYTES];
    output[..8].copy_from_slice(OUTPUT_MAGIC);
    output[8..40].copy_from_slice(hash(MODEL).as_ref());
    output[40..72].copy_from_slice(hashv(&[DOMAIN, accounts[0].key.as_ref(), input]).as_ref());
    output[72..104].copy_from_slice(&output_r);
    output[104..136].copy_from_slice(&output_c);
    set_return_data(&output);
    Ok(())
}
