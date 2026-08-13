# HTML 渲染验证记录

验证日期：2026-08-14

## Automated quality gate

- `npm --prefix frontend run check`：通过，0 errors / 0 warnings。
- `npm --prefix frontend run lint`：通过，0 errors / 0 warnings。
- `npm --prefix frontend run test`：通过，30 test files、417 tests。
- `npm --prefix frontend run build`：通过，Vite 生产构建成功。
- `make check-frontend`：通过（项目当前目标执行 check + lint）。
- `git diff --check`：通过。

## Security and behavior coverage

自动化测试覆盖：

- 正文静态 HTML 标签和 style 声明白名单；
- script、iframe、form、img、SVG、事件属性及危险 style 清除；
- 普通 HTML 与 KaTeX style sanitizer 来源隔离；
- Markdown 根的 layout/paint containment 与 overflow clipping；
- HTML/CSS/JavaScript 语言及 HTML-like fallback 提取；
- 多 fenced block 顺序、普通代码排除、未闭合 fence 保持不可执行；
- HTML/CSS/JavaScript preview document、首个 CSP、主题快照和 script/style 关闭序列转义；
- iframe 精确 `sandbox="allow-scripts"`、无 `allow-same-origin`、`no-referrer` 和 denied Permissions Policy；
- fenced block 与整条 HTML-like 消息的真实 DOM 预览按钮；
- 流式 transient Markdown 抑制复制与预览操作；
- workspace 预览/源码、关闭和多 artifact 选择。

## Bundle measurement

实施前：

- JS：467.30 kB raw / 146.60 kB gzip
- CSS：64.96 kB raw / 14.10 kB gzip
- 初始 JS + CSS：160.70 kB gzip

实施后：

- JS：484.30 kB raw / 152.55 kB gzip
- CSS：68.71 kB raw / 14.67 kB gzip
- 初始 JS + CSS：167.22 kB gzip

增量：

- JS：+17.00 kB raw / +5.95 kB gzip
- CSS：+3.75 kB raw / +0.57 kB gzip
- 合计：+6.52 kB gzip

仍低于项目 250 kB 初始 JS + CSS 目标。未新增 npm 运行时依赖。

## Manual/browser deferred checks

本会话未运行真实 Safari/iOS Safari 手工检查。发布前仍应在真实浏览器验证：

- iframe CSP/sandbox 对 inline JavaScript 的执行和网络阻断；
- 桌面 pointer resize、键盘方向键和双击复位；
- 移动端覆盖面板、关闭后的焦点恢复和软件键盘；
- 恶意 fixed/z-index/transform/100vw 正文不能越过消息裁剪区域；
- 下载 Blob URL 行为。
