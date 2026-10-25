# dsh-dblclick-bottom

DeepSeek Harness 聊天面板双击滚动插件。

- **下半区双击**：把会话记录平滑滚动到底部，并停在那里（不再被自动跟随打断）。
- **上半区双击**：平滑跳转到最近一条自己的消息，并把它停在视口顶部；连按则逐条向上回溯；已经到最早一条时直接滚到顶。
- **边界自动加载**：当向上跳跃会越过「已加载内容的顶部」时，自动点击宿主的「加载更早 / Load earlier」按钮加载更早历史，加载完成后再完成这次跳跃（单次手势最多加载 3 页）。
- **上半区连点 5 次 → 直接到最前**：在上半区快速连点（5 次以上，2.5 秒内）会切换到「一口气到最前面」的激进模式：自动反复点击「加载更早」直到历史全部加载完，然后把滚动条直接停到会话第一条消息的位置。

无配置项、无依赖，安装即生效。

## 效果对照

| 操作 | 行为 |
| --- | --- |
| 双击下半区（y > 72% 视口高度） | 平滑滚到底部 |
| 双击上半区（y < 28% 视口高度），视口未对齐任何自己的消息 | 平滑滚到最近一条自己的消息上方 |
| 同上，视口已对齐某条自己的消息 | 平滑滚到上一条自己的消息 |
| 已在最早一条自己的消息上 | 平滑滚到内容最顶部 |
| 上半区双击，但上方还有未加载的历史 | 自动加载更早历史（封顶 3 次），加载后完成跳跃 |
| 双击直接落在「加载更早」按钮上 | 交给宿主自己的点击逻辑，插件不干预 |
| 上半区连续点击 5 次以上（2.5 秒内） | 反复加载「加载更早」直到历史全部加载完，然后平滑滚到会话最顶部（第一条消息） |

## 安装

### 从 GitHub 安装

```bash
dsh plugin --profile desktop add https://codeload.github.com/liren2272-hue/dsh-dblclick-bottom/tar.gz/refs/heads/main
```

### 本地链接安装

克隆或复制本目录后，把源码目录软链/引用到 profile：

```jsonc
// C:\Users\<you>\.dsh\profiles\desktop\package.json
{
  "dependencies": {
    "@local/dsh-dblclick-bottom": "link:C:/Users/<you>/Documents/dsh-plugins/dsh-dblclick-bottom"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-dblclick-bottom"]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install` 重建链接，**重启桌面端**即可生效。

> Windows 下若 git 拉取 GitHub 报 `CRYPT_E_REVOCATION_OFFLINE`，给命令加 `-c http.sslBackend=openssl`。

## 测试

仓库自带一个纯 Node 的回归测试（内置极简 DOM 桩，无需浏览器、无需安装依赖）：

```bash
node test/jump-to-question.test.mjs
```

覆盖：下半区到底、上半区对齐/未对齐、连续逐条上跳、到顶、无用户消息、无 `scrollTo` 时的即时兜底、有分页控件时自动加载一次、无控件直接到顶、已在目标处不重复加载、双击控件本身不干预、空记录先加载、加载封顶 3 次、上半区连点 4 次不触发、连点 5 次直达最前并加载全部历史。

## 文件结构

```
dsh-dblclick-bottom/
├── client.js               # 全部行为（浏览器端）
├── index.js                # 宿主端占位（无需逻辑）
├── cordis.patch.yml        # 注册 bundle
├── icon.svg
├── locale/
│   ├── zh.json             # 插件市场元信息
│   └── en.json
├── test/
│   └── jump-to-question.test.mjs
├── package.json
└── README.md
```

## 实现要点

- 只监听 `[data-conversation-scroll]`，自动避开右侧栏副本（`[data-sidebar-right-panel]`），多实例时取面积最大的主面板。
- 目标行通过宿主的 `data-chat-flow-kind="user"` / `"steering"` 定位，所属 turn 行取 `[data-chat-turn]`。
- 滚动用原生 `scrollTo({ behavior: 'smooth' })`，并用 `scrollend`（缺失时定时器兜底）确认落点；若浏览器忽略平滑请求则立即写入。落点由「自己滚动」还是「用户/宿主滚动」决定是否二次校正，避免与阅读跟随打架。
- 分页控件按文案匹配（`加载更早` / `Load earlier` 等），并回退到包裹元素的 `*_older` class，避免 CSS module hash 变化。
- 「连点 5 次到最前」只统计落在上半区、且不落在交互元素/「加载更早」按钮上的原始 `click` 事件（2.5 秒窗口）；触发后进入 `jumpToFront`，反复点「加载更早」直到控件消失（封顶 60 页、每页超时 15 秒），再平滑滚到顶部。加载期间会暂停普通上半区双击，避免两种跳转互相争抢滚动条。

## 版本历史

- **1.2.0**：上半区连续点击 5 次以上（2.5 秒内）直达会话最前面，自动加载全部「加载更早」历史；新增对应回归测试。
- **1.1.0**：新增上半区「跳转到自己的消息」、连续向上逐条、越界自动加载更早历史、平滑滚动动画；新增回归测试。
- **1.0.0**：初始同步，仅支持下半区双击滚到底部。
