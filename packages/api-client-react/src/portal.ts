/**
 * Radix portals (dialogs, dropdowns, selects, popovers) render outside the
 * component's DOM subtree, so the scoped stylesheet would miss them. All the
 * package's portals are pointed at ONE container div appended to
 * document.body and marked with data-ffwd-api-client-portal, which the
 * stylesheet also targets. Hosts never need to do anything.
 */

const ATTR = "data-ffwd-api-client-portal";

let container: HTMLElement | null = null;

export function getPortalContainer(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (container && container.isConnected) return container;
  container = document.createElement("div");
  container.setAttribute(ATTR, "");
  document.body.appendChild(container);
  return container;
}
