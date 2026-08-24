import { loadEnvFile } from "node:process";

import { Reddit } from "../src/index.js";

loadEnvFile();

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const reddit = new Reddit({
  clientId: requiredEnvironmentVariable("REDDIT_CLIENT_ID"),
  clientSecret: requiredEnvironmentVariable("REDDIT_CLIENT_SECRET"),
  userAgent: "traw:typescript-top-posts-example:v1.0.0",
});

try {
  for await (const post of reddit.subreddit("typescript").top({ limit: 10 })) {
    console.log(post.title);
  }
} finally {
  await reddit.close();
}
