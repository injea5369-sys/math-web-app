'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=Number(process.env.PORT||3000),ROOT=__dirname;
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'', MODEL=process.env.OPENAI_MODEL||'gpt-5.6-luna', PASSWORD=process.env.KILLER_LAB_PASSWORD||'';
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg+xml':'image/svg+xml'};
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))}
function tokenFor(exp){const p=String(exp),sig=crypto.createHmac('sha256',PASSWORD).update(p).digest('base64url');return p+'.'+sig}
function validToken(t){if(!PASSWORD||!t||!t.includes('.'))return false;const parts=t.split('.'),p=parts[0],s=parts[1],exp=Number(p);if(!Number.isFinite(exp)||Date.now()>exp)return false;const want=crypto.createHmac('sha256',PASSWORD).update(p).digest('base64url');try{return crypto.timingSafeEqual(Buffer.from(s),Buffer.from(want))}catch{return false}}
function body(req,max=32*1024*1024){return new Promise((res,rej)=>{let n=0,ch=[];req.on('data',d=>{n+=d.length;if(n>max){rej(new Error('요청이 너무 큽니다.'));req.destroy();return}ch.push(d)});req.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString('utf8')||'{}'))}catch{rej(new Error('잘못된 요청입니다.'))}});req.on('error',rej)})}
function extractText(r){if(typeof r.output_text==='string'&&r.output_text)return r.output_text;return (r.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('')}
function parseJson(s){s=String(s||'').trim().replace(/^\`\`\`json\s*/i,'').replace(/\`\`\`$/,'').trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<a)throw new Error('AI 응답을 구조화하지 못했습니다.');return JSON.parse(s.slice(a,b+1))}
function auth(req){return validToken((req.headers.authorization||'').replace(/^Bearer\s+/i,''))}
function systemPrompt(level,history){return [
'너는 한국 수능 수학의 3점·4점, 준킬러·킬러까지 대비시키는 사고과정 코치다.',
'목표는 정답 제공이 아니라 사용자가 고난도 문항을 독립적으로 풀 역량을 쌓도록 만드는 것이다. 반드시 한국어로 답한다.',
'절대 규칙:',
'1. 정답, 완성 풀이, 핵심 치환/결정적 식을 바로 공개하지 않는다.',
'2. 학생 풀이에서 처음으로 사고가 끊긴 지점을 찾는다. 그 이후의 오류보다 최초 병목을 우선한다.',
'3. 문제의 모든 조건을 목록화하고 각 조건을 used / noticed_not_connected / unused / misread 중 하나로 분류한다.',
'4. 힌트 레벨 '+level+'을 엄격히 따른다.',
'0: 소크라테스식 질문 1개. 방향을 거의 노출하지 않는다.',
'1: 놓친 조건 또는 관찰 지점만 지적한다.',
'2: 관련 개념/정리 범주까지만 알려준다.',
'3: 서로 연결해야 할 조건 2개를 알려주되 식은 주지 않는다.',
'4: 첫 중간목표 또는 식의 형태만 제시한다. 실제 수치·결론은 주지 않는다.',
'5. 최종 답을 맞혔더라도 우연한 계산, 논리 비약, 조건 누락, 검산 부재를 따로 평가한다.',
'6. 손글씨가 불명확하면 추측하지 말고 needs_clarification에 적는다.',
'7. 매번 킬러까지 가는 역량을 0~5로 평가한다. 점수는 해당 풀이에서 보인 근거에만 기반한다.',
'8. 반복 습관은 제공된 과거 기록과 이번 풀이에 공통으로 드러날 때 강하게 지적한다.',
'평가 축: condition_reading 조건 해석, concept_selection 개념 선택, condition_connection 조건 연결, intermediate_goal 중간 목표, representation 표현 전환, execution 계산·전개, verification 검산, transfer 전이·일반화.',
'최근 기록 요약: '+JSON.stringify(history||[]),
'반드시 아래 JSON 구조만 출력:',
'{"correct_work":["..."],"first_block":"...","needs_clarification":"...","condition_map":[{"condition":"...","state":"used|noticed_not_connected|unused|misread","meaning":"..."}],"concepts":["..."],"next_question":"...","hint":"...","killer_feedback":{"stage":"기초 연결 형성|준킬러 적응|4점 안정화|킬러 진입 준비|킬러 사고 정교화","readiness_comment":"현재 킬러까지 가는 방향에서 무엇이 좋아지고/부족한지","scores":{"condition_reading":0,"concept_selection":0,"condition_connection":0,"intermediate_goal":0,"representation":0,"execution":0,"verification":0,"transfer":0},"bottleneck":"현재 가장 큰 병목 1개","habits":[{"name":"습관명","evidence":"이번/과거 기록에서의 근거","impact":"왜 고난도에서 치명적인지","correction":"구체적 교정 행동"}],"next_milestone":"다음 5~10문제에서 확인할 목표"}}'
].join('\n')}
async function analyze(data){const content=[{type:'input_text',text:systemPrompt(Number(data.hintLevel||0),data.history)+'\n\n문제명: '+(data.title||'')+'\n태그: '+(data.tags||'')+'\n사용자 메모: '+(data.note||'')+'\n같은 문제의 이전 분석: '+JSON.stringify((data.previousAnalyses||[]).slice(-4))}];for(const x of (data.problemImages||[]).slice(0,4))content.push({type:'input_image',image_url:x,detail:'high'});for(const x of (data.solutionImages||[]).slice(0,6))content.push({type:'input_image',image_url:x,detail:'high'});const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':'Bearer '+OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,input:[{role:'user',content}],max_output_tokens:3000})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j&&j.error&&j.error.message)||('OpenAI API 오류 '+r.status));return parseJson(extractText(j))}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,aiConfigured:Boolean(OPENAI_API_KEY),passwordConfigured:Boolean(PASSWORD),model:MODEL});if(req.method==='POST'&&u.pathname==='/api/login'){const b=await body(req,1024*20);if(!PASSWORD)return json(res,503,{error:'접속 암호가 설정되지 않았습니다.'});if(String(b.password||'')!==PASSWORD)return json(res,401,{error:'암호가 맞지 않습니다.'});return json(res,200,{token:tokenFor(Date.now()+1000*60*60*24*30)})}if(req.method==='POST'&&u.pathname==='/api/analyze'){if(!auth(req))return json(res,401,{error:'인증이 필요합니다.'});if(!OPENAI_API_KEY)return json(res,503,{error:'OpenAI API가 연결되지 않았습니다.'});const b=await body(req);const analysis=await analyze(b);return json(res,200,{analysis})}if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Method not allowed'});let rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname).replace(/^\/+/, '');rel=path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');const file=path.join(ROOT,rel);if(!file.startsWith(ROOT))return json(res,404,{error:'Not found'});fs.stat(file,(err,st)=>{if(err||!st.isFile())return json(res,404,{error:'Not found'});const ext=path.extname(file).toLowerCase();res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Content-Length':st.size,'Cache-Control':ext==='.html'?'no-cache':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res)})}catch(e){json(res,500,{error:e.message||'서버 오류'})}});
server.listen(PORT,'0.0.0.0',()=>console.log('Killer Lab listening on port '+PORT+'; OpenAI='+(OPENAI_API_KEY?'configured':'not configured')+'; password='+(PASSWORD?'configured':'not configured')+'; model='+MODEL));