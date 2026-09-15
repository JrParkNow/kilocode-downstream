import { describe, expect, test } from "bun:test"
import * as path from "path"
import { resolvePrivateCliEnv } from "./private-cli-env"

describe("resolvePrivateCliEnv", () => {
  test("isolates all XDG roots beneath extension-owned storage", () => {
    const storage = path.join("/tmp", "hybrid-runtime-storage")

    expect(resolvePrivateCliEnv(storage)).toEqual({
      XDG_DATA_HOME: path.join(storage, "cli", "data"),
      XDG_CONFIG_HOME: path.join(storage, "cli", "config"),
      XDG_STATE_HOME: path.join(storage, "cli", "state"),
      XDG_CACHE_HOME: path.join(storage, "cli", "cache"),
    })
  })
})
