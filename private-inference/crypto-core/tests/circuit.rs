use slm_private_crypto::{
    decode_artifact, evaluate_step, hash_label, initialize_wires, validate_circuit, xor,
    CircuitError, CircuitShape, Label, GATE_BYTES, MAX_ARTIFACT_BYTES,
};
use std::io::Read;

fn random_label() -> Label {
    let mut bytes = [0; 32];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes
}

// Independent test garbler. Secrets exist only in this test process. Never send
// a second set of input labels for any generated tables, even in tests.
fn garble(inputs: &[bool], graph: &[(u8, usize, usize)]) -> (Vec<u8>, Vec<Label>, Vec<bool>) {
    let namespace = random_label();
    let mut delta = random_label();
    delta[0] |= 1;
    let mut zero_labels: Vec<Label> = inputs.iter().map(|_| random_label()).collect();
    let mut clear = inputs.to_vec();
    let mut records = Vec::new();
    for (index, &(op, lhs, rhs)) in graph.iter().enumerate() {
        let a = zero_labels[lhs];
        let mut record = [0u8; GATE_BYTES];
        record[0] = op;
        record[4..8].copy_from_slice(&(lhs as u32).to_le_bytes());
        record[8..12].copy_from_slice(&(rhs as u32).to_le_bytes());
        let output = match op {
            0 => {
                let b = zero_labels[rhs];
                let ha0 = hash_label(&a, &namespace, index as u64, 0);
                let ha1 = hash_label(&xor(&a, &delta), &namespace, index as u64, 0);
                let hb0 = hash_label(&b, &namespace, index as u64, 1);
                let hb1 = hash_label(&xor(&b, &delta), &namespace, index as u64, 1);
                let mut tg = xor(&ha0, &ha1);
                if b[0] & 1 == 1 {
                    tg = xor(&tg, &delta);
                }
                let te = xor(&xor(&hb0, &hb1), &a);
                let mut result = xor(&ha0, &hb0);
                if a[0] & 1 == 1 {
                    result = xor(&result, &tg);
                }
                if b[0] & 1 == 1 {
                    result = xor(&result, &xor(&hb0, &hb1));
                }
                record[16..48].copy_from_slice(&tg);
                record[48..80].copy_from_slice(&te);
                clear.push(clear[lhs] && clear[rhs]);
                result
            }
            1 => {
                clear.push(clear[lhs] ^ clear[rhs]);
                xor(&a, &zero_labels[rhs])
            }
            2 => {
                clear.push(!clear[lhs]);
                xor(&a, &delta)
            }
            _ => panic!("invalid test graph"),
        };
        records.extend_from_slice(&record);
        zero_labels.push(output);
    }
    let outputs: Vec<u32> = (inputs.len()..zero_labels.len())
        .rev()
        .take(32)
        .map(|i| i as u32)
        .collect();
    let mut artifact = vec![0; 64];
    artifact[..8].copy_from_slice(b"SLMGC001");
    artifact[8..40].copy_from_slice(&namespace);
    artifact[40..44].copy_from_slice(&(inputs.len() as u32).to_le_bytes());
    artifact[44..48].copy_from_slice(&(graph.len() as u32).to_le_bytes());
    artifact[48..52].copy_from_slice(&(outputs.len() as u32).to_le_bytes());
    artifact[52..56].copy_from_slice(&(zero_labels.len() as u32).to_le_bytes());
    for index in outputs {
        artifact.extend_from_slice(&index.to_le_bytes());
    }
    for (i, &bit) in inputs.iter().enumerate() {
        artifact.extend_from_slice(&if bit {
            xor(&zero_labels[i], &delta)
        } else {
            zero_labels[i]
        });
    }
    artifact.extend_from_slice(&records);
    let expected = zero_labels
        .iter()
        .enumerate()
        .map(|(i, label)| if clear[i] { xor(label, &delta) } else { *label })
        .collect();
    (artifact, expected, clear)
}

#[test]
fn mixed_private_gates_fanout_not_and_absolute_tweaks_match_reference() {
    let graph = [(0, 0, 1), (1, 2, 0), (2, 3, 0), (0, 4, 1), (1, 5, 2)];
    for _round in 0..8 {
        for bits in 0..4 {
            let (bytes, expected, _) = garble(&[bits & 1 != 0, bits & 2 != 0], &graph);
            let artifact = decode_artifact(&bytes).unwrap();
            let mut wires = vec![0; expected.len() * 32];
            initialize_wires(&artifact, &mut wires).unwrap();
            let mut next = 0;
            for work in [2, 1, 2] {
                next = evaluate_step(
                    artifact.records,
                    artifact.shape,
                    artifact.namespace,
                    &mut wires,
                    next,
                    work,
                )
                .unwrap();
            }
            assert_eq!(next, 5);
            assert!(
                wires == expected.concat(),
                "ciphertext conformance mismatch"
            );
        }
    }
}

