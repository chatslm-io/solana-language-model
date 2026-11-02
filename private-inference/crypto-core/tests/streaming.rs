use slm_private_crypto::streaming::{
    decode_streaming_descriptor, evaluate_window, initialize_slots, validate_output_slots,
    validate_window, EMPTY_GENERATION, RECORD_BYTES, SLOT_BYTES,
};
use slm_private_crypto::{hash_label, xor, CircuitError, Label};
use std::io::Read;

fn random() -> Label {
    let mut value = [0; 32];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut value)
        .unwrap();
    value
}
fn put(bytes: &mut [u8], at: usize, n: u32) {
    bytes[at..at + 4].copy_from_slice(&n.to_le_bytes());
}

// Fresh whole-circuit test garbler. This two-slot chain repeatedly overwrites a
// dying source, exercises every opcode, and never exports a second input set.
fn fixture(a: bool, b: bool, gates: u32) -> (Vec<u8>, Vec<u8>, Label) {
    let ns = random();
    let mut delta = random();
    delta[0] |= 1;
    let mut zero_a = random();
    let zero_b = random();
    let mut desc = vec![0; 128 + 8 + 64];
    desc[..8].copy_from_slice(b"SLMGD002");
    desc[8..40].copy_from_slice(&ns);
    for (at, n) in [
        (40, 2),
        (44, gates),
        (48, 2),
        (52, 1),
        (56, 32),
        (60, (gates + 31) / 32),
        (128, gates + 1),
        (132, 0),
    ] {
        put(&mut desc, at, n);
    }
    desc[136..168].copy_from_slice(&if a { xor(&zero_a, &delta) } else { zero_a });
    desc[168..200].copy_from_slice(&if b { xor(&zero_b, &delta) } else { zero_b });
    // record_root is a public zero placeholder in this pure kernel fixture;
    // Merkle authentication is separately required in program integration.
    let mut records = vec![0; gates as usize * RECORD_BYTES];
    let mut clear = a;
    for index in 0..gates {
        let at = index as usize * RECORD_BYTES;
        let r = &mut records[at..at + RECORD_BYTES];
        let op = (index % 3) as u8;
        r[0] = op;
        let logical = if index == 0 { 0 } else { index + 1 };
        put(r, 4, logical);
        put(r, 12, 0);
        put(r, 20, 0);
        put(r, 24, logical);
        match op {
            0 => {
                put(r, 8, 1);
                put(r, 16, 1);
                let ha0 = hash_label(&zero_a, &ns, index as u64, 0);
                let ha1 = hash_label(&xor(&zero_a, &delta), &ns, index as u64, 0);
                let hb0 = hash_label(&zero_b, &ns, index as u64, 1);
                let hb1 = hash_label(&xor(&zero_b, &delta), &ns, index as u64, 1);
                let mut tg = xor(&ha0, &ha1);
                if zero_b[0] & 1 != 0 {
                    tg = xor(&tg, &delta);
                }
                let te = xor(&xor(&hb0, &hb1), &zero_a);
                let mut out = xor(&ha0, &hb0);
                if zero_a[0] & 1 != 0 {
                    out = xor(&out, &tg);
                }
                if zero_b[0] & 1 != 0 {
                    out = xor(&out, &xor(&hb0, &hb1));
                }
                r[32..64].copy_from_slice(&tg);
                r[64..96].copy_from_slice(&te);
                zero_a = out;
                clear = clear && b;
            }
            1 => {
                put(r, 8, 1);
                put(r, 16, 1);
                zero_a = xor(&zero_a, &zero_b);
                clear ^= b;
            }
            2 => {
                zero_a = xor(&zero_a, &delta);
                clear = !clear;
            }
            _ => unreachable!(),
        }
    }
    (
        desc,
        records,
        if clear { xor(&zero_a, &delta) } else { zero_a },
    )
}

#[test]
fn reused_slots_and_absolute_gate_tweaks_match_reference_across_windows() {
    for a in [false, true] {
        for b in [false, true] {
            let (bytes, records, expected) = fixture(a, b, 97);
            let d = decode_streaming_descriptor(&bytes).unwrap();
            let mut slots = vec![0; 2 * SLOT_BYTES];
            initialize_slots(&d, &mut slots).unwrap();
            for first in (0..97).step_by(32) {
                let end = (first + 32).min(97);
                let window = &records[first as usize * RECORD_BYTES..end as usize * RECORD_BYTES];
                let next = evaluate_window(window, &d, &mut slots, first).unwrap();
                assert_eq!(next, end);
            }
            validate_output_slots(&d, &slots, 97).unwrap();
            assert!(
                slots[8..40] == expected,
                "streaming ciphertext parity mismatch"
            );
            assert_eq!(&slots[..4], &98u32.to_le_bytes());
        }
    }
}

