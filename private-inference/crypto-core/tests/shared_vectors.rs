//! Independent Rust interpretation of coordinator-frozen public Python vectors.
//! This fixture accessor is not a JSON parser and is never used on untrusted data.
use solana_program::hash::hashv;
const FIXTURE: &str = include_str!("../../protocol/vectors.json");
fn fixed_hex(field: &str) -> Vec<u8> {
    fixture_hex(FIXTURE, field)
}
fn fixture_hex(fixture: &str, field: &str) -> Vec<u8> {
    let marker = format!("\"{}\": \"", field);
    let hex = fixture
        .split_once(&marker)
        .unwrap()
        .1
        .split('"')
        .next()
        .unwrap();
    assert_eq!(hex.len() % 2, 0);
    hex.as_bytes()
        .chunks_exact(2)
        .map(|b| {
            let n = |c| match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                _ => panic!("noncanonical fixture"),
            };
            n(b[0]) * 16 + n(b[1])
        })
        .collect()
}

#[test]
fn exact_bounded_circuit_artifact_vector() {
    use slm_private_crypto::decode_artifact;
    let fixture = include_str!("../../protocol/circuit-vectors.json");
    let bytes = fixture_hex(fixture, "artifactHex");
    let artifact = decode_artifact(&bytes).unwrap();
    assert_eq!(artifact.shape.input_count, 2);
    assert_eq!(artifact.shape.gate_count, 3);
    assert_eq!(artifact.output_count, 2);
    assert_eq!(
        artifact.namespace.as_slice(),
        fixture_hex(fixture, "namespaceHex")
    );
    assert_eq!(
        artifact.input_labels,
        fixture_hex(fixture, "inputLabelsHex")
    );
    assert_eq!(artifact.records, fixture_hex(fixture, "recordsHex"));
    assert_eq!(artifact.output_indices, &[4, 0, 0, 0, 2, 0, 0, 0]);
    for (i, (op, lhs, rhs)) in [(0u8, 0u32, 1u32), (2, 2, 0), (1, 3, 0)]
        .into_iter()
        .enumerate()
    {
        let r = &artifact.records[i * 80..(i + 1) * 80];
        assert_eq!(r[0], op);
        assert_eq!(&r[4..8], &lhs.to_le_bytes());
        assert_eq!(&r[8..12], &rhs.to_le_bytes());
    }
    let graph = fixture_hex(fixture, "graphHex");
    assert_eq!(
        hashv(&[b"slm-private:circuit-graph:v1\n", &graph]).as_ref(),
        fixture_hex(fixture, "graphHash")
    );
    // Public synthetic tables deliberately are not valid garbling. No encrypted
    // execution or security claim is inferred from these codec assertions.
}

#[test]
fn exact_streaming_descriptor_and_eager_input_vector() {
    use slm_private_crypto::streaming::{
        decode_streaming_descriptor, initialize_slots, SLOT_BYTES,
    };
    let fixture = include_str!("../../protocol/streaming-state-vectors.json");
    let bytes = fixture_hex(fixture, "descriptor");
    let d = decode_streaming_descriptor(&bytes).unwrap();
    assert_eq!(d.namespace, &[6u8; 32]);
    assert_eq!(d.input_count, 2);
    assert_eq!(d.gate_count, 1);
    assert_eq!(d.slot_count, 2);
    assert_eq!(d.output_count, 1);
    assert_eq!(d.window_count, 1);
    assert_eq!(d.record_root, &[9u8; 32]);
    assert_eq!(d.outputs, &[2, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&d.input_labels[..32], &[11u8; 32]);
    assert_eq!(&d.input_labels[32..], &[12u8; 32]);
    let mut slots = vec![0; 2 * SLOT_BYTES];
    initialize_slots(&d, &mut slots).unwrap();
    assert_eq!(&slots[..8], &[0u8; 8]);
    assert_eq!(&slots[8..40], &[11u8; 32]);
    assert_eq!(&slots[40..48], &[1, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&slots[48..], &[12u8; 32]);
    // Labels/root are public synthetic codec values, not valid encrypted data.
}
#[test]
fn exact_session_and_step_vectors_and_domains() {
    let session = fixed_hex("sessionHex");
    assert_eq!(session.len(), 412);
    assert_eq!(&session[..8], b"SLMPIB01");
    for field in 0..12 {
        assert_eq!(
            &session[8 + 32 * field..40 + 32 * field],
            &[field as u8 + 1; 32]
        );
    }
    for (offset, value) in [(392, 256u32), (396, 32), (400, 4096)] {
        assert_eq!(
            u32::from_le_bytes(session[offset..offset + 4].try_into().unwrap()),
            value
        );
    }
    assert_eq!(
        u64::from_le_bytes(session[404..412].try_into().unwrap()),
        123456789
    );
    let binding = hashv(&[b"slm-private:session:v1\n", &session]);
    assert_eq!(binding.as_ref(), fixed_hex("sessionHash"));
    let step = fixed_hex("stepHex");
    assert_eq!(step.len(), 80);
    assert_eq!(&step[..8], b"SLMPIS01");
    assert_eq!(&step[8..40], binding.as_ref());
    assert_eq!(&step[40..72], &[0x55; 32]);
    assert_eq!(u32::from_le_bytes(step[72..76].try_into().unwrap()), 7);
    assert_eq!(u32::from_le_bytes(step[76..80].try_into().unwrap()), 32);
    assert_eq!(
        hashv(&[b"slm-private:step:v1\n", &step]).as_ref(),
        fixed_hex("stepHash")
    );
    assert_ne!(
        hashv(&[b"slm-private:result:v1\n", &step]).as_ref(),
        fixed_hex("stepHash")
    );
    let payload = fixed_hex("payloadHex");
    let page = hashv(&[
        b"slm-private:page:v1\n",
        &0u32.to_le_bytes(),
        &0u32.to_le_bytes(),
        &(payload.len() as u32).to_le_bytes(),
        &payload,
    ]);
    assert_eq!(page.as_ref(), fixed_hex("hash"));
    assert_eq!(
        hashv(&[b"slm-private:pages:v1\n", page.as_ref()]).as_ref(),
        fixed_hex("pagesRoot")
    );
}
