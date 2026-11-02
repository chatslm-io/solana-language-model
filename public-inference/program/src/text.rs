use super::*;
use slm_public_kernel::tokenizer::{self, Status};
use solana_program::{clock::Clock, sysvar::Sysvar};
pub const TEXT: &[u8] = b"slm-pu-text";
pub const HEADER: usize = 256;
pub const FRAME: usize = 548;
pub const WORK: usize = HEADER + FRAME;
pub const BYTES: usize = WORK + 3456;
fn validate(a: &AccountInfo, s: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    require(
        d.len() == BYTES
            && &d[..8] == b"SLMPTX01"
            && d[8] == 1
            && d[9] == 7
            && d[16..48] == sd[16..48]
            && &d[48..80] == s.key.as_ref()
            && d[80..112] == sd[144..176]
            && sd[12] == 1
            && u32_at(&sd, 180) == 1,
        5,
    )?;
    let (k, b) = Pubkey::find_program_address(&[TEXT, s.key.as_ref()], p);
    require(k == *a.key && b == d[11], 5)
}
pub fn process(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(a.len() >= 3, 10)?;
    if ix[0] == 21 {
        require(ix.len() == 129 && a.len() == 6 && a[0].is_signer, 10)?;
        model::validate(&a[2], p)?;
        tokenizer_registry::validate(&a[3], p)?;
        let md = a[2].try_borrow_data()?;
        let td = a[3].try_borrow_data()?;
        require(
            md[10] == 1
                && td[10] == 1
                && td[168..200] == *a[2].key.as_ref()
                && td[200..232] == md[80..112],
            12,
        )?;
        let expiry = u64_at(ix, 65);
        let requested = u32_at(ix, 73);
        let rawlen = u32_at(ix, 77);
        require(
            expiry > Clock::get()?.slot
                && requested > 0
                && requested <= 15
                && rawlen >= 12
                && rawlen <= FRAME as u32,
            11,
        )?;
        let (sk, sb) =
            Pubkey::find_program_address(&[session::SESSION, a[0].key.as_ref(), &ix[1..33]], p);
        require(sk == *a[1].key, 5)?;
        let (tk, tb) = Pubkey::find_program_address(&[TEXT, a[1].key.as_ref()], p);
        require(tk == *a[4].key, 5)?;
        allocate(
            &a[0],
            &a[1],
            &a[5],
            p,
            384,
            u64_at(ix, 113),
            &[session::SESSION, a[0].key.as_ref(), &ix[1..33], &[sb]],
        )?;
        allocate(
            &a[0],
            &a[4],
            &a[5],
            p,
            BYTES,
            u64_at(ix, 121),
            &[TEXT, a[1].key.as_ref(), &[tb]],
        )?;
        let mut sd = a[1].try_borrow_mut_data()?;
        sd[..8].copy_from_slice(b"SLMPUS01");
        sd[8] = 1;
        sd[9] = 3;
        sd[11] = sb;
        sd[12] = 1;
        sd[16..48].copy_from_slice(a[0].key.as_ref());
        sd[48..80].copy_from_slice(&ix[33..65]);
        sd[80..112].copy_from_slice(&ix[1..33]);
        sd[112..144].copy_from_slice(a[2].key.as_ref());
        sd[144..176].copy_from_slice(&md[80..112]);
        put32(&mut sd, 180, 1);
        sd[200..208].copy_from_slice(&expiry.to_le_bytes());
        put32(&mut sd, 252, requested);
        let mut d = a[4].try_borrow_mut_data()?;
        d[..8].copy_from_slice(b"SLMPTX01");
        d[8] = 1;
        d[9] = 7;
        d[11] = tb;
        d[16..48].copy_from_slice(a[0].key.as_ref());
        d[48..80].copy_from_slice(a[1].key.as_ref());
        d[80..112].copy_from_slice(&md[80..112]);
        d[112..144].copy_from_slice(a[3].key.as_ref());
        d[144..176].copy_from_slice(&ix[81..113]);
        put32(&mut d, 208, rawlen);
        return Ok(());
    }
    session::validate(&a[1], p)?;
    validate(&a[2], &a[1], p)?;
    writable(&a[1])?;
    writable(&a[2])?;
    let sd = a[1].try_borrow_data()?;
    let owner = a[0].key.as_ref() == &sd[16..48];
    require(
        a[0].is_signer && (owner || (ix[0] != 25 && a[0].key.as_ref() == &sd[48..80])),
        4,
    )?;
    if ix[0] != 25 {
        require(
            sd[10] == 0 && u32_at(&sd, 244) == 0 && Clock::get()?.slot <= u64_at(&sd, 200),
            13,
        )?;
    }
    drop(sd);
    match ix[0] {
        22 => {
            require(a.len() == 3 && ix.len() > 5 && ix.len() <= 705, 10)?;
            let mut d = a[2].try_borrow_mut_data()?;
            require(d[10] == 0, 13)?;
            let offset = u32_at(ix, 1) as usize;
            let end = offset.checked_add(ix.len() - 5).ok_or(err(9))?;
            let written = u32_at(&d, 212) as usize;
            require(end <= u32_at(&d, 208) as usize && offset <= written, 11)?;
            if offset < written {
                require(
                    end <= written && d[HEADER + offset..HEADER + end] == ix[5..],
                    12,
                )?;
            } else {
                d[HEADER + offset..HEADER + end].copy_from_slice(&ix[5..]);
                put32(&mut d, 212, end as u32);
            }
            Ok(())
        }
        23 => {
            require(a.len() == 3 && ix.len() == 1, 10)?;
            let mut d = a[2].try_borrow_mut_data()?;
            require(d[10] == 0 && u32_at(&d, 212) == u32_at(&d, 208), 13)?;
            let length = u32_at(&d, 208) as usize;
            require(
                hashv(&[&d[HEADER..HEADER + length]]).as_ref() == &d[144..176],
                12,
            )?;
            let requested = u32_at(&a[1].try_borrow_data()?, 252);
            let (frame, work) = d.split_at_mut(WORK);
            tokenizer::initialize(&frame[HEADER..HEADER + length], requested, work)
                .map_err(|_| err(30))?;
            let h = hashv(&[&d[WORK..]]);
            d[176..208].copy_from_slice(h.as_ref());
            d[10] = 1;
            Ok(())
        }
        24 => {
            require(ix.len() == 37 && (a.len() == 4 || a.len() == 5), 10)?;
            tokenizer_registry::validate(&a[3], p)?;
            let mut d = a[2].try_borrow_mut_data()?;
            let td = a[3].try_borrow_data()?;
            require(
                d[10] == 1
                    && td[10] == 1
                    && a[3].key.as_ref() == &d[112..144]
                    && td[200..232] == d[80..112]
                    && u32_at(&d, 216) < 133000
                    && u32_at(&d, 216) == u32_at(ix, 1)
                    && d[176..208] == ix[5..37]
                    && hashv(&[&d[WORK..]]).as_ref() == &d[176..208],
                12,
            )?;
            drop(td);
            let desired = tokenizer::desired_page(&d[WORK..]).map_err(|_| err(30))?;
            let mut pd = None;
            if let Some(index) = desired {
                require(a.len() == 5, 10)?;
                tokenizer_registry::page(&a[4], &a[3], p)?;
                let page = a[4].try_borrow_data()?;
                require(page[10] == 1 && u32_at(&page, 80) == index, 12)?;
                pd = Some(page);
            } else {
                require(a.len() == 4, 10)?;
            }
            let page = desired.zip(pd.as_ref().map(|d| &d[tokenizer_registry::HEADER..]));
            let status = tokenizer::step(&mut d[WORK..], page).map_err(|_| err(30))?;
            let seq = u32_at(&d, 216);
            put32(&mut d, 216, seq.checked_add(1).ok_or(err(9))?);
            let h = hashv(&[&d[WORK..]]);
            d[176..208].copy_from_slice(h.as_ref());
            if matches!(status, Status::Complete) {
                let ids = tokenizer::outputs(&d[WORK..]).map_err(|_| err(30))?;
                let count = ids.len() / 4;
                let mut sd = a[1].try_borrow_mut_data()?;
                require(
                    count > 0 && count <= 15 && count + u32_at(&sd, 252) as usize <= 16,
                    11,
                )?;
                sd[256..256 + ids.len()].copy_from_slice(ids);
                put32(&mut sd, 244, count as u32);
                put32(&mut sd, 184, u32_at(ids, 0));
                d[10] = 2;
            }
            Ok(())
        }
        25 => {
            require(owner && a.len() == 3 && ix.len() == 1, 10)?;
            close(&a[2], &a[0])?;
            let mut sd = a[1].try_borrow_mut_data()?;
            put32(&mut sd, 180, 0);
            sd[10] = 4;
            Ok(())
        }
        _ => Err(err(10)),
    }
}
