import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSyntaxDocument, renderMarkdownDocument } from "./src/siteContent.mjs";
import { renderHighlightedCodeBlock } from "./src/syntaxHighlight.mjs";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(configDirectory, "..");

export default function eleventyConfig(config) {
  config.addPassthroughCopy({ "src/assets/generated": "assets/generated" });
  config.addPassthroughCopy({ "src/assets/site.css": "assets/site.css" });
  config.addPassthroughCopy({ "src/assets/favicon.svg": "favicon.svg" });

  config.addShortcode("year", function() {
    return String(new Date().getUTCFullYear());
  });
  config.addPairedShortcode("highlightVexaScript", function(content) {
    return renderHighlightedCodeBlock(String(content).trim(), "vexa");
  });
  config.addGlobalData("syntaxDocumentHtml", async function() {
    const syntaxDocument = await loadSyntaxDocument(projectRoot);
    return renderMarkdownDocument(syntaxDocument);
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      output: "_site"
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
}
