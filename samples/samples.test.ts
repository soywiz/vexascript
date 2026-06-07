import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path";
import { it, describe } from "node:test";
import { expect } from "../compiler/test/expect";
import { runFile } from "../compiler/cli";
import { spawnSync } from "node:child_process";

async function hookOutput(callback: () => Promise<void>) {
    const lines = [] as string[]
    const oldLog = console.log
    try {
        console.log = (...params: any[]) => {
            lines.push([...params].join(" "))
        }
        await callback()
    } finally {
        console.log = oldLog
    }
    return lines.join("\n")
}

describe("samples test", async () => {
    const rootDir = import.meta.dirname
    for (const file of readdirSync(rootDir)) {
        const rfile = `${rootDir}/${file}`
        const rexpected = `${rfile}/expected.txt`
        const rpackageJson = `${rfile}/package.json`
        const rnodeModules = `${rfile}/node_modules`

        if (!statSync(rfile).isDirectory()) continue
        if (!existsSync(rexpected)) continue
        if (existsSync(rpackageJson) && !existsSync(rnodeModules)) {
            // pnpm install
            spawnSync("pnpm", ["install"], { cwd: rfile })
        }

        it(`sample ${file}`, async () => {
            //console.log(rfile)

            const expected = readFileSync(rexpected, 'utf-8')
            const result = await hookOutput(async () => {
                await runFile(`${rfile}/main.my`, "conservative")
            })
            
            expect(result.trim()).toBe(expected.trim())
        })
    }
})