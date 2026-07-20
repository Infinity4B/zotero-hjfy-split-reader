export type HJFYTaskStatus =
  | "finished"
  | "failed"
  | "error"
  | "fault"
  | "start";

export type HJFYTaskState = "ready" | "failed" | "pending" | "unknown";

interface HJFYFileAvailability {
  zhCN?: unknown;
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
  return /未找到|不存在|尚未生成|暂无|还没有|not found|not ready/i.test(
    normalized,
  );
}

export function hasHjfyChinesePdf<T extends HJFYFileAvailability>(
  fileInfo?: T | null,
): fileInfo is T & { zhCN: string } {
  return typeof fileInfo?.zhCN === "string" && Boolean(fileInfo.zhCN.trim());
}

export function classifyHjfyTaskState(
  status: string,
  fileInfo?: HJFYFileAvailability | null,
): HJFYTaskState {
  if (hasHjfyChinesePdf(fileInfo)) return "ready" as const;
  if (status === "failed" || status === "error" || status === "fault") {
    return "failed" as const;
  }
  if (status === "start" || status === "finished") {
    return "pending" as const;
  }
  return "unknown" as const;
}
