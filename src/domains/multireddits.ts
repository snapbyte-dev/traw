import { ReadOnlyError } from "../exceptions.js";
import { isRawData } from "../models/base.js";
import { Redditor } from "../models/entities.js";
import {
  Multireddit,
  assertExactOptions,
  multiredditPath,
  multiredditUpdateModel,
  parseMultireddit,
  parseMultiredditList,
  requiredMultiredditString,
  type MultiredditClient,
  type MultiredditIcon,
  type MultiredditVisibility,
  type MultiredditWeightingScheme,
  type SubredditReference,
} from "../models/multireddit.js";

export interface MultiredditReferenceOptions {
  readonly name: string;
  readonly redditor: string | Redditor;
}

export interface MultiredditLoadOptions extends MultiredditReferenceOptions {
  readonly signal?: AbortSignal;
}

export interface CreateMultiredditOptions {
  readonly descriptionMd?: string | null;
  readonly displayName: string;
  readonly iconName?: MultiredditIcon | null;
  readonly keyColor?: string | null;
  readonly signal?: AbortSignal;
  readonly subreddits: readonly SubredditReference[];
  readonly visibility?: MultiredditVisibility;
  readonly weightingScheme?: MultiredditWeightingScheme;
}

export interface ListMultiredditsOptions {
  readonly expandSubreddits?: boolean;
  readonly signal?: AbortSignal;
}

const REFERENCE_KEYS = new Set(["name", "redditor"]);
const LOAD_KEYS = new Set(["name", "redditor", "signal"]);
const CREATE_KEYS = new Set([
  "descriptionMd",
  "displayName",
  "iconName",
  "keyColor",
  "signal",
  "subreddits",
  "visibility",
  "weightingScheme",
]);
const LIST_KEYS = new Set(["expandSubreddits", "signal"]);

function authorized(client: MultiredditClient, operation: string): void {
  if (client.readOnly)
    throw new ReadOnlyError(`${operation} does not work in read-only mode`);
}

function ownerName(value: string | Redditor): string {
  return requiredMultiredditString(String(value), "redditor");
}

function reference(
  client: MultiredditClient,
  options: MultiredditReferenceOptions,
): Multireddit {
  assertExactOptions(options, REFERENCE_KEYS, "multireddit reference");
  const owner = ownerName(options.redditor);
  const name = requiredMultiredditString(options.name, "multireddit name");
  return new Multireddit(client, { name, path: multiredditPath(owner, name) });
}

/** Standalone helper ready to replace the facade's reference-only helper. */
export class MultiredditsDomain {
  readonly #client: MultiredditClient;

  constructor(client: MultiredditClient) {
    this.#client = client;
  }

  reference(options: MultiredditReferenceOptions): Multireddit;
  reference(redditor: string | Redditor, name: string): Multireddit;
  reference(
    first: MultiredditReferenceOptions | string | Redditor,
    second?: string,
  ): Multireddit {
    if (typeof first === "object" && !(first instanceof Redditor))
      return reference(this.#client, first);
    if (second === undefined)
      throw new TypeError("multireddit name is required");
    return reference(this.#client, { name: second, redditor: first });
  }

  async load(options: MultiredditLoadOptions): Promise<Multireddit> {
    assertExactOptions(options, LOAD_KEYS, "multireddit load");
    const { signal, ...identity } = options;
    return this.reference(identity).load(
      signal === undefined ? {} : { signal },
    );
  }

  async create(options: CreateMultiredditOptions): Promise<Multireddit> {
    assertExactOptions(options, CREATE_KEYS, "multireddit create");
    authorized(this.#client, "multireddits.create()");
    options.signal?.throwIfAborted();
    const displayName = requiredMultiredditString(
      options.displayName,
      "displayName",
    );
    const model = multiredditUpdateModel({
      displayName,
      subreddits: options.subreddits,
      visibility: options.visibility ?? "private",
      weightingScheme: options.weightingScheme ?? "classic",
      ...(options.descriptionMd === undefined
        ? {}
        : { descriptionMd: options.descriptionMd }),
      ...(options.iconName === undefined ? {} : { iconName: options.iconName }),
      ...(options.keyColor === undefined ? {} : { keyColor: options.keyColor }),
    });
    const response = await this.#client.request({
      method: "POST",
      path: "/api/multi/",
      data: { model: JSON.stringify(model) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseMultireddit(this.#client, response);
  }

  async mine(options: ListMultiredditsOptions = {}): Promise<Multireddit[]> {
    assertExactOptions(options, LIST_KEYS, "multireddit mine");
    authorized(this.#client, "multireddits.mine()");
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: "/api/multi/mine/",
      params: { expand_srs: options.expandSubreddits ?? false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseMultiredditList(this.#client, response);
  }

  async public(
    redditor: string | Redditor,
    options: ListMultiredditsOptions = {},
  ): Promise<Multireddit[]> {
    assertExactOptions(options, LIST_KEYS, "multireddit public");
    options.signal?.throwIfAborted();
    const response = await this.#client.request({
      method: "GET",
      path: `/api/multi/user/${encodeURIComponent(ownerName(redditor))}/`,
      params: { expand_srs: options.expandSubreddits ?? false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseMultiredditList(this.#client, response);
  }
}

export function isMultiredditResponse(value: unknown): boolean {
  return (
    isRawData(value) &&
    (value["kind"] === "LabeledMulti" ||
      (typeof value["name"] === "string" && typeof value["path"] === "string"))
  );
}
