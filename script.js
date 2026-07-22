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
    uploadArea: document.getElementById('upload-area'),
    folderInput: document.getElementById('folder-input'),
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
    tipText: document.getElementById('tip-text')
};

// Tauri 桌面桥接。浏览器模式仍然保留，方便继续预览界面；Windows 版本将播放交给 mpv。
const isDesktopApp = Boolean(window.__TAURI__?.core?.invoke);
const desktopState = {
    started: false,
    eventReady: null,
    playlistSignature: '',
    lastSurfaceRect: '',
    lastError: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    filename: '',
    codec: '',
    format: '',
    hwdec: '',
    tracks: [],
    fullscreen: false,
    surfaceSyncFrame: 0
};

function invokeDesktop(command, args = {}) {
    if (!isDesktopApp) {
        return Promise.reject(new Error('当前不是 Windows 桌面模式'));
    }
    return window.__TAURI__.core.invoke(command, args);
}

function sendDesktopCommand(command) {
    if (!desktopState.started) return Promise.resolve();
    return invokeDesktop('mpv_command', { command }).catch(error => {
        console.error('mpv 命令失败:', command, error);
        if (desktopState.lastError !== String(error)) {
            desktopState.lastError = String(error);
            showToast('播放器内核通信失败');
        }
        throw error;
    });
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
    loadIndex(index) {
        if (!desktopState.started) return Promise.resolve();
        return sendDesktopCommand(['playlist-play-index', String(index)]);
    },
    loadPlaylist() {
        if (!desktopState.started || state.playlist.length === 0) return Promise.resolve();
        const paths = state.playlist.map(video => video.path).filter(Boolean);
        if (paths.length !== state.playlist.length) {
            return Promise.reject(new Error('桌面播放器缺少文件路径'));
        }
        desktopState.playlistSignature = paths.join('\u0000');
        return invokeDesktop('mpv_load_playlist', {
            paths,
            index: state.currentIndex
        });
    }
};

function getTauriPayload(event) {
    return event && Object.prototype.hasOwnProperty.call(event, 'payload') ? event.payload : event;
}

function handleDesktopProperty(payload) {
    const name = payload?.name;
    const value = payload?.value;
    if (!name) return;

    switch (name) {
        case 'time-pos':
            desktopState.currentTime = Number.isFinite(Number(value)) ? Number(value) : 0;
            updateProgress(desktopPlayer);
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
        case 'playlist-pos': {
            const index = Number(value);
            if (Number.isInteger(index) && index >= 0 && index < state.playlist.length) {
                state.currentIndex = index;
                updateVideoCount();
                updatePlaylistHighlight();
                const target = elements.videoContainer.querySelectorAll('.video-item')[index];
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                scheduleDesktopSurfaceSync();
            }
            break;
        }
        case 'filename':
            desktopState.filename = String(value || '');
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
        default:
            break;
    }
}

