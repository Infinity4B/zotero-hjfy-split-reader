import { getString } from "../utils/locale";
import { SplitViewFactory } from "./splitView";

interface ResolvedSelection {
  parentItem: Zotero.Item;
  sourcePDF: Zotero.Item;
}

interface HJFYArxivInfo {
  hasSrc: boolean;
}

interface HJFYArxivStatus {
  status: "finished" | "failed" | "error" | "fault" | "start";
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
  constructor(public readonly arxivId: string) {
    super("幻觉翻译要求登录后才能为这篇论文创建翻译任务");
  }
}

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";

  static registerItemMenu() {
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: this.menuID,
      label: getString("hjfy-menu-label"),
      icon: `chrome://${addon.data.config.addonRef}/content/icons/svreader.svg`,
      commandListener: () => {
        void this.handleMenuCommand();
      },
    });
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
      const { parentItem, sourcePDF } = this.resolveSelection(items[0]);
      let translatedPDF = this.findExistingTranslation(parentItem, sourcePDF);

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
        translatedPDF = await this.fetchAndAttachTranslation(parentItem);
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
      await SplitViewFactory.openItemsInSplitView(sourcePDF, translatedPDF);
      popup.createLine({
        text: "已在分屏阅读器中打开原文与幻觉翻译",
        type: "success",
        progress: 100,
      });
      popup.startCloseTimer(4000);
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        Zotero.launchURL(`https://hjfy.top/arxiv/${error.arxivId}`);
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

  private static resolveSelection(item: Zotero.Item): ResolvedSelection {
    if (item.isRegularItem()) {
      const sourcePDF = this.findSourcePDF(item);
      if (!sourcePDF) {
        throw new Error("该条目下没有可用于分屏的原始 PDF 附件");
      }
      return { parentItem: item, sourcePDF };
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
        const sourcePDF = this.findSourcePDF(parentItem, item);
        if (!sourcePDF) {
          throw new Error("找到了幻觉翻译附件，但没有找到对应的原始 PDF");
        }
        return { parentItem, sourcePDF };
      }

      return { parentItem, sourcePDF: item };
    }

    throw new Error("请选择论文主条目，或选择其下的 PDF 附件");
  }

  private static findSourcePDF(
    parentItem: Zotero.Item,
    excludedAttachment?: Zotero.Item,
  ) {
    const pdfs = this.getPDFAttachments(parentItem);
    return (
      pdfs.find(
        (attachment) =>
          attachment.id !== excludedAttachment?.id &&
          !this.isTranslationAttachment(attachment),
      ) || pdfs.find((attachment) => attachment.id !== excludedAttachment?.id)
    );
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
    sourcePDF: Zotero.Item,
  ) {
    const arxivId = this.extractArxivId(parentItem);
    const sourceKey = String(sourcePDF.getField("title") || "").trim();
    const candidates = this.getPDFAttachments(parentItem).filter(
      (attachment) => attachment.id !== sourcePDF.id,
    );

    return candidates.find((attachment) => {
      if (!this.isTranslationAttachment(attachment)) return false;
      if (arxivId) {
        const filename = String(
          (attachment as any).attachmentFilename || "",
        ).toLowerCase();
        if (filename.includes(arxivId.toLowerCase())) {
          return true;
        }
      }
      const title = String(attachment.getField("title") || "");
      return sourceKey ? title.includes(sourceKey) : true;
    });
  }

  private static async fetchAndAttachTranslation(parentItem: Zotero.Item) {
    const arxivId = this.extractArxivId(parentItem);
    if (!arxivId) {
      throw new Error(
        "当前仅支持能解析 arXiv ID 的论文条目，本地文档上传流需要在 hjfy.top 登录后使用",
      );
    }

    const arxivInfo = await this.fetchArxivInfo(arxivId);
    if (!arxivInfo.hasSrc) {
      throw new Error(
        "这篇论文没有可用的 LaTeX 源码，hjfy.top 不能直接生成翻译 PDF",
      );
    }

    const existing = await this.tryFetchArxivFileInfo(arxivId);
    if (existing?.zhCN) {
      return this.savePdfAsAttachment(
        parentItem,
        await this.downloadBinary(existing.zhCN),
        arxivId,
      );
    }

    await this.primeArxivTask(arxivId);
    await this.waitForTranslation(arxivId);

    const fileInfo = await this.fetchArxivFileInfo(arxivId);
    if (!fileInfo.zhCN) {
      throw new Error("幻觉翻译任务已完成，但没有拿到可下载的中文 PDF");
    }

    const pdfBuffer = await this.downloadBinary(fileInfo.zhCN);
    return this.savePdfAsAttachment(parentItem, pdfBuffer, arxivId);
  }

  private static extractArxivId(item: Zotero.Item) {
    const rawCandidates = [
      item.getField("DOI") as string,
      item.getField("url") as string,
      item.getField("extra") as string,
    ]
      .filter(Boolean)
      .map((value) => value.trim());

    for (const candidate of rawCandidates) {
      const doiMatch = candidate.match(/10\.48550\/arxiv\.(\d+\.\d+)(v\d+)?/i);
      if (doiMatch) {
        return doiMatch[1];
      }

      const arxivTextMatch = candidate.match(
        /\barxiv[:\s]+(\d+\.\d+)(v\d+)?\b/i,
      );
      if (arxivTextMatch) {
        return arxivTextMatch[1];
      }

      const urlMatch = candidate.match(
        /arxiv\.org\/(?:abs|pdf)\/(\d+\.\d+)(v\d+)?(?:\.pdf)?/i,
      );
      if (urlMatch) {
        return urlMatch[1];
      }
    }

    return null;
  }

  private static getRequestHeaders(): HeadersInit {
    return {
      "User-Agent":
        "zotero-hjfy-split-reader (Zotero Plugin; +https://github.com/Infinity4B/zotero-hjfy-split-reader)",
    };
  }

  private static async fetchArxivInfo(arxivId: string): Promise<HJFYArxivInfo> {
    const response = await fetch(`https://hjfy.top/api/arxivInfo/${arxivId}`, {
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
      throw new Error(payload.msg || "hjfy.top 返回了无效的 arXiv 信息");
    }

    return payload.data;
  }

  private static async fetchArxivStatus(
    arxivId: string,
  ): Promise<HJFYArxivStatus | "login-required"> {
    const response = await fetch(
      `https://hjfy.top/api/arxivStatus/${arxivId}`,
      {
        headers: this.getRequestHeaders(),
      },
    );
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
      throw new Error(payload.msg || "hjfy.top 返回了无效的状态数据");
    }

    return payload.data;
  }

  private static async fetchArxivFileInfo(
    arxivId: string,
  ): Promise<HJFYFileInfo> {
    const response = await fetch(`https://hjfy.top/api/arxivFiles/${arxivId}`, {
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

  private static async tryFetchArxivFileInfo(arxivId: string) {
    try {
      return await this.fetchArxivFileInfo(arxivId);
    } catch {
      return null;
    }
  }

  private static async primeArxivTask(arxivId: string) {
    try {
      const response = await fetch(`https://hjfy.top/arxiv/${arxivId}`, {
        headers: this.getRequestHeaders(),
      });
      const text = await response.text();
      if (text.includes("需要先登录")) {
        throw new HJFYLoginRequiredError(arxivId);
      }
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        throw error;
      }
      ztoolkit.log("primeArxivTask failed", error);
    }
  }

  private static async waitForTranslation(arxivId: string) {
    for (let attempt = 0; attempt < 36; attempt++) {
      const status = await this.fetchArxivStatus(arxivId);
      if (status === "login-required") {
        throw new HJFYLoginRequiredError(arxivId);
      }

      if (status.status === "finished") {
        return;
      }
      if (status.status === "failed" || status.status === "error") {
        throw new Error(status.info || "幻觉翻译任务失败");
      }
      if (status.status === "fault") {
        throw new Error(status.info || "hjfy.top 返回了故障状态");
      }

      await Zotero.Promise.delay(10000);
    }

    throw new Error("等待幻觉翻译完成超时，请稍后重试");
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
    arxivId: string,
  ) {
    const title = this.makeAttachmentTitle(parentItem.getDisplayTitle());
    const filename = `${title}_hjfy_arxiv_${arxivId}.pdf`;
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
        `幻觉翻译 - ${parentItem.getDisplayTitle()}`,
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
