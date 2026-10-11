'use strict';

const STORAGE = { learner: 'bhasha.learnerId', session: 'bhasha.sessionId', lang: 'bhasha.lang' };

const UI_TEXT = {
  en: {
    thinking: 'Bhasha is thinking about your reasoning…',
    starting: 'Setting up your session…',
    tutor: 'Bhasha', you: 'You',
    reasoning: 'Your reasoning', misconception: 'Misconception spotted', hint: 'Hint', example: 'Example',
    answer: 'Full explanation', question: 'Next question',
    assessments: { correct: 'On track ✓', partially_correct: 'Partly there', misconception: 'Let’s rethink this', uncertain: 'Unsure — that’s okay', insufficient_evidence: 'Tell me more' },
  },
  hi: {
    thinking: 'भाषा आपकी सोच को समझ रही है…',
    starting: 'आपका सत्र तैयार हो रहा है…',
    tutor: 'भाषा', you: 'आप',
    reasoning: 'आपकी सोच', misconception: 'एक गलतफहमी', hint: 'संकेत', example: 'उदाहरण',
    answer: 'पूरी व्याख्या', question: 'अगला सवाल',
    assessments: { correct: 'सही दिशा ✓', partially_correct: 'आंशिक रूप से सही', misconception: 'फिर से सोचें', uncertain: 'संदेह है — कोई बात नहीं', insufficient_evidence: 'थोड़ा और बताइए' },
  },
};

const STARTERS = {
  en: [
    { subject: 'Physics', topic: "Newton's third law", doubt: 'If action and reaction are equal and opposite, why doesn’t everything cancel out and stay still?' },
    { subject: 'Mathematics', topic: 'Fractions', doubt: 'Why is 1/3 bigger than 1/4 when 4 is bigger than 3?' },
    { subject: 'Biology', topic: 'Photosynthesis', doubt: 'Where does most of a tree’s mass actually come from — the soil?' },
    { subject: 'Chemistry', topic: 'Acids and bases', doubt: 'Is a strong acid the same as a concentrated acid?' },
  ],
  hi: [
    { subject: 'भौतिकी', topic: 'न्यूटन का तीसरा नियम', doubt: 'अगर क्रिया और प्रतिक्रिया बराबर और विपरीत हैं, तो सब कुछ रुक क्यों नहीं जाता?' },
    { subject: 'गणित', topic: 'भिन्न', doubt: '1/3, 1/4 से बड़ा क्यों है जबकि 4, 3 से बड़ा है?' },
    { subject: 'जीवविज्ञान', topic: 'प्रकाश संश्लेषण', doubt: 'पेड़ का ज़्यादातर वज़न कहाँ से आता है — मिट्टी से?' },
    { subject: 'रसायन', topic: 'अम्ल और क्षार', doubt: 'क्या प्रबल अम्ल और सांद्र अम्ल एक ही बात है?' },
  ],
};

const STATUS_LABEL = { new: 'New', learning: 'Learning', progressing: 'Progressing', mastered: 'Mastered' };

const $ = (id) => document.getElementById(id);
const state = {
  learnerId: safeGet(STORAGE.learner),
  sessionId: safeGet(STORAGE.session),
  lang: safeGet(STORAGE.lang) === 'hi' ? 'hi' : 'en',
  busy: false,
};

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the Bhasha server. Is it running?'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------------- Language ---------------- */

function setLanguage(lang) {
  state.lang = lang;
  safeSet(STORAGE.lang, lang);
  document.documentElement.lang = lang;
  document.querySelectorAll('.lang-btn').forEach((b) => {
    const on = b.dataset.lang === lang;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  renderStarters();
}

function renderStarters() {
  const list = $('starter-list');
  list.replaceChildren();
  for (const s of STARTERS[state.lang]) {
    const chip = el('button', 'chip', s.doubt);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      $('subject').value = s.subject;
      $('topic').value = s.topic;
      $('doubt').value = s.doubt;
      $('doubt').focus();
    });
    list.append(chip);
  }
}

