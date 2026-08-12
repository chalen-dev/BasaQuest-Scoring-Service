import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { supabaseAuthClient, supabaseAdmin } from './supabaseClients.js';
import { transcodeToWav } from './transcode.js';
import { assessPronunciation, weightedAverage } from './azureAssess.js';
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

        const { recognizedWords, segments } = await assessPronunciation(wavPath, attempt.passage_text);

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

const port = process.env.PORT || 8787;
app.listen(port, () => {
    console.log(`BasaQuest scoring service listening on :${port}`);
});