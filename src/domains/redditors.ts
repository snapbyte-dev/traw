import { Listing, type ListingOptions } from "../listing.js";
import type { RedditClientLike } from "../models/base.js";
import { Redditor } from "../models/entities.js";

function requiredQuery(value: string): string {
  const query = value.trim();
  if (query.length === 0) throw new TypeError("query cannot be empty");
  return query;
}

export class RedditorsDomain {
  readonly #client: RedditClientLike;

  constructor(client: RedditClientLike) {
    this.#client = client;
  }

  new(options: ListingOptions = {}): Listing<Redditor> {
    return new Listing(this.#client, "/users/new", options);
  }

  search(query: string, options: ListingOptions = {}): Listing<Redditor> {
    return new Listing(this.#client, "/users/search", {
      ...options,
      params: { ...options.params, q: requiredQuery(query) },
    });
  }
}
