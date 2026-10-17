import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadMobilityBaseline } from "../src/baseline.ts";

const output = resolve(process.cwd(), "data", "baseline.json");
const baseline = loadMobilityBaseline(resolve(process.cwd(), ".."));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(baseline));
console.log(`Baseline aggregata scritta in ${output}`);
