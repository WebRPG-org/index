# WebRPG 游戏运行页 SEO 注入规范

## 范围与数据来源
本功能仅增强经过验证的 RPG Maker 游戏入口 HTML；不修改 games.json、list.json、游戏脚本、Canvas、可见布局或任何生产仓库，也不包含 Toolkit 悬浮球的 CSS/JS。

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
- Description：优先选适用语言的真实介绍；没有中文、日文或英文对应简介时，优先使用英文；不因 draft 或简介较短阻止索引。
- Canonical：实例真实的游玩入口，保留大小写及类似 game.html 的深层入口；绝不统一 canonical 到作品介绍页。
- Open Graph：站点、标题、简介、规范地址和有效 HTTPS 封面；仅在语言匹配时输出对应 locale。
- JSON-LD：WebPage，包含真实的 inLanguage。已识别的 Game 引用 Astro 详情页的稳定 VideoGame 实体；没有可靠映射不做关联。单一实际运行页不伪造 hreflang。
- 不注入额外的 H1、导航、Header、Footer、HTML 正文或游戏 CSS。

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
- node --test tests