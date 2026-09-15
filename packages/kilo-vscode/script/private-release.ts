#!/usr/bin/env bun

import { $ } from "bun"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

const root = join(import.meta.dir, "..")
const repoRoot = join(root, "..", "..")
const pkgPath = join(root, "package.json")
const lockPath = join(repoRoot, "bun.lock")

const EXPECTED_EXTENSION_ID = "hybrid-ai-runtime.kilo-code"
const EXPECTED_UPSTREAM_VERSION = "7.6.2"
const EXPECTED_UPSTREAM_REF = "v7.6.2"

const privateRelease = process.env.PRIVATE_RELEASE?.trim()

if (!privateRelease || !/^[1-9][0-9]*$/.test(privateRelease)) {
  throw new Error(
    "PRIVATE_RELEASE must be a positive integer, for example PRIVATE_RELEASE=1",
  )
}

const status = (await $`git status --porcelain`.cwd(repoRoot).text()).trim()

if (status) {
  throw new Error(
    "Refusing to build a private release candidate from a dirty working tree",
  )
}

const pkg = await Bun.file(pkgPath).json()

const extensionId = `${pkg.publisher}.${pkg.name}`

if (extensionId !== EXPECTED_EXTENSION_ID) {
  throw new Error(
    `Unexpected extension identity: ${extensionId}; expected ${EXPECTED_EXTENSION_ID}`,
  )
}

if (pkg.version !== EXPECTED_UPSTREAM_VERSION) {
  throw new Error(
    `Unexpected base version: ${pkg.version}; expected ${EXPECTED_UPSTREAM_VERSION}`,
  )
}

const downstreamCommit = (
  await $`git rev-parse HEAD`.cwd(repoRoot).text()
).trim()

const downstreamBranch = (
  await $`git branch --show-current`.cwd(repoRoot).text()
).trim()

if (!downstreamBranch) {
  throw new Error("Refusing to build from detached HEAD")
}

const upstreamCommit = (
  await $`git rev-parse ${EXPECTED_UPSTREAM_REF}^{commit}`.cwd(repoRoot).text()
).trim()

const upstreamIsAncestor = await $`git merge-base --is-ancestor ${upstreamCommit} ${downstreamCommit}`
  .cwd(repoRoot)
  .nothrow()

if (upstreamIsAncestor.exitCode !== 0) {
  throw new Error(
    `Downstream commit ${downstreamCommit} does not descend from ${EXPECTED_UPSTREAM_REF} (${upstreamCommit})`,
  )
}

const releaseVersion = `${pkg.version}-hybrid.${privateRelease}`

console.log("Private release candidate")
console.log(`  extension: ${extensionId}`)
console.log(`  version:   ${releaseVersion}`)
console.log(`  branch:    ${downstreamBranch}`)
console.log(`  commit:    ${downstreamCommit}`)
console.log(
  `  upstream:  ${EXPECTED_UPSTREAM_REF} / ${upstreamCommit}`,
)

console.log("\n🧪 Running lifecycle contract tests...")

await $`bun test src/identity.test.ts`.cwd(root)

await $`bun test src/public-namespace.test.ts`.cwd(root)

await $`bun test src/services/cli-backend/private-cli-env.test.ts`.cwd(root)

console.log("\n📦 Preparing SDK...")

await $`bun run prepare:sdk`.cwd(root)

console.log("\n🔧 Preparing compiled CLI...")

await $`bun script/local-bin.ts --compiled`.cwd(root)

console.log("\n✅ Running production build gate...")

await $`bun run build:check:production`.cwd(root)

const postBuildStatus = (await $`git status --porcelain`.cwd(repoRoot).text()).trim()

if (postBuildStatus) {
  throw new Error(
    "Refusing to package because tests or build preparation changed the working tree",
  )
}

const outDir = join(
  repoRoot,
  "artifacts",
  "private-releases",
  releaseVersion,
)

mkdirSync(outDir, { recursive: true })

const vsixFilename =
  `kilo-code-hybrid-runtime-${releaseVersion}.vsix`

const vsixPath = join(outDir, vsixFilename)

console.log("\n📦 Packaging VSIX...")

const { createVSIX } = await import("@vscode/vsce")

await createVSIX({
  cwd: root,
  packagePath: vsixPath,
  version: releaseVersion,
  updatePackageJson: false,
  dependencies: false,
  skipLicense: true,
})

async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer()

  return createHash("sha256")
    .update(Buffer.from(bytes))
    .digest("hex")
}

const vsixSha256 = await sha256File(vsixPath)
const bunLockSha256 = await sha256File(lockPath)

const bunVersion = (await $`bun --version`.text()).trim()

const manifest = {
  schema_version: 1,

  extension: {
    id: extensionId,
    display_name: pkg.displayName,
    version: releaseVersion,
    vscode_engine: pkg.engines?.vscode ?? null,
  },

  upstream: {
    version: EXPECTED_UPSTREAM_VERSION,
    commit: upstreamCommit,
  },

  downstream: {
    commit: downstreamCommit,
    branch: downstreamBranch,
  },

  toolchain: {
    bun: bunVersion,
    bun_lock_sha256: bunLockSha256,
  },

  artifact: {
    filename: vsixFilename,
    sha256: vsixSha256,
  },
}

const manifestPath = join(outDir, "manifest.json")
const sumsPath = join(outDir, "SHA256SUMS")

await Bun.write(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
)

await Bun.write(
  sumsPath,
  `${vsixSha256}  ${vsixFilename}\n`,
)

console.log("\n✅ Private release candidate created")
console.log(`   VSIX:     ${vsixPath}`)
console.log(`   SHA-256:  ${vsixSha256}`)
console.log(`   Manifest: ${manifestPath}`)
console.log(`   Checksums:${sumsPath}`)
