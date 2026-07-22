// Safe regression runner for the order/inquiry delivery path.
//
// The previous script called the production API with a real customer phone
// and could itself create the delayed/duplicate messages it was intended to
// diagnose. These tests use deterministic fakes and never access Meta's API.
import { spawn } from 'node:child_process';

const files = [
  'test/inquiry-flow.test.js',
  'test/shopify-line-items.test.js',
  'test/meta-send-once.test.js',
  'test/supabase-config.test.js',
];

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`test process terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
