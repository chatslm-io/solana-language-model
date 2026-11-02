//! Executor for authenticated immutable public model commands.
//! Account authority, page ownership, schedule PC and state commitments are the caller's job.
use crate::{read_f32, Error};
pub const STATE_BYTES: usize = 8192;
pub const CACHE_OFFSET: usize = 7808;
pub const NO_SELECTOR: u32 = u32::MAX;
#[derive(Clone, Copy, Debug)]
pub struct Command {
    pub op: u32,
    pub src: u32,
    pub dst: u32,
    pub len: u32,
    pub aux0: u32,
    pub aux1: u32,
    pub weight_page: u32,
    pub weight_offset: u32,
    pub cols: u32,
    pub rows: u32,
    pub row_start: u32,
    pub selector: u32,
    pub expert_stride: u32,
    pub format: u32,
    pub flags: u32,
}
impl Command {
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != 64 {
            return Err(Error::Encoding);
        }
        let u = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        if u(15) != 0 || !(1..=19).contains(&u(0)) {
            return Err(Error::Encoding);
        }
        Ok(Self {
            op: u(0),
            src: u(1),
            dst: u(2),
            len: u(3),
            aux0: u(4),
            aux1: u(5),
            weight_page: u(6),
            weight_offset: u(7),
            cols: u(8),
            rows: u(9),
            row_start: u(10),
            selector: u(11),
            expert_stride: u(12),
            format: u(13),
            flags: u(14),
        })
    }
}
fn row_bytes(command: &Command) -> Result<usize, Error> {
    let cols = command.cols as usize;
    if cols == 0 || cols > 352 {
        return Err(Error::Bound);
    }
    match command.format {
        1 if cols % 32 == 0 => Ok(cols / 32 * 34),
        2 => Ok(cols * 2),
        3 => Ok(cols * 4),
        _ => Err(Error::Encoding),
    }
}
pub fn selected_weight_page(command: &Command, state: &[u8], token: u32) -> Result<u32, Error> {
    if state.len() != STATE_BYTES {
        return Err(Error::Shape);
    }
    if command.op == 1 {
        let rows_per_page = 8192 / row_bytes(command)?;
        return command
            .weight_page
            .checked_add(token / (rows_per_page as u32))
            .ok_or(Error::Bound);
    }
    if command.selector == NO_SELECTOR {
        return Ok(command.weight_page);
    }
    if command.selector != 1938 && command.selector != 1939 {
        return Err(Error::Encoding);
    }
    let selected = read_f32(state, command.selector as usize)?;
    if selected < 0.0 || selected >= 8.0 || selected != (selected as u32) as f32 {
        return Err(Error::Bound);
    }
    command
        .weight_page
        .checked_add(
            (selected as u32)
                .checked_mul(command.expert_stride)
                .ok_or(Error::Bound)?,
        )
        .ok_or(Error::Bound)
}
fn put(state: &mut [u8], index: usize, value: f32) -> Result<(), Error> {
    if !value.is_finite() {
        return Err(Error::NonFinite);
    }
    let start = index.checked_mul(4).ok_or(Error::Bound)?;
    let end = start.checked_add(4).ok_or(Error::Bound)?;
    state
        .get_mut(start..end)
        .ok_or(Error::Shape)?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}
