import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SyntaxChecker } from './syntax-check';

export function activate(context: vscode.ExtensionContext) {
    console.log('Minecraft 指令助手已成功激活！');

    const dataPath = path.join(context.extensionPath, 'data', '默认命令库.json');
    let mcData: any = { commands: {}, enums: {}, idlist: [], selectors: {} };

    try {
        if (fs.existsSync(dataPath)) {
            const rawData = fs.readFileSync(dataPath, 'utf-8');
            mcData = JSON.parse(rawData);
        } else {
            vscode.window.showErrorMessage('未找到数据文件：data/默认命令库.json');
        }
    } catch (e) {
        vscode.window.showErrorMessage('解析数据文件失败！');
    }
    const targetLanguages = [
        { language: 'mcfunction' },
        { language: 'bc-mcfunction' },
        { language: 'plaintext' }
    ];

    const triggerCmds = ['/', ' ', '@', '[', ']', '=', ',', ...'abcdefghijklmnopqrstuvwxyz'.split('')];

    // 补全详情（CompletionItem.documentation）里显示图标：
    // data/minecraft_items/<物品ID>.png、data/minecraft_effects/<效果ID>.png
    extensionBaseUri = context.extensionUri.with({
        path: context.extensionUri.path.endsWith('/') ? context.extensionUri.path : context.extensionUri.path + '/'
    });
    loadImageMap(itemImageMap, path.join(context.extensionPath, 'data', 'minecraft_items'));
    loadImageMap(effectImageMap, path.join(context.extensionPath, 'data', 'minecraft_effects'));
    loadImageMap(effectAnimMap, path.join(context.extensionPath, 'data', 'minecraft_effects_anim'));
    loadImageMap(entityImageMap, path.join(context.extensionPath, 'data', 'minecraft_mob'));

    // 【新增】CA Reforged 语法检测器（移植自 ca/modules/CA.IntelliSense.js）
    const checker = new SyntaxChecker(mcData);

    // 【新增】实时语法诊断：对 .mcfunction 中每一行命令做语法检测，错误标红
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('mc-command-helper');

    function updateDiagnostics(document: vscode.TextDocument) {
        if (!targetLanguages.some((t) => t.language === document.languageId)) return;
        const diagnostics: vscode.Diagnostic[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();
            if (!text.startsWith('/')) continue;
            const result = checker.check(text);
            if (!result.ok) {
                for (const err of result.errors) {
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(i, 0, i, line.text.length),
                        err.message,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            }
        }
        diagnosticCollection.set(document.uri, diagnostics);
    }

    const diagDocListener = vscode.workspace.onDidChangeTextDocument((e) => updateDiagnostics(e.document));
    const diagOpenListener = vscode.workspace.onDidOpenTextDocument(updateDiagnostics);
    vscode.workspace.textDocuments.forEach(updateDiagnostics);
    context.subscriptions.push(diagnosticCollection, diagDocListener, diagOpenListener);

    const provider = vscode.languages.registerCompletionItemProvider(
        targetLanguages,
        {
            provideCompletionItems(document, position) {
                const lineText = document.lineAt(position).text.substring(0, position.character);
                if (!lineText.trim()) {
                    return [];
                }

                // ==========================================
                // 【新增】选择器变量本身补全：@ → @a/@e/@p/@r/@s/@n
                //   任何参数位置输入 @ 都弹出候选（剥离逻辑定位不到槽位时兜底）；
                //   输入完整 @a 时额外提供 "@a[...]" 开括号引导（对齐网页版 procSelector）。
                // ==========================================
                const selectorVarMatch = lineText.match(/@([a-zA-Z]*)$/);
                if (selectorVarMatch && !/\[[^\]]*$/.test(lineText)) {
                    const beforeAt = lineText.slice(0, selectorVarMatch.index ?? 0);
                    if (/\s/.test(beforeAt)) {
                        const typed = selectorVarMatch[1].toLowerCase();
                        const items: vscode.CompletionItem[] = [];
                        const vars = [
                            { v: '@a', d: '所有玩家' },
                            { v: '@p', d: '最近的玩家' },
                            { v: '@r', d: '随机玩家' },
                            { v: '@e', d: '所有实体' },
                            { v: '@s', d: '当前实体/命令执行者' },
                            { v: '@n', d: '最近的实体' },
                        ];
                        const replaceStart = selectorVarMatch.index ?? 0;
                        const replaceRange = new vscode.Range(position.line, replaceStart, position.line, position.character);
                        for (const { v, d } of vars) {
                            if (!v.toLowerCase().startsWith('@' + typed)) continue;
                            const item = new vscode.CompletionItem({ label: v, description: d }, vscode.CompletionItemKind.Variable);
                            item.range = replaceRange;
                            items.push(item);
                            if (typed.length >= 1 && v === '@' + typed) {
                                const openItem = new vscode.CompletionItem({ label: v + '[', description: d + '（插入过滤参数）' }, vscode.CompletionItemKind.Snippet);
                                openItem.range = replaceRange;
                                openItem.insertText = v + '[';
                                // 选中后立即触发补全，弹出选择器内部属性
                                openItem.command = { command: 'editor.action.triggerSuggest', title: '触发选择器内部补全' };
                                items.push(openItem);
                            }
                        }
                        return items;
                    }
                }

                // ==========================================
                // 【新增核心】选择器内部参数补全逻辑适配
                // ==========================================
                const selectorMatch = lineText.match(/@([a-zA-Z])\[([^\]]*)\]?$/);
                if (selectorMatch) {
                    try {
                    const selectorsConfig = mcData.selectors || mcData.enums?.selectors || {};
                    const innerText = selectorMatch[2]; // 中括号内部已输入的文本
                    let currentParams: any[] = [];
                    let activeFilterText = "";

                    // 辅助函数：根据字段配置提取对应的建议列表
                    const getSuggestionsByFieldConfig = (fieldConfig: any) => {
                        let results: any[] = [];
                        const listKey = fieldConfig.list || fieldConfig.suggestion || fieldConfig.enum;

                        if (listKey) {
                            if (mcData.enums && mcData.enums[listKey]) {
                                const enumData = mcData.enums[listKey];
                                if (!Array.isArray(enumData)) {
                                    results.push(...Object.entries(enumData).map(([k, v]) => ({ name: k, prompt: v, list: listKey })));
                                } else {
                                    results.push(...enumData.map((item: any) => typeof item === 'string' ? { name: item, prompt: "", list: listKey } : { ...item, name: item.text || item.name, prompt: item.desc || item.prompt, list: listKey }));
                                }
                            } else if (mcData.idlist) {
                                const target = mcData.idlist.find((i: any) => i.list === listKey);
                                if (target) {
                                    const data = target.data || target.list;
                                    if (Array.isArray(data)) {
                                        results.push(...data.map((item: any) => ({ name: item, prompt: "ID", list: listKey })));
                                    } else if (typeof data === 'object' && data !== null) {
                                        results.push(...Object.entries(data).map(([k, v]) => ({ name: k, prompt: v, list: listKey })));
                                    }
                                }
                            }
                        }
                        return results;
                    };

                    // 1. 检查是否处于嵌套对象内部（如 hasitem={...}）
                    const openBraceMatch = innerText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]+)\s*=\s*\{([^}]*)$/i);
                    if (openBraceMatch) {
                        const parentKey = openBraceMatch[1].toLowerCase();
                        const subInnerText = openBraceMatch[2];
                        const subParts = subInnerText.split(/[,{}]/);
                        activeFilterText = subParts[subParts.length - 1].trim().toLowerCase();

                        const parentConfig = selectorsConfig[parentKey];
                        if (parentConfig && parentConfig.fields) {
                            const activeFieldMatch = subInnerText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]+)\s*=\s*([^,]*)$/i);
                            if (activeFieldMatch) {
                                const currentFieldName = activeFieldMatch[1].toLowerCase();
                                const fieldConfig = parentConfig.fields[currentFieldName];
                                if (fieldConfig) {
                                    currentParams = getSuggestionsByFieldConfig(fieldConfig);
                                    activeFilterText = activeFieldMatch[2].trim().toLowerCase();
                                }
                            }
                            if (currentParams.length === 0) {
                                currentParams = Object.entries(parentConfig.fields).map(([fk, fv]: [string, any]) => ({
                                    name: `${fk}=`,
                                    prompt: fv.name || fk,
                                    type: 'plain'
                                }));
                            }
                        }
                    } else {
                        // 2. 处于第一层选择器参数（如输入了 type=, m= 等）
                        const activeParamMatch = innerText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]+)\s*=\s*([^,]*)$/i);
                        if (activeParamMatch) {
                            const currentKey = activeParamMatch[1].toLowerCase();
                            const currentVal = activeParamMatch[2].trim();
                            activeFilterText = currentVal.toLowerCase();
                            const paramConfig = selectorsConfig[currentKey];

                            if (paramConfig) {
                                currentParams = getSuggestionsByFieldConfig(paramConfig);
                                if (paramConfig.type === "bool") {
                                    currentParams = [{ name: "true", prompt: "真" }, { name: "false", prompt: "假" }];
                                }
                            }
                        }

                        // 如果还没有命中具体键值输入状态，返回全部一级选择器属性列表
                        if (currentParams.length === 0) {
                            currentParams = Object.entries(selectorsConfig).map(([k, v]: [string, any]) => {
                                let suffix = "=";
                                if ((Array.isArray(v.type) && v.type.includes("object")) || v.type === "object") {
                                    suffix = "={";
                                }
                                return {
                                    name: k + suffix,
                                    prompt: v.name || k,
                                    type: 'plain'
                                };
                            });
                            const subParts = innerText.split(/[,{}]/);
                            activeFilterText = subParts[subParts.length - 1].trim().toLowerCase();
                        }
                    }

                    const selectorDoc = `### 选择器参数引导\n\n当前正在编辑目标选择器 \`${selectorMatch[0]}\` 的过滤属性。`;
                    return getSuggestionsFromParams(currentParams, activeFilterText, mcData, { description: selectorDoc }, "selector");
                    } catch (e) {
                        // 兜底：任何异常都不让选择器补全消失，退回基础属性列表
                        const selectorsConfig = mcData.selectors || mcData.enums?.selectors || {};
                        return getSuggestionsFromParams(
                            Object.entries(selectorsConfig).map(([k, v]: [string, any]) => ({
                                name: k + '=',
                                prompt: v.name || k,
                                type: 'plain'
                            })),
                            selectorMatch[2].trim().toLowerCase(),
                            mcData,
                            {},
                            "selector"
                        );
                    }
                }
                // ==========================================

                const clean = lineText.trim().startsWith("/") ? lineText.trim().substring(1) : lineText.trim();
                const parts = clean.split(/\s+/);
                const inputCmd = parts[0].toLowerCase();
                const endsWithSpace = lineText.endsWith(" ");
                const currentArgText = endsWithSpace ? "" : parts[parts.length - 1].toLowerCase();
                stackedListPhase = false;
                stackedListOrder = undefined;

                if (parts.length === 1 && !endsWithSpace) {
                    stackedListPhase = true;
                    const completionItems: vscode.CompletionItem[] = [];
                    const startChar = lineText.startsWith("/") ? 1 : 0;
                    const replaceRange = new vscode.Range(
                        position.line,
                        startChar,
                        position.line,
                        position.character
                    );
                    // 与参数提示里的堆叠列表使用同一份筛选和顺序
                    const entries = getCommandNameMatches(inputCmd, mcData)
                        .map((m) => ({ ...m, syntax: buildCommandSyntaxSummary(m.name, mcData) }))
                        .filter((e) => !!e.syntax);

                    currentCommandMatches = entries.map(({ name, desc }) => ({ name, desc }));
                    // 只有输入内容变了才重置下标；同一行的重复查询（VS Code 会多次调用）保留上下键选中的位置
                    if (lastCompletionLine !== lineText) {
                        selectedSuggestionIndex = 0;
                        lastCompletionLine = lineText;
                    }

                    entries.forEach(({ name, desc }, index) => {
                        const item = new vscode.CompletionItem({
                            label: name,
                            description: desc
                        }, vscode.CompletionItemKind.Keyword);

                        item.range = replaceRange;
                        item.filterText = `${name} ${desc}`;
                        // 固定顺序，保证补全列表和参数提示里的语法行一一对应
                        item.sortText = String(index).padStart(4, '0');
                        // 默认选中第一项，避免 VS Code 按模糊分把列表滚到中间
                        item.preselect = index === 0;
                        completionItems.push(item);
                    });
                    return completionItems;
                }

                let cmdConfig = mcData.commands[inputCmd];
                if (cmdConfig && cmdConfig.alias) {
                    cmdConfig = mcData.commands[cmdConfig.alias];
                }
                if (!cmdConfig || !cmdConfig.patterns) {
                    return [];
                }

                // 子命令阶段（例如 /execute 空格）：把每个子命令的语法也做成堆叠列表
                const argParts = parts.slice(1).filter(Boolean);
                const subcommandPhase = (argParts.length === 0 && endsWithSpace) || (argParts.length === 1 && !endsWithSpace);
                if (subcommandPhase) {
                    const subEntries = getSubcommandEntries(inputCmd, cmdConfig, mcData, argParts[0] || '');
                    if (subEntries.length > 0) {
                        currentCommandMatches = subEntries.map(({ name, desc }) => ({ name, desc }));
                        if (lastCompletionLine !== lineText) {
                            selectedSuggestionIndex = 0;
                            lastCompletionLine = lineText;
                        }
                        stackedListPhase = true;
                        stackedListOrder = new Map(subEntries.map((e, i) => [e.name.toLowerCase(), i]));
                    }
                }

                const args = parts.slice(1);
                let patterns = cmdConfig.patterns || {};
                let patternKeys = Object.keys(patterns);

                let parsedArgs = [...args];
                let reachedCommandSlot = false;

                const runIndex = parsedArgs.findIndex(arg => arg.toLowerCase() === 'run');
                if (runIndex !== -1) {
                    reachedCommandSlot = true;
                    parsedArgs = parsedArgs.slice(runIndex + 1);

                    if (parsedArgs.length > 0) {
                        let rawNextCmd = parsedArgs[0];
                        if (rawNextCmd.startsWith('/')) {
                            rawNextCmd = rawNextCmd.substring(1);
                        }
                        const nextCmdName = rawNextCmd.toLowerCase();
                        if (mcData.commands[nextCmdName]) {
                            let nextCmdConfig = mcData.commands[nextCmdName];
                            if (nextCmdConfig && nextCmdConfig.alias) {
                                nextCmdConfig = mcData.commands[nextCmdConfig.alias];
                            }
                            patterns = nextCmdConfig.patterns || {};
                            patternKeys = Object.keys(patterns);
                            parsedArgs = parsedArgs.slice(1);
                        } else {
                            patterns = {};
                            patternKeys = [];
                        }
                    } else {
                        patterns = {};
                        patternKeys = [];
                    }
                } else {
                    let parsing = true;
                    while (parsing && parsedArgs.length > 0) {
                        parsing = false;
                        for (let key of patternKeys) {
                            const p = patterns[key];
                            let argIndex = 0;
                            let matched = true;

                            for (let i = 0; i < p.params.length; i++) {
                                const param = p.params[i];

                                if (param.type === "subcommand" || param.name === "子命令") {
                                    break;
                                }

                                if (argIndex >= parsedArgs.length) {
                                    matched = false;
                                    break;
                                }

                                let consumeCount = (param.type === "position") ? 3 : 1;

                                if (param.type === "plain") {
                                    const paramName = (param.name || param.prompt || "").toLowerCase();
                                    const argVal = parsedArgs[argIndex] ? parsedArgs[argIndex].toLowerCase() : "";
                                    if (paramName && paramName !== argVal) {
                                        if (!(argIndex === parsedArgs.length - 1 && !endsWithSpace && paramName.startsWith(argVal))) {
                                            matched = false;
                                            break;
                                        }
                                    }
                                } else if (param.type === "position") {
                                    // 位置参数默认占 3 位
                                } else {
                                    const listKey = param.list || param.enum || param.suggestion;
                                    if (listKey) {
                                        let validOptions: string[] = [];
                                        if (mcData.enums && mcData.enums[listKey]) {
                                            const enumData = mcData.enums[listKey];
                                            validOptions = Array.isArray(enumData)
                                                ? enumData.map((item: any) => typeof item === 'string' ? item : item.text)
                                                : Object.keys(enumData);
                                        } else if (mcData.idlist) {
                                            const target = mcData.idlist.find((item: any) => item.list === listKey);
                                            if (target) {
                                                const data = target.data || target.list;
                                                validOptions = Array.isArray(data) ? data : Object.keys(data);
                                            }
                                        }

                                        if (validOptions.length > 0) {
                                            const argVal = parsedArgs[argIndex].toLowerCase();
                                            const isMatched = validOptions.some((opt: any) => {
                                                const optStr = (typeof opt === 'string' ? opt : (opt && typeof opt === 'object' && 'text' in opt ? (opt as any).text : "")).toLowerCase();
                                                if (!(argIndex === parsedArgs.length - 1 && !endsWithSpace)) {
                                                    return optStr === argVal;
                                                } else {
                                                    return optStr.startsWith(argVal);
                                                }
                                            });
                                            if (!isMatched && !isValidNumberOrRange(parsedArgs[argIndex])) {
                                                matched = false;
                                                break;
                                            }
                                        }
                                    }
                                }
                                argIndex += consumeCount;
                            }

                            if (matched && argIndex > 0 && argIndex <= parsedArgs.length) {
                                if (!(argIndex === parsedArgs.length && !endsWithSpace)) {
                                    parsedArgs = parsedArgs.slice(argIndex);
                                    parsing = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                const workingArgs = parsedArgs;
                let possibleParamsAtCursor: any[] = [];

                if (reachedCommandSlot && patternKeys.length === 0) {
                    Object.keys(mcData.commands || {}).forEach((cmdName) => {
                        if (!possibleParamsAtCursor.some((x) => x.name === cmdName)) {
                            possibleParamsAtCursor.push({
                                type: "plain",
                                name: cmdName,
                                prompt: mcData.commands[cmdName].description || cmdName
                            });
                        }
                    });
                } else {
                    patternKeys.forEach((key) => {
                        const p = patterns[key];
                        const activeIdx = calculateActiveIndex(workingArgs, p.params, endsWithSpace, mcData);
                        if (activeIdx !== -1) {
                            const param = p.params[activeIdx];
                            if (param) {
                                if (param.type === "subcommand" || param.name === "子命令") {
                                    patternKeys.forEach((k) => {
                                        const firstParam = patterns[k].params[0];
                                        if (firstParam && firstParam.type === "plain") {
                                            if (!possibleParamsAtCursor.some((x) => x.name === firstParam.name)) {
                                                possibleParamsAtCursor.push(firstParam);
                                            }
                                        }
                                    });
                                } else if (param.type === "command") {
                                    Object.keys(mcData.commands || {}).forEach((cmdName) => {
                                        if (!possibleParamsAtCursor.some((x) => x.name === cmdName)) {
                                            possibleParamsAtCursor.push({
                                                type: "plain",
                                                name: cmdName,
                                                prompt: mcData.commands[cmdName].description || cmdName
                                            });
                                        }
                                    });
                                } else {
                                    if (!possibleParamsAtCursor.some((x) => x.name === param.name)) {
                                        possibleParamsAtCursor.push(param);
                                    }
                                }
                            }
                        }
                    });
                }
                const suggestions = getSuggestionsFromParams(possibleParamsAtCursor, currentArgText, mcData, cmdConfig, inputCmd);
                stackedListOrder = undefined;
                return suggestions;
            },
            resolveCompletionItem(item) {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                selectedCompletionLabel = label;
                if (stackedListPhase) {
                    // 补全列表焦点变化时刷新参数提示，让对应语法行高亮
                    vscode.commands.executeCommand('editor.action.triggerParameterHints');
                }
                return item;
            }
        },
        ...triggerCmds
    );

    // 【核心】注册参数提示（Signature Help）提供程序：
    // 显示完整语法链（含 execute ... run ... 的嵌套命令），并高亮当前参数
    const signatureProvider = vscode.languages.registerSignatureHelpProvider(
        targetLanguages,
        {
            provideSignatureHelp(document, position) {
                const lineText = document.lineAt(position).text.substring(0, position.character);
                const clean = lineText.trim().startsWith("/") ? lineText.trim().substring(1) : lineText.trim();
                const parts = clean.split(/\s+/).filter(Boolean);
                if (parts.length === 0) {
                    return undefined;
                }

                const endsWithSpace = lineText.endsWith(" ");

                // 命令名还没输完整（例如 /g）：把当前筛选剩下的命令语法堆叠显示出来
                const firstToken = parts[0];
                const firstLower = firstToken.toLowerCase();
                if (!resolveCommandConfig(firstLower, mcData)) {
                    const commandLike = lineText.trim().startsWith('/')
                        || document.languageId === 'bc-mcfunction'
                        || document.languageId === 'mcfunction';
                    if (!commandLike) {
                        return undefined;
                    }

                    const entries = getCommandNameMatches(firstLower, mcData)
                        .map((m) => ({ ...m, syntax: buildCommandSyntaxSummary(m.name, mcData) }))
                        .filter((e) => !!e.syntax);
                    if (entries.length === 0) {
                        return undefined;
                    }

                    const syntaxLines = entries.map((e) => e.syntax as string);
                    const label = syntaxLines.join('\n');

                    // 计算每一行在 label 中的 [start, end)
                    const lineOffsets: [number, number][] = [];
                    let pos = 0;
                    for (const line of syntaxLines) {
                        lineOffsets.push([pos, pos + line.length]);
                        pos += line.length + 1;
                    }

                    // 当前补全列表聚焦的命令；优先用下标（上下键同步），越界再按标签回退
                    let selectedIndex = selectedSuggestionIndex;
                    if (selectedIndex < 0 || selectedIndex >= entries.length) {
                        selectedIndex = selectedCompletionLabel
                            ? entries.findIndex((e) => e.name === selectedCompletionLabel)
                            : -1;
                    }
                    if (selectedIndex < 0) {
                        selectedIndex = 0;
                    }

                    // 直接放进签名行里，用换行堆叠；配合 CSS 的 white-space: pre-wrap
                    const listSignature = new vscode.SignatureInformation(label);
                    listSignature.parameters = [
                        new vscode.ParameterInformation(lineOffsets[selectedIndex])
                    ];

                    const listHelp = new vscode.SignatureHelp();
                    listHelp.signatures = [listSignature];
                    listHelp.activeSignature = 0;
                    listHelp.activeParameter = 0;
                    return listHelp;
                }

                // 子命令阶段（例如 /execute 空格）：显示每个子命令的语法
                const exactConfig = resolveCommandConfig(firstLower, mcData);
                const argParts = parts.slice(1);
                const subcommandPhase = (argParts.length === 0 && endsWithSpace) || (argParts.length === 1 && !endsWithSpace);
                if (exactConfig && subcommandPhase) {
                    const subEntries = getSubcommandEntries(firstLower, exactConfig, mcData, argParts[0] || '');
                    if (subEntries.length > 0) {
                        const label = subEntries.map((e) => e.syntax).join('\n');
                        const lineOffsets: [number, number][] = [];
                        let pos = 0;
                        for (const e of subEntries) {
                            lineOffsets.push([pos, pos + e.syntax.length]);
                            pos += e.syntax.length + 1;
                        }
                        let idx = selectedSuggestionIndex;
                        if (idx < 0 || idx >= subEntries.length) {
                            idx = 0;
                        }
                        const subSignature = new vscode.SignatureInformation(label);
                        subSignature.parameters = [
                            new vscode.ParameterInformation(lineOffsets[idx])
                        ];
                        const subHelp = new vscode.SignatureHelp();
                        subHelp.signatures = [subSignature];
                        subHelp.activeSignature = 0;
                        subHelp.activeParameter = 0;
                        return subHelp;
                    }
                }

                const chain = buildSignatureChain(parts, mcData, endsWithSpace);
                if (!chain || chain.activeParams.length === 0) {
                    return undefined;
                }

                const signatureInfo = new vscode.SignatureInformation(
                    chain.label,
                    new vscode.MarkdownString(chain.activeConfig?.description || '')
                );

                signatureInfo.parameters = chain.activeParams.map((pt: any, i: number) => {
                    const offset = chain.paramOffsets[i];
                    return new vscode.ParameterInformation(
                        offset ?? `<${pt.name || pt.prompt || 'param'}>`,
                        new vscode.MarkdownString(pt.prompt || '参数说明')
                    );
                });

                const sigHelp = new vscode.SignatureHelp();
                sigHelp.signatures = [signatureInfo];
                sigHelp.activeSignature = 0;
                sigHelp.activeParameter = chain.activeParamIndex;
                return sigHelp;
            }
        },
        ' ', '=', ',', '[', '{', ...'abcdefghijklmnopqrstuvwxyz'.split('')
    );

    // 覆盖补全列表里的上下键：移动后同步语法高亮（包括回到上一个预选）
    const nextSuggestionCommand = vscode.commands.registerCommand('mc-command-helper.nextSuggestion', async () => {
        await vscode.commands.executeCommand('selectNextSuggestion');
        if (stackedListPhase && currentCommandMatches.length > 0) {
            selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentCommandMatches.length;
            await vscode.commands.executeCommand('editor.action.triggerParameterHints');
        }
    });
    const prevSuggestionCommand = vscode.commands.registerCommand('mc-command-helper.prevSuggestion', async () => {
        await vscode.commands.executeCommand('selectPrevSuggestion');
        if (stackedListPhase && currentCommandMatches.length > 0) {
            selectedSuggestionIndex = (selectedSuggestionIndex - 1 + currentCommandMatches.length) % currentCommandMatches.length;
            await vscode.commands.executeCommand('editor.action.triggerParameterHints');
        }
    });
    context.subscriptions.push(nextSuggestionCommand, prevSuggestionCommand);
}
// 模拟 VS Code 的 matchOnWordStartOnly：前缀必须落在某个“单词开头”
function wordMatchesPrefix(word: string, prefix: string): boolean {
    const w = word.toLowerCase();
    const p = prefix.toLowerCase();
    if (!w || !p || w[0] !== p[0]) {
        return false;
    }
    // 首字符必须在单词开头，后续字符按模糊子序列匹配
    let wi = 1;
    for (let pi = 1; pi < p.length; pi++) {
        wi = w.indexOf(p[pi], wi);
        if (wi < 0) {
            return false;
        }
        wi++;
    }
    return true;
}

function latinWords(text: string): string[] {
    return text.match(/[A-Za-z][A-Za-z0-9]*/g) || [];
}

// 0: 命令名以前缀开头；1: 命令名其他单词；2: 描述里的单词；-1: 不匹配
function commandMatchRank(name: string, desc: string, prefix: string): number {
    const p = prefix.toLowerCase();
    if (!p) {
        return 0;
    }
    // 中文等非 ASCII 前缀：退化为包含匹配
    if (/[^\x00-\x7F]/.test(prefix)) {
        return `${name} ${desc}`.includes(prefix) ? 0 : -1;
    }

    if (name.toLowerCase().startsWith(p)) {
        return 0;
    }
    if (latinWords(name).some((w) => wordMatchesPrefix(w, p))) {
        return 1;
    }

    const descWords = latinWords(desc);
    if (descWords.some((w) => wordMatchesPrefix(w, p))) {
        return 2;
    }
    // 跨 camelCase 边界：GameTest 连起来也要能匹配 gt
    if (descWords.length > 1 && wordMatchesPrefix(descWords.join(''), p)) {
        return 2;
    }
    return -1;
}

// 命令名还没输完整时，筛选出与补全列表一致的命令（单词开头匹配 + 固定顺序）
function getCommandNameMatches(prefix: string, mcData: any): { name: string; desc: string }[] {
    const entries: { name: string; desc: string; rank: number }[] = [];
    for (const name of Object.keys(mcData.commands || {})) {
        const desc = (mcData.commands[name] && mcData.commands[name].description) || '';
        const rank = commandMatchRank(name, desc, prefix);
        if (rank >= 0) {
            entries.push({ name, desc, rank });
        }
    }
    entries.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return entries.map(({ name, desc }) => ({ name, desc }));
}

// 命令名还没输完整时，为每个匹配命令挑一个最有代表性的 pattern 生成一行语法
function buildCommandSyntaxSummary(cmdName: string, mcData: any): string | undefined {
    const config = resolveCommandConfig(cmdName, mcData);
    if (!config || !config.patterns) {
        return undefined;
    }
    const keys = Object.keys(config.patterns);
    if (keys.length === 0) {
        return undefined;
    }

    // 选参数最多的 pattern 作为代表（并列时取第一个）
    let bestKey = keys[0];
    let bestLen = -1;
    for (const key of keys) {
        const params = config.patterns[key].params || [];
        if (params.length > bestLen) {
            bestLen = params.length;
            bestKey = key;
        }
    }

    const tokens: string[] = [cmdName];
    appendParamTokens(tokens, config.patterns[bestKey].params || [], false);
    return '/' + tokens.join(' ');
}

interface SubcommandEntry {
    name: string;
    desc: string;
    syntax: string;
}

function enumNames(list: any, mcData: any): string[] {
    if (!list) {
        return [];
    }
    if (typeof list === 'string') {
        const data = mcData.enums && mcData.enums[list];
        if (data) {
            if (Array.isArray(data)) {
                return data.map((v: any) => String(typeof v === 'string' ? v : (v.text || v.name || v.id))).filter(Boolean);
            }
            if (typeof data === 'object') {
                return Object.keys(data);
            }
        }
        return [];
    }
    if (typeof list === 'object') {
        return Object.keys(list);
    }
    return [];
}

function buildPatternSyntaxLine(cmdName: string, params: any[], subcommandName: string): string {
    const tokens: string[] = [cmdName, subcommandName];
    appendParamTokens(tokens, params.slice(1), false);
    return '/' + tokens.join(' ');
}

// 带子命令槽位的命令（如 execute）：每个子命令生成一行语法
function getSubcommandEntries(cmdName: string, cmdConfig: any, mcData: any, typedPrefix: string): SubcommandEntry[] {
    const patterns = (cmdConfig && cmdConfig.patterns) || {};
    const keys = Object.keys(patterns);
    const isSubcommandStyle = keys.some((key) => {
        const params = patterns[key].params || [];
        return params.some((p: any) => p.type === 'subcommand' || p.name === '子命令');
    });
    if (!isSubcommandStyle) {
        return [];
    }

    const prefix = (typedPrefix || '').toLowerCase();
    const entries: SubcommandEntry[] = [];
    const seen = new Set<string>();

    for (const key of keys) {
        const params = patterns[key].params || [];
        const first = params[0];
        if (!first) {
            continue;
        }

        let names: string[] = [];
        if (first.type === 'plain') {
            const n = first.name || first.prompt || '';
            if (n) {
                names = [n];
            }
        } else if (first.type === 'enum' || first.list) {
            names = enumNames(first.list, mcData);
        }
        if (names.length === 0) {
            continue;
        }

        for (const raw of names) {
            const name = String(raw).toLowerCase();
            if (!name || seen.has(name)) {
                continue;
            }
            if (prefix && !name.startsWith(prefix)) {
                continue;
            }
            seen.add(name);
            entries.push({
                name,
                desc: first.prompt || first.name || name,
                syntax: buildPatternSyntaxLine(cmdName, params, name),
            });
        }
    }

    return entries;
}

// 解析命令配置（支持 alias）
function resolveCommandConfig(name: string, mcData: any): any {
    let config = mcData.commands ? mcData.commands[name] : undefined;
    if (config && config.alias) {
        config = mcData.commands[config.alias];
    }
    return config;
}

// 把一组参数追加成语法 token，返回每个参数对应的 token 下标（-1 表示不显示）
function appendParamTokens(
    tokens: string[],
    params: any[],
    skipCommandParam: boolean,
    remainingLength?: number,
    consumed?: number
): number[] {
    const indices: number[] = [];
    for (const param of params) {
        const pName = param.name || param.prompt || 'arg';
        const isSub = param.type === 'subcommand' || param.name === '子命令';
        const isPlain = param.type === 'plain';

        // run 后面会展开成具体命令，不再显示通用的 <命令>
        if (skipCommandParam && (param.type === 'command' || param.name === '命令')) {
            indices.push(-1);
            continue;
        }
        // 已经输入了子命令时，让下一轮显示实际的子命令，不在这里补“子命令”占位
        if (isSub && remainingLength !== undefined && consumed !== undefined && remainingLength > consumed) {
            indices.push(-1);
            continue;
        }

        let text: string;
        if (isSub || isPlain) {
            text = pName;
        } else if (param.type === 'position') {
            text = '~ ~ ~';
        } else {
            text = `<${pName}>`;
        }
        indices.push(tokens.length);
        tokens.push(text);
    }
    return indices;
}

// 在命令的多个 pattern 中挑出与当前输入最匹配的一个
function pickBestPattern(patterns: any, remaining: string[]): { params: any[]; consumed: number } | undefined {
    let bestParams: any[] | undefined;
    let bestConsumed = 0;
    let bestScore = -1;

    for (const key of Object.keys(patterns)) {
        const p = patterns[key];
        let score = 0;
        let argIdx = 0;
        let consumed = 0;
        let valid = true;

        for (const param of p.params) {
            if (argIdx >= remaining.length) {
                break;
            }
            const userVal = remaining[argIdx].toLowerCase();
            const pName = (param.name || param.prompt || '').toLowerCase();
            const isSub = param.type === 'subcommand' || param.name === '子命令';
            const isPlain = param.type === 'plain';

            if (isSub) {
                // 子命令槽位本身不消耗输入，真正的子命令由下一轮匹配
                score += 1;
                continue;
            }
            if (isPlain) {
                if (pName === userVal || pName.startsWith(userVal)) {
                    // 精确匹配优先，前缀匹配次之，避免被前面的泛型参数抢走
                    score += (pName === userVal ? 3 : 2);
                    argIdx++;
                    consumed++;
                } else {
                    valid = false;
                    break;
                }
            } else {
                score += 1;
                const step = param.type === 'position' ? 3 : 1;
                argIdx += step;
                consumed += step;
            }
        }

        if (valid && score > bestScore) {
            bestScore = score;
            bestParams = p.params;
            bestConsumed = consumed;
        }
    }

    if (!bestParams || bestConsumed <= 0) {
        return undefined;
    }
    return { params: bestParams, consumed: bestConsumed };
}

interface SignatureChainSegment {
    config: any;
    params: any[];
    args: string[];
    paramTokenIndices: number[];
}

interface SignatureChain {
    label: string;
    activeConfig: any;
    activeParams: any[];
    activeParamIndex: number;
    paramOffsets: ([number, number] | undefined)[];
}

// 构造参数提示里显示的完整语法链：
// /execute as <目标> at <目标> run give <玩家> <物品名称> ...
function buildSignatureChain(parts: string[], mcData: any, endsWithSpace: boolean): SignatureChain | undefined {
    const rootName = (parts[0] || '').toLowerCase();
    let config = resolveCommandConfig(rootName, mcData);
    if (!config || !config.patterns) {
        return undefined;
    }

    const tokens: string[] = [rootName];
    const segments: SignatureChainSegment[] = [];
    let remaining = parts.slice(1);
    let safety = 0;

    while (config && config.patterns && safety < 12) {
        safety++;

        // 没有更多输入：显示第一个 pattern 的完整参数结构
        if (remaining.length === 0) {
            const firstKey = Object.keys(config.patterns)[0];
            if (!firstKey) {
                break;
            }
            const params = config.patterns[firstKey].params;
            const paramTokenIndices = appendParamTokens(tokens, params, false);
            segments.push({ config, params, args: [], paramTokenIndices });
            break;
        }

        const best = pickBestPattern(config.patterns, remaining);
        if (!best) {
            tokens.push(...remaining);
            break;
        }

        const { params, consumed } = best;

        // 检测 run，并把 run 后面的命令切换成对应命令的签名
        const runParamIdx = params.findIndex(
            (p: any) => p.type === 'plain' && (p.name || p.prompt || '').toLowerCase() === 'run'
        );
        const runArgIdx = runParamIdx >= 0
            ? remaining.findIndex((a) => a.toLowerCase() === 'run')
            : -1;

        let nextName: string | undefined;
        let nextConfig: any;
        if (runArgIdx >= 0 && runArgIdx + 1 < remaining.length) {
            nextName = remaining[runArgIdx + 1].toLowerCase();
            nextConfig = resolveCommandConfig(nextName, mcData);
        }
        const expandRun = !!nextConfig;

        const paramTokenIndices = appendParamTokens(
            tokens,
            params,
            expandRun,
            remaining.length,
            consumed
        );

        // 展开 run 时，这一层的输入只到 run 为止；后面的属于嵌套命令
        const segmentArgs = expandRun ? remaining.slice(0, runArgIdx + 1) : remaining.slice();
        segments.push({ config, params, args: segmentArgs, paramTokenIndices });

        if (expandRun) {
            tokens.push(nextName!);
            remaining = remaining.slice(runArgIdx + 2);
            config = nextConfig;
            continue;
        }

        remaining = remaining.slice(consumed);
        if (remaining.length === 0) {
            break;
        }

        // 只有带子命令槽位的 pattern（如 execute as/at）才继续匹配下一段
        const hasSubcommand = params.some(
            (p: any) => p.type === 'subcommand' || p.name === '子命令'
        );
        if (!hasSubcommand) {
            tokens.push(...remaining);
            break;
        }
    }

    if (segments.length === 0) {
        return undefined;
    }

    const active = segments[segments.length - 1];
    let activeParamIndex = calculateActiveIndex(active.args, active.params, endsWithSpace, mcData);
    if (activeParamIndex < 0 || activeParamIndex >= active.params.length) {
        activeParamIndex = 0;
    }

    const label = '/' + tokens.join(' ');

    // 计算每个 token 在 label 里的 [start, end)，用于精确高亮当前参数
    const tokenOffsets: [number, number][] = [];
    let pos = 1; // 跳过开头的 '/'
    for (const token of tokens) {
        tokenOffsets.push([pos, pos + token.length]);
        pos += token.length + 1; // 空格
    }

    const paramOffsets = active.paramTokenIndices.map((idx) =>
        idx >= 0 ? tokenOffsets[idx] : undefined
    );

    return {
        label,
        activeConfig: active.config,
        activeParams: active.params,
        activeParamIndex,
        paramOffsets,
    };
}

function isValidNumberOrRange(str: string): boolean {
    return /^([+-]?\d*(\.\d+)?(\.\.[+-]?\d*(\.\d+)?)?|\.\.[+-]?\d*(\.\d+)?)$/.test(str);
}

function calculateActiveIndex(args: string[], params: any[], endsWithSpace: boolean, mcData: any): number {
    let argPtr = 0;

    for (let i = 0; i < params.length; i++) {
        const paramConfig = params[i];
        if (argPtr >= args.length) return i;

        if (paramConfig.type === "subcommand" || paramConfig.name === "子命令") {
            return i;
        }

        const currentArg = args[argPtr];
        const listKey = paramConfig.list || paramConfig.enum || paramConfig.suggestion;

        if (listKey && currentArg !== "") {
            let validOptions: string[] = [];
            if (mcData.enums && mcData.enums[listKey]) {
                const enumData = mcData.enums[listKey];
                validOptions = Array.isArray(enumData)
                    ? enumData.map((item: any) => typeof item === 'string' ? item : item.text)
                    : Object.keys(enumData);
            } else if (mcData.idlist) {
                const target = mcData.idlist.find((item: any) => item.list === listKey);
                if (target) {
                    const data = target.data || target.list;
                    validOptions = Array.isArray(data) ? data : Object.keys(data);
                }
            }

            if (validOptions.length > 0) {
                const argVal = currentArg.toLowerCase();
                const isMatched = validOptions.some((opt: any) => {
                    const optStr = (typeof opt === 'string' ? opt : (opt && typeof opt === 'object' && 'text' in opt ? (opt as any).text : "")).toLowerCase();
                    if (!endsWithSpace && argPtr === args.length - 1) {
                        return optStr.startsWith(argVal);
                    } else {
                        return optStr === argVal;
                    }
                });
                if (!isMatched && !isValidNumberOrRange(currentArg)) return -1;
            }
        }

        if (paramConfig.type === "position") {
            const remainingArgs = args.length - argPtr;
            if (remainingArgs < 3 || (remainingArgs === 3 && !endsWithSpace)) {
                const currentChunk = args[argPtr];
                if (currentChunk !== "" && !/^[~^0-9.-]/.test(currentChunk)) return -1;
                return i;
            }
            argPtr += 3;
        } else {
            if (currentArg !== "") {
                if (paramConfig.type === "plain") {
                    const argValue = currentArg.toLowerCase();
                    const paramValue = (paramConfig.name || paramConfig.prompt || "").toLowerCase();
                    if (!endsWithSpace && argPtr === args.length - 1) {
                        if (!paramValue.startsWith(argValue)) return -1;
                    } else {
                        if (argValue !== paramValue) return -1;
                    }
                }
            }
            argPtr += 1;
            if (!endsWithSpace && argPtr >= args.length) return i;
        }
    }
    return -1;
}

function getSuggestionsFromParams(params: any[], filterText: string, mcData: any, cmdConfig: any, inputCmd: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    params.forEach(param => {
        const listKey = param.list || param.enum || param.suggestion;
        
        // 尝试推断当前参数的后续语法，以显示在预选区详情中
        let syntaxHint = "";
        if (param.type === "subcommand" || param.type === "plain") {
            // 从当前命令配置中寻找包含该子命令的模式，提取它的后续参数占位符
            if (cmdConfig && cmdConfig.patterns) {
                for (let key in cmdConfig.patterns) {
                    const p = cmdConfig.patterns[key];
                    if (p.params && p.params.length > 0 && 
                       (p.params[0].name === param.name || p.params[0].prompt === param.name)) {
                        syntaxHint = p.params.slice(1).map((pt: any) => 
                            pt.type === 'position' ? '~ ~ ~' : `<${pt.name || pt.prompt || 'arg'}>`
                        ).join(' ');
                        break;
                    }
                }
            }
        }

        if (listKey && mcData.enums && mcData.enums[listKey]) {
            let enumData: any = mcData.enums[listKey];
            if (!Array.isArray(enumData)) {
                Object.entries(enumData).forEach(([k, v]) => {
                    parseAndAddItem(items, k, v, vscode.CompletionItemKind.EnumMember, syntaxHint, listKey);
                });
            } else {
                enumData.forEach((item: any) => {
                    if (typeof item === 'string') {
                        parseAndAddItem(items, item, "枚举", vscode.CompletionItemKind.EnumMember, syntaxHint, listKey);
                    } else {
                        const text = item.text || item.name || item.id;
                        const desc = item.desc || item.description || item.prompt || item.title || "枚举";
                        parseAndAddItem(items, text, desc, vscode.CompletionItemKind.EnumMember, syntaxHint, listKey);
                    }
                });
            }
        }
        else if (listKey && mcData.idlist) {
            const target = mcData.idlist.find((i: any) => i.list === listKey);
            if (target) {
                const data = target.data || target.list;
                if (Array.isArray(data)) {
                    data.forEach((item: any) => {
                        if (typeof item === 'string') {
                            parseAndAddItem(items, item, `${listKey} ID`, vscode.CompletionItemKind.Value, syntaxHint, listKey);
                        } else {
                            const text = item.text || item.name || item.id;
                            const desc = item.desc || item.description || item.title || `${listKey} ID`;
                            parseAndAddItem(items, text, desc, vscode.CompletionItemKind.Value, syntaxHint, listKey);
                        }
                    });
                } else if (typeof data === 'object' && data !== null) {
                    Object.entries(data).forEach(([k, v]) => {
                        parseAndAddItem(items, k, v, vscode.CompletionItemKind.Value, syntaxHint, listKey);
                    });
                }
            }
        }
        else {
            if (param.type === "plain") {
                parseAndAddItem(items, param.name, param.prompt || "关键字", vscode.CompletionItemKind.Keyword, syntaxHint);
            } else if (param.type === "selector") {
                parseAndAddItem(items, "@a", "所有玩家", vscode.CompletionItemKind.Variable, syntaxHint);
                parseAndAddItem(items, "@e", "所有实体", vscode.CompletionItemKind.Variable, syntaxHint);
                parseAndAddItem(items, "@p", "最近的玩家", vscode.CompletionItemKind.Variable, syntaxHint);
                parseAndAddItem(items, "@r", "随机玩家", vscode.CompletionItemKind.Variable, syntaxHint);
                parseAndAddItem(items, "@s", "当前实体", vscode.CompletionItemKind.Variable, syntaxHint);
                parseAndAddItem(items, "@n", "最近的实体", vscode.CompletionItemKind.Variable, syntaxHint);
            } else if (param.type === "position") {
                parseAndAddItem(items, "~ ~ ~", "当前相对坐标", vscode.CompletionItemKind.Snippet, syntaxHint);
            }
        }
    });

    const normalizedFilter = filterText.trim().toLowerCase();
    return items.filter(item => {
        if (!normalizedFilter) return true;
        const label = (typeof item.label === 'string' ? item.label : item.label.label).toLowerCase();
        const detail = (item.detail || "").toLowerCase();
        return label.includes(normalizedFilter) || detail.includes(normalizedFilter);
    });
}

function parseAndAddItem(items: vscode.CompletionItem[], rawLabel: string, rawDesc: any, kind: vscode.CompletionItemKind, syntaxHint: string = "", listKey?: string) {
    if (!rawLabel) return;

    let descString = "";
    if (typeof rawDesc === 'string') {
        descString = rawDesc;
    } else if (typeof rawDesc === 'object' && rawDesc !== null) {
        descString = rawDesc.desc || rawDesc.description || rawDesc.title || rawDesc.name || "";
    }

    const cleanLabel = rawLabel.includes(':') ? rawLabel.split(':')[1] : rawLabel;
    addItemUnique(items, cleanLabel, descString, kind, syntaxHint, listKey);

    if (rawLabel.includes(':')) {
        addItemUnique(items, rawLabel, descString, kind, syntaxHint, listKey);
    }
}

function addItemUnique(items: vscode.CompletionItem[], label: string, desc: string, kind: vscode.CompletionItemKind, syntaxHint: string = "", listKey?: string) {
    if (items.some(i => (typeof i.label === 'string' ? i.label : i.label.label) === label)) return;

    const item = new vscode.CompletionItem({
        label: label,
        description: desc || ""
    }, kind);

    // 物品 / 状态效果 / 实体：在补全详情面板里显示对应图标
    const lookupLabel = label.includes(':') ? label.split(':')[1] : label;
    let imageFile: string | undefined;
    let imageDir: string | undefined;
    let imageWidth = 64;
    if (listKey === 'item') {
        imageFile = resolveItemImage(lookupLabel);
        imageDir = 'minecraft_items';
    } else if (listKey === 'effect') {
        // 优先使用带粒子动画的 APNG（data/minecraft_effects_anim）
        const anim = effectAnimMap.get(lookupLabel.toLowerCase());
        if (anim) {
            imageFile = anim;
            imageDir = 'minecraft_effects_anim';
            imageWidth = 120;
        } else {
            imageFile = effectImageMap.get(lookupLabel.toLowerCase());
            imageDir = 'minecraft_effects';
        }
    } else if (listKey === 'entity') {
        imageFile = entityImageMap.get(lookupLabel.toLowerCase());
        imageDir = 'minecraft_mob';
    }

    // 不设置 detail：列表行右侧已经显示中文名；
    // 详情面板只在有图片或后续语法文档时出现，没有补充内容时 VS Code 会自动关闭它

    // 如果有语法提示，也可以在侧边轻量级 markdown 面板展示
    if (syntaxHint) {
        item.documentation = new vscode.MarkdownString(`**后续语法**\n\`${label} ${syntaxHint}\`\n\n_${desc}_`);
    }

    if (imageFile && imageDir) {
        const cacheKey = `${listKey}|${label}`;
        let doc = itemDocCache.get(cacheKey);
        if (!doc) {
            doc = new vscode.MarkdownString(
                `${desc ? `**${desc}**\n\n` : ''}\`${label}\`\n\n![${label}](data/${imageDir}/${imageFile}|width=${imageWidth})`
            );
            if (extensionBaseUri) {
                doc.baseUri = extensionBaseUri;
            }
            itemDocCache.set(cacheKey, doc);
        }
        item.documentation = doc;
    }

    // 子命令阶段：固定顺序，和参数提示里的语法行一一对应
    if (stackedListOrder) {
        const order = stackedListOrder.get(label.toLowerCase());
        if (order !== undefined) {
            item.sortText = String(order).padStart(4, '0');
            item.preselect = order === 0;
        }
    }

    items.push(item);
}

// 图标文件索引：<ID> -> data/... 下的实际文件名
let extensionBaseUri: vscode.Uri | undefined;
const itemImageMap = new Map<string, string>();
const effectImageMap = new Map<string, string>();
const effectAnimMap = new Map<string, string>();
const entityImageMap = new Map<string, string>();
const itemDocCache = new Map<string, vscode.MarkdownString>();

function loadImageMap(map: Map<string, string>, dir: string): void {
    try {
        for (const file of fs.readdirSync(dir)) {
            const match = /^(.+)\.(png|gif)$/i.exec(file);
            if (!match) continue;
            const key = match[1].toLowerCase();
            // 同一 ID 同时有 png 和 gif 时优先 png
            if (!map.has(key) || /\.png$/i.test(file)) {
                map.set(key, file);
            }
        }
    } catch {
        // 没有图片目录时不影响补全
    }
}

// 当前是否处于“命令名补全”阶段，以及补全列表里当前聚焦的命令名
let stackedListPhase = false;
let stackedListOrder: Map<string, number> | undefined;
let selectedCompletionLabel: string | undefined;
// 命令名补全列表（顺序与补全项一致）和当前高亮下标
let currentCommandMatches: { name: string; desc: string }[] = [];
let selectedSuggestionIndex = 0;
let lastCompletionLine: string | undefined;

// 少数基岩版物品 ID 与图片文件名的对应关系（图片按 Java 版命名）
const itemImageAliases: { [id: string]: string } = {
    grass_block: 'grass',
    hardened_clay: 'terracotta',
    magma: 'magma_block',
    end_bricks: 'end_stone_bricks',
    lit_pumpkin: 'pumpkin',
};

function resolveItemImage(id: string): string | undefined {
    const key = id.toLowerCase();

    let file = itemImageMap.get(key);
    if (file) return file;

    // *_chest_boat / *_chest_raft -> *_boat_with_chest / *_raft_with_chest
    const chestBoat = /^(.*)_chest_boat$/.exec(key);
    if (chestBoat) {
        file = itemImageMap.get(`${chestBoat[1]}_boat_with_chest`);
        if (file) return file;
    }
    const chestRaft = /^(.*)_chest_raft$/.exec(key);
    if (chestRaft) {
        file = itemImageMap.get(`${chestRaft[1]}_raft_with_chest`);
        if (file) return file;
    }

    const alias = itemImageAliases[key];
    if (alias) {
        return itemImageMap.get(alias);
    }
    return undefined;
}

export function deactivate() { }