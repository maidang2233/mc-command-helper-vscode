/**
 * 语法检测模块（SyntaxChecker）
 * =====================================================================
 * 移植自 CA Reforged 项目：ca/modules/CA.IntelliSense.js
 *   原作者：projectXero & 南鸢晨星（命令助手 Command Assistant）
 *   原仓库：https://github.com/CA-Reforged/CA_Reforged
 *
 * 本模块把 CA.IntelliSense.js 中的【语法检测方法】提取并改写为
 * TypeScript，供 VSCode 扩展（mc-command-helper）使用：
 *   1. splitCommand()       —— 拆分命令结构（/ 命令名 参数）
 *   2. check()              —— 整行命令语法检测（命令存在性 + 逐模式匹配 + 参数类型校验）
 *   3. matchParam()         —— 单参数类型校验（int/uint/float/relative/string/enum/plain/subcommand/json 等）
 *   4. isSelectorComplete() —— 括号/引号闭合检测（栈式，支持嵌套）
 *   5. parseSelectorPath()  —— 选择器路径递归解析（解决"不能完整识别嵌套"）
 *   6. procSelector()       —— 选择器参数补全链分析
 *   7. checkJsonSyntax()    —— JSON 语法错误检测（内置简易版）
 *
 * 命令库使用与 CA Reforged 相同的格式：
 *   library.commands[命令名].patterns[模式名].params[]
 *   library.selectors / library.enums / library.jsonSchema
 * =====================================================================
 */

// 状态码（与 CA.IntelliSense.js 一致）
const UNINITIALIZED = 0;
const ONLY_COMMAND_NAME = 1;
const UNKNOWN_COMMAND = -1;
const COMMAND_WITH_PATTERN = 2;
const UNKNOWN_PATTERN = -2;

export class SyntaxChecker {
    public library: any;
    public jsonLanguageServices: { [key: string]: any };

    constructor(library: any) {
        this.library = library || {};
        this.jsonLanguageServices = {};
        // 确保命令快照（用于命令名补全/模糊匹配）
        if (!this.library.command_snap) {
            const snap: any = {};
            const cmds = this.library.commands || {};
            Object.keys(cmds).forEach((e) => {
                let t = cmds[e];
                while (t.alias) t = cmds[t.alias];
                snap[e] = t.description || "";
            });
            this.library.command_snap = snap;
        }
    }

    /* ================================================================
     * 1. 命令结构拆分（等价 CA.IntelliSense.procCmd 的拆分部分）
     * ================================================================ */
    public splitCommand(s: string): any {
        const c = /^(\/)?(\S*)(\s+)?(.*)/.exec(s || "");
        if (!c) return null;
        return {
            source: c[0],
            cmdname: c[2],
            hasSlash: Boolean(c[1]),
            hasSpace: Boolean(c[3]),
            strParam: c[4]
        };
    }

    /**
     * 便捷入口：对整行命令做完整语法检测。
     * @param s 用户输入的命令行（如 "/give @s stone 1"）
     * @param cursor 光标位置（可选，用于 jsonPro 精确检测）
     */
    public check(s: string, cursor?: number): any {
        const r = this.procCmd(s, cursor);
        if (!r) return { mode: UNINITIALIZED, ok: false, errors: [{ message: "无法解析命令" }] };
        let errors: any[] = [];
        r.prompt.forEach((p: any) => {
            if (p && p.level === 'error') errors.push({ message: p.text });
        });
        if (r.mode === UNKNOWN_COMMAND) {
            errors = [{ message: "无法在库中找到命令“" + r.cmdname + "”。" }];
        } else if (r.mode === UNKNOWN_PATTERN && errors.length === 0) {
            errors = [{ message: "无法在库中找到命令“" + r.cmdname + "”的此类用法。" }];
        }
        return {
            mode: r.mode,
            ok: r.mode >= 0 && errors.length === 0,
            errors: errors,
            cmdname: r.cmdname,
            hasSlash: r.hasSlash,
            strParam: r.strParam,
            canFinish: !!r.canFinish,
            input: r.input || [],
            output: r.output || {},
            prompt: r.prompt || [],
            help: r.help
        };
    }

