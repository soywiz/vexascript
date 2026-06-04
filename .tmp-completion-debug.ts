import { createAnalysisSession } from './compiler/lsp/analysisSession';
import { createCompletionItemsForPosition } from './compiler/lsp/completion';
import { TextDocument } from 'vscode-languageserver-textdocument';

const source =
  'class Point(val x: int, val y: int) {\n' +
  '  operator+(other: Point): Point {\n' +
  '    return new Point(this.x + other.x, this.y + other.y)\n' +
  '  }\n' +
  '  operator*(scale: int): Point {\n' +
  '    return new Point(x * scale, y * scale)\n' +
  '  }\n' +
  '}\n' +
  'fun demo() {\n' +
  '  const result = new Point(1, 2)\n' +
  '  return result.\n' +
  '}\n';

const session = createAnalysisSession(source);
const doc = TextDocument.create('file:///demo.my', 'mylang', 1, source);
const cursorOffset = source.indexOf('\n  return result.') + '\n  return result.'.length;
const cursor = doc.positionAt(cursorOffset);
const items = createCompletionItemsForPosition(
  session.ast,
  cursor.line,
  cursor.character,
  session.analysis,
  [],
  { text: source }
);
console.log(JSON.stringify(items.map((item) => ({ label: item.label, kind: item.kind, edit: item.textEdit })), null, 2));
