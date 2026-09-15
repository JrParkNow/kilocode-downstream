import * as path from "path"

export function resolvePrivateCliEnv(storageRoot: string): Record<string, string> {
  const root = path.join(storageRoot, "cli")

  return {
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
}
