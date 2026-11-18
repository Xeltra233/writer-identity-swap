/**
 * 编写者身份替换 (Writer Identity Swap)
 *
 * 读取“正在运行”的预设（oai_settings.prompts + prompt_order + extension_prompts），
 * 识别其中的“故事编写者/叙述者身份”，并在**发送的提示词**里把该身份替换成用户指定的新身份。
 *
 * 关键约束：
 *  - 只改内存里的出站载荷（CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_DATA /
 *    GENERATE_AFTER_COMBINE_PROMPTS），不写回预设 JSON、不写回聊天文件。
 *  - 覆盖整份载荷的每一段文本：系统提示、历史消息、剧场/心声等 <details> 区块标题与正文。
 *  - 单次正则替换（长名优先），不会出现 A→B→C 的链式替换。
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandNamedArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';

import { detectWriterIdentities, pickAutoCandidate } from './src/identity.js';
import {
    buildMatcher,
    findOccurrences,
    countOccurrences,
    replaceInChat,
    replaceInGenerateData,
    replaceInString,
    validateReplacement,
} from './src/replace.js';

export { MODULE_NAME };

const MODULE_NAME = 'writer_identity_swap';
const LOG_PREFIX = '[编写者替换]';
const OPENAI_GLOBAL_ORDER_ID = 100001;

/** 生成周期编号：同一轮生成的多个载荷只统计一次 */
let cycle = 0;
/** 上一次真实发送的替换结果（供 UI 展示） */
let lastReport = null;
/** 检测结果缓存 */
let detectCache = { key: '', result: null };
/** 上次统计时的预设名，用于发现用户切换预设 */
let lastPresetKey = '';
/** toast 节流 */
let lastToastAt = 0;

const defaultSettings = {
    enabled: true,
    autoDetect: true,
    includeAliases: true,
    replaceHistory: true,
    caseInsensitive: true,
    showToasts: false,
    syncTarget: true,
    target: '',
    perPreset: {},
};

// ---------------------------------------------------------------- settings

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const store = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (store[key] === undefined) store[key] = structuredClone(value);
    }
    if (!store.perPreset || typeof store.perPreset !== 'object') store.perPreset = {};
    return store;
}

function presetConfig(presetKey, { create = false } = {}) {
    const store = settings();
    let config = store.perPreset[presetKey];
    if (!config && create) {
        config = { source: '', target: '', aliases: [], autoMode: true, updatedAt: 0 };
        store.perPreset[presetKey] = config;
    }
    return config ?? null;
}

function persist() {
    saveSettingsDebounced();
}

// ------------------------------------------------------------ preset state

function getOaiSettings() {
    const context = getContext();
    return context?.chatCompletionSettings ?? context?.oaiSettings ?? null;
}

function getPresetKey() {
    try {
        const manager = getContext()?.getPresetManager?.('openai');
        const name = manager?.getSelectedPresetName?.();
        if (name) return String(name);
    } catch (error) {
        console.debug(LOG_PREFIX, '读取预设名失败', error);
    }
    return '';
}

/**
 * 当前生效的 prompt_order 条目。酒馆的 OpenAI 链路使用 global 策略（dummyId 100001），
 * 找不到时退回当前角色或第一块。
 * @param {object} oai
 * @returns {Array<{identifier: string, enabled: boolean}>}
 */
function resolvePromptOrder(oai) {
    const lists = Array.isArray(oai?.prompt_order) ? oai.prompt_order : [];
    if (lists.length === 0) return [];
    const context = getContext();
    // 与 ST 一致：优先当前角色的专属顺序，其次全局顺序（openai.js dummyId=100001，旧版本 100000）
    const wanted = [context?.characterId, OPENAI_GLOBAL_ORDER_ID, 100000];
    for (const id of wanted) {
        const found = lists.find(list => String(list?.character_id) === String(id));
        if (found && Array.isArray(found.order) && found.order.length > 0) return found.order;
    }
    return Array.isArray(lists[0]?.order) ? lists[0].order : [];
}

