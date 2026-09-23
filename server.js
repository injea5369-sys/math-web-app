'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const ROOT = __dirname;
const MAX_BODY = 24 * 1024 * 1024;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 40;
const rate = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function clientIp(req) {
  const h = req.headers['x-forwarded-for'];
  return (Array.isArray(h) ? h[0] : String(h || req.socket.remoteAddress || 'unknown')).split(',')[0].trim();
}

function allowed(ip) {
  const now = Date.now();
  const x = rate.get(ip);
  if (!x || now - x.start >= WINDOW_MS) {
    rate.set(ip, { start: now, count: 1 });
    return true;
  }
  x.count += 1;
  return x.count <= MAX_REQUESTS_PER_WINDOW;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('요청 용량이 너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('잘못된 요청 형식입니다.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function dataImage(s) {
  return typeof s === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(s) && s.length <= 9_000_000;
}

function cleanText(s, max = 6000) {
  return String(s ?? '').slice(0, max);
}

function extractOutputText(x) {
  if (typeof x?.output_text === 'string') return x.output_text;
  return (x?.output || [])
    .flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(c => c?.type === 'output_text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n');
}

function parseJsonText(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function normalizeFeedback(f) {
  const arr = Array.isArray(f?.recognized_steps) ? f.recognized_steps : [];
  const concepts = Array.isArray(f?.concepts) ? f.concepts : [];
  return {
    verdict: cleanText(f?.verdict || '판단 보류', 80),
    recognized_steps: arr.slice(0, 20).map(x => cleanText(x, 500)),
    needs_clarification: Boolean(f?.needs_clarification),
    first_error: cleanText(f?.first_error || '확인 가능한 첫 오류를 특정하지 못했습니다.', 1200),
    explanation: cleanText(f?.explanation || '', 2400),
    concepts: concepts.slice(0, 8).map(x => cleanText(x, 300)),
    core_summary: cleanText(f?.core_summary || '', 1800),
    hint: cleanText(f?.hint || '', 1600),
    check_question: cleanText(f?.check_question || '', 1000),
    twin_problem: cleanText(f?.twin_problem || '', 1800),
    twin_answer: cleanText(f?.twin_answer || '', 600),
    variant_problem: cleanText(f?.variant_problem || '', 1800),
    variant_answer: cleanText(f?.variant_answer || '', 600)
  };
}

async function diagnose(body) {
  const problem = body?.problem;
  const photos = Array.isArray(body?.photos) ? body.photos.slice(0, 3) : [];
  if (!dataImage(problem)) throw Object.assign(new Error('문제 이미지를 읽을 수 없습니다.'), { status: 400 });
  if (!photos.every(dataImage)) throw Object.assign(new Error('풀이 사진 형식이 올바르지 않습니다.'), { status: 400 });

  const meta = [
    `과목: ${cleanText(body.subject, 80)}`,
    `단원: ${cleanText(body.unit, 120)}`,
    `배점: ${cleanText(body.points, 10)}점`,
    `정답: ${cleanText(body.correctAnswer, 30)}`,
    `학생 제출 답: ${cleanText(body.answer, 30)}`,
    `학생 메모: ${cleanText(body.note, 6000) || '(없음)'}`
  ].join('\n');

  const prompt = `당신은 한국 수능 수학 과외교사를 돕는 풀이 진단 AI다. 문제 이미지와 학생의 풀이 사진/메모를 비교해 학생이 정확히 어디에서 막혔는지 진단하라.\n\n${meta}\n\n원칙:\n- 학생이 실제로 적은 식을 가능한 한 순서대로 판독하되, 흐리면 추측하지 말고 needs_clarification=true로 둔다.\n- 정답 여부만 보지 말고 처음 잘못된 단계 또는 가장 먼저 보완할 단계를 찾는다.\n- 필요한 선행 개념이나 풀이 기술을 한국 고등학교 수학 용어로 짧게 정리한다.\n- 학생이 다시 풀 수 있도록 정답을 바로 주입하기보다 핵심 힌트를 준다.\n- 마지막에는 원문과 같은 핵심 개념을 쓰는 쌍둥이 문제 1개와, 조건을 한 단계 바꾼 변형 문제 1개를 새로 만든다. 둘 다 자가검산 가능한 정확한 정답을 제공한다.\n- 문제에 없는 조건을 만들지 말고, 이미지 판독이 불확실하면 그 사실을 명시한다.\n- 모든 설명은 한국어로 한다.\n\n반드시 아래 키를 모두 가진 JSON 객체 하나만 출력하라. 마크다운 코드블록은 쓰지 마라.\n{\n  "verdict":"정답/오답/풀이 보완 필요/판단 보류 중 하나",\n  "recognized_steps":["판독한 풀이 단계"],\n  "needs_clarification":false,\n  "first_error":"처음 잘못된 단계 또는 가장 먼저 확인할 부분",\n  "explanation":"왜 문제가 되는지",\n  "concepts":["필요 개념 또는 풀이 기술"],\n  "core_summary":"이 문제에서 반드시 기억할 핵심",\n  "hint":"다시 풀기 위한 힌트",\n  "check_question":"학생 이해를 확인할 질문 1개",\n  "twin_problem":"같은 핵심 개념의 새 문제",\n  "twin_answer":"쌍둥이 문제 정답",\n  "variant_problem":"조건을 한 단계 바꾼 새 문제",\n  "variant_answer":"변형 문제 정답"\n}`;

  const content = [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: problem, detail: 'high' },
    ...photos.map(x => ({ type: 'input_image', image_url: x, detail: 'high' }))
  ];

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content }],
      max_output_tokens: 3500
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = result?.error?.message || `OpenAI API 오류 (${response.status})`;
    throw Object.assign(new Error(msg), { status: response.status >= 500 ? 502 : 400 });
  }

  const text = extractOutputText(result);
  if (!text) throw Object.assign(new Error('AI 응답에서 텍스트를 찾지 못했습니다.'), { status: 502 });
  try {
    return normalizeFeedback(parseJsonText(text));
  } catch {
    throw Object.assign(new Error('AI 응답 형식을 해석하지 못했습니다. 다시 시도해 주세요.'), { status: 502 });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) return json(res, 404, { error: 'Not found' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data: https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { enabled: Boolean(OPENAI_API_KEY), model: MODEL, token: SESSION_TOKEN });
  }

  if (pathname === '/api/diagnose' && req.method === 'POST') {
    if (!OPENAI_API_KEY) return json(res, 503, { error: '서버에 OpenAI API 키가 아직 연결되지 않았습니다.' });
    if (req.headers['x-session-token'] !== SESSION_TOKEN) return json(res, 403, { error: '세션이 만료되었습니다. 페이지를 새로고침해 주세요.' });
    const ip = clientIp(req);
    if (!allowed(ip)) return json(res, 429, { error: 'AI 진단 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    try {
      const body = await readJson(req);
      const feedback = await diagnose(body);
      return json(res, 200, { feedback });
    } catch (e) {
      console.error(e);
      return json(res, e.status || 500, { error: e.message || '서버 오류가 발생했습니다.' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  return serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Math Web App listening on port ${PORT}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? 'configured' : 'not configured'} / model=${MODEL}`);
});