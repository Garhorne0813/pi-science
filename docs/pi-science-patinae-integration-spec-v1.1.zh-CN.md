# Pi-Science 集成 Patinae 分子查看器实施规格

**用途：** 可直接交给编码模型执行的工程任务说明<br>
**编写日期：** 2026-07-29<br>
**目标仓库：** `Garhorne0813/pi-science`<br>
**目标快照：** `7f944b7e2c7f4c97d3cd9e480d12e5732c986a9a`<br>
**Patinae 仓库：** `zmactep/patinae`<br>
**Patinae 快照：** `5f7ba5a00be69567285c20a17ce59386de8b9efc`，版本 `0.4.4`<br>
**文档版本：** `1.1`

> 重要判断：Patinae 可以嵌入 Pi-Science 的现有 React 文件预览窗口，并通过 `PatinaeViewer.execute()` / `executeAsync()` 接受 PyMOL 风格文本命令。Pi-Science 只需要集成 `@patinae/viewer` Web 包及其 JavaScript/WASM 产物，不需要安装 Patinae 桌面端、Python、Jupyter、原生插件或完整 Rust workspace。第一阶段应保留 3Dmol.js 作为小分子、SMILES、无 WebGPU 环境和 Patinae 初始化失败时的后备查看器。

---

## 0. 可直接复制给编码模型的任务指令

你正在修改 `Garhorne0813/pi-science`。请在当前分子文件预览器中集成 `zmactep/patinae` 的 Web Viewer，实现一个可交互的 Patinae 窗口和文本命令控制台。

### 必做目标

1. 仅在 `frontend` 中增加 `@patinae/viewer` Web 依赖；不得把 Patinae 桌面端、Python/Jupyter 包、原生插件、Slint GUI 或完整 Cargo workspace 引入 Pi-Science。
2. 保留现有 3Dmol.js 查看器，不得删除其 SMILES 转换和小分子后备能力。
3. 将现有 `frontend/src/components/inspector/MoleculeView.tsx` 重构为查看器选择容器。
4. 把现有 3Dmol 实现移动到 `ThreeDMolMoleculeView.tsx`，行为保持不变。
5. 新增 `PatinaeMoleculeView.tsx`：
   - 动态导入 `@patinae/viewer`；
   - 在普通 React `<div>` 中初始化 `PatinaeViewer`；
   - 使用 `loadData(Uint8Array, name, format)` 加载 Pi-Science 已读取的文件文本；
   - 提供命令输入框、执行按钮、命令历史和输出区域；
   - 支持 `show`、`hide`、`color`、`select`、`zoom`、`orient` 等 Patinae 命令；
   - 组件卸载时调用 `destroy()`。
6. 查看器选择规则：
   - SMILES、PQR、CUBE 或 Patinae 不支持的格式默认使用 3Dmol；
   - 支持格式且浏览器有 `navigator.gpu` 时，大分子默认 Patinae；
   - Patinae 初始化失败时自动回退 3Dmol，并显示非阻断提示；
   - 用户可以在窗口内手动切换 `3Dmol` / `Patinae`。
7. 增加中英文 i18n 文案。
8. 为纯函数、查看器选择、Patinae 生命周期和命令执行增加 Vitest 测试。
9. 更新 Vite 手动分包配置，使 Patinae/WASM 独立懒加载。
10. 运行并记录：
   - `pnpm --filter frontend typecheck`
   - `pnpm --filter frontend test`
   - `pnpm --filter frontend build`
11. 除非第一阶段验收全部通过，不要声称集成完成。

### 第一阶段不得做

- 不得删除 `3dmol` 依赖。
- 不得安装或打包 Patinae native desktop、`patinae` Python 包、Jupyter widget、Slint GUI、`raytracer`/`python`/`ipc` 原生插件、`patinae-mm` 或其他非 Web 运行时。
- 不得把 Patinae 仓库作为完整 monorepo 合入 Pi-Science；registry 不可用时只 vendor 固定版本的 `@patinae/viewer` tarball。
- 不得使用 iframe 嵌入 Patinae。
- 不得让 3Dmol 和 Patinae 同时挂载并持续渲染。
- 不得在浏览器中使用 Patinae 的本地路径 `load` 命令读取工作区文件；工作区数据必须通过 `loadData()` 注入。
- 不得把 Patinae 私有 WASM 对象暴露给应用其他模块。
- 不得默认开启全局 COOP/COEP 头；只有实际测试证明必需时再增加，并验证不会破坏其他预览器。
- 不得把“Agent 自动控制查看器”与第一阶段强绑定。第一阶段只需用户手动输入命令；Agent 桥接作为第二阶段。

### 完成定义

- 打开 `.pdb` 或 `.cif` 文件时可进入 Patinae 窗口。
- 输入 `color green, chain A`、`select site, byres around 5 organic`、`show sticks, site`、`zoom site` 能改变当前场景。
- 切换查看器不会残留旧 Canvas、RAF 循环或重复监听器。
- 无 WebGPU 环境和 Patinae 初始化失败时仍能使用 3Dmol。
- SMILES 仍由现有 OpenChemLib + 3Dmol 流程预览。
- 类型检查、单元测试和生产构建通过。
- 打开普通聊天页或非分子文件时，浏览器网络面板不应加载 Patinae JavaScript/WASM；首次进入 Patinae 模式时才按需加载。
- 生产产物中只有 Web Viewer 所需的 JavaScript/WASM，不包含桌面可执行文件、Python wheel 或原生插件动态库。

---

## 1. 已确认的现有架构

### 1.1 Pi-Science 前端

Pi-Science 当前使用：

- React 19；
- TypeScript；
- Vite；
- pnpm workspace；
- Zustand；
- i18next；
- 现有 `3dmol` 依赖。

当前分子预览链路为：

```text
FilePreviewInspector
  -> lazy import MoleculeView
  -> MoleculeView(filename, text)
  -> dynamic import("3dmol")
  -> createViewer(container)
  -> addModel(text, format)
```

`FilePreviewInspector.tsx` 已经把分子查看器作为独立懒加载组件放入右侧文件预览面板。因此 Patinae 的正确集成点就是 `frontend/src/components/inspector/`，不需要重构 Node 控制平面或 Python worker。

