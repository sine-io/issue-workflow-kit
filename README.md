# Issue Workflow Kit

Issue Workflow Kit 是一套可被任意智能体远程读取的规划与交付协议。它把经审批的 JSON 计划同步为 GitHub 原生 Epic、Sub-issues 和 `blocked by` 依赖，并要求每个原子任务通过一个 squash PR 完成。

仓库入口是 [`WORKFLOW.md`](WORKFLOW.md)。目标仓库自身的 `AGENTS.md` 和其他本地指令始终优先；本套件不会复制、生成或覆盖这些文件。

## 远程引用

将 `<workflow-revision>` 替换为本仓库的完整 commit SHA，避免执行过程中协议漂移。

规划模式提示词：

```text
读取 https://raw.githubusercontent.com/sine-io/issue-project-workflow-template/<workflow-revision>/WORKFLOW.md，进入 Planning mode。
先读取目标仓库指令和现状，澄清需求并拆分为顺序执行的原子任务。生成严格 Issue Plan、规范化 SHA-256 摘要和规划 PR；在我批准摘要且规划 PR 合并前，不写入 Issues、标签或实现分支。
```

执行模式提示词：

```text
读取 https://raw.githubusercontent.com/sine-io/issue-project-workflow-template/<workflow-revision>/WORKFLOW.md，进入 Execution mode。
读取目标仓库已合并的批准计划，校验摘要、仓库、认证、权限和依赖。每次只领取一个 ready 任务，严格限制在 allowedPaths 内，通过一个带 Closes 引用的 squash PR 完成；CI、API、依赖或范围异常时立即停止。
```

## 环境要求

- Node.js 20 或更高版本。
- 已安装 GitHub CLI，并通过 `gh auth login` 或 `GH_TOKEN` 完成认证。
- 目标仓库启用 Issues，当前身份具备仓库写权限。
- apply 所用令牌需能读写目标仓库 Issues；preview 仍会读取仓库、标签、Issue 和原生关系。

令牌只通过环境或 GitHub CLI 提供，不要写入计划、Issue、日志或提交历史。

## 计划文件

计划保存在 `.github/issue-plans/<plan-id>.json`。v1.0 严格契约见 [`.github/issue-plan.schema.json`](.github/issue-plan.schema.json)，v1.1 契约见 [`.github/issue-plan.v1.1.schema.json`](.github/issue-plan.v1.1.schema.json)；对应草稿示例为 [`examples/issue-plan.example.json`](examples/issue-plan.example.json) 和 [`examples/issue-plan.v1.1.example.json`](examples/issue-plan.v1.1.example.json)。validator 按 `schemaVersion` 分派并检查 `$schema` 路径，现有 v1.0 计划及其摘要保持兼容。

每个 Task 必须包含目标、用户价值、上下文、期望行为、范围、允许路径、排除项、优先级、依赖、验收标准和验证步骤。未知字段、重复 ID、空边界、缺失依赖、依赖环和失效摘要都会使校验失败。

批准摘要按以下规则计算：删除根 `approval` 对象，递归排序所有对象键，保持数组顺序不变，将规范 JSON 以 UTF-8 编码后计算 SHA-256。任何实际计划内容变化都需要新的规划 PR、摘要和批准。

v1.1 的 Epic/Task 可选声明 `management`（owner、估算、截止日期、cycle、tags）和 `execution`（agent、副作用契约、运行/heartbeat/attempt 上限、必需检查）。owner 只会在确认可分配后追加，人工 assignee 不会被移除；`tag:` 与 `cycle:` 是受管标签，估算和截止日期仅进入 Issue 正文。默认运行上限为 7200 秒、heartbeat 为 300 秒、最多一次 attempt；需要重试必须在批准计划中提高 `maxAttempts`。`allowedSideEffects` 不是 OS 或网络沙箱。

## 固定命令

安装和测试：

```bash
npm ci
npm test
```

离线校验计划：

```bash
npm run plan:validate -- --plan .github/issue-plans/<plan-id>.json
```

只读预览目标仓库差异：

```bash
npm run issues:preview -- \
  --plan .github/issue-plans/<plan-id>.json \
  --repo owner/repository
```

应用已批准计划：

```bash
npm run issues:apply -- \
  --plan .github/issue-plans/<plan-id>.json \
  --repo owner/repository \
  --approval-digest <sha256>
```

三个命令都向 stdout 输出 JSON。`plan:validate` 不访问 GitHub；`issues:preview` 保证零写入；`issues:apply` 会在任何写入前检查批准摘要、`gh` 认证、目标仓库、Issues 开关、仓库写权限和计划的 base revision。成功 apply 返回稳定 ID 到 Issue number/URL 的映射及关系操作摘要。