fn dtype(format: u32) -> Result<crate::Dtype, Error> {
    match format {
        1 => Ok(crate::Dtype::Q8_0),
        2 => Ok(crate::Dtype::F16),
        3 => Ok(crate::Dtype::F32),
        _ => Err(Error::Encoding),
    }
}
fn span(start: u32, length: usize) -> Result<std::ops::Range<usize>, Error> {
    let start = start as usize;
    let end = start.checked_add(length).ok_or(Error::Bound)?;
    if end > 1952 {
        return Err(Error::Bound);
    }
    Ok(start * 4..end * 4)
}
/// Execute one immutable command. On error the caller must roll back its transaction.
/// Weight bytes are the authenticated page selected by selected_weight_page.
#[inline(never)]
pub fn execute(
    c: &Command,
    state: &mut [u8],
    kv: &mut [u8],
    weights: &[u8],
    position: u32,
    token: u32,
) -> Result<(), Error> {
    if state.len() != STATE_BYTES || position >= 16 || token >= 8196 || c.flags > 1 {
        return Err(Error::Bound);
    }
    let src = c.src as usize;
    let dst = c.dst as usize;
    let len = c.len as usize;
    match c.op {
        1 => {
            if c.cols != 128 || c.format != 1 || c.dst != 0 {
                return Err(Error::Encoding);
            }
            let rb = row_bytes(c)?;
            let offset = (token as usize % (8192 / rb)) * rb;
            let row = weights.get(offset..offset + rb).ok_or(Error::Shape)?;
            for i in 0..128 {
                put(state, dst + i, crate::weight(dtype(c.format)?, row, i)?)?;
            }
        }
        2 => {
            if ![32, 64].contains(&len) || c.row_start % 32 != 0 || c.row_start as usize + len > 352
            {
                return Err(Error::Bound);
            }
            let start = c.src.checked_add(c.row_start).ok_or(Error::Bound)?;
            let range = span(start, len)?;
            if range.end > CACHE_OFFSET {
                return Err(Error::Bound);
            }
            let out = CACHE_OFFSET + c.row_start as usize / 32 * 34;
            let (input, cache) = state.split_at_mut(CACHE_OFFSET);
            crate::quantize_q8(
                &input[range],
                &mut cache[out - CACHE_OFFSET..out - CACHE_OFFSET + len / 32 * 34],
            )?;
        }
        3 => {
            gemv(c, state, weights)?;
        }
        4 => {
            if ![32, 128].contains(&len) {
                return Err(Error::Bound);
            }
            span(c.src, len)?;
            let mut sum = 0.0f32;
            for i in 0..len {
                let x = read_f32(state, src + i)?;
                sum += x * x;
            }
            let gain = crate::rms_gain(sum, len, f32::from_bits(c.aux0))?;
            put(state, dst, gain)?;
        }
        5 => {
            if len == 0 || len > 128 {
                return Err(Error::Bound);
            }
            span(c.src, len)?;
            span(c.dst, len)?;
            let gain = read_f32(state, c.aux0 as usize)?;
            let offset = c.weight_offset as usize;
            let w = weights.get(offset..offset + len * 4).ok_or(Error::Shape)?;
            for i in 0..len {
                let x = crate::norm_value(read_f32(state, src + i)?, gain, read_f32(w, i)?)?;
                put(state, dst + i, x)?;
            }
        }
        6 => {
            let source = span(c.src, len)?;
            span(c.dst, len)?;
            for i in 0..len {
                read_f32(state, src + i)?;
            }
            state.copy_within(source, dst * 4);
        }
        7 | 15 => {
            if len == 0 || len > 128 {
                return Err(Error::Bound);
            }
            span(c.src, len)?;
            span(c.dst, len)?;
            if c.op == 7 {
                span(c.aux0, len)?;
            }
            let scale = if c.op == 15 {
                read_f32(state, c.aux0 as usize)?
            } else {
                1.0
            };
            for i in 0..len {
                let a = read_f32(state, src + i)?;
                let b = read_f32(
                    state,
                    if c.op == 15 {
                        dst + i
                    } else {
                        c.aux0 as usize + i
                    },
                )?;
                put(state, dst + i, b + a * scale)?;
            }
        }
        8 => {
            if len == 0 || len > 32 {
                return Err(Error::Bound);
            }
            span(c.src, len)?;
            span(c.aux0, len)?;
            span(c.dst, len)?;
            for i in 0..len {
                let x =
                    crate::silu(read_f32(state, src + i)?)? * read_f32(state, c.aux0 as usize + i)?;
                put(state, dst + i, x)?;
            }
        }
        9 => {
            if len != 16 {
                return Err(Error::Bound);
            }
            span(c.src, len)?;
            span(c.dst, len)?;
            for pair in 0..8 {
                let (a, b) = crate::rotary_pair(
                    read_f32(state, src + 2 * pair)?,
                    read_f32(state, src + 2 * pair + 1)?,
                    position,
                    f32::from_bits(c.aux0),
                    pair,
                    16,
                )?;
                put(state, dst + 2 * pair, a)?;
                put(state, dst + 2 * pair + 1, b)?;
            }
        }
        10 => {
            if len != 48 || kv.len() != 3072 || c.aux0 >= 4 {
                return Err(Error::Shape);
            }
            let range = span(c.src, len)?;
            for i in 0..len {
                read_f32(state, src + i)?;
            }
            let offset = position as usize * 48 * 4;
            kv[offset..offset + 48 * 4].copy_from_slice(&state[range]);
        }
        11 => {
            if len == 0
                || len > 8
                || c.cols != 48
                || kv.len() != 3072
                || c.aux0 >= 4
                || c.row_start as usize + len > 16
            {
                return Err(Error::Bound);
            }
            span(c.src, 48)?;
            span(c.dst, 16)?;
            let scale = f32::from_bits(c.aux1);
            if !scale.is_finite() {
                return Err(Error::NonFinite);
            }
            for i in 0..len {
                let row = c.row_start as usize + i;
                let mut sum = 0.0f32;
                if row <= position as usize {
                    for j in 0..48 {
                        sum += read_f32(state, src + j)? * read_f32(kv, row * 48 + j)?;
                    }
                    sum *= scale;
                }
                put(state, dst + row, sum)?;
            }
        }
        12 => {
            if len != 16 || c.flags != 1 {
                return Err(Error::Bound);
            }
            span(c.src, 16)?;
            span(c.dst, 16)?;
            let mut input = [0.0f32; 16];
            let mut output = [0.0f32; 16];
            for i in 0..=position as usize {
                input[i] = read_f32(state, src + i)?;
            }
            crate::softmax(
                &input[..position as usize + 1],
                &mut output[..position as usize + 1],
            )?;
            for i in 0..16 {
                put(state, dst + i, output[i])?;
            }
        }
        13 => {
            if len != 32 || c.cols != 48 || kv.len() != 3072 || c.aux0 >= 4 {
                return Err(Error::Bound);
            }
            span(c.src, 16)?;
            span(c.dst, 32)?;
            for col in 0..32 {
                let mut sum = 0.0f32;
                for row in 0..=position as usize {
                    sum += read_f32(state, src + row)? * read_f32(kv, row * 48 + col)?;
                }
                put(state, dst + col, sum)?;
            }
        }
        14 => {
            if len != 8 {
                return Err(Error::Bound);
            }
            span(c.src, 8)?;
            span(c.dst, 2)?;
            span(c.aux0, 2)?;
            span(c.aux1, 8)?;
            let mut logits = [0.0f32; 8];
            let mut bias = [0.0f32; 8];
            let mut indices = [0u32; 2];
            let mut scales = [0.0f32; 2];
            let weight = weights
                .get(c.weight_offset as usize..)
                .ok_or(Error::Shape)?;
            for i in 0..8 {
                logits[i] = read_f32(state, src + i)?;
                bias[i] = read_f32(weight, i)?;
            }
            crate::route(&logits, &bias, &mut indices, &mut scales)?;
            for i in 0..8 {
                put(state, c.aux1 as usize + i, crate::sigmoid(logits[i])?)?;
            }
            for i in 0..2 {
                put(state, dst + i, indices[i] as f32)?;
                put(state, c.aux0 as usize + i, scales[i])?;
            }
        }
        16 => argmax_chunk(state, c.src, c.len, c.row_start, c.dst, c.aux0, c.flags)?,
        19 => {
            gemv(c, state, weights)?;
            argmax_chunk(state, c.dst, c.rows, c.row_start, c.aux0, c.aux1, c.flags)?;
        }
        17 => {}
        18 => {
            let range = span(c.dst, len)?;
            state[range].fill(0);
        }
        _ => return Err(Error::Encoding),
    }
    Ok(())
}
#[inline(never)]
fn gemv(c: &Command, state: &mut [u8], weights: &[u8]) -> Result<(), Error> {
    let cols = c.cols as usize;
    let rows = c.rows as usize;
    let rb = row_bytes(c)?;
    let budget = if c.format == 1 { 2048 } else { 512 };
    if rows == 0 || rows > 16 || rows * cols > budget {
        return Err(Error::Bound);
    }
    let input = span(c.src, cols)?;
    span(c.dst, rows)?;
    let offset = c.weight_offset as usize;
    let data = weights
        .get(offset..offset + rows * rb)
        .ok_or(Error::Shape)?;
    for row in 0..rows {
        let value = crate::row_ggml(
            dtype(c.format)?,
            &data[row * rb..(row + 1) * rb],
            &state[input.clone()],
            &state[CACHE_OFFSET..CACHE_OFFSET + if c.format == 1 { cols / 32 * 34 } else { 0 }],
        )?;
        put(state, c.dst as usize + row, value)?;
    }
    Ok(())
}

fn argmax_chunk(
    state: &mut [u8],
    src: u32,
    len: u32,
    row_start: u32,
    dst: u32,
    index_slot: u32,
    flags: u32,
) -> Result<(), Error> {
    let len = len as usize;
    if len == 0 || len > 16 || row_start as usize + len > 8196 {
        return Err(Error::Bound);
    }
    span(src, len)?;
    let src = src as usize;
    let mut best = if flags == 1 {
        read_f32(state, src)?
    } else {
        read_f32(state, dst as usize)?
    };
    let mut index = if flags == 1 {
        row_start as f32
    } else {
        read_f32(state, index_slot as usize)?
    };
    for i in 0..len {
        let value = read_f32(state, src + i)?;
        if value > best {
            best = value;
            index = (row_start as usize + i) as f32;
        }
    }
    put(state, dst as usize, best)?;
    put(state, index_slot as usize, index)?;
    Ok(())
}
