import { replayableMultipart, type JsonValue } from "../core/transport.js";
import { BaseModel, isRawData, type RawData } from "../models/base.js";
import { Subreddit } from "../models/entities.js";
import { Media, type MediaOptions } from "../models/media.js";
import {
  assertModeratorAccess,
  requiredString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";
import {
  objectifyWidget,
  type AnyWidget,
  type ButtonWidget,
  type Calendar,
  type CommunityList,
  type CustomWidget,
  type IDCard,
  type ImageWidget,
  type Menu,
  type ModeratorsWidget,
  type PostFlairWidget,
  type TextArea,
  type Widget,
  type WidgetActions,
} from "../models/widgets.js";

export interface WidgetStyles {
  readonly backgroundColor: string;
  readonly headerColor: string;
}

export interface TextButtonData {
  readonly kind: "text";
  readonly text: string;
  readonly url: string;
  readonly color: string;
  readonly textColor: string;
  readonly fillColor: string;
  readonly hoverState?: Readonly<Record<string, JsonValue>>;
}

export interface ImageButtonData {
  readonly kind: "image";
  readonly text: string;
  readonly linkUrl: string;
  readonly url: string;
  readonly height: number;
  readonly width: number;
  readonly hoverState?: Readonly<Record<string, JsonValue>>;
}

export type ButtonData = ImageButtonData | TextButtonData;

export interface CalendarConfigurationData {
  readonly numEvents: number;
  readonly showDate: boolean;
  readonly showDescription: boolean;
  readonly showLocation: boolean;
  readonly showTime: boolean;
  readonly showTitle: boolean;
}

export interface ImageDataInput {
  readonly height: number;
  readonly linkUrl?: string;
  readonly name?: string;
  readonly url: string;
  readonly width: number;
}

export interface MenuLinkInput {
  readonly text: string;
  readonly url: string;
}

export interface SubmenuInput {
  readonly children: readonly MenuLinkInput[];
  readonly text: string;
}

type ExtraSettings = Readonly<Record<string, JsonValue>>;

interface StyledWidgetOptions {
  readonly shortName: string;
  readonly styles: WidgetStyles;
  readonly otherSettings?: ExtraSettings;
}

export interface AddButtonWidgetOptions extends StyledWidgetOptions {
  readonly buttons: readonly ButtonData[];
  readonly description: string;
}

export interface AddCalendarOptions extends StyledWidgetOptions {
  readonly configuration: CalendarConfigurationData;
  readonly googleCalendarId: string;
  readonly requiresSync: boolean;
}

export interface AddCommunityListOptions extends StyledWidgetOptions {
  readonly data: readonly SubredditReference[];
  readonly description?: string;
}

export interface AddCustomWidgetOptions extends StyledWidgetOptions {
  readonly css: string;
  readonly height: number;
  readonly imageData: readonly ImageDataInput[];
  readonly text: string;
}

export interface AddImageWidgetOptions extends StyledWidgetOptions {
  readonly data: readonly ImageDataInput[];
}

export interface AddMenuOptions {
  readonly data: readonly (MenuLinkInput | SubmenuInput)[];
  readonly otherSettings?: ExtraSettings;
}

export interface AddPostFlairWidgetOptions extends StyledWidgetOptions {
  readonly display: "cloud" | "list";
  readonly order: readonly string[];
}

export interface AddTextAreaOptions extends StyledWidgetOptions {
  readonly text: string;
}

export interface WidgetFetchOptions {
  readonly progressiveImages?: boolean;
  readonly signal?: AbortSignal;
}

export type WidgetSection = "sidebar" | "topbar";

function validateShortName(value: string): string {
  const name = requiredString(value, "widget short name");
  if (name.length > 30)
    throw new RangeError("widget short name cannot exceed 30 characters");
  return name;
}

function validateStyles(styles: WidgetStyles): WidgetStyles {
  const color = /^#[0-9a-f]{6}$/i;
  if (!color.test(styles.backgroundColor) || !color.test(styles.headerColor)) {
    throw new TypeError("widget styles must contain 6-digit hex colors");
  }
  return styles;
}

function responseWidgetData(value: unknown): RawData {
  let data = value;
  if (isRawData(data) && isRawData(data["json"])) data = data["json"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (!isRawData(data))
    throw new TypeError("Reddit returned invalid widget data");
  return data;
}

function widgetId(value: string | Widget): string {
  return requiredString(
    typeof value === "string" ? value : value.id,
    "widget ID",
  );
}

function widgetJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Subreddit) return String(item);
    if (item instanceof BaseModel) return item.raw;
    return item;
  });
}

