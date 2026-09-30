// ─── AI ELIT Solver — content.js ─────────────────────────────────────────────
// Watches for the ELIT form, injects "Answer with AI" button, calls OpenRouter.
// Supports: radio, checkbox, select/matching, text inputs. Hotkey: \

const DEFAULT_MODEL = 'google/gemini-3-flash-preview';
const DEFAULT_REASONING = 'medium';
const MAX_TOKENS = 16384;
const RETRY_COUNT = 2;
const FETCH_TIMEOUT_MS = 60000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => {
    try { chrome.storage.local.get(keys, resolve); }
    catch (_) { resolve({}); }
  });
}

function parseJsonSafe(text) {
  if (!text) return null;

  // Strip <think>...</think> blocks from reasoning models
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Also strip <reasoning>...</reasoning> blocks
  clean = clean.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
  // Strip markdown fences
  clean = clean.replace(/```json|```/gi, '').trim();

  // Direct parse
  try { return JSON.parse(clean); } catch (_) { }

  // Try to find a JSON object  { ... }
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch (_) { } }

  // Try to find a JSON array  [ ... ]
  // Use greedy match for arrays to avoid cutting off nested content
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch (_) { } }

  // Try relaxed number array  [1, 2, 3]
  const numArr = clean.match(/\[[\d,\s]+\]/);
  if (numArr) { try { return JSON.parse(numArr[0]); } catch (_) { } }

  return null;
}

/**
 * Strips heavy inline styles/scripts from HTML to reduce token usage,
 * but keeps structure, text, and image srcs.
 */
function lightweightHTML(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script, style, link').forEach(n => n.remove());
  // Remove style attributes to save tokens
  clone.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  return clone.innerHTML.replace(/\s{2,}/g, ' ').trim().slice(0, 6000);
}

// ─── Form Data Extraction — Robust ──────────────────────────────────────────

