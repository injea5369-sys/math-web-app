'use strict';
const http=require('http');
const fs=require('fs');
const path=require('path');
const PORT=Number(process.env.PORT||3000);
const ROOT=__dirname;
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
function send(res,status,body,type='text/plain; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});res.end(body)}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,'Method not allowed');
  let rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname).replace(/^\/+/, '');
  rel=path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file=path.join(ROOT,rel);
  if(!file.startsWith(ROOT))return send(res,404,'Not found');
  fs.stat(file,(err,stat)=>{
    if(err||!stat.isFile())return send(res,404,'Not found');
    const ext=path.extname(file).toLowerCase();
    res.writeHead(200,{
      'Content-Type':MIME[ext]||'application/octet-stream',
      'Content-Length':stat.size,
      'Cache-Control':ext==='.html'?'no-cache':'public, max-age=300',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'strict-origin-when-cross-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data: https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    if(req.method==='HEAD')return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Student Free Math App listening on port ${PORT}`));