function uploadLease(value: unknown): {
  readonly fields: readonly (readonly [string, string])[];
  readonly key: string;
  readonly url: string;
} {
  if (!isRawData(value) || !isRawData(value["s3UploadLease"])) {
    throw new TypeError("widget media lease response is missing s3UploadLease");
  }
  const lease = value["s3UploadLease"];
  const action = lease["action"];
  const fields = lease["fields"];
  if (typeof action !== "string" || !Array.isArray(fields)) {
    throw new TypeError("widget media lease response is malformed");
  }
  const entries = fields.map((field): readonly [string, string] => {
    if (
      !isRawData(field) ||
      typeof field["name"] !== "string" ||
      typeof field["value"] !== "string"
    ) {
      throw new TypeError(
        "widget media lease response contains a malformed field",
      );
    }
    return [field["name"], field["value"]];
  });
  const key = entries.find(([name]) => name === "key")?.[1];
  if (key === undefined)
    throw new TypeError("widget media lease response has no key");
  return {
    fields: entries,
    key,
    url: action.startsWith("//") ? `https:${action}` : action,
  };
}

export class WidgetMedia extends Media {
  static override fromBytes(
    bytes: Uint8Array,
    name: string,
    options: Omit<MediaOptions, "name"> = {},
  ): WidgetMedia {
    return new this(bytes, name, options);
  }

  static override fromPath(
    path: string,
    options: MediaOptions = {},
  ): WidgetMedia {
    return new this(path, options);
  }
}

export class WidgetModeration implements WidgetActions {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;
  readonly widget: Widget;

  constructor(
    client: ModerationClientLike,
    subreddit: SubredditReference,
    widget: Widget,
  ) {
    this.#client = client;
    this.#subreddit = subreddit;
    this.widget = widget;
  }

  async delete(signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.#client, "widgets.delete()");
    signal?.throwIfAborted();
    await this.#client.request({
      method: "DELETE",
      path: `/r/${subredditPath(this.#subreddit)}/api/widget/${encodeURIComponent(this.widget.id)}`,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async update(
    changes: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<AnyWidget> {
    assertModeratorAccess(this.#client, "widgets.update()");
    signal?.throwIfAborted();
    const payload = { ...this.widget.raw, ...changes };
    delete payload["subreddit"];
    const response = await this.#client.request({
      method: "PUT",
      path: `/r/${subredditPath(this.#subreddit)}/api/widget/${encodeURIComponent(this.widget.id)}`,
      data: { json: widgetJson(payload) },
      ...(signal === undefined ? {} : { signal }),
    });
    return attachModeration(
      this.#client,
      this.#subreddit,
      responseWidgetData(response),
    );
  }
}

function attachModeration(
  client: ModerationClientLike,
  subreddit: SubredditReference,
  data: RawData,
): AnyWidget {
  const widget = objectifyWidget(client, subreddit, data);
  return widget.attachModeration(
    new WidgetModeration(client, subreddit, widget),
  );
}

export class SubredditWidgetsModeration {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  addButtonWidget(
    options: AddButtonWidgetOptions,
    signal?: AbortSignal,
  ): Promise<ButtonWidget> {
    return this.create(
      {
        buttons: options.buttons,
        description: options.description,
        kind: "button",
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        ...options.otherSettings,
      },
      signal,
    ) as Promise<ButtonWidget>;
  }

  addCalendar(
    options: AddCalendarOptions,
    signal?: AbortSignal,
  ): Promise<Calendar> {
    if (
      !Number.isSafeInteger(options.configuration.numEvents) ||
      options.configuration.numEvents < 1
    ) {
      throw new RangeError("calendar numEvents must be a positive integer");
    }
    return this.create(
      {
        configuration: options.configuration,
        googleCalendarId: requiredString(
          options.googleCalendarId,
          "Google calendar ID",
        ),
        kind: "calendar",
        requiresSync: options.requiresSync,
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        ...options.otherSettings,
      },
      signal,
    ) as Promise<Calendar>;
  }