function extractQuestionContent(form) {
  // Helper: detect empty/whitespace-only text (including &nbsp; = \u00a0)
  const isEmptyText = (s) => !s || !s.replace(/[\s\u00a0]+/g, '');

  // Find the container that holds answer inputs (checkbox, radio, select)
  // so we can collect all text BEFORE it
  const firstAnswerInput = form.querySelector(
    'input[type="radio"], input[type="checkbox"], select, textarea, input[type="text"]:not([type="hidden"])'
  );
  const answerContainer = firstAnswerInput
    ? firstAnswerInput.closest('table, .answers, .options, [class*="answer"], [class*="option"], div')
    : null;

  // Strategy 1: Dedicated question selectors
  const dedicated = form.querySelector(
    '.test_question, .question-text, [class*="question"], [class*="Question"]'
  );
  if (dedicated) {
    const text = dedicated.innerText.trim();
    const images = extractImages(dedicated);
    if (!isEmptyText(text) || images.length) return { text, images, html: '' };
  }

  // Strategy 2: Find headings (h1-h6) that are NOT inside labels
  for (let lvl = 1; lvl <= 6; lvl++) {
    const headings = form.querySelectorAll(`h${lvl}`);
    for (const h of headings) {
      if (h.closest('label')) continue;
      const text = h.innerText.trim();
      const images = extractImages(h);
      if (!isEmptyText(text) || images.length) return { text, images, html: '' };
    }
  }

  // Strategy 3: Collect ALL <p> elements that are NOT inside labels/answer areas
  // This is critical for questions where code variants are in separate <p> tags
  const paragraphs = form.querySelectorAll('p');
  const collectedTexts = [];
  const collectedImages = [];
  for (const p of paragraphs) {
    if (p.closest('label')) continue;
    // Stop if we've reached the answer input area
    if (answerContainer && answerContainer.contains(p)) continue;
    // Skip paragraphs that come after the first answer input
    if (firstAnswerInput && (p.compareDocumentPosition(firstAnswerInput) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    const text = p.innerText.trim();
    if (!isEmptyText(text)) collectedTexts.push(text);
    collectedImages.push(...extractImages(p));
  }
  if (collectedTexts.length || collectedImages.length) {
    return { text: collectedTexts.join('\n'), images: collectedImages, html: '' };
  }

  // Strategy 4: Text content before the first VISIBLE input element
  const visibleInput = form.querySelector(
    'input[type="radio"], input[type="checkbox"], input[type="text"]:not([name="utf8"]):not([type="hidden"]), select, textarea'
  );
  if (visibleInput) {
    const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT, null);
    let collected = '';
    let node;
    while ((node = walker.nextNode())) {
      if (visibleInput.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      if (node.parentElement && node.parentElement.closest('label')) continue;
      const t = node.textContent.trim();
      if (!isEmptyText(t)) collected += t + ' ';
    }
    collected = collected.trim();
    if (collected) {
      const images = extractImages(form);
      return { text: collected, images, html: '' };
    }
  }

  // Strategy 5: Any images in the form (the question might be entirely an image)
  const allImages = extractImages(form);
  if (allImages.length) return { text: '', images: allImages, html: '' };

  // Strategy 6 (fallback): Send lightweight HTML of the form
  return { text: '', images: [], html: lightweightHTML(form) };
}

function extractImages(container) {
  if (!container) return [];
  const imgs = container.querySelectorAll('img');
  return Array.from(imgs)
    .map(img => {
      try { return new URL(img.src, window.location.href).href; } catch (_) { return img.src; }
    })
    .filter(Boolean);
}

/**
 * Detects question type and extracts all relevant data.
 * Returns { type, question, ... } where type is one of:
 *   'radio_checkbox' | 'matching' | 'text_input' | 'mixed'
 */
function extractFormData(form) {
  const q = extractQuestionContent(form);

  // ── Radio / Checkbox inputs ──
  const radioCheckboxInputs = Array.from(
    form.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  );

  const choices = radioCheckboxInputs.map((input, idx) => {
    let text = '';
    // Try label[for]
    if (input.id) {
      const label = form.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) {
        text = label.innerText.trim();
        // Also check for images inside label
        const labelImgs = extractImages(label);
        if (labelImgs.length) text += ' ' + labelImgs.map(u => `[image: ${u}]`).join(' ');
      }
    }
    // Try parent label
    if (!text) {
      const parentLabel = input.closest('label');
      if (parentLabel) {
        text = parentLabel.innerText.trim();
        const pImgs = extractImages(parentLabel);
        if (pImgs.length) text += ' ' + pImgs.map(u => `[image: ${u}]`).join(' ');
      }
    }
    // Try next sibling text node
    if (!text && input.nextSibling) {
      text = (input.nextSibling.textContent || '').trim();
    }
    if (!text) text = `Option ${idx + 1}`;

    return { idx, id: input.id, value: input.value, name: input.name, text, el: input };
  });

  const isMultiple = radioCheckboxInputs.length > 0 && radioCheckboxInputs[0]?.type === 'checkbox';

  // Group by name
  const groups = {};
  choices.forEach(c => {
    if (!groups[c.name]) groups[c.name] = [];
    groups[c.name].push(c);
  });

  // ── Select (dropdown) inputs — used in matching questions ──
  const selects = Array.from(form.querySelectorAll('select')).filter(sel => {
    // Exclude any non-answer selects (e.g. pagination)
    return sel.options.length > 1;
  });

  // ── Text inputs ──
  const textInputs = Array.from(
    form.querySelectorAll(
      'input[type="text"]:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'
    )
  ).filter(inp => {
    // Exclude search bars or unrelated inputs by checking parent context
    return inp.closest('form') === form || inp.closest('#form');
  });

  // ── Determine type ──
  const hasChoices = choices.length > 0;
  const hasSelects = selects.length > 0;
  const hasTexts = textInputs.length > 0;
  const groupNames = Object.keys(groups);
  const isMatching = hasSelects || (hasChoices && groupNames.length > 1);

  let type = 'radio_checkbox';
  if (isMatching && hasChoices && groupNames.length > 1) type = 'matching';
  else if (hasSelects) type = 'matching';
  else if (hasTexts && !hasChoices) type = 'text_input';
  else if (hasTexts && hasChoices) type = 'mixed';

  return {
    type,
    question: q,
    choices,
    groups,
    isMultiple,
    selects: selects.map((sel, idx) => {
      let statement = '';

      // Strategy 1: label[for="selectId"]
      if (sel.id) {
        const lbl = form.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
        if (lbl) statement = lbl.innerText.trim();
      }

      // Strategy 2: parent label wrapping the select
      if (!statement) {
        const parentLabel = sel.closest('label');
        if (parentLabel) statement = parentLabel.innerText.trim();
      }

      // Strategy 3: Inline select — extract surrounding text from parent node
      // For cases like: "клас Масив -  _[dropdown]_"
      // Must run BEFORE the broad container search to avoid grabbing unrelated text
      if (!statement) {
        try {
          const parent = sel.parentElement;
          if (parent) {
            const hasInlineText = Array.from(parent.childNodes).some(n =>
              n !== sel && n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 2
            );
            if (hasInlineText) {
              const contextParts = [];
              for (const child of parent.childNodes) {
                if (child === sel) {
                  contextParts.push(`[___GAP_${idx + 1}___]`);
                } else if (child.nodeType === Node.TEXT_NODE) {
                  const t = child.textContent.trim();
                  if (t) contextParts.push(t);
                } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'SELECT') {
                  const t = child.innerText?.trim();
                  if (t) contextParts.push(t);
                }
              }
              const ctx = contextParts.join(' ').trim();
              if (ctx && ctx !== `[___GAP_${idx + 1}___]`) statement = ctx;
            }
          }
        } catch (_) { /* never crash extraction */ }
      }

      // Strategy 4: closest row/cell container — take first text element that isn't the select itself
      if (!statement) {
        const row = sel.closest('tr, .matching-item, .match-row, [class*="match"], .form-group, p, div');
        if (row) {
          const textEls = row.querySelectorAll('td, span, p, label, div');
          for (const el of textEls) {
            if (el.contains(sel)) continue;
            const t = el.innerText.trim();
            if (t && t.length > 1) { statement = t; break; }
          }
        }
      }

      // Strategy 5: previousElementSibling (original fallback)
      if (!statement) {
        const prev = sel.previousElementSibling;
        if (prev && !prev.querySelector('select')) {
          statement = prev.innerText.trim();
        }
      }

      const options = Array.from(sel.options)
        .filter(o => o.value) // exclude empty placeholder options
        .map(o => ({ value: o.value, text: o.text.trim() }));

      // PATCH: Detect if this select is inline (embedded within text)
      const isInline = Boolean(
        sel.parentElement &&
        !sel.closest('table') &&
        sel.parentElement.childNodes.length > 1 &&
        Array.from(sel.parentElement.childNodes).some(n =>
          n !== sel && n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 2
        )
      );
      return { idx, el: sel, statement, options, isInline };
    }),
    textInputs: textInputs.map((inp, idx) => {
      // Try to find a label for this input
      let label = '';
      if (inp.id) {
        const lbl = form.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
        if (lbl) label = lbl.innerText.trim();
      }
      if (!label && inp.placeholder) label = inp.placeholder;
      if (!label) {
        const prev = inp.previousElementSibling;
        if (prev) label = prev.innerText?.trim() || '';
      }

      // PATCH: Extract surrounding text for context (ordering/numbering tasks)
      let surroundingText = '';
      try {
        const parentRow = inp.closest('tr, li, .form-group, div');
        if (parentRow) {
          // Get text excluding the input itself
          const clone = parentRow.cloneNode(true);
          clone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
          surroundingText = clone.innerText.trim().replace(/\s+/g, ' ').slice(0, 200);
        }
      } catch (_) { /* never crash extraction */ }

      return { idx, el: inp, label, isTextarea: inp.tagName === 'TEXTAREA', surroundingText };
    })
  };
}

