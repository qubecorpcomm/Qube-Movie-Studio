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
  else {
    results=(await tmdb('/search/movie',{query:title,year,include_adult:'false'})).results||[];
    if(!results.length&&year)results=(await tmdb('/search/movie',{query:title,include_adult:'false'})).results||[];
    if(!results.length){
      const cleaned=title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i,'').trim();
      if(cleaned&&cleaned!==title){
        results=(await tmdb('/search/movie',{query:cleaned,year,include_adult:'false'})).results||[];
        if(!results.length&&year)results=(await tmdb('/search/movie',{query:cleaned,include_adult:'false'})).results||[];
      }
    }
    if(!results.length&&/[:\-–—]/.test(title)){
      const primary=title.split(/[:\-–—]/)[0].trim();
      if(primary.length>2&&primary!==title){
        results=(await tmdb('/search/movie',{query:primary,year,include_adult:'false'})).results||[];
        if(!results.length&&year)results=(await tmdb('/search/movie',{query:primary,include_adult:'false'})).results||[];
      }
    }
    if(!results.length){
      try {
        const multi = (await tmdb('/search/multi',{query:title,include_adult:'false'})).results||[];
        results = multi.map(item=>({
          ...item,
          title: item.title || item.name || '',
          release_date: item.release_date || item.first_air_date || ''
        })).filter(m => m.poster_path || m.profile_path);
      } catch {}
    }
  }
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
  if(u.protocol!=='https:'||u.port||u.username||u.password||!['image.tmdb.org','i.ytimg.com','upload.wikimedia.org','wikimedia.org'].includes(u.hostname))throw fail('Embedding and downloads support TMDB images or uploaded images. Upload this external image instead.');
  const r=await fetch(u,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw fail('Could not download image.',502);
  const mime=r.headers.get('content-type')?.split(';')[0];if(!['image/jpeg','image/png','image/webp','image/gif'].includes(mime))throw fail('The address did not return an image.');
  let chunks=[],size=0;for await(const c of r.body){size+=c.length;if(size>LIMIT){throw fail('Image exceeds 10 MB.');}chunks.push(c);}return {buffer:Buffer.concat(chunks),mime};
}
async function dependency(pkg) {
  try {
    return await import(pkg);
  } catch {
    return null;
  }
}

let youtubeQuotaExceeded = false;
const youtubeCache = new Map();

async function fetchMovieAssets(title, year, language) {
  let poster_remote = '';
  let tmdb_id = null;
  let trailer_url = '';

  if (title) {
    // 1. Multi-tier TMDB Search Strategy (Exact -> No Year -> Cleaned Base Title)
    if (process.env.TMDB_API_KEY) {
      const cleanTitle = title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i, '').trim();
      const searchQueries = [
        { q: title, year },
        { q: title, year: '' },
        { q: cleanTitle, year: '' }
      ].filter(item => item.q);

      for (const queryObj of searchQueries) {
        if (poster_remote && trailer_url) break;
        try {
          const u = new URL('http://localhost/api/search');
          u.searchParams.set('q', queryObj.q);
          if (queryObj.year) u.searchParams.set('year', queryObj.year);
          if (language) u.searchParams.set('language', language);
          const results = await search(u);
          if (results && results.length > 0) {
            const top = results[0];
            if (!tmdb_id) tmdb_id = top.id;
            if (!poster_remote && top.poster_path) {
              poster_remote = `https://image.tmdb.org/t/p/w500${top.poster_path}`;
            }
            try {
              const det = await detail(top.id, language);
              if (!trailer_url && det.videos && det.videos.length > 0) {
                trailer_url = det.videos[0].url;
              }
              if (!poster_remote && det.images?.poster?.[0]?.url) {
                poster_remote = det.images.poster[0].url;
              }
            } catch {
              // ignore detail error
            }
          }
        } catch {
          // ignore tmdb search error
        }
      }
    }

    // 2. YouTube Search for Trailer
    if (!trailer_url && process.env.YOUTUBE_API_KEY && !youtubeQuotaExceeded) {
      const q = (title + (year ? ' ' + year : '')).trim().toLowerCase();
      if (youtubeCache.has(q)) {
        const cached = youtubeCache.get(q);
        if (cached.length > 0) trailer_url = cached[0].url;
      } else {
        try {
          const url = new URL('https://www.googleapis.com/youtube/v3/search');
          url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '1', q: title + ' official trailer', key: process.env.YOUTUBE_API_KEY });
          const d = await api(url);
          const videos = (d.items || []).map(v => ({ name: v.snippet.title, url: youtubeURL(v.id.videoId), type: 'YouTube search' }));
          youtubeCache.set(q, videos);
          if (videos.length > 0) trailer_url = videos[0].url;
        } catch (err) {
          if (err.message && (err.message.includes('403') || err.message.includes('quota'))) {
            youtubeQuotaExceeded = true;
          }
        }
      }
    }

    // 3. Fallback YouTube Search URL
    if (!trailer_url) {
      const cleanTitle = title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i, '').trim() || title;
      trailer_url = `https://www.youtube.com/results?search_query=${encodeURIComponent((cleanTitle + ' official trailer').trim())}`;
    }

    // 4. Fallback Poster from Wikipedia API if TMDB search returns no poster
    if (!poster_remote) {
      const cleanTitle = title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i, '').trim() || title;
      const wikiQueries = [cleanTitle, `${cleanTitle} (film)`, `${cleanTitle} (TV series)`, `${cleanTitle} (series)`, title];
      for (const wq of wikiQueries) {
        if (poster_remote) break;
        try {
          const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wq)}`, {
            headers: { 'User-Agent': 'MovieStudioApp/1.0 (contact@example.com)' },
            signal: AbortSignal.timeout(4000)
          });
          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            if (wikiData.thumbnail?.source) {
              poster_remote = wikiData.thumbnail.source;
            }
          }
        } catch {}
      }
    }

    // 5. Fallback Poster from YouTube Video Thumbnail if poster_remote is still empty
    if (!poster_remote && trailer_url) {
      const ytMatch = trailer_url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (ytMatch && ytMatch[1]) {
        poster_remote = `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
      }
    }
  }

  return { poster_remote, tmdb_id, trailer_url };
}

