import * as vscode from "vscode"
import { basename } from "node:path"
import { KiloProvider } from "./KiloProvider"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
import { KiloClawProvider } from "./kiloclaw/KiloClawProvider"
import { DiffViewerProvider } from "./diff/DiffViewerProvider"
import { DocumentViewerProvider } from "./DocumentViewerProvider"
import { DiffSourceCatalog } from "./diff/sources/catalog"
import { DiffVirtualProvider } from "./DiffVirtualProvider"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { MarketplacePanelProvider } from "./MarketplacePanelProvider"
import { MarketplaceNotifier } from "./services/marketplace/notifier"
import { SubAgentViewerProvider } from "./SubAgentViewerProvider"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { registerAutocompleteProvider } from "./services/autocomplete"
import { ensureBackendForAutocomplete } from "./services/autocomplete/ensure-backend"
import { AutocompleteServiceManager } from "./services/autocomplete/AutocompleteServiceManager"
import { AttentionService, showOSNotification } from "./services/attention"
import { CaffeinationService } from "./services/caffeination"
import { confirmCaffeination } from "./services/caffeination/confirm"
import { createCaffeinationDriver } from "./services/caffeination/inhibitor"
import { BrowserBroker } from "./services/browser-automation"
import { TelemetryEventName, TelemetryProxy } from "./services/telemetry"
import { registerCommitMessageService } from "./services/commit-message"
import { registerCodeActions, registerTerminalActions, KiloCodeActionProvider } from "./services/code-actions"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { markWorkspace } from "./util/spotlight"
import { createNotebookBridge } from "./services/notebook"
import { createGitExecutable } from "./util/git-executable"
import { isCursorHost } from "./utils"
import { sameDirectory } from "./kilo-provider-utils"

let agentManager: AgentManagerProvider | undefined
let caffeination: CaffeinationService | undefined
let shuttingDown = false

const RESTORE_KEY = "kilo.workbench.restore"

type RestoreState = {
  agentManager?: boolean
}

const panelTitleHandler = (panel: vscode.WebviewPanel) => (title: string) => {
  panel.title = title || EXTENSION_DISPLAY_NAME
}

