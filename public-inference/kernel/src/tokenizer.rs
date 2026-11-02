//! Bounded GPT-2 byte-BPE over authenticated model tables. Unicode category
//! data is pinned in the executable, not approximated by Rust char properties.
//! Caller binds table page ownership/root/index and rolls back failed steps.
pub use crate::unicode::UNICODE_SHA256;
use crate::Error;
pub const STATE_BYTES: usize = 3456;
pub const RAW_OFFSET: usize = 256;
pub const CLASS_OFFSET: usize = 768;
pub const SYMBOL_OFFSET: usize = 1280;
pub const OUTPUT_OFFSET: usize = 3328;
pub const PROFILE_DOMAIN: &[u8] = b"slm-public:gpt2-unicode17-messages4-bytes512:v1\n";
const MAGIC: &[u8; 8] = b"SLMPTS01";
#[derive(Debug, PartialEq, Eq)]
pub enum Status {
    InProgress,
    Complete,
}
fn get(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}
fn put(data: &mut [u8], at: usize, value: u32) {
    data[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
pub fn bucket(left: u32, right: u32) -> u32 {
    let h = left.wrapping_mul(0x9e3779b1) ^ right.wrapping_mul(0x85ebca77);
    (h ^ (h >> 16)) & 31
}
pub fn validate_descriptor(data: &[u8]) -> Result<(), Error> {
    if data.len() != 1120
        || &data[..8] != b"SLMPTD01"
        || get(data, 8) != 1
        || get(data, 12) != 32
        || get(data, 16) != 8196
        || get(data, 20) > 65536
        || data[24..56] != UNICODE_SHA256
        || get(data, 56) != 512
        || get(data, 60) != 0
        || get(data, 80) != 4
        || data[84..96].iter().any(|&b| b != 0)
    {
        return Err(Error::Encoding);
    }
    for i in 0..4 {
        if get(data, 64 + i * 4) != 8192 + i as u32 {
            return Err(Error::Encoding);
        }
    }
    let mut seen = [0u8; 1024];
    for i in 0..256 {
        let token = get(data, 96 + i * 4) as usize;
        if token >= 8192 || seen[token / 8] & (1 << (token % 8)) != 0 {
            return Err(Error::Encoding);
        }
        seen[token / 8] |= 1 << (token % 8);
    }
    Ok(())
}
fn checked(state: &[u8]) -> Result<(), Error> {
    if state.len() != STATE_BYTES || &state[..8] != MAGIC {
        return Err(Error::Encoding);
    }
    if !(1..=6).contains(&get(state, 8))
        || get(state, 12) > 512
        || !(1..=4).contains(&get(state, 16))
        || get(state, 20) > get(state, 16)
        || get(state, 24) > get(state, 12)
        || get(state, 28) > get(state, 12)
        || get(state, 32) > get(state, 12)
        || get(state, 36) > 512
        || get(state, 40) > 512
        || get(state, 60) > 16
        || !(1..=16).contains(&get(state, 64))
        || get(state, 68) > 1
    {
        return Err(Error::Encoding);
    }
    Ok(())
}
/// Framing: u32 message count, then (u32 role, u32 byte length, UTF8 bytes).
/// Roles are 0 system, 1 user, 2 assistant. Content never interprets special text.
pub fn initialize(frame: &[u8], generation: u32, state: &mut [u8]) -> Result<(), Error> {
    if state.len() != STATE_BYTES
        || state.iter().any(|&b| b != 0)
        || frame.len() < 4
        || frame.len() > 548
        || !(1..=16).contains(&generation)
    {
        return Err(Error::Shape);
    }
    let count = get(frame, 0);
    if !(1..=4).contains(&count) || count * 2 + 1 + generation > 16 {
        return Err(Error::Bound);
    }
    let mut at = 4;
    let mut raw = 0;
    // Complete frame validation before mutating persistent workspace.
    for _ in 0..count {
        if at + 8 > frame.len() {
            return Err(Error::Encoding);
        }
        let role = get(frame, at);
        let len = get(frame, at + 4) as usize;
        at += 8;
        if role > 2 || len > 512 || raw + len > 512 || at + len > frame.len() {
            return Err(Error::Bound);
        }
        core::str::from_utf8(&frame[at..at + len]).map_err(|_| Error::Encoding)?;
        raw += len;
        at += len;
    }
    if at != frame.len() {
        return Err(Error::Encoding);
    }
    state[..8].copy_from_slice(MAGIC);
    put(state, 8, 1);
    put(state, 12, raw as u32);
    put(state, 16, count);
    put(state, 64, generation);
    at = 4;
    raw = 0;
    for i in 0..count as usize {
        let role = get(frame, at);
        let len = get(frame, at + 4) as usize;
        at += 8;
        put(state, 128 + i * 12, role);
        put(state, 132 + i * 12, raw as u32);
        put(state, 136 + i * 12, len as u32);
        state[RAW_OFFSET + raw..RAW_OFFSET + raw + len].copy_from_slice(&frame[at..at + len]);
        at += len;
        raw += len;
    }
    Ok(())
}
pub fn desired_page(state: &[u8]) -> Result<Option<u32>, Error> {
    checked(state)?;
    match get(state, 8) {
        2 => Ok(Some(0)),
        3 => {
            let i = get(state, 40) as usize;
            let count = get(state, 36) as usize;
            if i + 1 >= count {
                return Err(Error::Encoding);
            }
            Ok(Some(
                1 + bucket(
                    get(state, SYMBOL_OFFSET + i * 4),
                    get(state, SYMBOL_OFFSET + (i + 1) * 4),
                ),
            ))
        }
        _ => Ok(None),
    }
}
fn append(state: &mut [u8], token: u32) -> Result<(), Error> {
    let n = get(state, 60);
    if token >= 8196 || n + 1 + get(state, 64) > 16 {
        return Err(Error::Bound);
    }
    put(state, OUTPUT_OFFSET + n as usize * 4, token);
    put(state, 60, n + 1);
    Ok(())
}
fn next(raw: &[u8], at: usize) -> usize {
    at + if raw[at] < 0x80 {
        1
    } else if raw[at] < 0xe0 {
        2
    } else if raw[at] < 0xf0 {
        3
    } else {
        4
    }
}
/// Exact alternation order of GPT2's reference regex. Class bytes are populated
/// only at validated scalar starts; continuation bytes have marker 128.
fn piece_end(raw: &[u8], classes: &[u8], start: usize, end: usize) -> usize {
    if raw[start] == b'\'' {
        for suffix in [b"s".as_slice(), b"t", b"re", b"ve", b"m", b"ll", b"d"] {
            let stop = start + 1 + suffix.len();
            if stop <= end && &raw[start + 1..stop] == suffix {
                return stop;
            }
        }
    }
    let mut at = start;
    let mut category = classes[at];
    if raw[at] == b' ' && at + 1 < end && classes[at + 1] != 4 {
        at += 1;
        category = classes[at];
    }
    if category != 4 {
        at = next(raw, at);
        while at < end && classes[at] == category {
            at = next(raw, at)
        }
        return at;
    }
    let mut last = at;
    let mut count = 0;
    while at < end && classes[at] == 4 {
        last = at;
        count += 1;
        at = next(raw, at)
    }
    if at < end && count > 1 {
        last
    } else {
        at
    }
}
fn classify(state: &mut [u8]) -> Result<(), Error> {
    let end = get(state, 12) as usize;
    let mut at = get(state, 28) as usize;
    for _ in 0..32 {
        if at == end {
            break;
        }
        let stop = next(&state[RAW_OFFSET..RAW_OFFSET + end], at);
        let character = core::str::from_utf8(&state[RAW_OFFSET + at..RAW_OFFSET + stop])
            .map_err(|_| Error::Encoding)?
            .chars()
            .next()
            .ok_or(Error::Encoding)?;
        state[CLASS_OFFSET + at] = crate::unicode::class(character as u32);
        for pos in at + 1..stop {
            state[CLASS_OFFSET + pos] = 128;
        }
        at = stop;
    }
    put(state, 28, at as u32);
    if at == end {
        put(state, 8, 2)
    }
    Ok(())
}
fn start_piece(state: &mut [u8], descriptor: &[u8]) -> Result<(), Error> {
    validate_descriptor(descriptor)?;
    put(state, 72, get(descriptor, 20));
    let message = get(state, 20) as usize;
    if message == get(state, 16) as usize {
        append(state, 8194)?;
        put(state, 8, 6);
        return Ok(());
    }
    let role = get(state, 128 + message * 12);
    let start = get(state, 132 + message * 12) as usize;
    let len = get(state, 136 + message * 12) as usize;
    let end = start + len;
    if end > get(state, 12) as usize || role > 2 {
        return Err(Error::Encoding);
    }
    if get(state, 68) == 0 {
        append(state, 8192 + role)?;
        put(state, 68, 1);
        put(state, 24, start as u32)
    }
    let at = get(state, 24) as usize;
    if at == end {
        append(state, 8195)?;
        put(state, 20, (message + 1) as u32);
        put(state, 68, 0);
        return Ok(());
    }
    if at < start || at > end {
        return Err(Error::Encoding);
    }
    let stop = piece_end(
        &state[RAW_OFFSET..RAW_OFFSET + 512],
        &state[CLASS_OFFSET..CLASS_OFFSET + 512],
        at,
        end,
    );
    let count = stop - at;
    for i in 0..count {
        let byte = state[RAW_OFFSET + at + i] as usize;
        put(state, SYMBOL_OFFSET + i * 4, get(descriptor, 96 + byte * 4));
    }
    put(state, 24, stop as u32);
    put(state, 32, stop as u32);
    put(state, 36, count as u32);
    put(state, 40, 0);
    put(state, 44, u32::MAX);
    put(state, 8, if count >= 2 { 3 } else { 5 });
    Ok(())
}
fn scan_pair(state: &mut [u8], page_index: u32, data: &[u8]) -> Result<(), Error> {
    if data.len() < 16
        || &data[..8] != b"SLMPTB01"
        || get(data, 8) != page_index - 1
        || get(data, 12) > 511
        || data.len() != 16 + get(data, 12) as usize * 16
    {
        return Err(Error::Encoding);
    }
    let i = get(state, 40) as usize;
    let count = get(state, 36) as usize;
    let left = get(state, SYMBOL_OFFSET + i * 4);
    let right = get(state, SYMBOL_OFFSET + (i + 1) * 4);
    let mut found = None;
    for record in data[16..].chunks_exact(16) {
        let lhs = get(record, 0);
        let rhs = get(record, 4);
        let merged = get(record, 8);
        let rank = get(record, 12);
        if lhs >= 8192
            || rhs >= 8192
            || merged >= 8192
            || rank >= get(state, 72)
            || bucket(lhs, rhs) + 1 != page_index
        {
            return Err(Error::Encoding);
        }
        if lhs == left && rhs == right {
            if found.is_some() {
                return Err(Error::Encoding);
            }
            found = Some((rank, merged));
        }
    }
    if let Some((rank, merged)) = found {
        if rank < get(state, 44) {
            put(state, 44, rank);
            put(state, 48, left);
            put(state, 52, right);
            put(state, 56, merged);
        }
    }
    put(state, 40, (i + 1) as u32);
    if i + 2 == count {
        put(state, 8, if get(state, 44) == u32::MAX { 5 } else { 4 })
    }
    Ok(())
}
fn merge(state: &mut [u8]) -> Result<(), Error> {
    let count = get(state, 36) as usize;
    let left = get(state, 48);
    let right = get(state, 52);
    let merged = get(state, 56);
    let mut read = 0;
    let mut write = 0;
    while read < count {
        let token = get(state, SYMBOL_OFFSET + read * 4);
        if read + 1 < count && token == left && get(state, SYMBOL_OFFSET + (read + 1) * 4) == right
        {
            put(state, SYMBOL_OFFSET + write * 4, merged);
            read += 2;
        } else {
            put(state, SYMBOL_OFFSET + write * 4, token);
            read += 1;
        }
        write += 1;
    }
    if write == count {
        return Err(Error::Encoding);
    }
    state[SYMBOL_OFFSET + write * 4..SYMBOL_OFFSET + count * 4].fill(0);
    put(state, 36, write as u32);
    put(state, 40, 0);
    put(state, 44, u32::MAX);
    put(state, 8, if write >= 2 { 3 } else { 5 });
    Ok(())
}
pub fn step(state: &mut [u8], page: Option<(u32, &[u8])>) -> Result<Status, Error> {
    let wanted = desired_page(state)?;
    if page.map(|p| p.0) != wanted {
        return Err(Error::Encoding);
    }
    match get(state, 8) {
        1 => classify(state)?,
        2 => start_piece(state, page.ok_or(Error::Encoding)?.1)?,
        3 => {
            let (index, bytes) = page.ok_or(Error::Encoding)?;
            scan_pair(state, index, bytes)?
        }
        4 => merge(state)?,
        5 => {
            let count = get(state, 36) as usize;
            if get(state, 60) + count as u32 + get(state, 64) > 16 {
                return Err(Error::Bound);
            }
            for i in 0..count {
                append(state, get(state, SYMBOL_OFFSET + i * 4))?;
            }
            state[SYMBOL_OFFSET..SYMBOL_OFFSET + count * 4].fill(0);
            put(state, 36, 0);
            put(state, 8, 2);
        }
        6 => return Err(Error::Encoding),
        _ => return Err(Error::Encoding),
    }
    Ok(if get(state, 8) == 6 {
        Status::Complete
    } else {
        Status::InProgress
    })
}
pub fn outputs(state: &[u8]) -> Result<&[u8], Error> {
    checked(state)?;
    if get(state, 8) != 6 {
        return Err(Error::Encoding);
    }
    Ok(&state[OUTPUT_OFFSET..OUTPUT_OFFSET + get(state, 60) as usize * 4])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(text: &str) -> Vec<u8> {
        let mut out = 1u32.to_le_bytes().to_vec();
        out.extend(1u32.to_le_bytes());
        out.extend((text.len() as u32).to_le_bytes());
        out.extend(text.as_bytes());
        out
    }
    fn pieces(text: &str) -> Vec<&str> {
        let mut state = [0u8; STATE_BYTES];
        initialize(&frame(text), 1, &mut state).unwrap();
        while get(&state, 8) == 1 {
            step(&mut state, None).unwrap();
        }
        let mut result = Vec::new();
        let mut at = 0;
        while at < text.len() {
            let stop = piece_end(
                text.as_bytes(),
                &state[CLASS_OFFSET..CLASS_OFFSET + 512],
                at,
                text.len(),
            );
            result.push(&text[at..stop]);
            at = stop;
        }
        result
    }
    #[test]
    fn splitter_matches_independent_javascript_unicode_regex_vectors() {
        for (text, expected) in [
            ("  a", vec![" ", " a"]),
            (" \na", vec![" ", "\n", "a"]),
            ("a  ", vec!["a", "  "]),
            ("'s", vec!["'s"]),
            ("'S", vec!["'", "S"]),
            ("a\u{a0}b", vec!["a", "\u{a0}", "b"]),
            ("a\u{301}b", vec!["a", "\u{301}", "b"]),
            ("你好 🌎", vec!["你好", " 🌎"]),
            ("\t\ta", vec!["\t", "\t", "a"]),
            (
                "can't we'll I'M",
                vec!["can", "'t", " we", "'ll", " I", "'", "M"],
            ),
            ("a\r\n b", vec!["a", "\r\n", " b"]),
            ("", vec![]),
        ] {
            assert_eq!(pieces(text), expected, "{text:?}");
        }
    }
    #[test]
    fn invalid_utf8_and_frame_reject_without_partial_initialization() {
        for bytes in [
            vec![0xc0, 0x80],
            vec![0xed, 0xa0, 0x80],
            vec![0xf4, 0x90, 0x80, 0x80],
            vec![0x80],
            vec![0xe2, 0x82],
        ] {
            let mut input = vec![];
            input.extend(1u32.to_le_bytes());
            input.extend(1u32.to_le_bytes());
            input.extend((bytes.len() as u32).to_le_bytes());
            input.extend(bytes);
            let mut state = [0u8; STATE_BYTES];
            assert!(initialize(&input, 1, &mut state).is_err());
            assert!(state.iter().all(|&x| x == 0));
        }
    }
    fn descriptor() -> Vec<u8> {
        let mut d = vec![0; 1120];
        d[..8].copy_from_slice(b"SLMPTD01");
        put(&mut d, 8, 1);
        put(&mut d, 12, 32);
        put(&mut d, 16, 8196);
        put(&mut d, 20, 2);
        d[24..56].copy_from_slice(&UNICODE_SHA256);
        put(&mut d, 56, 512);
        for i in 0..4 {
            put(&mut d, 64 + i * 4, 8192 + i as u32);
        }
        put(&mut d, 80, 4);
        for i in 0..256 {
            put(&mut d, 96 + i * 4, i as u32);
        }
        d
    }
    fn tables() -> Vec<Vec<u8>> {
        let mut pages = vec![descriptor()];
        for i in 0..32 {
            let mut page = vec![0; 16];
            page[..8].copy_from_slice(b"SLMPTB01");
            put(&mut page, 8, i);
            pages.push(page);
        }
        for (left, right, result, rank) in [(97, 97, 256, 0), (256, 256, 257, 1)] {
            let b = bucket(left, right) as usize + 1;
            let count = get(&pages[b], 12);
            put(&mut pages[b], 12, count + 1);
            for value in [left, right, result, rank] {
                pages[b].extend(value.to_le_bytes());
            }
        }
        pages
    }
    fn encode(text: &str) -> Vec<u32> {
        let pages = tables();
        let mut state = [0u8; STATE_BYTES];
        initialize(&frame(text), 1, &mut state).unwrap();
        for _ in 0..10000 {
            let wanted = desired_page(&state).unwrap();
            let page = wanted.map(|i| (i, pages[i as usize].as_slice()));
            if step(&mut state, page).unwrap() == Status::Complete {
                return outputs(&state)
                    .unwrap()
                    .chunks_exact(4)
                    .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
            }
        }
        panic!("step bound")
    }
    #[test]
    fn all_selected_pair_occurrences_merge_and_template_is_onchain() {
        assert_eq!(encode("aaaa"), vec![8193, 257, 8195, 8194]);
        assert_eq!(encode("aaaaa"), vec![8193, 257, 97, 8195, 8194]);
        assert_eq!(encode(""), vec![8193, 8195, 8194]);
    }
    #[test]
    fn descriptor_rejects_duplicate_byte_mapping_and_unicode_mismatch() {
        let mut d = descriptor();
        validate_descriptor(&d).unwrap();
        put(&mut d, 96 + 4, 0);
        assert!(validate_descriptor(&d).is_err());
        d = descriptor();
        d[24] ^= 1;
        assert!(validate_descriptor(&d).is_err());
    }
}
