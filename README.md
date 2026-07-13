# Issue + Project Workflow Template

一个用于把结构化任务清单批量转换为 GitHub Issues、原生 Sub-issues 和 GitHub Project 的模板仓库。

## 为什么需要 bootstrap

GitHub repository template 只复制目录、分支和文件；fork 会复制 Git 历史。两者都不会自动复制源仓库的 Issues、Issue 状态或 Project items。

本模板把任务系统保存为代码：

- `config/project-bootstrap.json`：项目自己的任务 manifest。
- `scripts/github-bootstrap.mjs`：幂等创建或更新标签、Issues、Sub-issues 和 Project。
- `.github/workflows/bootstrap-project.yml`：在 GitHub 网页中手动执行。
- `.github/ISSUE_TEMPLATE/`：后续手工新增 Epic 和 Task 的统一格式。

## 推荐使用方式

1. 点击 GitHub 上的 **Use this template**，选择 **Create a new repository**。新项目不建议使用 fork，因为 fork 更适合向原仓库贡献代码。
2. 将 `config/project-bootstrap.example.json` 复制为自己的任务设计，写入 `config/project-bootstrap.json`。
3. 本地验证配置：

   ```bash
   npm test
   npm run validate
   ```

4. 为新仓库配置 Actions secret `PROJECT_TOKEN`，然后运行 **Bootstrap Issues and Project** workflow。

也可以在已经通过 `gh auth login` 的本地环境执行：

```bash
npm run bootstrap:issues  # 只创建标签、Issues 和 Sub-issues
npm run bootstrap         # 同时创建和配置 GitHub Project
```

所有操作都按 `[任务编号] 标题` 查找已有 Issue，重复执行只会同步正文、标签、关系和 Project 字段，不会重复创建。

## Token 权限

只创建仓库 Issues 时，token 需要目标仓库的 `Issues: Read and write`。

创建组织 GitHub Project 时还需要：

- Fine-grained PAT：组织权限 `Projects: Read and write`，以及目标仓库 `Issues: Read and write`。
- Classic PAT：`project` scope；私有仓库还需要相应的 `repo` 权限。

不要把 token 写进 manifest、workflow 或提交历史。Actions secret 不会随模板复制，每个新仓库需要单独配置，或在组织级配置共享 secret。

## Manifest 结构

每个 Issue 可以包含：

- `id`、`title`、`priority`、`phase` 和 `area`。
- 额外 labels。
- 目标、用户价值、当前问题、期望行为和范围。
- 数据/API 要求、验收标准与测试要求。
- `dependsOn` 跨 Issue 依赖。
- `children` 原生 Sub-issues。

完整示例见 [`config/project-bootstrap.example.json`](config/project-bootstrap.example.json)，字段约束见 [`config/project-bootstrap.schema.json`](config/project-bootstrap.schema.json)。

## 工作流状态

默认 Project 字段：

- Status：Backlog、Ready、In progress、In review、Done
- Priority：P0、P1、P2
- Phase：由 manifest 定义

新任务初始进入 `Backlog` 且不自动指派负责人。

## 常用命令

```bash
npm run validate
npm test
npm run bootstrap:issues
npm run bootstrap
```

指定其他配置或仓库：

```bash
node scripts/github-bootstrap.mjs \
  --config config/project-bootstrap.example.json \
  --repo owner/repository \
  --dry-run
```

## 官方行为说明

- [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)
- [REST API endpoints for sub-issues](https://docs.github.com/en/rest/issues/sub-issues)