/**
 * 采集“正在运行”的预设语料：启用的提示词条目 + 扩展注入提示 + 名字信息。
 * @returns {{presetKey: string, entries: Array<object>, extensionPrompts: Array<object>, userName: string, characterName: string, chars: number}}
 */
function collectRuntimeCorpus() {
    const context = getContext();
    const oai = getOaiSettings();
    const prompts = Array.isArray(oai?.prompts) ? oai.prompts : [];
    const order = resolvePromptOrder(oai);
    const enabledIds = new Set(order.filter(item => item && item.enabled).map(item => String(item.identifier)));
    const useOrderFilter = enabledIds.size > 0;

    const entries = [];
    let chars = 0;
    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object') continue;
        const identifier = String(prompt.identifier ?? prompt.id ?? '');
        const enabled = useOrderFilter ? enabledIds.has(identifier) : true;
        const content = [prompt.content, prompt.system_prompt].filter(value => typeof value === 'string' && value).join('\n');
        if (!enabled) continue;
        chars += content.length;
        entries.push({
            identifier,
            name: prompt.name ?? identifier,
            content,
            enabled,
            role: prompt.role ?? 'system',
        });
    }

    const extensionPrompts = [];
    const extras = context?.extensionPrompts ?? {};
    for (const [key, value] of Object.entries(extras)) {
        const content = typeof value === 'string' ? value : (value?.value ?? '');
        if (typeof content !== 'string' || !content) continue;
        chars += content.length;
        extensionPrompts.push({ key, name: key, content });
    }

    const character = context?.characters?.[context?.characterId ?? -1];
    return {
        presetKey: getPresetKey(),
        entries,
        extensionPrompts,
        userName: String(context?.name1 ?? ''),
        characterName: String(context?.name2 || character?.name || ''),
        chars,
    };
}

/**
 * 对“当前运行中的预设”做编写者身份识别（带缓存）。
 * @param {{force?: boolean}} [options]
 * @returns {{presetKey: string, candidates: Array<object>, stats: object, corpus: object}}
 */
function detectCurrent(options = {}) {
    const corpus = collectRuntimeCorpus();
    const key = `${corpus.presetKey}|${corpus.chars}|${corpus.entries.length}|${corpus.extensionPrompts.length}`;
    if (!options.force && detectCache.key === key && detectCache.result) {
        return detectCache.result;
    }
    const result = detectWriterIdentities({
        presetName: corpus.presetKey,
        entries: corpus.entries,
        extensionPrompts: corpus.extensionPrompts,
        userName: corpus.userName,
        characterName: corpus.characterName,
    });
    const payload = {
        presetKey: corpus.presetKey,
        candidates: result.candidates ?? [],
        stats: result.stats ?? {},
        corpus,
    };
    detectCache = { key, result: payload };
    return payload;
}

/** 自动识别结果里可安全作为替换源的别名（太短的通用词不自动采用）。 */
function safeAliases(candidate, names = {}) {
    if (!candidate || !Array.isArray(candidate.aliases)) return [];
    const out = [];
    for (const alias of candidate.aliases) {
        if (typeof alias !== 'string') continue;
        const value = alias.trim();
        if (!value || value === candidate.name) continue;
        if (names.userName && value === names.userName) continue;
        if (names.characterName && value === names.characterName) continue;
        const cjk = /^[\u3400-\u9fff]+$/.test(value);
        // 中文别名至少 3 字，避免把「小猫」这类通用词全局替换掉
        if (cjk && Array.from(value).length < 3) continue;
        if (!cjk && /^[A-Za-z0-9_]+$/.test(value) && value.length < 3) continue;
        if (out.length >= 12) break;
        out.push(value);
    }
    return out;
}

/** 最近一次识别命中的候选（供 UI 展示别名） */
let detectedCandidate = null;

/**
 * 解析当前预设的生效配置：源身份、别名、目标身份、来源（auto/preset）。
 * @param {{detectNow?: boolean}} [options]
 */
