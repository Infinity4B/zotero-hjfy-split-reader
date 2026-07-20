import type { VersionedArxivReference } from "./arxivReference";
import {
  classifyHjfyTaskState,
  hasHjfyChinesePdf,
  isHjfyNotReadyMessage,
  isHjfyPendingMessage,
} from "./hjfyState";

export interface HJFYArxivInfo {
  hasSrc: boolean;
  exactVersion: boolean;
  returnedId: string | null;
}

export interface HJFYArxivStatus {
  status: string;
  info?: string;
}

export interface HJFYFileInfo {
  id: string;
  title: string;
  origin: string;
  zhCN?: string | null;
  zhCNTar?: string | null;
  isDeepSeek: boolean;
}

export type HJFYClientErrorCode =
  | "not-ready"
  | "login-required"
  | "retryable-error"
  | "permanent-error"
  | "version-mismatch";

export class HJFYClientError extends Error {
  public readonly code: HJFYClientErrorCode;
  public readonly httpStatus?: number;

  constructor(
    code: HJFYClientErrorCode,
    message: string,
    options: { httpStatus?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.name = "HJFYClientError";
  }
}

export type HJFYRoute = "arxivInfo" | "arxivStatus" | "arxivFiles" | "arxiv";

interface HJFYApiPayload<T> {
  status: number;
  data?: T;
  msg?: string;
}

interface HJFYRawArxivInfo {
  hasSrc: boolean;
  meta?: string;
}

export interface HJFYClientOptions {
  fetchImplementation?: typeof fetch;
  delayImplementation?: (milliseconds: number) => Promise<void>;
  retryDelaysMs?: number[];
  pollDelayMs?: number;
  maxPollAttempts?: number;
}

interface RequestOptions {
  notFoundIsNotReady?: boolean;
  acceptedErrorStatuses?: number[];
}

const defaultRetryDelaysMs = [500, 1500];

export function buildHjfyURL(
  route: HJFYRoute,
  reference: VersionedArxivReference,
  identifier = reference.id,
) {
  const prefix = route === "arxiv" ? "" : "api/";
  return `https://hjfy.top/${prefix}${route}/${encodeURIComponent(identifier)}`;
}

function normalizeArxivId(identifier: string) {
  return identifier.trim().toLowerCase();
}

function extractAtomEntryId(metadata?: string) {
  if (!metadata) return null;

  const match = metadata.match(
    /<entry>[\s\S]*?<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/i,
  );
  return match?.[1]?.trim() || null;
}

function isVersionedInfoCompatibilityError(payload: HJFYApiPayload<unknown>) {
  return (
    payload.status === 400 &&
    /^(?:arxivInfo error:\s*status not 200|versioned arxiv id (?:is )?not supported)$/i.test(
      payload.msg?.trim() || "",
    )
  );
}

function isLoginRequiredPayload(payload: HJFYApiPayload<unknown>) {
  return (
    payload.status === 101 ||
    /需要先登录|登录后才能|请登录|sign in|login required/i.test(
      payload.msg || "",
    )
  );
}

function decodeAscii(bytes: Uint8Array) {
  return String.fromCharCode(...bytes);
}

function isValidFileInfo(value: unknown): value is HJFYFileInfo {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<HJFYFileInfo>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.origin === "string" &&
    typeof candidate.isDeepSeek === "boolean" &&
    (candidate.zhCN === undefined ||
      candidate.zhCN === null ||
      typeof candidate.zhCN === "string")
  );
}

function isValidArxivInfo(value: unknown): value is HJFYRawArxivInfo {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<HJFYRawArxivInfo>;
  return (
    typeof candidate.hasSrc === "boolean" &&
    (candidate.meta === undefined || typeof candidate.meta === "string")
  );
}

function isValidArxivStatus(value: unknown): value is HJFYArxivStatus {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<HJFYArxivStatus>;
  return (
    typeof candidate.status === "string" &&
    (candidate.info === undefined || typeof candidate.info === "string")
  );
}

