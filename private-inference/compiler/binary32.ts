/** Exact IEEE754 binary32 addition graph, round-to-nearest/ties-to-even.
 * NaN outputs are canonical quiet NaN 0x7fc00000. This explicit payload policy
 * is a compiler primitive specification, not an approved target-model change.
 */
import type { CircuitBuilder, Wire, Word } from "./circuit";
export function compileBinary32Add(
  builder: CircuitBuilder,
  a: Word,
  b: Word,
): Wire[] {
  if (a.length !== 32 || b.length !== 32)
    throw Error("compiler_binary32_width");
  const zero = builder.constant(false),
    one = builder.constant(true);
  const all = (bits: Word): Wire =>
    bits.slice(1).reduce((out, bit) => builder.and(out, bit), bits[0] ?? one);
  const any = (bits: Word): Wire =>
    builder.not(all(bits.map((bit) => builder.not(bit))));
  const or = (x: Wire, y: Wire) =>
    builder.xor(builder.xor(x, y), builder.and(x, y));
  const isZero = (bits: Word) => all(bits.map((bit) => builder.not(bit)));
  const increment = (word: Word, flag: Wire): Wire[] => {
    let carry = flag;
    return word.map((bit, index) => {
      const output = builder.xor(bit, carry);
      if (index + 1 < word.length) carry = builder.and(bit, carry);
      return output;
    });
  };
  const decrement = (word: Word, flag: Wire): Wire[] => {
    let borrow = flag;
    return word.map((bit, index) => {
      const output = builder.xor(bit, borrow);
      if (index + 1 < word.length)
        borrow = builder.and(builder.not(bit), borrow);
      return output;
    });
  };
  const addCarry = (x: Word, y: Word, flag: Wire): Wire[] => {
    let carry = flag;
    return x.map((bit, index) => {
      const propagate = builder.xor(bit, y[index]),
        output = builder.xor(propagate, carry);
      if (index + 1 < x.length)
        carry = builder.xor(
          builder.and(bit, y[index]),
          builder.and(propagate, carry),
        );
      return output;
    });
  };
  const swap = builder.unsignedLess(a.slice(0, 31), b.slice(0, 31)),
    big = builder.muxWord(swap, b, a),
    small = builder.muxWord(swap, a, b),
    different = builder.xor(big[31], small[31]);
  const bigExponent = big.slice(23, 31),
    smallExponent = small.slice(23, 31),
    bigNormal = builder.not(isZero(bigExponent)),
    smallNormal = builder.not(isZero(smallExponent));
  let exponent = builder.muxWord(bigNormal, bigExponent, [
    one,
    ...Array<Wire>(7).fill(zero),
  ]);
  const smallEffective = builder.muxWord(smallNormal, smallExponent, [
      one,
      ...Array<Wire>(7).fill(zero),
    ]),
    difference = addCarry(
      exponent,
      smallEffective.map((bit) => builder.not(bit)),
      one,
    );
  const largeMantissa = [
    zero,
    zero,
    zero,
    ...big.slice(0, 23),
    bigNormal,
    zero,
  ];
  let aligned = [zero, zero, zero, ...small.slice(0, 23), smallNormal];
  // Shift-right-jam. All eight exponent-difference bits execute unconditionally;
  // excessive shifts collapse to a sticky bit rather than truncating it away.
  for (let stage = 0; stage < 8; stage++) {
    const distance = 2 ** stage,
      sticky = any(aligned.slice(0, Math.min(aligned.length, distance + 1))),
      shifted = aligned.map((_, i) =>
        i === 0 ? sticky : (aligned[i + distance] ?? zero),
      );
    aligned = builder.muxWord(difference[stage], shifted, aligned);
  }
  let value = addCarry(
    largeMantissa,
    [...aligned, zero].map((bit) => builder.xor(bit, different)),
    different,
  );
  const carry = value[27],
    right = [or(value[0], value[1]), ...value.slice(2), zero];
  value = builder.muxWord(carry, right, value);
  exponent = increment(exponent, carry);
  // Bounded normalization includes gradual underflow: exponent never drops below
  // one, so a result too small to normalize retains a subnormal significand.
  for (let position = 0; position < 26; position++) {
    const shift = builder.and(builder.not(value[26]), any(exponent.slice(1))),
      left = [zero, ...value.slice(0, 27)];
    value = builder.muxWord(shift, left, value);
    exponent = decrement(exponent, shift);
  }
  const overflowBeforeRound = all(exponent),
    roundUp = builder.and(value[2], any([value[0], value[1], value[3]]));
  const rounded = increment([...value.slice(3, 27), zero], roundUp),
    roundCarry = rounded[24];
  const mantissa = builder.muxWord(
    roundCarry,
    rounded.slice(1),
    rounded.slice(0, 24),
  );
  exponent = increment(exponent, roundCarry);
  const overflow = or(overflowBeforeRound, all(exponent));
  const resultExponent = builder.muxWord(
    mantissa[23],
    exponent,
    Array<Wire>(8).fill(zero),
  );
  const cancelled = builder.and(different, isZero(value)),
    sign = builder.and(big[31], builder.not(cancelled));
  const infinity = [
      ...Array<Wire>(23).fill(zero),
      ...Array<Wire>(8).fill(one),
      big[31],
    ],
    finite = [...mantissa.slice(0, 23), ...resultExponent, sign];
  let result = builder.muxWord(overflow, infinity, finite);
  const aAllExponent = all(a.slice(23, 31)),
    bAllExponent = all(b.slice(23, 31)),
    aFractionZero = isZero(a.slice(0, 23)),
    bFractionZero = isZero(b.slice(0, 23));
  const aInfinity = builder.and(aAllExponent, aFractionZero),
    bInfinity = builder.and(bAllExponent, bFractionZero),
    aNaN = builder.and(aAllExponent, builder.not(aFractionZero)),
    bNaN = builder.and(bAllExponent, builder.not(bFractionZero));
  result = builder.muxWord(or(aInfinity, bInfinity), infinity, result);
  const invalid = builder.and(builder.and(aInfinity, bInfinity), different),
    nan = or(or(aNaN, bNaN), invalid);
  return builder.muxWord(nan, builder.constantWord(0x7fc00000n, 32), result);
}

