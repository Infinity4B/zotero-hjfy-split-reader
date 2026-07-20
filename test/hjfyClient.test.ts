import { assert } from "chai";
import type { VersionedArxivReference } from "../src/modules/arxivReference";
import { HJFYClient, HJFYClientError } from "../src/modules/hjfyClient";

const expectedReference: VersionedArxivReference = {
  baseId: "2401.12345",
  version: 2,
  id: "2401.12345v2",
};

function atomMetadata(identifier: string) {
  return `<feed><entry><id>https://arxiv.org/abs/${identifier}</id></entry></feed>`;
}

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

describe("HJFYClient", function () {
  it("uses and verifies the exact versioned arxivInfo response", async function () {
    const { client, requestInits, requestedUrls } = createClient([
      jsonResponse({
        status: 0,
        data: {
          hasSrc: true,
          meta: atomMetadata(expectedReference.id),
        },
      }),
    ]);

    const result = await client.waitForArxivInfo(expectedReference);

    assert.isTrue(result.exactVersion);
    assert.equal(result.returnedId, expectedReference.id);
    assert.deepEqual(requestedUrls, [
      "https://hjfy.top/api/arxivInfo/2401.12345v2",
    ]);
    assert.equal(requestInits[0]?.credentials, "include");
  });

  it("falls back to base metadata without changing the target version", async function () {
    const { client, requestedUrls } = createClient([
      jsonResponse(
        {
          status: 400,
          msg: "arxivInfo error: status not 200",
        },
        { status: 400 },
      ),
      jsonResponse({
        status: 0,
        data: {
          hasSrc: true,
          meta: atomMetadata("2401.12345v7"),
        },
      }),
    ]);

    const result = await client.waitForArxivInfo(expectedReference);

    assert.isFalse(result.exactVersion);
    assert.equal(result.returnedId, "2401.12345v7");
    assert.deepEqual(requestedUrls, [
      "https://hjfy.top/api/arxivInfo/2401.12345v2",
      "https://hjfy.top/api/arxivInfo/2401.12345",
    ]);
  });

  it("rejects a mismatched exact arxivInfo response", async function () {
    const { client } = createClient([
      jsonResponse({
        status: 0,
        data: {
          hasSrc: true,
          meta: atomMetadata("2401.12345v7"),
        },
      }),
    ]);

    await expectClientError(
      client.waitForArxivInfo(expectedReference),
      "version-mismatch",
    );
  });

  it("does not fall back for unrelated arxivInfo version errors", async function () {
    const { client, requestedUrls } = createClient([
      jsonResponse({
        status: 400,
        msg: "version mismatch in upstream metadata",
      }),
    ]);

    await expectClientError(
      client.waitForArxivInfo(expectedReference),
      "permanent-error",
    );
    assert.lengthOf(requestedUrls, 1);
  });

  it("rejects a translation file from another version", async function () {
    const { client } = createClient([
      jsonResponse({ status: 0, data: readyFileInfo("2401.12345v7") }),
    ]);

    await expectClientError(
      client.fetchArxivFileInfo(expectedReference),
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
      client.waitForArxivInfo(expectedReference),
      "login-required",
    );
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
