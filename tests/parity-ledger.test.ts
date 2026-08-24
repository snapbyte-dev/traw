import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const checker = new URL("../scripts/check-parity.mjs", import.meta.url);
const ledger = new URL("../parity/praw-8.0.3.json", import.meta.url);

describe("parity schema v2", () => {
  it("validates and verifies the complete checked-in ledger", async () => {
    await expect(
      exec(process.execPath, [checker.pathname, "--validate"]),
    ).resolves.toMatchObject({
      stderr: "",
    });
    await expect(
      exec(process.execPath, [checker.pathname]),
    ).resolves.toMatchObject({
      stderr: "",
      stdout: expect.stringContaining("Verified 16 required parity outcomes"),
    });
  });

  it("permits incomplete ledgers only in validation mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traw-parity-"));
    const fixture = join(directory, "incomplete.json");
    const value = JSON.parse(await readFile(ledger, "utf8"));
    value.outcomes[0].status = "partial";
    value.outcomes[0].scenarios[0].status = "partial";
    await writeFile(fixture, JSON.stringify(value));

    try {
      await expect(
        exec(process.execPath, [
          checker.pathname,
          "--validate",
          "--ledger",
          fixture,
        ]),
      ).resolves.toMatchObject({ stderr: "" });
      await expect(
        exec(process.execPath, [checker.pathname, "--ledger", fixture]),
      ).rejects.toThrow("incomplete required entries");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
