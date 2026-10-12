// 使用隔离配置验证分组和收藏；不启动应用、不读取或写入用户配置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'script.js'), 'utf8');
const start = source.indexOf('const COMMON_VIDEO_FOLDERS_KEY');
const end = source.indexOf('function renderWallpaperFolderSummary()', start);
assert.ok(start >= 0 && end > start, '必须找到真实分组代码');
const values = new Map();
const writes = [];
const context = vm.createContext({
    storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); writes.push(key); }
    },
    elements: {}, console,
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
});
vm.runInContext(source.slice(start, end), context);
vm.runInContext('renderCommonVideoFolders = () => {}; function renderMoveFolderSummary() {}', context);
const evaluate = expression => vm.runInContext(expression, context);
const ids = expression => JSON.parse(evaluate(`JSON.stringify(${expression}.map(folder => folder.id))`));
const folders = Array.from({ length: 6 }, (_, index) => ({
    id: `f${index + 1}`, name: `文件夹 ${index + 1}`, path: `D:/fixtures/${index + 1}`
}));
const groups = [
    { id: 'g1', name: '第一组', folders },
    { id: 'g2', name: '第二组', folders: [{ id: 'other', name: '其他', path: 'D:/fixtures/other' }] }
];
values.set('moveFolders', JSON.stringify(groups));
values.set('commonVideoFolders', JSON.stringify(groups));
const originalMove = values.get('moveFolders');
const originalCommon = values.get('commonVideoFolders');

evaluate("toggleFolderFavorite('move', 'g1', 'f5')");
evaluate("toggleFolderFavorite('move', 'g1', 'f2')");
assert.deepEqual(ids("getOrderedGroupFolders(getMoveFolderGroups()[0], 'move')"), ['f2', 'f5', 'f1', 'f3', 'f4', 'f6']);
assert.deepEqual(ids("getOrderedGroupFolders(getMoveFolderGroups()[1], 'move')"), ['other']);
assert.deepEqual(ids("getOrderedGroupFolders(getCommonVideoGroups()[0], 'common')"), [...folders.map(folder => folder.id), 'other']);
assert.equal(values.get('moveFolders'), originalMove, '收藏不能改动原分组配置');
assert.equal(values.get('commonVideoFolders'), originalCommon);
assert.ok(writes.every(key => key === 'folderFavorites'));
assert.equal(evaluate("getFavoriteFolderIds('move').has('f5')"), true, '重新读取必须保留收藏');
const rendered = evaluate("renderFolderGroup(getMoveFolderGroups()[0], 'move', 0, 2)");
assert.equal((rendered.match(/class="directory-item directory-folder-item"/g) || []).length, 6, '超过四项仍必须完整渲染');
assert.equal((rendered.match(/aria-pressed="true"/g) || []).length, 2);
assert.ok(rendered.indexOf('data-folder-id="f5"') < rendered.indexOf('data-folder-id="f1"'));
const beforeInvalid = values.get('folderFavorites');
evaluate("toggleFolderFavorite('move', 'g2', 'f5')");
assert.equal(values.get('folderFavorites'), beforeInvalid, '错误分组不能收藏其他组的文件夹');
evaluate("toggleFolderFavorite('move', 'g1', 'f2'); toggleFolderFavorite('move', 'g1', 'f5')");
assert.deepEqual(ids("getOrderedGroupFolders(getMoveFolderGroups()[0], 'move')"), folders.map(folder => folder.id), '取消收藏恢复原顺序');