  addCommunityList(
    options: AddCommunityListOptions,
    signal?: AbortSignal,
  ): Promise<CommunityList> {
    if (options.data.length === 0)
      throw new TypeError("community list cannot be empty");
    return this.create(
      {
        data: options.data.map(subredditName),
        description: options.description ?? "",
        kind: "community-list",
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        ...options.otherSettings,
      },
      signal,
    ) as Promise<CommunityList>;
  }

  addCustomWidget(
    options: AddCustomWidgetOptions,
    signal?: AbortSignal,
  ): Promise<CustomWidget> {
    if (
      !Number.isSafeInteger(options.height) ||
      options.height < 50 ||
      options.height > 500
    ) {
      throw new RangeError("custom widget height must be between 50 and 500");
    }
    if (options.css.length === 0 || options.css.length > 100_000) {
      throw new RangeError(
        "custom widget CSS must contain 1 to 100000 characters",
      );
    }
    return this.create(
      {
        css: options.css,
        height: options.height,
        imageData: options.imageData,
        kind: "custom",
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        text: options.text,
        ...options.otherSettings,
      },
      signal,
    ) as Promise<CustomWidget>;
  }

  addImageWidget(
    options: AddImageWidgetOptions,
    signal?: AbortSignal,
  ): Promise<ImageWidget> {
    if (options.data.length === 0)
      throw new TypeError("image widget data cannot be empty");
    return this.create(
      {
        data: options.data,
        kind: "image",
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        ...options.otherSettings,
      },
      signal,
    ) as Promise<ImageWidget>;
  }

  addMenu(options: AddMenuOptions, signal?: AbortSignal): Promise<Menu> {
    return this.create(
      { data: options.data, kind: "menu", ...options.otherSettings },
      signal,
    ) as Promise<Menu>;
  }

  addPostFlairWidget(
    options: AddPostFlairWidgetOptions,
    signal?: AbortSignal,
  ): Promise<PostFlairWidget> {
    if (new Set(options.order).size !== options.order.length) {
      throw new TypeError("post flair order cannot contain duplicates");
    }
    return this.create(
      {
        display: options.display,
        kind: "post-flair",
        order: options.order,
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        ...options.otherSettings,
      },
      signal,
    ) as Promise<PostFlairWidget>;
  }

  addTextArea(
    options: AddTextAreaOptions,
    signal?: AbortSignal,
  ): Promise<TextArea> {
    return this.create(
      {
        kind: "textarea",
        shortName: validateShortName(options.shortName),
        styles: validateStyles(options.styles),
        text: options.text,
        ...options.otherSettings,
      },
      signal,
    ) as Promise<TextArea>;
  }