function resolveEffective(options = {}) {
    const store = settings();
    const presetKey = getPresetKey();
    const config = presetConfig(presetKey, { create: false });
    const names = {
        userName: String(getContext()?.name1 ?? ''),
        characterName: String(getContext()?.name2 ?? ''),
    };

    let source = (config?.source ?? '').trim();
    const manualAliases = Array.isArray(config?.aliases)
        ? config.aliases.map(value => String(value).trim()).filter(value => value && value !== source)
        : [];
    let aliases = [...manualAliases];
    let origin = source ? 'preset' : 'none';
    let autoConfidence = '';
    let detection = null;

    const autoMode = config ? config.autoMode !== false : true;
    if (!source && store.autoDetect && autoMode) {
        detection = detectCurrent({ force: options.detectNow === true });
        const picked = pickAutoCandidate(detection.candidates);
        if (picked) {
            source = picked.name;
            origin = 'auto';
            autoConfidence = picked.confidence;
            if (store.includeAliases) {
                const auto = safeAliases(picked, names);
                aliases = [...new Set([...auto, ...manualAliases])];
            }
        }
        detectedCandidate = picked;
    } else {
        detection = detectCurrent();
        const picked = pickAutoCandidate(detection.candidates);
        detectedCandidate = picked && picked.name === source ? picked : (detection.candidates.find(item => item.name === source) ?? picked);
    }

    const target = String(config?.target || store.target || '').trim();
    return { presetKey, source, aliases, target, origin, autoConfidence, detection, config, names };
}

/** 采样：给 UI 展示替换前/后的片段。 */
function sampleFromCorpus(matcher, limit = 6) {
    const corpus = detectCurrent().corpus;
    const samples = [];
    let total = 0;
    for (const entry of [...corpus.entries, ...corpus.extensionPrompts]) {
        if (!entry.content) continue;
        const hits = findOccurrences(entry.content, matcher, 3);
        if (hits.length === 0) continue;
        total += countOccurrences(entry.content, matcher);
        for (const hit of hits) {
            if (samples.length >= limit) break;
            samples.push({ where: entry.name || entry.identifier || entry.key, value: hit.value, context: hit.context });
        }
    }
    return { total, samples };
}

// -------------------------------------------------------------- rewriting

/** 生成一轮的过滤函数：限制只替换系统提示时跳过用户/助手消息。 */
function buildMessageFilter(store) {
    if (store.replaceHistory) return undefined;
    return message => {
        const role = typeof message?.role === 'string' ? message.role : '';
        return role === 'system' || role === 'developer';
    };
}

/**
 * 把一个出站载荷里的编写者身份替换掉。
 * @param {any} payload
 * @param {'chat'|'generate'|'string'} kind
 * @param {boolean} dryRun
 * @returns {{total: number, samples: Array<object>}|null}
 */
function applyToPayload(payload, kind, dryRun = false) {
    const store = settings();
    if (!store.enabled) return null;

    const effective = resolveEffective();
    if (!effective.source || !effective.target) {
        warnIncompleteOnce(effective);
        return null;
    }

    const issues = validateReplacement([effective.source, ...effective.aliases], effective.target, effective.names);
    const fatal = issues.filter(issue => issue.level === 'error');
    if (fatal.length > 0) {
        console.debug(LOG_PREFIX, '跳过替换：', fatal.map(issue => issue.message).join('；'));
        return null;
    }

    const matcher = buildMatcher([effective.source, ...effective.aliases], {
        caseInsensitive: store.caseInsensitive,
    });
    if (!matcher.regex) return null;

    const options = { cycle, filter: buildMessageFilter(store) };
    let report = null;
    if (kind === 'chat') {
        report = replaceInChat(payload, matcher, effective.target, options);
    } else if (kind === 'generate') {
        report = replaceInGenerateData(payload, matcher, effective.target, options);
    } else if (kind === 'string') {
        const result = replaceInString(payload, matcher, effective.target);
        report = { total: result.count, strings: result.count > 0 ? 1 : 0, samples: [], byKey: {}, skipped: 0, error: null };
    }

    if (!report || report.total === 0) return report;

    if (!dryRun) {
        lastReport = {
            at: Date.now(),
            presetKey: effective.presetKey,
            source: effective.source,
            target: effective.target,
            aliases: effective.aliases,
            count: report.total,
            samples: report.samples.slice(0, 12),
            byKey: report.byKey,
        };
        scheduleUiRefresh();
        if (store.showToasts) {
            const now = Date.now();
            if (now - lastToastAt > 1200) {
                lastToastAt = now;
                globalThis.toastr?.info?.(`编写者身份：${effective.source} → ${effective.target}（${report.total} 处）`);
            }
        }
    }

    return report;
}

