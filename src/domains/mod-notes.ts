import {
  Listing,
  moderatorNotesPageAdapter,
  type ListingOptions,
} from "../listing.js";
import { Objector } from "../objector.js";
import { isRawData } from "../models/base.js";
import { Comment, Submission } from "../models/entities.js";
import {
  ModNote,
  assertModeratorAccess,
  referenceString,
  requiredString,
  subredditName,
  type ModerationClientLike,
  type RedditorReference,
  type SubredditReference,
  type ThingReference,
} from "../models/moderation.js";

export type ModNoteLabel =
  | "ABUSE_WARNING"
  | "BAN"
  | "BOT_BAN"
  | "HELPFUL_USER"
  | "PERMA_BAN"
  | "SOLID_CONTRIBUTOR"
  | "SPAM_WARNING"
  | "SPAM_WATCH";

const MOD_NOTE_LABELS = new Set<ModNoteLabel>([
  "ABUSE_WARNING",
  "BAN",
  "BOT_BAN",
  "HELPFUL_USER",
  "PERMA_BAN",
  "SOLID_CONTRIBUTOR",
  "SPAM_WARNING",
  "SPAM_WATCH",
]);

export interface ModNoteListOptions extends ListingOptions {
  readonly redditor: RedditorReference;
}

export interface ModNotePair {
  readonly redditor: RedditorReference;
  readonly subreddit: SubredditReference;
}

export type ModNoteThing = Comment | Submission;

export interface ModNoteFilterOptions extends ListingOptions {
  readonly allNotes?: boolean;
  readonly pairs?: readonly ModNotePair[];
  readonly redditors?: readonly RedditorReference[];
  readonly subreddits?: readonly SubredditReference[];
  readonly things?: readonly ModNoteThing[];
}

export interface ModNoteSelectionOptions extends ListingOptions {
  readonly allNotes?: boolean;
}

export interface CreateModNoteOptions {
  readonly label?: ModNoteLabel;
  readonly note: string;
  readonly redditor?: RedditorReference;
  readonly subreddit?: SubredditReference;
  readonly thing?: ThingReference;
}

export interface DeleteModNoteOptions {
  readonly deleteAll?: boolean;
  readonly noteId?: string;
  readonly redditor?: RedditorReference;
  readonly signal?: AbortSignal;
  readonly subreddit?: SubredditReference;
}

function noteObject(
  client: ModerationClientLike,
  value: unknown,
): ModNote | null {
  if (value === null) return null;
  let data = value;
  if (isRawData(data) && isRawData(data["json"])) data = data["json"];
  if (isRawData(data) && isRawData(data["data"])) data = data["data"];
  if (!isRawData(data))
    throw new TypeError("Reddit returned invalid mod note data");
  return new ModNote(client, data);
}

function noteListing(
  client: ModerationClientLike,
  pair: ModNotePair,
  options: ListingOptions,
): Listing<ModNote> {
  const { params, ...listing } = options;
  return new Listing(client, "/api/mod/notes", {
    ...listing,
    objector: new Objector(client, {
      mod_note: (modelClient, data) => new ModNote(modelClient, data),
    }),
    pageAdapter: moderatorNotesPageAdapter,
    params: {
      ...params,
      subreddit: subredditName(pair.subreddit),
      user: referenceString(pair.redditor, "redditor"),
    },
    requestLimit: listing.requestLimit ?? 100,
  });
}

function thingPair(thing: ModNoteThing): ModNotePair {
  if (!(thing instanceof Comment || thing instanceof Submission)) {
    throw new TypeError(
      "things must contain only Comment or Submission objects",
    );
  }
  const author = thing.get("author");
  const subreddit = thing.get("subreddit");
  if (
    author === undefined ||
    author === null ||
    subreddit === undefined ||
    subreddit === null
  ) {
    throw new TypeError("thing must have an author and subreddit");
  }
  return {
    redditor: referenceString(author, "thing author"),
    subreddit: referenceString(subreddit, "thing subreddit"),
  };
}

