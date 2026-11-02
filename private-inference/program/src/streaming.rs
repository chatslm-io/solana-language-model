//! Experimental immutable Merkle windows over two bounded generation-tagged slot pages.
use super::*;
const SLOT: &[u8] = b"slm-pi-slot";
const WINDOW: &[u8] = b"slm-pi-window";
const H: usize = 256;
fn common(
    a: &AccountInfo,
    s: &AccountInfo,
    p: &Pubkey,
    magic: &[u8; 8],
    kind: u8,
) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    require(
        d.len() >= H && &d[..8] == magic && d[8] == 2 && d[9] == kind,
        3,
    )?;
    require(
        d[16..48] == sd[16..48]
            && &d[48..80] == s.key.as_ref()
            && d[80..112] == sd[112..144]
            && d[112..144] == sd[144..176],
        5,
    )
}
fn slot(a: &AccountInfo, s: &AccountInfo, p: &Pubkey, index: u32) -> ProgramResult {
    common(a, s, p, b"SLMPSL02", 4)?;
    let d = a.try_borrow_data()?;
    let (key, bump) =
        Pubkey::find_program_address(&[SLOT, s.key.as_ref(), &index.to_le_bytes()], p);
    let total = u32_at(&d, 156);
    let count = total.saturating_sub(index * 128).min(128);
    require(
        index < 2
            && key == *a.key
            && bump == d[11]
            && u32_at(&d, 144) == index
            && u32_at(&d, 148) == index * 128
            && total > 0
            && total <= 256
            && u32_at(&d, 152) == count
            && d.len() == H + count as usize * 40,
        5,
    )
}
fn window(a: &AccountInfo, s: &AccountInfo, p: &Pubkey) -> ProgramResult {
    common(a, s, p, b"SLMPWN02", 5)?;
    let d = a.try_borrow_data()?;
    let (key, bump) = Pubkey::find_program_address(&[WINDOW, s.key.as_ref()], p);
    require(
        key == *a.key
            && bump == d[11]
            && d.len() == H + 3072
            && d[10] <= 2
            && u32_at(&d, 148) <= 32
            && u32_at(&d, 156) == u32_at(&d, 148) * 96
            && u32_at(&d, 152) <= u32_at(&d, 156),
        5,
    )
}
pub fn close_slot(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() == 5 && a.len() == 3, 10)?;
    slot(&a[2], &a[1], p, u32_at(ix, 1))?;
    let mut sd = a[1].try_borrow_mut_data()?;
    let count = u32_at(&sd, 228);
    require(count > 0 && count <= 2, 13)?;
    put32(&mut sd, 228, count - 1);
    sd[10] = 4;
    drop(sd);
    close(&a[2], &a[0])
}
pub fn close_window(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() == 1 && a.len() == 3, 10)?;
    window(&a[2], &a[1], p)?;
    let mut sd = a[1].try_borrow_mut_data()?;
    require(u32_at(&sd, 240) == 1, 13)?;
    put32(&mut sd, 240, 0);
    sd[10] = 4;
    drop(sd);
    close(&a[2], &a[0])
}
#[cfg(feature = "experimental-stream")]
mod execution {
    use super::*;
    use slm_private_crypto::streaming::{
        decode_streaming_descriptor, evaluate_window, initialize_slots, validate_output_slots,
        StreamingDescriptor,
    };
    fn descriptor(p: &Pubkey, s: &AccountInfo, a: &AccountInfo) -> Result<Vec<u8>, ProgramError> {
        page(a, s, p)?;
        let d = a.try_borrow_data()?;
        let sd = s.try_borrow_data()?;
        require(
            u32_at(&sd, 212) == 1
                && u32_at(&sd, 216) == 1
                && u32_at(&sd, 220) == 1
                && d[10] == 1
                && u32_at(&d, 80) == 0
                && u32_at(&d, 92) == 1
                && u32_at(&d, 84) <= 2432,
            11,
        )?;
        let h = hashv(&[
            b"slm-private:page:v1\n",
            &d[80..84],
            &d[92..96],
            &d[84..88],
            &d[PAGE_HEADER..],
        ]);
        require(
            h.as_ref() == &d[96..128]
                && hashv(&[b"slm-private:pages:v1\n", h.as_ref()]).as_ref() == &sd[144..176],
            16,
        )?;
        let bytes = d[PAGE_HEADER..].to_vec();
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        require(
            desc.namespace == &sd[80..112] && desc.window_count == u32_at(&sd, 224),
            16,
        )?;
        Ok(bytes)
    }
    fn initialize_header(d: &mut [u8], kind: u8, bump: u8, s: &AccountInfo, sd: &[u8]) {
        d.fill(0);
        d[..8].copy_from_slice(if kind == 4 { b"SLMPSL02" } else { b"SLMPWN02" });
        d[8] = 2;
        d[9] = kind;
        d[11] = bump;
        d[16..48].copy_from_slice(&sd[16..48]);
        d[48..80].copy_from_slice(s.key.as_ref());
        d[80..112].copy_from_slice(&sd[112..144]);
        d[112..144].copy_from_slice(&sd[144..176]);
    }
    fn state_hash(sd: &[u8], next: u32, total: u32, slots: &[u8]) -> [u8; 32] {
        hashv(&[
            b"slm-private:slots:v2\n",
            &sd[112..144],
            &sd[144..176],
            &next.to_le_bytes(),
            &total.to_le_bytes(),
            slots,
        ])
        .to_bytes()
    }
    fn gather<'info>(
        p: &Pubkey,
        s: &AccountInfo,
        a: &AccountInfo<'info>,
        b: &AccountInfo<'info>,
        desc: &StreamingDescriptor,
    ) -> Result<Vec<u8>, ProgramError> {
        slot(a, s, p, 0)?;
        slot(b, s, p, 1)?;
        let mut result = Vec::with_capacity(desc.slot_count as usize * 40);
        for account in [a, b] {
            let d = account.try_borrow_data()?;
            require(
                u32_at(&d, 156) == desc.slot_count
                    && u32_at(&d, 160) == desc.gate_count
                    && u32_at(&d, 164) == desc.input_count
                    && u32_at(&d, 208) == desc.output_count,
                16,
            )?;
            result.extend_from_slice(&d[H..]);
        }
        Ok(result)
    }
    fn store<'info>(
        a: &AccountInfo<'info>,
        b: &AccountInfo<'info>,
        slots: &[u8],
        next: u32,
        total_gates: u32,
        root: &[u8; 32],
    ) -> ProgramResult {
        let mut offset = 0;
        for account in [a, b] {
            writable(account)?;
            let mut d = account.try_borrow_mut_data()?;
            let len = d.len() - H;
            d[H..].copy_from_slice(&slots[offset..offset + len]);
            offset += len;
            put32(&mut d, 168, next);
            d[176..208].copy_from_slice(root);
            d[10] = if next == total_gates { 3 } else { 1 };
        }
        Ok(())
    }
    pub fn initialize_slot(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(ix.len() == 13 && a.len() == 5, 10)?;
        live(&a[1])?;
        let index = u32_at(ix, 1);
        let sd = a[1].try_borrow_data()?;
        require(
            index < 2
                && sd[10] == 1
                && u32_at(&sd, 208) == 0
                && u32_at(&sd, 228) == index
                && u32_at(&sd, 240) == 0,
            13,
        )?;
        drop(sd);
        let bytes = descriptor(p, &a[1], &a[2])?;
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        let mut initial = vec![0u8; desc.slot_count as usize * 40];
        initialize_slots(&desc, &mut initial).map_err(|_| err(21))?;
        let start = (index * 128).min(desc.slot_count);
        let count = (desc.slot_count - start).min(128);
        let (key, bump) =
            Pubkey::find_program_address(&[SLOT, a[1].key.as_ref(), &index.to_le_bytes()], p);
        require(key == *a[3].key, 5)?;
        allocate(
            &a[0],
            &a[3],
            &a[4],
            p,
            H + count as usize * 40,
            u64_at(ix, 5),
            &[SLOT, a[1].key.as_ref(), &index.to_le_bytes(), &[bump]],
        )?;
        let sd = a[1].try_borrow_data()?;
        let mut d = a[3].try_borrow_mut_data()?;
        initialize_header(&mut d, 4, bump, &a[1], &sd);
        drop(sd);
        d[10] = 1;
        put32(&mut d, 144, index);
        put32(&mut d, 148, index * 128);
        put32(&mut d, 152, count);
        put32(&mut d, 156, desc.slot_count);
        put32(&mut d, 160, desc.gate_count);
        put32(&mut d, 164, desc.input_count);
        put32(&mut d, 208, desc.output_count);
        d[H..].copy_from_slice(&initial[start as usize * 40..(start + count) as usize * 40]);
        drop(d);
        put32(&mut a[1].try_borrow_mut_data()?, 228, index + 1);
        Ok(())
    }
    pub fn initialize_window(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(ix.len() == 9 && a.len() == 7, 10)?;
        live(&a[1])?;
        let sd = a[1].try_borrow_data()?;
        require(
            sd[10] == 1 && u32_at(&sd, 208) == 0 && u32_at(&sd, 228) == 2 && u32_at(&sd, 240) == 0,
            13,
        )?;
        drop(sd);
        let bytes = descriptor(p, &a[1], &a[2])?;
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        let slots = gather(p, &a[1], &a[4], &a[5], &desc)?;
        let (key, bump) = Pubkey::find_program_address(&[WINDOW, a[1].key.as_ref()], p);
        require(key == *a[3].key, 5)?;
        allocate(
            &a[0],
            &a[3],
            &a[6],
            p,
            H + 3072,
            u64_at(ix, 1),
            &[WINDOW, a[1].key.as_ref(), &[bump]],
        )?;
        let sd = a[1].try_borrow_data()?;
        let root = state_hash(&sd, 0, desc.slot_count, &slots);
        let mut d = a[3].try_borrow_mut_data()?;
        initialize_header(&mut d, 5, bump, &a[1], &sd);
        drop(sd);
        d[10] = 2;
        put32(&mut d, 144, u32::MAX);
        drop(d);
        store(&a[4], &a[5], &slots, 0, desc.gate_count, &root)?;
        let mut sd = a[1].try_borrow_mut_data()?;
        put32(&mut sd, 240, 1);
        sd[176..208].copy_from_slice(&root);
        Ok(())
    }
    pub fn begin(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(ix.len() == 5 && a.len() == 4, 10)?;
        window(&a[3], &a[1], p)?;
        writable(&a[3])?;
        let bytes = descriptor(p, &a[1], &a[2])?;
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        let sd = a[1].try_borrow_data()?;
        let sequence = u32_at(&sd, 208);
        require(
            (sd[10] == 1 || sd[10] == 2)
                && u32_at(&sd, 228) == 2
                && u32_at(&sd, 240) == 1
                && u32_at(ix, 1) == sequence
                && sequence < desc.window_count,
            15,
        )?;
        drop(sd);
        let mut d = a[3].try_borrow_mut_data()?;
        let old = u32_at(&d, 144);
        require(
            d[10] == 2
                && ((old == u32::MAX && sequence == 0) || (old < u32::MAX && old + 1 == sequence)),
            15,
        )?;
        let count = (desc.gate_count - sequence * 32).min(32);
        d[10] = 0;
        put32(&mut d, 144, sequence);
        put32(&mut d, 148, count);
        put32(&mut d, 152, 0);
        put32(&mut d, 156, count * 96);
        put32(&mut d, 160, sequence * 32);
        d[168..200].fill(0);
        d[H..].fill(0);
        Ok(())
    }
    pub fn write(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(a.len() == 3 && ix.len() > 5 && ix.len() <= 705, 10)?;
        window(&a[2], &a[1], p)?;
        writable(&a[2])?;
        let sd = a[1].try_borrow_data()?;
        require((sd[10] == 1 || sd[10] == 2) && u32_at(&sd, 240) == 1, 13)?;
        let seq = u32_at(&sd, 208);
        drop(sd);
        let mut d = a[2].try_borrow_mut_data()?;
        require(d[10] == 0 && u32_at(&d, 144) == seq, 13)?;
        let start = u32_at(ix, 1) as usize;
        let end = start.checked_add(ix.len() - 5).ok_or(err(9))?;
        let cursor = u32_at(&d, 152) as usize;
        require(end <= u32_at(&d, 156) as usize, 14)?;
        if start < cursor {
            return require(end <= cursor && d[H + start..H + end] == ix[5..], 15);
        }
        require(start == cursor, 15)?;
        d[H + start..H + end].copy_from_slice(&ix[5..]);
        put32(&mut d, 152, end as u32);
        Ok(())
    }
    fn leaf(index: u32, count: u32, records: &[u8]) -> [u8; 32] {
        hashv(&[
            b"slm-private:window:v2\n",
            &index.to_le_bytes(),
            &count.to_le_bytes(),
            records,
        ])
        .to_bytes()
    }
    pub fn seal(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(
            a.len() == 4 && ix.len() >= 1 && ix.len() <= 481 && (ix.len() - 1) % 32 == 0,
            10,
        )?;
        window(&a[3], &a[1], p)?;
        writable(&a[3])?;
        let bytes = descriptor(p, &a[1], &a[2])?;
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        let sd = a[1].try_borrow_data()?;
        let seq = u32_at(&sd, 208);
        require(
            (sd[10] == 1 || sd[10] == 2) && u32_at(&sd, 240) == 1 && seq < desc.window_count,
            13,
        )?;
        drop(sd);
        let mut d = a[3].try_borrow_mut_data()?;
        require(
            d[10] == 0
                && u32_at(&d, 144) == seq
                && u32_at(&d, 152) == u32_at(&d, 156)
                && u32_at(&d, 148) == (desc.gate_count - seq * 32).min(32),
            15,
        )?;
        let mut height = 0;
        let mut width = 1;
        while width < desc.window_count {
            width *= 2;
            height += 1;
        }
        require(ix.len() == 1 + height * 32, 10)?;
        let h = leaf(seq, u32_at(&d, 148), &d[H..H + u32_at(&d, 156) as usize]);
        let mut root = h;
        let mut index = seq;
        for sibling in ix[1..].chunks_exact(32) {
            root = if index & 1 == 0 {
                hashv(&[b"slm-private:window-node:v2\n", &root, sibling]).to_bytes()
            } else {
                hashv(&[b"slm-private:window-node:v2\n", sibling, &root]).to_bytes()
            };
            index >>= 1;
        }
        require(&root == desc.record_root, 16)?;
        d[168..200].copy_from_slice(&h);
        d[10] = 1;
        Ok(())
    }
    pub fn step(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
        require(
            ix.len() == 81 && a.len() == 6 && &ix[1..9] == b"SLMPIS01",
            10,
        )?;
        window(&a[3], &a[1], p)?;
        writable(&a[3])?;
        let bytes = descriptor(p, &a[1], &a[2])?;
        let desc = decode_streaming_descriptor(&bytes).map_err(|_| err(21))?;
        let mut slots = gather(p, &a[1], &a[4], &a[5], &desc)?;
        let sd = a[1].try_borrow_data()?;
        let sequence = u32_at(&sd, 208);
        let first = sequence.checked_mul(32).ok_or(err(9))?;
        require(
            (sd[10] == 1 || sd[10] == 2)
                && u32_at(&sd, 228) == 2
                && u32_at(&sd, 240) == 1
                && sequence < desc.window_count
                && u32_at(ix, 73) == sequence
                && ix[9..41] == sd[112..144]
                && ix[41..73] == sd[176..208],
            15,
        )?;
        let work = (desc.gate_count - first).min(32);
        require(
            u32_at(ix, 77) == work
                && state_hash(&sd, first, desc.slot_count, &slots) == sd[176..208],
            16,
        )?;
        for slot_account in [&a[4], &a[5]] {
            let d = slot_account.try_borrow_data()?;
            require(
                d[10] == 1 && u32_at(&d, 168) == first && d[176..208] == sd[176..208],
                16,
            )?;
        }
        let d = a[3].try_borrow_data()?;
        require(
            d[10] == 1
                && u32_at(&d, 144) == sequence
                && u32_at(&d, 160) == first
                && u32_at(&d, 148) == work
                && leaf(sequence, work, &d[H..H + work as usize * 96]) == d[168..200],
            16,
        )?;
        let next = evaluate_window(&d[H..H + work as usize * 96], &desc, &mut slots, first)
            .map_err(|_| err(21))?;
        if next == desc.gate_count {
            validate_output_slots(&desc, &slots, next).map_err(|_| err(21))?;
        }
        let root = state_hash(&sd, next, desc.slot_count, &slots);
        drop(d);
        drop(sd);
        store(&a[4], &a[5], &slots, next, desc.gate_count, &root)?;
        let mut sd = a[1].try_borrow_mut_data()?;
        put32(&mut sd, 208, sequence + 1);
        sd[176..208].copy_from_slice(&root);
        sd[10] = if next == desc.gate_count { 3 } else { 2 };
        a[3].try_borrow_mut_data()?[10] = 2;
        Ok(())
    }
}
#[cfg(feature = "experimental-stream")]
pub use execution::*;
