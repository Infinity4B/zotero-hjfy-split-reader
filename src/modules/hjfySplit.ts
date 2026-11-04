import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
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
import {
  buildHjfyLoginURL,
  buildHjfyURL,
  HJFYClient,
  HJFYClientError,
} from "./hjfyClient";
import type { HJFYFileInfo } from "./hjfyClient";
import {
  getValidUnlockQuote,
  hasHjfyChinesePdf,
  isHjfyPreviewFile,
} from "./hjfyState";
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

interface ExistingTranslations {
  full?: Zotero.Item;
  previews: Zotero.Item[];
  // A full translation saved before attachments recorded the arXiv version.
  unversioned?: Zotero.Item;
}

interface AttachedTranslation {
  attachment: Zotero.Item;
  kind: "full" | "preview" | "unversioned";
}

type ProgressPopup = InstanceType<typeof ztoolkit.ProgressWindow>;

const defaultPreviewPageLimit = 5;

type UnlockOutcome =
  | { action: "unlocked"; fileInfo: HJFYFileInfo & { zhCN: string } }
  | { action: "preview" }
  | { action: "abort"; message: string };

class HJFYUserAbort extends Error {}

interface UnlockRecord {
  at: number;
  status: "done" | "unknown";
}

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";
  private static readonly hjfyClient = new HJFYClient({
    delayImplementation: (milliseconds) => Zotero.Promise.delay(milliseconds),
  });
  // Versions being processed, so a repeated click cannot start a second unlock.
  private static readonly inFlight = new Set<string>();

  static registerItemMenu(win: Window) {
    const doc = win.document;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) return;
    // Also drops a stale item left by a copy of the plugin removed in this session.
    this.unregisterItemMenu(win);

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

  static unregisterItemMenu(win: Window) {
    win.document.getElementById(this.menuID)?.remove();
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
    this.addLine(popup, `正在处理: ${items[0].getDisplayTitle()}`);
    popup.show();

    let activeReference: VersionedArxivReference | null = null;
    let claimedId: string | null = null;
    try {
      const { parentItem, sourcePDF, reference } = await this.resolveSelection(
        items[0],
      );
      activeReference = reference;
      if (this.inFlight.has(reference.id)) {
        throw new HJFYUserAbort(
          `arXiv ${reference.id} 正在处理中，请等待当前操作完成`,
        );
      }
      this.inFlight.add(reference.id);
      claimedId = reference.id;
      this.addLine(popup, `本地论文版本: arXiv ${reference.id}`, "success");
      const existing = await this.findExistingTranslations(
        parentItem,
        sourcePDF,
        reference,
      );
      let translatedPDF: Zotero.Item;

      if (existing.full) {
        translatedPDF = existing.full;
        this.addLine(popup, "使用已保存的幻觉翻译附件", "success");
      } else {
        this.addLine(
          popup,
          existing.unversioned
            ? `已有旧版译文但未标注版本，先向 hjfy.top 查询 ${reference.id} 的译文`
            : existing.previews.length
              ? "已保存的译文只是预览版，正在向 hjfy.top 查询全文"
              : "正在向 hjfy.top 查询译文",
        );
        const attached = await this.fetchAndAttachTranslation(
          parentItem,
          reference,
          existing,
          popup,
        );
        translatedPDF = attached.attachment;
        if (attached.kind === "unversioned") {
          this.addLine(
            popup,
            "幻觉翻译目前只提供预览，改用已保存的旧版译文（版本未标注）",
            "info",
          );
        } else if (attached.kind === "preview") {
          this.addLine(popup, "目前只能获取前几页的预览版译文", "warning");
        } else {
          this.addLine(popup, "已下载并保存幻觉翻译附件", "success");
          await this.trashPreviewTranslations(existing.previews, popup);
        }
      }

      await SplitViewFactory.openItemsInSplitView(sourcePDF, translatedPDF, {
        primarySide: "right",
        activeSide: "right",
      });
      this.addLine(popup, "已分屏打开原文与译文", "success");
      popup.startCloseTimer(4000);
    } catch (error) {
      if (error instanceof HJFYUserAbort) {
        this.addLine(popup, error.message, "info");
        popup.startCloseTimer(3000);
        return;
      }
      if (
        error instanceof HJFYClientError &&
        error.code === "login-required" &&
        activeReference
      ) {
        this.addLine(popup, error.message, "warning");
        const reason = error.translationMissing
          ? `幻觉翻译上还没有 arXiv ${activeReference.id} 的译文，因此暂无预览可看。\n\n` +
            "幻觉翻译要求登录后才能提交翻译任务。登录后重新执行此操作，插件会先询问是否提交。"
          : `${error.message}。`;
        if (this.confirm(`${reason}\n\n是否在 Zotero 中打开登录页？`, "登录")) {
          this.openHjfyLogin(activeReference);
          this.addLine(
            popup,
            "已在 Zotero 中打开幻觉翻译登录页，登录后请重新执行此操作",
            "info",
          );
        }
        popup.startCloseTimer(5000);
        return;
      }
      const message =
        error instanceof Error ? error.message : "未知错误，未能获取幻觉翻译";
      this.addLine(popup, `失败: ${message}`, "error");
      popup.startCloseTimer(7000);
    } finally {
      if (claimedId) this.inFlight.delete(claimedId);
    }
  }

  private static addLine(
    popup: ProgressPopup,
    text: string,
    type: "default" | "success" | "warning" | "error" | "info" = "default",
  ) {
    // Zotero fades lines and draws a progress arc until a line reaches 100%.
    popup.createLine({ text, type, progress: 100 });
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

  private static isPreviewTranslationAttachment(attachment: Zotero.Item) {
    const title = String(attachment.getField("title") || "");
    const filename = String(
      (attachment as any).attachmentFilename || "",
    ).toLowerCase();
    return (
      title.includes("幻觉翻译预览") || filename.includes("_hjfy_preview_")
    );
  }

  private static isSupplementaryAttachment(attachment: Zotero.Item) {
    return isSupplementaryAttachmentMetadata(
      this.getAttachmentMetadataTexts(attachment),
    );
  }

  private static async getPdfPageCount(pdf: Zotero.Item) {
    const pdfWorker = (Zotero as any).PDFWorker;
    if (!pdfWorker || typeof pdfWorker.getFullText !== "function") return null;

    try {
      const result = await pdfWorker.getFullText(pdf.id, 1, true);
      const totalPages = Number(result?.totalPages);
      return Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null;
    } catch (error) {
      ztoolkit.log(`Failed to count pages of PDF ${pdf.id}`, error);
      return null;
    }
  }

  private static async findExistingTranslations(
    parentItem: Zotero.Item,
    sourcePDF: Zotero.Item,
    reference: VersionedArxivReference,
  ): Promise<ExistingTranslations> {
    const candidates = this.getPDFAttachments(parentItem).filter(
      (attachment) =>
        this.isTranslationAttachment(attachment) &&
        hasExactArxivReference(
          this.getAttachmentMetadataTexts(attachment),
          reference,
        ),
    );
    const result: ExistingTranslations = { previews: [] };
    let sourcePageCount: number | null | undefined;
    // Earlier releases saved HJFY previews as ordinary translations.
    const isShortTranslation = async (attachment: Zotero.Item) => {
      sourcePageCount ??= await this.getPdfPageCount(sourcePDF);
      if (!sourcePageCount || sourcePageCount <= defaultPreviewPageLimit) {
        return false;
      }
      const pageCount = await this.getPdfPageCount(attachment);
      return !!pageCount && pageCount <= defaultPreviewPageLimit;
    };

    for (const attachment of candidates) {
      if (
        this.isPreviewTranslationAttachment(attachment) ||
        (await isShortTranslation(attachment))
      ) {
        result.previews.push(attachment);
        continue;
      }
      result.full ??= attachment;
    }
    if (result.full) return result;

    for (const attachment of this.getPDFAttachments(parentItem)) {
      if (
        this.isTranslationAttachment(attachment) &&
        !this.isPreviewTranslationAttachment(attachment) &&
        hasUnversionedArxivReference(
          this.getAttachmentMetadataTexts(attachment),
          reference.baseId,
        ) &&
        !(await isShortTranslation(attachment))
      ) {
        result.unversioned = attachment;
        break;
      }
    }
    return result;
  }

  private static async fetchAndAttachTranslation(
    parentItem: Zotero.Item,
    reference: VersionedArxivReference,
    existing: ExistingTranslations,
    popup: ProgressPopup,
  ): Promise<AttachedTranslation> {
    // Check for a completed translation before creating or resuming a task.
    let fileInfo: (HJFYFileInfo & { zhCN: string }) | null = null;
    let declinedChoice = "cancel" as "cancel" | "unversioned";
    try {
      const current = await this.hjfyClient.fetchArxivFileInfo(reference);
      if (hasHjfyChinesePdf(current)) {
        fileInfo = current;
      } else {
        await this.hjfyClient.primeArxivTask(reference);
        fileInfo = await this.hjfyClient.waitForTranslation(reference, {
          confirmTranslationRequest: async () => {
            const choice = await this.confirmTranslationRequest(
              reference,
              !!existing.unversioned,
            );
            if (choice !== "submit") declinedChoice = choice;
            return choice === "submit";
          },
        });
      }
    } catch (error) {
      if (
        error instanceof HJFYClientError &&
        error.code === "translation-declined"
      ) {
        if (declinedChoice === "unversioned" && existing.unversioned) {
          return { attachment: existing.unversioned, kind: "unversioned" };
        }
        throw new HJFYUserAbort("已取消，未提交翻译任务");
      }
      if (
        existing.unversioned &&
        error instanceof HJFYClientError &&
        error.code === "login-required"
      ) {
        return { attachment: existing.unversioned, kind: "unversioned" };
      }
      throw error;
    }

    if (isHjfyPreviewFile(fileInfo)) {
      // A full translation of an unconfirmed version beats a few preview pages.
      if (existing.unversioned) {
        return { attachment: existing.unversioned, kind: "unversioned" };
      }
      const outcome = await this.chooseFullOrPreview(
        reference,
        fileInfo,
        popup,
        !existing.previews.length,
      );
      if (outcome.action === "abort") {
        throw new HJFYUserAbort(outcome.message);
      }
      if (outcome.action === "preview") {
        if (existing.previews.length) {
          return { attachment: existing.previews[0], kind: "preview" };
        }
        const previewBuffer = await this.hjfyClient.downloadPdf(fileInfo.zhCN);
        return {
          attachment: await this.savePdfAsAttachment(
            parentItem,
            previewBuffer,
            reference,
            true,
          ),
          kind: "preview",
        };
      }
      fileInfo = outcome.fileInfo;
    }

    const pdfBuffer = await this.hjfyClient.downloadPdf(fileInfo.zhCN);
    const attachment = await this.savePdfAsAttachment(
      parentItem,
      pdfBuffer,
      reference,
      false,
    );
    this.clearUnlockRecord(reference.id);
    return { attachment, kind: "full" };
  }

  private static async confirmTranslationRequest(
    reference: VersionedArxivReference,
    hasUnversioned: boolean,
  ): Promise<"submit" | "cancel" | "unversioned"> {
    try {
      await this.hjfyClient.fetchTranslationBalance();
    } catch (error) {
      if (error instanceof HJFYClientError && error.code === "login-required") {
        throw new HJFYClientError(
          "login-required",
          "幻觉翻译要求登录后才能提交翻译任务",
          { translationMissing: true },
        );
      }
      // Login state is unknown; HJFY still refuses the submission without one.
    }

    let text =
      `幻觉翻译上还没有 arXiv ${reference.id} 的译文。是否使用你的幻觉翻译账号提交翻译任务？\n\n` +
      "幻觉翻译网页界面上提示：提交翻译任务「不预占、不扣费」，解锁全文时才扣费。" +
      "这只是网页上的提示文字，不是正式的收费规则，插件无法保证它今后不会变动。\n\n" +
      "翻译完成后，插件会再询问是查看预览版还是解锁全文。";
    if (hasUnversioned) {
      text += "\n\n库里已有一份旧版译文（版本未标注），也可以直接打开它。";
      const index = this.promptButtons(text, "打开旧版译文", "提交翻译任务");
      if (index === 0) return "unversioned";
      return index === 2 ? "submit" : "cancel";
    }
    return this.promptButtons(text, "提交翻译任务", undefined, 1) === 0
      ? "submit"
      : "cancel";
  }

  private static async chooseFullOrPreview(
    reference: VersionedArxivReference,
    fileInfo: HJFYFileInfo,
    popup: ProgressPopup,
    askBeforePreview: boolean,
  ): Promise<UnlockOutcome> {
    const previewPages = fileInfo.previewPageLimit || defaultPreviewPageLimit;

    // HJFY already counts this version as unlocked; never offer to pay again.
    if (fileInfo.unlocked === true) {
      this.addLine(popup, "该版本已解锁，正在等待全文译文生成");
      return this.waitForUnlockedTranslation(reference, popup);
    }

    const quote = getValidUnlockQuote(fileInfo, reference.id);
    if (!quote) {
      this.addLine(
        popup,
        "幻觉翻译没有给出这一版本的有效全文报价，暂时无法解锁全文",
        "warning",
      );
      return { action: "preview" };
    }

    let balance: number;
    try {
      balance = await this.hjfyClient.fetchTranslationBalance();
    } catch (error) {
      if (error instanceof HJFYClientError && error.code === "login-required") {
        if (!askBeforePreview) {
          this.addLine(
            popup,
            "未登录幻觉翻译，打开已保存的预览版；如需解锁全文，请在插件设置中登录",
            "info",
          );
          return { action: "preview" };
        }
        const choice = this.choosePreviewOr(
          `幻觉翻译未登录时只能获取前 ${previewPages} 页预览。\n\n` +
            `登录后可使用账号额度解锁全文（幻觉翻译报价 ${quote.pages} 页）。` +
            "也可以随时在插件设置中登录。",
          "登录",
        );
        if (choice === "action") {
          this.openHjfyLogin(reference);
          return {
            action: "abort",
            message: "已在 Zotero 中打开幻觉翻译登录页，登录后请重新执行此操作",
          };
        }
        return choice === "preview" ? { action: "preview" } : this.cancelled();
      }
      this.addLine(
        popup,
        `无法查询账号额度，暂不解锁: ${error instanceof Error ? error.message : "未知错误"}`,
        "warning",
      );
      return { action: "preview" };
    }

    const priorUnlock = this.getUnlockRecord(reference.id);
    if (priorUnlock) {
      const outcome =
        priorUnlock.status === "done" ? "幻觉翻译已确认成功" : "结果未确认";
      const choice = this.choosePreviewOr(
        `插件曾在 ${new Date(priorUnlock.at).toLocaleString()} 为 arXiv ${reference.id} 提交过解锁请求（${outcome}），但幻觉翻译现在仍只提供预览。\n\n` +
          "为避免重复扣除额度，插件不会再次解锁这一版本。请在幻觉翻译网站上核对余额和解锁状态，必要时在网站上操作。",
        "在网站中查看",
      );
      if (choice === "action") {
        Zotero.openInViewer(buildHjfyURL("arxiv", reference));
        return {
          action: "abort",
          message: "已在 Zotero 中打开幻觉翻译论文页面",
        };
      }
      return choice === "preview" ? { action: "preview" } : this.cancelled();
    }

    if (balance < quote.pages) {
      const viewPreview =
        this.promptButtons(
          `解锁 arXiv ${reference.id} 全文需要 ${quote.pages} 页额度，当前余额 ${balance} 页，额度不足。\n\n` +
            `可以先查看前 ${previewPages} 页预览；如需全文，请到幻觉翻译网站充值后重新执行此操作。`,
          "查看预览版",
        ) === 0;
      return viewPreview ? { action: "preview" } : this.cancelled();
    }

    const choice = this.choosePreviewOr(
      `当前只能获取前 ${previewPages} 页预览。\n\n` +
        `解锁 arXiv ${reference.id} 全文：幻觉翻译报价 ${quote.pages} 页，将从账号扣除 ${quote.pages} 页额度` +
        `（当前余额 ${balance} 页，解锁后剩余 ${balance - quote.pages} 页）。\n\n` +
        "只有点击「解锁全文」才会扣除额度。",
      "解锁全文",
    );
    if (choice !== "action") {
      return choice === "preview" ? { action: "preview" } : this.cancelled();
    }

    this.addLine(popup, `正在使用 ${quote.pages} 页额度解锁全文`);
    try {
      await this.hjfyClient.unlockArxiv(reference, quote.id);
    } catch (error) {
      if (
        error instanceof HJFYClientError &&
        error.code === "unlock-outcome-unknown"
      ) {
        this.setUnlockRecord(reference.id, "unknown");
        this.addLine(
          popup,
          `${error.message}。插件不会自动重试，请到幻觉翻译网站核对余额和解锁状态`,
          "error",
        );
        return { action: "preview" };
      }
      this.addLine(
        popup,
        `解锁未完成，幻觉翻译拒绝了请求: ${error instanceof Error ? error.message : "未知错误"}`,
        "warning",
      );
      return { action: "preview" };
    }

    this.setUnlockRecord(reference.id, "done");
    this.addLine(popup, `已解锁 arXiv ${reference.id} 全文`, "success");
    return this.waitForUnlockedTranslation(reference, popup);
  }

  private static async waitForUnlockedTranslation(
    reference: VersionedArxivReference,
    popup: ProgressPopup,
  ): Promise<UnlockOutcome> {
    try {
      return {
        action: "unlocked",
        fileInfo: await this.hjfyClient.waitForFullTranslation(reference),
      };
    } catch (error) {
      if (
        error instanceof HJFYClientError &&
        error.code === "version-mismatch"
      ) {
        throw error;
      }
      this.addLine(
        popup,
        `全文译文暂未就绪，先打开预览；稍后重新执行即可获取全文，插件不会再次发起解锁: ${error instanceof Error ? error.message : "未知错误"}`,
        "warning",
      );
      return { action: "preview" };
    }
  }

  private static readUnlockLog(): Record<string, UnlockRecord> {
    try {
      const parsed = JSON.parse(String(getPref("hjfyUnlockLog") || "{}"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private static getUnlockRecord(referenceId: string): UnlockRecord | null {
    const record = this.readUnlockLog()[referenceId.toLowerCase()];
    return record && typeof record.at === "number" ? record : null;
  }

  private static setUnlockRecord(
    referenceId: string,
    status: UnlockRecord["status"],
  ) {
    const log = this.readUnlockLog();
    log[referenceId.toLowerCase()] = { at: Date.now(), status };
    setPref("hjfyUnlockLog", JSON.stringify(log));
  }

  private static clearUnlockRecord(referenceId: string) {
    const log = this.readUnlockLog();
    if (!(referenceId.toLowerCase() in log)) return;
    delete log[referenceId.toLowerCase()];
    setPref("hjfyUnlockLog", JSON.stringify(log));
  }

  private static cancelled(): UnlockOutcome {
    return { action: "abort", message: "已取消" };
  }

  private static openHjfyLogin(reference: VersionedArxivReference) {
    // The viewer shares Zotero's cookie jar, so the plugin's requests reuse this login.
    Zotero.openInViewer(buildHjfyLoginURL(reference));
  }

  private static confirm(text: string, acceptLabel: string) {
    return this.promptButtons(text, acceptLabel) === 0;
  }

  private static choosePreviewOr(text: string, actionLabel: string) {
    const index = this.promptButtons(text, "查看预览版", actionLabel);
    if (index === 0) return "preview" as const;
    if (index === 2) return "action" as const;
    return "cancel" as const;
  }

  // Button 1 is always 取消, which closing the dialog or Escape also answers.
  private static promptButtons(
    text: string,
    firstLabel: string,
    extraLabel?: string,
    defaultButton: 0 | 1 = 0,
  ) {
    // nsIPromptService: BUTTON_POS_n * BUTTON_TITLE_IS_STRING; BUTTON_POS_1_DEFAULT = 1 << 24.
    const titleIsString = 127;
    const flags =
      titleIsString +
      256 * titleIsString +
      (extraLabel ? 65536 * titleIsString : 0) +
      (defaultButton === 1 ? 1 << 24 : 0);
    return Services.prompt.confirmEx(
      Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
      getString("hjfy-window-title"),
      text,
      flags,
      firstLabel,
      "取消",
      extraLabel || "",
      "",
      { value: false },
    );
  }

  private static async trashPreviewTranslations(
    previews: Zotero.Item[],
    popup: ProgressPopup,
  ) {
    if (!previews.length) return;

    try {
      for (const preview of previews) {
        preview.deleted = true;
        await preview.saveTx();
      }
      this.addLine(popup, "已将旧的预览版译文移到回收站", "default");
    } catch (error) {
      ztoolkit.log("Failed to trash preview translations", error);
    }
  }

  private static async savePdfAsAttachment(
    parentItem: Zotero.Item,
    pdfBuffer: ArrayBuffer,
    reference: VersionedArxivReference,
    isPreview: boolean,
  ) {
    const title = this.makeAttachmentTitle(parentItem.getDisplayTitle());
    const filename = isPreview
      ? `${title}_hjfy_preview_arxiv_${reference.id}.pdf`
      : `${title}_hjfy_arxiv_${reference.id}.pdf`;
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
        `${isPreview ? "幻觉翻译预览" : "幻觉翻译"} (${reference.id}) - ${parentItem.getDisplayTitle()}`,
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
    this.addLine(popup, text, type);
    popup.show();
    popup.startCloseTimer(4000);
  }
}
