import { describe, expect, it, vi } from "vitest";

import {
  MultiredditsDomain,
  createMultiredditDomain,
  createMultiredditHelper,
  isMultiredditResponse,
} from "../src/domains/multireddits.js";
import { ReadOnlyException } from "../src/exceptions.js";
import { Listing } from "../src/listing.js";
import type { RedditRequest } from "../src/models/base.js";
import { Comment, Submission, Subreddit } from "../src/models/entities.js";
import {
  Multireddit,
  multiredditPath,
  multiredditUpdateModel,
  parseMultireddit,
  parseMultiredditList,
} from "../src/models/multireddit.js";

function client(readOnly = false) {
  return {
    readOnly,
    request: vi.fn<(request: RedditRequest) => Promise<unknown>>(),
  };
}

const multi = (name = "dev") => ({
  kind: "LabeledMulti",
  data: {
    display_name: "Development",
    name,
    path: `/user/alice/m/${name}`,
    subreddits: [{ name: "typescript" }],
    visibility: "private",
  },
});

async function first<T>(source: AsyncIterable<T>): Promise<T> {
  for await (const item of source) return item;
  throw new Error("empty listing");
}

describe("standalone multireddit domain", () => {
  it("references, loads, objectifies, and avoids duplicate hydration", async () => {
    const api = client();
    api.request.mockResolvedValue(multi());
    const helper = createMultiredditDomain(api);
    const feed = helper({ redditor: "alice", name: "dev" });

    expect(feed).toBeInstanceOf(Multireddit);
    expect(String(feed)).toBe("/user/alice/m/dev");
    expect(String(feed.owner)).toBe("alice");
    await expect(feed.load()).resolves.toBe(feed);
    expect(feed.get<Subreddit[]>("subreddits")?.[0]).toBeInstanceOf(Subreddit);
    await feed.load();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/multi/user/alice/m/dev/",
    });
  });

  it("creates and lists owned and public feeds with exact API models", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce(multi())
      .mockResolvedValueOnce([multi()])
      .mockResolvedValueOnce([multi()]);
    const domain = new MultiredditsDomain(api);
    const signal = new AbortController().signal;

    const created = await domain.create({
      descriptionMd: "Useful feeds",
      displayName: "Development",
      keyColor: "#AABBCC",
      signal,
      subreddits: ["typescript", new Subreddit(api, "javascript")],
      visibility: "public",
      weightingScheme: "fresh",
    });
    expect(created).toBeInstanceOf(Multireddit);
    const createData = api.request.mock.calls[0]![0].data as
      { readonly model?: string } | undefined;
    expect(JSON.parse(String(createData?.model))).toEqual({
      description_md: "Useful feeds",
      display_name: "Development",
      key_color: "#AABBCC",
      subreddits: [{ name: "typescript" }, { name: "javascript" }],
      visibility: "public",
      weighting_scheme: "fresh",
    });

    expect((await domain.mine({ signal }))[0]).toBeInstanceOf(Multireddit);
    expect(
      (await domain.public("alice", { expandSubreddits: true }))[0],
    ).toBeInstanceOf(Multireddit);
    expect(api.request.mock.calls[1]![0]).toEqual({
      method: "GET",
      path: "/api/multi/mine/",
      params: { expand_srs: false },
      signal,
    });
    expect(api.request.mock.calls[2]![0]).toEqual({
      method: "GET",
      path: "/api/multi/user/alice/",
      params: { expand_srs: true },
    });
  });

  it("updates, adds, removes, copies, renames, and deletes", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(multi())
      .mockResolvedValueOnce({ name: "bob" })
      .mockResolvedValueOnce({
        ...multi("development"),
        data: { ...multi("development").data, path: "/user/bob/m/development" },
      })
      .mockResolvedValueOnce(multi("renamed"))
      .mockResolvedValueOnce(null);
    const feed = new Multireddit(api, {
      display_name: "Development",
      name: "dev",
      path: "/user/alice/m/dev",
    });
    const signal = new AbortController().signal;

    await feed.add("typescript", { signal });
    await feed.remove(new Subreddit(api, "javascript"), { signal });
    await feed.update({ descriptionMd: "new", visibility: "public", signal });
    const copied = await feed.copy({ displayName: "Development Feed", signal });
    const renamed = await feed.rename("renamed", {
      displayName: "Renamed",
      signal,
    });
    await feed.delete({ signal });

    expect(copied.path).toBe("/user/bob/m/development");
    expect(renamed.path).toBe("/user/alice/m/renamed");
    expect(
      api.request.mock.calls.map(([request]) => [request.method, request.path]),
    ).toEqual([
      ["PUT", "/api/multi/user/alice/m/dev/r/typescript"],
      ["DELETE", "/api/multi/user/alice/m/dev/r/javascript"],
      ["PUT", "/api/multi/user/alice/m/dev/"],
      ["GET", "/api/v1/me"],
      ["POST", "/api/multi/copy/"],
      ["POST", "/api/multi/rename/"],
      ["DELETE", "/api/multi/user/alice/m/dev/"],
    ]);
  });

  it("provides all listings and polling streams with objectification", async () => {
    const api = client();
    api.request.mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t3", data: { id: "post", title: "Post" } }],
      },
    });
    const feed = new Multireddit(api, {
      name: "dev",
      path: "/user/alice/m/dev",
    });
    const listings = [
      feed.hot(),
      feed.new(),
      feed.rising(),
      feed.top({ timeFilter: "week" }),
      feed.controversial(),
      feed.comments(),
    ];
    expect(listings.every((listing) => listing instanceof Listing)).toBe(true);
    expect(listings.map((listing) => listing.url)).toEqual([
      "/user/alice/m/dev/hot",
      "/user/alice/m/dev/new",
      "/user/alice/m/dev/rising",
      "/user/alice/m/dev/top",
      "/user/alice/m/dev/controversial",
      "/user/alice/m/dev/comments",
    ]);
    expect(await first(feed.hot())).toBeInstanceOf(Submission);

    api.request.mockResolvedValueOnce({
      kind: "Listing",
      data: {
        after: null,
        children: [{ kind: "t1", data: { id: "c", parent_id: "t3_post" } }],
      },
    });
    const commentStream = feed.stream.comments({ pauseAfter: -1 });
    expect(await commentStream.next()).toMatchObject({
      value: expect.any(Comment),
    });
    await commentStream.return(undefined);
  });

  it("enforces strict settings, read-only auth, and preflight cancellation", async () => {
    const api = client();
    const domain = new MultiredditsDomain(api);
    const feed = domain.reference("alice", "dev");
    expect(() =>
      domain.reference({
        redditor: "alice",
        name: "dev",
        extra: true,
      } as never),
    ).toThrow("unknown option");
    await expect(feed.update({ keyColor: "blue" })).rejects.toThrow(
      "six-digit",
    );
    await expect(
      feed.update({ visibility: "friends" } as never),
    ).rejects.toThrow("Invalid multireddit visibility");
    expect(() => feed.top({ timeFilter: "forever" } as never)).toThrow(
      "Invalid time filter",
    );

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      domain.load({
        redditor: "alice",
        name: "dev",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(api.request).not.toHaveBeenCalled();

    const readonly = new MultiredditsDomain(client(true));
    const readonlyFeed = readonly.reference("alice", "dev");
    await expect(readonly.mine()).rejects.toBeInstanceOf(ReadOnlyException);
    await expect(
      readonly.create({ displayName: "Dev", subreddits: [] }),
    ).rejects.toBeInstanceOf(ReadOnlyException);
    await expect(readonlyFeed.add("typescript")).rejects.toBeInstanceOf(
      ReadOnlyException,
    );
    await expect(readonlyFeed.delete()).rejects.toBeInstanceOf(
      ReadOnlyException,
    );
  });

  it("exposes helper overloads, aliases, response detection, and encoded paths", async () => {
    const api = client();
    api.request.mockResolvedValue([]);
    const helper = createMultiredditHelper(api);
    expect(helper.domain).toBeInstanceOf(MultiredditsDomain);
    expect(helper("alice", "dev").path).toBe("/user/alice/m/dev");
    expect(helper.reference({ redditor: "alice", name: "dev" }).name).toBe(
      "dev",
    );
    expect(() => helper("alice" as never)).toThrow("name is required");
    expect(() => helper.domain.reference("alice" as never)).toThrow(
      "name is required",
    );
    expect(multiredditPath("a/b", "dev feed")).toBe("/user/a%2Fb/m/dev%20feed");
    await expect(helper.listMine()).resolves.toEqual([]);
    await expect(helper.listPublic("alice")).resolves.toEqual([]);
    expect(isMultiredditResponse({ kind: "LabeledMulti" })).toBe(true);
    expect(isMultiredditResponse({ name: "dev", path: "/user/a/m/dev" })).toBe(
      true,
    );
    expect(isMultiredditResponse({ name: "dev" })).toBe(false);
    expect(isMultiredditResponse(null)).toBe(false);
  });

  it("validates update models across every optional setting", () => {
    expect(
      multiredditUpdateModel({
        descriptionMd: null,
        displayName: " Feed ",
        iconName: "tech",
        keyColor: null,
        subreddits: [{ name: "typescript" }],
        visibility: "hidden",
        weightingScheme: "classic",
      }),
    ).toEqual({
      description_md: null,
      display_name: "Feed",
      icon_name: "tech",
      key_color: null,
      subreddits: [{ name: "typescript" }],
      visibility: "hidden",
      weighting_scheme: "classic",
    });
    expect(() => multiredditUpdateModel({ displayName: " " })).toThrow(
      "cannot be empty",
    );
    expect(() =>
      multiredditUpdateModel({ displayName: "x".repeat(51) }),
    ).toThrow("50");
    expect(() =>
      multiredditUpdateModel({ iconName: "invalid" as "tech" }),
    ).toThrow("icon");
    expect(() =>
      multiredditUpdateModel({ weightingScheme: "new" as "fresh" }),
    ).toThrow("weighting");
    expect(() => multiredditUpdateModel({ subreddits: [" "] })).toThrow(
      "subreddit",
    );
    expect(() => multiredditUpdateModel({ extra: true } as never)).toThrow(
      "unknown option",
    );
  });

  it("parses wrapped feeds and rejects malformed feed response variants", () => {
    const api = client();
    expect(parseMultireddit(api, { data: multi().data })).toBeInstanceOf(
      Multireddit,
    );
    expect(parseMultiredditList(api, { children: [multi()] })).toHaveLength(1);
    expect(() => parseMultireddit(api, null)).toThrow(
      "invalid multireddit data",
    );
    expect(() => parseMultireddit(api, { name: "dev" })).toThrow(
      "invalid multireddit data",
    );
    expect(() => parseMultireddit(api, { name: "dev", path: "bad" })).toThrow(
      "valid path",
    );
    expect(() => parseMultiredditList(api, {})).toThrow("list data");
    expect(() =>
      parseMultireddit(api, {
        name: "dev",
        path: "/user/a/m/dev",
        subreddits: {},
      }),
    ).toThrow("subreddits data");
    expect(() =>
      parseMultireddit(api, {
        name: "dev",
        path: "/user/a/m/dev",
        subreddits: [{}],
      }),
    ).toThrow("subreddit data");
    const subreddit = new Subreddit(api, "typescript");
    expect(
      parseMultireddit(api, {
        name: "dev",
        path: "/user/a/m/dev",
        subreddits: [subreddit],
      }).get("subreddits"),
    ).toEqual([subreddit]);
  });

  it("tracks loaded subreddit state through add and remove mutations", async () => {
    const api = client();
    api.request.mockResolvedValue(null);
    const feed = new Multireddit(api, {
      name: "dev",
      path: "user/alice/m/dev/",
      subreddits: [{ name: "typescript" }],
    });
    expect(feed.isLoaded).toBe(true);
    expect(feed.path).toBe("/user/alice/m/dev");
    expect(feed.name).toBe("dev");
    expect(feed.stream.multireddit).toBe(feed);
    await feed.add("javascript");
    await feed.add("JavaScript");
    expect(feed.get<Subreddit[]>("subreddits")?.map(String)).toEqual([
      "typescript",
      "javascript",
    ]);
    await feed.remove("TYPESCRIPT");
    expect(feed.get<Subreddit[]>("subreddits")?.map(String)).toEqual([
      "javascript",
    ]);

    const sparse = new Multireddit(api, {
      name: "sparse",
      path: "/user/a/m/sparse",
    });
    expect(sparse.isLoaded).toBe(false);
    await sparse.add("one");
    await sparse.remove("one");
    expect(sparse.get("subreddits")).toBeUndefined();
  });

  it("validates lifecycle options, auth, abort, and malformed account data", async () => {
    const api = client();
    const feed = new Multireddit(api, {
      name: "dev",
      path: "/user/alice/m/dev",
    });
    await expect(feed.update({})).rejects.toThrow("at least one setting");
    await expect(feed.copy({ displayName: "x".repeat(51) })).rejects.toThrow(
      "50",
    );
    await expect(
      feed.rename("new", { displayName: "x".repeat(51) }),
    ).rejects.toThrow("50");
    await expect(feed.rename("new", { displayName: " " })).rejects.toThrow(
      "cannot be empty",
    );
    await expect(feed.refresh({ extra: true } as never)).rejects.toThrow(
      "unknown option",
    );
    await expect(feed.add("one", { extra: true } as never)).rejects.toThrow(
      "unknown option",
    );
    await expect(feed.remove("one", { extra: true } as never)).rejects.toThrow(
      "unknown option",
    );
    await expect(feed.copy({ extra: true } as never)).rejects.toThrow(
      "unknown option",
    );
    await expect(feed.rename("new", { extra: true } as never)).rejects.toThrow(
      "unknown option",
    );
    await expect(feed.delete({ extra: true } as never)).rejects.toThrow(
      "unknown option",
    );

    api.request.mockResolvedValueOnce({ data: {} });
    await expect(feed.copy()).rejects.toThrow("current redditor data");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    for (const operation of [
      feed.refresh({ signal: controller.signal }),
      feed.update({ displayName: "x", signal: controller.signal }),
      feed.copy({ signal: controller.signal }),
      feed.rename("new", { signal: controller.signal }),
      feed.delete({ signal: controller.signal }),
    ])
      await expect(operation).rejects.toThrow("stopped");

    const readonlyFeed = new Multireddit(client(true), {
      name: "dev",
      path: "/user/a/m/dev",
    });
    await expect(readonlyFeed.update({ displayName: "x" })).rejects.toThrow(
      "read-only",
    );
    await expect(readonlyFeed.copy()).rejects.toThrow("read-only");
    await expect(readonlyFeed.rename("new")).rejects.toThrow("read-only");
    await expect(readonlyFeed.remove("one")).rejects.toThrow("read-only");
  });

  it("builds defaults for create/copy/rename and both stream listing types", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce(multi())
      .mockResolvedValueOnce({ data: { name: "bob" } })
      .mockResolvedValueOnce({
        ...multi("development"),
        data: { ...multi("development").data, path: "/user/bob/m/development" },
      })
      .mockResolvedValueOnce(multi("new"));
    await new MultiredditsDomain(api).create({
      displayName: "Development",
      subreddits: [],
    });
    const createModel = JSON.parse(
      (api.request.mock.calls[0]?.[0].data as { model: string }).model,
    );
    expect(createModel).toMatchObject({
      visibility: "private",
      weighting_scheme: "classic",
    });
    const feed = new Multireddit(api, {
      display_name: "Development",
      name: "dev",
      path: "/user/alice/m/dev",
    });
    await feed.copy({ descriptionMd: "copy" });
    await feed.rename("new");
    expect(api.request.mock.calls[2]?.[0].data).toMatchObject({
      description_md: "copy",
    });
    expect(api.request.mock.calls[3]?.[0].data).not.toHaveProperty(
      "display_name",
    );

    api.request.mockResolvedValue({ kind: "Listing", data: { children: [] } });
    const submissionStream = feed.stream.submissions({
      continueAfterId: "t3_before",
      pauseAfter: -1,
    });
    await submissionStream.next();
    const commentStream = feed.stream.comments({
      continueAfterId: "t1_before",
      pauseAfter: -1,
    });
    await commentStream.next();
    expect(api.request.mock.calls.at(-2)?.[0]).toMatchObject({
      path: "/user/alice/m/dev/new",
      params: { before: "t3_before", limit: 100 },
    });
    expect(api.request.mock.calls.at(-1)?.[0]).toMatchObject({
      path: "/user/alice/m/dev/comments",
      params: { before: "t1_before", limit: 100 },
    });
    await submissionStream.return(undefined);
    await commentStream.return(undefined);
  });

  it("covers listing filters and slug helpers", () => {
    const api = client();
    const feed = new Multireddit(api, { name: "dev", path: "/user/a/m/dev" });
    expect(feed.top({ params: { raw_json: 1 } }).params).toEqual({
      raw_json: 1,
      t: "all",
    });
    expect(feed.controversial({ timeFilter: "day" }).params).toEqual({
      t: "day",
    });
    expect(Multireddit.sluggify("Hello, Wide World Example Title")).toBe(
      "hello_wide_world",
    );
    expect(Multireddit.sluggify("abcdefghijklmnopqrstu-more")).toBe(
      "abcdefghijklmnopqrstu",
    );
    expect(Multireddit.sluggify("!!!")).toBe("_");
  });
});
