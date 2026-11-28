/*
 * The net under src/translatable.test.ts. A browser translator, or an extension, can still move a
 * node React made: text a component returns by itself, a library's own markup. React then asks the
 * page to remove or insert next to a node that isn't where it left it, the browser throws, and the
 * whole app goes blank.
 *
 * Some translators wrap the node in their own tag, others swap it out for one. A wrapped node is
 * still found inside the parent: it is removed from its wrapper, and an insert goes before the
 * wrapper. A swapped-out node is gone: its removal is let go, and an insert goes at the end of the
 * parent, so a word may sit out of place until the next render, but the app stays up.
 *
 * A miss is reported once for each place it happens (up to a few), with the parent's tag and class
 * only, so it can be found and fixed (never the page's words).
 */

type Report = (err: Error, extra: Record<string, unknown>) => void;

/** How many different places get reported in one page load. */
const MAX_PLACES = 5;

/** The parent's tag and class, enough to find the component. */
function whereIs(parent: Node): string {
  const el = parent as Partial<Element>;
  const tag = el.tagName?.toLowerCase() ?? parent.nodeName;
  const className = typeof el.className === 'string' ? el.className : '';
  if (className) {
    return `${tag}.${className.trim().split(/\s+/).join('.')}`;
  }
  return tag;
}

/** The parent's own child that holds the node, deeper down; null when the node left the parent. */
function childHolding(parent: Node, node: Node): Node | null {
  let at: Node | null = node;
  while (at && at.parentNode !== parent) {
    at = at.parentNode;
  }
  return at;
}

export function forgiveMovedNodes(proto: Node, report: Report): void {
  const removeChild = proto.removeChild;
  const insertBefore = proto.insertBefore;
  const reported = new Set<string>();

  const tell = (what: string, parent: Node) => {
    const place = whereIs(parent);
    if (reported.has(place)) {
      return;
    }
    if (reported.size >= MAX_PLACES) {
      return;
    }
    reported.add(place);
    report(new Error(`A node React was about to ${what} had moved`), { parent: place });
  };

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode === this) {
      return removeChild.call(this, child) as T;
    }
    tell('remove', this);
    const wrapper = childHolding(this, child);
    if (wrapper) {
      removeChild.call(child.parentNode, child);
    }
    return child;
  };

  proto.insertBefore = function <T extends Node>(this: Node, node: T, before: Node | null): T {
    if (!before) {
      return insertBefore.call(this, node, null) as T;
    }
    if (before.parentNode === this) {
      return insertBefore.call(this, node, before) as T;
    }
    tell('insert before', this);
    const wrapper = childHolding(this, before);
    return insertBefore.call(this, node, wrapper) as T;
  };
}
