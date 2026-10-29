// Enforce the repository's error-level CodeQL gate independently of uploads.
// Never print source snippets, paths or arbitrary SARIF message text.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReview } from "./codeql-reviewed-findings.mjs";

async function reports(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await reports(path));
    else if (entry.isFile() && entry.name.endsWith(".sarif")) files.push(path);
  }
  return files;
}

try {
  if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === "--reviewed-findings")) throw new Error();
  const review = process.argv.length === 5 ? await loadReview(process.argv[4], process.cwd()) : undefined;
  const files = await reports(process.argv[2]);
  if (!files.length) throw new Error();
  const errors = [];
  let reviewed = 0;
  for (const file of files) {
    const report = JSON.parse(await readFile(file, "utf8"));
    if (report.version !== "2.1.0" || !Array.isArray(report.runs) || !report.runs.length) throw new Error();
    for (const run of report.runs) {
      if (run.invocations?.some((invocation) => invocation.executionSuccessful === false)) throw new Error();
      if (!Array.isArray(run.results)) throw new Error();
      for (const result of run.results) {
        const componentRef = result.rule?.toolComponent;
        const component = componentRef
          ? Number.isInteger(componentRef.index) ? run.tool?.extensions?.[componentRef.index]
            : [run.tool?.driver, ...(run.tool?.extensions ?? [])].find((entry) => entry && (componentRef.guid ? entry.guid === componentRef.guid : entry.name === componentRef.name))
          : run.tool?.driver;
        if (componentRef && !component) throw new Error();
        const rules = component?.rules ?? [];
        const ruleId = result.ruleId ?? result.rule?.id;
        const ruleIndex = result.ruleIndex ?? result.rule?.index;
        const rule = rules.find((entry) => entry.id === ruleId) ?? rules[ruleIndex];
        if (result.level === undefined && (ruleId !== undefined || ruleIndex !== undefined) && !rule) throw new Error();
        const level = result.level ?? rule?.defaultConfiguration?.level ?? "warning";
        if (!["none", "note", "warning", "error"].includes(level)) throw new Error();
        if (level === "error") {
          const id = ruleId ?? rule?.id;
          if (review && await review(id, result)) { reviewed += 1; continue; }
          errors.push(typeof id === "string" && /^[a-zA-Z0-9_./-]{1,100}$/.test(id) ? id : "unclassified_rule");
        }
      }
    }
  }
  console.log(`CodeQL SARIF gate: ${files.length} report(s), ${errors.length} error-level finding(s).`);
  if (reviewed) console.log(`CodeQL reviewed false positives: ${reviewed} source-bound GitHub dismissal(s) verified.`);
  if (errors.length) {
    for (const id of [...new Set(errors)].slice(0, 20)) console.error(`CodeQL error: ${id}`);
    process.exitCode = 1;
  }
} catch {
  console.error("CodeQL SARIF gate could not verify completed analysis reports.");
  process.exitCode = 1;
}
