import { assert } from "chai";
import type { VersionedArxivReference } from "../src/modules/arxivReference";
import { HJFYClient, HJFYClientError } from "../src/modules/hjfyClient";
import {
  getValidUnlockQuote,
  isHjfyPreviewFile,
} from "../src/modules/hjfyState";

const expectedReference: VersionedArxivReference = {
  baseId: "2401.12345",
  version: 2,
  id: "2401.12345v2",
};

function jsonResponse(
  payload: unknown,
  options: { status?: number; url?: string } = {},
) {
  const response = new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json" },
  });
  if (options.url) {
    Object.defineProperty(response, "url", { value: options.url });
  }
  return response;
}

function responseWithFailingTextBody() {
  return {
    ok: true,
    status: 200,
    url: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => {
      throw new Error("connection interrupted");
    },
  } as Response;
}

function createQueuedFetch(responses: Array<Response | Error>) {
  const requestedUrls: string[] = [];
  const requestInits: Array<RequestInit | undefined> = [];
  const fetchImplementation = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requestedUrls.push(String(input));
    requestInits.push(init);
    const nextResponse = responses.shift();
    if (!nextResponse) {
      throw new Error("No queued response for request");
    }
    if (nextResponse instanceof Error) throw nextResponse;
    return nextResponse;
  };

  return {
    fetchImplementation: fetchImplementation as typeof fetch,
    requestInits,
    requestedUrls,
  };
}

async function expectClientError(
  promise: Promise<unknown>,
  code: HJFYClientError["code"],
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  assert.instanceOf(caught, HJFYClientError);
  assert.equal((caught as HJFYClientError).code, code);
  return caught as HJFYClientError;
}

function createClient(responses: Array<Response | Error>, maxPollAttempts = 1) {
  const queuedFetch = createQueuedFetch(responses);
  const delays: number[] = [];
  const client = new HJFYClient({
    fetchImplementation: queuedFetch.fetchImplementation,
    delayImplementation: async (milliseconds) => {
      delays.push(milliseconds);
    },
    retryDelaysMs: [0, 0],
    pollDelayMs: 0,
    maxPollAttempts,
  });

  return {
    client,
    delays,
    requestInits: queuedFetch.requestInits,
    requestedUrls: queuedFetch.requestedUrls,
  };
}

function readyFileInfo(identifier = expectedReference.id) {
  return {
    id: identifier,
    title: "Paper",
    origin: "https://example.com/original.pdf",
    zhCN: "https://example.com/translated.pdf",
    isDeepSeek: false,
  };
}

function previewFileInfo() {
  return {
    ...readyFileInfo(),
    zhCN: "https://example.com/2401.12345v2_zh_CN.preview.pdf?sig=1",
    isPreview: true,
    unlocked: false,
    previewPageLimit: 5,
    unlockQuote: { id: "quote-1", version: expectedReference.id, pages: 16 },
  };
}

