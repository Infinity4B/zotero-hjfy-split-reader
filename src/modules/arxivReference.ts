export interface ArxivReference {
  baseId: string;
  version: number | null;
  id: string;
}

export interface VersionedArxivReference extends ArxivReference {
  version: number;
}

export type ArxivResolutionErrorCode =
  | "not-found"
  | "version-missing"
  | "base-conflict"
  | "ambiguous"
  | "version-conflict";

export class ArxivResolutionError extends Error {
  public readonly code: ArxivResolutionErrorCode;

  constructor(code: ArxivResolutionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ArxivResolutionError";
  }
}

interface IndexedArxivReference extends ArxivReference {
  index: number;
  patternOrder: number;
}

interface ArxivEvidence {
  pdfText?: string;
  attachmentTexts?: string[];
  parentTexts?: string[];
  allowParentVersionFallback?: boolean;
}

const arxivPatterns = [
  /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?/gi,
  /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?(?:\.pdf)?/gi,
  /(?:^|[^a-z0-9])arxiv\s*(?:id\s*)?[:._-]?\s*([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?\b/gi,
  /(?:^|[^0-9])([0-9]{4}\.[0-9]{4,5})v([0-9]+)(?=$|[^0-9])/gi,
];

function makeReference(baseId: string, rawVersion?: string): ArxivReference {
  const version = rawVersion ? Number.parseInt(rawVersion, 10) : null;
  return {
    baseId,
    version,
    id: version === null ? baseId : `${baseId}v${version}`,
  };
}

export function extractArxivReferences(text: string): ArxivReference[] {
  if (!text) return [];

  const matches: IndexedArxivReference[] = [];
  arxivPatterns.forEach((pattern, patternOrder) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const reference = makeReference(match[1], match[2]);
      matches.push({
        ...reference,
        index: match.index,
        patternOrder,
      });
    }
  });

  matches.sort(
    (left, right) =>
      left.index - right.index || left.patternOrder - right.patternOrder,
  );

  const seen = new Set<string>();
  return matches
    .filter((reference) => {
      const key = reference.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ baseId, version, id }) => ({ baseId, version, id }));
}

function collectReferences(texts: string[] = []) {
  return texts.flatMap((text) => extractArxivReferences(text));
}

interface ArxivEvidenceSummary {
  baseId: string | null;
  versionedReference: VersionedArxivReference | null;
}

function summarizeEvidence(
  references: ArxivReference[],
  sourceName: string,
): ArxivEvidenceSummary {
  const baseIds = [...new Set(references.map((reference) => reference.baseId))];
  if (baseIds.length > 1) {
    throw new ArxivResolutionError(
      "ambiguous",
      `${sourceName}中检测到多个不同的 arXiv 编号: ${baseIds.join(", ")}`,
    );
  }

  const versionedReferences = references.filter(
    (reference): reference is VersionedArxivReference =>
      reference.version !== null,
  );
  const versionedIds = [
    ...new Set(versionedReferences.map((reference) => reference.id)),
  ];
  if (versionedIds.length > 1) {
    throw new ArxivResolutionError(
      "version-conflict",
      `${sourceName}中检测到多个不同的 arXiv 版本: ${versionedIds.join(", ")}`,
    );
  }

  return {
    baseId: baseIds[0] || null,
    versionedReference: versionedReferences[0] || null,
  };
}

function summarizePdfEvidence(
  references: ArxivReference[],
  expectedBaseId: string | null,
): ArxivEvidenceSummary {
  if (!references.length) {
    return { baseId: null, versionedReference: null };
  }

  if (!expectedBaseId) {
    // The arXiv version stamp is normally the first reference on page one.
    // Later IDs are commonly citations and should not make an otherwise
    // self-identifying PDF ambiguous.
    const firstBaseId = references[0].baseId;
    return summarizeEvidence(
      references.filter((reference) => reference.baseId === firstBaseId),
      "本地 PDF 首页",
    );
  }

  const matchingReferences = references.filter(
    (reference) => reference.baseId === expectedBaseId,
  );
  if (matchingReferences.length) {
    // Other arXiv IDs on the first page can be citations. Once the expected
    // paper ID is present, only use matching references as version evidence.
    return summarizeEvidence(matchingReferences, "本地 PDF 首页");
  }

  const detectedBaseIds = [
    ...new Set(references.map((reference) => reference.baseId)),
  ];
  throw new ArxivResolutionError(
    "base-conflict",
    `本地 PDF 中的 arXiv 编号 ${detectedBaseIds.join(", ")} 与条目 ${expectedBaseId} 不一致`,
  );
}

