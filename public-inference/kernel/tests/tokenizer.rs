use slm_public_kernel::tokenizer::*;
fn put(bytes: &mut [u8], at: usize, n: u32) {
    bytes[at..at + 4].copy_from_slice(&n.to_le_bytes());
}
fn get(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn pages() -> Vec<Vec<u8>> {
    let mut d = vec![0; 1120];
    d[..8].copy_from_slice(b"SLMPTD01");
    put(&mut d, 8, 1);
    put(&mut d, 12, 32);
    put(&mut d, 16, 8196);
    d[24..56].copy_from_slice(&UNICODE_SHA256);
    put(&mut d, 56, 512);
    for i in 0..4 {
        put(&mut d, 64 + i * 4, 8192 + i as u32);
    }
    put(&mut d, 80, 4);
    for i in 0..256 {
        put(&mut d, 96 + i * 4, i as u32);
    }
    let mut pages = vec![d];
    for i in 0..32 {
        let mut p = vec![0; 16];
        p[..8].copy_from_slice(b"SLMPTB01");
        put(&mut p, 8, i);
        pages.push(p);
    }
    pages
}
#[test]
fn randomized_unicode_piece_boundaries_match_frozen_independent_js_regex() {
    let pages = pages();
    for line in include_str!("split-vectors.txt")
        .lines()
        .filter(|line| !line.starts_with('#'))
    {
        let (hex, expected) = line.split_once('|').unwrap();
        let raw: Vec<u8> = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|b| u8::from_str_radix(core::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let expected: Vec<u32> = expected.split(',').map(|n| n.parse().unwrap()).collect();
        let mut frame = vec![];
        frame.extend(1u32.to_le_bytes());
        frame.extend(1u32.to_le_bytes());
        frame.extend((raw.len() as u32).to_le_bytes());
        frame.extend(&raw);
        let mut state = [0u8; STATE_BYTES];
        initialize(&frame, 1, &mut state).unwrap();
        let mut ends = Vec::new();
        let mut complete = false;
        for _ in 0..1000 {
            let phase = get(&state, 8);
            let desired = desired_page(&state).unwrap();
            let status = step(
                &mut state,
                desired.map(|i| (i, pages[i as usize].as_slice())),
            )
            .unwrap();
            if phase == 2 && [3, 5].contains(&get(&state, 8)) {
                ends.push(get(&state, 24));
            }
            if status == Status::Complete {
                complete = true;
                break;
            }
        }
        assert!(complete);
        assert_eq!(ends, expected, "inputhex={hex}");
    }
}
