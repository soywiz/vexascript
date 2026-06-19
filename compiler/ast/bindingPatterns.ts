import type { BindingElement, BindingName, Identifier } from "./ast";

export function bindingIdentifiers(binding: BindingName): Identifier[] {
  if (binding.kind === "Identifier") {
    return [binding];
  }
  return binding.elements.flatMap((element) =>
    element.kind === "BindingHole" ? [] : bindingIdentifiers(element.name)
  );
}

export function bindingElements(binding: BindingName): BindingElement[] {
  if (binding.kind === "Identifier") {
    return [];
  }
  return binding.elements.flatMap((element) =>
    element.kind === "BindingHole" ? [] : [element, ...bindingElements(element.name)]
  );
}

export function bindingElementPropertyName(element: BindingElement): string | undefined {
  if (element.propertyName?.kind === "Identifier") {
    return element.propertyName.name;
  }
  if (element.propertyName?.kind === "StringLiteral") {
    return element.propertyName.value;
  }
  if (element.name.kind === "Identifier") {
    return element.name.name;
  }
  return undefined;
}

export function bindingNameText(binding: BindingName): string {
  if (binding.kind === "Identifier") return binding.name;
  const names = bindingIdentifiers(binding).map((identifier) => identifier.name).join(", ");
  return binding.kind === "ObjectBindingPattern" ? `{ ${names} }` : `[${names}]`;
}
