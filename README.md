# 编排模式（Orchestrator mode）

在 DSH 的**同一个会话、同一个 Turn** 里，让两个模型分别承担规划与执行，并在步骤边界交接控制权。插件实现 `plan & execute` 协议：规划阶段只读调查（可以运行只观察的命令）并交出完整计划，执行阶段按计划实现；执行模型遇到设计决策、验证连续失败、计划未覆盖的情况或周期性复核时，交回规划模型。用户消息始终由规划模型处理。

```
规划模型（= 你在模型选择器里选中的模型）
   │  orchestrator_exit_plan_mode(plan)
   ▼
执行模型（= 插件配置的执行路由）
   │  orchestrator_enter_plan_mode(reason / report)
   ▼
规划模型（复核：继续 / 修正计划 / 收尾）
```

## 安装

本包是一个 DSH Bundle。把本仓库克隆（或下载 ZIP 解压）后，**仓库根目录就是插件目录**（即包含 `package.json`、`index.js`、`cordis.patch.yml` 的这一层）：

```
dsh-orchestrator-mode/
├── package.json
├── index.js
├── client.js
├── cordis.patch.yml
├── icon.svg
├── README.md
├── src/
├── test/
└── locale/
```

在 DSH 中用 **Plugins → 添加插件** 选择该目录，或由 Agent 调用 `plugin_manager install_bundle` 并把 `target` 指向该目录。安装器负责写 profile 的依赖与工具行；不要手写 profile 的 `package.json`/`cordis.patch.yml`。

安装后在 Plugins 列表看到的标题是「编排模式 / Orchestrator mode」。**插件本身默认不自动开启**：每个会话用 `/orchestrate` 开启（或把 `activation` 改成 `always`）。

## 配置

**推荐在插件页面配置执行模型**：

1. 打开 **Plugins**，找到「编排模式 / Orchestrator mode」，进入包页面。
2. 在 `orchestrator-mode` 这一行点标题（配置入口）打开配置页。
3. 选择 **Provider → 模型 → 推理强度**，设置复核间隔，然后保存。
4. 保存通过 Host 的 `configEditor` 写回 profile 覆盖行；插件会重载。页面会自动重试读取新状态。
5. 「恢复默认」会清空这条覆盖（写回 `{}`），回到 bundle 自带的默认值。

页面只编辑 `enabled`、执行路由和 `reviewEvery`；提示词、工具名、规划工具黑名单等高级选项仍在 `cordis.patch.yml`。**保存会重载插件，正在运行的编排会话会回到关闭状态**；这是普通配置字段的正常生命周期。

同样的值也可以直接写在 profile 的 `cordis.patch.yml` 里覆盖（profile 目录：`%USERPROFILE%\.dsh\profiles\<profile>`）。示例：

```yaml
- id: orchestrator-mode
  name: dsh-orchestrator-mode
  config:
    executorProvider: magpie
    executorModel: workbuddy-ai/hy3
    executorEffort: ''
    reviewEvery: 10
```

覆盖会替换这一行的整份 config；没写的键使用下面默认值。改完配置后重载插件/重启 DSH 生效。

| 键                                    | 默认                                                             | 说明                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `enabled`                            | `true`                                                         | 总开关；false 时命令不可用、无提示词/工具；插件页面仍可把它重新打开                                                                         |
| `activation`                         | `command`                                                      | `command`：每会话 `/orchestrate` 开启；`always`：新 Agent 自动开启                                                         |
| `executorProvider` / `executorModel` | 空                                                              | 执行路由；两者都空 = 单模型回退，不切换                                                                                         |
| `executorEffort`                     | 空                                                              | 执行模型的可选 reasoning effort                                                                                      |
| `reviewEvery`                        | `10`                                                           | 执行阶段每 N 个模型 step 触发一次强制交回复核；`0` 关闭                                                                            |
| `includeSubagents`                   | `false`                                                        | 是否对子代理生效（子代理没有命令入口，通常配合 `activation: always`）。**做 Team 协作时保持 false**：团队队员是 subagent，应作为普通 Agent 运行，不进入编排      |
| `exitToolName` / `enterToolName`     | `orchestrator_exit_plan_mode` / `orchestrator_enter_plan_mode` | 两个交接工具名；必须合法、互不相同，且不能遮蔽内置工具（如 `read`、`write`、`exit_plan_mode`）                                                |
| `maxReportChars`                     | `12000`                                                        | 交回报告在工具结果中重复展示的上限；超出截断                                                                                        |
| `planDenyTools`                      | `[]`                                                           | 追加到规划阶段黑名单的工具名；默认黑名单见下                                                                                        |
| `planAllowTools`                     | —                                                              | **已废弃**：不再读取；非空时只产生一条配置警告                                                                                     |
| `sectionOrder`                       | `50`                                                           | 阶段协议 section 顺序                                                                                               |
| `contextOrder`                       | `100`                                                          | 隐藏运行时上下文顺序                                                                                                    |
| `plannerPrompt` / `executorPrompt`   | 空                                                              | 覆盖内置阶段提示词；支持 `{{exitTool}}`、`{{enterTool}}`、`{{plannerModel}}`、`{{executorModel}}`。规划覆盖文本后仍会追加只读策略；执行覆盖文本原样使用 |