// ─── Build Prompt ──────────────────────────────────────────────────────────────

function buildQuestionContext(q) {
  let ctx = '';
  if (q.text) ctx += q.text;
  if (q.images && q.images.length) {
    ctx += '\n\n[The question contains images: ' + q.images.join(', ') + ']';
  }
  if (!q.text && q.html) {
    ctx += '\n\n[The question text could not be extracted cleanly. Here is the HTML of the question block:]\n' + q.html;
  }
  return ctx || '[No question text could be extracted — analyze the answer options to infer the question]';
}

// ─── Resolve Model Config from Profile ──────────────────────────────────────

/**
 * Determines which model and reasoning level to use based on the active profile
 * and the detected task type.
 * @param {string} taskType — one of: radio_single, radio_multiple, matching, text_input, image, mixed
 * @returns {{ model: string, reasoning: string }}
 */
async function resolveModelConfig(taskType) {
  const { profiles, activeProfile, model, reasoningLevel } = await getStorage([
    'profiles', 'activeProfile', 'model', 'reasoningLevel'
  ]);

  // New profile-based system
  if (profiles && activeProfile && profiles[activeProfile]) {
    const profile = profiles[activeProfile];
    const assignment = profile.assignments && profile.assignments[taskType];
    if (assignment && assignment.model) {
      return { model: assignment.model, reasoning: assignment.reasoning || DEFAULT_REASONING };
    }
  }

  // Legacy fallback: single model + single reasoning level
  return {
    model: model || DEFAULT_MODEL,
    reasoning: reasoningLevel || DEFAULT_REASONING,
  };
}

/**
 * Detects the specific task type key for profile-based model resolution.
 */
function detectTaskType(formData) {
  const hasImages = formData.question && formData.question.images && formData.question.images.length > 0;
  if (hasImages) return 'image';
  if (formData.type === 'matching') return 'matching';
  if (formData.type === 'text_input') return 'text_input';
  if (formData.type === 'mixed') return 'mixed';
  if (formData.isMultiple) return 'radio_multiple';
  return 'radio_single';
}

