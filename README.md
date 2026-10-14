# codex2zcode

> 把 OpenAI Codex CLI/Desktop 的历史会话迁移成 ZCode 原生会话:写入 ZCode 会话库并注册到 Desktop 任务索引,重启 ZCode 后即可按项目浏览、搜索、续聊全部 Codex 历史。
>
> Migrate OpenAI Codex CLI/Desktop sessions into ZCode as native sessions — written into the ZCode session DB and desktop task index, ready to browse, search and resume after a restart.

**零第三方依赖**(仅 Node 内置模块 + 系统 `sqlite3` 命令),对 Codex 数据目录**纯只读**。

## 工作原理

- **源**:`~/.codex/sessions/` 下的 rollout JSONL(`session_meta` / `response_item` / `event_msg` / `turn_context` / `compacted` 五类记录)
- **目标**:`~/.zcode/cli/db/db.sqlite`(session/message/part 三表)与 `~/.zcode/v2/tasks-index.sqlite`(Desktop 任务索引)
- **映射**:user/assistant 消息 → text part,`reasoning` → reasoning part,`function_call`(+`_output`)、`custom_tool_call`、`web_search_call` → tool part,每轮补 step-start/step-finish;`compacted` 按 Codex 语义截断历史并以摘要续接
- **契约对齐**:写入形状与 ZCode 官方 `restore-legacy-sessions` 插件一致(provider 固定 `glm`、正文进 part 表、tool 时间放 `state.time`、user 消息带空 `model:{}`),确保任务列表可见、详情页正常渲染

## 环境要求

- Node ≥ 22.5(使用内置 `node:sqlite`)
- 系统 PATH 里有 `sqlite3`(macOS 自带),仅用于 WAL 安全备份
- 已至少运行过一次 ZCode(两个目标数据库已存在)

## 快速开始

```sh
git clone https://github.com/BMGY/codex2zcode.git
cd codex2zcode

node codex2zcode.mjs scan                          # 1. 预览:按项目统计 Codex 会话
node codex2zcode.mjs import --session <uuid> --dry-run   # 2. 单会话试算
node codex2zcode.mjs import --project <路径片段>         # 3. 按项目导入
node codex2zcode.mjs import --all                        # 4. 全量导入
```

导入完成后重启 ZCode Desktop,**切换到对应项目的工作区**即可在任务列表看到历史会话(任务列表按工作区隔离,当前工作区不会显示其他项目的历史)。

## 命令与选项

| 命令 | 作用 |
|---|---|
| `scan` | 扫描 Codex 会话目录,按项目分组统计(时间跨度、体积) |
| `import --session <uuid片段>` | 导入单个会话 |
| `import --project <cwd片段>` | 导入匹配项目的全部会话 |
| `import --all [--limit N]` | 全量导入(可限量) |
| `rollback --backup <备份> --to <库路径>` | 从备份还原数据库 |

通用选项:`--dry-run`(只解析映射不写入)、`--max-tool-output N`(单条工具输出保留字符数,默认 32768,`0` 为不截断)、`--codex-dir`、`--db`、`--tasks`。

每次导入生成 `codex2zcode-report-*.json`,记录每个会话的成功/失败与原因。

## 安全设计

- **Codex 侧只读**:工具不写入 `~/.codex` 的任何文件
- **自动备份**:每次导入前用 `sqlite3 .backup`(WAL 安全)备份两个目标库
- **幂等(合并式)**:会话 id = `sess_<Codex uuid>`、消息 id = `msg_cx_<uuid>_<序号>` 均为确定性 id;重导入只替换本工具先前导入的消息,**保留你在 ZCode 里续聊产生的原生消息**(确定性 id 保证 parentID 引用链不断);session/task 走 upsert 且保留用户自定义标题
- **工具输出截断**:巨型工具输出(截图 base64、全文件转储)默认截断保留前 32K 字符并标注原始大小——否则续聊时重放输入会撑爆上下文窗口,模型端报 `model_output_limit_exceeded`(界面提示 "The model's response exceeded the output token maximum");不需要截断时传 `--max-tool-output 0`
- **schema 校验**:写入前核对两库表结构,ZCode 升级导致漂移时拒绝写入
- **运行共存**:WAL + busy_timeout + 短事务 + 忙锁重试,ZCode 运行中导入也安全(仍建议导入后重启)
- **被 resume 过的会话**:多个 rollout 文件属同一会话 id 时按"末次文件覆盖"(Codex resume 的新文件包含完整历史)

## 已知边界

- ZCode 大版本升级若改 schema,先 `scan` + 单会话试导,确认无误再全量
- 会话内 token/cost 为近似值(取自 Codex `token_count` 事件),仅供展示
- 标题提取会跳过环境上下文、权限评估等注入消息;个别会话可能回退为 `Codex 会话 <id>` 形式
- `~/.codex/worktrees/` 下已删除的工作区路径仍会出现在任务索引中,不影响使用

## License

[MIT](./LICENSE)
