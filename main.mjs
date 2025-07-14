#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { get } from "node:https"
import { homedir } from "node:os"
import { join } from "node:path"
import { URL } from "node:url"

// --- Global Configuration Storage ---
let defaultNpmRegistry = "https://registry.npmjs.com/" // Default registry
const scopedRegistries = {} // Stores { "@scope": "https://scoped-registry.com/" }
const registryAuthTokens = {} // Stores { "https://registry.com/": "your_auth_token" }
const registryUsernames = {} // Stores { "https://registry.com/": "username" }
const registryPasswords = {} // Stores { "https://registry.com/": "base64_encoded_password" }

// --- Helper Functions ---

/**
 * Fetches JSON data from a given URL.
 * Includes authentication headers if a token or basic auth credentials are found
 * for the associated registry key.
 * @param {string} url - The URL to fetch.
 * @param {string} [registryAuthKey] - The key (normalized registry host/path) to look up authentication.
 * @returns {Promise<object>} A promise that resolves with the parsed JSON data.
 */
function fetchJson(url, registryAuthKey) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);

    if (!options.headers) {
      options.headers = {};
    }

    // --- Authentication Logic ---
    // 1. Prioritize _authToken (Bearer)
    if (registryAuthKey && registryAuthTokens[registryAuthKey]) {
      options.headers['Authorization'] = `Bearer ${registryAuthTokens[registryAuthKey]}`;
      // console.log(`DEBUG: Adding Bearer token for ${registryAuthKey}`); // Uncomment for debugging
    }
    // 2. Fallback to username/password (Basic) if no _authToken and credentials exist
    else if (registryAuthKey && registryUsernames[registryAuthKey] && registryPasswords[registryAuthKey]) {
      const username = registryUsernames[registryAuthKey];
      const encodedPassword = registryPasswords[registryAuthKey];
      const password = Buffer.from(encodedPassword, 'base64').toString('utf8'); // Decode password
      const authString = Buffer.from(`${username}:${password}`).toString('base64');
      options.headers['Authorization'] = `Basic ${authString}`;
      // console.log(`DEBUG: Adding Basic auth for ${registryAuthKey}`); // Uncomment for debugging
    }

    get(options, (res) => {
      let data = ""
      res.on("data", (chunk) => {
        data += chunk
      })
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          // Attach status code to error for specific handling (e.g., 404)
          return reject(Object.assign(new Error(`HTTP error ${res.statusCode} for ${url}`), { statusCode: res.statusCode }));
        }
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}\nData: ${data}`))
        }
      })

      res.on("error", reject)
    }).on("error", reject)
  })
}

/**
 * Normalizes a registry URL to ensure it ends with a single trailing slash.
 * @param {string} url - The URL to normalize.
 * @returns {string} The normalized URL.
 */
function normalizeRegistryUrl(url) {
  let normalized = url.trim();
  // Remove multiple trailing slashes and ensure exactly one
  if (normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/, '') + '/';
  } else {
    normalized += '/';
  }
  return normalized;
}

/**
 * Extracts the full path-based key used in .npmrc for authentication.
 * This key format typically starts with `//` and includes the full path up to the npm endpoint.
 * E.g., for "https://pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/",
 * it returns "//pkgs.dev.azure.com/org/proj/_packaging/feed/npm/registry/".
 * @param {string} registryUrl - The full registry URL as configured or derived.
 * @returns {string} The normalized key string used for auth lookups (e.g., in `registryAuthTokens`).
 */
function getAuthKeyFromRegistryUrl(registryUrl) {
  // If the registryUrl already starts with '//', it's likely already in the .npmrc key format.
  // We just need to ensure it's normalized with a trailing slash.
  if (registryUrl.startsWith('//')) {
    return normalizeRegistryUrl(registryUrl);
  }

  try {
    const url = new URL(registryUrl);
    // Construct the string starting with '//', then hostname, port (if any), and pathname.
    // This forms the key as seen in .npmrc for paths.
    let key = `//${url.hostname}`;
    if (url.port) {
      key += `:${url.port}`;
    }
    // Append the pathname. URL.pathname includes the leading slash.
    key += url.pathname;

    // Ensure the resulting key also ends with a slash for consistency with .npmrc format.
    return normalizeRegistryUrl(key);
  } catch (e) {
    console.warn(`Could not parse registry URL for auth key extraction: ${registryUrl}. Error: ${e.message}`);
    // As a fallback, return the normalized original URL string. This might not always match if the original
    // URL didn't parse correctly or had a protocol, but it's the best we can do.
    return normalizeRegistryUrl(registryUrl);
  }
}

