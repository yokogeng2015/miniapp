# design_guidelines.md

## 1. 品牌定位

个人单词默写工具「随拍默写 WordSnap」：上传照片识别图中单词，生成中译英/英译中默写，答对赚积分。苹果 iOS 原生风格——浅灰分组背景、白色扁平卡片、系统蓝主色、克制的圆角与简洁层次，清爽利落。

## 2. 配色方案（Tailwind 类名）

语义色已映射到 `app.css` 的 CSS 变量，直接使用 Tailwind 语义类；强调色用 Tailwind 底色调色板。

- 页面背景：`bg-background`（iOS 浅灰 #f2f2f7）
- 主色/按钮：`bg-primary text-primary-foreground`（系统蓝 #007aff）
- 卡片底：`bg-card text-card-foreground`（白 #ffffff）
- 次级浅底：`bg-secondary text-secondary-foreground`（浅蓝 #e8f1ff）
- 弱化底/描边：`bg-muted text-muted-foreground`（浅灰 #f2f2f7 / 灰字 #6c6c70）
- 积分：`text-amber-500`、`bg-amber-50`
- 答对：`text-emerald-500`、`bg-emerald-50`；答错：`text-rose-500`、`bg-rose-50`
- 边框：`border-border`（浅灰线）

## 3. 字体排版

- 中文标题：系统默认（iOS SF 风），`font-semibold`，`text-lg`~`text-2xl`。
- 英文单词题干：`font-semibold`，`text-3xl`+，突出题干。
- 说明/注脚：`text-sm text-muted-foreground`。
- 垂直排列的 Taro 原生 `Text` 一律加 `block`。

## 4. 间距系统

- 页面边距：`px-4 py-6`，内容区 `max-w-xl mx-auto w-full`。
- 卡片：列表 `gap-2`~`gap-3`，卡片内边距 `p-4`~`p-5`，圆角 `rounded-2xl`，无重投影（`shadow-none`/柔和 `shadow-sm`）。
- 区块间距：`mb-4`/`space-y-4`。

## 5. 组件使用原则（强制）

- 按钮、输入框、卡片、标签、评分、进度、骨架屏、弹窗、Toast 等通用 UI **一律从 `@/components/ui/*` 导入**，禁止用 `View/Text` 手搓。
- 本页复用清单：
  - `Button`（上传/识别/提交/再来一轮）
  - `Card`（上传区、识别词卡、默写题干卡、结果卡）
  - `Input`（默写答案输入）
  - `Badge`（识别数量、积分角标）
  - `Progress`（默写进度条）
  - `Toast`/`Sonner`（反馈提示）
- 只有无需封装的 `View`/`Text`/`Image`/`ScrollView` 才直接用 `@tarojs/components`。

## 6. 页面结构与导航

单页应用：全部功能集中在 `pages/index`，用 `step` 状态机切换：
`upload`（上传/识别）→ `review`（词卡确认）→ `quiz`（默写答题）→ `result`（结果）。
另一入口 `bank`（我的词单集合默写）。

- **顶部积分条**：左侧 Logo+标题，右侧积分角标，常驻。
- **「我的词单」入口只保留顶部一处**（upload/review 顶部按钮），不在上传卡片内重复放置。
- 词单跨端全局共享（不按设备隔离）。

## 7. 小程序约束

- 图片在识别后按需展示（H5 取本地预览，识别结果不持久化大图）。
- 网络请求统一 `Network.request/uploadFile`，URL 用相对 `/api/*`。
- 文本默写输入用 `Input`（外包 `View` 承载宽度样式）。