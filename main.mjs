#!/usr/bin/env node

import assert from "node:assert"
import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"

const oldContents = await readFile("package-lock.json", "utf-8")
const packageLock = JSON.parse(oldContents)

async function fillResolved(name, p) {
  const metadataUrl = `https://registry.npmjs.com/${name}/${p.version}`
  const response = await fetch(metadataUrl)
  assert(response.ok)
  const metadata = await response.json()

  p.resolved = metadata.dist.tarball
  p.integrity = metadata.dist.integrity
}

async function fillAllResolved(list) {
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

    if (p.dependencies) {
      fillAllResolved(p.dependencies)
    }
  }
}

await fillAllResolved(packageLock.packages ?? [])
await fillAllResolved(packageLock.dependencies ?? [])

await writeFile("package-lock.json", JSON.stringify(packageLock, null, 2))

try {
  // npm install will validate and reformat
  spawnSync('npm', ['install'], { stdio: 'inherit', shell: true })
} catch (e) {
  console.error("Rolling back package-lock.json changes")
  await writeFile("package-lock.json", oldContents)
  throw e
}