### 1.2 Patinae Web API

Patinae 的公开 Web 包是 ESM + WASM 组件，核心接口包括：

```ts
new PatinaeViewer(container, options)
await viewer.init()
viewer.loadData(bytes, objectName, format)
await viewer.loadUrl(url, options)
viewer.execute(command)
await viewer.executeAsync(command)
viewer.on(event, callback)
viewer.off(event, callback)
viewer.countAtoms(selection)
viewer.destroy()
```

它在内部创建 `<canvas>`、启动 `requestAnimationFrame`、监听尺寸变化，并在 `destroy()` 时清理资源。Pi-Science 不应直接操作其内部 WASM 对象。


### 1.3 Patinae 的集成边界

Pi-Science 的网页窗口只需要一个前端依赖：

```text
@patinae/viewer
  ├── dist/patinae-viewer.js        TypeScript/JavaScript 公共 API
  ├── dist/patinae-viewer.d.ts      类型声明
  ├── pkg/patinae_web.js            wasm-bindgen 加载胶水
  └── pkg/patinae_web_bg.wasm       Rust 编译后的 Web Viewer 核心
```

从 Pi-Science 的依赖和部署角度，不需要安装以下内容：

| 不需要集成的部分 | 原因 |
|---|---|
| Patinae native desktop executable | Pi-Science 在浏览器内嵌 Viewer，不启动独立桌面程序 |
| Slint GUI | 只服务 Patinae 原生桌面界面 |
| `patinae` Python package | 第一阶段命令直接在浏览器 Viewer 中执行 |
| Jupyter widget | Pi-Science 已有自己的 Notebook 和 Inspector UI |
| native Rust plugins | 浏览器不能直接加载 `.so` / `.dll` / `.dylib` |
| `raytracer`、`python`、`ipc` plugins | 不属于 Web Viewer 最小运行路径 |
| `patinae-mm` 分子力学模块 | 第一阶段目标是查看与命令控制，不做能量计算或优化 |
| 完整 Cargo workspace | 仅在自行构建 `@patinae/viewer` tarball 时临时需要，不能成为 Pi-Science 运行依赖 |

需要注意：虽然安装层面只有一个 Web 包，但它的 WASM 内部仍会包含 Viewer 必需的分子模型、I/O、选择解析、命令、场景和渲染代码。当前公开接口不是可逐个安装的 `@patinae/select`、`@patinae/render` 等 JavaScript 子包，不能在 Pi-Science 侧通过 npm tree-shaking 任意拆掉 Rust crate。

运行时可以关闭或不创建的功能包括：

- 不传 `panels` / `layout`：不创建 Patinae 内置 REPL、Objects、Sequence 和 Movie 面板；
- `picking: false`：不分配点击命中检测资源；
- `selectionOverlay: false`：不绘制选取/悬停覆盖层；
- `memoryProfile: "lite"`：面向低端 GPU；
- `memoryProfile: "balanced"`：Pi-Science 推荐默认值。

第一阶段需要命令控制但不一定需要点击选取时，可采用更轻的配置：

```ts
const viewer = new PatinaeViewer(container, {
  picking: false,
  selectionOverlay: false,
  memoryProfile: "balanced",
});
```

若产品明确需要鼠标点选原子/残基，再启用：

```ts
const viewer = new PatinaeViewer(container, {
  picking: true,
  selectionOverlay: true,
  memoryProfile: "balanced",
});
```

---

## 2. 推荐集成架构

```text
FilePreviewInspector
       |
       v
MoleculeView  <-----------------------------+
  |                                           |
  | chooses viewer                            | fallback/error
  +-------------------+-----------------------+
                      |
          +-----------+-----------+
          |                       |
          v                       v
ThreeDMolMoleculeView      PatinaeMoleculeView
  - SMILES                  - WebGPU/WASM
  - small molecules         - PyMOL-like commands
  - fallback                - protein/nucleic acid
                            - command output/events
```

### 2.1 为什么保留双查看器

3Dmol.js 当前已经承担：

- SMILES 转 SDF；
- 小分子默认表示；
- PQR/CUBE 等现有格式；
- WebGL 后备环境。

Patinae 当前仍是 Alpha，且依赖 WebGPU。因此直接删除 3Dmol 会扩大回归风险。第一阶段的正确策略是“Patinae 增强 + 3Dmol 后备”，而不是一次性替换。

### 2.2 第一阶段范围

第一阶段只包含：

- 文件预览窗口内的 Patinae Viewer；
- 查看器切换；
- 用户手动命令输入；
- 命令输出；
- 选取（picking）；
- 生命周期和回退；
- 测试与构建。

不包含：

- Agent 自动发命令；
- XTC/TRR 轨迹；
- MRC/CCP4 密度图；
- bCIF、gzip 等二进制加载；
- Patinae session 持久化；
- 多窗口协同。


### 2.3 与 Mol* 的“重量”差异及本项目决策

不要用单一的“包大小”概念判断 Patinae 与 Mol*。应分成三层：

| 维度 | 通常更重的一方 | 对 Pi-Science 的含义 |
|---|---|---|
| JavaScript、UI 和功能栈规模 | Mol* | Mol* 包含成熟的 plugin/state tree、representation、查询、React UI 和数据服务集成 |
| 首次初始化与 GPU 环境要求 | Patinae | Patinae 需要实例化 WASM、申请 WebGPU adapter/device 并创建渲染资源 |
| 浏览器兼容和部署风险 | Patinae | 需要正确部署 WASM，并处理 WebGPU、驱动和低端设备回退 |
| 大型结构生产成熟度 | Mol* 更成熟 | Patinae 仍应保留 3Dmol fallback，并通过真实数据验证 |
| PyMOL 风格文本命令 | Patinae 更直接 | 本项目选择 Patinae 的核心理由，而不是追求最轻的 Viewer |

没有在同一 Pi-Science production build、同一浏览器和同一结构上测量前，不得写出“Patinae 固定比 Mol* 小多少 MB”或“固定快多少倍”。编码模型必须保留可测量性，而不是给出未经验证的数字。

本项目的性能决策：

