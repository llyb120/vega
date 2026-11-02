# Vega UI 重新设计方案

**版本**: 1.0  
**日期**: 2026-11-02  
**状态**: 设计方案

---

## 目录

1. [执行摘要](#执行摘要)
2. [用户与核心任务分析](#用户与核心任务分析)
3. [当前 UI 问题分析](#当前-ui-问题分析)
4. [信息架构与导航重设计](#信息架构与导航重设计)
5. [布局系统与响应式断点](#布局系统与响应式断点)
6. [设计标记系统 (Design Tokens)](#设计标记系统-design-tokens)
7. [组件清单与规范](#组件清单与规范)
8. [关键交互流程](#关键交互流程)
9. [边缘情况处理](#边缘情况处理)
10. [实施计划](#实施计划)
11. [权衡与未决问题](#权衡与未决问题)

---

## 执行摘要

Vega 是一个基于 Vue 3.6 Vapor 的数字员工工作台应用，支持对话式交互、任务管理、浏览器控制等复杂功能。本次 UI 重新设计旨在：

- **提升视觉现代化**：采用当代设计语言，简洁清晰
- **优化空间利用**：提高信息密度，减少无效留白，同时保持易读性
- **改善移动体验**：全面响应式设计，确保 375px 到 1440px+ 的流畅体验
- **保持功能完整**：所有现有功能完全保留，不改变后端行为

**关键原则**：
- 用户优先：基于真实使用场景的设计
- 系统化：建立一致的设计系统，便于维护和扩展
- 渐进式：支持优雅降级，确保兼容性
- 数据驱动：通过实际测试验证设计决策

---

## 用户与核心任务分析

### 1. 用户角色

#### 1.1 管理员 (admin)
**职责**：
- 系统配置（服务商、模型、场景）
- 用户账号管理
- 数字员工创建与管理（团队员工）
- 技能与 MCP 服务器配置
- 密码本管理
- 查看所有会话和调试信息

**核心任务**：
1. 配置 AI 模型接入（OpenAI、Claude、Devin 等）
2. 创建和分配团队数字员工
3. 管理用户权限
4. 监控系统运行状态
5. 处理异常情况

**使用频率**：
- 日常：查看员工任务状态、处理异常
- 周期性：配置更新、用户管理
- 偶尔：系统设置调整

#### 1.2 操作用户 (operator)
**职责**：
- 创建和使用对话
- 向数字员工交代任务
- 创建个人数字员工
- 查看和管理自己的任务
- 审批员工的任务请求
- 补充员工所需信息

**核心任务**：
1. 与 AI 对话解决问题
2. 委派任务给数字员工
3. 跟进任务进度
4. 审批/驳回员工的执行请求
5. 查看任务结果

**使用频率**：
- 高频：员工对话、任务查看
- 中频：任务审批、信息补充
- 低频：员工创建、设置调整

#### 1.3 只读用户 (viewer)
**职责**：
- 查看被授权的会话
- 查看团队员工的任务
- 查看经验图谱（如有权限）

**核心任务**：
1. 浏览他人分享的会话
2. 查看团队员工工作进度
3. 学习和参考他人的工作方式

**使用频率**：
- 以查看为主，无执行权限

### 2. 核心使用场景

#### 场景 A：快速对话咨询
**流程**：
1. 打开应用 → 看到最近会话或欢迎页
2. 输入问题（可能带图片）
3. 等待 AI 回复（可能包含工具调用）
4. 继续追问或开始新话题
5. 切换模型场景（如需要）

**关键点**：
- 输入框要易找、易用
- 等待状态要清晰
- 工具执行过程要可见但不打扰
- 支持中断和继续

#### 场景 B：委派任务给员工
**流程**：
1. 选择或创建员工
2. 描述任务目标
3. 员工反馈理解或询问细节
4. 确认后员工开始工作
5. 收到进度更新通知
6. （可能）审批关键操作
7. （可能）补充额外信息
8. 验收结果

**关键点**：
- 员工状态要醒目（空闲/忙碌/需注意）
- 任务卡片要展示关键信息
- 审批流程要清晰快速
- 进度更新要及时可见

#### 场景 C：浏览器远程控制
**流程**：
1. 查看浏览器标签列表
2. 选择一个标签刷新截图
3. 进入实时模式（查看或操作）
4. 点击、输入、滚动等操作
5. 切换标签或退出

**关键点**：
- 实时画面要流畅
- 操作反馈要及时
- 移动端触控要友好
- 缩放和拖动要自然

#### 场景 D：管理员系统配置
**流程**：
1. 进入设置页面
2. 配置服务商和模型
3. 设置场景模型优先级
4. 上传技能包
5. 管理 MCP 服务器
6. 配置密码本

**关键点**：
- 表单要清晰分组
- 复杂配置要有提示
- 敏感信息要保护
- 操作要有确认

### 3. 用户痛点

通过代码分析识别的潜在痛点：

**信息过载**：
- 侧边栏既有导航又有会话列表又有员工列表
- 员工页面信息密集（对话+任务+职责+记忆+浏览器）
- 缺少信息层次和优先级

**导航混乱**：
- 从员工切换到对话需要多次点击
- 没有清晰的"回到主页"概念
- 面包屑不足

**移动端欠缺**：
- 虽然有响应式代码，但主要针对桌面设计
- 触摸目标不够大
- 抽屉导航打开后难以快速访问内容

**状态不清**：
- 员工的忙碌/空闲状态不够突出
- 任务的待处理项容易被忽略
- 实时连接状态不够明显

---

## 当前 UI 问题分析

### 1. 视觉设计问题

#### 1.1 色彩系统
**问题**：
- 过度使用蓝色调（oklch 255 度主导）
- 灰度层次不足（仅 3-4 个灰阶）
- 缺少语义化色彩（成功、警告、错误不一致）
- Accent 颜色对比度在某些背景上不足

**影响**：
- 视觉单调
- 难以快速区分状态
- 无障碍问题

#### 1.2 排版系统
**问题**：
- 字体大小跳跃不规则（14px → 19px → 34px）
- 行高不一致（有的 1.4，有的 1.8）
- 字重使用混乱（450、500、550、600、650、700）
- 缺少明确的标题层次

**影响**：
- 视觉层次不清
- 阅读体验不连贯
- 难以建立视觉节奏

#### 1.3 间距系统
**问题**：
- 间距值随意（8px、10px、12px、14px、16px、18px、20px、22px...）
- 没有统一的间距比例
- 组件内外边距不一致

**影响**：
- 布局不整齐
- 视觉不和谐
- 难以维护

#### 1.4 圆角与阴影
**问题**：
- 圆角值杂乱（6px、8px、9px、10px、11px、12px、13px...）
- 阴影使用不一致
- 过多的 box-shadow 叠加

**影响**：
- 缺少现代感
- 视觉重量不均
- 性能影响

### 2. 布局问题

#### 2.1 侧边栏
**问题**：
- 248px 宽度对于 1024px 屏幕太宽（占 24%）
- 员工列表和会话列表混在一起
- 滚动区域划分不清
- 小屏幕下完全不可见

**建议**：
- 增加到 280px（内容更舒适）
- 明确分区
- 改进滚动行为

#### 2.2 主内容区
**问题**：
- 最大宽度限制不一致（有的 1040px，有的 1180px）
- 大屏幕留白过多
- 对话区域没有充分利用空间

**建议**：
- 统一最大宽度为 1400px
- 根据内容类型调整留白
- 允许宽屏用户看到更多信息

#### 2.3 员工工作区
**问题**：
- 对话和任务在不同标签页，切换频繁
- 工作摘要侧边栏在中等屏幕就隐藏了
- 移动端布局拥挤

**建议**：
- 优化标签页布局
- 改进信息展示优先级
- 移动端使用卡片式布局

### 3. 交互问题

#### 3.1 反馈不足
**问题**：
- 按钮 hover 状态不明显
- loading 状态缺少骨架屏
- 操作成功/失败提示不够突出

**建议**：
- 加强 hover/focus 状态
- 添加过渡动画
- 改进提示信息设计

#### 3.2 操作效率
**问题**：
- 常用操作埋得太深
- 批量操作支持不足
- 快捷键缺失

**建议**：
- 提升关键操作可达性
- 考虑批量操作场景
- 添加键盘快捷键提示

#### 3.3 错误处理
**问题**：
- 错误信息不够友好
- 缺少操作回退机制
- 敏感操作确认不足

**建议**：
- 改进错误文案
- 添加撤销功能（where applicable）
- 关键操作二次确认

### 4. 响应式问题

#### 4.1 断点设计
**当前断点**：
- 760px：主要移动端断点
- 980px：中等屏幕调整
- 1024px：特定组件断点

**问题**：
- 断点之间跨度太大
- 768px 平板体验不佳
- 1024-1440px 区间缺少优化

**建议**：
- 添加 640px 小手机断点
- 优化 768-1024px 平板体验
- 考虑超宽屏（>1920px）

#### 4.2 移动端问题
**问题**：
- 44px 触摸目标不是所有地方都遵守
- 抽屉导航层级关系混乱
- 软键盘弹出时布局问题
- 横屏体验差

**建议**：
- 严格执行 44px 最小触摸目标
- 优化导航层级
- 处理视口变化
- 添加横屏优化

---

## 信息架构与导航重设计

### 1. 新的信息架构

#### 1.1 三层架构

```
应用层
├── 工作台 (核心工作区)
│   ├── 员工空间 (默认主页)
│   │   ├── 员工列表（侧边栏）
│   │   ├── 当前员工工作区
│   │   │   ├── 对话区
│   │   │   ├── 任务中心
│   │   │   ├── 浏览器控制
│   │   │   ├── 职责管理
│   │   │   └── 记忆管理
│   │   └── 工作摘要（侧栏/可折叠）
│   │
│   ├── 快速对话 (轻量级对话)
│   │   ├── 会话列表（侧边栏）
│   │   ├── 对话区
│   │   └── 输入区
│   │
│   └── 浏览器工具 (独立浏览器)
│       ├── 标签页列表
│       ├── 实时画面
│       └── 控制面板
│
├── 管理层
│   ├── 账号与权限
│   ├── 经验图谱
│   └── 调试会话
│
└── 设置层
    ├── 服务商配置
    ├── 场景设置
    ├── 技能管理
    └── MCP 配置
```

#### 1.2 导航优化

**全局导航（侧边栏顶部）**：
```
[Logo] Vega 工作台
├── 👥 员工空间 (默认主页)
├── 💬 快速对话
├── 🌐 浏览器工具
├── 📊 经验图谱 (仅管理员)
├── 🔧 调试会话 (仅管理员)
├── 👤 账号设置
└── ⚙️ 系统设置 (仅管理员)
```

**上下文导航（根据当前页面）**：
- 员工空间：员工列表 + 切换器
- 快速对话：会话列表 + 新建按钮
- 其他：相关快捷操作

**面包屑导航**：
```
工作台 > 员工空间 > 研发助手 > 任务中心
工作台 > 快速对话 > 分析项目结构
工作台 > 设置 > 服务商配置
```

#### 1.3 导航层级决策

**为什么把员工空间设为默认主页？**
1. 员工是 Vega 的核心差异化功能
2. 操作用户最常用功能
3. 集成度高：任务、对话、浏览器都在这里
4. 减少点击：直接看到工作状态

**为什么分离快速对话？**
1. 用户心智模型：对话和委派任务是不同的
2. 减少认知负担：员工页面已经很复杂
3. 性能考虑：独立加载更快
4. 灵活性：可以快速试验想法

**为什么浏览器工具独立？**
1. 功能独立性强
2. 可以独立于员工使用
3. 全屏体验更好
4. 避免员工页面过于臃肿

### 2. 导航交互优化

#### 2.1 快速切换
**问题**：当前需要 3-4 次点击才能从一个员工切换到对话

**方案**：
- 全局快捷键：`Ctrl+K` 打开命令面板
- 员工切换器：顶部快速下拉
- 最近访问：记住最近 5 个位置
- 快速返回：明确的"返回"按钮

#### 2.2 移动端导航
**改进**：
- 底部标签栏（5 个核心功能）
  - 👥 员工
  - 💬 对话
  - 🌐 浏览器
  - 👤 账号
  - ⚙️ 更多
- 侧滑打开详细列表
- 浮动操作按钮（FAB）：快速创建

#### 2.3 状态保持
**需求**：
- 记住每个员工的当前标签页
- 保存对话输入草稿
- 恢复滚动位置
- 保持过滤器和排序

---

## 布局系统与响应式断点

### 1. 响应式断点

```css
/* 5-level responsive system */
--breakpoint-xs: 0px;      /* 超小屏 (< 640px) - 小手机竖屏 */
--breakpoint-sm: 640px;    /* 小屏 (640-768px) - 大手机竖屏 */
--breakpoint-md: 768px;    /* 中屏 (768-1024px) - 平板/小笔记本 */
--breakpoint-lg: 1024px;   /* 大屏 (1024-1440px) - 笔记本/台式 */
--breakpoint-xl: 1440px;   /* 超大屏 (> 1440px) - 大台式/超宽 */
```

### 2. 布局网格

#### 2.1 桌面布局 (≥1024px)
```
┌─────────────────────────────────────────┐
│  Topbar (64px)                          │
├─────────┬───────────────────────────────┤
│ Sidebar │ Main Content Area             │
│ (280px) │ (max-width: 1400px, centered)│
│         │                               │
│ Nav     │ ┌──────────────────────────┐ │
│ + List  │ │ Content                  │ │
│         │ │ (responsive columns)     │ │
│         │ └──────────────────────────┘ │
│         │                               │
│         │ [Bottom: Composer/Footer]     │
└─────────┴───────────────────────────────┘
```

#### 2.2 平板布局 (768-1024px)
```
┌─────────────────────────────────────────┐
│  Topbar (56px)                          │
├─────────┬───────────────────────────────┤
│ Sidebar │ Main Content (full width)     │
│ (260px) │                               │
│ (可折叠) │ ┌──────────────────────────┐ │
│         │ │ Content (1-2 columns)    │ │
│         │ └──────────────────────────┘ │
└─────────┴───────────────────────────────┘
```

#### 2.3 移动布局 (< 768px)
```
┌─────────────────────────────┐
│  Mobile Header (56px)       │
│  [☰] Title [Action]         │
├─────────────────────────────┤
│                             │
│  Main Content (full width)  │
│  (single column)            │
│                             │
│  ┌───────────────────────┐ │
│  │ Content Cards         │ │
│  │ (stacked)             │ │
│  └───────────────────────┘ │
│                             │
├─────────────────────────────┤
│  [Bottom Nav / Composer]    │
└─────────────────────────────┘

[Drawer Nav (slide from left)]
```

### 3. 组件响应式策略

#### 3.1 员工工作区
**桌面 (≥1024px)**：
```
┌────────────────────────────────────────┐
│ Header: 员工信息 + 状态 + 操作          │
├────────────────────────────────────────┤
│ Tabs: [对话] [任务] [浏览器] ...       │
├──────────────────────┬─────────────────┤
│ Main Content         │ Sidebar (320px) │
│ (对话/任务列表)       │ 工作摘要        │
│                      │ - 待处理项      │
│ ┌──────────────────┐│ - 进行中任务   │
│ │ Chat/Task Cards  ││ - 快速操作     │
│ └──────────────────┘│                │
│                      │                 │
├──────────────────────┴─────────────────┤
│ Composer (for chat tab)                │
└────────────────────────────────────────┘
```

**平板 (768-1024px)**：
- 隐藏工作摘要侧边栏
- 增加任务过滤器显著性
- 优化标签页间距

**移动 (<768px)**：
- 标签页横向滚动
- 单列卡片布局
- 对话输入固定在底部
- 添加快速切换按钮

#### 3.2 对话界面
**桌面**：
```
Max-width: 840px (对话内容)
Max-width: 1200px (包含侧边信息)
居中显示，两侧留白
```

**平板**：
```
Max-width: 100% - 48px padding
减少留白，增加内容区
```

**移动**：
```
Full width - 24px padding
用户消息最大宽度 90%
助手消息全宽
```

#### 3.3 浏览器控制
**桌面**：
- 标签页横向列表，可滚动
- 截图居中，最大宽度 1568px
- 控制面板固定在顶部

**移动**：
- 标签页卡片式横滚
- 截图全宽，可缩放
- 控制面板折叠设计
- 优化触控操作区域

### 4. 关键尺寸规范

```css
/* Sidebar */
--sidebar-width-desktop: 280px;
--sidebar-width-tablet: 260px;
--sidebar-width-mobile: 85vw (max 340px);

/* Topbar */
--topbar-height-desktop: 64px;
--topbar-height-tablet: 56px;
--topbar-height-mobile: 56px + safe-area-inset-top;

/* Content max-width */
--content-max-width: 1400px;
--chat-max-width: 840px;
--form-max-width: 720px;

/* Touch targets */
--touch-target-min: 44px;
--interactive-min-height: 40px (desktop);

/* Spacing */
--page-padding-desktop: 32px;
--page-padding-tablet: 24px;
--page-padding-mobile: 16px;
```

---

## 设计标记系统 (Design Tokens)

### 1. 色彩系统

#### 1.1 中性色 (Neutral Scale)
```css
/* Grayscale - 基于 tailwind 的现代灰度 */
--gray-50: #fafafa;    /* 最浅背景 */
--gray-100: #f5f5f5;   /* 浅背景 */
--gray-200: #e5e5e5;   /* 边框浅 */
--gray-300: #d4d4d4;   /* 边框标准 */
--gray-400: #a3a3a3;   /* 边框深/占位符 */
--gray-500: #737373;   /* 三级文本 */
--gray-600: #525252;   /* 二级文本 */
--gray-700: #404040;   /* 深文本 */
--gray-800: #262626;   /* 主要文本（深色模式背景） */
--gray-900: #171717;   /* 最深文本 */
```

**使用场景**：
- 50-200: 背景层次
- 200-400: 边框和分隔线
- 400-600: 占位符和次要文本
- 600-900: 主要文本和强调

#### 1.2 主题色 (Primary)
```css
/* Blue - 保持蓝色主题，但使用更现代的色调 */
--primary-50: #eff6ff;
--primary-100: #dbeafe;
--primary-200: #bfdbfe;
--primary-300: #93c5fd;
--primary-400: #60a5fa;
--primary-500: #3b82f6;  /* 主色 */
--primary-600: #2563eb;  /* 主色深 */
--primary-700: #1d4ed8;
--primary-800: #1e40af;
--primary-900: #1e3a8a;
```

**使用场景**：
- 500-600: 主要按钮、链接、高亮
- 100-200: hover 背景、轻微强调
- 700-900: active 状态、深色变体

#### 1.3 语义色 (Semantic Colors)
```css
/* Success - 绿色 */
--success-50: #f0fdf4;
--success-100: #dcfce7;
--success-500: #22c55e;
--success-600: #16a34a;
--success-700: #15803d;

/* Warning - 橙/琥珀色 */
--warning-50: #fffbeb;
--warning-100: #fef3c7;
--warning-500: #f59e0b;
--warning-600: #d97706;
--warning-700: #b45309;

/* Error - 红色 */
--error-50: #fef2f2;
--error-100: #fee2e2;
--error-500: #ef4444;
--error-600: #dc2626;
--error-700: #b91c1c;

/* Info - 浅蓝 */
--info-50: #f0f9ff;
--info-100: #e0f2fe;
--info-500: #0ea5e9;
--info-600: #0284c7;
```

**对比度验证**：
- 所有文本色与背景对比度 ≥ 4.5:1 (AA standard)
- 大文本（18px+）对比度 ≥ 3:1
- 交互元素明显可区分

#### 1.4 语义化映射
```css
/* 文本颜色 */
--text-primary: var(--gray-900);      /* 主要文本 */
--text-secondary: var(--gray-600);    /* 次要文本 */
--text-tertiary: var(--gray-500);     /* 三级文本/提示 */
--text-disabled: var(--gray-400);     /* 禁用文本 */
--text-inverse: white;                /* 反色文本（深色背景上） */

/* 背景颜色 */
--bg-primary: white;                  /* 主背景 */
--bg-secondary: var(--gray-50);       /* 次要背景/页面 */
--bg-tertiary: var(--gray-100);       /* 三级背景/hover */
--bg-elevated: white;                 /* 卡片/弹出层 */
--bg-sunken: var(--gray-50);         /* 凹陷区域/输入框禁用 */

/* 边框颜色 */
--border-light: var(--gray-200);      /* 轻边框 */
--border-medium: var(--gray-300);     /* 标准边框 */
--border-strong: var(--gray-400);     /* 强边框 */

/* 交互色 */
--accent: var(--primary-600);
--accent-hover: var(--primary-700);
--accent-light: var(--primary-50);
--accent-medium: var(--primary-100);
```

### 2. 排版系统 (Typography Scale)

#### 2.1 字体家族
```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
             system-ui, sans-serif;

--font-mono: 'SF Mono', 'Cascadia Code', 'Consolas', 
             'Liberation Mono', monospace;
```

**为什么选择 Inter？**
- 开源免费，支持可变字体
- 针对屏幕显示优化
- 支持中文回退
- 数字等宽（好的数据展示）
- 广泛使用，经过验证

#### 2.2 字号比例 (Type Scale)
```css
/* 基于 1.25 比例 + 手动调整 */
--text-xs: 0.75rem;      /* 12px - 标签、辅助信息 */
--text-sm: 0.875rem;     /* 14px - 次要文本、表单 */
--text-base: 1rem;       /* 16px - 移动端基准 */
--text-md: 0.9375rem;    /* 15px - 桌面基准 */
--text-lg: 1.125rem;     /* 18px - 强调文本 */
--text-xl: 1.25rem;      /* 20px - 小标题 */
--text-2xl: 1.5rem;      /* 24px - 中标题 */
--text-3xl: 2rem;        /* 32px - 大标题 */
--text-4xl: 2.5rem;      /* 40px - 特大标题 */
```

**使用规则**：
- 桌面端：基准 15px (0.9375rem)
- 移动端：基准 16px (1rem) - 防止 iOS 自动缩放
- 表单输入：永远 ≥16px
- 最小可读：12px（仅用于标签）

#### 2.3 字重 (Font Weights)
```css
--font-normal: 400;     /* 常规文本 */
--font-medium: 500;     /* 按钮、中等强调 */
--font-semibold: 600;   /* 标题、强调 */
--font-bold: 700;       /* 特别强调、数字 */
```

**使用规则**：
- 正文：400
- 按钮/导航：500
- 标题：600
- Logo/强调数字：700

#### 2.4 行高 (Line Height)
```css
--leading-none: 1;        /* 1.0 - logo、数字 */
--leading-tight: 1.25;    /* 1.25 - 大标题 */
--leading-snug: 1.375;    /* 1.375 - 小标题 */
--leading-normal: 1.5;    /* 1.5 - 正文（默认） */
--leading-relaxed: 1.625; /* 1.625 - 段落 */
--leading-loose: 2;       /* 2.0 - 特殊用途 */
```

**使用规则**：
- 标题：1.25-1.375
- 按钮/标签：1.5
- 正文/段落：1.6-1.75
- 输入框：1.5

#### 2.5 字距 (Letter Spacing)
```css
--tracking-tighter: -0.05em;  /* -0.05em - 大号标题 */
--tracking-tight: -0.025em;   /* -0.025em - 中号标题 */
--tracking-normal: 0;         /* 0 - 正文 */
--tracking-wide: 0.025em;     /* 0.025em - 小标签 */
--tracking-wider: 0.05em;     /* 0.05em - 大写字母 */
--tracking-widest: 0.1em;     /* 0.1em - 特殊强调 */
```

### 3. 间距系统 (Spacing Scale)

```css
/* 基于 4px 基准单位 */
--space-0: 0;
--space-1: 0.25rem;   /* 4px */
--space-2: 0.5rem;    /* 8px */
--space-3: 0.75rem;   /* 12px */
--space-4: 1rem;      /* 16px - 基准 */
--space-5: 1.25rem;   /* 20px */
--space-6: 1.5rem;    /* 24px */
--space-7: 1.75rem;   /* 28px */
--space-8: 2rem;      /* 32px */
--space-10: 2.5rem;   /* 40px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
--space-20: 5rem;     /* 80px */
--space-24: 6rem;     /* 96px */
```

**使用规则**：
- 1-3: 小间距（图标、行内元素）
- 4-6: 标准间距（组件内、表单）
- 8-12: 大间距（组件间、区块）
- 16+: 特大间距（页面区块）

### 4. 圆角系统 (Border Radius)

```css
--radius-none: 0;
--radius-sm: 0.375rem;   /* 6px - 小元素 */
--radius-md: 0.5rem;     /* 8px - 标准按钮/输入 */
--radius-lg: 0.75rem;    /* 12px - 卡片 */
--radius-xl: 1rem;       /* 16px - 大卡片 */
--radius-2xl: 1.5rem;    /* 24px - 模态框 */
--radius-full: 9999px;   /* 完全圆角 - pill/avatar */
```

**使用规则**：
- 按钮/输入：md (8px)
- 卡片：lg (12px)
- 对话框：xl (16px)
- Pill/Badge：full
- 头像：xl 或 full

### 5. 阴影系统 (Shadows)

```css
/* 微妙、分层的阴影 */
--shadow-xs: 0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.1), 
             0 1px 2px -1px rgb(0 0 0 / 0.1);
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 
             0 2px 4px -2px rgb(0 0 0 / 0.1);
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 
             0 4px 6px -4px rgb(0 0 0 / 0.1);
--shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 
             0 8px 10px -6px rgb(0 0 0 / 0.1);
--shadow-2xl: 0 25px 50px -12px rgb(0 0 0 / 0.25);
--shadow-inner: inset 0 2px 4px 0 rgb(0 0 0 / 0.05);
```

**使用规则**：
- xs/sm: 边框替代，轻微层次
- md: 卡片默认
- lg: hover 状态、下拉菜单
- xl: 模态框、侧边栏
- 2xl: 特殊强调（登录页等）

### 6. Z-index 层级

```css
--z-base: 0;
--z-dropdown: 10;
--z-sticky: 20;
--z-fixed: 30;
--z-modal-backdrop: 40;
--z-modal: 50;
--z-popover: 60;
--z-tooltip: 70;
```

### 7. 动画系统

#### 7.1 过渡时长
```css
--duration-fast: 150ms;
--duration-base: 200ms;
--duration-slow: 300ms;
--duration-slower: 500ms;
```

#### 7.2 缓动函数
```css
--ease-in: cubic-bezier(0.4, 0, 1, 1);
--ease-out: cubic-bezier(0, 0, 0.2, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
```

**使用规则**：
- 进入：ease-out
- 退出：ease-in
- 双向：ease-in-out
- 特殊：bounce（成功提示等）

---

## 组件清单与规范

### 1. 基础组件

#### 1.1 按钮 (Button)

**变体**：
```css
/* Primary - 主要操作 */
.btn-primary {
  background: var(--accent);
  color: var(--text-inverse);
  border: 1px solid transparent;
}

/* Secondary - 次要操作 */
.btn-secondary {
  background: var(--bg-primary);
  color: var(--text-secondary);
  border: 1px solid var(--border-medium);
}

/* Ghost - 轻量操作 */
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
}

/* Link - 链接式 */
.btn-link {
  background: transparent;
  color: var(--accent);
  border: none;
  text-decoration: underline;
}

/* Danger - 危险操作 */
.btn-danger {
  background: var(--error-500);
  color: white;
  border: 1px solid transparent;
}
```

**尺寸**：
```css
/* Small */
.btn-sm {
  height: 36px;
  padding: 0 12px;
  font-size: 0.875rem;
}

/* Medium (default) */
.btn-md {
  height: 40px;
  padding: 0 16px;
  font-size: 0.9375rem;
}

/* Large */
.btn-lg {
  height: 48px;
  padding: 0 24px;
  font-size: 1rem;
}

/* Mobile touch target */
@media (max-width: 768px) {
  .btn {
    min-height: 44px;
  }
}
```

**状态**：
```css
/* Hover */
.btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

/* Active */
.btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* Focus */
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Disabled */
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Loading */
.btn.loading {
  position: relative;
  color: transparent;
}
.btn.loading::after {
  content: '';
  /* spinner animation */
}
```

**图标支持**：
```html
<button class="btn btn-primary">
  <svg>...</svg>
  <span>按钮文字</span>
</button>
```

#### 1.2 输入框 (Input/Textarea/Select)

**基础样式**：
```css
input, textarea, select {
  padding: 12px 16px;
  font-size: 0.9375rem;  /* 15px 桌面 */
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  transition: all 0.2s ease;
}

/* Mobile - 防止自动缩放 */
@media (max-width: 768px) {
  input, textarea, select {
    font-size: 16px !important;
  }
}

/* Hover */
input:hover, textarea:hover, select:hover {
  border-color: var(--border-strong);
}

/* Focus */
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-light);
}

/* Error */
input.error, textarea.error {
  border-color: var(--error-500);
}

/* Disabled */
input:disabled, textarea:disabled, select:disabled {
  background: var(--bg-sunken);
  cursor: not-allowed;
  opacity: 0.6;
}
```

**标签与提示**：
```css
label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.hint, .error-message {
  display: block;
  font-size: 0.875rem;
  margin-top: 6px;
}

.hint {
  color: var(--text-tertiary);
}

.error-message {
  color: var(--error-600);
}
```

#### 1.3 卡片 (Card)

```css
.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 24px;
  transition: all 0.2s ease;
}

.card:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-sm);
}

.card-header {
  margin-bottom: 16px;
}

.card-title {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 4px;
}

.card-description {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.card-body {
  margin: 16px 0;
}

.card-footer {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-light);
}
```

#### 1.4 Badge/Pill

```css
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  white-space: nowrap;
}

/* Variants */
.pill.success {
  background: var(--success-50);
  color: var(--success-700);
  border-color: var(--success-200);
}

.pill.warning {
  background: var(--warning-50);
  color: var(--warning-700);
  border-color: var(--warning-200);
}

.pill.error {
  background: var(--error-50);
  color: var(--error-700);
  border-color: var(--error-200);
}

.pill.info {
  background: var(--info-50);
  color: var(--info-700);
  border-color: var(--info-200);
}

/* With dot indicator */
.pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* Animated */
.pill-dot.pulse {
  animation: pulse 2s ease-in-out infinite;
}
```

#### 1.5 加载指示器 (Spinner)

```css
.spinner {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-light);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Sizes */
.spinner-sm { width: 16px; height: 16px; }
.spinner-lg { width: 32px; height: 32px; border-width: 3px; }
```

### 2. 导航组件

#### 2.1 侧边栏 (Sidebar)

```css
.sidebar {
  width: 280px;
  height: 100%;
  background: var(--bg-primary);
  border-right: 1px solid var(--border-light);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  scrollbar-width: thin;
}

.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-weight: 500;
  transition: all 0.2s ease;
}

.sidebar-nav-item:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.sidebar-nav-item.active {
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 600;
}

.sidebar-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}
```

#### 2.2 标签页 (Tabs)

```css
.tabs {
  display: flex;
  align-items: center;
  gap: 32px;
  border-bottom: 2px solid var(--border-light);
  padding: 0 32px;
  overflow-x: auto;
}

.tab {
  padding: 16px 4px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 500;
  position: relative;
  white-space: nowrap;
  transition: color 0.2s ease;
}

.tab:hover {
  color: var(--text-primary);
}

.tab.active {
  color: var(--accent);
  font-weight: 600;
}

.tab.active::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
}

.tab-count {
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
}

.tab.active .tab-count {
  background: var(--accent-light);
  color: var(--accent);
}
```

#### 2.3 面包屑 (Breadcrumb)

```css
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

.breadcrumb-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.breadcrumb-link {
  color: var(--text-secondary);
  transition: color 0.2s ease;
}

.breadcrumb-link:hover {
  color: var(--accent);
}

.breadcrumb-separator {
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.breadcrumb-current {
  color: var(--text-primary);
  font-weight: 500;
}
```

### 3. 反馈组件

#### 3.1 提示框 (Alert/Banner)

```css
.alert {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border-radius: var(--radius-lg);
  font-size: 0.9375rem;
  border: 1px solid;
}

.alert-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
}

.alert-content {
  flex: 1;
  min-width: 0;
}

.alert-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.alert-close {
  flex-shrink: 0;
  padding: 4px;
}

/* Variants */
.alert.success {
  background: var(--success-50);
  border-color: var(--success-200);
  color: var(--success-700);
}

.alert.warning {
  background: var(--warning-50);
  border-color: var(--warning-200);
  color: var(--warning-700);
}

.alert.error {
  background: var(--error-50);
  border-color: var(--error-200);
  color: var(--error-700);
}

.alert.info {
  background: var(--info-50);
  border-color: var(--info-200);
  color: var(--info-700);
}
```

#### 3.2 空状态 (Empty State)

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 32px;
  text-align: center;
}

.empty-state-icon {
  font-size: 48px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.empty-state-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.empty-state-description {
  font-size: 0.9375rem;
  color: var(--text-secondary);
  max-width: 400px;
  margin-bottom: 24px;
  line-height: 1.6;
}

.empty-state-action {
  /* Primary button styles */
}
```

### 4. 数据展示组件

#### 4.1 列表项 (List Item)

```css
.list-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border-radius: var(--radius-lg);
  border: 1px solid transparent;
  transition: all 0.2s ease;
}

.list-item:hover {
  background: var(--bg-secondary);
  border-color: var(--border-light);
}

.list-item.active {
  background: var(--accent-light);
  border-color: var(--accent);
}

.list-item-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
}

.list-item-content {
  flex: 1;
  min-width: 0;
}

.list-item-title {
  font-weight: 600;
  font-size: 0.9375rem;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-item-description {
  font-size: 0.875rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-item-meta {
  flex-shrink: 0;
  text-align: right;
  font-size: 0.875rem;
  color: var(--text-tertiary);
}
```

#### 4.2 进度条 (Progress)

```css
.progress {
  width: 100%;
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-full);
  transition: width 0.3s ease;
}

/* Variants */
.progress-bar.success {
  background: var(--success-500);
}

.progress-bar.warning {
  background: var(--warning-500);
}

.progress-bar.error {
  background: var(--error-500);
}

/* With label */
.progress-wrapper {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
```

---

## 关键交互流程

### 1. 登录流程

**场景**：用户首次访问或登录过期

**步骤**：
1. 显示登录页（品牌展示 + 表单）
2. 输入用户名和密码
3. 提交（loading 状态）
4. 成功：进入工作台
5. 失败：显示错误信息，保留输入

**设计要点**：
- 登录页居中，渐变背景
- 表单清晰，字段明确
- 密码可见切换
- 错误提示在表单内，不打断布局
- 记住上次登录的用户名（可选）

**边缘情况**：
- 初次设置：额外的初始化令牌字段
- 网络错误：友好提示，允许重试
- 长时间未响应：超时提示

### 2. 对话流程

**场景**：用户与 AI 进行对话

**步骤**：
1. 输入文本（可能附图）
2. 点击发送或按 Enter
3. 消息添加到对话中
4. AI 响应（流式显示）
5. （可能）工具调用（可折叠显示）
6. 继续对话或结束

**设计要点**：
- 输入框固定底部，易于访问
- 用户消息右对齐，蓝色背景
- AI 消息左对齐，白色背景
- 流式文本平滑出现，光标闪烁
- 工具调用折叠展示，不干扰阅读
- 滚动到底部跟随新消息

**交互细节**：
- 发送按钮禁用：输入为空或发送中
- Enter 发送，Shift+Enter 换行（桌面）
- 移动端：Enter 换行，按钮发送
- 附加图片：拖放或点击选择
- 移除图片：点击 × 按钮
- 停止生成：中断按钮

**边缘情况**：
- 长消息：限制最大高度，可展开
- 多张图片：横向滚动
- 工具失败：红色错误提示
- 网络中断：提示重试，不丢失输入

### 3. 任务委派流程

**场景**：用户向数字员工交代任务

**步骤**：
1. 选择员工（或创建新员工）
2. 在对话中描述任务
3. 员工确认理解或询问细节
4. 确认后任务开始
5. 任务出现在任务列表
6. 进度更新（实时）
7. （可能）审批请求
8. （可能）补充信息
9. 任务完成，查看结果

**设计要点**：
- 员工状态醒目：空闲/忙碌/需注意
- 任务卡片展示关键信息：
  - 标题
  - 状态（带颜色）
  - 进度条
  - 最新更新
  - 操作按钮
- 待处理项突出显示（橙色边框）
- 审批/补充表单内嵌在卡片中

**交互细节**：
- 任务卡片可展开查看详情
- 进度条实时更新
- 批准/驳回按钮明显
- 补充信息输入框聚焦
- 完成任务卡片可收起

**边缘情况**：
- 任务失败：显示错误原因，允许重试
- 超时：自动恢复机制，用户可介入
- 多任务并发：显示排队状态
- 外部依赖：明确等待原因

### 4. 浏览器控制流程

**场景**：用户查看或操作远程浏览器

**步骤**：
1. 查看标签页列表
2. 选择一个标签
3. 刷新截图（等待加载）
4. 查看模式：缩放、拖动
5. （可选）开始操作
6. 操作模式：点击、输入、滚动
7. 退出操作
8. 切换标签或退出

**设计要点**：
- 标签页卡片式显示，可横向滚动
- 实时画面居中，最大宽度限制
- 操作按钮清晰：开始操作/退出操作
- 状态指示：查看中/操作中/同步中
- 缩放和位置控制：
  - 桌面：滚轮缩放，拖动平移
  - 移动：双指缩放，单指拖动
- 辅助输入框（移动端）

**交互细节**：
- 查看模式：
  - 鼠标拖动平移
  - 滚轮缩放
  - 0 键还原
- 操作模式：
  - 点击直接同步
  - 拖动流畅（有界流）
  - 输入防抖
  - 等待同步完成再接受下一次操作
- 移动端：
  - 短按点击
  - 长按拖动（~500ms）
  - 双指缩放画面

**边缘情况**：
- 连接失败：提示检查配置
- 操作不确定：提示核对，不重复提交
- 画面过大：限制尺寸，提示性能影响
- 多标签切换：保存每个标签的视图状态

### 5. 员工创建流程

**场景**：用户创建新的数字员工

**步骤**：
1. 点击"创建员工"
2. 输入员工名称
3. 描述工作方向
4. （可选）选择头像
5. （可选）设置工作目录
6. 提交创建
7. 员工出现在列表中
8. 进入员工工作区

**设计要点**：
- 表单清晰，步骤明确
- 必填和选填标注
- 工作方向提供示例
- 头像选择器友好
- 创建成功后自动进入

**交互细节**：
- 名称验证：长度、字符限制
- 工作方向：textarea，提供足够空间
- 头像：颜色 + emoji 选择器
- 取消：确认是否丢弃
- 保存：禁用直到必填项完整

---

## 边缘情况处理

### 1. 内容边缘情况

#### 1.1 长内容
**问题**：
- 超长对话消息
- 大量任务列表
- 长文件名

**处理**：
- 文本：max-height + scroll / 可展开
- 列表：虚拟滚动（仅在需要时）
- 文件名：truncate + tooltip

#### 1.2 空状态
**场景**：
- 无会话
- 无员工
- 无任务
- 无标签页

**处理**：
- 友好的空状态图标
- 清晰的说明文案
- 明显的操作引导（创建按钮）
- 示例/提示

#### 1.3 错误状态
**场景**：
- 网络错误
- 权限错误
- 数据加载失败
- 操作失败

**处理**：
- 明确的错误信息
- 错误原因说明
- 重试按钮
- 错误图标/颜色
- 不打断整体布局

#### 1.4 加载状态
**场景**：
- 页面初始加载
- 数据刷新
- 操作提交
- 实时连接

**处理**：
- 骨架屏（主要内容区）
- Spinner（按钮、小区域）
- 进度提示（文字）
- 保持布局稳定（预留空间）

### 2. 交互边缘情况

#### 2.1 网络问题
**慢速网络**：
- 延迟加载反馈
- 操作防抖
- 离线提示
- 缓存策略

**断线重连**：
- 自动重连机制
- 重连状态提示
- 操作队列（可能）
- 数据同步

#### 2.2 并发操作
**问题**：
- 同时编辑多个字段
- 快速点击
- 多窗口同时操作

**处理**：
- 输入防抖
- 操作去重
- 乐观更新 + 回滚
- 冲突提示

#### 2.3 权限变化
**场景**：
- 登录过期
- 权限被撤销
- 角色变更

**处理**：
- 实时权限检查
- 友好的重新登录提示
- 禁用不可用操作
- 数据安全（不泄露）

### 3. 设备边缘情况

#### 3.1 小屏幕
**<375px**：
- 最小支持宽度 320px
- 单列布局
- 字体不小于 14px
- 触摸目标不小于 44px

**横屏**：
- 优化横屏布局
- 减小垂直空间占用
- 欢迎页简化

#### 3.2 大屏幕
**>1920px**：
- 内容最大宽度限制
- 留白合理分配
- 不过度拉伸组件
- 考虑多列布局

#### 3.3 触控设备
**要求**：
- 44x44px 最小触摸目标
- 避免纯 hover 交互
- 长按操作提示
- 防止误触

#### 3.4 键盘导航
**要求**：
- Tab 键顺序合理
- Focus 状态明显
- Enter/Space 激活
- Esc 取消/关闭

### 4. 性能边缘情况

#### 4.1 大数据量
**问题**：
- 100+ 会话
- 1000+ 消息
- 50+ 任务

**处理**：
- 分页或虚拟滚动
- 懒加载
- 搜索和过滤
- 归档旧数据

#### 4.2 慢设备
**问题**：
- 低端手机
- 老旧浏览器
- 内存不足

**处理**：
- 降级体验
- 减少动画
- 优化渲染
- 警告性能问题

---

## 实施计划

### 阶段 1：基础设施 (3 hours)

**目标**：建立设计系统基础

**任务**：
1. 创建新的 `style.css`，实现 Design Tokens
   - 颜色系统
   - 排版系统
   - 间距系统
   - 圆角和阴影
2. 实现基础组件样式
   - 按钮
   - 输入框
   - 卡片
   - Badge/Pill
3. 设置响应式断点
4. 验证：检查 Token 正确应用

### 阶段 2：布局重构 (4 hours)

**目标**：优化整体布局结构

**任务**：
1. 重构侧边栏
   - 导航区
   - 员工列表
   - 会话列表
2. 优化顶部栏
   - 面包屑
   - 标题区
   - 操作区
3. 改进主内容区
   - 最大宽度
   - 内边距
   - 滚动行为
4. 移动端布局
   - 抽屉导航
   - 移动头部
   - 底部导航（可选）
5. 验证：检查三个断点（375/768/1440）

### 阶段 3：组件重设计 (5 hours)

**目标**：重设计核心组件

**任务**：
1. 对话界面
   - 消息样式
   - 工具调用展示
   - 输入区优化
2. 员工工作区
   - 标签页
   - 任务卡片
   - 工作摘要
3. 浏览器控制
   - 标签页列表
   - 截图查看器
   - 控制面板
4. 表单页面
   - 设置页
   - 账号管理
   - 员工创建
5. 验证：每个组件的所有状态

### 阶段 4：交互优化 (3 hours)

**目标**：改进交互细节

**任务**：
1. Hover/Focus 状态
2. Loading 状态
3. 错误处理
4. 空状态
5. 过渡动画
6. 验证：交互流畅性

### 阶段 5：响应式完善 (4 hours)

**目标**：确保全面响应式

**任务**：
1. 桌面端优化 (1440px)
   - 空间利用
   - 信息密度
   - 多列布局
2. 平板优化 (768px)
   - 折叠侧边栏
   - 调整间距
   - 触控友好
3. 移动端完善 (375px)
   - 单列布局
   - 触摸目标
   - 软键盘处理
4. 极端情况
   - 320px 小屏
   - 1920px+ 大屏
   - 横屏布局
5. 验证：所有断点截图

### 阶段 6：边缘情况处理 (3 hours)

**目标**：处理各种边缘情况

**任务**：
1. 长内容测试
2. 空状态完善
3. 错误场景
4. 加载状态
5. 验证：所有边缘情况

### 阶段 7：测试与验证 (4 hours)

**目标**：全面测试

**任务**：
1. 功能测试
   - 所有页面可访问
   - 所有操作可执行
   - 数据正确显示
2. 视觉测试
   - 对齐检查
   - 间距一致性
   - 颜色对比度
3. 响应式测试
   - 三个主要断点
   - 不同设备
   - 横竖屏
4. 交互测试
   - 键盘导航
   - 触摸操作
   - 鼠标交互
5. 性能测试
   - 页面加载
   - 滚动流畅性
   - 动画性能
6. 无障碍测试
   - 颜色对比度
   - ARIA 标签
   - 键盘访问

### 阶段 8：文档与交付 (2 hours)

**目标**：完成文档和清理

**任务**：
1. 更新 README
2. 添加注释
3. 清理测试代码
4. 截图对比
5. PR 描述

**总计**：约 28 小时的工作量

---

## 权衡与未决问题

### 1. 已做的权衡决策

#### 1.1 保持 Vue Vapor
**决策**：不改变前端框架

**理由**：
- 风险太高
- 超出范围
- Vue 3.6 Vapor 是新技术，值得保留

**权衡**：
- 失去：使用更流行框架的机会
- 获得：稳定性和快速实施

#### 1.2 不实现深色模式
**决策**：本次不做深色模式

**理由**：
- 增加 2-3x 工作量
- 需要完整的颜色映射
- 没有明确需求

**未来考虑**：
- 预留 CSS Variables 结构
- 文档化如何添加

#### 1.3 移动端底部导航
**决策**：使用抽屉导航，不用底部标签栏

**理由**：
- 保持与桌面版一致性
- 避免遮挡内容
- 更多导航项空间

**权衡**：
- 失去：快速切换便利性
- 获得：更大内容区

#### 1.4 Inter 字体
**决策**：使用 Inter + 系统后备

**理由**：
- 免费开源
- 屏幕优化
- 可变字体
- 广泛使用

**权衡**：
- 需要加载外部字体（可选）
- 中文回退到系统字体
- 考虑使用 CDN 或 self-host

#### 1.5 不使用 CSS-in-JS
**决策**：保持传统 CSS

**理由**：
- 项目已有结构
- 避免额外依赖
- 性能考虑
- Vue Scoped CSS 足够

**权衡**：
- 失去：动态样式便利性
- 获得：更好的性能和缓存

### 2. 未决问题

#### 2.1 渐进式 Web App (PWA)?
**问题**：是否添加 PWA 支持？

**考虑**：
- 离线访问能力
- 安装到桌面
- 推送通知
- 增加工作量

**决策**：留待后续

#### 2.2 键盘快捷键系统?
**问题**：是否实现全局快捷键？

**候选快捷键**：
- `Ctrl+K`: 命令面板
- `Ctrl+N`: 新建对话
- `Ctrl+/`: 显示快捷键帮助
- `Esc`: 关闭/取消

**决策**：基础快捷键（Esc），其他留待后续

#### 2.3 拖放功能?
**问题**：哪些地方需要拖放？

**候选位置**：
- 图片上传（已有点击）
- 任务排序（优先级）
- 员工排序（顺序）

**决策**：仅图片拖放（如果时间允许）

#### 2.4 虚拟滚动?
**问题**：是否需要虚拟滚动？

**适用场景**：
- 100+ 会话列表
- 1000+ 消息
- 50+ 员工

**决策**：先实现，如果性能问题再考虑

#### 2.5 国际化 (i18n)?
**问题**：是否准备国际化？

**考虑**：
- 当前仅中文
- 结构上预留空间
- 不影响当前实施

**决策**：不实施，但代码中不硬编码布局依赖文本长度

### 3. 需要验证的假设

#### 3.1 用户习惯
**假设**：员工空间是最常用功能

**验证**：
- 检查实际使用模式
- 可能需要调整默认页面

#### 3.2 设备分布
**假设**：主要是桌面端，其次是平板/手机

**验证**：
- 分析设备使用数据
- 可能需要调整优化重点

#### 3.3 性能要求
**假设**：大多数用户硬件良好，网络稳定

**验证**：
- 实测低端设备
- 考虑降级方案

#### 3.4 使用频率
**假设**：高频用户每天使用，需要快速访问

**验证**：
- 了解实际使用模式
- 可能需要添加快捷方式

### 4. 风险与缓解

#### 4.1 兼容性风险
**风险**：老旧浏览器不支持

**缓解**：
- 明确支持的浏览器列表
- 添加浏览器检测和提示
- 优雅降级

#### 4.2 性能风险
**风险**：大数据量时卡顿

**缓解**：
- 虚拟滚动
- 分页加载
- 优化渲染
- 性能监控

#### 4.3 无障碍风险
**风险**：颜色对比度不足，键盘导航问题

**缓解**：
- 使用对比度检查工具
- 完整的键盘测试
- ARIA 标签
- 语义化 HTML

#### 4.4 维护风险
**风险**：设计系统不一致，难以维护

**缓解**：
- Design Tokens
- 组件文档
- 命名约定
- 代码注释

---

## 总结

本设计方案基于对 Vega 应用的深入分析，提出了全面的 UI 重新设计方案。核心目标是：

1. **美观实用**：现代化设计语言，清晰的视觉层次
2. **空间高效**：优化信息密度，减少无效留白
3. **移动友好**：全面响应式，从 375px 到 1440px+ 流畅体验
4. **功能完整**：所有现有功能保留，不改变后端

通过建立系统化的设计标记系统、优化信息架构、改进布局和组件，我们将显著提升用户体验，同时保持代码的可维护性和可扩展性。

实施将分 8 个阶段进行，总计约 28 小时。每个阶段都有明确的目标和验证标准，确保渐进式实施和质量控制。

---

**附录**：

- [A] 当前 UI 截图
- [B] 设计原型（待补充）
- [C] 组件库文档（待补充）
- [D] 测试清单（待补充）

---

**修订历史**：

- v1.0 (2026-11-02): 初始版本
