import { Auth } from "../core/auth.js";
import { Front } from "../helpers.js";
import { Listing } from "../listing.js";
import { BaseModel, type RawData, type RedditClientLike } from "./base.js";
import {
  Comment,
  Message,
  MoreComments,
  Redditor,
  Submission,
  Subreddit,
  UserSubreddit,
} from "./entities.js";
import {
  InlineGif,
  InlineImage,
  InlineMedia,
  InlineVideo,
  Media,
  PostMedia,
} from "./media.js";

export {
  Auth,
  Comment,
  Front,
  InlineGif,
  InlineImage,
  InlineMedia,
  InlineVideo,
  Listing,
  Listing as ListingGenerator,
  Media,
  Message,
  MoreComments,
  PostMedia,
  Redditor,
  Submission,
  Subreddit,
  UserSubreddit,
};

/** Raw Reddit response with forward-compatible access to unmodelled fields. */
class ResponseModel extends BaseModel {
  constructor(client: RedditClientLike, data: RawData = {}) {
    super(client, data);
  }
}

/** A model namespace that is client-bound but implements no network operations. */
class ClientContainer {
  readonly client: RedditClientLike;

  constructor(client: RedditClientLike) {
    this.client = client;
  }
}

/** Eager response list that retains the client used to objectify its items. */
class ResponseList<T> extends Array<T> {
  readonly client: RedditClientLike;

  constructor(client: RedditClientLike, items: Iterable<T> = []) {
    super(...items);
    this.client = client;
  }
}

export class AnnouncementListing<T = Announcement> extends Listing<T> {}
export class DomainListing<T = Submission> extends Listing<T> {}
export class ModeratorListing<T = Redditor> extends Listing<T> {}
export class ModmailConversationsListing<
  T = ModmailConversation,
> extends Listing<T> {}

export class EmojiMedia extends Media {}
export class StylesheetAsset extends Media {}
export class StylesheetImage extends Media {}
export class WidgetMedia extends Media {}

export class Announcement extends Submission {}
export class Collection extends ResponseModel {}
export class Draft extends ResponseModel {}
export class Emoji extends ResponseModel {}
export class LiveThread extends ResponseModel {}
export class LiveUpdate extends ResponseModel {}
export class ModAction extends ResponseModel {}
export class ModNote extends ResponseModel {}
export class ModmailAction extends ResponseModel {}
export class ModmailConversation extends ResponseModel {}
export class ModmailMessage extends ResponseModel {}
export class Multireddit extends ResponseModel {}
export class PollData extends ResponseModel {}
export class PollOption extends ResponseModel {}
export class Preferences extends ResponseModel {}
export class RemovalReason extends ResponseModel {}
export class Rule extends ResponseModel {}
export class Stylesheet extends ResponseModel {}
export class SubredditMessage extends Message {}
export class Trophy extends ResponseModel {}
export class User extends ResponseModel {}
export class WikiPage extends ResponseModel {}

export class AnnouncementHelper extends ClientContainer {}
export class DraftHelper extends ClientContainer {}
export class DraftList extends ResponseList<Draft> {}
export class Inbox extends ClientContainer {}
export class LiveHelper extends ClientContainer {}
export class ModeratedList extends ResponseList<Subreddit> {}
export class MultiredditHelper extends ClientContainer {}
export class RedditModNotes extends ClientContainer {}
export class RedditorList extends ResponseList<Redditor> {}
export class RedditorModNotes extends ClientContainer {}
export class Redditors extends ClientContainer {}
export class SubredditHelper extends ClientContainer {}
export class SubredditModNotes extends ClientContainer {}
export class Subreddits extends ClientContainer {}
export class TrophyList extends ResponseList<Trophy> {}

/** Base for the distinct widget response types exposed by PRAW. */
export class Widget extends ResponseModel {
  static readonly widgetType: string = "widget";

  get widgetType(): string {
    return (this.constructor as typeof Widget).widgetType;
  }
}

export class ButtonWidget extends Widget {
  static override readonly widgetType = "button";
}

export class Calendar extends Widget {
  static override readonly widgetType = "calendar";
}

export class CommunityList extends Widget {
  static override readonly widgetType = "community-list";
}

export class CustomWidget extends Widget {
  static override readonly widgetType = "custom";
}

export class IDCard extends Widget {
  static override readonly widgetType = "id-card";
}

export class ImageWidget extends Widget {
  static override readonly widgetType = "image";
}

export class Menu extends Widget {
  static override readonly widgetType = "menu";
}

export class ModeratorsWidget extends Widget {
  static override readonly widgetType = "moderators";
}

export class PostFlairWidget extends Widget {
  static override readonly widgetType = "post-flair";
}

export class RulesWidget extends Widget {
  static override readonly widgetType = "rules";
}

export class TextArea extends Widget {
  static override readonly widgetType = "textarea";
}

export class Button extends ResponseModel {}
export class CalendarConfiguration extends ResponseModel {}
export class Hover extends ResponseModel {}
export class Image extends ResponseModel {}
export class ImageData extends ResponseModel {}
export class MenuLink extends ResponseModel {}
export class Styles extends ResponseModel {}
export class Submenu extends ResponseList<MenuLink> {}

export class SubredditWidgets extends ClientContainer {}
export class SubredditWidgetsModeration extends ClientContainer {}
export class WidgetModeration extends ClientContainer {}
