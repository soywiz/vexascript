import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { format } from "node:util"
import util from "node:util"

async function main() {
  const folder = tmpdir()
  const file = `${folder}/vexa.sample.tmp`
  console.log(join("hello", "world"))
  await writeFile(file, "test")
  console.log(await readFile(file, "utf-8"))
  const bytes = await readFile(file)
  const hex = await readFile(file, 'hex')
  console.log(util.format("00%d", 10))
  console.log(hex)
  console.log(bytes[0])
}

await main()