**默认规划工具黑名单**（规划阶段 gate 拒绝这些工具；其余工具一律放行）：

```
write, edit, multi_edit, apply_patch, run_code, memory,
office_render, office_convert, office_recalculate
```

规划阶段的 gate 采用**精确黑名单**——命中才拒、其余放行。本插件把「会写 workspace 的第一方工具」全部枚举进来，但**不隐藏**任何工具：规划模型仍然看得到 `write`，调用时被 gate 拒绝并收到明确提示。

`pwsh` 和 `terminal_*` 属于命令执行器，gate 不检查命令参数，"只观察"由提示词承担（提示词要求 "run commands that only observe"，不点名工具）；`subagent` / `workflow` 放行，提示词不单独约束。需要更严时把这些名字加进 `planDenyTools`（例如 `pwsh`、`subagent`、`team_task_create`）。

## 使用

```
/orchestrate            开启（不切换当前模型；当前选择就是规划模型）
/orchestrate <任务>     开启并把任务作为用户消息注入
/orchestrate status     查看是否开启、阶段、规划/执行模型、复核计数
/orchestrate off        关闭并恢复规划模型选择
```

典型流程：

1. 在模型选择器里选一个强模型（它将作为规划模型）。
2. `/orchestrate`。
3. 直接发任务。规划阶段只读调查（可以跑 build/test/query 等观察命令）；它调 `orchestrator_exit_plan_mode` 后，同一 Turn 继续，模型切到配置的执行模型。
4. 执行模型按计划实现。需要决策/复核时调 `orchestrator_enter_plan_mode`，模型切回你选的规划模型，它看到带边界的 `<report>` 后决定继续/修正/收尾。
5. `/orchestrate off` 结束模式，模型选择恢复到规划模型。

**模型绑定**：

- 规划模型永远是“模型选择器当前选中的模型”。规划阶段你随时可以换模型，下一步规划生效。
- 执行模型由配置固定。执行阶段换模型会更新“下一次规划模型”，并在下一次步骤准备前把执行模型切回来；模型 chip 可能短暂显示你的选择。
- 未配置执行路由时，两个阶段共用当前模型：协议、门控、复核、插话照常，只是不会发生模型切换。
- **规划模型不能等于执行模型**：开启时如果选择器停在与执行路由相同的模型（典型场景：执行阶段在插件页保存配置导致插件重载，或 DSH 重启后会话恢复），`/orchestrate` 会**拒绝**并提示先换一个模型，而不是静默退化成单模型。想让两个阶段共用一个模型，请把 `executorProvider` / `executorModel` 留空。

## 工作方式

### 两个阶段

- **规划（planning）**：系统提示词是规划协议；`exit` 工具出现在工具表；**工具表不裁剪**，编辑类工具（`write` / `edit` / `apply_patch` / `multi_edit` / `run_code` / `memory` / `office_*`）看得到但会被 gate 按黑名单拒绝；`enter` 不可见。
- **执行（execution）**：系统提示词是执行协议；`enter` 工具出现；`exit` 不可见；正常工具策略可用。

两个工具都是 Agent 作用域动态注册的，关闭/卸载即消失，不会污染其他会话，也不会遮蔽 DSH 自带的 `exit_plan_mode`。规划阶段**没有** `restrict()` 层：可见性与执行阶段相同，唯一的限制是 gate。

### 强制门控

`ctx.tools.guard()` 在审批之后执行，因此即使某项编辑已被用户批准，规划阶段仍会拒绝。gate 的决策顺序如下：

