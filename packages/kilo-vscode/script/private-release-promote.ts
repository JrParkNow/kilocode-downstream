#!/usr/bin/env bun

import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { basename, join } from "node:path"

const root = join(import.meta.dir, "..")
const repoRoot = join(root, "..", "..")

const EXPECTED_EXTENSION_ID = "hybrid-ai-runtime.kilo-code"

const releaseVersion = process.env.PRIVATE_RELEASE_VERSION?.trim()
const rollbackVersion = process.env.ROLLBACK_VERSION?.trim()

if (!releaseVersion) {
  throw new Error(
    "PRIVATE_RELEASE_VERSION is required, for example PRIVATE_RELEASE_VERSION=7.6.2-hybrid.1",
  )
}

if (!rollbackVersion) {
  throw new Error(
    "ROLLBACK_VERSION is required, for example ROLLBACK_VERSION=7.6.2-snapshot+d180de31ee.soul",
  )
}

const status = (await $`git status --porcelain`.cwd(repoRoot).text()).trim()

if (status) {
  throw new Error(
    "Refusing to promote a private release from a dirty working tree",
  )
}

const releaseDir = join(
  repoRoot,
  "artifacts",
  "private-releases",
  releaseVersion,
)

const rollbackDir = join(
  repoRoot,
  "artifacts",
  "private-releases",
  "rollback-baseline",
  rollbackVersion,
)

const manifestPath = join(releaseDir, "manifest.json")
const sumsPath = join(releaseDir, "SHA256SUMS")
const acceptancePath = join(releaseDir, "acceptance.json")

if (!existsSync(manifestPath)) {
  throw new Error(`Candidate manifest not found: ${manifestPath}`)
}

if (!existsSync(sumsPath)) {
  throw new Error(`Candidate SHA256SUMS not found: ${sumsPath}`)
}

if (existsSync(acceptancePath)) {
  throw new Error(
    `Release is already promoted because acceptance.json exists: ${acceptancePath}`,
  )
}

const manifest = await Bun.file(manifestPath).json()

if (manifest?.schema_version !== 1) {
  throw new Error(
    `Unsupported candidate manifest schema: ${manifest?.schema_version}`,
  )
}

if (manifest?.extension?.id !== EXPECTED_EXTENSION_ID) {
  throw new Error(
    `Unexpected candidate extension identity: ${manifest?.extension?.id}`,
  )
}

if (manifest?.extension?.version !== releaseVersion) {
  throw new Error(
    `Candidate manifest version ${manifest?.extension?.version} does not match requested release ${releaseVersion}`,
  )
}

const artifactFilename = manifest?.artifact?.filename
const manifestArtifactSha256 = manifest?.artifact?.sha256
const sourceCommit = manifest?.downstream?.commit

if (!artifactFilename || !manifestArtifactSha256 || !sourceCommit) {
  throw new Error(
    "Candidate manifest is missing artifact filename, artifact SHA-256, or downstream commit",
  )
}

const artifactPath = join(releaseDir, artifactFilename)

if (!existsSync(artifactPath)) {
  throw new Error(`Candidate VSIX not found: ${artifactPath}`)
}

async function readPackagedExtension(path: string): Promise<any> {
  const text = await $`unzip -p ${path} extension/package.json`.text()
  return JSON.parse(text)
}

const candidatePackage = await readPackagedExtension(artifactPath)
const candidatePackageId =
  `${candidatePackage.publisher}.${candidatePackage.name}`

if (candidatePackageId !== EXPECTED_EXTENSION_ID) {
  throw new Error(
    `Candidate VSIX identity mismatch: ${candidatePackageId}`,
  )
}

if (candidatePackage.version !== releaseVersion) {
  throw new Error(
    `Candidate VSIX version ${candidatePackage.version} does not match requested release ${releaseVersion}`,
  )
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer()

  return createHash("sha256")
    .update(Buffer.from(bytes))
    .digest("hex")
}

