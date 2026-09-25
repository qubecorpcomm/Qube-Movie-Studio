export function langCode(lang) {
  if (!lang || typeof lang !== 'string') return '';
  const clean = lang.trim().toLowerCase();
  if (clean.length === 2) return clean;
  const map = {
    english: 'en',
    spanish: 'es',
    french: 'fr',
    german: 'de',
    italian: 'it',
    japanese: 'ja',
    korean: 'ko',
    chinese: 'zh',
    hindi: 'hi',
    tamil: 'ta',
    telugu: 'te',
    malayalam: 'ml',
    kannada: 'kn',
    portuguese: 'pt',
    russian: 'ru'
  };
  return map[clean] || clean.slice(0, 2);
}

export function norm(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function youtubeURL(key) {
  if (!key) return '';
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return `https://www.youtube.com/watch?v=${key}`;
}

export function rankImages(imagesList = [], type = 'poster', targetLang = '', originalLang = '') {
  const size = type === 'backdrop' ? 'w1280' : 'w500';
  const target = langCode(targetLang);
  const orig = langCode(originalLang);

  const ranked = (imagesList || []).map((img) => {
    const imgLang = img.iso_639_1 ? langCode(img.iso_639_1) : null;
    let score = 0;
    
    if (target && imgLang === target) {
      score += 1000;
    } else if (orig && imgLang === orig) {
      score += 500;
    } else if (imgLang === 'en') {
      score += 300;
    } else if (!imgLang) {
      score += 100;
    }

    score += (img.vote_average || 0) * 10;
    score += Math.min((img.vote_count || 0), 100);

    const path = img.file_path || '';
    const url = path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
    const fullUrl = path ? `https://image.tmdb.org/t/p/original${path}` : '';

    return {
      ...img,
      url,
      fullUrl,
      score
    };
  });

  return ranked.sort((a, b) => b.score - a.score);
}

export function normalizeLink(val) {
  if (!val || typeof val !== 'string') return '';
  let str = val.trim();
  str = str.replace(/^["'<]|["'>]$/g, '').trim();
  if (!str) return '';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str) && !str.startsWith('mailto:')) {
    return `mailto:${str}`;
  }
  // Direct YouTube 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return `https://www.youtube.com/watch?v=${str}`;
  }
  if (str.startsWith('//')) return `https:${str}`;
  if (/^www\./i.test(str)) return `https://${str}`;
  if (/^(https?|mailto|tel):/i.test(str)) return str;
  if (/^[a-z0-9+.-]+:/i.test(str)) return ''; // reject javascript:, data:, etc.
  return `https://${str}`;
}

