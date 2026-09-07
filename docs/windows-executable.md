# Windows 单文件版

**[下载 Windows x64 · v0.1.1-preview.20260907](https://github.com/shank000/multiagent-town/releases/download/v0.1.1-preview.20260907/MultiagentTown-Windows-x64.zip)** · [发布页与校验文件](https://github.com/shank000/multiagent-town/releases/tag/v0.1.1-preview.20260907)

可执行文件内置 Node.js 22、研究控制台、选择性世界服务与许可素材，无需安装 Node.js 或 pnpm。模型权重和 Ollama 本身单独安装，不包含在 EXE 内。

这是协作测试版，不是已通过研究验收的正式版本。当前对话审校可能误拒正常发言或漏判错误内容，会话可能异常结束；详细数据见[对话连续性验收](dialogue-continuity-validation.md)。启动通过不代表对话逻辑正确或长期运行稳定性已获保证。

## 协作者使用

1. 使用 Windows 10/11 x64，安装 Windows 本地版 [Ollama](https://ollama.com/download/windows)。建议 16 GB 内存并预留至少 8 GB 空间；CPU 推理可用但可能较慢。
2. 下载 ZIP 并完整解压到自己的文件夹，双击 `MultiagentTown.exe`，无需管理员权限。
3. 首次运行等待 `qwen3:4b` 和 `qwen3:4b-instruct` 准备完成，模型下载约 5 GB；模型已齐备时无需重复下载。
4. 在自动打开的浏览器中使用研究控制台，保持启动窗口运行。
5. 结束前导出重要实验数据，在启动窗口按 `Ctrl+C` 安全退出。直接关闭窗口、断电或强制结束进程可能丢失尚在内存中的状态。

程序未配置代码签名证书，Windows 可能显示“未知发布者”。请核对来源与 SHA-256，不要关闭系统安全保护；组织设备可由管理员审核后使用。模型在本机推理，不需要登录 Ollama 云服务。手动在 UI 配置外部 API 后，相应模型请求会发送到所配置的服务。

## 工作空间与数据

每次启动创建一个全新的单世界实验，旧实验数据保留，但 EXE 当前不会自动续跑旧实验。界面左侧“新建实验工作空间”可以选择一个、两个或三个世界，各自使用独立 SQLite 数据库。

默认数据目录为 `%LOCALAPPDATA%\MultiagentTown\runs`；同目录 `town-….runtime.jsonl` 保存后端日志。顶栏“后端日志”可筛选与导出日志，诊断日志写入前会对敏感凭据脱敏。界面资源保存在 `%LOCALAPPDATA%\MultiagentTown\runtime`，按内容版本隔离并在启动时校验缓存内容。

默认端口为 8898；端口占用时在后续 20 个端口中自动选择。请以启动窗口显示并自动打开的地址为准。仅监听本机回环地址。

## 版本与校验

发布包包含 EXE、使用说明、素材署名、对话验收记录、`build-info.json` 和 EXE 的 SHA-256；发布页同时提供 ZIP 的 SHA-256。

```powershell
Get-FileHash .\MultiagentTown-Windows-x64.zip -Algorithm SHA256
Get-FileHash .\MultiagentTown.exe -Algorithm SHA256
.\MultiagentTown.exe --version
```

`--version` 显示版本、源码提交与构建时间，不启动模型或实验。

## 维护者构建与验证

在 Windows x64、Node.js 22 环境下：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build:windows --release
```

发布构建要求干净的 Git 工作区，输出 `dist\releases\<package.json版本>\MultiagentTown-Windows-x64.zip`。已有同版本发布包时构建会停止；调整版本后可构建独立新包。EXE 与 ZIP 使用 GitHub Release 附件分发，不进入 Git 历史。临时构建目录使用独立名称，旧发布包保持可用。

真实模型冒烟使用已安装模型与独立测试目录：

```powershell
.\MultiagentTown.exe --smoke --no-browser --no-download --data-dir "D:\TownChecks\run1" --port 18998
```

检查实际本地模型结构化输出、单世界六居民快照和安全退出。`SMOKE_OK real_model=true worlds=1 agents_per_world=6 selective_loading=true` 表示封装启动链路通过，不等于完整对话验收。`--no-download` 在模型缺失时给出明确错误。`OLLAMA_MODEL`、`OLLAMA_SMALL_MODEL` 和 `OLLAMA_AGENT_MODELS` 可指定已安装模型；这些配置只影响本次进程。
