export default function eleventyConfig(config) {
  config.addPassthroughCopy({ "src/assets/generated": "assets/generated" });
  config.addPassthroughCopy({ "src/assets/site.css": "assets/site.css" });

  config.addShortcode("year", () => String(new Date().getUTCFullYear()));

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
