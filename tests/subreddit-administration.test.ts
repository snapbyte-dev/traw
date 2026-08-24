import { describe, expect, it, vi } from "vitest";

import {
  SubredditModeration,
  SubredditQuarantine,
} from "../src/domains/moderation.js";
import { SubredditsDomain } from "../src/domains/subreddits.js";
import { ReadOnlyException } from "../src/exceptions.js";
import { ListingSubreddit } from "../src/helpers.js";
import { Subreddit } from "../src/models/entities.js";

describe("subreddit administration", () => {
  it("creates communities with PRAW defaults and remapped settings", async () => {
    const request = vi.fn().mockResolvedValue(null);
    const signal = new AbortController().signal;
    const subreddits = new SubredditsDomain({ request });

    const created = await subreddits.create(
      "typescript",
      {
        defaultSet: true,
        headerHoverText: "Snoo",
        language: "en",
        linkType: "any",
        title: "",
      },
      signal,
    );

    expect(created).toBeInstanceOf(ListingSubreddit);
    expect(String(created)).toBe("typescript");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/site_admin/",
      data: {
        allow_top: true,
        "header-title": "Snoo",
        lang: "en",
        link_type: "any",
        name: "typescript",
        title: "typescript",
        type: "public",
        wikimode: "disabled",
      },
      signal,
    });
  });

  it("validates creation and rejects read-only or aborted calls before I/O", async () => {
    const request = vi.fn();
    const readOnly = new SubredditsDomain({ readOnly: true, request });
    await expect(readOnly.create("test")).rejects.toBeInstanceOf(
      ReadOnlyException,
    );

    const subreddits = new SubredditsDomain({ request });
    await expect(
      subreddits.create("test", { subredditType: "invalid" as "public" }),
    ).rejects.toThrow("subredditType");
    await expect(
      subreddits.create("test", { keyColor: "blue" }),
    ).rejects.toThrow("keyColor");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      subreddits.create("test", {}, controller.signal),
    ).rejects.toThrow("stop");
    expect(request).not.toHaveBeenCalled();
  });

  it("reads and updates typed settings with modern field remaps", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { title: "Community", over_18: false } })
      .mockResolvedValueOnce({ title: "Updated", over_18: true });
    const subreddit = new Subreddit(
      { request },
      { display_name: "test", name: "t5_abc" },
    );
    const moderation = new SubredditModeration({ request }, subreddit);
    const signal = new AbortController().signal;

    await expect(moderation.settings(signal)).resolves.toEqual({
      over_18: false,
      title: "Community",
    });
    await expect(
      moderation.update(
        {
          contentOptions: "self",
          defaultSet: false,
          headerHoverText: "Header",
          language: "en_US",
          subredditType: "restricted",
        },
        signal,
      ),
    ).resolves.toEqual({ over_18: true, title: "Updated" });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "PATCH",
      path: "/api/v1/subreddit/update_settings",
      json: {
        allow_top: false,
        header_title: "Header",
        lang: "en_US",
        link_type: "self",
        sr: "t5_abc",
        type: "restricted",
      },
      signal,
    });
  });

  it("validates settings responses, updates, invites, and quarantine cancellation", async () => {
    const request = vi.fn().mockResolvedValue({ nested: {} });
    const moderation = new SubredditModeration({ request }, "test");
    await expect(moderation.settings()).rejects.toThrow(
      "invalid subreddit settings",
    );
    await expect(
      moderation.update({ crowdControlLevel: 4 as 3 }),
    ).rejects.toThrow("crowdControlLevel");

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(moderation.acceptInvite(controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(() =>
      new SubredditQuarantine({ request }, "test").optIn(controller.signal),
    ).toThrow("cancelled");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
