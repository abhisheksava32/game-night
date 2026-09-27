// Runs every browser test one after another. Usage: node run-e2e.mjs [siteUrl]
import { spawnSync } from 'node:child_process';

const site = (process.argv[2] || 'http://localhost:8766/').replace(/\/?$/, '/');
const suites = [
  ['ballpark.e2e.mjs', site + 'games/ballpark/'],
  ['ballpark.resilience.mjs', site + 'games/ballpark/'],
  ['ttt.e2e.mjs', site],
  ['chess.e2e.mjs', site],
  ['ludo.e2e.mjs', site],
  ['snake.e2e.mjs', site],
];
const failed = [];
for (const [file, url] of suites) {
  console.log(`\n=== ${file}`);
  const r = spawnSync(process.execPath, [file, url], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(file);
}
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nALL BROWSER TESTS PASSED');
process.exitCode = failed.length ? 1 : 0;
