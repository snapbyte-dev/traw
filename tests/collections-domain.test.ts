import { describe, expect, it, vi } from "vitest";

import {
  SubredditCollections,
  createSubredditCollections,
} from "../src/domains/collections.js";
import {
  Collection,
  type CollectionsClient,
} from "../src/models/collection.js";
import type { RedditRequest } from "../src/models/base.js";
import { Submission, Subreddit } from "../src/models/entities.js";

function setup(readOnly = false): {
  client: CollectionsClient;
  request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
  subreddit: Subreddit;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  request.mockResolvedValue(null);
  const client = { readOnly, request };
  return {
    client,
    request,
    subreddit: new Subreddit(client, {
      display_name: "typescript",
      id: "abc",
      name: "t5_abc",
    }),
  };
}

function collectionData(id = "collection-one") {
  return {
    collection_id: id,
    description: "Useful posts",
    display_layout: "TIMELINE",
    link_ids: ["t3_one", "t3_two"],
    permalink: `/r/typescript/collection/${id}`,
    sorted_links: [
      { kind: "t3", data: { id: "one", name: "t3_one", title: "One" } },
      { kind: "t3", data: { id: "two", name: "t3_two", title: "Two" } },
    ],
    title: "TypeScript",
  };
}

describe("standalone collections", () => {
  it("lists realistic collection responses with typed submission iteration", async () => {
    const { client, request, subreddit } = setup();
    const summary: Record<string, unknown> = collectionData();
    Reflect.deleteProperty(summary, "sorted_links");
    request.mockResolvedValue([summary]);

    const domain = createSubredditCollections(client, subreddit);
    const [collection] = await domain.list();

    expect(domain).toBeInstanceOf(SubredditCollections);
    expect(collection).toBeInstanceOf(Collection);
    expect(collection?.length).toBe(2);
    expect(() => collection?.submissions).toThrow("have not been loaded");
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/v1/collections/subreddit_collections",
      params: { sr_fullname: "t5_abc" },
    });
  });

  it("gets lazy references by ID and permalink and hydrates them", async () => {
    const { client, request, subreddit } = setup();
    request.mockResolvedValue({ data: collectionData() });
    const domain = createSubredditCollections(client, subreddit);

    const byId = domain.get("collection-one");
    const byPermalink = domain.getByPermalink(
      "https://www.reddit.com/r/typescript/collection/collection-one/",
    );
    expect(byId.isLoaded).toBe(false);
    expect(String(byPermalink)).toBe("collection-one");
    await byId.load();

    expect(byId.title).toBe("TypeScript");
    expect(byId.submissions[0]).toBeInstanceOf(Submission);
    expect([...byId]).toEqual(byId.submissions);
    expect([...byId].every((post) => post instanceof Submission)).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/v1/collections/collection",
      params: { collection_id: "collection-one", include_links: true },
    });
  });

  it("creates collections with the subreddit fullname and layout", async () => {
    const { client, request, subreddit } = setup();
    request.mockResolvedValue({ json: { data: collectionData("created") } });
    const signal = new AbortController().signal;

    const created = await createSubredditCollections(client, subreddit).create(
      { description: "Description", layout: "GALLERY", title: "Gallery" },
      signal,
    );

    expect(created).toBeInstanceOf(Collection);
    expect(String(created)).toBe("created");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/collections/create_collection",
      data: {
        description: "Description",
        display_layout: "GALLERY",
        sr_fullname: "t5_abc",
        title: "Gallery",
      },
      signal,
    });
  });

  it("follows, unfollows, and performs collection moderation requests", async () => {
    const { client, request, subreddit } = setup();
    const collection = new Collection(client, subreddit, collectionData());
    const signal = new AbortController().signal;

    await collection.follow(signal);
    await collection.unfollow();
    await collection.addPost("one");
    await collection.removePost("/r/typescript/comments/two/title/");
    await collection.reorder([new Submission(client, "one"), "t3_two"]);
    await collection.updateTitle("New title");
    await collection.updateDescription("");
    await collection.updateLayout("GALLERY");
    await collection.delete();

    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/v1/collections/follow_collection",
      data: { collection_id: "collection-one", follow: true },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/api/v1/collections/add_post_to_collection",
      data: { collection_id: "collection-one", link_fullname: "t3_one" },
    });
    expect(request).toHaveBeenNthCalledWith(5, {
      method: "POST",
      path: "/api/v1/collections/reorder_collection",
      data: { collection_id: "collection-one", link_ids: "t3_one,t3_two" },
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/v1/collections/delete_collection",
      data: { collection_id: "collection-one" },
    });
  });

  it("enforces auth, input limits, permalink ownership, and cancellation", async () => {
    const blocked = setup(true);
    const blockedDomain = createSubredditCollections(
      blocked.client,
      blocked.subreddit,
    );
    await expect(
      blockedDomain.create({ description: "", title: "Title" }),
    ).rejects.toThrow("read-only");
    await expect(blockedDomain.get("id").follow()).rejects.toThrow("read-only");

    const { client, request, subreddit } = setup();
    const domain = createSubredditCollections(client, subreddit);
    expect(() => domain.get(" ")).toThrow("collection ID cannot be empty");
    expect(() => domain.getByPermalink("/r/other/collection/id")).toThrow(
      "different subreddit",
    );
    await expect(
      domain.create({ description: "", title: " " }),
    ).rejects.toThrow("title cannot be empty");
    expect(() => domain.get("id").reorder([])).toThrow("cannot be empty");
    expect(() => domain.get("id").updateLayout("GRID" as "GALLERY")).toThrow(
      "layout must be",
    );

    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(domain.list(controller.signal)).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed collection and submission responses", async () => {
    const { client, request, subreddit } = setup();
    const domain = createSubredditCollections(client, subreddit);
    request.mockResolvedValueOnce({ nope: true });
    await expect(domain.list()).rejects.toThrow("invalid collections data");

    request.mockResolvedValueOnce({ collection_id: "id", sorted_links: [{}] });
    await expect(domain.get("id").load()).rejects.toThrow(
      "invalid collection submission data",
    );

    request.mockResolvedValueOnce({ collection_id: "id", sorted_links: {} });
    await expect(domain.get("id").refresh()).rejects.toThrow(
      "invalid collection submissions data",
    );

    request.mockResolvedValueOnce({ data: [collectionData()] });
    await expect(domain.list()).resolves.toHaveLength(1);
    request.mockResolvedValueOnce({ data: [collectionData(), null] });
    await expect(domain.list()).rejects.toThrow("invalid collections data");
    request.mockResolvedValueOnce({ json: { data: {} } });
    await expect(
      domain.create({ description: "", title: "title" }),
    ).rejects.toThrow("invalid collection data");
  });

  it("validates permalink forms, submission references, and update limits", async () => {
    const { client, request, subreddit } = setup();
    const domain = createSubredditCollections(client, subreddit);
    const collection = domain.get("id");

    expect(
      String(domain.getByPermalink("/r/typescript/collection/encoded%2Did")),
    ).toBe("encoded-id");
    expect(() =>
      domain.getByPermalink("ftp://reddit.com/r/typescript/collection/id"),
    ).toThrow("HTTP or HTTPS");
    expect(() => domain.getByPermalink("not a permalink")).toThrow("invalid");
    expect(() => domain.getByPermalink("/r/typescript/comments/id")).toThrow(
      "invalid",
    );
    expect(() => collection.addPost("not/a/post")).toThrow(
      "ID, fullname, or Reddit permalink",
    );
    expect(() => collection.updateTitle("x".repeat(301))).toThrow("300");
    expect(() => collection.updateDescription("x".repeat(501))).toThrow("500");

    await collection.addPost(
      "https://reddit.com/r/typescript/comments/ABC/title",
    );
    expect(request.mock.calls[0]?.[0].data).toMatchObject({
      link_fullname: "t3_ABC",
    });
    expect(new Collection(client, subreddit, collectionData()).length).toBe(2);
    expect(
      new Collection(client, subreddit, {
        ...collectionData(),
        link_ids: [1],
      }).length,
    ).toBe(2);
  });

  it("loads subreddit identity, rejects missing identity, and preflights create options", async () => {
    const { client, request } = setup();
    const lazy = new Subreddit(client, "typescript");
    request
      .mockResolvedValueOnce({
        display_name: "typescript",
        id: "abc",
        name: "t5_abc",
      })
      .mockResolvedValueOnce([collectionData()]);
    const signal = new AbortController().signal;
    await createSubredditCollections(client, lazy).list(signal);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ signal });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      params: { sr_fullname: "t5_abc" },
      signal,
    });

    const missing = new Subreddit(client, "missing");
    vi.spyOn(missing, "load").mockResolvedValue(missing);
    await expect(
      createSubredditCollections(client, missing).list(),
    ).rejects.toThrow("no fullname");
    await expect(
      createSubredditCollections(client, missing).create({
        description: "",
        title: "title",
      }),
    ).rejects.toThrow("no fullname");

    const domain = createSubredditCollections(client, lazy);
    await expect(
      domain.create({ description: "", title: "x".repeat(301) }),
    ).rejects.toThrow("300");
    await expect(
      domain.create({ description: "x".repeat(501), title: "title" }),
    ).rejects.toThrow("500");
    await expect(
      domain.create({
        description: "",
        layout: "GRID" as "GALLERY",
        title: "title",
      }),
    ).rejects.toThrow("layout");

    const controller = new AbortController();
    controller.abort(new Error("create stopped"));
    await expect(
      domain.create({ description: "", title: "title" }, controller.signal),
    ).rejects.toThrow("create stopped");
  });

  it("exposes the collection fetch request and aborts refresh and mutations", async () => {
    const { client, request, subreddit } = setup();
    class InspectableCollection extends Collection {
      requestShape() {
        return this.fetchRequest();
      }
    }
    const collection = new InspectableCollection(client, subreddit, "id");
    expect(collection.requestShape()).toEqual({
      path: "/api/v1/collections/collection",
      params: { collection_id: "id", include_links: true },
    });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      collection.refresh({ signal: controller.signal }),
    ).rejects.toThrow("stopped");
    await expect(collection.delete(controller.signal)).rejects.toThrow(
      "stopped",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