export function sanitizeHeaderHtml(htmlStr) {
  if (!htmlStr || typeof htmlStr !== 'string') return '';
  let clean = htmlStr;

  // 1. Strip unauthorized block elements (script, style, embed, object, iframe, svg, form, input, button, etc.)
  clean = clean.replace(/<(script|style|embed|object|iframe|svg|form|input|button|applet|meta|link)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  clean = clean.replace(/<(script|style|embed|object|iframe|svg|form|input|button|applet|meta|link)\b[^>]*\/?>/gi, '');

  // 2. Remove inline event handlers (e.g. onclick, onload)
  clean = clean.replace(/\son[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');

  // 3. Remove unsubscribe blocks or lines
  clean = clean.replace(/<[^>]*>[^<]*unsubscribe[^<]*<\/[^>]*>/gi, '');
  clean = clean.split(/\r?\n/).filter(line => !/unsubscribe/i.test(line)).join('\n');

  // 4. Filter allowed tags: h1-h3, p, br, strong, b, em, i, u, a, span, div, ul, ol, li
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${clean}</div>`, 'text/html');
      const permittedTags = new Set(['H1', 'H2', 'H3', 'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'SPAN', 'DIV', 'UL', 'OL', 'LI']);

      function filterNode(parentNode) {
        const children = Array.from(parentNode.childNodes);
        for (const child of children) {
          if (child.nodeType === 1) { // Element node
            const tagName = child.tagName.toUpperCase();
            if (!permittedTags.has(tagName)) {
              // Unwrap unpermitted tag by inserting its children
              while (child.firstChild) {
                parentNode.insertBefore(child.firstChild, child);
              }
              parentNode.removeChild(child);
            } else {
              // Clean attributes on permitted tags
              const attrs = Array.from(child.attributes);
              for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                const val = attr.value;
                if (name.startsWith('on')) {
                  child.removeAttribute(attr.name);
                } else if (name === 'href' || name === 'src') {
                  if (/^\s*javascript:/i.test(val) || /^\s*data:/i.test(val)) {
                    child.removeAttribute(attr.name);
                  }
                } else if (!['href', 'target', 'style', 'class', 'id', 'align', 'dir', 'title', 'color'].includes(name)) {
                  child.removeAttribute(attr.name);
                }
              }
              filterNode(child);
            }
          }
        }
      }

      const root = doc.body.firstElementChild || doc.body;
      filterNode(root);
      clean = root.innerHTML;
    } catch (e) {
      console.warn('DOMParser sanitization notice:', e);
    }
  } else {
    // Fallback regex for Node.js testing environment
    clean = clean.replace(/<\/?(?!h1|h2|h3|p|br|strong|b|em|i|u|a|span|div|ul|ol|li\b)[a-z0-9]+\b[^>]*>/gi, '');
  }

  // Auto-link email addresses if not already in an a-tag
  clean = clean.replace(/(<a\b[^>]*>[\s\S]*?<\/a>)|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (match, aTag, email) => {
    if (aTag) return aTag;
    return `<a href="mailto:${email}" style="color:#2b6ef6;text-decoration:underline;font-weight:700;">${email}</a>`;
  });

  return clean.trim();
}

export function cleanCplName(str) {
  if (!str) return '';
  let cleaned = String(str);
  cleaned = cleaned.replace(/Feature Film Duration\s*:\s*\d{2}:\d{2}:\d{2}/gi, '');
  cleaned = cleaned.replace(/CPL\s+Part\s+\d+\s+Duration\s*:\s*\d{2}:\d{2}:\d{2}/gi, '');
  cleaned = cleaned.replace(/\s+\d{2}:\d{2}:\d{2}$/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/^[\s\-:|]+|[\s\-:|]+$/g, '');
  return cleaned.trim();
}

export function parseMovieListText(text) {
  if (!text || typeof text !== 'string') return [];
  const rawText = text.trim();
  if (!rawText) return [];

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];
  let currentMovie = null;

  const inferCplPart = (name) => {
    if (/(?:_|-|\b)P(?:art)?(?:0?1)(?:_|-|\b)/i.test(name)) return 'Part 1';
    if (/(?:_|-|\b)P(?:art)?(?:0?2)(?:_|-|\b)/i.test(name)) return 'Part 2';
    return '';
  };

  const addCpl = (movie, cplName, explicitPart = '') => {
    const cleaned = cleanCplName(cplName);
    if (!cleaned) return;
    const part = explicitPart || inferCplPart(cleaned);
    const existing = movie.cpls.find(c => c.name.toLowerCase() === cleaned.toLowerCase());
    if (!existing) {
      movie.cpls.push({ name: cleaned, part, duration: '' });
    }
  };

  const finalizeMovie = () => {
    if (currentMovie && currentMovie.title) {
      currentMovie.cplEntries = currentMovie.cpls.map(c => c.name).join('\n');
      currentMovie.featureDuration = currentMovie.feature_duration;
      currentMovie.cplPart1Duration = currentMovie.cpl_part1_duration;
      currentMovie.cplPart2Duration = currentMovie.cpl_part2_duration;
      currentMovie.firstFrameEndCredits = currentMovie.first_frame_end_credits;
      currentMovie.firstFrameMovingCredits = currentMovie.first_frame_moving_credits;
      results.push(currentMovie);
    }
    currentMovie = null;
  };

  const createMovieRecord = (title, year = '', language = '', distributor = '') => ({
    title: title.trim(),
    year: (year || '').trim(),
    language: (language || '').trim(),
    distributor: (distributor || '').trim(),
    feature_duration: '',
    featureDuration: '',
    cpl_part1_duration: '',
    cplPart1Duration: '',
    cpl_part2_duration: '',
    cplPart2Duration: '',
    first_frame_end_credits: '',
    firstFrameEndCredits: '',
    first_frame_moving_credits: '',
    firstFrameMovingCredits: '',
    cpls: [],
    cplEntries: '',
    poster_url: '',
    poster_remote: '',
    poster_mode: 'auto',
    trailer_url: '',
    trailer_mode: 'auto',
    tmdb_id: null,
    raw_block: [],
    include: true
  });

  // Check if text is structured Qube report
  const isQubeReport = /distributor:|feature film duration:|first frame end credits:|cpl part 1|movie name:/i.test(rawText) ||
    lines.some(l => /^(?:Movie Name\s*:|Distributor\s*:|Duration\s*:|CPL Part)/i.test(l));

  if (isQubeReport) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Ignore separator lines made only of underscores or dashes
      if (/^[_\-–—]{2,}$/.test(line)) continue;

      // Ignore standard bulletin headers like HELP DESK, Phone, email, Date range
      if (/^(HELP DESK|Phone:|e?Mail:|e-mail:|September|October|November|December|January|February|March|April|May|June|July|August|Page\s*\d+)\b/i.test(line) && !line.includes('(')) {
        continue;
      }

      // NEW format: "Movie Name: <title>"
      const newFormatMatch = line.match(/^Movie Name\s*:\s*(.+)/i);
      if (newFormatMatch) {
        finalizeMovie();
        currentMovie = createMovieRecord(newFormatMatch[1]);
        continue;
      }

      // OLD format: "<Title> (<YYYY>), <Language>" e.g. "Eko (2025), Telugu"
      const oldFormatMatch = line.match(/^(.+?)\s*\(((?:19|20)\d{2}|\d{4})\)\s*,\s*(.+)$/);
      if (oldFormatMatch) {
        finalizeMovie();
        currentMovie = createMovieRecord(oldFormatMatch[1], oldFormatMatch[2], oldFormatMatch[3]);
        continue;
      }

      // Format: "<Title> (<YYYY>)" where next lines contain Distributor: or CPL
      const titleYearMatch = line.match(/^(.+?)\s*\(((?:19|20)\d{2}|\d{4})\)$/);
      const isNextDistributor = i + 1 < lines.length && /^Distributor\s*:/i.test(lines[i + 1]);
      if (titleYearMatch && (isNextDistributor || (i + 1 < lines.length && lines[i + 1].includes('FTR')))) {
        finalizeMovie();
        currentMovie = createMovieRecord(titleYearMatch[1], titleYearMatch[2]);
        continue;
      }

      // Line without ":" where next line is Distributor
      if (isNextDistributor && !line.includes(':') && !/^(HELP DESK|Phone)/i.test(line)) {
        finalizeMovie();
        currentMovie = createMovieRecord(line);
        continue;
      }

      if (!currentMovie) {
        continue;
      }

      // Match labels case-insensitively and store EXACTLY as written
      const yearMatch = line.match(/^Year\s*:\s*(.+)/i);
      if (yearMatch) {
        currentMovie.year = yearMatch[1].trim();
        continue;
      }

      const langMatch = line.match(/^Language\s*:\s*(.+)/i);
      if (langMatch) {
        currentMovie.language = langMatch[1].trim();
        continue;
      }

      const distMatch = line.match(/^Distributor\s*:\s*(.+)/i);
      if (distMatch) {
        currentMovie.distributor = distMatch[1].trim();
        continue;
      }

      const featDurMatch = line.match(/^(?:Feature Film )?Duration\s*:\s*(.+)/i);
      if (featDurMatch && !/^CPL/i.test(line)) {
        currentMovie.feature_duration = featDurMatch[1].trim();
        currentMovie.featureDuration = currentMovie.feature_duration;
        continue;
      }

      const cplP1DurMatch = line.match(/^CPL Part 1 Duration\s*:\s*(.+)/i);
      if (cplP1DurMatch) {
        currentMovie.cpl_part1_duration = cplP1DurMatch[1].trim();
        currentMovie.cplPart1Duration = currentMovie.cpl_part1_duration;
        continue;
      }

      const cplP2DurMatch = line.match(/^CPL Part 2 Duration\s*:\s*(.+)/i);
      if (cplP2DurMatch) {
        currentMovie.cpl_part2_duration = cplP2DurMatch[1].trim();
        currentMovie.cplPart2Duration = currentMovie.cpl_part2_duration;
        continue;
      }

      const ffecMatch = line.match(/^First Frame End Credits\s*:\s*(.+)/i);
      if (ffecMatch) {
        currentMovie.first_frame_end_credits = ffecMatch[1].trim();
        currentMovie.firstFrameEndCredits = currentMovie.first_frame_end_credits;
        continue;
      }

      const ffmcMatch = line.match(/^First Frame Moving Credits\s*:\s*(.+)/i);
      if (ffmcMatch) {
        currentMovie.first_frame_moving_credits = ffmcMatch[1].trim();
        currentMovie.firstFrameMovingCredits = currentMovie.first_frame_moving_credits;
        continue;
      }

      // Trailer link / URL line
      const trailerMatch = line.match(/^(?:Trailer(?:\s*(?:URL|Link|Video))?|YouTube|Video)\s*:\s*(.+)/i);
      if (trailerMatch) {
        currentMovie.trailer_url = trailerMatch[1].trim();
        currentMovie.trailerUrl = currentMovie.trailer_url;
        currentMovie.selectedTrailer = currentMovie.trailer_url;
        currentMovie.trailer_mode = 'manual';
        continue;
      }

      // Poster link / image line
      const posterMatch = line.match(/^(?:Poster(?:\s*(?:URL|Link|Image))?|Artwork|Image)\s*:\s*(.+)/i);
      if (posterMatch) {
        currentMovie.poster_url = posterMatch[1].trim();
        currentMovie.posterUrl = currentMovie.poster_url;
        currentMovie.poster_remote = currentMovie.poster_url;
        currentMovie.selectedPoster = currentMovie.poster_url;
        currentMovie.poster_mode = 'manual';
        continue;
      }

      // Standalone YouTube URL
      if (/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s]+/i.test(line)) {
        currentMovie.trailer_url = line.trim();
        currentMovie.trailerUrl = currentMovie.trailer_url;
        currentMovie.selectedTrailer = currentMovie.trailer_url;
        continue;
      }

      // Standalone direct image URL
      if (/^https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.webp|\.gif)(?:\?[^\s]*)?$/i.test(line)) {
        currentMovie.poster_url = line.trim();
        currentMovie.posterUrl = currentMovie.poster_url;
        currentMovie.poster_remote = currentMovie.poster_url;
        currentMovie.selectedPoster = currentMovie.poster_url;
        continue;
      }

      // "Part N: <cpl name>"
      const partCplMatch = line.match(/^Part\s*(\d+)\s*:\s*(.+)/i);
      if (partCplMatch) {
        addCpl(currentMovie, partCplMatch[2], `Part ${partCplMatch[1]}`);
        continue;
      }

      // A line with no ":" that contains "FTR" as a token (between _ or - or whitespace)
      if (!line.includes(':') && /(?:^|[_\-])FTR(?:[_\-]|\d|$)/i.test(line)) {
        addCpl(currentMovie, line);
        continue;
      }

      // Anything else -> append to raw_block
      currentMovie.raw_block.push(line);
    }
    finalizeMovie();

    if (results.length > 0) return results;
  }

  // Standard line-by-line / CSV list fallback
  for (const line of lines) {
    if (/^title\s*,\s*year/i.test(line)) continue;
    
    const imdbMatch = line.match(/(tt\d{7,10})/);
    const imdbId = imdbMatch ? imdbMatch[1] : '';

    const csvMatch = line.match(/^"?([^",]+)"?\s*,\s*"?(\d{4})?"?/);
    if (csvMatch) {
      const rec = createMovieRecord(csvMatch[1], csvMatch[2] || '');
      rec.imdbId = imdbId;
      results.push(rec);
      continue;
    }

    const pipeMatch = line.match(/^([^|]+)\|\s*(\d{4})?(?:\|\s*(.+))?$/);
    if (pipeMatch) {
      const rec = createMovieRecord(pipeMatch[1], pipeMatch[2] || '', pipeMatch[3] || '');
      rec.imdbId = imdbId;
      results.push(rec);
      continue;
    }

    const yearMatch = line.match(/^(.*?)\s*\((\d{4})\)(?:\s+(.+))?$/);
    if (yearMatch) {
      const rec = createMovieRecord(yearMatch[1], yearMatch[2], yearMatch[3] || '');
      rec.imdbId = imdbId;
      results.push(rec);
    } else {
      const rec = createMovieRecord(line);
      rec.imdbId = imdbId;
      results.push(rec);
    }
  }

  return results;
}

export function extractBulletinMetadata(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const meta = {};
  
  const dateMatch = rawText.match(/(?:September|October|November|December|January|February|March|April|May|June|July|August)\s+\d{1,2}(?:\s*[-–—]\s*\d{1,2})?,\s*\d{4}/i);
  if (dateMatch) meta.scheduleDate = dateMatch[0].trim();

  const phoneMatch = rawText.match(/Phone:\s*([^\r\n]+)/i);
  if (phoneMatch) meta.helpDeskPhone = phoneMatch[1].trim();

  const emailMatch = rawText.match(/e?Mail:\s*([^\r\n]+)/i);
  if (emailMatch) meta.helpDeskEmail = emailMatch[1].trim();

  return meta;
}

function parseCPLBadges(cpl) {
  if (!cpl) return [];
  const badges = [];
  const clean = String(cpl);

  if (/(?:^|[_\-])OV(?:\*|[_\-]|$)/i.test(clean)) {
    badges.push({ text: 'OV', bg: '#dcfce7', color: '#15803d' });
  } else if (/(?:^|[_\-])VF(?:\*|[_\-]|$)/i.test(clean)) {
    badges.push({ text: 'VF', bg: '#dbeafe', color: '#1d4ed8' });
  }

  if (/(?:^|[_\-])4K(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '4K', bg: '#f3e8ff', color: '#7e22ce' });
  } else if (/(?:^|[_\-])2K(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '2K', bg: '#f1f5f9', color: '#475569' });
  }

  if (/(?:^|[_\-])3D(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '3D', bg: '#fef3c7', color: '#b45309' });
  } else if (/(?:^|[_\-])2D(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '2D', bg: '#f8fafc', color: '#334155' });
  }

  if (/(?:^|[_\-])(?:IAB|ATMOS)(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: 'IAB/Atmos', bg: '#ccfbf1', color: '#0f766e' });
  } else if (/(?:^|[_\-])71(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '7.1 Audio', bg: '#e0f2fe', color: '#0369a1' });
  } else if (/(?:^|[_\-])51(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: '5.1 Audio', bg: '#e0f2fe', color: '#0369a1' });
  }

  if (/(?:^|[_\-])CCAP(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: 'CCAP', bg: '#ecfdf5', color: '#047857' });
  }
  if (/(?:^|[_\-])OCAP(?:[_\-]|$)/i.test(clean)) {
    badges.push({ text: 'OCAP', bg: '#ecfdf5', color: '#047857' });
  }

  return badges;
}

export function generateNewsletterHTML(movies, config = {}) {
  const accentColor = config.accentColor || '#2b6ef6';
  const fontFamilyChoice = config.fontFamily || 'sans-serif';
  const fontStack = fontFamilyChoice === 'serif' ? 'Georgia, serif' : fontFamilyChoice === 'monospace' ? "'Courier New', monospace" : 'Inter,Arial,Helvetica,sans-serif';
  const isTwoColumn = config.layoutTemplate === 'two-column';

  const banner1Src = normalizeLink(config.topBannerUrl || config.banner1_src || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg');
  const banner1Link = normalizeLink(config.topBannerLink || config.banner1_link || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg');
  const banner2Src = normalizeLink(config.secondBannerUrl || config.banner2_src || 'https://i.ibb.co/spJ8m0Tg/02.jpg');
  const banner2Link = normalizeLink(config.secondBannerLink || config.banner2_link || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg');
  
  const defaultHeader = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "http://www.w3.org/TR/REC-html40/strict.dtd">
<html><head><meta name="qrichtext" content="1" /><meta charset="utf-8" /><style type="text/css">
p, li { white-space: pre-wrap; }
hr { height: 1px; border-width: 0; }
li.unchecked::marker { content: "\\2610"; }
li.checked::marker { content: "\\2612"; }
</style></head><body style=" font-family:'Segoe UI'; font-size:9pt; font-weight:400; font-style:normal;">
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">Keep tabs on the feature releases coming your way and plan your screening schedules seamlessly with our weekly feature report.</p>
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">Need further information? Call the Qube Wire support team at: (424) 343-2691 or</p>
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">write to: support@qubewire.com</p></body></html>`;

  const headerRaw = config.header_html || config.headerHtml || config.intro || defaultHeader;
  const headerHtml = sanitizeHeaderHtml(headerRaw);
  const footerText = config.footer || '';

  const movieList = Array.isArray(movies) ? movies : [];
  const activeMovies = movieList.filter(m => m && typeof m === 'object' && m.include !== false && m.checked !== false && m.selected !== false);

  const cardList = activeMovies.map(m => {
    // 1. Trailer URL determination (evaluated first so poster and title can link to it)
    const rawTrailer = (m.trailer_mode === 'manual' ? (m.trailer_url || m.trailerUrl || m.trailer) : null)
      || m.trailer_url
      || m.trailerUrl
      || m.trailer
      || m.selectedTrailer
      || m.videos?.[0]?.url
      || m.videoUrl
      || m.youtubeUrl
      || '';
    const trailerUrl = normalizeLink(rawTrailer);

    // 2. Poster determination by priority:
    let posterUrl = '';
    if (m.poster_mode === 'manual') {
      posterUrl = m.poster_url || m.posterUrl || m.selectedPoster || m.poster || m.poster_remote || m.images?.poster?.[0]?.url || '';
    } else {
      posterUrl = m.poster_remote || m.selectedPoster || m.poster_url || m.posterUrl || m.poster || m.images?.poster?.[0]?.url || '';
    }

    if (!posterUrl && trailerUrl) {
      const ytMatch = trailerUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (ytMatch && ytMatch[1]) {
        posterUrl = `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
      }
    }

    if (posterUrl && posterUrl.startsWith('/')) {
      posterUrl = posterUrl.startsWith('/w') || posterUrl.startsWith('/original')
        ? `https://image.tmdb.org/t/p${posterUrl}`
        : `https://image.tmdb.org/t/p/w500${posterUrl}`;
    }

    // 3. Poster cell rendering - Poster links to trailer if available, otherwise links to poster image
    const altTitle = (m.title || 'Movie Poster').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    const posterTargetLink = (trailerUrl && trailerUrl !== '#') ? trailerUrl : (posterUrl || '');
    let posterCell = '';

    if (posterUrl) {
      const posterImg = `<img src='${posterUrl}' alt='${altTitle}' width='120' height='170' style='display:block;border-radius:6px;border:1px solid #e9eef6;object-fit:cover;max-width:120px;width:120px;height:170px;'>`;
      if (posterTargetLink) {
        posterCell = `<a href='${posterTargetLink}' target='_blank' rel='noopener noreferrer' style='text-decoration:none;display:block;border:0;outline:none;'>${posterImg}</a>`;
      } else {
        posterCell = posterImg;
      }
    } else {
      const placeholderTable = `<table role='presentation' width='120' height='170' cellpadding='0' cellspacing='0' style='width:120px;height:170px;background:#f3f4f6;border-radius:6px;border:1px solid #e9eef6;'><tr><td align='center' valign='middle' style='color:#6b7280;font-family:Arial,Helvetica,sans-serif;font-size:12px;'>No Poster</td></tr></table>`;
      if (posterTargetLink) {
        posterCell = `<a href='${posterTargetLink}' target='_blank' rel='noopener noreferrer' style='text-decoration:none;display:block;border:0;outline:none;'>${placeholderTable}</a>`;
      } else {
        posterCell = placeholderTable;
      }
    }

    // 4. Subtitle: "Year / Language"
    let subtitle = '';
    if (m.year && m.language) {
      subtitle = `${m.year} / ${m.language}`;
    } else if (m.year) {
      subtitle = String(m.year);
    } else if (m.language) {
      subtitle = m.language;
    }

    // 5. Duration & Distributor
    const duration = m.feature_duration || m.featureDuration || '';
    const distributor = m.distributor || '';

    // 6. Trailer button (bulletproof Outlook VML + HTML table)
    let trailerButtonHtml = '';
    if (trailerUrl && trailerUrl !== '#') {
      trailerButtonHtml = `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
 href="${trailerUrl}"
 style="height:44px;v-text-anchor:middle;width:160px;" arcsize="8%" strokecolor="#2356c6" fillcolor="${accentColor}">
 <w:anchorlock/>
 <center style="color:#ffffff;font-family:Arial, Helvetica, sans-serif;font-size:16px;font-weight:bold;">
 Watch Trailer
 </center>
 </v:roundrect><![endif]-->
 <!--[if !mso]><!-->
 <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="vml-btn" style="display:inline-block;border-collapse:collapse;border:0;">
 <tr>
 <td align="center" valign="middle" bgcolor="${accentColor}" style="background-color:${accentColor};border-radius:6px;border:0;padding:0;">
 <a href="${trailerUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 20px;font-family:Arial, Helvetica, sans-serif;font-weight:700;font-size:16px;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;border:0;outline:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:100%;">Watch Trailer</a>
 </td>
 </tr>
 </table>
 <!--<![endif]-->`;
    } else {
      trailerButtonHtml = `<span style="display:inline-block;padding:10px 20px;font-family:Arial, Helvetica, sans-serif;font-weight:700;font-size:14px;line-height:20px;color:#6b7280;background-color:#e6e9ee;border-radius:6px;">No Trailer</span>`;
    }

    // 7. Title HTML - linked to trailer if available
    const titleHtml = (trailerUrl && trailerUrl !== '#')
      ? `<a href='${trailerUrl}' target='_blank' rel='noopener noreferrer' style='color:#0b1220;text-decoration:none;'>${m.title}</a>`
      : m.title;

    // 5. Short synopsis from raw_block
    let synopsisHtml = '';
    if (Array.isArray(m.raw_block) && m.raw_block.length > 0) {
      const synLines = m.raw_block
        .filter(l => l && !l.includes(m.title) && (!m.language || !l.includes(m.language)) && (!m.distributor || !l.includes(m.distributor)))
        .slice(0, 2)
        .join(' ')
        .trim();
      if (synLines) {
        const truncated = synLines.length > 220 ? synLines.slice(0, 220) + '...' : synLines;
        synopsisHtml = `<div style='font-family:Arial,Helvetica,sans-serif;color:#4b5563;font-size:12px;line-height:1.4;margin-bottom:8px;text-align:left;'>${truncated}</div>`;
      }
    }

    // 6. CPL Details box
    let cplNames = [];
    if (Array.isArray(m.cpls) && m.cpls.length > 0) {
      cplNames = m.cpls.map(c => c.name).filter(Boolean);
    } else if (m.cplEntries) {
      cplNames = m.cplEntries.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else if (m.cpl) {
      cplNames = [m.cpl];
    }
    // deduplicate case-insensitive
    const seenCpls = new Set();
    const uniqueCpls = [];
    for (const c of cplNames) {
      const lower = c.toLowerCase();
      if (!seenCpls.has(lower)) {
        seenCpls.add(lower);
        uniqueCpls.push(c);
      }
    }

    const cplPart1 = m.cpl_part1_duration || m.cplPart1Duration || '';
    const cplPart2 = m.cpl_part2_duration || m.cplPart2Duration || '';
    const ffec = m.first_frame_end_credits || m.firstFrameEndCredits || '';
    const ffmc = m.first_frame_moving_credits || m.firstFrameMovingCredits || '';

    const hasCplDetails = uniqueCpls.length > 0 || cplPart1 || cplPart2 || ffec || ffmc;
    let cplBoxHtml = '';

    if (hasCplDetails) {
      const cplLinesItems = uniqueCpls.map(c =>
        `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-bottom:8px;text-align:left;'>${c}</div>`
      ).join('\n');

      const p1Item = cplPart1 ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:4px;text-align:left;'>CPL Part 1 Duration: <strong style='color:#0b1220;margin-left:6px;'>${cplPart1}</strong></div>` : '';
      const p2Item = cplPart2 ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:4px;text-align:left;'>CPL Part 2 Duration: <strong style='color:#0b1220;margin-left:6px;'>${cplPart2}</strong></div>` : '';
      const ffecItem = ffec ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:6px;text-align:left;'>First Frame End Credits: <strong style='color:#0b1220;margin-left:6px;'>${ffec}</strong></div>` : '';
      const ffmcItem = ffmc ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:4px;text-align:left;'>First Frame Moving Credits: <strong style='color:#0b1220;margin-left:6px;'>${ffmc}</strong></div>` : '';

      cplBoxHtml = `<tr><td style='background:#ffffff;padding:12px 18px 18px 18px;'>
<div style='background:#fbfdff;border:1px solid #eef6ff;border-radius:6px;padding:12px;'>
<div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-size:13px;font-weight:700;margin-bottom:8px;'>CPL Details</div>
${cplLinesItems}
${p1Item}
${p2Item}
${ffecItem}
${ffmcItem}
</div>
</td></tr>`;
    }

    return `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;margin:12px 0;'><tr><td align='center' style='padding:0;'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0" style="width:650px;"><tr><td><![endif]-->
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='max-width:650px;width:100%;margin:0 auto;border-collapse:collapse;background:#ffffff;'>
<tr><td style='padding:14px; width:100%; text-align:left;'>
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;'><tr>
<td valign='top' style='width:160px;padding:6px 12px 6px 12px;box-sizing:border-box;'>
${posterCell}
</td>
<td valign='top' style='padding:6px 16px 6px 0;box-sizing:border-box;'>
<div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-weight:800;font-size:20px;line-height:1.1;margin-bottom:6px;text-align:left;'>${titleHtml}</div>
${subtitle ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:8px;text-align:left;'>${subtitle}</div>` : ''}
${synopsisHtml}
${duration ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:10px;max-width:370px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;'>
Duration: ${duration}
</div>` : ''}
${distributor ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:6px;max-width:370px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;'>
${distributor}
</div>` : ''}
<div style='margin-top:6px;text-align:left;'>
${trailerButtonHtml}
</div>
</td>
</tr></table>
</td></tr>
${cplBoxHtml}
<tr><td style='padding-top:12px;'><div class='card-divider' style='border-bottom:1px solid #e5e7eb;height:1px;width:100%;'></div></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>`;
  });

  // Banner 1 Row (omit if empty)
  let banner1Html = '';
  if (banner1Src) {
    const img1 = `<img src="${banner1Src}" alt="banner1" width="650" style="display:block;width:650px;max-width:100%;height:auto;border-radius:8px 8px 0 0;">`;
    const wrappedImg1 = banner1Link ? `<a href="${banner1Link}" target="_blank">${img1}</a>` : img1;
    banner1Html = `<tr><td style='padding:0;' align='center'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
${wrappedImg1}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>`;
  }

  // Banner 2 Row (omit if empty)
  let banner2Html = '';
  if (banner2Src) {
    const img2 = `<img src="${banner2Src}" alt="banner2" width="650" style="display:block;width:650px;max-width:100%;height:auto;">`;
    const wrappedImg2 = banner2Link ? `<a href="${banner2Link}" target="_blank">${img2}</a>` : img2;
    banner2Html = `<tr><td style='padding:0;' align='center'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
${wrappedImg2}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>`;
  }

  let renderedHtml = '';
  if (isTwoColumn && cardList.length > 1) {
    const rows = [];
    for (let i = 0; i < cardList.length; i += 2) {
      const col1 = `<td width='50%' valign='top' style='padding:6px;width:50%;'>${cardList[i]}</td>`;
      const col2 = cardList[i + 1]
        ? `<td width='50%' valign='top' style='padding:6px;width:50%;'>${cardList[i + 1]}</td>`
        : `<td width='50%' valign='top' style='padding:6px;width:50%;'></td>`;
      rows.push(`<tr>${col1}${col2}</tr>`);
    }
    renderedHtml = `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;width:100%;'>${rows.join('\n')}</table>`;
  } else {
    renderedHtml = cardList.join('\n');
  }

  return `<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>

    <style>
    body { margin:0 !important; padding:0 !important; background-color:#f5f7fb; font-family:${fontStack}; color:#0b1220; }
    table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { text-decoration:none; color:#2b6ef6; }
    .card-divider { border-bottom:1px solid #e5e7eb; line-height:1px; font-size:1px; width:100%; display:block; }
    @media screen and (max-width:650px) {
      .container-table { width:100% !important; }
      .vml-btn td, .vml-btn a { border:0 !important; outline:0 !important; -webkit-text-size-adjust:none !important; -ms-text-size-adjust:100% !important; }
      .nowrap-ell { white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; display:block !important; max-width:320px !important; }
    }
    </style>
    
</head><body style="font-family:${fontStack};">
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='min-width:100%;border-collapse:collapse;font-family:${fontStack};'><tr><td align='center' style='padding:18px 0;'>
<!--[if (gte mso 9)|(IE)]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0" style="width:650px;"><tr><td><![endif]-->
<table role='presentation' class='container-table' width='100%' cellpadding='0' cellspacing='0' style='max-width:650px;margin:0 auto;background:#ffffff;'>
${banner1Html}
<tr><td style='padding:0;'><div style='width:100%;height:10px;background:${accentColor};display:block;'></div></td></tr>
<tr><td style='padding:0;background:#ffffff;'><div style='padding:24px;margin:0 auto;text-align:center;color:#0b1220;max-width:650px;display:block;clear:both;overflow:auto;'>${headerHtml}</div></td></tr>
<tr><td style='padding:0;'><div style='width:100%;height:10px;background:${accentColor};display:block;'></div></td></tr>
${banner2Html}
<tr><td style='padding:10px 0;'>
${renderedHtml}
</td></tr>
<tr><td style='padding:18px 20px;text-align:center;font-size:12px;color:#6b7280;'>${footerText}</td></tr>
</table>
<!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
