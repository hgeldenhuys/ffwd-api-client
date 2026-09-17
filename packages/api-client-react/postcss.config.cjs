const SCOPE = ":is(.ffwd-api-client, [data-ffwd-api-client-portal])";

module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
    "postcss-prefix-selector": {
      prefix: SCOPE + " ",
      transform(_prefix, selector) {
        // theme-variable emissions for the scope roots themselves
        if (selector.includes(":root")) {
          return selector.replace(/:root/g, SCOPE);
        }
        // already scoped (component root, portal, dark overrides)
        if (selector.includes(".ffwd-api-client") || selector.includes("[data-ffwd-api-client-portal]")) {
          return selector;
        }
        // The component ROOT carries utilities too (flex, h-full, min-h-[480px]); a pure
        // descendant prefix never matches the root itself, which rendered the client 190px
        // tall inside the Hono example host (2026-09-16). Emit both forms for class/attribute
        // selectors; a type selector cannot be compounded after :is() so it stays descendant-only.
        const compound = /^[.\[]/.test(selector.trim()) ? ", " + SCOPE + selector.trim() : "";
        return SCOPE + " " + selector + compound;
      },
    },
  },
};