// ─── OpenRouter API Call — Generic ──────────────────────────────────────────

async function callOpenRouterGeneric(systemPrompt, userPrompt, retryNum = 0, modelConfig = null) {
  const { apiKey, debugMode } = await getStorage(['apiKey', 'debugMode']);

  if (!apiKey) {
    showToast('⚠️ API key not set. Open the extension popup.', 'error');
    return null;
  }

  const usedModel = (modelConfig && modelConfig.model) || DEFAULT_MODEL;
  const effort = (modelConfig && modelConfig.reasoning) || DEFAULT_REASONING;

  // Escalating temperature on retries for diversity
  const temps = [0.3, 0.5, 0.7];
  const temperature = temps[Math.min(retryNum, temps.length - 1)];

  // Build request body
  const requestBody = {
    model: usedModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' }
  };

  // Add reasoning if not "none"
  if (effort !== 'none') {
    requestBody.reasoning = { effort, exclude: true };
  }

  // Debug logging
  if (debugMode) {
    console.group(`[AI ELIT] API Call (attempt ${retryNum + 1})`);
    console.log('Model:', usedModel);
    console.log('Reasoning:', effort);
    console.log('Temperature:', temperature);
    console.log('System prompt:', systemPrompt);
    console.log('User prompt:', userPrompt);
    console.groupEnd();
  }

  // Timeout via AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'AI ELIT Solver'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${response.status}`;
      if (debugMode) console.error('[AI ELIT] API Error:', err);
      showToast(`❌ API Error: ${msg}`, 'error');
      return null;
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();

    if (debugMode) {
      console.group(`[AI ELIT] API Response (attempt ${retryNum + 1})`);
      console.log('Raw response:', raw);
      console.log('Usage:', data?.usage);
      console.groupEnd();
    }

    return raw || null;

  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === 'AbortError' ? 'Request timed out (60s)' : err.message;
    showToast(`❌ Network error: ${msg}`, 'error');
    return null;
  }
}

// ─── Solvers for Each Question Type ────────────────────────────────────────

async function solveRadioCheckbox(formData, modelConfig) {
  const { question, choices, isMultiple } = formData;
  const questionCtx = buildQuestionContext(question);

  const optionsList = choices.map((c, i) => `  [${i}] ${c.text}`).join('\n');

  const selectionMode = isMultiple
    ? 'MULTIPLE CORRECT ANSWERS are possible — select ALL that apply.'
    : 'Only ONE answer is correct.';

  const systemPrompt = `You are an expert academic test-solving assistant with deep knowledge across all subjects including science, mathematics, history, literature, programming, law, economics, and more.

Your task: analyze the question, think step by step, then identify the correct answer(s).

You MUST respond with a JSON object in this exact format:
{"reasoning": "your step-by-step analysis here", "answer": [0]}

Rules:
1. In "reasoning": analyze the question, consider each option, explain why each is correct or incorrect.
2. In "answer": provide a JSON array of 0-based integer indices of the correct option(s).
3. Think carefully before answering. Consider edge cases, tricky wording, and common mistakes.
4. If the question is in a non-English language, answer based on the content regardless of language.
5. Output ONLY the JSON object, no markdown fences, no extra text.`;

  const userPrompt = `Question: ${questionCtx}

Options:
${optionsList}

Selection mode: ${selectionMode}

Analyze each option carefully, then respond with {"reasoning": "...", "answer": [...]}:`;

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const raw = await callOpenRouterGeneric(systemPrompt, userPrompt, attempt, modelConfig);
    if (raw === null) return null;

    const parsed = parseJsonSafe(raw);

    // New format: {"reasoning": "...", "answer": [0, 2]}
    if (parsed && parsed.answer && Array.isArray(parsed.answer)) return parsed.answer;
    // Legacy format: plain array [0, 2]
    if (parsed && Array.isArray(parsed)) return parsed;

    console.warn(`[AI ELIT] Attempt ${attempt + 1}: Could not parse response:`, raw);
    if (attempt < RETRY_COUNT) {
      showToast('⟳ Retrying with different parameters…', 'info');
    }
  }

  showToast('⚠️ Unexpected AI response after retries. Check console.', 'error');
  return null;
}

