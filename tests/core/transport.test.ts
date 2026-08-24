import { describe, expect, it, vi } from "vitest";

import {
  jsonParser,
  replayableBytes,
  replayableForm,
  replayableJson,
  replayableMultipart,
  replayableText,
  textParser,
  unknownJsonParser,
  type TransportResponse,
} from "../../src/core/transport.js";

function response(): TransportResponse {
  return {
    body: '{"answer":42}',
    headers: {},
    json: vi.fn(() => ({ answer: 42 })),
    status: 200,
    statusText: "OK",
    text: vi.fn(() => "plain text"),
    url: "https://example.com/",
  };
}

describe("transport helpers", () => {
  it("provides JSON, unknown JSON, and text parsers", () => {
    const result = response();
    expect(
      jsonParser((value) => (value as { answer: number }).answer)(result),
    ).toBe(42);
    expect(unknownJsonParser(result)).toEqual({ answer: 42 });
    expect(textParser(result)).toBe("plain text");
  });

  it("creates replayable text and JSON bodies", () => {
    const plain = replayableText("plain");
    const typed = replayableText("plain", "text/plain");
    const json = replayableJson({ value: true });
    expect(plain).not.toHaveProperty("contentType");
    expect(plain.create()).toBe("plain");
    expect(typed).toMatchObject({ contentType: "text/plain" });
    expect(json.contentType).toBe("application/json");
    expect(json.create()).toBe('{"value":true}');
  });

  it("snapshots bytes and returns an independent copy for every replay", () => {
    const source = new Uint8Array([1, 2, 3]);
    const body = replayableBytes(source, "application/octet-stream");
    source[0] = 9;
    const first = body.create() as Uint8Array;
    first[1] = 8;
    expect(Array.from(body.create() as Uint8Array)).toEqual([1, 2, 3]);
    expect(replayableBytes(source)).not.toHaveProperty("contentType");
  });

  it("snapshots duplicate form entries and recreates URLSearchParams", () => {
    const entries: [string, string][] = [
      ["tag", "one"],
      ["tag", "two"],
    ];
    const body = replayableForm(entries);
    entries[0]![1] = "changed";
    const first = body.create() as URLSearchParams;
    first.set("tag", "mutated");
    expect((body.create() as URLSearchParams).getAll("tag")).toEqual([
      "one",
      "two",
    ]);
  });

  it("creates deterministic replayable multipart fields and binary file data", () => {
    const bytes = new Uint8Array([0, 255, 1]);
    const body = replayableMultipart(
      [
        ["key", "media/file.png"],
        ["policy", "signed"],
      ],
      { bytes, contentType: "image/png", name: 'pic".png' },
      "test-boundary",
    );
    bytes[0] = 9;
    const first = body.create() as Uint8Array;
    const second = body.create() as Uint8Array;
    expect(body.contentType).toBe(
      "multipart/form-data; boundary=test-boundary",
    );
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(new TextDecoder().decode(first)).toContain(
      'name="key"\r\n\r\nmedia/file.png',
    );
    expect(new TextDecoder().decode(first)).toContain(
      'name="file"; filename="pic%22.png"\r\nContent-Type: image/png',
    );
    expect(Array.from(first).includes(255)).toBe(true);
  });
});
