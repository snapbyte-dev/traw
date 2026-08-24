import {
  RedditModel,
  type RawData,
  type RedditClientLike,
  type RedditRequest,
} from "./base.js";

export class MessageBase extends RedditModel {
  readonly kind = "t4";
  readonly identityField = "id";
  declare author: unknown;
  declare body: unknown;
  declare subject: unknown;

  constructor(client: RedditClientLike, value: string | RawData) {
    super(
      client,
      "id",
      typeof value === "string" && value.startsWith("t4_")
        ? value.slice(3)
        : value,
    );
  }

  get fullname(): string {
    const name = this.get("name");
    return typeof name === "string" ? name : `t4_${this.toString()}`;
  }

  protected fetchRequest(): Pick<RedditRequest, "params" | "path"> {
    return { path: "/api/info", params: { id: this.fullname } };
  }
}
