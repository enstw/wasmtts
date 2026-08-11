const DRAFT_KEY = 'wasmtts-frequency-ab-score-draft-v1';
const LAST_SUBMISSION_KEY = 'wasmtts-frequency-ab-score-last-v1';
const SCORE_ENDPOINT = '/mobile-host/frequency-ab-score';
const STIMULUS_REPORT_URL = '/frameworks/matcha/samples/frequency-ab/frequency-ab.json';
const VARIANTS = ['A', 'B', 'C', 'D'];
const SOURCES = {
  A: '/frameworks/matcha/samples/frequency-ab/A.wav',
  B: '/frameworks/matcha/samples/frequency-ab/B.wav',
  C: '/frameworks/matcha/samples/frequency-ab/C.mp3',
  D: '/frameworks/matcha/samples/frequency-ab/D.wav',
};
const DIMENSIONS = [
  {key: 'boxiness', label: '箱音／鼓聲', low: '幾乎沒有', high: '非常嚴重'},
  {key: 'clarity', label: '清晰度', low: '模糊', high: '清楚'},
  {key: 'naturalness', label: '自然度', low: '不自然', high: '自然'},
];

const $ = (selector) => document.querySelector(selector);
const scoreForm = $('#scoreForm');
const sampleList = $('#sampleList');
const preferenceOptions = $('#preferenceOptions');
const formStatus = $('#formStatus');
let stimulusReport = null;
let lastSubmission = null;

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function shuffledVariants() {
  const output = [...VARIANTS];
  const random = new Uint32Array(output.length - 1);
  globalThis.crypto.getRandomValues(random);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = random[index - 1] % (index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function validOrder(value) {
  return Array.isArray(value)
    && value.length === VARIANTS.length
    && new Set(value).size === VARIANTS.length
    && value.every((variant) => VARIANTS.includes(variant));
}

function freshDraft() {
  return {
    schemaVersion: 1,
    sessionId: randomId(),
    startedAt: new Date().toISOString(),
    presentationOrder: shuffledVariants(),
    playedVariants: [],
    participantLabel: '',
    listeningDevice: '',
    ratings: {},
    bestVariant: '',
    overallNotes: '',
  };
}

function readDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (
      stored?.schemaVersion === 1
      && typeof stored.sessionId === 'string'
      && validOrder(stored.presentationOrder)
    ) {
      return {
        ...freshDraft(),
        ...stored,
        playedVariants: Array.isArray(stored.playedVariants)
          ? stored.playedVariants.filter((variant) => VARIANTS.includes(variant))
          : [],
        ratings: stored.ratings && typeof stored.ratings === 'object' ? stored.ratings : {},
      };
    }
  } catch {
    // 損壞的 localStorage 草稿直接重建，不阻擋試聽。
  }
  return freshDraft();
}

let draft = readDraft();

function writeDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function optionMarkup(name, value, checked) {
  return `<label><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} required><span>${value}</span></label>`;
}

function dimensionMarkup(variant, dimension) {
  const selected = Number(draft.ratings?.[variant]?.[dimension.key]);
  const name = `${dimension.key}-${variant}`;
  return `
    <fieldset class="rating-fieldset">
      <legend>${dimension.label}</legend>
      <div class="scale-hint"><span>${dimension.low}</span><span>${dimension.high}</span></div>
      <div class="scale-options">
        ${[1, 2, 3, 4, 5].map((value) => optionMarkup(name, value, selected === value)).join('')}
      </div>
    </fieldset>`;
}