v1.1 任务生命周期命令均要求 `--plan`、`--repo` 和 `--approval-digest`：

```bash
npm run task:claim -- --plan <plan> --repo owner/repository --approval-digest <sha256> --task-id <id> --agent <agent>
npm run task:heartbeat -- --plan <plan> --repo owner/repository --approval-digest <sha256> --attempt-id <id> --note <text>
npm run task:block -- --plan <plan> --repo owner/repository --approval-digest <sha256> --attempt-id <id> --kind <kind> --reason <text>
npm run task:resume -- --plan <plan> --repo owner/repository --approval-digest <sha256> --task-id <id> --from-attempt <id> --agent <agent>
npm run task:submit -- --plan <plan> --repo owner/repository --approval-digest <sha256> --attempt-id <id> --pr <number-or-url> --result <file|->
npm run task:reconcile -- --plan <plan> --repo owner/repository --approval-digest <sha256>
```

所有命令向 stdout 输出 JSON，错误只写 stderr。默认分支为 `iwf/<task-id-lowercase>-a<attempt-number>`。`submit` 使用 GitHub PR files 校验新增、修改、删除和 rename 前后路径，并要求完整成功证据与 `Closes #<issue>`；`reconcile` 只在 PR 已合并、全部检查成功、Issue 由该关闭引用关闭且证据未变化时记录完成并解锁依赖。

## 身份与幂等

每个受管 Issue 正文包含隐藏的 `planId`、`taskId` 和 `workflowRevision` marker。同步器按 marker 查找，不按标题查找，因此人工改名不会创建重复 Issue。

同步器只替换标记的正文区块，并管理类型、优先级及 v1.1 声明的 PM 标签和 owner。它保留：

- 受管区块之外的人工正文；
- 已有人工 assignee；
- 额外标签和已有 `status:*`；
- open/closed 状态；
- 计划外父子关系和依赖关系。

自动化不会删除 Issue，也不会自动关闭计划修订中移除的任务。取消必须写入新的批准计划并由人工确认。

## 状态生命周期

固定标签为：

- 类型：`type:epic`、`type:task`
- 优先级：`priority:P0`、`priority:P1`、`priority:P2`
- 状态：`status:backlog`、`status:ready`、`status:in-progress`、`status:blocked`、`status:in-review`

新建时，Epic 和有依赖的 Task 进入 backlog；无依赖 Task 进入 ready。领取任务后转为 in-progress，PR 创建后转为 in-review。PR 合并通过 `Closes #<issue>` 关闭 Issue；closed 即完成，不使用额外的 done 标签。只有当前任务关闭且依赖满足后，下一项才能从 backlog 转为 ready。

每个 attempt 只有一条可更新的状态评论；block、submit、complete、stale 和 superseded 使用不可变事件评论。评论中的稳定 marker 保存受管 JSON，不保存密钥、本地绝对路径、完整日志或二进制附件。artifact 只记录 URL、摘要和可选 SHA-256。过期 attempt 只会转 blocked，不会自动重试；并发 claim 由最早的有效评论获胜。

block kind 固定为 `dependency`、`needs-input`、`capability`、`transient`、`verification` 或 `stale`。

## 安全停止

以下情况必须停止且不得启动下一项：CI 失败；摘要、revision 或仓库不匹配；认证、权限、REST 或 GraphQL 错误；依赖未关闭；需要修改 allowedPaths 之外的文件；或新需求改变验收、数据处理、安全或公开行为。

瞬时限流只会进行有上限的退避重试。部分写入失败后重新读取远端并重跑即可，稳定 marker 和差异同步会复用已创建内容。

## 仓库结构

```text
WORKFLOW.md                         远程规划与执行协议
.github/issue-plan.schema.json     严格计划契约
.github/issue-plan.v1.1.schema.json v1.1 计划契约
.github/task-*.schema.json         执行信封与完成结果契约
.github/issue-plans/               已审批计划
examples/issue-plan.example.json   草稿示例
scripts/plan-validation.mjs        schema、语义与摘要校验
scripts/plan-domain.mjs            纯计划领域逻辑
scripts/issue-body.mjs             受管正文渲染
scripts/github-adapter.mjs         GitHub REST/GraphQL adapter
scripts/issue-sync.mjs             Issue、标签与关系差异同步
scripts/issue-workflow.mjs         安全 CLI
scripts/runtime-*.mjs              运行记录领域与校验
scripts/task-*.mjs                 attempt 状态机与任务 CLI
test/                              单元与集成回归测试
```