evaluate("toggleFolderFavorite('move', 'g1', 'f2'); toggleFolderFavorite('move', 'g1', 'f5')");
evaluate("reorderFolderGroup('move', 'g1', 'f5', -1)");
assert.deepEqual(ids("getOrderedGroupFolders(getMoveFolderGroups()[0], 'move')"), ['f5', 'f2', 'f1', 'f3', 'f4', 'f6']);
const beforeBoundary = values.get('moveFolders');
evaluate("reorderFolderGroup('move', 'g1', 'f2', 1)");
assert.equal(values.get('moveFolders'), beforeBoundary, '手动排序不能越过收藏边界');
evaluate("reorderFolderGroup('move', 'g1', 'f3', -1)");
assert.deepEqual(ids("getOrderedGroupFolders(getMoveFolderGroups()[0], 'move')"), ['f5', 'f2', 'f3', 'f1', 'f4', 'f6']);
evaluate("toggleFolderFavorite('common', 'g1', 'f6')");
assert.equal(evaluate("getFavoriteFolderIds('move').size"), 2, '收藏视频分组不能覆盖移动分组收藏');
const oldConfig = JSON.parse(evaluate("JSON.stringify(normalizeFolderGroups([{path:'D:/legacy/旧文件夹'}]))"));
assert.equal(oldConfig[0].folders[0].name, '旧文件夹');
assert.equal(oldConfig[0].folders[0].path, 'D:/legacy/旧文件夹');
console.log('六项完整渲染、收藏持久化、组内置顶、取消还原、类别隔离、排序边界、旧配置兼容：通过');

const flatRendered = evaluate("renderFolderGroup(getCommonVideoGroups()[0], 'common', 0)");
assert.ok(!flatRendered.includes('directory-group-heading'), '常看不能渲染分组标题');
assert.ok(!flatRendered.includes('edit-group'));
assert.ok(flatRendered.indexOf('move-up') < flatRendered.indexOf('edit-folder'));
assert.ok(flatRendered.indexOf('remove-folder') < flatRendered.indexOf('favorite-folder'), '星标必须放在最后');
assert.equal(evaluate("normalizeFolderGroups([{path:'D:/legacy/no-id'}])[0].folders[0].id"), evaluate("normalizeFolderGroups([{path:'D:/legacy/no-id'}])[0].folders[0].id"));
context.fixture = [{id:'old1',name:'旧组',folders:[{id:'note1',path:'D:/note',name:'完整名称',note:'第一行\n<script>第二行</script>'}]},
    {id:'old2',name:'另一个组',folders:[{id:'note2',path:'D:/note2',name:'另一个名称',note:'保留备注'}]}];
values.set('commonVideoFolders', JSON.stringify(context.fixture));
values.set('moveFolders', JSON.stringify(context.fixture));
values.delete('folderConfigurationBackupV2');
const beforeMigrationCommon = values.get('commonVideoFolders');
const beforeMigrationMove = values.get('moveFolders');
// 使用真实迁移函数，隔离存储中检验备份、幂等和移动分组。
const migrationStart = source.indexOf('function migrateFolderConfiguration()');
const migrationEnd = source.indexOf('// 使用清单按需加载', migrationStart);
vm.runInContext(source.slice(migrationStart, migrationEnd), context);
evaluate('migrateFolderConfiguration()');
assert.equal(JSON.parse(values.get('folderConfigurationBackupV2')).values.commonVideoFolders, beforeMigrationCommon);
assert.equal(JSON.parse(values.get('folderConfigurationBackupV2')).values.moveFolders, beforeMigrationMove);
assert.equal(evaluate('getCommonVideoGroups().length'), 1);
assert.equal(evaluate('getMoveFolderGroups().length'), 2);
assert.deepEqual(ids('getCommonVideoGroups()[0].folders'), ['note1','note2']);
assert.equal(evaluate('getCommonVideoGroups()[0].folders[0].note'), context.fixture[0].folders[0].note);
const migrated = values.get('commonVideoFolders');
evaluate('migrateFolderConfiguration()');
assert.equal(values.get('commonVideoFolders'), migrated, '二次迁移不能重建 ID 或排序');
const notesRendered = evaluate("renderFolderGroup(getCommonVideoGroups()[0], 'common', 0)");
assert.ok(notesRendered.includes('第一行\n&lt;script&gt;第二行&lt;/script&gt;'));
assert.ok(!notesRendered.includes('<script>'));
evaluate("reorderFolderGroup('common','old1','note2',-1)");
assert.deepEqual(ids('getCommonVideoGroups()[0].folders'), ['note2','note1']);
assert.equal(evaluate('getCommonVideoGroups()[0].folders[1].note'), context.fixture[0].folders[0].note);
console.log('备注安全渲染、无分组平铺、跨旧组排序、备份、稳定 ID 和迁移幂等：通过');