/**
 * Resolve the version of the actual local PDF. Evidence closer to the file wins:
 * PDF text, then attachment metadata, then parent-item metadata.
 */
export function resolveArxivReference(
  evidence: ArxivEvidence,
): VersionedArxivReference {
  const parentReferences = collectReferences(evidence.parentTexts);
  const attachmentReferences = collectReferences(evidence.attachmentTexts);
  const pdfReferences = extractArxivReferences(evidence.pdfText || "");

  const parentSummary = summarizeEvidence(parentReferences, "父条目元数据");
  const attachmentSummary = summarizeEvidence(
    attachmentReferences,
    "PDF 附件元数据",
  );

  if (
    attachmentSummary.baseId &&
    parentSummary.baseId &&
    attachmentSummary.baseId !== parentSummary.baseId
  ) {
    throw new ArxivResolutionError(
      "base-conflict",
      `PDF 附件的 arXiv 编号 ${attachmentSummary.baseId} 与父条目 ${parentSummary.baseId} 不一致`,
    );
  }

  const expectedBaseId = parentSummary.baseId || attachmentSummary.baseId;
  const pdfSummary = summarizePdfEvidence(pdfReferences, expectedBaseId);

  if (
    pdfSummary.baseId &&
    attachmentSummary.baseId &&
    pdfSummary.baseId !== attachmentSummary.baseId
  ) {
    throw new ArxivResolutionError(
      "base-conflict",
      `本地 PDF 中的 arXiv 编号 ${pdfSummary.baseId} 与附件元数据 ${attachmentSummary.baseId} 不一致`,
    );
  }

  if (pdfSummary.versionedReference) {
    return pdfSummary.versionedReference;
  }
  if (attachmentSummary.versionedReference) {
    return attachmentSummary.versionedReference;
  }
  if (
    evidence.allowParentVersionFallback !== false &&
    parentSummary.versionedReference
  ) {
    return parentSummary.versionedReference;
  }

  const unresolvedBaseId =
    pdfSummary.baseId || attachmentSummary.baseId || parentSummary.baseId;
  if (unresolvedBaseId) {
    throw new ArxivResolutionError(
      "version-missing",
      `已识别 arXiv 编号 ${unresolvedBaseId}，但无法确认本地 PDF 的具体版本`,
    );
  }

  throw new ArxivResolutionError(
    "not-found",
    "无法从本地 PDF 或条目元数据中识别 arXiv 编号",
  );
}

export function selectHighestArxivVersion<
  T extends { reference: VersionedArxivReference },
>(candidates: T[], expectedBaseId?: string | null): T | null {
  const matching = expectedBaseId
    ? candidates.filter(
        (candidate) => candidate.reference.baseId === expectedBaseId,
      )
    : candidates;
  if (!matching.length) return null;

  return matching.reduce((highest, candidate) =>
    candidate.reference.version > highest.reference.version
      ? candidate
      : highest,
  );
}

export function hasExactArxivReference(
  texts: string[],
  expected: VersionedArxivReference,
) {
  try {
    const summary = summarizeEvidence(
      collectReferences(texts),
      "译文附件元数据",
    );
    return summary.versionedReference?.id === expected.id;
  } catch {
    return false;
  }
}

export function hasUnversionedArxivReference(
  texts: string[],
  expectedBaseId: string,
) {
  const matchingReferences = collectReferences(texts).filter(
    (reference) => reference.baseId === expectedBaseId,
  );
  return (
    matchingReferences.length > 0 &&
    matchingReferences.every((reference) => reference.version === null)
  );
}

export function getUnambiguousVersionedArxivReference(
  texts: string[],
  sourceName: string,
) {
  return summarizeEvidence(collectReferences(texts), sourceName)
    .versionedReference;
}

export function isSupplementaryAttachmentMetadata(texts: string[]) {
  const normalized = texts.join(" ").toLowerCase();
  return /\b(?:supplement|supplementary|appendix|slides?)\b|补充材料|附录|幻灯/.test(
    normalized,
  );
}
