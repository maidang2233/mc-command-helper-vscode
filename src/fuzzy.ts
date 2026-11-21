/*
 * 从 VS Code 的 src/vs/base/common/filters.ts 移植的模糊匹配打分（MIT License）。
 * 目的是让插件自己算出的候选顺序与 VS Code 补全列表的显示顺序一致，
 * 从而让 Tab 逐个切换实际文本时与列表从上到下的顺序完全对应。
 */

export type FuzzyScore = [number, number, ...number[]];

export interface FuzzyScoreOptions {
    readonly firstMatchCanBeWeak: boolean;
    readonly boostFullMatch: boolean;
}

const DEFAULT_OPTIONS: FuzzyScoreOptions = { boostFullMatch: true, firstMatchCanBeWeak: false };

const _maxLen = 128;

function initTable(): number[][] {
    const table: number[][] = [];
    const row: number[] = [];
    for (let i = 0; i <= _maxLen; i++) {
        row[i] = 0;
    }
    for (let i = 0; i <= _maxLen; i++) {
        table.push(row.slice(0));
    }
    return table;
}

function initArr(maxLen: number): number[] {
    const row: number[] = [];
    for (let i = 0; i <= maxLen; i++) {
        row[i] = 0;
    }
    return row;
}

const _minWordMatchPos = initArr(2 * _maxLen);
const _maxWordMatchPos = initArr(2 * _maxLen);
const _diag = initTable();
const _table = initTable();
const _arrows: number[][] = initTable();

const ARROW_DIAG = 1;
const ARROW_LEFT = 2;
const ARROW_LEFT_LEFT = 3;

const enum CharCode {
    Space = 32,
    DoubleQuote = 34,
    DollarSign = 36,
    SingleQuote = 39,
    OpenParen = 40,
    CloseParen = 41,
    Dash = 45,
    Period = 46,
    Slash = 47,
    Colon = 58,
    LessThan = 60,
    GreaterThan = 62,
    OpenSquareBracket = 91,
    Backslash = 92,
    CloseSquareBracket = 93,
    Underline = 95,
    OpenCurlyBrace = 123,
    CloseCurlyBrace = 125,
}

function isEmojiImprecise(x: number): boolean {
    return (
        (x >= 0x1F1E6 && x <= 0x1F1FF) || (x === 8986) || (x === 8987) || (x === 9200)
        || (x === 9203) || (x >= 9728 && x <= 10175) || (x === 11088) || (x === 11093)
        || (x >= 127744 && x <= 128591) || (x >= 128640 && x <= 128764)
        || (x >= 128992 && x <= 129008) || (x >= 129280 && x <= 129535)
        || (x >= 129648 && x <= 129782)
    );
}

function isSeparatorAtPos(value: string, index: number): boolean {
    if (index < 0 || index >= value.length) {
        return false;
    }
    const code = value.codePointAt(index);
    switch (code) {
        case CharCode.Underline:
        case CharCode.Dash:
        case CharCode.Period:
        case CharCode.Space:
        case CharCode.Slash:
        case CharCode.Backslash:
        case CharCode.SingleQuote:
        case CharCode.DoubleQuote:
        case CharCode.Colon:
        case CharCode.DollarSign:
        case CharCode.LessThan:
        case CharCode.GreaterThan:
        case CharCode.OpenParen:
        case CharCode.CloseParen:
        case CharCode.OpenSquareBracket:
        case CharCode.CloseSquareBracket:
        case CharCode.OpenCurlyBrace:
        case CharCode.CloseCurlyBrace:
            return true;
        case undefined:
            return false;
        default:
            return isEmojiImprecise(code);
    }
}

function isWhitespaceAtPos(value: string, index: number): boolean {
    if (index < 0 || index >= value.length) {
        return false;
    }
    const code = value.charCodeAt(index);
    return code === CharCode.Space || code === 9;
}

function isUpperCaseAtPos(pos: number, word: string, wordLow: string): boolean {
    return word[pos] !== wordLow[pos];
}

