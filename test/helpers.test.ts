import { describe, expect, it } from 'vitest';
import { clip } from '../src/lookup.js';
import { atomicFromValue } from '../src/money.js';

describe('clip', () => {
  it('keeps text whose length equals the limit', () => {
    expect(clip('abc', 3)).toBe('abc');
  });

  it('truncates text one past the limit and marks it', () => {
    expect(clip('abcd', 3)).toBe('abc... (truncated)');
  });

  it('keeps the empty string at a zero limit', () => {
    expect(clip('', 0)).toBe('');
  });
});

describe('atomicFromValue', () => {
  it('parses a digit string or an integer number', () => {
    expect(atomicFromValue('10000')).toBe(10000n);
    expect(atomicFromValue(10000)).toBe(10000n);
  });

  it('parses zero', () => {
    expect(atomicFromValue('0')).toBe(0n);
  });

  it('keeps every digit of a value past Number.MAX_SAFE_INTEGER', () => {
    expect(atomicFromValue('12345678901234567890')).toBe(12345678901234567890n);
  });

  it.each([
    ['negative string', '-1'],
    ['decimal string', '1.5'],
    ['exponent string', '1e3'],
    ['leading space', ' 5'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['bigint', 10n],
    ['object', {}],
    ['fractional number', 1.5],
  ])('refuses a %s', (_label, raw) => {
    expect(atomicFromValue(raw)).toBeNull();
  });
});
