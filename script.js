// ====== 实例 ID 管理 ======
// 自动生成唯一ID，实现数据隔离
// 基于当前页面的完整URL生成唯一标识
function getInstanceIdFromFilename() {
    // 获取当前页面的完整路径
    const fullPath = window.location.href;

    // 使用完整路径编码作为唯一标识，截取足够长的部分确保不冲突
    // 使用100个字符确保不同路径不会产生相同的哈希值
    const pathHash = btoa(fullPath).replace(/[+/=]/g, '').substring(0, 100);

    // 生成唯一的存储key（基于路径hash）
    const storageKey = `instance_id_${pathHash}`;

    // 尝试从 localStorage 读取这个路径对应的 ID
    let instanceId = localStorage.getItem(storageKey);

    if (!instanceId) {
        // 首次打开这个路径，生成新的随机 ID
        const randomStr = Math.random().toString(36).substring(2, 10);
        const timestamp = Date.now().toString(36);
        instanceId = `vp_${pathHash.substring(0, 8)}_${timestamp}`;

        // 保存到 localStorage
        localStorage.setItem(storageKey, instanceId);
        console.log('✅ 生成新实例ID:', instanceId);
    } else {
        console.log('✅ 使用已保存的实例ID:', instanceId);
    }

    return instanceId;
}

const INSTANCE_ID = getInstanceIdFromFilename();

// 带前缀的 localStorage 辅助函数
const storage = {
    setItem: (key, value) => localStorage.setItem(`${INSTANCE_ID}_${key}`, value),
    getItem: (key) => localStorage.getItem(`${INSTANCE_ID}_${key}`),
    removeItem: (key) => localStorage.removeItem(`${INSTANCE_ID}_${key}`)
};

// 状态管理
const state = {
    videos: [],           // 所有视频文件
    playlist: [],         // 当前播放列表（可能经过打乱）
    currentIndex: 0,      // 当前视频索引
    isPlaying: false,
    isReshuffling: false, // 是否正在洗牌中
    lastReshuffleTime: 0, // 上次洗牌的时间戳
    boundaryCooldown: 0,  // 边界冷却时间戳
    lastWheelNavigation: 0,
    folderHandle: null,   // 文件夹句柄
    includeSubfolders: true, // 是否包含子文件夹
    options: {
        shuffle: true,
        autoPlay: true,
        loopSingle: false
    }
};

