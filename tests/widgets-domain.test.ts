import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  SubredditWidgets,
  WidgetMedia,
  WidgetModeration,
} from "../src/domains/widgets.js";
import type { ReplayableBody } from "../src/core/transport.js";
import { BaseModel, type RedditRequest } from "../src/models/base.js";
import { Subreddit } from "../src/models/entities.js";
import { Media } from "../src/models/media.js";
import {
  Button,
  ButtonWidget,
  Calendar,
  CalendarConfiguration,
  CommunityList,
  CustomWidget,
  Hover,
  IDCard,
  Image,
  ImageData,
  ImageWidget,
  Menu,
  MenuLink,
  ModeratorsWidget,
  PostFlairWidget,
  RulesWidget,
  Styles,
  Submenu,
  TextArea,
  objectifyWidget,
} from "../src/models/widgets.js";

const styles = { backgroundColor: "#ffffff", headerColor: "#123abc" } as const;

function widgetResponse() {
  return {
    items: {
      card: { id: "card", kind: "id-card", styles },
      mods: {
        id: "mods",
        kind: "moderators",
        mods: [{ name: "alice" }],
        styles,
      },
      text: {
        id: "text",
        kind: "textarea",
        shortName: "Info",
        styles,
        text: "Hello",
      },
      menu: {
        id: "menu",
        kind: "menu",
        data: [
          { text: "Home", url: "https://example.com" },
          {
            text: "More",
            children: [{ text: "Docs", url: "https://example.com/docs" }],
          },
        ],
      },
    },
    layout: {
      idCardWidget: "card",
      moderatorWidget: "mods",
      sidebar: { order: ["text"] },
      topbar: { order: ["menu"] },
    },
  };
}

