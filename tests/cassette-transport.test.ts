import { describe, expect, it } from "vitest";

import {
  replayableBytes,
  replayableForm,
  replayableText,
} from "../src/core/transport.js";
import {
  type Cassette,
  CassetteTransport,
  type CassetteRequest,
} from "./helpers/cassette-transport.js";

const fixture = new URL("./fixtures/example-cassette.json", import.meta.url);

function cassetteWith(request: CassetteRequest): Cassette {
  return {
    interactions: [
      {
        request,
        response: {
          body: "ok",
          headers: {},
          status: 200,
          statusText: "OK",
          url: request.url,
        },
      },
    ],
    policy: { authorization: "ignore" },
    version: 1,
  };
}

describe("CassetteTransport", () => {
  it("replays an ordered fixture with normalized URLs, relevant headers, and redacted authorization", async () => {
    const transport = await CassetteTransport.fromFile(fixture);
    const response = await transport.send({
      body: replayableForm([
        ["name", "fixture"],
        ["enabled", "true"],
      ]),
      headers: {
        Authorization: "Bearer secret-that-must-not-be-recorded",
        "X-Irrelevant": "ignored",
        "X-Request-ID": " synthetic-1 ",
      },
      method: "POST",
      url: "https://example.test/items?tag=alpha&tag=beta&limit=2#not-sent",
    });

    expect(response.status).toBe(201);
    expect(response.headers["x-fixture"]).toBe("synthetic");
    expect(response.text()).toBe('{"id":1,"name":"fixture"}');
    expect(response.json()).toEqual({ id: 1, name: "fixture" });
    expect(() => transport.assertConsumed()).not.toThrow();
  });

  it.each([
    [
      "method",
      { method: "GET", url: "https://example.test/path" },
      { method: "POST" },
    ],
    [
      "URL",
      { method: "GET", url: "https://example.test/path?a=1" },
      { url: "https://example.test/path?a=2" },
    ],
    [
      "relevant header",
      {
        headers: { "x-test": "expected" },
        method: "GET",
        url: "https://example.test/path",
      },
      { headers: { "x-test": "actual" } },
    ],
  ])("strictly rejects a mismatched %s", async (_label, expected, override) => {
    const transport = new CassetteTransport(cassetteWith(expected));
    await expect(transport.send({ ...expected, ...override })).rejects.toThrow(
      "Cassette request mismatch",
    );
    expect(() => transport.assertConsumed()).toThrow("1 unused interaction");
  });

  it("strictly matches text and byte bodies", async () => {
    const textTransport = new CassetteTransport(
      cassetteWith({
        body: { encoding: "utf8", value: "expected" },
        method: "POST",
        url: "https://example.test/text",
      }),
    );
    await expect(
      textTransport.send({
        body: replayableText("actual"),
        method: "POST",
        url: "https://example.test/text",
      }),
    ).rejects.toThrow("Cassette request mismatch");

    const byteTransport = new CassetteTransport(
      cassetteWith({
        body: { encoding: "base64", value: "AAEC" },
        method: "POST",
        url: "https://example.test/bytes",
      }),
    );
    await byteTransport.send({
      body: replayableBytes(Uint8Array.from([0, 1, 2])),
      method: "POST",
      url: "https://example.test/bytes",
    });
    expect(() => byteTransport.assertConsumed()).not.toThrow();
  });

  it("fails unexpected requests and reports unused interactions", async () => {
    const empty = new CassetteTransport({
      interactions: [],
      policy: { authorization: "ignore" },
      version: 1,
    });
    await expect(
      empty.send({ method: "GET", url: "https://example.test/unexpected" }),
    ).rejects.toThrow("Unexpected cassette request");

    const unused = await CassetteTransport.fromFile(fixture);
    expect(() => unused.assertConsumed()).toThrow(
      "Cassette has 1 unused interaction(s); next is POST https://example.test/items?limit=2&tag=alpha&tag=beta",
    );
  });

  it("rejects authorization values in recorded relevant headers", async () => {
    const transport = new CassetteTransport(
      cassetteWith({
        headers: { Authorization: "Bearer recorded-secret" },
        method: "GET",
        url: "https://example.test/path",
      }),
    );
    await expect(
      transport.send({
        headers: { Authorization: "Bearer runtime-secret" },
        method: "GET",
        url: "https://example.test/path",
      }),
    ).rejects.toThrow("policy requires redaction");
  });
});