/**
 * Gets the correct integrity value from package metadata, preferring SHA512 'integrity'
 * but falling back to SHA1 'shasum' if necessary, formatting it as 'sha1-<base64_shasum>'.
 * @param {object} dist - The 'dist' object from package metadata.
 * @returns {string|undefined} The integrity string, or undefined if none is found.
 */
function getIntegrityFromDist(dist) {
  if (!dist) return undefined;

  // Prefer the modern 'integrity' (often SHA512)
  if (dist.integrity) {
    return dist.integrity;
  }

  // Fallback to older 'shasum' (SHA1) if integrity is not present
  // IMPORTANT FIX: Convert hex shasum to base64 before prefixing with 'sha1-'
  if (dist.shasum) {
    try {
      // Create a Buffer from the hexadecimal shasum string
      const shasumBytes = Buffer.from(dist.shasum, 'hex');
      // Convert the Buffer to a Base64 string and prepend 'sha1-'
      return `sha1-${shasumBytes.toString('base64')}`;
    } catch (e) {
      console.warn(`Failed to convert shasum "${dist.shasum}" to Base64 for integrity. Error: ${e.message}`);
      return undefined; // Return undefined if conversion fails
    }
  }

  return undefined;
}


/**
 * Reads the .npmrc file(s) and extracts registry URLs and authentication tokens/credentials.
 * Looks for .npmrc in the current directory and then in the user's home directory.
 * Settings in the project's .npmrc take precedence over home directory .npmrc.
 * @returns {Promise<void>}
 */
async function loadNpmrcRegistries() {
  // Process .npmrc files in order of precedence: home then project.
  // This means settings from later files (project) will override earlier ones (home).
  const npmrcPaths = [
    join(homedir(), ".npmrc"),
    join(process.cwd(), ".npmrc")
  ];

  for (const npmrcPath of npmrcPaths) {
    try {
      const npmrcContent = await readFile(npmrcPath, "utf-8");
      const lines = npmrcContent.split(/\r?\n/);

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip comments and empty lines
        if (trimmedLine.startsWith(';') || trimmedLine.startsWith('#') || trimmedLine === '') {
          continue;
        }

        // Handle general registry: registry=https://example.com/
        if (trimmedLine.startsWith("registry=")) {
          defaultNpmRegistry = normalizeRegistryUrl(trimmedLine.substring("registry=".length));
          console.log(`Setting default registry from ${npmrcPath}: ${defaultNpmRegistry}`);
        }
        // Handle scoped registry: @scope:registry=https://example.com/
        else if (trimmedLine.match(/^@.+:registry=/)) {
          const parts = trimmedLine.split(':registry=');
          if (parts.length === 2) {
            const scope = parts[0];
            const registryUrl = normalizeRegistryUrl(parts[1]);
            scopedRegistries[scope] = registryUrl;
            console.log(`Setting scoped registry for ${scope} from ${npmrcPath}: ${registryUrl}`);
          }
        }
        // Handle auth token for a specific registry host/path: //registry.example.com/:_authToken=
        else if (trimmedLine.includes(":_authToken=")) {
          const match = trimmedLine.match(/^(\/\/.*\/):_authToken=(.+)/);
          if (match) {
            const registryAuthKey = normalizeRegistryUrl(match[1]); // This is the exact key from .npmrc
            const token = match[2];
            registryAuthTokens[registryAuthKey] = token;
            console.log(`Found auth token for ${registryAuthKey} from ${npmrcPath}`);
          }
        }
        // Handle global _authToken for the default registry: _authToken=
        else if (trimmedLine.startsWith("_authToken=")) {
          const token = trimmedLine.substring("_authToken=".length).trim();
          // Map to the normalized auth key derived from the current default registry URL
          registryAuthTokens[getAuthKeyFromRegistryUrl(defaultNpmRegistry)] = token;
          console.log(`Found default _authToken from ${npmrcPath}`);
        }
        // Handle username for a specific registry host/path: //registry.example.com/:username=
        else if (trimmedLine.includes(":username=")) {
          const match = trimmedLine.match(/^(\/\/.*\/):username=(.+)/);
          if (match) {
            const registryAuthKey = normalizeRegistryUrl(match[1]);
            const username = match[2];
            registryUsernames[registryAuthKey] = username;
            console.log(`Found username for ${registryAuthKey} from ${npmrcPath}`);
          }
        }
        // Handle password for a specific registry host/path: //registry.example.com/:_password=
        else if (trimmedLine.includes(":_password=")) {
          const match = trimmedLine.match(/^(\/\/.*\/):_password=(.+)/);
          if (match) {
            const registryAuthKey = normalizeRegistryUrl(match[1]);
            const password = match[2]; // This is the base64 encoded password
            registryPasswords[registryAuthKey] = password;
            console.log(`Found _password for ${registryAuthKey} from ${npmrcPath}`);
          }
        }
          // Handle email for a specific registry host/path (ignored by this script for HTTP requests)
        // This is typically for npm CLI's internal use or for publish commands.
        else if (trimmedLine.includes(":email=")) {
          // console.log(`Ignoring email entry from ${npmrcPath}: ${trimmedLine}`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Could not read or parse ${npmrcPath}: ${error.message}`);
      }
    }
  }
  console.log(`Final default registry: ${defaultNpmRegistry}`);
  console.log(`Final scoped registries: ${JSON.stringify(scopedRegistries)}`);
  console.log(`Registry auth tokens configured for: ${Object.keys(registryAuthTokens)}`);
  console.log(`Registry usernames configured for: ${Object.keys(registryUsernames)}`);
  console.log(`Registry passwords configured for: ${Object.keys(registryPasswords)}`);
}


