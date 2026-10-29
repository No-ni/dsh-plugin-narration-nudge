# dsh-plugin-narration-nudge

让 DSH 的 agent「边做边说」，但**不碰系统提示、不改历史**——所以不会像常见的叙述插件那样，每轮把前面已经发出去的内容改一遍、把上游的前缀缓存打掉。

## 问题：同一条提醒，放错位置就贵三个数量级

| 位置 | 改动一次的成本 |
|---|---|
| 系统提示（`messages[0]`，请求最前面） | 从改动点往后全部作废，十万级 token 重新 prefill，首字时间 4–6 秒 |
| 本轮新追加的一条消息 | 只多几十 token；那一片本来每轮都在变 |

DSH 自己的运行时上下文、技能目录、`AGENTS.md` 指令都是走第二条路：**追加**，不改头部。

## 做法

- 只观察：每一轮里，如果某一步「调了工具却没写任何正文」，记一次静默步。
- 只追加：下一个工具结果返回时，把一句提醒作为**额外上下文**挂上去，落到本轮末尾。
- 头部零写入：默认不产生任何系统提示段落（除非你显式把 `contract` 打开，那时写的是**常量**，永不变化）。

因为对话历史里已经发出的内容一个字节都不会变，前缀缓存可以一路命中。

## 安装

插件从本地目录 link 进 profile（和 `dsh-plugin-model-request-accelerator` 同样的方式）：

```bash
# 1. 放到 profile 的 plugins 目录（本仓库就是这个位置）
cd ~/.dsh/profiles/desktop/plugins/narration-nudge

# 2. 在 profile 的 package.json 里加依赖与 bundle
#    "dsh-plugin-narration-nudge": "link:./plugins/narration-nudge"
#    dsh.profile.bundles 里追加 "dsh-plugin-narration-nudge"

# 3. 重启 DSH（新增 bundle 需要重新加载插件树）
```

## 配置

配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`，也可以在「插件 → narration-nudge → 配置」里改：

```yaml
- id: narration-nudge
  config:
    enabled: true      # 总开关
    language: zh       # zh | en（提醒文字语言；固定值，不随输入切换）
    threshold: 1       # 连续几步静默后才提醒
    maxPerTurn: 2      # 单轮最多提醒几次，防止刷屏
    contract: off      # off | short | full：是否顺带提供静态叙述说明
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件完全不参与 |
| `language` | `zh` | 提醒文字语言，固定值（不会跟着你的输入来回切换） |
| `threshold` | `1` | 连续静默几步开始提醒；1 表示一静默就提醒 |
| `maxPerTurn` | `2` | 单轮提醒上限 |
| `contract` | `off` | 是否额外写一段**静态**叙述说明（off 表示完全交给别的插件） |

## 和 dsh-interim-narration 的关系

两者可以并存，但建议分工：

- 静态说明书（「边做边说」的规则）交给 `dsh-interim-narration`，并把它的动态部分关掉：
  ```yaml
  - id: dsh-interim-narration
    config:
      language: zh
      enforce: false
  ```
- 动态监督（「你这一步没说话」）交给本插件，走尾部追加。

如果你不想再要那个插件，把 `contract` 设成 `full`，本插件会用一段常量文本接管说明，头部依然恒定。

## 验收

连续几轮后看 `~/.dsh/storages/model_request_timings/sessions/<会话>.json`：

- `cacheHitPercent` 稳定在 95% 以上；
- `ttftMs` 回到 2–3 秒；
- 出现静默步时，会话里能看到一条 `source.kind = narration-nudge` 的提醒消息。

## 卸载

从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉，重启即可；本地目录可留可删。

## 开发

```bash
npm test        # node --test，纯逻辑单测，不需要 DSH 运行
```

`lib/nudge.js` 是纯函数（可测），`lib/index.js` 只负责接线：`session/event` 观察、`tools/post-execute` 追加。
