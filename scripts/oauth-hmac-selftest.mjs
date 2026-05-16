// Unit-style self-test for verifyOAuthHmac (hex query-param algorithm).
// Run: node scripts/oauth-hmac-selftest.mjs
import crypto from 'node:crypto';
import { verifyOAuthHmac, buildInstallUrl, isValidShop } from '../src/shopifyOAuth.js';

const SECRET = 'shpss_test_secret_123';

// Craft a realistic Shopify callback query (values are percent-decoded,
// exactly what Express puts in req.query).
const baseQuery = {
  code: 'abc123def456',
  host: 'Zm9yLXlvdS1zaG9lLTYxMjkubXlzaG9waWZ5LmNvbS9hZG1pbg',
  shop: 'for-you-shoe-6129.myshopify.com',
  state: 'a1b2c3d4e5f6',
  timestamp: '1737000000',
};

// Compute the expected hex HMAC the documented way: every param except
// hmac/signature, sorted by key, joined "k=v" with "&".
function expectedHmac(query, secret) {
  const pairs = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .map((k) => `${k}=${query[k]}`)
    .sort();
  return crypto
    .createHmac('sha256', secret)
    .update(pairs.join('&'), 'utf8')
    .digest('hex');
}

const goodHmac = expectedHmac(baseQuery, SECRET);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
};

// 1. Valid HMAC -> true
check(
  'valid hmac accepted',
  verifyOAuthHmac({ ...baseQuery, hmac: goodHmac }, SECRET) === true
);

// 2. Tampered shop param -> false
check(
  'tampered shop rejected',
  verifyOAuthHmac(
    { ...baseQuery, shop: 'evil.myshopify.com', hmac: goodHmac },
    SECRET
  ) === false
);

// 3. Tampered hmac value -> false
check(
  'tampered hmac rejected',
  verifyOAuthHmac(
    { ...baseQuery, hmac: goodHmac.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) },
    SECRET
  ) === false
);

// 4. Wrong secret -> false
check(
  'wrong secret rejected',
  verifyOAuthHmac({ ...baseQuery, hmac: goodHmac }, 'wrong_secret') === false
);

// 5. Missing hmac -> false
check('missing hmac rejected', verifyOAuthHmac(baseQuery, SECRET) === false);

// 6. signature param is ignored in the digest (still valid)
check(
  'signature param ignored',
  verifyOAuthHmac(
    { ...baseQuery, signature: 'xx', hmac: goodHmac },
    SECRET
  ) === true
);

// 7. shop regex
check(
  'isValidShop accepts real shop',
  isValidShop('for-you-shoe-6129.myshopify.com') === true
);
check(
  'isValidShop rejects bad shop',
  isValidShop('for-you-shoe-6129.myshopify.com.evil.com') === false
);

// 8. buildInstallUrl shape (offline => no grant_options[])
const url = buildInstallUrl({
  shop: 'for-you-shoe-6129.myshopify.com',
  redirectUri: 'https://example.trycloudflare.com/auth/callback',
  state: 'nonce123',
});
check('install url has authorize path', url.includes('/admin/oauth/authorize?'));
check('install url has scopes', url.includes('scope=read_orders%2Cread_products'));
check('install url has NO grant_options', !url.includes('grant_options'));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  expected hex hmac (first 16): ${goodHmac.slice(0, 16)}…`);
process.exit(fail === 0 ? 0 : 1);
