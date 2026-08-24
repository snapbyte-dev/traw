import { describe, expect, it, vi } from "vitest";

import {
  Comment,
  Message,
  MoreComments,
  Redditor,
  Submission,
  Subreddit,
  UserSubreddit,
} from "../src/models/entities.js";
import { RedditAPIException } from "../src/exceptions.js";
import { Objector, objectify } from "../src/objector.js";
import { LiveContributor, LiveThread } from "../src/models/live.js";
import { Multireddit } from "../src/models/multireddit.js";

describe("Objector", () => {
  const client = { request: vi.fn() };

  it("maps kinds recursively without mutating the response", () => {
    const response = {
      kind: "Listing",
      data: {
        after: "t3_next",
        children: [{ kind: "t3", data: { id: "post", title: "Post" } }],
      },
    };
    const result = new Objector(client).objectify(response) as {
      children: unknown[];
    };
    expect(result.children[0]).toBeInstanceOf(Submission);
    expect(response.data.children[0]?.data).toEqual({
      id: "post",
      title: "Post",
    });
  });

  it("recognizes unwrapped comments and more placeholders by shape", () => {
    const objector = new Objector(client);
    expect(objector.objectify({ id: "c", parent_id: "t3_p" })).toBeInstanceOf(
      Comment,
    );
    expect(
      objector.objectify({ children: ["c"], count: 1, parent_id: "t3_p" }),
    ).toBeInstanceOf(MoreComments);
  });

  it("leaves unknown primitive and object shapes intact", () => {
    expect(new Objector(client).objectify({ nested: { value: 1 } })).toEqual({
      nested: { value: 1 },
    });
  });

  it("raises Reddit API errors from non-empty json.errors", () => {
    const objector = new Objector(client);
    expect(() =>
      objector.objectify({
        json: { errors: [["BAD_FIELD", "Invalid value", "name"]] },
      }),
    ).toThrow(RedditAPIException);
    expect(objector.objectify({ json: { errors: [] } })).toEqual({
      json: { errors: [] },
    });
    expect(objector.objectify({ json: { errors: "invalid" } })).toEqual({
      json: { errors: "invalid" },
    });
  });

  it("parses every wrapped kind and recursively handles arrays", () => {
    const result = objectify(client, [
      { kind: "t1", data: { id: "c", parent_id: "t3_p" } },
      { kind: "t2", data: { name: "user", comment_karma: 1 } },
      { kind: "t3", data: { id: "p", title: "post" } },
      { kind: "t4", data: { id: "m", subject: "message" } },
      { kind: "t5", data: { display_name: "community" } },
      { kind: "more", data: { children: [], count: 0, parent_id: "t3_p" } },
      null,
      "text",
    ]);

    expect(result).toEqual([
      expect.any(Comment),
      expect.any(Redditor),
      expect.any(Submission),
      expect.any(Message),
      expect.any(Subreddit),
      expect.any(MoreComments),
      null,
      "text",
    ]);
  });

  it("parses context-free lifecycle models from wrapped responses", () => {
    const objector = new Objector(client);
    expect(
      objector.objectify({ kind: "LiveThread", data: { id: "incident" } }),
    ).toBeInstanceOf(LiveThread);
    expect(
      objector.objectify({ kind: "LiveContributor", data: { name: "alice" } }),
    ).toBeInstanceOf(LiveContributor);
    expect(
      objector.objectify({
        kind: "LabeledMulti",
        data: { name: "dev", path: "/user/alice/m/dev" },
      }),
    ).toBeInstanceOf(Multireddit);
  });

  it("recognizes every unwrapped entity shape", () => {
    const objector = new Objector(client);
    expect(objector.objectify({ display_name: "community" })).toBeInstanceOf(
      Subreddit,
    );
    expect(objector.objectify({ id: "p", title: "post" })).toBeInstanceOf(
      Submission,
    );
    expect(objector.objectify({ id: "m", subject: "message" })).toBeInstanceOf(
      Message,
    );
    expect(objector.objectify({ name: "a", comment_karma: 0 })).toBeInstanceOf(
      Redditor,
    );
    expect(objector.objectify({ name: "b", link_karma: 0 })).toBeInstanceOf(
      Redditor,
    );
  });

  it("objectifies profile subreddits nested in redditors", () => {
    const objector = new Objector(client);
    const wrapped = objector.objectify({
      kind: "t2",
      data: {
        name: "alice",
        subreddit: { display_name: "u_alice", over18: false },
      },
    });
    const unwrapped = objector.objectify({
      name: "bob",
      link_karma: 1,
      subreddit: { display_name: "u_bob" },
    });

    expect(wrapped).toBeInstanceOf(Redditor);
    expect((wrapped as Redditor).subreddit).toBeInstanceOf(UserSubreddit);
    expect((unwrapped as Redditor).subreddit).toBeInstanceOf(UserSubreddit);
    expect(() =>
      objector.objectify({
        kind: "t2",
        data: { name: "invalid", subreddit: "u_invalid" },
      }),
    ).toThrow("invalid user subreddit");
  });

  it("keeps malformed wrappers and listing shapes while objectifying nested values", () => {
    const objector = new Objector(client);
    expect(
      objector.objectify({
        kind: "unknown",
        data: { nested: { id: "p", title: "post" } },
      }),
    ).toEqual({
      kind: "unknown",
      data: { nested: expect.any(Submission) },
    });
    expect(objector.objectify({ kind: "t3", data: null })).toEqual({
      kind: "t3",
      data: null,
    });
    expect(
      objector.objectify({
        kind: "Listing",
        data: { children: "invalid", nested: { id: "p", title: "post" } },
      }),
    ).toEqual({
      children: "invalid",
      nested: { id: "p", title: "post" },
    });
  });

  it("allows parser overrides and falls back when an inferred parser is absent", () => {
    const parser = vi.fn(() => "custom");
    const objector = new Objector(client, {
      t3: parser,
      t1: undefined as never,
    });

    expect(objector.objectify({ kind: "t3", data: { id: "p" } })).toBe(
      "custom",
    );
    expect(objector.objectify({ id: "p", title: "post" })).toBe("custom");
    const commentShape = { id: "c", parent_id: "t3_p" };
    expect(objector.objectify(commentShape)).toBe(commentShape);
    expect(parser).toHaveBeenCalledTimes(2);
  });
});