let lastIncompleteWarning = '';
function warnIncompleteOnce(effective) {
    const key = `${effective.presetKey}|${effective.source}|${effective.target}`;
    if (lastIncompleteWarning === key) return;
    lastIncompleteWarning = key;
    if (!effective.source) {
        console.debug(LOG_PREFIX, '未识别到编写者身份，也没有手动填写，跳过替换（预设：%s）', effective.presetKey || '未知');
    } else if (!effective.target) {
        console.debug(LOG_PREFIX, '尚未设置目标身份，跳过替换');
    }
}

// ---------------------------------------------------------------- events

function onGenerationStarted() {
    cycle += 1;
    const presetKey = getPresetKey();
    if (presetKey !== lastPresetKey) {
        lastPresetKey = presetKey;
        detectCache = { key: '', result: null };
        scheduleUiRefresh();
    }
    // 每轮开始刷新一次检测缓存，确保用户改了 prompt 开关后立即生效
    try {
        resolveEffective({ detectNow: true });
    } catch (error) {
        console.error(LOG_PREFIX, '生成前解析身份失败', error);
    }
}

function onChatCompletionPromptReady(data) {
    if (!data || !Array.isArray(data.chat)) return;
    try {
        applyToPayload(data.chat, 'chat', data.dryRun === true);
    } catch (error) {
        console.error(LOG_PREFIX, '处理 chat 载荷失败', error);
    }
}

function onGenerateAfterData(data, dryRun) {
    if (!data || typeof data !== 'object') return;
    try {
        applyToPayload(data, 'generate', dryRun === true);
    } catch (error) {
        console.error(LOG_PREFIX, '处理 generate_data 失败', error);
    }
}

function onGenerateAfterCombinePrompts(data) {
    if (!data || typeof data.prompt !== 'string') return;
    const store = settings();
    if (!store.enabled) return;
    try {
        const effective = resolveEffective();
        if (!effective.source || !effective.target) {
            warnIncompleteOnce(effective);
            return;
        }
        const matcher = buildMatcher([effective.source, ...effective.aliases], { caseInsensitive: store.caseInsensitive });
        if (!matcher.regex) return;
        const before = data.prompt;
        const result = replaceInString(before, matcher, effective.target);
        if (result.count === 0) return;
        // 写回事件对象：酒馆随后用它组装 generate_data
        data.prompt = result.text;
        if (data.dryRun !== true) {
            lastReport = {
                at: Date.now(),
                presetKey: effective.presetKey,
                source: effective.source,
                target: effective.target,
                aliases: effective.aliases,
                count: result.count,
                samples: [{ where: 'combined_prompt', count: result.count, before: before.slice(0, 200), after: result.text.slice(0, 200) }],
                byKey: { combined_prompt: result.count },
            };
            scheduleUiRefresh();
        }
    } catch (error) {
        console.error(LOG_PREFIX, '处理合并提示词失败', error);
    }
}

function wireEvents() {
    const handlers = [
        [event_types.GENERATION_STARTED, onGenerationStarted],
        [event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady],
        [event_types.GENERATE_AFTER_DATA, onGenerateAfterData],
        [event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts],
    ];
    for (const [type, handler] of handlers) {
        eventSource.off?.(type, handler);
        eventSource.on(type, handler);
    }
}

// --------------------------------------------------------------- macros

let macrosRegistered = false;

