import { isRawData, type DataValue, type RawData } from "../models/base.js";
import {
  Rule,
  assertModeratorAccess,
  responseArray,
  requiredString,
  subredditName,
  subredditPath,
  type ModerationClientLike,
  type SubredditReference,
} from "../models/moderation.js";

export type RuleKind = "all" | "comment" | "link";

export interface AddRuleOptions {
  readonly description?: string;
  readonly kind: RuleKind;
  readonly shortName: string;
  readonly violationReason?: string;
}

export interface UpdateRuleOptions {
  readonly description?: string;
  readonly kind?: RuleKind;
  readonly shortName?: string;
  readonly violationReason?: string;
}

function firstRule(
  client: ModerationClientLike,
  subreddit: SubredditReference,
  response: unknown,
): Rule {
  const data = responseArray(response, "subreddit rule")[0];
  if (data === undefined)
    throw new TypeError("Reddit returned no subreddit rule");
  return new Rule(client, subreddit, data);
}

export class SubredditRules {
  readonly #client: ModerationClientLike;
  readonly #subreddit: SubredditReference;

  constructor(client: ModerationClientLike, subreddit: SubredditReference) {
    this.#client = client;
    this.#subreddit = subreddit;
    subredditName(subreddit);
  }

  get(shortName: string): Rule {
    return new Rule(
      this.#client,
      this.#subreddit,
      requiredString(shortName, "rule name"),
    );
  }

  async list(signal?: AbortSignal): Promise<Rule[]> {
    const response = await this.#client.request({
      method: "GET",
      path: `/r/${subredditPath(this.#subreddit)}/about/rules`,
      ...(signal === undefined ? {} : { signal }),
    });
    let rules = response;
    if (isRawData(rules) && Array.isArray(rules["rules"]))
      rules = rules["rules"];
    if (!Array.isArray(rules) || !rules.every(isRawData)) {
      throw new TypeError("Reddit returned invalid subreddit rules data");
    }
    return rules.map((data) => new Rule(this.#client, this.#subreddit, data));
  }

  async add(options: AddRuleOptions, signal?: AbortSignal): Promise<Rule> {
    assertModeratorAccess(this.#client, "rules.add()");
    const shortName = requiredString(options.shortName, "rule name");
    const response = await this.#client.request({
      method: "POST",
      path: "/api/add_subreddit_rule",
      data: {
        description: options.description ?? "",
        kind: options.kind,
        r: subredditName(this.#subreddit),
        short_name: shortName,
        violation_reason: options.violationReason ?? shortName,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return firstRule(this.#client, this.#subreddit, response);
  }

  async update(
    rule: string | Rule,
    options: UpdateRuleOptions,
    signal?: AbortSignal,
  ): Promise<Rule> {
    assertModeratorAccess(this.#client, "rules.update()");
    const oldShortName = requiredString(String(rule), "rule name");
    let existing: RawData = rule instanceof Rule ? rule.raw : {};
    if (
      options.description === undefined ||
      options.kind === undefined ||
      options.shortName === undefined ||
      options.violationReason === undefined
    ) {
      const fetched = (await this.list(signal)).find(
        (candidate) => String(candidate) === oldShortName,
      );
      if (fetched === undefined)
        throw new TypeError(`Subreddit does not have rule ${oldShortName}`);
      existing = fetched.raw;
    }
    const value = (field: string, supplied: string | undefined): string => {
      if (supplied !== undefined) return supplied;
      const current = existing[field];
      if (typeof current !== "string")
        throw new TypeError(`Rule has no valid ${field}`);
      return current;
    };
    const data: Record<string, DataValue> = {
      description: value("description", options.description),
      kind: value("kind", options.kind),
      old_short_name: oldShortName,
      r: subredditName(this.#subreddit),
      short_name: value("short_name", options.shortName),
      violation_reason: value("violation_reason", options.violationReason),
    };
    const response = await this.#client.request({
      method: "POST",
      path: "/api/update_subreddit_rule",
      data,
      ...(signal === undefined ? {} : { signal }),
    });
    return firstRule(this.#client, this.#subreddit, response);
  }

  async delete(rule: string | Rule, signal?: AbortSignal): Promise<void> {
    assertModeratorAccess(this.#client, "rules.delete()");
    await this.#client.request({
      method: "POST",
      path: "/api/remove_subreddit_rule",
      data: {
        r: subredditName(this.#subreddit),
        short_name: requiredString(String(rule), "rule name"),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async reorder(
    rules: readonly (string | Rule)[],
    signal?: AbortSignal,
  ): Promise<Rule[]> {
    assertModeratorAccess(this.#client, "rules.reorder()");
    const order = rules.map((rule) =>
      requiredString(String(rule), "rule name"),
    );
    if (new Set(order).size !== order.length)
      throw new TypeError("rule order cannot contain duplicates");
    const encoded = encodeURIComponent(order.join(",")).replaceAll("%2C", ",");
    const response = await this.#client.request({
      method: "POST",
      path: "/api/reorder_subreddit_rules",
      data: { new_rule_order: encoded, r: subredditName(this.#subreddit) },
      ...(signal === undefined ? {} : { signal }),
    });
    return responseArray(response, "subreddit rules").map(
      (data) => new Rule(this.#client, this.#subreddit, data),
    );
  }
}

export function createSubredditRules(
  client: ModerationClientLike,
  subreddit: SubredditReference,
): SubredditRules {
  return new SubredditRules(client, subreddit);
}
