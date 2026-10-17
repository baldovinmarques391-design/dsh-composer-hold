# dsh-composer-hold

**发送键与停止键分开**，并且给"绝对停止"配一道**注入闸门**：你按下绝对停止之后，
后台任务完成、子代理汇报、定时提醒、webhook、目标续轮、hooks 注入——**全部被扣住**，
直到你发出下一条消息，它们与那条消息**在同一次请求里**送进模型。

## 按键的五个面

| 状态 | 图标 | 何时出现 | 点它 | 此时 Enter |
|---|---|---|---|---|
| 执行中 | 蓝 ‖ | 主回合在跑 | 软停：只中止当前回合（＝原来的停止键） | 走系统的繁忙提交策略 |
| 软暂停 | 蓝 ▶ | 你按过 ‖ 之后 | 进入绝对停止（锁定） | 走系统默认提交（本机是插话模式） |
| 绝对停止 | 灰蓝 ■（不可点） | 锁定中，且还有子代理/后台任务在跑 | 无动作 | — |
| 锁定＋有草稿 | 蓝 ↑ | 在 ■ 状态下打字 | 发送：本条 + 期间扣住的全部注入一次进模型 | 同左 |
| 静止 | 灰 ↑（不可点） | 空闲、无草稿、**且没有子代理/后台任务在跑** | 无动作 | 发送（有字时） |

- **▶ 是"模式"**：软暂停期间，注入仍可把模型唤醒继续执行，图标保持 ▶；你发消息（或回合重新开始）才回 ‖。
- **■ 没有点击出口**：唯一出路是打字（例如输入"继续"）再回车。
- **尘埃落定**只看子代理 + 后台任务（该会话 `/state` 里 `running` 的 job 行数为 0）。
- 右上角**橙色数字**＝此刻被扣住的注入条数。

## 它怎么工作

**宿主半**（`index.js`）——唤醒投递只有一个收口：`Agent.send(message, target, wakeup)`。
`followup()` / `steer()` / `inject()` 全部转发到它，所有外部生产者都经由它，所以插件只
需要在 agent 实例上覆盖一个 `send`：

- 锁定期间、`source.kind !== 'user'`、且 `wakeup === true` → 降级为 `('next-step', false)`：
  **消息留在收件箱，驱动不会被唤醒**。
- `source.kind === 'user'` → 解锁并**原样投递**（唤醒），于是驱动的第一步在**同一次请求**里
  claim 掉整批 `next-step` 加上你这条 `next-turn`。

**浏览器半**（`client.js`）——在 `conversation.input.right` 槽位渲染自己的键，并用产品图标的
几何特征（上升箭头 `path` / 停止方块 `rect 3,3,10,10`）把产品那颗发送键移出布局；
点击**委托**给那颗隐藏的键，所以发送/排队/插话/附件/斜杠命令全部沿用产品实现。
**回车路径完全不受影响**——这也是安全垫：按键坏了，回车照样能发。

子代理会话（`subagent !== null`）**不接管**，保留产品自己的独立停止键。

## 状态存哪

`locked` 是**宿主进程内**状态（`globalThis[Symbol.for('dsh-composer-hold.state')]`，故意不放
实例闭包：热重载会分叉），通过两个端点与浏览器同步：

```
GET  /plugin/dsh-composer-hold/state?sessionId=…   → { locked, parked, running, diagnostics }
POST /plugin/dsh-composer-hold/mode  { sessionId, mode: "lock" | "unlock" }
```

刻意不写进会话日志：外部插件**无法**写自定义持久事件——`Session.append()` 不接受 envelope 的
`ignorable` 标记，而未知的必需事件类型会让持久化读取**拒绝重建整个会话**。所以宿主重启后锁定不保留。

## 安装

作为**正经 bundle** 装进 profile（这样插件页才会列出它，并带开关）：

```jsonc
// profiles/<name>/package.json
{
  "dependencies": { "dsh-composer-hold": "link:D:/…/dsh-composer-hold" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-composer-hold" ] } }
}
```

**不要再在 profile 的 `cordis.patch.yml` 里手插同一行**：bundle 自带的
`cordis.patch.yml` 已经插入行 id `composer-hold`，两行同 id 会让 id 定向补丁（插件页开关）
只命中其中一个。

## 已实测（2026-10-16，3080 实例）

| 项 | 证据 |
|---|---|
| 锁定期间定时提醒被扣住 | 宿主日志 `hold … <- schedule\|… (next-turn -> next-step, no wake)` |
| 用户消息放行 | 日志 `release … <- user\|…`；`parked` 归零并开新回合 |
| 连续两条注入都被扣住 | 自测：`schedule` followup 与 `plugin` steer 后 `parked` = 2，agent 仍 idle |
| 与用户消息同批放行 | 上一条实测：提醒文本与用户消息出现在同一次请求里 |

判定闸门是否生效，只看两件事：**锁定时 `parked` 有没有涨** + **模型有没有在用户没说话时自己开新回合**。

## 已知边界

- 产品那颗键是靠 **SVG 几何指纹**识别的。产品换图标/结构时的症状是"冒出两颗键"——可见、好修，不会静默失效。
- 锁定**不跨宿主重启**（见上）。
- 锁定会对该会话执行 `agent.cancel({kind:'user'},{keepInbox:true})`，等同于一次停止；
  **不要对正在跑重要任务的会话上锁**。
- 其他停止入口（Esc 等）不经过本键，因此不会进入 ▶ 模式（当前行为，未接）。
