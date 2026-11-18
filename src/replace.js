/**
 * Outbound prompt rewriting.
 *
 * Pure module: no SillyTavern imports. It receives the *live* outbound payload
 * (the `chat` array of CHAT_COMPLETION_PROMPT_READY or the `generate_data` of
 * GENERATE_AFTER_DATA) and rewrites the writer persona name to another one.
 *
 * Design rules:
 *  - Single regex pass over an alternation of every source spelling, so a
 *    replacement can never be re-replaced by another source (no cascade).
 *  - Nothing is written to disk; the objects are mutated in place, which is what
 *    SillyTavern sends afterwards.
 *  - Idempotent: running twice on the same payload replaces nothing the second
 *    time (sources are gone, target != any source).
 */

/** Marks a payload that already went through this module in the current cycle. */
export const PROCESSED = Symbol.for('writer-identity-swap.processed');
/** Marks a string container that was already counted (kept for stats sanity). */
export const TEXT_FLAG = Symbol.for('writer-identity-swap.text-flag');

const MAX_SAMPLES = 60;

/** Keys inside a message/response object that carry prompt text. */
const STRING_VALUE_KEYS = new Set([
    'content', 'text', 'prompt', 'jailbreakPromptOverride', 'system_prompt', 'systemPrompt',
    'instruction', 'input', 'value', 'reasoning_content',
]);
/** Keys whose values are containers we must recurse into. */
const CONTAINER_KEYS = new Set([
    'chat', 'messages', 'contents', 'payload', 'parts', 'data', 'attachment',
]);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cleans and orders replacement sources (longest first so that
 * "小猫之神" wins over "小猫").
 * @param {string[]} sources
 * @returns {string[]}
 */
