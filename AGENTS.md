# InfinityLoop 项目专属规则

本项目继承 Codex 已加载的全局 `AGENTS.md`（本机：`C:\Users\freez\.codex\AGENTS.md`）；以下保留项目专属规则。

- 本项目是 Tauri 桌面应用，前端入口在根目录，Rust/Tauri 代码在 `src-tauri`，背景资源位于 `BackGroudPics`。
- 开发命令为 `npm run dev`；获得构建授权后使用项目已有的 `npm run build:exe`，该脚本会调用 `scripts/build-release.ps1`。
- 不要绕过项目的 Release 脚本直接把裸 Cargo 产物当作交付物。
- 项目没有预设的 `D:\@Software` 映射时，不要擅自复制或覆盖其他目录；先核对项目配置和用户要求。
- 播放记录在 `playback-memory.js`，原生加载/快照/属性身份校验在 `src-tauri/src/playback.rs`。时间保存和异步控制必须核对实际媒体 ID 与加载代次，不能以当前列表索引代替；隔离检查使用 `node scripts/check-playback.cjs`。
- 现有 `libmpv-wrapper` 使用 `mpv_command` 的字符串参数接口，`loadfile` 第四参数必须传 `start=秒数,pause=yes/no` 等选项字符串，不能传 JSON 对象。`cargo test --release --lib` 中的 `playback_ffi_tests.rs` 会调用随项目交付的 DLL，使用自建视频和无窗口、无音频的隔离内核验证加载、续播和暂停；不启动应用或读取用户视频。
- `vendor/tauri-plugin-libmpv` 固定为原 0.3.2 的本地源码修补，由 Cargo patch 引用。其事件按原生顺序转发，窗口关闭生命周期由本项目处理；维护或升级时先读 `INFINITYLOOP_PATCHES.md` 并保留这两项行为。

## 构建与共享缓存约束

- 依赖安装、编译检查或打包前，必须主动读取并遵守 D:\MyCodes\@UploadToGithub\AGENTS.md（共享规则），不依赖仓库外父目录自动加载；本项目已有的构建入口、交付方式及更严格限制继续适用。
- Windows 最终 Release 构建须有“11”“构建”“打包”等明确授权，并使用本项目既有正式入口；普通修改只做已允许的必要检查，前端构建或编译检查不等于最终打包授权。构建授权不自动包含启动 GUI、安装或发布。
- 使用 npm、pip、uv 时，下载缓存分别使用 E:\BuildCaches\npm、E:\BuildCaches\pip、E:\BuildCaches\uv，不改回 C 盘或重建旧入口。其他工具沿用已确认的有效位置；BUILD_CACHE_PLAN.md 中尚未实施的规划不视为已迁移。不同工具使用各自缓存子目录。
- 执行前核对工具实际缓存配置及当前进程环境，特别是 GRADLE_USER_HOME、CARGO_HOME、RUSTUP_HOME、APPDATA、LOCALAPPDATA；继承异常时，只为当前命令补齐经核实的现有配置，不擅改全局环境、迁移缓存或新建替代缓存目录。
- 复用现有依赖和增量编译缓存；只有依赖变化、缺失或确认损坏时才处理对应部分，不盲目重装全部依赖、清缓存或全量重建。不执行 cargo clean，不擅删有效 Gradle/Release 缓存；node_modules、.venv、项目 .gradle 和编译输出继续按项目隔离。
- 只执行本次任务必要的检查，不顺带构建其他项目或无关模块；通过后没有新修改或新问题，不重复全量检查。较大下载或构建前核对源码、缓存及产物所在盘的可用空间和实际输出路径，空间不足先说明，不靠清空有效缓存解决。
- 历史正式打包副本只保留最近一次成功且验证完整的版本，固定交付位置的当前版本另行保留；新版验证并交付成功后再按共享规则及本项目清理例外处理旧副本，失败保留上一成功版本。源码、用户修改、运行数据和有效构建缓存不属于历史副本。
