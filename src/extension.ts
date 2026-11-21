import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SyntaxChecker } from './syntax-check';
import { rankMatches } from './fuzzy';

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

    const triggerCmds = ['/', ' ', '@', '[', ']', '=', ',', '{', '}', '"', ':', ...'abcdefghijklmnopqrstuvwxyz'.split('')];

    // 临时诊断：记录补全导航/预览相关状态到临时文件，方便定位 preview 不显示的问题
    const diagLogPath = path.join(os.tmpdir(), 'mc-preview-diag.log');
    const diagLog = (event: string, extra: any = {}) => {
        try {
            const editor = vscode.window.activeTextEditor;
            const cfg = vscode.workspace.getConfiguration('editor');
            const pos = editor ? editor.selection.active : undefined;
            const lineText = editor && pos ? editor.document.lineAt(pos.line).text : '';
            const record = {
                time: new Date().toISOString(),
                event,
                uri: editor ? editor.document.uri.toString() : undefined,
                language: editor ? editor.document.languageId : undefined,
                lineText,
                cursor: pos ? [pos.line, pos.character] : undefined,
                selection: editor ? [editor.selection.start.line, editor.selection.start.character, editor.selection.end.line, editor.selection.end.character] : undefined,
                suggestPreview: cfg.get('suggest.preview'),
                inlineSuggest: cfg.get('inlineSuggest.enabled'),
                inlineSuppress: cfg.get('inlineSuggest.suppressSuggestions'),
                selectedCompletionLabel,
                stackedListPhase,
                matches: currentCommandMatches.length,
                selectedSuggestionIndex,
                ...extra
            };
            fs.appendFileSync(diagLogPath, JSON.stringify(record) + '\n');
        } catch {
            // 诊断失败不影响补全
        }
    };
    try {
        fs.writeFileSync(diagLogPath, '');
    } catch {
        // 忽略
    }

    const SYNTAX_VISIBLE = 5;

    // 自绘补全预览：VS Code 自带的 suggest.preview 在部分被修改过的安装里不渲染，
    // 这里用编辑器 decoration 在光标后显示候选词的剩余部分，不写入文档。
    let previewType: vscode.TextEditorDecorationType | undefined;
    let previewPrefixType: vscode.TextEditorDecorationType | undefined;
    let previewEditor: vscode.TextEditor | undefined;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPreview = () => {
        if (previewTimer) {
            clearTimeout(previewTimer);
            previewTimer = undefined;
        }
        for (const type of [previewType, previewPrefixType]) {
            if (previewEditor && type) {
                try {
                    previewEditor.setDecorations(type, []);
                } catch {
                    // 编辑器可能已关闭
                }
            }
            type?.dispose();
        }
        previewType = undefined;
        previewPrefixType = undefined;
        previewEditor = undefined;
    };
    // 未按 Tab 前用灰色提示“这是当前候选”；按过 Tab 后变成蓝色
    const showPreviewParts = (prefix: string, suffix: string) => {
        clearPreview();
        if (!prefix && !suffix) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const pos = editor.selection.active;
        const side = vscode.workspace.getConfiguration('mc-command-helper').get<string>('previewSide', 'right');
        const color = previewArmed ? '#7fd1ff' : '#9aa0a6';
        const style = { color, fontStyle: 'italic' };
        previewEditor = editor;
        // 输入在候选中间/结尾时：把缺少的前缀画在当前词前面，
        // 再把剩余后缀画在光标后，视觉上拼成完整候选。
        if (prefix) {
            previewPrefixType = vscode.window.createTextEditorDecorationType({
                before: { contentText: prefix, ...style },
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
            });
            const word = currentPreviewWord() || '';
            const start = Math.max(0, pos.character - word.length);
            editor.setDecorations(previewPrefixType, [{ range: new vscode.Range(pos.line, start, pos.line, start) }]);
        }
        if (suffix) {
            const attachment = { contentText: suffix, ...style };
            previewType = vscode.window.createTextEditorDecorationType({
                // left: 预览在光标左侧（光标在预览右边）；right: 预览在光标右侧
                ...(side === 'left' ? { before: attachment } : { after: attachment }),
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
            });
            editor.setDecorations(previewType, [{ range: new vscode.Range(pos, pos) }]);
        }
        diagLog('preview', { text: `${prefix}${suffix}`, prefix, suffix, armed: previewArmed });
        previewTimer = setTimeout(clearPreview, 30000);
    };
    const showPreviewText = (text: string) => showPreviewParts('', text);
    // 根据当前输入词和完整候选计算预览：
    // - 候选以输入开头：只显示剩余后缀
    // - 输入在候选中间/结尾：显示缺少的前缀 + 剩余后缀
    // - 模糊匹配（不连续）：显示完整候选提示
    const showPreviewCandidate = (fullText: string) => {
        if (!fullText) {
            clearPreview();
            return;
        }
        const word = currentPreviewWord();
        if (word === undefined) {
            clearPreview();
            return;
        }
        const lowerWord = word.toLowerCase();
        if (!lowerWord) {
            showPreviewParts('', fullText);
            return;
        }
        const lowerFull = fullText.toLowerCase();
        if (lowerFull.startsWith(lowerWord)) {
            showPreviewParts('', fullText.slice(word.length));
            return;
        }
        const index = lowerFull.indexOf(lowerWord);
        if (index >= 0) {
            showPreviewParts(fullText.slice(0, index), fullText.slice(index + word.length));
            return;
        }
        showPreviewParts('', ` → ${fullText}`);
    };
    const previewSuffixForText = (text: string): string => {
        if (!text) return '';
        const editor = vscode.window.activeTextEditor;
        if (!editor) return '';
        const pos = editor.selection.active;
        const line = editor.document.lineAt(pos.line).text.slice(0, pos.character);
        const tokenMatch = line.match(/\S*$/);
        const token = tokenMatch ? tokenMatch[0] : '';
        // 光标在空格后：直接显示完整候选
        if (!token) return text;
        // 找当前 token 的最长后缀，使它是候选的前缀。
        // 这样 item=gr → granite 只预览 anite；= → = 不会重复；/execute → execute 不会重复。
        let best = '';
        for (let i = 0; i < token.length; i++) {
            const suffix = token.slice(i);
            if (suffix.length > best.length && text.startsWith(suffix)) {
                best = suffix;
            }
        }
        // 模糊匹配（例如 at → anchored）没有可追加的后缀，宁可不显示
        if (!best) return '';
        return text.slice(best.length);
    };
    const candidateTextForItem = (item: vscode.CompletionItem, label: string): string => {
        let text = '';
        const insert: any = item.insertText;
        if (typeof insert === 'string') {
            text = insert;
        } else if (insert && typeof insert.value === 'string') {
            text = insert.value;
        } else {
            text = label;
        }
        // 跳过 selector 变量、JSON/snippet 占位符，避免出现 @@a、$1 这种预览
        if (!text || /\$|\\|\n/.test(text)) return '';
        if (text.startsWith('@') || text.startsWith('{') || text.startsWith('"')) return '';
        return text;
    };
    const previewTextForItem = (item: vscode.CompletionItem, label: string): string => {
        const text = candidateTextForItem(item, label);
        return text ? previewSuffixForText(text) : '';
    };
    let lastSuggestionCandidates: vscode.CompletionItem[] = [];
    let lastSuggestionPrefix: string | undefined;
    let previewIndex = 0;
    let lastPreviewWord: string | undefined;
    let previewArmed = false;
    const labelOfItem = (item: vscode.CompletionItem): string =>
        typeof item.label === 'string' ? item.label : item.label.label;
    const currentPreviewWord = (): string | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || lastSuggestionPrefix === undefined) return undefined;
        const pos = editor.selection.active;
        const line = editor.document.lineAt(pos.line).text.slice(0, pos.character);
        if (!line.startsWith(lastSuggestionPrefix)) return undefined;
        return line.slice(lastSuggestionPrefix.length);
    };
    let rankedSource: vscode.CompletionItem[] | undefined;
    let rankedWord: string | undefined;
    let rankedResult: vscode.CompletionItem[] = [];
    const describeItemForRank = (item: vscode.CompletionItem) => ({
        label: labelOfItem(item),
        filterText: typeof (item as any).filterText === 'string' ? (item as any).filterText : undefined,
        sortText: typeof (item as any).sortText === 'string' ? (item as any).sortText : undefined,
        kind: typeof item.kind === 'number' ? item.kind : 0
    });
    const filteredPreviewCandidates = (word: string): vscode.CompletionItem[] => {
        // 与 VS Code 列表相同的过滤/排序算法，保证 Tab 顺序 = 列表显示顺序
        if (rankedSource === lastSuggestionCandidates && rankedWord === word) {
            return rankedResult;
        }
        rankedSource = lastSuggestionCandidates;
        rankedWord = word;
        rankedResult = rankMatches(lastSuggestionCandidates, word, describeItemForRank);
        return rankedResult;
    };
    // 按“输入开头 → 中间/结尾包含 → 模糊匹配”重排，并用 sortText 固定显示顺序。
    // filterText 统一加上输入前缀，让 VS Code 给所有候选相同分数，否则它会按自己的分数打乱顺序。
    const applyTypedOrder = (items: vscode.CompletionItem[], word: string): vscode.CompletionItem[] => {
        if (!word || items.length <= 1) return items;
        const ranked = rankMatches(items, word, describeItemForRank);
        if (ranked.length === 0) return items;
        ranked.forEach((item, index) => {
            const label = labelOfItem(item);
            const descText = typeof item.label === 'object' && item.label.description ? String(item.label.description) : '';
            // 过滤词以输入开头（保证所有候选分数相同），后面保留标签与中文说明，
            // 这样继续输入/中文检索时 VS Code 的本地过滤仍能工作。
            (item as any).filterText = descText ? `${word}${label} ${descText}` : `${word}${label}`;
            item.sortText = String(index).padStart(4, '0');
            item.preselect = index === 0;
        });
        return ranked;
    };
    const updatePreviewFromEditor = (resetIndex: boolean) => {
        const word = currentPreviewWord();
        if (word === undefined || /\s/.test(word)) {
            lastPreviewWord = undefined;
            previewArmed = false;
            clearPreview();
            return;
        }
        const filtered = filteredPreviewCandidates(word);
        if (filtered.length === 0) {
            lastPreviewWord = undefined;
            previewArmed = false;
            clearPreview();
            return;
        }
        if (word !== lastPreviewWord) previewArmed = false;
        // 同一个 token 下 VS Code 可能重复查询补全（如 inline suggest），
        // 这时不能把用户用上下键选到的位置重置回第一项。
        if (resetIndex && word !== lastPreviewWord) previewIndex = 0;
        lastPreviewWord = word;
        if (previewIndex >= filtered.length) previewIndex = 0;
        const item = filtered[previewIndex];
        const label = labelOfItem(item);
        showPreviewCandidate(candidateTextForItem(item, label));
    };
    // 列表选中项变化后直接按本地顺序更新预览。
    // 不能只依赖 resolveCompletionItem：VS Code 会缓存已解析过的补全项，
    // 从 cooked_mutton 回到 command_block 时不会再调用 resolve，预览就会停在旧值。
    const showPreviewAtIndex = (word: string, index: number) => {
        const filtered = filteredPreviewCandidates(word);
        if (filtered.length === 0) {
            clearPreview();
            return;
        }
        previewIndex = ((index % filtered.length) + filtered.length) % filtered.length;
        const item = filtered[previewIndex];
        showPreviewCandidate(candidateTextForItem(item, labelOfItem(item)));
    };
    // 用户手动输入空格后，如果 VS Code 因 quickSuggestions 关闭没有自动弹列表，
    // 这里主动补一次 triggerSuggest（例如 /give @s 后应立刻出现物品列表）。
    let spaceAutoSuggestTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressSpaceAutoTrigger = false;
    const scheduleSpaceAutoSuggest = (editor: vscode.TextEditor) => {
        if (spaceAutoSuggestTimer) clearTimeout(spaceAutoSuggestTimer);
        spaceAutoSuggestTimer = setTimeout(() => {
            spaceAutoSuggestTimer = undefined;
            if (vscode.window.activeTextEditor !== editor) return;
            const pos = editor.selection.active;
            if (!editor.document.lineAt(pos.line).text.trimStart().startsWith('/')) return;
            void vscode.commands.executeCommand('editor.action.triggerSuggest');
        }, 30);
    };

    // ---- 蓝色预览模式 ----
    // 初始：文档里是 com + 灰色预览 mand_block（列表打开）
    // Tab 1：文档仍是 com + mand_block，预览由灰变蓝
    // Tab 2：文档仍是 com，预览切换到第二个候选
    // Space：把当前预览写成完整文本，并自动补一个空格
    // Esc：关闭列表并清除预览
    // 下面的 PrefillState 是旧版“Tab 写实际文本”的状态机，当前不再启用，保留代码备用。
    type PrefillState = {
        line: number;
        replaceStart: number;
        base: string;
        candidates: string[];
        objectiveNames: (string | undefined)[];
        sourceItems: vscode.CompletionItem[];
        index: number;
        actual: boolean;
        appendSpace: boolean;
    };
    let prefillState: PrefillState | undefined;
    let prefillBusy = false;
    let prefillRetriggerTimer: ReturnType<typeof setTimeout> | undefined;
    let prefillSelectionTimer: ReturnType<typeof setTimeout> | undefined;
    let prefillListServedAt = 0;
    let prefillListServedIndex = -1;
    const setPrefillContext = (active: boolean) => {
        void vscode.commands.executeCommand('setContext', 'mc-command-helper.prefillActive', active);
    };
    const clearPrefillStateOnly = () => {
        prefillState = undefined;
        if (prefillRetriggerTimer) {
            clearTimeout(prefillRetriggerTimer);
            prefillRetriggerTimer = undefined;
        }
        if (prefillSelectionTimer) {
            clearTimeout(prefillSelectionTimer);
            prefillSelectionTimer = undefined;
        }
        setPrefillContext(false);
        clearPreview();
    };
    const beginPrefillEdit = () => { prefillBusy = true; };
    const endPrefillEdit = () => {
        setTimeout(() => { prefillBusy = false; }, 50);
    };
    const prefillPositionValid = (editor: vscode.TextEditor, state: PrefillState): boolean => {
        if (prefillState !== state) return false;
        if (vscode.window.activeTextEditor !== editor) return false;
        const current = state.candidates[state.index] || '';
        const pos = editor.selection.active;
        return pos.line === state.line && pos.character === state.replaceStart + current.length;
    };
    // 重新弹出列表后，VS Code 有时不把列表滚动到 preselect 项（只显示第一行）。
    // 先向下再向上移动一次，触发两次 reveal，让列表回到当前候选所在位置。
    const nudgePrefillSelection = async (editor: vscode.TextEditor, state: PrefillState) => {
        if (!prefillPositionValid(editor, state)) return;
        try {
            await vscode.commands.executeCommand('selectNextSuggestion');
            if (!prefillPositionValid(editor, state)) return;
            await vscode.commands.executeCommand('selectPrevSuggestion');
        } catch {
            // 列表已关闭时忽略
        }
    };
    // 触发补全列表；如果到检查时间还没有用预填充列表响应（旧列表没刷新/触发被吞），
    // 先关掉旧列表再重试，最多重试两次。
    const attemptPrefillList = (editor: vscode.TextEditor, state: PrefillState, attempt: number) => {
        if (!prefillPositionValid(editor, state)) return;
        const since = Date.now();
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
        prefillSelectionTimer = setTimeout(() => {
            prefillSelectionTimer = undefined;
            if (!prefillPositionValid(editor, state)) return;
            if (prefillListServedIndex === state.index && prefillListServedAt >= since) {
                void nudgePrefillSelection(editor, state);
                return;
            }
            if (attempt < 2) {
                void vscode.commands.executeCommand('hideSuggestWidget').then(() => {
                    if (!prefillPositionValid(editor, state)) return;
                    setTimeout(() => attemptPrefillList(editor, state, attempt + 1), 50);
                });
            } else {
                void nudgePrefillSelection(editor, state);
            }
        }, 160);
    };
    // 实际文本被替换后，旧列表会按新文本过滤到空并自动关闭。
    // 等编辑器把这次修改处理完，再重新触发补全，列表才能稳定地重新展开。
    const schedulePrefillList = (editor: vscode.TextEditor, state: PrefillState) => {
        if (prefillRetriggerTimer) clearTimeout(prefillRetriggerTimer);
        if (prefillSelectionTimer) clearTimeout(prefillSelectionTimer);
        prefillRetriggerTimer = setTimeout(() => {
            prefillRetriggerTimer = undefined;
            attemptPrefillList(editor, state, 0);
        }, 30);
    };
    const baseSuffixFor = (token: string, text: string): string => {
        let best = '';
        for (let i = 0; i < token.length; i++) {
            const suffix = token.slice(i);
            if (suffix.length > best.length && text.startsWith(suffix)) {
                best = suffix;
            }
        }
        return best;
    };
    // 预填充列表要保留原补全项的标签（中文说明）、详情文档（图片）等元数据
    const cloneCompletionItem = (source: vscode.CompletionItem): vscode.CompletionItem => {
        const item = new vscode.CompletionItem(source.label, source.kind);
        item.detail = source.detail;
        item.documentation = source.documentation;
        item.insertText = source.insertText;
        item.command = source.command;
        item.tags = source.tags;
        item.commitCharacters = source.commitCharacters;
        item.keepWhitespace = source.keepWhitespace;
        const objectiveName = (source as any).__mcObjectiveName;
        if (objectiveName) (item as any).__mcObjectiveName = objectiveName;
        return item;
    };
    const startPrefill = async (): Promise<boolean> => {
        const editor = vscode.window.activeTextEditor;
        const word = currentPreviewWord();
        if (!editor || word === undefined) return false;
        const filtered = filteredPreviewCandidates(word);
        if (filtered.length === 0) return false;
        const item = filtered[Math.min(previewIndex, filtered.length - 1)];
        const full = candidateTextForItem(item, labelOfItem(item));
        if (!full) return false;
        const pairs = filtered
            .map((it) => ({
                text: candidateTextForItem(it, labelOfItem(it)),
                objective: (it as any).__mcObjectiveName as string | undefined,
                source: it
            }))
            .filter((p) => !!p.text);
        const candidateTexts = pairs.map((p) => p.text);
        const objectiveNames = pairs.map((p) => p.objective);
        const sourceItems = pairs.map((p) => p.source);
        if (candidateTexts.length === 0) return false;
        const selectedIndex = Math.max(0, pairs.findIndex((p) => p.text === full));
        const pos = editor.selection.active;
        const lineBefore = editor.document.lineAt(pos.line).text.slice(0, pos.character);
        const tokenMatch = lineBefore.match(/\S*$/);
        const token = tokenMatch ? tokenMatch[0] : '';
        let base = baseSuffixFor(token, full);
        // 模糊匹配时没有公共后缀，就替换整个 token
        if (!base && token) base = token;
        const start = pos.character - base.length;
        const range = new vscode.Range(pos.line, start, pos.line, pos.character);
        // 先在补全列表打开的状态下改文档，会让 suggest 进入“已取消但未关闭”的状态，
        // 之后再 triggerSuggest 也不会重新查询。先关列表再改文本。
        await vscode.commands.executeCommand('hideSuggestWidget');
        beginPrefillEdit();
        await editor.edit((eb) => eb.replace(range, full));
        endPrefillEdit();
        const after = new vscode.Position(pos.line, start + full.length);
        editor.selection = new vscode.Selection(after, after);
        if (objectiveNames[selectedIndex]) {
            recordObjectiveFill(editor.document.uri.toString(), objectiveNames[selectedIndex] as string);
        }
        const beforeCursor = editor.document.lineAt(pos.line).text.slice(0, pos.character);
        const atIndex = beforeCursor.lastIndexOf('@');
        let selectorOpen = false;
        if (atIndex >= 0) {
            const open = beforeCursor.indexOf('[', atIndex);
            if (open >= 0 && beforeCursor.indexOf(']', open) < 0) {
                selectorOpen = true;
            }
        }
        prefillState = {
            line: pos.line,
            replaceStart: start,
            base,
            candidates: candidateTexts,
            objectiveNames,
            sourceItems,
            index: selectedIndex,
            actual: true,
            appendSpace: !selectorOpen
        };
        clearPreview();
        setPrefillContext(true);
        // 列表保持展开：稍后重新触发补全，provider 会返回“预填充专用列表”（见 providePrefillListItems）
        schedulePrefillList(editor, prefillState);
        return true;
    };
    const prefillMove = async (delta: number): Promise<boolean> => {
        const state = prefillState;
        const editor = vscode.window.activeTextEditor;
        if (!state || !editor) return false;
        const current = state.candidates[state.index] || '';
        const lineText = editor.document.lineAt(state.line).text;
        // 始终用实际文本循环：command_block → command_block_minecart → ...
        const nextIndex = (state.index + delta + state.candidates.length) % state.candidates.length;
        const next = state.candidates[nextIndex] || '';
        if (!next) return false;
        const from = state.actual ? current : state.base;
        if (lineText.slice(state.replaceStart, state.replaceStart + from.length) !== from) {
            clearPrefillStateOnly();
            return false;
        }
        // 先关列表再改文本，避免 suggest 被这次修改卡在“已取消但未关闭”的状态
        await vscode.commands.executeCommand('hideSuggestWidget');
        beginPrefillEdit();
        await editor.edit((eb) => eb.replace(
            new vscode.Range(state.line, state.replaceStart, state.line, state.replaceStart + from.length),
            next
        ));
        endPrefillEdit();
        const cursor = new vscode.Position(state.line, state.replaceStart + next.length);
        editor.selection = new vscode.Selection(cursor, cursor);
        if (state.objectiveNames[nextIndex]) {
            recordObjectiveFill(editor.document.uri.toString(), state.objectiveNames[nextIndex] as string);
        }
        state.index = nextIndex;
        state.actual = true;
        clearPreview();
        // 列表跟随实际文本：稍后重新查询，由 providePrefillListItems 返回完整候选，
        // 并把当前候选设为预选，这样 Tab 循环时补全列表一直可见。
        schedulePrefillList(editor, state);
        return true;
    };
    const prefillNext = () => prefillMove(1);
    const prefillPrev = () => prefillMove(-1);
    // 预填充期间补全列表的专用数据：过滤词统一改成当前 token，
    // 否则按完整候选名过滤时列表会被逐渐筛空。
    const providePrefillListItems = (
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined => {
        const state = prefillState;
        if (!state) return undefined;
        if (position.line !== state.line) return undefined;
        const current = state.candidates[state.index] || '';
        const expected = state.replaceStart + current.length;
        if (position.character !== expected) return undefined;
        const lineText = document.lineAt(state.line).text;
        if (lineText.slice(state.replaceStart, expected) !== current) return undefined;
        prefillListServedAt = Date.now();
        prefillListServedIndex = state.index;
        const wordRange = document.getWordRangeAtPosition(position);
        const word = wordRange ? document.getText(wordRange) : '';
        const replaceRange = new vscode.Range(state.line, state.replaceStart, state.line, position.character);
        const items: vscode.CompletionItem[] = [];
        state.candidates.forEach((text, i) => {
            const source = state.sourceItems[i];
            const item = source
                ? cloneCompletionItem(source)
                : new vscode.CompletionItem(text, vscode.CompletionItemKind.Value);
            // 当前项在中文说明后追加“当前”，其余项保留原来的中文说明和详情图片
            if (i === state.index) {
                const label = item.label;
                item.label = typeof label === 'string'
                    ? { label, description: '当前' }
                    : { label: label.label, description: label.description ? `${label.description} · 当前` : '当前' };
            }
            item.range = replaceRange;
            // 所有候选使用相同的过滤词前缀，保证过滤后仍全部显示并按 sortText 排序；
            // 同时保留中文说明，便于继续输入时过滤
            const labelText = labelOfItem(item);
            const descText = typeof item.label === 'object' && item.label.description ? String(item.label.description) : '';
            item.filterText = word
                ? (descText ? `${word}${labelText} ${descText}` : `${word}${labelText}`)
                : (descText ? `${labelText} ${descText}` : labelText);
            item.sortText = String(i).padStart(4, '0');
            item.preselect = i === state.index;
            items.push(item);
        });
        return items;
    };
    const commitPrefill = async (): Promise<boolean> => {
        const state = prefillState;
        const editor = vscode.window.activeTextEditor;
        if (!state || !editor) return false;
        const current = state.candidates[state.index] || '';
        const lineText = editor.document.lineAt(state.line).text;
        if (state.actual) {
            const end = state.replaceStart + current.length;
            if (lineText.slice(state.replaceStart, end) !== current) {
                clearPrefillStateOnly();
                return false;
            }
            await vscode.commands.executeCommand('hideSuggestWidget');
            beginPrefillEdit();
            if (state.appendSpace) {
                await editor.edit((eb) => eb.insert(new vscode.Position(state.line, end), ' '));
            }
            endPrefillEdit();
        } else {
            if (lineText.slice(state.replaceStart, state.replaceStart + state.base.length) !== state.base) {
                clearPrefillStateOnly();
                return false;
            }
            await vscode.commands.executeCommand('hideSuggestWidget');
            beginPrefillEdit();
            await editor.edit((eb) => eb.replace(
                new vscode.Range(state.line, state.replaceStart, state.line, state.replaceStart + state.base.length),
                current + (state.appendSpace ? ' ' : '')
            ));
            endPrefillEdit();
            if (state.objectiveNames[state.index]) {
                recordObjectiveFill(editor.document.uri.toString(), state.objectiveNames[state.index] as string);
            }
        }
        clearPrefillStateOnly();
        await new Promise(resolve => setTimeout(resolve, 30));
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        return true;
    };
    const cancelPrefill = async (): Promise<boolean> => {
        const state = prefillState;
        const editor = vscode.window.activeTextEditor;
        if (!state || !editor) {
            clearPrefillStateOnly();
            return false;
        }
        const current = state.candidates[state.index] || '';
        const lineText = editor.document.lineAt(state.line).text;
        if (state.actual) {
            const end = state.replaceStart + current.length;
            if (lineText.slice(state.replaceStart, end) === current) {
                await vscode.commands.executeCommand('hideSuggestWidget');
                beginPrefillEdit();
                await editor.edit((eb) => eb.replace(
                    new vscode.Range(state.line, state.replaceStart, state.line, end),
                    state.base
                ));
                endPrefillEdit();
            }
        }
        clearPrefillStateOnly();
        return true;
    };

    // 动态可见行数：写入语言级设置，保留全部候选，只缩短弹窗高度
    let lastMaxVisible = -1;
    const getMaxVisibleItems = (position: vscode.Position): number => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return 10;
        const visible = editor.visibleRanges[0];
        if (!visible) return 10;
        const spaceBelow = visible.end.line - position.line;
        return Math.max(1, Math.min(10, spaceBelow - 2));
    };
    const applyMaxVisible = (n: number) => {
        if (n === lastMaxVisible) return;
        lastMaxVisible = n;
        void vscode.workspace
            .getConfiguration('editor')
            .update('suggest.maxVisibleSuggestions', n, vscode.ConfigurationTarget.Global, true)
            .then(undefined, () => { /* 设置不可写时忽略 */ });
    };

    // ---- 记分项：从当前文件提取 + 按补全填充次数排序 ----
    type ObjectiveEntry = {
        name: string;
        firstLine: number;
        firstChar: number;
        occurrences: number;
    };
    type ObjectiveStat = { count: number; last: number };
    const OBJECTIVE_STATS_KEY = 'mc-command-helper.objectiveFillStats';
    let objectiveStats: Record<string, Record<string, ObjectiveStat>> =
        (context.workspaceState?.get?.(OBJECTIVE_STATS_KEY, {}) as Record<string, Record<string, ObjectiveStat>>) || {};
    let objectiveStatsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    const saveObjectiveStats = () => {
        if (objectiveStatsSaveTimer) clearTimeout(objectiveStatsSaveTimer);
        objectiveStatsSaveTimer = setTimeout(() => {
            objectiveStatsSaveTimer = undefined;
            void context.workspaceState?.update?.(OBJECTIVE_STATS_KEY, objectiveStats);
        }, 300);
    };
    const getObjectiveStats = (uri: string): Record<string, ObjectiveStat> => objectiveStats[uri] || {};
    const recordObjectiveFill = (uri: string, name: string) => {
        if (!name) return;
        let fileStats = objectiveStats[uri];
        if (!fileStats) {
            fileStats = {};
            objectiveStats[uri] = fileStats;
        }
        const stat = fileStats[name] || { count: 0, last: 0 };
        stat.count += 1;
        stat.last = Date.now();
        fileStats[name] = stat;
        saveObjectiveStats();
    };

    const objectiveScanCache = new Map<string, Map<string, ObjectiveEntry>>();
    const scanObjectives = (document: vscode.TextDocument): Map<string, ObjectiveEntry> => {
        const cacheKey = `${document.uri.toString()}|${document.version}`;
        const cached = objectiveScanCache.get(cacheKey);
        if (cached) return cached;

        const entries = new Map<string, ObjectiveEntry>();
        const add = (name: string | undefined, line: number, char: number) => {
            if (!name) return;
            const clean = name.trim();
            if (!clean || clean === '*' || clean.startsWith('@')) return;
            const existing = entries.get(clean);
            if (existing) {
                existing.occurrences += 1;
                return;
            }
            entries.set(clean, {
                name: clean,
                firstLine: line,
                firstChar: Math.max(0, char),
                occurrences: 1
            });
        };

        for (let i = 0; i < document.lineCount; i++) {
            const raw = document.lineAt(i).text;
            const trimmed = raw.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
            const tokens = splitCommandArgs(trimmed, 0).map((t) => t.text);
            if (tokens[0] && tokens[0].startsWith('/')) {
                tokens[0] = tokens[0].slice(1);
            }

            // scoreboard 可能出现在 execute ... run 后面，所以扫描所有 token
            for (let j = 0; j < tokens.length; j++) {
                if (tokens[j] !== 'scoreboard') continue;
                const group = tokens[j + 1];
                const sub = tokens[j + 2];
                if (group === 'objectives') {
                    if (sub === 'add' || sub === 'remove') {
                        add(tokens[j + 3], i, raw.indexOf(tokens[j + 3] || ''));
                    } else if (sub === 'setdisplay') {
                        add(tokens[j + 4], i, raw.indexOf(tokens[j + 4] || ''));
                    }
                } else if (group === 'players') {
                    if (sub === 'operation') {
                        add(tokens[j + 4], i, raw.indexOf(tokens[j + 4] || ''));
                        add(tokens[j + 7], i, raw.indexOf(tokens[j + 7] || ''));
                    } else if (['set', 'add', 'remove', 'reset', 'random', 'test', 'enable', 'get'].includes(sub || '')) {
                        add(tokens[j + 4], i, raw.indexOf(tokens[j + 4] || ''));
                    }
                }
            }

            // execute if/unless score
            for (let j = 0; j < tokens.length - 1; j++) {
                if ((tokens[j] === 'if' || tokens[j] === 'unless') && tokens[j + 1] === 'score') {
                    add(tokens[j + 3], i, raw.indexOf(tokens[j + 3] || ''));
                    if (/^(<=|>=|=|<|>)$/.test(tokens[j + 4] || '')) {
                        add(tokens[j + 6], i, raw.indexOf(tokens[j + 6] || ''));
                    }
                }
            }

            // 单独的 score 命令
            if (tokens[0] === 'score') {
                add(tokens[2], i, raw.indexOf(tokens[2] || ''));
            }

            // 选择器里的 scores={记分项=...}
            const scoresRe = /scores\s*=\s*\{([^}]*)\}/g;
            let m: RegExpExecArray | null;
            while ((m = scoresRe.exec(raw))) {
                for (const part of m[1].split(',')) {
                    const eq = part.indexOf('=');
                    if (eq > 0) {
                        const name = part.slice(0, eq).trim();
                        add(name, i, raw.indexOf(name));
                    }
                }
            }
        }

        objectiveScanCache.set(cacheKey, entries);
        if (objectiveScanCache.size > 30) {
            const oldest = objectiveScanCache.keys().next().value;
            if (oldest) objectiveScanCache.delete(oldest);
        }
        return entries;
    };

    const getObjectiveList = (document: vscode.TextDocument, position: vscode.Position) => {
        const entries = scanObjectives(document);
        const stats = getObjectiveStats(document.uri.toString());
        const lineBefore = document.lineAt(position.line).text.slice(0, position.character);
        const tokenMatch = lineBefore.match(/[A-Za-z0-9_\-一-龥]+$/);
        const cursorToken = tokenMatch ? tokenMatch[0] : '';
        const list: (ObjectiveEntry & { count: number; last: number })[] = [];
        for (const entry of entries.values()) {
            // 当前光标下正在输入的那半截不算
            if (cursorToken && entry.name === cursorToken && entry.occurrences === 1 && entry.firstLine === position.line) {
                continue;
            }
            const stat = stats[entry.name] || { count: 0, last: 0 };
            list.push({ ...entry, count: stat.count, last: stat.last });
        }
        list.sort((a, b) =>
            (b.count - a.count) ||
            (b.occurrences - a.occurrences) ||
            (b.last - a.last) ||
            (a.firstLine - b.firstLine) ||
            (a.firstChar - b.firstChar) ||
            a.name.localeCompare(b.name)
        );
        return list;
    };

    const buildObjectiveItems = (
        document: vscode.TextDocument,
        position: vscode.Position,
        appendSpace: boolean
    ): vscode.CompletionItem[] => {
        return getObjectiveList(document, position).map((obj, index) => {
            const item = new vscode.CompletionItem(
                { label: obj.name, description: `填充${obj.count}次 · 出现${obj.occurrences}次` },
                vscode.CompletionItemKind.EnumMember
            );
            item.filterText = obj.name;
            item.sortText = String(index).padStart(4, '0');
            item.preselect = index === 0;
            item.command = {
                command: 'mc-command-helper.recordObjectiveFill',
                title: '记录记分项填充',
                arguments: [obj.name, appendSpace]
            };
            (item as any).__mcObjectiveName = obj.name;
            return item;
        });
    };

    const isObjectiveParam = (param: any, cmd: string): boolean => {
        const name = String(param?.name || '');
        if (/记分项|记分板/.test(name)) return true;
        if (name === '名称' && cmd === 'scoreboard') return true;
        return false;
    };
    const clearPreviewOnChange = vscode.workspace.onDidChangeTextDocument((e) => {
        if (prefillBusy) return;
        // 手动输入空格：主动弹补全，兼容 quickSuggestions 关闭的情况
        if (!suppressSpaceAutoTrigger && e.contentChanges.length > 0) {
            const change = e.contentChanges[0];
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === e.document && change.text.endsWith(' ')
                && targetLanguages.some((t) => t.language === e.document.languageId)) {
                const line = e.document.lineAt(change.range.start.line).text;
                if (line.trimStart().startsWith('/')) {
                    scheduleSpaceAutoSuggest(editor);
                }
            }
        }
        if (prefillState) {
            // 用户自己输入/删除了内容：结束预填充状态，保留已经写入的实际文本
            clearPrefillStateOnly();
            return;
        }
        updatePreviewFromEditor(true);
    });
    const clearPreviewOnSelection = vscode.window.onDidChangeTextEditorSelection(() => {
        if (prefillBusy) return;
        if (prefillState) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                clearPrefillStateOnly();
                return;
            }
            const pos = editor.selection.active;
            const current = prefillState.candidates[prefillState.index] || '';
            const expected = prefillState.actual
                ? prefillState.replaceStart + current.length
                : prefillState.replaceStart + prefillState.base.length;
            if (pos.line !== prefillState.line || pos.character !== expected) {
                clearPrefillStateOnly();
            }
            return;
        }
        updatePreviewFromEditor(false);
    });
    const clearPreviewOnEditor = vscode.window.onDidChangeActiveTextEditor(() => {
        lastPreviewWord = undefined;
        clearPreview();
    });
    const onPreviewConfigChange = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('mc-command-helper.previewSide')) {
            updatePreviewFromEditor(false);
        }
    });
    const hideSuggestAndClearPreview = vscode.commands.registerCommand('mc-command-helper.hideSuggestAndClearPreview', async () => {
        if (prefillState) {
            await cancelPrefill();
        } else {
            clearPreview();
        }
        previewIndex = 0;
        lastPreviewWord = undefined;
        previewArmed = false;
        await vscode.commands.executeCommand('hideSuggestWidget');
    });
    context.subscriptions.push(clearPreviewOnChange, clearPreviewOnSelection, clearPreviewOnEditor, onPreviewConfigChange, hideSuggestAndClearPreview, { dispose: clearPreview });

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
            if (!text.startsWith('/') || text.startsWith('//')) continue;
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
                // 每次补全查询先清空，避免 Space 用到上一个参数的旧候选
                lastSuggestionCandidates = [];

                // Tab 实际文本循环期间：保持补全列表展开，并高亮当前实际候选
                const prefillItems = providePrefillListItems(document, position);
                if (prefillItems !== undefined) {
                    lastSuggestionCandidates = prefillItems;
                    return prefillItems;
                }

                // tellraw / titleraw 的 rawtext JSON 补全（支持 JSON 内换行）
                // 必须放在最前面：多行 JSON 的当前行已经不是 tellraw 开头，
                // 后面的 cmdConfig 检查会直接返回，导致换行后没有补全。
                const rawtextItems = provideRawtextCompletions(document, position, lineText);
                if (rawtextItems !== undefined) {
                    lastSuggestionCandidates = rawtextItems;
                    return rawtextItems;
                }

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
                            item.filterText = v;
                            items.push(item);
                            if (typed.length >= 1 && v === '@' + typed) {
                                const openItem = new vscode.CompletionItem({ label: v + '[', description: d + '（插入过滤参数）' }, vscode.CompletionItemKind.Snippet);
                                openItem.range = replaceRange;
                                openItem.insertText = v + '[';
                                openItem.filterText = `${v}[`;
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
                // 只处理“还没闭合”的选择器：@a[...
                // 光标在 ] 后面时不再弹选择器参数，交给普通参数补全
                const selectorMatch = lineText.match(/@([a-zA-Z])\[([^\]]*)$/);
                if (selectorMatch) {
                    // 明确指定替换区间：只替换当前正在输入的值/字段名。
                    // 不指定 range 时 VS Code 会按语言的 wordPattern 取词，
                    // 某些文件类型会把 `item=`、逗号、花括号一起当成一个词，
                    // 导致 1000+ 物品候选被整体过滤掉、补全弹不出来。
                    const tokenMatch = lineText.match(/[A-Za-z0-9_:.\-@!]*$/);
                    const selectorReplaceRange = new vscode.Range(
                        position.line,
                        position.character - (tokenMatch ? tokenMatch[0].length : 0),
                        position.line,
                        position.character
                    );
                    const withSelectorRange = (items: vscode.CompletionItem[]) => {
                        for (const item of items) {
                            if (!item.range) item.range = selectorReplaceRange;
                        }
                        return items;
                    };
                    try {
                    const selectorsConfig = mcData.selectors || mcData.enums?.selectors || {};
                    const innerText = selectorMatch[2]; // 中括号内部已输入的文本
                    let currentParams: any[] = [];
                    let activeFilterText = "";
                    let objectiveFieldNames: Set<string> | undefined;
                    let objectiveFieldOrder: Map<string, number> | undefined;
                    const markObjectiveItems = (items: vscode.CompletionItem[]) => {
                        if (!objectiveFieldNames) return items;
                        for (const item of items) {
                            const label = labelOfItem(item);
                            if (!label.endsWith('=')) continue;
                            const name = label.slice(0, -1);
                            if (objectiveFieldNames.has(name)) {
                                (item as any).__mcObjectiveName = name;
                                const order = objectiveFieldOrder?.get(name);
                                if (order !== undefined) {
                                    item.sortText = String(order).padStart(4, '0');
                                    item.preselect = order === 0;
                                }
                                item.command = {
                                    command: 'mc-command-helper.recordObjectiveFill',
                                    title: '记录记分项填充',
                                    arguments: [name, false]
                                };
                            }
                        }
                        return items;
                    };

                    // 辅助函数：根据字段配置提取对应的建议列表
                    const getSuggestionsByFieldConfig = (fieldConfig: any) => {
                        let results: any[] = [];
                        const listKey = fieldConfig.list || fieldConfig.suggestion || fieldConfig.enum;

                        if (listKey) {
                            if (typeof listKey === 'object') {
                                results.push(...Object.entries(listKey).map(([k, v]) => ({ name: k, prompt: v, type: 'concrete' })));
                            } else if (mcData.enums && mcData.enums[listKey]) {
                                const enumData = mcData.enums[listKey];
                                if (!Array.isArray(enumData)) {
                                    results.push(...Object.entries(enumData).map(([k, v]) => ({ name: k, prompt: v, list: listKey, type: 'concrete' })));
                                } else {
                                    results.push(...enumData.map((item: any) => typeof item === 'string' ? { name: item, prompt: "", list: listKey, type: 'concrete' } : { ...item, name: item.text || item.name, prompt: item.desc || item.prompt, list: listKey, type: 'concrete' }));
                                }
                            } else if (mcData.idlist) {
                                const target = mcData.idlist.find((i: any) => i.list === listKey);
                                if (target) {
                                    const data = target.data || target.list;
                                    if (Array.isArray(data)) {
                                        results.push(...data.map((item: any) => ({ name: item, prompt: "ID", list: listKey, type: 'concrete' })));
                                    } else if (typeof data === 'object' && data !== null) {
                                        results.push(...Object.entries(data).map(([k, v]) => ({ name: k, prompt: v, list: listKey, type: 'concrete' })));
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
                        if (parentKey === 'scores') {
                            // scores={记分项=...}：当前在最前面输入 key 时，给出文件里的记分项
                            const lastPart = subInnerText.split(',').pop() || '';
                            activeFilterText = lastPart.trim().toLowerCase();
                            if (!lastPart.includes('=')) {
                                const objectives = getObjectiveList(document, position);
                                currentParams = objectives.map((o) => ({
                                    name: `${o.name}=`,
                                    prompt: `填充${o.count}次 · 出现${o.occurrences}次`,
                                    type: 'plain'
                                }));
                                objectiveFieldNames = new Set(objectives.map((o) => o.name));
                                objectiveFieldOrder = new Map(objectives.map((o, index) => [o.name, index]));
                            } else {
                                currentParams = [];
                            }
                        } else if (parentConfig && parentConfig.fields) {
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
                    const selectorItems = applyTypedOrder(markObjectiveItems(withSelectorRange(getSuggestionsFromParams(currentParams, activeFilterText, mcData, { description: selectorDoc }, "selector"))), activeFilterText);
                    const filterToken = (lineText.match(/[A-Za-z0-9_-]*$/) || [''])[0];
                    lastSuggestionCandidates = selectorItems;
                    lastSuggestionPrefix = lineText.slice(0, position.character - filterToken.length);
                    updatePreviewFromEditor(true);
                    return new vscode.CompletionList(selectorItems, true);
                    } catch (e) {
                        // 兜底：任何异常都不让选择器补全消失，退回基础属性列表
                        const selectorsConfig = mcData.selectors || mcData.enums?.selectors || {};
                        const selectorItems = applyTypedOrder(withSelectorRange(getSuggestionsFromParams(
                            Object.entries(selectorsConfig).map(([k, v]: [string, any]) => ({
                                name: k + '=',
                                prompt: v.name || k,
                                type: 'plain'
                            })),
                            selectorMatch[2].trim().toLowerCase(),
                            mcData,
                            {},
                            "selector"
                        )), selectorMatch[2].trim().toLowerCase());
                        const filterToken = (lineText.match(/[A-Za-z0-9_-]*$/) || [''])[0];
                        lastSuggestionCandidates = selectorItems;
                        lastSuggestionPrefix = lineText.slice(0, position.character - filterToken.length);
                        updatePreviewFromEditor(true);
                        return new vscode.CompletionList(selectorItems, true);
                    }
                }
                // ==========================================

                const clean = lineText.trim().startsWith("/") ? lineText.trim().substring(1) : lineText.trim();
                const parts = clean.split(/\s+/);
                const inputCmd = parts[0].toLowerCase();
                const endsWithSpace = lineText.endsWith(" ");
                let currentArgText = endsWithSpace ? "" : parts[parts.length - 1].toLowerCase();
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
                        // 命令名补全后自动补一个空格（rawtext / 选择器不走这里）
                        item.command = { command: 'mc-command-helper.appendSpaceAfterCompletion', title: '补全后加空格' };
                        completionItems.push(item);
                    });
                    lastSuggestionCandidates = completionItems;
                    lastSuggestionPrefix = lineText.slice(0, position.character - inputCmd.length);
                    applyMaxVisible(getMaxVisibleItems(position));
                    updatePreviewFromEditor(true);
                    return new vscode.CompletionList(completionItems, true);
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
                    // 光标正好停在 run / run 后面的命令名上时，当前参数是嵌套命令的起点，
                    // 不能拿 'run' 或 'give' 去过滤下一个候选
                    if (parsedArgs.length === 0) {
                        currentArgText = '';
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
                                    const isLastPartial = argIndex === parsedArgs.length - 1 && !endsWithSpace;
                                    // 最后一个正在输入的参数不要求英文前缀匹配：
                                    // 交给补全按 label / 中文说明过滤（如输入“显示”匹配 actionbar）
                                    if (paramName && paramName !== argVal && !isLastPartial) {
                                        matched = false;
                                        break;
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

                                        const isLastPartial = argIndex === parsedArgs.length - 1 && !endsWithSpace;
                                        // 最后一个正在输入的参数不校验枚举值：
                                        // 英文前缀、中文说明、模糊检索都交给补全层过滤
                                        if (validOptions.length > 0 && !isLastPartial) {
                                            const argVal = parsedArgs[argIndex].toLowerCase();
                                            const isMatched = validOptions.some((opt: any) => {
                                                const optStr = (typeof opt === 'string' ? opt : (opt && typeof opt === 'object' && 'text' in opt ? (opt as any).text : "")).toLowerCase();
                                                return optStr === argVal;
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
                const allSuggestions = getSuggestionsFromParams(possibleParamsAtCursor, currentArgText, mcData, cmdConfig, inputCmd);
                // 普通指令参数补全后自动补一个空格；已有 command（如自动打开下一级）的不覆盖
                for (const item of allSuggestions) {
                    if (!item.command) {
                        item.command = { command: 'mc-command-helper.appendSpaceAfterCompletion', title: '补全后加空格' };
                    }
                }
                // 比较运算符：把“=”排到第一个并默认选中，顺序 =、<=、>=
                const suggestionLabels = new Set(allSuggestions.map(labelOfItem));
                const operatorOrderPresent = suggestionLabels.has('=') && suggestionLabels.has('<=') && suggestionLabels.has('>=');
                if (operatorOrderPresent) {
                    const operatorOrder = new Map<string, number>([['=', 0], ['<=', 1], ['>=', 2]]);
                    allSuggestions.sort((a, b) =>
                        (operatorOrder.get(labelOfItem(a)) ?? 9) - (operatorOrder.get(labelOfItem(b)) ?? 9)
                    );
                    allSuggestions.forEach((item, index) => {
                        item.sortText = String(index).padStart(4, '0');
                        item.preselect = index === 0;
                    });
                }
                // 返回完整候选，交给 VS Code 的 maxVisibleSuggestions + 滚动；
                // 不能截断数组，否则列表滚动里也看不到后面的预选词。
                let suggestions = allSuggestions;
                if (possibleParamsAtCursor.some((p) => isObjectiveParam(p, inputCmd))) {
                    const dynamicObjectives = buildObjectiveItems(document, position, true);
                    if (dynamicObjectives.length > 0) {
                        const existingLabels = new Set(allSuggestions.map(labelOfItem));
                        suggestions = [
                            ...dynamicObjectives.filter((it) => !existingLabels.has(labelOfItem(it))),
                            ...allSuggestions
                        ];
                    }
                }
                // 前缀 → 中间/结尾包含 → 模糊匹配，保证列表和 Tab 顺序一致
                if (!operatorOrderPresent) {
                    suggestions = applyTypedOrder(suggestions, currentArgText);
                }
                lastSuggestionCandidates = suggestions;
                lastSuggestionPrefix = lineText.slice(0, position.character - currentArgText.length);
                applyMaxVisible(getMaxVisibleItems(position));
                updatePreviewFromEditor(true);
                stackedListOrder = undefined;
                return new vscode.CompletionList(suggestions, true);
            },
            resolveCompletionItem(item) {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                selectedCompletionLabel = label;
                diagLog('resolve', { label });
                // 蓝色预览跟随补全列表当前聚焦项（Tab / 上下键 / 鼠标选择都适用）
                if (!prefillState) {
                    const word = currentPreviewWord();
                    if (word !== undefined) {
                        const focused = filteredPreviewCandidates(word).findIndex((it) => labelOfItem(it) === label);
                        if (focused >= 0) previewIndex = focused;
                        const text = candidateTextForItem(item, label);
                        if (text) {
                            showPreviewCandidate(text);
                        } else {
                            clearPreview();
                        }
                    }
                }
                if (stackedListPhase) {
                    // 同步多行语法堆叠的高亮：焦点变化可能来自 Tab、上下键或鼠标，
                    // 不能只依赖 nextSuggestion/prevSuggestion 里的下标更新。
                    const matchIndex = currentCommandMatches.findIndex((m) => m.name === label);
                    if (matchIndex >= 0) selectedSuggestionIndex = matchIndex;
                    // 补全列表焦点变化时刷新参数提示，让对应语法行高亮。
                    // 但 preview 开启时，触发参数提示会抢掉建议预览（ghost text），所以跳过。
                    if (!vscode.workspace.getConfiguration('editor').get<boolean>('suggest.preview')) {
                        vscode.commands.executeCommand('editor.action.triggerParameterHints');
                    }
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

                    // 当前补全列表聚焦的命令；优先用下标（上下键同步），越界再按标签回退
                    let selectedIndex = selectedSuggestionIndex;
                    if (selectedIndex < 0 || selectedIndex >= entries.length) {
                        selectedIndex = selectedCompletionLabel
                            ? entries.findIndex((e) => e.name === selectedCompletionLabel)
                            : -1;
                    }
                    if (selectedIndex < 0) selectedIndex = 0;

                    // 5 行窗口跟随当前选中项滚动，而不是永远只显示前 5 条
                    const windowStart = Math.max(
                        0,
                        Math.min(
                            selectedIndex - Math.floor(SYNTAX_VISIBLE / 2),
                            Math.max(0, entries.length - SYNTAX_VISIBLE)
                        )
                    );
                    const syntaxEntries = entries.slice(windowStart, windowStart + SYNTAX_VISIBLE);
                    const syntaxLines = syntaxEntries.map((e) => e.syntax as string);
                    const label = syntaxLines.join('\n');

                    // 计算每一行在 label 中的 [start, end)
                    const lineOffsets: [number, number][] = [];
                    let pos = 0;
                    for (const line of syntaxLines) {
                        lineOffsets.push([pos, pos + line.length]);
                        pos += line.length + 1;
                    }

                    const lineIndex = selectedIndex - windowStart;
                    const listSignature = new vscode.SignatureInformation(label);
                    if (lineIndex >= 0 && lineIndex < lineOffsets.length) {
                        listSignature.parameters = [
                            new vscode.ParameterInformation(lineOffsets[lineIndex])
                        ];
                    }

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
                        let selectedIndex = selectedSuggestionIndex;
                        if (selectedIndex < 0 || selectedIndex >= subEntries.length) {
                            selectedIndex = selectedCompletionLabel
                                ? subEntries.findIndex((e) => e.name === selectedCompletionLabel)
                                : 0;
                        }
                        if (selectedIndex < 0) selectedIndex = 0;

                        // 5 行窗口跟随当前选中项滚动
                        const windowStart = Math.max(
                            0,
                            Math.min(
                                selectedIndex - Math.floor(SYNTAX_VISIBLE / 2),
                                Math.max(0, subEntries.length - SYNTAX_VISIBLE)
                            )
                        );
                        const syntaxEntries = subEntries.slice(windowStart, windowStart + SYNTAX_VISIBLE);
                        const label = syntaxEntries.map((e) => e.syntax).join('\n');
                        const lineOffsets: [number, number][] = [];
                        let pos = 0;
                        for (const e of syntaxEntries) {
                            lineOffsets.push([pos, pos + e.syntax.length]);
                            pos += e.syntax.length + 1;
                        }
                        const lineIndex = selectedIndex - windowStart;
                        const subSignature = new vscode.SignatureInformation(label);
                        if (lineIndex >= 0 && lineIndex < lineOffsets.length) {
                            subSignature.parameters = [
                                new vscode.ParameterInformation(lineOffsets[lineIndex])
                            ];
                        }
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
        if (prefillState) {
            await prefillNext();
            return;
        }
        const baseIndex = previewIndex;
        await vscode.commands.executeCommand('selectNextSuggestion');
        if (stackedListPhase && currentCommandMatches.length > 0) {
            selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentCommandMatches.length;
            // preview 开启时不要触发参数提示，否则会抢掉预填充 ghost text
            if (!vscode.workspace.getConfiguration('editor').get<boolean>('suggest.preview')) {
                await vscode.commands.executeCommand('editor.action.triggerParameterHints');
            }
        }
        const word = currentPreviewWord();
        if (word !== undefined && !/\s/.test(word)) {
            showPreviewAtIndex(word, baseIndex + 1);
        }
        diagLog('next');
    });
    const prevSuggestionCommand = vscode.commands.registerCommand('mc-command-helper.prevSuggestion', async () => {
        if (prefillState) {
            await prefillPrev();
            return;
        }
        const baseIndex = previewIndex;
        await vscode.commands.executeCommand('selectPrevSuggestion');
        if (stackedListPhase && currentCommandMatches.length > 0) {
            selectedSuggestionIndex = (selectedSuggestionIndex - 1 + currentCommandMatches.length) % currentCommandMatches.length;
            if (!vscode.workspace.getConfiguration('editor').get<boolean>('suggest.preview')) {
                await vscode.commands.executeCommand('editor.action.triggerParameterHints');
            }
        }
        const word = currentPreviewWord();
        if (word !== undefined && !/\s/.test(word)) {
            showPreviewAtIndex(word, baseIndex - 1);
        }
        diagLog('prev');
    });

    // translate 模板里光标先停在 %% 的 1-9 选择处，此时触发补全拿不到组件。
    // 延迟到用户选完 x、光标落到 {"rawtext":[ 后面时，再自动弹一次组件补全（不用打空格）。
    let pendingRawtextAutoTrigger = false;
    let pendingRawtextAutoTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPendingRawtextAutoTrigger = () => {
        pendingRawtextAutoTrigger = false;
        if (pendingRawtextAutoTimer) {
            clearTimeout(pendingRawtextAutoTimer);
            pendingRawtextAutoTimer = undefined;
        }
    };
    const rawtextAutoTriggerCommand = vscode.commands.registerCommand('mc-command-helper.rawtextAutoTrigger', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const pos = editor.selection.active;
            const before = editor.document.lineAt(pos.line).text.slice(0, pos.character);
            if (/"rawtext"\s*:\s*\[$/.test(before)) {
                void vscode.commands.executeCommand('editor.action.triggerSuggest');
                return;
            }
        }
        pendingRawtextAutoTrigger = true;
        if (pendingRawtextAutoTimer) clearTimeout(pendingRawtextAutoTimer);
        pendingRawtextAutoTimer = setTimeout(clearPendingRawtextAutoTrigger, 8000);
    });
    const rawtextSelectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!pendingRawtextAutoTrigger) return;
        const sel = e.selections[0];
        if (!sel || !sel.isEmpty) return;
        const pos = sel.active;
        const before = e.textEditor.document.lineAt(pos.line).text.slice(0, pos.character);
        if (!/"rawtext"\s*:\s*\[$/.test(before)) return;
        clearPendingRawtextAutoTrigger();
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
    });

    // 删除字符后重新弹出补全：输入法/退格把补全关掉时，删完还能继续筛选
    const deleteAndSuggestCommand = vscode.commands.registerCommand('mc-command-helper.deleteAndSuggest', async (direction?: string) => {
        await vscode.commands.executeCommand(direction === 'right' ? 'deleteRight' : 'deleteLeft');
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const pos = editor.selection.active;
        const lineText = editor.document.lineAt(pos.line).text;
        const trimmed = lineText.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const first = trimmed.replace(/^\//, '').split(/\s+/)[0].toLowerCase();
        // 只在看起来是指令的行里重新触发，避免注释/普通文本被弹窗打扰
        if (!trimmed.startsWith('/') && !mcData.commands[first]) return;
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
    });

    // 普通指令参数/命令名补全后自动补一个空格。
    // 只在“补全项自身没有 command”的普通参数上挂；rawtext 和选择器内部不会挂。
    const appendSpaceCommand = vscode.commands.registerCommand('mc-command-helper.appendSpaceAfterCompletion', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.selection.isEmpty) return;
        suppressSpaceAutoTrigger = true;
        try {
            const pos = editor.selection.active;
            const lineText = editor.document.lineAt(pos.line).text;
            const before = pos.character > 0 ? lineText[pos.character - 1] : '';
            const after = pos.character < lineText.length ? lineText[pos.character] : '';
            // 已经是空格/行尾已有空格时不重复添加
            if (!(before && /\s/.test(before)) && !(after && /\s/.test(after))) {
                await editor.edit(edit => edit.insert(pos, ' '));
                if (editor.selection.active.isEqual(pos)) {
                    const next = new vscode.Position(pos.line, pos.character + 1);
                    editor.selection = new vscode.Selection(next, next);
                }
            }
            // 程序化插入空格不会触发 VS Code 的“输入空格后弹补全”，
            // 这里手动触发一次，让下一个参数的补全继续出现。
            await new Promise(resolve => setTimeout(resolve, 10));
            if (vscode.window.activeTextEditor !== editor) return;
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        } finally {
            setTimeout(() => { suppressSpaceAutoTrigger = false; }, 80);
        }
    });

    // 空格键：在行中间时插入普通空格；在行尾/参数末尾时才接受补全。
    // 否则补全列表一开，光标在行中间也按不出空格。
    const spaceMaybeAcceptCommand = vscode.commands.registerCommand('mc-command-helper.spaceMaybeAccept', async () => {
        if (prefillState) {
            await commitPrefill();
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (!editor.selection.isEmpty) {
            await editor.edit(edit => edit.replace(editor.selection, ' '));
            return;
        }
        const pos = editor.selection.active;
        const lineText = editor.document.lineAt(pos.line).text;
        // 当前参数没有我们插件的候选（如 give 的数量）：空格就是普通空格，不能被补全吞掉
        if (lastSuggestionCandidates.length === 0) {
            const beforeChar = pos.character > 0 ? lineText[pos.character - 1] : '';
            const afterChar = pos.character < lineText.length ? lineText[pos.character] : '';
            if (!(beforeChar && /\s/.test(beforeChar)) && !(afterChar && /\s/.test(afterChar))) {
                await editor.edit(edit => edit.insert(pos, ' '));
            }
            return;
        }
        const beforeCursor = lineText.slice(0, pos.character);
        // 选择器括号内部：空格应该接受候选，而不是插入空格
        const atIndex = beforeCursor.lastIndexOf('@');
        if (atIndex >= 0) {
            const open = beforeCursor.indexOf('[', atIndex);
            if (open >= 0 && beforeCursor.indexOf(']', open) < 0) {
                await vscode.commands.executeCommand('acceptSelectedSuggestion');
                return;
            }
        }
        const after = lineText.slice(pos.character);
        if (after.trim().length > 0) {
            await editor.edit(edit => edit.insert(pos, ' '));
            return;
        }
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
    });

    // Tab：蓝色预览模式。第一次 Tab 保持当前预览；之后逐个移动列表选中项，
    // 蓝色预览跟随选中项；只有 Space 才会把完整候选写入文档并补空格。
    const prefillTabCommand = vscode.commands.registerCommand('mc-command-helper.prefillTab', async () => {
        if (prefillState) clearPrefillStateOnly();
        const word = currentPreviewWord();
        if (word === undefined || /\s/.test(word)) {
            await vscode.commands.executeCommand('selectNextSuggestion');
            return;
        }
        if (!previewArmed) {
            // 第一次 Tab：预览由灰色变成蓝色，仍停留在当前（第一个）候选，不写文档
            previewArmed = true;
            const filtered = filteredPreviewCandidates(word);
            if (filtered.length > 0) {
                const item = filtered[Math.min(previewIndex, filtered.length - 1)];
                showPreviewCandidate(candidateTextForItem(item, labelOfItem(item)));
            }
            vscode.window.setStatusBarMessage('$(check) 预览已就绪：Tab 切换下一个预览，Space 确认', 1600);
            return;
        }
        const baseIndex = previewIndex;
        const baseSuggestionIndex = selectedSuggestionIndex;
        await vscode.commands.executeCommand('selectNextSuggestion');
        if (stackedListPhase && currentCommandMatches.length > 0) {
            selectedSuggestionIndex = (baseSuggestionIndex + 1) % currentCommandMatches.length;
            if (!vscode.workspace.getConfiguration('editor').get<boolean>('suggest.preview')) {
                void vscode.commands.executeCommand('editor.action.triggerParameterHints');
            }
        }
        showPreviewAtIndex(word, baseIndex + 1);
    });
    const prefillCommitCommand = vscode.commands.registerCommand('mc-command-helper.prefillCommit', async () => {
        if (prefillState) {
            await commitPrefill();
        } else {
            await vscode.commands.executeCommand('acceptSelectedSuggestion');
        }
    });
    const prefillCancelCommand = vscode.commands.registerCommand('mc-command-helper.prefillCancel', async () => {
        if (prefillState) {
            await cancelPrefill();
        } else {
            clearPreview();
        }
    });

    // 记分项补全插入后记录次数；主命令参数补空格，选择器 scores 里不补
    const recordObjectiveFillCommand = vscode.commands.registerCommand('mc-command-helper.recordObjectiveFill', async (name?: string, appendSpace?: boolean) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && name) {
            recordObjectiveFill(editor.document.uri.toString(), name);
        }
        if (appendSpace) {
            await vscode.commands.executeCommand('mc-command-helper.appendSpaceAfterCompletion');
        } else {
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
    });

    context.subscriptions.push(nextSuggestionCommand, prevSuggestionCommand, rawtextAutoTriggerCommand, rawtextSelectionListener, deleteAndSuggestCommand, appendSpaceCommand, spaceMaybeAcceptCommand, prefillTabCommand, prefillCommitCommand, prefillCancelCommand, recordObjectiveFillCommand);

    // 临时诊断命令：手动记录一次当前补全/预览状态
    const diagCommand = vscode.commands.registerCommand('mc-command-helper.diagnosePreview', () => diagLog('manual'));
    const diagVisibleCommand = vscode.commands.registerCommand('mc-command-helper.diagnosePreviewVisible', () => diagLog('visible'));
    context.subscriptions.push(diagCommand, diagVisibleCommand);
}
// ---------------- tellraw / titleraw rawtext 补全 ----------------

interface RawtextJsonContext {
    stack: string[];
    keyStack: (string | undefined)[];
    inString: boolean;
    stringStart: number;
    stringIsValue: boolean;
    lastKey?: string;
    expectingValue: boolean;
}

function analyzeRawtextJson(text: string): RawtextJsonContext {
    const stack: string[] = [];
    const keyStack: (string | undefined)[] = [];
    let inString = false;
    let stringStart = -1;
    let stringContent = '';
    let stringIsValue = false;
    let lastKey: string | undefined;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') {
                inString = false;
                if (!stringIsValue) {
                    // 键字符串：后面跟冒号时记录 key
                    let n = i + 1;
                    while (n < text.length && /\s/.test(text[n])) n++;
                    if (text[n] === ':') lastKey = stringContent;
                }
                stringContent = '';
                continue;
            }
            stringContent += c;
            continue;
        }
        if (c === '"') {
            inString = true;
            stringStart = i;
            stringContent = '';
            let k = i - 1;
            while (k >= 0 && /\s/.test(text[k])) k--;
            stringIsValue = k >= 0 && text[k] === ':';
            continue;
        }
        if (c === '{' || c === '[') {
            stack.push(c);
            keyStack.push(lastKey);
            lastKey = undefined;
        } else if (c === '}' || c === ']') {
            stack.pop();
            keyStack.pop();
            lastKey = undefined;
        } else if (c === ',') {
            lastKey = undefined;
        }
    }

    let expectingValue = false;
    if (!inString) {
        let k = text.length - 1;
        while (k >= 0 && /\s/.test(text[k])) k--;
        expectingValue = k >= 0 && text[k] === ':';
    }

    return { stack, keyStack, inString, stringStart, stringIsValue, lastKey, expectingValue };
}

// 按参数切分命令文本：括号/引号内的空格不切分（选择器 hasitem 里可能带空格）
function splitCommandArgs(text: string, startIndex: number): { start: number; end: number; text: string }[] {
    const args: { start: number; end: number; text: string }[] = [];
    let i = startIndex;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;
        const start = i;
        let depth = 0;
        let inString = false;
        while (i < text.length) {
            const c = text[i];
            if (inString) {
                if (c === '\\') { i += 2; continue; }
                if (c === '"') { inString = false; i++; continue; }
                i++;
                continue;
            }
            if (c === '"') { inString = true; i++; continue; }
            if (c === '[' || c === '{') { depth++; i++; continue; }
            if (c === ']' || c === '}') { if (depth > 0) depth--; i++; continue; }
            if (depth === 0 && /\s/.test(c)) break;
            i++;
        }
        args.push({ start, end: i, text: text.slice(start, i) });
    }
    return args;
}