1. Patinae 必须通过动态 `import()` 懒加载；
2. 同一 Inspector 同时只能存在一个分子 Viewer 实例；
3. 关闭/切换时必须调用 `destroy()`；
4. 默认使用 `balanced`，低端设备可切换 `lite`；
5. 不默认加载 Patinae 内置 panels；
6. 不默认计算 surface、密度图或轨迹；
7. WebGPU 不可用或初始化失败时回退 3Dmol；
8. 首屏和普通聊天页面不得加载 Patinae WASM。

---

## 3. 依赖获取策略

Pi-Science 只增加 `@patinae/viewer` 一个 Patinae 运行依赖。不要假设 `@patinae/viewer@0.4.4` 一定已发布到当前 npm registry。编码模型应按以下顺序处理。构建 Patinae 源码只用于产出固定版本 tarball，不得把 Rust 工具链或 Patinae workspace 变成 Pi-Science 的日常启动依赖。

### 3.1 优先尝试 registry

```bash
pnpm --dir frontend add @patinae/viewer@0.4.4
```

如果成功，检查 `frontend/package.json` 和 lockfile，然后继续实现。

### 3.2 registry 不可用时：构建固定版本 tarball

在 `pi-science` 同级目录构建：

```bash
cd ..
git clone https://github.com/zmactep/patinae.git
git -C patinae checkout 5f7ba5a00be69567285c20a17ce59386de8b9efc

rustup target add wasm32-unknown-unknown
# 如果系统没有 wasm-pack：
cargo install wasm-pack --version 0.15.0

cd patinae/web
npm ci
npm run build
npm pack
```

把生成的 tarball 放入 Pi-Science：

```bash
mkdir -p ../../pi-science/vendor
cp patinae-viewer-0.4.4.tgz ../../pi-science/vendor/
cd ../../pi-science
pnpm --dir frontend add ../vendor/patinae-viewer-0.4.4.tgz
```

期望 `frontend/package.json` 中出现类似：

```json
{
  "dependencies": {
    "@patinae/viewer": "file:../vendor/patinae-viewer-0.4.4.tgz"
  }
}
```

### 3.3 安装结果检查

无论使用 registry 还是本地 tarball，安装完成后都要检查：

```bash
pnpm --dir frontend why @patinae/viewer
find frontend/node_modules/@patinae/viewer -maxdepth 3 \
  \( -name '*.js' -o -name '*.d.ts' -o -name '*.wasm' \) -print
```

期望结果：

- 依赖树中只有 `@patinae/viewer` Web 包；
- 包内存在公共 JavaScript、类型声明、wasm-bindgen 胶水和 `.wasm`；
- 不存在 Patinae 桌面可执行文件、Python wheel 或 native plugin 动态库；
- Pi-Science 的 `scripts/start.sh`、Node server 和 Python worker 不需要 Rust、Cargo、wasm-pack 或 Patinae Python 包才能启动。

### 3.4 第三方许可证


Patinae 使用 BSD-3-Clause。若提交 tarball 或构建产物到 Pi-Science 仓库，应在 `THIRD_PARTY_NOTICES.md` 中记录：

- 项目名；
- 仓库地址；
- 固定 commit；
- 版本；
- BSD-3-Clause 许可证。

---

## 4. 文件改动清单

### 必须修改

```text
frontend/package.json
frontend/vite.config.ts
frontend/src/components/inspector/MoleculeView.tsx
frontend/src/i18n/locales/en.json
frontend/src/i18n/locales/zh-Hans.json
frontend/src/lib/viewers/molecule.test.ts（或新增测试文件）
```

### 必须新增

```text
frontend/src/components/inspector/ThreeDMolMoleculeView.tsx
frontend/src/components/inspector/PatinaeMoleculeView.tsx
frontend/src/lib/viewers/patinae.ts
frontend/src/lib/viewers/patinae.test.ts
frontend/src/components/inspector/PatinaeMoleculeView.test.tsx
```

### 推荐新增

```text
frontend/src/lib/viewers/molecule-controller.ts
frontend/src/lib/viewers/molecule-controller.test.ts
THIRD_PARTY_NOTICES.md
```

---

## 5. 第一步：保留并移动现有 3Dmol 实现

把当前 `MoleculeView.tsx` 的实现移动到：

```text
frontend/src/components/inspector/ThreeDMolMoleculeView.tsx
```

仅做以下机械改动：

```ts
export function ThreeDMolMoleculeView({
  filename,
  text,
}: {
  filename: string;
  text: string;
}) {
  // 原 MoleculeView 实现，其他行为不变
}
```

不得改变：

- `smilesToMolblock()`；
- `looksLikeMacromolecule()`；
- `defaultStyleMode()`；
- pointer drag / wheel 行为；
- 现有 style buttons；
- 现有错误和 atom count 行为。

这样可以降低 Patinae 集成导致的回归范围。

---

## 6. 第二步：新增 Patinae 纯函数模块

创建：

```text
frontend/src/lib/viewers/patinae.ts
```

建议实现：

```ts
export type MoleculeViewerKind = "3dmol" | "patinae";

const PATINAE_FORMATS: Record<string, string> = {
  pdb: "pdb",
  cif: "cif",
  mcif: "cif",
  mmcif: "cif",
  mol: "mol",
  mol2: "mol2",
  sdf: "sdf",
  xyz: "xyz",
};

export function extensionOf(filename: string): string {
  const clean = filename.replace(/\.(gz|bz2)$/i, "");
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function patinaeFormatFor(filename: string): string | null {
  return PATINAE_FORMATS[extensionOf(filename)] ?? null;
}

export function patinaeObjectName(filename: string): string {
  const base = filename
    .replace(/\.(gz|bz2)$/i, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "structure";
}

export function supportsPatinaeFile(filename: string): boolean {
  return patinaeFormatFor(filename) !== null;
}

export function browserSupportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.gpu);
}

export function initialPatinaeCommands(isMacromolecule: boolean): string[] {
  if (isMacromolecule) {
    return [
      "as cartoon",
      "show sticks, organic",
      "orient",
    ];
  }

  return ["as sticks", "orient"];
}

export function defaultViewerKind(options: {
  filename: string;
  isMacromolecule: boolean;
  webGpuAvailable: boolean;
}): MoleculeViewerKind {
  if (!options.webGpuAvailable) return "3dmol";
  if (!supportsPatinaeFile(options.filename)) return "3dmol";
  return options.isMacromolecule ? "patinae" : "3dmol";
}
```