// DOM 元素
const elements = {
    homePage: document.getElementById('home-page'),
    playerPage: document.getElementById('player-page'),
    includeSubfolders: document.getElementById('include-subfolders'),
    videoContainer: document.getElementById('video-container'),
    videoCount: document.getElementById('video-count'),
    backBtn: document.getElementById('back-btn'),
    playlist: document.getElementById('playlist'),
    playlistContent: document.getElementById('playlist-content'),
    closePlaylist: document.getElementById('close-playlist'),
    controls: document.getElementById('controls'),
    loading: document.getElementById('loading'),
    progressWrapper: document.getElementById('progress-wrapper'),
    progressBar: document.getElementById('progress-bar'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    continueWatching: document.getElementById('continue-watching'),
    continueBtn: document.getElementById('continue-btn'),
    continueFolderName: document.getElementById('continue-folder-name'),
    reshuffleBtn: document.getElementById('reshuffle-btn'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    videoInfoBar: document.getElementById('video-info-bar'),
    infoName: document.getElementById('info-name'),
    infoSize: document.getElementById('info-size'),
    tipText: document.getElementById('tip-text'),
    addVideoFolder: document.getElementById('add-video-folder'),
    addVideoGroup: document.getElementById('add-video-group'),
    commonVideoFolders: document.getElementById('common-video-folders'),
    configureWallpaperFolder: document.getElementById('configure-wallpaper-folder'),
    wallpaperFolderSummary: document.getElementById('wallpaper-folder-summary'),
    wallpaperInterval: document.getElementById('wallpaper-interval'),
    configureMoveFolder: document.getElementById('configure-move-folder'),
    addMoveGroup: document.getElementById('add-move-group'),
    moveFolderSummary: document.getElementById('move-folder-summary'),
    deleteCurrentVideo: document.getElementById('delete-current-video'),
    moveTargetActions: document.getElementById('move-target-actions'),
    folderAliasModal: document.getElementById('folder-alias-modal'),
    folderAliasTitle: document.getElementById('folder-alias-title'),
    folderAliasPath: document.getElementById('folder-alias-path'),
    folderAliasInputLabel: document.getElementById('folder-alias-input-label'),
    folderAliasInput: document.getElementById('folder-alias-input'),
    folderAliasGroupLabel: document.getElementById('folder-alias-group-label'),
    folderAliasGroup: document.getElementById('folder-alias-group'),
    folderAliasClose: document.getElementById('folder-alias-close'),
    folderAliasCancel: document.getElementById('folder-alias-cancel'),
    folderAliasConfirm: document.getElementById('folder-alias-confirm')
};

// Tauri 桌面桥接。浏览器模式仍然保留，方便继续预览界面；Windows 版本将播放交给 mpv。
const isDesktopApp = Boolean(window.__TAURI__?.core?.invoke);
const MPV_WINDOW_LABEL = 'main';
const desktopState = {
    mode: 'idle',
    started: false,
    eventReady: null,
    lastSurfaceRect: '',
    lastError: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    filename: '',
    codec: '',
    format: '',
    hwdec: '',
    videoWidth: 0,
    videoHeight: 0,
    videoDisplayWidth: 0,
    videoDisplayHeight: 0,
    pendingVideoWidth: 0,
    pendingVideoHeight: 0,
    pendingVideoDisplayWidth: 0,
    pendingVideoDisplayHeight: 0,
    tracks: [],
    fullscreen: false,
    surfaceSyncFrame: 0,
    lastProgressPaint: 0,
    navigationRequest: 0,
    endHandled: false,
    navigationChain: Promise.resolve(),
    playbackLogChain: Promise.resolve()
};

function invokeDesktop(command, args = {}) {
    if (!isDesktopApp) {
        return Promise.reject(new Error('当前不是 Windows 桌面模式'));
    }
    return window.__TAURI__.core.invoke(command, args);
}

function describePlaybackFile(path = '') {
    const video = state.playlist[state.currentIndex];
    const filePath = String(path || video?.path || desktopState.filename || '');
    const name = String(video?.name || filePath.split(/[\\/]/).pop() || '');
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return {
        path: filePath,
        name,
        extension,
        size: Number(video?.size) || 0,
        lastModified: Number(video?.lastModified) || 0
    };
}

function queuePlaybackLog(event, details = {}, path = '') {
    if (!isDesktopApp) return;

    const entry = {
        time: new Date().toISOString(),
        event,
        mode: desktopState.mode,
        index: state.currentIndex,
        total: state.playlist.length,
        requestId: desktopState.navigationRequest,
        file: describePlaybackFile(path),
        ...details
    };

    let message;
    try {
        message = JSON.stringify(entry);
    } catch (error) {
        message = JSON.stringify({
            time: new Date().toISOString(),
            event: 'diagnostic-log-serialization-error',
            error: String(error)
        });
    }

    desktopState.playbackLogChain = desktopState.playbackLogChain
        .catch(() => {})
        .then(() => invokeDesktop('write_playback_log', { message }))
        .catch(error => console.debug('写入播放器诊断日志失败:', error));
}

function sendDesktopCommand(command) {
    if (!desktopState.started) return Promise.resolve();
    const [name, ...rawArgs] = command;
    const args = rawArgs.map(value => {
        if (value === 'yes') return true;
        if (value === 'no') return false;
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
            return Number(value);
        }
        return value;
    });
    const invokeName = name === 'set_property'
        ? 'plugin:libmpv|set_property'
        : 'plugin:libmpv|command';
    const invokeArgs = name === 'set_property'
        ? { name: args[0], value: args[1], windowLabel: MPV_WINDOW_LABEL }
        : { name, args, windowLabel: MPV_WINDOW_LABEL };
    return invokeDesktop(invokeName, invokeArgs).catch(error => {
        console.error('mpv 命令失败:', command, error);
        queuePlaybackLog('command-error', {
            command,
            error: String(error)
        });
        if (desktopState.lastError !== String(error)) {
            desktopState.lastError = String(error);
            showToast('播放器内核通信失败');
        }
        throw error;
    });
}

function describeMpvError(error) {
    const code = Number(error);
    const descriptions = {
        [-13]: '文件加载失败',
        [-16]: '没有找到可播放的音视频流',
        [-17]: '文件格式无法识别，或文件内容已损坏/不完整',
        [-18]: '当前系统不满足播放器要求'
    };
    return descriptions[code]
        ? `${descriptions[code]}（错误码 ${code}）`
        : `播放器错误 ${String(error)}`;
}

function queueDesktopNavigation(index) {
    const requestId = ++desktopState.navigationRequest;
    // 一个文件结束时，end-file 和 eof-reached 可能连续到达；切换到新文件后允许新一轮结束检测。
    desktopState.endHandled = false;
    const job = desktopState.navigationChain
        .catch(() => {})
        .then(() => {
            if (requestId !== desktopState.navigationRequest || !desktopState.started) return;
            const video = state.playlist[index];
            if (!video?.path) throw new Error('当前媒体缺少文件路径');
            return desktopPlayer.loadFile(video.path);
        });

    desktopState.navigationChain = job.catch(() => {});
    job.catch(error => console.error('mpv 切换失败:', error));
    return requestId;
}

function queueDesktopPlay(requestId) {
    const job = desktopState.navigationChain
        .catch(() => {})
        .then(() => {
            if (requestId !== desktopState.navigationRequest || !desktopState.started) return;
            return desktopPlayer.play();
        });

    desktopState.navigationChain = job.catch(() => {});
    job.catch(error => console.error('mpv 播放失败:', error));
}

const desktopPlayer = {
    get paused() {
        return desktopState.paused;
    },
    get currentTime() {
        return Number.isFinite(desktopState.currentTime) ? desktopState.currentTime : 0;
    },
    set currentTime(value) {
        const nextTime = Math.max(0, Number(value) || 0);
        desktopState.currentTime = nextTime;
        sendDesktopCommand(['set_property', 'time-pos', String(nextTime)]).catch(() => {});
    },
    get duration() {
        return desktopState.duration;
    },
    set loop(value) {
        sendDesktopCommand(['set_property', 'loop-file', value ? 'yes' : 'no']).catch(() => {});
    },
    play() {
        desktopState.paused = false;
        state.isPlaying = true;
        updatePlayPauseButton();
        return sendDesktopCommand(['set_property', 'pause', 'no']);
    },
    pause() {
        desktopState.paused = true;
        state.isPlaying = false;
        updatePlayPauseButton();
        return sendDesktopCommand(['set_property', 'pause', 'yes']);
    },
    requestFullscreen() {
        if (isDesktopApp) {
            desktopState.fullscreen = !desktopState.fullscreen;
            return invokeDesktop('set_fullscreen', { fullscreen: desktopState.fullscreen })
                .then(scheduleDesktopSurfaceSync);
        }
        const target = elements.playerPage || document.documentElement;
        return target.requestFullscreen?.() || Promise.resolve();
    },
    loadFile(path) {
        if (!desktopState.started || !path) return Promise.resolve();
        queuePlaybackLog('load-request', {
            command: ['loadfile', 'replace']
        }, path);
        return sendDesktopCommand(['loadfile', path, 'replace']);
    },
};

function getTauriPayload(event) {
    return event && Object.prototype.hasOwnProperty.call(event, 'payload') ? event.payload : event;
}

// 壁纸位于 WebView 上层，而 libmpv 画面位于透明窗口下层；根据视频比例挖出中间透明区域，避免壁纸遮挡视频。
function updateDesktopVideoMask() {
    if (!isDesktopApp) return;

    // video-params 是源文件像素尺寸，可能未包含像素宽高比；遮罩必须优先使用
    // mpv 最终输出到窗口的 display width/height，否则视频和透明挖空区域会错开，
    // 两侧就会露出透明窗口的黑底。
    const width = Number(desktopState.videoDisplayWidth || desktopState.videoWidth);
    const height = Number(desktopState.videoDisplayHeight || desktopState.videoHeight);
    const viewportWidth = Math.max(1, window.innerWidth);
    // libmpv 直接渲染到透明主窗口，视频实际占用整块客户区；顶部标题栏和底部控件是覆盖层，不能从遮罩计算中扣除。
    const viewportHeight = Math.max(1, window.innerHeight);

    if (!(width > 0) || !(height > 0)) {
        document.documentElement.style.setProperty('--desktop-video-left', '0px');
        document.documentElement.style.setProperty('--desktop-video-right', '100%');
        return;
    }

    const fittedWidth = Math.min(viewportWidth, viewportHeight * (width / height));
    const left = Math.max(0, Math.round((viewportWidth - fittedWidth) / 2));
    const right = Math.min(viewportWidth, Math.round(viewportWidth - left));
    document.documentElement.style.setProperty('--desktop-video-left', `${left}px`);
    document.documentElement.style.setProperty('--desktop-video-right', `${right}px`);
}

function handleDesktopProperty(payload) {
    const name = payload?.name;
    const value = payload?.value;
    if (!name) return;

    switch (name) {
        case 'time-pos':
            desktopState.currentTime = Number.isFinite(Number(value)) ? Number(value) : 0;
            if (performance.now() - desktopState.lastProgressPaint >= 100) {
                desktopState.lastProgressPaint = performance.now();
                updateProgress(desktopPlayer);
            }
            break;
        case 'duration':
            desktopState.duration = Number.isFinite(Number(value)) ? Number(value) : NaN;
            updateProgress(desktopPlayer);
            break;
        case 'pause':
            desktopState.paused = Boolean(value);
            state.isPlaying = !desktopState.paused;
            updatePlayPauseButton();
            break;
        case 'eof-reached':
            if (Boolean(value)) {
                scheduleDesktopNext();
            }
            break;
        case 'filename':
            desktopState.filename = String(value || '');
            // 切换文件时保留上一帧的遮罩，等待新的宽高都到齐后一次性更新，避免背景闪烁。
            desktopState.pendingVideoWidth = 0;
            desktopState.pendingVideoHeight = 0;
            desktopState.pendingVideoDisplayWidth = 0;
            desktopState.pendingVideoDisplayHeight = 0;
            break;
        case 'video-codec':
            desktopState.codec = String(value || '');
            break;
        case 'video-format':
            desktopState.format = String(value || '');
            break;
        case 'hwdec-current':
            desktopState.hwdec = String(value || '');
            break;
        case 'track-list':
            desktopState.tracks = Array.isArray(value) ? value : [];
            break;
        case 'video-params/w':
            desktopState.pendingVideoWidth = Number(value) || 0;
            if (desktopState.pendingVideoWidth > 0 && desktopState.pendingVideoHeight > 0
                && !(desktopState.pendingVideoDisplayWidth > 0 && desktopState.pendingVideoDisplayHeight > 0)
                && !(desktopState.videoDisplayWidth > 0 && desktopState.videoDisplayHeight > 0)) {
                desktopState.videoWidth = desktopState.pendingVideoWidth;
                desktopState.videoHeight = desktopState.pendingVideoHeight;
                updateDesktopVideoMask();
            }
            break;
        case 'video-params/h':
            desktopState.pendingVideoHeight = Number(value) || 0;
            if (desktopState.pendingVideoWidth > 0 && desktopState.pendingVideoHeight > 0
                && !(desktopState.pendingVideoDisplayWidth > 0 && desktopState.pendingVideoDisplayHeight > 0)
                && !(desktopState.videoDisplayWidth > 0 && desktopState.videoDisplayHeight > 0)) {
                desktopState.videoWidth = desktopState.pendingVideoWidth;
                desktopState.videoHeight = desktopState.pendingVideoHeight;
                updateDesktopVideoMask();
            }
            break;
        case 'video-out-params/dw':
            desktopState.pendingVideoDisplayWidth = Number(value) || 0;
            if (desktopState.pendingVideoDisplayWidth > 0 && desktopState.pendingVideoDisplayHeight > 0) {
                desktopState.videoDisplayWidth = desktopState.pendingVideoDisplayWidth;
                desktopState.videoDisplayHeight = desktopState.pendingVideoDisplayHeight;
                updateDesktopVideoMask();
            }
            break;
        case 'video-out-params/dh':
            desktopState.pendingVideoDisplayHeight = Number(value) || 0;
            if (desktopState.pendingVideoDisplayWidth > 0 && desktopState.pendingVideoDisplayHeight > 0) {
                desktopState.videoDisplayWidth = desktopState.pendingVideoDisplayWidth;
                desktopState.videoDisplayHeight = desktopState.pendingVideoDisplayHeight;
                updateDesktopVideoMask();
            }
            break;
        default:
            break;
    }
}

function isNaturalDesktopEnd(reason) {
    // 不同 libmpv/插件版本可能把 EOF 原因传成字符串或 0。
    return reason === 'eof'
        || reason === 'eof-reached'
        || reason === 0
        || reason === '0';
}

function scheduleDesktopNext() {
    if (
        desktopState.endHandled
        || desktopState.mode !== 'mpv'
        || !desktopState.started
        || !state.options.autoPlay
        || state.options.loopSingle
    ) {
        return;
    }

    desktopState.endHandled = true;
    const finishedIndex = state.currentIndex;
    const requestId = desktopState.navigationRequest;
    const finishedFilename = desktopState.filename;
    setTimeout(() => {
        if (
            desktopState.mode === 'mpv'
            && desktopState.started
            && state.options.autoPlay
            && !state.options.loopSingle
            && state.currentIndex === finishedIndex
            && desktopState.navigationRequest === requestId
            && (!finishedFilename || !desktopState.filename || desktopState.filename === finishedFilename)
        ) {
            playNext();
        }
    }, 0);
}

function handleDesktopInput(args) {
    if (!Array.isArray(args) || args.length === 0) return;

    switch (args[0]) {
        case 'infinity-loop-wheel-up':
            navigateByWheel(-1);
            break;
        case 'infinity-loop-wheel-down':
            navigateByWheel(1);
            break;
        case 'infinity-loop-prev':
            playPrev();
            break;
        case 'infinity-loop-next':
            playNext();
            break;
        case 'infinity-loop-first':
            jumpToVideo(0);
            break;
        case 'infinity-loop-last':
            jumpToVideo(state.playlist.length - 1);
            break;
        case 'infinity-loop-fullscreen':
            desktopPlayer.requestFullscreen().catch(error => console.error('切换全屏失败:', error));
            break;
        case 'infinity-loop-copy':
            copyCurrentFileName();
            break;
        default:
            break;
    }
}

async function setupDesktopBridge() {
    if (!isDesktopApp || desktopState.eventReady) return desktopState.eventReady;
    const listen = window.__TAURI__.event?.listen;
    if (!listen) {
        queuePlaybackLog('event-bridge-unavailable');
        showToast('桌面事件桥接不可用');
        return;
    }

    desktopState.eventReady = Promise.all([
        listen(`mpv-event-${MPV_WINDOW_LABEL}`, event => {
            const payload = getTauriPayload(event);
            const eventName = payload?.event;
            if (payload?.event === 'property-change') {
                if ([
                    'filename',
                    'video-codec',
                    'video-format',
                    'hwdec-current',
                    'video-params/w',
                    'video-params/h',
                    'video-out-params/dw',
                    'video-out-params/dh'
                ].includes(payload.name)) {
                    queuePlaybackLog('property-change', {
                        property: payload.name,
                        value: payload.data
                    }, payload.name === 'filename' ? String(payload.data || '') : '');
                }
                handleDesktopProperty({ name: payload.name, value: payload.data });
            } else if (payload?.event === 'client-message') {
                handleDesktopInput(payload.args);
            } else if (payload?.event === 'backend-exited' && desktopState.started) {
                queuePlaybackLog('backend-exited', { mpvEvent: payload });
                desktopState.started = false;
                showToast('播放器内核已退出');
            } else if (
                payload?.event === 'end-file'
                && isNaturalDesktopEnd(payload?.reason)
            ) {
                queuePlaybackLog('end-file', { mpvEvent: payload });
                scheduleDesktopNext();
            } else if (payload?.event === 'end-file' && payload?.reason === 'error') {
                queuePlaybackLog('playback-error', {
                    errorCode: payload.error,
                    errorDescription: describeMpvError(payload.error),
                    mpvEvent: payload
                });
                const errorDetail = payload.error !== undefined
                    ? `：${describeMpvError(payload.error)}`
                    : '';
                showToast(`❌ 当前文件无法播放${errorDetail}`);
                if (desktopState.mode === 'mpv' && state.options.autoPlay && !state.options.loopSingle) {
                    const failedIndex = state.currentIndex;
                    const requestId = desktopState.navigationRequest;
                    setTimeout(() => {
                        if (
                            desktopState.mode === 'mpv'
                            && state.currentIndex === failedIndex
                            && desktopState.navigationRequest === requestId
                        ) {
                            playNext();
                        }
                    }, 0);
                }
            }

            if (eventName && eventName !== 'property-change' && eventName !== 'client-message'
                && eventName !== 'backend-exited' && eventName !== 'end-file') {
                queuePlaybackLog('mpv-event', { mpvEvent: payload });
            }
        }),
        listen('folder-scan-progress', event => {
            const progress = getTauriPayload(event);
            if (!progress || progress.finished) return;
            const currentPath = String(progress.currentPath || '');
            const shortPath = currentPath.length > 70 ? `...${currentPath.slice(-67)}` : currentPath;
            const loadingText = elements.loading.querySelector('p');
            if (loadingText) {
                loadingText.textContent = `扫描文件夹 · ${progress.scanned || 0} 项 · 找到 ${progress.candidates || 0} 个媒体\n${shortPath}`;
            }
        })
    ]);

    return desktopState.eventReady;
}

async function ensureDesktopPlayer() {
    if (!isDesktopApp) return;
    await setupDesktopBridge();
    if (desktopState.started) return;
    const mpvLogPath = await invokeDesktop('get_mpv_log_path')
        .catch(() => 'InfinityLoop-mpv.log');
    queuePlaybackLog('player-init-request', { mpvLogPath });
    try {
        await invokeDesktop('plugin:libmpv|init', {
            windowLabel: MPV_WINDOW_LABEL,
            mpvConfig: {
                initialOptions: {
                    vo: 'gpu-next',
                    hwdec: 'auto-safe',
                    'keep-open': 'yes',
                    'force-window': 'yes',
                    keepaspect: 'yes',
                    'video-unscaled': 'no',
                    panscan: 0,
                    'video-zoom': 0,
                    'video-pan-x': 0,
                    'video-pan-y': 0,
                    // 保持软件默认听感，不使用音频滤镜，避免不同视频出现爆音或失真。
                    volume: 120,
                    'volume-max': 200,
                    'input-cursor-passthrough': 'yes',
                    'input-vo-keyboard': 'no',
                    'input-default-bindings': 'no',
                    osc: 'no',
                    'osd-level': 0,
                    'log-file': mpvLogPath,
                    'msg-level': 'all=info'
                },
                observedProperties: {
                    pause: 'flag',
                    'time-pos': 'double',
                    duration: 'double',
                    'eof-reached': 'flag',
                    filename: 'string',
                    'video-codec': 'string',
                    'video-format': 'string',
                    'hwdec-current': 'string',
                    'video-params/w': 'int64',
                    'video-params/h': 'int64',
                    'video-out-params/dw': 'int64',
                    'video-out-params/dh': 'int64',
                    'track-list': 'node'
                }
            }
        });
        desktopState.started = true;
        queuePlaybackLog('player-init-success', { mpvLogPath });
    } catch (error) {
        queuePlaybackLog('player-init-error', {
            error: String(error),
            mpvLogPath
        });
        throw error;
    }
}

/*
async function switchDesktopToMpv(index) {
    if (!isDesktopApp) return;
    if (desktopState.fallbackPending) {
        desktopState.pendingIndex = index;
        return;
    }

    desktopState.fallbackPending = true;
    desktopState.mode = 'mpv';
    desktopState.directFileMode = true;
    state.currentIndex = index;
    showLoading(true);

    const item = elements.videoContainer.querySelector('.video-item');
    if (item) {
        item.innerHTML = '';
        createDesktopVideoSurface(item, index);
    }

    try {
        await ensureDesktopPlayer();
        await desktopPlayer.loadFile(state.playlist[index]?.path);
        scheduleDesktopSurfaceSync();
        if (state.options.autoPlay) {
            await desktopPlayer.play();
        }
    } catch (error) {
        console.error('切换兼容播放器失败:', error);
        showToast(`❌ 当前文件无法播放：${error?.message || error}`);
    } finally {
        showLoading(false);
        const pendingIndex = desktopState.pendingIndex;
        desktopState.pendingIndex = null;
        desktopState.fallbackPending = false;
        if (Number.isInteger(pendingIndex) && pendingIndex !== index) {
            setTimeout(() => loadVideoAroundIndex(pendingIndex), 0);
        }
    }
}

async function switchDesktopToWebView(index) {
    if (!isDesktopApp) return;
    if (desktopState.fallbackPending) {
        desktopState.pendingIndex = index;
        return;
    }

    desktopState.fallbackPending = true;
    desktopState.mode = 'webview';
    desktopState.directFileMode = false;
    desktopState.navigationRequest += 1;
    state.currentIndex = index;
    showLoading(true);

    try {
        if (desktopState.started) {
            desktopState.started = false;
            desktopState.lastSurfaceRect = '';
            await invokeDesktop('plugin:libmpv|destroy', { windowLabel: MPV_WINDOW_LABEL })
                .catch(error => console.debug('销毁 libmpv 播放器失败:', error));
        }

        const item = elements.videoContainer.querySelector('.video-item');
        if (item) {
            item.innerHTML = '';
            createVideoElement(item, index);
        }
        updateVideoCount();
        updatePlaylistHighlight();

        const currentVideo = getCurrentVideo();
        if (currentVideo && state.options.autoPlay) {
            await currentVideo.play().catch(() => {});
        }
    } finally {
        showLoading(false);
        const pendingIndex = desktopState.pendingIndex;
        desktopState.pendingIndex = null;
        desktopState.fallbackPending = false;
        if (Number.isInteger(pendingIndex) && pendingIndex !== index) {
            setTimeout(() => loadVideoAroundIndex(pendingIndex), 0);
        }
    }
}

*/

function getDesktopSurfaceBounds() {
    const surface = elements.videoContainer.querySelector('.native-video-surface');
    if (!surface) return null;

    const rect = surface.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const visible = rect.width > 2
        && rect.height > 2
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    return {
        x: Math.max(0, Math.round(rect.left * scale)),
        y: Math.max(0, Math.round(rect.top * scale)),
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale)),
        visible
    };
}