export function normalizeSources(sources) {
    if (!Array.isArray(sources)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of sources) {
        if (typeof raw !== 'string') continue;
        const value = raw.trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out.sort((a, b) => Array.from(b).length - Array.from(a).length);
}

/**
 * Builds the single-pass matcher used for every string in the payload.
 * @param {string[]} sources
 * @param {{caseInsensitive?: boolean, latinBoundary?: boolean}} [options]
 * @returns {{regex: RegExp, sources: string[], flags: string}}
 */
export function buildMatcher(sources, options = {}) {
    const list = normalizeSources(sources);
    const caseInsensitive = options.caseInsensitive !== false;
    const latinBoundary = options.latinBoundary !== false;
    if (list.length === 0) {
        return { regex: null, sources: [], flags: '' };
    }
    const alternatives = list.map(source => {
        const needsBoundary = latinBoundary && /^[A-Za-z0-9_]+$/.test(source);
        const body = escapeRegExp(source);
        return needsBoundary ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body;
    });
    const flags = caseInsensitive ? 'giu' : 'gu';
    let regex;
    try {
        regex = new RegExp(alternatives.join('|'), flags);
    } catch {
        // Older engines without lookbehind support: fall back to plain literals.
        regex = new RegExp(list.map(escapeRegExp).join('|'), caseInsensitive ? 'giu' : 'gu');
    }
    return { regex, sources: list, flags };
}

/**
 * Replaces every occurrence of any source in `text`.
 * @param {string} text
 * @param {{regex: RegExp|null}} matcher
 * @param {string} target
 * @returns {{text: string, count: number}}
 */
export function replaceInString(text, matcher, target) {
    if (typeof text !== 'string' || text.length === 0 || !matcher?.regex) {
        return { text, count: 0 };
    }
    matcher.regex.lastIndex = 0;
    let count = 0;
    const next = text.replace(matcher.regex, () => {
        count += 1;
        return target;
    });
    return { text: next, count };
}

/** Lists occurrences without changing anything (used by the preview panel). */
export function findOccurrences(text, matcher, limit = 5) {
    if (typeof text !== 'string' || !matcher?.regex) return [];
    const hits = [];
    matcher.regex.lastIndex = 0;
    let match;
    while ((match = matcher.regex.exec(text)) !== null && hits.length < limit) {
        hits.push({
            index: match.index,
            value: match[0],
            context: text.slice(Math.max(0, match.index - 24), match.index + match[0].length + 24).replace(/\s+/g, ' '),
        });
        if (match[0].length === 0) matcher.regex.lastIndex += 1;
    }
    return hits;
}

/** Counts occurrences without materialising them (used for the panel statistics). */
export function countOccurrences(text, matcher) {
    if (typeof text !== 'string' || !matcher?.regex) return 0;
    matcher.regex.lastIndex = 0;
    let count = 0;
    let match;
    while ((match = matcher.regex.exec(text)) !== null) {
        count += 1;
        if (match[0].length === 0) matcher.regex.lastIndex += 1;
    }
    return count;
}

function createReport() {
    return {
        total: 0,
        strings: 0,
        samples: [],
        byKey: {},
        skipped: 0,
        error: null,
    };
}

function record(report, where, before, after, count) {
    report.total += count;
    report.strings += 1;
    report.byKey[where] = (report.byKey[where] ?? 0) + count;
    if (report.samples.length < MAX_SAMPLES) {
        report.samples.push({ where, count, before: before.slice(0, 200), after: after.slice(0, 200) });
    }
}

/**
 * Rewrites one text container in place.
 * @returns {number} replacements
 */
function rewriteTextHolder(holder, key, matcher, target, report, where) {
    const value = holder[key];
    if (typeof value === 'string') {
        const { text, count } = replaceInString(value, matcher, target);
        if (count > 0) {
            holder[key] = text;
            record(report, where, value, text, count);
        }
        return count;
    }
    if (Array.isArray(value)) {
        let count = 0;
        for (let index = 0; index < value.length; index += 1) {
            const item = value[index];
            if (typeof item === 'string') {
                const result = replaceInString(item, matcher, target);
                if (result.count > 0) {
                    value[index] = result.text;
                    record(report, where, item, result.text, result.count);
                    count += result.count;
                }
            } else if (item && typeof item === 'object' && typeof item.text === 'string') {
                const result = replaceInString(item.text, matcher, target);
                if (result.count > 0) {
                    const before = item.text;
                    item.text = result.text;
                    record(report, where, before, result.text, result.count);
                    count += result.count;
                }
            } else if (item && typeof item === 'object') {
                count += rewriteObject(item, matcher, target, report, `${where}[${index}]`, 0);
            }
        }
        return count;
    }
    if (value && typeof value === 'object') {
        return rewriteObject(value, matcher, target, report, where, 0);
    }
    return 0;
}

function rewriteObject(object, matcher, target, report, where, depth) {
    if (!object || typeof object !== 'object' || depth > 5) return 0;
    let count = 0;
    for (const key of Object.keys(object)) {
        if (STRING_VALUE_KEYS.has(key)) {
            count += rewriteTextHolder(object, key, matcher, target, report, `${where}.${key}`);
        } else if (CONTAINER_KEYS.has(key)) {
            const value = object[key];
            if (typeof value === 'string') {
                count += rewriteTextHolder(object, key, matcher, target, report, `${where}.${key}`);
            } else if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index += 1) {
                    const item = value[index];
                    if (typeof item === 'string') {
                        const result = replaceInString(item, matcher, target);
                        if (result.count > 0) {
                            value[index] = result.text;
                            record(report, `${where}.${key}`, item, result.text, result.count);
                            count += result.count;
                        }
                    } else if (item && typeof item === 'object') {
                        count += rewriteObject(item, matcher, target, report, `${where}.${key}[${index}]`, depth + 1);
                    }
                }
            } else if (value && typeof value === 'object') {
                count += rewriteObject(value, matcher, target, report, `${where}.${key}`, depth + 1);
            }
        }
    }
    return count;
}

/**
 * Rewrites a `chat` payload (CHAT_COMPLETION_PROMPT_READY / generateRawData).
 * Messages are addressed by their `role` for readable reporting.
 * @param {Array<object>} chat
 * @param {{regex: RegExp|null}} matcher
 * @param {string} target
 * @param {{force?: boolean, cycle?: string|number}} [options]
 * @returns {ReturnType<typeof createReport>}
 */