function registerMacros() {
    if (macrosRegistered) return;
    const context = getContext();
    const resolve = () => {
        const effective = resolveEffective();
        return effective;
    };
    const definitions = [
        ['writer', () => resolve().source || '', '当前预设里故事编写者的原始身份名。'],
        ['writerTarget', () => resolve().target || '', '配置的目标编写者身份。'],
        ['writerAliases', () => resolve().aliases.join('、'), '原始身份的别名（逗号分隔）。'],
    ];

    const category = context?.macros?.category?.MISC;
    // 新引擎存在时它会自己接管旧 API，两个都注册会触发 "already registered" 警告
    const modern = typeof context?.macros?.register === 'function';
    for (const [name, handler, description] of definitions) {
        try {
            if (modern) {
                context.macros.register(name, {
                    category,
                    description,
                    returns: description,
                    handler: () => handler(),
                });
            } else {
                // 旧引擎（关闭 experimental_macro_engine 时生效）
                context?.registerMacro?.(name, () => handler(), description);
            }
        } catch (error) {
            console.debug(LOG_PREFIX, `宏注册失败：${name}`, error);
        }
    }
    macrosRegistered = true;
}

// --------------------------------------------------------- slash commands

function statusText() {
    const store = settings();
    const effective = resolveEffective({ detectNow: true });
    const lines = [
        `启用：${store.enabled ? '是' : '否'}`,
        `预设：${effective.presetKey || '未识别'}`,
        `源身份：${effective.source || '（未识别）'}${effective.origin === 'auto' ? ' [自动]' : ''}`,
        `别名：${effective.aliases.length ? effective.aliases.join('、') : '（无）'}`,
        `目标身份：${effective.target || '（未设置）'}`,
        `上次发送替换：${lastReport ? `${lastReport.count} 处（${lastReport.source} → ${lastReport.target}）` : '无记录'}`,
    ];
    return lines.join('\n');
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'writer-status',
        callback: () => statusText(),
        aliases: ['writer'],
        returns: '当前编写者身份替换状态',
        helpString: '查看当前预设识别到的编写者身份与替换配置。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'writer-set',
        callback: (namedArgs) => {
            const store = settings();
            const presetKey = getPresetKey();
            const config = presetConfig(presetKey, { create: true });
            const target = String(namedArgs.target ?? '').trim();
            const source = String(namedArgs.source ?? '').trim();
            if (target) {
                config.target = target;
                if (store.syncTarget) store.target = target;
            }
            if (source) {
                config.source = source;
                config.autoMode = false;
            }
            config.updatedAt = Date.now();
            persist();
            scheduleUiRefresh();
            return statusText();
        },
        namedArgumentList: [
            new SlashCommandNamedArgument('target', '目标身份', [ARGUMENT_TYPE.STRING], false, false, '替换后的编写者名字'),
            new SlashCommandNamedArgument('source', '源身份', [ARGUMENT_TYPE.STRING], false, false, '要替换掉的原始编写者名字'),
        ],
        returns: '更新后的状态',
        helpString: '设置当前预设的目标身份，例如：/writer-set target=赤狐',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'writer-toggle',
        callback: () => {
            const store = settings();
            store.enabled = !store.enabled;
            persist();
            scheduleUiRefresh();
            return `编写者身份替换已${store.enabled ? '开启' : '关闭'}`;
        },
        returns: '开关状态',
        helpString: '开启或关闭编写者身份替换。',
    }));
}

// --------------------------------------------------------------------- UI

let uiRefreshTimer = null;
function scheduleUiRefresh() {
    if (uiRefreshTimer) return;
    uiRefreshTimer = setTimeout(() => {
        uiRefreshTimer = null;
        try {
            renderUi();
        } catch (error) {
            console.error(LOG_PREFIX, '刷新面板失败', error);
        }
    }, 120);
}

function el(selector) {
    return document.querySelector(selector);
}

function renderCandidates(payload) {
    const box = el('#wis_candidates');
    if (!box) return;
    box.textContent = '';
    const candidates = payload?.candidates ?? [];
    if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wis-empty';
        empty.textContent = '这个预设没有显式的编写者身份，手动填写来源名字即可。';
        box.append(empty);
        return;
    }
    for (const candidate of candidates.slice(0, 8)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wis-chip wis-candidate';
        button.dataset.name = candidate.name;
        button.title = (candidate.evidence ?? []).join('\n');
        const confidence = candidate.confidence === 'high' ? '高' : candidate.confidence === 'medium' ? '中' : '低';
        button.textContent = `${candidate.name} · ${confidence}${candidate.conflict ? ` · 与${candidate.conflict === 'user' ? '用户' : '角色'}同名` : ''}`;
        if (candidate.conflict) button.classList.add('wis-chip-warn');
        box.append(button);
    }
}

