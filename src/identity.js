/**
 * Writer identity detection.
 *
 * Pure module: no SillyTavern imports, no DOM, no I/O. Safe to unit test in Node
 * and to import from the extension bundle.
 *
 * Input is a description of the *currently running* preset (plus the live
 * extension-injected prompts), output is a ranked list of candidates for
 * "the persona that writes the story", each with evidence lines and aliases.
 */

/** Writer-role words: strong evidence of "this persona writes the story". */
const STRONG_WRITER_WORDS = [
    '作家', '写手', '执笔', '主笔', '笔者', '叙述者', '叙事者', '讲述者', '编织者', '小说家', '讲述人',
    '说书人', '说书', '主持人', '导演', '编剧', '小说家', '旁白', '记录者',
    'narrator', 'writer', 'novelist', 'storyteller',
];

/** Softer writer words: still relevant, but common in unrelated prose. */
const SOFT_WRITER_WORDS = [
    '文学', '文章', '小说', '故事', '正文', '剧情', '文风', '创作', '作品', '文笔', '笔墨',
];

/** Candidates that are never a persona name. */
const STOPWORDS = new Set([
    '你', '我', '他', '她', '它', '你们', '我们', '他们', '她们', '它们', '您', '咱',
    '大家', '自己', '谁', '什么', '这个', '那个', '一个', '一位', '一名', '一只', '一种',
    '这种', '那种', '这里', '那里', '现在', '然后', '所以', '但是', '因为', '如果', '可以',
    '需要', '应该', '一定', '不是', '没有', '真的', '就好', '而已', '一样', '时候', '角色',
    '用户', '玩家', '助手', '系统', '模型', '世界', '剧情', '故事', '内容', '提示', '规则',
    '设定', '人格', '身份', '名字', '作家', '写手', '作者', '叙述者', '主持人', '文章', '小说', '小说家', '讲述人', '记录者',
    '的', '了', '是', '在', '有', '和', '与', '就', '都', '也', '还', '很', '太', '最', '不',
    'ai', 'assistant', 'user', 'system', 'model', 'you', 'me', 'the', 'and',
    // 被"作者/旁白/叙述者 + X"句式误抓的常见词（不是人名）
    // 被"作者/旁白/叙述者 + X"句式误抓的常见词（不是人名）
    // 后半段是扫描真实预设库（47 个）时抓出的章节小标题：作家流派 / 叙事者分析核心 / 叙述者观察范围 / 旁白出现 …
    '旁白', '陈述', '铺垫', '控场', '代述', '情感', '视角', '解释', '标签', '名称', '小狗',
    '流派', '观察范围', '观察', '所知', '分析核心', '采访', '出现', '核心', '范围', '体会', '感受',
    '规范', '大人', '编辑', '场景', '段落', '文本', '方式', '风格', '语气', '结构', '节奏',
    '描写', '输出', '正文', '剧情', '故事', '提示', '指令', '分析', '判断', '建议', '修改',
    '润色', '总结', '记录', '更新', '生成', '创作', '写作', '思考', '计划', '要求', '任务',
    '目标', '效果', '状态', '关系', '事件', '时间', '地点', '人物', '世界', '系统', '模型',
    '作者', '作家', '写手', '主笔', '执笔', '叙述', '叙事', '讲述', '编织', '说书', '主持',
    '导演', '编剧', '报告', '表格', '数据', '代码', '界面', '格式', '排版', '标题', '按钮',
    '语气词', '视角切换', '旁白解释', '模式', '狗狗', '小猫', '猫咪', '小狗', '手法', '技巧',
    '习惯', '偏好', '能力', '权限', '信息', '资料', '档案', '笔记', '意见', '想法', '问题',
    '答案', '方法', '步骤', '流程', '阶段', '部分', '整体', '细节', '建议书', '说明书',
    '贴标签', '打标签', '加标签', '行为', '结束后', '亲密行为',
]);

