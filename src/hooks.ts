import {
  BasicExampleFactory,
  // HelperExampleFactory,
  // KeyExampleFactory,
  // PromptExampleFactory,
  // UIExampleFactory,
} from "./modules/examples";
import { HJFYSplitFactory } from "./modules/hjfySplit";
import { SplitViewFactory } from "./modules/splitView";
import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  SplitViewFactory.registerContextMenu();
  SplitViewFactory.registerSessionRestore();
  SplitViewFactory.registerTabLookup();
  SplitViewFactory.registerPrefObservers();
  SplitViewFactory.registerPromptCommands();
  HJFYSplitFactory.registerItemMenu();

  BasicExampleFactory.registerPrefs();

  BasicExampleFactory.registerNotifier();

  // Example code - commented out for Split-View Reader plugin
  // KeyExampleFactory.registerShortcuts();
  // await UIExampleFactory.registerExtraColumn();
  // await UIExampleFactory.registerExtraColumnWithCustomCell();
  // UIExampleFactory.registerItemPaneCustomInfoRow();
  // UIExampleFactory.registerItemPaneSection();
  // UIExampleFactory.registerReaderItemPaneSection();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Clean up split-view resources when the main window is unloaded.
  // This prevents keeping references to DOM nodes and windows that
  // become "dead objects" after Zotero is closed and reopened.
  SplitViewFactory.unregisterAll();

  // Cleanup ztoolkit and any open dialog windows.
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  SplitViewFactory.unregisterAll();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Notify events.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
  // Example code - commented out for Split-View Reader plugin
  // if (
  //   event == "select" &&
  //   type == "tab" &&
  //   extraData[ids[0]].type == "reader"
  // ) {
  //   BasicExampleFactory.exampleNotifierCallback();
  // }
}

/**
 * Dispatcher for Preference UI events.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Stub functions retained so examples.ts references still compile.
// These are no-ops for the Split-View Reader plugin.
function onShortcuts(_type: string) {}
function onDialogEvents(_type: string) {}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