function findRawtextJsonStart(blockText: string, inputCmd: string): number | undefined {
    const cmd = inputCmd.toLowerCase();
    if (cmd !== 'tellraw' && cmd !== 'titleraw') {
        return undefined;
    }

    let i = 0;
    while (i < blockText.length && /\s/.test(blockText[i])) i++;
    if (blockText[i] === '/') i++;
    while (i < blockText.length && /[A-Za-z0-9_]/.test(blockText[i])) i++;

    const args = splitCommandArgs(blockText, i);
    if (args.length === 0) return undefined;
    if (cmd === 'tellraw') {
        return args[0].end;
    }
    if (args.length < 2) return undefined;
    const mode = args[1].text.toLowerCase();
    if (mode !== 'title' && mode !== 'subtitle' && mode !== 'actionbar') return undefined;
    return args[1].end;
}

// 向上找到当前命令的起始行，取“命令起始行 → 光标”的完整文本。
// 这样 JSON 里按 Enter 换行后，仍然能分析出当前所在的 rawtext 结构。
function getRawtextCommandBlock(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    // 测试桩里可能没有 getText；真实 VS Code 文档一定有
    if (typeof (document as any).getText !== 'function') return undefined;
    const maxLookBack = 200;
    let startLine = -1;
    for (let line = position.line; line >= 0 && line >= position.line - maxLookBack; line--) {
        const trimmed = document.lineAt(line).text.trim();
        if (!trimmed) continue;
        if (/^\/?[A-Za-z_][A-Za-z0-9_]*/.test(trimmed)) {
            startLine = line;
            break;
        }
    }
    if (startLine < 0) return undefined;
    const start = new vscode.Position(startLine, 0);
    return document.getText(new vscode.Range(start, position));
}

