/**
 * The `pm` bridge, evaluated once inside the QuickJS sandbox before any user
 * script. It receives the phase state as a JSON string in the global
 * `__FFWD_STATE` and records everything the script does into `__f`, which the
 * worker reads back with `__f.collect()`. Nothing here touches the host: the
 * only host function is `__ffwdCrypto(op, a, b, mode)` (see worker.ts).
 *
 * Implemented as plain ES5-flavoured JS (QuickJS supports more, but user
 * scripts are often old Postman code — keep the bridge conservative).
 * No backticks in this string: it is a TS template literal.
 */

export const PRELUDE = String.raw`
var __f = (function () {
  var S = JSON.parse(__FFWD_STATE);

  var VAR_VALUE_CAP = 64 * 1024;
  var HEADER_CAP = 8 * 1024;
  var BODY_CAP = 1024 * 1024;
  var URL_CAP = 8 * 1024;
  var CONSOLE_MAX_LINES = 200;
  var CONSOLE_MAX_TOTAL = 64 * 1024;
  var CONSOLE_VALUE_CAP = 4 * 1024;
  var WRITE_CAP = 100 - (S.writesAlready || 0);
  var TEST_CAP = 100;

  var F = {
    consoleLines: [],
    consoleCount: 0,
    consoleTotal: 0,
    consoleTruncated: false,
    tests: [],
    varOps: [],
    secretReads: [],
    local: {},
    timeouts: [],
    urlSetBy: null,
  };

  var blockedSecrets = {};
  var currentScriptName = "";

  function hasOwn(obj, k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  }

  // ---- console ------------------------------------------------------------
  // Values are captured capped; the host applies the final 64 KB cut and the
  // "truncated" marker. Raw values are recorded on purpose: hiding happens on
  // the way back to the browser, never in front of the script.

  function stringifyValue(v) {
    var t = typeof v;
    var out;
    if (t === "string") out = v;
    else if (t === "number" || t === "boolean" || t === "undefined" || v === null) out = String(v);
    else if (t === "function") out = "[Function" + (v.name ? ": " + v.name : "") + "]";
    else {
      try {
        var seen = [];
        out = JSON.stringify(v, function (k, val) {
          if (typeof val === "object" && val !== null) {
            if (seen.indexOf(val) >= 0) return "[Circular]";
            seen.push(val);
          }
          if (typeof val === "function") return "[Function]";
          return val;
        });
        if (out === undefined) out = String(v);
      } catch (e) {
        out = String(v);
      }
    }
    if (out.length > CONSOLE_VALUE_CAP) out = out.slice(0, CONSOLE_VALUE_CAP) + "…(truncated)";
    return out;
  }

  function noteLine(kind, args) {
    if (F.consoleCount >= CONSOLE_MAX_LINES) {
      F.consoleTruncated = true;
      return;
    }
    F.consoleCount++;
    var parts = [];
    for (var i = 0; i < args.length && i < 8; i++) parts.push(stringifyValue(args[i]));
    var prefix = kind === "error" ? "[error] " : kind === "warn" ? "[warn] " : "";
    var line = prefix + parts.join(" ");
    if (F.consoleTotal + line.length > CONSOLE_MAX_TOTAL) {
      F.consoleTruncated = true;
      return;
    }
    F.consoleTotal += line.length;
    F.consoleLines.push(line);
  }

  // ---- secrets ------------------------------------------------------------

  function findSecret(name, scope) {
    var list = S.secrets || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name && (!scope || list[i].scope === scope)) return list[i];
    }
    return null;
  }

  function recordSecretRead(entry) {
    for (var i = 0; i < F.secretReads.length; i++) {
      if (F.secretReads[i].name === entry.name && F.secretReads[i].scope === entry.scope) return;
    }
    F.secretReads.push({ name: entry.name, scope: entry.scope });
  }

  function secretBlockedNote(name) {
    if (blockedSecrets[name]) return;
    blockedSecrets[name] = true;
    noteLine("info", ["secret " + name + " not readable: scripts in this collection are untrusted (collection settings -> Trusted scripts)"]);
  }

  function secretValueFor(entry) {
    if (!S.trusted) {
      secretBlockedNote(entry.name);
      return undefined;
    }
    if (entry.value === null || entry.value === undefined) return undefined;
    recordSecretRead(entry);
    return entry.value;
  }

  // ---- variables ----------------------------------------------------------

  var colVars = {};
  var colVarOrder = [];
  (function () {
    var src = S.vars.collection || {};
    for (var k in src) if (hasOwn(src, k)) { colVars[k] = src[k]; colVarOrder.push(k); }
  })();
  var envVars = null;
  if (S.vars.environment) {
    envVars = {};
    for (var ek in S.vars.environment) if (hasOwn(S.vars.environment, ek)) envVars[ek] = S.vars.environment[ek];
  }
  var plainNames = {
    collection: (S.plainNames && S.plainNames.collection ? S.plainNames.collection.slice() : []),
    environment: (S.plainNames && S.plainNames.environment ? S.plainNames.environment.slice() : null),
  };
  var secretNamesAll = (S.secretNamesAll || []).slice();

  function plainExists(scope, name) {
    var list = scope === "environment" ? plainNames.environment : plainNames.collection;
    if (!list) return false;
    if (list.indexOf(name) >= 0) return true;
    for (var i = 0; i < F.varOps.length; i++) {
      if (F.varOps[i].kind === "var" && F.varOps[i].scope === scope && F.varOps[i].name === name) return true;
    }
    return false;
  }

  function secretExistsIn(scope, name) {
    return !!findSecret(name, scope);
  }

  function matchesAnySecretValue(value) {
    var list = S.secrets || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i].value;
      if (!S.trusted || v === null || v === undefined || v.length < 8) continue;
      if (value.indexOf(v) >= 0) return list[i].name;
      if (value === b64(v) || value === hexOf(v) || value === encodeURIComponent(v)) return list[i].name;
    }
    return null;
  }

  function budgetCheck() {
    if (WRITE_CAP <= 0) throw new Error("variable write budget exhausted: at most 100 variable or secret writes per send");
    WRITE_CAP--;
  }

  function recordVar(kind, scope, name, value) {
    budgetCheck();
    F.varOps.push({ kind: kind, scope: scope, name: name, value: value });
  }

  function applyPlainSet(scope, name, value) {
    if (typeof name !== "string" || !name) throw new Error("variable name must be a non-empty string");
    if (typeof value !== "string") throw new Error("variable value must be a string (use JSON.stringify for objects)");
    if (value.length > VAR_VALUE_CAP) throw new Error("variable value too long: " + value.length + " chars, cap is " + VAR_VALUE_CAP);
    if (S.trusted) {
      var hit = matchesAnySecretValue(value);
      if (hit) throw new Error("refused: the value matches secret " + hit + "; store it with pm.secrets.set");
    }
    recordVar("var", scope, name, value);
    if (scope === "environment" && envVars) envVars[name] = value;
    if (scope === "collection") colVars[name] = value;
  }

  function applySecretSet(scope, name, value) {
    if (typeof name !== "string" || !name) throw new Error("secret name must be a non-empty string");
    if (typeof value !== "string") throw new Error("secret value must be a string");
    if (value.length > VAR_VALUE_CAP) throw new Error("secret value too long: " + value.length + " chars, cap is " + VAR_VALUE_CAP);
    recordVar("secret", scope, name, value);
  }

  // R4: no silent promote/demote. Writes the secret store only when a secret
  // with that exact name exists in THAT scope and no plain variable of the
  // same name exists in the same scope. Collisions are refused by name.
  function scopedPlainOrSecretSet(scope, name, value) {
    var secretHere = secretExistsIn(scope, name);
    var plainHere = plainExists(scope, name);
    if (plainHere && secretHere) {
      throw new Error("refused: both a plain variable and a secret named " + name + " exist in this scope; remove one before writing");
    }
    if (plainHere && !secretHere) {
      var elsewhere = secretNamesAll.indexOf(name) >= 0;
      if (elsewhere) {
        throw new Error("refused: a plain variable named " + name + " exists in this scope and a secret of that name exists in another scope; use a different name");
      }
    }
    if (secretHere && !plainHere) applySecretSet(scope, name, value);
    else applyPlainSet(scope, name, value);
  }

  function scopeLookup(scope, name) {
    var sec = findSecret(name, scope);
    if (sec) return { secret: true, value: secretValueFor(sec) };
    if (!S.trusted) {
      // an untrusted script must not learn whether the name is a secret:
      // still no note here, only direct secret gets are worth noting
    }
    var vars = scope === "environment" ? envVars : colVars;
    if (vars && hasOwn(vars, name)) return { value: vars[name] };
    if (hasOwn(F.local, name)) return { value: F.local[name] };
    return undefined;
  }

  function localLookup(name) {
    if (hasOwn(F.local, name)) return { value: F.local[name] };
    var sec = findSecret(name, null);
    if (sec) return { secret: true, value: secretValueFor(sec) };
    if (envVars && hasOwn(envVars, name)) return { value: envVars[name] };
    if (hasOwn(colVars, name)) return { value: colVars[name] };
    return undefined;
  }

  function nameExists(name) {
    if (hasOwn(F.local, name)) return true;
    if (findSecret(name, null)) return true;
    if (envVars && hasOwn(envVars, name)) return true;
    if (hasOwn(colVars, name)) return true;
    return false;
  }

  function replaceInVars(text) {
    return String(text).replace(/\{\{([^}]+)\}\}/g, function (m, name) {
      var r = localLookup(name.trim());
      return r && r.value !== undefined ? r.value : m;
    });
  }

  // ---- base64 / hex helpers (QuickJS has no btoa/atob) ---------------------

  var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64(binaryString) {
    var out = "";
    for (var i = 0; i < binaryString.length; i += 3) {
      var b1 = binaryString.charCodeAt(i) & 0xff;
      var b2 = i + 1 < binaryString.length ? binaryString.charCodeAt(i + 1) & 0xff : NaN;
      var b3 = i + 2 < binaryString.length ? binaryString.charCodeAt(i + 2) & 0xff : NaN;
      out += B64CHARS.charAt(b1 >> 2);
      out += isNaN(b2) ? "=" : B64CHARS.charAt(((b1 & 3) << 4) | (b2 >> 4));
      out += isNaN(b2) ? "=" : B64CHARS.charAt(((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6));
      out += isNaN(b3) ? "=" : B64CHARS.charAt(b3 & 63);
    }
    return out;
  }

  function atob(b64String) {
    var clean = String(b64String).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = "";
    for (var i = 0; i < clean.length; i += 4) {
      var e1 = B64CHARS.indexOf(clean.charAt(i));
      var e2 = B64CHARS.indexOf(clean.charAt(i + 1));
      var e3 = B64CHARS.indexOf(clean.charAt(i + 2));
      var e4 = B64CHARS.indexOf(clean.charAt(i + 3));
      out += String.fromCharCode((e1 << 2) | (e2 >> 4));
      if (e3 >= 0 && clean.charAt(i + 2) !== "=") out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
      if (e4 >= 0 && clean.charAt(i + 3) !== "=") out += String.fromCharCode(((e3 & 3) << 6) | e4);
    }
    return out;
  }

  function utf8ToBinary(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var cp = s.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
        var lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = (cp - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
          i++;
        }
      }
      if (cp < 0x80) out += String.fromCharCode(cp);
      else if (cp < 0x800) out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out += String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }
  function binaryToUtf8(s) {
    var out = "";
    var i = 0;
    while (i < s.length) {
      var b1 = s.charCodeAt(i);
      var cp;
      if (b1 < 0x80) {
        cp = b1;
        i += 1;
      } else if (b1 < 0xe0) {
        cp = ((b1 & 0x1f) << 6) | (s.charCodeAt(i + 1) & 0x3f);
        i += 2;
      } else if (b1 < 0xf0) {
        cp = ((b1 & 0x0f) << 12) | ((s.charCodeAt(i + 1) & 0x3f) << 6) | (s.charCodeAt(i + 2) & 0x3f);
        i += 3;
      } else {
        cp = ((b1 & 0x07) << 18) | ((s.charCodeAt(i + 1) & 0x3f) << 12) | ((s.charCodeAt(i + 2) & 0x3f) << 6) | (s.charCodeAt(i + 3) & 0x3f);
        i += 4;
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }
  function b64OfUtf8(s) {
    return b64(utf8ToBinary(s));
  }
  function utf8FromB64(s) {
    return binaryToUtf8(atob(s));
  }
  function hexOfUtf8(s) {
    var bin = utf8ToBinary(s);
    var out = "";
    for (var i = 0; i < bin.length; i++) {
      var h = bin.charCodeAt(i).toString(16);
      out += h.length < 2 ? "0" + h : h;
    }
    return out;
  }
  function hexOf(s) {
    return hexOfUtf8(s);
  }
  function utf8FromHex(h) {
    var bin = "";
    for (var i = 0; i + 1 < h.length; i += 2) bin += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return binaryToUtf8(bin);
  }

  // ---- crypto (host functions; the sandbox has no WebCrypto) ---------------

  function cryptoArg(v, what) {
    if (v === undefined || v === null) throw new Error("pm.crypto." + what + ": argument is missing");
    var s = typeof v === "string" ? v : String(v);
    if (s.length > 1024 * 1024) throw new Error("pm.crypto." + what + ": argument too long (cap 1 MB)");
    return s;
  }

  function cryptoCall(op, a, b, mode) {
    return __ffwdCrypto(op, a, b === undefined ? "" : b, mode || "");
  }

  var pmCrypto = {
    sha256: function (text) {
      if (text && typeof text === "object" && text.__wordarray) return new WordArray(cryptoCall("sha256hexbytes", text._hex, "", "hexa"));
      return new WordArray(cryptoCall("sha256hex", cryptoArg(text, "sha256"), ""));
    },
    md5: function (text) {
      if (text && typeof text === "object" && text.__wordarray) return new WordArray(cryptoCall("md5hexbytes", text._hex, "", "hexa"));
      return new WordArray(cryptoCall("md5hex", cryptoArg(text, "md5"), ""));
    },
    hmacSha256: function (text, key) {
      var isWA = text && typeof text === "object" && text.__wordarray;
      var t = isWA ? text._hex : cryptoArg(text, "hmacSha256");
      var tMode = isWA ? "a" : "";
      var k, kMode;
      if (key && typeof key === "object" && key.__wordarray) {
        k = key._hex;
        kMode = "hexkey";
      } else {
        k = cryptoArg(key, "hmacSha256");
        kMode = "";
      }
      return new WordArray(cryptoCall("hmacsha256hex", t, k, (tMode ? "a" : "") + (kMode ? "k" : "")));
    },
    base64: function (text) {
      return b64OfUtf8(cryptoArg(text, "base64"));
    },
    randomUUID: function () {
      return cryptoCall("uuid", "", "");
    },
  };

  // ---- crypto-js shim -------------------------------------------------------

  function WordArray(hex) {
    this._hex = hex;
    this.__wordarray = true;
  }
  WordArray.prototype.toString = function (enc) {
    if (!enc || enc === CryptoJS.enc.Hex) return this._hex;
    if (enc === CryptoJS.enc.Base64) return b64(hexBytes(this._hex));
    if (enc === CryptoJS.enc.Utf8) return utf8FromHex(this._hex);
    throw new Error("unsupported encoder: use CryptoJS.enc.Hex, Base64 or Utf8");
  };
  function hexBytes(h) {
    var out = "";
    for (var i = 0; i + 1 < h.length; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return out;
  }
  function normHex(s) {
    var clean = String(s).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2) clean += "0";
    return clean.toLowerCase();
  }
  var CryptoJS = {
    SHA256: pmCrypto.sha256,
    MD5: pmCrypto.md5,
    HmacSHA256: pmCrypto.hmacSha256,
    enc: {
      Hex: {
        parse: function (s) { return new WordArray(normHex(s)); },
        stringify: function (w) { return w && w.__wordarray ? w._hex : String(w); },
      },
      Base64: {
        parse: function (s) { return new WordArray(bytesToHex(atob(String(s)))); },
        stringify: function (w) { return w && w.__wordarray ? b64(hexBytes(w._hex)) : String(w); },
      },
      Utf8: {
        parse: function (s) { return new WordArray(hexOfUtf8(String(s))); },
        stringify: function (w) { return w && w.__wordarray ? utf8FromHex(w._hex) : String(w); },
      },
    },
  };
  function bytesToHex(bin) {
    var out = "";
    for (var i = 0; i < bin.length; i++) {
      var h = (bin.charCodeAt(i) & 0xff).toString(16);
      out += h.length < 2 ? "0" + h : h;
    }
    return out;
  }

  function req(name) {
    if (name === "crypto-js") return CryptoJS;
    throw new Error("module " + String(name) + " is not available in ffwd scripts");
  }

  // ---- request -------------------------------------------------------------

  var R = S.request;

  function validateHeaderKV(key, value) {
    if (typeof key !== "string" || !key) throw new Error("header key must be a non-empty string");
    if (typeof value !== "string") throw new Error("header value must be a string");
    if (value.length > HEADER_CAP) throw new Error("header value too long: " + value.length + " chars, cap is " + HEADER_CAP);
  }

  function setUrlString(v) {
    var s = String(v);
    if (s.length > URL_CAP) throw new Error("url too long: " + s.length + " chars, cap is " + URL_CAP);
    R.url = s;
    F.urlSetBy = currentScriptName || "unknown";
  }

  function splitUrl(u) {
    var rest = u;
    var scheme = "";
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(.*)$/.exec(u);
    if (m) {
      scheme = m[1];
      rest = m[2];
    }
    var authority = "";
    if (rest.indexOf("//") === 0) {
      rest = rest.slice(2);
      var slash = rest.indexOf("/");
      var qm = rest.indexOf("?");
      var hm = rest.indexOf("#");
      var end = rest.length;
      if (slash >= 0) end = Math.min(end, slash);
      if (qm >= 0) end = Math.min(end, qm);
      if (hm >= 0) end = Math.min(end, hm);
      authority = rest.slice(0, end);
      rest = rest.slice(end);
    }
    var path = rest;
    var query = "";
    var hash = "";
    var hi = path.indexOf("#");
    if (hi >= 0) {
      hash = path.slice(hi + 1);
      path = path.slice(0, hi);
    }
    var qi = path.indexOf("?");
    if (qi >= 0) {
      query = path.slice(qi + 1);
      path = path.slice(0, qi);
    }
    return { scheme: scheme, authority: authority, path: path, query: query, hash: hash };
  }

  function buildUrl(parts) {
    var u = parts.scheme + (parts.authority ? "//" + parts.authority : "") + (parts.path || "/");
    if (parts.query) u += "?" + parts.query;
    if (parts.hash) u += "#" + parts.hash;
    return u;
  }

  function urlQueryObj() {
    var parts = splitUrl(R.url);
    var pairs = [];
    if (parts.query) {
      var segs = parts.query.split("&");
      for (var i = 0; i < segs.length; i++) {
        if (!segs[i]) continue;
        var eq = segs[i].indexOf("=");
        if (eq < 0) pairs.push({ key: segs[i], value: "" });
        else pairs.push({ key: segs[i].slice(0, eq), value: segs[i].slice(eq + 1) });
      }
    }
    return {
      get: function (name) {
        for (var i = 0; i < pairs.length; i++) if (pairs[i].key === name) return pairs[i].value;
        return null;
      },
      add: function (p) {
        if (!p || typeof p.key !== "string" || !p.key) throw new Error("query param key must be a non-empty string");
        var v = typeof p.value === "string" ? p.value : String(p.value);
        if (v.length > HEADER_CAP) throw new Error("query param value too long: cap is " + HEADER_CAP);
        pairs.push({ key: p.key, value: v });
        flush();
      },
      remove: function (name) {
        var next = [];
        for (var i = 0; i < pairs.length; i++) if (pairs[i].key !== name) next.push(pairs[i]);
        pairs = next;
        flush();
      },
      toObject: function () {
        var o = {};
        for (var i = 0; i < pairs.length; i++) o[pairs[i].key] = pairs[i].value;
        return o;
      },
    };
    function flush() {
      var q = "";
      for (var i = 0; i < pairs.length; i++) {
        if (q) q += "&";
        q += pairs[i].key + "=" + pairs[i].value;
      }
      parts.query = q;
      setUrlString(buildUrl(parts));
    }
  }

  function urlObj() {
    var parts = splitUrl(R.url);
    return {
      toString: function () {
        return R.url;
      },
      getHost: function () {
        var a = parts.authority;
        var at = a.indexOf("@");
        if (at >= 0) a = a.slice(at + 1);
        var colon = a.lastIndexOf(":");
        if (colon >= 0 && /^\d+$/.test(a.slice(colon + 1))) return a.slice(0, colon);
        return a;
      },
      getPath: function () {
        return parts.path || "/";
      },
      query: urlQueryObj(),
    };
  }

  var requestObj = {
    get method() {
      return R.method;
    },
    set method(v) {
      if (typeof v !== "string" || !v) throw new Error("method must be a non-empty string");
      R.method = v.toUpperCase();
    },
    get url() {
      return urlObj();
    },
    set url(v) {
      setUrlString(typeof v === "string" ? v : String(v));
    },
    get headers() {
      return {
        add: function (h) {
          if (!h) throw new Error("headers.add expects {key, value}");
          validateHeaderKV(h.key, typeof h.value === "string" ? h.value : String(h.value));
          R.headers.push([h.key, h.value]);
        },
        upsert: function (h) {
          if (!h) throw new Error("headers.upsert expects {key, value}");
          validateHeaderKV(h.key, typeof h.value === "string" ? h.value : String(h.value));
          var lower = h.key.toLowerCase();
          for (var i = 0; i < R.headers.length; i++) {
            if (R.headers[i][0].toLowerCase() === lower) {
              R.headers[i][1] = h.value;
              return;
            }
          }
          R.headers.push([h.key, h.value]);
        },
        remove: function (key) {
          var lower = String(key).toLowerCase();
          var next = [];
          for (var i = 0; i < R.headers.length; i++) {
            if (R.headers[i][0].toLowerCase() !== lower) next.push(R.headers[i]);
          }
          R.headers = next;
        },
        get: function (key) {
          var lower = String(key).toLowerCase();
          for (var i = 0; i < R.headers.length; i++) {
            if (R.headers[i][0].toLowerCase() === lower) return R.headers[i][1];
          }
          return undefined;
        },
        all: function (key) {
          var lower = String(key).toLowerCase();
          var out = [];
          for (var i = 0; i < R.headers.length; i++) {
            if (R.headers[i][0].toLowerCase() === lower) out.push(R.headers[i][1]);
          }
          return out;
        },
      };
    },
    get body() {
      return {
        get mode() {
          return R.bodyMode;
        },
        set mode(v) {
          R.bodyMode = typeof v === "string" ? v : String(v);
        },
        get raw() {
          return R.body === null || R.body === undefined ? "" : R.body;
        },
        set raw(v) {
          var s = typeof v === "string" ? v : String(v);
          if (s.length > BODY_CAP) throw new Error("body too long: " + s.length + " chars, cap is 1 MB");
          R.body = s;
          if (!R.bodyMode) R.bodyMode = "raw";
        },
      };
    },
    set body(v) {
      // pm.request.body = {...} — accept an object with a raw string, or a string
      if (v && typeof v === "object") {
        if (v.mode) R.bodyMode = String(v.mode);
        var raw = v.raw;
        if (raw === undefined || raw === null) throw new Error("pm.request.body = {...} needs a raw string");
        var sv = typeof raw === "string" ? raw : String(raw);
        if (sv.length > BODY_CAP) throw new Error("body too long: " + sv.length + " chars, cap is 1 MB");
        R.body = sv;
        if (!R.bodyMode) R.bodyMode = "raw";
      } else if (typeof v === "string") {
        if (v.length > BODY_CAP) throw new Error("body too long: " + v.length + " chars, cap is 1 MB");
        R.body = v;
        if (!R.bodyMode) R.bodyMode = "raw";
      } else {
        throw new Error("pm.request.body must be a string or an object with a raw string");
      }
    },
    get auth() {
      return { type: R.authType };
    },
  };

  // ---- response (tests only) ----------------------------------------------

  function requireResponse() {
    if (!S.response) throw new Error("pm.response is only available in test scripts");
    return S.response;
  }

  var responseObj = {
    get code() {
      return requireResponse().code;
    },
    get status() {
      return requireResponse().status;
    },
    get responseTime() {
      return requireResponse().responseTime;
    },
    get responseSize() {
      return requireResponse().responseSize;
    },
    get headers() {
      var hs = requireResponse().headers;
      return {
        get: function (name) {
          var lower = String(name).toLowerCase();
          for (var i = 0; i < hs.length; i++) if (hs[i][0].toLowerCase() === lower) return hs[i][1];
          return undefined;
        },
        has: function (name) {
          var lower = String(name).toLowerCase();
          for (var i = 0; i < hs.length; i++) if (hs[i][0].toLowerCase() === lower) return true;
          return false;
        },
      };
    },
    text: function () {
      var b = requireResponse().bodyText;
      return b === null || b === undefined ? "" : b;
    },
    json: function () {
      var t = requireResponse().bodyText;
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new Error("response body is not valid JSON: " + (e && e.message ? e.message : String(e)));
      }
    },
  };

  // ---- chai-compatible expect subset ---------------------------------------

  function fmt(v) {
    var t = typeof v;
    if (t === "string") return JSON.stringify(v.length > 120 ? v.slice(0, 120) + "…" : v);
    if (t === "function") return "[Function" + (v.name ? " " + v.name : "") + "]";
    if (t === "object" && v !== null) {
      if (v instanceof Array) return "[ " + (v.length > 4 ? "…" : "") + " ]";
      try {
        var s = JSON.stringify(v);
        if (s && s.length > 120) s = s.slice(0, 120) + "…";
        return s === undefined ? String(v) : s;
      } catch (e) {
        return String(v);
      }
    }
    return String(v);
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== "object") return false;
    if (a instanceof Array && b instanceof Array) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (a instanceof Array || b instanceof Array) return false;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      if (!hasOwn(b, ka[j]) || !deepEqual(a[ka[j]], b[ka[j]])) return false;
    }
    return true;
  }

  function Assertion(subject) {
    this._obj = subject;
    this._neg = false;
  }

  var chainWords = ["to", "be", "been", "is", "that", "and", "has", "have", "with", "at", "of", "same"];
  for (var ci = 0; ci < chainWords.length; ci++) {
    Object.defineProperty(Assertion.prototype, chainWords[ci], {
      get: function () {
        return this;
      },
    });
  }
  Object.defineProperty(Assertion.prototype, "deep", {
    get: function () {
      this._deep = true;
      return this;
    },
  });
  Object.defineProperty(Assertion.prototype, "not", {
    get: function () {
      this._neg = !this._neg;
      return this;
    },
  });

  function assert(cond, msgPositive, msgNegative) {
    var ok = this._neg ? !cond : cond;
    if (!ok) throw new Error(this._neg ? msgNegative : msgPositive);
  }

  function typeName(v) {
    if (v === null) return "null";
    if (v instanceof Array) return "array";
    return typeof v;
  }

  var AP = Assertion.prototype;
  AP.assert = assert;

  function eqAssert(expected, label) {
    var a = this._obj;
    var pass = this._deep ? deepEqual(a, expected) : a === expected;
    this.assert(
      pass,
      "expected " + fmt(a) + " to " + (this._deep ? "deep equal " : "equal ") + fmt(expected),
      "expected " + fmt(a) + " not to " + (this._deep ? "deep equal " : "equal ") + fmt(expected)
    );
  }
  AP.equal = eqAssert;
  AP.eq = eqAssert;
  AP.eql = eqAssert;

  function typeAssert(type) {
    var a = this._obj;
    var pass;
    if (type === "null") pass = a === null;
    else if (type === "array") pass = a instanceof Array;
    else if (type === "object") pass = a !== null && typeof a === "object";
    else pass = typeof a === type;
    this.assert(
      pass,
      "expected " + fmt(a) + " to be a " + type,
      "expected " + fmt(a) + " not to be a " + type
    );
  }
  AP.a = typeAssert;
  AP.an = typeAssert;

  AP.ok = function () {
    this.assert(!!this._obj, "expected " + fmt(this._obj) + " to be truthy", "expected " + fmt(this._obj) + " to be falsy");
  };
  AP.true = function () {
    this.assert(this._obj === true, "expected " + fmt(this._obj) + " to be true", "expected " + fmt(this._obj) + " not to be true");
  };
  AP.false = function () {
    this.assert(this._obj === false, "expected " + fmt(this._obj) + " to be false", "expected " + fmt(this._obj) + " not to be false");
  };
  AP.null = function () {
    this.assert(this._obj === null, "expected " + fmt(this._obj) + " to be null", "expected " + fmt(this._obj) + " not to be null");
  };
  AP.undefined = function () {
    this.assert(this._obj === undefined, "expected " + fmt(this._obj) + " to be undefined", "expected " + fmt(this._obj) + " not to be undefined");
  };
  AP.exist = function () {
    this.assert(this._obj !== null && this._obj !== undefined, "expected " + fmt(this._obj) + " to exist", "expected " + fmt(this._obj) + " to not exist");
  };
  AP.empty = function () {
    var a = this._obj;
    var isEmpty =
      a === null || a === undefined
        ? false
        : typeof a === "string" || a instanceof Array
          ? a.length === 0
          : typeof a === "object"
            ? Object.keys(a).length === 0
            : false;
    this.assert(isEmpty, "expected " + fmt(a) + " to be empty", "expected " + fmt(a) + " not to be empty");
  };

  function numCmp(label, op) {
    return function (n) {
      var a = this._obj;
      this.assert(
        op(a, n),
        "expected " + fmt(a) + " to be " + label + " " + n,
        "expected " + fmt(a) + " not to be " + label + " " + n
      );
    };
  }
  AP.above = numCmp("above", function (a, b) { return a > b; });
  AP.gt = AP.above;
  AP.below = numCmp("below", function (a, b) { return a < b; });
  AP.lt = AP.below;
  AP.least = numCmp("at least", function (a, b) { return a >= b; });
  AP.gte = AP.least;
  AP.most = numCmp("at most", function (a, b) { return a <= b; });
  AP.lte = AP.most;

  AP.within = function (lo, hi) {
    var a = this._obj;
    this.assert(
      a >= lo && a <= hi,
      "expected " + fmt(a) + " to be within " + lo + ".." + hi,
      "expected " + fmt(a) + " not to be within " + lo + ".." + hi
    );
  };

  function includeAssert(arg) {
    var a = this._obj;
    var pass;
    if (typeof a === "string") pass = a.indexOf(String(arg)) >= 0;
    else if (a instanceof Array) {
      pass = false;
      for (var i = 0; i < a.length; i++) {
        if (this._deep ? deepEqual(a[i], arg) : a[i] === arg) {
          pass = true;
          break;
        }
      }
    } else if (a !== null && typeof a === "object") {
      pass = hasOwn(a, String(arg));
    } else pass = false;
    this.assert(
      pass,
      "expected " + fmt(a) + " to include " + fmt(arg),
      "expected " + fmt(a) + " not to include " + fmt(arg)
    );
  }
  AP.include = includeAssert;
  AP.includes = includeAssert;
  AP.contain = includeAssert;
  AP.contains = includeAssert;

  AP.match = function (re) {
    var a = this._obj;
    var pass = re instanceof RegExp ? re.test(String(a)) : String(a).indexOf(String(re)) >= 0;
    this.assert(pass, "expected " + fmt(a) + " to match " + fmt(re), "expected " + fmt(a) + " not to match " + fmt(re));
  };
  AP.string = function (s) {
    var a = this._obj;
    this.assert(
      typeof a === "string" && a.indexOf(s) >= 0,
      "expected " + fmt(a) + " to contain " + fmt(s),
      "expected " + fmt(a) + " not to contain " + fmt(s)
    );
  };
  AP.property = function (name, value) {
    var a = this._obj;
    var has = a !== null && a !== undefined && (name in Object(a));
    if (arguments.length > 1) {
      var v = a ? a[name] : undefined;
      var pass = has && (this._deep ? deepEqual(v, value) : v === value);
      this.assert(
        pass,
        "expected " + fmt(a) + " to have a property '" + name + "' of " + fmt(value),
        "expected " + fmt(a) + " not to have a property '" + name + "' of " + fmt(value)
      );
    } else {
      this.assert(
        has,
        "expected " + fmt(a) + " to have a property '" + name + "'",
        "expected " + fmt(a) + " not to have a property '" + name + "'"
      );
    }
  };
  AP.keys = function () {
    var a = this._obj;
    var want = [];
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] instanceof Array) {
        for (var j = 0; j < arguments[i].length; j++) want.push(String(arguments[i][j]));
      } else want.push(String(arguments[i]));
    }
    var got = typeof a === "object" && a !== null ? Object.keys(a) : [];
    var sortedWant = want.slice().sort();
    var sortedGot = got.slice().sort();
    var pass = sortedWant.length === sortedGot.length;
    if (pass) {
      for (var k = 0; k < sortedWant.length; k++) {
        if (sortedWant[k] !== sortedGot[k]) {
          pass = false;
          break;
        }
      }
    }
    this.assert(
      pass,
      "expected " + fmt(a) + " to have keys " + fmt(sortedWant),
      "expected " + fmt(a) + " not to have keys " + fmt(sortedWant)
    );
  };
  AP.lengthOf = function (n) {
    var a = this._obj;
    var len = a === null || a === undefined ? undefined : a.length;
    this.assert(
      len === n,
      "expected " + fmt(a) + " to have a length of " + n + " but got " + fmt(len),
      "expected " + fmt(a) + " not to have a length of " + n
    );
  };
  AP.oneOf = function (list) {
    var a = this._obj;
    var pass = false;
    if (list instanceof Array) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] === a) {
          pass = true;
          break;
        }
      }
    }
    this.assert(pass, "expected " + fmt(a) + " to be one of " + fmt(list), "expected " + fmt(a) + " not to be one of " + fmt(list));
  };
  AP.instanceOf = function (C) {
    var a = this._obj;
    var pass;
    try {
      pass = a instanceof C;
    } catch (e) {
      pass = false;
    }
    this.assert(
      pass,
      "expected " + fmt(a) + " to be an instance of " + fmt(C),
      "expected " + fmt(a) + " not to be an instance of " + fmt(C)
    );
  };

  function expect(value) {
    return new Assertion(value);
  }

  // response assertion target: pm.response.to.have.status(200) etc.
  function responseAssertion() {
    var resp = requireResponse();
    var a = new Assertion(resp);
    function rawAssert(cond, msg) {
      if (!cond) throw new Error(msg);
    }
    function wrap(name, fn) {
      return function () {
        if (a._neg) {
          try {
            fn.apply(null, arguments);
          } catch (e) {
            // positive form failed → the negative form holds
            return;
          }
          throw new Error("expected the positive assertion NOT to hold: " + fmt(arguments[0] !== undefined ? arguments[0] : name) + " holds");
        }
        fn.apply(null, arguments);
      };
    }
    var have = {
      status: wrap("status", function (want) {
        var pass = typeof want === "number" ? resp.code === want : String(want).toLowerCase() === String(resp.status).toLowerCase();
        rawAssert(pass, "expected " + resp.code + " to equal " + fmt(want));
      }),
      header: wrap("header", function (name, value) {
        var lower = String(name).toLowerCase();
        var found = null;
        for (var i = 0; i < resp.headers.length; i++) {
          if (resp.headers[i][0].toLowerCase() === lower) {
            found = resp.headers[i][1];
            break;
          }
        }
        if (arguments.length > 1) {
          rawAssert(
            found === value,
            "expected header " + name + " to equal " + fmt(value) + " but got " + fmt(found)
          );
        } else {
          rawAssert(found !== null, "expected a " + name + " header, but the response has none");
        }
      }),
      jsonBody: wrap("jsonBody", function () {
        var t = resp.bodyText;
        var okBody = t !== null && t !== undefined && t.length > 0;
        rawAssert(okBody, "expected a JSON body but the body is empty");
        try {
          JSON.parse(t);
        } catch (e) {
          rawAssert(false, "expected a JSON body: the body does not parse (" + (e && e.message ? e.message : e) + ")");
        }
      }),
      body: wrap("body", function (want) {
        var t = resp.bodyText === null || resp.bodyText === undefined ? "" : resp.bodyText;
        rawAssert(t === String(want), "expected the body to equal " + fmt(want));
      }),
    };
    var be = {
      ok: wrap("ok", function () {
        rawAssert(resp.code >= 200 && resp.code < 300, "expected " + resp.code + " to be an OK status (2xx)");
      }),
      json: wrap("json", function () {
        var ct = "";
        for (var i = 0; i < resp.headers.length; i++) {
          if (resp.headers[i][0].toLowerCase() === "content-type") {
            ct = resp.headers[i][1];
            break;
          }
        }
        rawAssert(ct.indexOf("json") >= 0, "expected a JSON content type, but got " + fmt(ct));
      }),
    };
    var out = new Assertion(resp);
    // own data properties: Assignment would silently hit the getter-only
    // chain-word properties on Assertion.prototype in sloppy mode
    Object.defineProperty(out, "have", { value: have });
    Object.defineProperty(out, "be", { value: be });
    Object.defineProperty(out, "status", { value: have.status });
    Object.defineProperty(out, "header", { value: have.header });
    Object.defineProperty(out, "body", { value: have.body });
    var words = ["to", "been", "is", "that", "and", "with", "at", "of", "same"];
    for (var i = 0; i < words.length; i++) {
      (function (w) {
        Object.defineProperty(out, w, {
          get: function () {
            return out;
          },
        });
      })(words[i]);
    }
    Object.defineProperty(out, "not", {
      get: function () {
        a._neg = !a._neg;
        return out;
      },
    });
    return out;
  }

  // ---- pm -------------------------------------------------------------------

  function envTargetScope(opts) {
    var scope = "collection";
    if (opts && opts.scope !== undefined) {
      if (opts.scope !== "collection" && opts.scope !== "environment") {
        throw new Error("pm.secrets.set scope must be \"collection\" or \"environment\"");
      }
      scope = opts.scope;
    }
    if ((!opts || opts.scope === undefined) && S.environmentId) scope = "environment";
    if (scope === "environment" && !S.environmentId) {
      throw new Error("pm.secrets.set with scope \"environment\" needs a selected environment");
    }
    return scope;
  }

  var pm = {
    variables: {
      get: function (name) {
        var r = localLookup(String(name));
        return r && r.value !== undefined ? r.value : undefined;
      },
      set: function (name, value) {
        if (typeof name !== "string" || !name) throw new Error("variable name must be a non-empty string");
        if (typeof value !== "string") throw new Error("variable value must be a string");
        if (value.length > VAR_VALUE_CAP) throw new Error("variable value too long: cap is " + VAR_VALUE_CAP);
        F.local[name] = value;
      },
      has: function (name) {
        return nameExists(String(name));
      },
      unset: function (name) {
        delete F.local[String(name)];
      },
      replaceIn: function (text) {
        return replaceInVars(text);
      },
    },
    collectionVariables: {
      get: function (name) {
        var r = scopeLookup("collection", String(name));
        return r && r.value !== undefined ? r.value : undefined;
      },
      set: function (name, value) {
        scopedPlainOrSecretSet("collection", String(name), value);
      },
      has: function (name) {
        return scopeLookup("collection", String(name)) !== undefined;
      },
      unset: function (name) {
        applyPlainSet("collection", String(name), "");
      },
    },
    environment: {
      get name() {
        return S.envName;
      },
      get: function (name) {
        if (!S.environmentId) return undefined;
        var r = scopeLookup("environment", String(name));
        return r && r.value !== undefined ? r.value : undefined;
      },
      set: function (name, value) {
        if (!S.environmentId) throw new Error("pm.environment.set needs a selected environment: pick one before sending");
        scopedPlainOrSecretSet("environment", String(name), value);
      },
      has: function (name) {
        if (!S.environmentId) return false;
        return scopeLookup("environment", String(name)) !== undefined;
      },
      unset: function (name) {
        if (!S.environmentId) throw new Error("pm.environment.unset needs a selected environment");
        applyPlainSet("environment", String(name), "");
      },
    },
    globals: {
      get: function (name) {
        var r = scopeLookup("collection", String(name));
        return r && r.value !== undefined ? r.value : undefined;
      },
      set: function (name, value) {
        scopedPlainOrSecretSet("collection", String(name), value);
      },
      has: function (name) {
        return scopeLookup("collection", String(name)) !== undefined;
      },
      unset: function (name) {
        applyPlainSet("collection", String(name), "");
      },
    },
    secrets: {
      set: function (name, value, opts) {
        var scope = envTargetScope(opts);
        if (plainExists(scope, String(name))) {
          throw new Error("refused: " + name + " is already a plain variable in that scope; use a different name or delete the variable first");
        }
        applySecretSet(scope, String(name), value);
      },
      has: function (name) {
        return findSecret(String(name), null) !== null;
      },
    },
    request: requestObj,
    response: responseObj,
    expect: expect,
    crypto: pmCrypto,
    info: {
      get requestName() {
        return S.requestName;
      },
      get eventName() {
        return S.eventName;
      },
      iterationData: {
        get: undefined,
      },
    },
    test: function (name, fn) {
      if (F.tests.length >= TEST_CAP) throw new Error("too many tests: at most " + TEST_CAP + " per send");
      var entry = { name: String(name).slice(0, 200), passed: false, error: undefined };
      F.tests.push(entry);
      if (typeof fn !== "function") {
        entry.error = "the test value is not a function";
        return;
      }
      try {
        var r = fn();
        if (r && typeof r.then === "function") {
          entry.error = "async tests are not supported yet: make the test function synchronous";
          return;
        }
        entry.passed = true;
      } catch (e) {
        entry.error = e && e.message ? e.message : String(e);
      }
    },
    sendRequest: function () {
      throw new Error("not supported in this version: scripts cannot send their own requests — create another request in the collection and send it separately");
    },
  };

  Object.defineProperty(responseObj, "to", {
    get: function () {
      return responseAssertion();
    },
  });

  var postman = {
    setNextRequest: function () {
      throw new Error("not supported in this version: collection runners are not available — send each request individually");
    },
    getEnvironmentVariable: function (name) {
      return pm.environment.get(name);
    },
    setEnvironmentVariable: function (name, value) {
      pm.environment.set(name, value);
    },
    getGlobalVariable: function (name) {
      return pm.globals.get(name);
    },
    setGlobalVariable: function (name, value) {
      pm.globals.set(name, value);
    },
  };

  var consoleObj = {
    log: function () {
      noteLine("log", arguments);
    },
    info: function () {
      noteLine("info", arguments);
    },
    warn: function () {
      noteLine("warn", arguments);
    },
    error: function () {
      noteLine("error", arguments);
    },
  };

  function setTimeoutShim(fn, ms) {
    if (typeof fn === "function") F.timeouts.push(fn);
    return 0;
  }
  function clearTimeoutShim() {}

  // ---- collect --------------------------------------------------------------

  function collect() {
    var ran = F.timeouts.length > 100 ? 100 : F.timeouts.length;
    for (var i = 0; i < ran; i++) {
      try {
        F.timeouts[i]();
      } catch (e) {
        noteLine("error", ["setTimeout callback failed: " + (e && e.message ? e.message : String(e))]);
      }
    }
    if (F.timeouts.length > 100) F.consoleTruncated = F.consoleTruncated || noteIfRoom("setTimeout ran 100 callbacks max; the rest were dropped");
    var out = [];
    var total = 0;
    for (var j = 0; j < F.consoleLines.length; j++) {
      var l = F.consoleLines[j];
      if (total + l.length > CONSOLE_MAX_TOTAL) {
        F.consoleTruncated = true;
        break;
      }
      total += l.length;
      out.push(l);
    }
    return {
      request: R,
      tests: F.tests,
      console: out,
      truncated: F.consoleTruncated,
      varOps: F.varOps,
      secretReads: F.secretReads,
      urlSetBy: F.urlSetBy,
    };
  }

  function noteIfRoom(line) {
    noteLine("info", [line]);
    return true;
  }

  function setCurrentScript(name) {
    currentScriptName = String(name);
  }

  function run(fn) {
    try {
      fn();
      return "";
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      if (msg === "interrupted") msg = "__FFWD_INTERRUPTED__";
      else if (msg === "out of memory" || msg === "string too long") msg = "__FFWD_OUT_OF_MEMORY__";
      var stack = "";
      try { stack = e && e.stack ? String(e.stack) : ""; } catch (_) {}
      return JSON.stringify({ message: msg, stack: stack });
    }
  }

  return {
    collect: collect,
    setCurrentScript: setCurrentScript,
    run: run,
    pm: pm,
    postman: postman,
    console: consoleObj,
    setTimeoutShim: setTimeoutShim,
    clearTimeoutShim: clearTimeoutShim,
    btoa: btoa,
    atob: atob,
    req: req,
  };
})();

var pm = __f.pm;
var postman = __f.postman;
var console = __f.console;
var setTimeout = __f.setTimeoutShim;
var clearTimeout = __f.clearTimeoutShim;
var btoa = __f.btoa;
var atob = __f.atob;
var require = __f.req;
`;
