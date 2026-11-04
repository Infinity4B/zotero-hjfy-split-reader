export type HJFYTaskStatus =
  | "init"
  | "finished"
  | "failed"
  | "error"
  | "fault"
  | "start";

export type HJFYTaskState = "ready" | "failed" | "pending" | "unknown";

interface HJFYFileAvailability {
  zhCN?: unknown;
}

interface HJFYPreviewMarkers extends HJFYFileAvailability {
  isPreview?: unknown;
  unlocked?: unknown;
}

export function isHjfyPendingMessage(message?: string) {
  if (!message) return false;

  const normalized = message.trim();
  if (!normalized || /失败|错误|无法|不支持/.test(normalized)) {
    return false;
  }
  return /正在|处理中|下载中|已提交|排队|队列|等待|请稍后|pending|processing|queued/i.test(
    normalized,
  );
}

export function isHjfyNotReadyMessage(message?: string) {
  if (!message) return false;

  const normalized = message.trim();
  return /未找到|不存在|尚未生成|尚未创建|暂无|还没有|not found|not ready/i.test(
    normalized,
  );
}

export function hasHjfyChinesePdf<T extends HJFYFileAvailability>(
  fileInfo?: T | null,
): fileInfo is T & { zhCN: string } {
  return typeof fileInfo?.zhCN === "string" && Boolean(fileInfo.zhCN.trim());
}

// HJFY serves a page-limited preview until the paper is unlocked with account quota.
export function isHjfyPreviewFile(fileInfo?: HJFYPreviewMarkers | null) {
  if (!hasHjfyChinesePdf(fileInfo)) return false;
  return (
    fileInfo.isPreview === true ||
    fileInfo.unlocked === false ||
    /\.preview\.pdf(?:[?#]|$)/i.test(fileInfo.zhCN)
  );
}

interface HJFYQuoteSource {
  unlockQuote?: { id?: unknown; version?: unknown; pages?: unknown } | null;
}

// Only a quote for exactly this version, with a whole positive page count, may be spent.
export function getValidUnlockQuote(
  fileInfo: HJFYQuoteSource | null | undefined,
  referenceId: string,
) {
  const quote = fileInfo?.unlockQuote;
  if (!quote) return null;

  const { id, version, pages } = quote;
  if (typeof id !== "string" || !id.trim()) return null;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages <= 0) {
    return null;
  }
  if (
    version !== undefined &&
    (typeof version !== "string" ||
      version.trim().toLowerCase() !== referenceId.trim().toLowerCase())
  ) {
    return null;
  }
  return { id, pages };
}

export function classifyHjfyTaskState(
  status: string,
  fileInfo?: HJFYFileAvailability | null,
): HJFYTaskState {
  if (hasHjfyChinesePdf(fileInfo)) return "ready" as const;
  if (status === "failed" || status === "error" || status === "fault") {
    return "failed" as const;
  }
  if (status === "init" || status === "start" || status === "finished") {
    return "pending" as const;
  }
  return "unknown" as const;
}