    /* ================================================================
     * 2. 命令存在性检查 + 全流程（等价 CA.IntelliSense.procCmd）
     * ================================================================ */
    public procCmd(s: string, cursor?: number): any {
        const c = this.splitCommand(s);
        if (!c) return null;
        const self = this;
        const pp = (text: string, level?: string) => ({ text: text, level: level || 'info' });

        const r: any = {
            source: c.source,
            cmdname: c.cmdname,
            hasSlash: c.hasSlash,
            strParam: c.strParam,
            input: [],
            output: {},
            prompt: [],
            patterns: [],
            help: null,
            canFinish: false,
            mode: UNINITIALIZED
        };

        if (c.hasSpace) {
            // 分类 - 已输入参数
            if (c.cmdname in this.library.commands) {
                this.procParams(r, cursor);
            } else {
                r.prompt.push(pp("无法在库中找到命令“" + c.cmdname + "”。", 'error'));
                r.help = "找不到这样的命令";
                r.mode = UNKNOWN_COMMAND;
            }
        } else {
            // 分类 - 未输入参数：列出候选命令
            const t = this.library.command_snap;
            const ca = Object.keys(t).filter((e) => {
                return e.indexOf(c.cmdname) >= 0 || t[e].indexOf(c.cmdname) >= 0;
            }).sort();

            if (ca.length) {
                ca.forEach((e) => {
                    let cm = self.library.commands[e];
                    while (cm.alias) cm = self.library.commands[cm.alias];
                    let text = (c.hasSlash ? "/" : "") + e;
                    if (!cm.noparams) text += " ...";
                    if (cm.noparams && c.cmdname === e && cm.noparams.description) {
                        r.canFinish = true;
                        text += "\n" + cm.noparams.description;
                    } else if ("description" in cm) {
                        text += "\n" + cm.description;
                    }
                    r.prompt.push(pp(text, 'highlight'));
                    r.output[cm.description ? e + " - " + cm.description : e] = (c.hasSlash ? "/" : "") + e + (cm.noparams ? "" : " ");
                });
                let first = self.library.commands[ca[0]];
                while (first.alias) first = self.library.commands[first.alias];
                r.help = first.help ? first.help : "该命令帮助还未上线";
                r.mode = ONLY_COMMAND_NAME;
            } else {
                r.prompt.push(pp(c.cmdname + " ...\n无法在库中找到命令“" + c.cmdname + "”。", 'error'));
                r.help = "命令不存在";
                r.mode = UNKNOWN_COMMAND;
            }
            r.input = Object.keys(r.output);
        }
        return r;
    }

    /* ================================================================
     * 3. 逐模式、逐参数匹配（等价 CA.IntelliSense.procParams）
     * ================================================================ */
    public procParams(c: any, cursor: number = 0): void {
        let i: any, j: any;
        let cm = this.library.commands[c.cmdname];
        let ps: any, pa: any, ci: number, cp: any, t: any, f = true, k: any, u: any;
        let pp: any, cpl: any[] = [], nn = false, erm: any[] = [];
        const self = this;
        const makePP = (text: string, level?: string) => ({ text: text, level: level || 'info' });

        // 别名处理
        while (cm.alias) cm = this.library.commands[cm.alias];

        c.help = cm.help ? cm.help : "该命令帮助还未上线";
        ps = cm.patterns;
        c.canFinish = false;

        // 对每一种模式进行判断
        for (i in ps) {
            const parsedParams: string[] = [];
            pa = ps[i].params;
            ci = 0;

            // 重置提示
            pp = makePP((c.hasSlash ? "/" : "") + c.cmdname);
            cpl.length = 0;

            // 逐部分匹配参数
            for (j = 0; j < pa.length; j++) {
                cp = pa[j];

                // 记录当前参数的开始位置
                const paramStart = ci;

                // 计算光标在当前参数中的偏移（用于 jsonPro 等需要精确光标的类型）
                cp._cursorOffset = cursor - (c.source.length - c.strParam.length + paramStart);

                // 匹配参数
                t = this.matchParam(cp, c.strParam.slice(ci), parsedParams, cursor);
                if (t && t.length >= 0 && (/^\s?$/).test(c.strParam.slice(ci += t.length, ++ci))) {
                    // 分类 - 匹配成功
                    ci += (/^\s*/).exec(c.strParam.slice(ci))![0].length;

                    const parsedParam = c.strParam.slice(paramStart, paramStart + t.length).trim();
                    if (parsedParam) parsedParams.push(parsedParam);

                    if (ci > c.strParam.length) {
                        // 分类 - 到达末尾
                        u = (c.hasSlash ? "/" : "") + c.cmdname + " " + c.strParam.slice(0, ci - t.length - 1);
                        if (pa[j + 1] && !pa[j + 1].optional) {
                            for (k in t.output) t.output[k] = t.output[k] + " ";
                        }
                        if (t.length && t.canFinish && pa[j + 1]) nn = true;
                        if (t.input) for (k in t.input) if (c.input.indexOf(t.input[k]) < 0) c.input.push(t.input[k]);
                        if (t.output) for (k in t.output) if (!(k in c.output)) {
                            if (t.output[k] && typeof t.output[k] === 'object' && t.output[k].text !== undefined) {
                                c.output[k] = { text: u + t.output[k].text, cursor: u.length + t.output[k].cursor };
                            } else {
                                c.output[k] = u + t.output[k];
                            }
                        }
                        if (t.recommend) for (k in t.recommend) if (!(k in c.output)) c.output[k] = u + t.recommend[k];
                        if (t.assist) for (k in t.assist) if (!(k in c.output)) c.output[k] = c.source + t.assist[k];
                        if (t.menu) for (k in t.menu) if (!(k in c.output)) c.output[k] = t.menu[k];
                        if (t.canFinish && (!pa[j + 1] || pa[j + 1].optional)) c.canFinish = true;
                        f = false;
                        pp.text += " " + this.getParamTag(cp, c.strParam.slice(ci - t.length - 1, ci), 1, t);
                        for (j++; j < pa.length; j++) {
                            pp.text += " " + this.getParamTag(pa[j], "", 2, null);
                        }
                        if (t.description || cp.description || ps[i].description || cm.description) {
                            pp.text += "\n" + (t.description ? String(t.description) : cp.description ? String(cp.description) : ps[i].description ? String(ps[i].description) : String(cm.description));
                        }
                        if (t.prompt && t.prompt.length > 0) {
                            t.prompt.forEach((p: any) => { pp.text += "\n" + (typeof p === 'string' ? p : p.text || ""); });
                        }
                        c.prompt.push(pp);
                        c.patterns.push(cpl);
                        break;
                    } else {
                        // 分类 - 未到达末尾
                        if (!t.canFinish) {
                            if (cp.canIgnore) {
                                continue;
                            } else {
                                const ppErr = makePP((c.hasSlash ? "/" : "") + c.cmdname);
                                ppErr.text += " " + this.getParamTag(cp, "", 3, t);
                                for (k = j + 1; k < pa.length; k++) {
                                    ppErr.text += " " + this.getParamTag(pa[k], "", 2, null);
                                }
                                erm.push({ desp: "未结束的参数", count: j, pp: ppErr });
                                break;
                            }
                        }
                        pp.text += " " + this.getParamTag(cp, c.strParam.slice(ci - t.length - 1, ci - 1), 0, null);
                        cpl.push(t);
                    }
                } else {
                    // 分类 - 匹配失败
                    if (cp.canIgnore) {
                        continue; // 忽略参数
                    } else {
                        const ppErr2 = makePP((c.hasSlash ? "/" : "") + c.cmdname);
                        ppErr2.text += " " + this.getParamTag(cp, "", 3, t);
                        for (k = j + 1; k < pa.length; k++) {
                            ppErr2.text += " " + this.getParamTag(pa[k], "", 2, null);
                        }
                        erm.push({
                            desp: !t ? null : t.length >= 0 ? "字符多余：" + c.strParam.slice(ci - 1) : t.description,
                            count: j,
                            pp: ppErr2
                        });
                        break; // 下一个模式
                    }
                }
                if (cp.repeat) { j--; continue; } // 重复
            }
        }

        // 如果未找到正确用法
        if (f) {
            c.input = [];
            erm.sort((a: any, b: any) => b.count - a.count);
            erm.forEach((e: any) => {
                e.pp.text += "\n" + (e.desp ? e.desp : "用法不存在");
                e.pp.level = 'error';
                c.prompt.push(e.pp);
            });
            if (!erm.length) {
                const ppNone = makePP((c.hasSlash ? "/" : "") + c.cmdname + " ...\n无法在库中找到命令“" + c.cmdname + "”的此类用法。", 'error');
                c.prompt.push(ppNone);
            }
        } else if (nn) {
            c.input.push("  - 下一个参数");
            c.output["  - 下一个参数"] = c.source + " ";
        }
        c.mode = f ? UNKNOWN_PATTERN : COMMAND_WITH_PATTERN;
    }