function rawtextSkeletonItem(position: vscode.Position, start: number, end: number): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
        { label: '{"rawtext":[]}', description: 'rawtext 数组' },
        vscode.CompletionItemKind.Snippet
    );
    // 只闭合本次骨架自己打开的数组和根对象，光标停在中括号内继续填组件
    item.insertText = new vscode.SnippetString('{"rawtext":[$0]}');
    item.range = new vscode.Range(position.line, start, position.line, end);
    item.filterText = 'rawtext 数组';
    item.command = { command: 'editor.action.triggerSuggest', title: '补全 rawtext 组件' };
    return item;
}

function rawtextItemsForContext(
    ctx: RawtextJsonContext,
    position: vscode.Position,
    lineText: string
): vscode.CompletionItem[] | undefined {
    // 只替换当前行里正在输入的那一段；多行 JSON 的上下文由 block 分析，
    // 但插入范围仍然限制在当前行，避免跨行 Range。
    let rangeStart = position.character;
    if (ctx.inString) {
        const before = lineText.slice(0, position.character);
        const quote = before.lastIndexOf('"');
        if (quote >= 0) rangeStart = quote;
    } else {
        const m = lineText.slice(0, position.character).match(/[A-Za-z0-9_]+$/);
        if (m) rangeStart = position.character - m[0].length;
    }
    const range = new vscode.Range(position.line, rangeStart, position.line, position.character);
    const items: vscode.CompletionItem[] = [];

    const add = (label: string, desc: string, snippet: string, filter?: string, kind: vscode.CompletionItemKind = vscode.CompletionItemKind.Property, autoTrigger: boolean = false, autoCommand: string = 'editor.action.triggerSuggest', sortOrder?: number) => {
        const it = new vscode.CompletionItem({ label, description: desc }, kind);
        it.insertText = new vscode.SnippetString(snippet);
        it.range = range;
        // 同时把中文说明放进 filterText，输入中文也能检索
        it.filterText = `${filter || label} ${desc}`;
        if (sortOrder !== undefined) {
            it.sortText = String(sortOrder).padStart(4, '0');
        }
        if (autoTrigger) {
            it.command = { command: autoCommand, title: '补全 rawtext 组件' };
        }
        items.push(it);
    };

    // A 方案：只闭合本次插入打开的括号
    // 组件项自己打开了 { / with{ / [，所以补 ]}}
    // 字段项的外层组件 { 是用户手打的，不替用户补
    const translateComponent = '{"translate":"%%${1|2,1,3,4,5,6,7,8,9|}","with":{"rawtext":[$0]}}';
    const translateField = '"translate":"%%${1|2,1,3,4,5,6,7,8,9|}","with":{"rawtext":[$0]}';

    // 值字符串/等待值：只对 selector/name 给选择器建议
    const valueKey = (ctx.lastKey || '').toLowerCase();
    if ((ctx.inString && ctx.stringIsValue) || ctx.expectingValue) {
        if (valueKey === 'selector' || valueKey === 'name') {
            // 值里已经输入了 @a[...]：交回通用选择器补全，继续补 hasitem 等内部参数
            if (/@[a-zA-Z]\[[^\]]*\]?$/.test(lineText.slice(0, position.character))) {
                return undefined;
            }
            for (const sel of ['@a', '@e', '@p', '@r', '@s', '@n']) {
                add(sel, '选择器', `"${sel}"`, sel);
            }
        }
        return items;
    }

    const top = ctx.stack[ctx.stack.length - 1];
    const topKey = (ctx.keyStack[ctx.keyStack.length - 1] || '').toLowerCase();

    if (ctx.stack.length === 0) {
        items.push(rawtextSkeletonItem(position, rangeStart, position.character));
        return items;
    }

    if (top === '{') {
        if (ctx.stack.length === 1) {
            add('rawtext', 'rawtext 数组', '"rawtext":[$0]', 'rawtext', vscode.CompletionItemKind.Property, true);
        } else if (topKey === 'score') {
            add('name', '分数持有者', '"name":"$1"', 'name', vscode.CompletionItemKind.Property, false, undefined, 0);
            add('objective', '记分项名称', '"objective":"$1"', 'objective', vscode.CompletionItemKind.Property, false, undefined, 1);
        } else if (topKey === 'with') {
            add('rawtext', 'with 文本组件列表', '"rawtext":[$0]', 'rawtext', vscode.CompletionItemKind.Property, true);
        } else if (ctx.stack.length >= 3 && ctx.stack[1] === '[') {
            // 顺序：text → score → selector → translate → rawtext → with
            add('text', '纯文本', '"text":"$1"', 'text', vscode.CompletionItemKind.Property, false, undefined, 0);
            add('score', '记分板分数', '"score":{"name":"$1","objective":"$2"}', 'score', vscode.CompletionItemKind.Property, false, undefined, 1);
            add('selector', '实体名称', '"selector":"$1"', 'selector', vscode.CompletionItemKind.Property, false, undefined, 2);
            add('translate', '翻译文本', translateField, 'translate', vscode.CompletionItemKind.Property, true, 'mc-command-helper.rawtextAutoTrigger', 3);
            add('rawtext', '扩展内容组件列表', '"rawtext":[$0]', 'rawtext', vscode.CompletionItemKind.Property, true, undefined, 4);
            add('with', '翻译匹配项（仅 translate 使用）', '"with":{"rawtext":[$0]}', 'with', vscode.CompletionItemKind.Property, true, undefined, 5);
        }
    } else if (top === '[') {
        if (topKey === 'rawtext') {
            // 顺序：text → score → selector → translate
            add('{"text":...}', '纯文本组件', '{"text":"$1"}', 'text', vscode.CompletionItemKind.Snippet, false, undefined, 0);
            add('{"score":...}', '记分板分数组件', '{"score":{"name":"$1","objective":"$2"}}', 'score', vscode.CompletionItemKind.Snippet, false, undefined, 1);
            add('{"selector":...}', '实体名称组件', '{"selector":"$1"}', 'selector', vscode.CompletionItemKind.Snippet, false, undefined, 2);
            add('{"translate":...}', '翻译文本组件', translateComponent, 'translate', vscode.CompletionItemKind.Snippet, true, 'mc-command-helper.rawtextAutoTrigger', 3);
        }
    }

    return items;
}

