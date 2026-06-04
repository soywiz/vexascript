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

export function bindingNameText(binding: BindingName): string {
  if (binding.kind === "Identifier") return binding.name;
  const names = bindingIdentifiers(binding).map((identifier) => identifier.name).join(", ");
  return binding.kind === "ObjectBindingPattern" ? `{ ${names} }` : `[${names}]`;
}
