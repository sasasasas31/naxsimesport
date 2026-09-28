const test = require('node:test');
const assert = require('node:assert/strict');
const { entryGuard, inspectEntry } = require('./entryGuard');

function request(headers, method = 'GET') {
  return { method, get: (name) => headers[name.toLowerCase()] || '' };
}

test('reads a referral hostname for this request without persisting it', () => {
  const req = request({ accept: 'text/html', referer: 'https://community.example/path', 'user-agent': 'Mozilla/5.0 Chrome/120' });
  const entry = inspectEntry(req);
  assert.equal(entry.sourceHost, 'community.example');
  assert.equal(entry.isAutomated, false);
  assert.equal(Object.hasOwn(req, 'entrySource'), false);
});

test('allows direct human navigation and does not classify API requests as page bots', () => {
  assert.equal(inspectEntry(request({ accept: 'text/html', 'user-agent': 'Mozilla/5.0 Chrome/120' })).isAutomated, false);
  assert.equal(inspectEntry(request({ accept: 'application/json', 'user-agent': 'curl/8.0' })).isAutomated, false);
});

test('flags obvious automation only on HTML document navigations', () => {
  const entry = inspectEntry(request({ accept: 'text/html', referer: 'https://external.example', 'user-agent': 'HeadlessChrome/122.0' }));
  assert.equal(entry.sourceHost, 'external.example');
  assert.equal(entry.isAutomated, true);
});

test('malformed referrers do not throw or classify normal visitors as bots', () => {
  const entry = inspectEntry(request({ accept: 'text/html', referer: 'not a url', 'user-agent': 'Mozilla/5.0' }));
  assert.equal(entry.sourceHost, 'invalid');
  assert.equal(entry.isAutomated, false);
});

test('redirects automation to the internal block page and normal subpages to the app root', () => {
  const response = { destination: null, redirect(status, destination) { this.destination = destination; } };
  const automatedRequest = { ...request({ accept: 'text/html', 'user-agent': 'curl/8.0' }), path: '/dashboard' };
  entryGuard(automatedRequest, response, () => assert.fail('automated request must be redirected'));
  assert.equal(response.destination, '/blocked');

  response.destination = null;
  const browserRequest = { ...request({ accept: 'text/html', referer: 'https://social.example/post', 'user-agent': 'Mozilla/5.0 Chrome/120' }), path: '/dashboard' };
  entryGuard(browserRequest, response, () => assert.fail('subpage navigation should be redirected to the SPA root'));
  assert.equal(response.destination, '/');
  assert.equal(browserRequest.entrySource, 'social.example');
});

test('does not redirect static/API requests and only allows filtered agents to view the block page', () => {
  const response = { destination: null, redirect(status, destination) { this.destination = destination; } };
  for (const req of [
    { ...request({ accept: 'text/css', 'user-agent': 'curl/8.0' }), path: '/style.css' },
    { ...request({ accept: 'application/json', 'user-agent': 'curl/8.0' }), path: '/api/health' }
  ]) entryGuard(req, response, () => {});
  assert.equal(response.destination, null);

  const humanRequest = { ...request({ accept: 'text/html', 'user-agent': 'Mozilla/5.0' }), path: '/blocked.html' };
  entryGuard(humanRequest, response, () => assert.fail('normal visitors must not access the block page'));
  assert.equal(response.destination, '/');

  response.destination = null;
  const automatedRequest = { ...request({ accept: 'text/html', 'user-agent': 'curl/8.0' }), path: '/blocked' };
  entryGuard(automatedRequest, response, () => {});
  assert.equal(response.destination, null);
});