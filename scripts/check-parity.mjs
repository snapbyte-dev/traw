import { readFile } from "node:fs/promises";
import { log } from "node:console";
import { URL } from "node:url";

const ledger = JSON.parse(
  await readFile(new URL("../parity/praw-8.0.3.json", import.meta.url), "utf8"),
);

if (ledger.baseline !== "praw@8.0.3") {
  throw new Error("Parity ledger must remain pinned to PRAW 8.0.3");
}

const incomplete = ledger.capabilities.filter(
  ({ status }) => status !== "implemented" && status !== "adapted",
);

if (incomplete.length > 0) {
  throw new Error(
    `Parity ledger has ${incomplete.length} incomplete capabilities: ${incomplete
      .map(({ symbol }) => symbol)
      .join(", ")}`,
  );
}

log(`Verified ${ledger.capabilities.length} parity capabilities.`);