describe("standalone widgets domain", () => {
  it("fetches and refreshes typed widget snapshots with nested objectification", async () => {
    const request = vi.fn().mockResolvedValue(widgetResponse());
    const signal = new AbortController().signal;
    const widgets = new SubredditWidgets({ request }, "typescript");

    await widgets.fetch({ progressiveImages: true, signal });
    expect(widgets.idCard).toBeInstanceOf(IDCard);
    expect(widgets.moderatorsWidget).toBeInstanceOf(ModeratorsWidget);
    expect(widgets.sidebar[0]).toBeInstanceOf(TextArea);
    expect(widgets.topbar[0]).toBeInstanceOf(Menu);
    expect(widgets.topbar[0]?.data[0]).toBeInstanceOf(MenuLink);
    expect(widgets.topbar[0]?.data[1]).toBeInstanceOf(Submenu);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/r/typescript/api/widgets",
      params: { progressive_images: true },
      signal,
    });

    await widgets.refresh();
    expect(request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/r/typescript/api/widgets",
      params: { progressive_images: false },
    });
  });

  it("creates every supported user-created widget with strict JSON payloads", async () => {
    const request = vi.fn().mockImplementation(async (input: RedditRequest) => {
      const payload = JSON.parse(
        (input.data as { json: string }).json,
      ) as Record<string, unknown>;
      return { id: `${String(payload["kind"])}-id`, ...payload };
    });
    const mod = new SubredditWidgets({ request }, "test").mod;

    const button = await mod.addButtonWidget({
      buttons: [
        {
          kind: "text",
          text: "Go",
          url: "https://example.com",
          color: "#000000",
          textColor: "#ffffff",
          fillColor: "#123456",
        },
      ],
      description: "Links",
      shortName: "Buttons",
      styles,
    });
    expect(button).toBeInstanceOf(ButtonWidget);
    expect(button.buttons[0]).toBeInstanceOf(Button);
    await mod.addCalendar({
      configuration: {
        numEvents: 5,
        showDate: true,
        showDescription: false,
        showLocation: false,
        showTime: true,
        showTitle: true,
      },
      googleCalendarId: "calendar@example.com",
      requiresSync: true,
      shortName: "Events",
      styles,
    });
    await mod.addCommunityList({
      data: ["typescript"],
      shortName: "Related",
      styles,
    });
    await mod.addCustomWidget({
      css: "/**/",
      height: 100,
      imageData: [],
      shortName: "Custom",
      styles,
      text: "Hi",
    });
    await mod.addImageWidget({
      data: [{ height: 1, url: "https://i.example/a.png", width: 1 }],
      shortName: "Images",
      styles,
    });
    await mod.addMenu({ data: [{ text: "Home", url: "https://example.com" }] });
    await mod.addPostFlairWidget({
      display: "list",
      order: ["flair"],
      shortName: "Flair",
      styles,
    });
    await mod.addTextArea({ shortName: "Text", styles, text: "Hello" });

    expect(request).toHaveBeenCalledTimes(8);
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: "POST",
      path: "/r/test/api/widget",
      data: {
        json: JSON.stringify({
          buttons: [
            {
              kind: "text",
              text: "Go",
              url: "https://example.com",
              color: "#000000",
              textColor: "#ffffff",
              fillColor: "#123456",
            },
          ],
          description: "Links",
          kind: "button",
          shortName: "Buttons",
          styles,
        }),
      },
    });
  });

  it("updates/deletes widgets and reorders readonly section input", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(widgetResponse())
      .mockResolvedValueOnce({
        id: "text",
        kind: "textarea",
        shortName: "Changed",
        styles,
        text: "Hello",
      })
      .mockResolvedValue(undefined);
    const widgets = await new SubredditWidgets({ request }, "test").fetch();
    const text = widgets.sidebar[0]!;
    const signal = new AbortController().signal;

    await expect(
      text.mod.update({ shortName: "Changed" }, signal),
    ).resolves.toMatchObject({ shortName: "Changed" });
    await text.mod.delete(signal);
    await widgets.mod.reorder([text, "other"] as const, "sidebar", signal);
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      method: "PUT",
      path: "/r/test/api/widget/text",
      signal,
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "PATCH",
      path: "/r/test/api/widget_order/sidebar",
      data: { json: '["text","other"]', section: "sidebar" },
      signal,
    });
  });

  it("leases and uploads replayable WidgetMedia with cancellation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        s3UploadLease: {
          action: "//bucket.example/upload",
          fields: [
            { name: "key", value: "widgets/photo.png" },
            { name: "policy", value: "signed" },
          ],
        },
      })
      .mockResolvedValueOnce("");
    const signal = new AbortController().signal;
    const media = WidgetMedia.fromBytes(
      new Uint8Array([137, 80, 78, 71]),
      "photo.png",
    );
    await expect(
      new SubredditWidgets({ request }, "test").mod.uploadImage(media, signal),
    ).resolves.toBe("https://bucket.example/upload/widgets/photo.png");
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: "POST",
      path: "/r/test/api/widget_image_upload_s3",
      data: { filepath: "photo.png", mimetype: "image/png" },
      signal,
    });
    const upload = request.mock.calls[1]?.[0];
    expect(upload).toMatchObject({
      auth: false,
      method: "POST",
      path: "https://bucket.example/upload",
      rawJson: false,
      responseType: "text",
      signal,
    });
    const body = upload.data as ReplayableBody;
    expect(Array.from(body.create() as Uint8Array)).toEqual(
      Array.from(body.create() as Uint8Array),
    );
  });

  it("rejects read-only, cancellation, invalid input, and malformed responses before mutation", async () => {
    const request = vi.fn();
    const readOnly = new SubredditWidgets({ request, readOnly: true }, "test");
    await expect(readOnly.fetch()).rejects.toThrow("read-only");
    await expect(
      readOnly.mod.addTextArea({ shortName: "Text", styles, text: "x" }),
    ).rejects.toThrow("read-only");

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new SubredditWidgets({ request }, "test").fetch({
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();

    const mod = new SubredditWidgets({ request }, "test").mod;
    expect(() =>
      mod.addTextArea({ shortName: "x".repeat(31), styles, text: "" }),
    ).toThrow("30");
    expect(() =>
      mod.addCustomWidget({
        css: "",
        height: 49,
        imageData: [],
        shortName: "x",
        styles,
        text: "",
      }),
    ).toThrow("height");
    await expect(mod.reorder(["same", "same"])).rejects.toThrow("duplicates");

    request.mockResolvedValue({ items: [], layout: {} });
    await expect(
      new SubredditWidgets({ request }, "test").fetch(),
    ).rejects.toThrow("invalid widgets");
  });
});

