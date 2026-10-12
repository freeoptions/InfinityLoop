// 预览独立取帧，任何悬停操作都不会改动主播放器的 currentTime。
const seekPreview = (() => {
    const wrapper = document.getElementById('progress-wrapper');
    const popup = document.getElementById('seek-preview');
    const image = document.getElementById('seek-preview-image');
    const status = document.getElementById('seek-preview-status');
    const time = document.getElementById('seek-preview-time');
    const marker = document.getElementById('seek-marker');
    const cache = new Map();
    const MAX_ENTRIES = 64;
    const MAX_BYTES = 8 * 1024 * 1024;
    const INTERVAL = 140;
    let cacheBytes = 0;
    let media = null;
    let mediaPath = '';
    let session = 0;
    let active = false;
    let busy = false;
    let wanted = null;
    let timer = null;
    let lastRequest = 0;
    let browserVideo = null;
    let cancelBrowserWait = null;
    const failures = new Set();

    function hide() {
        active = false;
        wanted = null;
        clearTimeout(timer);
        timer = null;
        popup.hidden = true;
        marker.hidden = true;
        if (busy) {
            if (isDesktopApp) invokeDesktop('cancel_seek_preview').catch(() => {});
            else cancelBrowserWait?.();
        }
    }

    function reset() {
        hide();
        session += 1;
        media = null;
        mediaPath = '';
        image.hidden = true;
        image.removeAttribute('src');
        for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
        cache.clear();
        failures.clear();
        cacheBytes = 0;
        if (browserVideo) {
            browserVideo.pause();
            browserVideo.removeAttribute('src');
            browserVideo.load();
            browserVideo = null;
        }
    }

    function syncMedia() {
        const next = state.playlist[state.currentIndex] || null;
        const path = next?.path || '';
        if (next !== media || path !== mediaPath) {
            reset();
            media = next;
            mediaPath = path;
        }
    }

    function showStatus(text) {
        image.hidden = true;
        status.textContent = text;
        status.hidden = false;
    }

    function showImage(entry) {
        image.src = entry.url;
        image.hidden = false;
        status.hidden = true;
    }

    function remember(key, blob) {
        const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
        cache.set(key, entry);
        cacheBytes += entry.bytes;
        while (cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
            const oldest = cache.keys().next().value;
            const removed = cache.get(oldest);
            URL.revokeObjectURL(removed.url);
            cacheBytes -= removed.bytes;
            cache.delete(oldest);
        }
        return cache.get(key);
    }

    function schedule() {
        if (!active || busy || timer || !wanted) return;
        timer = setTimeout(() => {
            timer = null;
            pump();
        }, Math.max(0, INTERVAL - (performance.now() - lastRequest)));
    }

    async function pump() {
        if (!active || busy || !wanted) return;
        const request = wanted;
        const cached = cache.get(request.key);
        if (cached) {
            showImage(cached);
            return;
        }
        if (failures.has(request.key)) {
            showStatus('此位置暂无法预览');
            return;
        }
        busy = true;
        lastRequest = performance.now();
        const requestSession = session;
        try {
            let blob;
            if (isDesktopApp) {
                const bytes = await invokeDesktop('get_seek_preview', {
                    path: mediaPath,
                    seconds: request.seconds
                });
                blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
            } else {
                blob = await captureBrowserFrame(request.seconds);
            }
            if (session !== requestSession) return;
            const entry = remember(request.key, blob);
            if (active && wanted?.key === request.key && entry) showImage(entry);
        } catch (error) {
            // 离开、切片取消不缓存成失败，重新悬停时仍可重试。
            if (session === requestSession && active && !String(error).includes('取消')) {
                failures.add(request.key);
                if (failures.size > MAX_ENTRIES) failures.delete(failures.values().next().value);
                if (wanted?.key === request.key) showStatus('此位置暂无法预览');
                console.debug('视频预览取帧失败:', error);
            }
        } finally {
            busy = false;
            if (active && wanted && !cache.has(wanted.key) && !failures.has(wanted.key)) schedule();
        }
    }

    function waitForVideo(video, event, action) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error('预览取帧超时')), 5000);
            const done = () => finish();
            const failed = () => finish(new Error('该视频无法预览'));
            const cancel = () => finish(new Error('预览已取消'));
            function finish(error) {
                clearTimeout(timeout);
                video.removeEventListener(event, done);
                video.removeEventListener('error', failed);
                if (cancelBrowserWait === cancel) cancelBrowserWait = null;
                if (error) reject(error);
                else resolve();
            }
            cancelBrowserWait = cancel;
            video.addEventListener(event, done, { once: true });
            video.addEventListener('error', failed, { once: true });
            try { action(); } catch (error) { finish(error); }
        });
    }

    async function captureBrowserFrame(seconds) {
        const source = getCurrentVideo()?.src;
        if (!source) throw new Error('没有可预览的视频');
        if (!browserVideo) {
            browserVideo = document.createElement('video');
            browserVideo.muted = true;
            browserVideo.preload = 'auto';
            browserVideo.playsInline = true;
        }
        const video = browserVideo;
        const requestSession = session;
        if (video.src !== source || video.readyState < 2) {
            await waitForVideo(video, 'loadeddata', () => { video.src = source; video.load(); });
        }
        if (requestSession !== session || !active) throw new Error('预览已取消');
        if (video.seeking || Math.abs(video.currentTime - seconds) > 0.01) {
            await waitForVideo(video, 'seeked', () => { video.currentTime = seconds; });
        }
        if (requestSession !== session || !active) throw new Error('预览已取消');
        if (!video.videoWidth || !video.videoHeight) throw new Error('没有可预览的画面');
        const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve, reject) => canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error('预览画面生成失败')),
            'image/jpeg', 0.75
        ));
    }

    function move(event) {
        if (event.pointerType === 'touch') return;
        syncMedia();
        const duration = getCurrentVideo()?.duration;
        const rect = wrapper.getBoundingClientRect();
        if (!media || !Number.isFinite(duration) || duration <= 0 || rect.width <= 0) {
            hide();
            return;
        }
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        // 半秒粒度复用缩略图，末尾留一帧空间，避免请求 EOF 空画面。
        const seconds = Math.min(Math.floor(ratio * duration * 2) / 2, Math.max(0, duration - 0.1));
        const key = seconds.toFixed(3);
        const changed = wanted?.key !== key;
        wanted = { key, seconds };
        active = true;
        popup.hidden = false;
        marker.hidden = false;
        marker.style.left = `${ratio * 100}%`;
        time.textContent = formatTime(ratio * duration);
        const width = popup.getBoundingClientRect().width;
        // 即便控件所在区域比预览框窄，也不越过窗口边界。
        const left = Math.max(8 - rect.left, Math.min(
            ratio * rect.width - width / 2,
            window.innerWidth - 8 - width - rect.left
        ));
        popup.style.left = `${left}px`;
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            showImage(cached);
        } else if (failures.has(key)) {
            showStatus('此位置暂无法预览');
        } else {
            if (changed) showStatus('正在加载预览…');
            schedule();
        }
    }

    function bind() {
        wrapper.addEventListener('pointerenter', move);
        wrapper.addEventListener('pointermove', move);
        wrapper.addEventListener('pointerleave', hide);
        window.addEventListener('blur', hide);
        window.addEventListener('resize', hide);
        document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
        image.addEventListener('error', () => showStatus('此位置暂无法预览'));
    }

    return { bind, reset, syncMedia };
})();
