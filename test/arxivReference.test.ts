import { assert } from "chai";
import {
  ArxivResolutionError,
  extractArxivReferences,
  getUnambiguousVersionedArxivReference,
  hasExactArxivReference,
  hasUnversionedArxivReference,
  isSupplementaryAttachmentMetadata,
  resolveArxivReference,
  selectHighestArxivVersion,
} from "../src/modules/arxivReference";
import type { VersionedArxivReference } from "../src/modules/arxivReference";
import { buildHjfyURL } from "../src/modules/hjfyClient";
import {
  classifyHjfyTaskState,
  hasHjfyChinesePdf,
  isHjfyNotReadyMessage,
  isHjfyPendingMessage,
} from "../src/modules/hjfyState";

function reference(baseId: string, version: number): VersionedArxivReference {
  return {
    baseId,
    version,
    id: `${baseId}v${version}`,
  };
}

const expectedV2 = reference("2401.12345", 2);

function expectResolutionError(
  callback: () => void,
  code: ArxivResolutionError["code"],
) {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.instanceOf(caught, ArxivResolutionError);
  assert.equal((caught as ArxivResolutionError).code, code);
}

describe("versioned arXiv translation", function () {
  it("preserves versions from DOI, text, and arXiv URLs", function () {
    const cases = [
      "10.48550/arXiv.2401.12345v2",
      "arXiv: 2401.12345v10",
      "https://arxiv.org/abs/2401.12345v3",
      "https://arxiv.org/pdf/2401.12345v4.pdf",
      "arXiv ID: 2401.12345v5",
    ];

    assert.deepEqual(
      cases.map((value) => extractArxivReferences(value)[0].id),
      [
        "2401.12345v2",
        "2401.12345v10",
        "2401.12345v3",
        "2401.12345v4",
        "2401.12345v5",
      ],
    );
  });

  it("uses the local PDF version when the parent item is versionless", function () {
    assert.deepEqual(
      resolveArxivReference({
        pdfText: "arXiv:2401.12345v2 [cs.LG] 3 Jan 2024",
        attachmentTexts: ["renamed-paper.pdf"],
        parentTexts: ["https://arxiv.org/abs/2401.12345"],
      }),
      reference("2401.12345", 2),
    );
  });

  it("falls back to attachment metadata before parent metadata", function () {
    assert.deepEqual(
      resolveArxivReference({
        attachmentTexts: ["paper_arxiv_2401.12345v4.pdf"],
        parentTexts: ["arXiv:2401.12345v3"],
      }),
      reference("2401.12345", 4),
    );
  });

  it("falls back to a versioned parent item", function () {
    assert.deepEqual(
      resolveArxivReference({
        attachmentTexts: ["paper.pdf"],
        parentTexts: ["10.48550/arXiv.2401.12345v3"],
      }),
      reference("2401.12345", 3),
    );
  });

  it("rejects a local PDF whose arXiv ID conflicts with its parent", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          pdfText: "arXiv:2402.54321v2 [cs.CL] 4 Feb 2024",
          parentTexts: ["arXiv:2401.12345"],
        }),
      "base-conflict",
    );
  });

  it("rejects a versionless PDF ID that conflicts with its parent", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          pdfText: "arXiv:2402.54321 [cs.CL]",
          parentTexts: ["arXiv:2401.12345v3"],
        }),
      "base-conflict",
    );
  });

  it("rejects conflicting versions within one metadata layer", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          parentTexts: [
            "10.48550/arXiv.2401.12345v1",
            "https://arxiv.org/abs/2401.12345v2",
          ],
        }),
      "version-conflict",
    );
  });

  it("ignores unrelated first-page citations when the expected ID is present", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          pdfText: "arXiv:2401.12345 [cs.LG]. See also arXiv:2301.00001v2.",
          parentTexts: ["https://arxiv.org/abs/2401.12345"],
        }),
      "version-missing",
    );

    assert.deepEqual(
      resolveArxivReference({
        pdfText: "arXiv:2401.12345v3 [cs.LG]. See also arXiv:2301.00001v2.",
        parentTexts: ["https://arxiv.org/abs/2401.12345"],
      }),
      reference("2401.12345", 3),
    );
  });

  it("uses the first-page version stamp without parent metadata", function () {
    assert.deepEqual(
      resolveArxivReference({
        pdfText: "arXiv:2401.12345v3 [cs.LG]. See also arXiv:2301.00001v2.",
      }),
      reference("2401.12345", 3),
    );
  });

  it("does not assign a parent version to every PDF in a multi-file item", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          attachmentTexts: ["paper-without-version.pdf"],
          parentTexts: ["arXiv:2401.12345v3"],
          allowParentVersionFallback: false,
        }),
      "version-missing",
    );
  });

  it("rejects a versionless arXiv ID", function () {
    expectResolutionError(
      () =>
        resolveArxivReference({
          attachmentTexts: ["paper.pdf"],
          parentTexts: ["https://arxiv.org/abs/2401.12345"],
        }),
      "version-missing",
    );
  });

  it("selects the numerically highest version", function () {
    const selected = selectHighestArxivVersion([
      { name: "v2.pdf", reference: reference("2401.12345", 2) },
      { name: "v10.pdf", reference: reference("2401.12345", 10) },
      { name: "v3.pdf", reference: reference("2401.12345", 3) },
    ]);

    assert.equal(selected?.name, "v10.pdf");
  });

  it("only matches an existing translation with the exact version", function () {
    assert.isTrue(
      hasExactArxivReference(["paper_hjfy_arxiv_2401.12345v2.pdf"], expectedV2),
    );
    assert.isFalse(
      hasExactArxivReference(["paper_hjfy_arxiv_2401.12345v1.pdf"], expectedV2),
    );
    assert.isFalse(
      hasExactArxivReference(["paper_hjfy_arxiv_2401.12345.pdf"], expectedV2),
    );
    assert.isFalse(
      hasExactArxivReference(
        ["幻觉翻译 (2401.12345v1)", "paper_hjfy_arxiv_2401.12345v2.pdf"],
        expectedV2,
      ),
    );
  });

  it("rejects conflicting IDs when resolving a selected translation", function () {
    expectResolutionError(
      () =>
        getUnambiguousVersionedArxivReference(
          ["幻觉翻译 (2401.12345v2)", "https://arxiv.org/abs/2402.54321"],
          "译文附件元数据",
        ),
      "ambiguous",
    );
  });

  it("keeps the exact version in every HJFY route", function () {
    const routes = ["arxivInfo", "arxivStatus", "arxivFiles", "arxiv"] as const;
    assert.deepEqual(
      routes.map((route) => buildHjfyURL(route, expectedV2)),
      [
        "https://hjfy.top/api/arxivInfo/2401.12345v2",
        "https://hjfy.top/api/arxivStatus/2401.12345v2",
        "https://hjfy.top/api/arxivFiles/2401.12345v2",
        "https://hjfy.top/arxiv/2401.12345v2",
      ],
    );
  });

  it("treats HJFY progress messages as pending", function () {
    assert.isTrue(isHjfyPendingMessage("正在下载论文源码"));
    assert.isTrue(isHjfyPendingMessage("任务正在排队，请稍后"));
    assert.isFalse(isHjfyPendingMessage("下载论文源码失败"));
    assert.isFalse(isHjfyPendingMessage());
    assert.isTrue(isHjfyNotReadyMessage("译文尚未生成"));
  });

  it("waits for the Chinese PDF even after the task reports finished", function () {
    assert.equal(classifyHjfyTaskState("finished", {}), "pending");
    assert.equal(
      classifyHjfyTaskState("finished", { zhCN: "https://example.com/zh.pdf" }),
      "ready",
    );
    assert.equal(classifyHjfyTaskState("error", {}), "failed");
    assert.equal(classifyHjfyTaskState("unexpected", {}), "unknown");
    assert.isFalse(hasHjfyChinesePdf({ zhCN: "" }));
    assert.isTrue(hasHjfyChinesePdf({ zhCN: "https://example.com/zh.pdf" }));
  });

  it("detects legacy unversioned translations without reusing them", function () {
    assert.isTrue(
      hasUnversionedArxivReference(
        ["paper_hjfy_arxiv_2401.12345.pdf"],
        "2401.12345",
      ),
    );
    assert.isFalse(
      hasUnversionedArxivReference(
        ["paper_hjfy_arxiv_2401.12345v2.pdf"],
        "2401.12345",
      ),
    );
    assert.isFalse(
      hasUnversionedArxivReference(
        ["幻觉翻译 (2401.12345v1)", "paper_hjfy_arxiv_2401.12345.pdf"],
        "2401.12345",
      ),
    );
  });

  it("recognizes supplementary attachments that may be ignored", function () {
    assert.isTrue(
      isSupplementaryAttachmentMetadata(["paper supplementary material.pdf"]),
    );
    assert.isTrue(isSupplementaryAttachmentMetadata(["论文补充材料.pdf"]));
    assert.isFalse(isSupplementaryAttachmentMetadata(["paper-v3.pdf"]));
  });
});
