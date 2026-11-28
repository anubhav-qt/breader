import { beforeEach, describe, expect, it } from 'vitest';
import { forgiveMovedNodes } from './translators';

/** Just enough of the page's nodes: a parent keeps its children in order, and throws as a browser does. */
class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  nodeName: string;
  tagName?: string;
  className?: string;

  constructor(name: string, className?: string) {
    this.nodeName = name;
    if (name !== '#text') {
      this.tagName = name.toUpperCase();
      this.className = className ?? '';
    }
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at < 0) {
      throw new Error("Failed to execute 'removeChild' on 'Node'");
    }
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    if (before === null) {
      this.childNodes.push(node);
    } else {
      const at = this.childNodes.indexOf(before);
      if (at < 0) {
        throw new Error("Failed to execute 'insertBefore' on 'Node'");
      }
      this.childNodes.splice(at, 0, node);
    }
    node.parentNode = this;
    return node;
  }
}

/** What one kind of translator does: swaps a text node for its own tag. */
function translate(text: FakeNode): FakeNode {
  const parent = text.parentNode!;
  const font = new FakeNode('font');
  parent.insertBefore(font, text);
  parent.removeChild(text);
  return font;
}

/** What another kind does: wraps the text node in its own tag. */
function wrap(text: FakeNode): FakeNode {
  const parent = text.parentNode!;
  const font = new FakeNode('font');
  parent.insertBefore(font, text);
  font.insertBefore(text, null);
  return font;
}

let reports: Array<{ message: string; extra: Record<string, unknown> }>;
let original: { removeChild: FakeNode['removeChild']; insertBefore: FakeNode['insertBefore'] };

beforeEach(() => {
  original = { removeChild: FakeNode.prototype.removeChild, insertBefore: FakeNode.prototype.insertBefore };
  reports = [];
  forgiveMovedNodes(FakeNode.prototype as unknown as Node, (err, extra) => reports.push({ message: err.message, extra }));
  return () => {
    FakeNode.prototype.removeChild = original.removeChild;
    FakeNode.prototype.insertBefore = original.insertBefore;
  };
});

/** The parent's last child. */
function lastOf(parent: FakeNode) {
  return parent.childNodes[parent.childNodes.length - 1];
}

function parentWith(...names: string[]) {
  const parent = new FakeNode('p', 'mds-here is-on');
  const kids = names.map((n) => parent.insertBefore(new FakeNode(n), null));
  return { parent, kids };
}

describe('forgiveMovedNodes', () => {
  it('removes a child as before', () => {
    const { parent, kids } = parentWith('#text', 'b');
    parent.removeChild(kids[0]);
    expect(parent.childNodes).toEqual([kids[1]]);
    expect(reports).toEqual([]);
  });

  it('inserts before a child as before', () => {
    const { parent, kids } = parentWith('#text', 'b');
    const added = new FakeNode('i');
    parent.insertBefore(added, kids[1]);
    expect(parent.childNodes).toEqual([kids[0], added, kids[1]]);
    expect(reports).toEqual([]);
  });

  it('lets go of a node a translator already took out', () => {
    const { parent, kids } = parentWith('#text', 'b');
    const font = translate(kids[0]);
    expect(() => parent.removeChild(kids[0])).not.toThrow();
    expect(parent.childNodes).toEqual([font, kids[1]]);
  });

  it('puts a node at the end when the one it goes before has moved', () => {
    const { parent, kids } = parentWith('#text', 'b');
    translate(kids[0]);
    const added = new FakeNode('i');
    expect(() => parent.insertBefore(added, kids[0])).not.toThrow();
    expect(lastOf(parent)).toBe(added);
    expect(added.parentNode).toBe(parent);
  });

  it('still appends when there is nothing to go before', () => {
    const { parent } = parentWith('b');
    const added = new FakeNode('i');
    parent.insertBefore(added, null);
    expect(lastOf(parent)).toBe(added);
    expect(reports).toEqual([]);
  });

  it('takes a wrapped node out of its wrapper', () => {
    const { parent, kids } = parentWith('#text', 'b');
    const font = wrap(kids[0]);
    parent.removeChild(kids[0]);
    expect(kids[0].parentNode).toBe(null);
    expect(font.childNodes).toEqual([]);
    expect(parent.childNodes).toEqual([font, kids[1]]);
  });

  it('puts a node before the wrapper of the one it goes before', () => {
    const { parent, kids } = parentWith('b', '#text');
    const font = wrap(kids[1]);
    const added = new FakeNode('i');
    parent.insertBefore(added, kids[1]);
    expect(parent.childNodes).toEqual([kids[0], added, font]);
  });

  it('reports a place once, with the parent tag and class only', () => {
    const { parent, kids } = parentWith('#text', '#text');
    translate(kids[0]);
    translate(kids[1]);
    parent.removeChild(kids[0]);
    parent.removeChild(kids[1]);
    expect(reports).toEqual([
      { message: 'A node React was about to remove had moved', extra: { parent: 'p.mds-here.is-on' } },
    ]);
  });

  it('reports each new place, up to five', () => {
    for (let i = 0; i < 7; i++) {
      const parent = new FakeNode('div', `place-${i}`);
      const text = parent.insertBefore(new FakeNode('#text'), null);
      translate(text);
      parent.removeChild(text);
    }
    expect(reports.map((r) => r.extra.parent)).toEqual([
      'div.place-0',
      'div.place-1',
      'div.place-2',
      'div.place-3',
      'div.place-4',
    ]);
  });

  it('names a parent with no class by its tag', () => {
    const parent = new FakeNode('div');
    const text = parent.insertBefore(new FakeNode('#text'), null);
    translate(text);
    parent.removeChild(text);
    expect(reports[0].extra).toEqual({ parent: 'div' });
  });
});
