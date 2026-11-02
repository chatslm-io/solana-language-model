//! Authenticated bounded multi-gate execution. Public artifact schedule only.
use super::*;
const WIRES: &[u8] = b"slm-pi-wires";
const HEADER: usize = 256;
fn validate(a: &AccountInfo, s: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    require(
        d.len() >= HEADER && &d[..8] == b"SLMPIW01" && d[8] == 1 && d[9] == 3,
        3,
    )?;
    let (key, bump) = Pubkey::find_program_address(&[WIRES, s.key.as_ref()], p);
    require(
        key == *a.key
            && bump == d[11]
            && d[16..48] == sd[16..48]
            && &d[48..80] == s.key.as_ref()
            && d[80..112] == sd[112..144]
            && d[112..144] == sd[144..176],
        5,
    )?;
    let n = u32_at(&d, 144);
    require(
        n > 1 && n <= 256 && d.len() == HEADER + n as usize * 32 && u32_at(&sd, 228) == 1,
        11,
    )
}
pub fn close_wires(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() == 1 && a.len() == 3, 10)?;
    validate(&a[2], &a[1], p)?;
    let mut sd = a[1].try_borrow_mut_data()?;
    sd[10] = 4;
    put32(&mut sd, 228, 0);
    drop(sd);
    close(&a[2], &a[0])
}
#[cfg(feature = "experimental-circuit")]
fn artifact(p: &Pubkey, s: &AccountInfo, pages: &[AccountInfo]) -> Result<Vec<u8>, ProgramError> {
    let sd = s.try_borrow_data()?;
    let count = u32_at(&sd, 212) as usize;
    require(
        (1..=3).contains(&count)
            && pages.len() == count
            && u32_at(&sd, 216) == count as u32
            && u32_at(&sd, 220) == count as u32,
        11,
    )?;
    let root: [u8; 32] = sd[144..176].try_into().unwrap();
    drop(sd);
    let mut bytes = Vec::with_capacity(slm_private_crypto::MAX_ARTIFACT_BYTES);
    let mut hashes = Vec::with_capacity(count * 32);
    for (index, pa) in pages.iter().enumerate() {
        page(pa, s, p)?;
        let d = pa.try_borrow_data()?;
        require(
            d[10] == 1 && u32_at(&d, 80) == index as u32 && u32_at(&d, 92) == 1,
            15,
        )?;
        require(
            bytes.len() + d.len() - PAGE_HEADER <= slm_private_crypto::MAX_ARTIFACT_BYTES,
            11,
        )?;
        let h = hashv(&[
            b"slm-private:page:v1\n",
            &d[80..84],
            &d[92..96],
            &d[84..88],
            &d[PAGE_HEADER..],
        ]);
        require(h.as_ref() == &d[96..128], 16)?;
        hashes.extend_from_slice(h.as_ref());
        bytes.extend_from_slice(&d[PAGE_HEADER..]);
    }
    require(
        hashv(&[b"slm-private:pages:v1\n", &hashes]).as_ref() == root,
        16,
    )?;
    Ok(bytes)
}
#[cfg(feature = "experimental-circuit")]
fn state_hash(binding: &[u8], root: &[u8], next: u32, wires: &[u8]) -> [u8; 32] {
    hashv(&[
        b"slm-private:wires:v1\n",
        binding,
        root,
        &next.to_le_bytes(),
        &((wires.len() / 32) as u32).to_le_bytes(),
        wires,
    ])
    .to_bytes()
}
#[cfg(feature = "experimental-circuit")]
pub fn initialize(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() == 9 && a.len() >= 5, 10)?;
    live(&a[1])?;
    let sd = a[1].try_borrow_data()?;
    require(
        sd[10] == 1 && u32_at(&sd, 228) == 0 && u32_at(&sd, 208) == 0,
        13,
    )?;
    let nonce: [u8; 32] = sd[80..112].try_into().unwrap();
    let binding: [u8; 32] = sd[112..144].try_into().unwrap();
    let root: [u8; 32] = sd[144..176].try_into().unwrap();
    let max_steps = u32_at(&sd, 224);
    drop(sd);
    let bytes = artifact(p, &a[1], &a[4..])?;
    let graph = slm_private_crypto::decode_artifact(&bytes).map_err(|_| err(21))?;
    require(
        graph.namespace == &nonce && max_steps == (graph.shape.gate_count + 31) / 32,
        16,
    )?;
    let count = graph.shape.wire_count().map_err(|_| err(21))?;
    let (key, bump) = Pubkey::find_program_address(&[WIRES, a[1].key.as_ref()], p);
    require(key == *a[2].key, 5)?;
    allocate(
        &a[0],
        &a[2],
        &a[3],
        p,
        HEADER + count as usize * 32,
        u64_at(ix, 1),
        &[WIRES, a[1].key.as_ref(), &[bump]],
    )?;
    let mut d = a[2].try_borrow_mut_data()?;
    d.fill(0);
    d[..8].copy_from_slice(b"SLMPIW01");
    d[8] = 1;
    d[9] = 3;
    d[10] = 1;
    d[11] = bump;
    d[16..48].copy_from_slice(a[0].key.as_ref());
    d[48..80].copy_from_slice(a[1].key.as_ref());
    d[80..112].copy_from_slice(&binding);
    d[112..144].copy_from_slice(&root);
    put32(&mut d, 144, count);
    put32(&mut d, 148, graph.shape.gate_count);
    put32(&mut d, 152, graph.shape.input_count);
    put32(&mut d, 192, graph.output_count);
    slm_private_crypto::initialize_wires(&graph, &mut d[HEADER..]).map_err(|_| err(21))?;
    let hash = state_hash(&binding, &root, 0, &d[HEADER..]);
    d[160..192].copy_from_slice(&hash);
    let mut sd = a[1].try_borrow_mut_data()?;
    put32(&mut sd, 228, 1);
    sd[176..208].copy_from_slice(&hash);
    Ok(())
}
#[cfg(feature = "experimental-circuit")]
pub fn step(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(
        ix.len() == 81 && a.len() >= 4 && &ix[1..9] == b"SLMPIS01",
        10,
    )?;
    validate(&a[2], &a[1], p)?;
    writable(&a[2])?;
    let sd = a[1].try_borrow_data()?;
    require(
        (sd[10] == 1 || sd[10] == 2)
            && u32_at(ix, 73) == u32_at(&sd, 208)
            && ix[9..41] == sd[112..144]
            && ix[41..73] == sd[176..208],
        15,
    )?;
    let sequence = u32_at(&sd, 208);
    let nonce: [u8; 32] = sd[80..112].try_into().unwrap();
    let binding: [u8; 32] = sd[112..144].try_into().unwrap();
    let root: [u8; 32] = sd[144..176].try_into().unwrap();
    let current: [u8; 32] = sd[176..208].try_into().unwrap();
    drop(sd);
    let bytes = artifact(p, &a[1], &a[3..])?;
    let graph = slm_private_crypto::decode_artifact(&bytes).map_err(|_| err(21))?;
    let mut d = a[2].try_borrow_mut_data()?;
    let cursor = u32_at(&d, 156);
    require(
        graph.namespace == &nonce
            && d[10] == 1
            && u32_at(&d, 148) == graph.shape.gate_count
            && u32_at(&d, 152) == graph.shape.input_count
            && u32_at(&d, 192) == graph.output_count
            && cursor == sequence * 32,
        16,
    )?;
    require(cursor < graph.shape.gate_count, 15)?;
    let work = (graph.shape.gate_count - cursor).min(32);
    require(u32_at(ix, 77) == work, 15)?;
    require(
        state_hash(&binding, &root, cursor, &d[HEADER..]) == current && d[160..192] == current,
        16,
    )?;
    let next = slm_private_crypto::evaluate_step(
        graph.records,
        graph.shape,
        &nonce,
        &mut d[HEADER..],
        cursor,
        work,
    )
    .map_err(|_| err(21))?;
    let hash = state_hash(&binding, &root, next, &d[HEADER..]);
    put32(&mut d, 156, next);
    d[160..192].copy_from_slice(&hash);
    d[10] = if next == graph.shape.gate_count { 3 } else { 1 };
    let mut sd = a[1].try_borrow_mut_data()?;
    put32(&mut sd, 208, sequence + 1);
    sd[176..208].copy_from_slice(&hash);
    sd[10] = if next == graph.shape.gate_count { 3 } else { 2 };
    Ok(())
}
