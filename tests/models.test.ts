import { describe, expect, it, vi } from "vitest";

import type { RedditClientLike } from "../src/models/base.js";
import {
  Comment,
  MoreComments,
  Redditor,
  Subreddit,
} from "../src/models/entities.js";

describe("models", () => {
  it("keeps unknown raw fields and compares stable identity", () => {
    const client = { request: vi.fn() } as unknown as RedditClientLike;
    const first = new Comment(client, {
      id: "AbC",
      body: "hello",
      future_field: { yes: true },
    });
    const second = new Comment(client, "abc");

    expect(first.body).toBe("hello");
    expect(first.get("future_field")).toEqual({ yes: true });
    expect(first.equals(second)).toBe(true);
    expect(first.equals("ABC")).toBe(true);
    expect(first.fullname).toBe("t1_AbC");
  });

  it("loads once and refreshes explicitly", async () => {
    const request = vi.fn().mockResolvedValue({
      kind: "t2",
      data: { name: "spez", comment_karma: 10 },
    });
    const redditor = new Redditor({ request }, "spez");

    await redditor.load();
    await redditor.load();
    expect(request).toHaveBeenCalledOnce();
    expect(redditor.comment_karma).toBe(10);
    await redditor.refresh();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses entity-specific fetch paths", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ display_name: "typescript", subscribers: 42 });
    const subreddit = new Subreddit({ request }, "typescript");
    await subreddit.load();
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/r/typescript/about",
    });
  });

  it("compares MoreComments by count and children", () => {
    const client = { request: vi.fn() };
    const a = new MoreComments(client, { count: 2, children: ["a", "b"] });
    const b = new MoreComments(client, { count: 2, children: ["a", "b"] });
    expect(a.equals(b)).toBe(true);
  });
});
