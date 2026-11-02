use super::*;
pub const MODEL: &[u8] = b"slm-pu-tokenizer";
pub const PAGE: &[u8] = b"slm-pu-tokpage";
pub const HEADER: usize = 192;
pub const MODEL_BYTES: usize = 384;
pub const PAGE_BYTES: usize = 8192;
pub fn validate(a: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    require(
        d.len() == MODEL_BYTES && &d[..8] == b"SLMPTR01" && d[8] == 1 && d[9] == 5,
        3,
    )?;
    let (k, b) = Pubkey::find_program_address(&[MODEL, &d[168..200], &d[112..144]], p);
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
        d.len() >= HEADER && &d[..8] == b"SLMPTP01" && d[8] == 1 && d[9] == 6,
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
        d.len() == 224 && &d[..8] == b"SLMPTB01" && d[216..].iter().all(|b| *b == 0),
        10,
    )?;
    require(
        u32_at(d, 200) == 33
            && u32_at(d, 204) == 512
            && u32_at(d, 208) == 4
            && u32_at(d, 212) == 8196,
        11,
    )?;
    require(
        hashv(&[b"slm-public:gpt2-unicode17-messages4-bytes512:v1\n"]).as_ref() == &d[136..168],
        12,
    )?;
    require(
        d[168..200] == slm_public_kernel::tokenizer::UNICODE_SHA256,
        12,
    )
}
fn leaf(index: u32, _kind: u32, n: u32, payload_hash: &[u8]) -> [u8; 32] {
    hashv(&[
        b"slm-public:tokenizer-page:v1\n",
        &index.to_le_bytes(),
        &n.to_le_bytes(),
        payload_hash,
    ])
    .to_bytes()
}
pub fn process(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(a.len() >= 2, 10)?;
    let tag = ix[0].checked_sub(14).ok_or(err(10))?;
    if tag == 0 {
        require(ix.len() == 233 && a.len() == 4, 10)?;
        require(a[0].is_signer, 4)?;
        binding(&ix[1..225])?;
        let b = &ix[1..225];
        model::validate(&a[2], p)?;
        model::authority(&a[0], &a[2])?;
        let md = a[2].try_borrow_data()?;
        require(
            md[10] == 1
                && a[2].key.as_ref() == &b[8..40]
                && md[80..112] == b[40..72]
                && md[200..232] == b[72..104],
            12,
        )?;
        drop(md);
        let (k, bump) = Pubkey::find_program_address(&[MODEL, &b[8..40], &b[104..136]], p);
        require(k == *a[1].key, 5)?;
        allocate(
            &a[0],
            &a[1],
            &a[3],
            p,
            MODEL_BYTES,
            u64_at(ix, 225),
            &[MODEL, &b[8..40], &b[104..136], &[bump]],
        )?;
        let mut d = a[1].try_borrow_mut_data()?;
        d[..8].copy_from_slice(b"SLMPTR01");
        d[8] = 1;
        d[9] = 5;
        d[11] = bump;
        d[16..48].copy_from_slice(a[0].key.as_ref());
        d[48..80].copy_from_slice(&b[8..40]);
        d[80..112].copy_from_slice(hashv(&[b"slm-public:tokenizer:v1\n", b]).as_ref());
        d[112..144].copy_from_slice(&b[104..136]);
        put32(&mut d, 144, 33);
        d[160..384].copy_from_slice(b);
        return Ok(());
    }
    validate(&a[1], p)?;
    authority(&a[0], &a[1])?;
    writable(&a[1])?;
    match tag {
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
                    && kind == 1
                    && ix.len() == 53 + height * 32,
                11,
            )?;
            let mut root = leaf(index, kind, n, expected);
            let mut cursor = index;
            for sibling in ix[53..].chunks_exact(32) {
                root = if cursor & 1 == 0 {
                    hashv(&[b"slm-public:tokenizer-node:v1\n", &root, sibling]).to_bytes()
                } else {
                    hashv(&[b"slm-public:tokenizer-node:v1\n", sibling, &root]).to_bytes()
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
            d[..8].copy_from_slice(b"SLMPTP01");
            d[8] = 1;
            d[9] = 6;
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
            if u32_at(&d, 80) == 0 {
                validate_descriptor(&d[HEADER..])?;
            }
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

pub fn validate_descriptor(d: &[u8]) -> ProgramResult {
    require(d.len() == 1120 && u32_at(d, 20) == 7935, 11)?;
    slm_public_kernel::tokenizer::validate_descriptor(d).map_err(|_| err(30))
}
