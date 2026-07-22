import { BindingHole, Identifier, ObjectBindingPattern, StringLiteral } from "compiler/ast/ast";
import type { BindingElement, BindingName, Node } from "./ast";

export function bindingIdentifiers(binding: BindingName): Identifier[] {
  if (binding instanceof Identifier) {
    return [binding];
  }
  const identifiers: Identifier[] = [];
  for (const rawElement of binding.elements) {
    if ((rawElement as Node) instanceof BindingHole) continue;
    const element = rawElement as BindingElement;
    for (const identifier of bindingIdentifiers(element.name)) identifiers.push(identifier);
  }
  return identifiers;
}

export function bindingElements(binding: BindingName): BindingElement[] {
  if (binding instanceof Identifier) {
    return [];
  }
  const elements: BindingElement[] = [];
  for (const rawElement of binding.elements) {
    if ((rawElement as Node) instanceof BindingHole) continue;
    const element = rawElement as BindingElement;
    elements.push(element);
    for (const nested of bindingElements(element.name)) elements.push(nested);
  }
  return elements;
}

export function bindingElementPropertyName(element: BindingElement): string | undefined {
  if (element.propertyName instanceof Identifier) {
    return element.propertyName.name;
  }
  if (element.propertyName instanceof StringLiteral) {
    return element.propertyName.value;
  }
  if (element.name instanceof Identifier) {
    return element.name.__vexaNativeOriginalName ?? element.name.name;
  }
  return undefined;
}

export function bindingNameText(binding: BindingName): string {
  if (binding instanceof Identifier) return binding.name;
  const names = bindingIdentifiers(binding).map((identifier) => identifier.name).join(", ");
  return binding instanceof ObjectBindingPattern ? `{ ${names} }` : `[${names}]`;
}
