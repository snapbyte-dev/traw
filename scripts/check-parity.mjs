import { log } from "node:console";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = argv.slice(2);
const validateOnly = args.includes("--validate");
const ledgerFlag = args.indexOf("--ledger");
const ledgerPath =
  ledgerFlag === -1
    ? resolve(root, "parity/praw-8.0.3.json")
    : resolve(args[ledgerFlag + 1] ?? "");
const statuses = new Set([
  "missing",
  "partial",
  "verified",
  "excluded",
  "unavailable",
]);
const terminalStatuses = new Set(["verified", "excluded", "unavailable"]);
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function status(value, label) {
  if (!statuses.has(value))
    fail(`${label} has invalid status ${String(value)}`);
  return value;
}

async function repositoryFile(path, label) {
  text(path, label);
  if (isAbsolute(path) || path.includes("..")) {
    fail(`${label} must be a repository-relative path`);
  }
  const absolute = resolve(root, path);
  await access(absolute).catch(() => fail(`${label} does not exist: ${path}`));
  return absolute;
}

function pinnedUpstream(evidence, label, baseline) {
  const item = object(evidence, label);
  const url = text(item.url, `${label}.url`);
  text(item.symbol, `${label}.symbol`);
  if (!url.startsWith("https://github.com/praw-dev/praw/blob/v8.0.3/")) {
    fail(`${label}.url must be pinned to the PRAW 8.0.3 source tree`);
  }
  if (baseline !== "praw@8.0.3") fail(`${label} has an invalid baseline`);
}

async function validateEvidence(evidence, label, baseline, required) {
  const value = object(evidence, label);
  const implementations = array(
    value.implementation,
    `${label}.implementation`,
  );
  const tests = array(value.tests, `${label}.tests`);
  const upstream = array(value.upstream, `${label}.upstream`);
  if (
    required &&
    (!implementations.length || !tests.length || !upstream.length)
  ) {
    fail(`${label} must contain implementation, test, and upstream evidence`);
  }
  for (const [index, evidenceItem] of implementations.entries()) {
    const item = object(evidenceItem, `${label}.implementation[${index}]`);
    await repositoryFile(item.path, `${label}.implementation[${index}].path`);
    text(item.symbol, `${label}.implementation[${index}].symbol`);
  }
  for (const [index, evidenceItem] of tests.entries()) {
    const itemLabel = `${label}.tests[${index}]`;
    const item = object(evidenceItem, itemLabel);
    const path = await repositoryFile(item.path, `${itemLabel}.path`);
    const name = text(item.name, `${itemLabel}.name`);
    const source = await readFile(path, "utf8");
    if (!source.includes(name))
      fail(`${itemLabel}.name was not found in ${item.path}`);
  }
  for (const [index, item] of upstream.entries()) {
    pinnedUpstream(item, `${label}.upstream[${index}]`, baseline);
  }
}

function validateDisposition(item, label) {
  if (item.status === "excluded") {
    const exclusion = object(item.exclusion, `${label}.exclusion`);
    text(exclusion.rationale, `${label}.exclusion.rationale`);
    text(exclusion.decision, `${label}.exclusion.decision`);
  } else if (item.exclusion !== undefined) {
    fail(`${label}.exclusion is only valid for excluded entries`);
  }
  if (item.status === "unavailable") {
    text(item.unavailableReason, `${label}.unavailableReason`);
  } else if (item.unavailableReason !== undefined) {
    fail(`${label}.unavailableReason is only valid for unavailable entries`);
  }
}

async function validateManifest(reference, baseline) {
  const path = await repositoryFile(reference.path, "manifest reference path");
  const manifest = object(JSON.parse(await readFile(path, "utf8")), "manifest");
  if (manifest.schemaVersion !== 2 || manifest.baseline !== baseline) {
    fail("Model export manifest must use schema v2 and the ledger baseline");
  }
  if (manifest.blocking !== false)
    fail("Model export manifest must be nonblocking");
  const test = object(manifest.testEvidence, "manifest.testEvidence");
  const testPath = await repositoryFile(
    test.path,
    "manifest.testEvidence.path",
  );
  const testName = text(test.name, "manifest.testEvidence.name");
  if (!(await readFile(testPath, "utf8")).includes(testName)) {
    fail("Manifest test name was not found in its evidence file");
  }
  const exports = array(manifest.exports, "manifest.exports");
  if (exports.length !== 85)
    fail(
      `Model export manifest must contain 85 entries, found ${exports.length}`,
    );
  const names = new Set();
  for (const [index, rawEntry] of exports.entries()) {
    const label = `manifest.exports[${index}]`;
    const entry = object(rawEntry, label);
    const name = text(entry.name, `${label}.name`);
    if (names.has(name)) fail(`Duplicate model export ${name}`);
    names.add(name);
    status(entry.status, `${label}.status`);
    text(entry.classification, `${label}.classification`);
    const implementation = object(
      entry.implementation,
      `${label}.implementation`,
    );
    await repositoryFile(implementation.path, `${label}.implementation.path`);
    text(implementation.symbol, `${label}.implementation.symbol`);
    pinnedUpstream(entry.upstream, `${label}.upstream`, baseline);
    if (entry.classification === "alias") {
      text(entry.mapsTo, `${label}.mapsTo`);
    } else if (entry.mapsTo !== undefined) {
      fail(`${label}.mapsTo is reserved for aliases`);
    }
    validateDisposition(entry, label);
  }
  for (const entry of exports) {
    if (entry.mapsTo !== undefined && !names.has(entry.mapsTo)) {
      fail(`Alias ${entry.name} maps to unknown export ${entry.mapsTo}`);
    }
  }
}