### 设计说明

- 不要把 `pqr`、`cube`、`smi`、`smiles` 在第一阶段映射给 Patinae。
- `navigator.gpu` 只表示基本能力存在，不能保证初始化成功；初始化错误仍需捕获并回退。
- `initialPatinaeCommands()` 只执行保守命令，避免首次加载就计算 surface。

---

## 7. 第三步：新增 Patinae React 组件

创建：

```text
frontend/src/components/inspector/PatinaeMoleculeView.tsx
```

下面代码是实现骨架。编码模型可以根据 Pi-Science 现有 Tailwind token 和 i18n 习惯微调，但不得删除生命周期、错误回退和命令输出逻辑。

```tsx
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Play, RotateCcw, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  OutputMessage,
  PatinaeViewer,
} from "@patinae/viewer";
import {
  initialPatinaeCommands,
  patinaeFormatFor,
  patinaeObjectName,
} from "@/lib/viewers/patinae";
import { looksLikeMacromolecule } from "@/lib/viewers/molecule";
import { cn } from "@/lib/cn";

type Props = {
  filename: string;
  text: string;
  onUnavailable?: (message: string) => void;
};

const MAX_OUTPUT_MESSAGES = 100;
const MAX_COMMAND_HISTORY = 50;

export function PatinaeMoleculeView({
  filename,
  text,
  onUnavailable,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PatinaeViewer | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<OutputMessage[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [atomCount, setAtomCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const format = patinaeFormatFor(filename);

    if (!container || !format) {
      const message = t("molecule.patinae.unsupportedFormat");
      setError(message);
      onUnavailable?.(message);
      return;
    }

    let disposed = false;
    let viewer: PatinaeViewer | null = null;

    setInitializing(true);
    setError(null);
    setMessages([]);
    setAtomCount(null);
    container.replaceChildren();

    const initialize = async () => {
      try {
        const module = await import("@patinae/viewer");
        if (disposed) return;

        viewer = new module.PatinaeViewer(container, {
          // 第一阶段默认保持较轻；产品需要鼠标点选时再改为 true。
          picking: false,
          selectionOverlay: false,
          memoryProfile: "balanced",
        });

        const onOutput = (message: OutputMessage) => {
          if (disposed) return;
          setMessages((current) => [
            ...current.slice(-(MAX_OUTPUT_MESSAGES - 1)),
            message,
          ]);
        };

        viewer.on("command-output", onOutput);
        await viewer.init();

        if (disposed) {
          viewer.destroy();
          return;
        }

        const bytes = new TextEncoder().encode(text);
        viewer.loadData(bytes, patinaeObjectName(filename), format);

        const isMacromolecule = looksLikeMacromolecule(text);
        for (const initialCommand of initialPatinaeCommands(isMacromolecule)) {
          viewer.execute(initialCommand);
        }

        viewerRef.current = viewer;
        setAtomCount(viewer.countAtoms("all"));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const userMessage = t("molecule.patinae.initializeFailed", {
          message,
        });
        setError(userMessage);
        onUnavailable?.(userMessage);
        viewer?.destroy();
        viewer = null;
      } finally {
        if (!disposed) setInitializing(false);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      viewerRef.current = null;
      viewer?.destroy();
      container.replaceChildren();
    };
  }, [filename, onUnavailable, t, text]);

  const executeCommand = useCallback(async () => {
    const viewer = viewerRef.current;
    const value = command.trim();
    if (!viewer || !value) return;

    historyRef.current = [
      value,
      ...historyRef.current.filter((item) => item !== value),
    ].slice(0, MAX_COMMAND_HISTORY);
    historyIndexRef.current = -1;
    setCommand("");

    try {
      await viewer.executeAsync(value);
      setAtomCount(viewer.countAtoms("all"));
    } catch (cause) {
      setMessages((current) => [
        ...current.slice(-(MAX_OUTPUT_MESSAGES - 1)),
        {
          level: "error",
          text: cause instanceof Error ? cause.message : String(cause),
        },
      ]);
    }
  }, [command]);

  const onCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void executeCommand();
        return;
      }

      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();

      const history = historyRef.current;
      if (history.length === 0) return;

      if (event.key === "ArrowUp") {
        historyIndexRef.current = Math.min(
          historyIndexRef.current + 1,
          history.length - 1,
        );
      } else {
        historyIndexRef.current = Math.max(historyIndexRef.current - 1, -1);
      }

      setCommand(
        historyIndexRef.current === -1
          ? ""
          : history[historyIndexRef.current] ?? "",
      );
    },
    [executeCommand],
  );

  const resetView = useCallback(() => {
    viewerRef.current?.execute("orient");
  }, []);

  return (
    <div className="flex h-full min-h-[420px] w-full flex-col overflow-hidden bg-black">
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="absolute inset-0"
          aria-label={t("molecule.patinae.viewerLabel")}
        />

        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-input border border-border/70 bg-surface/90 p-1 shadow-card backdrop-blur">
          <div className="flex items-center gap-1 px-1.5 text-xs font-medium text-muted">
            <Terminal size={13} /> Patinae
          </div>
          <button
            type="button"
            onClick={resetView}
            disabled={!viewerRef.current}
            aria-label={t("molecule.resetView")}
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            <RotateCcw size={13} />
          </button>
        </div>

        <div className="pointer-events-none absolute bottom-3 right-3 rounded-input border border-border/70 bg-surface/90 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
          <span className="font-medium text-text">
            {(patinaeFormatFor(filename) ?? "").toUpperCase()}
          </span>
          {atomCount !== null && (
            <span className="ml-2">
              {t("molecule.atomCount", { count: atomCount })}
            </span>
          )}
        </div>

        {(initializing || error) && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[75%] rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
            {initializing ? t("molecule.patinae.initializing") : error}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface">
        {messages.length > 0 && (
          <div className="max-h-28 overflow-auto border-b border-border px-3 py-2 font-mono text-xs">
            {messages.map((message, index) => (
              <div
                key={`${index}-${message.text}`}
                className={cn(
                  "whitespace-pre-wrap",
                  message.level === "error" && "text-red-500",
                  message.level === "warning" && "text-amber-500",
                  message.level === "info" && "text-muted",
                )}
              >
                {message.text}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 p-2">
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={onCommandKeyDown}
            disabled={!viewerRef.current}
            placeholder={t("molecule.patinae.commandPlaceholder")}
            aria-label={t("molecule.patinae.commandLabel")}
            className="min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void executeCommand()}
            disabled={!viewerRef.current || !command.trim()}
            className="flex h-9 items-center gap-1 rounded-input bg-accent px-3 text-sm font-medium text-white disabled:opacity-40"
          >
            <Play size={14} />
            {t("molecule.patinae.runCommand")}
          </button>
          <button
            type="button"
            onClick={() => setMessages([])}
            disabled={messages.length === 0}
            aria-label={t("molecule.patinae.clearOutput")}
            className="flex h-9 w-9 items-center justify-center rounded-input border border-border text-muted hover:text-text disabled:opacity-40"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 必须注意的 React 生命周期问题

1. 动态 import、WASM 初始化和文件加载均是异步的；卸载后不得再更新 state。
2. `viewer.destroy()` 必须在以下情况调用：
   - 组件卸载；
   - filename/text 改变；
   - 初始化完成前组件被卸载；
   - 初始化失败且 viewer 已创建。
3. 不需要额外给 Patinae 编写 `ResizeObserver`，Patinae Viewer Core 已经处理尺寸同步。
4. 不要在 React state 中存 viewer 实例，使用 `useRef`。
5. 不要在每次输入命令时重建 viewer。

---

## 8. 第四步：把 `MoleculeView.tsx` 改成选择容器

新的 `MoleculeView.tsx` 只负责：

- 计算默认查看器；
- 显示 3Dmol / Patinae 切换按钮；
- 捕获 Patinae 不可用事件并回退；
- 保证同一时间只挂载一个查看器。

建议骨架：

```tsx
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  browserSupportsWebGpu,
  defaultViewerKind,
  supportsPatinaeFile,
  type MoleculeViewerKind,
} from "@/lib/viewers/patinae";
import {
  isSmilesFile,
  looksLikeMacromolecule,
} from "@/lib/viewers/molecule";
import { cn } from "@/lib/cn";
import { PatinaeMoleculeView } from "./PatinaeMoleculeView";
import { ThreeDMolMoleculeView } from "./ThreeDMolMoleculeView";

