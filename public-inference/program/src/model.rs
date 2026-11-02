use super::*;
pub const MODEL: &[u8] = b"slm-pu-model";
pub const PAGE: &[u8] = b"slm-pu-artifact";
pub const HEADER: usize = 192;
pub const MODEL_BYTES: usize = 384;
pub const PAGE_BYTES: usize = 8192;
pub fn validate(a: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    require(
        d.len() == MODEL_BYTES && &d[..8] == b"SLMPUM01" && d[8] == 1 && d[9] == 1,
        3,
    )?;
    let (k, b) = Pubkey::find_program_address(&[MODEL, &d[16..48], &d[48..80]], p);
    require(k == *a.key && b == d[11], 5)
}
pub fn authority(owner: &AccountInfo, m: &AccountInfo) -> ProgramResult {
    require(
        owner.is_signer && owner.key.as_ref() == &m.try_borrow_data()?[16..48],
        4,
    )
}
pub fn page(a: &AccountInfo, m: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let md = m.try_borrow_data()?;
    require(
        d.len() >= HEADER && &d[..8] == b"SLMPUA01" && d[8] == 1 && d[9] == 2,
        3,
    )?;
    require(
        &d[16..48] == &md[16..48] && &d[48..80] == m.key.as_ref() && d[128..160] == md[80..112],
        5,
    )?;
    let index = u32_at(&d, 80);
    let n = u32_at(&d, 84) as usize;
    let (k, b) = Pubkey::find_program_address(&[PAGE, m.key.as_ref(), &index.to_le_bytes()], p);
    require(
        k == *a.key
            && b == d[11]
            && index < u32_at(&md, 144)
            && n > 0
            && n <= PAGE_BYTES
            && d.len() == HEADER + n,
        5,
    )
}
fn binding(d: &[u8]) -> ProgramResult {
    require(
        d.len() == 224 && &d[..8] == b"SLMPUB01" && d[208..].iter().all(|b| *b == 0),
        10,
    )?;
    let pages = u32_at(d, 168);
    let weights = u32_at(d, 172);
    let plans = u32_at(d, 180);
    let commands = u32_at(d, 184);
    require(
        pages > 0
            && pages <= 4096
            && weights > 0
            && weights < pages
            && u32_at(d, 176) == weights
            && commands > 0
            && commands <= 65536
            && plans == (commands + 127) / 128
            && weights + plans == pages,
        11,
    )?;
    require(
        u32_at(d, 188) == 16
            && u32_at(d, 192) == 8196
            && u32_at(d, 196) == 4
            && u32_at(d, 200) == 128
            && u32_at(d, 204) == 16,
        11,
    )
}
fn leaf(index: u32, kind: u32, n: u32, payload_hash: &[u8]) -> [u8; 32] {
    hashv(&[
        b"slm-public:artifact:v1\n",
        &index.to_le_bytes(),
        &kind.to_le_bytes(),
        &n.to_le_bytes(),
        payload_hash,
    ])
    .to_bytes()
}
pub fn process(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(a.len() >= 2, 10)?;
    if ix[0] == 0 {
        require(ix.len() == 233 && a.len() == 3, 10)?;
        require(a[0].is_signer, 4)?;
        binding(&ix[1..225])?;
        let b = &ix[1..225];
        let (k, bump) = Pubkey::find_program_address(&[MODEL, a[0].key.as_ref(), &b[8..40]], p);
        require(k == *a[1].key, 5)?;
        allocate(
            &a[0],
            &a[1],
            &a[2],
            p,
            MODEL_BYTES,
            u64_at(ix, 225),
            &[MODEL, a[0].key.as_ref(), &b[8..40], &[bump]],
        )?;
        let mut d = a[1].try_borrow_mut_data()?;
        d[..8].copy_from_slice(b"SLMPUM01");
        d[8] = 1;
        d[9] = 1;
        d[11] = bump;
        d[16..48].copy_from_slice(a[0].key.as_ref());
        d[48..80].copy_from_slice(&b[8..40]);
        d[80..112].copy_from_slice(hashv(&[b"slm-public:model:v1\n", b]).as_ref());
        d[112..144].copy_from_slice(&b[104..136]);
        put32(&mut d, 144, u32_at(b, 168));
        d[160..384].copy_from_slice(b);
        return Ok(());
    }
    validate(&a[1], p)?;
    authority(&a[0], &a[1])?;
    writable(&a[1])?;
    match ix[0] {
        1 => {
            require(
                a.len() == 4 && ix.len() >= 53 && (ix.len() - 53) % 32 == 0,
                10,
            )?;
            let index = u32_at(ix, 1);
            let n = u32_at(ix, 5);
            let cap = u64_at(ix, 9);
            let expected = &ix[17..49];
            let kind = u32_at(ix, 49);
            let md = a[1].try_borrow_data()?;
            let total = u32_at(&md, 144);
            let weights = u32_at(&md, 332);
            let mut height = 0;
            let mut width = 1;
            while width < total {
                width *= 2;
                height += 1;
            }
            require(
                md[10] == 0
                    && index < total
                    && n > 0
                    && n <= 8192
                    && kind == if index < weights { 1 } else { 2 }
                    && ix.len() == 53 + height * 32,
                11,
            )?;
            if kind == 2 {
                let remaining = u32_at(&md, 344).saturating_sub((index - weights) * 128);
                require(n == remaining.min(128) * 64, 11)?;
            }
            let mut root = leaf(index, kind, n, expected);
            let mut cursor = index;
            for sibling in ix[53..].chunks_exact(32) {
                root = if cursor & 1 == 0 {
                    hashv(&[b"slm-public:artifact-node:v1\n", &root, sibling]).to_bytes()
                } else {
                    hashv(&[b"slm-public:artifact-node:v1\n", sibling, &root]).to_bytes()
                };
                cursor >>= 1;
            }
            require(root == md[112..144], 12)?;
            let binding_hash: [u8; 32] = md[80..112].try_into().unwrap();
            drop(md);
            let (k, bump) =
                Pubkey::find_program_address(&[PAGE, a[1].key.as_ref(), &index.to_le_bytes()], p);
            require(k == *a[2].key, 5)?;
            allocate(
                &a[0],
                &a[2],
                &a[3],
                p,
                HEADER + n as usize,
                cap,
                &[PAGE, a[1].key.as_ref(), &index.to_le_bytes(), &[bump]],
            )?;
            let mut d = a[2].try_borrow_mut_data()?;
            d[..8].copy_from_slice(b"SLMPUA01");
            d[8] = 1;
            d[9] = 2;
            d[11] = bump;
            d[16..48].copy_from_slice(a[0].key.as_ref());
            d[48..80].copy_from_slice(a[1].key.as_ref());
            put32(&mut d, 80, index);
            put32(&mut d, 84, n);
            put32(&mut d, 92, kind);
            d[96..128].copy_from_slice(expected);
            d[128..160].copy_from_slice(&binding_hash);
            let mut md = a[1].try_borrow_mut_data()?;
            let live = u32_at(&md, 148);
            put32(&mut md, 148, live.checked_add(1).ok_or(err(9))?);
            Ok(())
        }
        2 => {
            require(a.len() == 3 && ix.len() > 5 && ix.len() <= 705, 10)?;
            page(&a[2], &a[1], p)?;
            writable(&a[2])?;
            require(a[1].try_borrow_data()?[10] == 0, 13)?;
            let mut d = a[2].try_borrow_mut_data()?;
            require(d[10] == 0, 13)?;
            let offset = u32_at(ix, 1) as usize;
            let end = offset.checked_add(ix.len() - 5).ok_or(err(9))?;
            let written = u32_at(&d, 88) as usize;
            require(end <= u32_at(&d, 84) as usize && offset <= written, 11)?;
            if offset < written {
                require(
                    end <= written && d[HEADER + offset..HEADER + end] == ix[5..],
                    12,
                )?;
            } else {
                d[HEADER + offset..HEADER + end].copy_from_slice(&ix[5..]);
                put32(&mut d, 88, end as u32);
            }
            Ok(())
        }
        3 => {
            require(a.len() == 3 && ix.len() == 1, 10)?;
            page(&a[2], &a[1], p)?;
            writable(&a[2])?;
            let mut d = a[2].try_borrow_mut_data()?;
            require(d[10] == 0 && u32_at(&d, 88) == u32_at(&d, 84), 13)?;
            require(hashv(&[&d[HEADER..]]).as_ref() == &d[96..128], 12)?;
            d[10] = 1;
            let mut md = a[1].try_borrow_mut_data()?;
            require(md[10] == 0, 13)?;
            let count = u32_at(&md, 152);
            put32(&mut md, 152, count.checked_add(1).ok_or(err(9))?);
            Ok(())
        }
        4 => {
            require(a.len() == 2 && ix.len() == 1, 10)?;
            let mut d = a[1].try_borrow_mut_data()?;
            require(
                d[10] == 0
                    && u32_at(&d, 152) == u32_at(&d, 144)
                    && u32_at(&d, 148) == u32_at(&d, 144),
                13,
            )?;
            d[10] = 1;
            Ok(())
        }
        5 => {
            require(a.len() == 3 && ix.len() == 1, 10)?;
            page(&a[2], &a[1], p)?;
            let sealed = a[2].try_borrow_data()?[10] == 1;
            close(&a[2], &a[0])?;
            let mut d = a[1].try_borrow_mut_data()?;
            d[10] = 2;
            let count = u32_at(&d, 148);
            put32(&mut d, 148, count.checked_sub(1).ok_or(err(9))?);
            if sealed {
                let count = u32_at(&d, 152);
                put32(&mut d, 152, count.checked_sub(1).ok_or(err(9))?);
            }
            Ok(())
        }
        6 => {
            require(a.len() == 2 && ix.len() == 1, 10)?;
            require(u32_at(&a[1].try_borrow_data()?, 148) == 0, 13)?;
            close(&a[1], &a[0])
        }
        _ => Err(err(10)),
    }
}
