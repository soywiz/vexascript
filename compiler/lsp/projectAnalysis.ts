export type {
  ProjectContext,
  ProjectImportBinding,
  ProjectIndex,
  ProjectSessionLike,
  ProjectTopLevelDeclaration
} from "compiler/analysis/projectIndex";

export {
  getProjectIndex,
  getProjectSessionForFilePath,
  scanProjectMyFiles
} from "compiler/analysis/projectIndex";
