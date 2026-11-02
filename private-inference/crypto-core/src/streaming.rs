//! Experimental v2 bounded physical-slot execution. Merkle/window admission,
//! authorization and atomic persisted cursors are obligations of the caller.
//! No lazy input loads or spill operations are supported by this version.
use crate::{evaluate_and, read_u32, xor, CircuitError, Label};

pub const DESCRIPTOR_HEADER_BYTES: usize = 128;
pub const RECORD_BYTES: usize = 96;
pub const SLOT_BYTES: usize = 40;
pub const EMPTY_GENERATION: u32 = u32::MAX;
pub const WINDOW_GATES: u32 = 32;
pub const MAX_INPUTS: u32 = 64;
pub const MAX_SLOTS: u32 = 256;
pub const MAX_OUTPUTS: u32 = 32;
pub const MAX_GATES: u32 = 1_048_576;
pub const MAX_DESCRIPTOR_BYTES: usize = 2432;

pub struct StreamingDescriptor<'a> {
    pub namespace: &'a Label,
    pub input_count: u32,
    pub gate_count: u32,
    pub slot_count: u32,
    pub output_count: u32,
    pub window_count: u32,
    pub record_root: &'a Label,
    /// Ordered (logical wire u32LE, physical slot u32LE) pairs.
    pub outputs: &'a [u8],
    pub input_labels: &'a [u8],
}

fn bounds(d: &StreamingDescriptor<'_>) -> Result<(), CircuitError> {
    if !(1..=MAX_INPUTS).contains(&d.input_count)
        || !(1..=MAX_GATES).contains(&d.gate_count)
        || d.slot_count < d.input_count
        || d.slot_count > MAX_SLOTS
        || !(1..=MAX_OUTPUTS).contains(&d.output_count)
        || d.window_count != (d.gate_count + WINDOW_GATES - 1) / WINDOW_GATES
        || d.outputs.len() != d.output_count as usize * 8
        || d.input_labels.len() != d.input_count as usize * 32
    {
        return Err(CircuitError::Bounds);
    }
    Ok(())
}

/// Exact codec validation only; caller authenticates this descriptor and its
/// Merkle root against the sealed session before allocating/executing anything.
pub fn decode_streaming_descriptor(data: &[u8]) -> Result<StreamingDescriptor<'_>, CircuitError> {
    if data.len() < DESCRIPTOR_HEADER_BYTES
        || data.len() > MAX_DESCRIPTOR_BYTES
        || &data[..8] != b"SLMGD002"
    {
        return Err(CircuitError::Encoding);
    }
    if data[96..128] != [0; 32] {
        return Err(CircuitError::Reserved);
    }
    let input_count = read_u32(data, 40);
    let output_count = read_u32(data, 52);
    if !(1..=MAX_INPUTS).contains(&input_count)
        || !(1..=MAX_OUTPUTS).contains(&output_count)
        || read_u32(data, 56) != WINDOW_GATES
    {
        return Err(CircuitError::Bounds);
    }
    let input_start = DESCRIPTOR_HEADER_BYTES + output_count as usize * 8;
    if data.len() != input_start + input_count as usize * 32 {
        return Err(CircuitError::Encoding);
    }
    let descriptor = StreamingDescriptor {
        namespace: data[8..40].try_into().unwrap(),
        input_count,
        gate_count: read_u32(data, 44),
        slot_count: read_u32(data, 48),
        output_count,
        window_count: read_u32(data, 60),
        record_root: data[64..96].try_into().unwrap(),
        outputs: &data[128..input_start],
        input_labels: &data[input_start..],
    };
    bounds(&descriptor)?;
    for (index, output) in descriptor.outputs.chunks_exact(8).enumerate() {
        let logical = read_u32(output, 0);
        let slot = read_u32(output, 4);
        if logical >= descriptor.input_count + descriptor.gate_count
            || slot >= descriptor.slot_count
        {
            return Err(CircuitError::Output);
        }
        // Two final selected logical wires cannot occupy the same physical slot.
        for previous in descriptor.outputs[..index * 8].chunks_exact(8) {
            if logical == read_u32(previous, 0) || slot == read_u32(previous, 4) {
                return Err(CircuitError::Output);
            }
        }
    }
    Ok(descriptor)
}

/// Eager-input profile: slot i initially contains input i. All remaining slots
/// have the empty-generation sentinel and zero data. No secret keys are present.
pub fn initialize_slots(d: &StreamingDescriptor<'_>, slots: &mut [u8]) -> Result<(), CircuitError> {
    bounds(d)?;
    if slots.len() != d.slot_count as usize * SLOT_BYTES || slots.iter().any(|b| *b != 0) {
        return Err(CircuitError::State);
    }
    for (index, slot) in slots.chunks_exact_mut(SLOT_BYTES).enumerate() {
        if index < d.input_count as usize {
            slot[..4].copy_from_slice(&(index as u32).to_le_bytes());
            slot[8..].copy_from_slice(&d.input_labels[index * 32..(index + 1) * 32]);
        } else {
            slot[..4].copy_from_slice(&EMPTY_GENERATION.to_le_bytes());
        }
    }
    Ok(())
}

