//! Experimental ZRE15 half-gates evaluator. No key generation or decryption.
//! Security assumptions and unfulfilled review requirements: SECURITY.md.
#![allow(unexpected_cfgs)]
pub mod streaming;
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, hash::hashv, program::set_return_data,
    program_error::ProgramError, pubkey::Pubkey,
};
#[cfg(feature = "entrypoint")]
solana_program::entrypoint!(process);

pub type Label = [u8; 32];
pub const HASH_DOMAIN: &[u8] = b"slm:half-gates:sha256:v1\0";
pub const REQUEST_BYTES: usize = 169;
pub const GATE_BYTES: usize = 80;
pub const ARTIFACT_HEADER_BYTES: usize = 64;
pub const MAX_INPUTS: u32 = 64;
pub const MAX_GATES: u32 = 192;
pub const MAX_WIRES: u32 = 256;
pub const MAX_OUTPUTS: u32 = 32;
pub const MAX_WORK: u32 = 32;
pub const MAX_ARTIFACT_BYTES: usize = 17_600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitError {
    Encoding,
    Bounds,
    Opcode,
    Reserved,
    Topology,
    Output,
    State,
    Work,
    Generation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CircuitShape {
    pub input_count: u32,
    pub gate_count: u32,
}
impl CircuitShape {
    pub fn wire_count(self) -> Result<u32, CircuitError> {
        if !(1..=MAX_INPUTS).contains(&self.input_count)
            || !(1..=MAX_GATES).contains(&self.gate_count)
        {
            return Err(CircuitError::Bounds);
        }
        let count = self.input_count + self.gate_count;
        if count > MAX_WIRES {
            return Err(CircuitError::Bounds);
        }
        Ok(count)
    }
}

/// Borrowed, structurally validated public artifact. This proves neither trusted
/// model compilation nor cryptographic correctness of the supplied tables.
pub struct CircuitArtifact<'a> {
    pub namespace: &'a Label,
    pub shape: CircuitShape,
    pub output_count: u32,
    pub output_indices: &'a [u8],
    pub input_labels: &'a [u8],
    pub records: &'a [u8],
}
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Validate all record bytes before execution. Sources always precede the
/// implicit destination input_count + gate_index, excluding cycles/forward refs.
pub fn validate_circuit(records: &[u8], shape: CircuitShape) -> Result<(), CircuitError> {
    shape.wire_count()?;
    if records.len() != shape.gate_count as usize * GATE_BYTES {
        return Err(CircuitError::Encoding);
    }
    for (index, record) in records.chunks_exact(GATE_BYTES).enumerate() {
        if record[1..4] != [0; 3] || record[12..16] != [0; 4] {
            return Err(CircuitError::Reserved);
        }
        let lhs = read_u32(record, 4);
        let rhs = read_u32(record, 8);
        let destination = shape.input_count + index as u32;
        if lhs >= destination {
            return Err(CircuitError::Topology);
        }
        match record[0] {
            0 | 1 if rhs >= destination => return Err(CircuitError::Topology),
            0 | 1 => (),
            2 if rhs != 0 => return Err(CircuitError::Reserved),
            2 => (),
            _ => return Err(CircuitError::Opcode),
        }
        if record[0] != 0 && record[16..].iter().any(|b| *b != 0) {
            return Err(CircuitError::Reserved);
        }
    }
    Ok(())
}

pub fn decode_artifact(data: &[u8]) -> Result<CircuitArtifact<'_>, CircuitError> {
    if data.len() < ARTIFACT_HEADER_BYTES
        || data.len() > MAX_ARTIFACT_BYTES
        || &data[..8] != b"SLMGC001"
    {
        return Err(CircuitError::Encoding);
    }
    if data[56..64] != [0; 8] {
        return Err(CircuitError::Reserved);
    }
    let shape = CircuitShape {
        input_count: read_u32(data, 40),
        gate_count: read_u32(data, 44),
    };
    let wires = shape.wire_count()?;
    let output_count = read_u32(data, 48);
    if !(1..=MAX_OUTPUTS).contains(&output_count) || read_u32(data, 52) != wires {
        return Err(CircuitError::Bounds);
    }
    let input_start = ARTIFACT_HEADER_BYTES + output_count as usize * 4;
    let record_start = input_start + shape.input_count as usize * 32;
    if data.len() != record_start + shape.gate_count as usize * GATE_BYTES {
        return Err(CircuitError::Encoding);
    }
    let output_indices = &data[ARTIFACT_HEADER_BYTES..input_start];
    for i in 0..output_count as usize {
        let output = read_u32(output_indices, i * 4);
        if output >= wires || (0..i).any(|j| read_u32(output_indices, j * 4) == output) {
            return Err(CircuitError::Output);
        }
    }
    let records = &data[record_start..];
    validate_circuit(records, shape)?;
    Ok(CircuitArtifact {
        namespace: data[8..40].try_into().unwrap(),
        shape,
        output_count,
        output_indices,
        input_labels: &data[input_start..record_start],
        records,
    })
}

