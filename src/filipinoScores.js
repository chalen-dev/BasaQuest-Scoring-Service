// Pronunciation and fluency estimates for a Filipino reading.
//
// Azure gives English readings five scores. The Filipino model only judges each
// word (correct / mispronounced / omitted), but it also reports how well each word
// fitted the audio (meanGop) and when it was heard, so two more scores can be
// worked out from that. They are OUR estimates, not Azure's, and are not
// comparable to the English numbers; the thresholds below were set by eye from two
// recordings and should be revisited once the scorer is recalibrated.
//
//   pronunciation  how well the spoken words fitted the expected sounds
//   fluency        how much of the reading was spent hesitating between words
//
// Prosody (pitch, stress, rhythm) is not something the model measures, so it is
// not estimated.

// A word's mean goodness-of-pronunciation at or below GOP_POOR counts as 0 and at or
// above GOP_GOOD as 100. A typical correctly read word sits around 1.4 and a clean
// read averaged about 2.0; a read with several wrong words averaged about 0.3.
const GOP_POOR = -2;
const GOP_GOOD = 2.5;

// Only the part of a pause beyond HESITATION_AFTER seconds counts as hesitation
// (a short breath between words is normal), and losing HESITATION_FOR_ZERO of the
// reading's length to it scores 0.
const HESITATION_AFTER = 0.5;
const HESITATION_FOR_ZERO = 0.25;

// Too little speech to say anything about fluency.
const MIN_WORDS_FOR_FLUENCY = 5;
const MIN_SPAN_FOR_FLUENCY = 2;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * @param {Array<{ status: string, unscorable?: boolean, meanGop?: number|null, startTime?: number|null, endTime?: number|null }>} words
 *   the Filipino service's per-word results
 * @returns {{ pronunciation: number|null, fluency: number|null }}
 */
export function estimateFilipinoScores(words) {
    // Omitted words were never spoken: they count against completeness, not here.
    const spoken = words.filter((w) => !w.unscorable && w.status !== 'omitted');

    const gops = spoken.map((w) => w.meanGop).filter((g) => typeof g === 'number');
    const pronunciation = gops.length
        ? Math.round(100 * (gops.reduce((sum, g) => sum + clamp01((g - GOP_POOR) / (GOP_GOOD - GOP_POOR)), 0) / gops.length))
        : null;

    const timed = spoken
        .filter((w) => typeof w.startTime === 'number' && typeof w.endTime === 'number')
        .sort((a, b) => a.startTime - b.startTime);
    let fluency = null;
    if (timed.length >= MIN_WORDS_FOR_FLUENCY) {
        const span = timed[timed.length - 1].endTime - timed[0].startTime;
        if (span >= MIN_SPAN_FOR_FLUENCY) {
            let hesitation = 0;
            for (let i = 0; i < timed.length - 1; i++) {
                const gap = timed[i + 1].startTime - timed[i].endTime;
                if (gap > HESITATION_AFTER) hesitation += gap - HESITATION_AFTER;
            }
            fluency = Math.round(100 * (1 - clamp01(hesitation / span / HESITATION_FOR_ZERO)));
        }
    }
    return { pronunciation, fluency };
}
