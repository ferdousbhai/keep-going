#!/usr/bin/env node

// Measures the reviewer against what actually happened next in Claude Code
// transcripts. Each stop the hook saw is labelled by its outcome:
//
//   useful    nudged, and the agent ran a tool before stopping again
//   declined  nudged, and the agent stopped again without a tool
//   missed    let through, and the owner's next message was a bare "continue"
//   answered  let through, and the owner's next message was a short "yes ..."
//
// These are proxies, not ground truth: an agent can decline a nudge it should
// have taken, and a "yes" can answer a permission the agent never needed. They
// are good enough to compare one REVIEW_PROMPT against another.
//
//   node scripts/eval.mjs                     count the labelled stops
//   node scripts/eval.mjs --samples 3         ...and print a few of each
//   node scripts/eval.mjs --replay 20         re-review 20 of each with the current prompt
//
// Options: --dir DIR (default: Claude's projects directory), --since YYYY-MM-DD,
// --label NAME (replay only that label), --verbose (with --replay: each
// verdict and the reviewer's reason).
// Replay pipes transcript text to `claude`, as the hook does; nothing is written.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  claudeOwnerText,
  claudeRecordKind,
  claudeReplyText,
  parseReview,
  reviewPrompt,
  runClaudeModel,
} from "../src/keep-going.mjs";

const EXPECTED = { useful: "CONTINUE", declined: "STOP", missed: "CONTINUE", answered: "STOP" };
const BARE_CONTINUE = /^(continue|keep going|go on|carry on|proceed|finish( it)?)[.!]*$/i;
const SHORT_YES = /^(yes|yep|yeah|go ahead|do it|ship it)\b/i;
// What the host writes in the agent's place when a reply fails; no stop to review.
const NOT_A_STOP = /^(API Error:|No response requested\.)/;

const { values: options } = parseArgs({
  options: {
    dir: { type: "string", default: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects") },
    since: { type: "string", default: "" },
    label: { type: "string", default: "" },
    samples: { type: "string", default: "0" },
    replay: { type: "string", default: "0" },
    verbose: { type: "boolean", default: false },
  },
});

function records(text) {
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Anything in the user's role but a tool's result means the agent had stopped:
// a nudge, a prompt, or a background job reporting back.
const agentStopped = (record) =>
  record?.type === "user" && !(Array.isArray(record.message?.content) &&
    record.message.content.some((part) => part?.type === "tool_result"));

// One pass over a transcript with the hook's own classifiers, so a case holds
// exactly what the hook would have handed the reviewer at that stop.
function labelStops(file, recs) {
  const cases = [];
  let ownerPrompt = "";
  let ownerRepliedTo = "";
  let reply = "";
  let open = null;
  const close = (label) => {
    if (open) cases.push({ ...open, label });
    open = null;
  };
  for (const record of recs) {
    if (options.since && typeof record.timestamp === "string" && record.timestamp < options.since) continue;
    const kind = claudeRecordKind(record);
    if (kind === "tool") close("useful");
    else if (agentStopped(record)) close("declined");
    if (kind === "nudge") {
      if (reply && !NOT_A_STOP.test(reply)) {
        open = { file, timestamp: record.timestamp, ownerPrompt, ownerRepliedTo, lastAssistantMessage: reply };
      }
    }
    const owner = claudeOwnerText(record);
    if (owner) {
      const label = BARE_CONTINUE.test(owner) ? "missed" : owner.length < 80 && SHORT_YES.test(owner) ? "answered" : null;
      if (label && ownerPrompt && reply && !NOT_A_STOP.test(reply)) {
        cases.push({ file, timestamp: record.timestamp, ownerPrompt, ownerRepliedTo, lastAssistantMessage: reply, label });
      }
      ownerPrompt = owner;
      ownerRepliedTo = reply;
    }
    reply = claudeReplyText(record) || reply;
  }
  close("declined");
  return cases;
}

async function collect() {
  const cases = [];
  for (const name of await readdir(options.dir, { recursive: true })) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(options.dir, name);
    const text = await readFile(file, "utf8").catch(() => "");
    // Only sessions keep-going reviewed: elsewhere a "continue" says nothing about it.
    if (!text.includes("Stop hook feedback")) continue;
    cases.push(...labelStops(file, records(text)));
  }
  return cases;
}

// An even spread across the whole period, so one long session does not fill the sample.
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, index) => list[Math.floor((index * list.length) / count)]);
}

const clip = (text, limit = 240) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `…${flat.slice(-limit)}` : flat;
};

async function replay(sample) {
  const results = [];
  let next = 0;
  // A few reviewers at once: each is a full `claude --print` process.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < sample.length) {
      const item = sample[next++];
      let verdict = "ERROR";
      let reason = "";
      try {
        ({ verdict, reason } = parseReview(await runClaudeModel({ prompt: reviewPrompt(item), timeoutMs: 180_000 })));
      } catch (error) {
        reason = error.message;
      }
      results.push({ ...item, verdict, reason });
      process.stderr.write(".");
    }
  }));
  process.stderr.write("\n");
  return results;
}

const cases = await collect();
const byLabel = Object.fromEntries(Object.keys(EXPECTED).map((label) => [label, cases.filter((item) => item.label === label)]));

console.log(`${cases.length} labelled stops in ${options.dir}${options.since ? ` since ${options.since}` : ""}`);
for (const [label, list] of Object.entries(byLabel)) {
  console.log(`  ${label.padEnd(9)} ${String(list.length).padStart(5)}   expect ${EXPECTED[label]}`);
}

const samples = Number(options.samples);
if (samples > 0) {
  for (const [label, list] of Object.entries(byLabel)) {
    console.log(`\n== ${label}`);
    for (const item of spread(list, samples)) {
      console.log(`- ${item.timestamp ?? ""} owner: ${clip(item.ownerPrompt, 100)}\n  agent: ${clip(item.lastAssistantMessage)}`);
    }
  }
}

const perLabel = Number(options.replay);
if (perLabel > 0) {
  const chosen = options.label ? [byLabel[options.label] ?? []] : Object.values(byLabel);
  const results = await replay(chosen.flatMap((list) => spread(list, perLabel)));
  console.log("\nlabel      n  CONTINUE  STOP  ERROR  agrees");
  for (const label of Object.keys(EXPECTED)) {
    const rows = results.filter((item) => item.label === label);
    if (!rows.length) continue;
    const count = (verdict) => rows.filter((item) => item.verdict === verdict).length;
    const agrees = Math.round((100 * count(EXPECTED[label])) / rows.length);
    console.log(`${label.padEnd(9)}${String(rows.length).padStart(3)}${String(count("CONTINUE")).padStart(10)}${String(count("STOP")).padStart(6)}${String(count("ERROR")).padStart(7)}${String(agrees).padStart(7)}%`);
  }
  if (options.verbose) {
    for (const item of results) {
      const mark = item.verdict === EXPECTED[item.label] ? " " : "✗";
      console.log(`\n${mark} ${item.label} → ${item.verdict}: ${item.reason}\n  agent: ${clip(item.lastAssistantMessage)}`);
    }
  }
}
