import fs from 'node:fs/promises';

// Azure pronunciation assessment is billed by the second of audio sent, so a
// recording with no voice in it should be turned away before the call.
// Reads the 16-bit mono PCM WAV that transcodeToWav produced and totals the
// seconds whose loudness (RMS, 0-1) clears a deliberately low bar, so a soft
// or slow reader still passes and only (near) silence is caught.
const WINDOW_SECONDS = 0.1;
const VOICED_RMS = 0.01;

/**
 * @param {string} wavPath 16-bit PCM mono WAV from transcodeToWav
 * @param {number} sampleRate
 * @returns {Promise<number>} seconds of audio with a voice in it
 */
export async function measureVoicedSeconds(wavPath, sampleRate = 16000) {
    const buf = await fs.readFile(wavPath);
    // Find the 'data' chunk (the header can carry extra chunks before it).
    let dataStart = -1;
    let dataEnd = buf.length;
    for (let pos = 12; pos + 8 <= buf.length; ) {
        const id = buf.toString('ascii', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === 'data') {
            dataStart = pos + 8;
            // A streamed WAV can leave the size as 0 or max: read to the end.
            dataEnd = size > 0 && dataStart + size <= buf.length ? dataStart + size : buf.length;
            break;
        }
        pos += 8 + size + (size % 2);
    }
    if (dataStart < 0) return 0;
    const windowSamples = Math.round(sampleRate * WINDOW_SECONDS);
    const totalSamples = Math.floor((dataEnd - dataStart) / 2);
    let voicedWindows = 0;
    for (let start = 0; start + windowSamples <= totalSamples; start += windowSamples) {
        let squares = 0;
        for (let i = 0; i < windowSamples; i++) {
            const sample = buf.readInt16LE(dataStart + (start + i) * 2) / 32768;
            squares += sample * sample;
        }
        if (Math.sqrt(squares / windowSamples) > VOICED_RMS) voicedWindows++;
    }
    return voicedWindows * WINDOW_SECONDS;
}
