import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  buildHjfyLoginURL,
  HJFYClient,
  HJFYClientError,
  hjfyHost,
} from "./hjfyClient";

const hjfyClient = new HJFYClient({
  delayImplementation: (milliseconds) => Zotero.Promise.delay(milliseconds),
});

export async function registerPrefsScripts(_window: Window) {
  // This function is called when the prefs window is opened
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  bindPrefEvents();
}

function updatePrefsUI() {
  if (!addon.data.prefs?.window) return;
  const doc = addon.data.prefs.window.document;

  // Initialize color preview with current pref values
  updateColorPreview(doc);
  void updateHjfyAccountStatus(doc);
}

async function updateHjfyAccountStatus(doc: Document) {
  const status = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-hjfy-status`,
  ) as HTMLElement | null;
  if (!status) return;

  status.textContent = getString("hjfy-account-checking");
  try {
    const balance = await hjfyClient.fetchTranslationBalance();
    status.textContent = getString("hjfy-account-logged-in", {
      args: { balance },
    });
  } catch (error) {
    if (error instanceof HJFYClientError && error.code === "login-required") {
      status.textContent = getString("hjfy-account-logged-out");
      return;
    }
    status.textContent = getString("hjfy-account-error", {
      args: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window) return;
  const doc = addon.data.prefs.window.document;

  // Checkbox: Follow mouse focus to switch primary window
  const followFocusCheckbox = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-follow-focus`,
  ) as HTMLInputElement | null;
  followFocusCheckbox?.addEventListener("command", (e: Event) => {
    const target = e.target as HTMLInputElement;
    setPref("followFocusPrimary", target.checked);
  });

  // Checkbox: Actions Sync
  const syncEnabledCheckbox = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-sync-enabled`,
  ) as HTMLInputElement | null;
  syncEnabledCheckbox?.addEventListener("command", (e: Event) => {
    const target = e.target as HTMLInputElement;
    setPref("syncEnabled", target.checked);
  });

  // RGB inputs: Primary scrollbar color
  const rInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-r`,
  ) as HTMLInputElement | null;
  const gInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-g`,
  ) as HTMLInputElement | null;
  const bInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-scrollbar-b`,
  ) as HTMLInputElement | null;

  const handleColorChange = (
    input: HTMLInputElement | null,
    prefKey: "primaryScrollbarR" | "primaryScrollbarG" | "primaryScrollbarB",
  ) => {
    if (!input) return;
    input.addEventListener("change", () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val)) val = 0;
      // Clamp to 0-255
      val = Math.max(0, Math.min(255, val));
      input.value = String(val);
      setPref(prefKey, val);
      updateColorPreview(doc);
    });
  };

  handleColorChange(rInput, "primaryScrollbarR");
  handleColorChange(gInput, "primaryScrollbarG");
  handleColorChange(bInput, "primaryScrollbarB");

  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-hjfy-login`)
    ?.addEventListener("command", () => {
      // The viewer shares Zotero's cookie jar, so the plugin's requests reuse this login.
      Zotero.openInViewer(buildHjfyLoginURL());
    });
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-hjfy-refresh`)
    ?.addEventListener("command", () => {
      void updateHjfyAccountStatus(doc);
    });
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-hjfy-logout`)
    ?.addEventListener("command", () => {
      void logoutHjfy(doc);
    });
}

async function logoutHjfy(doc: Document) {
  try {
    await hjfyClient.logout();
  } catch (error) {
    ztoolkit.log("HJFY logout request failed", error);
  }
  // Drop the local session even when the server could not be reached.
  try {
    for (const cookie of Services.cookies.getCookiesFromHost(hjfyHost, {})) {
      Services.cookies.remove(
        cookie.host,
        cookie.name,
        cookie.path,
        cookie.originAttributes,
      );
    }
  } catch (error) {
    ztoolkit.log("Failed to clear HJFY cookies", error);
  }
  await updateHjfyAccountStatus(doc);
}

function updateColorPreview(doc: Document) {
  const r = getPref("primaryScrollbarR") ?? 255;
  const g = getPref("primaryScrollbarG") ?? 0;
  const b = getPref("primaryScrollbarB") ?? 0;

  const preview = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-color-preview`,
  ) as HTMLElement | null;
  if (preview) {
    preview.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  }
}
