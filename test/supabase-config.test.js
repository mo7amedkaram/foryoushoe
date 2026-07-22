import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSupabaseConfig } from '../src/supabase.js';

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

test('accepts only a service-role key for the same Supabase project URL', () => {
  const valid = validateSupabaseConfig({
    url: 'https://correctref.supabase.co',
    serviceRoleKey: jwt({ ref: 'correctref', role: 'service_role' }),
  });
  const wrongProject = validateSupabaseConfig({
    url: 'https://correctref.supabase.co',
    serviceRoleKey: jwt({ ref: 'anotherref', role: 'service_role' }),
  });
  const anon = validateSupabaseConfig({
    url: 'https://correctref.supabase.co',
    serviceRoleKey: jwt({ ref: 'correctref', role: 'anon' }),
  });

  assert.equal(valid.valid, true);
  assert.equal(wrongProject.code, 'PROJECT_REF_MISMATCH');
  assert.equal(anon.code, 'KEY_IS_NOT_SERVICE_ROLE');
});