function renderAliases(effective) {
    const box = el('#wis_aliases');
    if (!box) return;
    box.textContent = '';
    const candidate = detectedCandidate;
    const pool = new Set([...(candidate?.aliases ?? []), ...(effective.aliases ?? [])]);
    if (pool.size === 0) {
        const empty = document.createElement('span');
        empty.className = 'wis-empty';
        empty.textContent = '没有别名';
        box.append(empty);
        return;
    }
    const active = new Set([...(effective.config?.aliases ?? []), ...(effective.origin === 'auto' ? effective.aliases : [])]);
    for (const alias of pool) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'wis-chip wis-alias';
        chip.dataset.alias = alias;
        chip.setAttribute('aria-pressed', active.has(alias) ? 'true' : 'false');
        chip.textContent = alias;
        box.append(chip);
    }
}

function renderIssues(effective, issues) {
    const box = el('#wis_issues');
    if (!box) return;
    box.textContent = '';
    const all = issues ?? validateReplacement([effective.source, ...effective.aliases], effective.target, effective.names);
    for (const issue of all) {
        const row = document.createElement('div');
        row.className = `wis-issue wis-issue-${issue.level}`;
        row.textContent = issue.message;
        box.append(row);
        if (issue.level === 'error') break;
    }
}

function renderUi() {
    const store = settings();
    const effective = resolveEffective();
    const detection = effective.detection;

    const enabled = el('#wis_enabled');
    if (enabled) enabled.checked = store.enabled;

    const badge = el('#wis_status');
    if (badge) {
        const ready = store.enabled && effective.source && effective.target;
        badge.textContent = !store.enabled ? '已关闭' : ready ? '生效中' : effective.source ? '待设置目标' : '待识别';
        badge.className = `wis-badge ${ready ? 'wis-badge-ok' : 'wis-badge-idle'}`;
    }

    const presetName = el('#wis_preset_name');
    if (presetName) presetName.textContent = effective.presetKey || '未识别预设';

    const sourceInput = el('#wis_source');
    if (sourceInput && document.activeElement !== sourceInput) sourceInput.value = effective.source ?? '';

    const targetInput = el('#wis_target');
    if (targetInput && document.activeElement !== targetInput) targetInput.value = effective.target ?? '';

    const origin = el('#wis_origin');
    if (origin) {
        origin.textContent = effective.origin === 'auto'
            ? (effective.autoConfidence === 'low' ? '自动识别·低置信' : '自动识别')
            : effective.origin === 'preset' ? '手动/已保存' : '未识别';
        origin.title = effective.autoConfidence === 'low' ? '置信度较低，建议确认或手动填写' : '';
    }

    renderCandidates(detection);
    renderAliases(effective);
    const aliasInput = el('#wis_alias_input');
    if (aliasInput && document.activeElement !== aliasInput) {
        aliasInput.value = (effective.config?.aliases ?? []).join(', ');
    }
    renderIssues(effective);

    const aliasToggle = el('#wis_include_aliases');
    if (aliasToggle) aliasToggle.checked = store.includeAliases;
    const historyToggle = el('#wis_replace_history');
    if (historyToggle) historyToggle.checked = store.replaceHistory;
    const autoToggle = el('#wis_auto_detect');
    if (autoToggle) autoToggle.checked = store.autoDetect;
    const caseToggle = el('#wis_case_insensitive');
    if (caseToggle) caseToggle.checked = store.caseInsensitive;
    const toastToggle = el('#wis_show_toasts');
    if (toastToggle) toastToggle.checked = store.showToasts;
    const syncToggle = el('#wis_sync_target');
    if (syncToggle) syncToggle.checked = store.syncTarget;

    // 预设静态命中统计
    const stats = el('#wis_stats');
    if (stats) {
        if (effective.source) {
            const matcher = buildMatcher([effective.source, ...effective.aliases], { caseInsensitive: store.caseInsensitive });
            const scan = sampleFromCorpus(matcher);
            stats.textContent = `当前预设里出现 ${scan.total} 处（${effective.source}${effective.aliases.length ? ' 及别名' : ''}）`;
        } else {
            stats.textContent = '当前预设里没有可替换的编写者身份';
        }
    }

    const lastBox = el('#wis_last');
    if (lastBox) {
        if (lastReport) {
            lastBox.textContent = `上次发送：${lastReport.count} 处 · ${lastReport.source} → ${lastReport.target}`;
        } else {
            lastBox.textContent = '还没有发送过替换后的提示词';
        }
    }

    const samplesBox = el('#wis_samples');
    if (samplesBox) {
        samplesBox.textContent = '';
        const rows = lastReport?.samples ?? [];
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'wis-empty';
            empty.textContent = '暂无样本';
            samplesBox.append(empty);
        } else {
            for (const row of rows) {
                const line = document.createElement('div');
                line.className = 'wis-sample';
                const where = document.createElement('span');
                where.className = 'wis-sample-where';
                where.textContent = `${row.where} ×${row.count}`;
                const before = document.createElement('div');
                before.className = 'wis-sample-before';
                before.textContent = row.before;
                const after = document.createElement('div');
                after.className = 'wis-sample-after';
                after.textContent = row.after;
                line.append(where, before, after);
                samplesBox.append(line);
            }
        }
    }
}

