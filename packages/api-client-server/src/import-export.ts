/**
 * Postman v2.1 import/export. On import of a collection, literal values in
 * structured auth blocks (bearer / apikey / basic, at any level) are moved
 * into collection-scope secrets and replaced by {{name}}; literal values in
 * plain auth-looking headers only produce a warning list. On import of an
 * environment, type:"secret" entries go into the secret store and the stored
 * JSON keeps a blank value. Export never contains a secret value.
 */

const AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key", "x-auth-token"]);
const AUTH_FIELD_FOR_TYPE: Record<string, string> = {
  bearer: "token",
  apikey: "value",
  basic: "password",
};
// The moved secret's name carries the auth KIND (bearer|apikey|basic), not the
// field name, per docs/BRIEF-3.md: <collectionSlug>_<folderOrRequestSlug>_<kind>.
const KIND_FOR_TYPE: Record<string, string> = {
  bearer: "bearer",
  apikey: "apikey",
  basic: "basic",
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "collection";
}

export interface MovedSecret {
  scope: "collection";
  name: string;
  where: string;
  field: string;
}

export interface ImportReport {
  movedSecrets: MovedSecret[];
  warnings: string[];
}

function isLiteral(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("{{");
}

/** Walk a v2.1 collection; move auth literals to secrets; returns mutated json + report. */
export function importCollection(
  collectionJson: any,
  collectionSlug: string
): { json: any; report: ImportReport; secrets: { name: string; value: string }[] } {
  const report: ImportReport = { movedSecrets: [], warnings: [] };
  const moved: { name: string; value: string }[] = [];
  const usedNames = new Set<string>();

  const secretName = (type: string, partSlug: string): string => {
    const kind = KIND_FOR_TYPE[type] ?? type;
    let base = `${collectionSlug}_${partSlug}_${kind}`;
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}_${i++}`;
    usedNames.add(name);
    return name;
  };

  const visitAuth = (auth: any, where: string, partSlug: string) => {
    if (!auth || typeof auth !== "object") return;
    const type = auth.type;
    const field = AUTH_FIELD_FOR_TYPE[type];
    if (!field || !Array.isArray(auth[type])) return;
    for (const p of auth[type]) {
      if (p && p.key === field && isLiteral(p.value)) {
        const name = secretName(type, partSlug);
        moved.push({ name, value: p.value });
        report.movedSecrets.push({ scope: "collection", name, where, field });
        p.value = `{{${name}}}`;
      }
    }
  };

  const visitHeaders = (headers: any[], where: string) => {
    for (const h of headers ?? []) {
      if (!h || h.disabled || typeof h.key !== "string") continue;
      if (AUTH_HEADER_NAMES.has(h.key.toLowerCase()) && isLiteral(h.value)) {
        report.warnings.push(
          `The header "${h.key}" on ${where} carries a literal value: it stays in the collection. Move it to a secret variable to protect it.`
        );
      }
    }
  };

  const walkItems = (items: any[], path: string[]) => {
    for (const item of items ?? []) {
      const name = item?.name ?? "?";
      const where = [...path, name].join(" / ");
      // the innermost folder/request slug names the moved secret; nested
      // folders contribute only their own name (the last hop wins)
      visitAuth(item?.auth, where, slugify(name));
      visitHeaders(item?.request?.header ?? [], `request "${where}"`);
      if (Array.isArray(item?.item)) walkItems(item.item, [...path, name]);
    }
  };

  // collection-level auth literals take the collection slug as the part slug
  visitAuth(collectionJson?.auth, `collection "${collectionJson?.name ?? collectionSlug}"`, collectionSlug);
  walkItems(collectionJson?.item ?? [], []);

  return { json: collectionJson, report, secrets: moved };
}

/** Import a v2.1 environment: pull type:"secret" values out into the secret store. */
export function importEnvironment(
  envJson: any
): { json: any; report: ImportReport; secrets: { name: string; value: string }[] } {
  const report: ImportReport = { movedSecrets: [], warnings: [] };
  const out: { name: string; value: string }[] = [];
  for (const v of envJson?.values ?? []) {
    if (v && v.type === "secret" && typeof v.value === "string" && v.value.length > 0) {
      out.push({ name: v.key, value: v.value });
      v.value = "";
    }
  }
  return { json: envJson, report, secrets: out };
}