function defaultDelay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class HJFYClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly delayImplementation: (milliseconds: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly pollDelayMs: number;
  private readonly maxPollAttempts: number;

  constructor(options: HJFYClientOptions = {}) {
    this.fetchImplementation = options.fetchImplementation || fetch;
    this.delayImplementation = options.delayImplementation || defaultDelay;
    this.retryDelaysMs = options.retryDelaysMs || defaultRetryDelaysMs;
    this.pollDelayMs = options.pollDelayMs ?? 10000;
    this.maxPollAttempts = options.maxPollAttempts ?? 36;
  }

  async fetchArxivFileInfo(
    reference: VersionedArxivReference,
  ): Promise<HJFYFileInfo | null> {
    let payload: HJFYApiPayload<HJFYFileInfo>;
    try {
      payload = await this.requestJsonPayload<HJFYFileInfo>(
        buildHjfyURL("arxivFiles", reference),
        "读取翻译文件信息",
        "翻译文件信息",
        { notFoundIsNotReady: true },
      );
    } catch (error) {
      if (error instanceof HJFYClientError && error.code === "not-ready") {
        return null;
      }
      throw error;
    }

    if (isLoginRequiredPayload(payload)) {
      throw new HJFYClientError(
        "login-required",
        "幻觉翻译要求登录后才能读取翻译文件",
      );
    }
    if (payload.status !== 0 || !payload.data) {
      if (
        isHjfyNotReadyMessage(payload.msg) ||
        isHjfyPendingMessage(payload.msg)
      ) {
        return null;
      }
      throw new HJFYClientError(
        "permanent-error",
        payload.msg || "hjfy.top 返回了无效的文件信息",
      );
    }
    if (!isValidFileInfo(payload.data)) {
      throw new HJFYClientError(
        "permanent-error",
        "hjfy.top 返回的翻译文件信息缺少有效的版本或文件字段",
      );
    }

    this.assertExactReference(payload.data.id, reference, "翻译文件");
    return payload.data;
  }

  async waitForArxivInfo(
    reference: VersionedArxivReference,
  ): Promise<HJFYArxivInfo> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      const arxivInfo = await this.fetchArxivInfoOnce(reference);
      if (arxivInfo) return arxivInfo;
      await this.delayBeforeNextPoll(attempt);
    }

    throw new HJFYClientError(
      "retryable-error",
      `等待 hjfy.top 下载 arXiv ${reference.id} 的论文源码超时，请稍后重试`,
    );
  }

  async primeArxivTask(reference: VersionedArxivReference) {
    const { response, body: responseText } = await this.readResponseBody(
      buildHjfyURL("arxiv", reference),
      "创建翻译任务",
      (taskResponse) => taskResponse.text(),
    );
    const finalUrl = response.url || "";
    if (
      /\/login(?:[/?#]|$)/i.test(finalUrl) ||
      /需要先登录|登录后才能|请登录|sign in/i.test(responseText)
    ) {
      throw new HJFYClientError(
        "login-required",
        "幻觉翻译要求登录后才能为这篇论文创建翻译任务",
      );
    }
  }

  async waitForTranslation(
    reference: VersionedArxivReference,
  ): Promise<HJFYFileInfo & { zhCN: string }> {
    let retriggeredAfterFinished = false;

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      const fileInfo = await this.fetchArxivFileInfo(reference);
      if (hasHjfyChinesePdf(fileInfo)) return fileInfo;

      const status = await this.fetchArxivStatus(reference);
      if (!status) {
        await this.delayBeforeNextPoll(attempt);
        continue;
      }

      const taskState = classifyHjfyTaskState(status.status, fileInfo);
      if (taskState === "failed") {
        throw new HJFYClientError(
          "permanent-error",
          status.info ||
            (status.status === "fault"
              ? "hjfy.top 返回了故障状态"
              : "幻觉翻译任务失败"),
        );
      }
      if (taskState === "unknown") {
        throw new HJFYClientError(
          "permanent-error",
          `hjfy.top 返回了未知任务状态: ${status.status}${status.info ? ` (${status.info})` : ""}`,
        );
      }

      if (status.status === "finished" && !retriggeredAfterFinished) {
        retriggeredAfterFinished = true;
        await this.primeArxivTask(reference);
      }

      await this.delayBeforeNextPoll(attempt);
    }

    throw new HJFYClientError(
      "retryable-error",
      `等待 arXiv ${reference.id} 的幻觉翻译生成中文 PDF 超时，请稍后重试`,
    );
  }

  async downloadPdf(url: string) {
    const { response, body: pdfBuffer } = await this.readResponseBody(
      url,
      "下载翻译 PDF",
      (downloadResponse) => downloadResponse.arrayBuffer(),
    );
    const contentType = response.headers.get("content-type") || "";
    const pdfBytes = new Uint8Array(pdfBuffer);
    const header = decodeAscii(
      pdfBytes.slice(0, Math.min(1024, pdfBytes.length)),
    );
    const trailer = decodeAscii(
      pdfBytes.slice(Math.max(0, pdfBytes.length - 2048)),
    );
    const hasPdfHeader = /%PDF-[0-9]\.[0-9]/.test(header);
    const hasPdfTrailer = /%%EOF[\s\0]*$/.test(trailer);

    if (
      /text\/html|application\/json/i.test(contentType) ||
      pdfBytes.length < 256 ||
      !hasPdfHeader ||
      !hasPdfTrailer
    ) {
      throw new HJFYClientError(
        "permanent-error",
        "下载地址没有返回有效的 PDF，可能是登录页或服务错误页面",
      );
    }

    return pdfBuffer;
  }

  private async fetchArxivInfoOnce(
    reference: VersionedArxivReference,
  ): Promise<HJFYArxivInfo | null> {
    const exactPayload = await this.requestJsonPayload<HJFYRawArxivInfo>(
      buildHjfyURL("arxivInfo", reference),
      "读取精确版本的 arXiv 信息",
      "精确版本的 arXiv 信息",
      { acceptedErrorStatuses: [400] },
    );

    if (isLoginRequiredPayload(exactPayload)) {
      throw new HJFYClientError(
        "login-required",
        "幻觉翻译要求登录后才能读取精确版本的 arXiv 信息",
      );
    }
    if (exactPayload.status === 0 && exactPayload.data) {
      if (!isValidArxivInfo(exactPayload.data)) {
        throw new HJFYClientError(
          "permanent-error",
          "hjfy.top 返回的精确版本 arXiv 信息字段无效",
        );
      }
      return this.normalizeArxivInfo(exactPayload.data, reference, true);
    }
    if (isHjfyPendingMessage(exactPayload.msg)) return null;
    if (!isVersionedInfoCompatibilityError(exactPayload)) {
      throw new HJFYClientError(
        "permanent-error",
        exactPayload.msg || "hjfy.top 返回了无效的精确版本 arXiv 信息",
      );
    }

    const fallbackPayload = await this.requestJsonPayload<HJFYRawArxivInfo>(
      buildHjfyURL("arxivInfo", reference, reference.baseId),
      "读取基础 arXiv 信息",
      "基础 arXiv 信息",
    );
    if (isLoginRequiredPayload(fallbackPayload)) {
      throw new HJFYClientError(
        "login-required",
        "幻觉翻译要求登录后才能读取基础 arXiv 信息",
      );
    }
    if (fallbackPayload.status !== 0 || !fallbackPayload.data) {
      if (isHjfyPendingMessage(fallbackPayload.msg)) return null;
      throw new HJFYClientError(
        "permanent-error",
        fallbackPayload.msg || "hjfy.top 返回了无效的基础 arXiv 信息",
      );
    }
    if (!isValidArxivInfo(fallbackPayload.data)) {
      throw new HJFYClientError(
        "permanent-error",
        "hjfy.top 返回的基础 arXiv 信息字段无效",
      );
    }

    return this.normalizeArxivInfo(fallbackPayload.data, reference, false);
  }

  private normalizeArxivInfo(
    rawInfo: HJFYRawArxivInfo,
    reference: VersionedArxivReference,
    exactRequest: boolean,
  ): HJFYArxivInfo {
    const returnedId = extractAtomEntryId(rawInfo.meta);
    if (exactRequest && !returnedId) {
      throw new HJFYClientError(
        "permanent-error",
        `hjfy.top 没有返回可验证的 arXiv ${reference.id} 版本信息`,
      );
    }
    if (returnedId) {
      const normalizedReturnedId = normalizeArxivId(returnedId);
      if (exactRequest) {
        this.assertExactReference(returnedId, reference, "arXiv 信息");
      } else if (
        normalizedReturnedId !== normalizeArxivId(reference.baseId) &&
        !normalizedReturnedId.startsWith(
          `${normalizeArxivId(reference.baseId)}v`,
        )
      ) {
        throw new HJFYClientError(
          "version-mismatch",
          `hjfy.top 返回的 arXiv 信息 ${returnedId} 与目标论文 ${reference.id} 不一致`,
        );
      }
    }

    return {
      hasSrc: rawInfo.hasSrc,
      exactVersion:
        exactRequest &&
        returnedId !== null &&
        normalizeArxivId(returnedId) === normalizeArxivId(reference.id),
      returnedId,
    };
  }

  private async fetchArxivStatus(
    reference: VersionedArxivReference,
  ): Promise<HJFYArxivStatus | null> {
    const payload = await this.requestJsonPayload<HJFYArxivStatus>(
      buildHjfyURL("arxivStatus", reference),
      "查询翻译状态",
      "翻译状态",
    );
    if (isLoginRequiredPayload(payload)) {
      throw new HJFYClientError(
        "login-required",
        "幻觉翻译要求登录后才能为这篇论文创建翻译任务",
      );
    }
    if (payload.status !== 0 || !payload.data) {
      if (isHjfyPendingMessage(payload.msg)) return null;
      throw new HJFYClientError(
        "permanent-error",
        payload.msg || "hjfy.top 返回了无效的状态数据",
      );
    }
    if (!isValidArxivStatus(payload.data)) {
      throw new HJFYClientError(
        "permanent-error",
        "hjfy.top 返回的翻译状态字段无效",
      );
    }
    return payload.data;
  }

  private assertExactReference(
    returnedId: string,
    reference: VersionedArxivReference,
    sourceName: string,
  ) {
    if (normalizeArxivId(returnedId) === normalizeArxivId(reference.id)) return;

    throw new HJFYClientError(
      "version-mismatch",
      `${sourceName}版本 ${returnedId} 与本地 PDF ${reference.id} 不一致，已停止下载`,
    );
  }

  private async requestJsonPayload<T>(
    url: string,
    actionName: string,
    responseName: string,
    options: RequestOptions = {},
  ): Promise<HJFYApiPayload<T>> {
    const { response, body: responseText } = await this.readResponseBody(
      url,
      actionName,
      (jsonResponse) => jsonResponse.text(),
      options,
    );
    const contentType = response.headers.get("content-type") || "";

    if (
      /text\/html/i.test(contentType) &&
      /需要先登录|登录后才能|请登录|sign in|<form[^>]+login/i.test(responseText)
    ) {
      throw new HJFYClientError(
        "login-required",
        `读取${responseName}需要登录 hjfy.top`,
      );
    }

    try {
      return JSON.parse(responseText) as HJFYApiPayload<T>;
    } catch {
      throw new HJFYClientError(
        "permanent-error",
        `hjfy.top 返回的${responseName}不是有效 JSON`,
      );
    }
  }

  private async readResponseBody<T>(
    url: string,
    actionName: string,
    readBody: (response: Response) => Promise<T>,
    options: RequestOptions = {},
  ): Promise<{ response: Response; body: T }> {
    const maximumAttempts = this.retryDelaysMs.length + 1;

    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const response = await this.requestResponse(url, actionName, options);
      try {
        return { response, body: await readBody(response) };
      } catch {
        if (attempt < maximumAttempts - 1) {
          await this.delayImplementation(this.retryDelaysMs[attempt]);
          continue;
        }
        throw new HJFYClientError(
          "retryable-error",
          `${actionName}失败：读取响应内容时连接中断`,
        );
      }
    }

    throw new HJFYClientError(
      "retryable-error",
      `${actionName}失败，请稍后重试`,
    );
  }

  private async requestResponse(
    url: string,
    actionName: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const maximumAttempts = this.retryDelaysMs.length + 1;

    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          headers: this.getRequestHeaders(),
          credentials: "include",
        });
      } catch {
        if (attempt < maximumAttempts - 1) {
          await this.delayImplementation(this.retryDelaysMs[attempt]);
          continue;
        }
        throw new HJFYClientError(
          "retryable-error",
          `${actionName}失败：无法连接 hjfy.top`,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new HJFYClientError(
          "login-required",
          `${actionName}需要登录 hjfy.top`,
          { httpStatus: response.status },
        );
      }
      if (/\/login(?:[/?#]|$)/i.test(response.url || "")) {
        throw new HJFYClientError(
          "login-required",
          `${actionName}需要登录 hjfy.top`,
        );
      }
      if (response.status === 404 && options.notFoundIsNotReady) {
        throw new HJFYClientError("not-ready", `${actionName}尚未就绪`, {
          httpStatus: response.status,
        });
      }

      const retryableStatus = response.status === 429 || response.status >= 500;
      if (retryableStatus) {
        if (attempt < maximumAttempts - 1) {
          await this.delayImplementation(this.retryDelaysMs[attempt]);
          continue;
        }
        throw new HJFYClientError(
          "retryable-error",
          `${actionName}失败：HTTP ${response.status}`,
          { httpStatus: response.status },
        );
      }
      if (!response.ok) {
        if (options.acceptedErrorStatuses?.includes(response.status)) {
          return response;
        }
        throw new HJFYClientError(
          "permanent-error",
          `${actionName}失败：HTTP ${response.status}`,
          { httpStatus: response.status },
        );
      }

      return response;
    }

    throw new HJFYClientError(
      "retryable-error",
      `${actionName}失败，请稍后重试`,
    );
  }

  private async delayBeforeNextPoll(attempt: number) {
    if (attempt < this.maxPollAttempts - 1) {
      await this.delayImplementation(this.pollDelayMs);
    }
  }

  private getRequestHeaders(): HeadersInit {
    return {
      "User-Agent":
        "zotero-hjfy-split-reader (Zotero Plugin; +https://github.com/Infinity4B/zotero-hjfy-split-reader)",
    };
  }
}
