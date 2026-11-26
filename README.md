# Meeting Copilot

A small always-on-top macOS app that listens to a call, transcribes both sides live, and streams suggested answers from Claude.

- **Them**: system audio (Zoom, Meet, Teams…) captured with macOS ScreenCaptureKit
- **Me**: your microphone
- **Transcription**: on your Mac, no API key or internet needed. Pick the engine in Settings:
  - **Parakeet** (NVIDIA Parakeet TDT 0.6B v2): most accurate, with punctuation. Each line is finalized when the speaker pauses; a draft updates about once a second while they talk.
  - **sherpa-onnx Zipformer** (streaming): words appear as they're spoken, lowest delay, less accurate, no punctuation.
  - Both are English only and run with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).
- **Answers**: Claude through your local **Claude Code** (`claude -p`), so they run on your Claude subscription with no API key. Default Sonnet 5.5 at low effort for speed, streamed token-by-token

## Setup

1. Install **Claude Code** (https://claude.com/claude-code) and run `claude` once in Terminal to sign in with your Claude account.
2. Install, download the speech models (about 800 MB, once), and run:
   ```bash
   npm install
   npm run models
   npm start
   ```
   If `npm start` says Electron failed to install, run `node node_modules/electron/install.js`.
3. Open ⚙︎ Settings and choose a **Speech engine**. Then give Claude your background:
   - **Resume**: click **Upload PDF…** (text and Markdown files work too), or paste it.
   - **Job description**: paste the posting link and click **Fetch**. The app opens the page in a hidden window and has Claude Code (Haiku) tidy it into role, responsibilities and requirements. This takes about 10 s. Pages behind a sign-in (some LinkedIn links) can't be read, so paste the description instead.
   - **Other notes**: company research, talking points.
   You can edit all three after importing.
4. Click **Start listening**. The first start loads the speech model, which takes a few seconds. macOS will ask for:
   - **Microphone** access
   - **Screen & System Audio Recording** access (needed to capture the other side's audio). After granting it, quit and restart the app.
   - macOS gives these permissions to the app you launched from. With `npm start` in VS Code's terminal, that's **Visual Studio Code**; in Terminal, it's **Terminal**. Turn the permission on for that app, then quit it completely (⌘Q) and reopen it.

Settings are stored in `~/Library/Application Support/meeting-copilot/settings.json`. Claude Code keeps its own login.

## Using it

| Action | How |
|---|---|
| Auto-answer when a question is asked | the **Auto: Them / Me** toggles. **Them** answers the interviewer's questions (call audio); **Me** answers questions you ask out loud (your mic). Turn on either or both. If the mic picks up the other side through your speakers, the same question is answered only once |
| Answer now | **Answer now** or `⌘⇧↵` (works from any app) |
| Ask something specific | type in "Ask Claude about this call…" |
| Answer what's on screen | **Analyze screen** or `⌘⇧1` (works from any app). Takes a screenshot of the display under the pointer and answers the question or coding problem on it: approach, complexity and working code. Needs the same Screen Recording permission as system audio. The screenshot goes to Claude and is not saved |
| Hide / show window | `⌘⇧H` |
| Stop the current answer | `⌘⇧X` |

**Hide window from screen sharing** (on by default) keeps the overlay out of your own screen shares and recordings.

## If system audio doesn't come through

The built-in capture needs macOS 13+ with Screen Recording permission. As a fallback, install [BlackHole](https://existential.audio/blackhole/), create a Multi-Output Device (speakers + BlackHole) in Audio MIDI Setup, set it as your output, then choose **BlackHole** under *Other side's audio* in Settings.

Use headphones if you can. Otherwise the mic also picks up the other person through your speakers.

## Costs (rough, per hour of call)

- Transcription: free (runs on your Mac)
- Claude: no separate bill. Answers count toward your Claude plan's usage limits, so auto-answer on a long call uses more. Sonnet 5.5 and Haiku 5.5 use less than Opus and start answering faster (about 0.6–0.8 s to the first words, versus about 3 s for Opus).

## Files

```
src/main.js        window, global shortcuts, IPC
src/questions.js   decides whether a line is a question
src/auto-answer.js when to answer automatically (per-speaker toggles)
src/context.js     resume PDF text + job posting fetch
src/transcriber.js runs the speech engine in a utility process
src/asr/           sherpa-onnx engines (Parakeet + VAD, streaming Zipformer)
scripts/           model download script (models go in ./models)
src/claude.js      answers via the Claude Code CLI (keeps one process ready)
src/screen-capture.js screenshot of the display under the pointer, sized for Claude
test/              unit tests (npm test)
src/settings.js    settings + encrypted keys
src/preload.js     safe bridge to the renderer
src/renderer/      UI, audio capture, PCM AudioWorklet
```

Be open about using an AI assistant wherever recording or AI help is restricted, and get consent before transcribing other people where the law requires it.