describe("widget models", () => {
  const client = { request: vi.fn() };

  it("objectifies every widget kind and its nested collections", () => {
    const button = objectifyWidget(client, "test", {
      id: "button",
      kind: "button",
      buttons: [
        { kind: "text" },
        { kind: "image", hoverState: { kind: "image", url: "hover.png" } },
      ],
      styles,
    });
    expect(button).toBeInstanceOf(ButtonWidget);
    if (!(button instanceof ButtonWidget))
      throw new TypeError("expected button");
    expect(button.buttons).toEqual([expect.any(Button), expect.any(Button)]);
    expect(button.buttons[0]?.hoverState).toBeUndefined();
    expect(button.buttons[1]?.hoverState).toBeInstanceOf(Hover);
    expect(button.styles).toBeInstanceOf(Styles);

    const calendar = objectifyWidget(client, "test", {
      id: "calendar",
      kind: "calendar",
      configuration: { numEvents: 3 },
    });
    expect(calendar).toBeInstanceOf(Calendar);
    expect((calendar as Calendar).configuration).toBeInstanceOf(
      CalendarConfiguration,
    );

    const communities = objectifyWidget(client, "test", {
      id: "communities",
      kind: "community-list",
      data: ["one", { display_name: "two" }, { name: "three", subscribers: 3 }],
    });
    expect(communities).toBeInstanceOf(CommunityList);
    expect((communities as CommunityList).data.map(String)).toEqual([
      "one",
      "two",
      "three",
    ]);

    const custom = objectifyWidget(client, "test", {
      id: "custom",
      kind: "custom",
      imageData: [{ name: "logo" }],
    });
    expect(custom).toBeInstanceOf(CustomWidget);
    expect((custom as CustomWidget).imageData[0]).toBeInstanceOf(ImageData);

    const image = objectifyWidget(client, "test", {
      id: "image",
      kind: "image",
      data: [{ url: "image.png" }],
    });
    expect(image).toBeInstanceOf(ImageWidget);
    expect((image as ImageWidget).data[0]).toBeInstanceOf(Image);

    const menu = objectifyWidget(client, "test", {
      id: "menu",
      kind: "menu",
      data: [
        { text: "link", url: "/link" },
        { text: "nested", children: [{ text: "child", url: "/child" }] },
      ],
    });
    expect(menu).toBeInstanceOf(Menu);
    expect((menu as Menu).data[0]).toBeInstanceOf(MenuLink);
    expect((menu as Menu).data[1]).toBeInstanceOf(Submenu);
    expect(((menu as Menu).data[1] as Submenu).children[0]).toBeInstanceOf(
      MenuLink,
    );

    const moderators = objectifyWidget(client, "test", {
      id: "moderators",
      kind: "moderators",
    });
    expect(moderators).toBeInstanceOf(ModeratorsWidget);
    expect((moderators as ModeratorsWidget).mods).toEqual([]);

    const flairOrder = ["one"];
    const flair = objectifyWidget(client, "test", {
      id: "flair",
      kind: "post-flair",
      order: flairOrder,
    });
    flairOrder.push("mutated");
    expect(flair).toBeInstanceOf(PostFlairWidget);
    expect((flair as PostFlairWidget).order).toEqual(["one"]);

    const rule = { shortName: "be kind" };
    const rules = objectifyWidget(client, "test", {
      id: "rules",
      kind: "subreddit-rules",
      data: [rule],
    });
    rule.shortName = "mutated";
    expect(rules).toBeInstanceOf(RulesWidget);
    expect((rules as RulesWidget).data).toEqual([{ shortName: "be kind" }]);
    expect(
      objectifyWidget(client, "test", {
        id: "empty-rules",
        kind: "subreddit-rules",
      }),
    ).toMatchObject({ data: [] });
    expect(
      objectifyWidget(client, "test", { id: "card", kind: "id-card" }),
    ).toBeInstanceOf(IDCard);
    expect(
      objectifyWidget(client, "test", { id: "text", kind: "textarea" }),
    ).toBeInstanceOf(TextArea);
  });

  it("provides identity, equality, and explicit moderation attachment", async () => {
    const widget = objectifyWidget(client, "test", {
      id: "MixedCase",
      kind: "textarea",
    });
    expect(widget.toString()).toBe("MixedCase");
    expect(
      widget.equals(
        objectifyWidget(client, "other", {
          id: "mixedcase",
          kind: "textarea",
        }),
      ),
    ).toBe(true);
    expect(widget.equals({ id: "MixedCase" })).toBe(false);
    expect(() => widget.mod).toThrow("not configured");

    const actions = {
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(widget),
    };
    expect(widget.attachModeration(actions)).toBe(widget);
    await widget.mod.delete();
    expect(actions.delete).toHaveBeenCalledOnce();
  });

  it.each([
    [null, "invalid widget data"],
    [{ kind: "textarea" }, "invalid widget id"],
    [{ id: "x", kind: "unknown" }, "unsupported widget kind"],
    [{ id: "x", kind: "textarea", styles: null }, "invalid widget styles"],
    [{ id: "x", kind: "button", buttons: null }, "invalid widget buttons"],
    [
      { id: "x", kind: "button", buttons: [{ kind: "other" }] },
      "invalid widget button kind",
    ],
    [
      { id: "x", kind: "button", buttons: [{ kind: "text", hoverState: 1 }] },
      "invalid button hover state",
    ],
    [
      { id: "x", kind: "calendar", configuration: null },
      "invalid calendar configuration",
    ],
    [{ id: "x", kind: "community-list", data: null }, "community-list data"],
    [
      { id: "x", kind: "community-list", data: [1] },
      "community-list subreddit",
    ],
    [
      { id: "x", kind: "community-list", data: [{}] },
      "community-list subreddit",
    ],
    [{ id: "x", kind: "custom", imageData: [1] }, "custom widget image data"],
    [{ id: "x", kind: "image", data: [1] }, "image widget data"],
    [{ id: "x", kind: "menu", data: null }, "invalid menu data"],
    [
      { id: "x", kind: "menu", data: [{ children: null }] },
      "invalid submenu children",
    ],
    [{ id: "x", kind: "moderators", mods: [1] }, "moderators widget data"],
    [
      { id: "x", kind: "moderators", mods: [{ name: "" }] },
      "invalid moderator name",
    ],
    [{ id: "x", kind: "post-flair", order: null }, "post-flair order"],
    [{ id: "x", kind: "post-flair", order: [1] }, "post-flair order"],
    [{ id: "x", kind: "subreddit-rules", data: [1] }, "rules widget data"],
  ] as const)("rejects malformed widget data %#", (data, message) => {
    expect(() => objectifyWidget(client, "test", data)).toThrow(message);
  });
});

