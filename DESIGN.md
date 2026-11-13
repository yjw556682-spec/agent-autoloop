---
name: Agent Autoloop
description: 像素小镇工作台与谱线大屏，共用真实中台状态和任务详情
colors:
  charcoal-base: "#191b1c"
  charcoal-input: "#1e2122"
  charcoal-plate: "#26292a"
  carbon: "#16181a"
  hairline: "#3a3d3e"
  ink: "#e7e2d4"
  ink-mid: "#a6a193"
  ink-faint: "#928d7f"
  sodium: "#f2d30b"
  wavelength-violet: "#9d7bff"
  wavelength-blue: "#5b8cff"
  wavelength-cyan: "#3fc1ff"
  wavelength-green: "#43cf8e"
  wavelength-orange: "#ff8a3d"
  wavelength-red: "#ff5d5d"
typography:
  data:
    fontFamily: "system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  plate-number:
    fontFamily: "system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.55
    letterSpacing: "0.02em"
  board-data:
    fontFamily: "system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    letterSpacing: "0.16em"
rounded:
  sm: "4px"
components:
  plate:
    backgroundColor: "{colors.charcoal-plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "22px 26px 24px"
    width: "min(720px, 100%)"
  button-act:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 20px"
    height: "44px"
  button-act-best:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.carbon}"
    rounded: "{rounded.sm}"
    padding: "0 20px"
    height: "44px"
  button-act-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-mid}"
    rounded: "{rounded.sm}"
    padding: "0 20px"
    height: "34px"
  input-word:
    backgroundColor: "{colors.charcoal-input}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "44px"
  banner:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
---

# Design System: Agent Autoloop

## Overview

本分支首页采用像素小镇：派单站、议事厅、工坊、档案馆、灯塔对应真实队列、卡片、Agent、历史和通知。地图素材随构建打包，数字和动画由中台状态驱动；窄屏点击建筑后聚焦详情。下面的谱线规范适用于可展开的运行谱线、详情和大屏，不再限制首页只能使用谱线。小镇样式在 town.css，业务列表在 workbench.css；三者共用单一会话和操作接口，见[系统架构](docs/workbench-architecture.md)。

**Creative North Star: "发射线谱栏（The Emission-line Rail）"**

这个界面把中台画成一台光谱仪。底是一张程序化条带织出的炭灰连续谱——body 背景由 3px 重复条带（#1b1d1e/#1f2122）加底部径向微光叠在炭底上构成；每件事物——一轮任务、一张卡片——是谱上竖着的一根发丝线（2px 茎线）。状态不靠图标、徽章或角标，全部写在线形里：实线在跑、虚线不确定、半高在排队、残桩已成过去、划断已停；加倍钠黄双线是唯一正在等你的事。点其中一根线，决策图版（plate）在那根线的正上方绽放，拍板完线就接成实线；无事时，从底部一行发射控件里发一根新线。

文字世界只有一个数据字号 14px，层级由三种墨色（ink / ink-mid / ink-faint）和字重承担，数字等宽。色彩只作为谱线存在：规则身份映射六个固定波长，589nm 钠黄专属等待，其余一切是墨色系。没有侧边栏、没有卡片网格、没有图表库、没有外部字体（own-world 契约，构建如实兑现——全部样式在一个 world.css 里，产物只有一份 JS 加一份 CSS）。

三个场景共用同一个壳（仪器条 / 舞台 / 图例三行网格）：进门（本人密钥）、总览（读轨、拍板、发射）、大屏（#/board，同一根轨的远读档）。界面文案是中文大白话，错误提示说人话（"钥匙不对，或中台没连上。"）。

**Key Characteristics:**

- 状态即线形：七种茎线形（live / queued / dashed / stub / struck / waiting / notice，`rail.ts` 的 `MarkForm` 是唯一枚举来源）加 land、breathe 两个动效
- 颜色只作为谱线：六个波长 + 钠黄，正文、按钮、输入框、边框全是墨色系
- 单一数据字号 14px；编号 21px 即标题；大屏 19px 场景档
- 平面深度：炭色三阶 + 1px 发丝线，无投影
- 44px 触控目标、focus-visible 1px 实墨描边、tabular-nums 数字
- 单一 640px 断点；大屏是独立路由场景，不是响应式变体

## Colors

底与字是同一支炭灰-骨白连续谱，彩色只以谱线身份出现在茎线、图例色样和图版指针上。