export function MoleculeView({
  filename,
  text,
}: {
  filename: string;
  text: string;
}) {
  const { t } = useTranslation();
  const isMacromolecule = useMemo(
    () => looksLikeMacromolecule(text),
    [text],
  );

  const patinaeAllowed = useMemo(
    () =>
      !isSmilesFile(filename) &&
      supportsPatinaeFile(filename) &&
      browserSupportsWebGpu(),
    [filename],
  );

  const initialKind = useMemo(
    () =>
      defaultViewerKind({
        filename,
        isMacromolecule,
        webGpuAvailable: browserSupportsWebGpu(),
      }),
    [filename, isMacromolecule],
  );

  const [viewerKind, setViewerKind] =
    useState<MoleculeViewerKind>(initialKind);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  useEffect(() => {
    setViewerKind(initialKind);
    setFallbackNotice(null);
  }, [filename, initialKind, text]);

  const handlePatinaeUnavailable = (message: string) => {
    setFallbackNotice(message);
    setViewerKind("3dmol");
  };

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden">
      {viewerKind === "patinae" ? (
        <PatinaeMoleculeView
          filename={filename}
          text={text}
          onUnavailable={handlePatinaeUnavailable}
        />
      ) : (
        <ThreeDMolMoleculeView filename={filename} text={text} />
      )}

      <div
        className="absolute right-3 top-3 z-20 flex rounded-input border border-border/70 bg-surface/90 p-0.5 shadow-card backdrop-blur"
        data-molecule-viewer-switch="true"
      >
        <ViewerButton
          active={viewerKind === "3dmol"}
          onClick={() => setViewerKind("3dmol")}
        >
          3Dmol
        </ViewerButton>
        <ViewerButton
          active={viewerKind === "patinae"}
          disabled={!patinaeAllowed}
          title={
            patinaeAllowed
              ? t("molecule.viewer.patinae")
              : t("molecule.patinae.unavailable")
          }
          onClick={() => {
            setFallbackNotice(null);
            setViewerKind("patinae");
          }}
        >
          Patinae
        </ViewerButton>
      </div>

      {fallbackNotice && viewerKind === "3dmol" && (
        <div className="pointer-events-none absolute right-3 top-14 z-20 max-w-[70%] rounded-input border border-amber-500/30 bg-surface/95 px-3 py-2 text-xs text-muted shadow-card">
          {t("molecule.patinae.fallback", { message: fallbackNotice })}
        </div>
      )}
    </div>
  );
}

function ViewerButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "rounded px-2 py-1 text-xs font-medium transition-colors",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}
```

### 视觉冲突处理

当前 3Dmol Viewer 左上角已有 style 控件。查看器切换按钮应放在右上角，避免覆盖现有控件。Patinae 自己的 reset 按钮也放左上角。

---

## 9. 第五步：增加可复用命令控制器

为了让未来的 Agent、快捷键或其他面板可以控制当前查看器，建议第一阶段就增加一个很小的前端注册表，但暂时不接后端。

创建：

```text
frontend/src/lib/viewers/molecule-controller.ts
```

```ts
export interface MoleculeViewerController {
  id: string;
  filename: string;
  execute(command: string): Promise<unknown>;
}

type Listener = (controller: MoleculeViewerController | null) => void;

let activeController: MoleculeViewerController | null = null;
const listeners = new Set<Listener>();

export function registerActiveMoleculeViewer(
  controller: MoleculeViewerController,
): () => void {
  activeController = controller;
  emit();

  return () => {
    if (activeController?.id === controller.id) {
      activeController = null;
      emit();
    }
  };
}

export function getActiveMoleculeViewer(): MoleculeViewerController | null {
  return activeController;
}

export async function executeMoleculeViewerCommand(
  command: string,
): Promise<unknown> {
  if (!activeController) {
    throw new Error("No active molecule viewer");
  }
  return activeController.execute(command);
}

