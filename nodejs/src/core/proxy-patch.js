'use strict';

const dns = require('dns');
const https = require('https');
const path = require('path');

const OA2_NS = encodeURIComponent('http://www.amazon.com/ap/ext/oauth/2');
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(['8.8.8.8', '1.1.1.1']);

let patched = false;

/**
 * Resolves hostnames via OS `dns.lookup` first and falls back to public DNS
 * (`8.8.8.8` / `1.1.1.1`) when Bionic `getaddrinfo` fails on Android.
 * @param {string} hostname
 * @param {object|function} options
 * @param {function} [callback]
 */
function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = options && typeof options === 'object' ? options : {};
  dns.lookup(hostname, opts, (err, address, family) => {
    if (!err) {
      return callback(null, address, family);
    }
    const use6 = opts.family === 6;
    const method = use6 ? 'resolve6' : 'resolve4';
    fallbackResolver[method](hostname, (e2, addrs) => {
      if (e2 || !Array.isArray(addrs) || addrs.length === 0) {
        return callback(err);
      }
      const fam = use6 ? 6 : 4;
      if (opts.all) {
        return callback(null, addrs.map((a) => ({ address: a, family: fam })));
      }
      return callback(null, addrs[0], fam);
    });
  });
}

const upstreamAgent = new https.Agent({
  keepAlive: false,
  lookup: patchedLookup,
  timeout: 30000,
});

/**
 * Patches `http-proxy-middleware` used by `alexa-cookie2` so `openid.ns.oa2`
 * is encoded properly on `/ap/signin?` redirects (alexa-cookie Issue #224),
 * disables upstream keep-alive, and injects `patchedLookup`.
 * Idempotent: subsequent calls return `true` without re-wrapping.
 * @returns {boolean}
 */
function applyProxyPatch() {
  if (patched) return true;
  https.globalAgent = upstreamAgent;
  try {
    const cookiePkgDir = path.dirname(require.resolve('alexa-cookie2/package.json'));
    const hpmPath = require.resolve('http-proxy-middleware', {
      paths: [path.join(cookiePkgDir, 'lib'), cookiePkgDir],
    });
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const hpm = require(hpmPath);
    const origCreate = hpm.createProxyMiddleware;
    hpm.createProxyMiddleware = (ctx, o) => {
      const targetOpts = typeof ctx === 'object' && !o ? ctx : o;
      if (targetOpts && typeof targetOpts === 'object') {
        if (!targetOpts.agent) {
          targetOpts.agent = upstreamAgent;
        }
        if (!targetOpts.proxyTimeout) {
          targetOpts.proxyTimeout = 60000;
        }
        if (typeof targetOpts.pathRewrite === 'function') {
          const pr = targetOpts.pathRewrite;
          targetOpts.pathRewrite = (p, req) => {
            let out = pr(p, req);
            if (typeof out === 'string' && out.startsWith('/ap/signin?') && /[?&]openid\.ns\.oa2=/.test(out)) {
              out = out.replace(/([?&]openid\.ns\.oa2=)[^&]*/, `$1${OA2_NS}`);
            }
            return out;
          };
        }
      }
      return origCreate(ctx, o);
    };
    patched = true;
    return true;
  } catch (e) {
    console.warn('[Patch] http-proxy-middleware hook skipped or failed:', e.message);
    return false;
  }
}

module.exports = {
  applyProxyPatch,
  patchedLookup,
  upstreamAgent,
};
