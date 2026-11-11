# Command Code 适配器

在仓库中运行 `pnpm dev`（ingest 默认端口 `8078`），打开 `http://localhost:3029/commandcode/sessions`。选择历史会话即可查看用户/助手消息、工具参数和结果。每个 turn 显示来源记录的美元估算与缓存读写 token（已包含在 input 中）；会话总额来自 Command Code 保存的 `usage.costUsd`，不是账单核对结果。

默认只扫描 `~/.commandcode/projects` 中具有 `type: session` 的 JSONL。`~/.commandcode/sessions` 是 hook 遥测，不是聊天记录；checkpoint/prompt 文件也不会被导入。可用 `COMMANDCODE_PROJECTS_DIR` 覆盖目录，或在 `~/.agent-trail/config.json` 设置 `commandcode_project_dirs` 数组。

支持 Command Code v3 的 `session`、`message`、`model_change`、`session_info` 记录。usage 在 message 记录顶层，包括 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`costUsd`。`inputTokens` 已包含缓存 token，total=input+output；缓存只作分项显示，不重复累计。工具结果不会启动新的用户 turn。缺失 usage/cost 不会被伪造。重复消息 entry ID 在单会话内只计一次。完整重解析用于更新，不启用不兼容的增量解析。

## 子代理历史的真实边界

本适配器只能展示 transcript 实际保存的内容：父会话保存 `agent` 调用的提示和最终结果，以及 `<usage>` 汇总；后台 `bg-*` ID 不是历史 session ID。因此可以回放代理委派的提示和结果，但不能恢复子代理内部消息/工具轨迹，也不能按模型分解子代理成本。父会话记录成本仅覆盖父模型调用；结果中的代理 token 汇总不重复加入父 usage。

适配器不会用消息 `parentId` 伪造代理关系（它是消息链），不会把 `bg-*` 当成 session，也不会合成可导航的子会话。要完整记录未来的子代理，Command Code 上游需要为每个子 run 保存独立 transcript、稳定 session ID、父 session ID、spawn tool-call ID、各模型 usage/cost。本改动不修改外部 Command Code CLI。


标题 `.meta.json` 纳入缓存指纹。手动、周期同步和 watcher 的 sidecar 变更都会重新检查对应 JSONL；标题 sidecar 被删除时回退到 transcript 的 `session_info` 标题。

若部分 assistant 记录缺失 `costUsd`，会话成本只累计实际保存的金额并标记为 `partial`；这不是完整费用，也不会用推测价格补齐。

本适配器基于社区贡献 [PR #4](https://github.com/camtrik/agent-trail/pull/4) 集成。