export function subscribeActiveMoleculeViewer(listener: Listener): () => void {
  listeners.add(listener);
  listener(activeController);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(activeController);
}
```

在 Patinae 初始化成功后注册：

```ts
const unregister = registerActiveMoleculeViewer({
  id: `patinae:${filename}`,
  filename,
  execute: (command) => viewer.executeAsync(command),
});
```

卸载时调用 `unregister()`。

注意：3Dmol 暂时不需要实现文本命令控制器。注册表应只在 Patinae 激活时存在。

---

## 10. 第六步：i18n 文案

必须同时修改：

```text
frontend/src/i18n/locales/en.json
frontend/src/i18n/locales/zh-Hans.json
```

建议英文：

```json
{
  "molecule.viewer.3dmol": "3Dmol viewer",
  "molecule.viewer.patinae": "Patinae viewer",
  "molecule.patinae.viewerLabel": "Interactive Patinae molecular viewer",
  "molecule.patinae.initializing": "Initializing Patinae WebGPU viewer…",
  "molecule.patinae.initializeFailed": "Patinae could not start: {{message}}",
  "molecule.patinae.unsupportedFormat": "This format is not supported by the Patinae preview.",
  "molecule.patinae.unavailable": "Patinae requires a supported format and WebGPU.",
  "molecule.patinae.fallback": "Patinae was unavailable; using 3Dmol instead. {{message}}",
  "molecule.patinae.commandLabel": "Patinae command",
  "molecule.patinae.commandPlaceholder": "Example: color green, chain A",
  "molecule.patinae.runCommand": "Run",
  "molecule.patinae.clearOutput": "Clear command output"
}
```

建议中文：

```json
{
  "molecule.viewer.3dmol": "3Dmol 查看器",
  "molecule.viewer.patinae": "Patinae 查看器",
  "molecule.patinae.viewerLabel": "Patinae 交互式分子查看器",
  "molecule.patinae.initializing": "正在初始化 Patinae WebGPU 查看器…",
  "molecule.patinae.initializeFailed": "Patinae 启动失败：{{message}}",
  "molecule.patinae.unsupportedFormat": "Patinae 预览暂不支持此格式。",
  "molecule.patinae.unavailable": "Patinae 需要受支持的格式和 WebGPU。",
  "molecule.patinae.fallback": "Patinae 不可用，已切换到 3Dmol。{{message}}",
  "molecule.patinae.commandLabel": "Patinae 命令",
  "molecule.patinae.commandPlaceholder": "例如：color green, chain A",
  "molecule.patinae.runCommand": "执行",
  "molecule.patinae.clearOutput": "清空命令输出"
}
```

Pi-Science 有 i18n coverage 测试，因此不能只修改一个语言文件。

---

## 11. 第七步：Vite 和 WASM 配置

### 11.1 手动分包

在 `frontend/vite.config.ts` 的 `manualChunks()` 中，放在通用 `node_modules` 分支之前：

```ts
if (
  id.includes("@patinae/viewer") ||
  id.includes("patinae_web") ||
  id.includes("patinae-viewer")
) return "vendor-patinae";
```

目标：

- 普通页面不加载 Patinae；
- 只有打开 Patinae 分子窗口时加载 JS/WASM；
- 不把 Patinae 合并进 `vendor-common`。

### 11.2 WASM 文件检查

生产构建后检查：

```bash
find frontend/dist -iname '*patinae*' -o -iname '*.wasm'
```

确认：

- `.wasm` 文件实际存在；
- JS 中的相对 URL 能解析到该文件；
- 静态服务器返回 `Content-Type: application/wasm`；
- 没有 404；
- 文件没有被错误内联成超大 base64 字符串。

### 11.3 COOP/COEP

Patinae 自己的开发服务器配置了：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

但是第一阶段不要未经测试就把这些头全局加到 Pi-Science，因为 `require-corp` 可能影响跨域图片、视频、iframe 或远程资源。

处理顺序：

1. 先不增加头，测试核心 Viewer。
2. 如果浏览器控制台明确报告 SharedArrayBuffer / cross-origin isolation 错误，再增加受环境变量控制的配置。
3. 增加后重新测试所有现有文件预览类型。


### 11.4 包体、懒加载和运行时预算

不要以开发模式网络请求判断 production 体积。完成构建后记录：

```bash
pnpm --filter frontend build

find frontend/dist -type f \
  \( -iname '*patinae*' -o -iname '*.wasm' \) \
  -exec ls -lh {} \;