/** Metadata-ish tokens from preset file names that are never a persona name. */
const META_TOKENS = new Set([
    '主预设', '预设', '预设包', '破限', '破甲', '版本', '内置', '档案馆', '工作室', '人格',
    '主', '副', '加强', '整合', '合集', '无限制', '测试', '正式版', '纯净版', '自带',
]);

/** Evidence kinds that need extra confirmation (a single hit is usually a fragment). */
/** Project/document nouns that are never a persona name. */
const PROJECT_NOUNS = ['工程', '系统', '教程', '指南', '手册', '模板', '框架', '协议', '流程', '文档', '项目', '规则集', '预设包', '工作室'];

/** Characters that make a CJK "name" look like a clause instead. */
const LEADING_BAD = /^[或和与及并而但则即来去用把被让给对从向在指说写读看讲做干搞想要会能可应需必先再还也都很大最更只仅不没别莫勿这那你我他她它谁什怎为]/;
const CLAUSE_CHARS = /[的了着过是在有和与就都也还又很太最不没别让被把那就才吗呢吧啊嘛哦呀啦]/;
/** Characters that may not appear inside a persona name. */
const NAME_FORBIDDEN = /[{}<>|\\/*#@$%^&+=~`\n\r\t[\]【】（）()：:，,。；;、！!？?\"'“”‘’]/;
/** Leading decoration to strip from captured names. */
const LEADING_NOISE = /^[\s"'“”‘’「」『』【】()（）\-—–·•:：,，、。.!！?？~～]+/;
/** Trailing decoration to strip from captured names. */
const TRAILING_NOISE = /[\s"'“”‘’「」『』【】()（）\-—–·•:：,，、。.!！?？~～]+$/;
/** Optional chinese honorific suffixes that can be trimmed into an alias. */
const HONORIFIC_SUFFIXES = ['大人', '小姐', '殿下', '老师', '先生', '酱', '君', '桑'];
/** 去掉后缀后不能以这些虚词/量词收尾（避免「小猫之」这种半截名字） */
const DANGLING_TAIL_RE = /[之的与和者们家]$/;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const ASCII_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]*$/;

/**
 * @typedef {Object} PresetPromptEntry
 * @property {string} [identifier]
 * @property {string} [name]
 * @property {string} [role]
 * @property {boolean} [systemPrompt]
 * @property {string} [content]
 * @property {boolean} [enabled]
 */

/**
 * @typedef {Object} DetectInput
 * @property {string} [presetName]
 * @property {PresetPromptEntry[]} [entries]
 * @property {{name?: string, content?: string}[]} [contextTemplates]
 * @property {{name?: string, value?: string}[]} [extensionPrompts]
 * @property {string} [characterName]
 * @property {string} [userName]
 */

/**
 * @typedef {Object} Candidate
 * @property {string} name
 * @property {number} score
 * @property {'high'|'medium'|'low'} confidence
 * @property {string[]} evidence
 * @property {string[]} aliases
 * @property {string[]} sources
 * @property {number} occurrences
 * @property {string} [conflict]
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function stripNoise(raw) {
    if (typeof raw !== 'string') return '';
    let value = raw.trim();
    value = value.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '');
    // "你是特图" / "我就是小金" captured verbatim by the 身份： pattern
    value = value.replace(/^(?:你|我|他|她|它)(?:就是|是|叫|即|为)\s*/, '');
    return value.trim();
}

function countCodePoints(value) {
    return Array.from(value).length;
}

function isLatinOnly(value) {
    return ASCII_WORD_RE.test(value) && !CJK_RE.test(value);
}

