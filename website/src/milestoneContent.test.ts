import { readFile, readdir } from "node:fs/promises";
import { assert, dirname, fileURLToPath, resolve, test } from "../../compiler/test/expect";

const testDirectory = dirname(fileURLToPath(import.meta.url));

async function readWebsiteSource(path: string): Promise<string> {
  return await readFile(resolve(testDirectory, path), "utf8");
}

test("the concise syntax guide documents postfix receiver blocks", async () => {
  const differences = await readFile(resolve(testDirectory, "..", "..", "docs", "syntax.differences.md"), "utf8");

  assert.match(differences, /### Postfix receiver blocks/m);
  assert.match(differences, /value\. \{ \.\.\. \}/m);
  assert.match(differences, /returns the same value/m);
});

test("the samples page places postfix receiver blocks beside the cascade operator", async () => {
  const samples = await readWebsiteSource("samples.njk");

  assert.match(samples, /<h3>Cascade operator<\/h3>[\s\S]*<h3>Postfix receiver blocks<\/h3>/m);
  assert.match(samples, /val badge = new Graphics\(\)\. \{/m);
});

test("the samples page demonstrates receiver functions in Extensions and Calls", async () => {
  const samples = await readWebsiteSource("samples.njk");

  assert.match(samples, /<h2 class="samples-group-heading">Extensions &amp; Calls<\/h2>[\s\S]*<h3>Receiver functions<\/h3>/m);
  assert.match(samples, /fun <T> T\.apply\(block: T\.\(\) => T\) \{ block\(this\); return this \}/m);
});

test("the public website describes native compilation, FFI, and self-hosting", async () => {
  const [home, cli, syntax] = await Promise.all([
    readWebsiteSource("index.njk"),
    readWebsiteSource("cli.njk"),
    readWebsiteSource("syntax.njk"),
  ]);

  assert.match(home, /native C\+\+/i);
  assert.match(home, /FFI/);
  assert.match(home, /compile itself/i);
  assert.match(cli, /\.vx.*\.ts/i);
  assert.doesNotMatch(cli, /FFILibrary/);
  assert.match(syntax, /FFILibrary/);
});

test("the blog records the requested compiler milestones", async () => {
  const blogDirectory = resolve(testDirectory, "blog");
  const postNames = (await readdir(blogDirectory)).filter((name) => name.endsWith(".md"));
  const posts = await Promise.all(postNames.map(async (name) => await readFile(resolve(blogDirectory, name), "utf8")));
  const combined = posts.join("\n");

  for (const title of [
    "VexaScript compiles itself",
    "VexaScript gains a native C++ backend",
    "The native compiler completes its first self-host",
    "Native VexaScript becomes faster than Node.js",
    "One FFI surface for Deno and native C++",
    "Oilpan and mimalloc power VexaScript native memory",
    "Pixi serve rebuilds fall from 200 ms to about 50 ms",
    "Engineering journals and repository-local skills",
    "From VexaScript 0.9.0 to 0.10.0: one language, two backends, a tested toolchain",
  ]) {
    assert.match(combined, new RegExp(`title: "?${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`));
  }
});

test("milestone posts include technical subsections and evidence tables", async () => {
  for (const name of [
    "typescript-self-hosting.md",
    "native-cpp-backend.md",
    "native-self-hosting.md",
    "native-faster-than-node.md",
    "pixi-incremental-serve.md",
    "cross-backend-ffi.md",
    "engineering-journals-and-skills.md",
    "oilpan-and-mimalloc.md",
    "vexa-0.10.0.md",
  ]) {
    const post = await readWebsiteSource(`blog/${name}`);
    assert.match(post, /^## \*\*.+\*\*$/m, `${name} should have explicit technical subsections`);
    assert.match(post, /^\| .+ \|$/m, `${name} should include an evidence table`);
    assert.ok(post.length >= 3_000, `${name} should be detailed enough to preserve technical context`);
  }
});