function isPatternInWord(
    patternLow: string,
    patternPos: number,
    patternLen: number,
    wordLow: string,
    wordPos: number,
    wordLen: number,
    fillMinWordPosArr = false
): boolean {
    while (patternPos < patternLen && wordPos < wordLen) {
        if (patternLow[patternPos] === wordLow[wordPos]) {
            if (fillMinWordPosArr) {
                _minWordMatchPos[patternPos] = wordPos;
            }
            patternPos += 1;
        }
        wordPos += 1;
    }
    return patternPos === patternLen;
}

function fillInMaxWordMatchPos(
    patternLen: number,
    wordLen: number,
    patternStart: number,
    wordStart: number,
    patternLow: string,
    wordLow: string
): void {
    let patternPos = patternLen - 1;
    let wordPos = wordLen - 1;
    while (patternPos >= patternStart && wordPos >= wordStart) {
        if (patternLow[patternPos] === wordLow[wordPos]) {
            _maxWordMatchPos[patternPos] = wordPos;
            patternPos--;
        }
        wordPos--;
    }
}

function doScore(
    pattern: string,
    patternLow: string,
    patternPos: number,
    patternStart: number,
    word: string,
    wordLow: string,
    wordPos: number,
    wordLen: number,
    wordStart: number,
    newMatchStart: boolean,
    outFirstMatchStrong: boolean[]
): number {
    if (patternLow[patternPos] !== wordLow[wordPos]) {
        return Number.MIN_SAFE_INTEGER;
    }

    let score = 1;
    let isGapLocation = false;
    if (wordPos === (patternPos - patternStart)) {
        // common prefix: `foobar <-> foobaz`
        score = pattern[patternPos] === word[wordPos] ? 7 : 5;
    } else if (isUpperCaseAtPos(wordPos, word, wordLow) && (wordPos === 0 || !isUpperCaseAtPos(wordPos - 1, word, wordLow))) {
        // hitting upper-case: `foo <-> forOthers`
        score = pattern[patternPos] === word[wordPos] ? 7 : 5;
        isGapLocation = true;
    } else if (isSeparatorAtPos(wordLow, wordPos) && (wordPos === 0 || !isSeparatorAtPos(wordLow, wordPos - 1))) {
        // hitting a separator: `. <-> foo.bar`
        score = 5;
    } else if (isSeparatorAtPos(wordLow, wordPos - 1) || isWhitespaceAtPos(wordLow, wordPos - 1)) {
        // post separator: `foo <-> bar_foo`
        score = 5;
        isGapLocation = true;
    }

    if (score > 1 && patternPos === patternStart) {
        outFirstMatchStrong[0] = true;
    }

    if (!isGapLocation) {
        isGapLocation = isUpperCaseAtPos(wordPos, word, wordLow) || isSeparatorAtPos(wordLow, wordPos - 1) || isWhitespaceAtPos(wordLow, wordPos - 1);
    }

    if (patternPos === patternStart) {
        if (wordPos > wordStart) {
            // the first pattern character would match a word character that is not at the word start
            score -= isGapLocation ? 3 : 5;
        }
    } else {
        if (newMatchStart) {
            // beginning of a new match (gap before this location)
            score += isGapLocation ? 2 : 0;
        } else {
            // part of a contiguous match
            score += isGapLocation ? 0 : 1;
        }
    }

    if (wordPos + 1 === wordLen) {
        // normalize matches that end at the last character
        score -= isGapLocation ? 3 : 5;
    }

    return score;
}

