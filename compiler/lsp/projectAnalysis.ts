export type {
  ProjectContext,
  ProjectImportBinding,
  ProjectIndex,
  ProjectSessionLike,
  ProjectTopLevelDeclaration,
  ProjectTopLevelDeclarationKind
} from "compiler/analysis/projectIndex";

export {
  getProjectIndex,
  getProjectSessionForFilePath,
  scanProjectMyFiles
} from "compiler/analysis/projectIndex";