const ledger = object(JSON.parse(await readFile(ledgerPath, "utf8")), "ledger");
if (ledger.schemaVersion !== 2) fail("Parity ledger must use schemaVersion 2");
if (ledger.baseline !== "praw@8.0.3")
  fail("Parity ledger must remain pinned to PRAW 8.0.3");
const definitions = object(ledger.statusDefinitions, "statusDefinitions");
for (const expectedStatus of statuses)
  text(definitions[expectedStatus], `statusDefinitions.${expectedStatus}`);

const manifests = array(ledger.manifests, "manifests");
if (manifests.length === 0)
  fail("Parity ledger must reference at least one manifest");
const manifestIds = new Set();
for (const rawReference of manifests) {
  const reference = object(rawReference, "manifest reference");
  const id = text(reference.id, "manifest reference id");
  if (!idPattern.test(id) || manifestIds.has(id))
    fail(`Invalid or duplicate manifest ID ${id}`);
  manifestIds.add(id);
  if (reference.blocking !== false)
    fail(`Manifest reference ${id} must be nonblocking`);
  await validateManifest(reference, ledger.baseline);
}

const ids = new Set();
const incomplete = [];
const outcomes = array(ledger.outcomes, "outcomes");
if (outcomes.length === 0) fail("Parity ledger must contain outcomes");
for (const [outcomeIndex, rawOutcome] of outcomes.entries()) {
  const outcomeLabel = `outcomes[${outcomeIndex}]`;
  const outcome = object(rawOutcome, outcomeLabel);
  const outcomeId = text(outcome.id, `${outcomeLabel}.id`);
  if (!idPattern.test(outcomeId) || ids.has(outcomeId))
    fail(`Invalid or duplicate outcome ID ${outcomeId}`);
  ids.add(outcomeId);
  text(outcome.outcome, `${outcomeLabel}.outcome`);
  status(outcome.status, `${outcomeLabel}.status`);
  if (outcome.required !== true)
    fail(`${outcomeLabel} must be blocking (required: true)`);
  validateDisposition(outcome, outcomeLabel);
  const scenarios = array(outcome.scenarios, `${outcomeLabel}.scenarios`);
  if (scenarios.length === 0) fail(`${outcomeLabel} must contain scenarios`);
  for (const [scenarioIndex, rawScenario] of scenarios.entries()) {
    const label = `${outcomeLabel}.scenarios[${scenarioIndex}]`;
    const scenario = object(rawScenario, label);
    const scenarioId = text(scenario.id, `${label}.id`);
    if (!idPattern.test(scenarioId) || ids.has(scenarioId))
      fail(`Invalid or duplicate scenario ID ${scenarioId}`);
    ids.add(scenarioId);
    text(scenario.scenario, `${label}.scenario`);
    status(scenario.status, `${label}.status`);
    validateDisposition(scenario, label);
    if (scenario.adaptation !== undefined) {
      const adaptation = object(scenario.adaptation, `${label}.adaptation`);
      text(adaptation.kind, `${label}.adaptation.kind`);
      text(adaptation.rationale, `${label}.adaptation.rationale`);
    }
    await validateEvidence(
      scenario.evidence,
      `${label}.evidence`,
      ledger.baseline,
      terminalStatuses.has(scenario.status),
    );
    if (!terminalStatuses.has(scenario.status))
      incomplete.push(`${outcomeId}/${scenarioId}`);
  }
  const scenariosComplete = scenarios.every(({ status: value }) =>
    terminalStatuses.has(value),
  );
  if (terminalStatuses.has(outcome.status) !== scenariosComplete) {
    fail(`${outcomeLabel}.status does not match its scenario statuses`);
  }
  if (!terminalStatuses.has(outcome.status)) incomplete.push(outcomeId);
}

if (!validateOnly && incomplete.length > 0) {
  fail(
    `Parity ledger has ${incomplete.length} incomplete required entries: ${incomplete.join(", ")}`,
  );
}

log(
  `${validateOnly ? "Validated" : "Verified"} ${outcomes.length} required parity outcomes and ${manifests.length} nonblocking manifest.`,
);