export function fuzzyScore(
    pattern: string,
    patternLow: string,
    patternStart: number,
    word: string,
    wordLow: string,
    wordStart: number,
    options: FuzzyScoreOptions = DEFAULT_OPTIONS
): FuzzyScore | undefined {
    const patternLen = pattern.length > _maxLen ? _maxLen : pattern.length;
    const wordLen = word.length > _maxLen ? _maxLen : word.length;

    if (patternStart >= patternLen || wordStart >= wordLen || (patternLen - patternStart) > (wordLen - wordStart)) {
        return undefined;
    }

    if (!isPatternInWord(patternLow, patternStart, patternLen, wordLow, wordStart, wordLen, true)) {
        return undefined;
    }

    fillInMaxWordMatchPos(patternLen, wordLen, patternStart, wordStart, patternLow, wordLow);

    let row = 1;
    let column = 1;
    let patternPos = patternStart;
    let wordPos = wordStart;

    const hasStrongFirstMatch = [false];

    for (row = 1, patternPos = patternStart; patternPos < patternLen; row++, patternPos++) {
        const minWordMatchPos = _minWordMatchPos[patternPos];
        const maxWordMatchPos = _maxWordMatchPos[patternPos];
        const nextMaxWordMatchPos = (patternPos + 1 < patternLen ? _maxWordMatchPos[patternPos + 1] : wordLen);

        for (column = minWordMatchPos - wordStart + 1, wordPos = minWordMatchPos; wordPos < nextMaxWordMatchPos; column++, wordPos++) {
            let score = Number.MIN_SAFE_INTEGER;
            let canComeDiag = false;

            if (wordPos <= maxWordMatchPos) {
                score = doScore(
                    pattern, patternLow, patternPos, patternStart,
                    word, wordLow, wordPos, wordLen, wordStart,
                    _diag[row - 1][column - 1] === 0,
                    hasStrongFirstMatch
                );
            }

            let diagScore = 0;
            if (score !== Number.MIN_SAFE_INTEGER) {
                canComeDiag = true;
                diagScore = score + _table[row - 1][column - 1];
            }

            const canComeLeft = wordPos > minWordMatchPos;
            const leftScore = canComeLeft ? _table[row][column - 1] + (_diag[row][column - 1] > 0 ? -5 : 0) : 0;
            const canComeLeftLeft = wordPos > minWordMatchPos + 1 && _diag[row][column - 1] > 0;
            const leftLeftScore = canComeLeftLeft ? _table[row][column - 2] + (_diag[row][column - 2] > 0 ? -5 : 0) : 0;

            if (canComeLeftLeft && (!canComeLeft || leftLeftScore >= leftScore) && (!canComeDiag || leftLeftScore >= diagScore)) {
                _table[row][column] = leftLeftScore;
                _arrows[row][column] = ARROW_LEFT_LEFT;
                _diag[row][column] = 0;
            } else if (canComeLeft && (!canComeDiag || leftScore >= diagScore)) {
                _table[row][column] = leftScore;
                _arrows[row][column] = ARROW_LEFT;
                _diag[row][column] = 0;
            } else if (canComeDiag) {
                _table[row][column] = diagScore;
                _arrows[row][column] = ARROW_DIAG;
                _diag[row][column] = _diag[row - 1][column - 1] + 1;
            } else {
                throw new Error('not possible');
            }
        }
    }

    if (!hasStrongFirstMatch[0] && !options.firstMatchCanBeWeak) {
        return undefined;
    }

    row--;
    column--;

    const result: FuzzyScore = [_table[row][column], wordStart];

    let backwardsDiagLength = 0;
    let maxMatchColumn = 0;

    while (row >= 1) {
        let diagColumn = column;
        do {
            const arrow = _arrows[row][diagColumn];
            if (arrow === ARROW_LEFT_LEFT) {
                diagColumn = diagColumn - 2;
            } else if (arrow === ARROW_LEFT) {
                diagColumn = diagColumn - 1;
            } else {
                break;
            }
        } while (diagColumn >= 1);

        if (
            backwardsDiagLength > 1
            && patternLow[patternStart + row - 1] === wordLow[wordStart + column - 1]
            && !isUpperCaseAtPos(diagColumn + wordStart - 1, word, wordLow)
            && backwardsDiagLength + 1 > _diag[row][diagColumn]
        ) {
            diagColumn = column;
        }

        if (diagColumn === column) {
            backwardsDiagLength++;
        } else {
            backwardsDiagLength = 1;
        }

        if (!maxMatchColumn) {
            maxMatchColumn = diagColumn;
        }

        row--;
        column = diagColumn - 1;
        result.push(column);
    }

    if (wordLen - wordStart === patternLen && options.boostFullMatch) {
        result[0] += 2;
    }

    const skippedCharsCount = maxMatchColumn - patternLen;
    result[0] -= skippedCharsCount;

    return result;
}

