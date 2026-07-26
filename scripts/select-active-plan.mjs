#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] || ".github/issue-plans");
const plans = [];
for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) {
    for (const nested of fs.readdirSync(file)) {
      if (!nested.endsWith(".json")) continue;
      const candidate = path.join(file, nested);
      const plan = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (plan.schemaVersion === "2.0" && plan.approval?.status === "approved") {
        plans.push({ file: candidate, id: plan.plan.id, approvedAt: plan.approval.approvedAt });
      }
    }
  } else if (entry.isFile() && entry.name.endsWith(".json")) {
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    if (plan.schemaVersion === "2.0" && plan.approval?.status === "approved") {
      plans.push({ file, id: plan.plan.id, approvedAt: plan.approval.approvedAt });
    }
  }
}
if (!plans.length) {
  console.error("expected at least one approved v2 plan, found 0");
  process.exitCode = 1;
} else {
  // Approved plans are immutable audit history. The newest approval is the
  // active control-plane input; older plans remain replayable records.
  for (const plan of plans) {
    const approvedAt = Date.parse(plan.approvedAt || "");
    if (Number.isNaN(approvedAt)) {
      console.error(`approved plan ${plan.id} has no valid approval timestamp`);
      process.exitCode = 1;
      process.exit();
    }
    plan.approvedAtMs = approvedAt;
  }
  plans.sort((left, right) => right.approvedAtMs - left.approvedAtMs || right.id.localeCompare(left.id));
  console.log(path.relative(process.cwd(), plans[0].file).split(path.sep).join("/"));
}
