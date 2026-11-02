# mc-command-helper README
# 变更说明（相对初始版本）

对比基准：`mc-command-helper-豆包改-新.zip` 里的初始文件（dist `557275ce…`）

当前版本：dist `7c6c6cdd…`（2026-11-02 13:07）

---

## 一、文件级变化

| 文件 / 目录 | 变化 | 说明 |
|---|---|---|
| `src/extension.ts` | **修改** | 872 → 1372 行；46302 → 62968 字节；diff 约 +729 / -229 行 |
| `package.json` | **修改** | 新增 `contributes.keybindings` 4 条（上下键同步语法高亮） |
| `dist/extension.js` | **重新编译** | `557275ce…`（33432 字节）→ `7c6c6cdd…`（39292 字节） |
| `data/minecraft_items/` | **新增图片资源** | 1168 张物品图标（PNG/GIF），另有原有的 `minecraft_items.js`、`names.txt`、脚本共 5 个辅助文件 |
| `data/minecraft_effects/` | **新增** | 74 张 PNG（36 个效果图标 + 36 个 `particle_*` 粒子图 + 2 张额外图） |
| `data/minecraft_effects_anim/` | **新增** | 36 个动态 APNG（效果图标 + 粒子动画），约 3MB |
| `data/minecraft_mob/` | **新增** | 135 张实体图标（106 PNG + 29 GIF） |
| `src/syntax-check.ts` | 未改 | MD5 与初始版本相同 |
| `data/默认命令库.json` | 未改 | MD5 与初始版本相同 |
| `CHANGELOG.md` / `.vscodeignore` / `tsconfig.json` / `esbuild.js` / `eslint.config.mjs` | 未改 | — |

### 项目外（VS Code 环境）的变化

| 位置 | 变化 |
|---|---|
| `C:\Users\maidang\.vscode\mc-suggest-details.css` | **新增**：补全详情面板样式（自适应大小、最大 200×200；参数提示签名行支持换行） |
| `%APPDATA%\Code\User\settings.json` | **修改**：`vscode_custom_css.imports` 增加上面的 CSS，并清理两条失效的旧路径 |
| VS Code 安装目录 `workbench.html` | **修改**：Custom CSS 内联；另有一段 `AUTO-DETAILS-PANEL` 自适应规则 |
| 已安装扩展 `~/.vscode/extensions/maidang2233.mc-command-helper-0.0.1/` | **已同步**：`dist/extension.js`、`package.json`（含 keybindings）、`data/minecraft_items` / `effects` / `effects_anim` / `mob` |

---

## 二、补全详情面板（C）

### 1. 物品图标

- 参数 `suggestion: "item"` 的物品候选，在详情面板显示 `data/minecraft_items/<物品ID>.png|.gif`
- 支持 GIF（如 `sculk_sensor.gif`），同一 ID 有 PNG/GIF 时优先 PNG
- 兼容基岩版与图片文件名的差异，内置别名：
  - `grass_block` → `grass`
  - `hardened_clay` → `terracotta`
  - `magma` → `magma_block`
  - `end_bricks` → `end_stone_bricks`
  - `lit_pumpkin` → `pumpkin`
  - `*_chest_boat` → `*_boat_with_chest`
  - `*_chest_raft` → `*_raft_with_chest`
- 带 `minecraft:` 前缀的 ID 会自动去掉前缀再找图

### 2. 状态效果图标（静态 + 动态）

- 参数 `suggestion: "effect"` 的效果候选，优先显示**动态 APNG**：`data/minecraft_effects_anim/<效果ID>.png`
  - 效果图标 + 12 个粒子围绕图标底部/两侧上飘
  - 4 秒循环、12fps、透明背景、120px 显示宽度
- 没有动态文件时回退到静态 `data/minecraft_effects/<效果ID>.png`
- 36 个效果全部覆盖

### 3. 实体图标

- 参数 `suggestion: "entity"` 的实体候选（如 `summon`），显示 `data/minecraft_mob/<实体ID>.png|.gif`
- 252 个候选（126 个实体 × 带/不带 `minecraft:` 两种写法）全部有图标
- 带 `minecraft:` 前缀的 ID 同样自动去掉前缀

### 4. 无内容自动关闭

- 所有补全项不再设置 `item.detail`
- 只有存在 `documentation`（图片或“后续语法”）时，详情面板才会展开
- 无图标的物品、`@s` 等选择器、命令名等候选聚焦时，详情面板自动收起
- 列表行右侧的中文说明保持不变（来自 `CompletionItemLabel.description`）

### 5. 自适应大小

- 详情面板从固定 200×200 改为**按内容自适应**，最大 200×200
- 物品约 100~130px 宽；效果约 140px 宽；内容超出时最多 200×200

---

## 三、参数提示（Signature Help）

