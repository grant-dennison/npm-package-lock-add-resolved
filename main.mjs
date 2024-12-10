#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { get } from "node:https"

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => {
        data += chunk
      })
      res.on("end", () => {
        resolve(JSON.parse(data))
      })

      res.on("error", reject)
    }).on("error", reject)
  })
}

async function fillResolved(name, p) {
  console.log(`Retrieving metadata for ${name}@${p.version}`)
  const metadataUrl = `https://registry.npmjs.com/${name}/${p.version}`
  const metadata = await fetchJson(metadataUrl)

  p.resolved = metadata.dist.tarball
  p.integrity = metadata.dist.integrity
}

async function fillAllResolved(list, recursive) {
  for (const packagePath in list) {
    if (packagePath === "") {
      continue
    }
    const p = list[packagePath]
    if (p.resolved && p.integrity) {
      continue
    }

    const packageName = packagePath.replace(/^.*node_modules\/(?=.+?$)/, "")
    await fillResolved(packageName, p)

    if (recursive && p.dependencies) {
      await fillAllResolved(p.dependencies)
    }
  }
}

const oldContents = await readFile("package-lock.json", "utf-8")
const packageLock = JSON.parse(oldContents)

console.log("Checking `packages` (v2/v3 package-lock.json)...")
await fillAllResolved(packageLock.packages ?? [], false)
console.log("Checking `dependencies` (v1 package-lock.json)...")
await fillAllResolved(packageLock.dependencies ?? [], true)

await writeFile("package-lock.json", JSON.stringify(packageLock, null, 2))

try {
  console.log("Running npm install to validate and reformat...")
  spawnSync("npm", ["install"], { stdio: "inherit", shell: true })
} catch (e) {
  console.error("Rolling back package-lock.json changes")
  await writeFile("package-lock.json", oldContents)
  throw e
}

console.log("Done!")
