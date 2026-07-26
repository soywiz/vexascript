const { register } = require("node:module");
const { pathToFileURL } = require("node:url");

const registrationUrl = pathToFileURL(__filename);
register(new URL("./textModuleLoader.cjs", registrationUrl), registrationUrl);
