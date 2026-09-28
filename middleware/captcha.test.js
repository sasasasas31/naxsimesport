const test = require('node:test');
const assert = require('node:assert/strict');
const svgCaptcha = require('svg-captcha');

test('CAPTCHA uses uppercase letters and digits only, without case-sensitive answers', () => {
  const charPreset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const challenge = svgCaptcha.create({ size: 5, charPreset });
    assert.match(challenge.text, /^[A-Z2-9]{5}$/);
    assert.equal(challenge.text.toLowerCase().toUpperCase(), challenge.text);
  }
});