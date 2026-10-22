import { chmodSync } from 'node:fs';

for (const bin of [
  'dist-server/server/main.js',
  'dist-server/server/set-password.js',
  'dist-server/cli/main.js',
]) {
  chmodSync(bin, 0o755);
}