### 1. 完整语法链

- 签名行直接显示完整语法，支持 `execute ... run ...` 的嵌套命令
- 例：
  - `/execute as @e at @s run give @s comm`
    → `/execute as <目标> at <目标> run give <玩家> <物品名称> <数量> <数据值> <数据标签>`
- 用字符偏移 `[start, end]` 精确高亮当前参数，重复的 `<目标>` 不会高亮错

### 2. 命令名阶段的堆叠语法

- 输入 `/g` 时显示当前筛选出的命令语法，一行一个：
  ```
  /gamemode <游戏模式> <玩家>
  /gamerule <规则> <布尔值>
  /gametest create <测试名称> <X轴大小> <Y轴大小> <Z轴大小>
  /give <玩家> <物品名称> <数量> <数据值> <数据标签>
  /script debugger connect <主机> <端口>
  ```
- 筛选规则模拟 VS Code 的 `editor.suggest.matchOnWordStartOnly`（单词开头匹配），与补全列表一致
- 每个命令选参数最多的 pattern 作为代表
- 补全项设置 `sortText` + `preselect`，保证补全列表和语法行**顺序一致、一一对应**

### 3. execute 子命令的堆叠语法

- 输入 `/execute `（空格）时显示 11 个子命令语法：
  ```
  /execute if block ~ ~ ~ <方块ID> <方块状态> 子命令
  /execute unless block ~ ~ ~ <方块ID> <方块状态> 子命令
  /execute align <坐标轴> 子命令
  /execute anchored <基准点> 子命令
  /execute as <目标> 子命令
  /execute at <目标> 子命令
  /execute facing ~ ~ ~ 子命令
  /execute in <维度> 子命令
  /execute positioned ~ ~ ~ 子命令
  /execute rotated <水平旋转值> <垂直旋转值> 子命令
  /execute run <命令>
  ```
- 输入 `/execute a` 会缩小到 align / anchored / as / at
- 补全列表与语法行顺序一致

### 4. 上下键同步高亮

- 新增命令：
  - `mc-command-helper.nextSuggestion`
  - `mc-command-helper.prevSuggestion`
- `package.json` 新增 keybindings：
  - `down` / `ctrl+down` → 下一个
  - `up` / `ctrl+up` → 上一个
  - 仅在 `suggestWidgetVisible && textInputFocus &&` 三种目标语言时生效
- 补全列表焦点变化时同步刷新参数提示；**回到之前选过的项也能正确高亮**（不再只对第一次有效）
- 只有输入内容变化时才重置下标，避免 VS Code 多次调用补全 provider 时跳回第一行

---

## 四、移除 / 回退

| 内容 | 说明 |
|---|---|
| `registerDocumentSymbolProvider`（面包屑/大纲/粘性滚动） | 已移除；原来塞进面包屑的 `语法: …` 不再出现，语法改由参数提示弹窗显示 |
| `item.detail` 赋值 | 全部移除；详情面板改为“有文档才显示” |
| 选择器 `@a/@s` 的详情面板标题 | 不再显示；列表行右侧说明仍在 |

---

## 五、资源统计

| 目录 | 文件数 | 约占用 |
|---|---|---|
| `data/minecraft_items` | 1168 张图片（+5 个辅助文件） | 17MB |
| `data/minecraft_effects` | 74 张 PNG | 1MB |
| `data/minecraft_effects_anim` | 36 个 APNG | 3MB |
| `data/minecraft_mob` | 135 张 PNG/GIF | 29MB |

打包 VSIX 时这些资源会一起带进去，体积会明显增大。

---

## 六、使用说明

- 改完代码后需要重新编译并同步：
  ```
  node esbuild.js --production
  ```
- VS Code 里需要 **Reload Window** 才会加载新的扩展代码 / keybindings
- 修改 `mc-suggest-details.css` 后需要执行 **Reload Custom CSS and JS**
- VS Code 每次更新后需要重新启用 Custom CSS
- keybindings 只在 `bc-mcfunction` / `mcfunction` / `plaintext` 三种语言的补全弹窗中生效

---

## 七、已知限制

1. PageUp / PageDown / Home / End 等其它预选导航方式不会同步语法高亮（目前只覆盖 ↑ / ↓ / Ctrl+↑ / Ctrl+↓）
2. `/e` 这类命令名阶段，`execute` 仍只占一行（一个候选对应一行），不会展开成 11 行
3. `/execute as @e ` 这种“已经选了一个子命令、继续选下一个子命令”的阶段，目前还显示单行 `/execute as <目标> 子命令`
4. 动态效果是预渲染 APNG，不是网页里的实时 CSS 粒子；VS Code 详情面板不支持注入 CSS 动画
5. 若其它扩展（如 Blockception）也向补全列表添加命令，本插件的“一一对应”只保证自己提供的条目
