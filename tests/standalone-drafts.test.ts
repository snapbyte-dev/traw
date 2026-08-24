import { describe, expect, it, vi } from "vitest";

import {
  Draft,
  DraftsDomain,
  type DraftsClient,
} from "../src/domains/drafts.js";
import type { RedditRequest } from "../src/models/base.js";
import { Submission, Subreddit } from "../src/models/entities.js";

function setup(readOnly = false): {
  client: DraftsClient;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(null);
  return { client: { readOnly, request }, request };
}

describe("standalone drafts", () => {
  it("lists, creates, and hydrates draft references", async () => {
    const { client, request } = setup();
    const response = {
      drafts: [
        {
          body: "Body",
          id: "draft-one",
          kind: "markdown",
          subreddit: "typescript",
          title: "Title",
        },
      ],
    };
    request
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ json: { data: { id: "created" } } })
      .mockResolvedValueOnce(response);
    const drafts = new DraftsDomain(client);

    const [listed] = await drafts.list();
    expect(listed).toBeInstanceOf(Draft);
    expect(listed?.selftext).toBe("Body");
    expect(listed?.subreddit).toBeInstanceOf(Subreddit);
    const created = await drafts.create({
      selftext: "Text",
      subreddit: "typescript",
      title: "New",
    });
    expect(String(created)).toBe("created");
    const lazy = drafts.reference("draft-one");
    await lazy.load();
    expect(lazy.title).toBe("Title");

    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/v1/draft",
      data: {
        body: "Text",
        is_public_link: false,
        kind: "markdown",
        nsfw: false,
        original_content: false,
        send_replies: true,
        spoiler: false,
        subreddit: "typescript",
        target: "subreddit",
        title: "New",
      },
    });
  });

  it("updates then rehydrates, deletes, and submits with the draft ID", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        drafts: [
          {
            body: "updated",
            id: "draft",
            kind: "markdown",
            subreddit: "typescript",
            title: "Updated",
          },
        ],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        json: {
          data: {
            things: [{ kind: "t3", data: { id: "post", title: "Post" } }],
          },
        },
      });
    const draft = new Draft(client, {
      body: "old",
      id: "draft",
      kind: "markdown",
      subreddit: "typescript",
      title: "Old",
    });
    const signal = new AbortController().signal;

    await expect(draft.update({ title: "Updated" }, signal)).resolves.toBe(
      draft,
    );
    expect(draft.selftext).toBe("updated");
    await draft.delete(signal);
    const submission = await draft.submit({
      selftext: "override",
      title: "Post",
    });
    expect(submission).toBeInstanceOf(Submission);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "PUT",
      path: "/api/v1/draft",
      data: { id: "draft", kind: "link", title: "Updated" },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "DELETE",
      path: "/api/v1/draft",
      params: { draft_id: "draft" },
      signal,
    });
    expect(request.mock.calls[3]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/submit",
      data: {
        draft_id: "draft",
        kind: "self",
        sr: "typescript",
        text: "override",
        title: "Post",
        validate_on_submit: false,
      },
    });
  });

  it("accepts subreddit models and validates draft operations", async () => {
    const { client, request } = setup();
    request.mockResolvedValue({ id: "created" });
    const subreddit = new Subreddit(client, "u_owner");
    await new DraftsDomain(client).create({
      subreddit,
      url: "https://example.com",
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      data: {
        body: "https://example.com",
        subreddit: "u_owner",
        target: "profile",
      },
    });

    await expect(
      new DraftsDomain(client).create({ selftext: "a", url: "b" }),
    ).rejects.toThrow("Exactly one");
    await expect(
      new DraftsDomain(client).create({ flairText: "editable" }),
    ).rejects.toThrow("flairId is required");
    await expect(new Draft(client, "draft").submit()).rejects.toThrow(
      "invalid drafts data",
    );
  });

  it("enforces authorization and cancellation before requests", async () => {
    const blocked = setup(true);
    expect(() => new DraftsDomain(blocked.client).reference("id")).toThrow(
      "read-only",
    );
    await expect(new DraftsDomain(blocked.client).list()).rejects.toThrow(
      "read-only",
    );
    await expect(new Draft(blocked.client, "id").delete()).rejects.toThrow(
      "read-only",
    );

    const { client, request } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      new DraftsDomain(client).create({}, controller.signal),
    ).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
    expect(() => new Draft(client, " ")).toThrow("draft ID cannot be empty");
  });

  it("covers link drafts, complete options, and malformed API responses", async () => {
    const { client, request } = setup();
    request
      .mockResolvedValueOnce({
        data: {
          drafts: [{ body: "https://example.com", id: "link", kind: "link" }],
        },
      })
      .mockResolvedValueOnce({ id: "complete" });
    const [link] = await new DraftsDomain(client).list();
    expect(link?.url).toBe("https://example.com");
    await new DraftsDomain(client).create({
      flairId: "flair",
      flairText: "text",
      isPublicLink: true,
      nsfw: true,
      originalContent: true,
      sendReplies: false,
      spoiler: true,
      subreddit: "u_owner",
      url: "url",
    });
    expect(request.mock.calls[1]?.[0].data).toMatchObject({
      flair_id: "flair",
      flair_text: "text",
      is_public_link: true,
      nsfw: true,
      original_content: true,
      send_replies: false,
      spoiler: true,
      target: "profile",
    });

    request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "missing-kind" });
    await expect(new DraftsDomain(client).list()).rejects.toThrow(
      "invalid drafts data",
    );
    await expect(new DraftsDomain(client).create({})).resolves.toBeInstanceOf(
      Draft,
    );
    request.mockResolvedValue({ nope: true });
    await expect(new DraftsDomain(client).create({})).rejects.toThrow(
      "invalid draft data",
    );
  });

  it("validates submit overrides, missing drafts, and malformed submit responses", async () => {
    const { client, request } = setup();
    const draft = new Draft(client, {
      body: "url",
      id: "draft",
      kind: "link",
      subreddit: "typescript",
      title: "Link",
    });
    await expect(
      draft.submit({ selftext: "text", url: "url" }),
    ).rejects.toThrow("Exactly one");
    await expect(draft.submit({ flairText: "text" })).rejects.toThrow(
      "flairId is required",
    );
    request.mockResolvedValue({ json: { data: { things: [] } } });
    await expect(draft.submit()).rejects.toThrow("submitted Submission data");

    const noSubreddit = new Draft(client, { id: "none", kind: "link" });
    await expect(noSubreddit.submit()).rejects.toThrow("subreddit must be set");
    request.mockResolvedValue({ drafts: [] });
    await expect(new Draft(client, "absent").refresh()).rejects.toThrow(
      "did not contain draft absent",
    );
  });
});
