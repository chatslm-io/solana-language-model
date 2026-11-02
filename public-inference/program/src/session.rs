use super::*;
use slm_public_kernel::executor::{execute, selected_weight_page, Command};
use solana_program::{clock::Clock, sysvar::Sysvar};
pub const SESSION: &[u8] = b"slm-pu-session";
pub const STATE: &[u8] = b"slm-pu-state";
pub const HEADER: usize = 192;
pub(crate) fn validate(a: &AccountInfo, p: &Pubkey) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    require(
        d.len() == 384 && &d[..8] == b"SLMPUS01" && d[8] == 1 && d[9] == 3,
        3,
    )?;
    let (k, b) = Pubkey::find_program_address(&[SESSION, &d[16..48], &d[80..112]], p);
    require(k == *a.key && b == d[11], 5)
}
fn state(a: &AccountInfo, s: &AccountInfo, p: &Pubkey, index: u32) -> ProgramResult {
    require(a.owner == p && !a.executable, 2)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    let n = if index == 0 { 8192 } else { 3072 };
    require(
        index < 5
            && d.len() == HEADER + n
            && &d[..8] == b"SLMPUT01"
            && d[8] == 1
            && d[9] == 4
            && u32_at(&d, 80) == index
            && u32_at(&d, 84) == n as u32
            && d[16..48] == sd[16..48]
            && &d[48..80] == s.key.as_ref()
            && d[96..128] == sd[144..176],
        5,
    )?;
    let (k, b) = Pubkey::find_program_address(&[STATE, s.key.as_ref(), &index.to_le_bytes()], p);
    require(k == *a.key && b == d[11], 5)?;
    require(hashv(&[&d[HEADER..]]).as_ref() == &d[128..160], 12)
}
fn check_model(a: &AccountInfo, s: &AccountInfo, p: &Pubkey) -> ProgramResult {
    model::validate(a, p)?;
    let d = a.try_borrow_data()?;
    let sd = s.try_borrow_data()?;
    require(
        d[10] == 1 && a.key.as_ref() == &sd[112..144] && d[80..112] == sd[144..176],
        12,
    )
}
pub fn process(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(a.len() >= 2, 10)?;
    if ix[0] == 7 {
        require(ix.len() == 153 && a.len() == 4 && a[0].is_signer, 10)?;
        model::validate(&a[2], p)?;
        let md = a[2].try_borrow_data()?;
        require(md[10] == 1, 13)?;
        let expiry = u64_at(ix, 65);
        let requested = u32_at(ix, 73);
        let prompt = u32_at(ix, 77);
        require(
            expiry > Clock::get()?.slot
                && prompt > 0
                && prompt <= 15
                && requested > 0
                && prompt + requested <= 16,
            11,
        )?;
        for i in 0..16 {
            let t = u32_at(ix, 81 + i * 4);
            require(
                if i < prompt as usize {
                    t < 8196
                } else {
                    t == 0
                },
                11,
            )?;
        }
        let (k, b) = Pubkey::find_program_address(&[SESSION, a[0].key.as_ref(), &ix[1..33]], p);
        require(k == *a[1].key, 5)?;
        allocate(
            &a[0],
            &a[1],
            &a[3],
            p,
            384,
            u64_at(ix, 145),
            &[SESSION, a[0].key.as_ref(), &ix[1..33], &[b]],
        )?;
        let mut d = a[1].try_borrow_mut_data()?;
        d[..8].copy_from_slice(b"SLMPUS01");
        d[8] = 1;
        d[9] = 3;
        d[11] = b;
        d[16..48].copy_from_slice(a[0].key.as_ref());
        d[48..80].copy_from_slice(&ix[33..65]);
        d[80..112].copy_from_slice(&ix[1..33]);
        d[112..144].copy_from_slice(a[2].key.as_ref());
        d[144..176].copy_from_slice(&md[80..112]);
        d[200..208].copy_from_slice(&expiry.to_le_bytes());
        put32(&mut d, 244, prompt);
        put32(&mut d, 252, requested);
        d[256..320].copy_from_slice(&ix[81..145]);
        put32(&mut d, 184, u32_at(ix, 81));
        return Ok(());
    }
    validate(&a[1], p)?;
    require(a[0].is_signer, 4)?;
    writable(&a[1])?;
    let sd = a[1].try_borrow_data()?;
    let owner = a[0].key.as_ref() == &sd[16..48];
    require(
        owner || (ix[0] == 9 || ix[0] == 10 || ix[0] == 26) && a[0].key.as_ref() == &sd[48..80],
        4,
    )?;
    if ix[0] <= 10 || ix[0] == 26 {
        require(sd[10] < 3 && Clock::get()?.slot <= u64_at(&sd, 200), 13)?;
    }
    drop(sd);
    match ix[0] {
        8 => {
            require(owner && ix.len() == 13 && a.len() == 4, 10)?;
            let index = u32_at(ix, 1);
            require(index < 5, 11)?;
            let sd = a[1].try_borrow_data()?;
            require(sd[10] == 0, 13)?;
            let mask = u32_at(&sd, 196);
            require(mask & (1 << index) == 0, 13)?;
            let binding: [u8; 32] = sd[144..176].try_into().unwrap();
            drop(sd);
            let n = if index == 0 { 8192 } else { 3072 };
            let (k, b) =
                Pubkey::find_program_address(&[STATE, a[1].key.as_ref(), &index.to_le_bytes()], p);
            require(k == *a[2].key, 5)?;
            allocate(
                &a[0],
                &a[2],
                &a[3],
                p,
                HEADER + n,
                u64_at(ix, 5),
                &[STATE, a[1].key.as_ref(), &index.to_le_bytes(), &[b]],
            )?;
            let mut d = a[2].try_borrow_mut_data()?;
            d[..8].copy_from_slice(b"SLMPUT01");
            d[8] = 1;
            d[9] = 4;
            d[11] = b;
            d[16..48].copy_from_slice(a[0].key.as_ref());
            d[48..80].copy_from_slice(a[1].key.as_ref());
            put32(&mut d, 80, index);
            put32(&mut d, 84, n as u32);
            d[96..128].copy_from_slice(&binding);
            let initial_hash = hashv(&[&d[HEADER..]]);
            d[128..160].copy_from_slice(initial_hash.as_ref());
            let mut sd = a[1].try_borrow_mut_data()?;
            put32(&mut sd, 196, mask | (1 << index));
            let live = u32_at(&sd, 192);
            put32(&mut sd, 192, live + 1);
            Ok(())
        }
        9 => {
            require(ix.len() == 1 && a.len() == 3, 10)?;
            check_model(&a[2], &a[1], p)?;
            let mut d = a[1].try_borrow_mut_data()?;
            require(
                d[10] == 0 && u32_at(&d, 196) == 31 && u32_at(&d, 244) > 0,
                13,
            )?;
            d[10] = 1;
            Ok(())
        }
        10 => step(p, a, ix),
        26 => batch(p, a, ix),
        11 => {
            require(owner && ix.len() == 1 && a.len() == 2, 10)?;
            a[1].try_borrow_mut_data()?[10] = 4;
            Ok(())
        }
        12 => {
            require(owner && ix.len() == 5 && a.len() == 3, 10)?;
            let index = u32_at(ix, 1);
            state(&a[2], &a[1], p, index)?;
            close(&a[2], &a[0])?;
            let mut d = a[1].try_borrow_mut_data()?;
            d[10] = 4;
            let live = u32_at(&d, 192);
            put32(&mut d, 192, live.checked_sub(1).ok_or(err(9))?);
            let mask = u32_at(&d, 196);
            put32(&mut d, 196, mask & !(1 << index));
            Ok(())
        }
        13 => {
            require(owner && ix.len() == 1 && a.len() == 2, 10)?;
            require(
                u32_at(&a[1].try_borrow_data()?, 192) == 0
                    && u32_at(&a[1].try_borrow_data()?, 180) == 0,
                13,
            )?;
            close(&a[1], &a[0])
        }
        _ => Err(err(10)),
    }
}
#[inline(never)]
fn step(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    // Executor/session/model/plan/global followed by optional weight and layer KV.
    require(ix.len() == 41 && a.len() >= 5 && a.len() <= 7, 10)?;
    check_model(&a[2], &a[1], p)?;
    model::page(&a[3], &a[2], p)?;
    state(&a[4], &a[1], p, 0)?;
    writable(&a[4])?;
    let sd = a[1].try_borrow_data()?;
    let pc = u32_at(&sd, 176);
    let seq = u32_at(&sd, 240);
    let position = u32_at(&sd, 188);
    let token = u32_at(&sd, 184);
    require(
        sd[10] == 1 && seq == u32_at(ix, 1) && pc == u32_at(ix, 5) && sd[208..240] == ix[9..41],
        13,
    )?;
    drop(sd);
    let md = a[2].try_borrow_data()?;
    let commands = u32_at(&md, 344);
    let planstart = u32_at(&md, 336);
    let weightpages = u32_at(&md, 332);
    drop(md);
    let pd = a[3].try_borrow_data()?;
    require(
        pd[10] == 1
            && u32_at(&pd, 80) == planstart + pc / 128
            && u32_at(&pd, 92) == 2
            && pc < commands,
        12,
    )?;
    let start = model::HEADER + (pc % 128) as usize * 64;
    require(start + 64 <= pd.len(), 11)?;
    let command = Command::decode(&pd[start..start + 64]).map_err(|_| err(20))?;
    require((command.op == 17) == (pc + 1 == commands), 11)?;
    let weighted = matches!(command.op, 1 | 3 | 5 | 14 | 19);
    let kv = matches!(command.op, 10 | 11 | 13);
    require(a.len() == 5 + weighted as usize + kv as usize, 10)?;
    let mut global = a[4].try_borrow_mut_data()?;
    let mut wi = 5;
    let mut weight_data = None;
    if weighted {
        let selected =
            selected_weight_page(&command, &global[HEADER..], token).map_err(|_| err(20))?;
        require(selected < weightpages, 11)?;
        model::page(&a[wi], &a[2], p)?;
        let d = a[wi].try_borrow_data()?;
        require(
            d[10] == 1 && u32_at(&d, 80) == selected && u32_at(&d, 92) == 1,
            12,
        )?;
        weight_data = Some(d);
        wi += 1;
    }
    let weights = weight_data
        .as_ref()
        .map(|d| &d[model::HEADER..])
        .unwrap_or(&[]);
    let mut kv_data = None;
    if kv {
        require(command.aux0 < 4, 11)?;
        state(&a[wi], &a[1], p, command.aux0 + 1)?;
        writable(&a[wi])?;
        kv_data = Some(a[wi].try_borrow_mut_data()?);
    }
    execute(
        &command,
        &mut global[HEADER..],
        kv_data
            .as_mut()
            .map(|d| &mut d[HEADER..])
            .unwrap_or(&mut []),
        weights,
        position,
        token,
    )
    .map_err(|_| err(20))?;
    let global_hash = hashv(&[&global[HEADER..]]).to_bytes();
    global[128..160].copy_from_slice(&global_hash);
    let mut kv_hash = [0u8; 32];
    if let Some(d) = kv_data.as_mut() {
        kv_hash = hashv(&[&d[HEADER..]]).to_bytes();
        d[128..160].copy_from_slice(&kv_hash);
    }
    let mut sd = a[1].try_borrow_mut_data()?;
    let root = hashv(&[
        b"slm-public:state:v1\n",
        &sd[208..240],
        &seq.to_le_bytes(),
        &global_hash,
        &kv_hash,
    ]);
    sd[208..240].copy_from_slice(root.as_ref());
    put32(&mut sd, 240, seq.checked_add(1).ok_or(err(9))?);
    if command.op == 17 {
        let selected = slm_public_kernel::read_f32(&global[HEADER..], 1941).map_err(|_| err(20))?;
        require(
            selected >= 0.0 && selected < 8196.0 && selected == (selected as u32) as f32,
            20,
        )?;
        let next = position + 1;
        put32(&mut sd, 188, next);
        put32(&mut sd, 176, 0);
        let prompt = u32_at(&sd, 244);
        if next < prompt {
            let token = u32_at(&sd, 256 + next as usize * 4);
            put32(&mut sd, 184, token);
        } else {
            let count = u32_at(&sd, 248);
            require(count < 16, 11)?;
            put32(&mut sd, 320 + count as usize * 4, selected as u32);
            put32(&mut sd, 248, count + 1);
            put32(&mut sd, 184, selected as u32);
            if count + 1 == u32_at(&sd, 252) || next == 16 {
                sd[10] = 3;
            }
        }
    } else {
        put32(&mut sd, 176, pc + 1);
    }
    Ok(())
}