    /* ================================================================
     * 4. 单参数类型校验（等价 CA.IntelliSense.matchParam）
     * ================================================================ */
    public matchParam(cp: any, ps: string, parsedParams: any[], cursor?: number): any {
        let i: any, r: any, t: any, t2: any, t3: any;
        switch (cp.type) {
            case "text":
            case "rawjson":
                r = { length: ps.length, canFinish: true };
                break;

            case "nbt":
            case "json":
                r = { input: ["插入JSON"], menu: {}, length: ps.length, canFinish: true };
                break;

            case "jsonPro":
                r = this.matchJsonPro(cp, ps, cursor);
                break;

            case "plain":
                t = cp.name;
                if (cp.prompt) t += " - " + cp.prompt;
                r = { input: [t], output: {} };
                r.output[t] = cp.name;
                if (ps.startsWith(cp.name + " ") || ps === cp.name) {
                    r.length = cp.name.length;
                    r.canFinish = true;
                } else if (cp.name.indexOf(ps) >= 0 || (cp.prompt && cp.prompt.indexOf(ps) >= 0)) {
                    r.length = ps.length;
                    r.canFinish = false;
                } else {
                    return { description: "不可为" + ps };
                }
                break;

            case "selector":
                r = this.procSelector(cp, ps);
                if (!r || !(r.length >= 0)) return r;
                break;

            case "uint":
                t = ps.search(" ") < 0 ? ps : ps.slice(0, ps.search(" "));
                if (!(/^\d*$/).test(t)) return { description: t + "不是自然数" };
                r = { length: t.length, canFinish: t.length > 0 };
                break;

            case "int":
                t = ps.search(" ") < 0 ? ps : ps.slice(0, ps.search(" "));
                if (!(/^(\+|-)?\d*$/).test(t)) return { description: t + "不是整数" };
                r = { length: t.length, canFinish: t.length && !isNaN(t) };
                break;

            case "float":
                t = ps.search(" ") < 0 ? ps : ps.slice(0, ps.search(" "));
                if (!(t2 = (/^(\+|-)?(\d*\.)?(\d)*$/).exec(t))) return { description: t + "不是数值" };
                r = { length: t.length, canFinish: t.length && t2[3] };
                break;

            case "relative":
                t = ps.search(" ") < 0 ? ps : ps.slice(0, ps.search(" "));
                t2 = (/^(~)?((\+|-)?(\d*\.)?\d*)$/).exec(t);
                if (!t2) return { description: t + "不是数值" };
                r = { length: t.length, input: [], assist: {}, canFinish: true };
                if (ps.indexOf('~') === -1 && ps.length === 0) {
                    r.input = ["~ - 相对标识符"];
                    r.assist = { "~ - 相对标识符": "~" };
                }
                break;

            case "position":
                r = this.procPosition(cp, ps);
                if (!r || !(r.length >= 0)) return r;
                break;

            case "custom":
                t = new RegExp(cp.input, "").exec(ps);
                if (!t) return { description: (t === null ? ps : t) + "不满足指定的条件" };
                r = { length: t[0].length, canFinish: new RegExp(cp.finish, "").test(ps) };
                break;

            case "enum":
                if (!(t = cp.list instanceof Object ? cp.list : this.library.enums[cp.list])) throw "无法找到指定枚举类型";
                r = { output: {}, canFinish: false, length: -1 };
                if (Array.isArray(t)) {
                    r.input = t.filter((e: any) => {
                        if (ps.startsWith(e + " ") || ps === e) {
                            r.length = Math.max(r.length, e.length);
                            r.canFinish = true;
                        } else if (e.startsWith(ps)) {
                            r.length = Math.max(r.length, ps.length);
                        } else return false;
                        r.output[e] = e;
                        return true;
                    });
                    r.input.sort();
                } else {
                    t2 = [];
                    r.input = [];
                    Object.keys(t).forEach((e) => {
                        if (ps.startsWith(e + " ") || ps === e) {
                            r.length = Math.max(r.length, e.length);
                            r.canFinish = true;
                        } else if (e.indexOf(ps) >= 0 || t[e].indexOf(ps) >= 0) {
                            r.length = Math.max(r.length, ps.length);
                        } else return;
                        if (t[e]) {
                            r.output[e + " - " + t[e]] = e;
                            r.input.push(e + " - " + t[e]);
                        } else {
                            r.output[e] = e;
                            t2.push(e);
                        }
                    });
                    r.input.sort(); t2.sort(); r.input = r.input.concat(t2);
                }
                if (r.length < 0) r.description = ps + "不是有效的元素";
                break;

            case "command":
                t = this.procCmd(ps);
                if (!t) return { description: "不是合法的命令格式" };
                t2 = t.prompt[0];
                t3 = (t2 && typeof t2.text === 'string') ? t2.text.indexOf("\n") : -1;
                r = {
                    length: t.mode < 0 ? -1 : t.source.length,
                    input: t.input,
                    output: {},
                    menu: {},
                    canFinish: t.canFinish,
                    description: (t3 >= 0 && t2) ? t2.text.slice(t3 + 1) : (t2 ? t2.text : ""),
                    tag: (t3 >= 0 && t2) ? t2.text.slice(0, t3) : (t2 ? t2.text.split('\n')[0] : "")
                };
                for (i in t.output) {
                    if (t.output[i] instanceof Function) r.menu[i] = t.output[i];
                    else r.output[i] = t.output[i];
                }
                break;

            case "subcommand":
                const mainCmd = cp.mainCommand;
                if (typeof mainCmd !== 'string') return { description: "主命令未定义或格式错误" };
                // 处理主命令 + 子命令参数，移除主命令前缀
                t = this.removeCmdPrefix(this.procCmd(mainCmd + ' ' + ps), mainCmd + ' ');
                if (!t || !Array.isArray(t.prompt) || !t.prompt[0]) return { description: "不是合法的命令格式" };
                t2 = t.prompt[0];
                t3 = (t2 && typeof t2.text === 'string') ? t2.text.indexOf("\n") : -1;
                r = {
                    length: t.mode < 0 ? -1 : (t.source && t.source.length) || 0,
                    input: Array.isArray(t.input) ? t.input : [],
                    output: {},
                    menu: {},
                    canFinish: !!t.canFinish,
                    description: (t3 >= 0 && t2) ? t2.text.slice(t3 + 1) : (typeof t2 === 'string' ? t2 : ""),
                    tag: (t3 >= 0 && t2) ? t2.text.slice(0, t3) : (typeof t2 === 'string' ? t2.split('\n')[0] : "")
                };
                if (t.output && typeof t.output === 'object') {
                    Object.keys(t.output).forEach((k) => {
                        if (typeof t.output[k] === 'function') r.menu[k] = t.output[k];
                        else r.output[k] = t.output[k];
                    });
                }
                break;

            case "string":
                // 把被双引号包围的片段先抓出来，占位替换防止被 split 拆开
                const quotedMatches = ps.match(/"[^"]*"/g) || [];
                let tmp = ps;
                const placeholders: string[] = [];
                quotedMatches.forEach((m: string, idx: number) => {
                    const ph = "__QUOTED_" + idx + "__";
                    placeholders.push(ph);
                    tmp = tmp.replace(m, ph);
                });
                const restParts = tmp.split(" ").filter(Boolean);
                const finalParts = restParts.map((part: string) => {
                    const idx = placeholders.indexOf(part);
                    return idx >= 0 ? quotedMatches[idx] : part;
                });
                t = finalParts[0] || "";
                r = { length: t.length, canFinish: t.length > 0 };
                break;

            case "status":
                r = this.matchStatus(cp, ps, parsedParams);
                break;

            default:
                t = ps.search(" ") < 0 ? ps : ps.slice(0, ps.search(" "));
                r = { length: t.length, canFinish: true };
        }
        // 额外的建议命名空间（suggestion 字段）
        if (!cp.suggestion) return r;
        t = cp.suggestion instanceof Object ? cp.suggestion : this.library.enums[cp.suggestion];
        t2 = ps.slice(0, r.length);
        this.matchString(t2, t, r);
        return r;
    }