function nextTypoPermutation(pattern: string, patternPos: number): string | undefined {
    if (patternPos + 1 >= pattern.length) {
        return undefined;
    }
    const swap1 = pattern[patternPos];
    const swap2 = pattern[patternPos + 1];
    if (swap1 === swap2) {
        return undefined;
    }
    return pattern.slice(0, patternPos) + swap2 + swap1 + pattern.slice(patternPos + 2);
}

export function fuzzyScoreGracefulAggressive(
    pattern: string,
    patternLow: string,
    patternStart: number,
    word: string,
    wordLow: string,
    wordStart: number,
    options: FuzzyScoreOptions = DEFAULT_OPTIONS
): FuzzyScore | undefined {
    let top = fuzzyScore(pattern, patternLow, patternStart, word, wordLow, wordStart, options);
    if (pattern.length >= 3) {
        const tries = Math.min(7, pattern.length - 1);
        for (let movingPatternPos = patternStart + 1; movingPatternPos < tries; movingPatternPos++) {
            const newPattern = nextTypoPermutation(pattern, movingPatternPos);
            if (newPattern) {
                const candidate = fuzzyScore(newPattern, newPattern.toLowerCase(), patternStart, word, wordLow, wordStart, options);
                if (candidate) {
                    candidate[0] -= 3;
                    if (!top || candidate[0] > top[0]) {
                        top = candidate;
                    }
                }
            }
        }
    }
    return top;
}

export interface RankableCandidate {
    label: string;
    filterText?: string;
    sortText?: string;
    kind?: number;
}

/**
 * 按 VS Code 补全列表的真实顺序返回匹配项：
 * 1. 先按 sortText（缺省用 label）、label、kind 做初始排序；
 * 2. 用与 VS Code 相同的 fuzzyScore 过滤/打分（filterText 优先）；
 * 3. 按分数、初始顺序排序。
 */
export function rankMatches<T>(items: T[], word: string, describe: (item: T) => RankableCandidate): T[] {
    const entries = items.map((item) => {
        const info = describe(item);
        return {
            item,
            label: info.label,
            filterText: info.filterText,
            sortText: (info.sortText || info.label).toLowerCase(),
            kind: info.kind || 0,
            idx: 0,
            group: 0,
            score: [-100, 0] as FuzzyScore
        };
    });

    entries.sort((a, b) => {
        if (a.sortText < b.sortText) return -1;
        if (a.sortText > b.sortText) return 1;
        if (a.label < b.label) return -1;
        if (a.label > b.label) return 1;
        return a.kind - b.kind;
    });
    entries.forEach((entry, i) => { entry.idx = i; });

    const wordLow = word.toLowerCase();
    const scoreFn = entries.length > 2000 ? fuzzyScore : fuzzyScoreGracefulAggressive;
    const matched: typeof entries = [];
    for (const entry of entries) {
        if (!word) {
            entry.score = [-100, 0];
            entry.group = 0;
            matched.push(entry);
            continue;
        }
        const haystack = typeof entry.filterText === 'string' ? entry.filterText : entry.label;
        const score = scoreFn(word, wordLow, 0, haystack, haystack.toLowerCase(), 0);
        if (!score) continue;
        entry.score = score;
        // 分组顺序：0 = 以输入开头；1 = 中间/结尾包含输入（含中文说明命中）；2 = 模糊匹配
        const labelLow = entry.label.toLowerCase();
        if (labelLow.startsWith(wordLow)) {
            entry.group = 0;
        } else if (labelLow.includes(wordLow) || haystack.toLowerCase().includes(wordLow)) {
            entry.group = 1;
        } else {
            entry.group = 2;
        }
        matched.push(entry);
    }

    matched.sort((a, b) => {
        if (a.group !== b.group) return a.group - b.group;
        if (a.score[0] > b.score[0]) return -1;
        if (a.score[0] < b.score[0]) return 1;
        return a.idx - b.idx;
    });

    return matched.map((entry) => entry.item);
}