async function solveMatching(formData, modelConfig) {
  const { question, selects, groups, choices } = formData;
  const questionCtx = buildQuestionContext(question);

  let promptBody = '';

  if (selects.length > 0) {
    // PATCH: Detect inline selects (selects embedded within sentences)
    const hasInlineSelects = selects.some(s => s.isInline);

    if (hasInlineSelects) {
      // Inline selects: show full sentence context with gap markers
      promptBody = selects.map((sel, i) => {
        const opts = sel.options.map(o => `"${o.text}"`).join(', ');
        const ctx = sel.statement || `Field ${i + 1}`;
        return `  ${i + 1}. Context: "${ctx}"\n     Choose from: [${opts}]`;
      }).join('\n');
    } else {
      // Original select-based matching — use 1-based numbering to match on-screen labels
      promptBody = selects.map((sel, i) => {
        const opts = sel.options.map(o => `"${o.text}"`).join(', ');
        const label = sel.statement || `Field ${i + 1}`;
        return `  ${i + 1}. "${label}" → Options: [${opts}]`;
      }).join('\n');
    }
  } else {
    // Multiple radio groups = matching — use 1-based numbering
    const groupNames = Object.keys(groups);
    promptBody = groupNames.map((name, i) => {
      const grp = groups[name];
      const opts = grp.map(c => `"${c.text}"`).join(', ');
      // Try to find the statement associated with this group
      const firstInput = grp[0]?.el;
      let statement = '';
      if (firstInput) {
        const container = firstInput.closest('.matching-item, .match-row, tr, [class*="match"]');
        if (container) {
          const stEl = container.querySelector('td:first-child, .statement, [class*="statement"]');
          if (stEl) statement = stEl.innerText.trim();
        }
      }
      return `  ${i + 1}. "${statement || `Group ${name}`}" → Options: [${opts}]`;
    }).join('\n');
  }

  // PATCH: Enhanced system prompt for inline selects
  const hasInlineSelects = selects.length > 0 && selects.some(s => s.isInline);
  const inlineAddendum = hasInlineSelects
    ? `\n6. These are INLINE dropdowns embedded within sentences. The "Context" shows the surrounding text with [___GAP_N___] marking where the dropdown is. Choose the word/phrase that fits grammatically and semantically in that position.
7. Pay close attention to grammar, gender, case, and conjugation when selecting the correct option for each gap.`
    : '';

  const systemPrompt = `You are an expert academic test-solving assistant. Your task is to match statements to their correct options.

You MUST respond with a JSON object in this exact format:
{"reasoning": "your analysis of each match", "matches": {"1": "correct_option_text", "2": "correct_option_text"}}

Rules:
1. In "reasoning": explain why each statement matches its option.
2. In "matches": keys are statement numbers (1-based strings), values are the EXACT text of the correct option.
3. Values must EXACTLY match one of the provided options — copy the text precisely.
4. If the question is in a non-English language, answer based on the content regardless of language.
5. Output ONLY the JSON object, no markdown fences, no extra text.${inlineAddendum}`;

  const userPrompt = `Question: ${questionCtx}

${hasInlineSelects ? 'Fill each gap with the correct option from the provided choices:' : 'Match each statement to the correct option:'}
${promptBody}

Analyze each ${hasInlineSelects ? 'gap' : 'statement'} carefully, then respond with {"reasoning": "...", "matches": {...}}:`;

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const raw = await callOpenRouterGeneric(systemPrompt, userPrompt, attempt, modelConfig);
    if (raw === null) return null;

    const parsed = parseJsonSafe(raw);
    if (parsed && parsed.matches && typeof parsed.matches === 'object') return parsed;

    console.warn(`[AI ELIT] Matching attempt ${attempt + 1}: Could not parse:`, raw);
    if (attempt < RETRY_COUNT) showToast('⟳ Retrying…', 'info');
  }

  showToast('⚠️ Could not parse matching response.', 'error');
  return null;
}

