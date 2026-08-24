import {
  type AccountDomain,
  type Announcement,
  Comment,
  type CreateSubredditOptions,
  type Draft,
  type InboxDomain,
  InlineImage,
  type LegacyModmailDomain,
  type LiveDomain,
  type LiveThread,
  TrawError,
  Media,
  type Message,
  type ModmailDomain,
  type ModNote,
  type Multireddit,
  Reddit,
  type SubredditFlair,
  type SubredditCollections,
  type SubredditEmoji,
  type SubredditModNotes,
  type RedditModNotes,
  type RedditorModNotes,
  type SubredditModeration,
  type SubredditSettings,
  type SubredditSettingsOptions,
  type SubredditQuarantine,
  type SubredditRelationship,
  type SubredditRemovalReasons,
  type SubredditRules,
  type SubredditStylesheet,
  type SubredditWidgets,
  type SubredditWiki,
  type RedditOptions,
  type RemovalMessageOptions,
  type RemovalMessageType,
  type Submission,
  type SubmitOptions,
  type UserSubreddit,
  PostMedia,
  PreferencesDomain,
  type WebSocketFactory,
} from "../../src/index.js";

const options: RedditOptions = {
  clientId: "client",
  clientSecret: "secret",
  userAgent: "traw:type-test",
};

const reddit = new Reddit(options);
const trawError: Error = new TrawError("typed error");
const comment: Comment = reddit.comment("abc");
const submissions: AsyncIterable<Submission> = reddit.front.hot({ limit: 10 });
const best: AsyncIterable<Submission> = reddit.front.best({ limit: 10 });
const controversial: AsyncIterable<Submission> = reddit
  .subreddit("all")
  .controversial({
    timeFilter: "day",
  });
const search: AsyncIterable<Submission> = reddit
  .subreddit("typescript")
  .search("types", {
    sort: "comments",
    syntax: "lucene",
    timeFilter: "year",
  });
const streamed: AsyncIterable<Submission | null> = reddit
  .redditor("spez")
  .stream.submissions({ pauseAfter: 0, signal: new AbortController().signal });
const bytes = new Media(new Uint8Array([1]), "pixel.png");
const postMedia = PostMedia.fromBytes(new Uint8Array([1]), "pixel.png");
const inline = new InlineImage({ media: postMedia });
const webSocketFactory: WebSocketFactory = () => ({
  addEventListener: () => undefined,
  close: () => undefined,
  removeEventListener: () => undefined,
});
const inlineSubmit: SubmitOptions = {
  inlineMedia: { image1: inline },
  kind: "text",
  selftext: "image {image1}",
};
const removalMessageType: RemovalMessageType = "public_as_subreddit";
const removalMessageOptions: RemovalMessageOptions = {
  signal: new AbortController().signal,
  type: removalMessageType,
};
const account: AccountDomain = reddit.account;
const preferencesDomain: PreferencesDomain = reddit.account.preferences;
const isPreferencesDomain: boolean =
  reddit.account.preferences instanceof PreferencesDomain;
const currentAccount = await reddit.account.me();
const profileSubreddit: UserSubreddit | null | undefined =
  currentAccount.subreddit;
const inbox: InboxDomain = reddit.inbox;
const messages: AsyncIterable<Message> = inbox.messages();
const announcements: AsyncIterable<Announcement> = reddit.announcements.list();
const draft: Draft = reddit.drafts.reference("draft-id");
const subreddit = reddit.subreddit("typescript");
const createSubredditOptions: CreateSubredditOptions = {
  linkType: "self",
  subredditType: "restricted",
  wikimode: "modonly",
};
const updateSubredditOptions: SubredditSettingsOptions = {
  crowdControlLevel: 3,
  spamLinks: "high",
};
const createdSubreddit = reddit.subreddits.create(
  "typedcommunity",
  createSubredditOptions,
  new AbortController().signal,
);
const subredditSettings: Promise<SubredditSettings> =
  subreddit.moderation.settings();
