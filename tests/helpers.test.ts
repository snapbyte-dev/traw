import { describe, expect, it, vi } from "vitest";

import {
  Domain,
  Front,
  InfoListing,
  ListingHelper,
  ListingRedditor,
  ListingSubreddit,
  RedditorContent,
  createSubredditHelper,
} from "../src/helpers.js";
import { Submission, Subreddit } from "../src/models/entities.js";

function client() {
  return { request: vi.fn() };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("listing helpers", () => {
  it("constructs every standard listing and normalizes paths", () => {
    const api = client();
    const helper = new ListingHelper(api, "/r/typescript/");

    expect(helper.hot()).toMatchObject({ url: "/r/typescript/hot" });
    expect(helper.new({ limit: 2 })).toMatchObject({
      limit: 2,
      url: "/r/typescript/new",
    });
    expect(helper.rising()).toMatchObject({ url: "/r/typescript/rising" });
    expect(helper.top()).toMatchObject({
      params: { t: "all" },
      url: "/r/typescript/top",
    });
    expect(
      helper.top({ params: { existing: true }, timeFilter: "hour" }),
    ).toMatchObject({ params: { existing: true, t: "hour" } });
    expect(() => helper.top({ timeFilter: "invalid" as "all" })).toThrow(
      "Invalid time filter",
    );
    expect(new Front(api).hot()).toMatchObject({ url: "/hot" });
  });

  it("validates and encodes domains, subreddits, and redditors", () => {
    const api = client();
    const domain = new Domain(api, " example.com ");
    const subreddit = new ListingSubreddit(api, "web dev");
    const redditor = new ListingRedditor(api, "some user");

    expect(domain).toMatchObject({
      name: "example.com",
      path: "/domain/example.com",
    });
    expect(domain.new()).toMatchObject({ url: "/domain/example.com/new" });
    expect(subreddit.hot()).toMatchObject({ url: "/r/web%20dev/hot" });
    expect(subreddit.new()).toMatchObject({ url: "/r/web%20dev/new" });
    expect(subreddit.rising()).toMatchObject({ url: "/r/web%20dev/rising" });
    expect(subreddit.top({ timeFilter: "day" })).toMatchObject({
      params: { t: "day" },
      url: "/r/web%20dev/top",
    });
    expect(redditor.hot()).toMatchObject({
      params: { sort: "hot" },
      url: "/user/some%20user/overview",
    });
    expect(redditor.new()).toMatchObject({ params: { sort: "new" } });
    expect(redditor.top({ timeFilter: "year" })).toMatchObject({
      params: { sort: "top", t: "year" },
    });
    expect(redditor.comments.rising()).toMatchObject({
      params: { sort: "rising" },
      url: "/user/some%20user/comments",
    });
    expect(redditor.submissions.new()).toMatchObject({
      url: "/user/some%20user/submitted",
    });
    expect(createSubredditHelper(api)("typescript")).toBeInstanceOf(
      ListingSubreddit,
    );
    expect(() => new Domain(api, " ")).toThrow("domain cannot be empty");
    expect(() => new ListingSubreddit(api, " ")).toThrow(
      "subreddit cannot be empty",
    );
    expect(() => new ListingRedditor(api, " ")).toThrow(
      "redditor cannot be empty",
    );
  });

  it("applies all redditor content sorts without replacing caller params", () => {
    const api = client();
    const content = new RedditorContent<Submission>(
      api,
      "/user/test/submitted",
    );
    expect(content.hot({ params: { raw_json: 1 } })).toMatchObject({
      params: { raw_json: 1, sort: "hot" },
    });
    expect(content.new()).toMatchObject({ params: { sort: "new" } });
    expect(content.rising()).toMatchObject({ params: { sort: "rising" } });
    expect(content.top({ timeFilter: "month" })).toMatchObject({
      params: { sort: "top", t: "month" },
    });
    expect(() => content.top({ timeFilter: "bad" as "all" })).toThrow(
      RangeError,
    );
  });
});

describe("InfoListing", () => {
  it("supports URL and subreddit modes and objectifies their children", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: { children: [{ kind: "t3", data: { id: "one", title: "One" } }] },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: { children: [{ kind: "t5", data: { display_name: "two" } }] },
      });
    const signal = new AbortController().signal;

    expect(
      await collect(
        new InfoListing(api, { url: "https://redd.it/one", signal }),
      ),
    ).toEqual([expect.any(Submission)]);
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      params: { url: "https://redd.it/one" },
      path: "/api/info",
      signal,
    });
    const subreddit = new Subreddit(api, "two");
    expect(
      await collect(new InfoListing(api, { subreddits: [subreddit] })),
    ).toEqual([expect.any(Subreddit)]);
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      params: { sr_name: "two" },
      path: "/api/info",
    });
  });

  it("validates modes, malformed responses, cancellation, and single use", async () => {
    const api = client();
    expect(() => new InfoListing(api, {})).toThrow("Exactly one");
    expect(
      () => new InfoListing(api, { fullnames: [], url: "https://redd.it/a" }),
    ).toThrow("Exactly one");
    expect(
      () => new InfoListing(api, { fullnames: "t3_a" as unknown as string[] }),
    ).toThrow("non-string iterables");

    for (const malformed of [null, {}, { children: null }]) {
      api.request.mockResolvedValueOnce(malformed);
      await expect(
        collect(new InfoListing(api, { fullnames: ["t3_a"] })),
      ).rejects.toThrow("no children array");
    }

    const empty = new InfoListing(api, { fullnames: [] });
    await expect(collect(empty)).resolves.toEqual([]);
    expect(() => empty[Symbol.asyncIterator]()).toThrow(
      "only be iterated once",
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        new InfoListing(api, {
          fullnames: ["t3_a"],
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow();
  });
});
