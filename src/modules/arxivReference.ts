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
  | "ambiguous";

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
}

const arxivPatterns = [
  /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?/gi,
  /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?(?:\.pdf)?/gi,
  /\barxiv\s*(?:id\s*)?[:._-]?\s*([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?\b/gi,
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

function uniqueBaseId(
  references: ArxivReference[],
  sourceName: string,
): string | null {
  const baseIds = [...new Set(references.map((reference) => reference.baseId))];
  if (baseIds.length > 1) {
    throw new ArxivResolutionError(
      "ambiguous",
      `${sourceName}中检测到多个不同的 arXiv 编号: ${baseIds.join(", ")}`,
    );
  }
  return baseIds[0] || null;
}

function firstVersioned(
  references: ArxivReference[],
  baseId?: string | null,
): VersionedArxivReference | null {
  const reference = references.find(
    (candidate) =>
      candidate.version !== null && (!baseId || candidate.baseId === baseId),
  );
  return reference ? (reference as VersionedArxivReference) : null;
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

  const parentBaseId = uniqueBaseId(parentReferences, "父条目元数据");
  const attachmentBaseId = uniqueBaseId(attachmentReferences, "PDF 附件元数据");

  if (pdfReferences.length) {
    if (parentBaseId) {
      const matchingPDF = firstVersioned(pdfReferences, parentBaseId);
      if (matchingPDF) return matchingPDF;

      const pdfBaseIds = [
        ...new Set(
          pdfReferences
            .filter((reference) => reference.version !== null)
            .map((reference) => reference.baseId),
        ),
      ];
      if (pdfBaseIds.length) {
        throw new ArxivResolutionError(
          "base-conflict",
          `本地 PDF 中的 arXiv 编号 ${pdfBaseIds.join(", ")} 与父条目 ${parentBaseId} 不一致`,
        );
      }
    } else if (attachmentBaseId) {
      const matchingPDF = firstVersioned(pdfReferences, attachmentBaseId);
      if (matchingPDF) return matchingPDF;

      const uniquePDFBaseId = uniqueBaseId(pdfReferences, "本地 PDF 首页");
      const pdfReference = firstVersioned(pdfReferences, uniquePDFBaseId);
      if (pdfReference) return pdfReference;
    } else {
      const uniquePDFBaseId = uniqueBaseId(pdfReferences, "本地 PDF 首页");
      const pdfReference = firstVersioned(pdfReferences, uniquePDFBaseId);
      if (pdfReference) return pdfReference;
    }
  }

  if (attachmentBaseId && parentBaseId && attachmentBaseId !== parentBaseId) {
    throw new ArxivResolutionError(
      "base-conflict",
      `PDF 附件的 arXiv 编号 ${attachmentBaseId} 与父条目 ${parentBaseId} 不一致`,
    );
  }

  const attachmentReference = firstVersioned(
    attachmentReferences,
    parentBaseId || attachmentBaseId,
  );
  if (attachmentReference) return attachmentReference;

  const parentReference = firstVersioned(parentReferences, parentBaseId);
  if (parentReference) return parentReference;

  const unresolvedBaseId = attachmentBaseId || parentBaseId;
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
  return collectReferences(texts).some(
    (reference) =>
      reference.version === expected.version && reference.id === expected.id,
  );
}

export type HJFYRoute = "arxivInfo" | "arxivStatus" | "arxivFiles" | "arxiv";

export function buildHjfyURL(
  route: HJFYRoute,
  reference: VersionedArxivReference,
) {
  const prefix = route === "arxiv" ? "" : "api/";
  // HJFY's arxivInfo endpoint forwards the identifier to the arXiv Atom API,
  // which rejects version suffixes. Task-specific routes do support versions
  // and must keep them to avoid mixing translations from different revisions.
  const id = route === "arxivInfo" ? reference.baseId : reference.id;
  return `https://hjfy.top/${prefix}${route}/${encodeURIComponent(id)}`;
}
