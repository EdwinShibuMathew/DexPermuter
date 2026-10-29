export const MIN_DEX = 1;
export const MAX_DEX = 1025;

/** Validate without coercing strings, booleans, or fractional numbers. */
export function validateDexNumber(input) {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    throw new TypeError('Enter a whole number from 1 to 1025.');
  }
  if (input < MIN_DEX || input > MAX_DEX) {
    throw new RangeError('Enter a number from 1 to 1025.');
  }
  return input;
}

function distinctPermutations(digits) {
  if (digits.length === 0) return [''];
  const permutations = [];
  const used = new Set();
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits[index];
    if (used.has(digit)) continue;
    used.add(digit);
    const rest = digits.slice(0, index) + digits.slice(index + 1);
    for (const suffix of distinctPermutations(rest)) {
      permutations.push(digit + suffix);
    }
  }
  return permutations;
}

/** Return the sorted union of valid 3- and 4-character padded permutations. */
export function permuteDexNumber(input) {
  validateDexNumber(input);
  const results = new Set();
  for (const width of [3, 4]) {
    for (const permutation of distinctPermutations(String(input).padStart(width, '0'))) {
      const number = Number(permutation);
      if (number >= MIN_DEX && number <= MAX_DEX) results.add(number);
    }
  }
  return [...results].sort((a, b) => a - b);
}