async function solveTextInput(formData, modelConfig) {
  const { question, textInputs } = formData;
  const questionCtx = buildQuestionContext(question);

  // PATCH: Include surrounding text context for each field
  const fields = textInputs.map((t, i) => {
    let desc = `  [${i}] "${t.label || `Field ${i + 1}`}"`;
    if (t.surroundingText && t.surroundingText !== t.label) {
      desc += ` — context: "${t.surroundingText}"`;
    }
    desc += ` ${t.isTextarea ? '(long answer)' : '(short answer)'}`;
    return desc;
  }).join('\n');

  // PATCH: Soft hint for ordering tasks — let AI decide, just give it extra guidance
  const orderingHint = `\n8. IMPORTANT: Analyze whether this is an ordering/sequencing/ranking task. If it is:
   - Each field expects a NUMBER (position in the correct order), e.g. "1", "2", "3".
   - The field index [0], [1], [2]... is the POSITION on the page, NOT the answer.
   - Carefully determine what order number belongs to each field based on its context.
   - Each number should be unique within the sequence.`;

  const systemPrompt = `You are an expert academic test-solving assistant. Your task is to provide precise answers for text input fields.

You MUST respond with a JSON object in this exact format:
{"reasoning": "your analysis", "text_answers": ["answer1", "answer2"]}

Rules:
1. In "reasoning": analyze the question and explain how you derived each answer.
2. In "text_answers": provide an array where each element is the answer for the corresponding field.
3. If the answer is a number or equation, give the exact value (e.g. "42" or "x^2 + 3x - 5").
4. If the answer is a word or short phrase, give just that.
5. If the answer requires a sentence, write a short, natural-sounding sentence (1-2 sentences max).
6. If the question is in a non-English language, answer in the same language.
7. Output ONLY the JSON object, no markdown fences, no extra text.${orderingHint}`;

  const userPrompt = `Question: ${questionCtx}

Text fields to fill:
${fields}

Analyze the question carefully, then respond with {"reasoning": "...", "text_answers": [...]}:`;

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const raw = await callOpenRouterGeneric(systemPrompt, userPrompt, attempt, modelConfig);
    if (raw === null) return null;

    const parsed = parseJsonSafe(raw);
    if (parsed && parsed.text_answers && Array.isArray(parsed.text_answers)) return parsed;

    console.warn(`[AI ELIT] Text input attempt ${attempt + 1}: Could not parse:`, raw);
    if (attempt < RETRY_COUNT) showToast('⟳ Retrying…', 'info');
  }

  showToast('⚠️ Could not parse text input response.', 'error');
  return null;
}

// ─── Apply Answers ────────────────────────────────────────────────────────────

// PATCH: Normalize strings for fuzzy matching (handles unicode spaces, quotes, dashes)
function normalizeForMatch(s) {
  return String(s).trim().toLowerCase()
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[«»\u201c\u201d\u2018\u2019]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

function applyRadioCheckbox(choices, indices) {
  if (!indices || !Array.isArray(indices)) return 0;
  choices.forEach(c => { if (c.el) c.el.checked = false; });

  let applied = 0;
  indices.forEach(idx => {
    if (idx >= 0 && idx < choices.length && choices[idx].el) {
      const el = choices[idx].el;
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('click', { bubbles: true }));
      applied++;
    }
  });
  return applied;
}

function applyMatching(formData, result) {
  if (!result || !result.matches) return 0;
  const { selects, groups } = formData;
  let applied = 0;

  // ── Auto-detect 0-based vs 1-based keys from AI response ──
  const keys = Object.keys(result.matches).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
  const count = selects.length || Object.keys(groups).length;
  const minKey = keys.length ? Math.min(...keys) : 0;
  const maxKey = keys.length ? Math.max(...keys) : 0;
  // If keys look 1-based (min=1, max=count), subtract 1 to convert to 0-based
  // If keys look 0-based (min=0, max=count-1), use as-is
  const offset = (minKey === 1 && maxKey === count) ? 1 : 0;

  console.log('[AI ELIT] Matching response:', JSON.stringify(result.matches));
  console.log('[AI ELIT] Detected offset:', offset, '(1 = AI used 1-based, 0 = AI used 0-based)');
  console.log('[AI ELIT] Items count:', count, 'Key range:', minKey, '-', maxKey);

  if (selects.length > 0) {
    console.log('[AI ELIT] Statements:', selects.map(s => s.statement));
    Object.entries(result.matches).forEach(([idxStr, value]) => {
      const i = parseInt(idxStr, 10) - offset;
      if (i >= 0 && i < selects.length && selects[i].el) {
        const sel = selects[i].el;
        // Find the option that matches the value text
        // PATCH: Use normalizeForMatch for more robust comparison
        const normValue = normalizeForMatch(value);
        const opt = Array.from(sel.options).find(o =>
          normalizeForMatch(o.text) === normValue
        );
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          applied++;
        } else {
          // Fallback: try partial match with normalization
          const partial = Array.from(sel.options).find(o =>
            normalizeForMatch(o.text).includes(normValue) ||
            normValue.includes(normalizeForMatch(o.text))
          );
          if (partial) {
            sel.value = partial.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            applied++;
          }
        }
      }
    });
  } else {
    // Radio groups matching
    const groupNames = Object.keys(groups);
    Object.entries(result.matches).forEach(([idxStr, value]) => {
      const i = parseInt(idxStr, 10) - offset;
      if (i >= 0 && i < groupNames.length) {
        const grp = groups[groupNames[i]];
        // PATCH: Use normalizeForMatch for more robust comparison
        const normVal = normalizeForMatch(value);
        const match = grp.find(c =>
          normalizeForMatch(c.text) === normVal
        ) || grp.find(c =>
          normalizeForMatch(c.text).includes(normVal) ||
          normVal.includes(normalizeForMatch(c.text))
        );
        if (match && match.el) {
          match.el.checked = true;
          match.el.dispatchEvent(new Event('change', { bubbles: true }));
          applied++;
        }
      }
    });
  }
  return applied;
}

