export {
  loadAmbientTypesForProject,
  type AmbientTypesResult,
  type AmbientModuleLocation
} from "./lsp/ambientTypesLoader";
export {
  resolveAmbientNamedImportType,
  ambientModuleHasNamedExport
} from "./lsp/importedDeclarations";