/* ---------------- Learner profile ---------------- */

function showApp(profile) {
  $('welcome').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('learner-chip').classList.remove('hidden');
  $('learner-chip').textContent = `👋 ${profile.nickname}`;
  renderProfile(profile);
}

function renderProfile(profile) {
  const stats = [
    [profile.stats.sessions, 'Sessions'],
    [profile.stats.responses, 'Answers given'],
    [profile.stats.hints, 'Hints received'],
    [profile.stats.mastered, 'Topics mastered'],
  ];
  $('stats').replaceChildren(...stats.map(([n, label]) => {
    const box = el('div', 'stat');
    box.append(el('b', null, String(n)), el('span', null, label));
    return box;
  }));

  const topics = $('topic-list');
  topics.replaceChildren();
  if (!profile.topics.length) topics.append(el('p', 'empty', 'Topics you study will appear here.'));
  for (const t of profile.topics.slice(0, 8)) {
    const row = el('div', 'topic-item');
    row.title = `${t.correctCount} correct · ${t.misconceptionCount} misconceptions · streak ${t.correctStreak}`;
    row.append(el('span', 't-name', `${t.subject} · ${t.topic}`), el('span', `status ${t.status}`, STATUS_LABEL[t.status] || t.status));
    topics.append(row);
  }

  const list = $('misconception-list');
  list.replaceChildren();
  if (!profile.misconceptions.length) list.append(el('li', 'empty', 'None recorded yet.'));
  for (const m of profile.misconceptions.slice(0, 8)) {
    const li = el('li');
    li.append(el('div', 'm-topic', `${m.subject} · ${m.topic} · ${new Date(m.at).toLocaleDateString()}`), el('div', null, m.label));
    if (m.explanation) li.title = m.explanation;
    list.append(li);
  }
}

async function registerLearner(nickname) {
  const profile = await api('/api/learners', { method: 'POST', body: { nickname, learnerId: state.learnerId || undefined } });
  state.learnerId = profile.id;
  safeSet(STORAGE.learner, profile.id);
  return profile;
}

/* ---------------- Chat rendering ---------------- */

function addSection(parent, label, text, className) {
  if (!text) return;
  const wrap = el('div', className || 'section');
  wrap.append(el('div', 'section-label', label), el('div', null, text));
  parent.append(wrap);
}

function renderTurn(turn) {
  const t = UI_TEXT[state.lang];
  const msg = el('div', `msg ${turn.role}`);
  if (turn.role === 'student') {
    msg.textContent = turn.text;
  } else {
    msg.append(el('div', 'who', t.tutor));
    if (turn.kind === 'opening') {
      msg.append(el('div', null, turn.text));
    } else {
      if (turn.assessment) msg.append(el('span', `badge ${turn.assessment}`, t.assessments[turn.assessment]));
      addSection(msg, t.reasoning, turn.reasoningSummary);
      if (turn.misconception) {
        const box = el('div', 'box misc');
        box.append(el('div', 'section-label', `${t.misconception}: ${turn.misconception.label}`), el('div', null, turn.misconception.explanation));
        msg.append(box);
      }
      if (turn.hint || turn.example) {
        const box = el('div', 'box hint');
        addSection(box, t.hint, turn.hint);
        addSection(box, t.example, turn.example);
        msg.append(box);
      }
      if (turn.revealed) addSection(msg, t.answer, turn.finalExplanation, 'box final');
      if (turn.nextQuestion) msg.append(el('div', 'question', `❓ ${turn.nextQuestion}`));
      if (turn.encouragement) msg.append(el('div', 'encourage', turn.encouragement));
    }
  }
  $('chat').append(msg);
  $('chat').scrollTop = $('chat').scrollHeight;
}

