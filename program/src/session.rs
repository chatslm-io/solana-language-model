use super::*;
use solana_program::clock::Clock;

// Sessions are ordinary program-owned PDAs, always discoverable by the owner's
// offset-16 authority. Their lamports fund storage; the delegate only pays fees.
pub(super) fn open(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(data.len() == 113 && a.len() == 5, 10)?;
    let (owner, registry, vault, delegate, system) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    require(owner.is_signer, 4)?;
    require(
        delegate.key != owner.key && delegate.key != vault.key && delegate.key != registry.key,
        4,
    )?;
    require(
        *delegate.owner == system_program::id() && delegate.data_is_empty(),
        2,
    )?;
    let id = &data[1..33];
    let budget = u64_at(data, 77);
    let fees = u64_at(data, 85);
    let expiry = u64_at(data, 93);
    let max_ops = u32_at(data, 101);
    let slot = Clock::get()?.slot;
    require(expiry > slot && expiry <= slot.saturating_add(216_000), 18)?;
    require(max_ops > 0 && max_ops <= 1_000_000, 19)?;
    let (key, bump) = Pubkey::find_program_address(&[SESSION, owner.key.as_ref(), id], program);
    require(*vault.key == key, 5)?;
    // Repeated setup must never top up a session implicitly.
    require(
        *vault.owner == system_program::id() && vault.data_is_empty(),
        12,
    )?;
    let rent = Rent::get()?.minimum_balance(HEADER);
    let reg_debit = if registry.owner == program {
        0
    } else {
        rent.saturating_sub(registry.lamports())
    };
    let vault_debit = rent.saturating_sub(vault.lamports());
    let debit = reg_debit
        .checked_add(vault_debit)
        .and_then(|n| n.checked_add(budget))
        .and_then(|n| n.checked_add(fees))
        .ok_or(err(9))?;
    require(debit <= u64_at(data, 105), 7)?;
    let mut create = data[..77].to_vec();
    create[0] = 0;
    create.extend_from_slice(&reg_debit.to_le_bytes());
    process_storage(
        program,
        &[owner.clone(), registry.clone(), system.clone()],
        &create,
        None,
    )?;
    require(registry.try_borrow_data()?[10] == 0, 13)?;
    allocate(
        owner,
        vault,
        system,
        program,
        HEADER,
        vault_debit,
        &[SESSION, owner.key.as_ref(), id, &[bump]],
    )?;
    if budget > 0 {
        invoke(
            &system_instruction::transfer(owner.key, vault.key, budget),
            &[owner.clone(), vault.clone(), system.clone()],
        )?;
    }
    if fees > 0 {
        writable(delegate)?;
        invoke(
            &system_instruction::transfer(owner.key, delegate.key, fees),
            &[owner.clone(), delegate.clone(), system.clone()],
        )?;
    }
    let mut d = vault.try_borrow_mut_data()?;
    init_header(&mut d, 3, bump, owner.key, id);
    d[80..112].copy_from_slice(delegate.key.as_ref());
    put64(&mut d, 112, expiry);
    put64(&mut d, 120, budget);
    put32(&mut d, 140, max_ops);
    d[144..176].copy_from_slice(&data[33..65]);
    put32(&mut d, 176, u32_at(data, 65));
    put64(&mut d, 180, u64_at(data, 69));
    Ok(())
}

pub(super) fn close(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(data.len() == 33 && a.len() == 3, 10)?;
    require(a[0].is_signer, 4)?;
    require(a[0].key == a[2].key, 8)?;
    let (key, _) = Pubkey::find_program_address(&[SESSION, a[0].key.as_ref(), &data[1..]], program);
    require(*a[1].key == key, 5)?;
    if *a[1].owner == system_program::id() && a[1].data_is_empty() {
        return Ok(());
    }
    validate(&a[1], program, a[0].key, 3)?;
    require(a[1].data_len() == HEADER, 3)?;
    // No registry or delegate is needed: recovery survives expiry, key loss,
    // partial uploads and even prior registry closure.
    transfer_all(&a[1], &a[2])
}

pub(super) fn execute(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(data.len() >= 2 && a.len() >= 4, 10)?;
    require(matches!(data[1], 1 | 2 | 3 | 6), 20)?;
    let (delegate, vault, owner, registry) = (&a[0], &a[1], &a[2], &a[3]);
    require(delegate.is_signer, 4)?;
    validate(vault, program, owner.key, 3)?;
    validate(registry, program, owner.key, 1)?;
    writable(vault)?;
    {
        let mut d = vault.try_borrow_mut_data()?;
        require(d.len() == HEADER && d[10] == 0, 3)?;
        require(&d[80..112] == delegate.key.as_ref(), 4)?;
        let r = registry.try_borrow_data()?;
        require(d[48..80] == r[48..80] && r[10] == 0, 13)?;
        require(
            d[144..176] == r[80..112]
                && u32_at(&d, 176) == u32_at(&r, 112)
                && u64_at(&d, 180) == u64_at(&r, 128),
            12,
        )?;
        require(Clock::get()?.slot < u64_at(&d, 112), 18)?;
        let ops = u32_at(&d, 136).checked_add(1).ok_or(err(9))?;
        require(ops <= u32_at(&d, 140), 19)?;
        put32(&mut d, 136, ops);
    }
    process_storage(program, &a[2..], &data[1..], Some(vault))
}

pub(super) fn allocate_shard<'a>(
    vault: &AccountInfo<'a>,
    shard: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program: &Pubkey,
    space: usize,
    cap: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    writable(shard)?;
    require(*system.key == system_program::id() && system.executable, 6)?;
    require(
        *shard.owner == system_program::id() && shard.data_is_empty(),
        2,
    )?;
    let rent = Rent::get()?;
    let debit = rent.minimum_balance(space).saturating_sub(shard.lamports());
    let mut d = vault.try_borrow_mut_data()?;
    let spent = u64_at(&d, 128).checked_add(debit).ok_or(err(9))?;
    require(debit <= cap && spent <= u64_at(&d, 120), 7)?;
    require(
        vault.lamports()
            >= rent
                .minimum_balance(HEADER)
                .checked_add(debit)
                .ok_or(err(9))?,
        7,
    )?;
    put64(&mut d, 128, spent);
    drop(d);
    invoke_signed(
        &system_instruction::allocate(shard.key, space as u64),
        &[shard.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(shard.key, program),
        &[shard.clone(), system.clone()],
        &[seeds],
    )?;
    // Finish CPIs before moving program-owned lamports so the runtime never
    // observes only one side of the balance transfer during CPI account sync.
    let balance = shard.lamports().checked_add(debit).ok_or(err(9))?;
    **vault.try_borrow_mut_lamports()? -= debit;
    **shard.try_borrow_mut_lamports()? = balance;
    Ok(())
}
