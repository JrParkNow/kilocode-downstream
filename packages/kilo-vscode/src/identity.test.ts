import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  EXTENSION_DISPLAY_NAME,
  EXTENSION_ID,
  EXTENSION_NAME,
  EXTENSION_PUBLISHER,
} from "./identity"

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)

describe("downstream extension identity", () => {
  test("uses the private Hybrid Runtime identity", () => {
    expect(EXTENSION_PUBLISHER).toBe("hybrid-ai-runtime")
    expect(EXTENSION_NAME).toBe("kilo-code")
    expect(EXTENSION_ID).toBe("hybrid-ai-runtime.kilo-code")
    expect(EXTENSION_DISPLAY_NAME).toBe("Kilo Code — Hybrid Runtime")
  })

  test("agrees with the packaged VS Code extension identity", () => {
    expect(packageJson.publisher).toBe(EXTENSION_PUBLISHER)
    expect(packageJson.name).toBe(EXTENSION_NAME)
    expect(`${packageJson.publisher}.${packageJson.name}`).toBe(EXTENSION_ID)
    expect(packageJson.displayName).toBe(EXTENSION_DISPLAY_NAME)
  })
})