  async reorder(
    order: readonly (string | Widget)[],
    section: WidgetSection = "sidebar",
    signal?: AbortSignal,
  ): Promise<void> {
    assertModeratorAccess(this.#client, "widgets.reorder()");
    signal?.throwIfAborted();
    const ids = order.map(widgetId);
    if (new Set(ids).size !== ids.length)
      throw new TypeError("widget order cannot contain duplicates");
    await this.#client.request({
      method: "PATCH",
      path: `/r/${subredditPath(this.#subreddit)}/api/widget_order/${section}`,
      data: { json: JSON.stringify(ids), section },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async uploadImage(media: WidgetMedia, signal?: AbortSignal): Promise<string> {
    assertModeratorAccess(this.#client, "widgets.uploadImage()");
    signal?.throwIfAborted();
    if (!(media instanceof WidgetMedia))
      throw new TypeError("media must be WidgetMedia");
    if (!media.mimeType.startsWith("image/"))
      throw new TypeError("widget media must be an image");
    const lease = uploadLease(
      await this.#client.request({
        method: "POST",
        path: `/r/${subredditPath(this.#subreddit)}/api/widget_image_upload_s3`,
        data: { filepath: media.name, mimetype: media.mimeType },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    signal?.throwIfAborted();
    await this.#client.request({
      auth: false,
      method: "POST",
      path: lease.url,
      data: replayableMultipart(lease.fields, {
        bytes: media.create(),
        contentType: media.mimeType,
        name: media.name,
      }),
      rawJson: false,
      responseType: "text",
      ...(signal === undefined ? {} : { signal }),
    });
    return `${lease.url.replace(/\/$/, "")}/${lease.key}`;
  }

  private async create(
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<AnyWidget> {
    assertModeratorAccess(this.#client, "widgets.create()");
    signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "POST",
      path: `/r/${subredditPath(this.#subreddit)}/api/widget`,
      data: { json: widgetJson(payload) },
      ...(signal === undefined ? {} : { signal }),
    });
    return attachModeration(
      this.#client,
      this.#subreddit,
      responseWidgetData(response),
    );
  }
}

interface WidgetLayout {
  readonly idCardWidget: string;
  readonly moderatorWidget: string;
  readonly sidebar: { readonly order: readonly string[] };
  readonly topbar: { readonly order: readonly string[] };
}

function parseLayout(value: unknown): WidgetLayout {
  if (
    !isRawData(value) ||
    typeof value["idCardWidget"] !== "string" ||
    typeof value["moderatorWidget"] !== "string"
  ) {
    throw new TypeError("Reddit returned invalid widget layout");
  }
  const section = (
    name: "sidebar" | "topbar",
  ): { readonly order: readonly string[] } => {
    const item = value[name];
    if (
      !isRawData(item) ||
      !Array.isArray(item["order"]) ||
      !item["order"].every((id) => typeof id === "string")
    ) {
      throw new TypeError(`Reddit returned invalid widget ${name} layout`);
    }
    return { order: [...item["order"]] };
  };
  return {
    idCardWidget: value["idCardWidget"],
    moderatorWidget: value["moderatorWidget"],
    sidebar: section("sidebar"),
    topbar: section("topbar"),
  };
}

export class SubredditWidgets {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;
  #items?: ReadonlyMap<string, AnyWidget>;
  #layout?: WidgetLayout;
  readonly mod: SubredditWidgetsModeration;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
    this.mod = new SubredditWidgetsModeration(client, subreddit);
  }

  get items(): ReadonlyMap<string, AnyWidget> {
    if (this.#items === undefined)
      throw new TypeError("Widgets have not been fetched");
    return this.#items;
  }

  get sidebar(): readonly AnyWidget[] {
    return this.section("sidebar");
  }

  get topbar(): readonly Menu[] {
    const widgets = this.section("topbar");
    if (!widgets.every((widget): widget is Menu => widget.kind === "menu")) {
      throw new TypeError("Reddit returned a non-menu topbar widget");
    }
    return widgets;
  }

  get idCard(): IDCard {
    const widget = this.item(this.layout.idCardWidget);
    if (widget.kind !== "id-card") {
      throw new TypeError("Reddit returned an invalid ID card widget");
    }
    return widget;
  }

  get moderatorsWidget(): ModeratorsWidget {
    const widget = this.item(this.layout.moderatorWidget);
    if (widget.kind !== "moderators") {
      throw new TypeError("Reddit returned an invalid moderators widget");
    }
    return widget;
  }

  async fetch(options: WidgetFetchOptions = {}): Promise<this> {
    return this.refresh(options);
  }

  async refresh(options: WidgetFetchOptions = {}): Promise<this> {
    assertModeratorAccess(this.#client, "widgets.fetch()");
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/r/${subredditPath(this.#subreddit)}/api/widgets`,
      params: { progressive_images: options.progressiveImages ?? false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!isRawData(response) || !isRawData(response["items"])) {
      throw new TypeError("Reddit returned invalid widgets data");
    }
    const layout = parseLayout(response["layout"]);
    const items = new Map<string, AnyWidget>();
    for (const [id, raw] of Object.entries(response["items"])) {
      const widget = attachModeration(
        this.#client,
        this.#subreddit,
        responseWidgetData(raw),
      );
      if (widget.id !== id)
        throw new TypeError(
          `Widget item key ${id} does not match widget ID ${widget.id}`,
        );
      items.set(id, widget);
    }
    for (const id of [
      layout.idCardWidget,
      layout.moderatorWidget,
      ...layout.sidebar.order,
      ...layout.topbar.order,
    ]) {
      if (!items.has(id))
        throw new TypeError(`Widget layout references missing widget ${id}`);
    }
    this.#layout = layout;
    this.#items = items;
    return this;
  }

  private get layout(): WidgetLayout {
    if (this.#layout === undefined)
      throw new TypeError("Widgets have not been fetched");
    return this.#layout;
  }

  private item(id: string): AnyWidget {
    const widget = this.items.get(id);
    if (widget === undefined)
      throw new TypeError(`Widget layout references missing widget ${id}`);
    return widget;
  }

  private section(section: WidgetSection): readonly AnyWidget[] {
    return this.layout[section].order.map((id) => this.item(id));
  }
}