function syncDesktopSurface() {
    // libmpv renders into the transparent main Tauri window directly.
}

function scheduleDesktopSurfaceSync() {
    if (!isDesktopApp || !desktopState.started || desktopState.surfaceSyncFrame) return;

    desktopState.surfaceSyncFrame = requestAnimationFrame(() => {
        desktopState.surfaceSyncFrame = 0;
        syncDesktopSurface();
    });
}

// 视频信息浮层
let videoInfoOverlay = null;

// IndexedDB 数据库名称
const DB_NAME = `InfinityLoopDB_${INSTANCE_ID}`;
const DB_VERSION = 2;
const STORE_NAME = 'savedPaths';
const PRESET_STORE_NAME = 'presetPaths';

// 预设路径配置（名称 -> 提示路径）
const DEFAULT_PRESETS = [
    { id: 'preset_xiaoshuishui', name: '小水水', hint: 'E:\\@百看不厌\\@yield\\yield-video\\小水水' }
];

// Windows/mpv 模式覆盖常见本地媒体；浏览器模式继续使用原本的原生格式范围。
const DESKTOP_VIDEO_FORMATS = [
    '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.qt', '.wmv', '.asf',
    '.ts', '.m2ts', '.mts', '.mxf', '.flv', '.f4v', '.webm', '.ogv',
    '.ogm', '.3gp', '.3g2', '.rm', '.rmvb', '.vob', '.mpg', '.mpeg',
    '.m2v', '.divx',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus',
    '.wma', '.ape', '.tta', '.ac3', '.dts'
];

const WEBVIEW_DESKTOP_FORMATS = new Set([
    '.mp4', '.m4v', '.mov', '.webm', '.ogv',
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma'
]);

function getFileExtension(file) {
    return `.${String(file?.name || file?.path || '').split('.').pop().toLowerCase()}`;
}

function getDesktopAssetUrl(video) {
    const convertFileSrc = window.__TAURI__?.core?.convertFileSrc;
    if (!convertFileSrc || !video?.path) return '';

    try {
        return convertFileSrc(video.path);
    } catch (error) {
        console.warn('本地媒体路径转换失败:', error);
        return '';
    }
}

function canUseDesktopWebView(video) {
    return isDesktopApp
        && WEBVIEW_DESKTOP_FORMATS.has(getFileExtension(video))
        && Boolean(getDesktopAssetUrl(video));
}

const VIDEO_FORMATS = isDesktopApp ? DESKTOP_VIDEO_FORMATS : [
    '.mp4', '.m4v', '.webm', '.ogg', '.ogv',
    '.mp3', '.m4a', '.aac', '.wav', '.oga', '.opus', '.flac'
];

// 图片格式（用于背景图）
const IMAGE_FORMATS = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'
];

// 背景图轮播状态
const bgState = {
    images: [],
    currentIndex: 0,
    intervalId: null,
    bgLayer1: null,
    bgLayer2: null,
    currentLayer: 1,
    imageCache: new Map(),
    rotationRequest: 0
};

const COMMON_VIDEO_FOLDERS_KEY = 'commonVideoFolders';
const WALLPAPER_FOLDER_KEY = 'wallpaperFolder';
const WALLPAPER_CACHE_STORE_NAME = 'wallpaperCache';
const WALLPAPER_INTERVAL_KEY = 'wallpaperIntervalSeconds';
const MOVE_FOLDER_KEY = 'moveFolder';
const MOVE_FOLDERS_KEY = 'moveFolders';
const FOLDER_GROUP_COLLAPSE_KEY = 'folderGroupCollapse';
const DEFAULT_WALLPAPER_INTERVAL_SECONDS = 12;
const MAX_BACKGROUND_IMAGE_CACHE = 2;
const BACKGROUND_IDLE_TIMEOUT_MS = 1200;
let pendingFolderEditor = null;
let activeMoveTargetMenu = null;
let dbReadyPromise = null;

function readStoredJson(key, fallback) {
    try {
        const value = storage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        console.warn('读取本地配置失败:', key, error);
        return fallback;
    }
}

function writeStoredJson(key, value) {
    storage.setItem(key, JSON.stringify(value));
}

function createConfigId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeFolderGroups(raw, legacyName = '未分组') {
    if (Array.isArray(raw) && raw.some(item => Array.isArray(item?.folders))) {
        return raw.map(group => ({
            id: group.id || createConfigId('group'),
            name: group.name || legacyName,
            folders: Array.isArray(group.folders)
                ? group.folders.filter(folder => folder && typeof folder.path === 'string' && folder.path).map(folder => ({
                    id: folder.id || createConfigId('folder'),
                    path: folder.path,
                    name: folder.name || getFolderName(folder.path)
                }))
                : []
        }));
    }

    const legacyFolders = Array.isArray(raw)
        ? raw.filter(folder => folder && typeof folder.path === 'string' && folder.path)
        : raw && typeof raw.path === 'string' && raw.path ? [raw] : [];
    if (legacyFolders.length === 0) return [];

    return [{
        id: createConfigId('group'),
        name: legacyName,
        folders: legacyFolders.map(folder => ({
            id: folder.id || createConfigId('folder'),
            path: folder.path,
            name: folder.name || getFolderName(folder.path)
        }))
    }];
}

function getFolderGroups(storageKey, legacyKey = null) {
    const raw = readStoredJson(storageKey, null);
    if (raw !== null) return normalizeFolderGroups(raw);
    return legacyKey ? normalizeFolderGroups(readStoredJson(legacyKey, null)) : [];
}

function writeFolderGroups(storageKey, groups) {
    writeStoredJson(storageKey, groups.map(group => ({
        id: group.id,
        name: group.name,
        folders: group.folders.map(folder => ({
            id: folder.id,
            path: folder.path,
            name: folder.name
        }))
    })));
}

function getCommonVideoGroups() {
    return getFolderGroups(COMMON_VIDEO_FOLDERS_KEY);
}

function getMoveFolderGroups() {
    return getFolderGroups(MOVE_FOLDERS_KEY, MOVE_FOLDER_KEY);
}

function getMoveFolders() {
    return getMoveFolderGroups().flatMap(group => group.folders);
}

function getCollapsedFolderGroups(kind) {
    const saved = readStoredJson(FOLDER_GROUP_COLLAPSE_KEY, {});
    return new Set(Array.isArray(saved?.[kind]) ? saved[kind] : []);
}

function setFolderGroupCollapsed(kind, groupId, collapsed) {
    const saved = readStoredJson(FOLDER_GROUP_COLLAPSE_KEY, {});
    const ids = new Set(Array.isArray(saved?.[kind]) ? saved[kind] : []);
    if (collapsed) ids.add(groupId);
    else ids.delete(groupId);
    writeStoredJson(FOLDER_GROUP_COLLAPSE_KEY, {
        ...saved,
        [kind]: [...ids]
    });
}

function toggleFolderGroup(kind, groupId) {
    const collapsed = getCollapsedFolderGroups(kind);
    setFolderGroupCollapsed(kind, groupId, !collapsed.has(groupId));
    kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
}

function getWallpaperFolder() {
    const folder = readStoredJson(WALLPAPER_FOLDER_KEY, null);
    return folder && typeof folder.path === 'string' && folder.path ? folder : null;
}

function getFolderName(path) {
    return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path || '未命名文件夹';
}

function renderFolderGroup(group, kind, groupIndex, groupCount = 1) {
    const isCommon = kind === 'common';
    const collapsed = getCollapsedFolderGroups(kind).has(group.id);
    const folders = group.folders.map((folder, folderIndex) => `
        <div class="directory-item directory-folder-item" data-folder-id="${escapeHtml(folder.id)}">
            <div class="directory-item-main" tabindex="0" role="button">
                <span class="directory-item-name">${escapeHtml(folder.name || getFolderName(folder.path))}</span>
                <span class="directory-item-path" title="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</span>
            </div>
            <div class="directory-item-actions">
                <button class="directory-item-action move-up" type="button" ${folderIndex === 0 ? 'disabled' : ''}>↑</button>
                <button class="directory-item-action move-down" type="button" ${folderIndex === group.folders.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="directory-item-action edit-folder" type="button">编辑</button>
                <button class="directory-item-action remove-folder" type="button">移除</button>
            </div>
        </div>
    `).join('');

    return `
        <section class="directory-group${collapsed ? ' is-collapsed' : ''}" data-group-id="${escapeHtml(group.id)}">
            <div class="directory-group-heading" tabindex="0" role="button" aria-expanded="${collapsed ? 'false' : 'true'}">
                <div class="directory-group-title">
                    <button class="directory-group-toggle" type="button" aria-label="${collapsed ? '展开' : '收起'}分组">
                        <span class="directory-group-chevron">⌄</span>
                    </button>
                    <span class="directory-group-icon">▦</span>
                    <span>${escapeHtml(group.name || '未命名分组')}</span>
                    <small>${group.folders.length} 个文件夹</small>
                </div>
                <div class="directory-item-actions directory-group-actions">
                    <button class="directory-item-action group-up" type="button" ${groupIndex === 0 ? 'disabled' : ''}>↑</button>
                    <button class="directory-item-action group-down" type="button" ${groupIndex === groupCount - 1 ? 'disabled' : ''}>↓</button>
                    <button class="directory-item-action edit-group" type="button">改名</button>
                    <button class="directory-item-action remove-group" type="button">移除组</button>
                </div>
            </div>
            <div class="directory-group-folders">
                ${folders || '<div class="directory-empty">组内还没有文件夹</div>'}
            </div>
        </section>
    `;
}

function reorderFolderGroup(kind, groupId, folderId, delta) {
    const key = kind === 'common' ? COMMON_VIDEO_FOLDERS_KEY : MOVE_FOLDERS_KEY;
    const groups = kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    const index = group.folders.findIndex(folder => folder.id === folderId);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= group.folders.length) return;
    [group.folders[index], group.folders[nextIndex]] = [group.folders[nextIndex], group.folders[index]];
    writeFolderGroups(key, groups);
    kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
}

function reorderFolderGroupContainer(kind, groupId, delta) {
    const key = kind === 'common' ? COMMON_VIDEO_FOLDERS_KEY : MOVE_FOLDERS_KEY;
    const groups = kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();
    const index = groups.findIndex(group => group.id === groupId);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= groups.length) return;
    [groups[index], groups[nextIndex]] = [groups[nextIndex], groups[index]];
    writeFolderGroups(key, groups);
    kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
}

function removeConfiguredFolder(kind, groupId, folderId) {
    const key = kind === 'common' ? COMMON_VIDEO_FOLDERS_KEY : MOVE_FOLDERS_KEY;
    const groups = kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    group.folders = group.folders.filter(folder => folder.id !== folderId);
    writeFolderGroups(key, groups);
    kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
    showToast('文件夹已移除');
}

function removeFolderGroup(kind, groupId) {
    const key = kind === 'common' ? COMMON_VIDEO_FOLDERS_KEY : MOVE_FOLDERS_KEY;
    const groups = kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (group.folders.length > 0 && !window.confirm(`分组“${group.name}”内还有文件夹，确定移除整个分组吗？`)) return;
    writeFolderGroups(key, groups.filter(item => item.id !== groupId));
    kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
    showToast('分组已移除');
}

function renderCommonVideoFolders() {
    const list = elements.commonVideoFolders;
    if (!list) return;

    const groups = getCommonVideoGroups();
    if (groups.length === 0) {
        list.innerHTML = '<div class="directory-empty">还没有配置常用文件夹，点击右上角添加。</div>';
        return;
    }

    list.innerHTML = groups.map((group, index) => renderFolderGroup(group, 'common', index, groups.length)).join('');

    bindFolderGroupActions(list, 'common');
}

function bindFolderGroupActions(list, kind) {
    const groups = kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();
    list.querySelectorAll('.directory-group').forEach(groupElement => {
        const groupId = groupElement.dataset.groupId;
        const group = groups.find(item => item.id === groupId);
        if (!group) return;
        const heading = groupElement.querySelector('.directory-group-heading');
        const toggle = () => toggleFolderGroup(kind, groupId);
        heading?.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            toggle();
        });
        heading?.addEventListener('keydown', event => {
            if (event.target.closest('button')) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
        groupElement.querySelector('.directory-group-toggle')?.addEventListener('click', toggle);
        groupElement.querySelector('.group-up')?.addEventListener('click', () => reorderFolderGroupContainer(kind, groupId, -1));
        groupElement.querySelector('.group-down')?.addEventListener('click', () => reorderFolderGroupContainer(kind, groupId, 1));
        groupElement.querySelector('.edit-group')?.addEventListener('click', () => openFolderAliasModal({ kind, type: 'group', group }));
        groupElement.querySelector('.remove-group')?.addEventListener('click', () => removeFolderGroup(kind, groupId));
        groupElement.querySelectorAll('.directory-folder-item').forEach(folderElement => {
            const folderId = folderElement.dataset.folderId;
            const folder = group.folders.find(item => item.id === folderId);
            if (!folder) return;
            const open = () => openDesktopFolder(folder.path, folder.name || getFolderName(folder.path));
            folderElement.querySelector('.directory-item-main')?.addEventListener('click', open);
            folderElement.querySelector('.directory-item-main')?.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            });
            folderElement.querySelector('.move-up')?.addEventListener('click', () => reorderFolderGroup(kind, groupId, folderId, -1));
            folderElement.querySelector('.move-down')?.addEventListener('click', () => reorderFolderGroup(kind, groupId, folderId, 1));
            folderElement.querySelector('.edit-folder')?.addEventListener('click', () => openFolderAliasModal({ kind, type: 'folder', groupId, folder }));
            folderElement.querySelector('.remove-folder')?.addEventListener('click', () => removeConfiguredFolder(kind, groupId, folderId));
        });
    });
}