function handleDesktopInput(args) {
    if (!Array.isArray(args) || args.length === 0) return;

    switch (args[0]) {
        case 'infinity-loop-wheel-up':
            if (!handleWheel({ deltaY: -1 })) playPrev();
            break;
        case 'infinity-loop-wheel-down':
            if (!handleWheel({ deltaY: 1 })) playNext();
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
        showToast('桌面事件桥接不可用');
        return;
    }

    desktopState.eventReady = Promise.all([
        listen('mpv-property', event => handleDesktopProperty(getTauriPayload(event))),
        listen('mpv-event', event => {
            const payload = getTauriPayload(event);
            if (payload?.event === 'client-message') {
                handleDesktopInput(payload.args);
            } else if (payload?.event === 'backend-exited' && desktopState.started) {
                desktopState.started = false;
                showToast('播放器内核已退出');
            } else if (payload?.event === 'end-file' && payload?.reason === 'error') {
                showToast(`❌ 当前文件无法播放${payload.error ? `：${payload.error}` : ''}`);
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
    await invokeDesktop('mpv_start');
    desktopState.started = true;
    desktopState.playlistSignature = '';
}

function getDesktopPath(video) {
    return video?.path || '';
}

function getPlaylistSignature() {
    return state.playlist.map(getDesktopPath).join('\u0000');
}

function syncDesktopSurface() {
    if (!isDesktopApp || !desktopState.started) return;

    const item = elements.videoContainer.querySelectorAll('.video-item')[state.currentIndex];
    const surface = item?.querySelector('.native-video-surface');
    if (!surface) {
        invokeDesktop('mpv_resize', { x: 0, y: 0, width: 1, height: 1, visible: false }).catch(() => {});
        return;
    }

    const rect = surface.getBoundingClientRect();
    const visible = rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.top < window.innerHeight;
    const nextRect = [rect.left, rect.top, rect.width, rect.height, visible].map(value => Math.round(Number(value) || 0)).join(',');
    if (nextRect === desktopState.lastSurfaceRect) return;
    desktopState.lastSurfaceRect = nextRect;

    invokeDesktop('mpv_resize', {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible
    }).catch(error => console.debug('调整 mpv 画面失败:', error));
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
const DB_VERSION = 1;
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
    currentLayer: 1
};

// 使用清单按需加载，避免启动时探测并解码全部超大背景图。
function loadBackgroundImages() {
    const images = Array.isArray(window.INFINITY_LOOP_BACKGROUNDS)
        ? window.INFINITY_LOOP_BACKGROUNDS.filter(path => typeof path === 'string' && path)
        : [];

    if (images.length === 0) {
        console.warn('未找到背景图片清单');
        return;
    }

    bgState.images = images;
    bgState.currentIndex = Math.floor(Math.random() * images.length);
    startBgRotation();
}

// 开始背景图轮播
function startBgRotation() {
    if (bgState.images.length === 0) return;

    // 设置初始背景（直接显示，不渐变）
    const initialBg = bgState.images[bgState.currentIndex];
    bgState.bgLayer1.style.backgroundImage = `url('${initialBg}')`;

    // 每6秒随机切换（避免短期内重复）
    bgState.intervalId = setInterval(() => {
        let newIndex;
        let attempts = 0;
        do {
            newIndex = Math.floor(Math.random() * bgState.images.length);
            attempts++;
        } while (newIndex === bgState.currentIndex && bgState.images.length > 1 && attempts < 10);
        bgState.currentIndex = newIndex;
        updateBgImage();
    }, 5000);
}

// 更新背景图（渐隐→切换→渐显）
function updateBgImage() {
    if (bgState.images.length === 0) return;

    const currentBg = bgState.images[bgState.currentIndex];

    // 确定当前显示的背景层和下一个要显示的背景层
    const currentBgLayer = bgState.currentLayer === 1 ? bgState.bgLayer1 : bgState.bgLayer2;
    const nextBgLayer = bgState.currentLayer === 1 ? bgState.bgLayer2 : bgState.bgLayer1;

    // 预加载新图片
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
        // 1. 设置下一个背景层的图片（但在后面，暂时看不见）
        nextBgLayer.style.backgroundImage = `url('${currentBg}')`;
        nextBgLayer.classList.remove('fade-out');
        nextBgLayer.classList.add('fade-in');

        // 2. 当前背景层渐隐
        currentBgLayer.classList.remove('fade-in');
        currentBgLayer.classList.add('fade-out');

        // 3. 切换当前层标记
        bgState.currentLayer = bgState.currentLayer === 1 ? 2 : 1;
    };
    img.src = currentBg;
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
    loadBackgroundImages();
    loadIncludeSubfoldersOption();
    console.log('✅ 播放器初始化完成');
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
    return new Promise((resolve, reject) => {
        // 先清理旧的共享数据库
        const oldDbName = 'VideoPlayerDB'; // 清理旧版本遗留数据库
        const deleteReq = indexedDB.deleteDatabase(oldDbName);
        deleteReq.onsuccess = () => console.log('✅ 已清理旧数据库');
        deleteReq.onerror = () => {}; // 忽略删除失败

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
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
        };
    });
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
            console.log('📁 读取文件:', fullPath); // 调试输出
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
            console.log('✅ 文件对象 webkitRelativePath:', fileWithPath.webkitRelativePath); // 调试输出
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
            // 降级到普通文件选择
            elements.folderInput.click();
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('加载失败:', error);
        }
    }
}

// Windows 桌面模式使用原生文件夹选择器和 mpv 可读取的真实路径。
async function openDesktopFolder(folderPath = null) {
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

        const folderName = selectedPath.split(/[\\/]/).filter(Boolean).pop() || selectedPath;
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
    console.log('🔗 绑定事件监听器...');

    // 上传区域点击 - 使用 showDirectoryPicker
    elements.uploadArea.addEventListener('click', async (e) => {
        // 防止重复触发（如果有 input 元素被点击）
        if (e.target.tagName === 'INPUT') return;

        console.log('📁 点击上传区域，开始选择文件夹');

        if (isDesktopApp) {
            await openDesktopFolder();
            return;
        }

        // 如果浏览器支持 File System Access API，直接使用
        if ('showDirectoryPicker' in window) {
            try {
                console.log('🔍 调用 showDirectoryPicker...');
                const handle = await window.showDirectoryPicker();
                console.log('✅ 已选择文件夹:', handle.name);

                const includeSubfolders = elements.includeSubfolders.checked;
                const files = [];
                await readDirectoryHandle(handle, files, includeSubfolders, handle.name + '/');

                // 筛选视频文件
                let videoFiles = files.filter(file => {
                    const ext = '.' + file.name.split('.').pop().toLowerCase();
                    return VIDEO_FORMATS.includes(ext);
                });

                if (videoFiles.length === 0) {
                    showToast('⚠️ 未找到视频文件！支持格式：' + VIDEO_FORMATS.join(', '));
                    return;
                }

                // 保存文件夹信息
                const folderId = Date.now().toString();
                storage.setItem('lastFolderId', folderId);
                storage.setItem('lastFolderName', handle.name);
                storage.setItem('lastFolderTimestamp', Date.now().toString());

                console.log('💾 已保存文件夹信息:', { folderId, folderName: handle.name, instanceId: INSTANCE_ID });
                console.log('💾 验证保存:', storage.getItem('lastFolderId'));

                // 保存句柄到 IndexedDB
                await savePath(folderId, handle, handle.name);
                await loadSavedPaths();

                processFiles(videoFiles, handle);
                showToast('✅ 已启用自动刷新功能');
                return;
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('选择文件夹失败:', err);
                }
                // 用户取消，不继续
                return;
            }
        }

        // 不支持 API，使用普通文件选择器
        elements.folderInput.click();
    });

    // 包含子文件夹选项变化时保存
    elements.includeSubfolders.addEventListener('change', () => {
        const isChecked = elements.includeSubfolders.checked;
        storage.setItem('includeSubfolders', isChecked.toString());
        console.log('💾 已保存"包含子文件夹"选项:', isChecked);
    });

    // 文件夹选择 input 变化事件（用于不支持 File System Access API 的浏览器）
    elements.folderInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            console.log('📁 已选择文件夹（传统方式）:', files.length, '个文件');
            showLoading(true);
            processFiles(files);
            showLoading(false);
        }
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

    // 拖拽上传
    elements.uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.uploadArea.classList.add('drag-over');
    });

    elements.uploadArea.addEventListener('dragleave', () => {
        elements.uploadArea.classList.remove('drag-over');
    });

    elements.uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadArea.classList.remove('drag-over');
        const items = e.dataTransfer.items;
        handleDroppedItems(items);
    });

    if (isDesktopApp && window.__TAURI__.event?.listen) {
        window.__TAURI__.event.listen('tauri://drag-drop', event => {
            const payload = getTauriPayload(event);
            const droppedPath = payload?.paths?.[0];
            if (droppedPath) openDesktopFolder(droppedPath);
        }).catch(error => console.debug('桌面拖拽事件不可用:', error));
    }

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
    elements.videoContainer.addEventListener('wheel', handleWheel, { passive: true });

    // 键盘快捷键
    document.addEventListener('keydown', handleKeyboard);
    if (isDesktopApp) {
        window.addEventListener('resize', scheduleDesktopSurfaceSync);
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

    // 如果开启随机播放，打乱顺序（每次都会重新打乱）
    if (state.options.shuffle) {
        shufflePlaylistArray();
    }

    showLoading(true);

    if (isDesktopApp) {
        ensureDesktopPlayer().then(() => {
            renderVideos();
            updateVideoInfoBar();
            showPlayer();
            scheduleDesktopSurfaceSync();
            showLoading(false);
        }).catch(error => {
            console.error('启动 Windows 播放内核失败:', error);
            showLoading(false);
            showToast(`❌ 播放内核启动失败：${error?.message || error}`);
        });
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
    const safeIndex = Math.max(0, Math.min(targetIndex, state.playlist.length - 1));
    loadVideoAroundIndex(safeIndex);
}

// 加载指定索引周围的视频（懒加载）
function loadVideoAroundIndex(index) {
    const videoItems = elements.videoContainer.querySelectorAll('.video-item');

    if (isDesktopApp) {
        const previousIndex = state.currentIndex;
        state.currentIndex = index;

        videoItems.forEach((item, itemIndex) => {
            const nativeSurface = item.querySelector('.native-video-surface');
            const placeholder = item.querySelector('.video-placeholder');

            if (itemIndex === index) {
                placeholder?.remove();
                if (!nativeSurface) {
                    createDesktopVideoSurface(item, itemIndex);
                }
            } else {
                nativeSurface?.remove();
                if (!placeholder) {
                    const nextPlaceholder = document.createElement('div');
                    nextPlaceholder.className = 'video-placeholder';
                    nextPlaceholder.innerHTML = `<span class="placeholder-text">视频 ${itemIndex + 1}</span>`;
                    nextPlaceholder.dataset.index = itemIndex;
                    item.appendChild(nextPlaceholder);
                }
            }
        });

        const signature = getPlaylistSignature();
        if (desktopState.started && signature && desktopState.playlistSignature !== signature) {
            desktopPlayer.loadPlaylist().catch(error => console.error('同步 mpv 播放列表失败:', error));
        } else if (desktopState.started && previousIndex !== index) {
            desktopPlayer.loadIndex(index).catch(error => console.error('切换 mpv 播放项目失败:', error));
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
    surface.title = '点击播放/暂停';
    surface.addEventListener('click', togglePlay);
    item.appendChild(surface);
}

// 创建视频元素
function createVideoElement(item, index) {
    if (isDesktopApp) {
        createDesktopVideoSurface(item, index);
        return;
    }

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

        elements.playlistContent.appendChild(item);
    });
}

// 滚动到指定视频
function scrollToVideo(index) {
    if (index < 0 || index >= state.playlist.length) return;

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

    if (isDesktopApp) {
        scheduleDesktopSurfaceSync();
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
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop >= container.scrollHeight - container.clientHeight - 1;
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

    // 重新渲染占位符
    renderVideos();

    // 使用 requestAnimationFrame 确保DOM更新完成
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // 滚动到底部并加载最后一个视频
            const lastIndex = state.playlist.length - 1;
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
    renderVideos();

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
    const items = elements.playlistContent.querySelectorAll('.playlist-item');
    items.forEach((item, index) => {
        item.classList.toggle('active', index === state.currentIndex);
    });
}

// 更新循环状态
function updateLoopState() {
    if (isDesktopApp) {
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
        if (desktopState.fullscreen) {
            invokeDesktop('set_fullscreen', { fullscreen: false }).catch(() => {});
            desktopState.fullscreen = false;
        }
        invokeDesktop('mpv_stop').catch(error => console.debug('停止 mpv 失败:', error));
        desktopState.started = false;
        desktopState.playlistSignature = '';
        desktopState.lastSurfaceRect = '';
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

    switch(e.key) {
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
                currentVideo.requestFullscreen();
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
    if (e.ctrlKey && e.altKey && e.key === 'c') {
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
