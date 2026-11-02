//! Separate recoverable private-execution account protocol. No production backend is registered.
#![allow(unexpected_cfgs, deprecated)]
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hashv,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);
#[cfg(all(
    feature = "experimental-half-gates",
    feature = "test-only-mock-evaluator"
))]
compile_error!("real and mock evaluator features are mutually exclusive");
#[cfg(any(
    all(feature = "experimental-circuit", feature = "experimental-half-gates"),
    all(feature = "experimental-circuit", feature = "test-only-mock-evaluator")
))]
compile_error!("circuit, single-gate and mock evaluators are distinct build flavors");
#[cfg(all(
    feature = "experimental-stream",
    any(
        feature = "experimental-circuit",
        feature = "experimental-half-gates",
        feature = "test-only-mock-evaluator"
    )
))]
compile_error!("streaming is a separate evaluator build flavor");
mod circuit;
mod streaming;
const SESSION: &[u8] = b"slm-pi-session";
const PAGE: &[u8] = b"slm-pi-page";
pub const SESSION_BYTES: usize = 256;
pub const PAGE_HEADER: usize = 192;
pub const MAX_PAGES: u32 = 16;
pub const MAX_PAGE_BYTES: usize = 8192;
fn err(n: u32) -> ProgramError {
    ProgramError::Custom(n)
}
fn require(b: bool, n: u32) -> ProgramResult {
    if b {
        Ok(())
    } else {
        Err(err(n))
    }
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn put32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes())
}
fn writable(a: &AccountInfo) -> ProgramResult {
    require(a.is_writable, 1)
}
fn session(a: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    require(
        d.len() == SESSION_BYTES && &d[..8] == b"SLMPIS01" && d[8] == 1 && d[9] == 1,
        3,
    )?;
    let (key, bump) = Pubkey::find_program_address(&[SESSION, &d[16..48], &d[80..112]], p);
    require(key == *a.key && bump == d[11], 5)
}
fn authority(a: &AccountInfo, s: &AccountInfo, owner_only: bool) -> ProgramResult {
    require(a.is_signer, 4)?;
    let d = s.try_borrow_data()?;
    require(
        a.key.as_ref() == &d[16..48] || (!owner_only && a.key.as_ref() == &d[48..80]),
        4,
    )
}
fn page(a: &AccountInfo, s: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    require(
        d.len() >= PAGE_HEADER && &d[..8] == b"SLMPIP01" && d[8] == 1 && d[9] == 2,
        3,
    )?;
    require(
        &d[16..48] == &sd[16..48] && &d[48..80] == s.key.as_ref() && d[128..160] == sd[112..144],
        5,
    )?;
    let (key, bump) = Pubkey::find_program_address(&[PAGE, s.key.as_ref(), &d[80..84]], p);
    require(
        key == *a.key && bump == d[11] && u32_at(&d, 80) < u32_at(&sd, 212),
        5,
    )?;
    require(
        u32_at(&d, 84) > 0
            && u32_at(&d, 84) as usize <= MAX_PAGE_BYTES
            && d.len() == PAGE_HEADER + u32_at(&d, 84) as usize,
        3,
    )
}
fn live(s: &AccountInfo) -> ProgramResult {
    let d = s.try_borrow_data()?;
    require(d[10] < 4 && Clock::get()?.slot <= u64_at(&d, 232), 13)
}
fn allocate<'a>(
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
fn close(a: &AccountInfo, to: &AccountInfo) -> ProgramResult {
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
pub fn process_instruction(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(!ix.is_empty() && a.len() >= 2, 10)?;
    if ix[0] == 0 {
        require(ix.len() == 425 && a.len() == 3, 10)?;
        require(a[0].is_signer, 4)?;
        let b = &ix[1..413];
        require(
            &b[..8] == b"SLMPIB01" && &b[40..72] == p.as_ref() && &b[104..136] == a[0].key.as_ref(),
            10,
        )?;
        let count = u32_at(ix, 413);
        let steps = u32_at(b, 400);
        require(
            count > 0
                && count <= MAX_PAGES
                && steps > 0
                && u32_at(b, 392) > 0
                && u32_at(b, 396) > 0,
            11,
        )?;
        require(u64_at(b, 404) > Clock::get()?.slot, 13)?;
        let (key, bump) =
            Pubkey::find_program_address(&[SESSION, a[0].key.as_ref(), &b[168..200]], p);
        require(key == *a[1].key, 5)?;
        allocate(
            &a[0],
            &a[1],
            &a[2],
            p,
            SESSION_BYTES,
            u64_at(ix, 417),
            &[SESSION, a[0].key.as_ref(), &b[168..200], &[bump]],
        )?;
        let mut d = a[1].try_borrow_mut_data()?;
        d.fill(0);
        d[..8].copy_from_slice(b"SLMPIS01");
        d[8] = 1;
        d[9] = 1;
        d[11] = bump;
        d[16..48].copy_from_slice(a[0].key.as_ref());
        d[48..80].copy_from_slice(&b[136..168]);
        d[80..112].copy_from_slice(&b[168..200]);
        d[112..144].copy_from_slice(hashv(&[b"slm-private:session:v1\n", b]).as_ref());
        d[144..176].copy_from_slice(&b[360..392]);
        put32(&mut d, 212, count);
        put32(&mut d, 224, steps);
        d[232..240].copy_from_slice(&b[404..412]);
        return Ok(());
    }
    session(&a[1], p)?;
    writable(&a[1])?;
    if matches!(ix[0], 6..=12 | 17 | 18) {
        authority(&a[0], &a[1], true)?;
    } else {
        authority(&a[0], &a[1], false)?;
        live(&a[1])?;
    }
    match ix[0] {
        1 => {
            // Create page, owner funds; delegates never debit owner.
            require(a.len() == 4 && ix.len() == 53, 10)?;
            require(a[0].key.as_ref() == &a[1].try_borrow_data()?[16..48], 4)?;
            let index = u32_at(ix, 1);
            let purpose = u32_at(ix, 5);
            let len = u32_at(ix, 9) as usize;
            let sd = a[1].try_borrow_data()?;
            require(
                sd[10] == 0
                    && index < u32_at(&sd, 212)
                    && purpose == 1
                    && len > 0
                    && len <= MAX_PAGE_BYTES,
                11,
            )?;
            let binding: [u8; 32] = sd[112..144].try_into().unwrap();
            drop(sd);
            let idx = index.to_le_bytes();
            let (key, bump) = Pubkey::find_program_address(&[PAGE, a[1].key.as_ref(), &idx], p);
            require(key == *a[2].key, 5)?;
            allocate(
                &a[0],
                &a[2],
                &a[3],
                p,
                PAGE_HEADER + len,
                u64_at(ix, 45),
                &[PAGE, a[1].key.as_ref(), &idx, &[bump]],
            )?;
            let mut d = a[2].try_borrow_mut_data()?;
            d.fill(0);
            d[..8].copy_from_slice(b"SLMPIP01");
            d[8] = 1;
            d[9] = 2;
            d[11] = bump;
            d[16..48].copy_from_slice(a[0].key.as_ref());
            d[48..80].copy_from_slice(a[1].key.as_ref());
            put32(&mut d, 80, index);
            put32(&mut d, 84, len as u32);
            put32(&mut d, 92, purpose);
            d[96..128].copy_from_slice(&ix[13..45]);
            d[128..160].copy_from_slice(&binding);
            let mut sd = a[1].try_borrow_mut_data()?;
            let n = u32_at(&sd, 216);
            put32(&mut sd, 216, n.checked_add(1).ok_or(err(9))?);
            Ok(())
        }
        2 => {
            require(a.len() == 3 && ix.len() > 5 && ix.len() <= 805, 10)?;
            page(&a[2], &a[1], p)?;
            writable(&a[2])?;
            require(a[1].try_borrow_data()?[10] == 0, 13)?;
            let mut d = a[2].try_borrow_mut_data()?;
            require(d[10] == 0, 13)?;
            let start = u32_at(ix, 1) as usize;
            let end = start.checked_add(ix.len() - 5).ok_or(err(9))?;
            let cursor = u32_at(&d, 88) as usize;
            require(end <= u32_at(&d, 84) as usize, 14)?;
            if start < cursor {
                return require(
                    end <= cursor && d[PAGE_HEADER + start..PAGE_HEADER + end] == ix[5..],
                    15,
                );
            }
            require(start == cursor, 15)?;
            d[PAGE_HEADER + start..PAGE_HEADER + end].copy_from_slice(&ix[5..]);
            put32(&mut d, 88, end as u32);
            Ok(())
        }
        3 => {
            require(a.len() == 3 && ix.len() == 1, 10)?;
            page(&a[2], &a[1], p)?;
            writable(&a[2])?;
            require(a[1].try_borrow_data()?[10] == 0, 13)?;
            let mut d = a[2].try_borrow_mut_data()?;
            if d[10] == 1 {
                return Ok(());
            }
            require(u32_at(&d, 88) == u32_at(&d, 84), 11)?;
            let h = hashv(&[
                b"slm-private:page:v1\n",
                &d[80..84],
                &d[92..96],
                &d[84..88],
                &d[PAGE_HEADER..],
            ]);
            require(h.as_ref() == &d[96..128], 16)?;
            d[10] = 1;
            let mut sd = a[1].try_borrow_mut_data()?;
            let n = u32_at(&sd, 220);
            put32(&mut sd, 220, n + 1);
            Ok(())
        }
        4 => {
            require(ix.len() == 1, 10)?;
            let sd = a[1].try_borrow_data()?;
            let count = u32_at(&sd, 212) as usize;
            require(
                sd[10] == 0
                    && a.len() == 2 + count
                    && u32_at(&sd, 216) == count as u32
                    && u32_at(&sd, 220) == count as u32,
                13,
            )?;
            drop(sd);
            let mut hashes = Vec::with_capacity(count * 32);
            for (i, pa) in a[2..].iter().enumerate() {
                page(pa, &a[1], p)?;
                let d = pa.try_borrow_data()?;
                require(d[10] == 1 && u32_at(&d, 80) == i as u32, 15)?;
                hashes.extend_from_slice(&d[96..128]);
            }
            let h = hashv(&[b"slm-private:pages:v1\n", &hashes]);
            let mut sd = a[1].try_borrow_mut_data()?;
            require(h.as_ref() == &sd[144..176], 16)?;
            sd[10] = 1;
            Ok(())
        }
        5 => {
            #[cfg(feature = "experimental-circuit")]
            {
                return circuit::step(p, a, ix);
            }
            #[cfg(not(feature = "experimental-circuit"))]
            {
                require(
                    ix.len() == 81 && (a.len() == 2 || a.len() == 3) && &ix[1..9] == b"SLMPIS01",
                    10,
                )?;
                let d = a[1].try_borrow_mut_data()?;
                require(
                    (d[10] == 1 || d[10] == 2)
                        && u32_at(ix, 73) == u32_at(&d, 208)
                        && ix[9..41] == d[112..144]
                        && ix[41..73] == d[176..208]
                        && u32_at(ix, 77) == 1,
                    15,
                )?;
                // Experimental real gate: immutable page commitment binds labels and tables.
                #[cfg(feature = "experimental-half-gates")]
                {
                    require(
                        a.len() == 3
                            && u32_at(&d, 224) == 1
                            && u32_at(&d, 212) == 1
                            && u32_at(&d, 208) == 0,
                        11,
                    )?;
                    let namespace: [u8; 32] = d[80..112].try_into().unwrap();
                    drop(d);
                    page(&a[2], &a[1], p)?;
                    let pd = a[2].try_borrow_data()?;
                    require(
                        pd[10] == 1 && u32_at(&pd, 80) == 0 && u32_at(&pd, 84) == 169,
                        11,
                    )?;
                    let x = &pd[PAGE_HEADER..];
                    require(x[0] == 1 && x[1..33] == namespace && u64_at(x, 33) == 0, 16)?;
                    let output = slm_private_crypto::evaluate_and(
                        x[41..73].try_into().unwrap(),
                        x[73..105].try_into().unwrap(),
                        x[105..137].try_into().unwrap(),
                        x[137..169].try_into().unwrap(),
                        &namespace,
                        0,
                    );
                    let mut d = a[1].try_borrow_mut_data()?;
                    d[176..208].copy_from_slice(&output);
                    put32(&mut d, 208, 1);
                    d[10] = 3;
                    return Ok(());
                }
                // Deliberately inaccessible unless explicitly compiled as a lifecycle test fixture.
                #[cfg(not(any(
                    feature = "test-only-mock-evaluator",
                    feature = "experimental-half-gates"
                )))]
                {
                    return Err(err(20));
                }
                #[cfg(feature = "test-only-mock-evaluator")]
                {
                    let mut d = d;
                    let seq = u32_at(&d, 208);
                    let h = hashv(&[
                        b"TEST-ONLY-MOCK-NOT-INFERENCE",
                        &d[112..176],
                        &seq.to_le_bytes(),
                    ]);
                    d[176..208].copy_from_slice(h.as_ref());
                    put32(&mut d, 208, seq + 1);
                    d[10] = if seq + 1 == u32_at(&d, 224) { 3 } else { 2 };
                    Ok(())
                }
            }
        }
        6 => {
            require(ix.len() == 1 && a.len() == 2, 10)?;
            a[1].try_borrow_mut_data()?[10] = 4;
            Ok(())
        }
        7 => {
            require(ix.len() == 1 && a.len() == 3, 10)?;
            page(&a[2], &a[1], p)?;
            let mut sd = a[1].try_borrow_mut_data()?;
            sd[10] = 4;
            let n = u32_at(&sd, 216);
            put32(&mut sd, 216, n.checked_sub(1).ok_or(err(9))?);
            drop(sd);
            close(&a[2], &a[0])
        }
        8 => {
            require(ix.len() == 1 && a.len() == 2, 10)?;
            require(
                u32_at(&a[1].try_borrow_data()?, 216) == 0
                    && u32_at(&a[1].try_borrow_data()?, 228) == 0
                    && u32_at(&a[1].try_borrow_data()?, 240) == 0,
                17,
            )?;
            close(&a[1], &a[0])
        }
        9 => {
            #[cfg(feature = "experimental-circuit")]
            {
                return circuit::initialize(p, a, ix);
            }
            #[cfg(not(feature = "experimental-circuit"))]
            {
                Err(err(20))
            }
        }
        10 => circuit::close_wires(p, a, ix),
        11..=16 => {
            #[cfg(feature = "experimental-stream")]
            {
                match ix[0] {
                    11 => streaming::initialize_slot(p, a, ix),
                    12 => streaming::initialize_window(p, a, ix),
                    13 => streaming::begin(p, a, ix),
                    14 => streaming::write(p, a, ix),
                    15 => streaming::seal(p, a, ix),
                    16 => streaming::step(p, a, ix),
                    _ => unreachable!(),
                }
            }
            #[cfg(not(feature = "experimental-stream"))]
            {
                Err(err(20))
            }
        }
        17 => streaming::close_slot(p, a, ix),
        18 => streaming::close_window(p, a, ix),
        _ => Err(err(10)),
    }
}
