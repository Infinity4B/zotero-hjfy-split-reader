import { getString } from "../utils/locale";
import {
  ArxivResolutionError,
  buildHjfyURL,
  extractArxivReferences,
  hasExactArxivReference,
  resolveArxivReference,
  selectHighestArxivVersion,
} from "./arxivReference";
import type { VersionedArxivReference } from "./arxivReference";
import {
  classifyHjfyTaskState,
  hasHjfyChinesePdf,
  isHjfyPendingMessage,
} from "./hjfyState";
import type { HJFYTaskStatus } from "./hjfyState";
import { SplitViewFactory } from "./splitView";

interface ResolvedSelection {
  parentItem: Zotero.Item;
  sourcePDF: Zotero.Item;
  reference: VersionedArxivReference;
}

interface ResolvedSourcePDF {
  sourcePDF: Zotero.Item;
  reference: VersionedArxivReference;
}

interface HJFYArxivInfo {
  hasSrc: boolean;
}

interface HJFYArxivStatus {
  status: HJFYTaskStatus;
  info?: string;
}

interface HJFYFileInfo {
  id: string;
  title: string;
  origin: string;
  zhCN?: string;
  zhCNTar?: string;
  isDeepSeek: boolean;
}

class HJFYLoginRequiredError extends Error {
  constructor(public readonly reference: VersionedArxivReference) {
    super("幻觉翻译要求登录后才能为这篇论文创建翻译任务");
  }
}

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";

  static registerItemMenu() {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) return;

    const elem = ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: this.menuID,
        namespace: "xul",
        attributes: {
          label: getString("hjfy-menu-label"),
          image: `chrome://${addon.data.config.addonRef}/content/icons/svreader.svg`,
        },
        classList: ["menuitem-iconic"],
        listeners: [
          {
            type: "command",
            listener: () => {
              void this.handleMenuCommand();
            },
          },
        ],
      },
      itemMenu,
    ) as XULElement;

    (elem as any).style.setProperty("-moz-context-properties", "fill");
    (elem as any).style.setProperty("fill", "currentColor");
  }

  private static async handleMenuCommand() {
    const items = ztoolkit.getGlobal("ZoteroPane").getSelectedItems();
    if (items.length !== 1) {
      this.showMessage("请选择单篇论文或其 PDF 附件后再执行此操作", "warning");
      return;
    }

    const popup = new ztoolkit.ProgressWindow(getString("hjfy-window-title"), {
      closeOnClick: true,
      closeTime: -1,
    });
    popup.createLine({
      text: `正在处理: ${items[0].getDisplayTitle()}`,
      type: "default",
      progress: 10,
    });
    popup.show();

    try {
      const { parentItem, sourcePDF, reference } = await this.resolveSelection(
        items[0],
      );
      popup.createLine({
        text: `已确认本地论文版本: arXiv ${reference.id}`,
        type: "success",
        progress: 25,
      });
      let translatedPDF = this.findExistingTranslation(parentItem, reference);

      if (translatedPDF) {
        popup.createLine({
          text: "已找到已有的幻觉翻译附件，准备分屏打开",
          type: "success",
          progress: 40,
        });
      } else {
        popup.createLine({
          text: "未找到现成翻译，正在向 hjfy.top 查询",
          type: "default",
          progress: 35,
        });
        translatedPDF = await this.fetchAndAttachTranslation(
          parentItem,
          reference,
        );
        popup.createLine({
          text: "已保存新的幻觉翻译附件",
          type: "success",
          progress: 75,
        });
      }

      popup.createLine({
        text: "正在打开分屏阅读器",
        type: "default",
        progress: 90,
      });
      await SplitViewFactory.openItemsInSplitView(sourcePDF, translatedPDF, {
        primarySide: "right",
        activeSide: "right",
      });
      popup.createLine({
        text: "已在分屏阅读器中打开原文与幻觉翻译",
        type: "success",
        progress: 100,
      });
      popup.startCloseTimer(4000);
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        Zotero.launchURL(buildHjfyURL("arxiv", error.reference));
      }
      const message =
        error instanceof Error ? error.message : "未知错误，未能获取幻觉翻译";
      popup.createLine({
        text: `失败: ${message}`,
        type: "error",
        progress: 100,
      });
      popup.startCloseTimer(7000);
    }
  }

  private static async resolveSelection(
    item: Zotero.Item,
  ): Promise<ResolvedSelection> {
    if (item.isRegularItem()) {
      const resolved = await this.resolveBestSourcePDF(item);
      return { parentItem: item, ...resolved };
    }

    if (
      item.isFileAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      if (!item.parentItemID) {
        throw new Error("暂不支持独立 PDF 条目，请先选中文章主条目");
      }
      const parentItem = Zotero.Items.get(item.parentItemID);
      if (!parentItem) {
        throw new Error("无法找到这篇论文的父条目");
      }

      if (this.isTranslationAttachment(item)) {
        const preferredReference = this.getAttachmentVersion(item);
        const resolved = await this.resolveBestSourcePDF(
          parentItem,
          preferredReference,
        );
        return { parentItem, ...resolved };
      }

      return {
        parentItem,
        sourcePDF: item,
        reference: await this.resolveSourceReference(parentItem, item),
      };
    }

    throw new Error("请选择论文主条目，或选择其下的 PDF 附件");
  }

  private static async resolveBestSourcePDF(
    parentItem: Zotero.Item,
    preferredReference?: VersionedArxivReference | null,
  ): Promise<ResolvedSourcePDF> {
    const sourcePDFs = this.getPDFAttachments(parentItem).filter(
      (attachment) => !this.isTranslationAttachment(attachment),
    );
    if (!sourcePDFs.length) {
      throw new Error("该条目下没有可用于分屏的原始 PDF 附件");
    }

    if (sourcePDFs.length === 1) {
      const sourcePDF = sourcePDFs[0];
      const reference = await this.resolveSourceReference(
        parentItem,
        sourcePDF,
      );
      if (preferredReference && reference.id !== preferredReference.id) {
        throw new Error(
          `没有找到与译文 ${preferredReference.id} 对应的本地原文 PDF`,
        );
      }
      return { sourcePDF, reference };
    }

    const settled = await Promise.all(
      sourcePDFs.map(async (sourcePDF) => {
        try {
          return {
            sourcePDF,
            reference: await this.resolveSourceReference(parentItem, sourcePDF),
          };
        } catch (error) {
          return { sourcePDF, error };
        }
      }),
    );
    const failed = settled.filter(
      (result): result is { sourcePDF: Zotero.Item; error: unknown } =>
        "error" in result,
    );
    const resolved = settled.filter(
      (result): result is ResolvedSourcePDF => "reference" in result,
    );
    if (preferredReference) {
      const exact = resolved.find(
        (candidate) => candidate.reference.id === preferredReference.id,
      );
      if (exact) return exact;
      if (!failed.length) {
        throw new Error(
          `没有找到与译文 ${preferredReference.id} 对应的本地原文 PDF`,
        );
      }
    }

    if (failed.length) {
      const titles = failed
        .map((result) => result.sourcePDF.getDisplayTitle())
        .join("、");
      throw new Error(
        `多个原文 PDF 中有附件无法确认版本（${titles}），请直接选中要翻译的 PDF 附件`,
      );
    }

    const baseIds = [
      ...new Set(resolved.map((candidate) => candidate.reference.baseId)),
    ];
    if (baseIds.length > 1) {
      throw new Error(
        `条目下的原文 PDF 属于多个 arXiv 编号（${baseIds.join(", ")}），请直接选中要翻译的附件`,
      );
    }

    const highest = selectHighestArxivVersion(resolved, baseIds[0]);
    if (!highest) {
      throw new Error("无法选择要翻译的本地原文 PDF");
    }
    return highest;
  }

  private static getPDFAttachments(parentItem: Zotero.Item) {
    return parentItem
      .getAttachments()
      .map((attachmentID) => Zotero.Items.get(attachmentID))
      .filter(
        (attachment): attachment is Zotero.Item =>
          !!attachment &&
          attachment.isFileAttachment() &&
          attachment.attachmentContentType === "application/pdf",
      );
  }

  private static getFieldText(item: Zotero.Item, field: string) {
    try {
      return String(item.getField(field) || "").trim();
    } catch {
      return "";
    }
  }

  private static getParentMetadataTexts(parentItem: Zotero.Item) {
    return [
      this.getFieldText(parentItem, "DOI"),
      this.getFieldText(parentItem, "url"),
      this.getFieldText(parentItem, "extra"),
    ].filter(Boolean);
  }

  private static getAttachmentMetadataTexts(attachment: Zotero.Item) {
    return [
      this.getFieldText(attachment, "title"),
      this.getFieldText(attachment, "url"),
      String((attachment as any).attachmentFilename || ""),
      String((attachment as any).attachmentPath || ""),
    ].filter(Boolean);
  }

  private static getAttachmentVersion(attachment: Zotero.Item) {
    const references = this.getAttachmentMetadataTexts(attachment).flatMap(
      (text) => extractArxivReferences(text),
    );
    const versioned = references.filter(
      (reference): reference is VersionedArxivReference =>
        reference.version !== null,
    );
    const ids = [...new Set(versioned.map((reference) => reference.id))];
    if (ids.length > 1) {
      throw new Error(
        `译文附件中检测到多个 arXiv 版本（${ids.join(", ")}），无法确定对应原文`,
      );
    }
    return versioned[0] || null;
  }

  private static async extractFirstPageText(sourcePDF: Zotero.Item) {
    const pdfWorker = (Zotero as any).PDFWorker;
    if (!pdfWorker || typeof pdfWorker.getFullText !== "function") {
      ztoolkit.log("Zotero.PDFWorker.getFullText is unavailable");
      return "";
    }

    try {
      const result = await pdfWorker.getFullText(sourcePDF.id, 1, true);
      return String(result?.text || "");
    } catch (error) {
      ztoolkit.log(
        `Failed to extract the first page of PDF ${sourcePDF.id}`,
        error,
      );
      return "";
    }
  }

  private static async resolveSourceReference(
    parentItem: Zotero.Item,
    sourcePDF: Zotero.Item,
  ) {
    try {
      return resolveArxivReference({
        pdfText: await this.extractFirstPageText(sourcePDF),
        attachmentTexts: this.getAttachmentMetadataTexts(sourcePDF),
        parentTexts: this.getParentMetadataTexts(parentItem),
      });
    } catch (error) {
      if (
        error instanceof ArxivResolutionError &&
        error.code === "version-missing"
      ) {
        throw new Error(
          `${error.message}。请直接选中带版本信息的 PDF，或在附件名、附件 URL、条目 DOI/URL/Extra 中补充类似 arXiv:2401.12345v2 的完整编号`,
        );
      }
      throw error;
    }
  }

  private static isTranslationAttachment(attachment: Zotero.Item) {
    const title = String(attachment.getField("title") || "").toLowerCase();
    const filename = String(
      (attachment as any).attachmentFilename || "",
    ).toLowerCase();
    return (
      title.includes("幻觉翻译") ||
      title.includes("hjfy") ||
      filename.includes("_hjfy_") ||
      filename.includes("-hjfy-")
    );
  }

  private static findExistingTranslation(
    parentItem: Zotero.Item,
    reference: VersionedArxivReference,
  ) {
    return this.getPDFAttachments(parentItem).find((attachment) => {
      if (!this.isTranslationAttachment(attachment)) return false;
      return hasExactArxivReference(
        this.getAttachmentMetadataTexts(attachment),
        reference,
      );
    });
  }

  private static async fetchAndAttachTranslation(
    parentItem: Zotero.Item,
    reference: VersionedArxivReference,
  ) {
    // HJFY's versioned file endpoint can already contain a completed
    // translation even when its arxivInfo endpoint rejects versioned IDs.
    // Check the exact requested version before doing the metadata/source gate.
    const existing = await this.tryFetchArxivFileInfo(reference);
    if (hasHjfyChinesePdf(existing)) {
      return this.savePdfAsAttachment(
        parentItem,
        await this.downloadBinary(existing.zhCN),
        reference,
      );
    }

    const arxivInfo = await this.waitForArxivInfo(reference);
    if (!arxivInfo.hasSrc) {
      throw new Error(
        `arXiv ${reference.id} 没有可用的 LaTeX 源码，hjfy.top 不能直接生成翻译 PDF`,
      );
    }

    await this.primeArxivTask(reference);
    const fileInfo = await this.waitForTranslation(reference);
    const pdfBuffer = await this.downloadBinary(fileInfo.zhCN);
    return this.savePdfAsAttachment(parentItem, pdfBuffer, reference);
  }

  private static getRequestHeaders(): HeadersInit {
    return {
      "User-Agent":
        "zotero-hjfy-split-reader (Zotero Plugin; +https://github.com/Infinity4B/zotero-hjfy-split-reader)",
    };
  }

  private static async fetchArxivInfo(
    reference: VersionedArxivReference,
  ): Promise<HJFYArxivInfo | "pending"> {
    const response = await fetch(buildHjfyURL("arxivInfo", reference), {
      headers: this.getRequestHeaders(),
    });
    if (!response.ok) {
      throw new Error(
        `无法读取 hjfy.top 的 arXiv 信息: HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as unknown as {
      status: number;
      data?: HJFYArxivInfo;
      msg?: string;
    };
    if (payload.status !== 0 || !payload.data) {
      if (isHjfyPendingMessage(payload.msg)) {
        return "pending";
      }
      throw new Error(payload.msg || "hjfy.top 返回了无效的 arXiv 信息");
    }

    return payload.data;
  }

  private static async fetchArxivStatus(
    reference: VersionedArxivReference,
  ): Promise<HJFYArxivStatus | "login-required" | "pending"> {
    const response = await fetch(buildHjfyURL("arxivStatus", reference), {
      headers: this.getRequestHeaders(),
    });
    if (!response.ok) {
      throw new Error(`无法查询翻译状态: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown as {
      status: number;
      data?: HJFYArxivStatus;
      msg?: string;
    };
    if (payload.status === 101) {
      return "login-required";
    }
    if (payload.status !== 0 || !payload.data) {
      if (isHjfyPendingMessage(payload.msg)) {
        return "pending";
      }
      throw new Error(payload.msg || "hjfy.top 返回了无效的状态数据");
    }

    return payload.data;
  }

  private static async fetchArxivFileInfo(
    reference: VersionedArxivReference,
  ): Promise<HJFYFileInfo> {
    const response = await fetch(buildHjfyURL("arxivFiles", reference), {
      headers: this.getRequestHeaders(),
    });
    if (!response.ok) {
      throw new Error(`无法读取翻译文件信息: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown as {
      status: number;
      data?: HJFYFileInfo;
      msg?: string;
    };
    if (payload.status !== 0 || !payload.data) {
      throw new Error(payload.msg || "hjfy.top 返回了无效的文件信息");
    }

    return payload.data;
  }

  private static async tryFetchArxivFileInfo(
    reference: VersionedArxivReference,
  ) {
    try {
      return await this.fetchArxivFileInfo(reference);
    } catch {
      return null;
    }
  }

  private static async waitForArxivInfo(reference: VersionedArxivReference) {
    for (let attempt = 0; attempt < 36; attempt++) {
      const arxivInfo = await this.fetchArxivInfo(reference);
      if (arxivInfo !== "pending") {
        return arxivInfo;
      }
      await Zotero.Promise.delay(10000);
    }

    throw new Error(
      `等待 hjfy.top 下载 arXiv ${reference.id} 的论文源码超时，请稍后重试`,
    );
  }

  private static async primeArxivTask(reference: VersionedArxivReference) {
    try {
      const response = await fetch(buildHjfyURL("arxiv", reference), {
        headers: this.getRequestHeaders(),
      });
      const text = await response.text();
      if (text.includes("需要先登录")) {
        throw new HJFYLoginRequiredError(reference);
      }
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        throw error;
      }
      ztoolkit.log("primeArxivTask failed", error);
    }
  }

  private static async waitForTranslation(reference: VersionedArxivReference) {
    let retriggeredAfterFinished = false;
    for (let attempt = 0; attempt < 36; attempt++) {
      const fileInfo = await this.tryFetchArxivFileInfo(reference);
      if (hasHjfyChinesePdf(fileInfo)) {
        return fileInfo;
      }

      const status = await this.fetchArxivStatus(reference);
      if (status === "login-required") {
        throw new HJFYLoginRequiredError(reference);
      }
      if (status === "pending") {
        await Zotero.Promise.delay(10000);
        continue;
      }

      if (classifyHjfyTaskState(status.status, fileInfo) === "failed") {
        throw new Error(
          status.info ||
            (status.status === "fault"
              ? "hjfy.top 返回了故障状态"
              : "幻觉翻译任务失败"),
        );
      }

      if (status.status === "finished" && !retriggeredAfterFinished) {
        retriggeredAfterFinished = true;
        await this.primeArxivTask(reference);
      }

      await Zotero.Promise.delay(10000);
    }

    throw new Error("等待幻觉翻译生成中文 PDF 超时，请稍后重试");
  }

  private static async downloadBinary(url: string) {
    const response = await fetch(url, {
      headers: this.getRequestHeaders(),
    });
    if (!response.ok) {
      throw new Error(`下载翻译 PDF 失败: HTTP ${response.status}`);
    }

    return response.arrayBuffer();
  }

  private static async savePdfAsAttachment(
    parentItem: Zotero.Item,
    pdfBuffer: ArrayBuffer,
    reference: VersionedArxivReference,
  ) {
    const title = this.makeAttachmentTitle(parentItem.getDisplayTitle());
    const filename = `${title}_hjfy_arxiv_${reference.id}.pdf`;
    const tempDir = Zotero.getTempDirectory();
    tempDir.append("hjfy-split-reader");
    if (!tempDir.exists()) {
      tempDir.create(1, 0o755);
    }

    const tempFile = tempDir.clone();
    tempFile.append(filename);

    try {
      await this.writeFile(tempFile, pdfBuffer);
      const attachment = await Zotero.Attachments.importFromFile({
        file: tempFile,
        parentItemID: parentItem.id,
      });
      attachment.setField(
        "title",
        `幻觉翻译 (${reference.id}) - ${parentItem.getDisplayTitle()}`,
      );
      await attachment.saveTx();
      return attachment;
    } finally {
      try {
        if (tempFile.exists()) {
          tempFile.remove(false);
        }
      } catch (error) {
        ztoolkit.log("Failed to clean temp translation file", error);
      }
    }
  }

  private static makeAttachmentTitle(title: string) {
    return (
      title
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .slice(0, 60) || "paper"
    );
  }

  private static async writeFile(file: any, data: ArrayBuffer) {
    return new Promise<void>((resolve, reject) => {
      const outputStream = (Components.classes as any)[
        "@mozilla.org/network/file-output-stream;1"
      ].createInstance(Components.interfaces.nsIFileOutputStream);
      outputStream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);

      try {
        const binaryStream = (Components.classes as any)[
          "@mozilla.org/binaryoutputstream;1"
        ].createInstance(Components.interfaces.nsIBinaryOutputStream);
        binaryStream.setOutputStream(outputStream);
        const bytes = new Uint8Array(data);
        binaryStream.writeByteArray(bytes, bytes.length);
        binaryStream.close();
        outputStream.close();
        resolve();
      } catch (error) {
        outputStream.close();
        reject(error);
      }
    });
  }

  private static showMessage(
    text: string,
    type: "default" | "warning" | "error" | "success" = "default",
  ) {
    const popup = new ztoolkit.ProgressWindow(getString("hjfy-window-title"));
    popup.createLine({
      text,
      type,
    });
    popup.show();
    popup.startCloseTimer(4000);
  }
}