/**
 * Fills the 'resolved' and 'integrity' fields for a given package object.
 * Determines the correct registry based on package scope.
 * If a 404 is received for a specific version, it attempts to fetch full metadata
 * and extract the version from there.
 * @param {string} name - The name of the package.
 * @param {object} p - The package object from the package-lock.json.
 */
async function fillResolved(name, p) {
  let registryToUse = defaultNpmRegistry;

  // Check if the package name has a scope and if a registry is defined for that scope
  if (name.startsWith('@')) {
    const scopeMatch = name.match(/^@[^/]+/); // Matches @scope, e.g., "@myorg"
    if (scopeMatch) {
      const scope = scopeMatch[0];
      if (scopedRegistries[scope]) {
        registryToUse = scopedRegistries[scope];
        console.log(`Using scoped registry for ${name}: ${registryToUse}`);
      }
    }
  }

  // Get the normalized key for auth lookups (e.g., //pkgs.dev.azure.com/.../npm/registry/)
  const registryAuthKey = getAuthKeyFromRegistryUrl(registryToUse);

  const specificVersionMetadataUrl = `${registryToUse}${name}/${p.version}`;
  const fullPackageMetadataUrl = `${registryToUse}${name}`;

  let fetchedMetadata = null; // Store metadata here

  try {
    console.log(`Retrieving metadata for ${name}@${p.version} from ${specificVersionMetadataUrl}`);
    fetchedMetadata = await fetchJson(specificVersionMetadataUrl, registryAuthKey);
    p.resolved = fetchedMetadata.dist.tarball;
    p.integrity = getIntegrityFromDist(fetchedMetadata.dist); // Use helper for integrity

  } catch (error) {
    if (error.statusCode === 401) { // Specifically handle 401 Unauthorized
      console.error(`Authentication error (401) for ${name}@${p.version} from ${registryToUse}. Please check your .npmrc credentials.`);
      throw error; // Re-throw 401 immediately as it's a critical auth issue
    }
    if (error.statusCode === 404) {
      console.warn(`Specific version ${name}@${p.version} not found (404). Attempting to fetch full package metadata from ${fullPackageMetadataUrl}`);
      try {
        fetchedMetadata = await fetchJson(fullPackageMetadataUrl, registryAuthKey);

        if (!fetchedMetadata.versions || !fetchedMetadata.versions[p.version]) {
          throw new Error(`Version ${p.version} not found in full metadata for ${name} from ${fullPackageMetadataUrl}`);
        }

        const versionMetadata = fetchedMetadata.versions[p.version];
        // Ensure dist and at least one of tarball/integrity/shasum exist
        if (!versionMetadata.dist || (!versionMetadata.dist.tarball && !versionMetadata.dist.integrity && !versionMetadata.dist.shasum)) {
          throw new Error(`'dist' or 'tarball'/'integrity'/'shasum' missing for version ${p.version} in full metadata for ${name}`);
        }

        p.resolved = versionMetadata.dist.tarball;
        p.integrity = getIntegrityFromDist(versionMetadata.dist); // Use helper for integrity
        console.log(`Successfully extracted ${name}@${p.version} details from full metadata.`);

      } catch (fullMetadataError) {
        throw new Error(`Failed to retrieve or parse full metadata for ${name} to find version ${p.version}: ${fullMetadataError.message}`);
      }
    } else {
      // Re-throw other types of errors (e.g., network issues, 5xx server errors)
      throw new Error(`Failed to retrieve metadata for ${name}@${p.version} from ${registryToUse}: ${error.message}`);
    }
  }

  // --- Final validation after trying all methods ---
  if (!p.resolved) {
    throw new Error(`Failed to obtain 'resolved' URL for ${name}@${p.version} from ${registryToUse}. Metadata missing 'dist.tarball'.`);
  }
  if (!p.integrity) {
    // This is the specific case where Azure might only provide shasum, and we fail to get it.
    // Or if public registry doesn't provide integrity.
    throw new Error(`Failed to obtain 'integrity' hash for ${name}@${p.version} from ${registryToUse}. Metadata missing 'dist.integrity' and 'dist.shasum'.`);
  }
}

