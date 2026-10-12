# InfinityLoop 本地修补

来源：crates.io `tauri-plugin-libmpv 0.3.2`，上游 https://github.com/nini22P/tauri-plugin-libmpv 。保留原 MPL-2.0 LICENSE；未升级依赖版本。

- `src/desktop.rs`：原生回调直接按顺序发出事件，避免每个事件单独 spawn 造成 `start-file` / `file-loaded` 顺序反转。事件监听只更新短小的身份状态，不在回调里查询 mpv 属性。
- `src/lib.rs`：移除插件自带的 CloseRequested 销毁及再次 close；主项目负责关闭隐藏、托盘退出前保存和显式 destroy。

源码通过 `src-tauri/Cargo.toml` 的 crates.io patch 使用。后续升级插件时必须重新核对这两项行为，不能直接删除补丁。
