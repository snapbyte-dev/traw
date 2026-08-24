import {
  Comment,
  Media,
  Reddit,
  type RedditOptions,
  type Submission,
} from "../../src/index.js";

const options: RedditOptions = {
  clientId: "client",
  clientSecret: "secret",
  userAgent: "traw:type-test",
};

const reddit = new Reddit(options);
const comment: Comment = reddit.comment("abc");
const submissions: AsyncIterable<Submission> = reddit.front.hot({ limit: 10 });
const bytes = new Media(new Uint8Array([1]), "pixel.png");

void comment;
void submissions;
void bytes;

// @ts-expect-error clientSecret must be present or explicitly null
const invalid: RedditOptions = { clientId: "client", userAgent: "agent" };
void invalid;
