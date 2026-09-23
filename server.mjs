import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {rankImages,langCode,norm,youtubeURL} from './public/core.mjs';

const publicDir=new URL('./public/',import.meta.url), cache=new Map();
const LIMIT=10*1024*1024;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
async function body(req){let chunks=[],n=0;for await(const c of req){n+=c.length;if(n>LIMIT)throw fail('File is too large. Maximum 10 MB.',413);chunks.push(c);}return Buffer.concat(chunks);}
async function jsonBody(req){try{return JSON.parse((await body(req)).toString('utf8'));}catch(e){if(e.status)throw e;throw fail('Invalid JSON.');}}
function send(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);}
async function api(url){
  const key=url.toString(), existing=cache.get(key);if(existing&&existing.expires>Date.now())return existing.value;
  let r;try{r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw fail('The movie service could not be reached. Try again.',502);}
  if(!r.ok)throw fail(r.status===401?'TMDB rejected the API key.':r.status===429?'Service rate limit reached. Please retry shortly.':r.status===403?'Service access or quota limit reached.':`Movie service returned ${r.status}.`,502);
  const value=await r.json();if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(key,{value,expires:Date.now()+300000});return value;
}
function tmdb(path,params={}){if(!process.env.TMDB_API_KEY)throw fail('Set TMDB_API_KEY in the server environment to enable movie search.',503);const u=new URL('https://api.themoviedb.org/3'+path);u.searchParams.set('api_key',process.env.TMDB_API_KEY);for(const[k,v]of Object.entries(params))if(v)u.searchParams.set(k,v);return api(u);}
async function search(u){const title=(u.searchParams.get('q')||'').slice(0,180),year=u.searchParams.get('year')||'',hint=langCode(u.searchParams.get('language')),imdb=title.match(/tt\d{7,10}/)?.[0];if(!title.trim())throw fail('Enter a movie title.');let results;
  if(imdb)results=(await tmdb('/find/'+imdb,{external_source:'imdb_id'})).movie_results||[];
  else {results=(await tmdb('/search/movie',{query:title,year,include_adult:'false'})).results||[];if(!results.length&&year)results=(await tmdb('/search/movie',{query:title,include_adult:'false'})).results||[];}
  const score=(m,i)=>20-i*3+([m.title,m.original_title].some(t=>norm(t)===norm(title))?50:0)+(year&&m.release_date?.startsWith(year)?30:0)+(hint&&hint===m.original_language?25:0);
  return results.slice(0,12).map((m,i)=>({...m,score:score(m,i)})).sort((a,b)=>b.score-a.score);
}
async function detail(id,language){
  const m=await tmdb('/movie/'+id,{append_to_response:'images,videos',include_image_language:[langCode(language),'en','null'].filter(Boolean).join(',')});
  const target=langCode(language)||m.original_language;
  // Fetch all image/video languages; rank original language ahead of fallbacks.
  const [images,videos]=await Promise.all([tmdb(`/movie/${id}/images`),tmdb(`/movie/${id}/videos`,{language:target})]);
  let all=[...(videos.results||[]),...(m.videos?.results||[])];const seen=new Set();all=all.filter(v=>v.site==='YouTube'&&['Trailer','Teaser'].includes(v.type)&&!seen.has(v.key)&&seen.add(v.key));
  all=all.map(v=>({...v,url:youtubeURL(v.key),score:(v.iso_639_1===target?100:0)+(v.official?25:0)+(v.type==='Trailer'?10:0)})).filter(v=>v.url).sort((a,b)=>b.score-a.score);
  return {movie:{id:m.id,title:m.title,year:m.release_date?.slice(0,4)||'',original_language:m.original_language,imdb_id:m.imdb_id,overview:m.overview},images:{poster:rankImages(images.posters||[],'poster',target,m.original_language),backdrop:rankImages(images.backdrops||[],'backdrop',target,m.original_language),logo:rankImages(images.logos||[],'logo',target,m.original_language)},videos:all};
}
export async function imageBytes(value){
  if(typeof value!=='string')throw fail('Invalid image.');
  const data=value.match(/^data:image\/(png|jpeg|webp|gif);base64,([a-z0-9+/=\s]+)$/i);
  if(data){const b=Buffer.from(data[2],'base64');if(b.length>LIMIT)throw fail('Image exceeds 10 MB.');return {buffer:b,mime:'image/'+data[1].toLowerCase()};}
  let u;try{u=new URL(value);}catch{throw fail('Invalid image URL.');}
  if(u.protocol!=='https:'||u.port||u.username||u.password||!['image.tmdb.org','i.ytimg.com'].includes(u.hostname))throw fail('Embedding and downloads support TMDB images or uploaded images. Upload this external image instead.');
  const r=await fetch(u,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw fail('Could not download image.',502);
  const mime=r.headers.get('content-type')?.split(';')[0];if(!['image/jpeg','image/png','image/webp','image/gif'].includes(mime))throw fail('The address did not return an image.');
  let chunks=[],size=0;for await(const c of r.body){size+=c.length;if(size>LIMIT){throw fail('Image exceeds 10 MB.');}chunks.push(c);}return {buffer:Buffer.concat(chunks),mime};
}
async function dependency(name,env){return import(process.env[env]||name);}
async function pdfText(buffer){
  let pdfjs;try{pdfjs=await dependency('pdfjs-dist/legacy/build/pdf.mjs','MOVIESTUDIO_PDF_MODULE');}catch{throw fail('PDF reader is not installed. Run npm install in web-app.',503);}
  let doc;try{doc=await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false}).promise;if(doc.numPages>150)throw fail('PDF limit is 150 pages.');let text=[];
    for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent(),lines=[];
      for(const item of content.items){if(!('str'in item)||!item.str.trim())continue;let y=item.transform[5],line=lines.find(l=>Math.abs(l.y-y)<3);if(!line){line={y,items:[]};lines.push(line);}line.items.push(item);}
      for(const line of lines.sort((a,b)=>b.y-a.y)){let end=null,s='';for(const item of line.items.sort((a,b)=>a.transform[4]-b.transform[4])){if(end!==null)s+=item.transform[4]-end>Math.max(12,item.height*1.2)?'\t':' ';s+=item.str;end=item.transform[4]+item.width;}text.push(s);}}
    if(!text.join('').trim())throw fail('This PDF has no selectable text. Paste its text or use OCR first.');return text.join('\n');
  }catch(e){if(e.status)throw e;throw fail('Could not read this PDF. Use an unlocked PDF with selectable text.');}finally{if(doc)await doc.destroy();}
}
export function createServer(){return http.createServer(async(req,res)=>{
  try{const u=new URL(req.url,'http://localhost');
    // API is same-origin. Prevent websites using a local server's credentials via browsers.
    if(u.pathname.startsWith('/api/')&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('Cross-origin request refused.',403);
    if(req.method==='GET'&&u.pathname==='/api/status')return send(res,200,{tmdb:!!process.env.TMDB_API_KEY,youtube:!!process.env.YOUTUBE_API_KEY});
    if(req.method==='GET'&&u.pathname==='/api/search')return send(res,200,{results:await search(u)});
    const match=u.pathname.match(/^\/api\/movie\/(\d+)$/);
    if(req.method==='GET'&&match)return send(res,200,await detail(match[1],u.searchParams.get('language')));
    if(req.method==='GET'&&u.pathname==='/api/youtube'){
      if(!process.env.YOUTUBE_API_KEY)throw fail('Optional YouTube search needs YOUTUBE_API_KEY.',503);
      const q=(u.searchParams.get('q')||'').slice(0,200);if(!q)throw fail('Enter a search title.');const url=new URL('https://www.googleapis.com/youtube/v3/search');url.search=new URLSearchParams({part:'snippet',type:'video',maxResults:'6',q:q+' official trailer',key:process.env.YOUTUBE_API_KEY});
      const d=await api(url);return send(res,200,{videos:(d.items||[]).map(v=>({name:v.snippet.title,url:youtubeURL(v.id.videoId),type:'YouTube search',iso_639_1:''}))});
    }
    if(req.method==='POST'&&u.pathname==='/api/pdf')return send(res,200,{text:await pdfText(await body(req))});
    if(req.method==='POST'&&u.pathname==='/api/embed'){const b=await jsonBody(req),i=await imageBytes(b.url);return send(res,200,{url:`data:${i.mime};base64,${i.buffer.toString('base64')}`});}
    if(req.method==='POST'&&u.pathname==='/api/artwork.zip'){
      const {assets}=await jsonBody(req);if(!Array.isArray(assets)||!assets.length||assets.length>60)throw fail('Choose between 1 and 60 images per ZIP.');let JSZip;try{JSZip=(await dependency('jszip','MOVIESTUDIO_ZIP_MODULE')).default;}catch{throw fail('ZIP support is not installed. Run npm install.',503);}const zip=new JSZip();let total=0;
      for(const [n,a]of assets.entries()){const i=await imageBytes(a.url);total+=i.buffer.length;if(total>100*1024*1024)throw fail('This ZIP exceeds 100 MB. Download fewer images.');const name=String(a.name||'artwork').replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,100);zip.file(`${n+1}_${name}.${i.mime.split('/')[1]}`,i.buffer);}
      res.setHeader('Content-Disposition','attachment; filename="movie-artwork.zip"');return send(res,200,await zip.generateAsync({type:'nodebuffer'}),'application/zip');
    }
    const files={'/':'index.html','/index.html':'index.html','/app.mjs':'app.mjs','/core.mjs':'core.mjs','/style.css':'style.css'};
    if(req.method==='GET'&&files[u.pathname]){const name=files[u.pathname],type=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';return send(res,200,await readFile(new URL(name,publicDir)),type);}
    send(res,404,{error:'Not found.'});
  }catch(e){send(res,e.status||500,{error:e.status?e.message:'Unable to complete this request. Please retry.'});}
});}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){const port=Number(process.env.PORT)||3000,host=process.env.HOST||'0.0.0.0';createServer().listen(port,host,()=>console.log(`Movie Studio is ready at http://${host}:${port}`));}
