---
name: npm-publish
description: >-
  发布 npm 包。执行完整的发布流程：版本号更新、构建检查、测试检查、Git 提交打 tag、
  推送到远程仓库、npm publish、发布验证。当用户说"发布 npm 包"、"publish"、
  "发版"、"release"、"上线 npm"、"打个版本"时自动触发。
---

# npm 包发布

## 执行步骤

### 1. 发布前确认
- 询问用户要发布的版本类型：`patch` / `minor` / `major`，或指定具体版本号。
- 检查当前分支是否为 `main` 或 `master`（或其他约定分支），如不在正确分支则提醒。
- 检查工作区是否有未提交的更改，如有则提醒用户先提交或 stash。

### 2. 构建与测试
- 运行 `npm run build`（如有 build 脚本），确保构建通过。
- 运行 `npm test`（如有 test 脚本），确保测试通过。
- 如有 lint 脚本，运行 `npm run lint` 检查代码风格。
- 任何一步失败，立即停止并报告错误，不继续发布。

### 3. 更新版本号
- 执行 `npm version <patch|minor|major>` 自动更新 `package.json` 和 `package-lock.json`。
- 该命令会自动创建一条版本提交（如 `release: 1.2.3`）和一个 git tag（如 `v1.2.3`）。
- 如果项目有 `CHANGELOG.md`，提醒用户追加本次变更说明（或自动追加）。

### 4. 推送到远程仓库
- 执行 `git push origin <当前分支>` 推送版本提交。
- 执行 `git push origin --tags` 推送 tag。
- 检查 GitHub 上是否能看到新的 tag 和 release。

### 5. 发布到 npm
- 执行 `npm publish`。
- 如果是 scoped 包（如 `@org/name`），确认是否需要加 `--access public`。
- 如果是预发布版本（如 `beta` / `alpha`），使用 `npm publish --tag <tag>`。
- 等待 publish 完成，记录输出的包名和版本号。

### 6. 发布后验证
- 访问 `https://www.npmjs.com/package/<包名>` 确认版本已更新。
- 运行 `npm view <包名> version` 确认最新版本号。
- 检查 `git log --oneline -3` 确认提交和 tag 正确。

## 输出格式

```text
## 发布结果
- 包名：<name>
- 版本：<version>
- 分支：<branch>
- tag：<tag>

## 执行步骤
1. ✅ 构建通过
2. ✅ 测试通过
3. ✅ 版本号更新至 x.x.x
4. ✅ 推送至 origin
5. ✅ npm 发布成功
6. ✅ 验证通过

## 链接
- npm: https://www.npmjs.com/package/<name>
- tag: https://github.com/<user>/<repo>/releases/tag/<tag>
```

## 禁止事项
- 不要在有未提交更改时直接发布。
- 不要跳过构建和测试步骤。
- 不要强制推送（`git push --force`）。
- 不要在未确认的情况下发布到公共 registry。
- 不要在 CI 未通过时发布（如有 CI 配置）。
