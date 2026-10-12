/* 有界播放记录：纯数据模块，可用隔离存储验证，不访问真实文件。 */
(function (scope) {
    'use strict';
    const KEY = 'videoPlaybackV1';
    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').toLowerCase();
    function identity(file, folder = '') {
        if (file?.path) return `desktop:${normalizePath(file.path)}`;
        const relative = file?.webkitRelativePath || file?.relativePath || file?.name || '';
        return relative ? `browser:${folder}/${relative}:${Number(file.size) || 0}:${Number(file.lastModified) || 0}` : '';
    }
    function fingerprint(file) { return `${Number(file?.size) || 0}:${Number(file?.lastModified) || 0}`; }
    function validSegment(segment, duration = Infinity) {
        return segment && Number.isFinite(segment.a) && Number.isFinite(segment.b)
            && segment.a >= 0 && segment.a < segment.b && segment.b <= duration;
    }
    function resumePosition(record, duration = record?.duration) {
        if (!record || record.completed || !Number.isFinite(record.position) || record.position < 0) return 0;
        if (Number.isFinite(duration) && record.position >= Math.max(0, duration - 2)) return 0;
        return record.position;
    }
    function create(storage, { capacity = 500, now = Date.now, onError = () => {} } = {}) {
        const records = new Map();
        let dirty = false;
        let lastWrite = 0;
        try {
            const raw = JSON.parse(storage.getItem(KEY) || '{}');
            if (raw.version === 1 && Array.isArray(raw.records)) {
                for (const row of raw.records.slice(0, capacity).reverse()) {
                    if (!row || typeof row.key !== 'string' || row.key.length > 4096 || typeof row.fingerprint !== 'string') continue;
                    records.set(row.key, {
                        key: row.key, fingerprint: row.fingerprint,
                        position: Number.isFinite(row.position) && row.position >= 0 ? row.position : 0,
                        duration: Number.isFinite(row.duration) && row.duration > 0 ? row.duration : null,
                        completed: row.completed === true,
                        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
                        segment: validSegment(row.segment, row.duration > 0 ? row.duration : Infinity) ? { a: row.segment.a, b: row.segment.b } : null
                    });
                }
            }
        } catch (error) { onError(error); }
        const flush = (force = false) => {
            if (!dirty || (!force && now() - lastWrite < 5000)) return;
            try {
                storage.setItem(KEY, JSON.stringify({ version: 1, records: [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt) }));
                dirty = false;
                lastWrite = now();
            } catch (error) { onError(error); }
        };
        const get = (key, file) => {
            const record = records.get(key);
            if (record && record.fingerprint !== fingerprint(file)) {
                records.delete(key); dirty = true;
                return null;
            }
            return record || null;
        };
        const ensure = (key, file) => {
            let record = get(key, file);
            if (!record) record = { key, fingerprint: fingerprint(file), position: 0, duration: null, completed: false, segment: null };
            record.updatedAt = now();
            records.delete(key); records.set(key, record);
            while (records.size > capacity) records.delete(records.keys().next().value);
            dirty = true;
            return record;
        };
        return {
            get, flush,
            update(key, file, position, duration, completed = false, force = false) {
                if (!key || !Number.isFinite(position) || position < 0) return;
                const record = ensure(key, file);
                if (Number.isFinite(duration) && duration > 0) record.duration = duration;
                record.position = completed ? 0 : position;
                record.completed = completed;
                if (record.segment && !validSegment(record.segment, record.duration || Infinity)) record.segment = null;
                flush(force);
            },
            setSegment(key, file, segment, duration) {
                if (segment && !validSegment(segment, duration)) return false;
                const record = ensure(key, file);
                record.segment = segment ? { a: segment.a, b: segment.b } : null;
                record.duration = Number.isFinite(duration) && duration > 0 ? duration : record.duration;
                flush(true); return true;
            },
            remove(key) { records.delete(key); dirty = true; flush(true); },
            move(oldKey, newKey, file, targetFile = file) {
                const record = get(oldKey, file);
                if (!record) return;
                records.delete(oldKey); records.set(newKey, { ...record, key: newKey, fingerprint: fingerprint(targetFile), updatedAt: now() });
                dirty = true; flush(true);
            },
            size: () => records.size
        };
    }
    scope.InfinityPlaybackMemory = { create, identity, normalizePath, fingerprint, validSegment, resumePosition, SPEEDS };
})(typeof module === 'object' ? module.exports : window);