function renderSamples() {
  sampleList.innerHTML = draft.presentationOrder.map((variant, index) => {
    const played = draft.playedVariants.includes(variant);
    const notes = draft.ratings?.[variant]?.notes ?? '';
    return `
      <article class="panel sample-card" data-variant="${variant}" data-played="${played}">
        <header class="sample-head">
          <div class="sample-title">
            <span class="sample-number">${String(index + 1).padStart(2, '0')}</span>
            <h2>匿名樣本 ${index + 1}</h2>
          </div>
          <span class="listen-state">${played ? '已播放' : '尚未播放'}</span>
        </header>
        <audio controls preload="metadata" src="${SOURCES[variant]}"></audio>
        <div class="rating-grid">
          ${DIMENSIONS.map((dimension) => dimensionMarkup(variant, dimension)).join('')}
        </div>
        <label class="field sample-notes">
          <span>這段的備註（選填）</span>
          <textarea name="notes-${variant}" maxlength="500" rows="2" placeholder="記錄特定字句、頻段或聽感">${escapeHtml(notes)}</textarea>
        </label>
      </article>`;
  }).join('');

  preferenceOptions.innerHTML = draft.presentationOrder.map((variant, index) => `
    <label>
      <input type="radio" name="bestVariant" value="${variant}" ${draft.bestVariant === variant ? 'checked' : ''} required>
      <span>樣本 ${index + 1}</span>
    </label>`).join('');

  for (const audio of sampleList.querySelectorAll('audio')) {
    audio.addEventListener('play', () => handlePlay(audio));
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function handlePlay(activeAudio) {
  for (const audio of sampleList.querySelectorAll('audio')) {
    if (audio !== activeAudio) audio.pause();
  }
  const card = activeAudio.closest('.sample-card');
  const variant = card.dataset.variant;
  if (!draft.playedVariants.includes(variant)) draft.playedVariants.push(variant);
  card.dataset.played = 'true';
  card.querySelector('.listen-state').textContent = '已播放';
  writeDraft();
  updateProgress();
}

function syncDraftFromForm() {
  draft.participantLabel = $('#participantLabel').value.trim();
  draft.listeningDevice = $('#listeningDevice').value;
  draft.overallNotes = $('#overallNotes').value.trim();
  draft.bestVariant = scoreForm.elements.bestVariant?.value ?? '';
  for (const variant of VARIANTS) {
    const current = draft.ratings[variant] ?? {};
    for (const dimension of DIMENSIONS) {
      const value = scoreForm.elements[`${dimension.key}-${variant}`]?.value;
      if (value) current[dimension.key] = Number(value);
      else delete current[dimension.key];
    }
    current.notes = scoreForm.elements[`notes-${variant}`]?.value.trim() ?? '';
    draft.ratings[variant] = current;
  }
  writeDraft();
  updateProgress();
}

function completedRatingCount() {
  return VARIANTS.reduce((total, variant) => total + DIMENSIONS.filter(
    (dimension) => Number.isInteger(draft.ratings?.[variant]?.[dimension.key]),
  ).length, 0);
}

function updateProgress() {
  const played = new Set(draft.playedVariants).size;
  const scores = completedRatingCount();
  const preference = draft.bestVariant ? 1 : 0;
  const completed = played + scores + preference;
  const total = VARIANTS.length + VARIANTS.length * DIMENSIONS.length + 1;
  const percentage = Math.round(completed / total * 100);
  $('#scoreProgress').value = percentage;
  $('#progressValue').textContent = `${percentage}%`;
  $('#progressLabel').textContent = `已播放 ${played}/4 · 已評 ${scores}/12 · 最佳版本 ${preference ? '已選' : '未選'}`;
}

function stimulusSet() {
  if (!stimulusReport) throw new Error('尚未載入音訊版本資料');
  return {
    generatedAt: stimulusReport.generatedAt,
    sha256: Object.fromEntries(
      VARIANTS.map((variant) => [variant, stimulusReport.variants[variant].sha256]),
    ),
  };
}

function buildSubmission() {
  syncDraftFromForm();
  return {
    schemaVersion: 1,
    sessionId: draft.sessionId,
    participantLabel: draft.participantLabel,
    listeningDevice: draft.listeningDevice,
    startedAt: draft.startedAt,
    submittedAt: new Date().toISOString(),
    presentationOrder: [...draft.presentationOrder],
    playedVariants: [...new Set(draft.playedVariants)],
    bestVariant: draft.bestVariant,
    ratings: draft.presentationOrder.map((variant, index) => ({
      variant,
      presentationIndex: index + 1,
      boxiness: draft.ratings[variant]?.boxiness,
      clarity: draft.ratings[variant]?.clarity,
      naturalness: draft.ratings[variant]?.naturalness,
      notes: draft.ratings[variant]?.notes ?? '',
    })),
    overallNotes: draft.overallNotes,
    stimulusSet: stimulusSet(),
  };
}

function missingMessage() {
  const missing = [];
  if (!draft.listeningDevice) missing.push('播放設備');
  const unplayed = VARIANTS.filter((variant) => !draft.playedVariants.includes(variant));
  if (unplayed.length) missing.push(`${unplayed.length} 段尚未播放`);
  const scoreCount = completedRatingCount();
  if (scoreCount < 12) missing.push(`${12 - scoreCount} 項尚未評分`);
  if (!draft.bestVariant) missing.push('整體最佳樣本');
  return missing.length ? `請先完成：${missing.join('、')}。` : '';
}

function validateSubmission() {
  syncDraftFromForm();
  const message = missingMessage();
  if (message) {
    formStatus.textContent = message;
    formStatus.className = 'form-status full-width error';
    scoreForm.reportValidity();
    return false;
  }
  return true;
}

function downloadJson(submission = null) {
  try {
    const value = submission ?? buildSubmission();
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `matcha-frequency-ab-score-${value.sessionId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    formStatus.textContent = '已下載目前評分 JSON。';
    formStatus.className = 'form-status full-width success';
  } catch (error) {
    formStatus.textContent = error.message;
    formStatus.className = 'form-status full-width error';
  }
}

async function submitScore(event) {
  event.preventDefault();
  if (!validateSubmission()) return;
  const submission = buildSubmission();
  const submitButton = scoreForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  formStatus.textContent = '正在保存至本機 host…';
  formStatus.className = 'form-status full-width';
  try {
    const response = await fetch(SCORE_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(submission),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    lastSubmission = {...submission, submissionId: result.submissionId};
    localStorage.setItem(LAST_SUBMISSION_KEY, JSON.stringify(lastSubmission));
    localStorage.removeItem(DRAFT_KEY);
    scoreForm.hidden = true;
    $('#successPanel').hidden = false;
    $('#successMessage').textContent = `本機第 ${result.count} 筆；submission ID：${result.submissionId}`;
    $('#submissionCount').textContent = `${result.count} 筆`;
    $('#successPanel').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    formStatus.textContent = `尚未保存：${error.message}。草稿仍在瀏覽器，可先下載 JSON。`;
    formStatus.className = 'form-status full-width error';
  } finally {
    submitButton.disabled = false;
  }
}

function newEvaluation() {
  for (const audio of sampleList.querySelectorAll('audio')) {
    audio.pause();
  }
  draft = freshDraft();
  writeDraft();
  scoreForm.reset();
  $('#participantLabel').value = '';
  $('#listeningDevice').value = '';
  $('#overallNotes').value = '';
  renderSamples();
  scoreForm.hidden = false;
  $('#successPanel').hidden = true;
  formStatus.textContent = '';
  updateProgress();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

async function loadSubmissionCount() {
  try {
    const response = await fetch(SCORE_ENDPOINT, {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    $('#submissionCount').textContent = `${result.count} 筆`;
  } catch {
    $('#submissionCount').textContent = '無法讀取';
  }
}

async function initialize() {
  try {
    const response = await fetch(STIMULUS_REPORT_URL, {cache: 'no-store'});
    if (!response.ok) throw new Error(`音訊版本資料 HTTP ${response.status}`);
    stimulusReport = await response.json();
    for (const variant of VARIANTS) {
      if (!stimulusReport.variants?.[variant]?.sha256) {
        throw new Error(`音訊版本資料缺少 ${variant}`);
      }
    }
  } catch (error) {
    formStatus.textContent = `無法開始評分：${error.message}`;
    formStatus.className = 'form-status full-width error';
    scoreForm.querySelector('button[type="submit"]').disabled = true;
  }

  $('#participantLabel').value = draft.participantLabel;
  $('#listeningDevice').value = draft.listeningDevice;
  $('#overallNotes').value = draft.overallNotes;
  renderSamples();
  updateProgress();
  writeDraft();
  await loadSubmissionCount();
}

scoreForm.addEventListener('input', syncDraftFromForm);
scoreForm.addEventListener('change', syncDraftFromForm);
scoreForm.addEventListener('submit', submitScore);
$('#downloadBtn').addEventListener('click', () => downloadJson());
$('#successDownloadBtn').addEventListener('click', () => {
  if (lastSubmission) downloadJson(lastSubmission);
});
$('#newEvaluationBtn').addEventListener('click', newEvaluation);

initialize();
