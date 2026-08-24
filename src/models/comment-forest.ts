import { Comment, MoreComments, Submission } from "./entities.js";

export type CommentNode = Comment | MoreComments;

interface MoreLocation {
  readonly item: MoreComments;
  readonly tree: CommentNode[];
}

export interface ReplaceMoreOptions {
  readonly limit?: number | null;
  readonly threshold?: number;
}

/** Mutable tree of top-level comments and their reply forests. */
export class CommentForest implements Iterable<CommentNode> {
  readonly submission: Submission;
  readonly #comments: CommentNode[];
  #replacing = false;

  constructor(submission: Submission, comments: readonly CommentNode[] = []) {
    this.submission = submission;
    this.#comments = [...comments];
    for (const comment of this.#comments) this.attach(comment);
  }

  get length(): number {
    return this.#comments.length;
  }

  at(index: number): CommentNode | undefined {
    return this.#comments.at(index);
  }

  [Symbol.iterator](): Iterator<CommentNode> {
    return this.#comments[Symbol.iterator]();
  }

  list(): CommentNode[] {
    const flattened: CommentNode[] = [];
    const queue = [...this.#comments];
    for (const item of queue) {
      flattened.push(item);
      if (item instanceof Comment)
        queue.push(...this.repliesOf(item).#comments);
    }
    return flattened;
  }

  async replaceMore(options: ReplaceMoreOptions = {}): Promise<MoreComments[]> {
    const limit = options.limit === undefined ? 32 : options.limit;
    const threshold = options.threshold ?? 0;
    if (limit !== null && (!Number.isInteger(limit) || limit < 0))
      throw new RangeError("limit must be a non-negative integer or null");
    if (!Number.isInteger(threshold) || threshold < 0)
      throw new RangeError("threshold must be a non-negative integer");
    if (this.#replacing)
      throw new TypeError("replaceMore cannot run concurrently on one forest");

    this.#replacing = true;
    try {
      let remaining = limit;
      const skipped: MoreComments[] = [];
      for (;;) {
        const locations = this.gatherMore();
        if (locations.length === 0) return skipped;
        locations.sort(
          (left, right) => countOf(right.item) - countOf(left.item),
        );
        const location = locations[0];
        if (location === undefined) return skipped;

        if (
          (remaining !== null && remaining === 0) ||
          countOf(location.item) < threshold
        ) {
          remove(location);
          skipped.push(location.item);
          continue;
        }

        const replacements = await location.item.comments(this.submission);
        if (remaining !== null) remaining -= 1;
        this.replace(location, replacements);
      }
    } finally {
      this.#replacing = false;
    }
  }

  private attach(item: CommentNode): void {
    Object.defineProperty(item, "submission", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: this.submission,
    });
    if (item instanceof Comment) this.repliesOf(item);
  }

  private gatherMore(): MoreLocation[] {
    const found: MoreLocation[] = [];
    const visit = (tree: CommentNode[]): void => {
      for (const item of tree) {
        if (item instanceof MoreComments) found.push({ item, tree });
        else visit(this.repliesOf(item).#comments);
      }
    };
    visit(this.#comments);
    return found;
  }

  private replace(location: MoreLocation, replacements: CommentNode[]): void {
    const index = location.tree.indexOf(location.item);
    if (index < 0)
      throw new TypeError("MoreComments is no longer in its forest");

    const commentsByName = new Map<string, Comment>();
    for (const item of this.list()) {
      if (item instanceof Comment)
        commentsByName.set(item.fullname.toLowerCase(), item);
    }
    const replacementNames = new Set<string>();
    for (const item of replacements) {
      if (!(item instanceof Comment)) continue;
      const name = item.fullname.toLowerCase();
      if (commentsByName.has(name) || replacementNames.has(name)) {
        throw new TypeError(
          `duplicate comment ${item.fullname} during replacement`,
        );
      }
      replacementNames.add(name);
    }

    location.tree.splice(index, 1);
    let rootIndex = index;
    for (const item of replacements) {
      this.attach(item);
      const parentId = item.get("parent_id");
      const parent =
        typeof parentId === "string"
          ? commentsByName.get(parentId.toLowerCase())
          : undefined;
      if (parent !== undefined) {
        this.repliesOf(parent).#comments.push(item);
      } else {
        location.tree.splice(rootIndex, 0, item);
        rootIndex += 1;
      }
      if (item instanceof Comment) {
        commentsByName.set(item.fullname.toLowerCase(), item);
      }
    }
  }

  private repliesOf(comment: Comment): CommentForest {
    if (comment.replies instanceof CommentForest) return comment.replies;
    const replies = comment.get("replies") ?? comment.replies;
    const children = Array.isArray(replies)
      ? replies.filter(
          (item): item is CommentNode =>
            item instanceof Comment || item instanceof MoreComments,
        )
      : [];
    const forest = new CommentForest(this.submission, children);
    Object.defineProperty(comment, "replies", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: forest,
    });
    return forest;
  }
}

function countOf(item: MoreComments): number {
  const count = item.get("count");
  return typeof count === "number" ? count : 0;
}

function remove(location: MoreLocation): void {
  const index = location.tree.indexOf(location.item);
  if (index >= 0) location.tree.splice(index, 1);
}
