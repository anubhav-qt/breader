import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal, unseal } from '../seal.ts';

/* The sealed NVIDIA key (seal.ts), with a made-up key and tokens. */

test('a sealed key opens with its token, and with no other', () => {
  const token = 'a'.repeat(40);
  const sealed = seal('nvapi-test', token);
  assert.equal(unseal(sealed, token), 'nvapi-test');
  assert.ok(!sealed.includes('nvapi'));
  assert.notEqual(seal('nvapi-test', token), sealed, 'sealed afresh every time');
  assert.throws(() => unseal(sealed, 'b'.repeat(40)));
});
