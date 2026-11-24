"use strict";

const { Plugin, PluginSettingTab, Setting, debounce } = require("obsidian");

/*
 * Obsidian (1.15.x) builds the window title as:
 *   "<note> - <app title>"   (note or tab open)
 *   "<app title>"            (nothing open)
 * where <app title> = "<vault> - Obsidian <version>", captured once into
 * app.title before plugins load. The in-app title bar ("Obsidian frame"
 * style) copies document.title through a MutationObserver on <title>.
 *
 * This plugin watches the same <title> element. Each time Obsidian writes a
 * title, it parses out the note name and rewrites the title from the
 * user's format. Obsidian's own observer then copies it into the title bar.
 */

const APP_SUFFIX_MARKER = " - Obsidian ";
// Fallback when app.title is unavailable: " - Obsidian 1.15.1" or " - Obsidian v1.9.12"
const FALLBACK_SUFFIX = / - Obsidian v?\d\S*$/;
const PLACEHOLDER_PATTERN = /\{(note|vault|version|app)\}/g;
const SAVE_DELAY_MS = 500;

const DEFAULT_SETTINGS = {
  noteFormat: "{note} - {vault}",
  emptyFormat: "{vault}",
};

const PLACEHOLDERS = [
  { key: "note", description: "Open note or tab name" },
  { key: "vault", description: "Vault name" },
  { key: "version", description: "Obsidian version" },
  { key: "app", description: "The word \"Obsidian\"" },
];

class StripTitleVersionPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    // Disabled while loadData was pending: onunload already ran, so attach nothing.
    if (this._loaded === false) {
      return;
    }

    this.appTitle = this.findAppTitle();
    if (!this.appTitle) {
      console.warn("[strip-title-version] Could not find Obsidian's app title; doing nothing.");
      return;
    }
    this.vaultName = this.parseVaultName(this.appTitle);
    this.version = this.parseVersion(this.appTitle);

    /** @type {Map<Window, {observer: MutationObserver, rawTitle: string | null, lastWritten: string | null}>} */
    this.windowStates = new Map();
    this.saveSettingsDebounced = debounce(() => this.saveSettings(), SAVE_DELAY_MS, true);

    this.addSettingTab(new StripTitleVersionSettingTab(this.app, this));

    this.watchWindow(window);
    this.watchExistingPopouts();
    this.app.workspace.onLayoutReady(() => this.watchExistingPopouts());

    // Pop-out windows have their own <title> and title bar.
    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, win) => this.watchWindow(win))
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, win) => this.unwatchWindow(win))
    );
  }

  onunload() {
    // Save a settings edit made in the last half second.
    if (this.saveSettingsDebounced && typeof this.saveSettingsDebounced.run === "function") {
      this.saveSettingsDebounced.run();
    }
    if (!this.windowStates) {
      return;
    }
    // Put Obsidian's original titles back.
    for (const [win, state] of this.windowStates) {
      state.observer.disconnect();
      if (state.rawTitle !== null) {
        win.document.title = state.rawTitle;
      }
    }
    this.windowStates.clear();
  }

  // ---------- Settings ----------

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = {
      noteFormat: typeof saved.noteFormat === "string" ? saved.noteFormat : DEFAULT_SETTINGS.noteFormat,
      emptyFormat: typeof saved.emptyFormat === "string" ? saved.emptyFormat : DEFAULT_SETTINGS.emptyFormat,
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Called by the settings tab on every change: retitle now, save shortly after. */
  onSettingsChanged() {
    this.refreshAllWindows();
    this.saveSettingsDebounced();
  }

  // ---------- Title parsing / formatting ----------

  /** @returns {string | null} "<vault> - Obsidian <version>" */
  findAppTitle() {
    const appTitle = this.app.title;
    if (typeof appTitle === "string" && appTitle.includes(APP_SUFFIX_MARKER)) {
      return appTitle;
    }
    const match = document.title.match(FALLBACK_SUFFIX);
    return match ? this.app.vault.getName() + match[0] : null;
  }

  /** Vault name exactly as Obsidian put it in the title (NFC-normalized). @param {string} appTitle */
  parseVaultName(appTitle) {
    return appTitle.slice(0, appTitle.lastIndexOf(APP_SUFFIX_MARKER));
  }

  /** @param {string} appTitle @returns {string} e.g. "1.15.1" */
  parseVersion(appTitle) {
    const index = appTitle.lastIndexOf(APP_SUFFIX_MARKER);
    return appTitle.slice(index + APP_SUFFIX_MARKER.length).replace(/^v/, "");
  }

  /**
   * @param {string} rawTitle a title written by Obsidian
   * @returns {string | null} note name ("" when nothing is open), or null if not an Obsidian app title
   */
  parseNote(rawTitle) {
    if (rawTitle === this.appTitle) {
      return "";
    }
    const noteSuffix = " - " + this.appTitle;
    if (rawTitle.endsWith(noteSuffix)) {
      return rawTitle.slice(0, rawTitle.length - noteSuffix.length);
    }
    return null;
  }

  /** @param {string} note "" when nothing is open @returns {string} */
  formatTitle(note) {
    const format = note ? this.settings.noteFormat : this.settings.emptyFormat;
    const fallback = note ? DEFAULT_SETTINGS.noteFormat : DEFAULT_SETTINGS.emptyFormat;
    const values = { note: note, vault: this.vaultName, version: this.version, app: "Obsidian" };

    const title = this.fillPlaceholders(format, values);
    // An empty format would blank the title; use the default instead.
    return title.trim() ? title : this.fillPlaceholders(fallback, values);
  }

  /** @param {string} format @param {Record<string, string>} values */
  fillPlaceholders(format, values) {
    return format.replace(PLACEHOLDER_PATTERN, (_match, key) => values[key]);
  }

  /** @returns {string} note name in the main window, for settings examples */
  getMainWindowNote() {
    const state = this.windowStates.get(window);
    const note = state && state.rawTitle !== null ? this.parseNote(state.rawTitle) : null;
    return note || "";
  }

  // ---------- Window watching ----------

  /** @returns {Array<object>} pop-out WorkspaceWindows already open (internal API, guarded) */
  getPopoutWorkspaceWindows() {
    const floatingSplit = this.app.workspace.floatingSplit;
    return floatingSplit && Array.isArray(floatingSplit.children) ? floatingSplit.children : [];
  }

  watchExistingPopouts() {
    for (const workspaceWindow of this.getPopoutWorkspaceWindows()) {
      if (workspaceWindow.win) {
        this.watchWindow(workspaceWindow.win);
      }
    }
  }

  /** @param {Window} win */
  watchWindow(win) {
    if (this.windowStates.has(win)) {
      return;
    }
    const titleEl = win.document && win.document.head && win.document.head.querySelector("title");
    if (!titleEl) {
      return;
    }

    const observer = new MutationObserver(() => this.onTitleChanged(win));
    observer.observe(titleEl, { subtree: true, characterData: true, childList: true });
    this.windowStates.set(win, { observer: observer, rawTitle: null, lastWritten: null });

    this.onTitleChanged(win);
  }

  /** @param {Window} win */
  unwatchWindow(win) {
    const state = this.windowStates.get(win);
    if (state) {
      state.observer.disconnect();
      this.windowStates.delete(win);
    }
  }

  /** @param {Window} win */
  onTitleChanged(win) {
    const state = this.windowStates.get(win);
    const current = win.document.title;
    if (!state) {
      return;
    }
    if (current === state.lastWritten) {
      // Our own write echoing back: consume it once, so a later Obsidian
      // write that happens to equal it is still processed.
      state.lastWritten = null;
      return;
    }
    if (this.parseNote(current) === null) {
      return; // not a title Obsidian built from the app title; leave it alone
    }
    state.rawTitle = current;
    this.applyFormat(win, state);
  }

  refreshAllWindows() {
    for (const [win, state] of this.windowStates) {
      this.applyFormat(win, state);
    }
  }

  /** @param {Window} win */
  applyFormat(win, state) {
    if (state.rawTitle === null) {
      return;
    }
    const desired = this.formatTitle(this.parseNote(state.rawTitle));
    if (win.document.title !== desired) {
      state.lastWritten = desired;
      win.document.title = desired;
    }
  }
}

class StripTitleVersionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Shown in Obsidian's title bar when Settings → Appearance → Window frame style is \"Obsidian frame\". " +
        "Minimal theme: keep Style Settings → Window frame → \"Hide window frame title\" off.",
    });

    new Setting(containerEl).setName("Title format").setHeading();

    new Setting(containerEl)
      .setName("With a note open")
      .setDesc("Used when a note or tab is open.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.noteFormat)
          .setValue(plugin.settings.noteFormat)
          .onChange((value) => {
            plugin.settings.noteFormat = value;
            plugin.onSettingsChanged();
            this.updatePreview();
          })
      );

    new Setting(containerEl)
      .setName("With nothing open")
      .setDesc("Used when no note is open (empty tab). {note} is empty here.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.emptyFormat)
          .setValue(plugin.settings.emptyFormat)
          .onChange((value) => {
            plugin.settings.emptyFormat = value;
            plugin.onSettingsChanged();
            this.updatePreview();
          })
      );

    this.previewSetting = new Setting(containerEl).setName("Preview");
    this.updatePreview();

    new Setting(containerEl).setName("How to format").setHeading();
    this.renderPlaceholderHints(containerEl);

    new Setting(containerEl)
      .setName("Reset to defaults")
      .setDesc(`"${DEFAULT_SETTINGS.noteFormat}" and "${DEFAULT_SETTINGS.emptyFormat}"`)
      .addButton((button) =>
        button.setButtonText("Reset").onClick(() => {
          plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          plugin.onSettingsChanged();
          this.display();
        })
      );
  }

  renderPlaceholderHints(containerEl) {
    const plugin = this.plugin;
    const examples = {
      note: plugin.getMainWindowNote() || "My Note",
      vault: plugin.vaultName,
      version: plugin.version,
      app: "Obsidian",
    };

    const hints = containerEl.createDiv({ cls: "setting-item-description" });
    hints.createEl("p", { text: "Placeholders (replaced with live values):" });
    const list = hints.createEl("ul");
    for (const placeholder of PLACEHOLDERS) {
      const item = list.createEl("li");
      item.createEl("code", { text: `{${placeholder.key}}` });
      item.appendText(` — ${placeholder.description}, e.g. "${examples[placeholder.key]}"`);
    }

    hints.createEl("p", {
      text:
        "Everything outside {…} is kept as typed, so you can use any separators, emoji or text. " +
        "Placeholders are lowercase; unknown ones are left as-is. " +
        "An empty format falls back to the default.",
    });

    hints.createEl("p", { text: "Examples:" });
    const exampleList = hints.createEl("ul");
    for (const example of ["{note} - {vault}", "{note} | {vault} ({version})", "📝 {note}", "{vault} › {note}"]) {
      exampleList.createEl("li").createEl("code", { text: example });
    }
  }

  updatePreview() {
    const plugin = this.plugin;
    const note = plugin.getMainWindowNote() || "My Note";
    this.previewSetting.descEl.empty();
    this.previewSetting.descEl.createDiv({ text: `With a note open: ${plugin.formatTitle(note)}` });
    this.previewSetting.descEl.createDiv({ text: `With nothing open: ${plugin.formatTitle("")}` });
  }
}

module.exports = StripTitleVersionPlugin;
