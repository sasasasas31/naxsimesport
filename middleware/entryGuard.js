const automatedAgent = /(?:^|[\s(;])(?:curl|wget|python-requests|python-urllib|scrapy|selenium|playwright|puppeteer|phantomjs|headlesschrome|httpclient|go-http-client|libwww-perl)(?:[/\s);]|$)/i;

function inspectEntry(req) {
  const accept = req.get('accept') || '';
  const isDocumentNavigation = req.method === 'GET' && accept.includes('text/html');
  const userAgent = req.get('user-agent') || '';
  let sourceHost = null;
  const referrer = req.get('referer');
  if (referrer) {
    try { sourceHost = new URL(referrer).hostname.toLowerCase(); } catch { sourceHost = 'invalid'; }
  }
  return {
    isDocumentNavigation,
    sourceHost,
    isAutomated: isDocumentNavigation && automatedAgent.test(userAgent)
  };
}

function entryGuard(req, res, next) {
  const entry = inspectEntry(req);
  if (!entry.isDocumentNavigation) return next();

  req.entrySource = entry.sourceHost;
  if (req.path === '/banned.html') return next();
  if (req.path === '/blocked' || req.path === '/blocked.html') {
    if (entry.isAutomated) return next();
    return res.redirect(302, '/');
  }
  if (entry.isAutomated) return res.redirect(302, '/blocked');
  if (req.path !== '/') return res.redirect(302, '/');
  next();
}

module.exports = { entryGuard, inspectEntry };