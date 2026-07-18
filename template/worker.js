// afo-subagent-mcp v0.2.0 — server-side repo Q&A subagent.
// The MCP caller only pays tokens for compact answers, never file contents.
//
// v0.2.0 (driven by manual field testing; prior weak spots were large-repo
// summarization and timeout resilience):
//  - Staged pipeline with per-stage timings (listing|fetching|packing|
//    model_call) reported on every response, success or failure.
//  - PARTIAL RESULTS instead of opaque failure: fetch stage respects a time
//    budget and proceeds with what it has; the model call is raced against
//    the remaining budget and on timeout returns everything gathered plus a
//    concrete suggested retry.
//  - Large-file mode: files over 50KB are no longer packed head-first blind;
//    a smart excerpt keeps structural lines (function/class/heading decls),
//    windows around question-keyword matches, and the file top.
//  - New tools: read_file_range (exact line windows, no LLM), grep_repo
//    (exact-term search across the repo server-side, paths + snippets),
//    ask_repo_light (tree-first: a fast model picks the files from paths
//    alone, then one answer call; falls back to heuristic selection).
//
// Bindings: AI (required), GITHUB_TOKEN (secret; required in practice —
// unauthenticated GitHub rate limits are shared per egress IP),
// DEFAULT_OWNER, WORKER_NAME.

const VERSION = '0.5.0';
const WORKER = 'afo-subagent-mcp';
const GH = 'https://api.github.com';
const MODEL_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // ~1-5s answers; fits connector timeouts
const MODEL_FAST = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MODEL_DEEP = '@cf/zai-org/glm-4.7-flash'; // reasoning model: better on hard questions, 40-70s+ latency

const LIMITS = {
  max_files_default: 8,
  max_files_cap: 25,
  per_file_chars: 15000,
  total_chars: 180000,
  model_input_chars: 48000,
  large_file_threshold: 50000,
  tree_entries_scan: 4000,
  answer_tokens: 4000,
  budget_ms_default: 90000,
  budget_ms_cap: 150000,
  fetch_budget_share: 0.35, // portion of budget the fetch stage may consume
  grep_max_files: 40,      // default; adjustable per-call up to grep_files_cap
  grep_files_cap: 120,
  grep_max_bytes: 2000000, // default; adjustable per-call up to grep_bytes_cap
  grep_bytes_cap: 8000000,
  grep_max_matches: 50,
  range_max_chars: 20000
};

const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.git|vendor|coverage|__pycache__)(\/|$)|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|\.min\.(js|css)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|bin|sqlite|db)$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function readJson(req) { try { return await req.json(); } catch { return {}; } }

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function ownerOf(env, args) {
  return String((args && args.owner) || env.DEFAULT_OWNER || 'nothinginfinity').trim();
}

// ---------------- stage tracking ----------------

function stageTracker() {
  const t0 = Date.now();
  const stages = {};
  let cur = null, curStart = 0;
  return {
    start(name) {
      if (cur) stages[cur] = (stages[cur] || 0) + (Date.now() - curStart);
      cur = name; curStart = Date.now();
    },
    finish() {
      if (cur) { stages[cur] = (stages[cur] || 0) + (Date.now() - curStart); cur = null; }
      return { stages_ms: stages, total_ms: Date.now() - t0 };
    },
    current() { return cur; },
    elapsed() { return Date.now() - t0; }
  };
}

// ---------------- GitHub ----------------

function ghHeaders(env) {
  const h = {
    'accept': 'application/vnd.github+json',
    'user-agent': WORKER + '/' + VERSION,
    'x-github-api-version': '2022-11-28'
  };
  if (env.GITHUB_TOKEN) h['authorization'] = 'Bearer ' + env.GITHUB_TOKEN;
  return h;
}