function fallbackPdfText(buffer) {
  try {
    const str = buffer.toString('latin1');
    const textBlocks = [];
    const regex = /\(([^()\\]|\\[\s\S])*\)\s*Tj|\[((?:\([^()\\]|\\[\s\S]*?\)|[^\]])*?)\]\s*TJ/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
      let raw = match[1] || match[2] || '';
      raw = raw.replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
               .replace(/\\(.)/g, '$1')
               .replace(/\)\s*\(/g, ' ')
               .replace(/[()]/g, '')
               .trim();
      if (raw.length > 1) textBlocks.push(raw);
    }
    return textBlocks.join('\n');
  } catch {
    return '';
  }
}

async function pdfText(buffer){
  let pdfjs;
  try {
    pdfjs = await dependency('pdfjs-dist/legacy/build/pdf.mjs','MOVIESTUDIO_PDF_MODULE');
  } catch {
    pdfjs = null;
  }

  if (pdfjs && pdfjs.getDocument) {
    let doc;
    try {
      doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        isEvalSupported: false,
        disableFontFace: true
      }).promise;
      if (doc.numPages > 150) throw fail('PDF limit is 150 pages.');
      let text = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i), content = await page.getTextContent(), lines = [];
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          let y = item.transform[5], line = lines.find(l => Math.abs(l.y - y) < 3);
          if (!line) { line = { y, items: [] }; lines.push(line); }
          line.items.push(item);
        }
        for (const line of lines.sort((a, b) => b.y - a.y)) {
          let end = null, s = '';
          for (const item of line.items.sort((a, b) => a.transform[4] - b.transform[4])) {
            if (end !== null) s += item.transform[4] - end > Math.max(12, item.height * 1.2) ? '\t' : ' ';
            s += item.str;
            end = item.transform[4] + item.width;
          }
          text.push(s);
        }
      }
      const extracted = text.join('\n').trim();
      if (extracted) return extracted;
    } catch {
      // Fallback if pdfjs error
    } finally {
      if (doc) await doc.destroy().catch(() => {});
    }
  }

  const fallback = fallbackPdfText(buffer);
  if (fallback.trim()) return fallback;
  throw fail('This PDF has no selectable text. Paste its text or use OCR first.');
}
async function readAssetFile(relativePath) {
  const clean = relativePath.replace(/^\/+/, '');
  const candidates = [
    new URL(clean, publicDir),
    new URL(`./public/${clean}`, import.meta.url),
    new URL(clean, `file://${process.cwd()}/public/`),
    new URL(`./${clean}`, `file://${process.cwd()}/`)
  ];
  for (const c of candidates) {
    try {
      return await readFile(c);
    } catch {}
  }
  throw fail('File not found: ' + relativePath, 404);
}