void subreddit.moderation.update(updateSubredditOptions);
const moderation: SubredditModeration = subreddit.moderation;
const quarantine: SubredditQuarantine = subreddit.quarantine;
const banned: SubredditRelationship = subreddit.banned;
const flair: SubredditFlair = subreddit.flair;
const modNotes: SubredditModNotes = subreddit.modNotes;
const subredditModerationNotes: SubredditModNotes = moderation.notes;
const redditModNotes: RedditModNotes = reddit.notes;
const redditorModNotes: RedditorModNotes = reddit.redditor("spez").notes;
const recentNotes: AsyncIterable<ModNote | null> = reddit.notes.list({
  pairs: [{ redditor: "spez", subreddit: "typescript" }],
});
const allNotes: AsyncIterable<ModNote | null> = redditorModNotes.subreddits(
  ["typescript"],
  { allNotes: true, signal: new AbortController().signal },
);
const rules: SubredditRules = subreddit.rules;
const removalReasons: SubredditRemovalReasons = subreddit.removalReasons;
const modmail: ModmailDomain = subreddit.modmail;
const legacyModmail: LegacyModmailDomain = subreddit.legacyModmail;
const wiki: SubredditWiki = subreddit.wiki;
const emoji: SubredditEmoji = subreddit.emoji;
const stylesheet: SubredditStylesheet = subreddit.stylesheet;
const widgets: SubredditWidgets = subreddit.widgets;
const collections: SubredditCollections = subreddit.collections;
const liveDomain: LiveDomain = reddit.live;
const liveThread: LiveThread = liveDomain.reference("thread");
const multireddit: Multireddit = reddit.multireddits.reference("alice", "dev");
void reddit.live.create("thread", {
  signal: new AbortController().signal,
});

void comment;
void submissions;
void best;
void controversial;
void search;
void streamed;
void bytes;
void inlineSubmit;
void removalMessageOptions;
void webSocketFactory;
void account;
void preferencesDomain;
void isPreferencesDomain;
void profileSubreddit;
void messages;
void announcements;
void draft;
void createdSubreddit;
void subredditSettings;
void moderation;
void quarantine;
void banned;
void flair;
void modNotes;
void subredditModerationNotes;
void redditModNotes;
void recentNotes;
void allNotes;
void rules;
void removalReasons;
void modmail;
void legacyModmail;
void wiki;
void emoji;
void stylesheet;
void widgets;
void collections;
void liveThread;
void multireddit;

void reddit.submission("post").mod.updateCrowdControlLevel(3);
void trawError;
void reddit.submission("post").mod.suggestedSort("qa");
void reddit.submission("post").mod.suggestedSort({ sort: "new" });
void reddit.submission("post").flair.select("template", { text: "custom" });
void reddit.submission("post").edit("image {image1}", {
  inlineMedia: { image1: inline },
});
void reddit.comment("comment").mod.distinguish({ how: "yes", sticky: true });
void reddit.comment("comment").mod.show();
void reddit
  .comment("comment")
  .mod.sendRemovalMessage("removed", removalMessageOptions);
void reddit.submission("post").mod.sendRemovalMessage("removed", {
  title: "Rule 1",
  type: "private",
});
// @ts-expect-error crowd-control show is comment-only
void reddit.submission("post").mod.show;

// @ts-expect-error time filters are closed to PRAW-supported values
reddit.front.controversial({ timeFilter: "decade" });
// @ts-expect-error search sorts are closed to PRAW-supported values
reddit.subreddit("all").search("q", { sort: "old" });
// @ts-expect-error crowd control levels range from 0 through 3
void reddit.submission("post").mod.updateCrowdControlLevel(4);
// @ts-expect-error subreddit types are closed to API-supported values
void reddit.subreddits.create("invalid", { subredditType: "hidden" });
// @ts-expect-error removal message types are closed to PRAW-supported values
const invalidRemovalMessageOptions: RemovalMessageOptions = { type: "hidden" };
void invalidRemovalMessageOptions;
const invalidInlineSubmit: SubmitOptions = {
  image: postMedia,
  // @ts-expect-error inline media is only supported by text self-posts
  inlineMedia: { image1: inline },
  kind: "image",
};
void invalidInlineSubmit;

// @ts-expect-error clientSecret must be present or explicitly null
const invalid: RedditOptions = { clientId: "client", userAgent: "agent" };
void invalid;