function looksLikeName(value) {
    if (!value) return false;
    const len = countCodePoints(value);
    if (len < 1 || len > 14) return false;
    if (STOPWORDS.has(value.toLowerCase())) return false;
    if (NAME_FORBIDDEN.test(value)) return false;
    if (/\d{2,}/.test(value)) return false;
    const hasCjk = CJK_RE.test(value);
    const hasEmoji = EMOJI_RE.test(value);
    if (!hasCjk && !hasEmoji && !isLatinOnly(value)) return false;
    // 单字中文名几乎都是被句式截断的残片（"上"/"亦"），不作为身份候选
    if (hasCjk && len < 2) return false;
    if (hasCjk && len > 1) {
        if (CLAUSE_CHARS.test(value)) return false;
        if (/^(?:你|我|他|她|它|这|那|谁|什|怎|为|把|被|让|就|才|又|还|很|太|最|不|没)/.test(value) && len > 1) {
            return false;
        }
        if (/(?:我们|你们|他们|她们|它们|自己|大家|什么|怎么|这样|那样|一个|一位|一只)$/.test(value) && len > 2) {
            return false;
        }
    }
    if (META_TOKENS.has(value)) return false;
    if (PROJECT_NOUNS.some(noun => value.includes(noun))) return false;
    if (LEADING_BAD.test(value)) return false;
    if (isLatinOnly(value) && !EMOJI_RE.test(value)) {
        if (countCodePoints(value) < 2) return false;
        if (STOPWORDS.has(value.toLowerCase())) return false;
        if (/^[a-z]+$/i.test(value) && value.length <= 2) return false;
    }
    return true;
}

function hasAnyWord(window, words) {
    const lower = window.toLowerCase();
    return words.some(word => lower.includes(word.toLowerCase()));
}

function writerStrength(window) {
    if (hasAnyWord(window, STRONG_WRITER_WORDS)) return 14;
    if (hasAnyWord(window, SOFT_WRITER_WORDS)) return 6;
    return 0;
}

function windowAround(text, index, length, before = 40, after = 60) {
    return text.slice(Math.max(0, index - before), Math.min(text.length, index + length + after));
}

function pushEvidence(list, snippet, limit = 6) {
    if (list.length >= limit) return;
    const clean = String(snippet).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!clean) return;
    if (!list.includes(clean)) list.push(clean);
}

function makeAccumulator() {
    /** @type {Map<string, {name: string, score: number, evidence: string[], aliases: Set<string>, sources: Set<string>, occurrences: number}>} */
    const map = new Map();
    const keyOf = name => (isLatinOnly(name) ? name.toLowerCase() : name);

    function get(name) {
        const key = keyOf(name);
        let entry = map.get(key);
        if (!entry) {
            entry = { name, score: 0, evidence: [], aliases: new Set(), sources: new Set(), occurrences: 0, writerHits: 0 };
            map.set(key, entry);
        }
        return entry;
    }

    function add(name, score, evidence, source, { alias = null, occurrences = 1, weight = 1 } = {}) {
        const clean = stripNoise(name);
        if (!looksLikeName(clean)) return null;
        const entry = get(clean);
        const weighted = score * weight;
        entry.score += weighted;
        entry.occurrences = Math.max(entry.occurrences, occurrences);
        entry.sources.add(source);
        if (evidence) pushEvidence(entry.evidence, evidence);
        if (alias) {
            const cleanAlias = stripNoise(alias);
            if (cleanAlias && cleanAlias !== clean && looksLikeName(cleanAlias)) {
                entry.aliases.add(cleanAlias);
            }
        }
        return entry;
    }

    function boost(name, score, evidence, source) {
        const clean = stripNoise(name);
        if (!clean) return null;
        const entry = map.get(keyOf(clean));
        if (!entry) return null;
        entry.score += score;
        entry.sources.add(source);
        if (evidence) pushEvidence(entry.evidence, evidence);
        return entry;
    }

    return { map, get, add, boost, keyOf };
}

/**
 * Splits a preset name into identity-looking tokens.
 * "【小猫之神·喵赛亚】1.6" -> ["小猫之神", "喵赛亚"]
 * "🐶魔法小狗的梦境10.20 (1)" -> ["魔法小狗的梦境"]
 * "FemirisDS_11 (2)" -> ["FemirisDS", "Femiris"]
 * @param {string} presetName
 * @returns {string[]}
 */
