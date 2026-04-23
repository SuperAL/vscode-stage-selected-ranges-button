"use strict";

const path = require("path");
const vscode = require("vscode");

const COMMAND_ID = "selectionStageRanges.stageSelectedRanges";
const BUILTIN_STAGE_COMMAND_ID = "git.stageSelectedRanges";
const BUILTIN_GIT_EXTENSION_ID = "vscode.git";
const AUTO_POPUP_DELAY_MS = 350;

function activate(context) {
  const controller = new SelectionStageRangesController();
  const hoverProvider = new SelectionStageRangesHoverProvider(controller);

  context.subscriptions.push(
    controller,
    vscode.languages.registerHoverProvider([{ scheme: "file" }], hoverProvider),
    vscode.commands.registerCommand(COMMAND_ID, () => controller.stageSelectedRanges())
  );
}

function deactivate() {}

class SelectionStageRangesController {
  constructor() {
    this.gitApi = null;
    this.gitDisposables = [];
    this.repositoryStateDisposables = new Map();
    this.pendingHoverTimer = null;
    this.hoverTarget = null;

    this.disposables = [
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection((event) => this.handleSelectionChange(event)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh())
    ];

    void this.initializeGitApi();
    this.refresh();
  }

  dispose() {
    this.clearPendingHover();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const disposable of this.gitDisposables) {
      disposable.dispose();
    }
    for (const disposable of this.repositoryStateDisposables.values()) {
      disposable.dispose();
    }
  }

  refresh() {
    if (!this.canExecuteAction()) {
      this.hoverTarget = null;
    }
  }

  getActiveEditor() {
    return vscode.window.activeTextEditor ?? null;
  }

  canExecuteAction(editor = this.getActiveEditor()) {
    if (!editor || !this.isDiffRightEditor(editor) || editor.document.uri.scheme !== "file") {
      return false;
    }

    if (!this.hasNonEmptySelection(editor)) {
      return false;
    }

    if (!this.isInsideWorkspace(editor.document.uri)) {
      return false;
    }

    return this.hasGitChangesForUri(editor.document.uri);
  }

  hasNonEmptySelection(editor) {
    return editor.selections.some((selection) => !selection.isEmpty);
  }

  async stageSelectedRanges() {
    const editor = this.getActiveEditor();
    if (!this.canExecuteAction(editor)) {
      void vscode.window.showInformationMessage(
        "Select a range in a diff editor where Stage Selected Ranges is available before staging."
      );
      return;
    }

    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(BUILTIN_STAGE_COMMAND_ID)) {
      void vscode.window.showErrorMessage(
        "VS Code built-in Git command 'git.stageSelectedRanges' is unavailable. Make sure the built-in Git extension is enabled."
      );
      return;
    }

    try {
      await vscode.commands.executeCommand(BUILTIN_STAGE_COMMAND_ID);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Stage Selected Ranges failed: ${message}`);
    } finally {
      this.hoverTarget = null;
      void this.closeHover();
      this.refresh();
    }
  }

  async initializeGitApi() {
    const extension = vscode.extensions.getExtension(BUILTIN_GIT_EXTENSION_ID);
    if (!extension) {
      return;
    }

    if (!extension.isActive) {
      await extension.activate();
    }

    const exportsValue = extension.exports;
    if (!exportsValue || typeof exportsValue.getAPI !== "function") {
      return;
    }

    this.gitApi = exportsValue.getAPI(1);

    for (const disposable of this.gitDisposables) {
      disposable.dispose();
    }

    this.gitDisposables = [
      this.gitApi.onDidOpenRepository((repository) => {
        this.watchRepository(repository);
        this.refresh();
      }),
      this.gitApi.onDidCloseRepository((repository) => {
        this.unwatchRepository(repository);
        this.refresh();
      })
    ];

    for (const repository of this.gitApi.repositories) {
      this.watchRepository(repository);
    }

    this.refresh();
  }

  hasGitChangesForUri(uri) {
    const repository = this.getGitRepository(uri);
    if (!repository) {
      return false;
    }

    const targetPath = this.normalizePath(uri.fsPath);
    const state = repository.state;
    const allChanges = [
      ...state.workingTreeChanges,
      ...state.indexChanges,
      ...state.mergeChanges,
      ...state.untrackedChanges
    ];

    return allChanges.some((change) => this.changeMatchesUri(change, targetPath));
  }

  changeMatchesUri(change, targetPath) {
    const candidates = [change.uri, change.originalUri, change.renameUri].filter(Boolean);
    return candidates.some((candidate) => {
      if (!candidate || candidate.scheme !== "file") {
        return false;
      }

      return this.normalizePath(candidate.fsPath) === targetPath;
    });
  }

  getGitRepository(uri) {
    if (!this.gitApi) {
      return null;
    }

    if (typeof this.gitApi.getRepository === "function") {
      return this.gitApi.getRepository(uri);
    }

    return null;
  }

  shouldAutoPopupHover(editor = this.getActiveEditor()) {
    return this.canExecuteAction(editor);
  }

  getPrimarySelection(editor = this.getActiveEditor()) {
    if (!editor) {
      return null;
    }

    return editor.selections.find((selection) => !selection.isEmpty) ?? null;
  }

  getHoverPosition(editor = this.getActiveEditor()) {
    const selection = this.getPrimarySelection(editor);
    if (!selection) {
      return null;
    }

    return selection.active;
  }

  getHoverTargetKey(editor = this.getActiveEditor()) {
    const position = this.getHoverPosition(editor);
    if (!editor || !position) {
      return null;
    }

    return `${editor.document.uri.toString()}#${position.line}:${position.character}`;
  }

  handleSelectionChange(event) {
    this.refresh();

    if (event.textEditor !== this.getActiveEditor()) {
      return;
    }

    this.clearPendingHover();
    this.hoverTarget = null;
    void this.closeHover();

    if (!this.shouldAutoPopupHover(event.textEditor)) {
      return;
    }

    this.pendingHoverTimer = setTimeout(() => {
      void this.showHoverForCurrentSelection();
    }, AUTO_POPUP_DELAY_MS);
  }

  clearPendingHover() {
    if (this.pendingHoverTimer) {
      clearTimeout(this.pendingHoverTimer);
      this.pendingHoverTimer = null;
    }
  }

  async showHoverForCurrentSelection() {
    this.pendingHoverTimer = null;

    const editor = this.getActiveEditor();
    if (!this.shouldAutoPopupHover(editor)) {
      return;
    }

    const key = this.getHoverTargetKey(editor);
    if (!key) {
      return;
    }

    this.hoverTarget = { key };

    try {
      await vscode.commands.executeCommand("editor.action.showHover");
    } catch {
      this.hoverTarget = null;
    }
  }

  async closeHover() {
    try {
      await vscode.commands.executeCommand("editor.action.closeHover");
    } catch {
      // Ignore when the host doesn't expose the close-hover command.
    }
  }

  shouldProvideHover(document, position, editor = this.getActiveEditor()) {
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return false;
    }

    if (!this.canExecuteAction(editor)) {
      return false;
    }

    const selection = this.getPrimarySelection(editor);
    if (!selection || !position.isEqual(selection.active)) {
      return false;
    }

    const key = this.getHoverTargetKey(editor);
    return Boolean(this.hoverTarget && key && this.hoverTarget.key === key);
  }

  isDiffRightEditor(editor = this.getActiveEditor()) {
    if (!editor) {
      return false;
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab || !(activeTab.input instanceof vscode.TabInputTextDiff)) {
      return false;
    }

    return activeTab.input.modified.toString() === editor.document.uri.toString();
  }

  watchRepository(repository) {
    const key = repository.rootUri.toString();
    if (this.repositoryStateDisposables.has(key)) {
      return;
    }

    const disposable = repository.state.onDidChange(() => this.refresh());
    this.repositoryStateDisposables.set(key, disposable);
  }

  unwatchRepository(repository) {
    const key = repository.rootUri.toString();
    const disposable = this.repositoryStateDisposables.get(key);
    if (!disposable) {
      return;
    }

    disposable.dispose();
    this.repositoryStateDisposables.delete(key);
  }

  isInsideWorkspace(uri) {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return true;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    return workspaceFolders.some((folder) => {
      const folderPath = this.normalizePath(folder.uri.fsPath);
      const filePath = this.normalizePath(uri.fsPath);
      return filePath.startsWith(`${folderPath}${path.sep}`) || filePath === folderPath;
    });
  }

  normalizePath(filePath) {
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  }
}

class SelectionStageRangesHoverProvider {
  constructor(controller) {
    this.controller = controller;
  }

  provideHover(document, position) {
    const editor = vscode.window.activeTextEditor;
    if (!this.controller.shouldProvideHover(document, position, editor)) {
      return null;
    }

    const commandUri = vscode.Uri.parse(`command:${COMMAND_ID}`);
    const markdown = new vscode.MarkdownString(
      `[$(plus) Stage Selected Ranges](${commandUri})`
    );
    markdown.isTrusted = true;
    markdown.supportThemeIcons = true;

    const activePosition = this.controller.getHoverPosition(editor);
    const anchorRange = activePosition
      ? new vscode.Range(activePosition, activePosition)
      : undefined;

    return new vscode.Hover(markdown, anchorRange);
  }
}

module.exports = {
  activate,
  deactivate
};
