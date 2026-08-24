import { describe, expect, it, vi } from "vitest";

import { createLiveDomain, LiveDomainClient } from "../src/domains/live.js";
import { ReadOnlyException } from "../src/exceptions.js";
import { Listing } from "../src/listing.js";
import type { RedditRequest } from "../src/models/base.js";
import {
  LiveContributor,
  LiveDiscussion,
  LiveThread,
  LiveUpdate,
} from "../src/models/live.js";

function mockClient(readOnly = false): {
  readonly client: {
    readonly readOnly: boolean;
    readonly request: ReturnType<
      typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
    >;
  };
  readonly request: ReturnType<
    typeof vi.fn<(request: RedditRequest) => Promise<unknown>>
  >;
} {
  const request = vi.fn<(request: RedditRequest) => Promise<unknown>>();
  return { client: { readOnly, request }, request };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("standalone live domain", () => {
  it("creates references, creates threads, loads them, and objectifies responses", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({
        json: {
          errors: [],
          data: { id: "created", title: "Incident", nsfw: false },
        },
      })
      .mockResolvedValueOnce({
        data: {
          title: "Hydrated incident",
          description: "All systems operational",
          nsfw: false,
          resources: "[Status](https://status.example)",
        },
      });
    const live = createLiveDomain(client);
    const signal = new AbortController().signal;
    const reference = live(" current ");
    const created = await live.create(" Incident ", {
      description: "Tracking",
      signal,
    });

    expect(reference).toBeInstanceOf(LiveThread);
    expect(String(reference)).toBe("current");
    expect(created).toMatchObject({ id: "created", title: "Incident" });
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/api/live/create",
      data: { description: "Tracking", nsfw: false, title: "Incident" },
      signal,
    });
    await reference.load({ signal });
    expect(reference).toMatchObject({
      description: "All systems operational",
      id: "current",
      title: "Hydrated incident",
    });
    await reference.load();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("batches info by 100, returns featured threads, and handles no feature", async () => {
    const { client, request } = mockClient();
    const ids = Array.from({ length: 101 }, (_, index) => `thread-${index}`);
    request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          children: ids.slice(0, 100).map((id) => ({
            kind: "LiveThread",
            data: { id, title: id },
          })),
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          children: [
            { kind: "LiveThread", data: { id: ids[100], title: "Last" } },
          ],
        },
      })
      .mockResolvedValueOnce({ kind: "LiveThread", data: { id: "featured" } })
      .mockResolvedValueOnce({ data: null });
    const live = createLiveDomain(client);

    const threads = await collect(live.info(ids));
    expect(threads).toHaveLength(101);
    expect(threads.every((thread) => thread instanceof LiveThread)).toBe(true);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      path: expect.stringContaining("/api/live/by_id/thread-0,thread-1"),
      params: { limit: 100 },
    });
    await expect(live.now()).resolves.toMatchObject({ id: "featured" });
    await expect(live.now()).resolves.toBeNull();
  });

  it("lists and objectifies realistic updates and linked discussions", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [
            {
              kind: "LiveUpdate",
              data: {
                id: "update-one",
                author: "alice",
                body: "Mitigation deployed",
                created_utc: 1_700_000_000,
                stricken: false,
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          after: null,
          children: [
            { kind: "t3", data: { id: "post", title: "Incident discussion" } },
          ],
        },
      });
    const thread = createLiveDomain(client)("incident");
    const updates = thread.updates({ limit: 1 });
    const discussions = thread.discussions({ limit: 1 });

    expect(updates).toBeInstanceOf(Listing);
    const [update] = await collect(updates);
    expect(update).toBeInstanceOf(LiveUpdate);
    expect(update?.thread).toBe(thread);
    expect(update?.author).toBeInstanceOf(LiveContributor);
    expect(update?.fullname).toBe("LiveUpdate_update-one");
    expect((await collect(discussions))[0]).toBeInstanceOf(LiveDiscussion);
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/live/incident",
      params: { limit: 1 },
    });
  });

  it("loads a focused update and performs report, remove, and strike actions", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({
        kind: "Listing",
        data: {
          children: [
            {
              kind: "LiveUpdate",
              data: { id: "focus", author: "bob", body: "Correction" },
            },
          ],
        },
      })
      .mockResolvedValue(null);
    const thread = createLiveDomain(client)("incident");
    const update = thread.update("focus");
    const signal = new AbortController().signal;

    await update.load({ signal });
    await thread.report("site-breaking", signal);
    await update.remove(signal);
    await update.strike(signal);
    expect(update.author).toBeInstanceOf(LiveContributor);
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/api/live/incident/delete_update",
      data: { id: "LiveUpdate_focus" },
      signal,
    });
    expect(request).toHaveBeenNthCalledWith(4, {
      method: "POST",
      path: "/api/live/incident/strike_update",
      data: { id: "LiveUpdate_focus" },
      signal,
    });
  });

  it("adds updates, closes, and edits with freshly loaded retained settings", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        data: {
          id: "incident",
          description: "Old description",
          nsfw: false,
          resources: "Runbook",
          title: "Old title",
        },
      })
      .mockResolvedValueOnce(null);
    const thread = createLiveDomain(client)("incident");
    const signal = new AbortController().signal;

    await thread.contrib.add(" Service restored ", signal);
    await thread.contrib.close(signal);
    await thread.contrib.update({ nsfw: true, title: "Resolved", signal });
    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      path: "/api/live/incident/edit",
      data: {
        description: "Old description",
        nsfw: true,
        resources: "Runbook",
        title: "Resolved",
      },
      signal,
    });
  });

  it("lists contributors and encodes invite and permission operations", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({
        kind: "UserList",
        data: {
          children: [
            { id: "alice-id", name: "alice", permissions: ["update", "edit"] },
          ],
        },
      })
      .mockResolvedValue(null);
    const contributor = createLiveDomain(client)("incident").contributor;
    const signal = new AbortController().signal;

    const [alice] = await collect(contributor.list({ limit: 1, signal }));
    expect(alice).toBeInstanceOf(LiveContributor);
    expect(alice?.fullname).toBe("t2_alice-id");
    await contributor.invite("bob", ["manage", "settings", "manage"], signal);
    await contributor.update("bob", [], signal);
    await contributor.updateInvite("bob", undefined, signal);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/api/live/incident/invite_contributor",
      data: {
        name: "bob",
        permissions: "+manage,+settings",
        type: "liveupdate_contributor_invite",
      },
      signal,
    });
    expect(request.mock.calls[2]?.[0].data).toMatchObject({ permissions: "" });
    expect(request.mock.calls[3]?.[0].data).toMatchObject({
      permissions: "+all",
    });
  });

  it("removes contributors and invites, leaves, and accepts invitations", async () => {
    const { client, request } = mockClient();
    request.mockResolvedValue(null);
    const contributor = createLiveDomain(client)("incident").contributor;

    await contributor.remove("t2_alice");
    await contributor.removeInvite("t2_bob");
    await contributor.leave();
    await contributor.acceptInvite();
    expect(request.mock.calls.map(([call]) => call.path)).toEqual([
      "/api/live/incident/rm_contributor",
      "/api/live/incident/rm_contributor_invite",
      "/api/live/incident/leave_contributor",
      "/api/live/incident/accept_contributor_invite",
    ]);
  });

  it("streams unseen updates oldest first with cancellation", async () => {
    const { client, request } = mockClient();
    request.mockResolvedValue({
      kind: "Listing",
      data: {
        after: null,
        children: [
          { kind: "LiveUpdate", data: { id: "new", body: "New" } },
          { kind: "LiveUpdate", data: { id: "old", body: "Old" } },
        ],
      },
    });
    const controller = new AbortController();
    const stream = createLiveDomain(client)("incident").stream.updates({
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: "old" },
    });
    controller.abort(new Error("stop"));
    await iterator.return(undefined);
  });

  it("rejects invalid, read-only, and cancelled operations before I/O", async () => {
    const blocked = mockClient(true);
    const live = createLiveDomain(blocked.client);
    expect(() => live(" ")).toThrow("live thread ID cannot be empty");
    await expect(live.create("Title")).rejects.toBeInstanceOf(
      ReadOnlyException,
    );
    expect(() => live("thread").report("spam")).toThrow(ReadOnlyException);
    expect(() => live("thread").contrib.add("body")).toThrow(ReadOnlyException);
    expect(blocked.request).not.toHaveBeenCalled();

    const active = mockClient();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createLiveDomain(active.client).now(controller.signal),
    ).rejects.toThrow("cancelled");
    await expect(
      createLiveDomain(active.client)("thread").contributor.invite(
        "alice",
        ["manage"],
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(active.request).not.toHaveBeenCalled();

    const thread = createLiveDomain(active.client)("thread");
    expect(() => thread.report("other" as "spam")).toThrow("report reason");
    expect(() => thread.contrib.add(" ")).toThrow("body cannot be empty");
    expect(() => thread.contributor.remove("alice")).toThrow("t2_");
  });

  it("validates domain inputs and malformed create, info, and now responses", async () => {
    const { client, request } = mockClient();
    const wrapped = new LiveDomainClient(client);
    expect(wrapped.live("id")).toBeInstanceOf(LiveThread);
    expect(() => wrapped.live.info("ids" as never)).toThrow("array of strings");
    expect(() => wrapped.live.info(["ok", 1] as never)).toThrow(
      "array of strings",
    );
    expect(() => wrapped.live.info([" "])).toThrow("cannot be empty");
    await expect(wrapped.live.create("x".repeat(121))).rejects.toThrow("120");

    request.mockResolvedValueOnce(null);
    await expect(
      wrapped.live.create("title", { nsfw: true, resources: "links" }),
    ).rejects.toThrow("invalid live thread data");
    request.mockResolvedValueOnce({});
    await expect(collect(wrapped.live.info(["id"]))).rejects.toThrow(
      "invalid live thread info",
    );
    request.mockResolvedValueOnce({
      kind: "Listing",
      data: { children: [null] },
    });
    await expect(collect(wrapped.live.info(["id"]))).rejects.toThrow(
      "invalid live thread data",
    );
    request.mockResolvedValueOnce(null);
    await expect(wrapped.live.now()).resolves.toBeNull();
    request.mockResolvedValueOnce({ data: { id: "now" } });
    await expect(wrapped.live.now()).resolves.toMatchObject({ id: "now" });
  });

  it("covers model identity helpers and loaded-state lifecycle", async () => {
    const { client, request } = mockClient();
    const contributor = new LiveContributor(client, {
      name: "alice",
      fullname: "t2_alice",
    });
    expect(String(contributor)).toBe("alice");
    expect(contributor.fullname).toBe("t2_alice");
    expect(new LiveContributor(client, { id: "bob" }).fullname).toBe("t2_bob");
    expect(new LiveContributor(client, {}).fullname).toBeUndefined();
    expect(() => String(new LiveContributor(client, {}))).toThrow("valid name");

    expect(new LiveDiscussion(client, { name: "t3_named" }).fullname).toBe(
      "t3_named",
    );
    expect(String(new LiveDiscussion(client, { id: "post" }))).toBe("t3_post");
    expect(new LiveDiscussion(client, { id: "t3_post" }).fullname).toBe(
      "t3_post",
    );
    expect(() => new LiveDiscussion(client, {}).fullname).toThrow(
      "valid identity",
    );
    expect(() => new LiveThread(client, {})).toThrow("valid ID");

    const loadedThread = new LiveThread(client, {
      id: "thread",
      title: "loaded",
    });
    expect(loadedThread.isLoaded).toBe(true);
    expect(loadedThread.contribution.thread).toBe(loadedThread);
    await loadedThread.load();
    expect(request).not.toHaveBeenCalled();

    const loadedUpdate = new LiveUpdate(client, "thread", {
      id: "LiveUpdate_up",
      author: "alice",
    });
    expect(loadedUpdate.id).toBe("up");
    expect(loadedUpdate.fullname).toBe("LiveUpdate_up");
    expect(loadedUpdate.isLoaded).toBe(true);
    expect(loadedUpdate.contribution.update).toBe(loadedUpdate);
    expect(String(loadedUpdate)).toBe("up");
    await loadedUpdate.load();
    expect(() => new LiveUpdate(client, "thread", {})).toThrow("valid ID");
  });

  it("retains refresh identities and rejects malformed lifecycle responses", async () => {
    const { client, request } = mockClient();
    request
      .mockResolvedValueOnce({ json: { data: { title: "refreshed" } } })
      .mockResolvedValueOnce({
        kind: "Listing",
        data: { children: [{ data: { body: "body" } }] },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const thread = new LiveThread(client, "thread/id");
    await thread.refresh();
    expect(thread.id).toBe("thread/id");
    expect(request.mock.calls[0]?.[0].path).toContain("thread%2Fid");
    const update = thread.update("update/id");
    await update.refresh();
    expect(update.id).toBe("update/id");
    expect(update.author).toBeUndefined();
    await update.contrib.remove();
    await update.contrib.strike();

    request.mockResolvedValueOnce([]);
    await expect(new LiveThread(client, "bad").refresh()).rejects.toThrow(
      "invalid live thread",
    );
    request.mockResolvedValueOnce({ kind: "Listing", data: { children: [] } });
    await expect(
      new LiveUpdate(client, "thread", "bad").refresh(),
    ).rejects.toThrow("invalid live update");
  });

  it("validates contributor pages, permissions, fullnames, and update settings", async () => {
    const { client, request } = mockClient();
    const thread = new LiveThread(client, "thread");
    request.mockResolvedValueOnce({
      kind: "UserList",
      data: { children: [], after: 1 },
    });
    await expect(collect(thread.contributor.list())).rejects.toThrow("cursor");
    request.mockResolvedValueOnce({ kind: "UserList", data: {} });
    await expect(collect(thread.contributor.list())).rejects.toThrow(
      "contributors data",
    );
    request.mockResolvedValueOnce({
      kind: "UserList",
      data: { children: [null] },
    });
    await expect(collect(thread.contributor.list())).rejects.toThrow(
      "live contributor data",
    );

    expect(() =>
      thread.contributor.invite("alice", ["bad,permission" as "all"]),
    ).toThrow("Invalid live contributor permission");
    expect(() =>
      thread.contributor.remove({ toString: () => "alice" }),
    ).toThrow("fullname is required");
    await thread.contrib.update();
    expect(request).toHaveBeenCalledTimes(3);

    request.mockResolvedValueOnce({ data: { id: "thread" } });
    await expect(thread.contrib.update({ description: "new" })).rejects.toThrow(
      "valid title",
    );
    request.mockResolvedValueOnce({
      data: { id: "thread", title: "x".repeat(121) },
    });
    await expect(thread.contrib.update({ nsfw: true })).rejects.toThrow("120");
  });

  it("passes stream listing options and preflights aborted info iteration", async () => {
    const { client, request } = mockClient();
    request.mockResolvedValue({ kind: "Listing", data: { children: [] } });
    const stream = new LiveThread(client, "thread").stream.updates({
      continueAfterId: "LiveUpdate_before",
      excludeBefore: false,
      params: { raw_json: 1 },
      pauseAfter: -1,
    });
    await expect(stream.next()).resolves.toEqual({ done: false, value: null });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/live/thread",
      params: { before: "LiveUpdate_before", limit: 100, raw_json: 1 },
    });
    await stream.return(undefined);

    const controller = new AbortController();
    controller.abort(new Error("info stopped"));
    await expect(
      collect(createLiveDomain(client).info(["id"], controller.signal)),
    ).rejects.toThrow("info stopped");
  });
});
