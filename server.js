'use strict';

const path = require('path');
// Load .env from the project root, regardless of the directory the server is started from.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const fs = require('fs/promises');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SARVAM_URL = 'https://api.sarvam.ai/v1/chat/completions';
const SARVAM_MODEL = 'sarvam-105b';
const MAX_TOKENS = 1200; // includes reasoning tokens; keeps cost per turn bounded
// Reasoning tokens are billed and even "low" can use ~1.5k tokens, so it is off by default.
const REASONING_EFFORT = ['low', 'medium', 'high'].includes(process.env.SARVAM_REASONING_EFFORT)
  ? process.env.SARVAM_REASONING_EFFORT : null;
const REQUEST_TIMEOUT_MS = 60_000;
// Override with DATA_DIR to point at a persistent disk in production.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'learners.json');

// Minimum number of student replies in a session before the full answer may be revealed.
const MIN_TURNS_BEFORE_REVEAL = 3;
// Consecutive correct answers needed (within a topic) before marking it mastered.
const MASTERY_STREAK = 3;

const LANGUAGES = { en: 'English', hi: 'Hindi' };
const ASSESSMENTS = ['correct', 'partially_correct', 'misconception', 'uncertain', 'insufficient_evidence'];

/* ------------------------------------------------------------------ */
/* Storage: one JSON file, atomic writes, serialized through a queue. */
/* ------------------------------------------------------------------ */

let db = { learners: {} };
let writeQueue = Promise.resolve();

async function loadDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.learners === 'object') db = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep a copy of the unreadable file rather than silently overwriting it.
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      await fs.copyFile(DATA_FILE, backup).catch(() => {});
      console.error(`Could not read ${DATA_FILE}; backed up to ${backup}. Starting fresh.`);
    }
    await saveDb();
  }
}

function saveDb() {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, DATA_FILE);
  }).catch((err) => console.error('Failed to save learner data:', err.message));
  return writeQueue;
}

