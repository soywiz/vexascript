# JSON import shape was missing from the LSP

## Symptom

The compiler resolved a local `import data from "./data.json"`, but the editor treated `data` as `unknown`. As a result, member hover and type checking could not see properties such as `data.title`, even though native and JavaScript module paths already understood JSON imports.

## Investigation

The shared module resolver found the JSON file correctly. The LSP import collector then followed the normal source-module path, which only collects declarations from parsed VexaScript/TypeScript modules and only processes named imports when building local imported symbols. A raw JSON file therefore never contributed a type for its default import.

## Fix

Local JSON imports now read and parse the resolved file through the active VFS and recursively convert JSON values into analysis types: objects expose their properties, arrays combine their element types, and scalar values map to the corresponding built-in types. Member-definition navigation also scans the JSON source and returns the exact property-key range for accesses such as `data.title`. The behavior is covered by focused imported-symbol, hover, and go-to-definition tests.

## Regression prevention

Keep the LSP fixture separate from runtime samples. Runtime support and editor type support use different paths, so a sample that executes successfully does not prove that the editor can infer the JSON shape.