function applyTextInputs(formData, result) {
  if (!result || !result.text_answers || !Array.isArray(result.text_answers)) return 0;
  const { textInputs } = formData;
  let applied = 0;

  result.text_answers.forEach((answer, i) => {
    if (i < textInputs.length && textInputs[i].el && answer != null) {
      const el = textInputs[i].el;
      // Use native input setter to trigger React/Vue bindings
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, String(answer));
      } else {
        el.value = String(answer);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      applied++;
    }
  });
  return applied;
}

// ─── Toast Notification ───────────────────────────────────────────────────────

async function showToast(message, type = 'info') {
  try {
    // When button is hidden, suppress non-error toasts (selected answer info)
    if (type !== 'error') {
      const { hideButton } = await getStorage(['hideButton']);
      if (hideButton) return;
    }

    const existing = document.getElementById('aqs-toast');
    if (existing) existing.remove();

    const colors = {
      info: { bg: '#1a1a2e', border: '#4ecca3', text: '#e0e0e0' },
      success: { bg: '#0d2818', border: '#4ecca3', text: '#a8f0cb' },
      error: { bg: '#2e0d0d', border: '#ff6b6b', text: '#ffb3b3' }
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.id = 'aqs-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '999999',
      padding: '12px 18px',
      borderRadius: '8px',
      border: `1px solid ${c.border}`,
      background: c.bg,
      color: c.text,
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '500',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      maxWidth: '420px',
      lineHeight: '1.5',
      transition: 'opacity 0.4s',
      opacity: '1'
    });

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { try { toast.remove(); } catch (_) { } }, 400);
    }, 4000);
  } catch (_) {
    // Never let toast crash the main flow
  }
}

// ─── Button Injection ─────────────────────────────────────────────────────────

function createAIButton() {
  const btn = document.createElement('a');
  btn.id = 'aqs-btn';
  btn.href = '#';
  btn.className = 'btn mt-2';
  btn.innerHTML = `<span class="aqs-icon">✦</span> <span class="aqs-label">Answer with AI</span>`;

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    marginLeft: '10px',
    padding: '7px 16px',
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    color: '#4ecca3',
    border: '1px solid #4ecca3',
    borderRadius: '6px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '14px',
    fontWeight: '600',
    letterSpacing: '0.02em',
    textDecoration: 'none',
    cursor: 'pointer',
    boxShadow: '0 0 12px rgba(78,204,163,0.15)',
    transition: 'all 0.2s ease',
    verticalAlign: 'middle'
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'linear-gradient(135deg, #16213e 0%, #0f3460 100%)';
    btn.style.boxShadow = '0 0 20px rgba(78,204,163,0.35)';
    btn.style.transform = 'translateY(-1px)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
    btn.style.boxShadow = '0 0 12px rgba(78,204,163,0.15)';
    btn.style.transform = 'translateY(0)';
  });

  return btn;
}

function setButtonLoading(btn, loading) {
  if (!btn) return;
  const icon = btn.querySelector('.aqs-icon');
  const label = btn.querySelector('.aqs-label');
  if (!icon || !label) return;

  if (loading) {
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.7';
    icon.textContent = '⟳';
    label.textContent = 'Thinking…';
    icon.style.display = 'inline-block';
    icon.style.animation = 'aqs-spin 1s linear infinite';
  } else {
    btn.style.pointerEvents = '';
    btn.style.opacity = '1';
    icon.textContent = '✦';
    label.textContent = 'Answer with AI';
    icon.style.animation = '';
  }
}

