# Windows 单文件版

Windows x64 单文件版面向不使用命令行、未安装 Node.js 或 pnpm 的协作者。可执行文件内置 Node.js 22、研究控制台、选择性世界服务与全部许可素材，运行时固定连接 `127.0.0.1:11434` 上的本地 Ollama。

## 协作者使用

1. 安装 Windows 本地版 [Ollama](https://ollama.com/download/windows)。
2. 双击 `MultiagentTown.exe`。
3. 首次运行等待 `qwen3:4b` 和 `qwen3:4b-instruct` 准备完成。
4. 在自动打开的浏览器中使用研究控制台；关闭启动窗口结束本次运行。

每次运行默认在 `%LOCALAPPDATA%\MultiagentTown\runs` 创建只含关系记忆开启组的单世界工作空间及独立 `town-….runtime.jsonl`。右栏“新建小镇”可按名称、种子、速度、实验天数和 1–3 个世界模板创建下一工作空间；每个已选世界使用独立 SQLite，旧数据库与日志完整保留。研究控制台顶栏的“后端日志”可实时筛选、复制路径并保存完整日志；敏感凭据写入前统一脱敏。界面资源按内容版本释放到 `%LOCALAPPDATA%\MultiagentTown\runtime`。默认端口为 8898；端口占用时会在后续 20 个端口中自动选择。

## 维护者构建

```powershell
pnpm install --frozen-lockfile
pnpm build:windows
```

输出目录：`dist\MultiagentTown-Windows-x64`，并生成可直接发布的 `dist\MultiagentTown-Windows-x64.zip` 及两级 SHA-256 校验文件。构建主机应为 Windows x64，并使用项目要求的 Node.js 22。可执行文件属于本地构建产物，不进入 Git 历史；对外发布时使用 GitHub Release 附件。

可执行文件级真实模型冒烟：

```powershell
dist\MultiagentTown-Windows-x64\MultiagentTown.exe --smoke --no-browser
```

检查会调用一次本地 Qwen3 结构化推理，然后启动默认单世界、读取六居民快照并安全退出。输出 `SMOKE_OK real_model=true worlds=1 agents_per_world=6 selective_loading=true` 表示封装与选择性加载链路通过。