function renderWallpaperFolderSummary() {
    const summary = elements.wallpaperFolderSummary;
    if (!summary) return;

    const folder = getWallpaperFolder();
    if (!folder) {
        summary.innerHTML = '<span class="directory-empty">当前使用内置壁纸</span>';
        return;
    }

    summary.innerHTML = `
        <span class="directory-item-name">${escapeHtml(folder.name || getFolderName(folder.path))}</span>
        <span class="directory-item-path" title="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</span>
    `;
}

function renderMoveFolderSummary() {
    const summary = elements.moveFolderSummary;
    if (!summary) return;

    const groups = getMoveFolderGroups();
    if (groups.length === 0) {
        summary.innerHTML = '<span class="directory-empty">尚未配置移动目标</span>';
        updatePlayerActions();
        return;
    }

    summary.innerHTML = groups.map((group, index) => renderFolderGroup(group, 'move', index, groups.length)).join('');
    bindFolderGroupActions(summary, 'move');
    updatePlayerActions();
}

function getWallpaperIntervalSeconds() {
    const value = Number.parseInt(storage.getItem(WALLPAPER_INTERVAL_KEY), 10);
    if (!Number.isFinite(value)) return DEFAULT_WALLPAPER_INTERVAL_SECONDS;
    return Math.min(3600, Math.max(5, value));
}

function loadWallpaperIntervalOption() {
    if (elements.wallpaperInterval) {
        elements.wallpaperInterval.value = String(getWallpaperIntervalSeconds());
    }
}

function saveWallpaperInterval() {
    const value = Math.min(3600, Math.max(5, Number.parseInt(elements.wallpaperInterval?.value, 10) || DEFAULT_WALLPAPER_INTERVAL_SECONDS));
    if (elements.wallpaperInterval) elements.wallpaperInterval.value = String(value);
    storage.setItem(WALLPAPER_INTERVAL_KEY, String(value));
    if (bgState.intervalId) startBgRotation();
    showToast(`壁纸轮播间隔已设置为 ${value} 秒`);
}

function openFolderAliasModal(editor = {}) {
    pendingFolderEditor = editor;
    if (!elements.folderAliasModal) return;

    const isGroup = editor.type === 'group';
    const isCommon = editor.kind !== 'move';
    const path = editor.folder?.path || editor.path || '';
    const currentName = editor.group?.name || editor.folder?.name
        || (isGroup ? '未命名分组' : getFolderName(path));
    elements.folderAliasTitle.textContent = isGroup
        ? `${editor.group ? '修改' : '添加'}${isCommon ? '常用文件夹' : '移动目标'}分组`
        : `${editor.folder?.id ? '修改' : '添加'}${isCommon ? '常用视频文件夹' : '移动目标文件夹'}`;
    elements.folderAliasPath.textContent = path;
    elements.folderAliasPath.classList.toggle('hidden', isGroup);
    elements.folderAliasInputLabel.textContent = isGroup ? '分组名称' : '文件夹名称';
    elements.folderAliasInput.value = currentName;
    elements.folderAliasGroupLabel.classList.toggle('hidden', isGroup);
    elements.folderAliasGroup.classList.toggle('hidden', isGroup);
    if (!isGroup) {
        const groups = isCommon ? getCommonVideoGroups() : getMoveFolderGroups();
        elements.folderAliasGroup.innerHTML = groups.length > 0
            ? groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')
            : '<option value="">未分组（保存时自动创建）</option>';
        elements.folderAliasGroup.value = editor.groupId || groups[0]?.id || '';
    }
    elements.folderAliasModal.classList.remove('hidden');
    requestAnimationFrame(() => {
        elements.folderAliasInput.focus();
        elements.folderAliasInput.select();
    });
}

function closeFolderAliasModal() {
    pendingFolderEditor = null;
    elements.folderAliasModal?.classList.add('hidden');
}

function saveFolderAlias() {
    const editor = pendingFolderEditor;
    if (!editor) {
        closeFolderAliasModal();
        return;
    }

    const name = elements.folderAliasInput.value.trim() || (editor.type === 'group' ? '未命名分组' : getFolderName(editor.folder?.path || editor.path));
    const key = editor.kind === 'common' ? COMMON_VIDEO_FOLDERS_KEY : MOVE_FOLDERS_KEY;
    const groups = editor.kind === 'common' ? getCommonVideoGroups() : getMoveFolderGroups();

    if (editor.type === 'group') {
        if (editor.group?.id) {
            const group = groups.find(item => item.id === editor.group.id);
            if (group) group.name = name;
        } else {
            groups.push({ id: createConfigId('group'), name, folders: [] });
        }
    } else {
        const path = editor.folder?.path || editor.path;
        if (!path) {
            closeFolderAliasModal();
            return;
        }
        let targetGroup = groups.find(group => group.id === elements.folderAliasGroup.value);
        if (!targetGroup) {
            targetGroup = { id: createConfigId('group'), name: '未分组', folders: [] };
            groups.push(targetGroup);
        }
        if (editor.folder?.id) {
            const oldGroup = groups.find(group => group.folders.some(folder => folder.id === editor.folder.id));
            const folder = oldGroup?.folders.find(item => item.id === editor.folder.id);
            if (folder) {
                oldGroup.folders = oldGroup.folders.filter(item => item.id !== folder.id);
                targetGroup.folders.push({ ...folder, name, path });
            }
        } else {
            targetGroup.folders.push({ id: createConfigId('folder'), path, name });
        }
    }

    writeFolderGroups(key, groups);
    editor.kind === 'common' ? renderCommonVideoFolders() : renderMoveFolderSummary();
    closeFolderAliasModal();
    showToast(editor.type === 'group' ? '分组名称已更新' : editor.folder?.id ? '文件夹名称已更新' : '文件夹已保存');
}

async function addCommonVideoFolder() {
    if (!isDesktopApp) {
        showToast('常用文件夹配置仅支持 Windows 桌面版');
        return;
    }

    const path = await invokeDesktop('pick_folder');
    if (path) openFolderAliasModal({ kind: 'common', type: 'folder', path });
}

function addCommonVideoGroup() {
    openFolderAliasModal({ kind: 'common', type: 'group' });
}

async function scanWallpaperImageFiles(path) {
    return invokeDesktop('scan_wallpaper_folder', {
        path,
        includeSubfolders: true
    });
}

function wallpaperFilesToUrls(files) {
    return Array.isArray(files)
        ? files.map(file => getDesktopAssetUrl(file)).filter(Boolean)
        : [];
}

function compactWallpaperFiles(files) {
    if (!Array.isArray(files)) return [];

    // 清单只需要保留路径；尺寸、修改时间等信息对轮播没有用，避免 IndexedDB 缓存膨胀。
    return files
        .map(file => ({ path: String(file?.path || '') }))
        .filter(file => file.path);
}

async function getWallpaperCache(path) {
    if (!isDesktopApp) return null;
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([WALLPAPER_CACHE_STORE_NAME], 'readonly');
        const request = transaction.objectStore(WALLPAPER_CACHE_STORE_NAME).get('active');
        request.onsuccess = () => {
            const cache = request.result;
            resolve(cache?.folderPath === path && Array.isArray(cache.files) ? cache.files : null);
        };
        request.onerror = () => reject(request.error);
    });
}

