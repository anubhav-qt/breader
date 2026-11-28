import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * Readers translate the app with their browser (Chrome's Translate and the like). A translator
 * swaps each piece of text on the page for its own <font> tags, so a text node React made is no
 * longer in the page. When React later moves or removes that text node, the browser throws
 * "The node to be removed is not a child of this node" and the whole app goes blank.
 *
 * React keeps no text node of its own where an element's text is its only child, a single string:
 * it sets the element's textContent instead. So every piece of text sits alone in its element:
 *
 *   <button><Icon /> Save</button>          no: the text sits beside the icon
 *   <button><Icon /><span>Save</span></button>
 *
 *   <p>Pages: {n} left</p>                  no: three text nodes side by side
 *   <p>{`Pages: ${n} left`}</p>
 *
 * Text in a fragment counts as beside its fragment's neighbours, so it is never loose there either.
 * Anything typed as text (string, number, ReactNode) counts, so `{children}` beside an icon too.
 *
 * A component of the app's own that can return text by itself always leaves a text node of its
 * own, wherever it is put, so it returns its text in an element instead. Components made by a
 * library or wrapped (memo, forwardRef) aren't looked into: lib/translators.ts catches those.
 */

const project = fileURLToPath(new URL('../tsconfig.app.json', import.meta.url));
const src = fileURLToPath(new URL('.', import.meta.url));

function loadProgram() {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  const config = ts.getParsedCommandLineOfConfigFile(project, {}, host);
  if (!config) throw new Error('tsconfig.app.json could not be read.');
  return ts.createProgram(config.fileNames, config.options);
}

/** Whether a child of this type can become text on the page. */
function canBeText(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  // A type that holds itself (lib/elements.ts) is looked at once.
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  // React puts nothing on the page for '', as in {error && <p>{error}</p>}.
  if (type.isStringLiteral() && type.value === '') {
    return false;
  }
  if (type.isUnion()) {
    return type.types.some((part) => canBeText(checker, part, seen));
  }
  const textFlags = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Any;
  if (type.flags & textFlags) {
    return true;
  }
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0];
    return canBeText(checker, item, seen);
  }
  return false;
}

/** The children that put something on the page: no blank lines between tags, no comments. */
function realChildren(node: ts.JsxElement | ts.JsxFragment): ts.JsxChild[] {
  return node.children.filter((child) => {
    if (ts.isJsxText(child)) {
      return !child.containsOnlyTriviaWhiteSpaces;
    }
    if (ts.isJsxExpression(child)) {
      return child.expression !== undefined;
    }
    return true;
  });
}

function isText(checker: ts.TypeChecker, child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) {
    return true;
  }
  if (ts.isJsxExpression(child) && child.expression) {
    return canBeText(checker, checker.getTypeAtLocation(child.expression));
  }
  return false;
}

/** Whether a tag is one of the app's own components that can return text by itself. */
function returnsText(checker: ts.TypeChecker, tag: ts.JsxTagNameExpression, src: string): boolean {
  const isHostTag = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
  if (isHostTag) {
    return false;
  }
  const signatures = checker.getTypeAtLocation(tag).getCallSignatures();
  return signatures.some((signature) => {
    const declared = signature.getDeclaration()?.getSourceFile().fileName ?? '';
    if (!declared.startsWith(src)) {
      return false;
    }
    return canBeText(checker, signature.getReturnType());
  });
}

/** Every piece of text that sits beside something else, as `file:line text`. */
function looseText(): string[] {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const found: string[] = [];
  for (const file of program.getSourceFiles()) {
    const inApp = file.fileName.startsWith(src);
    if (!inApp || /\.test\.tsx?$/.test(file.fileName)) {
      continue;
    }
    const where = (node: ts.Node) => {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      const what = node.getText().replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${file.fileName.slice(src.length)}:${line + 1} ${what}`;
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (returnsText(checker, node.tagName, src)) {
          found.push(where(node));
        }
      }
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const children = realChildren(node);
        const shared = children.length > 1 || ts.isJsxFragment(node);
        if (shared) {
          for (const child of children) {
            if (isText(checker, child)) {
              found.push(where(child));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

describe('text a translator can change', () => {
  it('sits alone in its element everywhere', () => {
    expect(looseText()).toEqual([]);
  }, 120_000);
});
