export interface SplitReaderAdapterOptions {
  tabID: string;
  item: any;
  iframeWindow: any;
  getInternalReader: () => any;
  addToNote: (annotations: any[]) => void;
  instanceID: string;
}

/**
 * Expose the subset of ReaderInstance used by reader extensions.
 * Embedded readers created via reader.html's createReader() are otherwise
 * invisible to Zotero.Reader event listeners (e.g. Translate for Zotero's
 * text-selection popup), because Zotero only forwards events for instances
 * it created itself (ReaderTab / ReaderWindow).
 */
export function createSplitReaderAdapter(options: SplitReaderAdapterOptions) {
  return {
    tabID: options.tabID,
    itemID: options.item.id,
    _item: options.item,
    _iframeWindow: options.iframeWindow,
    _instanceID: options.instanceID,
    get _internalReader() {
      return options.getInternalReader();
    },
    _addToNote(annotations: any[]) {
      options.addToNote(annotations);
    },
  };
}

/**
 * Forward an embedded reader's `customEvent` DOM event to
 * Zotero.Reader._dispatchEvent(), mirroring what Zotero's ReaderInstance
 * does in xpcom/reader.js:
 *
 *   let data = event.detail.wrappedJSObject;
 *   let append = data.append;
 *   data.append = (...args) => {
 *     append(...Components.utils.cloneInto(args, this._iframeWindow,
 *       { wrapReflectors: true, cloneFunctions: true }));
 *   };
 *   data.reader = this;
 *   Zotero.Reader._dispatchEvent(data);
 */
export function forwardReaderCustomEvent(
  event: any,
  reader: any,
  cloneArgs: (args: any[]) => any[],
  dispatch: (data: any) => void,
) {
  const data = event?.detail?.wrappedJSObject;
  if (!data) return;

  const append = data.append;
  if (typeof append === "function") {
    data.append = (...args: any[]) => append(...cloneArgs(args));
  }
  data.reader = reader;
  dispatch(data);
}