function bindUi() {
    const onChange = (selector, apply) => {
        const node = el(selector);
        if (!node) return;
        node.addEventListener('change', () => {
            apply(node.checked);
            persist();
            renderUi();
        });
    };

    onChange('#wis_enabled', value => { settings().enabled = value; });
    onChange('#wis_auto_detect', value => { settings().autoDetect = value; });
    onChange('#wis_include_aliases', value => { settings().includeAliases = value; detectCache = { key: '', result: null }; });
    onChange('#wis_replace_history', value => { settings().replaceHistory = value; });
    onChange('#wis_case_insensitive', value => { settings().caseInsensitive = value; });
    onChange('#wis_show_toasts', value => { settings().showToasts = value; });
    onChange('#wis_sync_target', value => { settings().syncTarget = value; });

    const targetInput = el('#wis_target');
    targetInput?.addEventListener('input', () => {
        const presetKey = getPresetKey();
        const config = presetConfig(presetKey, { create: true });
        const value = targetInput.value.trim();
        config.target = value;
        config.updatedAt = Date.now();
        if (settings().syncTarget) settings().target = value;
        persist();
    });
    targetInput?.addEventListener('blur', renderUi);

    const sourceInput = el('#wis_source');
    sourceInput?.addEventListener('input', () => {
        const presetKey = getPresetKey();
        const config = presetConfig(presetKey, { create: true });
        config.source = sourceInput.value.trim();
        config.autoMode = false;
        config.updatedAt = Date.now();
        persist();
    });
    sourceInput?.addEventListener('blur', () => { detectCache = { key: '', result: null }; renderUi(); });

    el('#wis_detect')?.addEventListener('click', () => {
        detectCache = { key: '', result: null };
        const presetKey = getPresetKey();
        const config = presetConfig(presetKey, { create: true });
        config.source = '';
        config.autoMode = true;
        persist();
        renderUi();
    });

    el('#wis_candidates')?.addEventListener('click', event => {
        const button = event.target.closest?.('.wis-candidate');
        if (!button) return;
        const name = button.dataset.name ?? '';
        const presetKey = getPresetKey();
        const config = presetConfig(presetKey, { create: true });
        const detection = detectCurrent({ force: true });
        const candidate = detection.candidates.find(item => item.name === name);
        config.source = name;
        config.autoMode = false;
        config.aliases = safeAliases(candidate, {
            userName: String(getContext()?.name1 ?? ''),
            characterName: String(getContext()?.name2 ?? ''),
        });
        config.updatedAt = Date.now();
        persist();
        renderUi();
    });

    el('#wis_aliases')?.addEventListener('click', event => {
        const chip = event.target.closest?.('.wis-alias');
        if (!chip) return;
        const alias = chip.dataset.alias ?? '';
        if (!alias) return;
        const presetKey = getPresetKey();
        const config = presetConfig(presetKey, { create: true });
        const aliases = new Set(Array.isArray(config.aliases) ? config.aliases : []);
        if (aliases.has(alias)) aliases.delete(alias);
        else aliases.add(alias);
        config.aliases = [...aliases];
        config.updatedAt = Date.now();
        persist();
        renderUi();
    });

    el('#wis_alias_input')?.addEventListener('change', event => {
        const raw = String(event.target.value ?? '');
        const list = raw.split(/[,，、\s]+/).map(item => item.trim()).filter(Boolean);
        const config = presetConfig(getPresetKey(), { create: true });
        config.aliases = [...new Set(list)];
        config.updatedAt = Date.now();
        persist();
        renderUi();
    });

    el('#wis_preview')?.addEventListener('click', () => {
        const effective = resolveEffective({ detectNow: true });
        if (!effective.source) {
            globalThis.toastr?.warning?.('当前预设里没有识别到编写者身份');
            return;
        }
        const matcher = buildMatcher([effective.source, ...effective.aliases], { caseInsensitive: settings().caseInsensitive });
        const scan = sampleFromCorpus(matcher);
        const box = el('#wis_preview_out');
        if (!box) return;
        box.textContent = '';
        const head = document.createElement('div');
        head.className = 'wis-preview-head';
        head.textContent = `${effective.presetKey || '当前预设'}：${scan.total} 处 → ${effective.target || '（未设置目标）'}`;
        box.append(head);
        for (const sample of scan.samples) {
            const row = document.createElement('div');
            row.className = 'wis-sample';
            const where = document.createElement('span');
            where.className = 'wis-sample-where';
            where.textContent = `${sample.where || 'entry'} · ${sample.value}`;
            const text = document.createElement('div');
            text.className = 'wis-sample-before';
            text.textContent = sample.context;
            row.append(where, text);
            box.append(row);
        }
    });
}

