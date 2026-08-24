import { describe, expect, it, vi } from "vitest";

import {
  AccountDomain,
  PreferencesDomain,
  Trophy,
  blockRedditor,
  redditorModeratedCommunities,
  redditorPublicMultireddits,
  redditorTrophies,
} from "../src/domains/account.js";
import { ConflictError, ReadOnlyError } from "../src/exceptions.js";
import { Listing } from "../src/listing.js";
import type { RedditRequest } from "../src/models/base.js";
import {
  Redditor,
  Submission,
  Subreddit,
  UserSubreddit,
} from "../src/models/entities.js";
import { Multireddit } from "../src/models/multireddit.js";

function client(readOnly = false): {
  readonly readOnly: boolean;
  readonly request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  return {
    readOnly,
    request: vi.fn<(request: RedditRequest) => Promise<unknown>>(),
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("AccountDomain", () => {
  it("loads, objectifies, caches, refreshes, and cancels the current account", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "t2",
        data: { id: "one", name: "alice", link_karma: 5 },
      })
      .mockResolvedValueOnce({ id: "two", name: "alice", comment_karma: 8 });
    const account = new AccountDomain(api);
    const signal = new AbortController().signal;

    const first = await account.me({ signal });
    expect(first).toBeInstanceOf(Redditor);
    expect(first.fullname).toBe("t2_one");
    await expect(account.me()).resolves.toBe(first);
    await expect(account.me({ useCache: false })).resolves.toMatchObject({
      comment_karma: 8,
    });
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/v1/me",
      signal,
    });
    expect(api.request).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      account.me({ signal: controller.signal, useCache: false }),
    ).rejects.toThrow("cancelled");
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("objectifies the current account profile subreddit", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        id: "one",
        name: "alice",
        subreddit: {
          display_name: "u_alice",
          public_description: "Alice's profile",
          subscribers: 4,
        },
      })
      .mockResolvedValueOnce({
        kind: "t2",
        data: { id: "one", name: "alice", subreddit: null },
      });
    const account = new AccountDomain(api);

    const me = await account.me();
    expect(me.subreddit).toBeInstanceOf(UserSubreddit);
    expect(me.subreddit).toBeInstanceOf(Subreddit);
    expect(me.subreddit).toMatchObject({
      display_name: "u_alice",
      public_description: "Alice's profile",
      subscribers: 4,
    });
    expect(me.subreddit?.isLoaded).toBe(true);
    await expect(me.subreddit?.load()).resolves.toBe(me.subreddit);
    expect(api.request).toHaveBeenCalledTimes(1);

    const refreshed = await account.me({ useCache: false });
    expect(refreshed.subreddit).toBeNull();
  });

  it("reads karma and all authenticated community listings", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "KarmaList",
        data: [{ sr: "typescript", comment_karma: 12, link_karma: 3 }],
      })
      .mockResolvedValue({
        kind: "Listing",
        data: {
          after: null,
          children: [
            {
              kind: "t5",
              data: { display_name: "typescript", subscribers: 10 },
            },
          ],
        },
      });
    const account = new AccountDomain(api);
    const karma = await account.karma();
    const entry = [...karma][0];
    expect(entry).toBeDefined();
    const [community, values] = entry!;
    expect(community).toBeInstanceOf(Subreddit);
    expect(String(community)).toBe("typescript");
    expect(values).toEqual({ commentKarma: 12, linkKarma: 3 });

    const listings = [
      account.subreddits({ limit: 1 }),
      account.contributorCommunities({ limit: 1 }),
      account.contributorCommunities({ limit: 1 }),
      account.moderatorCommunities({ limit: 1 }),
      account.moderatorCommunities({ limit: 1 }),
    ];
    expect(listings.every((listing) => listing instanceof Listing)).toBe(true);
    expect(listings.map((listing) => listing.url)).toEqual([
      "/subreddits/mine/subscriber/",
      "/subreddits/mine/contributor/",
      "/subreddits/mine/contributor/",
      "/subreddits/mine/moderator/",
      "/subreddits/mine/moderator/",
    ]);
    expect((await collect(listings[0]!))[0]).toBeInstanceOf(Subreddit);
  });

  it("reads and updates realistic account preferences", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        show_link_flair: true,
        num_comments: 200,
        lang: "en",
      })
      .mockResolvedValueOnce({
        show_link_flair: false,
        num_comments: 200,
        lang: "en",
      });
    const account = new AccountDomain(api);
    const signal = new AbortController().signal;

    expect(account.preferences).toBeInstanceOf(PreferencesDomain);
    await expect(account.preferences.get()).resolves.toMatchObject({
      show_link_flair: true,
    });
    await expect(
      account.preferences.update({ show_link_flair: false }, signal),
    ).resolves.toMatchObject({
      show_link_flair: false,
    });
    expect(api.request).toHaveBeenLastCalledWith({
      method: "PATCH",
      path: "/api/v1/me/prefs",
      data: { json: '{"show_link_flair":false}' },
      signal,
    });
  });

  it("lists friends, blocked users, and trusted users from UserList responses", async () => {
    const api = client();
    const users = {
      kind: "UserList",
      data: { children: [{ name: "bob", id: "b", date: 1_700_000_000 }] },
    };
    api.request
      .mockResolvedValueOnce(users)
      .mockResolvedValueOnce({ name: "bob", id: "b", note: "friend" })
      .mockResolvedValueOnce(users)
      .mockResolvedValueOnce(users);
    const account = new AccountDomain(api);

    expect((await account.friends())[0]).toBeInstanceOf(Redditor);
    await expect(account.friends("bob")).resolves.toMatchObject({
      note: "friend",
    });
    expect((await account.blocked())[0]).toMatchObject({ name: "bob" });
    expect((await account.trusted())[0]).toMatchObject({ date: 1_700_000_000 });
    expect(api.request.mock.calls.map(([request]) => request.path)).toEqual([
      "/api/v1/me/friends/",
      "/api/v1/me/friends/bob",
      "/prefs/blocked/",
      "/prefs/trusted",
    ]);
  });

  it("pins and unpins profile submissions with slot and cancellation support", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce({
        kind: "t3",
        data: { id: "post", title: "Pinned" },
      })
      .mockResolvedValueOnce(null);
    const account = new AccountDomain(api);
    const post = new Submission(api, "post");
    const signal = new AbortController().signal;

    await expect(account.pin(post, { num: 2, signal })).resolves.toBeInstanceOf(
      Submission,
    );
    await account.unpin(post, signal);
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/set_subreddit_sticky/",
      data: { id: "t3_post", num: 2, state: true, to_profile: true },
      signal,
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/set_subreddit_sticky/",
      data: { id: "t3_post", state: false, to_profile: true },
      signal,
    });

    api.request.mockResolvedValueOnce(null);
    await expect(account.pin(post)).resolves.toBeUndefined();
    api.request.mockRejectedValueOnce(
      new ConflictError({
        status: 409,
        body: "",
        headers: {},
        url: "https://oauth.reddit.com",
      }),
    );
    await expect(account.pin(post)).resolves.toBeUndefined();
  });

  it("loads owned and public multireddits plus trophies and moderated communities", async () => {
    const api = client();
    const multis = [
      {
        kind: "LabeledMulti",
        data: { name: "dev", path: "/user/alice/m/dev" },
      },
    ];
    api.request
      .mockResolvedValueOnce(multis)
      .mockResolvedValueOnce({
        kind: "TrophyList",
        data: {
          trophies: [
            { kind: "t6", data: { id: "verified", name: "Verified Email" } },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          children: [
            { kind: "t5", data: { display_name: "typescript", title: "TS" } },
          ],
        },
      })
      .mockResolvedValueOnce(multis);
    const account = new AccountDomain(api);

    expect((await account.multireddits())[0]).toBeInstanceOf(Multireddit);
    expect((await redditorTrophies(api, "alice"))[0]).toBeInstanceOf(Trophy);
    expect(
      (await redditorModeratedCommunities(api, "alice"))[0],
    ).toBeInstanceOf(Subreddit);
    expect((await redditorPublicMultireddits(api, "alice"))[0]).toBeInstanceOf(
      Multireddit,
    );

    api.request
      .mockResolvedValueOnce({
        kind: "TrophyList",
        data: { trophies: [{ data: { name: "One-Year Club" } }] },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(multis);
    expect(
      (await account.trophies(new Redditor(api, "alice")))[0],
    ).toBeInstanceOf(Trophy);
    await expect(account.moderatedCommunities("alice")).resolves.toEqual([]);
    expect((await account.publicMultireddits("alice"))[0]).toBeInstanceOf(
      Multireddit,
    );
  });

  it("performs all redditor relationship requests with API-compatible bodies", async () => {
    const api = client();
    api.request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "bob", id: "b", date: 123 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "alice", id: "a" })
      .mockResolvedValueOnce(null);
    const account = new AccountDomain(api);
    const signal = new AbortController().signal;

    await account.block("bob", signal);
    await account.friend("bob", { note: "met at a meetup", signal });
    await account.unfriend("bob", signal);
    await expect(account.friendInfo("bob", signal)).resolves.toMatchObject({
      date: 123,
    });
    await account.trust("bob", signal);
    await account.distrust("bob", signal);
    await account.unblock("bob", signal);

    api.request.mockResolvedValueOnce(null);
    await account.friend("bob");

    expect(api.request.mock.calls[0]![0]).toEqual({
      method: "POST",
      path: "/api/block_user/",
      params: { name: "bob" },
      signal,
    });
    const friendBody = api.request.mock.calls[1]![0].data;
    expect(friendBody).toMatchObject({ contentType: "application/json" });
    expect((friendBody as { create(): unknown }).create()).toBe(
      '{"note":"met at a meetup"}',
    );
    expect(api.request.mock.calls[6]![0]).toEqual({
      method: "GET",
      path: "/api/v1/me",
      signal,
    });
    expect(api.request.mock.calls[7]![0]).toEqual({
      method: "POST",
      path: "/r/all/api/unfriend/",
      data: { container: "t2_a", name: "bob", type: "enemy" },
      signal,
    });
  });

  it("supports friend-list signals and unwrapped relationship records", async () => {
    const api = client();
    const signal = new AbortController().signal;
    api.request
      .mockResolvedValueOnce({
        data: {
          children: [{ kind: "t2", data: { name: "bob", link_karma: 1 } }],
        },
      })
      .mockResolvedValueOnce({ data: { name: "bob", id: "b" } });
    const account = new AccountDomain(api);

    expect((await account.friends(signal))[0]).toBeInstanceOf(Redditor);
    await expect(account.friendInfo("bob")).resolves.toBeInstanceOf(Redditor);
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/v1/me/friends/",
      signal,
    });
  });

  it("rejects all authenticated capabilities in read-only mode before I/O", async () => {
    const api = client(true);
    const account = new AccountDomain(api);
    const post = new Submission(api, "post");
    const operations: (() => unknown)[] = [
      () => account.me(),
      () => account.karma(),
      () => account.preferences.get(),
      () => account.preferences.update({ lang: "en" }),
      () => account.friends(),
      () => account.blocked(),
      () => account.trusted(),
      () => account.pin(post),
      () => account.unpin(post),
      () => account.multireddits(),
      () => blockRedditor(api, "bob"),
    ];
    for (const operation of operations) {
      await expect(Promise.resolve().then(operation)).rejects.toBeInstanceOf(
        ReadOnlyError,
      );
    }
    expect(() => account.subreddits()).toThrow(ReadOnlyError);
    expect(() => account.contributorCommunities()).toThrow(ReadOnlyError);
    expect(() => account.moderatorCommunities()).toThrow(ReadOnlyError);
    expect(api.request).not.toHaveBeenCalled();
  });

  it("rejects malformed responses and empty redditor names", async () => {
    const api = client();
    api.request.mockResolvedValue({
      data: [{ sr: "typescript", comment_karma: "many" }],
    });
    const account = new AccountDomain(api);
    await expect(account.karma()).rejects.toThrow("invalid karma");
    await expect(account.trophies(" ")).rejects.toThrow(
      "redditor cannot be empty",
    );

    api.request.mockResolvedValue({ nested: {} });
    await expect(account.preferences.get()).rejects.toThrow(
      "invalid preferences",
    );
    api.request.mockResolvedValue([{ name: "missing path" }]);
    await expect(account.multireddits()).rejects.toThrow("invalid multireddit");

    api.request.mockResolvedValue({ data: [null] });
    await expect(account.karma()).rejects.toThrow("invalid karma");
    api.request.mockResolvedValue({
      data: { children: [{ title: "missing name" }] },
    });
    await expect(account.blocked()).rejects.toThrow("invalid redditor");
    api.request.mockResolvedValue({
      data: { children: [{ title: "missing name" }] },
    });
    await expect(redditorModeratedCommunities(api, "alice")).rejects.toThrow(
      "invalid subreddit",
    );
    api.request.mockResolvedValue({ data: { trophies: [null] } });
    await expect(redditorTrophies(api, "alice")).rejects.toThrow(
      "invalid trophy",
    );
    api.request.mockResolvedValue({ name: "alice" });
    await expect(account.unblock("bob")).rejects.toThrow("without an ID");
    api.request.mockResolvedValue({ nope: [] });
    await expect(account.blocked()).rejects.toThrow("invalid redditor list");
    api.request.mockResolvedValue({
      name: "alice",
      subreddit: { title: "missing display name" },
    });
    await expect(account.me({ useCache: false })).rejects.toThrow(
      "invalid user subreddit",
    );
  });
});
