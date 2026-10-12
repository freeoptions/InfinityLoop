// 隔离验证鼠标预览的异步竞争和缓存；不打开播放器，不读取业务数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(rect = {}) {
        this.hidden = true;
        this.style = {};
        this.listeners = new Map();
        this.rect = rect;
    }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    removeAttribute(name) { delete this[name]; }
    getBoundingClientRect() { return this.rect; }
    dispatch(event, clientX) { this.listeners.get(event)?.({ clientX, pointerType: 'mouse' }); }
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const ids = ['progress-wrapper', 'seek-preview', 'seek-preview-image',
        'seek-preview-status', 'seek-preview-time', 'seek-marker'];
    const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
    nodes['progress-wrapper'].rect = { left: 100, width: 800 };
    nodes['seek-preview'].rect = { width: 224 };
    const video = { duration: 100, currentTime: 17 };
    const state = { playlist: [{ path: 'fixture-a.avi' }], currentIndex: 0 };
    const pending = [];
    const cancelled = [];
    const timers = new Map();
    const liveURLs = new Set();
    let clock = 1000;
    let timerId = 0;
    let urlId = 0;
    const context = vm.createContext({
        document: { getElementById: id => nodes[id], addEventListener() {} },
        window: { innerWidth: 1100, addEventListener() {} },
        state, isDesktopApp: true, getCurrentVideo: () => video,
        formatTime: value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`,
        performance: { now: () => clock },
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        URL: {
            createObjectURL: () => { const url = `blob:test-${++urlId}`; liveURLs.add(url); return url; },
            revokeObjectURL: url => liveURLs.delete(url)
        },
        Blob, Uint8Array, console: { debug() {} },
        invokeDesktop: (name, args) => {
            if (name === 'cancel_seek_preview') { cancelled.push(name); return Promise.resolve(); }
            return new Promise((resolve, reject) => pending.push({ args, resolve, reject }));
        }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'seek-preview.js'), 'utf8'), context);
    vm.runInContext('seekPreview.bind()', context);
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const tick = async () => {
        clock += 140;
        const scheduled = [...timers.values()];
        timers.clear();
        scheduled.forEach(callback => callback());
        await settle();
    };
    const wrapper = nodes['progress-wrapper'];
    const image = nodes['seek-preview-image'];

    wrapper.dispatch('pointerenter', 500);
    await tick();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].args.seconds, 50);
    wrapper.dispatch('pointermove', 740);
    await tick();
    assert.equal(pending.length, 1, '忙碌时不能堆积取帧请求');
    pending.shift().resolve([255, 216, 255, 217]);
    await settle();
    assert.equal(image.hidden, true, '过时的时间点不能覆盖当前预览');
    await tick();
    assert.equal(pending[0].args.seconds, 80, '完成后只处理最新鼠标位置');
    pending.shift().resolve([255, 216, 255, 217]);
    await settle();
    assert.equal(image.hidden, false);
    assert.equal(video.currentTime, 17, '悬停不能改变主播放进度');

    wrapper.dispatch('pointermove', 900);
    await tick();
    assert.equal(pending[0].args.seconds, 99.9, '末端不能取 EOF 空帧');
    assert.ok(parseFloat(nodes['seek-preview'].style.left) + 224 + 100 <= 1092);
    state.playlist[0] = { path: 'fixture-b.avi' };
    vm.runInContext('seekPreview.syncMedia()', context);
    assert.equal(cancelled.length, 1);
    pending.shift().resolve([255, 216, 255, 217]);
    await settle();
    assert.equal(liveURLs.size, 0, '切片必须清理缓存并丢弃旧请求结果');
    assert.equal(nodes['seek-preview'].hidden, true);

    wrapper.dispatch('pointerenter', 100);
    await tick();
    assert.equal(pending[0].args.seconds, 0);
    wrapper.dispatch('pointerleave');
    pending.shift().resolve([255, 216, 255, 217]);
    await settle();
    assert.equal(nodes['seek-preview'].hidden, true, '离开后不能重新显示预览');

    for (let i = 1; i <= 70; i++) {
        wrapper.dispatch('pointermove', 100 + i * 8);
        await tick();
        assert.equal(pending.length, 1);
        pending.shift().resolve([255, 216, 255, 217]);
        await settle();
    }
    assert.equal(liveURLs.size, 64, '预览缓存必须有数量边界');
    vm.runInContext('seekPreview.reset()', context);
    assert.equal(liveURLs.size, 0);

    // 检查真实点击处理函数的左右边界及无效时长保护。
    const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
    const start = source.indexOf('function handleProgressClick(e)');
    const end = source.indexOf('// 格式化时间', start);
    context.elements = { progressWrapper: wrapper };
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext('handleProgressClick({clientX: 50})', context);
    assert.equal(video.currentTime, 0);
    vm.runInContext('handleProgressClick({clientX: 950})', context);
    assert.equal(video.currentTime, 100);
    video.duration = Infinity;
    video.currentTime = 17;
    vm.runInContext('handleProgressClick({clientX: 500})', context);
    assert.equal(video.currentTime, 17);
    console.log('进度条边界、独立预览、最新请求、切片清理、离开隐藏、缓存上限：通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
