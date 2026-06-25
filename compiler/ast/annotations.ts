import type { AnnotationApplication, Program } from "./ast";
import { walkAst } from "./traversal";

/**
 * Collects every `@Annotation` application reachable from the program, wherever
 * it appears: on top-level declarations, on class members, and inside
 * exported/namespaced declarations.
 *
 * LSP features (navigation, signature help) consume this single traversal so
 * member and top-level annotations are handled through one path instead of each
 * surface re-deciding where annotations may appear. The shared `walkAst` visits
 * the `annotations` arrays as ordinary child nodes, so any future annotation
 * location is covered automatically.
 */
export function programAnnotationApplications(program: Program): AnnotationApplication[] {
  const applications: AnnotationApplication[] = [];
  walkAst(program, (node) => {
    if (node.kind === "AnnotationApplication") {
      applications.push(node as AnnotationApplication);
    }
  });
  return applications;
}