export function replaceInChat(chat, matcher, target, options = {}) {
    const report = createReport();
    if (!Array.isArray(chat)) return report;
    if (!matcher?.regex) return report;
    if (!target) {
        report.error = 'empty-target';
        return report;
    }
    if (!options.force && options.cycle !== undefined && chat[PROCESSED] === options.cycle) {
        return report;
    }
    for (let index = 0; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || typeof message !== 'object') continue;
        if (typeof options.filter === 'function' && !options.filter(message, index)) continue;
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        const where = `${role}[${index}]`;
        if (typeof message.content === 'string') {
            const { text, count } = replaceInString(message.content, matcher, target);
            if (count > 0) {
                const before = message.content;
                message.content = text;
                record(report, where, before, text, count);
            }
        } else if (Array.isArray(message.content)) {
            rewriteTextHolder(message, 'content', matcher, target, report, where);
        } else if (message.content && typeof message.content === 'object') {
            rewriteTextHolder(message, 'content', matcher, target, report, where);
        }
        // Some pipelines keep the text beside `content` (swipes / raw variants).
        for (const key of ['text', 'display_text']) {
            if (typeof message[key] === 'string') {
                const { text, count } = replaceInString(message[key], matcher, target);
                if (count > 0) {
                    const before = message[key];
                    message[key] = text;
                    record(report, `${where}.${key}`, before, text, count);
                }
            }
        }
    }
    if (options.cycle !== undefined) {
        try {
            Object.defineProperty(chat, PROCESSED, { value: options.cycle, configurable: true, enumerable: false });
        } catch {
            /* frozen arrays are fine: we just lose the cycle guard */
        }
    }
    return report;
}

/**
 * Merges `source` into `target` (both created by createReport).
 * @param {ReturnType<typeof createReport>} target
 * @param {ReturnType<typeof createReport>} source
 * @returns {ReturnType<typeof createReport>}
 */
function mergeReports(target, source) {
    target.total += source.total;
    target.strings += source.strings;
    target.skipped += source.skipped;
    if (source.error && !target.error) target.error = source.error;
    for (const [key, count] of Object.entries(source.byKey)) {
        target.byKey[key] = (target.byKey[key] ?? 0) + count;
    }
    for (const sample of source.samples) {
        if (target.samples.length >= MAX_SAMPLES) break;
        target.samples.push(sample);
    }
    return target;
}

/**
 * Rewrites a `generate_data` payload (GENERATE_AFTER_DATA / generateRawData).
 * @param {object} data
 * @param {{regex: RegExp|null}} matcher
 * @param {string} target
 * @param {{force?: boolean, cycle?: string|number}} [options]
 * @returns {ReturnType<typeof createReport>}
 */
export function replaceInGenerateData(data, matcher, target, options = {}) {
    const report = createReport();
    if (!data || typeof data !== 'object') return report;
    if (!matcher?.regex) return report;
    if (!target) {
        report.error = 'empty-target';
        return report;
    }
    if (!options.force && options.cycle !== undefined && data[PROCESSED] === options.cycle) {
        return report;
    }
    // prompt / jailbreakPromptOverride / system_prompt ...
    for (const key of STRING_VALUE_KEYS) {
        if (typeof data[key] === 'string') {
            const { text, count } = replaceInString(data[key], matcher, target);
            if (count > 0) {
                const before = data[key];
                data[key] = text;
                record(report, key, before, text, count);
            }
        }
    }
    for (const key of CONTAINER_KEYS) {
        const value = data[key];
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                const item = value[index];
                if (!item || typeof item !== 'object') continue;
                const role = typeof item.role === 'string' ? item.role : 'item';
                const where = `${key}.${role}[${index}]`;
                if (typeof item.content === 'string') {
                    const { text, count } = replaceInString(item.content, matcher, target);
                    if (count > 0) {
                        const before = item.content;
                        item.content = text;
                        record(report, where, before, text, count);
                    }
                } else if (Array.isArray(item.content)) {
                    rewriteTextHolder(item, 'content', matcher, target, report, where);
                } else if (typeof item.text === 'string') {
                    const { text, count } = replaceInString(item.text, matcher, target);
                    if (count > 0) {
                        const before = item.text;
                        item.text = text;
                        record(report, where, before, text, count);
                    }
                }
            }
        } else if (value && typeof value === 'object') {
            rewriteObject(value, matcher, target, report, key, 0);
        }
    }
    // OpenAI chat completions keep the message list under `prompt` (an array).
    if (Array.isArray(data.prompt)) {
        mergeReports(report, replaceInChat(data.prompt, matcher, target, { cycle: options.cycle, filter: options.filter }));
    }
    if (options.cycle !== undefined) {
        try {
            Object.defineProperty(data, PROCESSED, { value: options.cycle, configurable: true, enumerable: false });
        } catch {
            /* ignore */
        }
    }
    return report;
}

