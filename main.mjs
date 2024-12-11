#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { get } from "node:https"

let changesMade = false

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => {
        data += chunk
      })
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data))
        } else {
          reject(`${url} returned ${res.statusCode} ${res.statusMessage}`)
        }
      })

      res.on("error", reject)
    }).on("error", reject)
  })
}

async function fillResolved(name, p) {
  const version = p.version.replace(/^.*@/, "")
  console.log(`Retrieving metadata for ${name}@${version}`)
  const metadataUrl = `https://registry.npmjs.com/${name}/${version}`
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
    if (!p.resolved || !p.integrity) {
      const packageName =
        p.name ||
        /^npm:(.+?)@.+$/.exec(p.version)?.[1] ||
        packagePath.replace(/^.*node_modules\/(?=.+?$)/, "")
      await fillResolved(packageName, p)
      changesMade = true
    }

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

if (changesMade) {
  const newContents = JSON.stringify(packageLock, null, 2) + "\n"
  await writeFile("package-lock.json", newContents)

  try {
    console.log("Running npm install to validate and reformat...")
    spawnSync("npm", ["install"], { stdio: "inherit", shell: true })
  } catch (e) {
    console.error("Rolling back package-lock.json changes")
    await writeFile("package-lock.json", oldContents)
    throw e
  }
}

console.log("Done!")
