import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, generateCode, generateHostToken, hashToken, tokenMatches } from '../src/auth.js';
import { cleanText, parseCode } from '../src/validate.js';

test('code alphabet has 31 characters and no lookalikes', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const ch of '0O1IL') assert.ok(!CODE_ALPHABET.includes(ch), `${ch} should be excluded`);
});

test('generated codes are 6 characters from the alphabet', () => {
  for (let i = 0; i < 1000; i += 1) {
    const code = generateCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  }
});

test('host tokens are 32 random bytes and hash to 32 bytes', () => {
  const token = generateHostToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(token, generateHostToken());
  assert.equal(hashToken(token).length, 32);
});

test('tokenMatches accepts only the right token', () => {
  const token = generateHostToken();
  const stored = hashToken(token);
  assert.equal(tokenMatches(token, stored), true);
  assert.equal(tokenMatches(generateHostToken(), stored), false);
  assert.equal(tokenMatches('', stored), false);
  assert.equal(tokenMatches(undefined, stored), false);
});

test('parseCode uppercases and rejects invalid codes', () => {
  assert.equal(parseCode(' abc234 '), 'ABC234');
  assert.equal(parseCode('ABC12O'), null);
  assert.equal(parseCode('ABC23'), null);
  assert.equal(parseCode(42), null);
});

test('cleanText trims, enforces limits and handles optional fields', () => {
  assert.equal(cleanText('  Hi  ', { field: 't', max: 5, required: true }), 'Hi');
  assert.equal(cleanText('   ', { field: 't', max: 5, required: false }), null);
  assert.throws(() => cleanText('   ', { field: 't', max: 5, required: true }), { status: 400 });
  assert.throws(() => cleanText('toolong', { field: 't', max: 5, required: true }), { status: 400 });
  assert.throws(() => cleanText(123, { field: 't', max: 5, required: true }), { status: 400 });
  // Emoji count as one character each, like the database counts them.
  assert.equal(cleanText('😀😀😀', { field: 't', max: 3, required: true }), '😀😀😀');
});