// Inject keyframe for spin animation once
function injectStyles() {
  if (document.getElementById('aqs-styles')) return;
  const style = document.createElement('style');
  style.id = 'aqs-styles';
  style.textContent = `
    @keyframes aqs-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    #aqs-btn .aqs-icon {
      display: inline-block;
      line-height: 1;
    }
    #aqs-btn.aqs-hidden {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Main Solve Logic ─────────────────────────────────────────────────────────

let isSolving = false;

async function solveCurrentForm() {
  if (isSolving) {
    showToast('⏳ Already processing…', 'info');
    return;
  }

  const form = document.getElementById('form') || document.querySelector('form');
  if (!form) {
    showToast('⚠️ No form found on this page.', 'error');
    return;
  }

  const formData = extractFormData(form);
  const btn = document.getElementById('aqs-btn');

  // Check we have something to work with
  const hasWork = formData.choices.length > 0 || formData.selects.length > 0 || formData.textInputs.length > 0;
  if (!hasWork) {
    showToast('⚠️ No answer inputs found on this page.', 'error');
    return;
  }

  isSolving = true;
  setButtonLoading(btn, true);

  try {
    let totalApplied = 0;
    const results = [];

    // ── Handle radio/checkbox ──
    if (formData.choices.length > 0 && formData.type !== 'matching') {
      const taskType = formData.isMultiple ? 'radio_multiple' : 'radio_single';
      // Override task type if question has images
      const effectiveType = (formData.question?.images?.length > 0) ? 'image' : taskType;
      const mc = await resolveModelConfig(effectiveType);
      const indices = await solveRadioCheckbox(formData, mc);
      if (indices !== null) {
        const applied = applyRadioCheckbox(formData.choices, indices);
        totalApplied += applied;
        const labels = indices
          .filter(i => i >= 0 && i < formData.choices.length)
          .map(i => `"${formData.choices[i].text.slice(0, 40)}"`)
          .join(', ');
        results.push(applied ? `✅ Selected: ${labels}` : `⚠️ Out-of-range indices: [${indices}]`);
      }
    }

    // ── Handle matching ──
    if (formData.type === 'matching') {
      const effectiveType = (formData.question?.images?.length > 0) ? 'image' : 'matching';
      const mc = await resolveModelConfig(effectiveType);
      const matchResult = await solveMatching(formData, mc);
      if (matchResult !== null) {
        const applied = applyMatching(formData, matchResult);
        totalApplied += applied;
        results.push(applied ? `✅ Matched ${applied} items` : '⚠️ No matches applied');
      }
    }

    // ── Handle text inputs ──
    if (formData.textInputs.length > 0) {
      const effectiveType = (formData.question?.images?.length > 0) ? 'image' : 'text_input';
      const mc = await resolveModelConfig(effectiveType);
      const textResult = await solveTextInput(formData, mc);
      if (textResult !== null) {
        const applied = applyTextInputs(formData, textResult);
        totalApplied += applied;
        results.push(applied ? `✅ Filled ${applied} text fields` : '⚠️ No text fields filled');
      }
    }

    // Show combined result
    if (results.length) {
      showToast(results.join(' | '), totalApplied > 0 ? 'success' : 'error');
    }

  } catch (err) {
    console.error('[AI ELIT] Solve error:', err);
    showToast(`❌ Error: ${err.message}`, 'error');
  } finally {
    isSolving = false;
    setButtonLoading(btn, false);
  }
}

// ─── Button Injection into Form ───────────────────────────────────────────────

async function injectButton(form) {
  // Don't inject twice
  if (document.getElementById('aqs-btn')) return;

  injectStyles();

  const aiBtn = createAIButton();

  // Find the navigation link by text content
  const links = Array.from(form.querySelectorAll('a'));
  const nextLink = links.find(a => /наступного питання|наступне питання|next/i.test(a.textContent));

  if (nextLink && nextLink.parentNode) {
    nextLink.parentNode.insertBefore(aiBtn, nextLink.nextSibling);
  } else {
    // Fallback: just append to the form
    form.appendChild(aiBtn);
  }

  // Check if button should be hidden
  const { hideButton } = await getStorage(['hideButton']);
  if (hideButton) aiBtn.classList.add('aqs-hidden');

  aiBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await solveCurrentForm();
  });
}

// ─── Hide Button Toggle — listen for storage changes ──────────────────────────

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hideButton) {
      const btn = document.getElementById('aqs-btn');
      if (btn) {
        if (changes.hideButton.newValue) {
          btn.classList.add('aqs-hidden');
        } else {
          btn.classList.remove('aqs-hidden');
        }
      }
    }
  });
} catch (_) { }

// ─── Hotkey: Backslash (\) — always works ─────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Don't trigger if user is typing in an input/textarea
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.target.isContentEditable) return;

  if (e.key === '\\') {
    e.preventDefault();
    solveCurrentForm();
  }
});

// ─── MutationObserver — watches for dynamic form loads ────────────────────────

function watchForForm() {
  let debounceTimer = null;

  const tryInject = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const form = document.getElementById('form') || document.querySelector('form');
        if (form && !document.getElementById('aqs-btn')) {
          injectButton(form);
        }
      } catch (err) {
        console.warn('[AI ELIT] Inject error:', err);
      }
    }, 150);
  };

  // Try immediately
  tryInject();

  // Also watch DOM mutations (Turbo/Pjax/SPA navigation)
  try {
    const observer = new MutationObserver(tryInject);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (err) {
    console.warn('[AI ELIT] Observer error:', err);
    // Fallback: poll every 2 seconds
    setInterval(tryInject, 2000);
  }
}

// Start
if (document.body) {
  watchForForm();
} else {
  document.addEventListener('DOMContentLoaded', watchForForm);
}