describe("HJFYClient", function () {
  describe("preview detection", function () {
    it("recognizes each preview marker", function () {
      const preview = previewFileInfo();
      assert.isTrue(isHjfyPreviewFile(preview));
      assert.isTrue(isHjfyPreviewFile({ ...readyFileInfo(), isPreview: true }));
      assert.isTrue(isHjfyPreviewFile({ ...readyFileInfo(), unlocked: false }));
      assert.isTrue(
        isHjfyPreviewFile({ ...readyFileInfo(), zhCN: preview.zhCN }),
      );
    });

    it("accepts unlocked translations and ignores missing files", function () {
      assert.isFalse(isHjfyPreviewFile(readyFileInfo()));
      assert.isFalse(
        isHjfyPreviewFile({
          ...readyFileInfo(),
          isPreview: false,
          unlocked: true,
        }),
      );
      assert.isFalse(isHjfyPreviewFile({ ...previewFileInfo(), zhCN: "" }));
    });
  });

  it("rejects a translation from another version while polling", async function () {
    const { client } = createClient([
      jsonResponse({ status: 0, data: readyFileInfo("2401.12345v7") }),
    ]);

    await expectClientError(
      client.waitForTranslation(expectedReference),
      "version-mismatch",
    );
  });

  it("retries HTTP 500 and then reports a retryable error", async function () {
    const { client, delays, requestedUrls } = createClient([
      new Response("server error", { status: 500 }),
      new Response("server error", { status: 500 }),
      new Response("server error", { status: 500 }),
    ]);

    const error = await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "retryable-error",
    );

    assert.equal(error.httpStatus, 500);
    assert.lengthOf(requestedUrls, 3);
    assert.deepEqual(delays, [0, 0]);
  });

  it("reports authentication errors without treating them as pending", async function () {
    const { client } = createClient([
      new Response("unauthorized", { status: 401 }),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "login-required",
    );
  });

  it("recognizes authentication requirements in API payloads", async function () {
    const { client } = createClient([
      jsonResponse({ status: 101, msg: "需要先登录" }),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "login-required",
    );
  });

  it("includes HJFY session credentials in API requests", async function () {
    const { client, requestInits } = createClient([
      jsonResponse({ status: 0, data: readyFileInfo() }),
    ]);

    await client.fetchArxivFileInfo(expectedReference);

    assert.equal(requestInits[0]?.credentials, "include");
  });

  it("retries HTTP 429 and accepts the following exact file", async function () {
    const { client, requestedUrls } = createClient([
      new Response("rate limited", { status: 429 }),
      jsonResponse({ status: 0, data: readyFileInfo() }),
    ]);

    const result = await client.fetchArxivFileInfo(expectedReference);

    assert.equal(result?.id, expectedReference.id);
    assert.lengthOf(requestedUrls, 2);
  });

  it("reports invalid JSON as a permanent response error", async function () {
    const { client } = createClient([
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "permanent-error",
    );
  });

  it("retries response-body network failures", async function () {
    const { client, delays, requestedUrls } = createClient([
      responseWithFailingTextBody(),
      responseWithFailingTextBody(),
      responseWithFailingTextBody(),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "retryable-error",
    );
    assert.lengthOf(requestedUrls, 3);
    assert.deepEqual(delays, [0, 0]);
  });

  it("classifies redirected login pages as authentication errors", async function () {
    const { client } = createClient([
      jsonResponse(
        { status: 0, data: readyFileInfo() },
        { url: "https://hjfy.top/login" },
      ),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "login-required",
    );
  });

  it("rejects malformed successful file responses", async function () {
    const { client } = createClient([
      jsonResponse({
        status: 0,
        data: {
          title: "Paper",
          origin: "https://example.com/original.pdf",
          isDeepSeek: false,
        },
      }),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
      "permanent-error",
    );
  });

  it("does not enter polling when task creation returns HTTP 500", async function () {
    const { client, requestedUrls } = createClient([
      new Response("server error", { status: 500 }),
      new Response("server error", { status: 500 }),
      new Response("server error", { status: 500 }),
    ]);

    await expectClientError(
      client.primeArxivTask(expectedReference),
      "retryable-error",
    );
    assert.lengthOf(requestedUrls, 3);
  });

  it("keeps polling while a new task is not ready", async function () {
    const { client, requestedUrls } = createClient(
      [
        jsonResponse({ status: 1, msg: "译文尚未生成" }),
        jsonResponse({ status: 1, msg: "任务尚未创建" }),
        jsonResponse({ status: 0, data: readyFileInfo() }),
      ],
      2,
    );

    const result = await client.waitForTranslation(expectedReference);

    assert.equal(result.id, expectedReference.id);
    assert.deepEqual(requestedUrls, [
      "https://hjfy.top/api/arxivFiles/2401.12345v2",
      "https://hjfy.top/api/arxivStatus/2401.12345v2",
      "https://hjfy.top/api/arxivFiles/2401.12345v2",
    ]);
  });

  it("waits after finished until the exact Chinese PDF appears", async function () {
    const { client, requestedUrls } = createClient(
      [
        jsonResponse({ status: 1, msg: "译文尚未生成" }),
        jsonResponse({
          status: 0,
          data: { status: "finished", info: "正在生成 PDF" },
        }),
        new Response("task triggered", { status: 200 }),
        jsonResponse({ status: 0, data: readyFileInfo() }),
      ],
      2,
    );

    const result = await client.waitForTranslation(expectedReference);

    assert.equal(result.id, expectedReference.id);
    assert.equal(result.zhCN, "https://example.com/translated.pdf");
    assert.deepEqual(requestedUrls, [
      "https://hjfy.top/api/arxivFiles/2401.12345v2",
      "https://hjfy.top/api/arxivStatus/2401.12345v2",
      "https://hjfy.top/arxiv/2401.12345v2",
      "https://hjfy.top/api/arxivFiles/2401.12345v2",
    ]);
  });

  it("reports a polling timeout with the target version", async function () {
    const { client } = createClient([
      jsonResponse({ status: 1, msg: "译文尚未生成" }),
      jsonResponse({ status: 0, data: { status: "start" } }),
    ]);

    const error = await expectClientError(
      client.waitForTranslation(expectedReference),
      "retryable-error",
    );
    assert.include(error.message, expectedReference.id);
  });

  it("requests a translation when HJFY reports an uncreated task", async function () {
    const { client, requestedUrls, requestInits } = createClient(
      [
        jsonResponse({ status: 0, data: { ...readyFileInfo(), zhCN: "" } }),
        jsonResponse({ status: 0, data: { status: "init", pending: false } }),
        jsonResponse({ pending: true }),
        jsonResponse({ status: 0, data: readyFileInfo() }),
      ],
      2,
    );

    let confirmations = 0;
    const result = await client.waitForTranslation(expectedReference, {
      confirmTranslationRequest: async () => {
        confirmations++;
        return true;
      },
    });

    assert.equal(result.id, expectedReference.id);
    assert.equal(confirmations, 1);
    assert.equal(
      requestedUrls[2],
      "https://hjfy.top/api/arxivTranslate/2401.12345v2",
    );
    assert.equal(requestInits[2]?.method, "POST");
    assert.property(requestInits[2]?.headers, "Idempotency-Key");
  });

  it("reports login-required when translation creation is unauthorized", async function () {
    const { client } = createClient([
      jsonResponse({ status: 0, data: { ...readyFileInfo(), zhCN: "" } }),
      jsonResponse({ status: 0, data: { status: "init", pending: false } }),
      jsonResponse(
        { error: "LOGIN_REQUIRED", msg: "LOGIN_REQUIRED" },
        { status: 401 },
      ),
    ]);

    const error = await expectClientError(
      client.waitForTranslation(expectedReference, {
        confirmTranslationRequest: async () => true,
      }),
      "login-required",
    );
    assert.isTrue(error.translationMissing);
  });

  async function expectNoTranslationTask(options: {
    confirmTranslationRequest?: () => Promise<boolean>;
  }) {
    const { client, requestedUrls } = createClient(
      [
        jsonResponse({ status: 0, data: { ...readyFileInfo(), zhCN: "" } }),
        jsonResponse({ status: 0, data: { status: "init", pending: false } }),
        jsonResponse({ pending: true }),
      ],
      2,
    );

    await expectClientError(
      client.waitForTranslation(expectedReference, options),
      "translation-declined",
    );
    assert.notInclude(
      requestedUrls,
      "https://hjfy.top/api/arxivTranslate/2401.12345v2",
    );
  }

  it("does not submit a translation task when the user declines", async function () {
    await expectNoTranslationTask({
      confirmTranslationRequest: async () => false,
    });
  });

  it("does not submit a translation task without a confirmation", async function () {
    await expectNoTranslationTask({});
  });

  it("reads the translation page balance", async function () {
    const { client, requestedUrls } = createClient([
      jsonResponse({
        balances: [
          { resource: "other", available: 1 },
          { resource: "translation_pages", available: 42 },
        ],
      }),
    ]);

    assert.equal(await client.fetchTranslationBalance(), 42);
    assert.deepEqual(requestedUrls, ["https://hjfy.top/api/billing/balance"]);
  });

  it("unlocks with the quote id and an idempotency key", async function () {
    const queuedFetch = createQueuedFetch([jsonResponse({ status: 0 })]);
    const client = new HJFYClient({
      fetchImplementation: queuedFetch.fetchImplementation,
      idempotencyKeyFactory: () => "fixed-key",
      retryDelaysMs: [],
    });

    await client.unlockArxiv(expectedReference, "quote-1");

    const init = queuedFetch.requestInits[0];
    assert.equal(
      queuedFetch.requestedUrls[0],
      "https://hjfy.top/api/arxivUnlock/2401.12345v2",
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, JSON.stringify({ quoteId: "quote-1" }));
    assert.equal(
      (init?.headers as Record<string, string>)["Idempotency-Key"],
      "fixed-key",
    );
  });

  it("logs out without following the redirect", async function () {
    const { client, requestedUrls, requestInits } = createClient([
      new Response(null, { status: 200 }),
    ]);

    await client.logout();

    assert.deepEqual(requestedUrls, ["https://hjfy.top/api/logout"]);
    assert.equal(requestInits[0]?.method, "POST");
    assert.equal(requestInits[0]?.redirect, "manual");
    assert.equal(requestInits[0]?.credentials, "include");
  });

  describe("unlocking spends quota at most once", function () {
    for (const [name, response] of [
      ["HTTP 500", () => new Response("server error", { status: 500 })],
      ["HTTP 429", () => new Response("rate limited", { status: 429 })],
      ["a network error", () => new Error("connection reset")],
      ["an unreadable body", () => responseWithFailingTextBody()],
      [
        "a non-JSON success body",
        () => new Response("<html></html>", { status: 200 }),
      ],
    ] as const) {
      it(`sends one request without retrying on ${name}`, async function () {
        const { client, requestedUrls, delays } = createClient([
          response(),
          jsonResponse({ status: 0 }),
          jsonResponse({ status: 0 }),
        ]);

        const error = await expectClientError(
          client.unlockArxiv(expectedReference, "quote-1"),
          name === "HTTP 429" ? "retryable-error" : "unlock-outcome-unknown",
        );

        assert.lengthOf(requestedUrls, 1);
        assert.isEmpty(delays);
        if (name === "HTTP 429") assert.equal(error.httpStatus, 429);
      });
    }

    it("reports a server-side refusal as a definite failure", async function () {
      const { client, requestedUrls } = createClient([
        jsonResponse({ status: 1, msg: "报价已过期" }),
      ]);

      const error = await expectClientError(
        client.unlockArxiv(expectedReference, "quote-1"),
        "permanent-error",
      );
      assert.equal(error.message, "报价已过期");
      assert.lengthOf(requestedUrls, 1);
    });

    it("reports a missing login as a definite failure", async function () {
      const { client } = createClient([
        jsonResponse(
          { error: "LOGIN_REQUIRED", msg: "LOGIN_REQUIRED" },
          { status: 401 },
        ),
      ]);

      await expectClientError(
        client.unlockArxiv(expectedReference, "quote-1"),
        "login-required",
      );
    });
  });

  describe("unlock quote validation", function () {
    const quoted = (unlockQuote: unknown) =>
      getValidUnlockQuote(
        { unlockQuote } as Parameters<typeof getValidUnlockQuote>[0],
        expectedReference.id,
      );

    it("accepts a quote for exactly this version", function () {
      assert.deepEqual(
        quoted({ id: "q", version: "2401.12345V2", pages: 16 }),
        { id: "q", pages: 16 },
      );
      assert.deepEqual(quoted({ id: "q", pages: 16 }), { id: "q", pages: 16 });
    });

    it("rejects quotes that could charge an unexpected amount", function () {
      assert.isNull(quoted(null));
      assert.isNull(quoted({ id: "q", version: "2401.12345v3", pages: 16 }));
      assert.isNull(quoted({ id: "", pages: 16 }));
      for (const pages of [0, -1, 2.5, Number.NaN, "16", Infinity]) {
        assert.isNull(quoted({ id: "q", pages }), String(pages));
      }
    });
  });

  it("reports insufficient balance when unlocking returns HTTP 402", async function () {
    const { client } = createClient([
      jsonResponse({ msg: "余额不足" }, { status: 402 }),
    ]);

    await expectClientError(
      client.unlockArxiv(expectedReference, "quote-1"),
      "insufficient-balance",
    );
  });

  it("waits until the unlocked full translation replaces the preview", async function () {
    const { client } = createClient(
      [
        jsonResponse({ status: 0, data: previewFileInfo() }),
        jsonResponse({
          status: 0,
          data: { ...readyFileInfo(), isPreview: false, unlocked: true },
        }),
      ],
      2,
    );

    const result = await client.waitForFullTranslation(expectedReference);

    assert.equal(result.zhCN, "https://example.com/translated.pdf");
  });

  it("rejects HTML downloads and accepts a real PDF signature", async function () {
    const invalidClient = createClient([
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]).client;
    await expectClientError(
      invalidClient.downloadPdf("https://example.com/translation"),
      "permanent-error",
    );

    const validPdfContent = `%PDF-1.7\n${"0".repeat(300)}\n%%EOF\n`;
    const validClient = createClient([
      new Response(new TextEncoder().encode(validPdfContent), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    ]).client;
    const pdfBuffer = await validClient.downloadPdf(
      "https://example.com/translation.pdf",
    );
    assert.equal(pdfBuffer.byteLength, validPdfContent.length);
  });
});
