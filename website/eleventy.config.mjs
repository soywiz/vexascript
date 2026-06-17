import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSyntaxDocument, loadDifferencesDocument, loadSyntaxAiDocument, renderMarkdownDocument } from "./src/siteContent.mjs";
import { renderHighlightedCodeBlock } from "./src/syntaxHighlight.mjs";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(configDirectory, "..");

async function versionedAssetHref(sourceRelativePath, publicPath) {
  const assetPath = resolve(configDirectory, sourceRelativePath);
  try {
    const { mtimeMs } = await stat(assetPath);
    return `${publicPath}?v=${Math.trunc(mtimeMs)}`;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return publicPath;
    }
    throw error;
  }
}

function htmlDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function readableDate(date) {
  return new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export default function eleventyConfig(config) {
  config.addFilter("htmlDateString", htmlDateString);
  config.addFilter("readableDate", readableDate);

  config.addCollection("blog", function(collectionApi) {
    return collectionApi.getFilteredByTag("blog").sort((a, b) => a.date - b.date);
  });
  config.addPassthroughCopy({ "src/assets/generated": "assets/generated" });
  config.addPassthroughCopy({ "src/assets/site.css": "assets/site.css" });
  config.addPassthroughCopy({ "src/assets/favicon.svg": "favicon.svg" });
  config.addPassthroughCopy({ "src/assets/favicon.png": "favicon.png" });

  config.addFilter("jsonEncode", (value) => JSON.stringify(value));
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
  config.addGlobalData("differencesDocumentHtml", async function() {
    const differencesDocument = await loadDifferencesDocument(projectRoot);
    return renderMarkdownDocument(differencesDocument);
  });
  config.addGlobalData("syntaxAiDocumentHtml", async function() {
    const doc = await loadSyntaxAiDocument(projectRoot);
    return renderMarkdownDocument(doc);
  });
  config.addGlobalData("syntaxAiDocumentRaw", async function() {
    return await loadSyntaxAiDocument(projectRoot);
  });
  config.addGlobalData("generatedAssetHrefs", async function() {
    return {
      siteCss: await versionedAssetHref("src/assets/site.css", "/assets/site.css"),
      generatedStyleCss: await versionedAssetHref("src/assets/generated/style.css", "/assets/generated/style.css"),
      generatedEmbedJs: await versionedAssetHref("src/assets/generated/vexa-embed.js", "/assets/generated/vexa-embed.js"),
    };
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
