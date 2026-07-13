export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function replaceTokens(value, context) {
  return String(value || "")
    .replaceAll("{{owner}}", context.owner)
    .replaceAll("{{repo}}", context.repo)
    .replaceAll("{{repository}}", `${context.owner}/${context.repo}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyArray(value, message) {
  assert(Array.isArray(value) && value.length > 0, message);
}

export function flattenIssues(issues) {
  const flattened = [];

  function visit(issue, parent = null) {
    const normalized = {
      ...issue,
      parentId: parent?.id,
      priority: issue.priority || parent?.priority,
      phase: issue.phase || parent?.phase,
      area: issue.area || parent?.area,
      labels: issue.labels || [],
      dependsOn: issue.dependsOn || [],
      children: issue.children || [],
    };
    flattened.push(normalized);
    for (const child of normalized.children) visit(child, normalized);
  }

  for (const issue of issues || []) visit(issue);
  return flattened;
}

export function validateConfig(config, { allowEmpty = false } = {}) {
  assert(config && typeof config === "object", "Config must be an object");
  assert(config.project && typeof config.project === "object", "project is required");
  assert(config.project.title, "project.title is required");
  assert(["PUBLIC", "PRIVATE"].includes(config.project.visibility), "project.visibility must be PUBLIC or PRIVATE");
  nonEmptyArray(config.project.statusOptions, "project.statusOptions must not be empty");
  const statusNames = config.project.statusOptions.map((item) => item.name);
  assert(new Set(statusNames).size === statusNames.length, "Status option names must be unique");
  assert(statusNames.includes(config.project.initialStatus), "project.initialStatus must match a status option");
  nonEmptyArray(config.project.fields, "project.fields must not be empty");
  for (const field of config.project.fields) {
    assert(field.name && field.source, "Every project field needs name and source");
    nonEmptyArray(field.options, `Project field ${field.name} needs options`);
  }

  assert(Array.isArray(config.labels), "labels must be an array");
  const labelNames = config.labels.map((item) => item.name);
  assert(new Set(labelNames).size === labelNames.length, "Label names must be unique");
  for (const label of config.labels) {
    assert(label.name, "Every label needs a name");
    assert(/^[0-9a-f]{6}$/i.test(label.color), `Label ${label.name} needs a six-digit color`);
  }

  assert(Array.isArray(config.issues), "issues must be an array");
  if (!allowEmpty) nonEmptyArray(config.issues, "issues must not be empty before bootstrap");
  const flattened = flattenIssues(config.issues);
  const ids = flattened.map((item) => item.id);
  assert(new Set(ids).size === ids.length, "Issue IDs must be unique");
  const idSet = new Set(ids);

  for (const issue of flattened) {
    assert(issue.id && /^[A-Z][A-Z0-9_-]*(\.\d+)?$/.test(issue.id), `Invalid issue ID: ${issue.id || "<missing>"}`);
    for (const field of ["title", "priority", "phase", "area", "goal", "value", "current", "expected"]) {
      assert(issue[field], `${issue.id}.${field} is required`);
    }
    for (const field of ["scope", "acceptance", "tests"]) {
      nonEmptyArray(issue[field], `${issue.id}.${field} must not be empty`);
    }
    for (const dependency of issue.dependsOn) {
      assert(idSet.has(dependency), `${issue.id} references unknown dependency ${dependency}`);
      assert(dependency !== issue.id, `${issue.id} cannot depend on itself`);
    }
    assert(config.project.fields.every((field) => field.options.includes(issue[field.source])), `${issue.id} contains a value not declared by a Project field`);
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(flattened.map((item) => [item.id, item]));
  function checkCycle(id) {
    if (visited.has(id)) return;
    assert(!visiting.has(id), `Dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) checkCycle(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) checkCycle(id);

  return flattened;
}

export function labelsForIssue(issue) {
  return unique([
    `priority:${issue.priority}`,
    issue.area,
    ...(issue.labels || []),
    issue.children.length ? "epic" : undefined,
    issue.parentId ? "subtask" : undefined,
  ]);
}

export function reverseDependencies(issues) {
  const reverse = new Map();
  for (const issue of issues) {
    for (const dependency of issue.dependsOn) {
      if (!reverse.has(dependency)) reverse.set(dependency, []);
      reverse.get(dependency).push(issue.id);
    }
  }
  return reverse;
}

function bullets(items, checkbox = false) {
  const values = items?.length ? items : ["None"];
  return values.map((item) => `- ${checkbox ? "[ ] " : ""}${item}`).join("\n");
}

export function buildIssueBody(issue, refs, reverse) {
  const formatRefs = (ids) => ids.length
    ? ids.map((id) => `#${refs.get(id).number} (\`${id}\`)`).join("、")
    : "无";
  const children = issue.children.map((child) => ({ ...child, id: child.id }));
  const scope = children.length
    ? children.map((child) => `#${refs.get(child.id).number} \`${child.id}\` ${child.title}`)
    : issue.scope;
  const blocks = reverse.get(issue.id) || [];

  return `> 任务编号：\`${issue.id}\`  
> 优先级：\`${issue.priority}\`  
> 阶段：\`${issue.phase}\`  
> 类型：${children.length ? "Epic" : issue.parentId ? "Sub-issue" : "Task"}

## 目标

${issue.goal}

## 用户价值

${issue.value}

## 当前问题

${issue.current}

## 期望行为

${issue.expected}

## 实现范围

${bullets(scope, true)}

## 不在本 Issue 范围

${bullets(issue.outOfScope || ["不处理未在本任务范围中声明的其他功能。"])}

## 数据与接口要求

${bullets(issue.dataRequirements || ["不使用新的硬编码或静默 fallback 代替真实实现。"])}

## 依赖关系

- Blocked by: ${formatRefs(issue.dependsOn)}
- Blocks: ${formatRefs(blocks)}
- Parent Epic: ${issue.parentId ? `#${refs.get(issue.parentId).number} (\`${issue.parentId}\`)` : "无"}

## 验收标准

${bullets(issue.acceptance, true)}

## 测试与验证

${bullets(issue.tests, true)}

## 完成定义

- [ ] 实现已合并，所有验收项通过。
- [ ] 自动化检查通过，相关 contract、迁移和文档已同步。
- [ ] PR 使用 \`Closes #${refs.get(issue.id).number}\` 关联本 Issue。
`;
}

export function summarize(config, flattened) {
  return {
    projectTitle: config.project.title,
    labels: config.labels.length,
    issues: flattened.filter((item) => !item.parentId).length,
    subIssues: flattened.filter((item) => item.parentId).length,
    epics: flattened.filter((item) => item.children.length > 0).length,
    dependencies: flattened.reduce((count, item) => count + item.dependsOn.length, 0),
  };
}
