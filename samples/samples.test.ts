import { readdir, readFile } from "node:fs/promises"
import { format } from "node:util";
import { describe, expect, it } from "../compiler/test/expect";
import { runFile } from "../cli/cli";
import { fileExists, isDirectory } from "../compiler/utils/fs";
import { runCommand } from "../cli/io";

async function hookOutput(callback: () => Promise<void>) {
    const lines = [] as string[]
    const oldLog = console.log
    try {
        console.log = (...params: any[]) => {
            lines.push(format(...params))
        }
        await callback()
    } finally {
        console.log = oldLog
    }
    return lines.join("\n")
}

describe("samples test", async () => {
    const rootDir = import.meta.dirname
    for (const file of await readdir(rootDir)) {
        const rfile = `${rootDir}/${file}`
        const rexpected = `${rfile}/expected.txt`
        const rpackageJson = `${rfile}/package.json`
        const rnodeModules = `${rfile}/node_modules`

        if (!(await isDirectory(rfile))) continue
        if (!(await fileExists(rexpected))) continue
        if ((await fileExists(rpackageJson)) && !(await fileExists(rnodeModules))) {
            // pnpm install
            await runCommand("pnpm", ["install"], { cwd: rfile })
        }

        it(`sample ${file}`, async () => {
            //console.log(rfile)

            const expected = await readFile(rexpected, 'utf-8')
            const result = await hookOutput(async () => {
                await runFile(`${rfile}/main.vx`, "conservative")
            })
            
            expect(result.trim()).toBe(expected.trim())
        })
    }
})