// 找到 execute ... run 链里最后一个顶层 run，返回它后面的位置。
// 多行 rawtext 可能写在 /execute ... run /tellraw ... 里，真正拥有 JSON 的是 run 后面的命令。
function findLastRunOffset(text: string): number {
    let depth = 0;
    let inString = false;
    let last = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '[' || c === '{') { depth++; continue; }
        if (c === ']' || c === '}') { if (depth > 0) depth--; continue; }
        if (depth === 0 && (c === 'r' || c === 'R') && text.slice(i, i + 3).toLowerCase() === 'run') {
            const before = i > 0 ? text[i - 1] : '';
            const after = text[i + 3] || '';
            if ((!before || /\s/.test(before)) && (!after || /\s/.test(after) || after === '/')) {
                last = i + 3;
                i += 2;
            }
        }
    }
    return last;
}

function provideRawtextCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    lineText: string
): vscode.CompletionItem[] | undefined {
    const block = getRawtextCommandBlock(document, position);
    if (!block) return undefined;

    const effectiveStart = findLastRunOffset(block);
    const effective = block.slice(effectiveStart);
    const cmdMatch = effective.replace(/^\s+/, '').match(/^\/?([A-Za-z0-9_]+)/);
    if (!cmdMatch) return undefined;
    const inputCmd = cmdMatch[1].toLowerCase();
    if (inputCmd !== 'tellraw' && inputCmd !== 'titleraw') return undefined;

    const relativeJsonStart = findRawtextJsonStart(effective, inputCmd);
    if (relativeJsonStart === undefined) return undefined;
    const jsonStart = effectiveStart + relativeJsonStart;
    if (block.length <= jsonStart) return undefined;

    const after = block.slice(jsonStart);
    const braceIndex = after.indexOf('{');
    if (braceIndex < 0) {
        // 还没有 JSON：在 tellraw/titleraw 参数后面给骨架
        const m = lineText.match(/[A-Za-z0-9_]+$/);
        const start = m ? position.character - m[0].length : position.character;
        return [rawtextSkeletonItem(position, start, position.character)];
    }

    const jsonStartAbs = jsonStart + braceIndex;
    if (block.length < jsonStartAbs) return undefined;
    const jsonText = block.slice(jsonStartAbs);
    if (!jsonText) {
        return [rawtextSkeletonItem(position, position.character, position.character)];
    }

    const ctx = analyzeRawtextJson(jsonText);
    // JSON 已经闭合：光标在 JSON 后面的空行/新行时，把补全交还给普通指令逻辑
    if (ctx.stack.length === 0) {
        return undefined;
    }

    return rawtextItemsForContext(ctx, position, lineText);
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
        const isLastPartial = !endsWithSpace && argPtr === args.length - 1;

        // 最后一个正在输入的参数不校验枚举值，交给补全层按 label/中文说明过滤
        if (listKey && currentArg !== "" && !isLastPartial) {
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
                    return optStr === argVal;
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
                    // 最后一个正在输入的参数允许任意内容（中文检索等）
                    if (!isLastPartial && argValue !== paramValue) return -1;
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
        // 选择器字段的值已经是具体候选（如 hasitem 的 item=grass_block），直接加入，
        // 不能再按 listKey 展开整个枚举：否则 1398 个候选会对 1398 个枚举做 O(n²) 展开。
        if (param.type === 'concrete') {
            parseAndAddItem(items, param.name, param.prompt, vscode.CompletionItemKind.EnumMember, "", param.list);
            return;
        }

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

        if (listKey && typeof listKey === 'object') {
            // 内联对象 enum，例如 titleraw 的 { title, subtitle, actionbar }
            Object.entries(listKey).forEach(([k, v]) => {
                parseAndAddItem(items, k, v, vscode.CompletionItemKind.EnumMember, syntaxHint);
            });
        }
        else if (listKey && mcData.enums && mcData.enums[listKey]) {
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
    // 模糊匹配（子序列）：c-o-m 也命中 cooked_mutton，最终排序会把这类候选放到最后
    const isSubsequence = (haystack: string, needle: string): boolean => {
        let i = 0;
        for (let j = 0; j < haystack.length && i < needle.length; j++) {
            if (haystack[j] === needle[i]) i++;
        }
        return i === needle.length;
    };
    return items.filter(item => {
        if (!normalizedFilter) return true;
        const label = (typeof item.label === 'string' ? item.label : item.label.label).toLowerCase();
        const detail = (item.detail || "").toLowerCase();
        // 中文检索：候选的中文说明保存在 CompletionItemLabel.description 里
        const desc = (typeof item.label === 'object' && item.label && item.label.description
            ? String(item.label.description)
            : "").toLowerCase();
        // @a/@p 等选择器只按标签匹配；输入玩家名时不应因为“所有玩家”的说明而弹出
        if (label.startsWith('@')) return label.includes(normalizedFilter);
        return label.includes(normalizedFilter)
            || detail.includes(normalizedFilter)
            || desc.includes(normalizedFilter)
            || isSubsequence(label, normalizedFilter);
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

// 去重用的标签集合缓存：避免 addItemUnique 里对每个候选做 O(n²) 的 items.some 扫描。
// 物品枚举有 1398 项，之前每敲一个字符都会扫描约 100 万次，导致补全卡 5 秒。
const itemLabelSetCache = new WeakMap<vscode.CompletionItem[], Set<string>>();

function addItemUnique(items: vscode.CompletionItem[], label: string, desc: string, kind: vscode.CompletionItemKind, syntaxHint: string = "", listKey?: string) {
    let seenLabels = itemLabelSetCache.get(items);
    if (!seenLabels) {
        seenLabels = new Set<string>();
        for (const existing of items) {
            seenLabels.add(typeof existing.label === 'string' ? existing.label : existing.label.label);
        }
        itemLabelSetCache.set(items, seenLabels);
    }
    if (seenLabels.has(label)) return;
    seenLabels.add(label);

    const item = new vscode.CompletionItem({
        label: label,
        description: desc || ""
    }, kind);
    // 让 VS Code 的补全过滤也能命中中文说明（如输入“金合欢”检索金合欢木船）
    // 但 @a/@p 这类选择器只按标签匹配：否则输入玩家名“玩家”会命中“所有玩家”的说明，
    // 把不该出现的 @ 选择器弹出来。
    item.filterText = label.startsWith('@') ? label : (desc ? `${label} ${desc}` : label);

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

    // 接受以 = / ={ / [ 结尾的补全后，继续触发下一级补全（如 hasitem={ → item=）
    if (/(?:\{|\[|=)$/.test(label)) {
        item.command = { command: 'editor.action.triggerSuggest', title: '触发下一级补全' };
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