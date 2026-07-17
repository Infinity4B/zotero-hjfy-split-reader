export type HJFYTaskStatus =
  | "finished"
  | "failed"
  | "error"
  | "fault"
  | "start";

interface HJFYFileAvailability {
  zhCN?: string;
}

export function isHjfyPendingMessage(message?: string) {
  if (!message) return false;

  const normalized = message.trim();
  if (!normalized || /失败|错误|无法|不支持/.test(normalized)) {
    return false;
  }
  return /正在|处理中|排队|队列|等待|请稍后/.test(normalized);
}

export function hasHjfyChinesePdf<T extends HJFYFileAvailability>(
  fileInfo?: T | null,
): fileInfo is T & { zhCN: string } {
  return Boolean(fileInfo?.zhCN?.trim());
}

export function classifyHjfyTaskState(
  status: HJFYTaskStatus,
  fileInfo?: HJFYFileAvailability | null,
) {
  if (hasHjfyChinesePdf(fileInfo)) return "ready" as const;
  if (status === "failed" || status === "error" || status === "fault") {
    return "failed" as const;
  }
  return "pending" as const;
}
