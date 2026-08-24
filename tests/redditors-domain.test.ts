import { describe, expect, it, vi } from "vitest";

import { RedditorsDomain } from "../src/domains/redditors.js";
import type { RedditRequest } from "../src/models/base.js";
import { Redditor } from "../src/models/entities.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("RedditorsDomain", () => {
  it("creates discovery listings and validates search queries", () => {
    const redditors = new RedditorsDomain({ request: vi.fn() });

    expect(redditors.new()).toMatchObject({ url: "/users/new" });
    expect(() => redditors.search(" ")).toThrow("query cannot be empty");
  });

  it("searches for redditors with listing options", async () => {
    const request = vi
      .fn<(request: RedditRequest) => Promise<unknown>>()
      .mockResolvedValue({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t2", data: { name: "found" } }],
        },
      });
    const [redditor] = await collect(
      new RedditorsDomain({ request }).search("person", { limit: 1 }),
    );

    expect(redditor).toBeInstanceOf(Redditor);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/users/search",
      params: { limit: 1, q: "person" },
    });
  });
});
