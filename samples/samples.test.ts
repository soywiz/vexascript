import { describe, expect, format, it, readFile, readdir } from "../compiler/test/expect";
import { runFile } from "../cli/cli";
import {
    createBundledModuleArtifacts,
    ensureCompilerRuntimePrograms,
    ensureRuntimeDependencies,
    resolveProjectForSource
} from "../cli/cliShared";
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
        if ((await fileExists(rpackageJson)) && !(await fileExists(rnodeModules))) {
            // pnpm install
            await runCommand("pnpm", ["install"], { cwd: rfile })
        }

        if (await fileExists(rexpected)) {
            it(`sample ${file}`, async () => {
                const expected = await readFile(rexpected, 'utf-8')
                const result = await hookOutput(async () => {
                    await runFile(`${rfile}/main.vx`, "conservative")
                })

                expect(result.trim()).toBe(expected.trim())
            })
            continue
        }

        const project = await resolveProjectForSource(rfile)
        const entrypoint = project?.bundleEntrypoint
        if (!entrypoint) continue

        it(`sample ${file} bundles entrypoint`, async () => {
            await ensureRuntimeDependencies(entrypoint, project)
            await ensureCompilerRuntimePrograms()

            const result = await createBundledModuleArtifacts(entrypoint, "optimized", project)

            expect(result.errors).toEqual([])
            expect(result.diagnostics).toEqual([])
            expect(result.code.length).toBeGreaterThan(0)
        })
    }
})
