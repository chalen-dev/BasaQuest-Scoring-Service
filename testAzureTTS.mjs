// File: testAzureTTS.mjs
// One-off sanity check for the Azure Speech key/region before wiring
// anything through Supabase — hits Azure's TTS REST API directly with
// the same two-step flow pronounce-word/index.ts uses (get a token,
// then synthesize), and saves the result as a real mp3 you can play.
// Run with: node testAzureTTS.mjs
import { readFileSync, writeFileSync } from 'node:fs'

function loadEnv(path) {
    const text = readFileSync(path, 'utf8')
    const env = {}
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        env[key] = value
    }
    return env
}

const env = loadEnv('.env')
const key = env.AZURE_SPEECH_KEY
const region = env.AZURE_SPEECH_REGION

if (!key || !region) {
    console.error('Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in .env — found keys:', Object.keys(env))
    process.exit(1)
}

async function getToken() {
    const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
    })
    if (!res.ok) {
        throw new Error(`Token request failed: ${res.status} ${await res.text()}`)
    }
    return res.text()
}

async function synthesize(token, { voice, text, outFile }) {
    const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${text}</voice></speak>`
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
            'User-Agent': 'basaquest-tts-test',
        },
        body: ssml,
    })
    if (!res.ok) {
        throw new Error(`Synthesis failed for "${text}" (${voice}): ${res.status} ${await res.text()}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(outFile, buf)
    console.log(`✅ Wrote ${outFile} (${buf.length} bytes) using ${voice}`)
}

try {
    console.log(`Requesting token for region "${region}"...`)
    const token = await getToken()
    console.log('Token OK. Synthesizing test words...')

    await synthesize(token, { voice: 'en-US-JennyNeural', text: 'hello', outFile: 'test-en.mp3' })
    await synthesize(token, { voice: 'fil-PH-BlessicaNeural', text: 'kumusta', outFile: 'test-fil.mp3' })

    console.log('\nDone. Play test-en.mp3 and test-fil.mp3 to confirm both languages actually work.')
} catch (err) {
    console.error('❌', err.message)
    process.exit(1)
}