import test from 'node:test';
import assert from 'node:assert/strict';
import { permuteDexNumber } from '../js/permute.js';

test('1 merges three- and four-digit padding', () => {
  assert.deepEqual(permuteDexNumber(1), [1, 10, 100, 1000]);
});

test('1025 preserves all digits and filters permutations above the limit', () => {
  assert.deepEqual(permuteDexNumber(1025), [125, 152, 215, 251, 512, 521, 1025]);
});

test('100 handles repeated digits without duplicates', () => {
  assert.deepEqual(permuteDexNumber(100), [1, 10, 100, 1000]);
});

test('rejects non-numbers and non-integers without coercion', () => {
  for (const value of ['1', '', 'abc', null, undefined, true, false, {}, [], NaN, Infinity, -Infinity, 1.5]) {
    assert.throws(() => permuteDexNumber(value), TypeError);
  }
});

test('rejects out-of-range integers', () => {
  for (const value of [0, -1, 1026, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => permuteDexNumber(value), RangeError);
  }
});

test('every supported input matches an independent digit-signature oracle', () => {
  const signature = (number, width) => String(number).padStart(width, '0').split('').sort().join('');
  const signatures = [null, ...Array.from({ length: 1025 }, (_, index) =>
    [signature(index + 1, 3), signature(index + 1, 4)])];
  for (let input = 1; input <= 1025; input += 1) {
    const expected = [];
    for (let candidate = 1; candidate <= 1025; candidate += 1) {
      if (signatures[input][0] === signatures[candidate][0] || signatures[input][1] === signatures[candidate][1]) expected.push(candidate);
    }
    assert.deepEqual(permuteDexNumber(input), expected, `input ${input}`);
  }
});