// Activated via "onStartupFinished" and "onUri" (package.json) so that commands, code actions,
// keybindings, autocomplete, commit-message generation, and URI deep links all work immediately —
// without requiring the user to open a Kilo sidebar or panel first. The CLI backend is NOT spawned here;
// it starts lazily when a webview connects or when ensureBackendForAutocomplete() triggers it.
export async function activate(context: vscode.ExtensionContext) {
  console.log("Kilo Code extension is now active")
  shuttingDown = false

  // Drives the "!hybrid-ai-runtime.kilo-code.isCursor" guards on the native view/title and
  // editor/title menu contributions — see isCursorHost() for why.
  void vscode.commands.executeCommand("setContext", "hybrid-ai-runtime.kilo-code.isCursor", isCursorHost())

  const telemetry = TelemetryProxy.getInstance()

  const browserBroker = new BrowserBroker({
    log: (...args) => console.warn("[Kilo New] BrowserBroker:", ...args),
    enabled: () => vscode.workspace.getConfiguration("hybrid-ai-runtime.kilo-code.experimental").get("browserAutomation", false),
    trusted: () => vscode.workspace.isTrusted,
    useSystemChrome: () =>
      vscode.workspace.getConfiguration("hybrid-ai-runtime.kilo-code.browserAutomation").get("useSystemChrome", true),
  })

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context, () => browserBroker.env())
  const notebookBridge = createNotebookBridge(connectionService)
  let restore = context.workspaceState.get<RestoreState>(RESTORE_KEY) ?? {}
  const remember = (patch: RestoreState) => {
    const next = { ...restore, ...patch }
    if (shuttingDown && patch.agentManager === false) next.agentManager = restore.agentManager
    restore = next
    void context.workspaceState.update(RESTORE_KEY, restore)
  }

  // Create remote status service (one status bar item for all webviews)
  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)

  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
        // Sync the CLI's PostHog client with the current consent state. The
        // CLI reads KILO_TELEMETRY_LEVEL once at spawn, so without this call
        // a fresh CLI started while VS Code telemetry was off would stay
        // opted out for the rest of the session.
        telemetry.setEnabled(vscode.env.isTelemetryEnabled)
      }
      try {
        remoteService.setClient(connectionService.getClient())
        console.log("[Kilo New] CLI connected, calling remoteService.refresh()")
        remoteService.refresh().catch((err) => console.warn("[Kilo New] initial remote refresh failed:", err))
      } catch {
        remoteService.setClient(null)
      }
      AutocompleteServiceManager.getInstance()?.load()
    } else {
      remoteService.clearState()
      remoteService.setClient(null)
    }
  })

  // Propagate runtime telemetry consent changes to the CLI subprocess so its
  // PostHog client stays in sync with the user's VS Code telemetry setting.
  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      telemetry.setEnabled(enabled)
    }),
  )

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void markWorkspace(folder.uri.fsPath, (msg) => console.warn(`[Kilo New] ${msg}`))
  }

  // Track all open tab panel providers so toolbar button commands can target them.
  // NOTE: The editor/title toolbar for tab panels intentionally omits Agent Manager
  // and Marketplace buttons (unlike the sidebar). Too many icons causes VS Code to
  // collapse them into a "..." overflow menu, hiding important buttons like Settings.
  const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()
  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  // Create the provider with shared service
  const provider = new KiloProvider(context.extensionUri, connectionService, context, {
    focusContext: "hybrid-ai-runtime.kilo-code.sidebarFocused",
  })
  provider.setRemoteService(remoteService)

  const deliver = (comments: unknown[], autoSend: boolean, sessionID?: string, directory?: string): void => {
    const target = sessionID
      ? [...tabPanels.values()].find((item) => {
          if (item.getCurrentSessionId() !== sessionID || !item.canReceiveReviewComments()) return false
          if (!directory) return true
          return [item.getSessionDirectories().get(sessionID), item.getSessionGitDirectory(sessionID)]
            .filter((value): value is string => value !== undefined)
            .some((value) => sameDirectory(value, directory))
        })
      : undefined
    const destination = target ?? provider
    void destination.appendReviewComments(comments, autoSend, sessionID)
  }
  provider.setReviewCommentsHandler(deliver)

  // Register the webview view provider for the sidebar.
  // retainContextWhenHidden keeps the webview alive when switching to other sidebar panels.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KiloProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  const skip = [
    "hybrid-ai-runtime.kilo-code.agentManagerOpen",
    "hybrid-ai-runtime.kilo-code.agentManager.showTerminal",
    "hybrid-ai-runtime.kilo-code.agentManager.previousTerminal",
    "hybrid-ai-runtime.kilo-code.agentManager.nextTerminal",
  ]
  if (process.platform === "darwin") skip.push("hybrid-ai-runtime.kilo-code.agentManager.runScript")
  ensureCommandsSkipShell(skip)

  // Create KiloClaw chat provider for editor panel
  const kiloClawProvider = new KiloClawProvider(context.extensionUri, connectionService)
  context.subscriptions.push(kiloClawProvider)

  // Create Agent Manager provider for editor panel
  const reason = vscode.env.remoteName ? "Keep Awake is only available in a local VS Code window." : undefined
  const awake = new CaffeinationService(connectionService, createCaffeinationDriver({ reason }))
  caffeination = awake
  let previous = awake.getState()
  const unsubscribeCaffeination = awake.onChange((state) => {
    const prior = previous
    previous = state
    if (state.error && state.error !== prior.error) {
      void vscode.window.showErrorMessage(`Keep Awake stopped: ${state.error}`)
      return
    }
    if (state.enabled === prior.enabled) return
    void vscode.window.showInformationMessage(
      state.enabled ? "Keep Awake enabled. Kilo will prevent system sleep while agents work." : "Keep Awake disabled.",
    )
  })
  context.subscriptions.push({ dispose: unsubscribeCaffeination })
  const toggle = confirmCaffeination(awake, async () => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage("Trust this workspace before enabling Keep Awake.")
      return false
    }
    if (context.globalState.get<boolean>("caffeination.confirmed") === true) return true
    const detail = [
      "Keep Awake prevents system sleep while Kilo sessions are in progress, including some waits for approval. It does not keep the display on or disable screen locking. It turns off when this VS Code window reloads.",
      "Agents may continue to access files, network services, and available credentials while the computer is locked. Enable only if your organization's device policy permits it.",
      ...(process.platform === "linux"
        ? ["On Linux, this can also block manual suspend. Turn Keep Awake off before suspending."]
        : []),
    ].join("\n\n")
    const answer = await vscode.window.showWarningMessage(
      "Keep this computer awake while Kilo agents work?",
      { modal: true, detail },
      "Enable Keep Awake",
    )
    if (answer !== "Enable Keep Awake") return false
    await context.globalState.update("caffeination.confirmed", true).then(undefined, (error: unknown) => {
      console.warn("[Kilo New] Could not save Keep Awake confirmation:", error)
    })
    return true
  })
  const controls = {
    getState: () => awake.getState(),
    onChange: awake.onChange.bind(awake),
    setEnabled: toggle,
  }
  const git = createGitExecutable({
    preferred: async () => {
      const extension = vscode.extensions.getExtension("vscode.git")
      if (!extension) return undefined
      if (!extension.isActive) await extension.activate()
      return extension.exports?.getAPI(1).git.path
    },
    log: (message) => console.warn(`[Kilo New] ${message}`),
  })
  const binary = process.platform === "win32" ? await git() : git
  const agentManagerHost = new VscodeHost(context.extensionUri, connectionService, context, remoteService, controls)
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService, binary, browserBroker)
  agentManagerProvider.onPanelVisibilityChange((visible) => remember({ agentManager: visible }))
  agentManager = agentManagerProvider
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("hybrid-ai-runtime.kilo-code.experimental.browserAutomation")) {
        agentManagerProvider.refreshBrowserAutomation()
      }
    }),
  )
  context.subscriptions.push(agentManagerProvider)

  // Wire "Continue in Worktree" from sidebar → Agent Manager
  provider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )
  provider.setCreateWorktreeHandler((baseBranch, branchName) =>
    agentManagerProvider.createFromSidebar(baseBranch, branchName),
  )

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const autoApprove = registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir =
          provider.getSessionDirectories().get(sessionId) ?? agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of provider.getSessionDirectories().values()) dirs.add(dir)
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )
  const attention = new AttentionService(connectionService, {
    approve: (event, directory) => autoApprove.approve(event, directory),
    details: async (sessionID, directory) => {
      provider.rememberSession(sessionID, directory)
      const session = await provider.getSessionInfo(sessionID)
      const dir = directory ?? session?.directory
      const workspace = dir
        ? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir))?.name ?? basename(dir))
        : (vscode.workspace.name ?? "Workspace")
      return { workspace, session: session?.title ?? session?.slug ?? sessionID }
    },
    focused: () => vscode.window.state.focused,
    // Every surface already reports the session it displays, gated on its own
    // visibility, so this covers the sidebar, Kilo editor tabs, and Agent
    // Manager without each one needing its own accessor.
    visible: (sessionID) => connectionService.isVisible(sessionID),
    os: showOSNotification,
    show: async (sessionID, directory) => {
      if (await agentManagerProvider.revealSession(sessionID)) return
      await vscode.commands.executeCommand("hybrid-ai-runtime-kilo-code-SidebarProvider.focus")
      await provider.openSession(sessionID, directory)
    },
  })

  // Prewarm only after all global event consumers are ready.
  ensureBackendForAutocomplete(connectionService)

  provider.setAutoApproveController(autoApprove)
  agentManagerHost.setAutoApproveController(autoApprove)

  // Register serializer so Agent Manager restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        if (restore.agentManager === false) {
          panel.dispose()
          return Promise.resolve()
        }
        const ctx = agentManagerHost.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => agentManagerProvider.handleMessage(msg),
          worktreeDirectories: () => agentManagerProvider.getWorktreeDirectories(),
          workspaceRoot: () => agentManagerProvider.workspaceRoot(),
          projectId: () => agentManagerProvider.projectId(),
        })
        agentManagerProvider.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so KiloClaw panel restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(KiloClawProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        kiloClawProvider.restorePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  const attach = (panel: vscode.WebviewPanel) => {
    const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
      tabTitle: panelTitleHandler(panel),
      topBarSurface: "tab",
    })
    tabProvider.setRemoteService(remoteService)
    tabProvider.setAutoApproveController(autoApprove)
    tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
      agentManagerProvider.continueFromSidebar(sessionId, progress),
    )
    tabProvider.setCreateWorktreeHandler((baseBranch, branchName) =>
      agentManagerProvider.createFromSidebar(baseBranch, branchName),
    )
    tabProvider.setDiffVirtualProvider(diffVirtualProvider)
    tabProvider.setDiffViewerProvider(diffViewerProvider)
    tabProvider.setReviewCommentsHandler(deliver)
    tabProvider.resolveWebviewPanel(panel)
    tabPanels.set(panel, tabProvider)
    return tabProvider
  }

  // Register serializer so "Open in Tab" restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("hybrid-ai-runtime.kilo-code.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = attach(panel)
        panel.onDidDispose(
          () => {
            console.log("[Kilo New] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  const diffSourceCatalog = new DiffSourceCatalog(connectionService)
  context.subscriptions.push(diffSourceCatalog)
  const diffViewerProvider = new DiffViewerProvider(context.extensionUri, connectionService, diffSourceCatalog, {
    sessionIdProvider: () => provider.getCurrentSessionId(),
    sessionDirectoryProvider: (sessionId) => provider.getSessionGitDirectory(sessionId),
  })
  diffViewerProvider.setCommentHandler((comments, autoSend) => {
    void provider.appendReviewComments(comments, autoSend)
  })
  provider.setDiffViewerProvider(diffViewerProvider)
  context.subscriptions.push(diffViewerProvider)

  const documentViewerProvider = new DocumentViewerProvider(context.extensionUri, connectionService, {
    onComments: (comments, autoSend) => void provider.appendReviewComments(comments, autoSend),
  })
  provider.setDocumentViewerProvider(documentViewerProvider)
  context.subscriptions.push(documentViewerProvider)

  // Create diff virtual provider (lightweight single-file diff for permission approval)
  const diffVirtualProvider = new DiffVirtualProvider(context.extensionUri)
  provider.setDiffVirtualProvider(diffVirtualProvider)
  agentManagerHost.setDiffVirtualProvider(diffVirtualProvider)
  context.subscriptions.push(diffVirtualProvider)

  // Create standalone editor providers (open in editor area, not sidebar)
  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context, {
    ...agentManagerProvider.settings,
  })
  settingsEditorProvider.setRemoteService(remoteService)
  const marketplacePanelProvider = new MarketplacePanelProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(settingsEditorProvider, marketplacePanelProvider)

  // Surface a discardable notification when a marketplace item matches the workspace.
  const marketplaceNotifier = new MarketplaceNotifier(connectionService, context, (item) =>
    marketplacePanelProvider.openInstall(item),
  )
  context.subscriptions.push(marketplaceNotifier)
  marketplaceNotifier.start()

  // Create sub-agent viewer provider (read-only editor panel for sub-agent sessions)
  const subAgentViewerProvider = new SubAgentViewerProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(subAgentViewerProvider)

  // Register serializers so standalone panels restore on restart
  const settingsViews = ["settingsPanel", "profilePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`hybrid-ai-runtime.kilo-code.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          settingsEditorProvider.deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(MarketplacePanelProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        marketplacePanelProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DocumentViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DiffViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        diffViewerProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("hybrid-ai-runtime.kilo-code.SubAgentViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        // Sub-agent viewer requires a session ID that can't be recovered
        // after restart, so dispose the stale panel cleanly.
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  // Sidebar menus use wrapper commands so this event measures real title button presses,
  // not programmatic opens, shortcuts, or editor title commands.
  const track = (button: string, command: string) => {
    TelemetryProxy.capture(TelemetryEventName.TITLE_BUTTON_CLICKED, {
      button,
      surface: "sidebar_title",
    })
    void vscode.commands.executeCommand(command)
  }

  // Register toolbar button command handlers
  context.subscriptions.push(
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.plusButtonClicked", () => {
      track("new_task", "hybrid-ai-runtime.kilo-code.plusButtonClicked")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.historyButtonClicked", () => {
      track("history", "hybrid-ai-runtime.kilo-code.historyButtonClicked")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.agentManagerOpen", () => {
      track("agent_manager", "hybrid-ai-runtime.kilo-code.agentManagerOpen")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.kiloClawOpen", () => {
      track("kiloclaw", "hybrid-ai-runtime.kilo-code.kiloClawOpen")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.marketplaceButtonClicked", () => {
      track("marketplace", "hybrid-ai-runtime.kilo-code.marketplaceButtonClicked")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.profileButtonClicked", () => {
      track("profile", "hybrid-ai-runtime.kilo-code.profileButtonClicked")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.sidebarTitle.settingsButtonClicked", () => {
      track("settings", "hybrid-ai-runtime.kilo-code.settingsButtonClicked")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.plusButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "plusButtonClicked" })
      else provider.postMessage({ type: "action", action: "plusButtonClicked" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.marketplaceButtonClicked", (directory?: string | null) => {
      marketplacePanelProvider.openPanel(directory)
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.kiloClawOpen", () => {
      kiloClawProvider.openPanel()
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.historyButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "historyButtonClicked" })
      else provider.postMessage({ type: "action", action: "historyButtonClicked" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.cycleAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cycleAgentMode" })
      else provider.postMessage({ type: "action", action: "cycleAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.cyclePreviousAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      else provider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.profileButtonClicked", () => {
      settingsEditorProvider.openPanel("profile")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.settingsButtonClicked", (tab?: string, projectId?: string) => {
      settingsEditorProvider.openPanel("settings", tab, projectId)
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.openIndexingSettings", () => {
      settingsEditorProvider.openPanel("settings", "indexing")
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.showMemory", async () => {
      if (agentManagerProvider.isActive()) {
        await agentManagerProvider.showMemory()
        return
      }
      const target = activeTabProvider() ?? provider
      if (target === provider) await vscode.commands.executeCommand("hybrid-ai-runtime-kilo-code-SidebarProvider.focus")
      await target.waitForReady()
      await target.showMemory()
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.toggleMemory", async () => {
      if (agentManagerProvider.isActive()) {
        await agentManagerProvider.toggleMemory()
        return
      }
      const target = activeTabProvider() ?? provider
      if (target === provider) await vscode.commands.executeCommand("hybrid-ai-runtime-kilo-code-SidebarProvider.focus")
      await target.waitForReady()
      await target.toggleMemory()
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.toggleCaffeination", (enabled?: boolean) => {
      const state = awake.getState()
      const next = typeof enabled === "boolean" ? enabled : !(state.enabled || state.active)
      if (next && !state.available) {
        return vscode.window.showWarningMessage(state.error ?? "Keep Awake is unavailable on this platform.")
      }
      return toggle(next)
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      await vscode.commands.executeCommand("hybrid-ai-runtime-kilo-code-SidebarProvider.focus")
      await provider.waitForReady()
      provider.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.toggleRemote", () => {
      remoteService.toggle().catch((err) => console.error("[Kilo New] toggleRemote command failed:", err))
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.openInTab", () => {
      return openKiloInNewTab(context, tabPanels, attach)
    }),
    vscode.commands.registerCommand(
      "hybrid-ai-runtime.kilo-code.showChanges",
      (arg?: Parameters<DiffViewerProvider["openFromCommand"]>[0]) => {
        diffViewerProvider.openFromCommand(arg)
      },
    ),
    vscode.commands.registerCommand(
      "hybrid-ai-runtime.kilo-code.openSubAgentViewer",
      (sessionID: string, title?: string, directory?: string) => {
        subAgentViewerProvider.openPanel(sessionID, title, directory)
      },
    ),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.previousSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.nextSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.previousTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.nextTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.previousTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "terminalPrevious" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.nextTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "terminalNext" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.search", () => {
      agentManagerProvider.postMessage({ type: "action", action: "search" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.showTerminal", () => {
      // Route through the webview so it can reach into the active session
      // state and open the VS Code integrated terminal for it.
      agentManagerProvider.postMessage({ type: "action", action: "showTerminal" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.runScript", () => {
      agentManagerProvider.postMessage({ type: "action", action: "runScript" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.toggleDiff", () => {
      agentManagerProvider.postMessage({ type: "action", action: "toggleDiff" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.showShortcuts", () => {
      agentManagerProvider.postMessage({ type: "action", action: "showShortcuts" })
    }),

    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.newTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.newTerminalTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTerminalTab" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.newSideTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newSideTerminal" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.closeTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeTab" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.newWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newWorktree" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.quickWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "quickWorktree" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.openWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openWorktree" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.updateFromBase", () => {
      agentManagerProvider.postMessage({ type: "action", action: "updateFromBase" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.openPR", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openPR" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.closeWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeWorktree" })
    }),
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.agentManager.advancedWorktree", () =>
      agentManagerProvider.openAdvancedWorktree(),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`hybrid-ai-runtime.kilo-code.agentManager.jumpTo${i + 1}`, () => {
        agentManagerProvider.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for extension deep links (vscode://hybrid-ai-runtime.kilo-code/kilocode/...)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const sessionMatch = uri.path.match(/^\/kilocode\/s\/([a-zA-Z0-9_-]+)$/)
        const sessionId = sessionMatch?.[1]
        if (sessionId) {
          console.log("[Kilo New] URI handler: opening cloud session:", sessionId)
          await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
          provider.openCloudSession(sessionId)
          return
        }

        if (uri.path !== "/kilocode/switch" && uri.path !== "/kilocode/model") return
        const params = new URLSearchParams(uri.query)
        const modelID = params.get("model") || undefined
        const agent = params.get("agent") || undefined
        if (!modelID && !agent) return
        console.log("[Kilo New] URI handler: applying linked Kilo selection:", { modelID, agent })
        await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
        provider.selectKiloModel(modelID, agent)
      },
    }),
  )

  // Register autocomplete provider
  void registerAutocompleteProvider(context, connectionService)

  // Register commit message generation
  registerCommitMessageService(context, connectionService)

  registerHeapSnapshot(context, connectionService)

  context.subscriptions.push(
    vscode.commands.registerCommand("hybrid-ai-runtime.kilo-code.reload", () => {
      provider.reload().catch((e) => console.error("[Kilo New] reload command failed:", e))
    }),
  )

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts)
  registerCodeActions(context, provider, agentManagerProvider, activeTabProvider)
  registerTerminalActions(context, provider, agentManagerProvider)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // Dispose services when extension deactivates (kills the server)
  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true
      void caffeination?.dispose().catch((error: unknown) => {
        console.warn("[Kilo New] Keep-awake cleanup failed:", error)
      })
      unsubscribeStateChange()
      attention.dispose()
      browserBroker.dispose()
      provider.dispose()
      notebookBridge.dispose()
      connectionService.dispose()
    },
  })
}

export async function deactivate() {
  shuttingDown = true
  const results = await Promise.allSettled([caffeination?.dispose(), agentManager?.shutdown()])
  for (const result of results) {
    if (result.status === "rejected") console.warn("[Kilo New] Extension shutdown failed:", result.reason)
  }
  TelemetryProxy.getInstance().shutdown()
}

function openKiloInNewTab(
  context: vscode.ExtensionContext,
  tabPanels: Map<vscode.WebviewPanel, KiloProvider>,
  attach: (panel: vscode.WebviewPanel) => KiloProvider,
) {
  const panel = vscode.window.createWebviewPanel(
    "hybrid-ai-runtime.kilo-code.TabPanel",
    EXTENSION_DISPLAY_NAME,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  )

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.svg"),
  }

  const tabProvider = attach(panel)

  panel.onDidDispose(
    () => {
      console.log("[Kilo New] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}
