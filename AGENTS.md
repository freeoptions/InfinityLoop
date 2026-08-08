# InfinityLoop 项目专属规则

通用规则见：`E:\@imFile-Download\AI-Useful-Prompt\通用开发工作规则.md`。

- 本项目是 Tauri 桌面应用，前端入口在根目录，Rust/Tauri 代码在 `src-tauri`，背景资源位于 `BackGroudPics`。
- 开发命令为 `npm run dev`；获得构建授权后使用项目已有的 `npm run build:exe`，该脚本会调用 `scripts/build-release.ps1`。
- 不要绕过项目的 Release 脚本直接把裸 Cargo 产物当作交付物。
- 项目没有预设的 `D:\@Software` 映射时，不要擅自复制或覆盖其他目录；先核对项目配置和用户要求。