du -ah frontend/dist | sort -h | tail -n 30
```

还要在浏览器中分别验证：

1. 打开普通聊天页：Patinae JS/WASM 请求数应为 0；
2. 打开 3Dmol 模式：Patinae JS/WASM 请求数仍应为 0；
3. 第一次切换 Patinae：才出现 Patinae chunk 和 WASM 请求；
4. 关闭 Inspector：`requestAnimationFrame` 不再持续，GPU/内存不应不断增长；
5. 重复打开和关闭 10 次：Canvas 数量、事件监听器和 Viewer 实例不能累积。

记录以下指标，但不要在没有测量时预设硬编码阈值：

- Patinae JavaScript chunk 的原始和 gzip 大小；
- `.wasm` 原始大小；
- 首次切换 Patinae 到可交互的耗时；
- 加载测试 PDB 的耗时；
- 关闭 Viewer 后的内存回落情况；
- `balanced` 与 `lite` 的兼容性差异。

若 bundle-budget 脚本把 Patinae 归入 `vendor-common` 或导致主入口超预算，必须修正分包；不得简单扩大预算掩盖回归。

---

## 12. 支持格式与默认策略

### 第一阶段 Patinae 文本格式

| 扩展名 | Patinae format | 默认策略 |
|---|---|---|
| `.pdb` | `pdb` | 大分子默认 Patinae |
| `.cif` | `cif` | 大分子默认 Patinae |
| `.mcif` | `cif` | 大分子默认 Patinae |
| `.mmcif` | `cif` | 大分子默认 Patinae |
| `.mol` | `mol` | 默认 3Dmol，可手动 Patinae |
| `.mol2` | `mol2` | 默认 3Dmol，可手动 Patinae |
| `.sdf` | `sdf` | 默认 3Dmol，可手动 Patinae |
| `.xyz` | `xyz` | 默认 3Dmol，可手动 Patinae |

### 第一阶段继续使用 3Dmol

| 扩展名 | 原因 |
|---|---|
| `.smi` / `.smiles` | 依赖现有 OpenChemLib 生成坐标/SDF |
| `.pqr` | Patinae README 未明确列为 Web 输入格式 |
| `.cube` | 第一阶段不引入体数据加载差异 |
| 未知格式 | 安全回退 |

### 第二阶段二进制格式

后续可增加：

- bCIF；
- gzip；
- CCP4/MRC；
- XTC/TRR；
- GRO。

这些格式不能继续通过当前 `text` 属性传递，需要修改 `previewPolicy` 和 `FilePreviewInspector` 以传入 `ArrayBuffer` / `Uint8Array`。

---

## 13. 推荐命令与验证样例

打开蛋白-配体复合物后，在命令栏依次测试：

```text
as cartoon
show sticks, organic
color cyan, polymer
color yellow, organic
select pocket, byres around 5 organic
show sticks, pocket
color green, pocket
zoom pocket
```

其他测试：

```text
hide cartoon, chain B
show surface, polymer
set transparency, 0.35
orient
center organic
```

不要把所有命令成功与否当作 PyMOL 100% 兼容证明。只验证本文列出的集成用例。

---

## 14. 测试要求

### 14.1 `patinae.test.ts`

至少覆盖：

```ts
expect(patinaeFormatFor("protein.pdb")).toBe("pdb");
expect(patinaeFormatFor("model.mmCIF")).toBe("cif");
expect(patinaeFormatFor("ligand.sdf")).toBe("sdf");
expect(patinaeFormatFor("ligand.pqr")).toBeNull();
expect(patinaeFormatFor("ligand.smiles")).toBeNull();
expect(patinaeObjectName("folder/My protein.pdb")).toBe("folder_My_protein");
expect(defaultViewerKind({
  filename: "protein.pdb",
  isMacromolecule: true,
  webGpuAvailable: true,
})).toBe("patinae");
expect(defaultViewerKind({
  filename: "protein.pdb",
  isMacromolecule: true,
  webGpuAvailable: false,
})).toBe("3dmol");
```

根据最终 `patinaeObjectName()` 实现调整带目录路径的预期；更推荐先取 basename，再清洗，避免把目录写入 object name。

### 14.2 Patinae 组件测试

通过 `vi.mock("@patinae/viewer")` 模拟类：

```ts
const executeAsync = vi.fn(async () => ({ messages: [] }));
const execute = vi.fn(() => ({ messages: [] }));
const loadData = vi.fn();
const destroy = vi.fn();
const on = vi.fn();
const countAtoms = vi.fn(() => 123);

vi.mock("@patinae/viewer", () => ({
  PatinaeViewer: class {
    on = on;
    init = vi.fn(async () => undefined);
    loadData = loadData;
    execute = execute;
    executeAsync = executeAsync;
    countAtoms = countAtoms;
    destroy = destroy;
  },
}));
```

至少验证：

- 初始化后调用 `loadData`；
- PDB 映射为 `pdb`；
- 初始命令被执行；
- 输入命令并按 Enter 会调用 `executeAsync`；
- 卸载时调用 `destroy`；
- 初始化 reject 时调用 `onUnavailable`；
- 文件变化时旧 viewer 被销毁并创建新 viewer。

### 14.3 选择容器测试

JSDOM 通常没有 `navigator.gpu`。测试中应显式 mock：

```ts
Object.defineProperty(navigator, "gpu", {
  configurable: true,
  value: {},
});
```

验证：

- WebGPU + PDB + 大分子 -> 默认 Patinae；
- 无 WebGPU -> 3Dmol；
- SMILES -> 3Dmol；
- Patinae `onUnavailable` -> 3Dmol；
- 手动切换只挂载一个子组件。

### 14.4 构建测试

执行：

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend build
```

构建后检查：

```bash
find frontend/dist -type f \( -name '*.wasm' -o -iname '*patinae*' \) -print
```

---

## 15. 手工验收矩阵

| 场景 | 预期 |
|---|---|
| Chrome/Edge + WebGPU + PDB | Patinae 可启动并默认显示 cartoon |
| Chrome/Edge + WebGPU + CIF | Patinae 可启动，atom count 非 0 |
| 无 WebGPU | Patinae 按钮禁用，3Dmol 正常 |
| Patinae WASM 404 | 显示回退提示，3Dmol 正常 |
| SMILES | 使用原有 3Dmol 流程 |
| 在 Patinae 输入 `color green, chain A` | 场景颜色改变 |
| 输入无效命令 | 输出区显示错误，应用不崩溃 |
| 重复切换 3Dmol/Patinae 10 次 | 无重复 Canvas、无明显内存持续增长 |
| 关闭文件 Inspector | Patinae RAF 和监听器被销毁 |
| 切换到另一个 PDB 文件 | 旧 viewer 销毁，新数据正确加载 |
| 深色/浅色主题 | 命令栏和按钮可读 |

---

## 16. 常见失败模式与处理

### 16.1 `@patinae/viewer` 无法安装

原因：包未发布或 registry 不可达。

处理：使用第 3.2 节的固定 commit tarball，不要改成不固定版本的 GitHub HEAD。

### 16.2 WASM 404

检查：

- tarball 是否包含 `dist` 和 `pkg`；
- Vite 输出中是否存在 `.wasm`；
- JS 相对路径是否指向正确位置；
- 静态服务器是否复制了全部 assets。

### 16.3 `navigator.gpu` 存在但初始化失败

可能原因：

- adapter 获取失败；
- GPU driver；
- 远程桌面或虚拟机；
- WebGPU 被策略禁用；
- 内存限制。

处理：捕获错误并自动回退，不要让整个 Inspector 进入 error boundary。

### 16.4 Canvas 黑屏

先确认：

- atom count 是否大于 0；
- 命令是否成功；
- Canvas 尺寸是否为 0；
- 浏览器控制台是否有 surface/WASM 错误；
- 使用的是固定 Patinae commit，包含 web alpha mode 修复。

### 16.5 viewer 在切换后仍消耗 GPU

