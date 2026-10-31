import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const files = ['src', 'scripts', 'ops', 'test', 'web/src', 'web/scripts', 'web/test']
  .flatMap((dir) => walk(dir))
  .filter((path) => /\.(?:js|mjs)$/.test(path));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax OK: ${files.length} files`);