// ------------------------------------------------------------------- init

async function loadSettingsTemplate() {
    const url = new URL('./settings.html', import.meta.url);
    const response = await fetch(url.href, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`settings.html 加载失败：HTTP ${response.status}`);
    return await response.text();
}

async function waitForAppReady() {
    const context = getContext?.();
    if (!context?.eventSource || !context?.eventTypes?.APP_READY) return;
    await new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        context.eventSource.once(context.eventTypes.APP_READY, finish);
        setTimeout(finish, 2500);
    });
}

let initialized = false;

export async function init() {
    if (initialized) return;
    initialized = true;
    try {
        await waitForAppReady();

        if (!document.querySelector('#wis_container')) {
            const html = await loadSettingsTemplate();
            const host = document.querySelector('#extensions_settings2')
                ?? document.querySelector('#extensions_settings')
                ?? document.body;
            const container = document.createElement('div');
            container.id = 'wis_container';
            container.className = 'extension_container';
            container.innerHTML = html;
            host.append(container);
        }

        settings();
        bindUi();
        wireEvents();
        registerSlashCommands();
        registerMacros();

        // extension_settings 在 SETTINGS_LOADED 时才完整，重新渲染一次
        eventSource.on(event_types.SETTINGS_LOADED, () => {
            settings();
            scheduleUiRefresh();
        });
        eventSource.on(event_types.CHAT_CHANGED, scheduleUiRefresh);
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
            detectCache = { key: '', result: null };
            scheduleUiRefresh();
        });

        renderUi();
        console.info(LOG_PREFIX, '初始化完成');
    } catch (error) {
        console.error(LOG_PREFIX, '初始化失败', error);
    }
}

void init();

// 便于测试/调试
export const __internals = {
    resolvePromptOrder,
    collectRuntimeCorpus,
    detectCurrent,
    resolveEffective,
    applyToPayload,
    safeAliases,
    settings,
    defaultSettings,
    get cycle() { return cycle; },
    get lastReport() { return lastReport; },
};
