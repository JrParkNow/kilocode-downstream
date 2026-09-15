import * as vscode from "vscode"
import { getWebviewFontSize } from "../utils"

export function watchFontSizeConfig(
  post: (msg: { type: "fontSizeChanged"; fontSize: number }) => void,
  next?: vscode.Disposable,
) {
  const font = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("hybrid-ai-runtime.kilo-code.fontSize"))
      post({ type: "fontSizeChanged", fontSize: getWebviewFontSize() })
  })
  return next ? vscode.Disposable.from(font, next) : font
}
