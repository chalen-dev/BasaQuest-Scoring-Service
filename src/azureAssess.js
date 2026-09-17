import fs from 'node:fs';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;
if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    throw new Error('Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION env vars.');
}
/**
 * Run Azure Pronunciation Assessment in continuous mode over a WAV file
 * (PCM 16-bit / 16kHz / mono). Audio over 30 seconds requires continuous
 * mode -- the single-shot REST endpoint caps at 30s and doesn't accept
 * WAV produced from WebM/Opus source, which is why this runs through the
 * SDK instead of a plain HTTP call.
 *
 * IMPORTANT: continuous mode does not support Azure's built-in EnableMiscue
 * flag, so this only returns Azure's per-word accuracy scores for words it
 * actually recognized -- it does NOT tell you what was omitted or inserted.
 * That comparison happens afterwards in align.js, against referenceText.
 *
 * @param {string} wavPath
 * @param {string} referenceText - the passage, used to bias/score recognition
 * @param {string} [locale] - defaults to en-US (English flow only for now)
 * @returns {Promise<{
 *   recognizedWords: Array<{ word: string, accuracyScore: number|null }>,
 *   segments: Array<{ accuracyScore, fluencyScore, completenessScore, prosodyScore, pronScore, wordCount }>
 * }>}
 */
export function assessPronunciation(wavPath, referenceText, locale = 'en-US') {
    return new Promise((resolve, reject) => {
        let speechConfig;
        try {
            speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
        } catch (err) {
            reject(err);
            return;
        }
        speechConfig.speechRecognitionLanguage = locale;
        const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wavPath));
        const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
            referenceText,
            sdk.PronunciationAssessmentGradingSystem.HundredMark,
            sdk.PronunciationAssessmentGranularity.Word,
            false // enableMiscue: unsupported in continuous mode, we align ourselves
        );
        pronunciationConfig.enableProsodyAssessment = true;
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
        pronunciationConfig.applyTo(recognizer);
        const recognizedWords = [];
        const segments = [];
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            recognizer.stopContinuousRecognitionAsync(
                () => {
                    recognizer.close();
                    if (err) reject(err);
                    else resolve({ recognizedWords, segments });
                },
                (stopErr) => {
                    recognizer.close();
                    reject(err || new Error(String(stopErr)));
                }
            );
        };
        recognizer.recognized = (_sender, event) => {
            if (event.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
            let json;
            try {
                json = JSON.parse(
                    event.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
                );
            } catch {
                return;
            }
            const nbest = json?.NBest?.[0];
            if (!nbest) return;
            const pa = nbest.PronunciationAssessment || {};
            const words = nbest.Words || [];
            segments.push({
                accuracyScore: pa.AccuracyScore ?? null,
                fluencyScore: pa.FluencyScore ?? null,
                completenessScore: pa.CompletenessScore ?? null,
                prosodyScore: pa.ProsodyScore ?? null,
                pronScore: pa.PronScore ?? null,
                wordCount: words.length,
            });
            for (const w of words) {
                recognizedWords.push({
                    word: w.Word,
                    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? null,
                });
            }
        };
        recognizer.canceled = (_sender, event) => {
            if (event.reason === sdk.CancellationReason.Error) {
                finish(new Error(`Azure recognition canceled: ${event.errorDetails}`));
            } else {
                finish(); // EndOfStream -- normal completion
            }
        };
        recognizer.sessionStopped = () => {
            finish();
        };
        recognizer.startContinuousRecognitionAsync(
            () => {}, // started successfully; wait for canceled/sessionStopped
            (err) => finish(new Error(String(err)))
        );
    });
}
/**
 * Single-word pronunciation assessment, for the remediation mic-game.
 * Unlike assessPronunciation() above, this uses Azure's single-shot
 * recognizeOnceAsync -- appropriate here because a remediation-game
 * utterance is always one short word, never a whole passage, so there's
 * no 30-second-cap concern and no need for continuous mode's streaming
 * machinery. No alignment step either (see align.js): with only one
 * reference word there's nothing to Wagner-Fischer against, so this
 * returns Azure's own recognized word + accuracy score directly.
 *
 * @param {string} wavPath
 * @param {string} referenceWord - the single word being practiced
 * @param {string} [locale] - defaults to en-US (English flow only for now)
 * @returns {Promise<{ recognizedWords: Array<{ word: string, accuracyScore: number|null }> }>}
 */
export function assessSingleWord(wavPath, referenceWord, locale = 'en-US') {
    return new Promise((resolve, reject) => {
        let speechConfig;
        try {
            speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
        } catch (err) {
            reject(err);
            return;
        }
        speechConfig.speechRecognitionLanguage = locale;
        const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wavPath));
        const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
            referenceWord,
            sdk.PronunciationAssessmentGradingSystem.HundredMark,
            sdk.PronunciationAssessmentGranularity.Word,
            false
        );
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
        pronunciationConfig.applyTo(recognizer);
        recognizer.recognizeOnceAsync(
            (result) => {
                recognizer.close();
                if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
                    // NoMatch, canceled, etc. -- nothing was recognized at all.
                    resolve({ recognizedWords: [] });
                    return;
                }
                let json;
                try {
                    json = JSON.parse(
                        result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
                    );
                } catch {
                    resolve({ recognizedWords: [] });
                    return;
                }
                const nbest = json?.NBest?.[0];
                const words = nbest?.Words || [];
                const recognizedWords = words.map((w) => ({
                    word: w.Word,
                    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? null,
                }));
                resolve({ recognizedWords });
            },
            (err) => {
                recognizer.close();
                reject(new Error(String(err)));
            }
        );
    });
}
/**
 * Weighted average of a per-segment numeric field, weighted by word count.
 * Returns null if there's nothing to average.
 */
export function weightedAverage(segments, field) {
    let totalWeight = 0;
    let total = 0;
    for (const seg of segments) {
        const value = seg[field];
        const weight = seg.wordCount || 1;
        if (typeof value === 'number') {
            total += value * weight;
            totalWeight += weight;
        }
    }
    return totalWeight > 0 ? total / totalWeight : null;
}