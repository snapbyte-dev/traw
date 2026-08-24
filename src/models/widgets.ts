import type { JsonValue } from "../core/transport.js";
import {
  BaseModel,
  isRawData,
  type RawData,
  type RedditClientLike,
} from "./base.js";
import { Redditor, Subreddit } from "./entities.js";
import type { SubredditReference } from "./moderation.js";

export type WidgetKind =
  | "button"
  | "calendar"
  | "community-list"
  | "custom"
  | "id-card"
  | "image"
  | "menu"
  | "moderators"
  | "post-flair"
  | "subreddit-rules"
  | "textarea";

export interface WidgetActions {
  delete(signal?: AbortSignal): Promise<void>;
  update(
    changes: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<AnyWidget>;
}

function rawObject(value: unknown, description: string): RawData {
  if (!isRawData(value))
    throw new TypeError(`Reddit returned invalid ${description}`);
  return value;
}

function rawArray(value: unknown, description: string): RawData[] {
  if (!Array.isArray(value) || !value.every(isRawData)) {
    throw new TypeError(`Reddit returned invalid ${description}`);
  }
  return value;
}

function stringField(
  data: RawData,
  field: string,
  description: string,
): string {
  const value = data[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Reddit returned invalid ${description} ${field}`);
  }
  return value;
}

export class Styles extends BaseModel {
  declare readonly backgroundColor?: string;
  declare readonly headerColor?: string;
}

export class Hover extends BaseModel {
  declare readonly kind: "image" | "text";
}

export class Button extends BaseModel {
  declare readonly hoverState?: Hover;
  declare readonly kind: "image" | "text";

  constructor(client: RedditClientLike, data: RawData) {
    const kind = data["kind"];
    if (kind !== "image" && kind !== "text") {
      throw new TypeError("Reddit returned invalid widget button kind");
    }
    const hover = data["hoverState"];
    super(client, {
      ...data,
      ...(hover === undefined
        ? {}
        : {
            hoverState: new Hover(
              client,
              rawObject(hover, "button hover state"),
            ),
          }),
    });
  }
}

export class CalendarConfiguration extends BaseModel {}
export class Image extends BaseModel {}
export class ImageData extends BaseModel {}
export class MenuLink extends BaseModel {}

export class Submenu extends BaseModel {
  declare readonly children: readonly MenuLink[];

  constructor(client: RedditClientLike, data: RawData) {
    super(client, {
      ...data,
      children: rawArray(data["children"], "submenu children").map(
        (child) => new MenuLink(client, child),
      ),
    });
  }
}

export class Widget extends BaseModel {
  declare readonly id: string;
  declare readonly kind: WidgetKind;
  declare readonly styles?: Styles;
  readonly subreddit: SubredditReference;
  #actions: WidgetActions | undefined;

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
    actions?: WidgetActions,
  ) {
    stringField(data, "id", "widget");
    const styles = data["styles"];
    super(client, {
      ...data,
      ...(styles === undefined
        ? {}
        : { styles: new Styles(client, rawObject(styles, "widget styles")) }),
    });
    this.subreddit = subreddit;
    this.#actions = actions;
  }

  get mod(): WidgetActions {
    if (this.#actions === undefined) {
      throw new TypeError("Widget moderation is not configured");
    }
    return this.#actions;
  }

  attachModeration(actions: WidgetActions): this {
    this.#actions = actions;
    return this;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Widget &&
      other.id.toLowerCase() === this.id.toLowerCase()
    );
  }

  override toString(): string {
    return this.id;
  }
}

export class ButtonWidget extends Widget {
  declare readonly kind: "button";
  declare readonly buttons: readonly Button[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, subreddit, {
      ...data,
      buttons: rawArray(data["buttons"], "widget buttons").map(
        (button) => new Button(client, button),
      ),
    });
  }
}

export class Calendar extends Widget {
  declare readonly kind: "calendar";
  declare readonly configuration: CalendarConfiguration;

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, subreddit, {
      ...data,
      configuration: new CalendarConfiguration(
        client,
        rawObject(data["configuration"], "calendar configuration"),
      ),
    });
  }
}

export class CommunityList extends Widget {
  declare readonly kind: "community-list";
  declare readonly data: readonly Subreddit[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    const rawCommunities = data["data"];
    if (!Array.isArray(rawCommunities)) {
      throw new TypeError("Reddit returned invalid community-list data");
    }
    const communities = rawCommunities.map((item) => {
      if (typeof item === "string") return new Subreddit(client, item);
      if (!isRawData(item)) {
        throw new TypeError("Reddit returned invalid community-list subreddit");
      }
      const name = item["display_name"] ?? item["name"];
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("Reddit returned invalid community-list subreddit");
      }
      return new Subreddit(client, { ...item, display_name: name });
    });
    super(client, subreddit, { ...data, data: communities });
  }
}

export class CustomWidget extends Widget {
  declare readonly kind: "custom";
  declare readonly imageData: readonly ImageData[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, subreddit, {
      ...data,
      imageData: rawArray(data["imageData"], "custom widget image data").map(
        (image) => new ImageData(client, image),
      ),
    });
  }
}

export class IDCard extends Widget {
  declare readonly kind: "id-card";
}

export class ImageWidget extends Widget {
  declare readonly kind: "image";
  declare readonly data: readonly Image[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, subreddit, {
      ...data,
      data: rawArray(data["data"], "image widget data").map(
        (image) => new Image(client, image),
      ),
    });
  }
}

export type MenuItem = MenuLink | Submenu;

export class Menu extends Widget {
  declare readonly kind: "menu";
  declare readonly data: readonly MenuItem[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    const items = rawArray(data["data"], "menu data").map((item) =>
      "children" in item
        ? new Submenu(client, item)
        : new MenuLink(client, item),
    );
    super(client, subreddit, { ...data, data: items });
  }
}

export class ModeratorsWidget extends Widget {
  declare readonly kind: "moderators";
  declare readonly mods: readonly Redditor[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    const mods = data["mods"] ?? [];
    super(client, subreddit, {
      ...data,
      mods: rawArray(mods, "moderators widget data").map((moderator) => {
        stringField(moderator, "name", "moderator");
        return new Redditor(client, moderator);
      }),
    });
  }
}

export class PostFlairWidget extends Widget {
  declare readonly kind: "post-flair";
  declare readonly order: readonly string[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    const order = data["order"];
    if (
      !Array.isArray(order) ||
      !order.every((value) => typeof value === "string")
    ) {
      throw new TypeError("Reddit returned invalid post-flair order");
    }
    super(client, subreddit, { ...data, order: [...order] });
  }
}

export class RulesWidget extends Widget {
  declare readonly kind: "subreddit-rules";
  declare readonly data: readonly Readonly<RawData>[];

  constructor(
    client: RedditClientLike,
    subreddit: SubredditReference,
    data: RawData,
  ) {
    super(client, subreddit, {
      ...data,
      data: rawArray(data["data"] ?? [], "rules widget data").map((rule) => ({
        ...rule,
      })),
    });
  }
}

export class TextArea extends Widget {
  declare readonly kind: "textarea";
}

export type AnyWidget =
  | ButtonWidget
  | Calendar
  | CommunityList
  | CustomWidget
  | IDCard
  | ImageWidget
  | Menu
  | ModeratorsWidget
  | PostFlairWidget
  | RulesWidget
  | TextArea;

export function objectifyWidget(
  client: RedditClientLike,
  subreddit: SubredditReference,
  value: unknown,
): AnyWidget {
  const data = rawObject(value, "widget data");
  switch (data["kind"]) {
    case "button":
      return new ButtonWidget(client, subreddit, data);
    case "calendar":
      return new Calendar(client, subreddit, data);
    case "community-list":
      return new CommunityList(client, subreddit, data);
    case "custom":
      return new CustomWidget(client, subreddit, data);
    case "id-card":
      return new IDCard(client, subreddit, data);
    case "image":
      return new ImageWidget(client, subreddit, data);
    case "menu":
      return new Menu(client, subreddit, data);
    case "moderators":
      return new ModeratorsWidget(client, subreddit, data);
    case "post-flair":
      return new PostFlairWidget(client, subreddit, data);
    case "subreddit-rules":
      return new RulesWidget(client, subreddit, data);
    case "textarea":
      return new TextArea(client, subreddit, data);
    default:
      throw new TypeError(
        `Reddit returned unsupported widget kind ${String(data["kind"])}`,
      );
  }
}
