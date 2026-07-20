import { getString } from "../utils/locale";
import {
  ArxivResolutionError,
  getUnambiguousVersionedArxivReference,
  hasExactArxivReference,
  hasUnversionedArxivReference,
  isSupplementaryAttachmentMetadata,
  resolveArxivReference,
  selectHighestArxivVersion,
} from "./arxivReference";
import type { VersionedArxivReference } from "./arxivReference";
import { buildHjfyURL, HJFYClient, HJFYClientError } from "./hjfyClient";
import { hasHjfyChinesePdf } from "./hjfyState";
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

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";
  private static readonly hjfyClient = new HJFYClient({
    delayImplementation: (milliseconds) => Zotero.Promise.delay(milliseconds),
  });

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

    let activeReference: VersionedArxivReference | null = null;
    try {
      const { parentItem, sourcePDF, reference } = await this.resolveSelection(
        items[0],
      );
      activeReference = reference;
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
        if (this.findUnversionedTranslation(parentItem, reference)) {
          popup.createLine({
            text: `检测到旧版无版本译文，但无法确认是否对应 ${reference.id}，将获取准确版本`,
            type: "warning",
            progress: 30,
          });
        }
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
      if (error instanceof HJFYClientError && error.code === "login-required") {
        if (activeReference) {
          Zotero.launchURL(buildHjfyURL("arxiv", activeReference));
        }
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
      (attachment) =>
        !this.isTranslationAttachment(attachment) &&
        !this.isSupplementaryAttachment(attachment),
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
            reference: await this.resolveSourceReference(
              parentItem,
              sourcePDF,
              false,
            ),
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
    const blockingFailures = failed;
    const resolved = settled.filter(
      (result): result is ResolvedSourcePDF => "reference" in result,
    );
    if (preferredReference) {
      const exact = resolved.find(
        (candidate) => candidate.reference.id === preferredReference.id,
      );
      if (exact) return exact;
      if (!blockingFailures.length) {
        throw new Error(
          `没有找到与译文 ${preferredReference.id} 对应的本地原文 PDF`,
        );
      }
    }

    if (blockingFailures.length) {
      const titles = blockingFailures
        .map((result) => result.sourcePDF.getDisplayTitle())
        .join("、");
      throw new Error(
        `多个原文 PDF 中有附件无法确认版本（${titles}），请直接选中要翻译的 PDF 附件`,
      );
    }

    if (!resolved.length) {
      throw new Error("该条目下没有可确认 arXiv 版本的原始 PDF 附件");
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
    return getUnambiguousVersionedArxivReference(
      this.getAttachmentMetadataTexts(attachment),
      "译文附件元数据",
    );
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
    allowParentVersionFallback = true,
  ) {
    try {
      return resolveArxivReference({
        pdfText: await this.extractFirstPageText(sourcePDF),
        attachmentTexts: this.getAttachmentMetadataTexts(sourcePDF),
        parentTexts: this.getParentMetadataTexts(parentItem),
        allowParentVersionFallback,
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

  private static isSupplementaryAttachment(attachment: Zotero.Item) {
    return isSupplementaryAttachmentMetadata(
      this.getAttachmentMetadataTexts(attachment),
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

  private static findUnversionedTranslation(
    parentItem: Zotero.Item,
    reference: VersionedArxivReference,
  ) {
    return this.getPDFAttachments(parentItem).find((attachment) => {
      if (!this.isTranslationAttachment(attachment)) return false;
      return hasUnversionedArxivReference(
        this.getAttachmentMetadataTexts(attachment),
        reference.baseId,
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
    const existing = await this.hjfyClient.fetchArxivFileInfo(reference);
    if (hasHjfyChinesePdf(existing)) {
      return this.savePdfAsAttachment(
        parentItem,
        await this.hjfyClient.downloadPdf(existing.zhCN),
        reference,
      );
    }

    const arxivInfo = await this.hjfyClient.waitForArxivInfo(reference);
    if (arxivInfo.exactVersion && !arxivInfo.hasSrc) {
      throw new Error(
        `arXiv ${reference.id} 没有可用的 LaTeX 源码，hjfy.top 不能直接生成翻译 PDF`,
      );
    }
    if (!arxivInfo.exactVersion && !arxivInfo.hasSrc) {
      ztoolkit.log(
        `HJFY only returned base metadata for ${reference.id}; continuing with the exact version task`,
        arxivInfo.returnedId,
      );
    }

    await this.hjfyClient.primeArxivTask(reference);
    const fileInfo = await this.hjfyClient.waitForTranslation(reference);
    const pdfBuffer = await this.hjfyClient.downloadPdf(fileInfo.zhCN);
    return this.savePdfAsAttachment(parentItem, pdfBuffer, reference);
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
