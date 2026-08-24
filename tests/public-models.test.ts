import { describe, expect, it, vi } from "vitest";

import * as models from "../src/models/public.js";
import { Listing } from "../src/listing.js";
import { BaseModel } from "../src/models/base.js";
import { Media, PostMedia } from "../src/models/media.js";

const PRAW_MODEL_EXPORTS = [
  "Announcement",
  "AnnouncementHelper",
  "AnnouncementListing",
  "Auth",
  "Button",
  "ButtonWidget",
  "Calendar",
  "CalendarConfiguration",
  "Collection",
  "Comment",
  "CommunityList",
  "CustomWidget",
  "DomainListing",
  "Draft",
  "DraftHelper",
  "DraftList",
  "Emoji",
  "EmojiMedia",
  "Front",
  "Hover",
  "IDCard",
  "Image",
  "ImageData",
  "ImageWidget",
  "Inbox",
  "InlineGif",
  "InlineImage",
  "InlineMedia",
  "InlineVideo",
  "Listing",
  "ListingGenerator",
  "LiveHelper",
  "LiveThread",
  "LiveUpdate",
  "Media",
  "Menu",
  "MenuLink",
  "Message",
  "ModAction",
  "ModNote",
  "ModeratedList",
  "ModeratorListing",
  "ModeratorsWidget",
  "ModmailAction",
  "ModmailConversation",
  "ModmailConversationsListing",
  "ModmailMessage",
  "MoreComments",
  "Multireddit",
  "MultiredditHelper",
  "PollData",
  "PollOption",
  "PostFlairWidget",
  "PostMedia",
  "Preferences",
  "RedditModNotes",
  "Redditor",
  "RedditorList",
  "RedditorModNotes",
  "Redditors",
  "RemovalReason",
  "Rule",
  "RulesWidget",
  "Styles",
  "Stylesheet",
  "StylesheetAsset",
  "StylesheetImage",
  "Submenu",
  "Submission",
  "Subreddit",
  "SubredditHelper",
  "SubredditMessage",
  "SubredditModNotes",
  "SubredditWidgets",
  "SubredditWidgetsModeration",
  "Subreddits",
  "TextArea",
  "Trophy",
  "TrophyList",
  "User",
  "UserSubreddit",
  "Widget",
  "WidgetMedia",
  "WidgetModeration",
  "WikiPage",
] as const;

describe("public PRAW model exports", () => {
  it("matches the PRAW 8.0.3 runtime manifest", () => {
    expect(Object.keys(models).sort()).toEqual([...PRAW_MODEL_EXPORTS].sort());
    expect(PRAW_MODEL_EXPORTS).toHaveLength(85);
  });

  it("uses model, listing, media, and widget foundations", () => {
    const client = { request: vi.fn() };

    expect(new models.PollData(client, { id: "poll" })).toBeInstanceOf(
      BaseModel,
    );
    expect(
      new models.DomainListing(client, "/domain/example.com"),
    ).toBeInstanceOf(Listing);
    expect(models.EmojiMedia.prototype).toBeInstanceOf(Media);
    const media = PostMedia.fromBytes(new Uint8Array(), "inline.png");
    expect(new models.InlineImage({ media }).media).toBe(media);
    expect(new models.DraftList(client)).toBeInstanceOf(Array);
    expect(new models.ButtonWidget(client).widgetType).toBe("button");
    expect(new models.SubredditHelper(client).client).toBe(client);
  });
});