function listingOptions(options: ModNoteFilterOptions): ListingOptions {
  return {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.objector === undefined ? {} : { objector: options.objector }),
    ...(options.pageAdapter === undefined
      ? {}
      : { pageAdapter: options.pageAdapter }),
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.requestLimit === undefined
      ? {}
      : { requestLimit: options.requestLimit }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function selectedPairs(options: ModNoteFilterOptions): ModNotePair[] {
  const pairs = [...(options.pairs ?? [])];
  const redditors = options.redditors ?? [];
  const subreddits = options.subreddits ?? [];
  const things = options.things ?? [];
  if (
    pairs.length + redditors.length + subreddits.length + things.length ===
    0
  ) {
    throw new TypeError(
      "pairs, redditors, subreddits, or things must be provided",
    );
  }
  if ((redditors.length === 0) !== (subreddits.length === 0)) {
    throw new TypeError(
      redditors.length === 0
        ? "redditors must be non-empty when subreddits are provided"
        : "subreddits must be non-empty when redditors are provided",
    );
  }
  for (const redditor of redditors) {
    for (const subreddit of subreddits) pairs.push({ redditor, subreddit });
  }
  pairs.push(...things.map(thingPair));
  for (const pair of pairs) {
    referenceString(pair.redditor, "redditor");
    subredditName(pair.subreddit);
  }
  return pairs;
}

async function* allModNotes(
  client: ModerationClientLike,
  pairs: readonly ModNotePair[],
  options: ListingOptions,
): AsyncGenerator<ModNote> {
  for (const pair of pairs) {
    options.signal?.throwIfAborted();
    yield* noteListing(client, pair, options);
  }
}

async function* recentModNotes(
  client: ModerationClientLike,
  pairs: readonly ModNotePair[],
  signal?: AbortSignal,
): AsyncGenerator<ModNote | null> {
  for (let index = 0; index < pairs.length; index += 500) {
    signal?.throwIfAborted();
    const chunk = pairs.slice(index, index + 500);
    const response = await client.request({
      method: "GET",
      path: "/api/mod/notes/recent",
      params: {
        subreddits: chunk
          .map((pair) => subredditName(pair.subreddit))
          .join(","),
        users: chunk
          .map((pair) => referenceString(pair.redditor, "redditor"))
          .join(","),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!isRawData(response) || !Array.isArray(response["mod_notes"])) {
      throw new TypeError("Reddit returned invalid bulk mod notes data");
    }
    for (const note of response["mod_notes"]) yield noteObject(client, note);
  }
}

function findThing(value: unknown): ModNoteThing | undefined {
  if (value instanceof Comment || value instanceof Submission) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findThing(item);
      if (found !== undefined) return found;
    }
  } else if (isRawData(value)) {
    for (const item of Object.values(value)) {
      const found = findThing(item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export class BaseModNotes {
  protected readonly client: ModerationClientLike;
  protected readonly redditor: RedditorReference | undefined;
  protected readonly subreddit: SubredditReference | undefined;

  constructor(
    client: ModerationClientLike,
    scope: {
      readonly redditor?: RedditorReference;
      readonly subreddit?: SubredditReference;
    } = {},
  ) {
    this.client = client;
    this.redditor = scope.redditor;
    this.subreddit = scope.subreddit;
    if (scope.redditor !== undefined)
      referenceString(scope.redditor, "redditor");
    if (scope.subreddit !== undefined) subredditName(scope.subreddit);
  }

  async create(
    options: CreateModNoteOptions,
    signal?: AbortSignal,
  ): Promise<ModNote> {
    assertModeratorAccess(this.client, "notes.create()");
    signal?.throwIfAborted();
    if (typeof options.note !== "string")
      throw new TypeError("note must be a string");
    if (options.note.length > 250)
      throw new RangeError("note must be 250 characters or less");
    if (options.label !== undefined && !MOD_NOTE_LABELS.has(options.label)) {
      throw new RangeError(`Invalid mod note label: ${options.label}`);
    }

    let redditor = this.redditor ?? options.redditor;
    let subreddit = this.subreddit ?? options.subreddit;
    let redditId: string | undefined;
    if (options.thing !== undefined) {
      redditId = requiredString(
        typeof options.thing === "string"
          ? options.thing
          : options.thing.fullname,
        "thing fullname",
      );
      if (redditor === undefined || subreddit === undefined) {
        const response = await this.client.request({
          method: "GET",
          path: "/api/info",
          params: { id: redditId },
          ...(signal === undefined ? {} : { signal }),
        });
        const thing = findThing(new Objector(this.client).objectify(response));
        if (thing === undefined)
          throw new TypeError("thing lookup returned no Comment or Submission");
        const pair = thingPair(thing);
        redditor ??= pair.redditor;
        subreddit ??= pair.subreddit;
      }
    }
    if (redditor === undefined)
      throw new TypeError("redditor or thing must be provided");
    if (subreddit === undefined)
      throw new TypeError("subreddit or thing must be provided");

    const data: Record<string, string> = {
      note: options.note,
      subreddit: subredditName(subreddit),
      user: referenceString(redditor, "redditor"),
    };
    if (options.label !== undefined) data["label"] = options.label;
    if (redditId !== undefined) data["reddit_id"] = redditId;
    const response = await this.client.request({
      method: "POST",
      path: "/api/mod/notes",
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    const result = noteObject(this.client, response);
    if (result === null)
      throw new TypeError("Reddit returned invalid mod note data");
    return result;
  }

  async delete(options: DeleteModNoteOptions): Promise<void> {
    assertModeratorAccess(this.client, "notes.delete()");
    options.signal?.throwIfAborted();
    const redditor = this.redditor ?? options.redditor;
    const subreddit = this.subreddit ?? options.subreddit;
    if (redditor === undefined)
      throw new TypeError("redditor must be provided");
    if (subreddit === undefined)
      throw new TypeError("subreddit must be provided");
    const pair = { redditor, subreddit };
    if (options.deleteAll === true) {
      for await (const note of noteListing(this.client, pair, {
        limit: null,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        await this.deleteOne(note.toString(), pair, options.signal);
      }
      return;
    }
    if (options.noteId === undefined) {
      throw new TypeError("Either noteId or deleteAll must be provided");
    }
    await this.deleteOne(options.noteId, pair, options.signal);
  }

  private async deleteOne(
    noteId: string,
    pair: ModNotePair,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: "/api/mod/notes",
      params: {
        note_id: requiredString(noteId, "note ID"),
        subreddit: subredditName(pair.subreddit),
        user: referenceString(pair.redditor, "redditor"),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export class RedditModNotes extends BaseModNotes {
  list(options: ModNoteFilterOptions): AsyncIterable<ModNote | null> {
    assertModeratorAccess(this.client, "notes.list()");
    const pairs = selectedPairs(options);
    return options.allNotes === true
      ? allModNotes(this.client, pairs, listingOptions(options))
      : recentModNotes(this.client, pairs, options.signal);
  }

  things(
    things: readonly ModNoteThing[],
    options?: ModNoteSelectionOptions,
  ): AsyncIterable<ModNote | null> {
    return this.list({
      ...options,
      allNotes: options?.allNotes ?? things.length === 1,
      things,
    });
  }
}

export class SubredditModNotes extends BaseModNotes {
  readonly scopedSubreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    super(client, { subreddit });
    this.scopedSubreddit = subreddit;
  }

  list(options: ModNoteListOptions): Listing<ModNote> {
    assertModeratorAccess(this.client, "notes.list()");
    const { redditor, ...listing } = options;
    return noteListing(
      this.client,
      { redditor, subreddit: this.scopedSubreddit },
      listing,
    );
  }

  redditors(
    redditors: readonly RedditorReference[],
    options: ModNoteSelectionOptions = {},
  ): AsyncIterable<ModNote | null> {
    assertModeratorAccess(this.client, "notes.redditors()");
    if (redditors.length === 0)
      throw new RangeError("At least one redditor must be provided");
    const pairs = redditors.map((redditor) => ({
      redditor,
      subreddit: this.scopedSubreddit,
    }));
    return (options.allNotes ?? redditors.length === 1)
      ? allModNotes(this.client, pairs, options)
      : recentModNotes(this.client, pairs, options.signal);
  }

  async bulk(
    redditors: readonly RedditorReference[],
    signal?: AbortSignal,
  ): Promise<(ModNote | null)[]> {
    const result: (ModNote | null)[] = [];
    for await (const note of this.redditors(redditors, {
      allNotes: false,
      ...(signal === undefined ? {} : { signal }),
    })) {
      result.push(note);
    }
    return result;
  }
}

export class RedditorModNotes extends BaseModNotes {
  readonly scopedRedditor: RedditorReference;

  constructor(client: ModerationClientLike, redditor: RedditorReference) {
    super(client, { redditor });
    this.scopedRedditor = redditor;
  }

  subreddits(
    subreddits: readonly SubredditReference[],
    options: ModNoteSelectionOptions = {},
  ): AsyncIterable<ModNote | null> {
    assertModeratorAccess(this.client, "notes.subreddits()");
    if (subreddits.length === 0)
      throw new RangeError("At least one subreddit must be provided");
    const pairs = subreddits.map((subreddit) => ({
      redditor: this.scopedRedditor,
      subreddit,
    }));
    return (options.allNotes ?? subreddits.length === 1)
      ? allModNotes(this.client, pairs, options)
      : recentModNotes(this.client, pairs, options.signal);
  }
}

export async function bulkModNotes(
  client: ModerationClientLike,
  pairs: readonly ModNotePair[],
  signal?: AbortSignal,
): Promise<(ModNote | null)[]> {
  assertModeratorAccess(client, "notes.bulk()");
  const result: (ModNote | null)[] = [];
  for await (const note of recentModNotes(client, pairs, signal))
    result.push(note);
  return result;
}