/** Exact binary32 multiply with the same RNE/canonical-NaN primitive policy. */
export function compileBinary32Multiply(
  builder: CircuitBuilder,
  a: Word,
  b: Word,
): Wire[] {
  if (a.length !== 32 || b.length !== 32)
    throw Error("compiler_binary32_width");
  const zero = builder.constant(false),
    one = builder.constant(true);
  const all = (bits: Word): Wire =>
    bits.slice(1).reduce((out, bit) => builder.and(out, bit), bits[0] ?? one);
  const isZero = (bits: Word) => all(bits.map((bit) => builder.not(bit)));
  const any = (bits: Word) => builder.not(isZero(bits));
  const or = (x: Wire, y: Wire) =>
    builder.xor(builder.xor(x, y), builder.and(x, y));
  const addCarry = (x: Word, y: Word, flag: Wire): Wire[] => {
    let carry = flag;
    return x.map((bit, index) => {
      const propagate = builder.xor(bit, y[index]),
        output = builder.xor(propagate, carry);
      if (index + 1 < x.length)
        carry = builder.xor(
          builder.and(bit, y[index]),
          builder.and(propagate, carry),
        );
      return output;
    });
  };
  const increment = (word: Word, flag: Wire): Wire[] => {
    let carry = flag;
    return word.map((bit, index) => {
      const output = builder.xor(bit, carry);
      if (index + 1 < word.length) carry = builder.and(bit, carry);
      return output;
    });
  };
  const subtractPowerIf = (word: Word, power: number, flag: Wire): Wire[] => {
    let borrow = flag;
    return word.map((bit, index) => {
      if (index < power) return bit;
      const output = builder.xor(bit, borrow);
      if (index + 1 < word.length)
        borrow = builder.and(builder.not(bit), borrow);
      return output;
    });
  };
  const aExponent = a.slice(23, 31),
    bExponent = b.slice(23, 31),
    aNormal = builder.not(isZero(aExponent)),
    bNormal = builder.not(isZero(bExponent)),
    aMantissa = [...a.slice(0, 23), aNormal],
    bMantissa = [...b.slice(0, 23), bNormal];
  // Exact unsigned24x24 product. Later rows cannot affect the already-final
  // low bits; the high unoccupied column receives the final carry directly.
  let product = [
    ...aMantissa.map((bit) => builder.and(bit, bMantissa[0])),
    ...Array<Wire>(24).fill(zero),
  ];
  for (let row = 1; row < 24; row++) {
    const next = [...product];
    let carry = zero;
    for (let column = 0; column < 24; column++) {
      const index = row + column,
        partial = builder.and(aMantissa[column], bMantissa[row]),
        propagate = builder.xor(product[index], partial);
      next[index] = column === 0 ? propagate : builder.xor(propagate, carry);
      carry =
        column === 0
          ? builder.and(product[index], partial)
          : builder.xor(
              builder.and(product[index], partial),
              builder.and(propagate, carry),
            );
    }
    next[row + 24] = carry;
    product = next;
  }
  const effective = (exponent: Word, normal: Wire) => [
    ...builder.muxWord(normal, exponent, [one, ...Array<Wire>(7).fill(zero)]),
    zero,
    zero,
  ];
  let exponent = addCarry(
    effective(aExponent, aNormal),
    effective(bExponent, bNormal),
    zero,
  );
  exponent = addCarry(exponent, builder.constantWord(898n, 10), zero); // signed10: -126
  // Normalize an exact48bit product to bit47. Six fixed public barrel stages
  // also handle subnormal inputs; signed exponent range stays within10bits.
  for (const distance of [32, 16, 8, 4, 2, 1]) {
    const shift = isZero(product.slice(48 - distance)),
      left = [
        ...Array<Wire>(distance).fill(zero),
        ...product.slice(0, 48 - distance),
      ];
    product = product.map((bit, index) => builder.mux(shift, left[index], bit));
    exponent = subtractPowerIf(exponent, Math.log2(distance), shift);
  }
  const underflow = or(exponent[9], isZero(exponent)),
    distance = addCarry(
      exponent.map((bit) => builder.not(bit)),
      builder.constantWord(1n, 10),
      one,
    ); //1-exponent
  let shifted = [...product];
  for (let stage = 0; stage < 10; stage++) {
    const amount = 2 ** stage,
      sticky = any(shifted.slice(0, Math.min(48, amount + 1))),
      right = shifted.map((_, index) =>
        index === 0 ? sticky : (shifted[index + amount] ?? zero),
      );
    shifted = shifted.map((bit, index) =>
      builder.mux(distance[stage], right[index], bit),
    );
  }
  product = product.map((bit, index) =>
    builder.mux(underflow, shifted[index], bit),
  );
  exponent = builder.muxWord(underflow, builder.constantWord(1n, 10), exponent);
  const roundUp = builder.and(
      product[23],
      any([...product.slice(0, 23), product[24]]),
    ),
    rounded = increment([...product.slice(24), zero], roundUp),
    carry = rounded[24];
  const mantissa = builder.muxWord(
    carry,
    rounded.slice(1),
    rounded.slice(0, 24),
  );
  exponent = increment(exponent, carry);
  const overflow = or(exponent[8], all(exponent.slice(0, 8))),
    resultExponent = builder.muxWord(
      mantissa[23],
      exponent.slice(0, 8),
      Array<Wire>(8).fill(zero),
    ),
    sign = builder.xor(a[31], b[31]),
    infinity = [
      ...Array<Wire>(23).fill(zero),
      ...Array<Wire>(8).fill(one),
      sign,
    ];
  let result = builder.muxWord(overflow, infinity, [
    ...mantissa.slice(0, 23),
    ...resultExponent,
    sign,
  ]);
  const aAll = all(aExponent),
    bAll = all(bExponent),
    aFractionZero = isZero(a.slice(0, 23)),
    bFractionZero = isZero(b.slice(0, 23)),
    aInf = builder.and(aAll, aFractionZero),
    bInf = builder.and(bAll, bFractionZero),
    aNaN = builder.and(aAll, builder.not(aFractionZero)),
    bNaN = builder.and(bAll, builder.not(bFractionZero)),
    aZero = isZero(a.slice(0, 31)),
    bZero = isZero(b.slice(0, 31));
  result = builder.muxWord(or(aInf, bInf), infinity, result);
  const invalid = or(builder.and(aInf, bZero), builder.and(bInf, aZero)),
    nan = or(or(aNaN, bNaN), invalid);
  return builder.muxWord(nan, builder.constantWord(0x7fc00000n, 32), result);
}
