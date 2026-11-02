use slm_public_kernel::{executor::*, *};
fn command(op: u32) -> Command {
    Command {
        op,
        src: 0,
        dst: 0,
        len: 0,
        aux0: 0,
        aux1: 0,
        weight_page: 0,
        weight_offset: 0,
        cols: 0,
        rows: 0,
        row_start: 0,
        selector: NO_SELECTOR,
        expert_stride: 0,
        format: 0,
        flags: 0,
    }
}
fn set(state: &mut [u8], at: usize, value: f32) {
    state[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
#[test]
fn persisted_quantization_and_chunk_output_address() {
    let mut state = [0u8; 8192];
    let mut kv = [];
    for i in 0..352 {
        set(&mut state, i, (i as f32 - 100.0) / 32.0)
    }
    let mut whole = [0u8; 374];
    quantize_q8(&state[..352 * 4], &mut whole).unwrap();
    for start in (0..352).step_by(64) {
        let mut c = command(2);
        c.row_start = start as u32;
        c.len = (352 - start).min(64) as u32;
        execute(&c, &mut state, &mut kv, &[], 0, 0).unwrap();
    }
    assert_eq!(&state[CACHE_OFFSET..CACHE_OFFSET + 374], &whole);
    let mut c = command(3);
    c.cols = 352;
    c.rows = 1;
    c.dst = 736;
    c.row_start = 8192;
    c.format = 1;
    execute(&c, &mut state, &mut kv, &whole, 0, 0).unwrap();
    assert_eq!(
        read_f32(&state, 736).unwrap(),
        dot_q8(&whole, &whole).unwrap()
    );
    c.dst = 1951;
    c.rows = 2;
    assert!(execute(&c, &mut state, &mut kv, &whole, 0, 0).is_err());
}
#[test]
fn selector_and_embedding_page_derived_from_state() {
    let mut c = command(3);
    let mut state = [0u8; 8192];
    c.weight_page = 20;
    c.expert_stride = 3;
    c.selector = 1938;
    set(&mut state, 1938, 7.0);
    assert_eq!(selected_weight_page(&c, &state, 5).unwrap(), 41);
    set(&mut state, 1938, 7.5);
    assert!(selected_weight_page(&c, &state, 5).is_err());
    c.op = 1;
    c.cols = 128;
    c.format = 1;
    assert_eq!(selected_weight_page(&c, &state, 60).unwrap(), 21);
}
#[test]
fn attention_rows_are_runtime_position_bounded_and_softmax_prefix_only() {
    let mut state = [0u8; 8192];
    let mut kv = [0u8; 3072];
    for i in 0..48 {
        set(&mut state, 624 + i, 1.0);
        set(&mut kv, i, 1.0)
    }
    let mut c = command(11);
    c.src = 624;
    c.dst = 672;
    c.len = 8;
    c.cols = 48;
    c.aux1 = 1.0f32.to_bits();
    execute(&c, &mut state, &mut kv, &[], 0, 0).unwrap();
    assert_eq!(read_f32(&state, 672).unwrap(), 48.0);
    assert_eq!(read_f32(&state, 673).unwrap(), 0.0);
    c = command(12);
    c.src = 672;
    c.dst = 688;
    c.len = 16;
    c.flags = 1;
    execute(&c, &mut state, &mut kv, &[], 0, 0).unwrap();
    assert_eq!(read_f32(&state, 688).unwrap(), 1.0);
    assert_eq!(read_f32(&state, 689).unwrap(), 0.0);
}
#[test]
fn fused_head_preserves_logits_and_lowest_index_tie() {
    let mut state = [0u8; 8192];
    for i in 0..32 {
        set(&mut state, i, 1.0)
    }
    let mut weights = [0u8; 68];
    quantize_q8(&state[..128], &mut weights[..34]).unwrap();
    let row: Vec<u8> = weights[..34].to_vec();
    weights[34..].copy_from_slice(&row);
    let mut quant = command(2);
    quant.len = 32;
    execute(&quant, &mut state, &mut [], &[], 0, 0).unwrap();
    let mut fused = command(19);
    fused.cols = 32;
    fused.rows = 2;
    fused.dst = 736;
    fused.row_start = 8000;
    fused.format = 1;
    fused.aux0 = 1940;
    fused.aux1 = 1941;
    fused.flags = 1;
    let mut unfused = state;
    let mut ordinary = fused;
    ordinary.op = 3;
    execute(&ordinary, &mut unfused, &mut [], &weights, 0, 0).unwrap();
    let mut select = command(16);
    select.src = 736;
    select.len = 2;
    select.row_start = 8000;
    select.dst = 1940;
    select.aux0 = 1941;
    select.flags = 1;
    execute(&select, &mut unfused, &mut [], &[], 0, 0).unwrap();
    execute(&fused, &mut state, &mut [], &weights, 0, 0).unwrap();
    assert_eq!(state, unfused);
    assert_eq!(read_f32(&state, 1941).unwrap(), 8000.0);
}