/* ----------------------------- Helpers ----------------------------- */

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function topicKey(subject, topic) {
  return `${subject.toLowerCase()}::${topic.toLowerCase()}`;
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function getLearner(id) {
  if (!isValidId(id)) throw httpError(400, 'Invalid learner ID.');
  const learner = db.learners[id];
  if (!learner) throw httpError(404, 'Learner not found. Please enter your nickname again.');
  return learner;
}

function publicProfile(learner) {
  const topics = Object.values(learner.topics).sort((a, b) => b.lastStudied.localeCompare(a.lastStudied));
  return {
    id: learner.id,
    nickname: learner.nickname,
    createdAt: learner.createdAt,
    stats: {
      sessions: learner.sessions.length,
      responses: learner.sessions.reduce((n, s) => n + s.turns.filter((t) => t.role === 'student').length, 0),
      hints: learner.sessions.reduce((n, s) => n + s.turns.filter((t) => t.role === 'tutor' && t.hint).length, 0),
      mastered: topics.filter((t) => t.status === 'mastered').length,
    },
    topics,
    misconceptions: learner.misconceptions.slice(-20).reverse(),
    recentSessions: learner.sessions.slice(-5).reverse().map((s) => ({
      id: s.id, subject: s.subject, topic: s.topic, doubt: s.doubt, language: s.language,
      startedAt: s.startedAt, turns: s.turns.length,
    })),
  };
}

/* ------------------------- Prompt building ------------------------- */

const SYSTEM_PROMPT = `You are Bhasha AI, a patient Socratic tutor for Indian students.

TEACHING RULES (follow strictly):
1. Teach through guided questioning, NOT direct answers. Never give the full solution early.
2. First analyse the student's own reasoning. Say briefly what they got right and where their thinking went.
3. Ask exactly ONE focused guiding question per reply. It must move the student one small step closer to the concept.
4. Diagnose carefully:
   - "correct": reasoning is right.
   - "partially_correct": on the right track but incomplete.
   - "misconception": a specific, clearly evidenced conceptual error (a wrong belief, not a slip).
   - "uncertain": the student says they don't know / is guessing; this is NOT a misconception.
   - "insufficient_evidence": too little to judge; ask a clarifying question.
   Only label a misconception when the student's words clearly show it.
5. When there is a misconception, explain it in simple, kind, encouraging language. Never shame the student.
6. Give a short conceptual hint and one small, concrete, relatable example (Indian everyday context is welcome).
7. Only set reveal_answer=true when the server says revealing is allowed AND the student has genuinely tried, or has understood and needs a summary. Then put a clear, complete explanation in final_explanation.
8. You know NOTHING about the student's past except the "Saved learner history" provided by the application. Never invent or assume past sessions, scores, or mistakes.

OUTPUT: Respond with ONLY a single JSON object, no markdown fences, using exactly these keys:
{
  "reasoning_summary": "1-2 sentences reflecting the student's reasoning back to them",
  "assessment": "correct | partially_correct | misconception | uncertain | insufficient_evidence",
  "misconception": { "detected": true/false, "label": "short name of the misconception or empty", "explanation": "gentle explanation or empty" },
  "hint": "short conceptual hint",
  "example": "one short relevant example",
  "next_question": "exactly one guiding question (or a reflective check question if the answer was revealed)",
  "reveal_answer": true/false,
  "final_explanation": "full explanation only if reveal_answer is true, else empty",
  "encouragement": "one short warm sentence"
}
Keep every field concise (under 80 words each, final_explanation under 180 words). JSON keys stay in English; all values must be written in the language the application requests.`;

function historyContext(learner, session) {
  const key = topicKey(session.subject, session.topic);
  const topic = learner.topics[key];
  const pastMisconceptions = learner.misconceptions
    .filter((m) => m.sessionId !== session.id)
    .slice(-6)
    .map((m) => `- [${m.subject} / ${m.topic}] ${m.label}`);
  const pastTopics = Object.values(learner.topics)
    .filter((t) => t.key !== key)
    .slice(-5)
    .map((t) => `- ${t.subject} / ${t.topic}: ${t.status}`);

  return [
    'Saved learner history (from the application database; this is the ONLY true information about the past):',
    `- Nickname: ${learner.nickname}`,
    `- Previous sessions: ${learner.sessions.length - 1}`,
    topic && topic.attempts > 0
      ? `- This topic before: status=${topic.status}, correct answers=${topic.correctCount}, misconceptions=${topic.misconceptionCount}`
      : '- This topic: first time studying it.',
    pastMisconceptions.length ? `Earlier misconceptions (check gently whether they still apply):\n${pastMisconceptions.join('\n')}` : 'Earlier misconceptions: none recorded.',
    pastTopics.length ? `Other topics studied:\n${pastTopics.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function buildMessages(learner, session, studentReplies) {
  const lang = LANGUAGES[session.language];
  const revealAllowed = studentReplies >= MIN_TURNS_BEFORE_REVEAL;
  const context = [
    `Subject: ${session.subject}`,
    `Topic: ${session.topic}`,
    `Student's doubt: ${session.doubt}`,
    `Reply language: ${lang}${session.language === 'hi' ? ' (Devanagari script; common technical terms may stay in English in brackets)' : ''}`,
    `Student replies so far in this session: ${studentReplies}. Revealing the full answer is ${revealAllowed ? 'ALLOWED if appropriate' : 'NOT allowed yet'}.`,
    '',
    historyContext(learner, session),
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: context },
  ];

  // Only the most recent turns, to bound prompt size.
  for (const turn of session.turns.slice(-12)) {
    if (turn.role === 'student') {
      messages.push({ role: 'user', content: turn.text });
    } else {
      messages.push({ role: 'assistant', content: turn.raw || turn.text });
    }
  }
  return messages;
}

/* ------------------------- Sarvam API call ------------------------- */

