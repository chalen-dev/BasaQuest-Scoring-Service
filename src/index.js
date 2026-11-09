import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { supabaseAuthClient, supabaseAdmin } from './supabaseClients.js';
import { transcodeToWav } from './transcode.js';
import { measureVoicedSeconds } from './silence.js';
import { assessPronunciation, assessSingleWord, weightedAverage } from './azureAssess.js';
import { alignWords } from './align.js';
const app = express();
app.use(express.json());
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
app.use(
    cors({
        origin: allowedOrigins.length ? allowedOrigins : true,
    })
);
const RECORDINGS_BUCKET = 'assessment-recordings';
// Same confidence bar align.js uses for "confidently correct" on a
// passage word -- reused here as the remediation mic-game's pass/fail
// cutoff, since there's no teacher-review loop to eventually tune this
// against for the game (no rows are ever stored -- see /score-word and
// /score-sentence).
const WORD_PASS_THRESHOLD = 80;
// A passage recording with less voice than this is treated as empty and not
// sent to Azure (see silence.js).
const MIN_VOICED_SECONDS = 1.5;
// Single word/sentence's raw audio, in memory only -- never written to
// Storage, matching the remediation mic-game's "ephemeral, no
// persistence" design. 5MB is generous headroom for a few seconds of
// WebM/Opus.
const MAX_WORD_AUDIO_BYTES = 5 * 1024 * 1024;
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/score/:attemptId', async (req, res) => {
    const { attemptId } = req.params;
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Missing bearer token.' });
    }
    const { data: userData, error: userError } = await supabaseAuthClient.auth.getUser(token);
    if (userError || !userData?.user) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
    }
    const callerId = userData.user.id;
    const { data: attempt, error: fetchError } = await supabaseAdmin
        .from('assessment_attempts')
        .select('*')
        .eq('id', attemptId)
        .single();
    if (fetchError || !attempt) {
        return res.status(404).json({ error: 'Attempt not found.' });
    }
    // Manual authorization check -- this client uses the service-role key,
    // which bypasses RLS, so we replicate the same access rule the DB
    // policies enforce (see the migration): the student themselves, or the
    // teacher who owns that student's profile.
    const isOwner = callerId === attempt.student_id || callerId === attempt.teacher_id;
    if (!isOwner) {
        const { data: studentProfile } = await supabaseAdmin
            .from('profiles')
            .select('teacher_id')
            .eq('id', attempt.student_id)
            .single();
        if (studentProfile?.teacher_id !== callerId) {
            return res.status(403).json({ error: 'Not authorized to score this attempt.' });
        }
    }
    if (attempt.language !== 'en') {
        return res.status(400).json({ error: 'Only the English scoring flow is implemented right now.' });
    }
    if (attempt.status === 'processing') {
        return res.status(409).json({ error: 'This attempt is already being scored.' });
    }
    if (attempt.status === 'scored') {
        return res.status(200).json({ status: 'scored', message: 'Already scored.' });
    }
    await supabaseAdmin
        .from('assessment_attempts')
        .update({ status: 'processing', error_message: null })
        .eq('id', attemptId);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `basaquest-${attemptId}-`));
    const inputPath = path.join(workDir, 'input');
    const wavPath = path.join(workDir, 'audio.wav');
    try {
        const { data: audioBlob, error: downloadError } = await supabaseAdmin.storage
            .from(RECORDINGS_BUCKET)
            .download(attempt.audio_path);
        if (downloadError || !audioBlob) {
            throw new Error(`Could not download recording: ${downloadError?.message || 'unknown error'}`);
        }
        const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
        await fs.writeFile(inputPath, audioBuffer);
        const { durationSeconds } = await transcodeToWav(inputPath, wavPath);
        // Don't pay Azure to listen to silence: turn away a recording with
        // (almost) no voice in it before the assessment call.
        const voicedSeconds = await measureVoicedSeconds(wavPath);
        if (voicedSeconds < MIN_VOICED_SECONDS) {
            const message = 'No speech detected in the recording.';
            await supabaseAdmin
                .from('assessment_attempts')
                .update({ status: 'failed', error_message: message })
                .eq('id', attemptId);
            return res.status(422).json({ error: message });
        }
        // Continuous recognition roughly tracks real-time, but "roughly"
        // needs real headroom, not a flat cap sized for a short clip --
        // 3x the take's own length, floored at 30s, is generous enough
        // that hitting it means Azure's connection actually stalled (see
        // azureAssess.js's header comment for why that used to hang this
        // whole request forever instead of ever reaching this timeout).
        const assessTimeoutMs = Math.max(30_000, durationSeconds * 3000);
        const { recognizedWords, segments } = await assessPronunciation(wavPath, attempt.passage_text, 'en-US', assessTimeoutMs);
        const referenceWords = attempt.passage_text.split(/\s+/).filter(Boolean);
        const alignedRows = alignWords(referenceWords, recognizedWords);
        const wordRows = alignedRows.map((row) => ({
            attempt_id: attemptId,
            word_index: row.wordIndex,
            reference_word: row.referenceWord,
            recognized_word: row.recognizedWord,
            error_type: row.errorType,
            accuracy_score: row.accuracyScore,
            system_verdict: row.systemVerdict,
            confidence: row.confidence,
        }));
        // Clear out any previous attempt at scoring this same attempt (e.g. a
        // retry after failure) before inserting fresh rows.
        await supabaseAdmin.from('assessment_attempt_words').delete().eq('attempt_id', attemptId);
        if (wordRows.length > 0) {
            const { error: insertError } = await supabaseAdmin.from('assessment_attempt_words').insert(wordRows);
            if (insertError) throw new Error(`Failed to store word results: ${insertError.message}`);
        }
        const utteranceScores = {
            accuracy_score: weightedAverage(segments, 'accuracyScore'),
            fluency_score: weightedAverage(segments, 'fluencyScore'),
            completeness_score: weightedAverage(segments, 'completenessScore'),
            prosody_score: weightedAverage(segments, 'prosodyScore'),
            pron_score: weightedAverage(segments, 'pronScore'),
        };
        await supabaseAdmin
            .from('assessment_attempts')
            .update({
                status: 'scored',
                scored_at: new Date().toISOString(),
                duration_seconds: durationSeconds,
                ...utteranceScores,
            })
            .eq('id', attemptId);
        return res.status(200).json({
            status: 'scored',
            utteranceScores,
            wordCount: wordRows.length,
        });
    } catch (err) {
        console.error(`[score/${attemptId}] failed:`, err);
        await supabaseAdmin
            .from('assessment_attempts')
            .update({ status: 'failed', error_message: String(err?.message || err) })
            .eq('id', attemptId);
        return res.status(500).json({ error: 'Scoring failed.', detail: String(err?.message || err) });
    } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
});
// Single-word scoring for the remediation mic-game's earlier bare-word
// mode. Kept for backward compatibility with anything still calling it,
// but RemediationGame.tsx now calls /score-sentence below instead. Same
// "ephemeral, no persistence" shape as that route -- see its own
// comment for the full reasoning.
app.post(
    '/score-word',
    express.raw({ type: () => true, limit: MAX_WORD_AUDIO_BYTES }),
    async (req, res) => {
        const word = typeof req.query.word === 'string' ? req.query.word.trim() : '';
        const language = typeof req.query.language === 'string' ? req.query.language : 'en';
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ error: 'Missing bearer token.' });
        }
        const { data: userData, error: userError } = await supabaseAuthClient.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }
        if (!word) {
            return res.status(400).json({ error: 'Missing word.' });
        }
        if (language !== 'en') {
            return res.status(400).json({ error: 'Only the English scoring flow is implemented right now.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Missing audio body.' });
        }
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'basaquest-word-'));
        const inputPath = path.join(workDir, 'input');
        const wavPath = path.join(workDir, 'audio.wav');
        try {
            await fs.writeFile(inputPath, req.body);
            await transcodeToWav(inputPath, wavPath);
            const { recognizedWords } = await assessSingleWord(wavPath, word);
            const spoken = recognizedWords[0] || null;
            const accuracyScore = spoken?.accuracyScore ?? null;
            return res.status(200).json({
                recognizedWord: spoken?.word ?? null,
                accuracyScore,
                passed: accuracyScore != null && accuracyScore >= WORD_PASS_THRESHOLD,
            });
        } catch (err) {
            console.error('[score-word] failed:', err);
            return res.status(500).json({ error: 'Scoring failed.', detail: String(err?.message || err) });
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }
);
// Single-sentence scoring for the remediation mic-game's sentence mode.
// Unlike /score-word, the audio here is a short SENTENCE (the
// Gemini-generated sentence for one weak word -- see
// generate-remediation-sentences and RemediationGame.tsx).
//
// LIVE WORD-BY-WORD FEEDBACK (this pass): the response now includes a
// `words` array covering EVERY word in the sentence, not just the
// target word -- align.js's alignWords() already computes a verdict for
// every reference word, this previously just discarded all but one row.
// `words[i]` corresponds to `sentenceWords[i]` from the request (0-based
// -- align.js's own wordIndex is 1-based against the reference list, so
// it's converted here). Only rows with a real reference word are kept
// (an alignment can also produce fractional-wordIndex "Insertion" rows
// for extra words Azure heard that don't correspond to any reference
// position -- those don't map to a sentence word, so they're dropped
// rather than confusing the per-word coloring on the client).
//
// PASS/FAIL STILL ONLY LOOKS AT THE TARGET WORD -- that product decision
// hasn't changed. The extra per-word data is purely for the student to
// SEE how the rest of their read went; a slip elsewhere in the sentence
// never blocks unlocking the target word's treasure.
//
// Reuses assessSingleWord() unchanged: it already runs Azure's
// single-shot recognizer against whatever reference text it's given,
// one word or several, since a short remediation sentence is nowhere
// near the 30-second single-shot cap.
//
// Ephemeral, same as /score-word: the audio arrives as the raw request
// body and nothing is written to Storage or any DB table -- no
// assessment_attempts row, no assessment_attempt_words rows.
app.post(
    '/score-sentence',
    express.raw({ type: () => true, limit: MAX_WORD_AUDIO_BYTES }),
    async (req, res) => {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ error: 'Missing bearer token.' });
        }
        const { data: userData, error: userError } = await supabaseAuthClient.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }
        const language = typeof req.query.language === 'string' ? req.query.language : 'en';
        let sentenceWords = null;
        try {
            sentenceWords = JSON.parse(String(req.query.words || 'null'));
        } catch {
            sentenceWords = null;
        }
        const targetIndex = Number(req.query.targetIndex);
        if (!Array.isArray(sentenceWords) || sentenceWords.length === 0 || !sentenceWords.every((w) => typeof w === 'string')) {
            return res.status(400).json({ error: 'Missing or invalid words.' });
        }
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= sentenceWords.length) {
            return res.status(400).json({ error: 'Missing or invalid targetIndex.' });
        }
        if (language !== 'en') {
            return res.status(400).json({ error: 'Only the English scoring flow is implemented right now.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Missing audio body.' });
        }
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'basaquest-sentence-'));
        const inputPath = path.join(workDir, 'input');
        const wavPath = path.join(workDir, 'audio.wav');
        try {
            await fs.writeFile(inputPath, req.body);
            await transcodeToWav(inputPath, wavPath);
            const referenceText = sentenceWords.join(' ');
            const { recognizedWords } = await assessSingleWord(wavPath, referenceText);
            const alignedRows = alignWords(sentenceWords, recognizedWords);
            // Convert align.js's 1-based wordIndex to 0-based, matching the
            // caller's sentenceWords array directly, and drop insertion-only
            // rows (no referenceWord -- nothing in sentenceWords to color).
            const words = alignedRows
                .filter((row) => row.referenceWord != null)
                .map((row) => ({
                    wordIndex: row.wordIndex - 1,
                    referenceWord: row.referenceWord,
                    recognizedWord: row.recognizedWord,
                    errorType: row.errorType,
                    accuracyScore: row.accuracyScore,
                    systemVerdict: row.systemVerdict,
                }));
            const targetRow = words.find((row) => row.wordIndex === targetIndex) ?? null;
            const accuracyScore = targetRow?.accuracyScore ?? null;
            const passed = targetRow != null && targetRow.systemVerdict === 'correct';
            return res.status(200).json({
                recognizedWord: targetRow?.recognizedWord ?? null,
                accuracyScore,
                passed,
                words,
            });
        } catch (err) {
            console.error('[score-sentence] failed:', err);
            return res.status(500).json({ error: 'Scoring failed.', detail: String(err?.message || err) });
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }
);
// Whole-passage scoring for Reading Coach Mode. The pupil reads one remediation
// passage aloud and gets a verdict for every word of it (correct / mispronounced
// / omitted) while still on the page.
//
// Like /score-sentence it is ephemeral: the audio arrives as the raw request
// body and nothing is stored, no attempt row and no word rows. Unlike it, a
// passage can run past the 30 seconds one-shot recognition allows, so this uses
// continuous recognition (assessPronunciation, the same call the full
// assessment makes), and it turns a take away BEFORE paying Azure for it when it
// is too long or has no voice in it (the same silence check as /score/:attemptId).
//
// words[i] corresponds to the request's words[i] (0-based). Rows for extra
// words Azure heard (insertions) have no reference word and are dropped, as in
// /score-sentence.
const MAX_PASSAGE_AUDIO_BYTES = 15 * 1024 * 1024;
// Longest take accepted; the app stops recording well before this.
const MAX_PASSAGE_SECONDS = 150;
const MAX_PASSAGE_WORDS = 300;
// Filipino passages are scored by the separate Filipino model service (the
// wav2vec2 phoneme scorer in basaquest-filipino-miscue-detection, hosted as a
// Hugging Face Space), not Azure, which has no Filipino pronunciation
// assessment. Both must be set for Filipino to work; the key is sent as
// x-api-key. It runs on CPU and can take as long as the recording is, so the
// wait is generous.
const GOP_SERVICE_URL = (process.env.GOP_SERVICE_URL || '').replace(/\/+$/, '');
const GOP_API_KEY = process.env.GOP_API_KEY || '';
// Only for a private Space: a Hugging Face read token, sent as the bearer token Spaces ask for.
const GOP_HF_TOKEN = process.env.GOP_HF_TOKEN || '';
const GOP_TIMEOUT_MS = 240_000;
// The Filipino service's verdicts, in this service's vocabulary (what /score-sentence returns).
const GOP_STATUS_TO_ERROR_TYPE = { correct: 'None', mispronounced: 'Mispronunciation', omitted: 'Omission' };
async function scoreWithGop(passageWords, wavPath) {
    const audio = await fs.readFile(wavPath);
    const url = `${GOP_SERVICE_URL}/score?words=${encodeURIComponent(JSON.stringify(passageWords))}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'x-api-key': GOP_API_KEY,
            'Content-Type': 'audio/wav',
            ...(GOP_HF_TOKEN ? { Authorization: `Bearer ${GOP_HF_TOKEN}` } : {}),
        },
        body: audio,
        signal: AbortSignal.timeout(GOP_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Filipino scorer answered ${response.status}: ${detail.slice(0, 300)}`);
    }
    const result = await response.json();
    return result.words
        // A token with nothing to pronounce (a lone punctuation mark) has no verdict to show.
        .filter((w) => !w.unscorable && GOP_STATUS_TO_ERROR_TYPE[w.status] !== undefined)
        .map((w) => ({
            wordIndex: w.index,
            referenceWord: w.word,
            recognizedWord: null,
            errorType: GOP_STATUS_TO_ERROR_TYPE[w.status],
            accuracyScore: null,
            systemVerdict: w.status === 'correct' ? 'correct' : 'miscue',
        }));
}
app.post(
    '/score-passage',
    express.raw({ type: () => true, limit: MAX_PASSAGE_AUDIO_BYTES }),
    async (req, res) => {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
            return res.status(401).json({ error: 'Missing bearer token.' });
        }
        const { data: userData, error: userError } = await supabaseAuthClient.auth.getUser(token);
        if (userError || !userData?.user) {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }
        const language = typeof req.query.language === 'string' ? req.query.language : 'en';
        let passageWords = null;
        try {
            passageWords = JSON.parse(String(req.query.words || 'null'));
        } catch {
            passageWords = null;
        }
        if (
            !Array.isArray(passageWords) ||
            passageWords.length === 0 ||
            passageWords.length > MAX_PASSAGE_WORDS ||
            !passageWords.every((w) => typeof w === 'string')
        ) {
            return res.status(400).json({ error: 'Missing or invalid words.' });
        }
        if (language !== 'en' && language !== 'fil') {
            return res.status(400).json({ error: 'Unsupported language.' });
        }
        if (language === 'fil' && (!GOP_SERVICE_URL || !GOP_API_KEY)) {
            return res.status(400).json({ error: 'Filipino scoring is not set up on this server.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Missing audio body.' });
        }
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'basaquest-passage-'));
        const inputPath = path.join(workDir, 'input');
        const wavPath = path.join(workDir, 'audio.wav');
        try {
            await fs.writeFile(inputPath, req.body);
            const { durationSeconds } = await transcodeToWav(inputPath, wavPath);
            if (durationSeconds > MAX_PASSAGE_SECONDS) {
                return res.status(422).json({ error: 'The recording is too long.', code: 'too_long' });
            }
            const voicedSeconds = await measureVoicedSeconds(wavPath);
            if (voicedSeconds < MIN_VOICED_SECONDS) {
                return res.status(422).json({ error: 'No speech detected in the recording.', code: 'silent' });
            }
            if (language === 'fil') {
                const filipinoWords = await scoreWithGop(passageWords, wavPath);
                return res.status(200).json({ durationSeconds, voicedSeconds, words: filipinoWords });
            }
            const assessTimeoutMs = Math.max(30_000, durationSeconds * 3000);
            const { recognizedWords } = await assessPronunciation(
                wavPath,
                passageWords.join(' '),
                'en-US',
                assessTimeoutMs
            );
            const alignedRows = alignWords(passageWords, recognizedWords);
            const words = alignedRows
                .filter((row) => row.referenceWord != null)
                .map((row) => ({
                    wordIndex: row.wordIndex - 1,
                    referenceWord: row.referenceWord,
                    recognizedWord: row.recognizedWord,
                    errorType: row.errorType,
                    accuracyScore: row.accuracyScore,
                    systemVerdict: row.systemVerdict,
                }));
            return res.status(200).json({ durationSeconds, voicedSeconds, words });
        } catch (err) {
            console.error('[score-passage] failed:', err);
            return res.status(500).json({ error: 'Scoring failed.', detail: String(err?.message || err) });
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }
);
const port = process.env.PORT || 8787;
app.listen(port, () => {
    console.log(`BasaQuest scoring service listening on :${port}`);
});