说明 `destroy()` 没有执行或两个组件同时挂载。用 React DevTools 和 Performance 检查 RAF；修复卸载逻辑，不要只隐藏 Canvas。

### 16.6 COEP 导致其他预览器失败

撤销全局 `Cross-Origin-Embedder-Policy: require-corp`，先验证 Patinae 核心是否实际需要。必要时把 cross-origin isolation 做成明确的部署选项，而非默认行为。

---

## 17. 第二阶段：让 AI Agent 控制当前 Viewer

第一阶段完成后再实现。目标流程：

```text
Agent tool call
  -> Node control plane
  -> session SSE event
  -> React event handler
  -> executeMoleculeViewerCommand(command)
  -> PatinaeViewer.executeAsync(command)
```

### 17.1 建议事件合同

在 `packages/contracts/src/index.ts` 增加：

```ts
const viewerCommandEventSchema = z.object({
  type: z.literal("viewer.command"),
  sessionId: z.string(),
  requestId: z.string(),
  viewer: z.literal("molecule"),
  command: z.string().min(1).max(4000),
});
```

并加入 `sessionEventSchema` discriminated union。

### 17.2 前端处理

Session SSE 收到事件后：

```ts
if (event.type === "viewer.command" && event.viewer === "molecule") {
  await executeMoleculeViewerCommand(event.command);
}
```

执行结果应通过现有 tool status 或新的 acknowledgement API 返回给 Agent，避免 Agent 假设命令已执行。

### 17.3 Agent 命令安全策略

Agent 发出的命令和用户手动输入不能完全同权。建议第一版仅允许显示和分析类动词：

```text
show, hide, as, color, select,
zoom, center, orient,
enable, disable, label,
distance, angle, dihedral,
set（仅白名单设置）
```

默认阻止：

```text
load, fetch, save, png, ray,
任何插件命令或未知命令
```

原因：`load` / `fetch` 可触发网络访问，输出命令可能写文件或消耗较大资源。用户手动命令可以更宽松，但仍要显示错误。

### 17.4 建议 Agent tool 输入

```json
{
  "command": "select pocket, byres around 5 organic",
  "reason": "Highlight residues within 5 angstroms of the ligand"
}
```

不要让 Agent 直接传 JavaScript 或调用 WASM API。

---

## 18. 第二阶段：二进制和轨迹格式

当前 `previewPolicy("molecule")` 统一读取文本。要支持二进制格式，需要把加载策略从“按 PreviewKind”扩展成“按 filename/extension”。

建议：

1. 增加 `moleculeLoadModeFor(filename)`；
2. 文本格式读取 `text`；
3. 二进制格式读取 `bytes`；
4. `MoleculeView` props 扩展为：

```ts
type MoleculeSource =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: ArrayBuffer };
```

5. Patinae 使用：

```ts
viewer.loadData(
  source.kind === "text"
    ? new TextEncoder().encode(source.text)
    : new Uint8Array(source.bytes),
  objectName,
  format,
);
```

轨迹还需要拓扑与 trajectory 的组合加载，不能只把 XTC 当成独立分子文件。该部分需要单独设计 UI，不属于本次第一阶段。

---

## 19. 代码审查重点

审查者应重点检查：

1. 是否保留 3Dmol 和 SMILES 路径；
2. 是否真正使用 `loadData()`，而不是浏览器本地路径；
3. 是否固定依赖版本或 commit；
4. 是否按需加载 Patinae；
5. 是否调用 `destroy()`；
6. 是否存在异步卸载后的 setState；
7. 是否只挂载一个 viewer；
8. 是否有 WebGPU 和初始化失败回退；
9. 是否同时更新中英文 i18n；
10. 是否测试了 WASM 产物；
11. 是否避免全局 COEP 回归；
12. 是否把 Agent 控制延后或做了严格命令白名单；
13. 是否只引入 `@patinae/viewer`，没有加入桌面/Python/native 插件依赖；
14. 普通页面和 3Dmol 模式是否不会加载 Patinae JS/WASM；
15. 是否记录了 production chunk/WASM 大小与首次初始化测量，而不是写未经验证的体积数字。

---

## 20. 最终提交说明模板

编码模型完成后应输出类似：

```text
Implemented Patinae as an optional molecular viewer in Pi-Science.

Changes:
- Preserved existing 3Dmol viewer as fallback and SMILES renderer.
- Added lazy-loaded Patinae WebGPU/WASM viewer.
- Added viewer switch, command input, history and command output.
- Added WebGPU/format gating and automatic fallback.
- Added i18n strings and unit/component tests.
- Added a separate Vite chunk for Patinae assets.
- Integrated only `@patinae/viewer`; no native desktop, Python/Jupyter or native plugin runtime was added.

Validation:
- pnpm --filter frontend typecheck: PASS/FAIL
- pnpm --filter frontend test: PASS/FAIL
- pnpm --filter frontend build: PASS/FAIL
- WASM asset found in frontend/dist: YES/NO
- Patinae loaded on ordinary routes: YES/NO (expected NO)
- Patinae JS chunk size: <measured value>
- Patinae WASM size: <measured value>
- First interactive initialization: <measured value>

Known limitations:
- Agent-to-viewer command bridge not included.
- Binary density/trajectory formats not included.
- Patinae remains an alpha dependency; 3Dmol fallback retained.
```

如果任何命令失败，应附错误和未完成项，不得用模糊措辞掩盖。

---

## 21. 验收结论

本次第一阶段完成后，Pi-Science 应获得：

- 一个嵌入现有文件 Inspector 的 Patinae WebGPU 分子窗口；
- PyMOL 风格文本命令控制；
- 结构选取和命令输出；
- 3Dmol 安全后备；
- 可扩展到 Agent 控制的前端命令控制器；
- 不改变现有 Node/Python 科学计算架构；
- 只增加 `@patinae/viewer` Web 运行时，不携带桌面、Python/Jupyter 或 native plugin 模块；
- Patinae 只在用户进入高级分子查看模式时加载，不增加普通页面的首屏运行成本。

这是一条低侵入、可回滚的集成路线。不要把第一阶段扩大成“完整替换 PyMOL、3Dmol 或 Mol*”。先证明 Viewer 生命周期、WASM 构建、命令控制和回退可靠，再进入 Agent 桥接和二进制结构数据支持。
