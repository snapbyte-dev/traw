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
import { Comment, Submission, Subreddit } from "../src/models/entities.js";

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

  it("constructs best, controversial, comment, search, and private history listings", () => {
    const api = client();
    const front = new Front(api);
    const subreddit = new ListingSubreddit(api, "type script");
    const redditor = new ListingRedditor(api, "some user");

    expect(front.best()).toMatchObject({ url: "/best" });
    expect(front.controversial({ timeFilter: "week" })).toMatchObject({
      params: { t: "week" },
      url: "/controversial",
    });
    expect(subreddit.controversial()).toMatchObject({
      params: { t: "all" },
      url: "/r/type%20script/controversial",
    });
    expect(subreddit.comments()).toMatchObject({
      url: "/r/type%20script/comments",
    });
    expect(
      subreddit.search(" typed query ", {
        params: { raw_json: 1 },
        sort: "comments",
        syntax: "plain",
        timeFilter: "month",
      }),
    ).toMatchObject({
      params: {
        q: "typed query",
        raw_json: 1,
        restrict_sr: true,
        sort: "comments",
        syntax: "plain",
        t: "month",
      },
      url: "/r/type%20script/search",
    });
    expect(
      new ListingSubreddit(api, "all").search("query").params,
    ).toMatchObject({
      restrict_sr: false,
    });
    expect(redditor.controversial({ timeFilter: "day" })).toMatchObject({
      params: { sort: "controversial", t: "day" },
    });
    for (const [name, listing] of [
      ["saved", redditor.saved()],
      ["hidden", redditor.hidden()],
      ["upvoted", redditor.upvoted()],
      ["downvoted", redditor.downvoted()],
    ] as const) {
      expect(listing.url).toBe(`/user/some%20user/${name}`);
    }

    expect(() => subreddit.search(" ")).toThrow("query cannot be empty");
    expect(() => subreddit.search("q", { sort: "bad" as "hot" })).toThrow(
      "Invalid search sort",
    );
    expect(() => subreddit.search("q", { syntax: "bad" as "plain" })).toThrow(
      "Invalid search syntax",
    );
  });

  it("reads sticky, post requirements, and traffic with cancellation and validation", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: { children: [{ kind: "t3", data: { id: "sticky" } }] },
      })
      .mockResolvedValueOnce({ is_flair_required: true })
      .mockResolvedValueOnce({
        day: [[1, 2]],
        hour: [[1, 2]],
        month: [[1, 2]],
      });
    const subreddit = new ListingSubreddit(api, "test");
    const signal = new AbortController().signal;

    await expect(
      subreddit.sticky({ number: 2, signal }),
    ).resolves.toBeInstanceOf(Submission);
    await expect(subreddit.postRequirements({ signal })).resolves.toEqual({
      is_flair_required: true,
    });
    await expect(subreddit.traffic({ signal })).resolves.toEqual({
      day: [[1, 2]],
      hour: [[1, 2]],
      month: [[1, 2]],
    });
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      params: { num: 2 },
      path: "/r/test/about/sticky/",
      signal,
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/api/v1/test/post_requirements",
      signal,
    });
    expect(api.request).toHaveBeenNthCalledWith(3, {
      method: "GET",
      path: "/r/test/about/traffic/",
      signal,
    });

    await expect(subreddit.sticky({ number: 3 as 1 })).rejects.toThrow(
      "must be 1 or 2",
    );
    api.request.mockResolvedValueOnce({ day: [], hour: [] });
    await expect(subreddit.traffic()).rejects.toThrow("month array");
    api.request.mockResolvedValueOnce(null);
    await expect(subreddit.postRequirements()).rejects.toThrow("invalid");
    api.request.mockResolvedValueOnce({});
    await expect(subreddit.sticky()).rejects.toThrow("no Submission");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      subreddit.postRequirements({ signal: controller.signal }),
    ).rejects.toThrow("stop");
  });

  it("binds subreddit and redditor streams to newest listings", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t1", data: { id: "c", parent_id: "t3_p" } }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t3", data: { id: "p" } }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t3", data: { id: "subreddit-post" } }],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [{ kind: "t1", data: { id: "user-c", parent_id: "t3_p" } }],
        },
      });
    const subreddit = new ListingSubreddit(api, "test");
    const redditor = new ListingRedditor(api, "user");
    const commentStream = subreddit.stream.comments({ pauseAfter: -1 });
    const submissionStream = redditor.stream.submissions({ pauseAfter: -1 });
    const subredditSubmissions = subreddit.stream.submissions({
      pauseAfter: -1,
    });
    const redditorComments = redditor.stream.comments({ pauseAfter: -1 });

    await expect(commentStream.next()).resolves.toMatchObject({
      value: expect.any(Comment),
    });
    await expect(submissionStream.next()).resolves.toMatchObject({
      value: expect.any(Submission),
    });
    await expect(subredditSubmissions.next()).resolves.toMatchObject({
      value: expect.any(Submission),
    });
    await expect(redditorComments.next()).resolves.toMatchObject({
      value: expect.any(Comment),
    });
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      params: { limit: 100 },
      path: "/r/test/comments",
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      params: { limit: 100, sort: "new" },
      path: "/user/user/submitted",
    });
    expect(api.request).toHaveBeenNthCalledWith(3, {
      method: "GET",
      params: { limit: 100 },
      path: "/r/test/new",
    });
    expect(api.request).toHaveBeenNthCalledWith(4, {
      method: "GET",
      params: { limit: 100, sort: "new" },
      path: "/user/user/comments",
    });
    await commentStream.return(undefined);
    await submissionStream.return(undefined);
    await subredditSubmissions.return(undefined);
    await redditorComments.return(undefined);
  });

  it("defers private-history authorization failures until iteration", async () => {
    const api = client();
    const forbidden = new Error("Forbidden");
    api.request.mockRejectedValue(forbidden);
    const saved = new ListingRedditor(api, "other-user").saved();

    expect(api.request).not.toHaveBeenCalled();
    await expect(collect(saved)).rejects.toBe(forbidden);
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
