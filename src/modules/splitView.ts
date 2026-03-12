import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";

/**
 * Split View Tab - Single tab with two side-by-side PDF readers.
 *
 * Features:
 * 1. Opens two PDF readers in a single Zotero tab
 * 2. Horizontal split layout with draggable splitter
 * 3. Bidirectional scroll/page sync (preference-controlled; no context menu toggle)
 * 4. Each reader has complete annotation support
 */

interface TrackedEventListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

interface SplitTabState {
  tabID: string;
  container: XUL.Box;
  leftBrowser: XULBrowserElement;
  rightBrowser: XULBrowserElement;
  leftPopupset: XULElement;
  rightPopupset: XULElement;
  leftItemID: number;
  rightItemID: number;
  leftParentItemID: number;
  rightParentItemID: number;
  syncEnabled: boolean;
  primarySide: "left" | "right";
  activeSide: "left" | "right";
  leftScrollHandler: (() => void) | null;
  rightScrollHandler: (() => void) | null;
  lastLeftScroll: { top: number; left: number } | null;
  lastRightScroll: { top: number; left: number } | null;
  syncPaused: boolean;
  sidebarToggleTimers: number[];
  ctrlPressed: boolean;
  zoomingCount: number;
  // Resource tracking for proper cleanup
  eventListeners: TrackedEventListener[];
  timeoutIds: number[];
  // Cached viewer containers to avoid repeated DOM queries
  leftViewerContainer: Element | null;
  rightViewerContainer: Element | null;
  // Split ratio for proportional resizing (0-1, left side proportion)
  splitRatio: number;
  // Track view states for saving to disk
  leftViewState: any;
  rightViewState: any;
  // Original tab title before enabling split view (for future extensions)
  originalTitle?: string;
  // Track if cleanup is in progress to avoid dead object errors
  isCleaningUp: boolean;
  // Same PDF split view specific fields
  isSamePDF: boolean;
  annotationNotifierID: string | null;
  isSyncingSelection: boolean;
  annotationItemIDs: number[]; // Track current PDF's annotation IDs for delete sync
  // requestAnimationFrame pending flag for scroll sync batching
  scrollSyncRAFPending: boolean;
  // Last scroll sync timestamp for throttling (ms)
  lastScrollSyncTime: number;
  // Resize debounce timer ID for cleanup
  resizeTimerId: number | null;
  // Full-screen overlay during resizer drag; removed on cleanup so UI is not stuck
  dragOverlay?: HTMLElement | null;
}

interface OpenSplitViewOptions {
  primarySide?: "left" | "right";
  activeSide?: "left" | "right";
}

/** Command id for the Split-View Reader prompt command; used for unregister to avoid leaks. */
const SPLIT_VIEW_PROMPT_COMMAND_ID = "split-view-reader";

export class SplitViewFactory {
  /** Per-tab split view states. Each tab can independently have its own split view. */
  private static stateMap: Map<string, SplitTabState> = new Map();
  /** Global tab notifier ID - shared across all split view tabs */
  private static globalTabNotifierID: string | null = null;
  /** Session restore notifier ID - for detecting tabs that need split view restoration */
  private static sessionRestoreNotifierID: string | null = null;
  /** Preference observer ID for syncEnabled - allows real-time pref changes */
  private static syncPrefObserverID: symbol | null = null;
  /** Preference observer IDs for scrollbar RGB - apply new color to open split view tabs */
  private static scrollbarPrefObserverIDs: (symbol | null)[] = [
    null,
    null,
    null,
  ];

  /**
   * Look up state for a specific tab
   */
  private static getState(tabID: string): SplitTabState | null {
    return this.stateMap.get(tabID) ?? null;
  }

  /**
   * Get the state for the currently selected Zotero tab (if it has split view)
   */
  private static getActiveTabState(): SplitTabState | null {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const selectedTabID = Zotero_Tabs?.selectedID;
      if (selectedTabID) {
        return this.stateMap.get(selectedTabID) ?? null;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Build a chrome:// URI for an icon bundled with this addon
   */
  private static getIconURI(name: string): string {
    return `chrome://${addon.data.config.addonRef}/content/icons/${name}`;
  }

  /**
   * Apply an icon to a XUL menuitem element (menuitem-iconic style)
   */
  private static setMenuItemIcon(menuitem: Element, iconURI: string) {
    menuitem.classList.add("menuitem-iconic");
    menuitem.setAttribute("image", iconURI);
    menuitem.setAttribute(
      "style",
      "-moz-context-properties: fill; fill: currentColor;",
    );
  }

  /**
   * Register an event listener and track it for cleanup
   */
  private static trackEventListener(
    state: SplitTabState,
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    state.eventListeners.push({ target, type, listener, options });
  }

  /**
   * Register a timeout and track it for cleanup
   */
  private static trackTimeout(
    state: SplitTabState,
    callback: () => void,
    delay: number,
  ): number {
    const win = Zotero.getMainWindow();
    const id = win.setTimeout(callback, delay);
    state.timeoutIds.push(id);
    return id;
  }

  /**
   * Create a browser element for the reader
   * Uses CSS flex layout for automatic proportional resizing
   */
  private static createReaderBrowser(win: Window): XULBrowserElement {
    const browser = win.document.createXULElement("browser");
    // Don't set XUL flex attribute - use CSS flex instead
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    // Initial flex: equal distribution, will be updated by updateBrowserFlex
    // Use flex-basis: 0 (not 0%) to ensure proportional sizing regardless of content
    (browser as any).style.flex = "1 1 0";
    (browser as any).style.minWidth = "200px";
    (browser as any).style.maxWidth = "none";
    (browser as any).style.overflow = "hidden";
    (browser as any).style.boxSizing = "border-box";
    return browser;
  }

  /**
   * Update browser flex values to achieve the desired split ratio
   * Uses flex layout for automatic proportional resizing when window changes
   */
  private static updateBrowserFlex(
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    splitRatio: number,
  ) {
    // Use flex-grow to control proportions (flex-shrink=1, flex-basis=0)
    // flex-basis: 0 (not 0%) ensures both browsers start at exactly 0 and grow proportionally
    // Using integer flex-grow values to avoid floating point issues
    const leftFlex = Math.round(splitRatio * 1000);
    const rightFlex = Math.round((1 - splitRatio) * 1000);
    (leftBrowser as any).style.flex = `${leftFlex} 1 0`;
    (rightBrowser as any).style.flex = `${rightFlex} 1 0`;
  }

  /**
   * Set up drag functionality for the resizer
   * - Uses requestAnimationFrame for smooth performance
   * - Uses flex layout for automatic proportional resizing
   * - PDF scale is preserved (PDF.js handles relative vs absolute scaling)
   */
  private static setupResizerDrag(
    tabID: string,
    resizer: XULElement | HTMLElement,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    mainHbox: XULElement,
    win: Window,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    let isDragging = false;
    let startX = 0;
    let startRatio = 0;
    let overlay: HTMLElement | null = null;
    let rafPending = false;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const removeOverlay = () => {
      isDragging = false;
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      const s = self.stateMap.get(tabID);
      if (s) s.dragOverlay = null;
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
        onKeyDown = null;
      }
    };

    const createOverlay = () => {
      // Remove any existing overlay first (but don't reset isDragging)
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      state.dragOverlay = null;
      win.removeEventListener("mouseup", onMouseUp);
      win.removeEventListener("blur", onMouseUp);
      win.document.removeEventListener("mouseleave", onMouseUp);
      if (onKeyDown) {
        win.removeEventListener("keydown", onKeyDown);
      }

      overlay = win.document.createElement("div");
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 99999;
        cursor: ew-resize;
        background: transparent;
      `;
      const target = win.document.documentElement || win.document.body;
      if (target) target.appendChild(overlay);
      state.dragOverlay = overlay;
      overlay.addEventListener("mousemove", onMouseMove);
      overlay.addEventListener("mouseup", onMouseUp);
      state.eventListeners.push(
        {
          target: overlay,
          type: "mousemove",
          listener: onMouseMove as EventListener,
        },
        {
          target: overlay,
          type: "mouseup",
          listener: onMouseUp as EventListener,
        },
      );

      // Also listen on window in case mouseup happens outside overlay
      win.addEventListener("mouseup", onMouseUp);
      win.addEventListener("blur", onMouseUp);
      win.document.addEventListener("mouseleave", onMouseUp);
      state.eventListeners.push(
        { target: win, type: "mouseup", listener: onMouseUp as EventListener },
        { target: win, type: "blur", listener: onMouseUp as EventListener },
        {
          target: win.document,
          type: "mouseleave",
          listener: onMouseUp as EventListener,
        },
      );

      // Escape key to cancel drag and restore original ratio
      onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          // Restore original ratio
          const s = self.stateMap.get(tabID);
          if (s) {
            s.splitRatio = startRatio;
            self.updateBrowserFlex(leftBrowser, rightBrowser, startRatio);
          }
          removeOverlay();
        }
      };
      win.addEventListener("keydown", onKeyDown);
      state.eventListeners.push({
        target: win,
        type: "keydown",
        listener: onKeyDown as EventListener,
        options: true,
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      // Store the starting ratio for Escape key restoration
      const s = self.stateMap.get(tabID);
      startRatio = s?.splitRatio ?? 0.5;

      createOverlay();
      e.preventDefault();
      e.stopPropagation();
    };

    const onWindowMouseDown = (e: MouseEvent) => {
      if (isDragging) return;
      const s = self.stateMap.get(tabID);
      if (!s) return;

      // Only handle when our tab is visible (resizer has non-zero dimensions)
      const resizerRect = resizer.getBoundingClientRect();
      if (resizerRect.width === 0 || resizerRect.height === 0) return;

      const leftBrowserRect = leftBrowser.getBoundingClientRect();

      const edgeX = leftBrowserRect.right;
      const isNearEdge =
        Math.abs(e.clientX - edgeX) <= 15 &&
        e.clientY >= resizerRect.top &&
        e.clientY <= resizerRect.bottom;

      if (isNearEdge) {
        onMouseDown(e);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const s = self.stateMap.get(tabID);
      if (!isDragging || !s) return;
      if (rafPending) return;

      rafPending = true;
      win.requestAnimationFrame(() => {
        rafPending = false;
        const s2 = self.stateMap.get(tabID);
        if (!isDragging || !s2) return;

        // Use real-time container width instead of cached start widths
        // This ensures correct ratio calculation even if window is resized during drag
        const containerWidth = mainHbox.getBoundingClientRect().width;
        const resizerWidth = 1;
        const availableWidth = containerWidth - resizerWidth;

        // Calculate new left width based on mouse position
        // Use Math.floor with integer percentage like Zotero's split-view-resizer.js:
        // let p = Math.floor((br.width - (x - br.left)) / br.width * 100);
        const containerRect = mainHbox.getBoundingClientRect();
        const relativeX = e.clientX - containerRect.left;

        // Calculate percentage and floor to integer (1% step, matching Zotero)
        let percent = Math.floor((relativeX / availableWidth) * 100);

        // Apply min/max constraints (20-80% like Zotero's VIEW_MIN_SIZE)
        const minPercent = Math.ceil((200 / availableWidth) * 100); // At least 200px
        const maxPercent = 100 - minPercent;
        percent = Math.max(minPercent, Math.min(maxPercent, percent));

        // Update split ratio and flex values
        s2.splitRatio = percent / 100;
        self.updateBrowserFlex(leftBrowser, rightBrowser, s2.splitRatio);
      });
    };

    const onMouseUp = () => {
      // Save the new split ratio to tab data for session restore
      const s = self.stateMap.get(tabID);
      if (s && !s.isCleaningUp) {
        self.updateTabDataForSession(tabID);
      }
      removeOverlay();
    };

    // Track resizer mousedown listener for proper cleanup
    resizer.addEventListener("mousedown", onMouseDown);
    state.eventListeners.push({
      target: resizer,
      type: "mousedown",
      listener: onMouseDown as EventListener,
      options: undefined,
    });

    this.trackEventListener(
      state,
      win,
      "mousedown",
      onWindowMouseDown as EventListener,
      true,
    );
  }

  /**
   * Cache viewer container references to avoid repeated DOM queries during scroll sync
   */
  private static cacheViewerContainers(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    try {
      state.leftViewerContainer = this.getViewerContainerFromBrowser(
        state.leftBrowser,
      );
      state.rightViewerContainer = this.getViewerContainerFromBrowser(
        state.rightBrowser,
      );
    } catch (e) {
      Zotero.debug(
        `Split view: cacheViewerContainers error (browsers may be dead): ${e}`,
      );
    }
  }

  static registerContextMenu() {
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      (event) => {
        // Guard: skip if plugin has been unloaded
        if (!addon.data.alive) return;

        const { reader, append } = event;
        const readerTabID = reader.tabID;

        // Check if THIS tab has an active split view (not cleaning up)
        const tabState = this.stateMap.get(readerTabID);
        const isInSplitView = !!tabState && !tabState.isCleaningUp;

        // Determine icon for the Split-View Reader toggle
        const splitViewIcon = isInSplitView
          ? this.getIconURI("do_not_splitscreen_vertical_24dp.svg")
          : this.getIconURI("splitscreen_vertical_add_24dp.svg");

        // Build a label-to-icon map for post-processing
        // Use the actual label that will be shown (close or open)
        const menuLabel = isInSplitView
          ? getString("splitview-close-menu-label")
          : getString("splitview-menu-label");
        const iconMap: Record<string, string> = {
          [menuLabel]: splitViewIcon,
        };

        const menuItems: any[] = [];

        // First item: "Split-View Reader" toggle or Close
        menuItems.push({
          label: menuLabel,
          onCommand: () => {
            // Re-check state at command time to avoid stale references
            const currentTabState = this.stateMap.get(readerTabID);
            const currentlyInSplitView =
              !!currentTabState && !currentTabState.isCleaningUp;

            if (currentlyInSplitView) {
              // Use activeSide to determine which side was clicked
              // activeSide is updated whenever user clicks/focuses on a side
              const clickedSide = currentTabState?.activeSide || "right";
              // Pass the side to close (the one we clicked on)
              this.revertToSingleReader(readerTabID, clickedSide);
            } else {
              this.handleSplitView(reader);
            }
          },
        });

        // If we have an active split view, add additional options
        if (isInSplitView && tabState) {
          // Determine which side this reader is on
          const currentSide = this.getReaderSide(readerTabID, reader as any);

          // Second item: "Primary Window" (icon replaces checkmark)
          menuItems.push({
            label: getString("splitview-set-primary"),
            onCommand: () => {
              // Re-check state at command time
              const s = this.stateMap.get(readerTabID);
              if (s && !s.isCleaningUp && currentSide) {
                this.setPrimarySide(readerTabID, currentSide);
              }
            },
          });
          iconMap[getString("splitview-set-primary")] = this.getIconURI(
            "primary_window_24dp.svg",
          );
        }

        (append as any)(...menuItems);

        // Post-process: Zotero's _openContextMenu doesn't support custom icon
        // properties, so we add a one-time popupshowing listener to find the
        // menuitems by label and apply our icon attributes after they are
        // rendered into the DOM.
        const mainWindow = Zotero.getMainWindow();
        if (mainWindow) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const self = this;
          const onPopupShowing = (e: Event) => {
            const popup = e.target as Element;
            if (!popup || popup.tagName?.toLowerCase() !== "menupopup") return;
            const items = popup.querySelectorAll("menuitem");
            let found = false;
            for (const item of items) {
              const label = item.getAttribute("label");
              if (label && iconMap[label]) {
                found = true;
                // Remove checkbox type if Zotero added one (from checked property)
                item.removeAttribute("type");
                item.removeAttribute("checked");
                self.setMenuItemIcon(item, iconMap[label]);
              }
            }
            if (!found) {
              // Not our popup — re-listen for the next one
              mainWindow.document.addEventListener(
                "popupshowing",
                onPopupShowing,
                { once: true },
              );
            }
          };
          mainWindow.document.addEventListener("popupshowing", onPopupShowing, {
            once: true,
          });
        }
      },
      addon.data.config.addonID,
    );
  }

  /**
   * Hook into Zotero_Tabs.getTabIDByItemID to support finding tabs by right-side itemID
   */
  static registerTabLookup() {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    if (!Zotero_Tabs) return;

    // Store original method if not already stored
    if (!(Zotero_Tabs as any)._originalGetTabIDByItemID) {
      (Zotero_Tabs as any)._originalGetTabIDByItemID =
        Zotero_Tabs.getTabIDByItemID;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Override method
    Zotero_Tabs.getTabIDByItemID = function (itemID: number) {
      // 1. Try original method first
      const tabID = this._originalGetTabIDByItemID.call(this, itemID);
      if (tabID) return tabID;

      // 2. If not found, check our split view states for right-side items
      for (const state of self.stateMap.values()) {
        if (state.rightItemID === itemID && !state.isCleaningUp) {
          // Verify the tab still exists in Zotero's _tabs array before returning.
          // The tab may have been closed (removed from _tabs) but our cleanup
          // notifier hasn't fired yet, leaving stale state in stateMap.
          const { tab } = this._getTab(state.tabID);
          if (tab) {
            return state.tabID;
          }
        }
      }

      return null;
    };
  }

  /**
   * Register session restore handler to restore split view tabs after Zotero restart.
   * This should be called once during plugin initialization.
   */
  static registerSessionRestore() {
    // Already registered
    if (this.sessionRestoreNotifierID) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const notifierCallback = {
      notify: async (
        action: string,
        type: string,
        ids: (string | number)[],
        extraData: any,
      ) => {
        if (type !== "tab") return;

        // When a reader tab finishes loading, check if it should be a split view
        if (action === "load") {
          const tabID = String(ids[0]);
          const tabData = extraData?.[tabID];

          // Check if this tab has split view data saved
          if (tabData?.data?.isSplitView) {
            // Small delay to ensure the reader is fully initialized
            setTimeout(async () => {
              try {
                await self.restoreSplitViewFromSession(tabID, tabData.data);
              } catch (e) {
                Zotero.debug(
                  `Split view: Failed to restore split view for tab ${tabID}: ${e}`,
                );
              }
            }, 500);
          }
        }
      },
    };

    this.sessionRestoreNotifierID = Zotero.Notifier.registerObserver(
      notifierCallback,
      ["tab"],
      "splitViewSessionRestore",
      25,
    );

    // Check for already-loaded split view tabs that may have been missed
    // because they loaded before this listener was registered.
    // This handles the case where a split view tab was selected when Zotero closed,
    // causing it to load before the plugin's uiReadyPromise completed.
    setTimeout(() => {
      self.checkAlreadyLoadedSplitViewTabs();
    }, 100);
  }

  /**
   * Check for already-loaded split view tabs that may have been missed
   * because they loaded before the session restore listener was registered.
   */
  private static async checkAlreadyLoadedSplitViewTabs() {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;

      for (const tab of Zotero_Tabs._tabs) {
        // Check loaded reader tabs (not unloaded) that have split view data
        if (tab.type === "reader" && tab.data?.isSplitView) {
          // Skip if already converted to split view
          if (this.stateMap.has(tab.id)) continue;

          Zotero.debug(
            `Split view: Found already-loaded split view tab ${tab.id}, restoring...`,
          );

          try {
            await this.restoreSplitViewFromSession(tab.id, tab.data);
          } catch (e) {
            Zotero.debug(
              `Split view: Failed to restore split view for tab ${tab.id}: ${e}`,
            );
          }
        }
      }
    } catch (e) {
      Zotero.debug(`Split view: checkAlreadyLoadedSplitViewTabs failed: ${e}`);
    }
  }

  /**
   * Register preference observers so that changes in the preference panel
   * take effect immediately on all existing split view tabs.
   */
  static registerPrefObservers() {
    const prefix = config.prefsPrefix;

    // syncEnabled: start/stop sync on existing tabs
    this.syncPrefObserverID = Zotero.Prefs.registerObserver(
      `${prefix}.syncEnabled`,
      (value: boolean) => {
        const enabled = value !== false;
        for (const [tabID, state] of this.stateMap.entries()) {
          if (state.isCleaningUp) continue;
          if (state.syncEnabled === enabled) continue;

          state.syncEnabled = enabled;
          if (enabled) {
            this.initSyncState(tabID);
            this.startSyncPolling(tabID);
          } else {
            this.stopSyncPolling(tabID);
            state.lastLeftScroll = null;
            state.lastRightScroll = null;
          }
          this.updateTabDataForSession(tabID);
        }
      },
      true,
    );

    // primaryScrollbarR/G/B: re-apply scrollbar color to all split view tabs
    const scrollbarPrefKeys: (keyof _ZoteroTypes.Prefs["PluginPrefsMap"])[] = [
      "primaryScrollbarR",
      "primaryScrollbarG",
      "primaryScrollbarB",
    ];
    const onScrollbarPrefChange = () => {
      for (const tabID of this.stateMap.keys()) {
        this.updateScrollbarColors(tabID);
      }
    };
    scrollbarPrefKeys.forEach((key, i) => {
      const id = Zotero.Prefs.registerObserver(
        `${prefix}.${key}`,
        onScrollbarPrefChange,
        true,
      );
      this.scrollbarPrefObserverIDs[i] = id;
    });
  }

  /**
   * Register a named command in the Shift+P command palette.
   * Context-aware: in a reader tab it starts the split view flow immediately;
   * in the library or any other tab it enters the two-step PDF selection flow.
   */
  static registerPromptCommands() {
    ztoolkit.Prompt.register([
      {
        id: SPLIT_VIEW_PROMPT_COMMAND_ID,
        name: getString("splitview-command-label"),
        label: "Split-View Reader",
        callback: async (prompt) => {
          const win = Zotero.getMainWindow();
          const Zotero_Tabs = (win as any).Zotero_Tabs;
          const selectedTabID = Zotero_Tabs?.selectedID;
          const reader = selectedTabID
            ? Zotero.Reader.getByTabID(selectedTabID)
            : null;

          // Hide the command palette before proceeding
          prompt.promptNode.style.display = "none";

          if (reader) {
            // We are inside a reader tab – start split view with this PDF on the left
            await this.handleSplitView(reader);
          } else {
            // Library or other non-reader tab – two-step flow
            await this.openSplitViewFromLibrary();
          }
        },
      },
    ]);
  }

  /**
   * Open two PDF attachments in a split-view tab.
   * A fresh reader tab is used as the host so callers do not need to manage
   * existing reader state first.
   */
  static async openItemsInSplitView(
    leftPDF: Zotero.Item,
    rightPDF: Zotero.Item,
    options: OpenSplitViewOptions = {},
  ) {
    if (
      !leftPDF?.isFileAttachment?.() ||
      leftPDF.attachmentContentType !== "application/pdf"
    ) {
      throw new Error("Left item is not a PDF attachment");
    }
    if (
      !rightPDF?.isFileAttachment?.() ||
      rightPDF.attachmentContentType !== "application/pdf"
    ) {
      throw new Error("Right item is not a PDF attachment");
    }

    const reader = (await Zotero.Reader.open(leftPDF.id)) || null;
    if (!reader) {
      throw new Error("Failed to open the source PDF");
    }

    await this.waitForReaderReady(reader);

    if (leftPDF.id === rightPDF.id) {
      await this.convertToSamePDFSplitView(reader);
      return;
    }

    await this.convertToSplitView(reader, rightPDF);

    const state = this.stateMap.get(reader.tabID);
    if (!state || state.isCleaningUp) return;

    if (options.primarySide && options.primarySide !== state.primarySide) {
      this.setPrimarySide(reader.tabID, options.primarySide);
    }

    if (options.activeSide && options.activeSide !== state.activeSide) {
      state.activeSide = options.activeSide;
      const targetParentItemID =
        options.activeSide === "right"
          ? state.rightParentItemID
          : state.leftParentItemID;
      this.updateContextPane(
        reader.tabID,
        Zotero.getMainWindow(),
        targetParentItemID,
      );
    }
  }

  /**
   * Unregister all split view notifiers and cleanup.
   * This should be called during plugin shutdown.
   */
  static unregisterAll() {
    // Save view states for all active split views before cleanup.
    // This ensures PDF page/zoom positions are preserved when Zotero closes.
    for (const [_tabID, state] of this.stateMap.entries()) {
      if (state.isCleaningUp) continue;
      try {
        let leftCurrentState: any = null;
        let rightCurrentState: any = null;
        try {
          leftCurrentState = this.getCurrentViewStateFromBrowser(
            state.leftBrowser,
          );
        } catch {
          // Browser may be dead
        }
        try {
          rightCurrentState = this.getCurrentViewStateFromBrowser(
            state.rightBrowser,
          );
        } catch {
          // Browser may be dead
        }
        // Fire and forget - async save
        Promise.all([
          this.saveViewStateToDisk(
            state.leftItemID,
            leftCurrentState || state.leftViewState,
          ),
          this.saveViewStateToDisk(
            state.rightItemID,
            rightCurrentState || state.rightViewState,
          ),
        ]).catch(() => {
          /* Ignore save errors during shutdown */
        });
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Clean up all active split views
    for (const tabID of this.stateMap.keys()) {
      try {
        this.cleanupTabResources(tabID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - cleanupTabResources(${tabID}) failed: ${e}`,
        );
      }
    }
    this.stateMap.clear();

