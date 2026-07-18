import { NodeKind } from "compiler/ast/ast";
import type { BindingElement, BindingName, Identifier, Node } from "./ast";

export function bindingIdentifiers(binding: BindingName): Identifier[] {
  if (binding.kind === NodeKind.Identifier) {
    return [binding];
  }
  const identifiers: Identifier[] = [];
  for (const rawElement of binding.elements) {
    if ((rawElement as Node).kind === NodeKind.BindingHole) continue;
    const element = rawElement as BindingElement;
    for (const identifier of bindingIdentifiers(element.name)) identifiers.push(identifier);
  }
  return identifiers;
}

export function bindingElements(binding: BindingName): BindingElement[] {
  if (binding.kind === NodeKind.Identifier) {
    return [];
  }
  const elements: BindingElement[] = [];
  for (const rawElement of binding.elements) {
    if ((rawElement as Node).kind === NodeKind.BindingHole) continue;
    const element = rawElement as BindingElement;
    elements.push(element);
    for (const nested of bindingElements(element.name)) elements.push(nested);
  }
  return elements;
}

export function bindingElementPropertyName(element: BindingElement): string | undefined {
  if (element.propertyName?.kind === NodeKind.Identifier) {
    return element.propertyName.name;
  }
  if (element.propertyName?.kind === NodeKind.StringLiteral) {
    return element.propertyName.value;
  }
  if (element.name.kind === NodeKind.Identifier) {
    return element.name.__vexaNativeOriginalName ?? element.name.name;
  }
  return undefined;
}

export function bindingNameText(binding: BindingName): string {
  if (binding.kind === NodeKind.Identifier) return binding.name;
  const names = bindingIdentifiers(binding).map((identifier) => identifier.name).join(", ");
  return binding.kind === NodeKind.ObjectBindingPattern ? `{ ${names} }` : `[${names}]`;
}
