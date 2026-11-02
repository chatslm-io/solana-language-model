use slm_public_kernel::*;
#[test]
fn half_roundtrip_all_finite_and_signed_zero() {
    for bits in 0..=u16::MAX {
        if bits & 0x7c00 != 0x7c00 {
            assert_eq!(to_f16(f16(bits)), bits)
        }
    }
}
#[test]
fn scalar_operations_and_rejection() {
    assert_eq!(sigmoid(0.0).unwrap(), 0.5);
    assert_eq!(silu(0.0).unwrap(), 0.0);
    assert!(sigmoid(f32::NAN).is_err());
    assert!(rms_gain(-1.0, 4, 0.01).is_err());
    let mut probabilities = [0.0; 3];
    softmax(&[0.0, 0.0, 0.0], &mut probabilities).unwrap();
    assert_eq!(probabilities, [1.0 / 3.0; 3]);
    let mut indices = [9; 2];
    let mut weights = [0.0; 2];
    route(
        &[0.0, 0.0, 0.0],
        &[0.0, 0.0, 0.0],
        &mut indices,
        &mut weights,
    )
    .unwrap();
    assert_eq!(indices, [0, 1]);
    assert_eq!(weights, [0.5, 0.5]);
    assert_eq!(
        rotary_pair(2.0, 3.0, 0, 10000.0, 0, 16).unwrap(),
        (2.0, 3.0)
    );
    assert_eq!(argmax(&[2.0, 2.0, 1.0]).unwrap(), 0);
}
#[test]
fn q8_zero_and_half_ties() {
    let mut q = [9; 34];
    quantize_q8(&[0; 128], &mut q).unwrap();
    assert_eq!(q, [0; 34]);
    assert_eq!(dot_q8(&q, &q).unwrap(), 0.0);
    assert_eq!(to_f16(1.00048828125), 0x3c00);
    assert_eq!(to_f16(1.00146484375), 0x3c02);
    assert!(quantize_q8(&[0; 124], &mut q).is_err());
    assert!(dot_q8(&[0; 33], &[0; 33]).is_err());
}
#[test]
fn reject_nonfinite_intermediates_in_norm_and_quantization() {
    assert!(rms_gain(f32::MAX, 1, f32::MAX).is_err());
    let mut input = [0u8; 128];
    for i in 0..32 {
        input[i * 4..i * 4 + 4].copy_from_slice(&1e-40f32.to_le_bytes());
    }
    let mut output = [0u8; 34];
    assert!(quantize_q8(&input, &mut output).is_err());
}
