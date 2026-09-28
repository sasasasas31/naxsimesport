const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, filterMessage } = require('./filters');

test('cleanText removes tags, control characters, and enforces a limit', () => {
  assert.equal(cleanText(' hi\u0000 <b>there</b> ', 20), 'hi there');
  assert.equal(cleanText('abcdefgh', 4), 'abcd');
});

test('filterMessage rejects links and empty messages', () => {
  assert.match(filterMessage('see https://example.com').error, /bağlantı/);
  assert.match(filterMessage('  ').error, /boş/);
});

test('filterMessage censors a configured profanity without damaging other words', () => {
  assert.equal(filterMessage('selam amk oyuncu').text, 'selam ••• oyuncu');
  assert.equal(filterMessage('oyun başlıyor').text, 'oyun başlıyor');
});