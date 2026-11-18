const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require.resolve('../src/features/chat/topicEmoji.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const actual = {};
new Function('exports', code)(actual);

test('keyboard emoji beyond the former grid are accepted whole', () => {
  for (const value of ['🦦', '🧑🏽‍💻', '👨‍👩‍👧‍👦', '🇻🇳', '1️⃣', '❤️', '🏳️‍🌈', '👍🏿', ' 🪷 ']) {
    assert.equal(actual.isTopicEmoji(value), true, value);
  }
});

test('invalid or multiple graphemes cannot be saved as a topic icon', () => {
  for (const value of ['', ' ', 'abc', 'A', '1', '12', '💬🔥', '🦦 text', 'text 🦦', '🇻🇳🇺🇸']) {
    assert.equal(actual.isTopicEmoji(value), false, value);
  }
});