#[test]
fn maximum_artifact_and_cross_step_consistency() {
    let inputs = [false; 64];
    let graph: Vec<_> = (0..192)
        .map(|i| (0, if i == 0 { 0 } else { 63 + i }, 1))
        .collect();
    let (bytes, expected, _) = garble(&inputs, &graph);
    assert_eq!(bytes.len(), MAX_ARTIFACT_BYTES);
    let artifact = decode_artifact(&bytes).unwrap();
    let mut first = vec![0; 256 * 32];
    initialize_wires(&artifact, &mut first).unwrap();
    let mut second = first.clone();
    for next in (0..192).step_by(32) {
        evaluate_step(
            artifact.records,
            artifact.shape,
            artifact.namespace,
            &mut first,
            next,
            32,
        )
        .unwrap();
    }
    for next in 0..192 {
        evaluate_step(
            artifact.records,
            artifact.shape,
            artifact.namespace,
            &mut second,
            next,
            1,
        )
        .unwrap();
    }
    assert!(first == second, "partitioned ciphertext mismatch");
    assert!(
        first == expected.concat(),
        "maximum circuit conformance mismatch"
    );
}

#[test]
fn strict_graph_encoding_and_no_partial_mutation_on_failure() {
    let (bytes, _, _) = garble(&[true, false], &[(0, 0, 1), (1, 2, 0), (2, 3, 0)]);
    let artifact = decode_artifact(&bytes).unwrap();
    let mut initial = vec![0; 5 * 32];
    initialize_wires(&artifact, &mut initial).unwrap();
    for (offset, value, expected) in [
        (0, 3, CircuitError::Opcode),
        (1, 1, CircuitError::Reserved),
        (12, 1, CircuitError::Reserved),
        (4, 2, CircuitError::Topology), // Self-reference.
        (8, 4, CircuitError::Topology), // Forward edge/cycle.
        (80 + 16, 1, CircuitError::Reserved),
        (160 + 8, 1, CircuitError::Reserved),
    ] {
        let mut bad = artifact.records.to_vec();
        bad[offset] = value;
        let mut wires = initial.clone();
        assert_eq!(
            evaluate_step(&bad, artifact.shape, artifact.namespace, &mut wires, 0, 1),
            Err(expected)
        );
        assert!(wires == initial, "failed step mutated state");
    }
    for (next, work) in [(0, 0), (0, 33), (0, 4), (3, 1), (u32::MAX, 1)] {
        let mut wires = initial.clone();
        assert_eq!(
            evaluate_step(
                artifact.records,
                artifact.shape,
                artifact.namespace,
                &mut wires,
                next,
                work
            ),
            Err(CircuitError::Work)
        );
        assert!(wires == initial, "failed step mutated state");
    }
    let mut bad_state = initial.clone();
    bad_state[64] = 1;
    assert_eq!(
        evaluate_step(
            artifact.records,
            artifact.shape,
            artifact.namespace,
            &mut bad_state,
            0,
            1
        ),
        Err(CircuitError::State)
    );
    assert_eq!(
        initialize_wires(&artifact, &mut bad_state),
        Err(CircuitError::State)
    );
    assert_eq!(
        validate_circuit(
            artifact.records,
            CircuitShape {
                input_count: 0,
                gate_count: 3
            }
        ),
        Err(CircuitError::Bounds)
    );
    assert_eq!(
        validate_circuit(&artifact.records[1..], artifact.shape),
        Err(CircuitError::Encoding)
    );
}

#[test]
fn artifact_rejects_unknown_version_reserved_duplicates_counts_and_trailing_bytes() {
    let (bytes, _, _) = garble(&[false, false], &[(0, 0, 1), (2, 2, 0)]);
    for offset in [0, 7, 40, 44, 48, 52, 56, 63] {
        let mut bad = bytes.clone();
        bad[offset] ^= 0x80;
        assert!(decode_artifact(&bad).is_err());
    }
    let mut duplicate = bytes.clone();
    let first = duplicate[64..68].to_vec();
    duplicate[68..72].copy_from_slice(&first);
    assert!(matches!(
        decode_artifact(&duplicate),
        Err(CircuitError::Output)
    ));
    let mut out_of_bounds = bytes.clone();
    out_of_bounds[64..68].copy_from_slice(&4u32.to_le_bytes());
    assert!(matches!(
        decode_artifact(&out_of_bounds),
        Err(CircuitError::Output)
    ));
    assert!(decode_artifact(&bytes[..bytes.len() - 1]).is_err());
    let mut extra = bytes;
    extra.push(0);
    assert!(decode_artifact(&extra).is_err());
}
