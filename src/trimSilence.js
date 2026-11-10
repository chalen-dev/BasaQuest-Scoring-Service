import fs from 'node:fs/promises';

// Azure pronunciation assessment is billed by the second of audio sent. A take
// of one word is mostly quiet: the pause after "Go!" and the tail after the
// word. This cuts the leading and trailing quiet (keeping a little padding so
// the first and last sounds are not clipped) before the audio is scored.
// Reads and writes the 16-bit mono PCM WAV that transcodeToWav produces.
const WINDOW_SECONDS = 0.05;
const VOICED_RMS = 0.01;
const PAD_SECONDS = 0.25;

function findDataChunk(buf) {
    for (let pos = 12; pos + 8 <= buf.length; ) {
        const id = buf.toString('ascii', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === 'data') {
            const start = pos + 8;
            const end = size > 0 && start + size <= buf.length ? start + size : buf.length;
            return { start, end };
        }
        pos += 8 + size + (size % 2);
    }
    return null;
}

/**
 * Writes a copy of the WAV with the leading and trailing silence removed.
 * Returns the new length in seconds; if nothing can be trimmed (or no voice is
 * found) the original file is left as it is and its length is returned.
 *
 * @param {string} wavPath input WAV (16-bit PCM mono)
 * @param {string} outPath where the trimmed WAV is written
 * @param {number} sampleRate
 * @returns {Promise<{ path: string, seconds: number, trimmed: boolean }>}
 */
export async function trimSilenceWav(wavPath, outPath, sampleRate = 16000) {
    const buf = await fs.readFile(wavPath);
    const data = findDataChunk(buf);
    if (!data) return { path: wavPath, seconds: 0, trimmed: false };
    const total = Math.floor((data.end - data.start) / 2);
    const win = Math.round(sampleRate * WINDOW_SECONDS);
    const voicedAt = (startSample) => {
        let squares = 0;
        for (let i = 0; i < win; i++) {
            const s = buf.readInt16LE(data.start + (startSample + i) * 2) / 32768;
            squares += s * s;
        }
        return Math.sqrt(squares / win) >= VOICED_RMS;
    };
    let first = -1;
    let last = -1;
    for (let start = 0; start + win <= total; start += win) {
        if (voicedAt(start)) {
            if (first < 0) first = start;
            last = start + win;
        }
    }
    const seconds = total / sampleRate;
    if (first < 0) return { path: wavPath, seconds, trimmed: false };
    const pad = Math.round(sampleRate * PAD_SECONDS);
    const from = Math.max(0, first - pad);
    const to = Math.min(total, last + pad);
    // Not worth rewriting for a tenth of a second.
    if (total - (to - from) < sampleRate * 0.1) return { path: wavPath, seconds, trimmed: false };
    const pcm = buf.subarray(data.start + from * 2, data.start + to * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    await fs.writeFile(outPath, Buffer.concat([header, pcm]));
    return { path: outPath, seconds: (to - from) / sampleRate, trimmed: true };
}