/// Initialize a caller-owned zeroed state after authenticating the artifact.
/// Refuses nonzero state to prevent accidental restart over existing execution.
pub fn initialize_wires(
    artifact: &CircuitArtifact<'_>,
    wires: &mut [u8],
) -> Result<(), CircuitError> {
    let count = artifact.shape.wire_count()? as usize;
    if wires.len() != count * 32 || wires.iter().any(|b| *b != 0) {
        return Err(CircuitError::State);
    }
    if artifact.input_labels.len() != artifact.shape.input_count as usize * 32 {
        return Err(CircuitError::Encoding);
    }
    wires[..artifact.input_labels.len()].copy_from_slice(artifact.input_labels);
    Ok(())
}

/// Deterministic fixed public work, no allocation, writes only append outputs.
/// Caller MUST authenticate artifact, namespace, previous wire bytes and cursor;
/// this pure kernel cannot detect substitution of already-produced labels.
/// All fallible validation precedes mutation, including records outside this step.
pub fn evaluate_step(
    records: &[u8],
    shape: CircuitShape,
    namespace: &Label,
    wires: &mut [u8],
    next_gate: u32,
    work: u32,
) -> Result<u32, CircuitError> {
    validate_circuit(records, shape)?;
    if next_gate >= shape.gate_count
        || !(1..=MAX_WORK).contains(&work)
        || work > shape.gate_count - next_gate
    {
        return Err(CircuitError::Work);
    }
    let first_output = (shape.input_count + next_gate) as usize * 32;
    if wires.len() != shape.wire_count()? as usize * 32
        || wires[first_output..].iter().any(|b| *b != 0)
    {
        return Err(CircuitError::State);
    }
    for gate in next_gate..next_gate + work {
        let start = gate as usize * GATE_BYTES;
        let record = &records[start..start + GATE_BYTES];
        let lhs = read_u32(record, 4) as usize * 32;
        let a: Label = wires[lhs..lhs + 32].try_into().unwrap();
        let output = match record[0] {
            0 | 1 => {
                let rhs = read_u32(record, 8) as usize * 32;
                let b: Label = wires[rhs..rhs + 32].try_into().unwrap();
                if record[0] == 0 {
                    evaluate_and(
                        &a,
                        &b,
                        record[16..48].try_into().unwrap(),
                        record[48..80].try_into().unwrap(),
                        namespace,
                        gate as u64,
                    )
                } else {
                    xor(&a, &b)
                }
            }
            // NOT changes the garbler's semantic zero label by delta; evaluator
            // copies the active label. It never learns or uses secret delta.
            2 => a,
            _ => unreachable!(),
        };
        let destination = (shape.input_count + gate) as usize * 32;
        wires[destination..destination + 32].copy_from_slice(&output);
    }
    Ok(next_gate + work)
}
/// A unique session namespace and monotonically allocated gate ID separate every
/// invocation of H. The lifecycle program must authenticate both to the circuit.
pub fn hash_label(label: &Label, namespace: &[u8; 32], gate: u64, half: u8) -> Label {
    hashv(&[HASH_DOMAIN, namespace, &gate.to_le_bytes(), &[half], label]).to_bytes()
}
pub fn xor(a: &Label, b: &Label) -> Label {
    let mut out = [0; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}
/// ZRE15 Fig. 1 evaluation, with H instantiated as SHA-256 under the explicit
/// random-oracle assumption. The point bits are uniformly masked, not plaintext.
/// Two hashes and masked XOR work. The pinned SBF build is checked for equal CU
/// across public point bits; this is not a general compiler constant-time claim.
pub fn evaluate_and(
    a: &Label,
    b: &Label,
    tg: &Label,
    te: &Label,
    namespace: &[u8; 32],
    gate: u64,
) -> Label {
    let ha = hash_label(a, namespace, gate, 0);
    let hb = hash_label(b, namespace, gate, 1);
    // Prevent LLVM from specializing the 0/255 masks into four point-bit paths.
    // These point bits are already public ciphertext, not plaintext. black_box
    // is an optimization barrier, NOT a cryptographic constant-time primitive;
    // the actual pinned SBF code/resource tests remain the evidence.
    let ma = core::hint::black_box(0u8.wrapping_sub(a[0] & 1));
    let mb = core::hint::black_box(0u8.wrapping_sub(b[0] & 1));
    let mut out = [0; 32];
    for i in 0..32 {
        out[i] = ha[i] ^ hb[i] ^ (ma & tg[i]) ^ (mb & (te[i] ^ a[i]));
    }
    out
}
/// Spike-only wire: version=1, namespace[32], gate:u64LE, A/B/TG/TE[32].
/// This stateless probe does not authorize sessions or attest model correctness.
pub fn process(_: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if !accounts.is_empty() || data.len() != REQUEST_BYTES || data[0] != 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ns: Label = data[1..33].try_into().unwrap();
    let gate = u64::from_le_bytes(data[33..41].try_into().unwrap());
    if gate >= (1u64 << 32) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let a = data[41..73].try_into().unwrap();
    let b = data[73..105].try_into().unwrap();
    let tg = data[105..137].try_into().unwrap();
    let te = data[137..169].try_into().unwrap();
    set_return_data(&evaluate_and(&a, &b, &tg, &te, &ns, gate));
    Ok(())
}