function showChat(session) {
  $('setup').classList.add('hidden');
  $('chat-card').classList.remove('hidden');
  $('chat-subject').textContent = session.subject;
  $('chat-topic').textContent = session.topic;
  $('chat-doubt').textContent = `“${session.doubt}”`;
  $('chat').replaceChildren();
  session.turns.forEach(renderTurn);
  $('reply').focus();
}

function setBusy(busy, text) {
  state.busy = busy;
  $('loading').classList.toggle('hidden', !busy);
  $('loading-text').textContent = text || UI_TEXT[state.lang].thinking;
  $('send-btn').disabled = busy;
  $('start-btn').disabled = busy;
  $('reply').disabled = busy;
}

function resetToSetup() {
  state.sessionId = null;
  safeSet(STORAGE.session, null);
  $('chat-card').classList.add('hidden');
  $('setup').classList.remove('hidden');
  $('doubt-form').reset();
  $('chat-error').textContent = '';
  $('subject').focus();
}

/* ---------------- Event handlers ---------------- */

$('nickname-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('nickname-error').textContent = '';
  try {
    showApp(await registerLearner($('nickname').value.trim()));
  } catch (err) {
    $('nickname-error').textContent = err.message;
  }
});

$('doubt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  $('setup-error').textContent = '';
  const body = {
    learnerId: state.learnerId,
    subject: $('subject').value.trim(),
    topic: $('topic').value.trim(),
    doubt: $('doubt').value.trim(),
    language: state.lang,
  };
  $('start-btn').disabled = true;
  try {
    const data = await api('/api/sessions', { method: 'POST', body });
    state.sessionId = data.sessionId;
    safeSet(STORAGE.session, data.sessionId);
    showChat({ ...body, turns: data.turns });
    renderProfile(data.profile);
  } catch (err) {
    $('setup-error').textContent = err.message;
  } finally {
    $('start-btn').disabled = false;
  }
});

$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('reply').value.trim();
  if (!text || state.busy) return;
  $('chat-error').textContent = '';
  renderTurn({ role: 'student', text });
  const pending = $('chat').lastElementChild;
  $('reply').value = '';
  setBusy(true);
  try {
    const data = await api(`/api/sessions/${state.sessionId}/messages`, {
      method: 'POST', body: { learnerId: state.learnerId, message: text, language: state.lang },
    });
    renderTurn(data.turn);
    renderProfile(data.profile);
  } catch (err) {
    // The server didn't save this answer; put it back so the student can retry.
    pending.remove();
    $('reply').value = text;
    $('chat-error').textContent = err.message;
  } finally {
    setBusy(false);
    $('reply').focus();
  }
});

$('reply').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('reply-form').requestSubmit();
  }
});

$('new-session').addEventListener('click', resetToSetup);

$('switch-learner').addEventListener('click', () => {
  state.learnerId = null;
  safeSet(STORAGE.learner, null);
  safeSet(STORAGE.session, null);
  location.reload();
});

document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

/* ---------------- Startup ---------------- */

async function init() {
  setLanguage(state.lang);

  api('/api/health').then((h) => {
    if (!h.apiKeyConfigured) {
      $('api-warning').textContent = '⚠️ The server has no Sarvam API key configured. Add SARVAM_API_KEY to .env and restart the server.';
      $('api-warning').classList.remove('hidden');
    }
  }).catch(() => {});

  if (!state.learnerId) {
    $('welcome').classList.remove('hidden');
    $('nickname').focus();
    return;
  }

  try {
    showApp(await api(`/api/learners/${state.learnerId}`));
  } catch {
    // Saved ID is unknown to the server (e.g. data file removed); ask for a nickname again.
    safeSet(STORAGE.learner, null);
    state.learnerId = null;
    $('welcome').classList.remove('hidden');
    return;
  }

  if (state.sessionId) {
    try {
      showChat(await api(`/api/sessions/${state.sessionId}?learnerId=${encodeURIComponent(state.learnerId)}`));
    } catch {
      safeSet(STORAGE.session, null);
      state.sessionId = null;
    }
  }
}

init();
