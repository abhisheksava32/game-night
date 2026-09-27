// Builds site/games/ballpark/questions.js from test/ballpark.questions.json.
// Answers are base64-encoded so they don't show up in a quick look at the page source.
import { readFileSync, writeFileSync } from 'node:fs';

const questions = JSON.parse(readFileSync(new URL('./ballpark.questions.json', import.meta.url)));
for (const q of questions) {
  if (!q.q || !Number.isFinite(q.a) || !q.f) throw new Error('bad question: ' + JSON.stringify(q));
}
const b64 = Buffer.from(JSON.stringify(questions), 'utf8').toString('base64');
const js = `// Ballpark question bank (${questions.length} questions).\n` +
  `const DATA = '${b64}';\n` +
  `export const QUESTIONS = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(DATA), (c) => c.charCodeAt(0))));\n`;
writeFileSync(new URL('../site/games/ballpark/questions.js', import.meta.url), js);
console.log('wrote', questions.length, 'questions');
