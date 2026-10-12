// 纯内存配置与模拟原生桥接；不启动 GUI、不接触用户配置/视频。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { InfinityPlaybackMemory: memory } = require('../playback-memory.js');
const values = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
let now = 10000;
const store = memory.create(storage, { now: () => ++now, capacity: 3 });
const a = { path: 'D:\\视频\\A.mp4', name: 'A.mp4', size: 100, lastModified: 10 };
const b = { ...a, path: 'D:/视频/B.mp4', name: 'B.mp4' };
const c = { ...a, path: 'D:/视频/C.mp4', name: 'C.mp4' };
const ka = memory.identity(a);
assert.equal(ka, memory.identity({ ...a, path: 'd:/视频/a.mp4' }));
assert.notEqual(ka, memory.identity({ ...a, path: 'E:/视频/A.mp4' }));
assert.notEqual(memory.identity({ ...a, path: undefined, webkitRelativePath: 'one/A.mp4' }), memory.identity({ ...a, path: undefined, webkitRelativePath: 'two/A.mp4' }));
store.update(ka, a, 50, 120, false, true);
assert.equal(memory.resumePosition(store.get(ka, a)), 50);
assert.equal(memory.resumePosition({ position: 119, duration: 120 }), 0);
assert.equal(memory.resumePosition({ position: 1, duration: 2 }), 0);
assert.equal(store.setSegment(ka, a, { a: 20, b: 40 }, 120), true);
for (const invalid of [{a:NaN,b:4},{a:4,b:4},{a:-1,b:2},{a:5,b:121}]) assert.equal(store.setSegment(ka,a,invalid,120),false);
const reopened = memory.create(storage);
assert.equal(reopened.get(ka, a).position, 50);
assert.deepEqual(reopened.get(ka, a).segment, { a: 20, b: 40 });
const destination = { ...a, path: 'E:/moved/A.mp4', lastModified: 20 };
store.move(ka, memory.identity(destination), a, destination);
assert.equal(store.get(ka, a), null);
assert.equal(store.get(memory.identity(destination), destination).position, 50);
store.remove(memory.identity(destination));
assert.equal(store.size(), 0);
store.update(ka,a,30,120,false,true);
assert.equal(store.get(ka,{...a,size:200}),null, '同路径被替换时进度和区间失效');
store.update(ka,a,120,120,true,true);
assert.equal(memory.resumePosition(store.get(ka,a)),0);
for (let i=0;i<8;i++) store.update('fixture:'+i,a,1,120,false,true);
assert.equal(store.size(),3);
assert.ok(store.get('fixture:7',a));
assert.equal(memory.create({getItem:()=>'{bad',setItem(){}}).size(),0);
assert.doesNotThrow(()=>memory.create({getItem:()=>null,setItem(){throw Error('full')}}).update(ka,a,20,120,false,true));