async function gh(env, path) {
  const res = await fetch(GH + path, { headers: ghHeaders(env) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const hint = res.status === 404 && !env.GITHUB_TOKEN
      ? ' (repo may be private - GITHUB_TOKEN secret is not set on this worker)'
      : (res.status === 403 ? ' (possibly rate-limited - set GITHUB_TOKEN for higher limits)' : '');
    const err = new Error('GitHub GET ' + path.split('?')[0] + ' -> ' + res.status + ': ' + String(data.message || text).slice(0, 200) + hint);
    err.status = res.status;
    throw err;
  }
  return data;
}

function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function fetchFileContent(env, owner, repo, path, ref) {
  const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`);
  if (data.content) return b64ToUtf8(data.content);
  if (data.download_url) {
    const res = await fetch(data.download_url, { headers: { 'user-agent': WORKER } });
    return await res.text();
  }
  throw new Error('no content returned for ' + path);
}

async function resolveBranch(env, owner, repo, ref) {
  if (ref) return ref;
  return (await gh(env, `/repos/${owner}/${repo}`)).default_branch || 'main';
}

async function fetchTree(env, owner, repo, branch) {
  const tree = await gh(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return (tree.tree || [])
    .filter(e => e.type === 'blob' && !SKIP_PATH.test(e.path) && !BINARY_EXT.test(e.path))
    .slice(0, LIMITS.tree_entries_scan);
}

// ---------------- excerpting ----------------

function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false, mode: 'full' };
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return {
    text: text.slice(0, head) + '\n\n/* ...[' + (text.length - maxChars) + ' chars omitted by subagent]... */\n\n' + text.slice(-tail),
    truncated: true,
    mode: 'head_tail'
  };
}

const STRUCTURE_LINE = /^(export\s|import\s|function\s|class\s|def\s|async\s+function|const\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?(\(|function)|#{1,4}\s|CREATE\s+(TABLE|INDEX|VIRTUAL)|--\s|\/\/\s*={3,}|\/\/\s*-{3,}|"[a-zA-Z_]+"\s*:)/i;

function smartExcerpt(text, questionTokens, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false, mode: 'full' };
  const lines = text.split('\n');
  const marks = new Set();
  const qTokens = (questionTokens || []).filter(t => t.length >= 4);
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (qTokens.some(t => low.includes(t))) {
      for (let j = Math.max(0, i - 6); j <= Math.min(lines.length - 1, i + 8); j++) marks.add(j);
    } else if (STRUCTURE_LINE.test(lines[i].trim())) {
      marks.add(i);
    }
  }
  for (let i = 0; i < Math.min(30, lines.length); i++) marks.add(i);
  if (marks.size < 5) return truncateMiddle(text, maxChars);

  const idx = [...marks].sort((a, b) => a - b);
  const out = [];
  let last = -2, used = 0, capped = false;
  for (const i of idx) {
    if (i !== last + 1 && last >= 0) out.push('/* ...[' + (i - last - 1) + ' lines omitted]... */');
    const line = lines[i];
    if (used + line.length > maxChars) { out.push('/* ...[excerpt budget reached; use read_file_range for more]... */'); capped = true; break; }
    out.push(line);
    used += line.length + 1;
    last = i;
  }
  if (!capped && last < lines.length - 1) out.push('/* ...[' + (lines.length - 1 - last) + ' trailing lines omitted]... */');
  return { text: out.join('\n'), truncated: true, mode: 'smart' };
}

// ---------------- selection ----------------

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9_$]+/).filter(t => t.length >= 3);
}

// ---------------- evidence grounding ----------------
const PROBE_STOPWORDS = new Set(['implemented','implement','implementation','function','feature','version','whether','does','the','this','that','file','repo','code','what','how','where','which','with','and','for','are','was','have','has']);

function extractProbes(question) {
  const s = String(question || '');
  const probes = new Set();
  for (const m of s.matchAll(/["'`]([^"'`]{3,60})["'`]/g)) probes.add(m[1]);
  for (const m of s.matchAll(/\bv?\d+(?:\.\d+){1,4}\b/g)) probes.add(m[0]);
  for (const m of s.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) probes.add(m[0]);
  for (const m of s.matchAll(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g)) probes.add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) probes.add(m[0]);
  for (const m of s.matchAll(/\bTODO[:#\s-]*[\w.-]*/gi)) probes.add(m[0].trim());
  return [...probes]
    .map(p => p.trim())
    .filter(p => p.length >= 3 && !PROBE_STOPWORDS.has(p.toLowerCase()))
    .slice(0, 5);
}

function findEvidenceWindows(text, path, probes, maxPerProbe) {
  const lines = text.split('\n');
  const windows = [];
  for (const probe of probes) {
    const low = probe.toLowerCase();
    let found = 0;
    for (let i = 0; i < lines.length && found < (maxPerProbe || 2); i++) {
      if (lines[i].toLowerCase().includes(low)) {
        const start = Math.max(0, i - 8);
        const end = Math.min(lines.length - 1, i + 12);
        windows.push({
          probe, path, line: i + 1,
          text: lines.slice(start, end + 1).map((l, j) => (start + j + 1) + '| ' + l).join('\n')
        });
        found++;
        i = end;
      }
    }
  }
  return windows;
}

function scorePath(path, size, questionTokens) {
  const p = path.toLowerCase();
  let score = 0;
  for (const t of questionTokens) if (p.includes(t)) score += 5;
  if (/(^|\/)readme\.(md|txt)$/i.test(path)) score += 6;
  if (/(^|\/)(index|worker|main|app|server)\.[jt]sx?$/.test(p)) score += 5;
  if (/(^|\/)(wrangler\.(toml|jsonc?)|package\.json|schema\.sql)$/.test(p)) score += 4;
  if (/^(src|workers?|lib|app)\//.test(p)) score += 2;
  if (/\.(md|sql|toml|ya?ml|jsonc?)$/.test(p)) score += 1;
  if (/\.(test|spec)\./.test(p)) score -= 2;
  if (size > 120000) score -= 3;
  return score;
}

function heuristicSelect(entries, question, args) {
  const include = Array.isArray(args.include) ? args.include : null;
  const exclude = Array.isArray(args.exclude) ? args.exclude : null;
  let candidates = entries;
  if (include) candidates = candidates.filter(e => include.some(s => e.path.includes(s)));
  if (exclude) candidates = candidates.filter(e => !exclude.some(s => e.path.includes(s)));
  const qTokens = tokenize(question);
  const maxFiles = Math.min(Number(args.max_files) || LIMITS.max_files_default, LIMITS.max_files_cap);
  return candidates
    .map(e => ({ path: e.path, size: e.size || 0, score: scorePath(e.path, e.size || 0, qTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
}

// ---------------- model ----------------

async function runModel(env, model, system, user, maxTokens) {
  if (!env.AI) throw new Error('AI binding is not attached to this worker');
  const params = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (String(model).startsWith('@cf/zai-org')) params.max_completion_tokens = maxTokens || LIMITS.answer_tokens;
  else params.max_tokens = maxTokens || LIMITS.answer_tokens;
  const out = await env.AI.run(model, params);
  const answer = (out && (out.response || out.result || out.output_text
    || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || '';
  if (!answer) throw new Error('model returned empty response: ' + JSON.stringify(out).slice(0, 200));
  return String(answer).trim();
}

function raceWithTimeout(promise, ms) {
  return Promise.race([
    promise.then(v => ({ timed_out: false, value: v })),
    new Promise(resolve => setTimeout(() => resolve({ timed_out: true }), ms))
  ]);
}

const SYSTEM_PROMPT =
  'You are a code-analysis subagent. You are given source files (possibly excerpted) from one repository and a question. ' +
  'Answer the question accurately and CONCISELY (a few short paragraphs max). ' +
  'Cite specific file paths (and function names) for every claim. ' +
  'If an EVIDENCE section is present, it contains exact verbatim grep matches for identifiers/versions named in the question - treat it as ground truth for whether something exists or is implemented, even if the file excerpts do not show it. ' +
  'If the provided excerpts are insufficient, say exactly what is missing and which paths/line ranges would contain it. ' +
  'Do not restate file contents at length; the caller cannot afford large outputs.';

// ---------------- fetching with budget ----------------

async function readSelected(env, owner, repo, branch, selected, questionTokens, deadlineAt, cache) {
  const files = [];
  let total = 0;
  for (let i = 0; i < selected.length; i += 5) {
    if (deadlineAt && Date.now() > deadlineAt) {
      for (const s of selected.slice(i)) files.push({ path: s.path, skipped: 'fetch time budget reached', chars: 0 });
      break;
    }
    const batch = selected.slice(i, i + 5);
    const contents = await Promise.all(batch.map(async s => {
      try {
        const cached = cache && cache.get(s.path);
        return { path: s.path, raw: cached != null ? cached : await fetchFileContent(env, owner, repo, s.path, branch) };
      }
      catch (e) { return { path: s.path, error: String(e.message || e) }; }
    }));
    for (const c of contents) {
      if (c.error) { files.push({ path: c.path, error: c.error, chars: 0 }); continue; }
      const budgetLeft = LIMITS.total_chars - total;
      if (budgetLeft <= 500) { files.push({ path: c.path, skipped: 'total char budget reached', chars: 0 }); continue; }
      const cap = Math.min(LIMITS.per_file_chars, budgetLeft);
      const t = c.raw.length > LIMITS.large_file_threshold
        ? smartExcerpt(c.raw, questionTokens, cap)
        : truncateMiddle(c.raw, cap);
      total += t.text.length;
      files.push({ path: c.path, text: t.text, chars: t.text.length, truncated: t.truncated, excerpt_mode: t.mode, raw_chars: c.raw.length });
    }
  }
  return { files, total_chars: total };
}

function buildPrompt(owner, repo, branch, question, files, evidenceWindows) {
  const withText = files.filter(f => f.text);
  let evidenceBlock = '';
  if (evidenceWindows && evidenceWindows.length) {
    let used = 0;
    const parts = [];
    for (const w of evidenceWindows) {
      if (used + w.text.length > 8000) break;
      parts.push('[exact match for "' + w.probe + '"] ' + w.path + ':' + w.line + '\n' + w.text);
      used += w.text.length;
    }
    evidenceBlock = '===== EVIDENCE: exact verbatim matches for terms in the question (authoritative for existence/implementation claims) =====\n'
      + parts.join('\n---\n') + '\n\n';
  }
  const budget = Math.max(8000, LIMITS.model_input_chars - 1000 - evidenceBlock.length);
  const perFile = Math.floor(budget / Math.max(1, withText.length));
  const blocks = withText.map(f => {
    const t = f.text.length > perFile ? truncateMiddle(f.text, perFile) : { text: f.text, truncated: f.truncated };
    return '===== FILE: ' + f.path + (t.truncated ? ' (excerpted)' : '') + ' =====\n' + t.text;
  }).join('\n\n');
  return 'Repository: ' + owner + '/' + repo + ' @ ' + branch + '\n\nQuestion: ' + question + '\n\n' + evidenceBlock + blocks;
}

function partialPayload(stage, timings, extra) {
  return {
    ok: false,
    error: stage === 'model_call' ? 'model_timeout' : 'time_budget_exhausted',
    stage,
    timings,
    ...extra
  };
}

// ---------------- tools ----------------

async function askRepoCore(env, args, preselected) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const question = String(args.question || '').trim();
  if (!repo || !question) throw new Error('repo and question are required');
  const model = String(args.model || MODEL_DEFAULT);
  const budgetMs = clampNum(args.budget_ms, 15000, LIMITS.budget_ms_cap, LIMITS.budget_ms_default);
  const qTokens = tokenize(question);

  track.start('listing');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  let selected, repoFileCount = null, repoEntries = null;
  if (preselected) {
    selected = preselected.map(p => ({ path: String(p) }));
  } else {
    repoEntries = await fetchTree(env, owner, repo, branch);
    repoFileCount = repoEntries.length;
    selected = heuristicSelect(repoEntries, question, args);
  }

  // Evidence stage: for questions naming symbols/versions/features, gather
  // exact grep windows BEFORE synthesis, and promote matching files into the
  // selection. Deterministic evidence beats model chunk-selection.
  const probes = extractProbes(question);
  const cache = new Map();
  let evidenceWindows = [];
  let promoted = [];
  if (probes.length) {
    track.start('evidence');
    const evidenceDeadline = Date.now() + Math.max(6000, Math.floor(budgetMs * 0.2));
    const selectedSet = new Set(selected.map(s => s.path));
    let scanPaths = selected.map(s => s.path);
    if (!preselected && typeof repoEntries !== 'undefined' && repoEntries) {
      const extra = repoEntries
        .filter(e => !selectedSet.has(e.path))
        .map(e => ({ path: e.path, score: scorePath(e.path, e.size || 0, probes.map(p => p.toLowerCase())) - (e.size || 0) / 300000 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map(e => e.path);
      scanPaths = scanPaths.concat(extra);
    }
    for (let i = 0; i < scanPaths.length; i += 5) {
      if (Date.now() > evidenceDeadline) break;
      const batch = scanPaths.slice(i, i + 5);
      await Promise.all(batch.map(async p => {
        try { cache.set(p, await fetchFileContent(env, owner, repo, p, branch)); } catch { /* skip unreadable */ }
      }));
      for (const p of batch) {
        const raw = cache.get(p);
        if (!raw) continue;
        const wins = findEvidenceWindows(raw, p, probes, 2);
        if (wins.length) {
          evidenceWindows = evidenceWindows.concat(wins);
          if (!selectedSet.has(p) && promoted.length < 4) {
            selected.push({ path: p });
            selectedSet.add(p);
            promoted.push(p);
          }
        }
      }
      if (evidenceWindows.length >= 10) break;
    }
    evidenceWindows = evidenceWindows.slice(0, 10);
  }

  track.start('fetching');
  const fetchDeadline = Date.now() + Math.max(8000, Math.floor(budgetMs * LIMITS.fetch_budget_share));
  const read = await readSelected(env, owner, repo, branch, selected, qTokens, fetchDeadline, cache);
  const readable = read.files.filter(f => f.text);
  const fileReport = read.files.map(f => ({
    path: f.path,
    chars: f.chars || 0,
    raw_chars: f.raw_chars,
    excerpt_mode: f.excerpt_mode,
    problem: f.error || f.skipped || undefined
  }));

  if (!readable.length) {
    return {
      ...partialPayload(track.current(), track.finish(), {}),
      error: 'no_files_readable',
      files: fileReport,
      suggestion: 'check paths with list_repo_files, or pass include filters'
    };
  }

  track.start('packing');
  const prompt = buildPrompt(owner, repo, branch, question, read.files, evidenceWindows);

  track.start('model_call');
  const remaining = budgetMs - track.elapsed();
  const modelWindow = Math.max(20000, remaining - 2000);
  const raced = await raceWithTimeout(
    runModel(env, model, SYSTEM_PROMPT, prompt, LIMITS.answer_tokens).catch(e => { throw e; }),
    modelWindow
  ).catch(e => ({ timed_out: false, error: String(e.message || e) }));

  const timings = track.finish();

  if (raced.error) {
    return { ok: false, error: 'model_error', detail: raced.error, stage: 'model_call', timings, files: fileReport };
  }
  if (raced.timed_out) {
    const topPaths = readable.slice(0, 4).map(f => f.path);
    return partialPayload('model_call', timings, {
      files: fileReport,
      chars_read_server_side: read.total_chars,
      prompt_chars: prompt.length,
      model,
      suggestion: 'model did not answer within ' + modelWindow + 'ms. Retry with ask_files on fewer paths, e.g. paths: ' + JSON.stringify(topPaths) + ', or pass a larger budget_ms (cap ' + LIMITS.budget_ms_cap + '), or a faster model.'
    });
  }

  return {
    ok: true,
    answer: raced.value,
    repo: owner + '/' + repo + '@' + branch,
    model,
    files_read: readable.map(f => f.path + (f.truncated ? ' (' + (f.excerpt_mode || 'excerpted') + ')' : '')),
    files_skipped: read.files.filter(f => f.skipped || f.error).map(f => f.path),
    evidence: probes.length ? {
      probes,
      windows: evidenceWindows.map(w => ({ probe: w.probe, path: w.path, line: w.line })),
      promoted_paths: promoted.length ? promoted : undefined
    } : undefined,
    stats: {
      repo_files_scanned: repoFileCount,
      files_read: readable.length,
      chars_read_server_side: read.total_chars,
      prompt_chars: prompt.length
    },
    timings
  };
}

async function askRepo(env, args) { return askRepoCore(env, args, null); }

async function askFiles(env, args) {
  const paths = Array.isArray(args.paths) ? args.paths.slice(0, LIMITS.max_files_cap) : [];
  if (!paths.length) throw new Error('paths[] is required');
  return askRepoCore(env, args, paths);
}

// One-call auto flow (field-tested recommended pipeline):
// question -> extract probes -> plan over full tree -> grep candidates ->
// take files with hits -> synthesize via ask_files with evidence grounding.
// Broad questions with no greppable terms fall back to the light flow.
async function investigateRepo(env, args) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const question = String(args.question || '').trim();
  if (!repo || !question) throw new Error('repo and question are required');

  const probes = extractProbes(question);
  if (!probes.length) {
    const light = await askRepoLight(env, args);
    light.flow = 'light_fallback (no symbol/version/feature terms in question to grep for)';
    return light;
  }

  track.start('plan');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  const all = await fetchTree(env, owner, repo, branch);
  const filtered = applyPathFilters(all, args);
  const { picked } = rankGrepCandidates(filtered, probes.join(' '), clampNum(args.max_files, 5, 60, 30), 4000000);

  track.start('grep');
  const grepDeadline = Date.now() + 20000;
  const hits = new Map(); // path -> window count
  let scanned = 0;
  for (let i = 0; i < picked.length; i += 5) {
    if (Date.now() > grepDeadline || hits.size >= 8) break;
    const batch = picked.slice(i, i + 5);
    const contents = await Promise.all(batch.map(async e => {
      try { return { path: e.path, raw: await fetchFileContent(env, owner, repo, e.path, branch) }; }
      catch { return null; }
    }));
    for (const c of contents) {
      if (!c) continue;
      scanned++;
      const wins = findEvidenceWindows(c.raw, c.path, probes, 2);
      if (wins.length) hits.set(c.path, wins.length);
    }
  }
  const planTimings = track.finish();

  if (!hits.size) {
    const light = await askRepoLight(env, args);
    light.flow = 'light_fallback (grep found no matches for ' + JSON.stringify(probes) + ' in ' + scanned + ' scanned files)';
    light.plan = { probes, tree_files: all.length, candidates: picked.length, scanned, plan_ms: planTimings.total_ms };
    return light;
  }

  const hitPaths = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
  const result = await askRepoCore(env, { ...args }, hitPaths);
  result.flow = 'grep_first';
  result.plan = {
    probes,
    tree_files: all.length,
    candidates: picked.length,
    scanned,
    files_with_hits: hitPaths,
    plan_ms: planTimings.total_ms
  };
  return result;
}

async function askRepoLight(env, args) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const question = String(args.question || '').trim();
  if (!repo || !question) throw new Error('repo and question are required');
  const maxFiles = Math.min(Number(args.max_files) || 6, LIMITS.max_files_cap);

  track.start('listing');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  const entries = await fetchTree(env, owner, repo, branch);

  // Stage 1: a FAST model picks files from the tree alone (no contents).
  track.start('selecting');
  let chosen = null;
  let selection_mode = 'model';
  let selection_detail = null;
  try {
    const treeList = entries.slice(0, 800).map(e => e.path + ' (' + (e.size || 0) + 'B)').join('\n');
    const sel = await raceWithTimeout(runModel(
      env,
      String(args.selection_model || MODEL_FAST),
      'You select files. Given a repo file tree and a question, reply with ONLY a JSON array of the most relevant file paths (max ' + maxFiles + '), most relevant first. Use double quotes. No prose, no markdown fences.',
      'Question: ' + question + '\n\nFile tree:\n' + treeList,
      500
    ), 25000);
    if (sel.timed_out) {
      selection_detail = 'selection model timed out';
    } else {
      const raw = String(sel.value);
      const norm = p => String(p).replace(/^["'\s]+|["'\s]+$/g, '').replace(/^\.\//, '').replace(/^\//, '').replace(/\s*\(\d+B\)$/, '');
      let arr = null;
      const m = raw.match(/\[[\s\S]*?\]/);
      if (m) { try { arr = JSON.parse(m[0].replaceAll("'", '"')); } catch { arr = null; } }
      if (!arr) arr = raw.split(/[,\n]+/); // models often reply with a bare comma/newline list
      const valid = arr.map(norm).filter(p => p && entries.some(e => e.path === p)).slice(0, maxFiles);
      if (valid.length) chosen = valid;
      else selection_detail = 'no returned paths matched the tree; reply started: ' + raw.slice(0, 120);
    }
  } catch (e) { selection_detail = 'selection error: ' + String(e.message || e).slice(0, 160); }
  if (!chosen) {
    selection_mode = 'heuristic_fallback';
    chosen = heuristicSelect(entries, question, args).map(s => s.path);
  }

  const selectTimings = track.finish();
  const result = await askRepoCore(env, { ...args, max_files: maxFiles }, chosen);
  result.selection = { mode: selection_mode, detail: selection_detail || undefined, chosen, tree_files: entries.length, selecting_ms: selectTimings.stages_ms.selecting || 0, listing_ms: selectTimings.stages_ms.listing || 0 };
  return result;
}

async function readFileRange(env, args) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const path = String(args.path || '').trim();
  if (!repo || !path) throw new Error('repo and path are required');
  track.start('fetching');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  const raw = await fetchFileContent(env, owner, repo, path, branch);
  const lines = raw.split('\n');
  const start = Math.max(1, Number(args.start_line) || 1);
  const maxChars = clampNum(args.max_chars, 200, LIMITS.range_max_chars, 8000);
  let end = args.end_line ? Math.min(lines.length, Number(args.end_line)) : lines.length;
  let text = '';
  let lastIncluded = start - 1;
  for (let i = start - 1; i < end; i++) {
    if (text.length + lines[i].length + 1 > maxChars) break;
    text += lines[i] + '\n';
    lastIncluded = i + 1;
  }
  return {
    ok: true,
    repo: owner + '/' + repo + '@' + branch,
    path,
    total_lines: lines.length,
    total_chars: raw.length,
    returned: { start_line: start, end_line: lastIncluded, chars: text.length },
    more: lastIncluded < end ? 'truncated at max_chars; continue from start_line ' + (lastIncluded + 1) : undefined,
    text,
    timings: track.finish()
  };
}

const CODE_EXT = /\.(m?[jt]sx?|py|sql|go|rs|rb|php|java|cc?|cpp|h|html|css|toml|ya?ml|jsonc?|md)$/i;

// Rank grep candidates: path-relevant first, then code files LARGEST-first
// (implementations live in big files), greedily filling the byte budget.
function rankGrepCandidates(entries, term, maxFiles, maxBytes) {
  const termTokens = tokenize(term);
  const ranked = entries
    .map(e => ({ path: e.path, size: e.size || 0,
      _s: (termTokens.some(t => e.path.toLowerCase().includes(t)) ? 10 : 0)
        + (CODE_EXT.test(e.path) ? Math.min(e.size || 0, 500000) / 500000 : -0.5) }))
    .sort((a, b) => b._s - a._s);
  const picked = [];
  let est = 0;
  for (const e of ranked) {
    if (picked.length >= maxFiles) break;
    if (est + e.size > maxBytes && picked.length > 0) continue; // skip too-big, keep filling with smaller
    picked.push(e);
    est += e.size;
  }
  return { picked, estimated_bytes: est };
}

function applyPathFilters(entries, args) {
  const include = Array.isArray(args.include) ? args.include : null;               // substring match
  const includePrefixes = Array.isArray(args.include_prefixes) ? args.include_prefixes : null; // startsWith match
  const exclude = Array.isArray(args.exclude) ? args.exclude : null;
  let out = entries;
  if (includePrefixes) out = out.filter(e => includePrefixes.some(p => e.path.startsWith(p)));
  if (include) out = out.filter(e => include.some(s => e.path.includes(s)));
  if (exclude) out = out.filter(e => !exclude.some(s => e.path.includes(s)));
  return out;
}

async function grepRepoPlan(env, args) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const term = String(args.term || args.pattern || '').trim();
  if (!repo || !term) throw new Error('repo and term are required');

  track.start('listing');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  const all = await fetchTree(env, owner, repo, branch);
  const filtered = applyPathFilters(all, args);
  const low = term.toLowerCase();
  const filenameMatches = filtered.filter(e => e.path.toLowerCase().includes(low)).map(e => e.path);
  const planMaxFiles = clampNum(args.max_files, 1, LIMITS.grep_files_cap, LIMITS.grep_max_files);
  const planMaxBytes = clampNum(args.max_bytes, 100000, LIMITS.grep_bytes_cap, LIMITS.grep_max_bytes);
  const { picked: wouldScan, estimated_bytes: totalBytes } = rankGrepCandidates(filtered, term, planMaxFiles, planMaxBytes);

  return {
    ok: true,
    repo: owner + '/' + repo + '@' + branch,
    term,
    tree_files: all.length,
    after_filters: filtered.length,
    filename_matches: filenameMatches.slice(0, 30),
    would_scan: wouldScan.map(e => ({ path: e.path, size: e.size })),
    would_scan_bytes: totalBytes,
    coverage: filtered.length ? Math.round(wouldScan.length / filtered.length * 100) + '%' : '100%',
    suggestion: filtered.length > wouldScan.length
      ? 'coverage is partial: narrow with include_prefixes (e.g. a top-level dir), or raise max_files (cap ' + LIMITS.grep_files_cap + '), or pass paths[] explicitly'
      : 'full coverage: call grep_repo with the same filters',
    timings: track.finish()
  };
}

async function grepRepo(env, args) {
  const track = stageTracker();
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  const term = String(args.term || args.pattern || '').trim(); // 'pattern' accepted as alias
  if (!repo || !term) throw new Error('repo and term are required');
  const caseSensitive = args.case_sensitive === true;
  const needle = caseSensitive ? term : term.toLowerCase();
  const maxMatches = clampNum(args.max_matches, 1, LIMITS.grep_max_matches, 30);

  const maxFiles = clampNum(args.max_files, 1, LIMITS.grep_files_cap, LIMITS.grep_max_files);
  const maxBytes = clampNum(args.max_bytes, 100000, LIMITS.grep_bytes_cap, LIMITS.grep_max_bytes);

  track.start('listing');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  let entries;
  if (Array.isArray(args.paths) && args.paths.length) {
    // explicit scan list (e.g. from grep_repo_plan) - no tree fetch needed
    entries = args.paths.slice(0, LIMITS.grep_files_cap).map(p => ({ path: String(p), size: 0 }));
  } else {
    entries = await fetchTree(env, owner, repo, branch);
    entries = applyPathFilters(entries, args);
    entries = rankGrepCandidates(entries, term, maxFiles, maxBytes).picked;
  }

  track.start('fetching');
  const matches = [];
  let scanned = 0, bytes = 0, stopped = null;
  for (let i = 0; i < entries.length && matches.length < maxMatches; i += 5) {
    const batch = entries.slice(i, i + 5);
    const contents = await Promise.all(batch.map(async e => {
      try { return { path: e.path, raw: await fetchFileContent(env, owner, repo, e.path, branch) }; }
      catch (err) { return { path: e.path, error: String(err.message || err) }; }
    }));
    for (const c of contents) {
      if (c.error || matches.length >= maxMatches) continue;
      scanned++;
      bytes += c.raw.length;
      const lines = c.raw.split('\n');
      for (let ln = 0; ln < lines.length && matches.length < maxMatches; ln++) {
        const hay = caseSensitive ? lines[ln] : lines[ln].toLowerCase();
        if (hay.includes(needle)) {
          matches.push({ path: c.path, line: ln + 1, snippet: lines[ln].trim().slice(0, 180) });
        }
      }
      if (bytes > maxBytes) { stopped = 'byte budget reached (' + maxBytes + 'B); raise max_bytes or narrow with include_prefixes'; break; }
    }
    if (stopped) break;
  }

  return {
    ok: true,
    repo: owner + '/' + repo + '@' + branch,
    term,
    total_matches: matches.length,
    matches,
    files_scanned: scanned,
    files_considered: entries.length,
    stopped_early: stopped || (matches.length >= maxMatches ? 'match cap reached' : undefined),
    hint: matches.length ? 'use read_file_range on a path+line for full context' : 'no matches in scanned files; try include filters or a different term',
    timings: track.finish()
  };
}

async function listRepoFiles(env, args) {
  const owner = ownerOf(env, args);
  const repo = String(args.repo || '').trim();
  if (!repo) throw new Error('repo required');
  const branch = await resolveBranch(env, owner, repo, args.ref);
  const tree = await gh(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  let entries = (tree.tree || []).filter(e => e.type === 'blob');
  const filter = args.filter ? String(args.filter) : null;
  if (filter) entries = entries.filter(e => e.path.includes(filter));
  return {
    ok: true,
    repo: owner + '/' + repo + '@' + branch,
    count: entries.length,
    files: entries.slice(0, 300).map(e => ({ path: e.path, size: e.size || 0 })),
    note: entries.length > 300 ? 'listing capped at 300; use filter to narrow' : undefined
  };
}

function status(env) {
  return {
    ok: true,
    worker: WORKER,
    deployed_as: env.WORKER_NAME || null,
    version: VERSION,
    model_default: MODEL_DEFAULT,
    model_deep: MODEL_DEEP + ' (pass as model param for hard questions; expect 40-70s+)',
    bindings: { AI: !!env.AI, GITHUB_TOKEN: !!env.GITHUB_TOKEN, DEFAULT_OWNER: !!env.DEFAULT_OWNER },
    private_repos: env.GITHUB_TOKEN ? 'enabled' : 'DISABLED - add the GITHUB_TOKEN secret to read private repos',
    tools: ['subagent_status', 'list_repo_files', 'read_file_range', 'grep_repo', 'grep_repo_plan', 'ask_repo', 'ask_files', 'ask_repo_light', 'investigate_repo'],
    limits: LIMITS
  };
}

// ---------------- MCP plumbing ----------------

const toolSchemas = [
  { name: 'subagent_status', description: 'Health check: bindings, models, limits.', inputSchema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'list_repo_files',
    description: 'Cheap server-side tree listing (no LLM).',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' }, filter: { type: 'string' }
    }, required: ['repo'] }
  },
  {
    name: 'read_file_range',
    description: 'Read an exact line window of one file (no LLM). Returns text plus total_lines/total_chars and a continuation hint if truncated at max_chars (cap 20000).',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' }, max_chars: { type: 'number' }
    }, required: ['repo', 'path'] }
  },
  {
    name: 'grep_repo',
    description: 'Exact-term search across a repo, entirely server-side (no LLM). On monorepos (100+ files) run grep_repo_plan FIRST to check coverage. Returns path + line + snippet per match with stage timings. Defaults: 40 files / 2MB, adjustable via max_files (cap 120) and max_bytes (cap 8MB). Narrow big monorepos with include_prefixes (startsWith, e.g. "apps/afo-link-lane/") or pass paths[] explicitly (e.g. from grep_repo_plan). term and pattern are synonyms.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      term: { type: 'string' }, pattern: { type: 'string' }, case_sensitive: { type: 'boolean' },
      include: { type: 'array', items: { type: 'string' }, description: 'substring path filters' },
      include_prefixes: { type: 'array', items: { type: 'string' }, description: 'startsWith path filters, e.g. "apps/afo-link-lane/"' },
      exclude: { type: 'array', items: { type: 'string' } },
      paths: { type: 'array', items: { type: 'string' }, description: 'scan exactly these paths, skipping tree ranking' },
      max_files: { type: 'number' }, max_bytes: { type: 'number' }, max_matches: { type: 'number' }
    }, required: ['repo'] }
  },
  {
    name: 'grep_repo_plan',
    description: 'Dry-run for grep_repo on big monorepos: no file contents fetched, near-instant. Shows which files WOULD be scanned for a term (ranked), filename matches, coverage percentage of the filtered tree, and a concrete suggestion (narrow with include_prefixes / raise max_files / pass paths). Use before grep_repo when the repo has hundreds of files.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      term: { type: 'string' }, pattern: { type: 'string' },
      include: { type: 'array', items: { type: 'string' } },
      include_prefixes: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      max_files: { type: 'number' }
    }, required: ['repo'] }
  },
  {
    name: 'ask_repo',
    description: 'Deeper open-ended synthesis over heuristically selected files - NOT the first-pass navigation tool (use ask_repo_light for orientation, investigate_repo for specific features/symbols). Reads files server-side. Files over 50KB get smart excerpts (structure + question-keyword windows) instead of blind truncation. Respects budget_ms (default 90000): on timeout returns PARTIAL results - files fetched, chars read, failing stage, per-stage timings, and a concrete suggested retry - never an opaque failure.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      question: { type: 'string' },
      include: { type: 'array', items: { type: 'string' } }, exclude: { type: 'array', items: { type: 'string' } },
      max_files: { type: 'number' }, model: { type: 'string' }, budget_ms: { type: 'number' }
    }, required: ['repo', 'question'] }
  },
  {
    name: 'ask_files',
    description: 'Subagent over explicit paths (max 25): reads them server-side and answers with citations. Best used AFTER deterministic evidence is collected (grep_repo / read_file_range) - feed it the paths those tools surfaced. Also the right retry after a timeout.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      question: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' }, budget_ms: { type: 'number' }
    }, required: ['repo', 'question', 'paths'] }
  },
  {
    name: 'investigate_repo',
    description: 'ONE-CALL auto flow for questions about a specific feature, symbol, version, or implementation status on any repo (especially monorepos): internally runs plan -> grep -> read hit files -> evidence-grounded synthesis, and reports the whole pipeline (probes, files scanned, files with hits). Falls back to ask_repo_light automatically for broad questions. Prefer this over manual grep+ask sequencing.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      question: { type: 'string' },
      include: { type: 'array', items: { type: 'string' } },
      include_prefixes: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      max_files: { type: 'number' }, model: { type: 'string' }, budget_ms: { type: 'number' }
    }, required: ['repo', 'question'] }
  },
  {
    name: 'ask_repo_light',
    description: 'DEFAULT orientation tool - use this FIRST on any repo you have not explored. Tree-first: a fast model picks relevant files from paths alone (heuristic fallback), then one answer call. For questions naming a specific symbol/version/feature, prefer investigate_repo instead.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' },
      question: { type: 'string' }, max_files: { type: 'number' },
      model: { type: 'string' }, selection_model: { type: 'string' }, budget_ms: { type: 'number' }
    }, required: ['repo', 'question'] }
  }
];