export function tokenizePresetName(presetName) {
    if (!presetName) return [];
    let text = String(presetName)
        .replace(/\.json$/i, '')
        .replace(/\b[vV]?\d+(?:\.\d+)*\b/g, ' ')
        .replace(/[_]+\d+/g, ' ')
        .replace(/\(\d+\)/g, ' ');
    const raw = text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const tokens = [];
    for (const piece of raw) {
        if (CJK_RE.test(piece)) {
            // strip trailing possessive particles: 魔法小狗的梦境 -> 魔法小狗 / 梦境
            const parts = piece.split('的').filter(Boolean);
            for (const part of parts) {
                if (countCodePoints(part) >= 2 && !STOPWORDS.has(part) && !META_TOKENS.has(part)) tokens.push(part);
            }
        } else if (/^[A-Za-z][A-Za-z0-9]{1,}$/.test(piece)) {
            // "Ako1" / "char0520261025" -> 去掉尾随数字后再作为 token
            const trimmed = piece.replace(/\d+$/, '');
            const base = trimmed.length >= 2 ? trimmed : piece;
            tokens.push(base);
            // Camel-case "FemirisDS" -> "Femiris"
            const stripped = base.replace(/[A-Z]{2,}$/, '');
            if (stripped !== base && stripped.length >= 3) tokens.push(stripped);
        }
    }
    return Array.from(new Set(tokens));
}

/**
 * Resolves the enabled set of prompt identifiers for a character from a preset's
 * `prompt_order` block. Falls back to "all enabled" when no order matches.
 * @param {{prompt_order?: Array<{character_id?: string|number, order?: Array<{identifier?: string, enabled?: boolean}>}>}} preset
 * @param {string|number|undefined|null} characterId
 * @returns {Set<string>|null} enabled identifiers, or null when unknown
 */
export function enabledIdentifiersFromPromptOrder(preset, characterId) {
    const order = preset?.prompt_order;
    if (!Array.isArray(order) || order.length === 0) return null;
    const wanted = characterId === undefined || characterId === null ? null : String(characterId);
    let block = null;
    if (wanted !== null) {
        block = order.find(item => String(item?.character_id) === wanted) ?? null;
    }
    if (!block) {
        // global dummy order is usually the lowest character_id (100000)
        const sorted = [...order].sort((a, b) => Number(a?.character_id) - Number(b?.character_id));
        block = sorted[0] ?? null;
    }
    if (!block || !Array.isArray(block.order)) return null;
    const enabled = new Set();
    for (const entry of block.order) {
        if (entry && entry.enabled && entry.identifier) enabled.add(entry.identifier);
    }
    return enabled.size > 0 ? enabled : null;
}

function buildCorpus(input) {
    /** @type {{text: string, weight: number, kind: string}[]} */
    const chunks = [];
    const entries = Array.isArray(input.entries) ? input.entries : [];
    for (const entry of entries) {
        if (!entry || typeof entry.content !== 'string' || entry.content.length === 0) continue;
        if (entry.enabled === false) continue;
        const isSystem = entry.role === 'system' || entry.systemPrompt === true;
        chunks.push({ text: entry.content, weight: isSystem ? 1 : 0.6, kind: isSystem ? 'system' : 'example' });
    }
    for (const template of input.contextTemplates ?? []) {
        if (template && typeof template.content === 'string' && template.content.length > 0) {
            chunks.push({ text: template.content, weight: 0.9, kind: 'context' });
        }
    }
    for (const prompt of input.extensionPrompts ?? []) {
        if (prompt && typeof prompt.value === 'string' && prompt.value.length > 0) {
            chunks.push({ text: prompt.value, weight: 0.8, kind: 'extension' });
        }
    }
    return chunks;
}