    /**
     * 子命令前缀移除（等价 CA.IntelliSense.removeCmdPrefix）
     */
    public removeCmdPrefix(obj: any, prefix: string): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.output && typeof obj.output === 'object') {
            Object.keys(obj.output).forEach((k) => {
                const v = obj.output[k];
                if (typeof v === 'string' && v.indexOf(prefix) === 0) obj.output[k] = v.slice(prefix.length);
            });
        }
        if (Array.isArray(obj.prompt)) {
            obj.prompt = obj.prompt.map((v: any) => {
                if (v && typeof v.text === 'string' && v.text.indexOf(prefix) === 0) {
                    return { text: v.text.slice(prefix.length), level: v.level };
                }
                return v;
            });
        }
        return obj;
    }

    /**
     * 参数标签（等价 CA.IntelliSense.getParamTag 的文本版）
     * mt: 0=输入中 1=已输入 2=未输入 3=出错
     */
    public getParamTag(cp: any, ms: string, mt: number, md: any): string {
        let z = cp.name;
        if (cp.repeat) z += "…";
        if (mt === 0) return "(" + z + ": " + ms + ")";
        if (mt === 1) {
            if (md && md.length >= 0) z = ms + (cp.repeat ? "…" : "");
            return "(" + z + ")";
        }
        if (mt === 2) {
            if (cp.optional) return "[" + z + "]";
            return "<" + z + ">";
        }
        if (mt === 3) {
            const tt = (md && md.description) ? md.description : "参数不合法";
            return "<" + z + ": " + tt + ">";
        }
        return "<" + z + ">";
    }

    /**
     * 模糊匹配建议项（等价 CA.IntelliSense.matchString）
     */
    public matchString(ps: string, a: any, r: any): any {
        let t: any[], t2: string[], t3: string;
        if (!(r instanceof Object)) r = {};
        if (!Array.isArray(r.input)) r.input = [];
        if (!(r.output instanceof Object)) r.output = {};
        if (typeof a === 'string') a = this.library.enums[a];
        if (!a) return r;
        if (Array.isArray(a)) {
            t = [];
            a.forEach((e: string) => {
                if (e.indexOf(ps) < 0) return;
                r.output[e] = e;
                if (r.input.indexOf(e) < 0) t.push(e);
            });
            t.sort();
            r.input = r.input.concat(t);
        } else {
            t = []; t2 = [];
            Object.keys(a).forEach((e) => {
                if (e.indexOf(ps) < 0 && a[e].indexOf(ps) < 0) return;
                if (a[e]) {
                    t3 = e + " - " + a[e];
                    r.output[t3] = e;
                    if (r.input.indexOf(t3) < 0) t.push(t3);
                } else {
                    r.output[e] = e;
                    if (r.input.indexOf(e) < 0) t2.push(e);
                }
            });
            t.sort(); t2.sort();
            r.input = r.input.concat(t, t2);
        }
        return r;
    }

    /* ================================================================
     * 5. 括号/引号闭合检测（等价 CA.IntelliSense.isSelectorComplete）
     *    栈式匹配 { } [ ]，跳过引号内内容，支持任意层嵌套。
     * ================================================================ */
    public isSelectorComplete(inputStr: string): any {
        const stack: string[] = [];
        let inQuote = false;
        let leftBrace = 0, rightBrace = 0;
        let leftBracket = 0, rightBracket = 0;
        let selectorEnd = -1;

        for (let i = 0; i < inputStr.length; i++) {
            const c = inputStr[i];
            if (c === '"') inQuote = !inQuote;
            if (inQuote) continue;

            if (c === '{') { stack.push(c); leftBrace++; }
            if (c === '[') { stack.push(c); leftBracket++; }

            if (c === '}') {
                rightBrace++;
                if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop();
            }
            if (c === ']') {
                rightBracket++;
                if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop();
                if (stack.length === 0 && !inQuote) {
                    selectorEnd = i + 1;
                    break;
                }
            }
        }

        return {
            isValid: stack.length === 0 && !inQuote &&
                leftBrace === rightBrace &&
                leftBracket === rightBracket,
            debugInfo: {
                leftBrace: leftBrace,
                rightBrace: rightBrace,
                leftBracket: leftBracket,
                rightBracket: rightBracket,
                remainingStack: stack.slice(),
                inQuote: inQuote,
                selectorEnd: selectorEnd
            }
        };
    }

    /**
     * 按逗号分割字符串，忽略嵌套结构与引号内的逗号
     */
    public splitByComma(str: string): string[] {
        const segments: string[] = [];
        let braceCount = 0, bracketCount = 0;
        let inQuote = false;
        let lastSplit = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            if (char === '"') inQuote = !inQuote;
            if (inQuote) continue;
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
            if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
            if (char === ',' && braceCount === 0 && bracketCount === 0) {
                segments.push(str.substring(lastSplit, i));
                lastSplit = i + 1;
            }
        }
        segments.push(str.substring(lastSplit));
        return segments;
    }

    /**
     * 查找顶层的等号（忽略嵌套结构内的等号）
     */
    public findTopLevelEqual(str: string): number {
        let braceCount = 0, bracketCount = 0;
        let inQuote = false;
        for (let j = 0; j < str.length; j++) {
            const c = str[j];
            if (c === '"') inQuote = !inQuote;
            if (inQuote) continue;
            if (c === '{') braceCount++;
            else if (c === '}') braceCount--;
            if (c === '[') bracketCount++;
            else if (c === ']') bracketCount--;
            if (c === '=' && braceCount === 0 && bracketCount === 0) return j;
        }
        return -1;
    }

    /**
     * 选择器路径递归解析（等价 CA.IntelliSense.parseSelectorPath）
     * 返回 { stack, state, currentInput, keys, debug }
     * state: complete / wait_key / wait_value / wait_value_array
     */
    public parseSelectorPath(inputStr: string): any {
        const self = this;
        const selectorCompleteResult = this.isSelectorComplete(inputStr);

        if (selectorCompleteResult.isValid) {
            return {
                stack: [],
                state: 'complete',
                debug: selectorCompleteResult.debugInfo,
                currentInput: '',
                keys: []
            };
        }

        function _recursiveParse(currentStr: string, parentStack: string[], keys: string[]): any {
            if (keys === undefined) keys = [];
            currentStr = currentStr.trim();
            const stack = parentStack.slice();

            // === 处理数组开头 '[' ===
            if (currentStr.startsWith('[')) {
                const isTopLevel = parentStack.length === 0;
                stack.push(isTopLevel ? '{...}' : '[...]');
                const innerContent = currentStr.slice(1);
                const items = self.splitByComma(innerContent);
                items.forEach((item: string) => {
                    const eq = self.findTopLevelEqual(item);
                    if (eq >= 0) keys.push(item.substring(0, eq).trim());
                });
                const activeItem = items[items.length - 1].trim();
                if (activeItem === '') {
                    if (stack[stack.length - 1] === '{...}') {
                        return { stack: stack, state: 'wait_key', currentInput: '', keys: keys };
                    } else {
                        return { stack: stack, state: 'wait_value_array', currentInput: '', keys: keys };
                    }
                }
                return _recursiveParse(activeItem, stack, keys);
            }

            // === 处理对象开头 '{' ===
            if (currentStr.startsWith('{')) {
                stack.push('{...}');
                const inner = currentStr.slice(1);
                const pairs = self.splitByComma(inner);
                const activeItem2 = pairs[pairs.length - 1].trim();
                if (activeItem2 === '') {
                    return { stack: stack, state: 'wait_key', currentInput: '', keys: keys };
                }
                return _recursiveParse(activeItem2, stack, keys);
            }

            // === 处理键值对 ===
            const equalIndex = self.findTopLevelEqual(currentStr);
            if (equalIndex !== -1) {
                const key = currentStr.substring(0, equalIndex).trim();
                const value = currentStr.substring(equalIndex + 1).trim();
                if (stack.length > 0 && stack[stack.length - 1] === '{...}') stack.pop();
                stack.push(key);
                if (value.startsWith('[') || value.startsWith('{')) {
                    return _recursiveParse(value, stack, keys);
                } else {
                    stack.push('...');
                    return { stack: stack, state: 'wait_value', currentInput: value, keys: keys };
                }
            }
            // === 处理没有等号的字符串 ===
            else {
                if (currentStr === '') {
                    if (stack.length > 0 && stack[stack.length - 1] === '[...]') {
                        return { stack: stack, state: 'wait_value_array', currentInput: '', keys: keys };
                    } else {
                        return { stack: stack, state: 'wait_key', currentInput: '', keys: keys };
                    }
                }
                if (stack.length > 0 && stack[stack.length - 1] === '{...}') {
                    return { stack: stack, state: 'wait_key', currentInput: currentStr, keys: keys };
                }
                return { stack: stack, state: 'wait_value', currentInput: currentStr, keys: keys };
            }
        }

        const result = _recursiveParse(inputStr.trim(), [], []);
        result.debug = selectorCompleteResult.debugInfo;
        return result;
    }

    /**
     * 为选择器参数生成补全建议（等价 CA.IntelliSense.getSelectorParamCompletions）
     */
    public getSelectorParamCompletions(input: string, base: string, selectors: any, addtext: string, sort?: boolean): any {
        const completions: any = {};
        const sortedKeys = Object.keys(selectors);
        addtext = addtext || "";
        sortedKeys.forEach((key) => {
            const sel = selectors[key];
            const name = (sel && typeof sel === 'object' && sel.name) ? sel.name : "";
            const display = name ? key + " - " + name : key;
            if (input && display.toLowerCase().indexOf(input.toLowerCase()) < 0) return;
            completions[display] = (base || "") + key + addtext;
        });
        if (sort === false) return completions;
        const out: any = {};
        Object.keys(completions).sort().forEach((k) => { out[k] = completions[k]; });
        return out;
    }

    /**
     * 选择器参数补全链分析（等价 CA.IntelliSense.procSelector）
     */
    public procSelector(cp: any, ps: string): any {
        const selectorParam = ps.replace(/^@[pareas]/, "");
        const selResult = this.parseSelectorPath(selectorParam);
        const debug = selResult && selResult.debug ? selResult.debug : {};
        const pathArr = selResult.stack ? selResult.stack.slice() : [];
        const recommend: any = {};
        let canFinish = false;
        let selectorEnd = 0;

        if (debug.selectorEnd !== -1) {
            selectorEnd = debug.selectorEnd + 2;
        } else {
            selectorEnd = ps.length;
        }
        let needSelectorParam = false;

        if (/^@[a-zA-Z]\[/.test(ps)) {
            canFinish = false;
            needSelectorParam = true;
            if (debug.selectorEnd !== -1) canFinish = true;
        } else if (/^@[a-zA-Z] +/.test(ps)) {
            canFinish = true;
            selectorEnd = 2;
        } else if (/^@[a-zA-Z]$/.test(ps)) {
            canFinish = true;
            recommend["[...] - 插入参数"] = ps + "[";
        } else if (/^(?:[^\s"]+|"[^"]*") /.test(ps) || (ps.length > 0 && !/^@[a-zA-Z] +/.test(ps))) {
            const firstArgMatch = /^([^\s"]+|"[^"]*")/.exec(ps);
            if (firstArgMatch) {
                selectorEnd = firstArgMatch[0].length;
                canFinish = true;
            } else {
                selectorEnd = ps.length;
                canFinish = false;
                if (/^"/.test(ps)) recommend['" - 结束双引号'] = ps + '" ';
            }
        }

        if (selectorEnd === 0) {
            recommend["@a - 选择所有玩家"] = "@a";
            recommend["@p - 选择距离最近的玩家"] = "@p";
            recommend["@r - 选择随机玩家"] = "@r";
            recommend["@e - 选择所有实体"] = "@e";
            recommend["@s - 选择命令执行者"] = "@s";
            recommend["@n - 选择最近的实体"] = "@n";
        }

        let recommend_enums: any = {};
        if (needSelectorParam) {
            const input = selResult.currentInput || "";
            const filteredPathArr = pathArr.filter((item: string) => item !== "[...]");

            if (filteredPathArr[filteredPathArr.length - 1] === "{...}") {
                // 进入选择器层级
                if (input.length > 0) recommend["= - 输入参数"] = ps + "=";
                if (filteredPathArr.length === 1) {
                    recommend_enums = this.getSelectorParamCompletions(input, ps, this.library.selectors || {}, "=");
                } else if (filteredPathArr.length === 2) {
                    const parentKey = filteredPathArr[filteredPathArr.length - 2];
                    const selectors = this.library.selectors || {};
                    if (parentKey && selectors[parentKey]) {
                        if (selectors[parentKey]["fields"]) {
                            recommend_enums = this.getSelectorParamCompletions(input, ps, selectors[parentKey]["fields"], "=");
                        }
                    }
                }
            } else if (pathArr[pathArr.length - 1] === "...") {
                if (input.length > 0) {
                    recommend[", - 下一个参数"] = ps + ",";
                    const openBrackets = debug.remainingStack;
                    if (openBrackets.slice(-1) === "{") {
                        recommend["} - 结束键值"] = ps + "}";
                    } else if (openBrackets.length > 1 && openBrackets.slice(-1) === "[") {
                        recommend["] - 结束数组"] = ps + "]";
                    } else if (openBrackets.length === 1 && openBrackets.slice(-1) === "[") {
                        recommend["] - 结束选择器"] = ps + "]";
                    }
                }
            } else if (pathArr[pathArr.length - 1] === "{...}") {
                if (input.length > 0) recommend["= - 输入参数"] = ps + "=";
            }
        }

        for (const key in recommend_enums) {
            if (recommend_enums.hasOwnProperty(key)) {
                recommend[key] = recommend_enums[key];
            }
        }

        return {
            length: canFinish ? selectorEnd : ps.length,
            canFinish: canFinish,
            recommend: recommend,
            input: Object.keys(recommend),
            output: {}
        };
    }

    /**
     * 坐标位置解析（等价 CA.IntelliSense.procPosition 简化版：x y z 三段 relative）
     */
    public procPosition(cp: any, ps: string): any {
        const parts = ps.split(/\s+/).filter(Boolean);
        let i: number, len = 0, ok = true;
        for (i = 0; i < 3 && i < parts.length; i++) {
            if (!(/^(~)?((\+|-)?(\d*\.)?\d*)$/).test(parts[i])) {
                ok = false;
                break;
            }
            len += parts[i].length + 1;
        }
        if (!ok) return { description: parts[i] + "不是数值" };
        return { length: Math.min(len, ps.length), canFinish: parts.length >= 3 };
    }

    /**
     * 方块状态（status）匹配（等价 CA.IntelliSense.matchParam 的 status 分支）
     */
    public matchStatus(cp: any, ps: string, parsedParams: any[]): any {
        const recommend: any = {};
        let recommend_enums: any = {};
        const r: any = { canFinish: false, length: ps.length, recommend: {}, input: [] };

        if (!ps.startsWith('[')) {
            r.length = 0;
            r.canFinish = true;
            return r;
        }
        if (ps.length === 0) {
            recommend["[...] - 插入状态"] = ps + "[";
        } else if (ps.length > 0) {
            const selResult = this.parseSelectorPath(ps);
            if (selResult.state === "complete") {
                r.length = selResult.debug.selectorEnd;
                r.canFinish = true;
                return r;
            }
            const input = selResult.currentInput || "";
            const pathArr = selResult.stack ? selResult.stack.slice() : [];
            const keys = selResult.keys;
            let schema: any;

            if (selResult.state === "wait_key") {
                schema = this.getSchemaByContext(parsedParams[parsedParams.length - 1], cp.subject);
                if (!schema) schema = {};
                recommend_enums = this.getSelectorParamCompletions(input, ps, this.removeKeysFromSchema(schema, keys), "=");
            } else if (selResult.state === "wait_value") {
                if (input.length >= 1) {
                    recommend[", - 下一个参数"] = ps + ",";
                    recommend["] - 结束参数"] = ps + "] ";
                }
                schema = this.getSchemaByContext(parsedParams[parsedParams.length - 1], cp.subject);
                if (pathArr[pathArr.length - 2] && schema && schema[pathArr[pathArr.length - 2]]) {
                    const param = this.matchParam(schema[pathArr[pathArr.length - 2]], input, []);
                    const rec = param.output || param.recommend || {};
                    const bb = ps.slice(0, ps.lastIndexOf('=') + 1);
                    for (const k in rec) {
                        if (rec.hasOwnProperty(k)) recommend_enums[k] = bb + rec[k];
                    }
                }
            }
        }
        for (const key in recommend_enums) {
            if (recommend_enums.hasOwnProperty(key)) recommend[key] = recommend_enums[key];
        }
        r.recommend = recommend;
        r.input = Object.keys(recommend);
        return r;
    }

    /**
     * 根据上下文获取状态 Schema（等价 CA.IntelliSense.getSchemaByContext）
     */
    public getSchemaByContext(contextValue: any, type: string): any {
        const jsonSchema = this.library.jsonSchema || {};
        const table = jsonSchema[type];
        if (!table) return null;
        if (typeof table === 'object' && !Array.isArray(table)) {
            let key = contextValue || "";
            if (key in table) return table[key];
            key = String(key).replace(/^[a-zA-Z0-9_]+:/, "");
            if (key in table) return table[key];
        }
        return table;
    }

    /**
     * 从 Schema 中移除已使用的键（等价 CA.IntelliSense.removeKeysFromSchema）
     */
    public removeKeysFromSchema(schema: any, keys: string[]): any {
        if (!schema || typeof schema !== 'object') return schema;
        const out: any = {};
        Object.keys(schema).forEach((k) => {
            if (keys.indexOf(k) < 0) out[k] = schema[k];
        });
        return out;
    }

    /* ================================================================
     * 6. JSON 语法检测（简易扫描器 + JSON.parse 兜底）
     * ================================================================ */
    public checkJsonSyntax(jsonStr: string): any[] {
        const errors: any[] = [];
        const stack: string[] = [];
        let inQuote = false;
        let escapeNext = false;
        let stringStart = -1;
        for (let i = 0; i < jsonStr.length; i++) {
            const ch = jsonStr[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (ch === '\\') { escapeNext = true; continue; }
            if (ch === '"') {
                if (!inQuote) {
                    inQuote = true;
                    stringStart = i;
                    stack.push('quote');
                } else {
                    inQuote = false;
                    stack.pop();
                }
                continue;
            }
            if (inQuote) continue;
            if (ch === '{') stack.push('brace');
            else if (ch === '[') stack.push('bracket');
            else if (ch === '}') {
                if (stack.length === 0 || stack[stack.length - 1] !== 'brace') {
                    errors.push({ offset: i, message: "多余的右大括号 }" });
                } else stack.pop();
            } else if (ch === ']') {
                if (stack.length === 0 || stack[stack.length - 1] !== 'bracket') {
                    errors.push({ offset: i, message: "多余的右中括号 ]" });
                } else stack.pop();
            }
        }
        if (inQuote) errors.push({ offset: stringStart, message: "字符串未闭合" });
        if (stack.length > 0) {
            const last = stack[stack.length - 1];
            if (last === 'quote') errors.push({ offset: jsonStr.length, message: "字符串未闭合" });
            else if (last === 'brace') errors.push({ offset: jsonStr.length, message: "缺少右大括号 }" });
            else if (last === 'bracket') errors.push({ offset: jsonStr.length, message: "缺少右中括号 ]" });
        }

        if (errors.length > 0) return errors;
        if (!jsonStr.trim()) return errors;

        try {
            JSON.parse(jsonStr);
        } catch (e: any) {
            const m = /position (\d+)/.exec(e.message);
            errors.push({
                offset: m ? parseInt(m[1], 10) - 1 : 0,
                message: "JSON语法错误：" + (e.message || String(e))
            });
        }
        return errors;
    }

    /**
     * jsonPro 参数匹配（简化版：内置 checkJsonSyntax，不依赖 vscode-json-languageservice）
     */
    public matchJsonPro(cp: any, ps: string, cursor?: number): any {
        const schema = this.library.jsonSchema && this.library.jsonSchema[cp.schema];
        if (!schema) {
            return { length: ps.length, canFinish: false, description: "找不到Schema: " + cp.schema };
        }

        const errors = this.checkJsonSyntax(ps);
        const r: any = {
            length: ps.length,
            canFinish: false,
            input: [],
            output: {},
            prompt: []
        };

        if (errors.length > 0) {
            errors.sort((a: any, b: any) => a.offset - b.offset);
            const firstError = errors[0];
            r.description = "JSON错误：" + firstError.message + " (位置: " + firstError.offset + ")";
            r.canFinish = false;
            return r;
        }
        r.canFinish = ps.length > 0;
        return r;
    }

    /**
     * 工具：把 prompt 列表转成纯文本（供 UI 直接展示）
     */
    public promptToText(promptList: any[]): string {
        if (!Array.isArray(promptList)) return "";
        return promptList.map((p) => {
            return (p && typeof p === 'object' && 'text' in p) ? p.text : String(p);
        }).join("\n");
    }

    public readonly UNINITIALIZED = UNINITIALIZED;
    public readonly ONLY_COMMAND_NAME = ONLY_COMMAND_NAME;
    public readonly UNKNOWN_COMMAND = UNKNOWN_COMMAND;
    public readonly COMMAND_WITH_PATTERN = COMMAND_WITH_PATTERN;
    public readonly UNKNOWN_PATTERN = UNKNOWN_PATTERN;
}
