// Pure VLESS URI helpers shared by the QR page (app.js) and its unit tests.
// Loaded as a plain <script> in the browser (exposes window.Vless) and with
// require() under node --test.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Vless = api;
  }
})(globalThis, function () {
  'use strict';

  /** Connect addresses offered in the dropdown, as host:port. */
  const TARGETS = Object.freeze({
    vina0d: Object.freeze({ name: 'Vina0D', authority: 'vina.std.io.vn:443' }),
    tiktok: Object.freeze({ name: 'Tiktok', authority: 'api24-normal-alisg.tiktokv.com:443' }),
  });

  const SCHEME = 'vless://';

  /** host:port, where host is a name, IPv4 or a bracketed IPv6 address. */
  const AUTHORITY_RE = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/?#@\s]+):(\d{1,5})$/;

  /** Port assumed when a custom address has none, by URL scheme. */
  const DEFAULT_PORTS = Object.freeze({ http: 80, ws: 80 });
  const FALLBACK_PORT = 443;
  /**
   * @typedef {Object} ParsedVless
   * @property {true} ok
   * @property {string} source    The URI exactly as it was entered.
   * @property {string} userInfo  The part before '@' (the client UUID).
   * @property {string} authority host:port the client connects to.
   * @property {string} tail      Path and query, up to the last '#'.
   * @property {string} label     Decoded text after the last '#'.
   */

  /**
   * @typedef {Object} ParseError
   * @property {false} ok
   * @property {string} source
   * @property {string} code
   * @property {string} message
   */

  /**
   * Splits free text into URI candidates. URIs never contain raw whitespace,
   * so any run of whitespace separates two of them.
   * @param {string} text
   * @returns {string[]}
   */
  function splitUris(text) {
    return text.split(/\s+/).filter((token) => token.length > 0);
  }

  /**
   * Decodes a percent-encoded label, keeping it as typed when it is malformed.
   * @param {string} raw
   * @returns {string}
   */
  function decodeLabel(raw) {
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  }

  /**
   * @param {string} source
   * @param {string} code
   * @param {string} message
   * @returns {ParseError}
   */
  function fail(source, code, message) {
    return { ok: false, source, code, message };
  }

  /**
   * Splits a vless:// URI into the pieces the page rewrites.
   * @param {string} source
   * @returns {ParsedVless | ParseError}
   */
  function parseVlessUri(source) {
    if (!source.toLowerCase().startsWith(SCHEME)) {
      return fail(source, 'ERR_NOT_VLESS', 'Not a vless:// URI.');
    }
    const hashAt = source.lastIndexOf('#');
    const body = hashAt === -1 ? source.slice(SCHEME.length) : source.slice(SCHEME.length, hashAt);
    const label = hashAt === -1 ? '' : decodeLabel(source.slice(hashAt + 1));

    const authorityEnd = body.search(/[/?]/);
    const userAndHost = authorityEnd === -1 ? body : body.slice(0, authorityEnd);
    const tail = authorityEnd === -1 ? '' : body.slice(authorityEnd);

    const atIndex = userAndHost.lastIndexOf('@');
    if (atIndex <= 0) {
      return fail(source, 'ERR_NO_USER_ID', 'Missing the client ID before "@".');
    }
    const authority = userAndHost.slice(atIndex + 1);
    if (!AUTHORITY_RE.test(authority)) {
      return fail(source, 'ERR_BAD_ADDRESS', 'Expected host:port after "@".');
    }
    return { ok: true, source, userInfo: userAndHost.slice(0, atIndex), authority, tail, label };
  }

  /** Query keys replaced by withTls(); any existing values are dropped. */
  const TLS_KEYS = Object.freeze(['security', 'alpn', 'sni']);

  /**
   * Returns the host of a host:port authority, without IPv6 brackets.
   * @param {string} authority
   * @returns {string}
   */
  function hostOf(authority) {
    const host = authority.slice(0, authority.lastIndexOf(':'));
    return host.startsWith('[') ? host.slice(1, -1) : host;
  }

  /**
   * @param {string} pair A raw `key=value` query pair.
   * @returns {string} Its key, lowercased, for comparisons.
   */
  function keyOf(pair) {
    return pair.split('=', 1)[0].toLowerCase();
  }

  /**
   * Rebuilds a URI tail (path + query) so no parameter appears twice: for a
   * repeated key (compared case-insensitively) only the first occurrence is
   * kept, the one URLSearchParams.get() would read. With an `sni`, any
   * security, alpn and sni parameters are dropped and
   * `security=tls&alpn=h3%2C%20h2&sni=<sni>` is inserted right after
   * encryption=, or at the end of the query when there is no encryption=.
   * Kept parameters keep their order and encoding.
   * @param {string} tail
   * @param {string | null} sni
   * @returns {string}
   */
  function buildTail(tail, sni) {
    const queryAt = tail.indexOf('?');
    if (queryAt === -1 && sni === null) return tail;
    const path = queryAt === -1 ? tail : tail.slice(0, queryAt);
    const query = queryAt === -1 ? '' : tail.slice(queryAt + 1);

    const seen = new Set();
    const params = query.split('&').filter((pair) => {
      const key = keyOf(pair);
      if (pair === '' || seen.has(key) || (sni !== null && TLS_KEYS.includes(key))) return false;
      seen.add(key);
      return true;
    });
    if (sni !== null) {
      const tlsParams = ['security=tls', 'alpn=h3%2C%20h2', 'sni=' + encodeURIComponent(sni)];
      const encryptionAt = params.findIndex((pair) => keyOf(pair) === 'encryption');
      params.splice(encryptionAt === -1 ? params.length : encryptionAt + 1, 0, ...tlsParams);
    }
    return params.length === 0 ? path : path + '?' + params.join('&');
  }

  /**
   * Reassembles a URI, optionally with another connect address, label and TLS.
   * Duplicate query parameters are always removed (see buildTail); host= is
   * kept as is. With `tls`, the SNI is the host of the original address,
   * before any swap: the server's own certificate name.
   * @param {ParsedVless} parsed
   * @param {{authority?: string, label?: string, tls?: boolean}} [overrides]
   * @returns {string}
   */
  function buildVlessUri(parsed, overrides = {}) {
    const authority = overrides.authority || parsed.authority;
    const label = overrides.label !== undefined ? overrides.label : parsed.label;
    const tail = buildTail(parsed.tail, overrides.tls ? hostOf(parsed.authority) : null);
    const fragment = label === '' ? '' : '#' + encodeURIComponent(label);
    return SCHEME + parsed.userInfo + '@' + authority + tail + fragment;
  }

  /**
   * Reduces a user-typed address to host:port. Accepts a bare host, host:port
   * or a full URL; a missing port defaults to 80 for http/ws and 443 otherwise.
   * @param {string} input
   * @returns {{ok: true, authority: string} | {ok: false, code: string, message: string}}
   */
  function normalizeAuthority(input) {
    let rest = input.trim();
    if (rest === '') {
      return { ok: false, code: 'ERR_ADDRESS_EMPTY', message: 'Enter a host or URL.' };
    }
    let scheme = '';
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      rest = rest.slice(schemeMatch[0].length);
    }
    // Drop any path, query or fragment, then any user info.
    rest = rest.replace(/[/?#].*$/, '');
    rest = rest.slice(rest.lastIndexOf('@') + 1).toLowerCase();

    const hasPort = /^\[[^\]]*\]:\d+$/.test(rest) || /^[^:[\]]+:\d+$/.test(rest);
    const authority = hasPort ? rest : `${rest}:${DEFAULT_PORTS[scheme] || FALLBACK_PORT}`;
    const match = AUTHORITY_RE.exec(authority);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) {
      return { ok: false, code: 'ERR_BAD_ADDRESS', message: 'Expected host, host:port or a URL.' };
    }
    return { ok: true, authority };
  }

  /**
   * Turns a label into a safe file name for the saved QR image.
   * @param {string} label
   * @returns {string}
   */
  function toFileName(label) {
    const cleaned = label.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '');
    return (cleaned || 'vless') + '.png';
  }

  return { TARGETS, splitUris, parseVlessUri, buildVlessUri, normalizeAuthority, toFileName };
});