async function saveWallpaperCache(path, files) {
    if (!isDesktopApp || !Array.isArray(files)) return;
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([WALLPAPER_CACHE_STORE_NAME], 'readwrite');
        const request = transaction.objectStore(WALLPAPER_CACHE_STORE_NAME).put({
            id: 'active',
            folderPath: path,
            files: compactWallpaperFiles(files),
            updatedAt: Date.now()
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function configureWallpaperFolder() {
    if (!isDesktopApp) {
        showToast('壁纸文件夹配置仅支持 Windows 桌面版');
        return;
    }

    try {
        const path = await invokeDesktop('pick_wallpaper_folder');
        if (!path) return;

        showLoading(true);
        const files = await scanWallpaperImageFiles(path);
        const images = wallpaperFilesToUrls(files);
        if (images.length === 0) {
            showToast('该文件夹及子文件夹中没有可用图片');
            return;
        }

        const folder = { path, name: getFolderName(path) };
        writeStoredJson(WALLPAPER_FOLDER_KEY, folder);
        await saveWallpaperCache(path, files);
        renderWallpaperFolderSummary();
        bgState.images = images;
        bgState.currentIndex = Math.floor(Math.random() * images.length);
        startBgRotation();
        showToast(`已加载 ${images.length} 张壁纸`);
    } catch (error) {
        console.error('读取壁纸文件夹失败:', error);
        showToast(`壁纸读取失败：${error?.message || error}`);
    } finally {
        showLoading(false);
    }
}

async function configureMoveFolder() {
    if (!isDesktopApp) {
        showToast('移动文件功能仅支持 Windows 桌面版');
        return;
    }

    try {
        const path = await invokeDesktop('pick_move_folder');
        if (!path) return;

        openFolderAliasModal({ kind: 'move', type: 'folder', path });
    } catch (error) {
        console.error('配置移动目标失败:', error);
        showToast(`配置失败：${error?.message || error}`);
    }
}

function addMoveFolderGroup() {
    openFolderAliasModal({ kind: 'move', type: 'group' });
}

/* 保留旧配置读取兼容性；首次保存新的分组配置时会自然迁移到 moveFolders。 */
function migrateFolderConfiguration() {
    const commonRaw = readStoredJson(COMMON_VIDEO_FOLDERS_KEY, null);
    if (commonRaw !== null && !(Array.isArray(commonRaw) && commonRaw.some(item => Array.isArray(item?.folders)))) {
        writeFolderGroups(COMMON_VIDEO_FOLDERS_KEY, normalizeFolderGroups(commonRaw));
    }
    const moveRaw = readStoredJson(MOVE_FOLDERS_KEY, null);
    if (moveRaw === null) {
        const legacyMove = readStoredJson(MOVE_FOLDER_KEY, null);
        if (legacyMove) writeFolderGroups(MOVE_FOLDERS_KEY, normalizeFolderGroups(legacyMove));
    }
}

// 使用清单按需加载，避免启动时探测并解码全部超大背景图。
async function loadBackgroundImages() {
    let images = Array.isArray(window.INFINITY_LOOP_BACKGROUNDS)
        ? window.INFINITY_LOOP_BACKGROUNDS.filter(path => typeof path === 'string' && path)
        : [];

    renderWallpaperFolderSummary();
    renderMoveFolderSummary();
    const wallpaperFolder = getWallpaperFolder();
    if (isDesktopApp && wallpaperFolder) {
        try {
            // 配置壁纸时才扫描；启动时直接使用 IndexedDB 清单，避免重复遍历大目录。
            let customFiles = await getWallpaperCache(wallpaperFolder.path);
            if (!customFiles) {
                customFiles = await scanWallpaperImageFiles(wallpaperFolder.path);
                await saveWallpaperCache(wallpaperFolder.path, customFiles);
            }
            const customImages = wallpaperFilesToUrls(customFiles);
            if (customImages.length > 0) images = customImages;
        } catch (error) {
            console.warn('加载已配置壁纸文件夹失败，将使用内置壁纸:', error);
        }
    }

    if (images.length === 0) {
        console.warn('未找到背景图片');
        return;
    }

    bgState.images = images;
    bgState.currentIndex = Math.floor(Math.random() * images.length);
    startBgRotation();
}

// 开始背景图轮播
function startBgRotation() {
    if (bgState.images.length === 0) return;

    if (bgState.intervalId) {
        clearInterval(bgState.intervalId);
    }

    // 设置初始背景（直接显示，不渐变）。图片本身通过受控缓存异步解码。
    const initialBg = bgState.images[bgState.currentIndex];
    bgState.currentLayer = 1;
    bgState.rotationRequest += 1;
    const rotationRequest = bgState.rotationRequest;
    preloadBackgroundImage(initialBg).then(() => {
        if (rotationRequest === bgState.rotationRequest && bgState.bgLayer1) {
            bgState.bgLayer1.style.backgroundImage = `url('${initialBg}')`;
        }
    });

    // 按设置的间隔随机切换，避免重复扫描壁纸目录。
    bgState.intervalId = setInterval(() => {
        let newIndex;
        let attempts = 0;
        do {
            newIndex = Math.floor(Math.random() * bgState.images.length);
            attempts++;
        } while (newIndex === bgState.currentIndex && bgState.images.length > 1 && attempts < 10);
        bgState.currentIndex = newIndex;
        // 提前解码下一张，切换时直接复用；缓存上限为 2 张，避免长时间轮播持续占用内存。
        preloadBackgroundImage(bgState.images[newIndex]);
        updateBgImage();
    }, getWallpaperIntervalSeconds() * 1000);
}

function setBackgroundActive(active) {
    const layers = [bgState.bgLayer1, bgState.bgLayer2].filter(Boolean);
    layers.forEach(layer => layer.classList.toggle('background-suspended', !active));

    if (active) {
        if (!bgState.intervalId && bgState.images.length > 0) {
            startBgRotation();
        }
    } else if (bgState.intervalId) {
        clearInterval(bgState.intervalId);
        bgState.intervalId = null;
    }
}

function preloadBackgroundImage(url) {
    if (!url) return Promise.resolve(null);

    const cached = bgState.imageCache.get(url);
    if (cached) {
        // LRU：重新访问的图片移动到 Map 末尾。
        bgState.imageCache.delete(url);
        bgState.imageCache.set(url, cached);
        return cached;
    }

    const imagePromise = new Promise(resolve => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
    bgState.imageCache.set(url, imagePromise);

    while (bgState.imageCache.size > MAX_BACKGROUND_IMAGE_CACHE) {
        const oldestUrl = bgState.imageCache.keys().next().value;
        bgState.imageCache.delete(oldestUrl);
    }

    return imagePromise;
}

// 更新背景图（渐隐→切换→渐显）
function updateBgImage() {
    if (bgState.images.length === 0) return;

    const currentBg = bgState.images[bgState.currentIndex];

    // 确定当前显示的背景层和下一个要显示的背景层
    const currentBgLayer = bgState.currentLayer === 1 ? bgState.bgLayer1 : bgState.bgLayer2;
    const nextBgLayer = bgState.currentLayer === 1 ? bgState.bgLayer2 : bgState.bgLayer1;

    const rotationRequest = ++bgState.rotationRequest;
    preloadBackgroundImage(currentBg).then(img => {
        if (!img || rotationRequest !== bgState.rotationRequest) return;
        // 1. 设置下一个背景层的图片（但在后面，暂时看不见）
        nextBgLayer.style.backgroundImage = `url('${currentBg}')`;
        nextBgLayer.classList.remove('fade-out');
        nextBgLayer.classList.add('fade-in');

        // 2. 当前背景层渐隐
        currentBgLayer.classList.remove('fade-in');
        currentBgLayer.classList.add('fade-out');

        // 3. 切换当前层标记
        bgState.currentLayer = bgState.currentLayer === 1 ? 2 : 1;
    });
}

// 初始化背景层
function initBgLayers() {
    // 创建两个背景层
    bgState.bgLayer1 = document.createElement('div');
    bgState.bgLayer1.className = 'bg-layer fade-in';
    document.body.appendChild(bgState.bgLayer1);

    bgState.bgLayer2 = document.createElement('div');
    bgState.bgLayer2.className = 'bg-layer fade-out';
    document.body.appendChild(bgState.bgLayer2);
}

// 初始化
function init() {
    console.log('🎬 播放器初始化开始...');
    if (isDesktopApp) {
        document.body.classList.add('desktop-mode');
        setupDesktopBridge().catch(error => console.error('桌面桥接初始化失败:', error));
    }
    initDB();
    initBgLayers();
    bindEvents();
    loadLastFolder();
    migrateFolderConfiguration();
    renderCommonVideoFolders();
    loadWallpaperIntervalOption();
    renderMoveFolderSummary();
    scheduleBackgroundLoad();
    loadIncludeSubfoldersOption();
    console.log('✅ 播放器初始化完成');
}

function scheduleBackgroundLoad() {
    const load = () => loadBackgroundImages()
        .catch(error => console.error('加载壁纸失败:', error));

    // 壁纸不参与首屏交互，优先让首页完成布局、按钮绑定和窗口响应。
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(load, { timeout: BACKGROUND_IDLE_TIMEOUT_MS });
    } else {
        window.setTimeout(load, 350);
    }
}

// 加载上次使用的文件夹
async function loadLastFolder() {
    if (isDesktopApp) {
        const lastDesktopFolder = storage.getItem('lastDesktopFolder');
        const lastDesktopFolderName = storage.getItem('lastFolderName');
        if (lastDesktopFolder) {
            elements.continueFolderName.textContent = lastDesktopFolderName || lastDesktopFolder;
            elements.continueWatching.classList.remove('hidden');
        }
        return;
    }

    const lastFolderId = storage.getItem('lastFolderId');
    const lastFolderName = storage.getItem('lastFolderName');

    console.log('🔍 检查继续观看:', { lastFolderId, lastFolderName, instanceId: INSTANCE_ID });

    if (!lastFolderId) {
        console.log('❌ 没有lastFolderId，不显示继续观看按钮');
        return;
    }

    // 检查是否有保存的句柄
    try {
        if (!window.db) await initDB();

        const pathData = await new Promise((resolve, reject) => {
            const transaction = window.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(lastFolderId);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        console.log('📁 pathData:', pathData);

        // 只有当有有效的句柄时才显示继续观看按钮
        if (pathData && pathData.handle) {
            elements.continueFolderName.textContent = lastFolderName || pathData.name || '上次文件夹';
            elements.continueWatching.classList.remove('hidden');
            console.log('✅ 显示继续观看按钮');
        } else {
            console.log('❌ pathData或handle为空');
        }
    } catch (error) {
        console.error('❌ 检查上次文件夹失败:', error);
    }
}

// 加载"包含子文件夹"选项
function loadIncludeSubfoldersOption() {
    console.log('========================================');
    console.log('🔍 实例信息检查:');
    console.log('  当前URL:', window.location.href);
    console.log('  INSTANCE_ID:', INSTANCE_ID);
    console.log('  includeSubfolders key:', `${INSTANCE_ID}_includeSubfolders`);

    const savedValue = storage.getItem('includeSubfolders');
    console.log('  读取到的值:', savedValue);

    if (savedValue !== null) {
        // 'true' -> true, 'false' -> false
        const isChecked = savedValue === 'true';
        elements.includeSubfolders.checked = isChecked;
        console.log('✅ 已加载"包含子文件夹"选项:', isChecked);
    } else {
        console.log('ℹ️ 没有保存的值，使用默认值 checked');
        elements.includeSubfolders.checked = true;
    }
    console.log('========================================');
}

// 初始化默认预设
function initDefaultPresets() {
    // 检查是否已初始化预设
    const initialized = storage.getItem('presetsInitialized');
    if (!initialized) {
        DEFAULT_PRESETS.forEach(preset => {
            savePresetPath(preset.id, preset.name, preset.hint);
        });
        storage.setItem('presetsInitialized', 'true');
    }
}

// 初始化 IndexedDB
function initDB() {
    if (window.db) return Promise.resolve(window.db);
    if (dbReadyPromise) return dbReadyPromise;

    dbReadyPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            dbReadyPromise = null;
            reject(request.error);
        };
        request.onsuccess = () => {
            window.db = request.result;
            resolve(request.result);
        };

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(PRESET_STORE_NAME)) {
                db.createObjectStore(PRESET_STORE_NAME, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(WALLPAPER_CACHE_STORE_NAME)) {
                db.createObjectStore(WALLPAPER_CACHE_STORE_NAME, { keyPath: 'id' });
            }
        };
    });

    return dbReadyPromise;
}

// 保存路径到 IndexedDB
async function savePath(id, handle, name) {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put({ id, handle, name, timestamp: Date.now() });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 从 IndexedDB 获取所有保存的路径
async function getSavedPaths() {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

// 删除保存的路径
async function removeSavedPath(id) {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 保存预设路径
async function savePresetPath(id, name, hint) {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([PRESET_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PRESET_STORE_NAME);
        const request = store.put({ id, name, hint });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 获取所有预设路径
async function getPresetPaths() {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([PRESET_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PRESET_STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

// 删除预设路径
async function removePresetPath(id) {
    if (!window.db) await initDB();

    return new Promise((resolve, reject) => {
        const transaction = window.db.transaction([PRESET_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PRESET_STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 加载已保存的路径
async function loadSavedPaths() {
    try {
        const savedPaths = await getSavedPaths();
        const presetPaths = await getPresetPaths();
        renderQuickPaths(savedPaths, presetPaths);
    } catch (error) {
        console.error('加载快捷路径失败:', error);
    }
}

// 渲染快捷路径列表
function renderQuickPaths(savedPaths, presetPaths) {
    const listEl = elements.quickPathsList;

    if (savedPaths.length === 0 && presetPaths.length === 0) {
        listEl.innerHTML = `
            <div class="empty-paths">
                暂无快捷路径
                <br><small style="color: var(--text-secondary); margin-top: 8px; display: block;">
                    选择文件夹后会自动保存为快捷路径
                </small>
            </div>
        `;
        return;
    }

    let html = '';

    // 渲染预设路径
    if (presetPaths && presetPaths.length > 0) {
        html += '<div class="paths-section-title">预设路径</div>';
        html += presetPaths.map(path => `
            <div class="quick-path-item preset" data-id="${path.id}" data-type="preset" data-hint="${escapeHtml(path.hint || '')}">
                <div class="path-info">
                    <span class="path-icon">📌</span>
                    <span class="path-name">${escapeHtml(path.name)}</span>
                </div>
                <button class="remove-path" title="删除">×</button>
            </div>
        `).join('');
    }

    // 渲染已保存路径
    if (savedPaths && savedPaths.length > 0) {
        if (presetPaths && presetPaths.length > 0) {
            html += '<div class="paths-section-title">已保存</div>';
        }
        html += savedPaths.map(path => `
            <div class="quick-path-item saved" data-id="${path.id}" data-type="saved">
                <div class="path-info">
                    <span class="path-icon">📁</span>
                    <span class="path-name">${escapeHtml(path.name)}</span>
                </div>
                <button class="remove-path" title="删除">×</button>
            </div>
        `).join('');
    }

    listEl.innerHTML = html;

    // 绑定点击事件
    listEl.querySelectorAll('.quick-path-item').forEach(item => {
        const id = item.dataset.id;
        const type = item.dataset.type;

        item.addEventListener('click', async (e) => {
            if (e.target.classList.contains('remove-path')) {
                e.stopPropagation();
                if (type === 'preset') {
                    await removePresetPath(id);
                } else {
                    await removeSavedPath(id);
                }
                await loadSavedPaths();
            } else {
                if (type === 'preset') {
                    await loadPresetPath(id, item.dataset.hint);
                } else {
                    await loadSavedPath(id);
                }
            }
        });
    });
}

// 加载已保存的路径
async function loadSavedPath(id) {
    try {
        if (!window.db) await initDB();

        const pathData = await new Promise((resolve, reject) => {
            const transaction = window.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!pathData) {
            alert('路径不存在');
            return;
        }

        // 请求权限并读取文件夹
        showLoading(true);
        const permission = await pathData.handle.requestPermission({ mode: 'read' });

        if (permission === 'granted') {
            const includeSubfolders = elements.includeSubfolders.checked;
            const files = [];
            await readDirectoryHandle(pathData.handle, files, includeSubfolders, pathData.name + '/');
            processFiles(files);
        } else {
            alert('需要授权才能访问该文件夹');
        }
    } catch (error) {
        console.error('加载路径失败:', error);
        alert('加载失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// 递归读取目录句柄（用于 File System Access API）
async function readDirectoryHandle(dirHandle, files, includeSubfolders = true, currentPath = '') {
    for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
            const file = await entry.getFile();
            // 创建一个新对象来保存文件和路径信息
            const fullPath = currentPath + file.name;
            const fileWithPath = {
                _file: file,
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: file.lastModified,
                webkitRelativePath: fullPath, // 添加路径属性
                // 保存原始文件的引用用于播放
                get file() { return this._file; }
            };
            files.push(fileWithPath);
        } else if (entry.kind === 'directory' && includeSubfolders) {
            await readDirectoryHandle(entry, files, includeSubfolders, currentPath + entry.name + '/');
        }
    }
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 加载预设路径（弹出文件选择）
async function loadPresetPath(id, hint) {
    // 提示用户选择对应文件夹
    const hintMsg = hint ? `\n提示路径: ${hint}` : '';
    if (!confirm(`请选择对应的文件夹${hintMsg}\n\n点击"确定"打开文件夹选择器`)) {
        return;
    }

    if (isDesktopApp) {
        await openDesktopFolder();
        return;
    }

    try {
        if ('showDirectoryPicker' in window) {
            const handle = await window.showDirectoryPicker();

            const includeSubfolders = elements.includeSubfolders.checked;
            const files = [];
            await readDirectoryHandle(handle, files, includeSubfolders, handle.name + '/');

            // 保存为快捷路径
            await savePath(id, handle, handle.name);
            await loadSavedPaths();

            processFiles(files);
        } else {
            showToast('当前环境不支持文件夹选择，请使用 Windows 桌面版');
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('加载失败:', error);
        }
    }
}

// Windows 桌面模式使用原生文件夹选择器和 mpv 可读取的真实路径。
async function openDesktopFolder(folderPath = null, displayName = '') {
    if (!isDesktopApp) return;

    let handedOffToPlayer = false;
    try {
        const selectedPath = folderPath || await invokeDesktop('pick_folder');
        if (!selectedPath) return;

        showLoading(true);
        const loadingText = elements.loading.querySelector('p');
        if (loadingText) loadingText.textContent = '扫描文件夹 · 准备读取...';

        const files = await invokeDesktop('scan_folder', {
            path: selectedPath,
            includeSubfolders: elements.includeSubfolders.checked
        });

        if (!Array.isArray(files) || files.length === 0) {
            showToast('⚠️ 未找到支持的媒体文件');
            return;
        }

        const folderName = displayName || getFolderName(selectedPath);
        storage.setItem('lastDesktopFolder', selectedPath);
        storage.setItem('lastFolderName', folderName);
        storage.setItem('lastFolderTimestamp', Date.now().toString());

        processFiles(files, selectedPath);
        handedOffToPlayer = true;
        showToast(`已找到 ${files.length} 个媒体文件`);
    } catch (error) {
        console.error('Windows 文件夹扫描失败:', error);
        showToast(`❌ 扫描失败：${error?.message || error}`);
    } finally {
        if (!handedOffToPlayer) showLoading(false);
    }
}

// 绑定事件
function bindEvents() {
    elements.addVideoFolder?.addEventListener('click', addCommonVideoFolder);
    elements.addVideoGroup?.addEventListener('click', addCommonVideoGroup);
    elements.configureWallpaperFolder?.addEventListener('click', configureWallpaperFolder);
    elements.configureMoveFolder?.addEventListener('click', configureMoveFolder);
    elements.addMoveGroup?.addEventListener('click', addMoveFolderGroup);
    elements.wallpaperInterval?.addEventListener('change', saveWallpaperInterval);
    elements.deleteCurrentVideo?.addEventListener('click', deleteCurrentVideoToRecycleBin);
    elements.folderAliasClose?.addEventListener('click', closeFolderAliasModal);
    elements.folderAliasCancel?.addEventListener('click', closeFolderAliasModal);
    elements.folderAliasConfirm?.addEventListener('click', saveFolderAlias);
    elements.folderAliasInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter') saveFolderAlias();
        if (event.key === 'Escape') closeFolderAliasModal();
    });
    elements.folderAliasModal?.addEventListener('click', event => {
        if (event.target === elements.folderAliasModal) closeFolderAliasModal();
    });
    document.addEventListener('pointerdown', event => {
        if (activeMoveTargetMenu && !event.target.closest('.move-target-actions')) closeMoveTargetMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMoveTargetMenu();
    });

    console.log('🔗 绑定事件监听器...');

    // 包含子文件夹选项变化时保存
    elements.includeSubfolders.addEventListener('change', () => {
        const isChecked = elements.includeSubfolders.checked;
        storage.setItem('includeSubfolders', isChecked.toString());
        console.log('💾 已保存"包含子文件夹"选项:', isChecked);
    });

    // 继续观看按钮
    elements.continueBtn.addEventListener('click', async () => {
        if (isDesktopApp) {
            await openDesktopFolder(storage.getItem('lastDesktopFolder'));
            return;
        }

        const lastFolderId = storage.getItem('lastFolderId');
        if (!lastFolderId) return;

        showLoading(true);
        try {
            if (!window.db) await initDB();

            const pathData = await new Promise((resolve, reject) => {
                const transaction = window.db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(lastFolderId);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (!pathData || !pathData.handle) {
                showLoading(false);
                alert('未找到保存的文件夹信息，请重新选择文件夹');
                return;
            }

            // 请求权限并读取文件夹
            const permission = await pathData.handle.requestPermission({ mode: 'read' });
            if (permission === 'granted') {
                const includeSubfolders = elements.includeSubfolders.checked;
                const files = [];
                await readDirectoryHandle(pathData.handle, files, includeSubfolders, pathData.name + '/');

                // 筛选视频文件
                const videoFiles = files.filter(file => {
                    const ext = '.' + file.name.split('.').pop().toLowerCase();
                    return VIDEO_FORMATS.includes(ext);
                });

                if (videoFiles.length === 0) {
                    showLoading(false);
                    showToast('⚠️ 未找到视频文件');
                    return;
                }

                processFiles(videoFiles, pathData.handle);
            } else {
                showLoading(false);
                alert('需要授权才能访问文件夹');
            }
        } catch (error) {
            console.error('加载失败:', error);
            showLoading(false);
            alert('加载失败: ' + error.message);
        }
    });

    // 播放页面控制
    elements.backBtn.addEventListener('click', goHome);
    elements.closePlaylist.addEventListener('click', () => {
        elements.playlist.classList.remove('show');
    });

    // 重新洗牌按钮
    elements.reshuffleBtn.addEventListener('click', () => {
        reshuffleAndKeepPosition();
    });

    // 播放/暂停按钮
    elements.playPauseBtn.addEventListener('click', togglePlayPause);

    // 进度条点击
    elements.progressWrapper.addEventListener('click', handleProgressClick);

    // 视频容器滚动
    elements.videoContainer.addEventListener('scroll', handleScroll);

    // 滚轮事件 - 用于边界洗牌检测
    elements.videoContainer.addEventListener('wheel', (event) => {
        if (!isDesktopApp) {
            handleWheel(event);
            return;
        }

        event.preventDefault();
        navigateByWheel(event.deltaY);
    }, { passive: false });

    // 键盘快捷键
    document.addEventListener('keydown', handleKeyboard);
    if (isDesktopApp) {
        window.addEventListener('resize', () => {
            updateDesktopVideoMask();
            scheduleDesktopSurfaceSync();
        });
    }
    console.log('✅ 键盘事件监听器已绑定');
}

// 处理文件夹选择
function handleFolderSelect(e) {
    const files = Array.from(e.target.files);
    const includeSubfolders = elements.includeSubfolders.checked;

    // 获取文件夹名
    const folderName = files[0]?.webkitRelativePath?.split('/')[0] || '该文件夹';

    // 筛选视频文件
    let videoFiles = files.filter(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return VIDEO_FORMATS.includes(ext);
    });

    // 如果不包含子文件夹，只保留根目录的文件
    if (!includeSubfolders) {
        videoFiles = videoFiles.filter(file => {
            const relativePath = file.webkitRelativePath;
            if (relativePath) {
                const pathParts = relativePath.split('/');
                return pathParts.length === 2;
            }
            return true;
        });
    }

    if (videoFiles.length === 0) {
        showToast('⚠️ 未找到视频文件！支持格式：' + VIDEO_FORMATS.join(', '));
        return;
    }

    // 保存文件夹信息
    storage.setItem('lastFolderName', folderName);
    storage.setItem('lastFolderTimestamp', Date.now().toString());

    processFiles(videoFiles);
}

// 处理拖拽的文件
async function handleDroppedItems(items) {
    const files = [];
    const includeSubfolders = elements.includeSubfolders.checked;

    for (const item of items) {
        if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry?.();
            if (entry) {
                if (entry.isDirectory) {
                    const dirFiles = await readDirectory(entry, includeSubfolders);
                    files.push(...dirFiles);
                } else {
                    files.push(item.getAsFile());
                }
            }
        }
    }

    // 获取文件夹名
    const folderName = files[0]?.webkitRelativePath?.split('/')[0] || '拖拽的文件夹';
    storage.setItem('lastFolderName', folderName);
    storage.setItem('lastFolderTimestamp', Date.now().toString());

    processFiles(files);
}

// 递归读取目录
async function readDirectory(directoryEntry, includeSubfolders = true) {
    const files = [];
    const reader = directoryEntry.createReader();
    const entries = await new Promise((resolve) => {
        reader.readEntries(resolve);
    });

    for (const entry of entries) {
        if (entry.isDirectory) {
            if (includeSubfolders) {
                const subFiles = await readDirectory(entry, includeSubfolders);
                files.push(...subFiles);
            }
            // 如果不包含子文件夹，跳过目录
        } else {
            const file = await new Promise((resolve) => {
                entry.file(resolve);
            });
            files.push(file);
        }
    }
    return files;
}

// 处理文件
function processFiles(files, folderHandle = null) {
    state.includeSubfolders = elements.includeSubfolders.checked;
    state.folderHandle = folderHandle;

    // 筛选视频文件
    const videoFiles = files.filter(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return VIDEO_FORMATS.includes(ext);
    });

    if (videoFiles.length === 0) {
        showToast('⚠️ 未找到视频文件！支持格式：' + VIDEO_FORMATS.join(', '));
        return;
    }

    state.videos = videoFiles;
    state.playlist = [...videoFiles];
    state.currentIndex = 0;

    // 如果开启随机播放，打乱顺序（每次都会重新打乱）
    if (state.options.shuffle) {
        shufflePlaylistArray();
    }

    showLoading(true);

    if (isDesktopApp) {
        desktopState.mode = 'mpv';
        desktopState.navigationRequest += 1;
        renderVideos(0);
        updateVideoInfoBar();
        showPlayer();

        requestAnimationFrame(() => requestAnimationFrame(() => {
            ensureDesktopPlayer().then(() => {
                loadVideoAroundIndex(state.currentIndex);
                scheduleDesktopSurfaceSync();
                showLoading(false);
            }).catch(error => {
                console.error('启动 Windows 播放内核失败:', error);
                showLoading(false);
                showToast(`❌ 播放内核启动失败：${error?.message || error}`);
            });
        }));
        return;
    }

    // 延迟加载以确保UI更新
    setTimeout(() => {
        renderVideos();
        updateVideoInfoBar();
        showPlayer();
        showLoading(false);
    }, 300);
}

// 渲染视频（懒加载模式）
function renderVideos(targetIndex = 0) {
    elements.videoContainer.innerHTML = '';

    const safeIndex = Math.max(0, Math.min(targetIndex, state.playlist.length - 1));
    if (isDesktopApp) {
        const videoItem = document.createElement('div');
        videoItem.className = 'video-item desktop-video-item';
        createDesktopVideoSurface(videoItem, safeIndex);
        elements.videoContainer.appendChild(videoItem);
        renderPlaylist();
        loadVideoAroundIndex(safeIndex);
        return;
    }

    // 只创建占位符，不直接创建video元素
    state.playlist.forEach((video, index) => {
        const videoItem = document.createElement('div');
        videoItem.className = 'video-item';
        videoItem.dataset.index = index;

        // 创建左上角触发区域
        const infoTrigger = document.createElement('div');
        infoTrigger.className = 'video-info-trigger';
        infoTrigger.title = '查看视频信息';
        // 鼠标悬停触发区域显示视频信息
        infoTrigger.addEventListener('mouseenter', () => {
            if (!state.isReshuffling) {
                showVideoInfo(index);
            }
        });
        infoTrigger.addEventListener('mouseleave', () => {
            if (!state.isReshuffling) {
                hideVideoInfo();
            }
        });
        videoItem.appendChild(infoTrigger);

        // 创建占位符
        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        placeholder.innerHTML = `<span class="placeholder-text">视频 ${index + 1}</span>`;
        placeholder.dataset.index = index;
        videoItem.appendChild(placeholder);

        elements.videoContainer.appendChild(videoItem);
    });

    renderPlaylist();
    loadVideoAroundIndex(safeIndex);
}

// 加载指定索引周围的视频（懒加载）
function loadVideoAroundIndex(index) {
    const videoItems = elements.videoContainer.querySelectorAll('.video-item');

    if (isDesktopApp) {
        state.currentIndex = index;
        const surface = elements.videoContainer.querySelector('.native-video-surface');
        if (surface) surface.dataset.index = index;

        if (desktopState.started && state.playlist[index]?.path) {
            queueDesktopNavigation(index);
        }

        updateVideoCount();
        updatePlaylistHighlight();
        scheduleDesktopSurfaceSync();
        return;
    }

    const preloadRange = 2; // 预加载前后各2个视频

    // 计算需要加载的视频范围
    const startIndex = Math.max(0, index - preloadRange);
    const endIndex = Math.min(state.playlist.length - 1, index + preloadRange);

    // 释放不在范围内的video元素
    videoItems.forEach((item, i) => {
        if (i < startIndex || i > endIndex) {
            const existingVideo = item.querySelector('video');
            if (existingVideo) {
                existingVideo.pause();
                existingVideo.src = '';
                item.innerHTML = `<div class="video-placeholder"><span class="placeholder-text">视频 ${i + 1}</span></div>`;
            }
        }
    });

    // 加载范围内的视频
    for (let i = startIndex; i <= endIndex; i++) {
        const item = videoItems[i];
        if (!item.querySelector('video')) {
            createVideoElement(item, i);
        }
    }

    state.currentIndex = index;
    updateVideoCount();
    updatePlaylistHighlight();
}

function createDesktopVideoSurface(item, index) {
    const surface = document.createElement('div');
    surface.className = 'native-video-surface';
    surface.dataset.index = index;
    surface.addEventListener('pointerdown', () => window.focus(), { passive: true });
    surface.addEventListener('click', togglePlay);
    item.appendChild(surface);
}

// 创建视频元素
function createVideoElement(item, index) {
    const video = state.playlist[index];

    // 保存触发区域（如果存在）
    const infoTrigger = item.querySelector('.video-info-trigger');

    // 清空占位符
    item.innerHTML = '';

    // 如果有触发区域，重新添加
    if (infoTrigger) {
        item.appendChild(infoTrigger);
    }

    const videoEl = document.createElement('video');
    videoEl.src = URL.createObjectURL(video._file || video);
    videoEl.preload = 'metadata';
    videoEl.loop = state.options.loopSingle;
    videoEl.playsInline = true;
    videoEl.dataset.index = index;

    // 视频事件
    videoEl.addEventListener('loadedmetadata', () => {
        // 视频加载完成，如果当前正在显示这个视频的信息，更新时长
        if (videoInfoOverlay && videoInfoOverlay.classList.contains('show') && parseInt(videoInfoOverlay.dataset.currentIndex) === index) {
            const durationEl = videoInfoOverlay.querySelector('.video-info-duration');
            if (durationEl && videoEl.duration) {
                durationEl.textContent = `时长: ${formatTime(videoEl.duration)}`;
            }
        }
    });

    videoEl.addEventListener('play', () => {
        state.isPlaying = true;
        updatePlayPauseButton();
    });

    videoEl.addEventListener('pause', () => {
        state.isPlaying = false;
        updatePlayPauseButton();
    });

    videoEl.addEventListener('ended', () => {
        if (!state.options.loopSingle && state.options.autoPlay) {
            playNext();
        }
    });

    videoEl.addEventListener('click', togglePlay);

    // 进度更新
    videoEl.addEventListener('timeupdate', () => {
        if (index === state.currentIndex) {
            updateProgress(videoEl);
        }
    });

    item.appendChild(videoEl);

    // 如果是当前视频，自动播放
    if (index === state.currentIndex && state.options.autoPlay) {
        videoEl.play().catch(e => console.log('自动播放被阻止:', e));
    }
}

// 渲染播放列表
function renderPlaylist() {
    elements.playlistContent.innerHTML = '';
    const fragment = document.createDocumentFragment();

    state.playlist.forEach((video, index) => {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        if (index === state.currentIndex) {
            item.classList.add('active');
        }

        item.innerHTML = `
            <span class="icon">🎬</span>
            <div class="info">
                <div class="name">${video.name}</div>
                <div class="duration">${formatFileSize(video.size)}</div>
            </div>
        `;

        item.addEventListener('click', () => {
            scrollToVideo(index);
            elements.playlist.classList.remove('show');
        });

        fragment.appendChild(item);
    });

    elements.playlistContent.appendChild(fragment);
}

// 滚动到指定视频
function scrollToVideo(index) {
    if (index < 0 || index >= state.playlist.length) return;

    if (isDesktopApp) {
        loadVideoAroundIndex(index);
        return;
    }

    const videoItems = elements.videoContainer.querySelectorAll('.video-item');
    const targetItem = videoItems[index];

    if (targetItem) {
        // 先加载视频，再滚动
        loadVideoAroundIndex(index);
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// 处理滚动
function handleScroll() {
    if (isDesktopApp) return;

    const container = elements.videoContainer;
    const scrollTop = container.scrollTop;
    const itemHeight = window.innerHeight;
    const newIndex = Math.round(scrollTop / itemHeight);

    if (newIndex !== state.currentIndex && newIndex >= 0 && newIndex < state.playlist.length) {
        // 加载新位置周围的视频
        loadVideoAroundIndex(newIndex);

        // 暂停其他视频，播放当前视频
        const videoItems = container.querySelectorAll('.video-item');
        videoItems.forEach((item, index) => {
            const video = item.querySelector('video');
            if (video) {
                if (index === newIndex && state.options.autoPlay) {
                    video.play().catch(e => console.log('自动播放被阻止:', e));
                } else {
                    video.pause();
                }
            }
        });
    }

}

function navigateByWheel(deltaY) {
    if (!deltaY) return;

    const now = Date.now();
    if (now - state.lastWheelNavigation < 260) return;
    state.lastWheelNavigation = now;

    if (handleWheel({ deltaY })) return;
    if (deltaY < 0) {
        playPrev();
    } else {
        playNext();
    }
}

// 处理滚轮事件 - 用于边界洗牌
function handleWheel(e) {
    // 冷却期
    if (state.boundaryCooldown && Date.now() - state.boundaryCooldown < 800) {
        return true;
    }

    const container = elements.videoContainer;
    const scrollTop = container.scrollTop;
    const atTop = isDesktopApp ? state.currentIndex === 0 : scrollTop <= 0;
    const atBottom = isDesktopApp
        ? state.currentIndex === state.playlist.length - 1
        : scrollTop >= container.scrollHeight - container.clientHeight - 1;
    const deltaY = e.deltaY;

    // 在顶部向上滚
    if (atTop && state.currentIndex === 0 && deltaY < 0) {
        state.boundaryCooldown = Date.now();
        reshuffleToLast();
        return true;
    }

    // 在底部向下滚
    if (atBottom && state.currentIndex === state.playlist.length - 1 && deltaY > 0) {
        state.boundaryCooldown = Date.now();
        reshuffleToFirst();
        return true;
    }

    return false;
}

// 重新打乱并滚动到顶部
function reshuffleAndScrollToTop() {
    // 防止重复触发
    if (state.isReshuffling) return;
    state.isReshuffling = true;
    state.lastReshuffleTime = Date.now();

    // 重新打乱播放列表
    shufflePlaylistArray();

    // 重新渲染占位符
    renderVideos();

    // 使用 requestAnimationFrame 确保DOM更新完成
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // 滚动到顶部并加载第一个视频
            elements.videoContainer.scrollTop = 0;
            loadVideoAroundIndex(0);

            const firstVideo = getCurrentVideo();
            if (firstVideo && state.options.autoPlay) {
                firstVideo.play().catch(e => console.log('自动播放被阻止:', e));
            }

            // 延迟解锁
            setTimeout(() => {
                state.isReshuffling = false;
            }, 500);
        });
    });
}

// 从底部洗牌到第一个
async function reshuffleToFirst() {
    if (state.isReshuffling) return;
    if (state.playlist.length <= 1) {
        showToast('只有一个视频，到底啦');
        return;
    }
    state.isReshuffling = true;

    // 完全隐藏视频信息浮层
    if (videoInfoOverlay) {
        videoInfoOverlay.classList.add('hidden');
    }

    // 显示加载遮罩
    elements.loading.classList.remove('hidden');

    // 重新打乱
    shufflePlaylistArray();

    if (isDesktopApp) {
        renderVideos(0);
        elements.loading.classList.add('hidden');
        videoInfoOverlay?.classList.remove('hidden');
        state.isReshuffling = false;
        return;
    }

    // 延迟一下
    setTimeout(() => {
        renderVideos();

        setTimeout(() => {
            elements.videoContainer.scrollTop = 0;
            loadVideoAroundIndex(0);

            const firstVideo = getCurrentVideo();
            if (firstVideo && state.options.autoPlay) {
                firstVideo.play().catch(e => {});
            }

            elements.loading.classList.add('hidden');
            // 恢复视频信息浮层
            if (videoInfoOverlay) {
                videoInfoOverlay.classList.remove('hidden');
            }
            state.isReshuffling = false;
        }, 300);
    }, 50);
}

// 从顶部洗牌到最后一个
async function reshuffleToLast() {
    if (state.isReshuffling) return;
    if (state.playlist.length <= 1) {
        showToast('只有一个视频，到底啦');
        return;
    }
    state.isReshuffling = true;

    // 完全隐藏视频信息浮层
    if (videoInfoOverlay) {
        videoInfoOverlay.classList.add('hidden');
    }

    // 显示加载遮罩
    elements.loading.classList.remove('hidden');

    // 重新打乱
    shufflePlaylistArray();

    if (isDesktopApp) {
        renderVideos(state.playlist.length - 1);
        elements.loading.classList.add('hidden');
        videoInfoOverlay?.classList.remove('hidden');
        state.isReshuffling = false;
        return;
    }

    // 延迟一下
    setTimeout(() => {
        renderVideos();

        setTimeout(() => {
            const lastIndex = state.playlist.length - 1;
            elements.videoContainer.scrollTop = elements.videoContainer.scrollHeight;
            loadVideoAroundIndex(lastIndex);

            const lastVideo = getCurrentVideo();
            if (lastVideo && state.options.autoPlay) {
                lastVideo.play().catch(e => {});
            }

            elements.loading.classList.add('hidden');
            // 恢复视频信息浮层
            if (videoInfoOverlay) {
                videoInfoOverlay.classList.remove('hidden');
            }
            state.isReshuffling = false;
        }, 300);
    }, 50);
}

// 重新打乱并滚动到底部
function reshuffleAndScrollToLast() {
    // 防止重复触发
    if (state.isReshuffling) return;
    state.isReshuffling = true;
    state.lastReshuffleTime = Date.now();

    // 重新打乱播放列表
    shufflePlaylistArray();

    const lastIndex = state.playlist.length - 1;
    renderVideos(isDesktopApp ? lastIndex : state.currentIndex);

    if (isDesktopApp) {
        state.isReshuffling = false;
        return;
    }

    // 使用 requestAnimationFrame 确保DOM更新完成
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // 滚动到底部并加载最后一个视频
            elements.videoContainer.scrollTop = elements.videoContainer.scrollHeight;
            loadVideoAroundIndex(lastIndex);

            const lastVideo = getCurrentVideo();
            if (lastVideo && state.options.autoPlay) {
                lastVideo.play().catch(e => console.log('自动播放被阻止:', e));
            }

            // 延迟解锁
            setTimeout(() => {
                state.isReshuffling = false;
            }, 500);
        });
    });
}

// 重新洗牌并保持当前位置
function reshuffleAndKeepPosition() {
    // 保存当前视频信息
    const currentVideoInfo = state.playlist[state.currentIndex];

    // 重新打乱播放列表
    shufflePlaylistArray();

    // 找到刚才那个视频在新列表中的位置
    const newIndex = state.playlist.findIndex(v => v === currentVideoInfo);
    state.currentIndex = newIndex >= 0 ? newIndex : 0;

    // 重新渲染
    renderVideos(state.currentIndex);

    if (isDesktopApp) return;

    // 滚动到新位置
    setTimeout(() => {
        elements.videoContainer.scrollTop = state.currentIndex * window.innerHeight;
        loadVideoAroundIndex(state.currentIndex);

        const currentVideo = getCurrentVideo();
        if (currentVideo && state.options.autoPlay) {
            currentVideo.play().catch(e => console.log('自动播放被阻止:', e));
        }
    }, 100);
}

// 更新视频计数
function updateVideoCount() {
    elements.videoCount.textContent = `${state.currentIndex + 1} / ${state.playlist.length}`;
    updateVideoInfoBar();
    updatePlayerActions();
}

function updatePlayerActions() {
    const currentVideo = state.playlist[state.currentIndex];
    const canOperate = isDesktopApp && Boolean(currentVideo?.path);
    const hasMoveTarget = getMoveFolders().length > 0;

    if (elements.deleteCurrentVideo) {
        elements.deleteCurrentVideo.disabled = !canOperate;
        elements.deleteCurrentVideo.title = canOperate ? '删除当前视频到回收站' : '当前视频不可操作';
    }
    renderMoveTargetActions(canOperate && hasMoveTarget);
}

function closeMoveTargetMenu() {
    activeMoveTargetMenu?.remove();
    activeMoveTargetMenu = null;
}

function moveTargetIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2h7A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/><path d="M8 13h8M13 10l3 3-3 3"/></svg>';
}

function openMoveTargetMenu(button, group) {
    closeMoveTargetMenu();
    const menu = document.createElement('div');
    menu.className = 'move-target-menu';
    menu.innerHTML = `
        <div class="move-target-menu-title">${escapeHtml(group.name || '移动目标')}</div>
        ${group.folders.map(folder => `
            <button class="move-target-menu-item" type="button" data-folder-id="${escapeHtml(folder.id)}">
                <span class="move-target-menu-name">${escapeHtml(folder.name || getFolderName(folder.path))}</span>
                <span class="move-target-menu-path">${escapeHtml(folder.path)}</span>
            </button>
        `).join('')}
    `;
    elements.moveTargetActions.appendChild(menu);
    menu.style.top = `${Math.max(0, button.offsetTop - 4)}px`;
    menu.querySelectorAll('.move-target-menu-item').forEach(item => {
        const folder = group.folders.find(value => value.id === item.dataset.folderId);
        item.addEventListener('click', () => {
            closeMoveTargetMenu();
            moveCurrentVideoToFolder(folder);
        });
    });
    activeMoveTargetMenu = menu;
}

function renderMoveTargetActions(enabled) {
    const container = elements.moveTargetActions;
    if (!container) return;
    closeMoveTargetMenu();
    const groups = getMoveFolderGroups().filter(group => group.folders.length > 0);
    if (groups.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = groups.map(group => `
        <button class="player-action move-target-action" type="button" data-group-id="${escapeHtml(group.id)}"
            title="移动到${escapeHtml(group.name || '目标分组')}" aria-label="移动到${escapeHtml(group.name || '目标分组')}" ${enabled ? '' : 'disabled'}>
            ${moveTargetIcon()}
            <span>${escapeHtml(group.name || '移动')}</span>
        </button>
    `).join('');
    container.querySelectorAll('.move-target-action').forEach(button => {
        const group = groups.find(value => value.id === button.dataset.groupId);
        button.addEventListener('click', () => {
            if (!group) return;
            if (group.folders.length === 1) {
                moveCurrentVideoToFolder(group.folders[0]);
            } else {
                openMoveTargetMenu(button, group);
            }
        });
    });
}

// 更新顶部视频信息栏
function updateVideoInfoBar() {
    if (state.currentIndex >= 0 && state.currentIndex < state.playlist.length) {
        const video = state.playlist[state.currentIndex];
        elements.infoName.textContent = video.name;
        elements.infoSize.textContent = formatFileSize(video.size);
    }
}

// 更新播放列表高亮
function updatePlaylistHighlight() {
    elements.playlistContent.querySelector('.playlist-item.active')?.classList.remove('active');
    elements.playlistContent.children[state.currentIndex]?.classList.add('active');
}

function removeCurrentVideoFromPlaylist(message) {
    const currentVideo = state.playlist[state.currentIndex];
    if (!currentVideo) return;

    const removedIndex = state.currentIndex;
    state.playlist.splice(removedIndex, 1);
    state.videos = state.videos.filter(video => video !== currentVideo && video.path !== currentVideo.path);

    if (state.playlist.length === 0) {
        showToast(message);
        goHome();
        return;
    }

    // 删除当前项后，优先播放原来紧随其后的项；删掉末项时从列表头部继续。
    const nextIndex = removedIndex < state.playlist.length ? removedIndex : 0;
    state.currentIndex = nextIndex;
    renderPlaylist();
    updateVideoCount();
    updatePlaylistHighlight();

    if (isDesktopApp) {
        loadVideoAroundIndex(nextIndex);
        if (state.options.autoPlay) queueDesktopPlay(desktopState.navigationRequest);
    }
    showToast(message);
}

function setPlayerActionBusy(busy) {
    [elements.deleteCurrentVideo, ...document.querySelectorAll('.move-target-action')].forEach(button => {
        if (button) button.disabled = busy;
    });
    if (busy) closeMoveTargetMenu();
}

async function deleteCurrentVideoToRecycleBin() {
    const video = state.playlist[state.currentIndex];
    if (!isDesktopApp || !video?.path) {
        showToast('当前视频无法执行文件操作');
        return;
    }

    if (!window.confirm(`确定将“${video.name}”移动到回收站吗？`)) return;

    setPlayerActionBusy(true);
    try {
        await invokeDesktop('send_to_recycle_bin', { path: video.path });
        removeCurrentVideoFromPlaylist('已移入回收站，已切换到下一个视频');
    } catch (error) {
        console.error('删除视频失败:', error);
        showToast(`删除失败：${error?.message || error}`);
        updatePlayerActions();
    } finally {
        setPlayerActionBusy(false);
        updatePlayerActions();
    }
}

async function moveCurrentVideoToFolder(folder = null) {
    const video = state.playlist[state.currentIndex];
    if (!isDesktopApp || !video?.path) {
        showToast('当前视频无法执行文件操作');
        return;
    }
    if (!folder?.path) {
        showToast('请先在首页配置移动目标文件夹');
        return;
    }

    setPlayerActionBusy(true);
    try {
        await invokeDesktop('move_file_to_folder', {
            path: video.path,
            destinationDir: folder.path
        });
        removeCurrentVideoFromPlaylist(`已移动到“${folder.name || getFolderName(folder.path)}”，已切换到下一个视频`);
    } catch (error) {
        console.error('移动视频失败:', error);
        showToast(`移动失败：${error?.message || error}`);
        updatePlayerActions();
    } finally {
        setPlayerActionBusy(false);
        updatePlayerActions();
    }
}

// 更新循环状态
function updateLoopState() {
    if (isDesktopApp && desktopState.mode === 'mpv') {
        desktopPlayer.loop = state.options.loopSingle;
        return;
    }

    const videos = elements.videoContainer.querySelectorAll('video');
    videos.forEach(video => {
        video.loop = state.options.loopSingle;
    });
}

// 播放/暂停
function togglePlay() {
    const currentVideo = getCurrentVideo();
    if (currentVideo) {
        if (currentVideo.paused) {
            currentVideo.play();
        } else {
            currentVideo.pause();
        }
    }
}

// 播放/暂停按钮点击处理
function togglePlayPause() {
    const currentVideo = getCurrentVideo();
    if (currentVideo) {
        if (currentVideo.paused) {
            currentVideo.play();
        } else {
            currentVideo.pause();
        }
        updatePlayPauseButton();
    }
}

// 更新播放/暂停按钮图标
function updatePlayPauseButton() {
    const currentVideo = getCurrentVideo();
    if (currentVideo && elements.playPauseBtn) {
        if (currentVideo.paused) {
            elements.playPauseBtn.textContent = '▶️';
            elements.playPauseBtn.title = '播放';
        } else {
            elements.playPauseBtn.textContent = '⏸️';
            elements.playPauseBtn.title = '暂停';
        }
    }
}

// 上一个
function playPrev() {
    if (state.playlist.length <= 1) {
        showToast('只有一个视频，到底啦');
        return;
    }
    const newIndex = state.currentIndex > 0 ? state.currentIndex - 1 : state.playlist.length - 1;
    jumpToVideo(newIndex);
}

// 下一个
function playNext() {
    if (state.playlist.length <= 1) {
        showToast('只有一个视频，到底啦');
        return;
    }
    const newIndex = state.currentIndex < state.playlist.length - 1 ? state.currentIndex + 1 : 0;
    jumpToVideo(newIndex);
}

// 随机打乱（只打乱数组，不渲染）
function shufflePlaylistArray() {
    // Fisher-Yates 洗牌算法
    for (let i = state.playlist.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.playlist[i], state.playlist[j]] = [state.playlist[j], state.playlist[i]];
    }
    state.currentIndex = 0;
}

// 随机打乱并重新渲染
function shufflePlaylist() {
    shufflePlaylistArray();
    renderVideos();
}

// 获取当前视频
function getCurrentVideo() {
    if (isDesktopApp) {
        return state.playlist.length > 0 ? desktopPlayer : null;
    }

    const videoItems = elements.videoContainer.querySelectorAll('.video-item');
    const currentItem = videoItems[state.currentIndex];
    return currentItem ? currentItem.querySelector('video') : null;
}

// 跳转到指定视频
function jumpToVideo(index) {
    if (index < 0 || index >= state.playlist.length) return;

    if (isDesktopApp) {
        loadVideoAroundIndex(index);
        if (state.options.autoPlay) {
            queueDesktopPlay(desktopState.navigationRequest);
        }
        return;
    }

    const videoItems = elements.videoContainer.querySelectorAll('.video-item');
    const targetItem = videoItems[index];

    if (targetItem) {
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'start' });
        loadVideoAroundIndex(index);

        const currentVideo = getCurrentVideo();
        if (currentVideo && state.options.autoPlay) {
            currentVideo.play().catch(e => console.log('自动播放被阻止:', e));
        }
    }
}

// 显示播放器
function showPlayer() {
    elements.homePage.classList.add('hidden');
    elements.playerPage.classList.remove('hidden');
    if (isDesktopApp) {
        document.body.classList.add('desktop-player-mode');
    }
    setBackgroundActive(isDesktopApp);
    // 隐藏继续观看按钮
    elements.continueWatching.classList.add('hidden');
    if (isDesktopApp) scheduleDesktopSurfaceSync();
}

// 返回首页
function goHome() {
    // 暂停并释放所有视频
    const videos = elements.videoContainer.querySelectorAll('video');
    videos.forEach(video => {
        video.pause();
        video.src = ''; // 释放内存
    });

    if (isDesktopApp && desktopState.started) {
        desktopState.navigationRequest += 1;
        if (desktopState.fullscreen) {
            invokeDesktop('set_fullscreen', { fullscreen: false }).catch(() => {});
            desktopState.fullscreen = false;
        }
        invokeDesktop('plugin:libmpv|destroy', { windowLabel: MPV_WINDOW_LABEL })
            .catch(error => console.debug('停止 libmpv 失败:', error));
        desktopState.started = false;
        desktopState.mode = 'idle';
        desktopState.lastSurfaceRect = '';
    }

    if (isDesktopApp && !desktopState.started) {
        desktopState.navigationRequest += 1;
        desktopState.mode = 'idle';
    }

    // 重置状态
    state.videos = [];
    state.playlist = [];
    state.currentIndex = 0;

    // 清空容器
    elements.videoContainer.innerHTML = '';

    // 显示首页
    elements.playerPage.classList.add('hidden');
    elements.homePage.classList.remove('hidden');
    if (isDesktopApp) {
        document.body.classList.remove('desktop-player-mode');
    }
    setBackgroundActive(true);
    elements.playlist.classList.remove('show');

    // 重新显示继续观看按钮
    loadLastFolder();
}

// 显示/隐藏加载
function showLoading(show) {
    elements.loading.classList.toggle('hidden', !show);
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 更新进度条
function updateProgress(video) {
    if (!video.duration) return;

    const percent = (video.currentTime / video.duration) * 100;
    elements.progressBar.style.width = percent + '%';
    elements.currentTime.textContent = formatTime(video.currentTime);
    elements.totalTime.textContent = formatTime(video.duration);
}

// 处理进度条点击
function handleProgressClick(e) {
    const currentVideo = getCurrentVideo();
    if (!currentVideo || !currentVideo.duration) return;

    const rect = elements.progressWrapper.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    currentVideo.currentTime = percent * currentVideo.duration;
}

// 格式化时间
function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

// 键盘快捷键
function handleKeyboard(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // 调试：检测所有键盘事件
    if (e.ctrlKey && e.altKey) {
        console.log('🎯 检测到 Ctrl + Alt 组合, key:', e.key, 'keyCode:', e.keyCode);
    }

    // 只在播放页面生效
    if (elements.playerPage.classList.contains('hidden')) {
        console.log('不在播放页面，快捷键忽略');
        return;
    }

    const currentVideo = getCurrentVideo();
    if (!currentVideo) {
        console.log('没有当前视频，快捷键忽略');
        return;
    }

    switch(key) {
        case ' ':
        case 'k':
            // 空格或K键：播放/暂停
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            // 左箭头：后退5秒
            e.preventDefault();
            currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 5);
            break;
        case 'ArrowRight':
            // 右箭头：前进5秒
            e.preventDefault();
            currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 5);
            break;
        case 'ArrowUp':
            // 上箭头：上一个视频
            e.preventDefault();
            playPrev();
            break;
        case 'ArrowDown':
            // 下箭头：下一个视频
            e.preventDefault();
            playNext();
            break;
        case 'Home':
            // Home键：跳到第一个视频
            e.preventDefault();
            jumpToVideo(0);
            break;
        case 'End':
            // End键：跳到最后一个视频
            e.preventDefault();
            jumpToVideo(state.playlist.length - 1);
            break;
        case 'j':
            // J键：后退10秒
            e.preventDefault();
            currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 10);
            break;
        case 'l':
            // L键：前进10秒
            e.preventDefault();
            currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 10);
            break;
        case 'f':
            // F键：全屏
            e.preventDefault();
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                currentVideo.requestFullscreen?.();
            }
            break;
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
            // 数字键：跳转到对应百分比位置
            e.preventDefault();
            const percent = parseInt(e.key) * 10;
            currentVideo.currentTime = currentVideo.duration * (percent / 100);
            break;
    }

    // Ctrl + Alt + C 复制文件名
    if (e.ctrlKey && e.altKey && key === 'c') {
        e.preventDefault();
        console.log('快捷键触发: Ctrl + Alt + C');
        copyCurrentFileName();
    }
}

// 复制当前文件名到剪贴板
function copyCurrentFileName() {
    console.log('copyCurrentFileName 被调用');
    console.log('currentIndex:', state.currentIndex, 'playlist长度:', state.playlist.length);

    if (state.currentIndex >= 0 && state.currentIndex < state.playlist.length) {
        const video = state.playlist[state.currentIndex];
        console.log('video对象:', video);
        console.log('webkitRelativePath:', video.webkitRelativePath);
        console.log('name:', video.name);

        // 使用 webkitRelativePath 获取相对路径（包含父目录），如果不存在则使用文件名
        // 将路径中的 / 替换为 Windows 风格的 \
        let pathToCopy = video.path || video.webkitRelativePath || video.name;
        pathToCopy = pathToCopy.replace(/\//g, '\\');
        console.log('准备复制路径:', pathToCopy);

        navigator.clipboard.writeText(pathToCopy).then(() => {
            console.log('复制成功!');
            // 显示复制成功提示，只显示文件名不含路径
            showToast(`${video.name} 已复制到剪贴板`);
        }).catch(err => {
            console.error('复制失败:', err);
            showToast('❌ 复制失败');
        });
    } else {
        console.log('没有当前视频');
    }
}

// 显示提示信息
function showToast(message) {
    // 移除旧的提示
    const existingToast = document.querySelector('.toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // 2秒后自动消失
    setTimeout(() => {
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// 创建视频信息浮层
function createVideoInfoOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'video-info';
    overlay.innerHTML = `
        <div class="video-info-name"></div>
        <div class="video-info-size"></div>
        <div class="video-info-duration"></div>
        <div class="video-info-progress"></div>
    `;
    elements.playerPage.appendChild(overlay);
    return overlay;
}

// 显示视频信息
function showVideoInfo(index) {
    // 如果正在洗牌，不显示视频信息
    if (state.isReshuffling) return;

    if (!videoInfoOverlay) {
        videoInfoOverlay = createVideoInfoOverlay();
    }

    const video = state.playlist[index];
    if (video) {
        videoInfoOverlay.dataset.currentIndex = index;
        videoInfoOverlay.querySelector('.video-info-name').textContent = video.name;
        videoInfoOverlay.querySelector('.video-info-size').textContent = formatFileSize(video.size);
        videoInfoOverlay.querySelector('.video-info-progress').textContent = `${index + 1} / ${state.playlist.length}`;

        // 获取视频时长
        const videoItem = elements.videoContainer.querySelectorAll('.video-item')[index];
        const videoEl = videoItem?.querySelector('video');
        if (isDesktopApp && index === state.currentIndex && Number.isFinite(desktopPlayer.duration)) {
            videoInfoOverlay.querySelector('.video-info-duration').textContent = `时长: ${formatTime(desktopPlayer.duration)}`;
        } else if (videoEl && videoEl.duration) {
            videoInfoOverlay.querySelector('.video-info-duration').textContent = `时长: ${formatTime(videoEl.duration)}`;
        } else {
            videoInfoOverlay.querySelector('.video-info-duration').textContent = '时长: 加载中...';
        }

        videoInfoOverlay.classList.add('show');
    }
}

// 隐藏视频信息
function hideVideoInfo() {
    if (videoInfoOverlay) {
        videoInfoOverlay.classList.remove('show');
    }
}

// 启动
init();