async function callSarvam(messages) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKeyConfigured()) {
    throw httpError(503, 'The server has no Sarvam API key configured. Add SARVAM_API_KEY to the .env file and restart.');
  }

  const body = {
    model: SARVAM_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: REASONING_EFFORT ? MAX_TOKENS + 2500 : MAX_TOKENS,
    reasoning_effort: REASONING_EFFORT,
    response_format: { type: 'json_object' },
  };

  const send = async (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(SARVAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw httpError(504, 'The AI tutor took too long to respond. Please try again.');
      throw httpError(502, 'Could not reach the Sarvam AI service. Check your internet connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await send(body);
  let errorInfo = res.ok ? null : await readError(res);

  // If JSON mode is rejected for any reason, retry once without it; the prompt still asks for JSON.
  if (errorInfo && (res.status === 400 || res.status === 422) && /response_format|json/i.test(errorInfo.message)) {
    const { response_format, ...rest } = body;
    res = await send(rest);
    errorInfo = res.ok ? null : await readError(res);
  }

  if (errorInfo) throw mapSarvamError(res.status, errorInfo);

  let data;
  try {
    data = await res.json();
  } catch {
    throw httpError(502, 'The AI service returned an unreadable response. Please try again.');
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  if (!content.trim()) {
    const reason = choice && choice.finish_reason === 'length' ? ' (the response was cut off)' : '';
    throw httpError(502, `The AI tutor returned an empty response${reason}. Please try again.`);
  }
  return content;
}

async function readError(res) {
  let message = '';
  let code = '';
  try {
    const data = await res.json();
    const e = data && (data.error || data);
    message = String(e.message || e.detail || '');
    code = String(e.code || '');
  } catch { /* body was not JSON */ }
  return { message, code };
}

function mapSarvamError(status, { message, code }) {
  const text = `${code} ${message}`.toLowerCase();
  // Log status and error code only; never the key or request headers.
  console.error(`Sarvam API error: HTTP ${status} ${code || ''}`.trim());

  if (status === 401 || status === 403 || /invalid_api_key|authentication/.test(text)) {
    return httpError(502, 'The Sarvam API key was rejected. Please check SARVAM_API_KEY in .env.');
  }
  if (/insufficient_quota|credit|quota/.test(text) && !/rate_limit/.test(text)) {
    return httpError(503, 'Sarvam API credits appear to be exhausted. Please top up or use another key.');
  }
  if (status === 429 || /rate_limit/.test(text)) {
    return httpError(429, 'Too many requests to the AI tutor right now. Please wait a few seconds and try again.');
  }
  if (status >= 500) {
    return httpError(502, 'The Sarvam AI service is having trouble right now. Please try again shortly.');
  }
  return httpError(502, 'The AI service could not process this request. Please try rephrasing.');
}

/* ----------------------- Model output validation ----------------------- */

function parseModelJson(content) {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateTutorReply(parsed, revealAllowed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const assessment = ASSESSMENTS.includes(parsed.assessment) ? parsed.assessment : 'insufficient_evidence';
  const m = parsed.misconception && typeof parsed.misconception === 'object' ? parsed.misconception : {};
  const label = cleanText(m.label, 120);
  // A misconception is only recorded when the assessment and the details agree.
  const detected = assessment === 'misconception' && m.detected !== false && label.length > 0;

  const reply = {
    reasoningSummary: cleanText(parsed.reasoning_summary, 600),
    assessment,
    misconception: detected ? { label, explanation: cleanText(m.explanation, 700) } : null,
    hint: cleanText(parsed.hint, 600),
    example: cleanText(parsed.example, 600),
    nextQuestion: cleanText(parsed.next_question, 500),
    revealed: false,
    finalExplanation: '',
    encouragement: cleanText(parsed.encouragement, 300),
  };

  // The server, not the model, decides whether revealing is allowed yet.
  if (revealAllowed && parsed.reveal_answer === true) {
    const fin = cleanText(parsed.final_explanation, 1500);
    if (fin) {
      reply.revealed = true;
      reply.finalExplanation = fin;
    }
  }

  if (!reply.nextQuestion && !reply.revealed) return null;
  return reply;
}

/* ------------------------- Progress tracking ------------------------- */

function ensureTopic(learner, subject, topic) {
  const key = topicKey(subject, topic);
  if (!learner.topics[key]) {
    learner.topics[key] = {
      key, subject, topic, status: 'new', attempts: 0, correctCount: 0,
      correctStreak: 0, misconceptionCount: 0, hintsGiven: 0, lastStudied: new Date().toISOString(),
    };
  }
  return learner.topics[key];
}

function updateProgress(topic, reply) {
  topic.attempts += 1;
  topic.lastStudied = new Date().toISOString();
  if (reply.hint) topic.hintsGiven += 1;

  if (reply.assessment === 'correct') {
    topic.correctCount += 1;
    topic.correctStreak += 1;
  } else if (reply.assessment === 'misconception') {
    topic.misconceptionCount += 1;
    topic.correctStreak = 0;
  } else if (reply.assessment !== 'partially_correct') {
    topic.correctStreak = 0;
  }

  // Cautious progression: mastery needs a streak of correct answers, not a single one.
  // A fresh misconception drops a mastered topic back to "progressing".
  if (topic.correctStreak >= MASTERY_STREAK) topic.status = 'mastered';
  else if (topic.status === 'mastered' && reply.assessment !== 'misconception') topic.status = 'mastered';
  else if (topic.correctCount >= 1) topic.status = 'progressing';
  else topic.status = 'learning';
}

/* ----------------------------- Routes ----------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function apiKeyConfigured() {
  const key = process.env.SARVAM_API_KEY;
  return Boolean(key && key !== 'your_sarvam_api_key_here');
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, apiKeyConfigured: apiKeyConfigured(), model: SARVAM_MODEL });
});

// Register a new learner or return an existing one.
app.post('/api/learners', async (req, res) => {
  const nickname = cleanText(req.body && req.body.nickname, 30);
  const existingId = req.body && req.body.learnerId;

  if (existingId && isValidId(existingId) && db.learners[existingId]) {
    const learner = db.learners[existingId];
    if (nickname && nickname !== learner.nickname) learner.nickname = nickname;
    learner.lastSeen = new Date().toISOString();
    await saveDb();
    return res.json(publicProfile(learner));
  }

  if (nickname.length < 2) {
    return res.status(400).json({ error: 'Please enter a nickname with at least 2 characters.' });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.learners[id] = { id, nickname, createdAt: now, lastSeen: now, topics: {}, misconceptions: [], sessions: [] };
  await saveDb();
  res.status(201).json(publicProfile(db.learners[id]));
});

app.get('/api/learners/:id', (req, res) => {
  res.json(publicProfile(getLearner(req.params.id)));
});

const OPENING = {
  en: (topic) => `Before I explain anything, tell me in your own words: what do you currently understand about "${topic}", and how are you thinking about your doubt? It's completely fine to be unsure — just share your thinking.`,
  hi: (topic) => `कुछ भी समझाने से पहले, अपने शब्दों में बताइए: "${topic}" के बारे में आप अभी क्या समझते हैं, और अपने सवाल के बारे में आप कैसे सोच रहे हैं? अगर पक्का नहीं पता तो भी बिल्कुल ठीक है — बस अपनी सोच बताइए।`,
};

// Start a new doubt session. The first tutor turn is a fixed prompt asking for the student's understanding.
app.post('/api/sessions', async (req, res) => {
  const learner = getLearner(req.body && req.body.learnerId);
  const subject = cleanText(req.body.subject, 60);
  const topic = cleanText(req.body.topic, 100);
  const doubt = cleanText(req.body.doubt, 1000);
  const language = req.body.language;

  const missing = [!subject && 'subject', !topic && 'topic', doubt.length < 5 && 'doubt (at least 5 characters)'].filter(Boolean);
  if (missing.length) return res.status(400).json({ error: `Please provide: ${missing.join(', ')}.` });
  if (!LANGUAGES[language]) return res.status(400).json({ error: 'Language must be "en" or "hi".' });

  const session = {
    id: crypto.randomUUID(), subject, topic, doubt, language,
    startedAt: new Date().toISOString(),
    turns: [{ role: 'tutor', kind: 'opening', text: OPENING[language](topic), at: new Date().toISOString() }],
  };
  learner.sessions.push(session);
  const t = ensureTopic(learner, subject, topic);
  t.lastStudied = session.startedAt;
  learner.lastSeen = session.startedAt;
  await saveDb();

  res.status(201).json({ sessionId: session.id, turns: session.turns, profile: publicProfile(learner) });
});

// Student replies in a session; the model analyses and asks the next guiding question.
app.post('/api/sessions/:sessionId/messages', async (req, res) => {
  const learner = getLearner(req.body && req.body.learnerId);
  const session = learner.sessions.find((s) => s.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found. Please start a new doubt.' });

  const text = cleanText(req.body.message, 1500);
  if (!text) return res.status(400).json({ error: 'Please type a response first.' });
  if (req.body.language && LANGUAGES[req.body.language]) session.language = req.body.language;

  const studentReplies = session.turns.filter((t) => t.role === 'student').length + 1;
  const pendingTurn = { role: 'student', text, at: new Date().toISOString() };
  const messages = buildMessages(learner, { ...session, turns: [...session.turns, pendingTurn] }, studentReplies);

  // The model occasionally returns malformed JSON; retry once before giving up.
  let reply = null;
  for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
    const content = await callSarvam(messages);
    reply = validateTutorReply(parseModelJson(content), studentReplies >= MIN_TURNS_BEFORE_REVEAL);
    if (!reply) console.error(`Model output failed validation (attempt ${attempt}): ${content.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  if (!reply) {
    throw httpError(502, 'The AI tutor gave a response I could not understand. Please send your answer again.');
  }

  // Only persist the student's turn once we have a valid tutor reply, so retries don't duplicate it.
  session.turns.push(pendingTurn);
  const tutorTurn = {
    role: 'tutor', kind: 'guidance', at: new Date().toISOString(), ...reply,
    // Compact JSON of what the tutor said, used as conversation context on later turns.
    raw: JSON.stringify({
      reasoning_summary: reply.reasoningSummary, assessment: reply.assessment,
      misconception: reply.misconception ? { detected: true, ...reply.misconception } : { detected: false, label: '', explanation: '' },
      hint: reply.hint, example: reply.example, next_question: reply.nextQuestion,
      reveal_answer: reply.revealed, final_explanation: reply.finalExplanation, encouragement: reply.encouragement,
    }),
  };
  session.turns.push(tutorTurn);

  const topic = ensureTopic(learner, session.subject, session.topic);
  updateProgress(topic, reply);
  if (reply.misconception) {
    learner.misconceptions.push({
      label: reply.misconception.label, explanation: reply.misconception.explanation,
      subject: session.subject, topic: session.topic, sessionId: session.id, at: tutorTurn.at,
    });
  }
  learner.lastSeen = tutorTurn.at;
  await saveDb();

  const { raw, ...clientTurn } = tutorTurn;
  res.json({ turn: clientTurn, profile: publicProfile(learner) });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const learner = getLearner(req.query.learnerId);
  const session = learner.sessions.find((s) => s.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const turns = session.turns.map(({ raw, ...t }) => t);
  res.json({ ...session, turns });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Express 5 forwards async errors here.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Message is too long.' });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error('Unexpected error:', err.message);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

loadDb().then(() => {
  app.listen(PORT, HOST, () => {
    const keyStatus = apiKeyConfigured() ? 'configured' : 'MISSING (set SARVAM_API_KEY in .env)';
    console.log(`Bhasha AI running at http://localhost:${PORT}  |  Sarvam API key: ${keyStatus}`);
  });
});