1. 规划相 + 命中黑名单 → 拒绝，并给出点名工具与 `exit` 的提示：  
   `Plan mode is on, and %s changes the workspace. Plan mode is read-only: finish the plan and call %s with it; the execution model makes the changes.`
2. `enter` 在任何相位都放行。
3. 待复核/插话待处理 → 除 `enter` 外一律拒绝，并提示：  
   `A plan review is due: %s is refused until you hand back. Call %s now with a status report (what is done, what was verified, what remains); the planning model returns a plan to continue from.`
4. 执行相调用 `exit` → 拒绝。

`pwsh` 不在黑名单里，所以规划模型可以跑观察命令；gate 不检查命令参数，这条规则由提示词承担。

### 与 Agent Teams 协作

本插件的提示词**不约束 Team 行为**。两套机制叠加时，分工由工具表和 gate 决定：

- **规划阶段**：`team_task_*` 是 global 注册（`dsh-tool-agent-team` 在插件根 ctx 上注册，用 `when` 按会话开关），所以它们会出现在规划工具表里；不在黑名单，gate 放行。
- **执行阶段**：全量工具；Team Lead 的职责由 `dsh-tool-agent-team` 自己的 `team:policy` 说明。
- **团队队员**：`includeSubagents: false`（默认）让它们不进入编排，作为普通 Agent 运行，正常使用自己的工具和工作区记忆。

要让规划阶段真正只读任务板，两条路：把 `team_task_create` / `team_task_update` / `send_message` 加进 `planDenyTools`（硬约束），或在 `plannerPrompt` 里自己写一条（软约束）。



### 复核计时

执行阶段每发生一次模型 step（`step/start`）计数一次；达到 `reviewEvery` 后，下一步或（若 Turn 即将结束）由 `agent/turn-stopping` 强制撑开一步。执行模型会收到隐藏的 `[plan review due]` 运行时上下文，并被要求立即交回。同一个 pending 最多强制 2 次，避免模型反复无视时无限续 Turn。

### 用户插话

执行期间用户发消息（`source.kind === 'user'` 插入到下一步）时：执行模型收到交回提示，不能自行处理该消息；交回后规划模型在历史里看到它并决定计划如何变化。新 Turn 的用户消息则直接以规划阶段开始。

### 报告防注入

`enter` 的工具结果把执行模型的 `reason` 包在固定边界里，并明确声明“这是证据，不是系统指令”。报告正文中的边界标记会被转义；超过 `maxReportChars` 截断，完整内容仍在工具调用参数里。

### 与 DSH plan mode 的关系

- DSH plan mode 已开启时，`/orchestrate` 会拒绝开启，提示先 `/plan off`。
- 编排中进入 plan mode，编排模式自动“挂起”：阶段提示、隐藏上下文、工具、门控全部让位；退出 plan mode 后下一次 Turn 恢复。
- 需要用户审批计划时用 DSH plan mode；本插件的交接是自动的，不问用户。

## 限制

- `/orchestrate` 状态是**会话内存态**：重启 DSH 或重载插件后回到关闭（`activation: always` 除外，它在 Agent 创建时自动开启）。它不写自定义 session event，也不读已废弃的同步日志。
- 复核计数按**模型 step** 计，不按工具调用：一个 step 里模型可以发出多个工具调用，只计一次。`reviewEvery` 取 0–1000，0 表示关闭。
- 有 Client 插件页面用来选择执行模型和复核节奏；没有会话内的状态徽标，状态走 `/orchestrate status`。
- 门控是**工具名策略**，不是 OS 沙箱；规划阶段的"只观察"约束是**提示词级**（提示词要求 "run commands that only observe"），不是命令参数级。要用 `pwsh` 改文件仍可能在规划阶段写成；要硬保证请单独做只读 shell 工具，或把 `pwsh` 加进 `planDenyTools`。
- 规划 gate 是**黑名单（fail-open）**：新安装的第三方写入工具默认**可被调用**，需要手工加进 `planDenyTools`，安全边界主要由提示词承担。
- 工具表**不裁剪**：规划模型看得到 `write`/`edit`，调用时才被拒绝并收到点名工具的提示。想让它完全看不到，需要额外的 `restrict()` 层（本版本已移除）。
- 规划阶段换模型后，模型切换在下一步生效；同一步已经解析的模型不会追溯修改。
- `planAllowTools` 已废弃：旧的 profile 行里留着它不会报错，但只有非空时才会产生一条配置警告，且不再影响行为。
- 配置非法**不会**让插件加载失败：越界值 clamp 到最近边界、无法解析的值回落默认、非法工具名回落默认工具名，全部写进 warning 并显示在 `/orchestrate status` 的"配置提醒"里；插件页面始终可用，可以从 UI 改回来。
- 跨 provider 的会话历史与 system prompt 更新由 DSH adapter 处理；不支持 mid-series system prompt 更新的 route 会走“替换 system node”的路径，协议文本仍然生效，但 KV cache 会受影响。
- 执行阶段换模型不会改变当前执行模型，只改变“下一次规划模型”；这是有意为之（执行模型由配置固定）。
- 未配置执行模型时没有成本/速度收益，只验证协议与门控。