/// Execute a canonical bounded union of authenticated steps. Instruction data
/// carries only the first expected state and account indices, never activations.
#[inline(never)]
fn batch(p: &Pubkey, a: &[AccountInfo], ix: &[u8]) -> ProgramResult {
    require(ix.len() >= 45 && a.len() >= 5 && a.len() <= 20, 10)?;
    let count = ix[41] as usize;
    require(count > 0 && count <= 8 && ix.len() == 42 + count * 3, 10)?;
    for i in 0..a.len() {
        for j in 0..i {
            require(a[i].key != a[j].key, 5)?;
        }
    }
    let sd = a[1].try_borrow_data()?;
    let start_pc = u32_at(&sd, 176);
    require(
        sd[10] == 1
            && u32_at(&sd, 240) == u32_at(ix, 1)
            && start_pc == u32_at(ix, 5)
            && sd[208..240] == ix[9..41],
        13,
    )?;
    drop(sd);
    check_model(&a[2], &a[1], p)?;
    state(&a[3], &a[1], p, 0)?;
    let md = a[2].try_borrow_data()?;
    let command_count = u32_at(&md, 344);
    let plan_start = u32_at(&md, 336);
    drop(md);
    require(
        start_pc.checked_add(count as u32).ok_or(err(9))? <= command_count,
        11,
    )?;
    let mut used = 0b1111u32;
    // Prevalidate every public map and boundary before any numeric mutation.
    for i in 0..count {
        let map = &ix[42 + i * 3..45 + i * 3];
        let plan = map[0] as usize;
        require(plan >= 4 && plan < a.len(), 10)?;
        model::page(&a[plan], &a[2], p)?;
        let pd = a[plan].try_borrow_data()?;
        let pc = start_pc + i as u32;
        require(
            pd[10] == 1 && u32_at(&pd, 80) == plan_start + pc / 128 && u32_at(&pd, 92) == 2,
            12,
        )?;
        let at = model::HEADER + (pc % 128) as usize * 64;
        require(at + 64 <= pd.len(), 11)?;
        let command = Command::decode(&pd[at..at + 64]).map_err(|_| err(20))?;
        require(!matches!(command.op, 14 | 17) || i + 1 == count, 11)?;
        let weighted = matches!(command.op, 1 | 3 | 5 | 14 | 19);
        let kv = matches!(command.op, 10 | 11 | 13);
        for (index, required) in [(map[1], weighted), (map[2], kv)] {
            require(
                if required {
                    index >= 4 && (index as usize) < a.len()
                } else {
                    index == 255
                },
                10,
            )?;
            if required {
                used |= 1u32 << index;
            }
        }
        used |= 1u32 << plan;
    }
    require(used == (1u32 << a.len()) - 1, 10)?;
    for i in 0..count {
        let map = &ix[42 + i * 3..45 + i * 3];
        let mut inner = [
            a[0].clone(),
            a[1].clone(),
            a[2].clone(),
            a[map[0] as usize].clone(),
            a[3].clone(),
            a[0].clone(),
            a[0].clone(),
        ];
        let mut n = 5;
        if map[1] != 255 {
            inner[n] = a[map[1] as usize].clone();
            n += 1;
        }
        if map[2] != 255 {
            inner[n] = a[map[2] as usize].clone();
            n += 1;
        }
        let mut current = [0u8; 41];
        current[0] = 10;
        {
            let sd = a[1].try_borrow_data()?;
            current[1..5].copy_from_slice(&sd[240..244]);
            current[5..9].copy_from_slice(&sd[176..180]);
            current[9..41].copy_from_slice(&sd[208..240]);
        }
        step(p, &inner[..n], &current)?;
    }
    Ok(())
}
