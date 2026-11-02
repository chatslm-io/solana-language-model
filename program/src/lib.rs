#![allow(unexpected_cfgs, deprecated)]
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);
mod approved_signers;

pub const HEADER: usize = 192;
pub const MAX_PAYLOAD: usize = 8192;
const MAGIC: &[u8; 8] = b"SLMSTOR1";
const REG: &[u8] = b"slm-reg-v1";
const SHARD: &[u8] = b"slm-shard-v1";
const SESSION: &[u8] = b"slm-session-v1";
mod session;
// Stable program error codes.
fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}
fn require(ok: bool, code: u32) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(err(code))
    }
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn put32(d: &mut [u8], o: usize, n: u32) {
    d[o..o + 4].copy_from_slice(&n.to_le_bytes());
}
fn put64(d: &mut [u8], o: usize, n: u64) {
    d[o..o + 8].copy_from_slice(&n.to_le_bytes());
}
fn writable(a: &AccountInfo) -> ProgramResult {
    require(a.is_writable, 1)
}
fn validate(a: &AccountInfo, program: &Pubkey, authority: &Pubkey, kind: u8) -> ProgramResult {
    require(a.owner == program && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    require(d.len() >= HEADER, 3)?;
    require(&d[..8] == MAGIC && d[8] == 1 && d[9] == kind, 3)?;
    require(&d[16..48] == authority.as_ref(), 4)?;
    let index = if kind == 2 {
        Some(u32_at(&d, 112).to_le_bytes())
    } else {
        None
    };
    let seeds: Vec<&[u8]> = if let Some(ref idx) = index {
        vec![SHARD, authority.as_ref(), &d[48..80], idx]
    } else {
        vec![
            if kind == 3 { SESSION } else { REG },
            authority.as_ref(),
            &d[48..80],
        ]
    };
    let (address, bump) = Pubkey::find_program_address(&seeds, program);
    require(address == *a.key && d[11] == bump, 5)
}
fn init_header(d: &mut [u8], kind: u8, bump: u8, authority: &Pubkey, id: &[u8]) {
    d.fill(0);
    d[..8].copy_from_slice(MAGIC);
    d[8] = 1;
    d[9] = kind;
    d[11] = bump;
    d[16..48].copy_from_slice(authority.as_ref());
    d[48..80].copy_from_slice(id);
}
fn allocate<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program: &Pubkey,
    space: usize,
    cap: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    writable(payer)?;
    writable(account)?;
    require(*system.key == system_program::id() && system.executable, 6)?;
    require(
        *account.owner == system_program::id() && account.data_is_empty(),
        2,
    )?;
    let rent = Rent::get()?.minimum_balance(space);
    let debit = rent.saturating_sub(account.lamports());
    require(debit <= cap, 7)?;
    // Supports pre-funded PDAs: a third-party dust transfer cannot prevent initialization.
    if debit > 0 {
        invoke(
            &system_instruction::transfer(payer.key, account.key, debit),
            &[payer.clone(), account.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, space as u64),
        &[account.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, program),
        &[account.clone(), system.clone()],
        &[seeds],
    )
}
fn transfer_all(account: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    writable(account)?;
    writable(recipient)?;
    require(account.key != recipient.key, 8)?;
    let amount = account.lamports();
    let balance = recipient.lamports().checked_add(amount).ok_or(err(9))?;
    **recipient.try_borrow_mut_lamports()? = balance;
    **account.try_borrow_mut_lamports()? = 0;
    account.realloc(0, false)?;
    account.assign(&system_program::id());
    Ok(())
}

pub fn process_instruction(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    approved_signers::check(a)?;
    require(!data.is_empty() && !a.is_empty(), 10)?;
    match data[0] {
        7 => session::open(program, a, data),
        8 => session::close(program, a, data),
        9 => session::execute(program, a, data),
        _ => {
            require(a[0].is_signer, 4)?;
            process_storage(program, a, data, None)
        }
    }
}

fn process_storage<'a>(
    program: &Pubkey,
    a: &[AccountInfo<'a>],
    data: &[u8],
    vault: Option<&AccountInfo<'a>>,
) -> ProgramResult {
    let authority = &a[0];
    match data[0] {
        0 => {
            require(data.len() == 85 && a.len() == 3, 10)?;
            let (registry, system) = (&a[1], &a[2]);
            let id = &data[1..33];
            let count = u32_at(data, 65);
            let bytes = u64_at(data, 69);
            require(
                count > 0 && bytes >= count as u64 && bytes <= count as u64 * MAX_PAYLOAD as u64,
                11,
            )?;
            let (key, bump) =
                Pubkey::find_program_address(&[REG, authority.key.as_ref(), id], program);
            require(*registry.key == key, 5)?;
            if registry.owner == program {
                validate(registry, program, authority.key, 1)?;
                let d = registry.try_borrow_data()?;
                return require(
                    d[10] != 2
                        && d[80..112] == data[33..65]
                        && u32_at(&d, 112) == count
                        && u64_at(&d, 128) == bytes,
                    12,
                );
            }
            allocate(
                authority,
                registry,
                system,
                program,
                HEADER,
                u64_at(data, 77),
                &[REG, authority.key.as_ref(), id, &[bump]],
            )?;
            let mut d = registry.try_borrow_mut_data()?;
            init_header(&mut d, 1, bump, authority.key, id);
            d[80..112].copy_from_slice(&data[33..65]);
            put32(&mut d, 112, count);
            put64(&mut d, 128, bytes);
        }
        1 => {
            require(data.len() == 49 && a.len() == 4, 10)?;
            let (registry, shard, system) = (&a[1], &a[2], &a[3]);
            validate(registry, program, authority.key, 1)?;
            writable(registry)?;
            let index = u32_at(data, 1);
            let len = u32_at(data, 5);
            require(len > 0 && len as usize <= MAX_PAYLOAD, 11)?;
            let mut r = registry.try_borrow_mut_data()?;
            require(r[10] == 0 && index < u32_at(&r, 112), 13)?;
            let id: [u8; 32] = r[48..80].try_into().unwrap();
            let idx = index.to_le_bytes();
            let (key, bump) =
                Pubkey::find_program_address(&[SHARD, authority.key.as_ref(), &id, &idx], program);
            require(*shard.key == key, 5)?;
            if shard.owner == program {
                validate(shard, program, authority.key, 2)?;
                let d = shard.try_borrow_data()?;
                return require(
                    u32_at(&d, 116) == len
                        && d[128..160] == data[9..41]
                        && &d[80..112] == registry.key.as_ref(),
                    12,
                );
            }
            let live = u32_at(&r, 116).checked_add(1).ok_or(err(9))?;
            let bytes = u64_at(&r, 136).checked_add(len as u64).ok_or(err(9))?;
            require(live <= u32_at(&r, 112) && bytes <= u64_at(&r, 128), 11)?;
            let seeds = [SHARD, authority.key.as_ref(), &id, &idx, &[bump]];
            if let Some(vault) = vault {
                session::allocate_shard(
                    vault,
                    shard,
                    system,
                    program,
                    HEADER + len as usize,
                    u64_at(data, 41),
                    &seeds,
                )?;
            } else {
                allocate(
                    authority,
                    shard,
                    system,
                    program,
                    HEADER + len as usize,
                    u64_at(data, 41),
                    &seeds,
                )?;
            }
            let mut d = shard.try_borrow_mut_data()?;
            init_header(&mut d, 2, bump, authority.key, &id);
            d[80..112].copy_from_slice(registry.key.as_ref());
            put32(&mut d, 112, index);
            put32(&mut d, 116, len);
            d[128..160].copy_from_slice(&data[9..41]);
            put32(&mut r, 116, live);
            put64(&mut r, 136, bytes);
        }
        2 | 3 | 4 => {
            let tag = data[0];
            require(a.len() == if tag == 4 { 4 } else { 3 }, 10)?;
            let (registry, shard) = (&a[1], &a[2]);
            validate(registry, program, authority.key, 1)?;
            // A repeated closure is safe, but still checks the intended address and recipient.
            if tag == 4 {
                require(data.len() == 5 && a[3].key == authority.key, 8)?;
                let r = registry.try_borrow_data()?;
                let idx = &data[1..5];
                require(u32_at(data, 1) < u32_at(&r, 112), 11)?;
                let (key, _) = Pubkey::find_program_address(
                    &[SHARD, authority.key.as_ref(), &r[48..80], idx],
                    program,
                );
                require(*shard.key == key, 5)?;
                if *shard.owner == system_program::id() && shard.data_is_empty() {
                    return Ok(());
                }
            }
            validate(shard, program, authority.key, 2)?;
            writable(shard)?;
            let mut d = shard.try_borrow_mut_data()?;
            let mut r = registry.try_borrow_mut_data()?;
            require(
                &d[80..112] == registry.key.as_ref() && d[48..80] == r[48..80],
                5,
            )?;
            let len = u32_at(&d, 116) as usize;
            let written = u32_at(&d, 120) as usize;
            require(
                len > 0 && len <= MAX_PAYLOAD && d.len() == HEADER + len && written <= len,
                3,
            )?;
            if tag == 2 {
                require(data.len() > 5 && data.len() <= 773, 10)?;
                require(r[10] == 0 && d[10] == 0, 13)?;
                let offset = u32_at(data, 1) as usize;
                let chunk = &data[5..];
                let end = offset.checked_add(chunk.len()).ok_or(err(9))?;
                require(end <= len, 14)?;
                if offset < written {
                    return require(
                        end <= written && &d[HEADER + offset..HEADER + end] == chunk,
                        15,
                    );
                }
                require(offset == written, 15)?;
                d[HEADER + offset..HEADER + end].copy_from_slice(chunk);
                put32(&mut d, 120, end as u32);
            } else if tag == 3 {
                require(data.len() == 1, 10)?;
                writable(registry)?;
                require(r[10] != 2 && written == len, 13)?;
                if d[10] == 1 {
                    return Ok(());
                }
                require(hash(&d[HEADER..]).as_ref() == &d[128..160], 16)?;
                d[10] = 1;
                let finalized = u32_at(&r, 120).checked_add(1).ok_or(err(9))?;
                put32(&mut r, 120, finalized);
            } else {
                writable(registry)?;
                let live = u32_at(&r, 116).checked_sub(1).ok_or(err(9))?;
                let bytes = u64_at(&r, 136).checked_sub(len as u64).ok_or(err(9))?;
                if d[10] == 1 {
                    let n = u32_at(&r, 120).checked_sub(1).ok_or(err(9))?;
                    put32(&mut r, 120, n);
                }
                r[10] = 2;
                put32(&mut r, 116, live);
                put64(&mut r, 136, bytes);
                drop(d);
                drop(r);
                transfer_all(shard, &a[3])?;
            }
        }
        5 => {
            require(data.len() == 33 && a.len() == 3, 10)?;
            require(a[2].key == authority.key, 8)?;
            let (key, _) =
                Pubkey::find_program_address(&[REG, authority.key.as_ref(), &data[1..]], program);
            require(*a[1].key == key, 5)?;
            if *a[1].owner == system_program::id() && a[1].data_is_empty() {
                return Ok(());
            }
            validate(&a[1], program, authority.key, 1)?;
            require(u32_at(&a[1].try_borrow_data()?, 116) == 0, 17)?;
            transfer_all(&a[1], &a[2])?;
        }
        6 => {
            require(data.len() == 1 && a.len() == 2, 10)?;
            validate(&a[1], program, authority.key, 1)?;
            writable(&a[1])?;
            let mut r = a[1].try_borrow_mut_data()?;
            require(
                r[10] != 2
                    && u32_at(&r, 112) == u32_at(&r, 116)
                    && u32_at(&r, 112) == u32_at(&r, 120)
                    && u64_at(&r, 128) == u64_at(&r, 136),
                13,
            )?;
            r[10] = 1;
        }
        _ => return Err(err(10)),
    }
    Ok(())
}
