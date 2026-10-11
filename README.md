# Bhasha AI — Doubt Solver

> Understand the why, not just the answer.

A Socratic, multilingual (English / Hindi) doubt solver built for Sarvam Campus '26. Instead of handing out answers, Bhasha AI asks the student to explain their thinking first, analyses that reasoning, flags misconceptions kindly, and guides them one question at a time. It runs on **Sarvam-105B** through Sarvam's Chat Completions V1 API.

## Features

- **Socratic flow.** Each session opens by asking for the student's current understanding. Every tutor reply then gives a reasoning summary, an assessment, a hint, an example, and one guiding question.
- **Misconception detection.** The tutor separates a real misconception from an unsure answer or too little evidence. When it can't tell, it asks a clarifying question.
- **Server-enforced reveal.** The full answer can only be revealed after at least 3 student replies in a session, whatever the model asks for.
- **Persistent learner model.** You only enter a nickname. The browser keeps a random learner ID, and the history lives in `data/learners.json`, which survives server restarts. It records topics studied, every answer, misconceptions, hints given, and progress.
- **Cautious progress.** A topic only becomes "mastered" after 3 correct answers in a row. A new misconception moves it back.
- **History-aware prompts.** Past misconceptions are read from the saved file and passed to the model. The prompt tells the model to trust only that history.
- **Key stays on the server.** The API key is only used server-side, and errors (bad key, no credits, rate limits, network failures, timeouts, malformed output) become friendly messages.

## Setup

Requires Node.js 18+ (it uses the built-in `fetch`).

```bash
npm install
cp .env.example .env
# edit .env and set SARVAM_API_KEY=<your key from https://dashboard.sarvam.ai>
npm start
```

Open http://localhost:3000.

To use a different port, set `PORT=4000` in `.env`.

## Deploying to Render

1. Push the repo to GitHub. `.env`, `node_modules/` and `data/` are git-ignored.
2. On Render, create a **New → Web Service** from the repo:
   - Runtime: **Node**
   - Build command: `npm ci`
   - Start command: `npm start`
3. Under **Environment**, add `SARVAM_API_KEY` with your key. Don't set `PORT`; Render provides it, and the server listens on `0.0.0.0:$PORT`.

**Persistence:** learner history is a JSON file. Render's filesystem is temporary, so without extra setup the history is **wiped on every deploy and restart**, and on the free plan also when the service spins down after inactivity. To keep it:
- Attach a **Persistent Disk** (paid plans only), for example mounted at `/var/data`, and set the environment variable `DATA_DIR=/var/data`.
- Run only **one instance**: a JSON file can't be shared safely between several instances.

Students' browsers keep their learner ID. If the server's data is wiped, the app asks for a nickname again and starts a fresh history.

## Project structure

```
server.js            Express server, Sarvam API client, validation, learner storage
public/index.html    UI markup
public/style.css     Styling (responsive)
public/script.js     Frontend logic (no frameworks)
data/learners.json   Learner history (created automatically, git-ignored)
.env.example         Template for your API key
```

## API (local)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server status and whether a key is configured |
| POST | `/api/learners` | `{nickname, learnerId?}`: create a learner or resume one |
| GET | `/api/learners/:id` | Learner profile, progress, misconceptions |
| POST | `/api/sessions` | `{learnerId, subject, topic, doubt, language: "en"/"hi"}`: start a doubt |
| POST | `/api/sessions/:id/messages` | `{learnerId, message, language}`: send a reply and get guidance |
| GET | `/api/sessions/:id?learnerId=` | Reload a session's conversation |

## Notes

- To keep costs down, each model call uses `max_tokens: 1200` with reasoning disabled (`reasoning_effort: null`). Reasoning tokens are billed, and in testing even `"low"` used about 1,600 tokens per turn. To turn reasoning on, set `SARVAM_REASONING_EFFORT=low|medium|high` in `.env`; the token limit is raised automatically.
- "New doubt" starts a fresh session and leaves the saved history alone. "Switch learner" only clears the ID stored in the browser.
- No passwords, emails, or other personal data are collected.