export async function handleRequest(req, res) {
  try {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const u = new URL(req.url, `${proto}://${hostHeader}`);

    // API is same-origin. Prevent websites using a local server's credentials via browsers.
    if (u.pathname.startsWith('/api/') && req.headers.origin) {
      const originHost = new URL(req.headers.origin).hostname;
      const reqHost = hostHeader.split(':')[0];
      const isAllowed = originHost === reqHost || originHost === 'localhost' || originHost === '127.0.0.1' || originHost.endsWith('.run.app') || originHost.endsWith('.google.com') || originHost.endsWith('.vercel.app');
      if (!isAllowed) throw fail('Cross-origin request refused.', 403);
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      return send(res, 200, { tmdb: !!process.env.TMDB_API_KEY, youtube: !!process.env.YOUTUBE_API_KEY });
    }

    if (req.method === 'GET' && u.pathname === '/api/firebase-config') {
      const configCandidates = [
        new URL('./firebase-applet-config.json', import.meta.url),
        new URL('./firebase-applet-config.json', `file://${process.cwd()}/`)
      ];
      for (const cand of configCandidates) {
        try {
          const configData = await readFile(cand, 'utf8');
          return send(res, 200, JSON.parse(configData));
        } catch {}
      }
      return send(res, 404, { error: 'Firebase config not found.' });
    }

    if (req.method === 'GET' && u.pathname === '/api/search') {
      return send(res, 200, { results: await search(u) });
    }

    const match = u.pathname.match(/^\/api\/movie\/(\d+)$/);
    if (req.method === 'GET' && match) {
      return send(res, 200, await detail(match[1], u.searchParams.get('language')));
    }

    if (req.method === 'GET' && u.pathname === '/api/fetch-movie-assets') {
      const title = u.searchParams.get('title') || '';
      const year = u.searchParams.get('year') || '';
      const lang = u.searchParams.get('language') || '';
      return send(res, 200, await fetchMovieAssets(title, year, lang));
    }

    if (req.method === 'GET' && u.pathname === '/api/youtube') {
      if (youtubeQuotaExceeded) throw fail('YouTube API quota reached for this session. Use manual trailer links.', 403);
      if (!process.env.YOUTUBE_API_KEY) throw fail('Optional YouTube search needs YOUTUBE_API_KEY.', 503);
      const q = (u.searchParams.get('q') || '').trim().toLowerCase().slice(0, 200);
      if (!q) throw fail('Enter a search title.');
      if (youtubeCache.has(q)) return send(res, 200, { videos: youtubeCache.get(q) });
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '6', q: q + ' official trailer', key: process.env.YOUTUBE_API_KEY });
      try {
        const d = await api(url);
        const videos = (d.items || []).map(v => ({ name: v.snippet.title, url: youtubeURL(v.id.videoId), type: 'YouTube search', iso_639_1: '' }));
        youtubeCache.set(q, videos);
        return send(res, 200, { videos });
      } catch (err) {
        if (err.message && (err.message.includes('403') || err.message.includes('quota'))) {
          youtubeQuotaExceeded = true;
          throw fail('YouTube API quota reached for this session. Use manual trailer links.', 403);
        }
        throw err;
      }
    }

    if (req.method === 'POST' && u.pathname === '/api/pdf') {
      return send(res, 200, { text: await pdfText(await body(req)) });
    }

    if (req.method === 'POST' && u.pathname === '/api/embed') {
      const b = await jsonBody(req), i = await imageBytes(b.url);
      return send(res, 200, { url: `data:${i.mime};base64,${i.buffer.toString('base64')}` });
    }

    if (req.method === 'POST' && u.pathname === '/api/artwork.zip') {
      const { assets } = await jsonBody(req);
      if (!Array.isArray(assets) || !assets.length || assets.length > 60) throw fail('Choose between 1 and 60 images per ZIP.');
      let JSZip;
      try {
        JSZip = (await dependency('jszip', 'MOVIESTUDIO_ZIP_MODULE')).default;
      } catch {
        throw fail('ZIP support is not installed. Run npm install.', 503);
      }
      const zip = new JSZip();
      let total = 0;
      for (const [n, a] of assets.entries()) {
        const i = await imageBytes(a.url);
        total += i.buffer.length;
        if (total > 100 * 1024 * 1024) throw fail('This ZIP exceeds 100 MB. Download fewer images.');
        const name = String(a.name || 'artwork').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 100);
        zip.file(`${n + 1}_${name}.${i.mime.split('/')[1]}`, i.buffer);
      }
      res.setHeader('Content-Disposition', 'attachment; filename="movie-artwork.zip"');
      return send(res, 200, await zip.generateAsync({ type: 'nodebuffer' }), 'application/zip');
    }

    const files = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/app.mjs': 'app.mjs',
      '/core.mjs': 'core.mjs',
      '/style.css': 'style.css',
      '/firebase-applet-config.json': 'firebase-applet-config.json'
    };

    if (req.method === 'GET' && files[u.pathname]) {
      const name = files[u.pathname];
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8';
      const fileBuf = await readAssetFile(name);
      return send(res, 200, fileBuf, type);
    }

    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Unable to complete this request. Please retry.' });
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

export default handleRequest;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => console.log(`Movie Studio is ready at http://${host}:${port}`));
}
