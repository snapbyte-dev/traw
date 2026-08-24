import { describe, expect, it, vi } from "vitest";

import {
  RedditorModNotes,
  RedditModNotes,
  SubredditModNotes,
} from "../src/domains/mod-notes.js";
import { Comment, Submission } from "../src/models/entities.js";
import { ModNote } from "../src/models/moderation.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("moderator-note helper views", () => {
  it("merges pairs, cartesian filters, and things into ordered bulk requests", async () => {
    const request = vi.fn().mockResolvedValue({
      mod_notes: [{ id: "pair" }, { id: "cross-one" }, null, { id: "thing" }],
    });
    const client = { request };
    const thing = new Submission(client, {
      author: "dana",
      id: "post",
      subreddit: "gamma",
    });
    const notes = new RedditModNotes(client);

    const result = await collect(
      notes.list({
        pairs: [{ redditor: "alice", subreddit: "alpha" }],
        redditors: ["bob", "carol"],
        subreddits: ["beta"],
        things: [thing],
      }),
    );

    expect(result).toEqual([
      expect.any(ModNote),
      expect.any(ModNote),
      null,
      expect.any(ModNote),
    ]);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/mod/notes/recent",
      params: {
        subreddits: "alpha,beta,beta,gamma",
        users: "alice,bob,carol,dana",
      },
    });
  });

  it("uses all-note listings and scoped single/multiple defaults", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "all" }],
      })
      .mockResolvedValueOnce({
        end_cursor: null,
        has_next_page: false,
        mod_notes: [{ id: "single" }],
      })
      .mockResolvedValueOnce({ mod_notes: [{ id: "one" }, null] });
    const client = { request };

    await collect(
      new RedditModNotes(client).list({
        allNotes: true,
        pairs: [{ redditor: "alice", subreddit: "alpha" }],
        limit: 1,
      }),
    );
    await collect(new SubredditModNotes(client, "alpha").redditors(["alice"]));
    await collect(
      new RedditorModNotes(client, "alice").subreddits(["alpha", "beta"]),
    );

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/mod/notes",
      params: { limit: 1, subreddit: "alpha", user: "alice" },
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "GET",
      path: "/api/mod/notes/recent",
      params: { subreddits: "alpha,beta", users: "alice,alice" },
    });
  });

  it("looks up a fullname to fill missing create scope and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [
            {
              kind: "t1",
              data: {
                author: "alice",
                id: "comment",
                link_id: "t3_post",
                subreddit: "alpha",
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ id: "note" });

    await new RedditModNotes({ request }).create(
      { note: "Context", thing: "t1_comment" },
      signal,
    );

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/api/info",
      params: { id: "t1_comment" },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/mod/notes",
      data: {
        note: "Context",
        reddit_id: "t1_comment",
        subreddit: "alpha",
        user: "alice",
      },
      signal,
    });
  });

  it("strictly validates filters, scoped selections, auth, labels, and things", async () => {
    const request = vi.fn();
    const notes = new RedditModNotes({ request });
    expect(() => notes.list({})).toThrow("must be provided");
    expect(() => notes.list({ redditors: ["alice"] })).toThrow("subreddits");
    expect(() =>
      new SubredditModNotes({ request }, "alpha").redditors([]),
    ).toThrow("At least one");
    expect(() =>
      new RedditModNotes({ request, readOnly: true }).list({
        pairs: [{ redditor: "alice", subreddit: "alpha" }],
      }),
    ).toThrow("read-only");
    await expect(
      notes.create({
        label: "UNKNOWN" as never,
        note: "No",
        redditor: "alice",
        subreddit: "alpha",
      }),
    ).rejects.toThrow("Invalid mod note label");
    expect(() =>
      notes.list({ things: [new Comment({ request }, "comment")] }),
    ).toThrow("author and subreddit");
  });
});
