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

export function parseMovieListText(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    if (/^title\s*,\s*year/i.test(line)) continue;
    
    const csvMatch = line.match(/^"?([^",]+)"?\s*,\s*"?(\d{4})?"?/);
    if (csvMatch) {
      results.push({ title: csvMatch[1].trim(), year: csvMatch[2] || '' });
      continue;
    }

    const yearMatch = line.match(/^(.*?)\s*\((\d{4})\)$/);
    if (yearMatch) {
      results.push({ title: yearMatch[1].trim(), year: yearMatch[2] });
    } else {
      results.push({ title: line, year: '' });
    }
  }

  return results;
}

export function generateNewsletterHTML(movies, config = {}) {
  const title = config.title || 'Movie Newsletter';
  const subtitle = config.subtitle || 'Latest Releases & Featured Artwork';
  const headerBg = config.headerBg || '#1e293b';
  const headerTextColor = config.headerTextColor || '#ffffff';
  const accentColor = config.accentColor || '#3b82f6';

  const movieCards = movies.map(m => {
    const posterUrl = m.selectedPoster || m.images?.poster?.[0]?.url || 'https://via.placeholder.com/300x450?text=No+Poster';
    const backdropUrl = m.selectedBackdrop || m.images?.backdrop?.[0]?.url;
    const trailerUrl = m.selectedTrailer || m.videos?.[0]?.url;
    
    return `
      <div style="background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; margin-bottom: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
        ${backdropUrl ? `<img src="${backdropUrl}" alt="${m.title}" style="width: 100%; max-height: 200px; object-fit: cover; display: block;" />` : ''}
        <div style="padding: 20px; display: flex; gap: 20px; flex-wrap: wrap;">
          <img src="${posterUrl}" alt="${m.title}" style="width: 120px; height: 180px; object-fit: cover; border-radius: 6px; flex-shrink: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.15);" />
          <div style="flex: 1; min-width: 200px;">
            <h3 style="margin: 0 0 8px 0; font-size: 20px; color: #0f172a;">${m.title} ${m.year ? `<span style="font-size: 16px; color: #64748b; font-weight: normal;">(${m.year})</span>` : ''}</h3>
            <p style="margin: 0 0 12px 0; color: #334155; font-size: 14px; line-height: 1.5;">${m.overview || 'No overview available.'}</p>
            ${trailerUrl ? `<a href="${trailerUrl}" target="_blank" rel="noopener" style="display: inline-block; background: ${accentColor}; color: #ffffff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-weight: 500; font-size: 14px;">Watch Trailer 🎬</a>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width: 680px; margin: 0 auto; padding: 20px;">
    <div style="background: ${headerBg}; color: ${headerTextColor}; padding: 32px 24px; border-radius: 8px; text-align: center; margin-bottom: 24px;">
      <h1 style="margin: 0 0 8px 0; font-size: 28px; letter-spacing: -0.5px;">${title}</h1>
      <p style="margin: 0; opacity: 0.9; font-size: 16px;">${subtitle}</p>
    </div>
    ${movieCards}
    <div style="text-align: center; padding: 16px; color: #94a3b8; font-size: 12px;">
      Generated with Qube Movie Studio
    </div>
  </div>
</body>
</html>`;
}