#[test]
fn rejects_stale_generations_aliases_and_last_record_errors_before_any_write() {
    let (bytes, records, _) = fixture(false, true, 65);
    let d = decode_streaming_descriptor(&bytes).unwrap();
    let mut initial = vec![0; 2 * SLOT_BYTES];
    initialize_slots(&d, &mut initial).unwrap();
    let first = &records[..32 * RECORD_BYTES];
    for (offset, value, expected) in [
        (4, 1, CircuitError::Generation),
        (12, 1, CircuitError::Generation),
        (20, 1, CircuitError::Generation),
        (24, 1, CircuitError::Generation),
        (31 * RECORD_BYTES + 1, 1, CircuitError::Reserved),
    ] {
        let mut bad = first.to_vec();
        put(&mut bad, offset, value);
        let mut slots = initial.clone();
        assert_eq!(evaluate_window(&bad, &d, &mut slots, 0), Err(expected));
        assert!(slots == initial, "failed window mutated slots");
    }
    let mut slots = initial.clone();
    evaluate_window(first, &d, &mut slots, 0).unwrap();
    assert!(evaluate_window(first, &d, &mut slots, 0).is_err()); // Stale replay.
    assert_eq!(
        validate_window(first, &d, &initial, 1),
        Err(CircuitError::Work)
    );
    assert_eq!(
        validate_window(&first[..first.len() - 1], &d, &initial, 0),
        Err(CircuitError::Encoding)
    );
    assert_eq!(
        validate_output_slots(&d, &slots, 32),
        Err(CircuitError::State)
    );
    let before = slots.clone();
    assert_eq!(initialize_slots(&d, &mut slots), Err(CircuitError::State));
    assert!(slots == before);
}

#[test]
fn empty_slots_require_zero_labels_and_initial_inputs_are_eager() {
    let (mut bytes, records, _) = fixture(true, true, 1);
    put(&mut bytes, 48, 3);
    let d = decode_streaming_descriptor(&bytes).unwrap();
    let mut slots = vec![0; 3 * SLOT_BYTES];
    initialize_slots(&d, &mut slots).unwrap();
    assert_eq!(
        &slots[2 * SLOT_BYTES..2 * SLOT_BYTES + 4],
        &EMPTY_GENERATION.to_le_bytes()
    );
    assert!(slots[2 * SLOT_BYTES + 4..].iter().all(|b| *b == 0));
    slots[2 * SLOT_BYTES + 8] = 1;
    assert_eq!(
        validate_window(&records, &d, &slots, 0),
        Err(CircuitError::State)
    );
}

#[test]
fn descriptor_rejects_version_reserved_window_counts_bounds_and_output_aliasing() {
    let (bytes, _, _) = fixture(false, false, 33);
    for (at, n) in [
        (40, 0),
        (40, 65),
        (44, 0),
        (44, 1_048_577),
        (48, 1),
        (48, 257),
        (52, 0),
        (52, 33),
        (56, 31),
        (60, 1),
        (96, 1),
        (128, 35),
        (132, 2),
    ] {
        let mut bad = bytes.clone();
        put(&mut bad, at, n);
        assert!(decode_streaming_descriptor(&bad).is_err());
    }
    let mut bad = bytes.clone();
    bad[0] |= 128;
    assert!(decode_streaming_descriptor(&bad).is_err());
    assert!(decode_streaming_descriptor(&bytes[..bytes.len() - 1]).is_err());
    let mut bad = bytes.clone();
    bad.push(0);
    assert!(decode_streaming_descriptor(&bad).is_err());
    // Two logical outputs cannot share a final physical slot.
    let mut bad = bytes[..136].to_vec();
    put(&mut bad, 52, 2);
    bad.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0]);
    bad.extend_from_slice(&bytes[136..]);
    assert!(matches!(
        decode_streaming_descriptor(&bad),
        Err(CircuitError::Output)
    ));
}
