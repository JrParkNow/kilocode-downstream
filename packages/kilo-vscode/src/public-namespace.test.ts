import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)

const PREFIX = "hybrid-ai-runtime.kilo-code"

describe("private extension public namespace", () => {
  test("all commands use the downstream namespace", () => {
    const commands = (pkg.contributes?.commands ?? []).map(
      (entry: { command: string }) => entry.command,
    )

    expect(commands.length).toBeGreaterThan(0)

    for (const command of commands) {
      expect(command.startsWith(`${PREFIX}.`)).toBe(true)
    }
  })

  test("all configuration keys use the downstream namespace", () => {
    const blocks = Array.isArray(pkg.contributes?.configuration)
      ? pkg.contributes.configuration
      : [pkg.contributes?.configuration].filter(Boolean)

    const keys = blocks.flatMap((block: { properties?: Record<string, unknown> }) =>
      Object.keys(block.properties ?? {}),
    )

    expect(keys.length).toBeGreaterThan(0)

    for (const key of keys) {
      expect(key.startsWith(`${PREFIX}.`)).toBe(true)
    }
  })

  test("views and task type are independently identified", () => {
    expect(pkg.contributes.viewsContainers.activitybar[0].id).toBe(
      "hybrid-ai-runtime-kilo-code-ActivityBar",
    )

    expect(pkg.contributes.views["hybrid-ai-runtime-kilo-code-ActivityBar"][0].id).toBe(
      "hybrid-ai-runtime-kilo-code-SidebarProvider",
    )

    expect(pkg.contributes.taskDefinitions[0].type).toBe(
      "hybrid-ai-runtime-kilo-worktree-setup",
    )
  })

  test("submenus use the downstream namespace", () => {
    for (const submenu of pkg.contributes?.submenus ?? []) {
      expect(submenu.id.startsWith(`${PREFIX}.`)).toBe(true)
    }
  })
})
