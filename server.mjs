import http from 'node:http';
import {readFile, unlink, stat} from 'node:fs/promises';
import {createReadStream, existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
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
function tmdb(path, params = {}, customApiKey = null) {
  const apiKey = (customApiKey || process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) throw fail('Set TMDB_API_KEY or enter your API key in Connection Details to enable movie search.', 503);
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return api(u);
}
async function search(u, customApiKey = null) {
  const title = (u.searchParams.get('q') || '').slice(0, 180),
        year = u.searchParams.get('year') || '',
        actor = (u.searchParams.get('actor') || '').trim(),
        production = (u.searchParams.get('production') || '').trim(),
        hint = langCode(u.searchParams.get('language')),
        imdb = title.match(/tt\d{7,10}/)?.[0];
  if (!title.trim()) throw fail('Enter a movie title.');
  let results;
  if (imdb) results = (await tmdb('/find/' + imdb, { external_source: 'imdb_id' }, customApiKey)).movie_results || [];
  else {
    results = (await tmdb('/search/movie', { query: title, year, include_adult: 'false' }, customApiKey)).results || [];
    if (!results.length && year) results = (await tmdb('/search/movie', { query: title, include_adult: 'false' }, customApiKey)).results || [];
    if (!results.length) {
      const cleaned = title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i, '').trim();
      if (cleaned && cleaned !== title) {
        results = (await tmdb('/search/movie', { query: cleaned, year, include_adult: 'false' }, customApiKey)).results || [];
        if (!results.length && year) results = (await tmdb('/search/movie', { query: cleaned, include_adult: 'false' }, customApiKey)).results || [];
      }
    }
    if (!results.length && /[:\-–—]/.test(title)) {
      const primary = title.split(/[:\-–—]/)[0].trim();
      if (primary.length > 2 && primary !== title) {
        results = (await tmdb('/search/movie', { query: primary, year, include_adult: 'false' }, customApiKey)).results || [];
        if (!results.length && year) results = (await tmdb('/search/movie', { query: primary, include_adult: 'false' }, customApiKey)).results || [];
      }
    }
    // If actor is provided and no results yet, try finding person to see known_for
    if (!results.length && actor) {
      try {
        const personData = await tmdb('/search/person', { query: actor, include_adult: 'false' }, customApiKey);
        const person = personData.results?.[0];
        if (person && Array.isArray(person.known_for)) {
          const matched = person.known_for.filter(kf => {
            const kfTitle = kf.title || kf.name || '';
            return norm(kfTitle).includes(norm(title)) || norm(title).includes(norm(kfTitle));
          });
          if (matched.length) results = matched;
        }
      } catch {}
    }
    if (!results.length) {
      try {
        const multi = (await tmdb('/search/multi', { query: title, include_adult: 'false' }, customApiKey)).results || [];
        results = multi.map(item => ({
          ...item,
          title: item.title || item.name || '',
          release_date: item.release_date || item.first_air_date || ''
        })).filter(m => m.poster_path || m.profile_path);
      } catch {}
    }
  }
  const score = (m, i) => 20 - i * 3 +
    ([m.title, m.original_title].some(t => norm(t) === norm(title)) ? 50 : 0) +
    (year && m.release_date?.startsWith(year) ? 30 : 0) +
    (hint && hint === m.original_language ? 25 : 0) +
    (actor && (m.overview || '').toLowerCase().includes(actor.toLowerCase()) ? 20 : 0);
  return results.slice(0, 12).map((m, i) => ({ ...m, score: score(m, i) })).sort((a, b) => b.score - a.score);
}
async function detail(id, language, customApiKey = null) {
  const m = await tmdb('/movie/' + id, { append_to_response: 'images,videos,credits', include_image_language: [langCode(language), 'en', 'null'].filter(Boolean).join(',') }, customApiKey);
  const target = langCode(language) || m.original_language;
  // Fetch all image/video languages; rank original language ahead of fallbacks.
  const [images, videos] = await Promise.all([
    tmdb(`/movie/${id}/images`, {}, customApiKey),
    tmdb(`/movie/${id}/videos`, { language: target }, customApiKey)
  ]);
  let all = [...(videos.results || []), ...(m.videos?.results || [])];
  const seen = new Set();
  const allowedTypes = ['Trailer', 'Teaser', 'Clip', 'Featurette', 'Behind the Scenes', 'Music Video', 'Bloopers', 'Song'];
  all = all.filter(v => v.site === 'YouTube' && (allowedTypes.includes(v.type) || !v.type) && !seen.has(v.key) && seen.add(v.key));
  all = all.map(v => {
    const nameLow = (v.name || '').toLowerCase();
    const typeLow = (v.type || '').toLowerCase();
    let category = 'Trailer';
    if (typeLow === 'teaser' || nameLow.includes('teaser') || nameLow.includes('glimpse') || nameLow.includes('first look')) {
      category = 'Teaser';
    } else if (nameLow.includes('song') || nameLow.includes('lyric') || nameLow.includes('audio') || typeLow === 'music video' || nameLow.includes('jukebox')) {
      category = 'Song';
    } else if (nameLow.includes('promo') || nameLow.includes('sneak peek') || nameLow.includes('spot') || typeLow === 'clip' || typeLow === 'featurette') {
      category = 'Promo';
    } else if (typeLow === 'trailer' || nameLow.includes('trailer')) {
      category = 'Trailer';
    }
    return {
      ...v,
      category,
      type: category,
      url: youtubeURL(v.key),
      score: (v.iso_639_1 === target ? 100 : 0) + (v.official ? 25 : 0) + (category === 'Trailer' ? 15 : category === 'Teaser' ? 10 : 5)
    };
  }).filter(v => v.url).sort((a, b) => b.score - a.score);
  const topCast = (m.credits?.cast || []).slice(0, 5).map(c => c.name).join(', ');
  const topProduction = (m.production_companies || []).slice(0, 3).map(p => p.name).join(', ');
  return {
    movie: {
      id: m.id,
      title: m.title,
      year: m.release_date?.slice(0, 4) || '',
      original_language: m.original_language,
      imdb_id: m.imdb_id,
      overview: m.overview,
      actor: topCast,
      production: topProduction
    },
    images: { poster: rankImages(images.posters || [], 'poster', target, m.original_language), backdrop: rankImages(images.backdrops || [], 'backdrop', target, m.original_language), logo: rankImages(images.logos || [], 'logo', target, m.original_language) },
    videos: all
  };
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

async function searchYouTubeScraper(query) {
  if (!query) return [];
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(/\"videoRenderer\":\{\"videoId\":\"([a-zA-Z0-9_-]{11})\"(?:.*?)\"title\":\{\"runs\":\[\{\"text\":\"(.*?)\"\}\]/g)];
    const seen = new Set();
    const videos = [];
    for (const m of matches) {
      const vidId = m[1];
      let vidTitle = (m[2] || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (seen.has(vidId)) continue;
      seen.add(vidId);
      const tLow = vidTitle.toLowerCase();
      let cat = 'Trailer';
      if (tLow.includes('teaser') || tLow.includes('glimpse') || tLow.includes('first look')) cat = 'Teaser';
      else if (tLow.includes('song') || tLow.includes('lyric') || tLow.includes('audio') || tLow.includes('music')) cat = 'Song';
      else if (tLow.includes('promo') || tLow.includes('sneak peek') || tLow.includes('spot') || tLow.includes('clip')) cat = 'Promo';
      videos.push({
        name: vidTitle,
        url: `https://www.youtube.com/watch?v=${vidId}`,
        type: cat,
        category: cat,
        iso_639_1: ''
      });
      if (videos.length >= 10) break;
    }
    return videos;
  } catch (err) {
    console.warn('searchYouTubeScraper notice:', err.message);
    return [];
  }
}

async function fetchMovieAssets(title, year, language, customTmdbKey = null, customYtKey = null) {
  let poster_remote = '';
  let tmdb_id = null;
  let trailer_url = '';
  const effectiveTmdb = (customTmdbKey || process.env.TMDB_API_KEY || '').trim();
  const effectiveYt = (customYtKey || process.env.YOUTUBE_API_KEY || '').trim();

  if (title) {
    // 1. Multi-tier TMDB Search Strategy (Exact -> No Year -> Cleaned Base Title)
    if (effectiveTmdb) {
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
          const results = await search(u, effectiveTmdb);
          if (results && results.length > 0) {
            const top = results[0];
            if (!tmdb_id) tmdb_id = top.id;
            if (!poster_remote && top.poster_path) {
              poster_remote = `https://image.tmdb.org/t/p/w500${top.poster_path}`;
            }
            try {
              const det = await detail(top.id, language, effectiveTmdb);
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
    if (!trailer_url && effectiveYt && !youtubeQuotaExceeded) {
      const q = (title + (year ? ' ' + year : '')).trim().toLowerCase();
      if (youtubeCache.has(q)) {
        const cached = youtubeCache.get(q);
        if (cached.length > 0) trailer_url = cached[0].url;
      } else {
        try {
          const url = new URL('https://www.googleapis.com/youtube/v3/search');
          url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '1', q: title + ' official trailer', key: effectiveYt });
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

    // 3. Fallback: Search YouTube public interface for real working watch link
    if (!trailer_url) {
      const cleanTitle = title.replace(/[:\-–—]\s*(encore|re-release|re-issue|imax|scope|flat|infinity\s*vision|part\s*\d+).*$/i, '').trim() || title;
      const q = [cleanTitle, year, 'official trailer'].filter(Boolean).join(' ');
      const scraped = await searchYouTubeScraper(q);
      if (scraped.length > 0) {
        trailer_url = scraped[0].url;
      } else {
        const fallbackScraped = await searchYouTubeScraper(`${cleanTitle} trailer`);
        if (fallbackScraped.length > 0) {
          trailer_url = fallbackScraped[0].url;
        }
      }
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

async function downloadTrailerVideo(trailerUrl, movieTitle = 'trailer') {
  if (!trailerUrl || typeof trailerUrl !== 'string') {
    throw fail('Trailer URL is required.');
  }

  // Resolve yt-dlp binary location
  const appRoot = fileURLToPath(new URL('.', import.meta.url));
  const localYtDlp = path.join(appRoot, 'bin', 'yt-dlp');

  let execCmd = 'yt-dlp';
  let execPrefix = [];
  if (existsSync(localYtDlp)) {
    // Run via python3 so it executes regardless of file permission bits
    execCmd = 'python3';
    execPrefix = [localYtDlp];
  }

  const safeTitle = (movieTitle || 'trailer')
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'trailer';

  const outTemplate = path.join(os.tmpdir(), `trailer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeTitle}.%(ext)s`);

  return new Promise((resolve, reject) => {
    // Quality preference: 720p/1080p MP4 with audio merged
    const args = [
      ...execPrefix,
      '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--no-playlist',
      '--max-filesize', '150M',
      '-o', outTemplate,
      trailerUrl
    ];

    const proc = spawn(execCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(fail('Download timed out after 60 seconds.', 504));
    }, 60000);

    proc.on('close', async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(fail(`Video download failed: ${stderr.slice(0, 160) || 'Unknown error'}`, 502));
      }

      // Find downloaded file matching pattern
      const expectedMp4 = outTemplate.replace('%(ext)s', 'mp4');
      const expectedMkv = outTemplate.replace('%(ext)s', 'mkv');
      const expectedWebm = outTemplate.replace('%(ext)s', 'webm');

      let targetFile = null;
      let ext = 'mp4';
      let mime = 'video/mp4';

      if (existsSync(expectedMp4)) {
        targetFile = expectedMp4;
        ext = 'mp4';
        mime = 'video/mp4';
      } else if (existsSync(expectedMkv)) {
        targetFile = expectedMkv;
        ext = 'mkv';
        mime = 'video/x-matroska';
      } else if (existsSync(expectedWebm)) {
        targetFile = expectedWebm;
        ext = 'webm';
        mime = 'video/webm';
      }

      if (!targetFile) {
        return reject(fail('Downloaded video file could not be located.', 500));
      }

      try {
        const fileStats = await stat(targetFile);
        resolve({
          filePath: targetFile,
          fileName: `${safeTitle}_trailer.${ext}`,
          fileSize: fileStats.size,
          mimeType: mime
        });
      } catch (statErr) {
        reject(statErr);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(fail(`Video download process error: ${err.message}`, 500));
    });
  });
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
    let reqUrl = req.url || '/';
    const matchedPath = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url'];
    if (matchedPath && !matchedPath.includes('index.mjs') && !matchedPath.includes('.mjs')) {
      const qIndex = reqUrl.indexOf('?');
      const query = qIndex !== -1 ? reqUrl.slice(qIndex) : '';
      reqUrl = matchedPath + (matchedPath.includes('?') ? '' : query);
    }
    const u = new URL(reqUrl, `${proto}://${hostHeader}`);
    // Support rewrites passing path param, e.g. /api/index.mjs?path=download-trailer
    if ((u.pathname === '/api/index.mjs' || u.pathname === '/api/index' || u.pathname === '/api') && u.searchParams.get('path')) {
      u.pathname = '/api/' + u.searchParams.get('path');
    }

    // API is same-origin. Prevent websites using a local server's credentials via browsers.
    if (u.pathname.startsWith('/api/') && req.headers.origin) {
      const originHost = new URL(req.headers.origin).hostname;
      const reqHost = hostHeader.split(':')[0];
      const isAllowed = originHost === reqHost || originHost === 'localhost' || originHost === '127.0.0.1' || originHost.endsWith('.run.app') || originHost.endsWith('.google.com') || originHost.endsWith('.vercel.app');
      if (!isAllowed) throw fail('Cross-origin request refused.', 403);
    }

    const clientTmdbKey = (req.headers['x-tmdb-api-key'] || u.searchParams.get('tmdb_key') || '').trim();
    const clientYtKey = (req.headers['x-youtube-api-key'] || u.searchParams.get('yt_key') || '').trim();
    const effectiveTmdbKey = clientTmdbKey || (process.env.TMDB_API_KEY || '').trim();
    const effectiveYtKey = clientYtKey || (process.env.YOUTUBE_API_KEY || '').trim();

    if (req.method === 'GET' && u.pathname === '/api/status') {
      return send(res, 200, {
        tmdb: !!effectiveTmdbKey,
        youtube: !!effectiveYtKey,
        tmdbSource: clientTmdbKey ? 'client' : (process.env.TMDB_API_KEY ? 'server' : 'none'),
        youtubeSource: clientYtKey ? 'client' : (process.env.YOUTUBE_API_KEY ? 'server' : 'none')
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/test-keys') {
      const b = await jsonBody(req).catch(() => ({}));
      const testTmdb = (b.tmdbKey || effectiveTmdbKey || '').trim();
      const testYt = (b.youtubeKey || effectiveYtKey || '').trim();
      let tmdbValid = false, tmdbMessage = '';
      if (testTmdb) {
        try {
          const testRes = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(testTmdb)}`);
          if (testRes.ok) {
            tmdbValid = true;
            tmdbMessage = 'TMDB API key is valid & working!';
          } else {
            tmdbMessage = testRes.status === 401 ? 'Invalid TMDB API key' : `TMDB HTTP ${testRes.status}`;
          }
        } catch (err) {
          tmdbMessage = err.message;
        }
      }
      let ytValid = false, ytMessage = '';
      if (testYt) {
        try {
          const testRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=test&key=${encodeURIComponent(testYt)}`);
          if (testRes.ok) {
            ytValid = true;
            ytMessage = 'YouTube API key is valid & working!';
          } else {
            ytMessage = testRes.status === 400 || testRes.status === 403 ? 'Invalid or restricted YouTube key' : `YouTube HTTP ${testRes.status}`;
          }
        } catch (err) {
          ytMessage = err.message;
        }
      }
      return send(res, 200, { tmdbValid, tmdbMessage, ytValid, ytMessage });
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
      return send(res, 200, { results: await search(u, effectiveTmdbKey) });
    }

    const match = u.pathname.match(/^\/api\/movie\/(\d+)$/);
    if (req.method === 'GET' && match) {
      return send(res, 200, await detail(match[1], u.searchParams.get('language'), effectiveTmdbKey));
    }

    if (req.method === 'GET' && u.pathname === '/api/fetch-movie-assets') {
      const title = u.searchParams.get('title') || '';
      const year = u.searchParams.get('year') || '';
      const lang = u.searchParams.get('language') || '';
      return send(res, 200, await fetchMovieAssets(title, year, lang, effectiveTmdbKey, effectiveYtKey));
    }

    if (req.method === 'GET' && u.pathname === '/api/youtube') {
      if (youtubeQuotaExceeded) throw fail('YouTube API quota reached for this session. Use manual trailer links.', 403);
      if (!effectiveYtKey) throw fail('Optional YouTube search needs YOUTUBE_API_KEY.', 503);
      const q = (u.searchParams.get('q') || '').trim().slice(0, 200);
      const year = (u.searchParams.get('year') || '').trim();
      const actor = (u.searchParams.get('actor') || '').trim();
      const production = (u.searchParams.get('production') || '').trim();
      const category = (u.searchParams.get('category') || '').trim().toLowerCase();
      const lang = (u.searchParams.get('language') || '').trim();
      if (!q) throw fail('Enter a search title.');

      let term = 'official trailer';
      if (category === 'teaser') term = 'official teaser glimpse';
      else if (category === 'song') term = 'song promo lyrical video song';
      else if (category === 'promo') term = 'promo sneak peek clip';
      else if (category === 'all') term = 'trailer teaser song promo';

      const fullQuery = [q, year, actor, production, lang, term].filter(Boolean).join(' ');
      const cacheKey = (fullQuery + '_' + category).toLowerCase();
      if (youtubeCache.has(cacheKey)) return send(res, 200, { videos: youtubeCache.get(cacheKey) });

      if (!effectiveYtKey || youtubeQuotaExceeded) {
        const scraped = await searchYouTubeScraper(fullQuery);
        if (scraped.length > 0) {
          youtubeCache.set(cacheKey, scraped);
          return send(res, 200, { videos: scraped });
        }
      }

      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '10', q: fullQuery, key: effectiveYtKey });
      try {
        const d = await api(url);
        const videos = (d.items || []).map(v => {
          const title = v.snippet.title || '';
          const tLow = title.toLowerCase();
          let cat = 'Trailer';
          if (tLow.includes('teaser') || tLow.includes('glimpse') || tLow.includes('first look')) cat = 'Teaser';
          else if (tLow.includes('song') || tLow.includes('lyric') || tLow.includes('audio') || tLow.includes('music')) cat = 'Song';
          else if (tLow.includes('promo') || tLow.includes('sneak peek') || tLow.includes('spot') || tLow.includes('clip')) cat = 'Promo';
          return {
            name: title,
            url: youtubeURL(v.id.videoId),
            type: cat,
            category: cat,
            iso_639_1: ''
          };
        });
        youtubeCache.set(cacheKey, videos);
        return send(res, 200, { videos });
      } catch (err) {
        if (err.message && (err.message.includes('403') || err.message.includes('quota'))) {
          youtubeQuotaExceeded = true;
        }
        // Seamless fallback to web scraper so user always receives active YouTube videos
        const scraped = await searchYouTubeScraper(fullQuery);
        if (scraped.length > 0) {
          youtubeCache.set(cacheKey, scraped);
          return send(res, 200, { videos: scraped });
        }
        return send(res, 200, { videos: [] });
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

    if ((req.method === 'GET' || req.method === 'POST') && (u.pathname === '/api/download-trailer' || u.pathname.endsWith('/download-trailer') || u.pathname.endsWith('/download-trailer.mjs'))) {
      let trailerUrl = '';
      let title = 'trailer';

      if (req.method === 'POST') {
        const b = await jsonBody(req).catch(() => ({}));
        trailerUrl = b.url || '';
        title = b.title || 'trailer';
      } else {
        trailerUrl = u.searchParams.get('url') || '';
        title = u.searchParams.get('title') || 'trailer';
      }

      if (!trailerUrl && u.searchParams.get('v')) {
        trailerUrl = `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
      }

      if (!trailerUrl) {
        throw fail('Trailer URL is required.');
      }

      const safeTitle = (title || 'trailer').replace(/[/\\?%*:|"<>]/g, '_').trim() || 'trailer';
      const fileName = `${safeTitle} Trailer.mp4`;

      // 1. Try local yt-dlp first
      try {
        const media = await downloadTrailerVideo(trailerUrl, title);
        res.writeHead(200, {
          'Content-Type': media.mimeType,
          'Content-Length': media.fileSize,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(media.fileName || fileName)}"`,
          'Cache-Control': 'no-cache'
        });

        const stream = createReadStream(media.filePath);
        stream.pipe(res);
        stream.on('close', async () => { try { await unlink(media.filePath); } catch {} });
        stream.on('error', async () => { try { await unlink(media.filePath); } catch {} });
        return;
      } catch (err) {
        // Fallback for cloud environment
      }

      const videoIdMatch = trailerUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      const videoId = videoIdMatch ? videoIdMatch[1] : '';

      return send(res, 200, {
        ok: true,
        title,
        safeTitle,
        trailerUrl,
        videoId,
        fileName,
        converterUrl: `https://10downloader.com/download?v=${encodeURIComponent(trailerUrl)}`
      });
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