const actualArtifactSha256 = await sha256File(artifactPath)

if (actualArtifactSha256 !== manifestArtifactSha256) {
  throw new Error(
    `Candidate VSIX checksum mismatch: manifest=${manifestArtifactSha256} actual=${actualArtifactSha256}`,
  )
}

const sums = await Bun.file(sumsPath).text()
const expectedSumLine = `${actualArtifactSha256}  ${artifactFilename}`

if (!sums.split(/\r?\n/).includes(expectedSumLine)) {
  throw new Error(
    `SHA256SUMS does not contain the verified candidate checksum for ${artifactFilename}`,
  )
}

const sourceCommitExists = await $`git cat-file -e ${sourceCommit}^{commit}`
  .cwd(repoRoot)
  .nothrow()

if (sourceCommitExists.exitCode !== 0) {
  throw new Error(
    `Candidate source commit does not exist in this repository: ${sourceCommit}`,
  )
}

const sourceIsAncestor = await $`git merge-base --is-ancestor ${sourceCommit} HEAD`
  .cwd(repoRoot)
  .nothrow()

if (sourceIsAncestor.exitCode !== 0) {
  throw new Error(
    `Candidate source commit ${sourceCommit} is not an ancestor of current HEAD`,
  )
}

const rollbackVsixFiles = Array.from(
  new Bun.Glob("*.vsix").scanSync({
    cwd: rollbackDir,
    onlyFiles: true,
  }),
)

if (rollbackVsixFiles.length !== 1) {
  throw new Error(
    `Expected exactly one rollback VSIX in ${rollbackDir}, found ${rollbackVsixFiles.length}`,
  )
}

const rollbackFilename = rollbackVsixFiles[0]
const rollbackPath = join(rollbackDir, rollbackFilename)
const rollbackSumsPath = join(rollbackDir, "SHA256SUMS")

const rollbackPackage = await readPackagedExtension(rollbackPath)
const rollbackPackageId =
  `${rollbackPackage.publisher}.${rollbackPackage.name}`

if (rollbackPackageId !== EXPECTED_EXTENSION_ID) {
  throw new Error(
    `Rollback VSIX identity mismatch: ${rollbackPackageId}`,
  )
}

if (rollbackPackage.version !== rollbackVersion) {
  throw new Error(
    `Rollback VSIX version ${rollbackPackage.version} does not match requested rollback ${rollbackVersion}`,
  )
}

if (!existsSync(rollbackSumsPath)) {
  throw new Error(`Rollback SHA256SUMS not found: ${rollbackSumsPath}`)
}

const rollbackSha256 = await sha256File(rollbackPath)
const rollbackSums = await Bun.file(rollbackSumsPath).text()
const expectedRollbackSumLine = `${rollbackSha256}  ${rollbackFilename}`

if (!rollbackSums.split(/\r?\n/).includes(expectedRollbackSumLine)) {
  throw new Error(
    `Rollback SHA256SUMS does not contain the verified checksum for ${rollbackFilename}`,
  )
}

const acceptance = {
  schema_version: 1,
  status: "accepted",

  extension: {
    id: EXPECTED_EXTENSION_ID,
    version: releaseVersion,
  },

  candidate: {
    artifact_filename: basename(artifactPath),
    artifact_sha256: actualArtifactSha256,
    source_commit: sourceCommit,
  },

  rollback: {
    version: rollbackVersion,
    artifact_filename: rollbackFilename,
    artifact_sha256: rollbackSha256,
  },
}

await Bun.write(
  acceptancePath,
  `${JSON.stringify(acceptance, null, 2)}\n`,
)

console.log("Private release promoted")
console.log(`  version:   ${releaseVersion}`)
console.log(`  artifact:  ${artifactFilename}`)
console.log(`  sha256:    ${actualArtifactSha256}`)
console.log(`  source:    ${sourceCommit}`)
console.log(`  rollback:  ${rollbackVersion}`)
console.log(`  record:    ${acceptancePath}`)