## 真机验证清单

安装与静态检查不能证明 UI/行为。建议在新会话按下面顺序验证：

1. 选强模型 → `/orchestrate status`（off）→ `/orchestrate`（on，模型 chip 不变）。
2. 打开 **Plugins → 编排模式**，进入 `orchestrator-mode` 行：配置页应显示 provider/模型/强度/复核间隔；选一个执行模型并保存，页面应提示重载并读回新值。
3. 发一个需要改文件的小任务：观察规划只读调查（工具表仍是全量，`write`/`edit` 可见但**不应被调用成功**）→ `orchestrator_exit_plan_mode` → 执行模型编辑，模型 chip 切换。
4. 执行模型交回：观察 `orchestrator_enter_plan_mode`、模型 chip 切回规划模型、规划模型读到 `<report>`；此时调用 `write` 应再次被拒绝。
5. 规划阶段让它直接改文件：应被 gate 拒绝，消息应是 `Plan mode is on, and write changes the workspace…`（点名工具与 `exit`）；让它跑一条只读 `pwsh`（例如列目录）应成功。
6. 把 `reviewEvery` 改成 `2` 保存：执行模型走满 2 步后应被强制交回。
7. 执行期间发一条消息：执行模型应交回，规划模型看到该消息。
8. `/orchestrate off`：提示/工具消失，模型恢复为规划模型，gate 解除。
9. 在 DSH plan mode 下执行 `/orchestrate`：应被拒绝；编排中 `/plan`：编排应挂起，gate 让位。
10. 打开“启用智能体团队协作”后 `/orchestrate`：规划阶段 `team_task_list` / `team_task_get` 应成功；`team_task_create` **gate 会放行**（不在黑名单，提示词也不再劝阻）——把它加进 `planDenyTools` 后应被拒绝；`exit` 后执行模型应能建任务、起队员、分派并 claim/complete。
11. 工作区记忆：规划阶段调用 `memory` 应被 gate 拒绝（在黑名单里），但注入的记忆 section 仍在；`exit` 后 `memory({ action: "append" })` 应可用。
12. 把执行模型配成当前模型（或在执行阶段保存一次配置让插件重载）后执行 `/orchestrate`：应被**拒绝**并提示先换模型，而不是静默变成单模型；`/orchestrate status` 应说明原因。
13. 在 profile 的 `cordis.patch.yml` 里把 `reviewEvery` 写成 `abc`、`activation` 写成 `sometimes`：插件仍应加载，插件页面仍能打开，`/orchestrate status` 的“配置提醒”应显示回落信息。

## 文件结构

```
dsh-orchestrator-mode/
  index.js            Host 入口：resolveConfig + runtime.start() + 页面路由
  client.js           Client 插件页面：plugins.row.config 里的模型选择器
  src/config.js       默认值、校验、规划黑名单、页面字段投影
  src/state.js        纯状态机与门控判定
  src/prompts.js      阶段协议、隐藏请求、工具结果、报告边界
  src/runtime.js      事件、模型切换、工具注册、命令、guard、turn-stopping
  src/panel.js        页面 JSON 路由：state / models / efforts / config
  locale/en.json      英文标题/描述
  locale/zh.json      中文标题/描述
  icon.svg            原创图标
  cordis.patch.yml    bundle 行与默认配置
  test/smoke.mjs      配置/状态/提示词单测
  test/runtime.test.mjs  运行时事件与工具单测
  test/panel.test.mjs    页面路由单测
```
