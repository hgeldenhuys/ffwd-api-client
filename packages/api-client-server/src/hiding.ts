/**
 * Secret hiding on send. For every secret value resolved for this send,
 * build its encoded forms and replace every occurrence with ••••••{{name}}
 * in the resolved request preview, response headers, response text bodies
 * and any error message.
 */

export const HIDE_MARK = "\u2022\u2022\u2022\u2022\u2022\u2022"; // ••••••
export const MIN_HIDEABLE_LENGTH = 8;

export interface UsedSecret {
  name: string;
  value: string;
}

export interface HideResult {
  text: string;
  warnings: string[];
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
function b64url(s: string): string {
  return b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hex(s: string, upper = false): string {
  const h = Buffer.from(s, "utf8").toString("hex");
  return upper ? h.toUpperCase() : h;
}
function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}
function unicodeEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    }
  }
  return out;
}

function forms(value: string): string[] {
  const set = new Set<string>();
  set.add(value);
  set.add(encodeURIComponent(value));
  set.add(jsonEscape(value));
  set.add(b64(value));
  set.add(b64url(value));
  set.add(hex(value));
  set.add(hex(value, true));
  set.add(unicodeEscape(value));
  set.delete("");
  return [...set];
}

/** Replace every occurrence of any encoded form of each secret with the mark. */
export function hideSecrets(text: string, secrets: UsedSecret[]): HideResult {
  const warnings: string[] = [];
  for (const { name, value } of secrets) {
    if (value.length === 0) continue;
    if (value.length < MIN_HIDEABLE_LENGTH) {
      warnings.push(
        `The secret "${name}" is shorter than ${MIN_HIDEABLE_LENGTH} characters: it was still substituted, but a value that short cannot be hidden reliably in the response.`
      );
    }
    const mark = `${HIDE_MARK}{{${name}}}`;
    for (const form of forms(value)) {
      text = text.split(form).join(mark);
    }
  }
  return { text, warnings };
}

export function hideHeaders(
  headers: Record<string, string>,
  secrets: UsedSecret[]
): { headers: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const r = hideSecrets(v, secrets);
    out[k] = r.text;
    warnings.push(...r.warnings);
  }
  return { headers: out, warnings };
}

export function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

/** Hide a text body, or flag a binary body as not hidden. */
export function hideBody(
  bodyText: string | null,
  isText: boolean,
  contentType: string,
  secrets: UsedSecret[]
): { body: string | null; base64: string | null; hidden: boolean; notHiddenReason?: string; warnings: string[] } {
  const warnings: string[] = [];
  if (bodyText === null || !isText) {
    return {
      body: null,
      base64: bodyText === null ? null : Buffer.from(bodyText, "utf8").toString("base64"),
      hidden: false,
      notHiddenReason:
        bodyText === null
          ? undefined
          : `The response body has content type "${contentType}", which is not text: encoded secrets cannot be found reliably inside it, so it is returned as base64 and not rendered inline.`,
      warnings,
    };
  }
  const r = hideSecrets(bodyText, secrets);
  return { body: r.text, base64: null, hidden: true, warnings: r.warnings };
}
