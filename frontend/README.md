# Pi-Science frontend

Pi-Science 的 React + TypeScript + Vite 前端。页面路由、业务组件和客户端能力按职责分层，避免把所有非组件代码堆在同一个 `lib/` 目录中。

## Source layout

```text
src/
├── app/             应用入口、路由、页面级布局
├── components/      按功能域组织的 React 组件
├── hooks/           可复用的 React hooks
├── i18n/            国际化配置和翻译资源
├── lib/
│   ├── agent-runtime/  会话运行时、事件折叠和恢复
│   ├── artifacts/      产物识别、预览策略和产物查询
│   ├── client/         API、事件流和 React Query 客户端
│   ├── conversation/   消息操作、建议和斜杠命令
│   ├── files/          文件引用和文件查询
│   ├── knowledge/      项目知识库和记忆
│   ├── notebook/       Notebook 运行时
│   ├── provenance/     来源追踪
│   ├── research/       研究事件和研究身份
│   ├── runs/           运行记录
│   ├── settings/       设置 API 和类型
│   ├── shared/         CSV、图表、Office、下载和格式化工具
│   ├── skills/         Skills API
│   ├── ui/             UI 状态、className 和滚动记忆
│   ├── viewers/        分子等专业查看器
│   └── workspace/      工作区上下文、路径和文件
└── types/           跨页面共享的类型
```

目录约定：页面放在 `app/routes`，跨页面的 UI 放在 `components`，业务能力放在 `lib` 的对应功能域；只有真正跨领域的轻量工具才放入 `lib/shared`。

## Commands

从仓库根目录执行：

```bash
corepack pnpm --filter frontend dev
corepack pnpm --filter frontend test
corepack pnpm --filter frontend typecheck
corepack pnpm --filter frontend build
```
