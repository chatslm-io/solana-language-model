//! Deterministic scalar public inference kernels. No account/authentication policy.
//! Caller persists accumulators and supplies authenticated model/state slices.
#![allow(unexpected_cfgs)]
pub const MAX_TERMS: usize = 32;
pub const MAX_VECTOR: usize = 512;
pub const MAX_EXPERTS: usize = 256;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Shape,
    Bound,
    NonFinite,
    Encoding,
}
#[derive(Debug, Clone, Copy)]
pub enum Dtype {
    F32,
    F16,
    Q8_0,
}
fn finite(x: f32) -> Result<f32, Error> {
    if x.is_finite() {
        Ok(x)
    } else {
        Err(Error::NonFinite)
    }
}
pub fn read_f32(bytes: &[u8], i: usize) -> Result<f32, Error> {
    let at = i.checked_mul(4).ok_or(Error::Bound)?;
    let b = bytes
        .get(at..at.checked_add(4).ok_or(Error::Bound)?)
        .ok_or(Error::Shape)?;
    finite(f32::from_le_bytes(b.try_into().unwrap()))
}
pub fn f16(bits: u16) -> f32 {
    let sign = ((bits as u32) & 0x8000) << 16;
    let e = (bits >> 10) & 31;
    let m = (bits & 1023) as u32;
    if e == 31 {
        return f32::from_bits(sign | 0x7f800000 | (m << 13));
    }
    if e == 0 {
        let v = (m as f32) * (1.0 / 16777216.0);
        return if sign != 0 { -v } else { v };
    }
    f32::from_bits(sign | (((e as u32) + 112) << 23) | (m << 13))
}
pub fn weight(dtype: Dtype, bytes: &[u8], i: usize) -> Result<f32, Error> {
    match dtype {
        Dtype::F32 => read_f32(bytes, i),
        Dtype::F16 => {
            let at = i.checked_mul(2).ok_or(Error::Bound)?;
            finite(f16(u16::from_le_bytes(
                bytes
                    .get(at..at.checked_add(2).ok_or(Error::Bound)?)
                    .ok_or(Error::Shape)?
                    .try_into()
                    .unwrap(),
            )))
        }
        Dtype::Q8_0 => {
            let at = (i / 32).checked_mul(34).ok_or(Error::Bound)?;
            let block = bytes
                .get(at..at.checked_add(34).ok_or(Error::Bound)?)
                .ok_or(Error::Shape)?;
            finite(f16(u16::from_le_bytes([block[0], block[1]])) * (block[2 + i % 32] as i8 as f32))
        }
    }
}
/// A row segment, strictly ascending terms, with scalar f32 product/add rounding.
pub fn dot_chunk(
    dtype: Dtype,
    weights: &[u8],
    input: &[u8],
    offset: usize,
    count: usize,
    prior: f32,
) -> Result<f32, Error> {
    if count == 0 || count > MAX_TERMS {
        return Err(Error::Bound);
    };
    let end = offset.checked_add(count).ok_or(Error::Bound)?;
    let mut sum = finite(prior)?;
    for i in offset..end {
        let product = finite(weight(dtype, weights, i)? * read_f32(input, i)?)?;
        sum = finite(sum + product)?;
    }
    Ok(sum)
}
pub fn sigmoid(x: f32) -> Result<f32, Error> {
    finite(x)?;
    let e = libm::exp(if x >= 0.0 { -(x as f64) } else { x as f64 }) as f32;
    finite(if x >= 0.0 {
        1.0 / (1.0 + e)
    } else {
        e / (1.0 + e)
    })
}
pub fn silu(x: f32) -> Result<f32, Error> {
    finite(x * sigmoid(x)?)
}
pub fn rms_gain(sum_squares: f32, length: usize, epsilon: f32) -> Result<f32, Error> {
    if length == 0 || length > 1048576 || epsilon <= 0.0 || sum_squares < 0.0 {
        return Err(Error::Bound);
    };
    finite(epsilon)?;
    finite(sum_squares)?;
    let mean = sum_squares / (length as f32);
    let root = libm::sqrt(finite(mean + epsilon)? as f64) as f32;
    finite(1.0 / root)
}
pub fn norm_value(value: f32, gain: f32, weight: f32) -> Result<f32, Error> {
    finite(value)?;
    finite(gain)?;
    finite(weight)?;
    finite((value * gain) * weight)
}
pub fn softmax(input: &[f32], output: &mut [f32]) -> Result<(), Error> {
    if input.is_empty() || input.len() > MAX_VECTOR || input.len() != output.len() {
        return Err(Error::Shape);
    };
    let mut maximum = finite(input[0])?;
    for &v in input {
        finite(v)?;
        if v > maximum {
            maximum = v;
        }
    }
    let mut sum = 0.0f32;
    for &v in input {
        sum += libm::exp((v - maximum) as f64) as f32;
    }
    finite(sum)?;
    for (out, &v) in output.iter_mut().zip(input) {
        *out = (libm::exp((v - maximum) as f64) as f32) / sum;
    }
    Ok(())
}
/// GGML normal RoPE consecutive pair. Public position/base/dimension come from model descriptor.
pub fn rotary_pair(
    a: f32,
    b: f32,
    position: u32,
    base: f32,
    pair: usize,
    dimension: usize,
) -> Result<(f32, f32), Error> {
    if dimension == 0
        || dimension > MAX_VECTOR
        || dimension % 2 != 0
        || pair >= dimension / 2
        || base <= 0.0
    {
        return Err(Error::Bound);
    };
    finite(a)?;
    finite(b)?;
    finite(base)?;
    let angle = ((position as f64)
        * libm::pow(base as f64, -2.0 * (pair as f64) / (dimension as f64))) as f32;
    let c = libm::cos(angle as f64) as f32;
    let s = libm::sin(angle as f64) as f32;
    Ok((finite(a * c - b * s)?, finite(a * s + b * c)?))
}
pub fn argmax(values: &[f32]) -> Result<usize, Error> {
    if values.is_empty() {
        return Err(Error::Shape);
    };
    let mut best = 0;
    for (i, &v) in values.iter().enumerate() {
        finite(v)?;
        if v > values[best] {
            best = i;
        }
    }
    Ok(best)
}
/// Stable sigmoid+bias top-k; weights use unbiased probabilities in selection order.
pub fn route(
    logits: &[f32],
    bias: &[f32],
    indices: &mut [u32],
    weights: &mut [f32],
) -> Result<(), Error> {
    if logits.is_empty()
        || logits.len() > MAX_EXPERTS
        || logits.len() != bias.len()
        || indices.is_empty()
        || indices.len() > logits.len()
        || weights.len() != indices.len()
    {
        return Err(Error::Shape);
    };
    let mut p = [0.0f32; MAX_EXPERTS];
    let mut score = [0.0f32; MAX_EXPERTS];
    for i in 0..logits.len() {
        p[i] = sigmoid(logits[i])?;
        score[i] = finite(p[i] + finite(bias[i])?)?;
    }
    let mut sum = 0.0f32;
    for selected in 0..indices.len() {
        let mut best = None;
        for i in 0..logits.len() {
            if indices[..selected].contains(&(i as u32)) {
                continue;
            }
            if best.map_or(true, |b| score[i] > score[b]) {
                best = Some(i);
            }
        }
        let i = best.ok_or(Error::Shape)?;
        indices[selected] = i as u32;
        sum += p[i];
    }
    if sum == 0.0 {
        return Err(Error::NonFinite);
    };
    for i in 0..indices.len() {
        weights[i] = p[indices[i] as usize] / sum;
    }
    Ok(())
}
#[cfg(feature = "entrypoint")]
solana_program::entrypoint!(process_instruction);
#[cfg(feature = "entrypoint")]
fn process_instruction(
    _: &solana_program::pubkey::Pubkey,
    accounts: &[solana_program::account_info::AccountInfo],
    data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    use solana_program::{program::set_return_data, program_error::ProgramError};
    if !accounts.is_empty() || data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    };
    let count = data[1] as usize;
    if count == 0 || count > 32 {
        return Err(ProgramError::InvalidInstructionData);
    };
    let result = match data[0] {
        0 if data.len() == 2 + count * 8 => dot_chunk(
            Dtype::F32,
            &data[2..2 + count * 4],
            &data[2 + count * 4..],
            0,
            count,
            0.0,
        )
        .map(|v| {
            set_return_data(&v.to_le_bytes());
        }),
        1 if data.len() == 2 + count * 4 => {
            let mut out = [0u8; 128];
            let mut result = Ok(());
            for i in 0..count {
                match read_f32(&data[2..], i).and_then(silu) {
                    Ok(v) => out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes()),
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
            if result.is_ok() {
                set_return_data(&out[..count * 4]);
            }
            result
        }
        2 if count == 32 && data.len() == 164 => {
            let mut quantized = [0u8; 34];
            quantize_q8(&data[36..], &mut quantized)
                .and_then(|_| dot_q8(&data[2..36], &quantized))
                .map(|v| set_return_data(&v.to_le_bytes()))
        }
        3 if data.len() == 650 => {
            let mut quantized = [0u8; 136];
            quantize_q8(&data[138..], &mut quantized).and_then(|_| {
                let mut outputs = [0u8; 128];
                for i in 0..count {
                    let value = dot_q8(&data[2..138], &quantized)?;
                    outputs[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
                }
                set_return_data(&outputs[..count * 4]);
                Ok(())
            })
        }
        4 if count == 16 && data.len() == 66 => {
            let mut output = [0u8; 64];
            let mut status = Ok(());
            for pair in 0..8 {
                match read_f32(&data[2..], pair * 2).and_then(|a| {
                    read_f32(&data[2..], pair * 2 + 1)
                        .and_then(|b| rotary_pair(a, b, 7, 10000.0, pair, 16))
                }) {
                    Ok((a, b)) => {
                        output[pair * 8..pair * 8 + 4].copy_from_slice(&a.to_le_bytes());
                        output[pair * 8 + 4..pair * 8 + 8].copy_from_slice(&b.to_le_bytes());
                    }
                    Err(e) => {
                        status = Err(e);
                        break;
                    }
                }
            }
            if status.is_ok() {
                set_return_data(&output)
            }
            status
        }
        5 if count == 16 && data.len() == 66 => {
            let mut input = [0.0f32; 16];
            let mut output = [0.0f32; 16];
            let mut bytes = [0u8; 64];
            let status = (|| {
                for i in 0..16 {
                    input[i] = read_f32(&data[2..], i)?;
                }
                softmax(&input, &mut output)?;
                for i in 0..16 {
                    bytes[i * 4..i * 4 + 4].copy_from_slice(&output[i].to_le_bytes());
                }
                Ok(())
            })();
            if status.is_ok() {
                set_return_data(&bytes)
            }
            status
        }
        _ => Err(Error::Encoding),
    };
    result.map_err(|_| ProgramError::InvalidInstructionData)
}
/// IEEE binary32 -> binary16, round nearest ties-even, matching scalar oracle.
pub fn to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 255) as i32 - 127 + 15;
    let mantissa = bits & 0x7fffff;
    if (bits >> 23) & 255 == 255 {
        return sign | if mantissa != 0 { 0x7e00 } else { 0x7c00 };
    };
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    if exponent < -10 {
        return sign;
    }
    let significand = if exponent <= 0 {
        mantissa | 0x800000
    } else {
        mantissa
    };
    let shift = if exponent <= 0 { 14 - exponent } else { 13 } as u32;
    let mut rounded = significand >> shift;
    let remainder = significand & ((1 << shift) - 1);
    let halfway = 1 << (shift - 1);
    if remainder > halfway || (remainder == halfway && rounded & 1 != 0) {
        rounded += 1
    }
    sign | ((if exponent <= 0 {
        0
    } else {
        (exponent as u32) << 10
    }) + rounded) as u16
}
pub fn quantize_q8(input: &[u8], output: &mut [u8]) -> Result<(), Error> {
    if input.is_empty()
        || input.len() % 128 != 0
        || input.len() > MAX_VECTOR * 4
        || output.len() != input.len() / 128 * 34
    {
        return Err(Error::Shape);
    }
    for block in 0..input.len() / 128 {
        let mut maximum = 0.0f32;
        for j in 0..32 {
            let v = read_f32(input, block * 32 + j)?.abs();
            if v > maximum {
                maximum = v
            }
        }
        let scale = maximum / 127.0;
        let inverse = if scale != 0.0 { 1.0 / scale } else { 0.0 };
        output[block * 34..block * 34 + 2].copy_from_slice(&to_f16(scale).to_le_bytes());
        for j in 0..32 {
            let v = finite(read_f32(input, block * 32 + j)? * inverse)?;
            let rounded = libm::floor((v.abs() as f64) + 0.5) as i32;
            let signed = if v < 0.0 { -rounded } else { rounded };
            output[block * 34 + 2 + j] = signed as i8 as u8;
        }
    }
    Ok(())
}
pub fn dot_q8(weights: &[u8], input: &[u8]) -> Result<f32, Error> {
    if weights.is_empty()
        || weights.len() != input.len()
        || weights.len() % 34 != 0
        || weights.len() > MAX_VECTOR / 32 * 34
    {
        return Err(Error::Shape);
    }
    let mut sum = 0.0f32;
    for at in (0..input.len()).step_by(34) {
        let mut integer = 0i32;
        for j in 0..32 {
            integer += (weights[at + 2 + j] as i8 as i32) * (input[at + 2 + j] as i8 as i32)
        }
        let scale = finite(
            f16(u16::from_le_bytes([weights[at], weights[at + 1]]))
                * f16(u16::from_le_bytes([input[at], input[at + 1]])),
        )?;
        sum = finite(sum + scale * (integer as f32))?;
    }
    Ok(sum)
}
/// Complete bounded GEMV row. Q8 activations are prepared once by quantize_q8.
pub fn row_ggml(
    dtype: Dtype,
    weights: &[u8],
    input: &[u8],
    quantized: &[u8],
) -> Result<f32, Error> {
    if input.is_empty() || input.len() % 4 != 0 || input.len() > MAX_VECTOR * 4 {
        return Err(Error::Shape);
    }
    if matches!(dtype, Dtype::Q8_0) {
        return dot_q8(weights, quantized);
    }
    let mut sum = 0.0f32;
    for i in 0..input.len() / 4 {
        let mut x = read_f32(input, i)?;
        if matches!(dtype, Dtype::F16) {
            x = f16(to_f16(x));
        }
        sum = finite(sum + finite(x * weight(dtype, weights, i)?)?)?;
    }
    Ok(sum)
}

pub mod executor;

pub mod tokenizer;
mod unicode;