class Node {
    constructor() { this.hidden = true; this.style = {}; this.dataset = {}; this.value = ''; this.listeners = new Map(); this.classList = { contains: () => false, add(){}, remove(){}, toggle(){} }; }
    setAttribute() {} removeAttribute() {} addEventListener(name, fn) { this.listeners.set(name, fn); }
    querySelectorAll() { return []; } querySelector() { return null; } focus() {} scrollIntoView() {}
}
async function integration() {
    const root = path.resolve(__dirname,'..');
    const nodes = new Map();
    const raw = new Map();
    const commands = [];
    const timers = [];
    let native = null;
    let mediaId = 0;
    let deferSnapshot = false;
    let resolveSnapshot;
    const invoke = async (name, args) => {
        if (name === 'playback_snapshot') {
            if (deferSnapshot) { deferSnapshot = false; return new Promise(resolve => { resolveSnapshot = resolve; }); }
            return native ? { ...native } : null;
        }
        if (name === 'playback_load') {
            commands.push({name,args});
            native = { generation: args.generation, mediaId: ++mediaId, path: memory.normalizePath(args.path), position: args.start, duration: 120, paused: !args.autoplay, eof: false, speed: args.speed };
        }
        if (name === 'playback_set') {
            commands.push({name,args});
            if (!native || args.generation !== native.generation || args.mediaId !== native.mediaId) return false;
            if (args.name === 'time-pos') { native.position = args.value; native.eof = false; }
            if (args.name === 'pause') native.paused = args.value;
            if (args.name === 'speed') native.speed = args.value;
            return true;
        }
        if (name === 'playback_failure') return args.generation === native?.generation && args.mediaId === native?.mediaId;
        return null;
    };
    const quiet = { log(){},debug(){},warn(){},error(){} };
    const context = vm.createContext({
        InfinityPlaybackMemory: memory, console: quiet, performance: { now: () => now },
        window: { location:{href:'http://isolated.test/'}, __TAURI__: {core:{invoke}}, addEventListener(){}, innerWidth:1000 },
        localStorage:{ getItem:key=>raw.get(key)||null, setItem:(key,value)=>raw.set(key,value), removeItem:key=>raw.delete(key) },
        document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)}, addEventListener(){},createElement:()=>new Node(),activeElement:null},
        btoa:value=>Buffer.from(value).toString('base64'), setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},setInterval(){},
        requestAnimationFrame:fn=>fn(), URL, Blob, Uint8Array
    });
    vm.runInContext(fs.readFileSync(path.join(root,'seek-preview.js'),'utf8'),context);
    vm.runInContext(fs.readFileSync(path.join(root,'script.js'),'utf8').replace(/\ninit\(\);\s*$/,''),context);
    context.files = [a,b,c];
    const run = code => vm.runInContext(code,context);
    run('bindPlaybackFeatures(); state.playlist=files; desktopState.started=true; desktopState.mode="mpv";');
    const settle = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
    const navigate = async index => {run(`state.currentIndex=${index}; queueDesktopNavigation(${index});`);await run('desktopState.navigationChain');await settle();await run('pollDesktopPlayback()');};
    await navigate(0);
    native.position=51.25;
    await run('pollDesktopPlayback()');
    // 故意把真实离开位置放在最后一次属性通知之后，验证切换前重新读取。
    native.position=52.75;
    await navigate(1);
    native.position=12;await run('pollDesktopPlayback()');
    await navigate(0);
    assert.equal(native.position,52.75,'A→B→A 使用真实离开位置恢复');
    const previous = { ...native, position: 88 };
    deferSnapshot = true;
    const stalePoll = run('pollDesktopPlayback()');await settle();
    run('state.currentIndex=1;queueDesktopNavigation(1);state.currentIndex=2;queueDesktopNavigation(2);');
    await run('desktopState.navigationChain');
    resolveSnapshot(previous);await stalePoll;await settle();await run('pollDesktopPlayback()');
    assert.equal(run('playbackSession.active.file.name'),'C.mp4');
    assert.equal(run('playbackSession.active.position'),0,'迟到 A 快照不能污染 C');
    const afterFastSwitch = commands.filter(command=>command.name==='playback_load').slice(-1)[0];
    assert.equal(afterFastSwitch.args.path,c.path);
    run("handleDesktopProperty({name:'time-pos',value:99}); handleDesktopProperty({name:'eof-reached',value:true});");
    assert.equal(run('playbackSession.active.position'),0,'无身份属性通知不参与记录');
    native.duration=null;native.position=8;
    await run('pollDesktopPlayback()');
    assert.equal(run('playbackSession.active.ready'),true,'未知时长不能阻止正常播放控制');
    await run('desktopPlayer.pause()');
    assert.equal(native.paused,true);
    assert.ok(Number.isNaN(run('playbackSession.active.duration')));
    native.duration=120;
    native.position=120;native.eof=true;await run('pollDesktopPlayback()');
    assert.equal(run('playbackMemory.get(videoIdentity(files[2]),files[2]).completed'),true);
    await navigate(0);
    run("playbackUi['segment-a'].value='0:20';playbackUi['segment-b'].value='0:40';saveSegmentDraft();");
    await run('playbackSession.segmentChain');
    assert.equal(run('playbackSession.active.segment.a'),20);
    await run('queueSegmentAction(session=>startSegment(session,false))');
    assert.equal(native.position,20);
    assert.equal(run('playbackSession.active.segmentMode'),'once');
    assert.ok(commands.some(command=>command.args?.name==='end'&&command.args.value===40),'单次区间使用内核终点');
    native.position=40;await run('pollDesktopPlayback()');await run('playbackSession.segmentChain');
    assert.equal(native.paused,true);
    assert.equal(run('playbackSession.active.segmentMode'),'once');
    const beforeAuto=timers.length;
    run('scheduleDesktopNext()');assert.equal(timers.length,beforeAuto,'主动区间优先于自动下一首');
    await run('queueSegmentAction(session=>startSegment(session,true))');
    assert.ok(commands.some(command=>command.args?.name==='ab-loop-b'&&command.args.value===40));
    run('state.options.loopSingle=true;');
    await run('queueSegmentAction(resetSegmentMode)');
    assert.equal(commands.at(-1).args.value,'inf','退出区间恢复整视频循环');
    await navigate(1);
    assert.equal(run('playbackSession.active.segment'),null,'区间不能串到 B');
    await navigate(0);
    assert.equal(run('playbackSession.active.segment.b'),40);
    assert.equal(run('playbackSession.active.segmentMode'),null,'回到 A 只恢复数据，不自动启动区间');
    const speedNode=nodes.get('playback-speed');
    speedNode.value='1.5';await speedNode.listeners.get('change')({target:speedNode});
    assert.equal(native.speed,1.5);assert.equal(run('playbackSession.speed'),1.5);
    await navigate(1);assert.equal(native.speed,1.5);
    assert.equal(run("parseSegmentTime('1:30.25')"),90.25);
    assert.ok(Number.isNaN(run("parseSegmentTime('1:99')")));
    // 浏览器相同元素的真实位置、metadata 后恢复、逐帧区间及过期帧回调。
    const frames = new Map();
    let frameId = 0;
    context.browserFile = { name:'browser.mp4',webkitRelativePath:'folder/browser.mp4',size:321,lastModified:123 };
    context.browserOther = { ...context.browserFile,name:'other.mp4',webkitRelativePath:'folder/other.mp4' };
    context.browserEl = {
        currentTime:0,duration:120,playbackRate:1,paused:true,loop:false,dataset:{index:'0'},
        pause(){this.paused=true},async play(){this.paused=false},
        requestVideoFrameCallback(fn){const id=++frameId;frames.set(id,fn);return id},
        cancelVideoFrameCallback(id){frames.delete(id)}
    };
    context.otherEl = { ...context.browserEl,dataset:{index:'1'} };
    run('leavePlaybackSession(); desktopState.started=false; playbackMemory.update(videoIdentity(browserFile),browserFile,33.5,120,false,true);activateBrowserSession(browserEl,browserFile);');
    assert.equal(context.browserEl.currentTime,33.5);
    assert.equal(context.browserEl.playbackRate,1.5);
    context.browserEl.currentTime=34.75;
    run('activateBrowserSession(otherEl,browserOther);activateBrowserSession(browserEl,browserFile);');
    assert.equal(context.browserEl.currentTime,34.75);
    run('playbackSession.active.segment={a:2,b:4};');
    await run('queueSegmentAction(session=>startSegment(session,false))');
    context.browserEl.currentTime=4.1;
    const onceFrame = [...frames.entries()][0];frames.delete(onceFrame[0]);onceFrame[1]();
    await run('playbackSession.segmentChain');
    assert.equal(context.browserEl.currentTime,4);
    assert.equal(context.browserEl.paused,true);
    await run('queueSegmentAction(session=>startSegment(session,true))');
    context.browserEl.currentTime=4.1;
    const loopFrame = [...frames.entries()][0];frames.delete(loopFrame[0]);loopFrame[1]();
    assert.equal(context.browserEl.currentTime,2);
    const staleFrame = [...frames.values()][0];
    run('activateBrowserSession(otherEl,browserOther);');
    staleFrame();
    assert.equal(context.otherEl.currentTime,0);
    assert.equal(frames.size,0,'离开视频取消持续取帧检查');
    assert.equal(run('playbackSession.active.segmentMode'),null);
    console.log('浏览器 metadata 后恢复、离开位置保存、区间帧边界、循环和过期回调隔离：通过');
    console.log('按视频恢复、真实离开快照、快速切换、迟到事件、自然完成、区间隔离与优先级、倍速实际状态：通过');
}
integration().catch(error=>{console.error(error);process.exitCode=1});