/**
 * Counts how many times any source appears in a payload, without mutating.
 * Used by the "预览" button.
 * @param {Array<object>|object} payload
 * @param {{regex: RegExp|null}} matcher
 * @returns {{count: number, samples: {where: string, value: string, context: string}[]}}
 */
export function previewPayload(payload, matcher) {
    const samples = [];
    let count = 0;
    const visit = (value, where, depth) => {
        if (depth > 5 || value === null || value === undefined) return;
        if (typeof value === 'string') {
            const hits = findOccurrences(value, matcher, 3);
            if (hits.length > 0) {
                count += hits.length;
                for (const hit of hits) {
                    if (samples.length < MAX_SAMPLES) samples.push({ where, value: hit.value, context: hit.context });
                }
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, `${where}[${index}]`, depth + 1));
            return;
        }
        if (typeof value === 'object') {
            for (const key of Object.keys(value)) {
                if (STRING_VALUE_KEYS.has(key) || CONTAINER_KEYS.has(key)) {
                    visit(value[key], `${where}.${key}`, depth + 1);
                }
            }
        }
    };
    visit(payload, 'payload', 0);
    return { count, samples };
}

/**
 * Validates the (source -> target) pair and returns human readable warnings.
 * @param {string[]} sources
 * @param {string} target
 * @param {{userName?: string, characterName?: string}} [names]
 * @returns {{level: 'error'|'warning'|'info', message: string}[]}
 */
export function validateReplacement(sources, target, names = {}) {
    const issues = [];
    const list = normalizeSources(sources);
    const value = typeof target === 'string' ? target.trim() : '';
    if (!value) issues.push({ level: 'error', message: '目标身份不能为空' });
    if (list.length === 0) issues.push({ level: 'error', message: '没有可替换的源身份（先识别或手动填写）' });
    if (value && list.includes(value)) issues.push({ level: 'warning', message: '目标身份与源身份相同，不会产生任何变化' });
    for (const source of list) {
        if (!value) break;
        if (value.includes(source) && value !== source) {
            issues.push({
                level: 'warning',
                message: `目标身份里包含源身份「${source}」，单次替换不会二次替换，但输出里仍会出现旧名字`,
            });
        }
        if (source.includes(value) && source !== value) {
            issues.push({ level: 'info', message: `「${source}」包含目标身份，替换后名字会变短` });
        }
        if (names.userName && source === names.userName) {
            issues.push({ level: 'error', message: `「${source}」是当前用户名，替换会把用户自己改名` });
        }
        if (names.characterName && source === names.characterName) {
            issues.push({ level: 'warning', message: `「${source}」与当前角色卡同名，确认是否真要替换` });
        }
    }
    return issues;
}

/** Groups warnings by level for the UI. */
export function summarizeIssues(issues) {
    const errors = issues.filter(issue => issue.level === 'error');
    const warnings = issues.filter(issue => issue.level === 'warning');
    return { errors, warnings, ok: errors.length === 0 };
}
