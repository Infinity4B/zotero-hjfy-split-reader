import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";

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