### Primary
- **钠黄 Sodium** (#f2d30b)：全站唯一高饱和色，589nm。只属于"正在等你"的家族——ask 卡的实线双线（带 0.5px 钠色光晕）、notice 卡的 75% 高虚线单线、它们图版顶上的钠色指针、图例里"没被接走"的虚线小样、进门页待机的双线。除此之外任何元素不得使用。

### Secondary（六个规则波长）
- **波长·紫 Violet** (#9d7bff) / **波长·蓝 Blue** (#5b8cff) / **波长·青 Cyan** (#3fc1ff) / **波长·绿 Green** (#43cf8e) / **波长·橙 Orange** (#ff8a3d) / **波长·红 Red** (#ff5d5d)：规则的身份色，按规则名的确定性哈希分配（见命名规则），只上茎线、图例色样和图版指针。没有规则的中台自带卡片烧中墨（--ink-mid）。

### Neutral
- **炭底 Charcoal Base** (#191b1c)：页面基底，条带与微光落在它上面；`::selection` 反转用它做底。
- **炭井 Charcoal Input** (#1e2122)：输入框的填充。
- **炭版 Charcoal Plate** (#26292a)：决策图版的抬升面。
- **炭黑 Carbon** (#16181a)：实墨填充按钮上的文字色。
- **发丝灰 Hairline** (#3a3d3e)：所有结构线——基线、分隔线、quiet 按钮与输入框边框、图例间隔符、图版默认指针。
- **骨白 Ink** (#e7e2d4)：正文、实心按钮、选中态、focus 描边、错误强调（加粗）。
- **中墨 Ink Mid** (#a6a193)：次级文字——仪器条事实、图版副题与 meta、placeholder 替代场景、默认按钮边框。
- **淡墨 Ink Faint** (#928d7f)：三级文字——轨标签、提示、图例、输入框 placeholder。

### Named Rules
**The 589nm Rule.** 钠黄只表达"这件事在等你"。错误与告警用实墨加粗（`.mistake` / `.banner` / `.note.err` / `.gate .err` 一律 `color: var(--ink)` + `font-weight: 600`）；world.css 在 `.mistake` 处明文注释了这条禁令：An alarm is loud ink, never the sodium family.

**The 波长即身份 Rule.** 规则颜色不手挑、不按语义上色：`wave.ts` 把规则名做 31 乘子哈希（种子 7）对 6 取模，同名规则永远烧同一波长，跨总览、大屏、图例一致可读。红（wl-5）不表示错误，只表示某条规则的身份。

## Typography

**字体：** 系统栈 `system-ui, 'Microsoft YaHei', sans-serif`（无外部字体、无图标字体），全站数字 `font-variant-numeric: tabular-nums`。
**Character：** 一支系统无衬线承担全部，人格来自字号的极端克制与墨色分层——像仪器读数，不像排版。

### Hierarchy
- **Data 正文** (400, 14px / `--data`, 1.55)：一切默认文字，全站的"单一字号"。
- **Plate 编号** (650, 21px, 0.02em)：决策图版的"编号即标题"——`卡片 #N · 等你决定`、`第 N 轮`。唯一的标准字号抬升。
- **Board 场景档** (400, 19px, 1.55)：大屏整档放大（轨标签与图例降回 15px），为跨房间远读。
- **Label 仪器条名称** (400, 14px, 0.16em, uppercase)：顶栏 AGENT AUTOLOOP；进门页有同款 12px 内联实例。
- **强调**：`b` 元素 = 骨白色 + 600 字重，不换字号——花费、用量、编号、状态点旁边的在线名都这样提亮。

### Named Rules
**The 单一数据字号 Rule.** 新界面的一切常规文字都是 14px；层级用三种墨色和字重（400/600/650）表达，不新增字号。已落地的例外只有三个：图版编号 21px、大屏 19px（其标签/图例 15px）、进门名称 12px。

## Layout

- **壳**：`.shell` 三行网格（仪器条 auto / 舞台 1fr / 图例 auto），min-height 100dvh，内边距 `18px clamp(16px, 4vw, 52px) 14px`。
- **舞台**：竖向 `1fr auto auto`——图版在自由空间绽放（桌面底部对齐、紧贴轨上方；移动端改顶部对齐），空态提示悬在轨上方（bottom = rail-h + 78px），其下是轨和发射行。
- **轨**：高 rail-h + 44px（132 + 44），横向滚动（滚动条隐藏），左端 28px 渐隐遮罩（历史在左边消失，遮罩在滚动条带上、不在基线上），两端 24px sticky 弹性空当；茎线 2px 宽，带 44px 宽的不可见热区；标签在茎下（14px 淡墨，选中转骨白），1px 发丝基线垫底。
- **间距**：没有 token 化，是 10 / 12 / 14 / 16 / 20 / 22 / 26px 的松散节律——控件间隙 10px，区块节奏 14px，仪器条与 meta 间隙 16–20px，图版内距 22–26px。
- **断点**：只有一个，≤640px——rail-h 降到 108px、图版内距收紧（18/16/20）、发射输入全宽、图版改顶对齐、图例收紧。大屏不是断点而是独立路由 `#/board` 的同一个壳：rail-h 换 44vh、茎线 3px、字号 19px。
- **空态**：居中一行淡墨白话（"还没有轮次。发射一根线，或等下一个定时。"），不画插画。

## Elevation & Depth

平面世界，无投影。深度由三阶炭色（炭底 → 炭井 → 炭版）加 1px 发丝线表达。全站仅有的两处 box-shadow 都是功能性记号而非阴影：等待茎线的 0.5px 钠色光晕，和离线状态点的 1px 内描圆环。`::selection` 用骨白底、炭底字反转，是全站唯一的反色时刻。

### Shadow Vocabulary
- **钠晕 sodium-halo** (`box-shadow: 0 0 0 0.5px rgba(242,211,11,0.35)`)：等待茎线的轮廓增亮，让钠线在暗底上微微发毛。仅限 `.stem.waiting`。
- **离线环 presence-ring** (`inset 0 0 0 1px var(--ink-faint)`)：空心圆点表示该接单程序/通道不在线。

### Named Rules
**The 无影 Rule.** 深度 = 炭色三阶 + 1px 发丝线。不给面板、图版、控件加投影；上表两个记号之外没有先例。

## Shapes

圆角只有一档：4px（图版、按钮、输入框、横幅）；唯一的其他形状是状态点的正圆（border-radius 50%）。茎线是 2px（大屏 3px）的直角矩形，图版顶上的指针与茎线同宽（`--stem-w`），把图版钉在所选线的正上方。边框一律 1px，三级用法：结构线用发丝灰（图版、输入框、quiet 按钮、分隔线），主动作用用中墨（默认按钮边框，hover 升骨白），实墨强调用骨白（best 按钮、横幅、focus 描边）。没有药丸形、没有渐变边、没有裁切图形。

## Components

### Navigation（仪器条）
顶栏一行两端对齐：左侧名称（14px / 0.16em / uppercase / 中墨），右侧事实（在线状态、今日花费与轮数、7 天花费、大屏/返回链接，14px 中墨，数字 `b` 提为骨白 600）。在线状态是 7px 圆点：在线实心骨白，离线空心发丝环。路由是 hash（`#/`、`#/board`），链接保持中墨文字，不做按钮化。

### The Rail（签名组件）
每轮任务/每张卡片一根竖线，form 决定形（数据源 `rail.ts` 的 `marksOf`，本轮是哪形由运行状态唯一决定）：

| form | 线形 | 含义 |
| --- | --- | --- |
| live | 满高实线（132px），规则波长 | 在跑 |
| queued | 42% 高、55% 透明度实线 | 排队 |
| dashed | 满高虚线（7px 实 / 5px 空） | 不确定/等重派 |
| stub | 18px 残桩、30% 透明度 | 已完成（只保留最近 18 根，`STUBS_KEPT`） |
| struck | 18px 残桩 + 1px 贯穿划线 | 已停/正在停 |
| waiting | 满高钠黄实线双线 + 钠晕 | ask 卡等你拍板 |
| notice | 75% 高钠黄虚线单线 | notice 卡要你留意 |

新线落地播放 land（scaleY 0.02 → 1.045 过冲 → 1，0.6s spring）；大屏上等待线呼吸（4s 透明度 1↔0.5），其余一切静止、不可点。总览上茎线是按钮（focus-visible 描边 offset 4px），大屏上退化为纯展示的 span。选中态只把标签从淡墨提到骨白——线本身不变；等待卡会自动绽放，直到本人把它打发走（`overview.tsx` 的 dismissed 逻辑）。

### Cards / Containers（决策图版 Decision Plate）
宽 `min(720px, 100%)`，炭版面 + 1px 发丝边 + 4px 圆角，内距 22/26/24。头顶行：编号 21px/650 + 副题 14px 中墨。正文 `pre-wrap` 任意断行。meta 行 14px 中墨、数字 `b` 600。顶部指针（`::after`，`--pointer` 定位、`--pointer-color` 上色：等待卡钠色，其余发丝灰）把图版钉在所选线正上方。ask 卡的选项区是一排骨描按钮（gap 10px），推荐项 `.best` 实墨填充；下方一行 word 输入 + 发送。错误行实墨加粗。"看经过"时间线（`.tline`）顶部 1px 分隔，max-height 260px 内滚、细滚动条发丝灰。

### Buttons（`button.act`）
- **Shape:** 4px 圆角，min-height 44px，内距 0 20px，1px 边框，字体继承。
- **Default（骨描）:** 透明底、骨白字、中墨边；hover 边框升骨白；busy 态 0.5 透明度禁点。
- **Primary（`.best`）:** 实墨填充、炭黑字 (#16181a)、600 字重——推荐选项、"发射"、"进门"。
- **Quiet（`.quiet`）:** 34px 高、发丝灰边、中墨字——图版内次级动作（停这一轮、看经过、收起）。
- **Focus:** focus-visible 1px 骨白描边，offset 2px；过渡 0.25s ease（底色/字色/边框）。

### Inputs / Fields（`input.word`）
44px 高、发丝灰边、炭井底、骨白字、placeholder 淡墨；focus 去描边、边框升中墨（键盘 focus 同样落在边框变化上）。发射行的三个输入（类型带 datalist 建议 / 对象 / 一句话说明）与图版应答输入同款。

### Launch（发射行）
横排 flex wrap：类型输入（220px 基准）+ 对象输入（160px）+ 说明输入（240px 起伸缩）+ 实墨"发射"按钮 + 结果 note（中墨；出错转骨白 600）。布局拒绝换行成网格——一行仪表。

### Legend（图例）
底部一行 14px 淡墨，顶部 1px 发丝线：规则波长色样（2px × 12px 同宽竖线，总览封顶 8 条）+ "没被接走"钠虚线小样 + 接单程序/通道在线圆点 + 今日/7 天用量，以发丝灰 `|` 分隔。图例是仪表读数，不是导航。

### Gate（进门）
居中列（gap 26px）：12px 字距名称、钠黄双线（两根 2px × 72px，gap 5px；钥匙错了整组转虚线）、居中 word 输入（`min(420px, 86vw)`）、实墨"进门"按钮、骨白加粗错误行、淡墨提示。双线是"将有一件事等你"的待机态——进门之前，系统就先给了你一根等待线。

### Banner（断线横幅）
1px 骨白边、4px 圆角、骨白 600 字；`.lost` 态下舞台与图例整体降到 0.45 透明度，横幅说"下面是最后一次看到的样子"。

## Do's and Don'ts

### Do:
- **Do** 把运行状态写进线形：实线在跑、虚线不确定、半高排队、残桩过去、划断停止、钠黄双线等你——新状态先扩 `MarkForm`，别发明第五种表达。
- **Do** 用 `wave.ts` 的名字哈希给新规则配色——同名永远同波长，跨页面一致。
- **Do** 错误一律实墨加粗（`color: var(--ink)` + `font-weight: 600`）；触控目标保持 44px；focus-visible 用 1px 实墨描边。
- **Do** 数字一律 tabular-nums，金额/用量/编号用 `b` 提到骨白 600。
- **Do** 新场景复用同一个壳（仪器条/舞台/图例 + 轨），只换档位（如大屏 44vh / 3px / 19px），不另起布局。
- **Do** 反馈靠墨色升级：hover 边框中墨→骨白、选中标签淡墨→骨白、进行中 busy 半透明。

### Don't:
- **Don't** 给等待以外的任何东西用钠黄——尤其不要拿它当错误色或强调色。
- **Don't** 新增字号：常规文字 14px，层级靠三种墨色与字重；编号抬升只属于图版（21px），场景档只属于大屏（19px）。
- **Don't** 加 box-shadow 投影、图标/emoji/徽章、超过 4px 的圆角或药丸形、侧边栏、卡片网格、图表库。
- **Don't** 让彩色出现在谱线之外——正文、按钮、输入框、边框全是墨色系；波长只上茎线、色样和图版指针。
- **Don't** 按语义手挑规则颜色（红=错误之类的映射不成立：wl-5 红只表示某条规则的身份）。
