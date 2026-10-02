import { writeFileSync } from "node:fs";
import { loadFixtureGroundTruth } from "./ground-truth.mjs";
const records = loadFixtureGroundTruth();
const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const outputIndex = process.argv.indexOf("--out");
if (outputIndex === -1) {
  process.stdout.write(jsonl);
} else {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath || process.argv.length !== outputIndex + 2) throw new Error("Usage: node export-ground-truth.mjs [--out <path>]");
  writeFileSync(outputPath, jsonl, "utf8");
  console.log(`PASS wrote ${records.length} independent ground-truth event(s) to ${outputPath}`);
}