/// Validate a complete public window and simulate its generation changes before
/// writing any labels. The 256-entry generation workspace occupies 1024 bytes;
/// no heap allocation or full logical-wire array is used.
pub fn validate_window(
    records: &[u8],
    d: &StreamingDescriptor<'_>,
    slots: &[u8],
    first_gate: u32,
) -> Result<u32, CircuitError> {
    bounds(d)?;
    if first_gate >= d.gate_count || first_gate % WINDOW_GATES != 0 {
        return Err(CircuitError::Work);
    }
    let count = (d.gate_count - first_gate).min(WINDOW_GATES);
    if records.len() != count as usize * RECORD_BYTES {
        return Err(CircuitError::Encoding);
    }
    if slots.len() != d.slot_count as usize * SLOT_BYTES {
        return Err(CircuitError::State);
    }
    let mut generations = [EMPTY_GENERATION; MAX_SLOTS as usize];
    for (index, slot) in slots.chunks_exact(SLOT_BYTES).enumerate() {
        let logical = read_u32(slot, 0);
        if slot[4..8] != [0; 4]
            || (logical != EMPTY_GENERATION && logical >= d.input_count + first_gate)
            || (logical == EMPTY_GENERATION && slot[8..].iter().any(|b| *b != 0))
        {
            return Err(CircuitError::State);
        }
        generations[index] = logical;
    }
    for (index, record) in records.chunks_exact(RECORD_BYTES).enumerate() {
        if record[1..4] != [0; 3] || record[28..32] != [0; 4] {
            return Err(CircuitError::Reserved);
        }
        let lhs = read_u32(record, 4);
        let rhs = read_u32(record, 8);
        let lhs_slot = read_u32(record, 12);
        let rhs_slot = read_u32(record, 16);
        let dst_slot = read_u32(record, 20);
        let prior = read_u32(record, 24);
        let dst = d.input_count + first_gate + index as u32;
        if lhs >= dst || (record[0] != 2 && rhs >= dst) {
            return Err(CircuitError::Topology);
        }
        if lhs_slot >= d.slot_count || rhs_slot >= d.slot_count || dst_slot >= d.slot_count {
            return Err(CircuitError::Bounds);
        }
        match record[0] {
            0 | 1 => (),
            2 if rhs == 0 && rhs_slot == 0 => (),
            2 => return Err(CircuitError::Reserved),
            _ => return Err(CircuitError::Opcode),
        }
        if record[0] != 0 && record[32..].iter().any(|b| *b != 0) {
            return Err(CircuitError::Reserved);
        }
        if generations[lhs_slot as usize] != lhs
            || (record[0] != 2 && generations[rhs_slot as usize] != rhs)
            || generations[dst_slot as usize] != prior
        {
            return Err(CircuitError::Generation);
        }
        generations[dst_slot as usize] = dst;
    }
    Ok(first_gate + count)
}

/// Caller must first prove the exact records' membership in d.record_root and
/// authenticate first_gate/slots against the previous persisted state. A raw
/// record hash supplied by a caller is not membership or model correctness.
pub fn evaluate_window(
    records: &[u8],
    d: &StreamingDescriptor<'_>,
    slots: &mut [u8],
    first_gate: u32,
) -> Result<u32, CircuitError> {
    let next = validate_window(records, d, slots, first_gate)?;
    for (index, record) in records.chunks_exact(RECORD_BYTES).enumerate() {
        let lhs_offset = read_u32(record, 12) as usize * SLOT_BYTES;
        let a: Label = slots[lhs_offset + 8..lhs_offset + SLOT_BYTES]
            .try_into()
            .unwrap();
        let output = match record[0] {
            0 | 1 => {
                let rhs_offset = read_u32(record, 16) as usize * SLOT_BYTES;
                let b: Label = slots[rhs_offset + 8..rhs_offset + SLOT_BYTES]
                    .try_into()
                    .unwrap();
                if record[0] == 0 {
                    evaluate_and(
                        &a,
                        &b,
                        record[32..64].try_into().unwrap(),
                        record[64..96].try_into().unwrap(),
                        d.namespace,
                        first_gate as u64 + index as u64,
                    )
                } else {
                    xor(&a, &b)
                }
            }
            2 => a,
            _ => unreachable!(),
        };
        let dst_offset = read_u32(record, 20) as usize * SLOT_BYTES;
        let logical = d.input_count + first_gate + index as u32;
        slots[dst_offset..dst_offset + 4].copy_from_slice(&logical.to_le_bytes());
        slots[dst_offset + 8..dst_offset + SLOT_BYTES].copy_from_slice(&output);
    }
    Ok(next)
}

/// Check final output generations before completion or extracting ciphertext.
pub fn validate_output_slots(
    d: &StreamingDescriptor<'_>,
    slots: &[u8],
    gate_cursor: u32,
) -> Result<(), CircuitError> {
    bounds(d)?;
    if gate_cursor != d.gate_count || slots.len() != d.slot_count as usize * SLOT_BYTES {
        return Err(CircuitError::State);
    }
    for output in d.outputs.chunks_exact(8) {
        let logical = read_u32(output, 0);
        let slot = read_u32(output, 4);
        if logical >= d.input_count + d.gate_count || slot >= d.slot_count {
            return Err(CircuitError::Output);
        }
        let offset = slot as usize * SLOT_BYTES;
        if read_u32(slots, offset) != logical || slots[offset + 4..offset + 8] != [0; 4] {
            return Err(CircuitError::Generation);
        }
    }
    Ok(())
}
