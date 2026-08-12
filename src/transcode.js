import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Transcode whatever the browser recorded (typically WebM/Opus) into a
 * WAV file Azure's Speech SDK can read directly: PCM, 16-bit, 16kHz, mono.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<{ durationSeconds: number }>}
 */
export function transcodeToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        let durationSeconds = null;

        ffmpeg(inputPath)
            .audioCodec('pcm_s16le')
            .audioFrequency(16000)
            .audioChannels(1)
            .format('wav')
            .on('codecData', (data) => {
                // e.g. "00:01:23.45" -> seconds
                const parts = String(data.duration || '').split(':').map(Number);
                if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
                    durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
            })
            .on('error', (err) => reject(err))
            .on('end', () => resolve({ durationSeconds }))
            .save(outputPath);
    });
}