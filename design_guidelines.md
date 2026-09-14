# design_guidelines.md

## 1. 品牌定位

个人单词默写工具「词格 WordSnap」：上传照片识别图中单词，生成中译英/英译中默写，答对赚积分。风格为"清晨书桌上的手写词卡"——暖纸底、墨绿主色、克制圆角、柔和阴影，松弛而专注。

## 2. 配色方案（Tailwind 类名）

语义色已映射到 `app.css` 的 CSS 变量，直接使用 Tailwind 语义类；强调色用 Tailwind 底色调色板。

- 页面背景：`bg-background`（暖纸 #f7f4ee）
- 主色/按钮：`bg-primary text-primary-foreground`（墨绿 #0f766e）
- 卡片底：`bg-card text-card-foreground`（白 #ffffff）
- 次级浅底：`bg-secondary text-secondary-foreground`（浅青绿）
- 弱化底/描边：`bg-muted text-muted-foreground`（暖灰）
- 加分/积分：`text-amber-400`、`bg-amber-50`
- 答对：`text-emerald-600`、`bg-emerald-50`；答错：`text-rose-500`、`bg-rose-50`
- 边框：`border-border`

## 3. 字体排版

- 中文标题：系统默认，`font-bold`，`text-xl`~`text-2xl`。
- 英文单词题干：使用衬线感 `font-[serif]`（字体族 fallback `serif`），`text-3xl`+ `font-bold`，突出"手写词卡"记忆点。
- 说明/注脚：`text-sm text-muted-foreground`。
- 垂直排列的 Taro 原生 `Text` 一律加 `block`。

## 4. 间距系统

- 页面边距：`px-5 py-6`，内容区 `max-w-xl mx-auto w-full`。
- 卡片间距：列表 `gap-3`，卡片内边距 `p-4`~`p-5`，圆角 `rounded-2xl`，阴影 `shadow-sm`。
- 区块间距：`mb-6`/`space-y-6`。

## 5. 组件使用原则（强制）

- 按钮、输入框、卡片、标签、评分、进度、骨架屏、弹窗、Toast 等通用 UI **一律从 `@/components/ui/*` 导入**，禁止用 `View/Text` 手搓。
- 本页复用清单：
  - `Button`（上传/识别/提交/再来一轮）
  - `Card`（上传区、识别词卡、默写题干卡、结果卡）
  - `Input`（默写答案输入）
  - `Badge`（识别数量、积分角标）
  - `ToggleGroup`（中译英 / 英译中模式切换）
  - `Progress`（默写进度条）
  - `Skeleton`（识别中 / 判题中加载态）
  - `Toast`/`Sonner`（反馈提示）
- 只有无需封装的 `View`/`Text`/`Image`/`ScrollView` 才直接用 `@tarojs/components`。

## 6. 导航结构

单页应用：全部功能集中在 `pages/index`，用 `step` 状态机切换：`upload`（上传/识别）→ `review`（词卡确认）→ `quiz`（默写答题）→ `result`（结果）。页面顶部常驻积分条。

## 7. 小程序约束

- 图片在识别后按需展示（H5 取本地预览，识别结果不持久化大图）。
- 网络请求统一 `Network.request/uploadFile`，URL 用相对 `/api/*`。
- 文本默写输入用 `Input`（外包 `View` 承载宽度样式）。