async function callTool(env, name, args) {
  if (name === 'subagent_status') return status(env);
  if (name === 'list_repo_files') return listRepoFiles(env, args || {});
  if (name === 'read_file_range') return readFileRange(env, args || {});
  if (name === 'grep_repo') return grepRepo(env, args || {});
  if (name === 'grep_repo_plan') return grepRepoPlan(env, args || {});
  if (name === 'ask_repo') return askRepo(env, args || {});
  if (name === 'ask_files') return askFiles(env, args || {});
  if (name === 'ask_repo_light') return askRepoLight(env, args || {});
  if (name === 'investigate_repo') return investigateRepo(env, args || {});
  throw new Error('Unknown tool: ' + name);
}

async function handleMcp(req, env) {
  const rpc = await readJson(req);
  const id = rpc.id == null ? null : rpc.id;
  try {
    if (rpc.method === 'initialize') {
      return json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: WORKER, version: VERSION } } });
    }
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204, headers: CORS });
    if (rpc.method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
    if (rpc.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: toolSchemas } });
    if (rpc.method === 'tools/call') {
      let result;
      try { result = await callTool(env, rpc.params && rpc.params.name, (rpc.params && rpc.params.arguments) || {}); }
      catch (e) { result = { ok: false, error: String(e.message || e) }; }
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result && result.ok === false } });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    return json({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/' || url.pathname === '/status' || url.pathname === '/health') return json(status(env));
      if (url.pathname === '/tools') return json({ ok: true, tools: toolSchemas });
      if (url.pathname === '/mcp') return handleMcp(req, env);
      if (req.method === 'POST' && url.pathname === '/call') {
        const b = await readJson(req);
        try { return json(await callTool(env, b.name, b.arguments || {})); }
        catch (e) { return json({ ok: false, error: String(e.message || e) }, 200); }
      }
      return json({ ok: false, error: 'not_found', worker: WORKER }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e), worker: WORKER }, 500);
    }
  }
};