describe("widget domain edge cases", () => {
  it("guards access before fetch and validates layout invariants", async () => {
    const unfetched = new SubredditWidgets({ request: vi.fn() }, "test");
    expect(() => unfetched.items).toThrow("not been fetched");
    expect(() => unfetched.sidebar).toThrow("not been fetched");
    expect(() => unfetched.topbar).toThrow("not been fetched");
    expect(() => unfetched.idCard).toThrow("not been fetched");
    expect(() => unfetched.moderatorsWidget).toThrow("not been fetched");
    expect(() => new SubredditWidgets({ request: vi.fn() }, " ")).toThrow(
      "subreddit cannot be empty",
    );

    const cases: readonly [unknown, string][] = [
      [null, "invalid widgets data"],
      [{ items: [] }, "invalid widgets data"],
      [{ items: {}, layout: null }, "invalid widget layout"],
      [
        {
          items: {},
          layout: {
            idCardWidget: 1,
            moderatorWidget: "mods",
            sidebar: { order: [] },
            topbar: { order: [] },
          },
        },
        "invalid widget layout",
      ],
      [
        {
          items: {},
          layout: {
            idCardWidget: "card",
            moderatorWidget: "mods",
            sidebar: null,
            topbar: { order: [] },
          },
        },
        "invalid widget sidebar layout",
      ],
      [
        {
          items: {},
          layout: {
            idCardWidget: "card",
            moderatorWidget: "mods",
            sidebar: { order: [] },
            topbar: { order: [1] },
          },
        },
        "invalid widget topbar layout",
      ],
      [
        {
          items: { wrong: { id: "actual", kind: "textarea" } },
          layout: {
            idCardWidget: "wrong",
            moderatorWidget: "wrong",
            sidebar: { order: [] },
            topbar: { order: [] },
          },
        },
        "does not match widget ID",
      ],
      [
        {
          items: {},
          layout: {
            idCardWidget: "missing",
            moderatorWidget: "missing",
            sidebar: { order: [] },
            topbar: { order: [] },
          },
        },
        "references missing widget",
      ],
    ];
    for (const [response, message] of cases) {
      const widgets = new SubredditWidgets(
        { request: vi.fn().mockResolvedValue(response) },
        "test",
      );
      await expect(widgets.fetch()).rejects.toThrow(message);
    }
  });

  it("rejects semantically invalid accessor widget types and stale maps", async () => {
    const response = widgetResponse();
    response.items.card.kind = "textarea";
    response.items.mods.kind = "textarea";
    response.items.menu.kind = "textarea";
    const widgets = await new SubredditWidgets(
      { request: vi.fn().mockResolvedValue(response) },
      "test",
    ).fetch();
    expect(() => widgets.idCard).toThrow("invalid ID card");
    expect(() => widgets.moderatorsWidget).toThrow("invalid moderators");
    expect(() => widgets.topbar).toThrow("non-menu");

    (widgets.items as Map<string, unknown>).delete("text");
    expect(() => widgets.sidebar).toThrow("references missing widget text");
  });

  it("accepts response envelopes and serializes model values in create/update", async () => {
    const request = vi.fn().mockImplementation(async (input: RedditRequest) => {
      const payload = JSON.parse(
        (input.data as { json: string }).json,
      ) as Record<string, unknown>;
      if (input.method === "PUT") {
        return { json: { data: { ...payload, id: "text", kind: "textarea" } } };
      }
      return { json: { data: { id: "text", kind: "textarea", ...payload } } };
    });
    const widgets = new SubredditWidgets({ request }, "test");
    const model = new BaseModel({ request }, { nested: true });
    await widgets.mod.addTextArea({
      shortName: "Text",
      styles,
      text: "hello",
      otherSettings: { model } as unknown as Record<string, string>,
    });
    const createdPayload = JSON.parse(
      (request.mock.calls[0]?.[0].data as { json: string }).json,
    ) as Record<string, unknown>;
    expect(createdPayload["model"]).toEqual({ nested: true });
    const signal = new AbortController().signal;
    await widgets.mod.addTextArea(
      { shortName: "Signaled", styles, text: "hello" },
      signal,
    );
    expect(request.mock.calls[1]?.[0]).toMatchObject({ signal });

    request.mockReset();
    request
      .mockResolvedValueOnce(widgetResponse())
      .mockImplementationOnce(async (input: RedditRequest) => {
        const payload = JSON.parse(
          (input.data as { json: string }).json,
        ) as Record<string, unknown>;
        expect(payload["subreddit"]).toBeUndefined();
        expect(payload["styles"]).toEqual(styles);
        return { data: { ...payload, id: "text", kind: "textarea" } };
      });
    const fetched = await widgets.fetch();
    await expect(
      fetched.sidebar[0]!.mod.update({ text: "new" }),
    ).resolves.toBeInstanceOf(TextArea);

    const subreddit = new Subreddit({ request }, "linked");
    request.mockImplementationOnce(async (input: RedditRequest) => {
      const payload = JSON.parse((input.data as { json: string }).json) as {
        data: unknown[];
      };
      expect(payload.data).toEqual(["linked"]);
      return { id: "menu", kind: "menu", data: [] };
    });
    await widgets.mod.addMenu({
      data: [subreddit] as unknown as { text: string; url: string }[],
    });
  });

  it.each([
    ["short name empty", () => ({ shortName: " ", styles, text: "" }), "empty"],
    [
      "short name long",
      () => ({ shortName: "x".repeat(31), styles, text: "" }),
      "30",
    ],
    [
      "invalid background",
      () => ({
        shortName: "x",
        styles: { ...styles, backgroundColor: "red" },
        text: "",
      }),
      "6-digit",
    ],
    [
      "invalid header",
      () => ({
        shortName: "x",
        styles: { ...styles, headerColor: "#123" },
        text: "",
      }),
      "6-digit",
    ],
  ])("validates text widget input: %s", (_name, options, message) => {
    const mod = new SubredditWidgets({ request: vi.fn() }, "test").mod;
    expect(() => mod.addTextArea(options())).toThrow(message);
  });

  it("validates every specialized create method", () => {
    const mod = new SubredditWidgets({ request: vi.fn() }, "test").mod;
    const calendar = (numEvents: number, googleCalendarId = "id") =>
      mod.addCalendar({
        configuration: {
          numEvents,
          showDate: true,
          showDescription: true,
          showLocation: true,
          showTime: true,
          showTitle: true,
        },
        googleCalendarId,
        requiresSync: false,
        shortName: "calendar",
        styles,
      });
    expect(() => calendar(0)).toThrow("positive integer");
    expect(() => calendar(1.5)).toThrow("positive integer");
    expect(() => calendar(1, " ")).toThrow("cannot be empty");
    expect(() =>
      mod.addCommunityList({ data: [], shortName: "list", styles }),
    ).toThrow("cannot be empty");
    expect(() =>
      mod.addImageWidget({ data: [], shortName: "image", styles }),
    ).toThrow("cannot be empty");
    expect(() =>
      mod.addPostFlairWidget({
        display: "list",
        order: ["same", "same"],
        shortName: "flair",
        styles,
      }),
    ).toThrow("duplicates");

    const custom = (height: number, css: string) =>
      mod.addCustomWidget({
        css,
        height,
        imageData: [],
        shortName: "custom",
        styles,
        text: "",
      });
    for (const height of [49, 501, 50.5]) {
      expect(() => custom(height, "x")).toThrow("height");
    }
    expect(() => custom(50, "")).toThrow("CSS");
    expect(() => custom(50, "x".repeat(100_001))).toThrow("CSS");
  });

  it("validates reorder identifiers and sends the default section", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const mod = new SubredditWidgets({ request }, "test").mod;
    await mod.reorder(["one"]);
    expect(request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/r/test/api/widget_order/sidebar",
      data: { json: '["one"]', section: "sidebar" },
    });
    await expect(mod.reorder([" "])).rejects.toThrow(
      "widget ID cannot be empty",
    );
    await expect(
      mod.reorder([{ id: "", kind: "textarea" } as TextArea]),
    ).rejects.toThrow("widget ID cannot be empty");
  });

  it("enforces read-only access on every moderation operation", async () => {
    const request = vi.fn();
    const readOnly = { request, readOnly: true };
    const widget = objectifyWidget(readOnly, "test", {
      id: "widget",
      kind: "textarea",
    });
    const actions = new SubredditWidgets(readOnly, "test").mod;
    widget.attachModeration(new WidgetModeration(readOnly, "test", widget));
    await expect(widget.mod.delete()).rejects.toThrow("read-only");
    await expect(widget.mod.update({})).rejects.toThrow("read-only");
    await expect(actions.reorder([])).rejects.toThrow("read-only");
    await expect(
      actions.uploadImage(WidgetMedia.fromBytes(new Uint8Array(), "x.png")),
    ).rejects.toThrow("read-only");
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts every operation before requests and propagates request errors", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const request = vi.fn();
    const widgets = new SubredditWidgets({ request }, "test");
    const widget = objectifyWidget({ request }, "test", {
      id: "text",
      kind: "textarea",
    });
    widget.attachModeration(new WidgetModeration({ request }, "test", widget));
    await expect(
      widgets.mod.addTextArea(
        { shortName: "text", styles, text: "" },
        controller.signal,
      ),
    ).rejects.toThrow("stop");
    await expect(
      widgets.mod.reorder([], "topbar", controller.signal),
    ).rejects.toThrow("stop");
    await expect(
      widgets.mod.uploadImage(
        WidgetMedia.fromBytes(new Uint8Array(), "x.png"),
        controller.signal,
      ),
    ).rejects.toThrow("stop");
    await expect(widget.mod.delete(controller.signal)).rejects.toThrow("stop");
    await expect(widget.mod.update({}, controller.signal)).rejects.toThrow(
      "stop",
    );
    expect(request).not.toHaveBeenCalled();

    const failure = new Error("network");
    const failing = new SubredditWidgets(
      { request: vi.fn().mockRejectedValue(failure) },
      "test",
    );
    await expect(failing.fetch()).rejects.toBe(failure);
    await expect(
      failing.mod.addTextArea({ shortName: "x", styles, text: "" }),
    ).rejects.toBe(failure);
    await expect(failing.mod.reorder([])).rejects.toBe(failure);
    await expect(
      failing.mod.uploadImage(WidgetMedia.fromBytes(new Uint8Array(), "x.png")),
    ).rejects.toBe(failure);
  });

  it("validates widget uploads, leases, cancellation, and upload errors", async () => {
    const mod = new SubredditWidgets({ request: vi.fn() }, "test").mod;
    await expect(
      mod.uploadImage(
        Media.fromBytes(new Uint8Array(), "x.png") as unknown as WidgetMedia,
      ),
    ).rejects.toThrow("must be WidgetMedia");
    await expect(
      mod.uploadImage(WidgetMedia.fromBytes(new Uint8Array(), "x.mp4")),
    ).rejects.toThrow("must be an image");

    const malformed: readonly unknown[] = [
      null,
      {},
      { s3UploadLease: {} },
      { s3UploadLease: { action: 1, fields: [] } },
      { s3UploadLease: { action: "https://upload", fields: null } },
      { s3UploadLease: { action: "https://upload", fields: [null] } },
      {
        s3UploadLease: {
          action: "https://upload",
          fields: [{ name: 1, value: "key" }],
        },
      },
      {
        s3UploadLease: {
          action: "https://upload",
          fields: [{ name: "key", value: 1 }],
        },
      },
      {
        s3UploadLease: {
          action: "https://upload",
          fields: [{ name: "policy", value: "signed" }],
        },
      },
    ];
    for (const response of malformed) {
      const widgets = new SubredditWidgets(
        { request: vi.fn().mockResolvedValue(response) },
        "test",
      );
      await expect(
        widgets.mod.uploadImage(
          WidgetMedia.fromBytes(new Uint8Array(), "x.png"),
        ),
      ).rejects.toThrow("lease");
    }

    const controller = new AbortController();
    const leaseRequest = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("after lease"));
      return {
        s3UploadLease: {
          action: "https://upload/",
          fields: [{ name: "key", value: "x.png" }],
        },
      };
    });
    await expect(
      new SubredditWidgets({ request: leaseRequest }, "test").mod.uploadImage(
        WidgetMedia.fromBytes(new Uint8Array(), "x.png"),
        controller.signal,
      ),
    ).rejects.toThrow("after lease");
    expect(leaseRequest).toHaveBeenCalledOnce();

    const uploadFailure = new Error("upload failed");
    const uploadRequest = vi
      .fn()
      .mockResolvedValueOnce({
        s3UploadLease: {
          action: "https://upload/",
          fields: [{ name: "key", value: "x.png" }],
        },
      })
      .mockRejectedValueOnce(uploadFailure);
    await expect(
      new SubredditWidgets({ request: uploadRequest }, "test").mod.uploadImage(
        WidgetMedia.fromBytes(new Uint8Array(), "x.png"),
      ),
    ).rejects.toBe(uploadFailure);
  });

  it("constructs WidgetMedia from paths and preserves subclass factories", () => {
    const media = WidgetMedia.fromPath(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      { name: "widget.PNG" },
    );
    expect(media).toBeInstanceOf(WidgetMedia);
    expect(media.mimeType).toBe("image/png");
    expect(WidgetMedia.fromBytes(new Uint8Array([1]), "x.webp")).toBeInstanceOf(
      WidgetMedia,
    );
  });

  it("rejects malformed create and update responses and propagates delete errors", async () => {
    const malformedCreate = new SubredditWidgets(
      { request: vi.fn().mockResolvedValue([]) },
      "test",
    );
    await expect(
      malformedCreate.mod.addTextArea({ shortName: "x", styles, text: "" }),
    ).rejects.toThrow("invalid widget data");

    const failure = new Error("delete failed");
    const request = vi
      .fn()
      .mockResolvedValueOnce(widgetResponse())
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(failure);
    const widgets = await new SubredditWidgets({ request }, "test").fetch();
    const text = widgets.sidebar[0]!;
    await expect(text.mod.update({})).rejects.toThrow("invalid widget data");
    await expect(text.mod.delete()).rejects.toBe(failure);
    expect(request).toHaveBeenLastCalledWith({
      method: "DELETE",
      path: "/r/test/api/widget/text",
    });
  });
});
