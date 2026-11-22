# WebRPG 游戏运行页 SEO 注入规范

## 范围与数据来源
本功能仅增强经过验证的 RPG Maker 游戏入口 HTML；不修改 games.json、list.json、游戏脚本、Canvas、可见布局或任何生产仓库，Toolkit 的 CSS/JS 独立托管于 WebRPG-org/tookit；准备流程同时注入公共资源引用和原生导航。

- 读取 Index 本地工作副本的 games.json，按内部实例 ID 精确匹配 list.json 的 entry.id，避免根据标题猜测作品归属。
- 找到唯一匹配时，使用实例标题和 Game 对应的摘要、封面、Slug。
- 未匹配到 Game 的历史有效仓库，只利用可核实的 list 标题、原 HTML 标题和引擎类型生成基础 SEO；不伪造作品身份。
- 只针对实际 detection.entryPath 注入完整 SEO；其他被识别为 HTML 的文件维持原有处理。

## 语言选择
- 单语言实例：html lang 保持实际游戏语言。zh-Hans、ja、en 分别使用对应摘要。
- 其他语言，例如 pt、ko、zh-Hant：html lang 保留实际语言，缺少相应本地化简介时 SEO 摘要回退英文，绝不将游戏标记为英语游戏。
- 多语言实例：如果原 HTML lang 是支持语言之一，保留；否则使用 und，不猜测默认语言。
- 没有已知游戏语言：保留格式有效的原始 html lang，否则使用 und。
- 英文简介回退不生成虚假的 og:locale。

## 元信息
- Title：实际实例标题 | WebRPG。不会擅自翻译或制造不存在的版本名。
- Description：优先选适用语言的真实介绍；在独立的 Meta Description 中加入该实例的「在线浏览器游玩」信息，按语言使用自然的短句模板，而不是修改 games.json 中的作品简介。没有对应语言简介时回退英文，不因 draft 或简介较短阻止索引。英文约 170 字符、简体中文约 110 字符、日文约 125 字符为软目标；较长简介优先截取完整句子或有意义的分句，找不到可靠边界就保留原始简介，不生硬截断、伪造玩法或堆砌关键词。Open Graph 与 JSON-LD 使用同一描述。
- Canonical：实例真实的游玩入口，保留大小写及类似 game.html 的深层入口；绝不统一 canonical 到作品介绍页。
- Open Graph：站点、标题、简介、规范地址和有效 HTTPS 封面；仅在语言匹配时输出对应 locale。
- JSON-LD：WebPage，包含真实的 inLanguage。已识别的 Game 引用 Astro 详情页的稳定 VideoGame 实体；没有可靠映射不做关联。单一实际运行页不伪造 hreflang。
- 不插入额外 H1、Header、Footer 或游戏说明正文；可见导航只存在于悬浮组件内，不改动游戏原生布局。

## 兼容和安全
- 原作者已有的 description、canonical、robots、Open Graph 不会被重复注入或无条件覆盖。
- 若作者设置的 Canonical 与当前入口冲突，保守跳过该页的 SEO 改写并报告原因。
- 通过 WebRPG SEO:START / WebRPG SEO:END 注释标记受管理的元信息；重复执行得到相同 HTML。
- 对 Title、Meta 内容执行 HTML 转义，对 JSON-LD 中的小于号执行转义。
- 如果 HTML 没有完整 head、标记损坏或入口 URL 不可信，直接跳过并记录状态。
- 保持原本 analytics 脚本处理流程。

## 测试与部署边界
运行：
- node --check scripts/game-page-seo.mjs
- node --check scripts/process-fork-repo.mjs
- node --test tests/*.test.mjs

## Game Shell 注入（与 SEO 共用一次入口写入）

- 只对 detection.entryPath 增强。其他 HTML 仍沿用 InsightFlare 注入，不复制 SEO 或菜单。
- Index 生成原生 details 悬浮球、真实的主页/详情链接，以及可选的虚拟按键 HTML；公共资源由 WebRPG-org/tookit 维护：
  - https://webrpg.org/tookit/shell.css
  - https://webrpg.org/tookit/shell.js
- CSS 在 Head 中同步加载，经典 JS 紧跟 Body 起始处的悬浮球结构运行。没有框架、不包装 Canvas、不插入 Header/Footer。
- 游戏详情导航依照实际 HTML 主语言，在 en、ja、zh-Hans 中选取；其他语言使用英文详情链接。无可信 Game 关联则只保留主页链接。
- 使用 WebRPG Shell Head / WebRPG Shell 两组独立标记，保证重复准备不重复插入，损坏标记保守跳过。
- JS/CSS 故障时 details 保留静态导航；虚拟按键、全屏和方向锁定属于 JS 增强。虚拟按键默认关闭。
- 输入映射面向 RPG Maker MV/MZ；特定游戏插件可能需要引擎专用适配器。方向锁定也受浏览器 API 限制。
- 此更改仅影响后续执行准备流程的游戏。此前已经准备的游戏仓库需要重新运行准备任务才会接入；未修改 games.json。