    // Unregister session restore notifier
    if (this.sessionRestoreNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.sessionRestoreNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(session) failed: ${e}`,
        );
      }
      this.sessionRestoreNotifierID = null;
    }

    // Unregister global tab notifier
    if (this.globalTabNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.globalTabNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(globalTab) failed: ${e}`,
        );
      }
      this.globalTabNotifierID = null;
    }

    // Unregister preference observers (sync + scrollbar color)
    if (this.syncPrefObserverID) {
      try {
        Zotero.Prefs.unregisterObserver(this.syncPrefObserverID);
      } catch (e) {
        Zotero.debug(
          `Split view: unregisterAll - unregisterObserver(syncPref) failed: ${e}`,
        );
      }
      this.syncPrefObserverID = null;
    }
    this.scrollbarPrefObserverIDs.forEach((id, i) => {
      if (id) {
        try {
          Zotero.Prefs.unregisterObserver(id);
        } catch (e) {
          Zotero.debug(
            `Split view: unregisterAll - unregisterObserver(scrollbarPref[${i}]) failed: ${e}`,
          );
        }
        this.scrollbarPrefObserverIDs[i] = null;
      }
    });

    // Restore Zotero_Tabs.getTabIDByItemID to avoid holding references and stale tab IDs
    this.unregisterTabLookup();

    // Unregister our command so Prompt no longer holds our callback
    try {
      ztoolkit.Prompt.unregister(SPLIT_VIEW_PROMPT_COMMAND_ID);
    } catch (e) {
      Zotero.debug(
        `Split view: unregisterAll - Prompt.unregister failed: ${e}`,
      );
    }
  }

  /**
   * Restore original Zotero_Tabs.getTabIDByItemID. Call on plugin unload to avoid
   * holding references to stateMap and to prevent returning stale tab IDs.
   */
  private static unregisterTabLookup() {
    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      if (!Zotero_Tabs) return;
      const original = (Zotero_Tabs as any)._originalGetTabIDByItemID;
      if (typeof original === "function") {
        Zotero_Tabs.getTabIDByItemID = original;
        (Zotero_Tabs as any)._originalGetTabIDByItemID = undefined;
      }
    } catch (e) {
      Zotero.debug(`Split view: unregisterTabLookup failed: ${e}`);
    }
  }

  /**
   * Restore split view from saved session data
   */
  private static async restoreSplitViewFromSession(
    tabID: string,
    savedData: any,
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // Get the reader that was just loaded
    const reader = Zotero.Reader.getByTabID(tabID);
    if (!reader) {
      Zotero.debug(
        `Split view: Cannot restore - reader not found for tab ${tabID}`,
      );
      return;
    }

    // Wait for reader to be fully initialized
    if (reader._initPromise) {
      await reader._initPromise;
    }

    // Check if already converted (e.g., user manually enabled split view)
    if (this.stateMap.has(tabID)) {
      Zotero.debug(
        `Split view: Tab ${tabID} already has split view, skipping restore`,
      );
      return;
    }

    const {
      leftItemID,
      rightItemID,
      isSamePDF,
      splitRatio,
      syncEnabled,
      primarySide,
      activeSide,
    } = savedData;

    // Validate items still exist
    if (!Zotero.Items.exists(leftItemID) || !Zotero.Items.exists(rightItemID)) {
      Zotero.debug(
        `Split view: Cannot restore - one or both items no longer exist`,
      );
      return;
    }

    const leftItem = Zotero.Items.get(leftItemID);
    const rightItem = Zotero.Items.get(rightItemID);

    if (!leftItem || !rightItem) {
      Zotero.debug(`Split view: Cannot restore - failed to get items`);
      return;
    }

    Zotero.debug(
      `Split view: Restoring split view for tab ${tabID} (isSamePDF: ${isSamePDF})`,
    );

    if (isSamePDF) {
      // Restore same-PDF split view
      await this.convertToSamePDFSplitView(reader);
    } else {
      // Restore different-PDF split view
      await this.convertToSplitView(reader, rightItem);
    }

    // Restore saved settings
    const state = this.stateMap.get(tabID);
    if (state) {
      // Restore split ratio
      if (typeof splitRatio === "number" && splitRatio > 0 && splitRatio < 1) {
        state.splitRatio = splitRatio;
        this.updateBrowserFlex(
          state.leftBrowser,
          state.rightBrowser,
          splitRatio,
        );
      }

      // Restore sync setting
      if (typeof syncEnabled === "boolean") {
        state.syncEnabled = syncEnabled;
        if (!syncEnabled) {
          this.stopSyncPolling(tabID);
        }
      }

      // Restore primary side setting (directly set state to avoid
      // notification popup that setPrimarySide shows)
      if (primarySide === "left" || primarySide === "right") {
        state.primarySide = primarySide;
        this.updateScrollbarColors(tabID);
        // Sync polling will be started by convertToSplitView's delay timer
      }

      // Restore active side
      if (activeSide === "left" || activeSide === "right") {
        state.activeSide = activeSide;
      }
    }

    Zotero.debug(
      `Split view: Successfully restored split view for tab ${tabID}`,
    );
  }

  /**
   * Update tab data with current split view state for session persistence.
   * Called when split ratio or sync settings change.
   */
  private static updateTabDataForSession(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;

      Zotero_Tabs.setTabData(tabID, {
        itemID: state.leftItemID,
        leftItemID: state.leftItemID,
        rightItemID: state.rightItemID,
        isSplitView: true,
        isSamePDF: state.isSamePDF,
        splitRatio: state.splitRatio,
        syncEnabled: state.syncEnabled,
        primarySide: state.primarySide,
        activeSide: state.activeSide,
      });
    } catch (e) {
      Zotero.debug(`Split view: Failed to update tab data: ${e}`);
    }
  }

  /**
   * Determine which side (left/right) a reader belongs to based on itemID
   */
  private static getReaderSide(
    tabID: string,
    reader: any,
  ): "left" | "right" | null {
    const state = this.stateMap.get(tabID);
    if (!state) return null;

    try {
      if (reader.itemID === state.leftItemID) {
        return "left";
      }
      if (reader.itemID === state.rightItemID) {
        return "right";
      }
    } catch (e) {
      Zotero.debug(`Split view: getReaderSide error: ${e}`);
      return null;
    }

    return null;
  }

  /**
   * Set which side is the primary (controller)
   */
  private static setPrimarySide(tabID: string, side: "left" | "right") {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Stop current sync before changing
    this.stopSyncPolling(tabID);

    state.primarySide = side;

    // Update scrollbar colors to reflect new primary side
    this.updateScrollbarColors(tabID);

    // Restart sync with new primary
    if (state.syncEnabled) {
      this.initSyncState(tabID);
      this.startSyncPolling(tabID);
    }
  }

  /**
   * Replace the browser element for a side to ensure fresh state
   * @param tabID Tab ID
   * @param side 'left' or 'right'
   * @returns The new browser element
   */
  private static async replaceBrowser(
    tabID: string,
    side: "left" | "right",
  ): Promise<XULBrowserElement | null> {
    const state = this.stateMap.get(tabID);
    if (!state) return null;

    const oldBrowser = side === "left" ? state.leftBrowser : state.rightBrowser;
    const container = oldBrowser.parentNode;

    if (!container) return null;

    // Close the old reader instance associated with this browser.
    // This removes it from Zotero.Reader._readers and prevents orphaned readers.
    const oldReader = this.getReaderForBrowser(oldBrowser);
    if (oldReader) {
      await this.closeReaderWithoutClosingTab(oldReader);
    }

    // Create new browser element
    const doc = oldBrowser.ownerDocument;
    if (!doc) return null;
    const newBrowser = doc.createXULElement("browser") as XULBrowserElement;

    // Copy attributes from createReaderBrowser
    newBrowser.setAttribute("type", "content");
    newBrowser.setAttribute("transparent", "true");
    newBrowser.setAttribute("src", "resource://zotero/reader/reader.html");

    // Copy styles from old browser to maintain layout
    newBrowser.className = oldBrowser.className;

    // Manually copy style properties to preserve layout
    const oldStyle = (oldBrowser as any).style;
    (newBrowser as any).style.flex = oldStyle.flex;
    (newBrowser as any).style.minWidth = oldStyle.minWidth;
    (newBrowser as any).style.maxWidth = oldStyle.maxWidth;
    (newBrowser as any).style.overflow = oldStyle.overflow;
    (newBrowser as any).style.boxSizing = oldStyle.boxSizing;

    // Remove tracked event listeners bound to the old browser before replacing it.
    // This avoids stale references and cleanup errors when the old browser is dead.
    state.eventListeners = state.eventListeners.filter((entry) => {
      if (entry.target === oldBrowser) {
        try {
          entry.target.removeEventListener(
            entry.type,
            entry.listener,
            entry.options,
          );
        } catch {
          // Old browser may already be dead
        }
        return false;
      }
      return true;
    });

    // Replace in DOM
    container.replaceChild(newBrowser, oldBrowser);

    // Update state
    if (side === "left") {
      state.leftBrowser = newBrowser;
    } else {
      state.rightBrowser = newBrowser;
    }

    return newBrowser;
  }

  /**
   * Find the Zotero Reader instance associated with a browser element.
   * Searches Zotero.Reader._readers for a reader whose _iframe matches the browser.
   */
  private static getReaderForBrowser(browser: XULBrowserElement): any {
    try {
      const readers = (Zotero.Reader as any)._readers;
      if (!readers || !Array.isArray(readers)) return null;
      return readers.find((r: any) => r._iframe === browser) || null;
    } catch {
      return null;
    }
  }

  /**
   * Select and load a new PDF in the secondary (non-primary) window
   */
  /**
   * Select and load a new PDF in the specified side panel.
   * @param tabID Tab ID
   * @param targetSide The side where the new PDF will be loaded (based on where the user right-clicked)
   */
  private static async selectAndLoadPDF(
    tabID: string,
    targetSide: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Get the current item ID for the target side
    const currentItemID =
      targetSide === "left" ? state.leftItemID : state.rightItemID;
    const currentItem = Zotero.Items.get(currentItemID);

    // Show PDF selection dialog
    const selectedPDF = await this.showItemPrompt(currentItem.libraryID);
    if (!selectedPDF) return;

    // Check if the selected PDF is the same as the currently loaded one
    if (selectedPDF.id === currentItemID) {
      // Same PDF - no need to reload
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
      return;
    }

    // Load the new PDF in the target side
    try {
      // Stop sync polling during reload
      const wasSyncEnabled = state.syncEnabled;
      if (wasSyncEnabled) {
        this.stopSyncPolling(tabID);
      }

      // Get the view state for the new PDF
      const newViewState = await this.getStoredViewState(selectedPDF);

      // Get the appropriate popupset
      const popupset =
        targetSide === "left" ? state.leftPopupset : state.rightPopupset;

      // Replace the browser element to ensure a fresh state
      // This avoids race conditions with waitForBrowserLoad on reused browsers
      const newBrowser = await this.replaceBrowser(tabID, targetSide);
      if (!newBrowser) {
        throw new Error("Failed to replace browser element");
      }

      // Reload the browser with the new PDF
      const win = Zotero.getMainWindow();
      await this.initializeReader(
        tabID,
        newBrowser,
        selectedPDF,
        popupset,
        newViewState,
        targetSide === "right", // isRight parameter
      );

      // Setup listeners for the new browser
      // Use the shared focus listener method with all proper guards
      // to prevent redundant "Section item data changed" events
      this.setupBrowserFocusListeners(tabID, newBrowser, targetSide, win);
      this.setupCtrlKeyListener(tabID, newBrowser);
      this.setupZoomButtonListeners(tabID, newBrowser);

      // Update state with new item ID
      if (targetSide === "left") {
        state.leftItemID = selectedPDF.id;
        state.leftParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      } else {
        state.rightItemID = selectedPDF.id;
        state.rightParentItemID = selectedPDF.parentItemID || selectedPDF.id;
      }

      // Update isSamePDF flag
      state.isSamePDF = state.leftItemID === state.rightItemID;

      // Setup annotation sync if we are now viewing the same PDF
      if (state.isSamePDF) {
        this.setupAnnotationManagerSync(tabID);
      }

      // Make the side where we opened the PDF the primary and apply scrollbar color
      state.primarySide = targetSide;
      this.updateScrollbarColors(tabID);

      // Update tab data
      this.updateTabDataForSession(tabID);

      // Update tab title
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const leftItem = Zotero.Items.get(state.leftItemID);
      const rightItem = Zotero.Items.get(state.rightItemID);
      const leftTitle = String(leftItem.getField("title") || "PDF").substring(
        0,
        50,
      );
      const rightTitle = String(rightItem.getField("title") || "PDF").substring(
        0,
        50,
      );

      if (state.isSamePDF) {
        Zotero_Tabs.rename(tabID, `${leftTitle}`);
      } else {
        Zotero_Tabs.rename(tabID, `${leftTitle} | ${rightTitle}`);
      }

      // Restart sync if it was enabled
      if (wasSyncEnabled) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.syncEnabled) {
              this.cacheViewerContainers(tabID);
              this.initSyncState(tabID);
              this.startSyncPolling(tabID);
            }
          },
          500,
        );
      }

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: Error loading PDF on ${targetSide} side: ${e}`);

      // Show error notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-not-found"),
          type: "error",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    }
  }

  /**
   * Swap the PDFs between left and right panels.
   * Recreates both browser instances with swapped items and view states.
   * Primary and active side states follow the swap.
   */
  private static async swapPDFs(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      // 1. Save current view states from browsers
      let leftCurrentState: any = null;
      let rightCurrentState: any = null;
      try {
        leftCurrentState = this.getCurrentViewStateFromBrowser(
          state.leftBrowser,
        );
      } catch {
        // Browser may be dead
      }
      try {
        rightCurrentState = this.getCurrentViewStateFromBrowser(
          state.rightBrowser,
        );
      } catch {
        // Browser may be dead
      }
      const leftViewState = leftCurrentState || state.leftViewState;
      const rightViewState = rightCurrentState || state.rightViewState;

      // 2. Record current item IDs and parent IDs
      const oldLeftItemID = state.leftItemID;
      const oldRightItemID = state.rightItemID;
      const oldLeftParentItemID = state.leftParentItemID;
      const oldRightParentItemID = state.rightParentItemID;

      // 3. Stop sync polling during swap
      const wasSyncEnabled = state.syncEnabled;
      if (wasSyncEnabled) {
        this.stopSyncPolling(tabID);
      }

      // 4. Replace both browsers to get fresh instances (closes old readers)
      const newLeftBrowser = await this.replaceBrowser(tabID, "left");
      const newRightBrowser = await this.replaceBrowser(tabID, "right");
      if (!newLeftBrowser || !newRightBrowser) {
        throw new Error("Failed to replace browser elements for swap");
      }

      // 5. Swap state: left gets old right, right gets old left
      state.leftItemID = oldRightItemID;
      state.rightItemID = oldLeftItemID;
      state.leftParentItemID = oldRightParentItemID;
      state.rightParentItemID = oldLeftParentItemID;
      state.leftViewState = rightViewState;
      state.rightViewState = leftViewState;

      // 6. Primary and active sides remain unchanged (do not follow the swap)

      // 7. Get items for initialization
      const newLeftItem = Zotero.Items.get(state.leftItemID);
      const newRightItem = Zotero.Items.get(state.rightItemID);
      if (!newLeftItem || !newRightItem) {
        throw new Error("Failed to get items for swap");
      }

      // 8. Initialize both readers with swapped content
      const win = Zotero.getMainWindow();
      await Promise.all([
        this.initializeReader(
          tabID,
          newLeftBrowser,
          newLeftItem,
          state.leftPopupset,
          rightViewState,
          false, // left is never isRight
        ),
        this.initializeReader(
          tabID,
          newRightBrowser,
          newRightItem,
          state.rightPopupset,
          leftViewState,
          true, // right is always isRight
        ),
      ]);

      // 9. Setup listeners for both new browsers
      this.setupFocusListeners(tabID, newLeftBrowser, newRightBrowser, win);
      this.setupCtrlKeyListener(tabID, newLeftBrowser);
      this.setupCtrlKeyListener(tabID, newRightBrowser);
      this.setupZoomButtonListeners(tabID, newLeftBrowser);
      this.setupZoomButtonListeners(tabID, newRightBrowser);

      // 10. Update scrollbar colors to reflect new primary side
      this.updateScrollbarColors(tabID);

      // 11. Update context pane for the active side
      const activeParentItemID =
        state.activeSide === "left"
          ? state.leftParentItemID
          : state.rightParentItemID;
      this.updateContextPane(tabID, win, activeParentItemID);

      // 12. Setup annotation sync if same PDF
      if (state.isSamePDF) {
        this.setupAnnotationManagerSync(tabID);
      }

      // 13. Update tab data and title
      this.updateTabDataForSession(tabID);

      const Zotero_Tabs = (win as any).Zotero_Tabs;
      const leftTitle = String(
        newLeftItem.getField("title") || "PDF",
      ).substring(0, 50);
      const rightTitle = String(
        newRightItem.getField("title") || "PDF",
      ).substring(0, 50);
      if (state.isSamePDF) {
        Zotero_Tabs.rename(tabID, `${leftTitle}`);
      } else {
        Zotero_Tabs.rename(tabID, `${leftTitle} | ${rightTitle}`);
      }

      // 14. Restart sync if it was enabled
      if (wasSyncEnabled) {
        this.trackTimeout(
          state,
          () => {
            const s = this.stateMap.get(tabID);
            if (s && s.syncEnabled) {
              this.cacheViewerContainers(tabID);
              this.initSyncState(tabID);
              this.startSyncPolling(tabID);
            }
          },
          500,
        );
      }

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-swap-pdf"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: Error swapping PDFs: ${e}`);
    }
  }

  private static async handleSplitView(reader: any) {
    const tabID = reader.tabID;
    try {
      // Clean up any stale state for THIS tab only
      const existingState = this.stateMap.get(tabID);
      if (existingState && !existingState.isCleaningUp) {
        this.cleanupTab(tabID);
      }

      // Wait a bit for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const currentItem = Zotero.Items.get(reader.itemID);
      const selectedPDF = await this.showItemPrompt(currentItem.libraryID);
      if (!selectedPDF) return;

      // Check if same PDF
      const isSamePDF = selectedPDF.id === reader.itemID;

      if (isSamePDF) {
        // Same file: use dual browser with annotation sync
        await this.convertToSamePDFSplitView(reader);
      } else {
        // Different files: use existing dual browser approach
        await this.convertToSplitView(reader, selectedPDF);
      }
    } catch {
      const s = this.stateMap.get(tabID);
      if (s && !s.isCleaningUp) {
        this.cleanupTab(tabID);
      }
    }
  }

  /**
   * Convert current reader tab to split view
   * Keeps the current PDF on the left side and adds the secondary PDF on the right
   */
  private static async convertToSplitView(
    currentReader: any,
    secondaryPDF: Zotero.Item,
  ) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // 1. Get current tab and reader info
    const tabID = currentReader.tabID;
    const leftItemID = currentReader.itemID;
    const leftItem = Zotero.Items.get(leftItemID);
    const container = win.document.getElementById(tabID);

    if (!container) {
      throw new Error("Tab container not found");
    }

    // 2. Save current reader's viewState (position info)
    const leftViewState = await this.getViewStateFromReader(currentReader);

    // 3. Get right PDF's stored state
    const rightViewState = await this.getStoredViewState(secondaryPDF);

    // 4. Close current reader (but don't close tab)
    await this.closeReaderWithoutClosingTab(currentReader);

    // 5. Replace tab container to remove old event listeners
    // The old ReaderTab added event listeners for tab-bottom-placeholder-resize,
    // tab-context-pane-toggle, and tab-selection-change that reference the dead reader.
    // Cloning without events removes these stale listeners.
    const newContainer = container.cloneNode(false) as HTMLElement;
    container.parentNode?.replaceChild(newContainer, container);

    // Restore TabContent custom element methods on the cloned container.
    // cloneNode may not preserve custom element prototype methods, so Zotero's
    // contextPane.update() calling tabContent.setContextPaneOpen() would fail.
    // These methods just dispatch events that our listeners below will handle.
    (newContainer as any).setContextPaneOpen = function (open: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-context-pane-toggle", {
          detail: { open },
        }),
      );
    };
    (newContainer as any).setBottomPlaceholderHeight = function (
      height: number,
    ) {
      this.dispatchEvent(
        new win.CustomEvent("tab-bottom-placeholder-resize", {
          detail: { height },
        }),
      );
    };
    (newContainer as any).onTabSelectionChanged = function (selected: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-selection-change", {
          detail: { selected },
        }),
      );
    };

    // Reset container styles to ensure proper flex layout
    (newContainer as any).style.display = "flex";
    (newContainer as any).style.flexDirection = "row";
    (newContainer as any).style.width = "100%";
    (newContainer as any).style.height = "100%";
    (newContainer as any).style.overflow = "hidden";

    // 6. Get item info for tab title
    const leftTitle = String(leftItem.getField("title") || "PDF 1").substring(
      0,
      30,
    );
    const rightTitle = String(
      secondaryPDF.getField("title") || "PDF 2",
    ).substring(0, 30);

    // 7. Build split view layout
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    (mainHbox as any).style.display = "flex";
    (mainHbox as any).style.flexDirection = "row";
    (mainHbox as any).style.flex = "1 1 100%";
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";
    (mainHbox as any).style.minWidth = "0";
    (mainHbox as any).style.overflow = "hidden";
    (mainHbox as any).style.boxSizing = "border-box";

    const leftBrowser = this.createReaderBrowser(win);
    const rightBrowser = this.createReaderBrowser(win);

    const resizer = win.document.createXULElement("box") as XULElement;
    resizer.className = "split-view-resizer";
    (resizer as any).style.cssText = `
      width: 1px;
      min-width: 1px;
      max-width: 1px;
      flex: 0 0 1px;
      cursor: ew-resize;
      background: var(--fill-quarternary, rgba(0, 0, 0, 0.1));
      position: relative;
      z-index: 100;
      box-sizing: border-box;
    `;
    resizer.setAttribute("mousethrough", "never");

    const leftPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;
    const rightPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(resizer);
    mainHbox.appendChild(rightBrowser);
    newContainer.appendChild(mainHbox);
    newContainer.appendChild(leftPopupset);
    newContainer.appendChild(rightPopupset);

    // Set up event listeners for tab content events (replacing the dead reader's listeners)
    // Handlers are stored so they can be tracked in state after state creation.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const bottomPlaceholderHandler = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const height =
        event.detail?.height !== undefined ? event.detail.height : null;
      try {
        const leftReader = self.getInternalReaderFromBrowser(s.leftBrowser);
        const rightReader = self.getInternalReaderFromBrowser(s.rightBrowser);
        if (leftReader?.setBottomPlaceholderHeight) {
          leftReader.setBottomPlaceholderHeight(height);
        }
        if (rightReader?.setBottomPlaceholderHeight) {
          rightReader.setBottomPlaceholderHeight(height);
        }
      } catch {
        // Ignore errors - readers may not be ready
      }
    };

    const contextPaneToggleHandler = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const open = event.detail?.open ?? false;
      if (s.rightBrowser) {
        self.setContextPaneOpenForBrowser(s.rightBrowser, open);
      }
    };

    const tabSelectionChangeHandler = (_event: any) => {
      // No special handling needed for split view
    };

    // Listeners are added here; they will be tracked in state after state creation below
    newContainer.addEventListener(
      "tab-bottom-placeholder-resize",
      bottomPlaceholderHandler,
    );
    newContainer.addEventListener(
      "tab-context-pane-toggle",
      contextPaneToggleHandler,
    );
    newContainer.addEventListener(
      "tab-selection-change",
      tabSelectionChangeHandler,
    );

    // Get parent item IDs for context pane switching
    const leftParentItemID = leftItem.parentItemID || leftItem.id;
    const rightParentItemID = secondaryPDF.parentItemID || secondaryPDF.id;

    // 8. Initialize state and store in map (reuse current tabID)
    //    Capture original tab title before we rename it, for possible future use.
    let originalTitle: string | undefined;
    try {
      const { tab } = Zotero_Tabs._getTab(tabID);
      originalTitle = tab?.title;
    } catch {
      originalTitle = undefined;
    }

    const newState: SplitTabState = {
      tabID,
      container: newContainer as unknown as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID,
      rightItemID: secondaryPDF.id,
      leftParentItemID,
      rightParentItemID,
      syncEnabled: getPref("syncEnabled") !== false,
      primarySide: "left",
      activeSide: "left",
      leftScrollHandler: null,
      rightScrollHandler: null,
      lastLeftScroll: null,
      lastRightScroll: null,
      syncPaused: false,
      sidebarToggleTimers: [],
      ctrlPressed: false,
      zoomingCount: 0,
      eventListeners: [],
      timeoutIds: [],
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: rightViewState,
      isCleaningUp: false,
      // Different PDF split view - no same PDF sync
      isSamePDF: false,
      annotationNotifierID: null,
      isSyncingSelection: false,
      annotationItemIDs: [],
      scrollSyncRAFPending: false,
      lastScrollSyncTime: 0,
      resizeTimerId: null,
      originalTitle,
    };
    this.stateMap.set(tabID, newState);

    // Track container event listeners that were added before state creation
    newState.eventListeners.push(
      {
        target: newContainer,
        type: "tab-bottom-placeholder-resize",
        listener: bottomPlaceholderHandler as EventListener,
      },
      {
        target: newContainer,
        type: "tab-context-pane-toggle",
        listener: contextPaneToggleHandler as EventListener,
      },
      {
        target: newContainer,
        type: "tab-selection-change",
        listener: tabSelectionChangeHandler as EventListener,
      },
    );

    // Set up drag functionality
    this.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.updateBrowserFlex(leftBrowser, rightBrowser, newState.splitRatio);

    // Register global tab notifier (if not already registered)
    this.ensureGlobalTabNotifier(win);

    // Set up context pane
    this.setupContextPane(tabID, win);

    // 9. Initialize both readers (with viewState)
    try {
      await Promise.all([
        this.initializeReader(
          tabID,
          leftBrowser,
          leftItem,
          leftPopupset,
          leftViewState,
          false,
        ),
        this.initializeReader(
          tabID,
          rightBrowser,
          secondaryPDF,
          rightPopupset,
          rightViewState,
          true,
        ),
      ]);

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(3000);

      // Initialize context pane with left item
      const curState = this.stateMap.get(tabID);
      if (curState) {
        curState.activeSide = "left";
        this.updateContextPane(tabID, win, curState.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);

      // Enable sync after delay
      this.trackTimeout(
        newState,
        () => {
          const s = this.stateMap.get(tabID);
          if (s && s.syncEnabled) {
            this.cacheViewerContainers(tabID);
            this.initSyncState(tabID);
            this.startSyncPolling(tabID);
            this.setupResizeListener(tabID, win);
            this.setupCtrlKeyListener(tabID, leftBrowser);
            this.setupCtrlKeyListener(tabID, rightBrowser);
            this.setupMainWindowKeyboardListener(tabID, win);
            this.setupZoomButtonListeners(tabID, leftBrowser);
            this.setupZoomButtonListeners(tabID, rightBrowser);
            this.setupContextPaneObserver(tabID, win);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 10. Update tab data and title (include split view state for session restore)
      Zotero_Tabs.setTabData(tabID, {
        itemID: leftItemID,
        leftItemID,
        rightItemID: secondaryPDF.id,
        isSplitView: true,
        isSamePDF: false,
        splitRatio: newState.splitRatio,
        syncEnabled: newState.syncEnabled,
      });
      // Different-PDF split view: show "Name1 | Name2" without extra prefix.
      Zotero_Tabs.rename(tabID, `${leftTitle} | ${rightTitle}`);
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
  }

  /**
   * Convert current reader tab to split view with the same PDF
   * Both sides show the same PDF with annotation synchronization
   */
  private static async convertToSamePDFSplitView(currentReader: any) {
    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // 1. Get current tab and reader info
    const tabID = currentReader.tabID;
    const itemID = currentReader.itemID;
    const item = Zotero.Items.get(itemID);
    const container = win.document.getElementById(tabID);

    if (!container) {
      throw new Error("Tab container not found");
    }

    // 2. Save current reader's viewState (position info)
    const leftViewState = await this.getViewStateFromReader(currentReader);

    // 3. Close current reader (but don't close tab)
    await this.closeReaderWithoutClosingTab(currentReader);

    // 4. Replace tab container to remove old event listeners
    const newContainer = container.cloneNode(false) as HTMLElement;
    container.parentNode?.replaceChild(newContainer, container);

    // Restore TabContent custom element methods on the cloned container.
    // cloneNode may not preserve custom element prototype methods, so Zotero's
    // contextPane.update() calling tabContent.setContextPaneOpen() would fail.
    (newContainer as any).setContextPaneOpen = function (open: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-context-pane-toggle", {
          detail: { open },
        }),
      );
    };
    (newContainer as any).setBottomPlaceholderHeight = function (
      height: number,
    ) {
      this.dispatchEvent(
        new win.CustomEvent("tab-bottom-placeholder-resize", {
          detail: { height },
        }),
      );
    };
    (newContainer as any).onTabSelectionChanged = function (selected: boolean) {
      this.dispatchEvent(
        new win.CustomEvent("tab-selection-change", {
          detail: { selected },
        }),
      );
    };

    // Reset container styles
    (newContainer as any).style.display = "flex";
    (newContainer as any).style.flexDirection = "row";
    (newContainer as any).style.width = "100%";
    (newContainer as any).style.height = "100%";
    (newContainer as any).style.overflow = "hidden";

    // 5. Get item info for tab title (for potential use), but we will
    //    keep the original tab title when splitting the same PDF.
    const title = String(item.getField("title") || "PDF").substring(0, 50);

    // 6. Build split view layout
    const mainHbox = win.document.createXULElement("hbox") as XULElement;
    (mainHbox as any).style.display = "flex";
    (mainHbox as any).style.flexDirection = "row";
    (mainHbox as any).style.flex = "1 1 100%";
    (mainHbox as any).style.width = "100%";
    (mainHbox as any).style.height = "100%";
    (mainHbox as any).style.minWidth = "0";
    (mainHbox as any).style.overflow = "hidden";
    (mainHbox as any).style.boxSizing = "border-box";

    const leftBrowser = this.createReaderBrowser(win);
    const rightBrowser = this.createReaderBrowser(win);

    const resizer = win.document.createXULElement("box") as XULElement;
    resizer.className = "split-view-resizer";
    (resizer as any).style.cssText = `
      width: 1px;
      min-width: 1px;
      max-width: 1px;
      flex: 0 0 1px;
      cursor: ew-resize;
      background: var(--fill-quarternary, rgba(0, 0, 0, 0.1));
      position: relative;
      z-index: 100;
      box-sizing: border-box;
    `;
    resizer.setAttribute("mousethrough", "never");

    const leftPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;
    const rightPopupset = win.document.createXULElement(
      "popupset",
    ) as XULElement;

    mainHbox.appendChild(leftBrowser);
    mainHbox.appendChild(resizer);
    mainHbox.appendChild(rightBrowser);
    newContainer.appendChild(mainHbox);
    newContainer.appendChild(leftPopupset);
    newContainer.appendChild(rightPopupset);

    // Set up event listeners for tab content events
    // Handlers are stored so they can be tracked in state after state creation.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const bottomPlaceholderHandler2 = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const height =
        event.detail?.height !== undefined ? event.detail.height : null;
      try {
        const leftReader = self.getInternalReaderFromBrowser(s.leftBrowser);
        const rightReader = self.getInternalReaderFromBrowser(s.rightBrowser);
        if (leftReader?.setBottomPlaceholderHeight) {
          leftReader.setBottomPlaceholderHeight(height);
        }
        if (rightReader?.setBottomPlaceholderHeight) {
          rightReader.setBottomPlaceholderHeight(height);
        }
      } catch {
        // Ignore errors
      }
    };

    const contextPaneToggleHandler2 = (event: any) => {
      const s = self.stateMap.get(tabID);
      if (!s || s.isCleaningUp) return;
      const open = event.detail?.open ?? false;
      if (s.rightBrowser) {
        self.setContextPaneOpenForBrowser(s.rightBrowser, open);
      }
    };

    const tabSelectionChangeHandler2 = () => {
      // No special handling needed
    };

    newContainer.addEventListener(
      "tab-bottom-placeholder-resize",
      bottomPlaceholderHandler2,
    );
    newContainer.addEventListener(
      "tab-context-pane-toggle",
      contextPaneToggleHandler2,
    );
    newContainer.addEventListener(
      "tab-selection-change",
      tabSelectionChangeHandler2,
    );

    // Get parent item ID for context pane
    const parentItemID = item.parentItemID || item.id;

    // 7. Initialize state and store in map
    //    Capture original tab title before any rename, so we could restore or
    //    inspect it in the future if needed.
    let originalTitle: string | undefined;
    try {
      const { tab } = Zotero_Tabs._getTab(tabID);
      originalTitle = tab?.title;
    } catch {
      originalTitle = undefined;
    }

    const newState: SplitTabState = {
      tabID,
      container: newContainer as unknown as XUL.Box,
      leftBrowser,
      rightBrowser,
      leftPopupset,
      rightPopupset,
      leftItemID: itemID,
      rightItemID: itemID, // Same PDF
      leftParentItemID: parentItemID,
      rightParentItemID: parentItemID, // Same parent
      syncEnabled: getPref("syncEnabled") !== false,
      primarySide: "left",
      activeSide: "left",
      leftScrollHandler: null,
      rightScrollHandler: null,
      lastLeftScroll: null,
      lastRightScroll: null,
      syncPaused: false,
      sidebarToggleTimers: [],
      ctrlPressed: false,
      zoomingCount: 0,
      eventListeners: [],
      timeoutIds: [],
      leftViewerContainer: null,
      rightViewerContainer: null,
      splitRatio: 0.5,
      leftViewState: leftViewState,
      rightViewState: leftViewState, // Start at same position as left side
      isCleaningUp: false,
      // Same PDF split view specific
      isSamePDF: true,
      annotationNotifierID: null,
      isSyncingSelection: false,
      annotationItemIDs: item.getAnnotations().map((ann: any) => ann.id),
      scrollSyncRAFPending: false,
      lastScrollSyncTime: 0,
      resizeTimerId: null,
      originalTitle,
    };
    this.stateMap.set(tabID, newState);

    // Track container event listeners that were added before state creation
    newState.eventListeners.push(
      {
        target: newContainer,
        type: "tab-bottom-placeholder-resize",
        listener: bottomPlaceholderHandler2 as EventListener,
      },
      {
        target: newContainer,
        type: "tab-context-pane-toggle",
        listener: contextPaneToggleHandler2 as EventListener,
      },
      {
        target: newContainer,
        type: "tab-selection-change",
        listener: tabSelectionChangeHandler2 as EventListener,
      },
    );

    // Set up drag functionality
    this.setupResizerDrag(
      tabID,
      resizer,
      leftBrowser,
      rightBrowser,
      mainHbox,
      win,
    );

    // Set initial flex values
    this.updateBrowserFlex(leftBrowser, rightBrowser, newState.splitRatio);

    // Register global tab notifier (if not already registered)
    this.ensureGlobalTabNotifier(win);

    // Set up context pane
    this.setupContextPane(tabID, win);

    // 8. Initialize both readers with the same PDF
    try {
      await Promise.all([
        this.initializeReader(
          tabID,
          leftBrowser,
          item,
          leftPopupset,
          leftViewState,
          false,
        ),
        this.initializeReader(
          tabID,
          rightBrowser,
          item,
          rightPopupset,
          leftViewState,
          true,
        ),
      ]);

      // Show success notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-same-pdf-loaded"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(3000);

      // Initialize context pane with left item
      const curState = this.stateMap.get(tabID);
      if (curState) {
        curState.activeSide = "left";
        this.updateContextPane(tabID, win, curState.leftParentItemID);
      }

      // Set up focus listeners
      this.setupFocusListeners(tabID, leftBrowser, rightBrowser, win);

      // Hook into both readers' annotation managers to mirror changes
      // instantly, replicating Zotero's native split view behavior where
      // both views share one _annotationManager. The render() hook fires
      // synchronously when an annotation is created/modified/deleted,
      // bypassing the slow onSaveAnnotations debounce path entirely.
      this.setupAnnotationManagerSync(tabID);

      // Set up selection sync for same PDF
      this.setupSelectionSync(tabID);

      // Hide secondary toolbar (optional, since they share annotations)
      this.hideSecondaryToolbar(tabID);

      // Enable scroll/zoom sync after delay
      this.trackTimeout(
        newState,
        () => {
          const s = this.stateMap.get(tabID);
          if (s && s.syncEnabled) {
            this.cacheViewerContainers(tabID);
            this.initSyncState(tabID);
            this.startSyncPolling(tabID);
            this.setupResizeListener(tabID, win);
            this.setupCtrlKeyListener(tabID, leftBrowser);
            this.setupCtrlKeyListener(tabID, rightBrowser);
            this.setupMainWindowKeyboardListener(tabID, win);
            this.setupZoomButtonListeners(tabID, leftBrowser);
            this.setupZoomButtonListeners(tabID, rightBrowser);
            this.setupContextPaneObserver(tabID, win);
          }
          // Apply scrollbar colors to indicate primary side
          this.updateScrollbarColors(tabID);
        },
        500,
      );

      // 9. Update tab data (include split view state for session restore).
      //    For same-PDF split view we intentionally DO NOT change the tab title,
      //    so that the label stays exactly as the original reader tab.
      Zotero_Tabs.setTabData(tabID, {
        itemID: itemID,
        leftItemID: itemID,
        rightItemID: itemID,
        isSplitView: true,
        isSamePDF: true,
        splitRatio: newState.splitRatio,
        syncEnabled: newState.syncEnabled,
      });
    } catch (e) {
      this.cleanupTab(tabID);
      throw e;
    }
  }

  // NOTE: The old Notifier-based setupAnnotationSync and refreshAnnotationsInBothViews
  // have been removed. Annotation sync for same-PDF split view is now handled by
  // setupAnnotationManagerSync() which hooks directly into the annotation manager's
  // render() method for instant, synchronous propagation.

  /**
   * Set up selection sync for same PDF split view
   * When an annotation is selected on one side, sync to the other
   */
  private static setupSelectionSync(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || !state.isSamePDF) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Helper to clone data into browser's context to avoid permission errors
    const cloneForBrowser = (browser: XULBrowserElement, data: any) => {
      try {
        const win = browser.contentWindow;
        if (!win) return data;
        return Components.utils.cloneInto(data, win, { wrapReflectors: true });
      } catch {
        return data;
      }
    };

    // Set up observers on both readers' internal state
    const setupObserver = (browser: XULBrowserElement, isLeft: boolean) => {
      try {
        const internalReader = this.getInternalReaderFromBrowser(browser);
        if (!internalReader) return;

        // Hook into the reader's annotation selection
        const originalSetSelectedAnnotationIDs =
          internalReader.setSelectedAnnotationIDs?.bind(internalReader);
        if (originalSetSelectedAnnotationIDs) {
          internalReader.setSelectedAnnotationIDs = (ids: string[]) => {
            // Call original
            originalSetSelectedAnnotationIDs(ids);

            // Sync to other side if not already syncing
            const s = self.stateMap.get(tabID);
            if (s?.isSamePDF && !s.isSyncingSelection && !s.isCleaningUp) {
              s.isSyncingSelection = true;
              try {
                const otherBrowser = isLeft ? s.rightBrowser : s.leftBrowser;
                const otherReader =
                  self.getInternalReaderFromBrowser(otherBrowser);
                if (otherReader?.setSelectedAnnotationIDs) {
                  // Clone ids array for the other browser's context
                  const clonedIds = cloneForBrowser(
                    otherBrowser,
                    Array.from(ids),
                  );
                  otherReader.setSelectedAnnotationIDs(clonedIds);
                }
              } finally {
                const s2 = self.stateMap.get(tabID);
                if (s2) {
                  s2.isSyncingSelection = false;
                }
              }
            }
          };
        }
      } catch {
        // Ignore errors
      }
    };

    setupObserver(state.leftBrowser, true);
    setupObserver(state.rightBrowser, false);
  }

  /**
   * Hide the secondary (right) toolbar in same PDF split view
   * Since both views show the same PDF, we only need one toolbar
   */
  private static hideSecondaryToolbar(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || !state.isSamePDF) return;

    try {
      const rightReader = this.getInternalReaderFromBrowser(state.rightBrowser);
      if (!rightReader?._primaryView) return;

      const iframeWindow = rightReader._primaryView._iframeWindow;
      if (!iframeWindow) return;

      const doc = iframeWindow.document;
      if (!doc) return;

      // Try to find and hide the toolbar
      const toolbar = doc.querySelector(".toolbar");
      if (toolbar) {
        (toolbar as HTMLElement).style.display = "none";
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Toggle scroll/page sync
   */
  private static toggleSync(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    state.syncEnabled = !state.syncEnabled;

    if (state.syncEnabled) {
      this.initSyncState(tabID);
      this.startSyncPolling(tabID);
    } else {
      this.stopSyncPolling(tabID);
      state.lastLeftScroll = null;
      state.lastRightScroll = null;
    }

    // Save sync state to tab data for session restore
    this.updateTabDataForSession(tabID);

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: state.syncEnabled
          ? getString("splitview-sync-enabled")
          : getString("splitview-sync-disabled"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Initialize sync state - record both panes' current positions
   */
  private static initSyncState(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      // Refresh cached viewer containers to ensure syncViews uses up-to-date refs
      // (e.g. after primary side switch or browser replacement)
      this.cacheViewerContainers(tabID);

      if (state.leftViewerContainer) {
        state.lastLeftScroll = {
          top: state.leftViewerContainer.scrollTop,
          left: state.leftViewerContainer.scrollLeft,
        };
      }

      if (state.rightViewerContainer) {
        state.lastRightScroll = {
          top: state.rightViewerContainer.scrollTop,
          left: state.rightViewerContainer.scrollLeft,
        };
      }
    } catch (e) {
      Zotero.debug(
        `Split view: initSyncState error (browser may be dead): ${e}`,
      );
    }
  }

  /**
   * Get PDF viewer from internal reader
   */
  private static getPdfViewerFromReader(internalReader: any): any {
    try {
      const primaryView = internalReader?._primaryView;
      if (!primaryView) return null;

      const iframe = primaryView._iframe;
      if (!iframe) return null;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return null;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      return wrappedWin.PDFViewerApplication?.pdfViewer || null;
    } catch (e) {
      Zotero.debug(`Split view: getPdfViewerFromReader error: ${e}`);
      return null;
    }
  }

  /**
   * Sync position and scale from source browser to target browser.
   *
   * Uses Zotero's _primaryView._setState() which atomically applies
   * pageIndex, top, left, and scale via scrollPageIntoView with destArray,
   * instead of the previous approach of navigate({ pageIndex }) which only
   * scrolled to the top of the page without applying position offsets or scale.
   */
  private static async syncPositionAndScale(
    tabID: string,
    sourceBrowser: XULBrowserElement,
    targetBrowser: XULBrowserElement,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Pause scroll sync to avoid feedback loops
    state.syncPaused = true;

    try {
      const sourceReader = this.getInternalReaderFromBrowser(sourceBrowser);
      const targetReader = this.getInternalReaderFromBrowser(targetBrowser);
      if (!sourceReader || !targetReader) {
        Zotero.debug("Split view: syncPositionAndScale - readers not found");
        return;
      }

      // Get source viewState (contains pageIndex, top, left, scale, scrollMode, spreadMode)
      const viewState = sourceReader._state?.primaryViewState;
      if (!viewState) {
        Zotero.debug("Split view: syncPositionAndScale - viewState not found");
        return;
      }

      // Get target primary view for _setState
      const targetPrimaryView = targetReader._primaryView;
      if (!targetPrimaryView) {
        Zotero.debug(
          "Split view: syncPositionAndScale - target _primaryView not found",
        );
        return;
      }

      // Build a plain state object with only the fields _setState expects.
      // _setState handles scale + position atomically via scrollPageIntoView
      // with a destArray: [null, {name:'XYZ'}, left, top, scale].
      const stateToApply: Record<string, any> = {
        pageIndex: viewState.pageIndex ?? 0,
        scale: viewState.scale,
      };
      // top/left: only include if defined (null values are ignored by _setState)
      if (viewState.top !== undefined) {
        stateToApply.top = viewState.top;
      }
      if (viewState.left !== undefined) {
        stateToApply.left = viewState.left;
      }
      if (Number.isInteger(viewState.scrollMode)) {
        stateToApply.scrollMode = viewState.scrollMode;
      }
      if (Number.isInteger(viewState.spreadMode)) {
        stateToApply.spreadMode = viewState.spreadMode;
      }

      // Clone state into the target browser's compartment to avoid
      // cross-compartment Xray wrapper issues with property access
      let clonedState = stateToApply;
      try {
        const targetWin = targetBrowser.contentWindow;
        if (targetWin) {
          clonedState = Components.utils.cloneInto(stateToApply, targetWin, {
            wrapReflectors: true,
          });
        }
      } catch (e) {
        Zotero.debug(
          `Split view: syncPositionAndScale - cloneInto failed, using plain object: ${e}`,
        );
      }

      // Apply the full view state atomically
      await targetPrimaryView._setState(clonedState);

      Zotero.debug(
        `Split view: synced position (page ${stateToApply.pageIndex}, ` +
          `top=${stateToApply.top}, left=${stateToApply.left}, ` +
          `scale=${stateToApply.scale})`,
      );

      // Show notification
      const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
      })
        .createLine({
          text: getString("splitview-position-synced"),
          type: "default",
          icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
        })
        .show();
      popup.startCloseTimer(2000);
    } catch (e) {
      Zotero.debug(`Split view: syncPositionAndScale error: ${e}`);
    } finally {
      // Resume scroll sync after _setState has completed and the view has settled.
      // Re-initialize sync baselines to prevent position jumps.
      this.trackTimeout(
        state,
        () => {
          const s = this.stateMap.get(tabID);
          if (s) {
            s.syncPaused = false;
            this.initSyncState(tabID);
          }
        },
        400,
      );
    }
  }

  /**
   * Set up zoom button listeners on a browser's toolbar
   * This directly hooks into zoom button clicks for reliable sync
   */
  private static setupZoomButtonListeners(
    tabID: string,
    browser: XULBrowserElement,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      // The zoom buttons are in the reader's main document (browser.contentWindow),
      // NOT in the inner PDF.js iframe
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Find zoom buttons in the toolbar
      // Try multiple selectors as Zotero's reader may use different ones
      // Search for button with zoom-in/zoom-out/zoom-reset icons or titles
      const findButton = (type: "in" | "out" | "reset"): Element | null => {
        const selectors =
          type === "in"
            ? [
                '[data-l10n-id="pdfjs-zoom-in-button"]',
                "#zoomIn",
                ".zoomIn",
                'button[class*="zoomIn"]',
                'button[class*="zoom-in"]',
                '[title*="Zoom In"]',
                '[title*="zoom in"]',
                '[aria-label*="Zoom In"]',
                '[aria-label*="zoom in"]',
                // Zotero reader specific
                'button[data-tabstop="1"][class*="zoom"]',
              ]
            : type === "out"
              ? [
                  '[data-l10n-id="pdfjs-zoom-out-button"]',
                  "#zoomOut",
                  ".zoomOut",
                  'button[class*="zoomOut"]',
                  'button[class*="zoom-out"]',
                  '[title*="Zoom Out"]',
                  '[title*="zoom out"]',
                  '[aria-label*="Zoom Out"]',
                  '[aria-label*="zoom out"]',
                ]
              : [
                  // Reset zoom selectors (Zotero reader uses zoomAuto)
                  "#zoomAuto",
                  ".zoomAuto",
                  'button[class*="zoomAuto"]',
                  'button[class*="zoom-auto"]',
                  '[title*="Zoom Reset"]',
                  '[title*="zoom reset"]',
                  '[title*="Reset Zoom"]',
                  '[title*="reset zoom"]',
                  '[aria-label*="Zoom Reset"]',
                  '[aria-label*="Reset Zoom"]',
                ];

        for (const selector of selectors) {
          try {
            const btn = doc.querySelector(selector);
            if (btn) return btn;
          } catch {
            // Invalid selector, skip
          }
        }

        // Try finding by icon class patterns
        const allButtons = doc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          const className = (btn.className || "").toLowerCase();
          const title = (btn.getAttribute("title") || "").toLowerCase();
          const ariaLabel = (
            btn.getAttribute("aria-label") || ""
          ).toLowerCase();

          if (type === "in") {
            if (
              className.includes("zoomin") ||
              className.includes("zoom-in") ||
              title.includes("zoom in") ||
              ariaLabel.includes("zoom in") ||
              title.includes("放大") ||
              ariaLabel.includes("放大")
            ) {
              return btn;
            }
          } else if (type === "out") {
            if (
              className.includes("zoomout") ||
              className.includes("zoom-out") ||
              title.includes("zoom out") ||
              ariaLabel.includes("zoom out") ||
              title.includes("缩小") ||
              ariaLabel.includes("缩小")
            ) {
              return btn;
            }
          } else {
            if (
              className.includes("zoomauto") ||
              className.includes("zoom-auto") ||
              className.includes("zoomreset") ||
              className.includes("zoom-reset") ||
              title.includes("zoom reset") ||
              title.includes("reset zoom") ||
              ariaLabel.includes("zoom reset") ||
              ariaLabel.includes("reset zoom") ||
              title.includes("重置") ||
              ariaLabel.includes("重置")
            ) {
              return btn;
            }
          }
        }

        return null;
      };

      const zoomInBtn = findButton("in");
      const zoomOutBtn = findButton("out");
      const zoomResetBtn = findButton("reset");

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const isLeft = browser === state.leftBrowser;

      if (zoomInBtn) {
        const zoomInHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "in");
        };
        this.trackEventListener(
          state,
          zoomInBtn,
          "click",
          zoomInHandler as EventListener,
          true,
        );
      }

      if (zoomOutBtn) {
        const zoomOutHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "out");
        };
        this.trackEventListener(
          state,
          zoomOutBtn,
          "click",
          zoomOutHandler as EventListener,
          true,
        );
      }

      if (zoomResetBtn) {
        const zoomResetHandler = () => {
          self.handleZoomButtonClick(tabID, isLeft, "reset");
        };
        this.trackEventListener(
          state,
          zoomResetBtn,
          "click",
          zoomResetHandler as EventListener,
          true,
        );
      }
    } catch {
      // Ignore errors setting up zoom button listeners
    }
  }

  /**
   * Handle zoom button click - sync to secondary if this is primary
   */
  private static handleZoomButtonClick(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out" | "reset",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    if (!state.syncEnabled) return;

    // Only sync from primary to secondary
    const isPrimary =
      (isLeft && state.primarySide === "left") ||
      (!isLeft && state.primarySide === "right");
    if (!isPrimary) return;

    // Skip if Ctrl is pressed (user doing Ctrl+wheel zoom shouldn't sync)
    if (state.ctrlPressed) return;

    const secondaryBrowser =
      state.primarySide === "left" ? state.rightBrowser : state.leftBrowser;

    // Pause scroll sync during zoom
    state.zoomingCount++;

    // Sync zoom action to secondary immediately
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else if (direction === "out") {
      this.zoomOutForBrowser(secondaryBrowser);
    } else {
      this.zoomResetForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after a delay, and reinitialize sync state
    // to prevent position jump (zoom changes scroll positions)
    this.trackTimeout(
      state,
      () => {
        const s = this.stateMap.get(tabID);
        if (s) {
          s.zoomingCount = Math.max(0, s.zoomingCount - 1);
          // Reinitialize sync state after zoom completes
          // This updates both panes' baseline scroll positions
          if (s.zoomingCount === 0) {
            this.initSyncState(tabID);
          }
        }
      },
      150,
    ); // Slightly longer to ensure zoom animation completes
  }

  /**
   * Wait for browser to load reader.html
   */
  private static waitForBrowserLoad(browser: XULBrowserElement): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 200; // 20 seconds max

      const check = () => {
        attempts++;
        try {
          const win = browser.contentWindow;
          if (win && win.document && win.document.readyState === "complete") {
            // Check if createReader function exists
            const wrappedWin = (win as any).wrappedJSObject || win;
            if (typeof wrappedWin.createReader === "function") {
              resolve();
              return;
            }
          }
        } catch {
          // Ignore errors during check
        }

        if (attempts >= maxAttempts) {
          reject(new Error("Timeout waiting for browser to load"));
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Initialize a reader in a browser element
   * @param viewState - Optional view state to restore position
   * @param isRight - Whether this is the right browser (shows context pane toggle)
   */
  private static async initializeReader(
    tabID: string,
    browser: XULBrowserElement,
    item: Zotero.Item,
    popupset: XULElement,
    viewState?: any,
    isRight: boolean = false,
  ): Promise<void> {
    await this.waitForBrowserLoad(browser);

    const win = browser.contentWindow;
    if (!win) throw new Error("Browser contentWindow not available");

    const wrappedWin = (win as any).wrappedJSObject || win;
    const mainWindow = Zotero.getMainWindow();

    // Get PDF data URL
    const data = {
      url: `zotero://attachment/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`,
    };

    // Get annotations - match Zotero's _getAnnotation method
    const annotationItems = item.getAnnotations();
    const annotations = await Promise.all(
      annotationItems.map(async (annot: Zotero.Item) => {
        try {
          if (!annot || !annot.isAnnotation()) {
            return null;
          }
          const json: any = await Zotero.Annotations.toJSON(annot);
          json.id = annot.key;
          delete json.key;
          // Ensure no undefined values for non-array properties (match Zotero's behavior)
          for (const key in json) {
            if (!Array.isArray(json[key])) {
              json[key] = json[key] || "";
            }
          }
          json.tags = json.tags || [];
          return json;
        } catch {
          return null;
        }
      }),
    );
    const validAnnotations = annotations.filter((a) => a !== null);

    // Prepare Fluent localization data
    const ftl: string[] = [];
    try {
      ftl.push(
        Zotero.File.getContentsFromURL("chrome://zotero/locale/zotero.ftl"),
      );
    } catch {
      // Ignore FTL loading errors
    }
    try {
      ftl.push(
        Zotero.File.getContentsFromURL("chrome://zotero/locale/reader.ftl"),
      );
    } catch {
      // Ignore FTL loading errors
    }

    // Store references for callbacks
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const itemRef = item;
    const browserRef = browser;
    const popupsetRef = popupset;

    // Only show context pane toggle button on the RIGHT browser
    // The right reader's toggle controls the global context pane
    const showContextPaneToggle = isRight;
    const mainWin = Zotero.getMainWindow();
    const contextPaneOpen = isRight
      ? !((mainWin as any).ZoteroContextPane?.collapsed ?? true)
      : false;

    // bottomPlaceholderHeight controls stackedView in reader-ui.js:
    //   let stackedView = state.bottomPlaceholderHeight !== null;
    // When stackedView = true, the toggle button uses a different icon (bottom sidebar)
    // and is always shown regardless of contextPaneOpen.
    // For standard (non-stacked) layout, this MUST be null so the toggle hides when
    // context pane opens and uses the correct sidebar icon.
    const isStacked = Zotero.Prefs.get("layout") === "stacked";
    const bottomPlaceholderHeight = isStacked ? 0 : null;

    // Create internal reader config - all callbacks defined inline, clone entire object once
    const readerConfig = {
      type: "pdf",
      data,
      annotations: validAnnotations,
      readOnly: false,
      authorName:
        item.library.libraryType === "group"
          ? Zotero.Users.getCurrentName()
          : "",
      showContextPaneToggle,
      contextPaneOpen, // Right browser shows toggle to control global context pane
      sidebarWidth: 240,
      sidebarOpen: false, // Default to collapsed in split view
      bottomPlaceholderHeight,
      rtl: (Zotero as any).rtl,
      fontSize: Zotero.Prefs.get("fontSize"),
      ftl,
      showAnnotations: true,
      // Additional reader preferences
      textSelectionAnnotationMode: Zotero.Prefs.get(
        "reader.textSelectionAnnotationMode",
      ),
      customThemes:
        (Zotero as any).SyncedSettings?.get(
          Zotero.Libraries.userLibraryID,
          "readerCustomThemes",
        ) ?? [],
      lightTheme: Zotero.Prefs.get("reader.lightTheme"),
      darkTheme: Zotero.Prefs.get("reader.darkTheme"),
      fontFamily: Zotero.Prefs.get("reader.ebookFontFamily"),
      hyphenate: Zotero.Prefs.get("reader.ebookHyphenate"),
      autoDisableNoteTool: Zotero.Prefs.get("reader.autoDisableTool.note"),
      autoDisableTextTool: Zotero.Prefs.get("reader.autoDisableTool.text"),
      autoDisableImageTool: Zotero.Prefs.get("reader.autoDisableTool.image"),
      sidebarView: Zotero.Prefs.get("reader.lastSidebarTab"),
      // Pass viewState to restore position
      primaryViewState: viewState,
      // Required callbacks - defined as regular functions
      onOpenContextMenu: () => {
        const params = wrappedWin.contextMenuParams;
        if (params) {
          self.openContextMenu(browserRef, popupsetRef, params);
        }
      },
      onToggleSidebar: (open: boolean) => {
        // Sync sidebar toggle when sync is enabled
        self.handleSidebarToggle(tabID, browserRef, open);
      },
      onChangeSidebarWidth: (_width: number) => {
        // No-op for split view
      },
      onChangeViewState: (viewState: any, _primary: boolean) => {
        // Track view state for saving to disk later
        const s = self.stateMap.get(tabID);
        if (s && !s.isCleaningUp) {
          const isLeft = browserRef === s.leftBrowser;
          const stateCopy = JSON.parse(JSON.stringify(viewState));
          if (isLeft) {
            s.leftViewState = stateCopy;
          } else {
            s.rightViewState = stateCopy;
          }
        }
        // Sync zoom when scale changes (toolbar zoom in/out)
        self.handleViewStateChange(browserRef, viewState);
      },
      onSaveAnnotations: async (annotations: any[], callback: () => void) => {
        await self.handleAnnotationSave(itemRef, annotations);
        if (callback) callback();
      },
      onDeleteAnnotations: (ids: string[]) => {
        self.handleAnnotationDelete(itemRef, ids);
      },
      onAddToNote: (_annotations: any[]) => {
        // No-op for split view
      },
      onOpenTagsPopup: (_id: string, _x: number, _y: number) => {
        // Tags popup not implemented for split view
      },
      onClosePopup: () => {
        // No-op
      },
      onOpenLink: (url: string) => {
        Zotero.launchURL(url);
      },
      onCopyImage: (_dataURL: string) => {
        // Image copy not implemented for split view
      },
      onSaveImageAs: (_dataURL: string) => {
        // Save image not implemented for split view
      },
      onSetDataTransferAnnotations: (
        _dataTransfer: any,
        _annotations: any[],
        _fromText: boolean,
      ) => {
        // Drag-drop not implemented for split view
      },
      onToggleContextPane: () => {
        // Toggle global context pane
        const mainWin = Zotero.getMainWindow();
        if ((mainWin as any).ZoteroContextPane) {
          (mainWin as any).ZoteroContextPane.togglePane();
          // Update right reader's contextPaneOpen state after toggle
          // This controls whether the toggle button shows in the toolbar
          setTimeout(() => {
            const s = self.stateMap.get(tabID);
            if (s?.rightBrowser) {
              const isOpen = !(
                (mainWin as any).ZoteroContextPane?.collapsed ?? true
              );
              self.setContextPaneOpenForBrowser(s.rightBrowser, isOpen);
            }
          }, 50);
        }
      },
    };

    // Clone entire config once with wrapReflectors and cloneFunctions
    wrappedWin.createReader(
      Components.utils.cloneInto(readerConfig, win, {
        wrapReflectors: true,
        cloneFunctions: true,
      }),
    );

    // Wait for internal reader to be ready
    await this.waitForInternalReader(browser);

    // Only hide the reader's internal sidenav on the LEFT browser
    // The RIGHT browser keeps its toggle button to control the global context pane
    if (!isRight) {
      this.hideReaderSidenav(browser);
    } else {
      // Inject a content-side event listener for synchronous context pane state updates.
      // setContextPaneOpen() uses React's flushSync() which only works when called from
      // within the content compartment. By injecting a <script>, the listener runs in the
      // content compartment so flushSync() works correctly, producing a smooth transition
      // without flicker when the toggle button appears/disappears.
      this.injectContextPaneHandler(browser);
    }
  }

  /**
   * Hide the sidenav inside a reader browser
   * This prevents each reader from having its own context pane toggle
   */
  private static hideReaderSidenav(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;

      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const sidenav = doc.querySelector(
        ".sidenav, reader-sidenav, #sidenav, [class*='sidenav']",
      );
      if (sidenav) {
        sidenav.style.display = "none";
      }

      // Also try to find any context pane toggle buttons
      const toggleBtns = doc.querySelectorAll(
        "[class*='context-pane'], [data-action='toggle-pane']",
      );
      toggleBtns.forEach((btn: any) => {
        btn.style.display = "none";
      });

      // Check the internal reader object for sidenav
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader) {
        // Try to hide sidenav via the reader API if available
        if (internalReader._sidenav) {
          internalReader._sidenav.style.display = "none";
        }
        // Some readers have a toolbarRight that contains the sidenav
        if (internalReader._toolbarRight) {
          // Only hide context pane related items, not all toolbar items
          const contextItems = internalReader._toolbarRight.querySelectorAll?.(
            "[class*='context'], [data-action='toggle-pane']",
          );
          contextItems?.forEach((item: any) => {
            item.style.display = "none";
          });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Wait for internal reader to initialize
   * This includes waiting for the PDF viewer iframe to fully load
   */
  private static async waitForInternalReader(
    browser: XULBrowserElement,
  ): Promise<void> {
    const maxAttempts = 100;
    let attempts = 0;

    // First, wait for _primaryView to exist
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const internalReader = this.getInternalReaderFromBrowser(browser);
        if (internalReader && internalReader._primaryView) {
          // Found _primaryView, now wait for it to fully initialize
          // This ensures the PDF.js viewer iframe is loaded and pdfjsLib is available
          if (internalReader._primaryView.initializedPromise) {
            try {
              await internalReader._primaryView.initializedPromise;
            } catch (e) {
              Zotero.debug(
                `Split view: primaryView initialization failed: ${e}`,
              );
              // Continue anyway, the view might still be usable
            }
          }
          return;
        }
      } catch {
        // Ignore errors during check
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timeout waiting for internal reader");
  }

  /**
   * Get internal reader object from browser
   */
  private static getInternalReaderFromBrowser(browser: XULBrowserElement): any {
    if (!this.isBrowserAlive(browser)) return null;
    try {
      const win = browser.contentWindow;
      if (!win) return null;
      const wrappedWin = (win as any).wrappedJSObject || win;
      return wrappedWin._reader || null;
    } catch (e) {
      Zotero.debug(`Split view: getInternalReaderFromBrowser error: ${e}`);
      return null;
    }
  }

  /**
   * Check if a browser element is still alive and usable
   */
  private static isBrowserAlive(browser: XULBrowserElement): boolean {
    try {
      // Try to access a property - this will throw if the object is dead
      const _test = browser.contentWindow;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Unload a browser by setting its src to about:blank
   * This prevents dead object errors from callbacks
   */
  private static unloadBrowser(browser: XULBrowserElement): void {
    try {
      if (this.isBrowserAlive(browser)) {
        browser.setAttribute("src", "about:blank");
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Close a Zotero reader without closing its tab
   * Cleans up the reader (flushes state to disk, unregisters listeners)
   * and removes it from Zotero.Reader._readers array
   */
  private static async closeReaderWithoutClosingTab(
    reader: any,
  ): Promise<void> {
    try {
      const win = reader._window;

      // 1. Remove window-level event listeners FIRST
      if (win) {
        try {
          if (reader._handleLoad) {
            win.removeEventListener("DOMContentLoaded", reader._handleLoad);
          }
          if (reader._handlePointerDown) {
            win.removeEventListener("pointerdown", reader._handlePointerDown);
          }
          if (reader._handlePointerUp) {
            win.removeEventListener("pointerup", reader._handlePointerUp);
          }
        } catch (e) {
          Zotero.debug(
            `Split view: closeReader - removeEventListener failed: ${e}`,
          );
        }
      }

      // 2. Call uninit() to flush state to disk and clean up observers
      if (typeof reader.uninit === "function") {
        try {
          reader.uninit();
        } catch (e) {
          Zotero.debug(`Split view: closeReader - uninit failed: ${e}`);
        }
      }

      // 3. Now unload the reader's iframe
      if (reader._iframe) {
        this.unloadBrowser(reader._iframe);
        // Wait a bit for pending callbacks to complete
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // 4. Clear internal references AFTER uninit and unload
      try {
        reader._internalReader = null;
        reader._iframeWindow = null;
      } catch (e) {
        Zotero.debug(`Split view: closeReader - clear refs failed: ${e}`);
      }

      // 5. Remove from Zotero.Reader._readers array
      const readers = (Zotero.Reader as any)._readers;
      const index = readers.indexOf(reader);
      if (index !== -1) {
        readers.splice(index, 1);
      }
    } catch (e) {
      Zotero.debug(`Split view: closeReaderWithoutClosingTab failed: ${e}`);
    }
  }

  /**
   * Get view state from a reader (real-time position info)
   */
  private static async getViewStateFromReader(reader: any): Promise<any> {
    try {
      // Prefer using _getState() method (syncs to disk)
      if (typeof reader._getState === "function") {
        return await reader._getState();
      }
      // Fallback: get from internal reader
      const internalReader = reader._internalReader;
      if (internalReader?._state?.primaryViewState) {
        return internalReader._state.primaryViewState;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Get stored view state from disk for an attachment item
   */
  private static async getStoredViewState(item: Zotero.Item): Promise<any> {
    try {
      const dir = Zotero.Attachments.getStorageDirectory(item);
      const stateFile = PathUtils.join(dir.path, ".zotero-reader-state");
      if (await IOUtils.exists(stateFile)) {
        return await IOUtils.readJSON(stateFile);
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Save view state to disk for an attachment item
   * Mirrors Zotero's ReaderInstance._setState behavior
   */
  private static async saveViewStateToDisk(
    itemID: number,
    viewState: any,
  ): Promise<void> {
    if (!viewState) return;
    try {
      const item = Zotero.Items.get(itemID);
      if (!item) return;

      // Update last page index (like Zotero does)
      if (viewState.pageIndex !== undefined) {
        item.setAttachmentLastPageIndex(viewState.pageIndex);
      }

      const dir = Zotero.Attachments.getStorageDirectory(item);
      if (!dir.exists()) {
        await Zotero.Attachments.createDirectoryForItem(item);
      }
      const stateFile = PathUtils.join(dir.path, ".zotero-reader-state");

      Zotero.debug("Split view: Writing reader state to " + stateFile);
      await IOUtils.writeJSON(stateFile, viewState);
    } catch (e) {
      Zotero.debug("Split view: Failed to save view state: " + e);
    }
  }

  /**
   * Get current view state from internal reader in browser
   */
  private static getCurrentViewStateFromBrowser(
    browser: XULBrowserElement,
  ): any {
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader?._state?.primaryViewState) {
        return JSON.parse(
          JSON.stringify(internalReader._state.primaryViewState),
        );
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Open context menu for a reader
   */
  private static openContextMenu(
    browser: XULBrowserElement,
    popupset: XULElement,
    params: { x: number; y: number; itemGroups: any[][] },
  ) {
    // Check if browser is still alive
    if (!this.isBrowserAlive(browser)) return;

    const mainWindow = Zotero.getMainWindow();
    const { x, y, itemGroups } = params;

    const popup = mainWindow.document.createXULElement("menupopup");
    popupset.appendChild(popup);

    popup.addEventListener("popuphidden", function () {
      popup.remove();
    });

    const appendItems = (parentNode: Element, groups: any[][]) => {
      for (let i = 0; i < groups.length; i++) {
        const itemGroup = groups[i];
        for (const item of itemGroup) {
          if (item.groups) {
            // Submenu
            const menu = mainWindow.document.createXULElement("menu");
            menu.setAttribute("label", item.label);
            const menupopup = mainWindow.document.createXULElement("menupopup");
            menu.appendChild(menupopup);
            appendItems(menupopup, item.groups);
            parentNode.appendChild(menu);
          } else {
            // Menu item
            const menuitem = mainWindow.document.createXULElement("menuitem");
            menuitem.setAttribute("label", item.label);
            if (item.disabled) {
              menuitem.setAttribute("disabled", "true");
            }
            if (item.checked) {
              menuitem.setAttribute("type", "checkbox");
              menuitem.setAttribute("checked", "true");
            }
            menuitem.addEventListener("command", () => {
              if (item.onCommand) item.onCommand();
            });
            parentNode.appendChild(menuitem);
          }
        }
        // Add separator between groups (but not after the last group)
        if (i < groups.length - 1) {
          const separator =
            mainWindow.document.createXULElement("menuseparator");
          parentNode.appendChild(separator);
        }
      }
    };

    appendItems(popup, itemGroups);

    // Add Split View menu items - find which tab state owns this browser
    let ownerTabID: string | null = null;
    for (const [tid, s] of this.stateMap) {
      if (s.leftBrowser === browser || s.rightBrowser === browser) {
        ownerTabID = tid;
        break;
      }
    }
    const ownerState = ownerTabID ? this.stateMap.get(ownerTabID) : null;
    if (ownerState && ownerTabID) {
      const separator = mainWindow.document.createXULElement("menuseparator");
      popup.appendChild(separator);

      // Determine which side this browser is on
      const isLeft = browser === ownerState.leftBrowser;
      const currentSide = isLeft ? "left" : "right";
      const isPrimary = ownerState.primarySide === currentSide;
      const capturedTabID = ownerTabID;

      // Close Split View (revert to single reader)
      const closeItem = mainWindow.document.createXULElement("menuitem");
      closeItem.setAttribute("label", getString("splitview-close-menu-label"));
      this.setMenuItemIcon(
        closeItem,
        this.getIconURI("do_not_splitscreen_vertical_24dp.svg"),
      );
      closeItem.addEventListener("command", () => {
        this.revertToSingleReader(capturedTabID, currentSide);
      });
      popup.appendChild(closeItem);

      // Set Primary (right below Split-View Reader)
      const primaryItem = mainWindow.document.createXULElement("menuitem");
      primaryItem.setAttribute("label", getString("splitview-set-primary"));
      this.setMenuItemIcon(
        primaryItem,
        this.getIconURI("primary_window_24dp.svg"),
      );
      primaryItem.addEventListener("command", () => {
        this.setPrimarySide(capturedTabID, currentSide);
      });
      popup.appendChild(primaryItem);

      // Open Another PDF (replace PDF on the side where the user right-clicked)
      const openAnotherItem = mainWindow.document.createXULElement("menuitem");
      openAnotherItem.setAttribute(
        "label",
        getString("splitview-open-another"),
      );
      this.setMenuItemIcon(
        openAnotherItem,
        this.getIconURI("file_open_24dp.svg"),
      );
      openAnotherItem.addEventListener("command", async () => {
        await this.selectAndLoadPDF(capturedTabID, currentSide);
      });
      popup.appendChild(openAnotherItem);

      // Swap PDFs (exchange left and right PDFs)
      const swapItem = mainWindow.document.createXULElement("menuitem");
      swapItem.setAttribute("label", getString("splitview-swap-pdf"));
      this.setMenuItemIcon(swapItem, this.getIconURI("swap_horiz_24dp.svg"));
      swapItem.addEventListener("command", async () => {
        await this.swapPDFs(capturedTabID);
      });
      popup.appendChild(swapItem);

      // Sync Position and Scale
      const syncPositionItem = mainWindow.document.createXULElement("menuitem");
      syncPositionItem.setAttribute(
        "label",
        getString("splitview-sync-position"),
      );
      this.setMenuItemIcon(syncPositionItem, this.getIconURI("sync_24dp.svg"));
      syncPositionItem.addEventListener("command", () => {
        const s = this.stateMap.get(capturedTabID);
        if (!s) return;
        const targetBrowser = isLeft ? s.rightBrowser : s.leftBrowser;
        this.syncPositionAndScale(capturedTabID, browser, targetBrowser);
      });
      popup.appendChild(syncPositionItem);
    }

    // Calculate screen position
    const browserRect = browser.getBoundingClientRect();
    const screenX = browserRect.left + x;
    const screenY = browserRect.top + y;

    // Convert to screen coordinates
    const windowUtils = (mainWindow as any).windowUtils;
    if (windowUtils && windowUtils.toScreenRectInCSSUnits) {
      const rect = windowUtils.toScreenRectInCSSUnits(screenX, screenY, 0, 0);
      setTimeout(() => (popup as any).openPopupAtScreen(rect.x, rect.y, true));
    } else {
      // Fallback
      setTimeout(() =>
        (popup as any).openPopupAtScreen(screenX, screenY, true),
      );
    }
  }

  /**
   * Hook into both readers' _annotationManager.render() to mirror annotation
   * changes instantly between the two views, replicating Zotero's native
   * split view behavior.
   *
   * In Zotero's native split view, both views share one _annotationManager.
   * When an annotation is created/modified/deleted:
   *   _applyChanges → render() → onRender → _updateState → view.setAnnotations()
   * This happens SYNCHRONOUSLY, so both views update immediately.
   *
   * In our plugin, each browser has its own reader with its own annotation
   * manager. We hook render() on each to propagate to the other:
   *   Left AM render() → update left view → copy annotations → right AM render() → update right view
   *
   * The DB save (onSaveAnnotations) is completely separate and fires later
   * via debounced _triggerSaving. We don't need to intercept it for UI sync.
   */
  private static setupAnnotationManagerSync(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || !state.isSamePDF) return;

    const leftReader = this.getInternalReaderFromBrowser(state.leftBrowser);
    const rightReader = this.getInternalReaderFromBrowser(state.rightBrowser);
    if (!leftReader || !rightReader) return;

    const leftAM = leftReader._annotationManager;
    const rightAM = rightReader._annotationManager;
    if (!leftAM || !rightAM) return;

    let isSyncing = false; // Guard against infinite recursion
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Capture original render functions (arrow functions, so `this` is bound to AM instance)
    const origLeftRender = leftAM.render;
    const origRightRender = rightAM.render;

    // When left annotation manager renders, mirror state to right
    leftAM.render = () => {
      origLeftRender();
      const s = self.stateMap.get(tabID);
      if (!isSyncing && s?.isSamePDF && !s.isCleaningUp) {
        isSyncing = true;
        try {
          // Deep-clone annotations across browser compartments via JSON
          const serialized = JSON.stringify(leftAM._annotations);
          const parsed = JSON.parse(serialized);
          // Clone into right browser's compartment for safe cross-compartment access
          const rightWin = s.rightBrowser.contentWindow;
          rightAM._annotations = rightWin
            ? Components.utils.cloneInto(parsed, rightWin, {
                wrapReflectors: true,
              })
            : parsed;
          origRightRender();
        } catch (e) {
          Zotero.debug(`Split view: annotation sync left→right error: ${e}`);
        } finally {
          isSyncing = false;
        }
      }
    };

    // When right annotation manager renders, mirror state to left
    rightAM.render = () => {
      origRightRender();
      const s = self.stateMap.get(tabID);
      if (!isSyncing && s?.isSamePDF && !s.isCleaningUp) {
        isSyncing = true;
        try {
          const serialized = JSON.stringify(rightAM._annotations);
          const parsed = JSON.parse(serialized);
          const leftWin = s.leftBrowser.contentWindow;
          leftAM._annotations = leftWin
            ? Components.utils.cloneInto(parsed, leftWin, {
                wrapReflectors: true,
              })
            : parsed;
          origLeftRender();
        } catch (e) {
          Zotero.debug(`Split view: annotation sync right→left error: ${e}`);
        } finally {
          isSyncing = false;
        }
      }
    };

    Zotero.debug("Split view: annotation manager sync hooks installed");
  }

  /**
   * Handle annotation save callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationSave(
    item: Zotero.Item,
    annotations: any[],
  ) {
    const attachment = Zotero.Items.get(item.id);
    try {
      for (const annotation of annotations) {
        annotation.key = annotation.id;
        delete annotation.authorName;
        await Zotero.Annotations.saveFromJSON(attachment, annotation);
      }
    } catch {
      // Ignore annotation save errors
    }
  }

  /**
   * Handle annotation delete callback
   * Uses the same approach as Zotero's reader
   */
  private static async handleAnnotationDelete(
    item: Zotero.Item,
    ids: string[],
  ) {
    const attachment = Zotero.Items.get(item.id);
    const libraryID = attachment.libraryID;
    try {
      for (const key of ids) {
        const annotation = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (
          annotation &&
          annotation.isAnnotation() &&
          annotation.parentID === item.id
        ) {
          await annotation.eraseTx();
        }
      }
    } catch {
      // Ignore annotation delete errors
    }
  }

  /**
   * Handle sidebar toggle - sync to the other reader when sync is enabled
   * Pauses scroll sync during sidebar animation to prevent position drift
   */
  private static handleSidebarToggle(
    tabID: string,
    sourceBrowser: XULBrowserElement,
    open: boolean,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    if (!state.syncEnabled) return;

    // Determine if this is the primary browser
    const isLeft = sourceBrowser === state.leftBrowser;
    const isPrimary =
      (isLeft && state.primarySide === "left") ||
      (!isLeft && state.primarySide === "right");

    // Only sync from primary to secondary
    if (!isPrimary) return;

    // Cancel any pending timers from previous toggle (debounce)
    const win = Zotero.getMainWindow();
    for (const timerId of state.sidebarToggleTimers) {
      win.clearTimeout(timerId);
    }
    state.sidebarToggleTimers = [];

    // Pause sync during sidebar toggle to prevent position drift
    state.syncPaused = true;

    // Get the secondary browser
    const secondaryBrowser = isLeft ? state.rightBrowser : state.leftBrowser;

    // Toggle sidebar on secondary reader
    try {
      const internalReader =
        this.getInternalReaderFromBrowser(secondaryBrowser);
      if (
        internalReader &&
        typeof internalReader.toggleSidebar === "function"
      ) {
        internalReader.toggleSidebar(open);
      } else if (internalReader && internalReader._primaryView) {
        const primaryView = internalReader._primaryView;
        if (primaryView && typeof primaryView.setSidebarOpen === "function") {
          primaryView.setSidebarOpen(open);
        }
      }
    } catch {
      // Ignore errors
    }

    // Resume sync after sidebar animation completes and reinitialize position
    // Only set one timer - the final one that resumes sync
    const timerId = win.setTimeout(() => {
      const s = this.stateMap.get(tabID);
      if (!s) return;
      // Reinitialize sync state with current positions
      this.initSyncState(tabID);
      s.syncPaused = false;
      // Clear timer list
      s.sidebarToggleTimers = [];
    }, 200);

    state.sidebarToggleTimers.push(timerId);
  }

  /**
   * Revert split view to single reader
   * Called when user unchecks "Split-View Reader" in context menu
   * Keeps the focused reader and closes the other one
   * @param sideToClose Optional. If provided, closes this specific side. If not, keeps active side.
   */
  private static async revertToSingleReader(
    tabID: string,
    sideToClose?: "left" | "right",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    // Mark as cleaning up to prevent dead object errors
    state.isCleaningUp = true;

    const win = Zotero.getMainWindow();

    // 1. Determine which reader to keep
    // If sideToClose is "left", we keep right. If "right", keep left.
    // If not specified, we keep the currently active side (default behavior).
    let keepLeft = state.activeSide === "left";
    if (sideToClose) {
      keepLeft = sideToClose === "right";
    }
    const keepItemID = keepLeft ? state.leftItemID : state.rightItemID;

    // 2. Save current view states to disk before closing
    try {
      // Get the most current state from browsers
      const leftCurrentState = this.getCurrentViewStateFromBrowser(
        state.leftBrowser,
      );
      const rightCurrentState = this.getCurrentViewStateFromBrowser(
        state.rightBrowser,
      );

      // Save both states
      await Promise.all([
        this.saveViewStateToDisk(
          state.leftItemID,
          leftCurrentState || state.leftViewState,
        ),
        this.saveViewStateToDisk(
          state.rightItemID,
          rightCurrentState || state.rightViewState,
        ),
      ]);
    } catch (e) {
      Zotero.debug("Split view: Error saving states: " + e);
    }

    // 3. Clean up split state (but don't close tab yet)
    this.cleanupTabResources(tabID);

    // 4. Close current tab and open the kept reader in a new tab
    // Note: Zotero.Reader.open creates its own tab, so we close ours first
    const Zotero_Tabs = (win as any).Zotero_Tabs;
    Zotero_Tabs.close(tabID);

    // 5. Open the kept reader (viewState will auto-restore from .zotero-reader-state)
    await Zotero.Reader.open(keepItemID, undefined, {});

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Clean up split view state resources for a specific tab and remove from map.
   * Core cleanup logic shared by cleanupTab and cleanupTabResources.
   */
  private static cleanupTabResources(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Mark as cleaning up to prevent further operations
    state.isCleaningUp = true;

    // Unload browsers FIRST to prevent dead object errors from callbacks
    // This stops the internal readers from firing more callbacks
    const leftBrowser = state.leftBrowser;
    const rightBrowser = state.rightBrowser;
    this.unloadBrowser(leftBrowser);
    this.unloadBrowser(rightBrowser);

    // Store references before removing from map
    const eventListeners = [...state.eventListeners];
    const timeoutIds = [...state.timeoutIds];
    const sidebarToggleTimers = [...state.sidebarToggleTimers];
    const resizeTimerId = state.resizeTimerId;
    const annotationNotifierID = state.annotationNotifierID;
    const contextPaneObserver = (state as any).contextPaneObserver;
    const dragOverlay = state.dragOverlay;

    // Clear state arrays first to prevent re-entry
    state.eventListeners = [];
    state.timeoutIds = [];
    state.sidebarToggleTimers = [];
    state.leftViewerContainer = null;
    state.rightViewerContainer = null;
    state.resizeTimerId = null;
    state.annotationNotifierID = null;
    state.dragOverlay = null;
    (state as any).contextPaneObserver = null;

    // Stop sync polling before other cleanup
    this.stopSyncPolling(tabID);

    // Remove from map
    this.stateMap.delete(tabID);

    let win: Window | null = null;
    try {
      win = Zotero.getMainWindow();
    } catch (e) {
      Zotero.debug(`Split view: cleanup ${tabID} - getMainWindow failed: ${e}`);
    }

    // Remove split-view-active class only if no other split views are active for the current tab
    if (win) {
      try {
        const Zotero_Tabs = (win as any).Zotero_Tabs;
        const selectedTabID = Zotero_Tabs?.selectedID;
        if (!selectedTabID || !this.stateMap.has(selectedTabID)) {
          win.document.documentElement?.classList.remove("split-view-active");
        }
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - remove class failed: ${e}`,
        );
      }
    }

    // Remove all tracked event listeners
    for (const { target, type, listener, options } of eventListeners) {
      try {
        target.removeEventListener(type, listener, options);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - removeEventListener(${type}) failed: ${e}`,
        );
      }
    }

    // Remove resizer drag overlay if tab was closed during drag (restores cursor and clickability)
    if (dragOverlay && dragOverlay.parentNode) {
      try {
        dragOverlay.remove();
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - dragOverlay.remove failed: ${e}`,
        );
      }
    }

    // Clear all tracked timeouts
    if (win) {
      for (const id of timeoutIds) {
        try {
          win.clearTimeout(id);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout failed: ${e}`,
          );
        }
      }

      // Clear sidebar toggle timers
      for (const timerId of sidebarToggleTimers) {
        try {
          win.clearTimeout(timerId);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout(sidebar) failed: ${e}`,
          );
        }
      }

      // Clear resize debounce timer
      if (resizeTimerId !== null) {
        try {
          win.clearTimeout(resizeTimerId);
        } catch (e) {
          Zotero.debug(
            `Split view: cleanup ${tabID} - clearTimeout(resize) failed: ${e}`,
          );
        }
      }
    }

    // Unregister annotation sync notifier (same PDF split view)
    if (annotationNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(annotationNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - unregisterObserver(annotation) failed: ${e}`,
        );
      }
    }

    // Disconnect context pane observer
    if (contextPaneObserver) {
      try {
        contextPaneObserver.disconnect();
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup ${tabID} - observer.disconnect failed: ${e}`,
        );
      }
    }

    // If no more split views, unregister global tab notifier
    if (this.stateMap.size === 0 && this.globalTabNotifierID) {
      try {
        Zotero.Notifier.unregisterObserver(this.globalTabNotifierID);
      } catch (e) {
        Zotero.debug(
          `Split view: cleanup - unregisterObserver(globalTab) failed: ${e}`,
        );
      }
      this.globalTabNotifierID = null;
    }
  }

  /**
   * Clean up a specific tab's split view (with state save)
   */
  private static cleanupTab(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Prevent re-entry and dead object access
    if (state.isCleaningUp) return;
    state.isCleaningUp = true;

    // Save view states to disk before cleanup (fire and forget)
    const leftItemID = state.leftItemID;
    const rightItemID = state.rightItemID;
    const leftViewState = state.leftViewState;
    const rightViewState = state.rightViewState;

    // Try to get current state from browsers (may fail if dead)
    let leftCurrentState: any = null;
    let rightCurrentState: any = null;
    try {
      leftCurrentState = this.getCurrentViewStateFromBrowser(state.leftBrowser);
    } catch {
      // Browser may be dead
    }
    try {
      rightCurrentState = this.getCurrentViewStateFromBrowser(
        state.rightBrowser,
      );
    } catch {
      // Browser may be dead
    }

    // Save states asynchronously (don't await)
    Promise.all([
      this.saveViewStateToDisk(leftItemID, leftCurrentState || leftViewState),
      this.saveViewStateToDisk(
        rightItemID,
        rightCurrentState || rightViewState,
      ),
    ]).catch(() => {
      /* Ignore save errors */
    });

    // Reset isCleaningUp so cleanupTabResources can process it
    state.isCleaningUp = false;

    this.cleanupTabResources(tabID);
  }

  /**
   * Close split tab
   */
  private static closeSplitTab(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Cleanup state first
    this.cleanupTab(tabID);

    try {
      const win = Zotero.getMainWindow();
      const Zotero_Tabs = (win as any).Zotero_Tabs;
      Zotero_Tabs.close(tabID);
    } catch {
      // Ignore errors
    }

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
    })
      .createLine({
        text: getString("splitview-closed"),
        type: "default",
        icon: `chrome://${config.addonRef}/content/icons/svreader.svg`,
      })
      .show();
    popup.startCloseTimer(2000);
  }

  /**
   * Start sync polling
   * Uses requestAnimationFrame batching: the scroll event handler schedules
   * a rAF callback, so multiple scroll events within the same frame are
   * coalesced into a single DOM write. This reduces cross-compartment
   * overhead and prevents forced reflows during fast scrolling.
   */
  private static startSyncPolling(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      const leftContainer = this.getViewerContainerFromBrowser(
        state.leftBrowser,
      );
      const rightContainer = this.getViewerContainerFromBrowser(
        state.rightBrowser,
      );
      if (!leftContainer || !rightContainer) return;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const win = Zotero.getMainWindow();
      // Minimum interval between scroll syncs (ms) for throttling
      const SCROLL_SYNC_MIN_INTERVAL = 16; // ~60fps

      const makeScrollHandler = (sourceSide: "left" | "right") => () => {
        const s = self.stateMap.get(tabID);
        if (!s || s.isCleaningUp || s.scrollSyncRAFPending || s.syncPaused) {
          return;
        }
        if (sourceSide !== s.primarySide) {
          return;
        }

        // Time-based throttling: skip if last sync was too recent
        const now = Date.now();
        if (now - s.lastScrollSyncTime < SCROLL_SYNC_MIN_INTERVAL) return;

        s.scrollSyncRAFPending = true;
        win.requestAnimationFrame(() => {
          const s2 = self.stateMap.get(tabID);
          if (!s2 || s2.isCleaningUp) return;
          s2.scrollSyncRAFPending = false;
          s2.lastScrollSyncTime = Date.now();
          self.syncViews(tabID, sourceSide);
        });
      };

      state.leftScrollHandler = makeScrollHandler("left");
      state.rightScrollHandler = makeScrollHandler("right");

      leftContainer.addEventListener("scroll", state.leftScrollHandler, {
        passive: true,
      });
      rightContainer.addEventListener("scroll", state.rightScrollHandler, {
        passive: true,
      });
    } catch (e) {
      Zotero.debug(
        `Split view: startSyncPolling error (browser may be dead): ${e}`,
      );
    }
  }

  /**
   * Stop sync polling
   */
  private static stopSyncPolling(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Remove scroll listeners
    try {
      const leftContainer = this.getViewerContainerFromBrowser(
        state.leftBrowser,
      );
      if (leftContainer && state.leftScrollHandler) {
        leftContainer.removeEventListener("scroll", state.leftScrollHandler);
      }
    } catch {
      // Browser may be dead
    }
    try {
      const rightContainer = this.getViewerContainerFromBrowser(
        state.rightBrowser,
      );
      if (rightContainer && state.rightScrollHandler) {
        rightContainer.removeEventListener("scroll", state.rightScrollHandler);
      }
    } catch {
      // Browser may be dead
    }
    state.leftScrollHandler = null;
    state.rightScrollHandler = null;
    // Cancel any pending rAF
    state.scrollSyncRAFPending = false;
  }

  private static SYNC_THRESHOLD = 1;

  /**
   * Sync scroll position between views.
   * Called once per animation frame (via rAF) to batch scroll events.
   * Uses cached viewer containers and delta-based scrolling for performance.
   */
  private static syncViews(tabID: string, sourceSide: "left" | "right") {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    if (state.syncPaused) return;
    if (state.ctrlPressed) return;
    if (state.zoomingCount > 0) return;

    try {
      const sourceContainer =
        sourceSide === "left"
          ? state.leftViewerContainer
          : state.rightViewerContainer;
      const targetContainer =
        sourceSide === "left"
          ? state.rightViewerContainer
          : state.leftViewerContainer;
      const lastSourceScroll =
        sourceSide === "left" ? state.lastLeftScroll : state.lastRightScroll;

      if (!sourceContainer || !targetContainer || !lastSourceScroll) return;

      const sourceTop = sourceContainer.scrollTop;
      const sourceLeft = sourceContainer.scrollLeft;
      const deltaTop = sourceTop - lastSourceScroll.top;
      const deltaLeft = sourceLeft - lastSourceScroll.left;

      if (
        Math.abs(deltaTop) >= this.SYNC_THRESHOLD ||
        Math.abs(deltaLeft) >= this.SYNC_THRESHOLD
      ) {
        const win = Zotero.getMainWindow();
        const newTop = Math.max(0, targetContainer.scrollTop + deltaTop);
        const newLeft = Math.max(0, targetContainer.scrollLeft + deltaLeft);

        state.syncPaused = true;
        targetContainer.scrollTo(newLeft, newTop);

        if (sourceSide === "left") {
          state.lastLeftScroll = {
            top: sourceTop,
            left: sourceLeft,
          };
          state.lastRightScroll = {
            top: newTop,
            left: newLeft,
          };
        } else {
          state.lastRightScroll = {
            top: sourceTop,
            left: sourceLeft,
          };
          state.lastLeftScroll = {
            top: newTop,
            left: newLeft,
          };
        }

        win.requestAnimationFrame(() => {
          const s = this.stateMap.get(tabID);
          if (s && !s.isCleaningUp) {
            s.syncPaused = false;
          }
        });
        return;
      }

      if (sourceSide === "left") {
        state.lastLeftScroll = {
          top: sourceTop,
          left: sourceLeft,
        };
      } else {
        state.lastRightScroll = {
          top: sourceTop,
          left: sourceLeft,
        };
      }
    } catch (e) {
      Zotero.debug(`Split view: syncViews error: ${e}`);
    }
  }

  /**
   * Call zoomIn on a browser's internal reader
   */
  private static zoomInForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomIn === "function") {
        internalReader.zoomIn();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomInForBrowser error: ${e}`);
    }
  }

  /**
   * Call zoomOut on a browser's internal reader
   */
  private static zoomOutForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomOut === "function") {
        internalReader.zoomOut();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomOutForBrowser error: ${e}`);
    }
  }

  /**
   * Call zoomReset on a browser's internal reader
   */
  private static zoomResetForBrowser(browser: XULBrowserElement) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (internalReader && typeof internalReader.zoomReset === "function") {
        internalReader.zoomReset();
      }
    } catch (e) {
      Zotero.debug(`Split view: zoomResetForBrowser error: ${e}`);
    }
  }

  /**
   * Inject a content-side event listener into the reader's iframe.
   * This allows us to call setContextPaneOpen() (which uses flushSync) from
   * within the content compartment, avoiding the cross-compartment issue.
   */
  private static injectContextPaneHandler(browser: XULBrowserElement) {
    try {
      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      const script = doc.createElement("script");
      script.textContent = `
        document.addEventListener('__splitview_context_pane', function(e) {
          if (window._reader && window._reader.setContextPaneOpen) {
            window._reader.setContextPaneOpen(e.detail.open);
          }
        });
      `;
      doc.head.appendChild(script);
      script.remove(); // Remove the script element; the listener persists
    } catch (e) {
      Zotero.debug(`Split view: injectContextPaneHandler error: ${e}`);
    }
  }

  /**
   * Inject CSS to change scrollbar color for a browser's PDF viewer.
   * Red scrollbar indicates the primary window, gray for secondary.
   */
  private static injectScrollbarCSS(
    browser: XULBrowserElement,
    isPrimary: boolean,
  ) {
    try {
      if (!browser || !browser.contentWindow) return;

      // Safety check for dead objects (prevents InvisibleToDebugger errors)
      if (
        Components.utils.isDeadWrapper(browser) ||
        Components.utils.isDeadWrapper(browser.contentWindow)
      ) {
        return;
      }

      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      const iframe = primaryView._iframe;
      if (!iframe || Components.utils.isDeadWrapper(iframe)) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin || Components.utils.isDeadWrapper(iframeWin)) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      if (Components.utils.isDeadWrapper(wrappedWin)) return;

      const doc = wrappedWin.document;
      if (!doc || Components.utils.isDeadWrapper(doc)) return;

      const existingStyle = doc.getElementById("split-view-scrollbar-style");

      // If secondary: just ensure no custom scrollbar style exists
      if (!isPrimary) {
        if (existingStyle && !Components.utils.isDeadWrapper(existingStyle)) {
          existingStyle.remove();
        }
        return;
      }

      // Build the desired CSS content for primary window
      const r = getPref("primaryScrollbarR") ?? 255;
      const g = getPref("primaryScrollbarG") ?? 0;
      const b = getPref("primaryScrollbarB") ?? 0;
      const cssContent = `
        #viewerContainer {
          scrollbar-color: rgba(${r}, ${g}, ${b}, 0.6) #f0f0f0 !important;
        }
      `;

      // Skip injection if existing style already has identical content
      if (
        existingStyle &&
        !Components.utils.isDeadWrapper(existingStyle) &&
        existingStyle.textContent === cssContent
      ) {
        return;
      }

      // Remove outdated style if present
      if (existingStyle && !Components.utils.isDeadWrapper(existingStyle)) {
        existingStyle.remove();
      }

      // Create new style element for primary window
      const style = doc.createElement("style");
      style.id = "split-view-scrollbar-style";
      style.textContent = cssContent;

      if (doc.head && !Components.utils.isDeadWrapper(doc.head)) {
        doc.head.appendChild(style);
      } else if (
        doc.documentElement &&
        !Components.utils.isDeadWrapper(doc.documentElement)
      ) {
        doc.documentElement.appendChild(style);
      }
    } catch (e) {
      Zotero.debug(`Split view: injectScrollbarCSS error: ${e}`);
    }
  }

  /**
   * Update scrollbar colors for both browsers based on current primary side
   */
  private static updateScrollbarColors(tabID: string) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;

    try {
      // Set red scrollbar for primary, gray for secondary
      this.injectScrollbarCSS(state.leftBrowser, state.primarySide === "left");
      this.injectScrollbarCSS(
        state.rightBrowser,
        state.primarySide === "right",
      );
    } catch (e) {
      Zotero.debug(`Split view: updateScrollbarColors error: ${e}`);
    }
  }

  /**
   * Set contextPaneOpen state on a browser's internal reader.
   * This controls whether the toggle button shows in the toolbar.
   *
   * Dispatches a custom event to trigger the injected content-side listener,
   * which calls setContextPaneOpen() with React's flushSync() for a smooth,
   * synchronous transition (no flicker). Falls back to direct _updateState()
   * if the event handler is not available.
   */
  private static setContextPaneOpenForBrowser(
    browser: XULBrowserElement,
    open: boolean,
  ) {
    if (!this.isBrowserAlive(browser)) return;
    try {
      const win = browser.contentWindow;
      if (!win) return;
      const wrappedWin = (win as any).wrappedJSObject || win;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Dispatch event to the injected content-side handler which calls
      // setContextPaneOpen() with flushSync inside the correct compartment.
      // The ENTIRE eventInit object must be cloned into the content compartment,
      // otherwise the content-side CustomEvent constructor can't read the detail property.
      const eventInit = Components.utils.cloneInto({ detail: { open } }, win);
      doc.dispatchEvent(
        new wrappedWin.CustomEvent("__splitview_context_pane", eventInit),
      );
    } catch (e) {
      Zotero.debug(`Split view: setContextPaneOpenForBrowser error: ${e}`);
      // Fallback: direct _updateState (async, may cause brief flicker)
      try {
        const internalReader = this.getInternalReaderFromBrowser(browser);
        const fallbackWin = browser.contentWindow;
        if (internalReader?._updateState && fallbackWin) {
          const stateUpdate = Components.utils.cloneInto(
            { contextPaneOpen: open },
            fallbackWin,
          );
          internalReader._updateState(stateUpdate);
        }
      } catch {
        // Ignore fallback errors
      }
    }
  }

  /**
   * Set up observer to watch context pane collapsed state changes
   * When context pane is toggled via sidenav, update right reader's toggle button visibility
   */
  private static setupContextPaneObserver(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      const contextPane = win.document.getElementById("zotero-context-pane");
      if (!contextPane) return;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const observer = new win.MutationObserver(
        (mutations: MutationRecord[]) => {
          for (const mutation of mutations) {
            if (
              mutation.type === "attributes" &&
              mutation.attributeName === "collapsed"
            ) {
              const isOpen = contextPane.getAttribute("collapsed") !== "true";
              const s = self.stateMap.get(tabID);
              if (s?.rightBrowser) {
                self.setContextPaneOpenForBrowser(s.rightBrowser, isOpen);
              }
            }
          }
        },
      );

      observer.observe(contextPane, {
        attributes: true,
        attributeFilter: ["collapsed"],
      });

      // Store observer for cleanup
      (state as any).contextPaneObserver = observer;
    } catch {
      // Ignore errors
    }
  }

  /**
   * Set up Ctrl key listener on a browser's iframe to detect Ctrl+wheel zoom
   * and Ctrl+Plus/Minus keyboard shortcuts for zoom sync
   */
  private static setupCtrlKeyListener(
    tabID: string,
    browser: XULBrowserElement,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return;

      const iframe = primaryView._iframe;
      if (!iframe) return;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      const doc = wrappedWin.document;
      if (!doc) return;

      // Also get the reader.html window for keyboard events
      const readerWin = browser.contentWindow;
      const wrappedReaderWin = readerWin
        ? (readerWin as any).wrappedJSObject || readerWin
        : null;

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;

      const keydownHandler = (e: KeyboardEvent) => {
        const s = self.stateMap.get(tabID);
        if (!s) return;

        if (e.key === "Control") {
          s.ctrlPressed = true;
          return;
        }

        // Note: Ctrl+Plus/Minus zoom sync is handled by setupMainWindowKeyboardListener
        // to avoid duplicate handling when events propagate through multiple layers
      };
      // Use capture phase to intercept before Zotero/PDF.js handlers
      // Listen on both PDF iframe doc and reader window for better coverage
      this.trackEventListener(
        state,
        doc,
        "keydown",
        keydownHandler as EventListener,
        true,
      );
      if (wrappedReaderWin && wrappedReaderWin.document) {
        this.trackEventListener(
          state,
          wrappedReaderWin.document,
          "keydown",
          keydownHandler as EventListener,
          true,
        );
      }

      const keyupHandler = (e: KeyboardEvent) => {
        const s = self.stateMap.get(tabID);
        if (e.key === "Control" && s) {
          s.ctrlPressed = false;
        }
      };
      this.trackEventListener(
        state,
        doc,
        "keyup",
        keyupHandler as EventListener,
      );

      const blurHandler = () => {
        const s = self.stateMap.get(tabID);
        if (s) {
          s.ctrlPressed = false;
        }
      };
      this.trackEventListener(
        state,
        wrappedWin,
        "blur",
        blurHandler as EventListener,
      );
    } catch {
      // Ignore errors
    }
  }

  /**
   * Handle keyboard zoom (Ctrl+Plus/Minus) - sync to secondary
   */
  private static handleKeyboardZoom(
    tabID: string,
    isLeft: boolean,
    direction: "in" | "out",
  ) {
    const state = this.stateMap.get(tabID);
    if (!state || state.isCleaningUp) return;
    if (!state.syncEnabled) return;

    const secondaryBrowser =
      state.primarySide === "left" ? state.rightBrowser : state.leftBrowser;

    // Pause scroll sync during zoom
    state.zoomingCount++;

    // Sync zoom action to secondary
    if (direction === "in") {
      this.zoomInForBrowser(secondaryBrowser);
    } else {
      this.zoomOutForBrowser(secondaryBrowser);
    }

    // Resume scroll sync after zoom completes
    this.trackTimeout(
      state,
      () => {
        const s = this.stateMap.get(tabID);
        if (s) {
          s.zoomingCount = Math.max(0, s.zoomingCount - 1);
          if (s.zoomingCount === 0) {
            this.initSyncState(tabID);
          }
        }
      },
      150,
    );
  }

  /**
   * Set up resize listener to pause scroll sync during window resize
   * This prevents false scroll sync when context pane expands/collapses
   */
  private static setupResizeListener(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const resizeHandler = () => {
      const s = self.stateMap.get(tabID);
      if (!s) return;

      // Pause sync during resize
      s.syncPaused = true;

      // Clear any existing timer
      if (s.resizeTimerId !== null) {
        win.clearTimeout(s.resizeTimerId);
      }

      // Resume sync after resize settles and reinitialize sync state
      s.resizeTimerId = win.setTimeout(() => {
        const s2 = self.stateMap.get(tabID);
        if (s2) {
          // Reinitialize sync state with new positions after resize
          self.initSyncState(tabID);
          s2.syncPaused = false;
          s2.resizeTimerId = null;
        }
      }, 200);
    };

    this.trackEventListener(
      state,
      win,
      "resize",
      resizeHandler as EventListener,
    );
  }

  /**
   * Set up main window keyboard listener for Ctrl+=/- zoom sync
   * This catches keyboard events at the top level before they're consumed
   */
  private static setupMainWindowKeyboardListener(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const keydownHandler = (e: KeyboardEvent) => {
      const s = self.stateMap.get(tabID);
      if (!s) return;
      if (!s.syncEnabled) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      // Check if zoom key (support both Ctrl+=/- and Ctrl+Shift+=/-)
      // With Shift: key is "+" or "_"
      // Without Shift: key is "=" or "-"
      const isZoomIn =
        e.key === "+" ||
        e.key === "=" ||
        e.code === "Equal" ||
        e.code === "NumpadAdd";
      const isZoomOut =
        e.key === "-" ||
        e.key === "_" ||
        e.code === "Minus" ||
        e.code === "NumpadSubtract";

      if (!isZoomIn && !isZoomOut) return;

      // Determine which browser has focus to check if it's primary
      const activeElement = win.document.activeElement;
      const leftBrowserFocused =
        s.leftBrowser.contains(activeElement) ||
        s.leftBrowser === activeElement;
      const rightBrowserFocused =
        s.rightBrowser.contains(activeElement) ||
        s.rightBrowser === activeElement;

      // If neither browser is focused, use activeSide
      let isLeft: boolean;
      if (leftBrowserFocused) {
        isLeft = true;
      } else if (rightBrowserFocused) {
        isLeft = false;
      } else {
        isLeft = s.activeSide === "left";
      }

      const isPrimary =
        (isLeft && s.primarySide === "left") ||
        (!isLeft && s.primarySide === "right");
      if (!isPrimary) return;

      // Sync zoom to secondary
      if (isZoomIn) {
        self.handleKeyboardZoom(tabID, isLeft, "in");
      } else if (isZoomOut) {
        self.handleKeyboardZoom(tabID, isLeft, "out");
      }
    };

    // Use capture phase at main window level
    this.trackEventListener(
      state,
      win,
      "keydown",
      keydownHandler as EventListener,
      true,
    );
  }

  /**
   * Handle view state change (no-op, zoom sync is done via button listeners)
   */
  private static handleViewStateChange(
    _sourceBrowser: XULBrowserElement,
    _viewState: any,
  ) {
    // Zoom sync is handled by setupZoomButtonListeners for reliability
  }

  /**
   * Get viewer container from browser
   */
  private static getViewerContainerFromBrowser(
    browser: XULBrowserElement,
  ): Element | null {
    try {
      const internalReader = this.getInternalReaderFromBrowser(browser);
      if (!internalReader) return null;

      const primaryView = internalReader._primaryView;
      if (!primaryView) return null;

      const iframe = primaryView._iframe;
      if (!iframe) return null;

      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return null;

      const wrappedWin = (iframeWin as any).wrappedJSObject || iframeWin;
      return wrappedWin.document?.getElementById("viewerContainer") || null;
    } catch (e) {
      Zotero.debug(`Split view: getViewerContainerFromBrowser error: ${e}`);
      return null;
    }
  }

  /**
   * Set up focus/click listeners for a single browser to handle context pane switching.
   * Reusable for both initial setup and secondary PDF replacement.
   * Includes all guard conditions to prevent redundant "Section item data changed" events.
   */
  private static setupBrowserFocusListeners(
    tabID: string,
    browser: XULBrowserElement,
    side: "left" | "right",
    win: Window,
  ) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // Handle focus change with all necessary guards
    const handleFocus = () => {
      const s = self.stateMap.get(tabID);
      if (!s) return;
      if (s.activeSide === side) return; // Already active - avoid redundant updates

      s.activeSide = side;

      // Auto-switch primary when followFocusPrimary preference is enabled.
      // Directly set state to avoid notification popup from setPrimarySide().
      if (getPref("followFocusPrimary") && s.primarySide !== side) {
        s.primarySide = side;
        // Restart sync with new primary if enabled
        if (s.syncEnabled) {
          self.stopSyncPolling(tabID);
          self.initSyncState(tabID);
          self.startSyncPolling(tabID);
        }
      }

      // Update scrollbar colors to reflect active/primary side
      self.updateScrollbarColors(tabID);

      // Skip context pane update when both sides belong to the same
      // Zotero item (same parentItemID), to avoid redundant updates
      // that cause "Section item data changed" log spam
      if (s.leftParentItemID === s.rightParentItemID) return;

      const parentItemID =
        side === "left" ? s.leftParentItemID : s.rightParentItemID;
      self.updateContextPane(tabID, win, parentItemID);
    };

    // IMPORTANT: Wrap handlers in setTimeout to run asynchronously.
    // Zotero's internal reader handlers (mouse events, etc.) may be running synchronously,
    // and accessing certain properties or layout immediately after can cause errors
    // like "Uncaught TypeError: can't access property 'rects', pointPosition is null".
    // By yielding to the event loop, we ensure Zotero's internal logic completes first.
    const clickHandler = () => win.setTimeout(handleFocus, 0);
    const focusHandler = () => win.setTimeout(handleFocus, 0);

    this.trackEventListener(
      state,
      browser,
      "click",
      clickHandler as EventListener,
      true,
    );
    this.trackEventListener(
      state,
      browser,
      "focus",
      focusHandler as EventListener,
      true,
    );
  }

  /**
   * Set up focus listeners for context pane switching (both browsers).
   * Delegates to setupBrowserFocusListeners for each side.
   */
  private static setupFocusListeners(
    tabID: string,
    leftBrowser: XULBrowserElement,
    rightBrowser: XULBrowserElement,
    win: Window,
  ) {
    this.setupBrowserFocusListeners(tabID, leftBrowser, "left", win);
    this.setupBrowserFocusListeners(tabID, rightBrowser, "right", win);
  }

  /**
   * Update context pane to show the specified item
   * Based on Zotero's contextPane.js implementation
   */
  private static updateContextPane(
    tabID: string,
    win: Window,
    parentItemID: number,
  ) {
    try {
      const state = this.stateMap.get(tabID);
      if (!state || state.isCleaningUp) return;

      const document = win.document;
      const item = Zotero.Items.get(parentItemID);
      if (!item) return;

      const contextPaneElement = document.querySelector("context-pane") as any;
      if (!contextPaneElement) return;

      const itemPaneDeck = contextPaneElement._itemPaneDeck;
      if (!itemPaneDeck) return;

      let itemDetails = itemPaneDeck.querySelector(
        `[data-tab-id="${tabID}"]`,
      ) as any;

      if (itemDetails) {
        itemDetails.item = item;
        if (typeof itemDetails.render === "function") {
          itemDetails.render();
        }
      } else {
        itemDetails = document.createXULElement("item-details");
        itemDetails.id = tabID + "-context";
        itemDetails.dataset.tabId = tabID;
        itemDetails.className = "zotero-item-pane-content";
        itemPaneDeck.appendChild(itemDetails);

        // Set up the item-details properties
        const libraryID = item.libraryID;
        const library = Zotero.Libraries.get(libraryID);
        const editable = library && library.editable && !item.deleted;

        itemDetails.editable = editable;
        itemDetails.tabID = tabID;
        itemDetails.tabType = "reader"; // Use reader type for proper rendering
        itemDetails.item = item;

        if (contextPaneElement._sidenav) {
          itemDetails.sidenav = contextPaneElement._sidenav;
        }
      }

      itemPaneDeck.selectedPanel = itemDetails;
    } catch {
      // Ignore context pane errors
    }
  }

  /**
   * Ensure the global tab notifier is registered.
   * This is a single notifier shared across all split view tabs.
   * It handles CSS class toggling and tab close cleanup for all split views.
   */
  private static ensureGlobalTabNotifier(win: Window) {
    // Already registered
    if (this.globalTabNotifierID) return;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const notifierCallback = {
      notify: (
        action: string,
        type: string,
        ids: (string | number)[],
        _extraData: any,
      ) => {
        if (type !== "tab") return;

        if (action === "select") {
          const selectedTabID = String(ids[0]);
          const selectedState = self.stateMap.get(selectedTabID);

          if (selectedState && !selectedState.isCleaningUp) {
            // This tab has split view - activate CSS and context pane
            win.document.documentElement?.classList.add("split-view-active");
            self.showContextPaneForSplitView(win);
            // Update context pane content to show the active side's item
            const parentItemID =
              selectedState.activeSide === "left"
                ? selectedState.leftParentItemID
                : selectedState.rightParentItemID;
            self.updateContextPane(selectedTabID, win, parentItemID);
          } else {
            // This tab has no split view - remove CSS class
            win.document.documentElement?.classList.remove("split-view-active");
          }
        } else if (action === "close") {
          // Handle tab close - cleanup if this tab has split view
          const closedTabID = String(ids[0]);
          const closedState = self.stateMap.get(closedTabID);
          if (closedState && !closedState.isCleaningUp) {
            // Save states before cleanup
            const leftItemID = closedState.leftItemID;
            const rightItemID = closedState.rightItemID;
            const leftViewState = closedState.leftViewState;
            const rightViewState = closedState.rightViewState;

            // Try to get current state from browsers
            let leftCurrentState: any = null;
            let rightCurrentState: any = null;
            try {
              leftCurrentState = self.getCurrentViewStateFromBrowser(
                closedState.leftBrowser,
              );
            } catch {
              /* Browser may be dead */
            }
            try {
              rightCurrentState = self.getCurrentViewStateFromBrowser(
                closedState.rightBrowser,
              );
            } catch {
              /* Browser may be dead */
            }

            // Save states asynchronously
            Promise.all([
              self.saveViewStateToDisk(
                leftItemID,
                leftCurrentState || leftViewState,
              ),
              self.saveViewStateToDisk(
                rightItemID,
                rightCurrentState || rightViewState,
              ),
            ]).catch(() => {
              /* Ignore save errors */
            });

            self.cleanupTabResources(closedTabID);
          }
        }
      },
    };

    this.globalTabNotifierID = Zotero.Notifier.registerObserver(
      notifierCallback,
      ["tab"],
      "splitView",
      20,
    );
  }

  /**
   * Show context pane elements for our split view tab
   */
  private static showContextPaneForSplitView(win: Window) {
    const document = win.document;
    const ZoteroContextPane = (win as any).ZoteroContextPane;
    if (!ZoteroContextPane) return;

    const splitter = ZoteroContextPane.splitter;
    if (splitter) {
      splitter.setAttribute("hidden", "false");
    }

    const sidenav = ZoteroContextPane.sidenav;
    if (sidenav) {
      sidenav.hidden = false;
      sidenav.removeAttribute("hidden");
      sidenav.style.display = "";
      sidenav.style.visibility = "visible";
    }

    const sidenavById = document.getElementById(
      "zotero-context-pane-sidenav",
    ) as HTMLElement | null;
    if (sidenavById) {
      (sidenavById as any).hidden = false;
      sidenavById.removeAttribute("hidden");
    }

    const contextPaneBox = document.getElementById("zotero-context-pane");
    if (contextPaneBox) {
      contextPaneBox.removeAttribute("hidden");
    }

    this.injectSidenavCSS(document);
  }

  /**
   * Inject CSS to keep sidenav visible when context pane is collapsed
   * Only applies when split-view tab is active (body has .split-view-active class)
   */
  private static injectSidenavCSS(document: Document) {
    const styleId = "split-view-sidenav-style";
    if (document.getElementById(styleId)) {
      // CSS already injected, just ensure the active class is set
      document.documentElement?.classList.add("split-view-active");
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    // Override XUL's collapsed behavior for context pane
    // Zotero uses display:flex for context pane, we need to maintain that
    // when collapsed to keep sidenav visible
    style.textContent = `
      /* Context pane layout - ONLY override when expanded (not collapsed).
       * When collapsed, we apply NO display override so XUL's native
       * collapsed="true" behavior works correctly (hides everything
       * including the sidenav). This matches native Zotero behavior:
       * collapsed → entire context pane + sidenav hidden, reader toggle shown. */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) {
        display: flex !important;
        flex-direction: row !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
      }
      /* Force sidenav visible when context pane is expanded
       * (overrides the hidden="true" attribute that Zotero sets by default) */
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav {
        display: flex !important;
        flex-direction: column !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 37px !important;
        min-width: 37px !important;
        flex-shrink: 0 !important;
      }
      :root.split-view-active #zotero-context-pane:not([collapsed="true"]) #zotero-context-pane-sidenav[hidden] {
        display: flex !important;
        visibility: visible !important;
      }
      /* Splitter - only show when context pane is expanded */
      :root.split-view-active #zotero-context-splitter[state="open"] {
        display: flex !important;
        visibility: visible !important;
      }
      /* Dragging cursor for resizer */
      body.split-view-dragging,
      body.split-view-dragging * {
        cursor: ew-resize !important;
        user-select: none !important;
      }
    `;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    }

    document.documentElement?.classList.add("split-view-active");
  }

  /**
   * Set up context pane for our split view tab
   * Note: Polling removed - tab notifier handles tab selection events
   */
  private static setupContextPane(tabID: string, win: Window) {
    const state = this.stateMap.get(tabID);
    if (!state) return;

    // Initialize immediately
    this.showContextPaneForSplitView(win);

    // Single delayed call to ensure async updates complete
    // (Replaced multiple 50ms/150ms/300ms calls with a single 300ms call)
    this.trackTimeout(state, () => this.showContextPaneForSplitView(win), 300);

    // Note: Polling interval removed - ensureGlobalTabNotifier() already handles
    // tab selection events and calls showContextPaneForSplitView() when needed
  }

  // NOTE: The old singleton cleanup() method has been replaced by:
  // - cleanupTab(tabID): saves state + cleans up resources for a specific tab
  // - cleanupTabResources(tabID): cleans up resources only (no state save)

  // === Library-mode split view (open from Shift+P without an active reader) ===

  /**
   * Open split view from the library / non-reader context.
   * Two-step flow: select first PDF → open it → select second PDF → split view.
   * If the user cancels the second selection, the first PDF stays open as a normal tab.
   */
  private static async openSplitViewFromLibrary() {
    // Step 1: select the first PDF (left side)
    const firstPDF = await this.showItemPrompt(
      undefined,
      getString("splitview-select-first-pdf"),
    );
    if (!firstPDF) return;

    const win = Zotero.getMainWindow();
    const Zotero_Tabs = (win as any).Zotero_Tabs;

    // Check if this PDF is already open in an existing tab (including split view tabs)
    // This handles both normal tabs and split view tabs after Zotero restart
    let existingTabID: string | null = null;
    let isAlreadySplitView = false;

    if (Zotero_Tabs) {
      const tabs =
        typeof Zotero_Tabs.getTabs === "function"
          ? Zotero_Tabs.getTabs()
          : Zotero_Tabs._tabs || [];

      for (const tab of tabs) {
        // Check if tab contains this PDF as left side
        if (tab.data?.itemID === firstPDF.id) {
          existingTabID = tab.id;
          // Check if this tab is already a split view (has rightItemID)
          if (tab.data?.rightItemID) {
            isAlreadySplitView = true;
          }
          break;
        }
        // Also check split view data for right-side PDF
        if (tab.data?.rightItemID === firstPDF.id) {
          existingTabID = tab.id;
          isAlreadySplitView = true;
          break;
        }
      }
    }

    // If already in a split view tab, just switch to it and return
    if (existingTabID && isAlreadySplitView) {
      Zotero_Tabs.select(existingTabID);
      return;
    }

    let reader: _ZoteroTypes.ReaderInstance | null = null;

    if (existingTabID) {
      // Switch to existing tab first
      Zotero_Tabs.select(existingTabID);
      // Wait for tab switch and reader initialization
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Get the reader after switching
      reader = Zotero.Reader.getByTabID(existingTabID);
      if (!reader) {
        // Tab might be unloaded, wait for it to load
        await new Promise((resolve) => setTimeout(resolve, 1000));
        reader = Zotero.Reader.getByTabID(existingTabID);
      }
    }

    if (!reader) {
      // Open the first PDF in a new reader tab
      reader = (await Zotero.Reader.open(firstPDF.id)) || null;
    }

    if (!reader) return;

    // Check if this reader is already in split view mode (via stateMap)
    if (this.stateMap.has(reader.tabID)) {
      // Already in split view, no need to show second prompt
      return;
    }

    // Wait for the reader to fully initialise
    // For unloaded tabs, we need to wait longer and ensure the reader is ready
    await this.waitForReaderReady(reader);

    // Step 2: select the second PDF (right side)
    const secondPDF = await this.showItemPrompt(
      firstPDF.libraryID,
      getString("splitview-select-second-pdf"),
    );
    if (!secondPDF) return; // User cancelled – leave the single PDF open

    // Check if same PDF
    const isSamePDF = secondPDF.id === reader.itemID;

    if (isSamePDF) {
      await this.convertToSamePDFSplitView(reader);
    } else {
      await this.convertToSplitView(reader, secondPDF);
    }
  }

  /**
   * Wait for a reader to be fully initialized and ready
   * Uses Zotero's native Promise mechanisms instead of arbitrary delays
   */
  private static async waitForReaderReady(
    reader: any,
    maxWaitMs = 10000,
  ): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), maxWaitMs),
    );

    try {
      // Method 1: Use _initPromise if available (most reliable for basic init)
      if (reader._initPromise) {
        await Promise.race([reader._initPromise, timeoutPromise]);
      }

      // Method 2: Wait for _internalReader._primaryView.initializedPromise
      // This is the pattern Zotero uses internally (see reader.js line 2039-2053)
      const pollInterval = 10;
      let attempts = 0;
      const maxAttempts = maxWaitMs / pollInterval;

      while (!reader._internalReader?._primaryView?._iframeWindow) {
        if (attempts >= maxAttempts) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        attempts++;
      }

      // Wait for the primary view's initialized promise if available
      if (reader._internalReader?._primaryView?.initializedPromise) {
        await Promise.race([
          reader._internalReader._primaryView.initializedPromise,
          timeoutPromise,
        ]);
      }
    } catch {
      // Timeout or error - reader may still be usable
    }
  }

  // === PDF selector UI methods (retained from original) ===

  private static getPDFAttachments(item: Zotero.Item): Zotero.Item[] {
    const attachmentIDs = item.getAttachments();
    const pdfs: Zotero.Item[] = [];
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      if (
        att &&
        att.isFileAttachment() &&
        att.attachmentContentType === "application/pdf"
      ) {
        pdfs.push(att);
      }
    }
    return pdfs;
  }

  private static getItemDescription(item: Zotero.Item): string {
    const parts: string[] = [];
    if (item.firstCreator) {
      parts.push(item.firstCreator);
    }
    const date = item.getField("date", true, true) as string;
    if (date) {
      const year = date.substring(0, 4);
      if (year !== "0000") {
        parts.push(`(${parseInt(year)})`);
      }
    }
    const pubTitle = item.getField("publicationTitle", false, true);
    if (pubTitle) {
      parts.push(String(pubTitle));
    }
    return parts.join(", ");
  }

  private static showItemPrompt(
    libraryID?: number,
    placeholder?: string,
  ): Promise<Zotero.Item | null> {
    return new Promise((resolve) => {
      let resolved = false;
      let searchTimer: number | null = null;

      // Track PDF sub-list state so we can filter PDFs by title
      let currentPDFs: Zotero.Item[] | null = null;
      let currentParentItem: Zotero.Item | null = null;

      const win = Zotero.getMainWindow();
      const promptInstance = ztoolkit.Prompt.prompt;
      const { promptNode } = promptInstance;

      // Save original Prompt methods so we can restore them in finish()
      const origShowSuggestions = (promptInstance as any).showSuggestions.bind(
        promptInstance,
      );
      const origExit = (promptInstance as any).exit.bind(promptInstance);

      // MutationObserver to detect external close (click outside, etc.)
      const observer = new win.MutationObserver(() => {
        if (promptNode.style.display === "none") {
          finish(null);
        }
      });

      // Helper: count current containers
      const getContainers = () =>
        promptNode.querySelectorAll(".commands-containers .commands-container");

      // Helper: remove all containers except the base (index 0)
      const removeContainersAboveBase = () => {
        const all = getContainers();
        for (let i = all.length - 1; i >= 1; i--) {
          all[i].remove();
        }
      };

      // ------------------------------------------------------------------
      // finish() – single exit point; restore toolkit state first to avoid
      // re-entrancy, then clear timers/observer, DOM, and refs to allow GC.
      // ------------------------------------------------------------------
      const finish = (item: Zotero.Item | null) => {
        if (resolved) return;
        resolved = true;

        // 1. Restore original prompt methods so toolkit no longer holds our overrides
        (promptInstance as any).showSuggestions = origShowSuggestions;
        (promptInstance as any).exit = origExit;

        // 2. Stop observing and clear debounce timer so callbacks never run after this
        observer.disconnect();
        if (searchTimer != null) {
          win.clearTimeout(searchTimer);
          searchTimer = null;
        }

        // 3. Reset DOM: one empty base so next Shift+P shows command list
        promptNode
          .querySelectorAll(".commands-container")
          .forEach((e: Element) => e.remove());
        promptInstance.createCommandsContainer();

        // 4. Clear input and PDF state so nothing holds references
        promptInstance.inputNode.value = "";
        (promptInstance as any).lastInputText = "";
        currentPDFs = null;
        currentParentItem = null;

        // 5. Hide prompt and resolve
        if (promptNode.style.display !== "none") {
          promptNode.style.display = "none";
        }
        resolve(item);
      };

      // ------------------------------------------------------------------
      // doSearch() – item search; removes old item container, rebuilds
      // ------------------------------------------------------------------
      const doSearch = async (text: string) => {
        if (resolved) return;

        Zotero.debug("Split view debug: doSearch text='" + text + "'");

        // If text is empty, show items for currently open PDFs
        if (!text.trim()) {
          const itemsWithPDF: Zotero.Item[] = [];
          const seenAttachmentIDs = new Set<number>();
          const seenParentIDs = new Set<number>();

          // 1. Check instantiated readers (Zotero.Reader._readers)
          const readers = (Zotero.Reader as any)._readers || [];
          for (const reader of readers) {
            if (reader && reader.itemID) seenAttachmentIDs.add(reader.itemID);
          }

          // 2. Check all tabs (including unloaded ones for lazy loading)
          const win = Zotero.getMainWindow();
          const Zotero_Tabs =
            (win as any).Zotero_Tabs || Zotero.getMainWindow().Zotero_Tabs;
          if (Zotero_Tabs) {
            // Try to get tabs array - support both Zotero 6 and 7 patterns
            const tabs =
              typeof Zotero_Tabs.getTabs === "function"
                ? Zotero_Tabs.getTabs()
                : Zotero_Tabs._tabs || [];

            for (const tab of tabs) {
              // Check for reader type, including unloaded tabs after Zotero restart
              // Types: 'reader', 'reader-unloaded', 'reader-loading'
              const isReaderTab =
                tab.type === "reader" ||
                tab.type === "reader-unloaded" ||
                tab.type === "reader-loading" ||
                tab.type?.startsWith("reader") ||
                tab.mode === "reader";

              if (isReaderTab && tab.data && tab.data.itemID) {
                seenAttachmentIDs.add(tab.data.itemID);
              } else if (isReaderTab) {
                // Fallback: try to get reader if initialized
                const r = Zotero.Reader.getByTabID(tab.id);
                if (r && r.itemID) seenAttachmentIDs.add(r.itemID);
              }
            }
          }

          // 3. Convert Attachment IDs to Parent Items
          for (const attachmentID of seenAttachmentIDs) {
            const attachment = Zotero.Items.get(attachmentID);
            // Only consider attachments with parents (regular items)
            if (attachment && attachment.parentID) {
              if (!seenParentIDs.has(attachment.parentID)) {
                const parent = Zotero.Items.get(attachment.parentID);
                if (parent) {
                  itemsWithPDF.push(parent);
                  seenParentIDs.add(attachment.parentID);
                }
              }
            }
          }

          removeContainersAboveBase();

          if (itemsWithPDF.length === 0) {
            // Show "no open pdf" message
            const container = promptInstance.createCommandsContainer();
            container.classList.add("suggestions");
            const ele = ztoolkit.UI.createElement(win.document, "div", {
              namespace: "html",
              classList: ["command"],
              styles: {
                opacity: "0.5",
                padding: "8px",
                textAlign: "center",
                cursor: "default",
              },
              children: [
                {
                  tag: "span",
                  properties: { innerText: getString("splitview-no-open-pdf") },
                },
              ],
            });
            container.appendChild(ele);
            return;
          }

          buildItemList(promptInstance, itemsWithPDF);
          return;
        }

        const s = new Zotero.Search();
        if (libraryID !== undefined) {
          s.addCondition("libraryID", "is", String(libraryID));
        }
        s.addCondition("itemType", "isNot", "attachment");
        s.addCondition("itemType", "isNot", "note");
        if (text.trim()) {
          s.addCondition("quicksearch-titleCreatorYear", "contains", text);
        }
        const ids = await s.search();
        if (resolved) return;
        const itemsWithPDF: Zotero.Item[] = [];
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (!item || !item.isRegularItem()) continue;
          if (this.getPDFAttachments(item).length > 0) {
            itemsWithPDF.push(item);
          }
          if (itemsWithPDF.length >= 30) break;
        }

        // Remove all containers above the base before rebuilding
        removeContainersAboveBase();
        buildItemList(promptInstance, itemsWithPDF);
      };

      // ------------------------------------------------------------------
      // doPDFSearch() – filter stored PDFs by title, rebuild PDF container
      // ------------------------------------------------------------------
      const doPDFSearch = (text: string) => {
        if (resolved || !currentPDFs || !currentParentItem) return;

        const filtered = text.trim()
          ? currentPDFs.filter((pdf: Zotero.Item) => {
              const title = String(
                pdf.getField("title") || (pdf as any).attachmentFilename || "",
              );
              return title.toLowerCase().includes(text.toLowerCase());
            })
          : currentPDFs;

        // Remove existing PDF container (the last one, beyond base + items)
        const all = getContainers();
        if (all.length >= 3) {
          all[all.length - 1].remove();
        }

        buildPDFList(promptInstance, filtered, currentParentItem);
      };

      // ------------------------------------------------------------------
      // Override showSuggestions – replaces the toolkit's fuzzy-match logic
      // that would crash on our custom elements (no .name span).
      // Supports search in BOTH item list and PDF list.
      // ------------------------------------------------------------------
      (promptInstance as any).showSuggestions = async (inputText: string) => {
        if (resolved) return origShowSuggestions(inputText);

        if (searchTimer) win.clearTimeout(searchTimer);

        if (currentPDFs !== null) {
          // ----- In PDF sub-list: filter PDFs by title -----
          if (inputText.trim() === "") {
            doPDFSearch("");
            return;
          }
          searchTimer = win.setTimeout(() => {
            if (!resolved) doPDFSearch(inputText);
          }, 200) as unknown as number;
        } else {
          // ----- In item list: search items by keyword -----
          if (inputText.trim() === "") {
            doSearch("");
            return;
          }
          searchTimer = win.setTimeout(() => {
            if (!resolved) doSearch(inputText);
          }, 300) as unknown as number;
        }
      };

      // ------------------------------------------------------------------
      // Override exit – Esc always goes back one level:
      //   PDF list → item list → command list → close prompt
      // ------------------------------------------------------------------
      (promptInstance as any).exit = () => {
        if (resolved) return origExit();

        const containers = getContainers();

        if (currentPDFs !== null) {
          // In PDF sub-list: pop back to item list (toolkit's exit shows previous container)
          if (containers.length >= 3) {
            origExit();
          }
          currentPDFs = null;
          currentParentItem = null;
          promptInstance.inputNode.value = "";
          (promptInstance as any).lastInputText = "";
          promptInstance.inputNode.placeholder =
            placeholder || getString("splitview-select-second-pdf");
          promptInstance.inputNode.focus();
          return;
        }

        if (containers.length >= 2) {
          // In item list: pop back to command list, then repopulate with commands
          origExit();
          promptInstance.showCommands(promptInstance.commands, true);
          promptInstance.inputNode.value = "";
          (promptInstance as any).lastInputText = "";
          promptInstance.inputNode.focus();
          return;
        }

        // Only base (or command list): close prompt entirely
        finish(null);
      };

      // ------------------------------------------------------------------
      // buildItemList / buildPDFList – UI builders
      // ------------------------------------------------------------------
      const buildItemList = (prompt: any, items: Zotero.Item[]) => {
        if (resolved) return;

        const container = prompt.createCommandsContainer();
        container.classList.add("suggestions");

        if (items.length === 0) {
          // Show "not found" as a non-interactive element inside the container
          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            styles: {
              opacity: "0.5",
              padding: "8px",
              textAlign: "center",
              cursor: "default",
            },
            children: [
              {
                tag: "span",
                properties: {
                  innerText: getString("splitview-not-found"),
                },
              },
            ],
          });
          container.appendChild(ele);
          return;
        }

        items.slice(0, 30).forEach((item: Zotero.Item) => {
          const title = String(item.getField("title") || "Untitled");
          const description = this.getItemDescription(item);
          const pdfs = this.getPDFAttachments(item);
          const pdfCount = pdfs.length;

          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            listeners: [
              {
                type: "mousemove",
                listener: function () {
                  prompt.selectItem(this as unknown as HTMLDivElement);
                },
              },
              {
                type: "click",
                listener: () => {
                  if (pdfCount === 0) {
                    prompt.showTip(getString("splitview-not-found"));
                    return;
                  }
                  if (pdfCount === 1) {
                    finish(pdfs[0]);
                  } else {
                    // Enter PDF sub-list: store state and clear input
                    currentPDFs = pdfs;
                    currentParentItem = item;
                    promptInstance.inputNode.value = "";
                    (promptInstance as any).lastInputText = "";
                    buildPDFList(prompt, pdfs, item);
                  }
                },
              },
            ],
            styles: {
              display: "flex",
              flexDirection: "column",
              justifyContent: "start",
            },
            children: [
              {
                tag: "span",
                styles: {
                  fontWeight: "bold",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
                properties: {
                  innerText:
                    title + (pdfCount > 1 ? ` [${pdfCount} PDFs]` : ""),
                },
              },
              {
                tag: "span",
                styles: {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: "0.7",
                  fontSize: "0.9em",
                },
                properties: {
                  innerText: description,
                },
              },
            ],
          });
          container.appendChild(ele);
        });

        // Auto-select first item so that pressing Enter triggers it
        const first = container.querySelector(".command");
        if (first) (first as HTMLElement).classList.add("selected");
      };

      const buildPDFList = (
        prompt: any,
        pdfs: Zotero.Item[],
        parentItem: Zotero.Item,
      ) => {
        if (resolved) return;

        const container = prompt.createCommandsContainer();
        container.classList.add("suggestions");

        if (pdfs.length === 0) {
          // Show "not found" for PDF filter
          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            styles: {
              opacity: "0.5",
              padding: "8px",
              textAlign: "center",
              cursor: "default",
            },
            children: [
              {
                tag: "span",
                properties: {
                  innerText: getString("splitview-not-found"),
                },
              },
            ],
          });
          container.appendChild(ele);
          return;
        }

        pdfs.forEach((pdf: Zotero.Item) => {
          const pdfTitle = String(
            pdf.getField("title") || (pdf as any).attachmentFilename || "PDF",
          );

          const ele = ztoolkit.UI.createElement(win.document, "div", {
            namespace: "html",
            classList: ["command"],
            listeners: [
              {
                type: "mousemove",
                listener: function () {
                  prompt.selectItem(this as unknown as HTMLDivElement);
                },
              },
              {
                type: "click",
                listener: () => {
                  finish(pdf);
                },
              },
            ],
            styles: {
              display: "flex",
              flexDirection: "column",
              justifyContent: "start",
            },
            children: [
              {
                tag: "span",
                styles: {
                  fontWeight: "bold",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
                properties: {
                  innerText: pdfTitle,
                },
              },
              {
                tag: "span",
                styles: {
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: "0.7",
                  fontSize: "0.9em",
                },
                properties: {
                  innerText: String(parentItem.getField("title") || ""),
                },
              },
            ],
          });
          container.appendChild(ele);
        });

        // Auto-select first PDF so that pressing Enter triggers it
        const first = container.querySelector(".command");
        if (first) (first as HTMLElement).classList.add("selected");
      };

      // ------------------------------------------------------------------
      // Show prompt with an empty base container
      // ------------------------------------------------------------------
      promptNode.style.display = "flex";
      promptNode
        .querySelectorAll(".commands-container")
        .forEach((e: Element) => e.remove());
      promptInstance.createCommandsContainer();
      promptInstance.inputNode.value = "";
      (promptInstance as any).lastInputText = "";
      promptInstance.inputNode.placeholder =
        placeholder || getString("splitview-select-second-pdf");
      promptInstance.inputNode.focus();

      // Run initial search to populate the item list
      doSearch("");

      observer.observe(promptNode, {
        attributes: true,
        attributeFilter: ["style"],
      });
    });
  }
}