/**
 * Recursively fills 'resolved' and 'integrity' for all packages in a list.
 * Skips packages that are marked as 'link: true'.
 * @param {object} list - The list of packages (either `packages` or `dependencies`).
 * @param {boolean} recursive - Whether to recursively fill dependencies.
 */
async function fillAllResolved(list, recursive) {
  for (const packagePath in list) {
    if (packagePath === "") {
      continue
    }
    const p = list[packagePath]

    // Skip linked packages (npm link)
    if (p.link === true) {
      console.log(`Skipping linked package: ${packagePath}`);
      continue;
    }

    // Skip if already resolved and has integrity (assuming it's complete)
    if (p.resolved && p.integrity) {
      continue
    }

    const packageName = packagePath.replace(/^.*node_modules\/(?=.+?$)/, "")
    try {
      await fillResolved(packageName, p)
    } catch (e) {
      console.warn(`Skipping package ${packageName} due to error: ${e.message}`);
      // Continue to the next package even if one fails to fill, to process others
    }

    // Recursively check dependencies if 'recursive' flag is true and dependencies exist
    if (recursive && p.dependencies) {
      await fillAllResolved(p.dependencies, recursive)
    }
  }
}

// --- Main Execution Flow ---
async function main() {
  // IMPORTANT: This must be called first to load .npmrc configuration
  await loadNpmrcRegistries();

  const oldContents = await readFile("package-lock.json", "utf-8");
  const packageLock = JSON.parse(oldContents);

  console.log("Checking `packages` (v2/v3 package-lock.json)...");
  // Ensure we pass an empty object if packages is null/undefined to avoid errors
  await fillAllResolved(packageLock.packages ?? {}, false);

  console.log("Checking `dependencies` (v1 package-lock.json)...");
  // Ensure we pass an empty object if dependencies is null/undefined to avoid errors
  await fillAllResolved(packageLock.dependencies ?? {}, true);

  await writeFile("package-lock.json", JSON.stringify(packageLock, null, 2));

  try {
    console.log("Running npm install to validate and reformat...");
    // Use `shell: true` on Windows to correctly find npm, on Unix it's less critical but harmless.
    spawnSync("npm", ["install"], { stdio: "inherit", shell: true });
  } catch (e) {
    console.error("npm install failed. Rolling back package-lock.json changes.");
    await writeFile("package-lock.json", oldContents); // Rollback on error
    throw e; // Re-throw to indicate script failure
  }

  console.log("Done!");
}

// Execute the main function and catch any unhandled errors
main().catch(console.error);