/** Main entry point. */
export function detectWriterIdentities(input = {}) {
    const chunks = buildCorpus(input);
    const allText = chunks.map(chunk => chunk.text).join('\n');
    const acc = makeAccumulator();
    // 出现次数带缓存：语料可达数十万字，逐个候选重复扫描代价太高
    const countCache = new Map();
    const occurrencesOf = name => {
        let value = countCache.get(name);
        if (value === undefined) {
            value = countOccurrences(allText, name);
            countCache.set(name, value);
        }
        return value;
    };
    const stats = {
        chunks: chunks.length,
        chars: allText.length,
        labels: [],
        patterns: 0,
    };

    if (allText.length === 0) {
        const tokens = Array.from(new Set([
            ...tokenizePresetName(input.presetName ?? ''),
            ...tokenizePresetName(input.presetTitle ?? ''),
        ]));
        return { candidates: [], stats, presetTokens: tokens };
    }

    // ---------------------------------------------------------------- A. labels
    /** @type {Map<string, {count: number, evidence: string, userPaired: boolean}>} */
    const labels = new Map();
    const userLabelRe = /^(?:用户|使用者|玩家|user|human|you|\{\{user\}\})$/i;
    let userLabelCount = 0;
    for (const chunk of chunks) {
        const re = /(?:^|\n)\|([^|\n]{1,14})\|/g;
        let match;
        while ((match = re.exec(chunk.text)) !== null) {
            const raw = match[1];
            if (/^\s*$/.test(raw) || /^[\s:*-]+$/.test(raw) || /^\d+$/.test(raw)) continue;
            const label = raw.trim();
            if (userLabelRe.test(label)) {
                userLabelCount += 1;
                continue;
            }
            const prev = labels.get(label) ?? { count: 0, evidence: '', userPaired: false };
            prev.count += 1;
            if (!prev.evidence) prev.evidence = match[0].trim();
            labels.set(label, prev);
        }
    }
    stats.labels = [...labels.entries()]
        .map(([name, info]) => ({ name, count: info.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    for (const [name, info] of labels.entries()) {
        if (info.count < 2) continue;
        if (!looksLikeName(name)) continue;
        const base = userLabelCount > 0 ? 42 : 18;
        const score = base + Math.min(info.count, 18);
        acc.add(name, score, `标签: ${info.evidence}`, 'label', { occurrences: info.count });
        stats.patterns += 1;
    }

    // ------------------------------------------------------- B. declarations
    const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const declarations = [
        {
            // 名字就叫👾 / 名字: 小金 / 姓名：X
            re: /(?:名字|姓名|名号)\s*(?:(?:就叫|叫做|叫|是|为)\s*|\s*[：:]\s*)([^\s，。、；：！？（）()【】<>“”"'|]{1,14})/g,
            score: 26,
            source: 'decl-name',
        },
        {
            // 核心搭档：小金 (超级魔法小狗)
            re: /核心搭档\s*[：:]\s*([^(\n（，。]{1,14})/g,
            score: 32,
            source: 'decl-partner',
        },
        {
            // 身份：小金 / 身份: 你是特图（Tet）
            re: /(?<![一-鿿])(?:身份|角色名|人设名)\s*[：:]\s*([^\s，。、；：！？（）()【】<>“”"'|]{1,14})/g,
            score: 22,
            source: 'decl-identity',
        },
        {
            // 你是Ako / 你是一只👾 / 你是一位作家
            re: /你(?:是一只|是一名|是一位|是一个|也就是|就是|是)\s*([^\s，。、；：！？（）()【】<>“”"'|]{1,10})(?=[\s，。、；：！？（）()【】<>“”"'|\n]|$)/g,
            score: 16,
            source: 'decl-you-are',
        },
        {
            // 我是Ako
            re: /我是\s*([^\s，。、；：！？（）()【】<>“”"'|]{1,10})(?=[\s，。、；：！？（）()【】<>“”"'|\n]|$)/g,
            score: 12,
            source: 'decl-i-am',
        },
        {
            // 作家泉此方 / 作者：泉此方 / 旁白小此 —— 写作角色词直接修饰人名
            re: /(?:作家|写手|作者|主笔|执笔者|叙述者|叙事者|旁白|说书人)\s*[：:]?\s*([^\s，。、；：！？（）()【】<>“”"'|]{2,4})/g,
            score: 24,
            source: 'decl-writer-prefixed',
            minCount: 2,
            rejectMixed: true,
        },
        {
            // 小猫之神的留言 / 狐神抚的留言
            re: /([^\s，。、；：！？（）()【】<>“”"'|]{1,12})的留言/g,
            score: 16,
            source: 'decl-signature',
        },
    ];

    for (const chunk of chunks) {
        for (const { re, score, source, minCount = 0, rejectMixed = false } of declarations) {
            re.lastIndex = 0;
            let match;
            let hits = 0;
            while ((match = re.exec(chunk.text)) !== null) {
                const raw = match[1];
                const name = stripNoise(raw);
                if (!looksLikeName(name)) continue;
                // 中英混排的"报bug"之类不是人名
                if (rejectMixed && CJK_RE.test(name) && /[A-Za-z]/.test(name)) continue;
                // 高频词才可能是人名，一次性出现的多半是句式残片
                if (minCount > 0 && occurrencesOf(name) < minCount) continue;
                hits += 1;
                if (hits > 6) break;
                const win = windowAround(chunk.text, match.index, match[0].length);
                const bonus = writerStrength(win);
                const evidence = match[0].replace(/\s+/g, ' ').trim();
                // 同一句式重复出现时递减计分，避免刷屏式重复盖过真实证据
                const repeatWeight = hits === 1 ? 1 : 0.3;
                const weight = chunk.weight * repeatWeight;
                const entry = acc.add(name, score, evidence, source, {
                    occurrences: 1,
                    weight,
                });
                if (entry && bonus > 0) {
                    entry.writerHits += 1;
                    acc.boost(name, bonus * weight, null, `${source}:writer-word`);
                }

                // 括号别名：小金 (超级魔法小狗) / 特图（Tet） / Izumi Konata(泉此方)
                const tailRe = /^\s*[（(]\s*([^)）]{1,20})\s*[)）]/;
                const tail = tailRe.exec(chunk.text.slice(match.index + match[0].length));
                if (entry && tail) {
                    const alias = stripNoise(tail[1]);
                    if (alias && alias !== name && looksLikeName(alias)) {
                        entry.aliases.add(alias);
                        pushEvidence(entry.evidence, `别名: ${name} (${alias})`);
                    }
                }
                // 前置括号：特图（Tet）形态已在 tail 中处理；这里是 名字(别名) 写在后面的情况
                if (entry) {
                    const prevSlice = chunk.text.slice(Math.max(0, match.index - 24), match.index);
                    const headRe = /([^\s（(]{1,16})\s*[（(]\s*$/;
                    const head = headRe.exec(prevSlice);
                    if (head) {
                        const headName = stripNoise(head[1]);
                        if (headName && headName !== name && looksLikeName(headName) && !labels.has(headName)) {
                            entry.aliases.add(headName);
                        }
                    }
                }
            }
            if (hits > 0) stats.patterns += 1;
        }
    }

    // --------------------------------------------------- C. preset name tokens
    const presetTokens = Array.from(new Set([
        ...tokenizePresetName(input.presetName ?? ''),
        ...tokenizePresetName(input.presetTitle ?? ''),
    ]));
    for (const token of presetTokens) {
        const occurrences = countOccurrences(allText, token);
        if (occurrences === 0) continue;
        const boosted = acc.boost(token, 20 + Math.min(occurrences, 18), `预设名 token: ${token} ×${occurrences}`, 'preset-name');
        if (boosted) continue;
        // 允许由预设名单独建立候选，但门槛更高：必须出现在标题/引号/预设名语境
        const contextRe = new RegExp(
            `(?:^|\\n)[^\\n]{0,30}${escapeRe(token)}[^\\n]{0,20}(?:预设|核心|主笔|作者|人格|工作室|搭档|身份)`,
            'u',
        );
        const quotedRe = new RegExp(`["“']${escapeRe(token)}["”']`, 'u');
        // 只在语料里真正复现（≥3 次）且落在标题/引号语境时，预设名才单独成为候选
        if (occurrences >= 3 && (contextRe.test(allText) || quotedRe.test(allText))) {
            acc.add(token, 18 + Math.min(occurrences, 10), `预设名/标题出现: ${token}`, 'preset-name', {
                occurrences,
            });
        }
    }

    // ------------------------------------------- D. merge + alias enrichment
    let entries = [...acc.map.values()];
    // drop duplicates that are substrings of a stronger candidate (小猫 vs 小猫之神)
    entries.sort((a, b) => b.score - a.score || b.name.length - a.name.length);
    /** @type {typeof entries} */
    const merged = [];
    for (const entry of entries) {
        const parent = merged.find(other => other !== entry && other.name.includes(entry.name) && countCodePoints(other.name) - countCodePoints(entry.name) <= 3);
        if (parent) {
            parent.aliases.add(entry.name);
            parent.occurrences = Math.max(parent.occurrences, entry.occurrences);
            for (const alias of entry.aliases) if (alias !== parent.name) parent.aliases.add(alias);
            for (const source of entry.sources) parent.sources.add(source);
            for (const evidence of entry.evidence) pushEvidence(parent.evidence, `「${entry.name}」${evidence}`);
            parent.score += Math.min(entry.score * 0.35, 18);
            parent.writerHits = (parent.writerHits ?? 0) + (entry.writerHits ?? 0);
            continue;
        }
        merged.push(entry);
    }
    entries = merged;

    // aliases: honorific trim, ASCII variants, latin typo variants, label variants
    for (const entry of entries) {
        for (const suffix of HONORIFIC_SUFFIXES) {
            if (!entry.name.endsWith(suffix)) continue;
            const stem = entry.name.slice(0, -suffix.length);
            if (countCodePoints(stem) < 2) continue;
            if (DANGLING_TAIL_RE.test(stem)) continue;
            entry.aliases.add(stem);
        }
        if (isLatinOnly(entry.name)) {
            if (entry.name !== entry.name.toLowerCase()) entry.aliases.add(entry.name.toLowerCase());
            if (entry.name !== entry.name.toUpperCase()) entry.aliases.add(entry.name.toUpperCase());
            const cap = entry.name.charAt(0).toUpperCase() + entry.name.slice(1);
            if (cap !== entry.name) entry.aliases.add(cap);
            for (const variant of findLatinVariants(entry.name, allText)) entry.aliases.add(variant);
        }
        // 同名标签写法（|X|）当作别名保留原样
        entry.aliases.delete(entry.name);
        entry.aliases = [...entry.aliases].filter(alias => alias && alias !== entry.name);
    }

    // ---------------------------------------------- E. conflicts + confidence
    const userName = (input.userName ?? '').trim();
    const characterName = (input.characterName ?? '').trim();
    /** @type {Candidate[]} */
    const candidates = entries
        .map(entry => {
            let conflict;
            if (userName && (entry.name === userName || entry.aliases.includes(userName))) conflict = 'user';
            else if (characterName && entry.name === characterName) conflict = 'character';
            const score = Math.round(entry.score);
            // occurrences 用「语料里真实出现次数」：既是 UI 上的替换命中预期，也是自动采用的门槛。
            const occurrences = occurrencesOf(entry.name);
            const writerHits = entry.writerHits ?? 0;
            // 只有「写作身份句式」才算强证据；小标题、列表项、泛泛的旁白词都不算。
            const strongSources = ['decl-partner', 'decl-signature', 'decl-writer-prefixed', 'decl-name', 'label'];
            const declCount = [...entry.sources].filter(source => source.startsWith('decl-')).length;
            const isStrong = [...entry.sources].some(source => strongSources.includes(source))
                // 多种声明句式同时指认（你是X + 我是X + 身份：X）
                || (declCount >= 2 && occurrences >= 8)
                // "我是Ako""你是Ako" 这类反复自述
                || ([...entry.sources].some(source => source === 'decl-i-am' || source === 'decl-you-are') && occurrences >= 8)
                // 预设名就是身份名，且在正文里反复出现
                || ([...entry.sources].includes('preset-name') && occurrences >= 20);
            const confidence = isStrong && (occurrences >= 8 || score >= 35)
                ? 'high'
                : isStrong && occurrences >= 3
                    ? 'medium'
                    : score >= 60 || (writerHits >= 2 && occurrences >= 12) ? 'high' : 'low';
            return {
                name: entry.name,
                score,
                confidence,
                evidence: entry.evidence.slice(0, 6),
                aliases: entry.aliases.slice(0, 20),
                sources: [...entry.sources],
                occurrences,
                writerHits,
                strongIdentity: isStrong,
                ...(conflict ? { conflict } : {}),
            };
        })
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || b.occurrences - a.occurrences)
        .slice(0, 10);

    return { candidates, stats, presetTokens };
}

/** Counts non-overlapping literal occurrences (case-sensitive). */
export function countOccurrences(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count += 1;
        index += needle.length;
    }
    return count;
}

/**
 * Finds ASCII spellings that differ slightly from the detected name
 * (Femris / Femiris), because presets are written by humans.
 */
function findLatinVariants(name, text) {
    if (!isLatinOnly(name) || name.length < 4) return [];
    const variants = new Set();
    const lowerName = name.toLowerCase();
    const head = lowerName.slice(0, 2);
    const wordRe = /[A-Za-z][A-Za-z0-9]{2,}/g;
    let match;
    while ((match = wordRe.exec(text)) !== null) {
        const word = match[0];
        if (word === name) continue;
        const lowerWord = word.toLowerCase();
        if (lowerWord === lowerName) continue;
        if (word.length < 4) continue;
        if (lowerWord.slice(0, 2) !== head) continue;
        if (Math.abs(word.length - name.length) > 2) continue;
        if (levenshteinAtMost(lowerWord, lowerName, 2)) variants.add(word);
    }
    return [...variants];
}

/** Bounded edit distance; returns true when distance <= max. */
function levenshteinAtMost(a, b, max) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > max) return false;
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            rowMin = Math.min(rowMin, curr[j]);
        }
        if (rowMin > max) return false;
        for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
    }
    return prev[b.length] <= max;
}


/**
 * Picks the best automatic candidate.
 * @param {Candidate[]} candidates
 * @returns {Candidate|null}
 */
/** 自动采用的最低出现次数：真实身份几乎都会在预设里反复出现，一次性的多是章节小标题。 */
export const AUTO_MIN_OCCURRENCES = 3;

export function pickAutoCandidate(candidates) {
    if (!Array.isArray(candidates)) return null;
    const usable = candidates.filter(candidate => !candidate.conflict);
    const solid = usable
        // 只出现 1~2 次的候选（"作家流派:"、"叙事者分析核心" 这类小标题）默认不自动套用
        .filter(candidate => (candidate.occurrences ?? 0) >= AUTO_MIN_OCCURRENCES)
        // 必须来自"写作身份句式"（核心搭档/留言署名/作家X/身份：/带 user 的转录标签），
        // 或分数高到 60 以上，否则只作为候选展示，等用户手动点选。
        .filter(candidate => (candidate.strongIdentity ?? false) || candidate.score >= 60);
    // 置信度已经在 detectWriterIdentities 里把"出现次数"算进去了：高置信直接采用，中等兜底。
    const strong = solid.find(candidate => candidate.confidence === 'high');
    if (strong) return strong;
    const medium = solid.find(candidate => candidate.confidence === 'medium');
    if (medium) return medium;
    // 兜底：只有一两次明确声明、但语料里确实这么自称的（"你是狐神抚""我是Ako"）
    const declared = usable
        .filter(candidate => (candidate.occurrences ?? 0) >= 1 && candidate.score >= 8)
        .filter(candidate => (candidate.sources ?? []).some(source => String(source).startsWith('decl-')))
        .sort((a, b) => b.score - a.score);
    return declared[0] ?? null;
}

/** Clamp helper reused by tests. */
export const __test = { looksLikeName, stripNoise, tokenizePresetName, clamp };
