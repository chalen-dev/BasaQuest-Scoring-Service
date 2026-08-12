// Aligns the reference passage against what Azure actually recognized, and
// derives the miscue tags (None / Omission / Insertion / Mispronunciation)
// that Azure's continuous mode doesn't give us for free (see azureAssess.js).
//
// This is a classic word-level edit-distance alignment (Wagner-Fischer),
// which is also the same category of algorithm the manuscript calls for in
// the Filipino pipeline's sequence-alignment step -- this is meant to be a
// reusable starting point for that later, not just an English one-off.

const HIGH_ACCURACY_THRESHOLD = 80; // >= this: confidently "correct"
const LOW_ACCURACY_THRESHOLD = 40; // < this: confidently "miscue"

function normalize(word) {
    return word
        .toLowerCase()
        .replace(/[^\p{L}\p{N}']/gu, '')
        .trim();
}

/**
 * @param {string[]} referenceWords - words from the passage, in order
 * @param {Array<{ word: string, accuracyScore: number|null }>} recognizedWords
 * @returns {Array<{
 *   wordIndex: number,
 *   referenceWord: string|null,
 *   recognizedWord: string|null,
 *   errorType: 'None'|'Omission'|'Insertion'|'Mispronunciation',
 *   accuracyScore: number|null,
 *   systemVerdict: 'correct'|'miscue',
 *   confidence: 'high'|'low',
 * }>}
 */
export function alignWords(referenceWords, recognizedWords) {
    const ref = referenceWords.map(normalize);
    const rec = recognizedWords.map((w) => normalize(w.word));
    const n = ref.length;
    const m = rec.length;

    // dp[i][j] = edit distance between ref[0..i) and rec[0..j)
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 0; i <= n; i++) dp[i][0] = i;
    for (let j = 0; j <= m; j++) dp[0][j] = j;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = ref[i - 1] === rec[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1, // deletion (omission)
                dp[i][j - 1] + 1, // insertion
                dp[i - 1][j - 1] + cost // match or substitution
            );
        }
    }

    // Backtrace from (n, m) to (0, 0)
    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (ref[i - 1] === rec[j - 1] ? 0 : 1)) {
            ops.push({ type: ref[i - 1] === rec[j - 1] ? 'match' : 'substitute', refIdx: i - 1, recIdx: j - 1 });
            i -= 1;
            j -= 1;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
            ops.push({ type: 'delete', refIdx: i - 1, recIdx: null });
            i -= 1;
        } else {
            ops.push({ type: 'insert', refIdx: null, recIdx: j - 1 });
            j -= 1;
        }
    }
    ops.reverse();

    const results = [];
    let refPosition = 0; // 1-based index of the last reference word consumed

    for (const op of ops) {
        if (op.type === 'insert') {
            const rec0 = recognizedWords[op.recIdx];
            results.push(
                buildRow({
                    wordIndex: refPosition + 0.5,
                    referenceWord: null,
                    recognizedWord: rec0.word,
                    errorType: 'Insertion',
                    accuracyScore: rec0.accuracyScore,
                })
            );
            continue;
        }

        refPosition += 1;

        if (op.type === 'delete') {
            results.push(
                buildRow({
                    wordIndex: refPosition,
                    referenceWord: referenceWords[op.refIdx],
                    recognizedWord: null,
                    errorType: 'Omission',
                    accuracyScore: null,
                })
            );
            continue;
        }

        const rec0 = recognizedWords[op.recIdx];
        results.push(
            buildRow({
                wordIndex: refPosition,
                referenceWord: referenceWords[op.refIdx],
                recognizedWord: rec0.word,
                errorType: op.type === 'match' ? 'None' : 'Mispronunciation',
                accuracyScore: rec0.accuracyScore,
            })
        );
    }

    return results;
}

function buildRow({ wordIndex, referenceWord, recognizedWord, errorType, accuracyScore }) {
    const { systemVerdict, confidence } = judge(errorType, accuracyScore);
    return {
        wordIndex,
        referenceWord,
        recognizedWord,
        errorType,
        accuracyScore,
        systemVerdict,
        confidence,
    };
}

// First-pass confidence-gating heuristic. This threshold logic is exactly
// the kind of thing the manuscript's Detection Accuracy Validation (target
// Cohen's kappa >= 0.70) should be used to tune once real teacher-review
// data exists -- treat these numbers as a starting point, not a final rule.
function judge(errorType, accuracyScore) {
    if (errorType === 'Omission' || errorType === 'Insertion') {
        // Alignment-only decisions -- unambiguous by construction.
        return { systemVerdict: 'miscue', confidence: 'high' };
    }

    if (errorType === 'None') {
        if (accuracyScore == null) return { systemVerdict: 'correct', confidence: 'low' };
        if (accuracyScore >= HIGH_ACCURACY_THRESHOLD) return { systemVerdict: 'correct', confidence: 'high' };
        return { systemVerdict: 'correct', confidence: 'low' };
    }

    // Mispronunciation (word matched alignment-wise, but text differs, or
    // Azure scored it as a likely misread)
    if (accuracyScore == null) return { systemVerdict: 'miscue', confidence: 'low' };
    if (accuracyScore < LOW_ACCURACY_THRESHOLD) return { systemVerdict: 'miscue', confidence: 'high' };
    return { systemVerdict: 'miscue', confidence: 'low' };
}