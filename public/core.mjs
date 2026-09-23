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

export function parseMovieListText(text) {
  if (!text || typeof text !== 'string') return [];
  const rawText = text.trim();
  if (!rawText) return [];

  // Detect Qube report structure
  if (/movie name:|feature film duration:|cpl part 1/i.test(rawText)) {
    const blocks = rawText.split(/(?=\n\s*(?:Movie Name|Title)\s*:)/i).filter(b => b.trim());
    const results = [];
    for (const block of blocks) {
      const getVal = (regex) => {
        const m = block.match(regex);
        return m ? m[1].trim() : '';
      };
      const rawTitle = getVal(/(?:Movie Name|Title)\s*:\s*(.+)/i) || getVal(/^([^\n]+)/);
      if (!rawTitle) continue;
      
      const year = getVal(/(?:Release Year|Year)\s*:\s*(\d{4})/i) || (rawTitle.match(/\((\d{4})\)/) ? rawTitle.match(/\((\d{4})\)/)[1] : '');
      const cleanTitle = rawTitle.replace(/Movie Name\s*:\s*/i, '').replace(/\s*\(\d{4}\)/, '').trim();
      const language = getVal(/Language\s*:\s*(.+)/i);
      const distributor = getVal(/Distributor\s*:\s*(.+)/i);
      const featureDuration = getVal(/Feature Film Duration\s*:\s*(.+)/i);
      const cplPart1Duration = getVal(/CPL Part 1 Duration\s*:\s*(.+)/i);
      const cplPart2Duration = getVal(/CPL Part 2 Duration\s*:\s*(.+)/i);
      const firstFrameEndCredits = getVal(/First Frame End Credits\s*:\s*(.+)/i);
      const firstFrameMovingCredits = getVal(/First Frame Moving Credits\s*:\s*(.+)/i);
      const cplEntries = getVal(/CPL Entries\s*:\s*([\s\S]+?)(?=\n\s*(?:Movie Name|Title)\s*:|$)/i) || '';

      results.push({
        title: cleanTitle,
        year,
        language,
        distributor,
        featureDuration,
        cplPart1Duration,
        cplPart2Duration,
        firstFrameEndCredits,
        firstFrameMovingCredits,
        cplEntries
      });
    }
    if (results.length > 0) return results;
  }

  // Standard list / CSV / line-by-line format
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    if (/^title\s*,\s*year/i.test(line)) continue;
    
    const imdbMatch = line.match(/(tt\d{7,10})/);
    const imdbId = imdbMatch ? imdbMatch[1] : '';

    const csvMatch = line.match(/^"?([^",]+)"?\s*,\s*"?(\d{4})?"?/);
    if (csvMatch) {
      results.push({ title: csvMatch[1].trim(), year: csvMatch[2] || '', imdbId });
      continue;
    }

    const pipeMatch = line.match(/^([^|]+)\|\s*(\d{4})?(?:\|\s*(.+))?$/);
    if (pipeMatch) {
      results.push({
        title: pipeMatch[1].trim(),
        year: pipeMatch[2] ? pipeMatch[2].trim() : '',
        language: pipeMatch[3] ? pipeMatch[3].trim() : '',
        imdbId
      });
      continue;
    }

    const yearMatch = line.match(/^(.*?)\s*\((\d{4})\)(?:\s+(.+))?$/);
    if (yearMatch) {
      results.push({
        title: yearMatch[1].trim(),
        year: yearMatch[2],
        language: yearMatch[3] ? yearMatch[3].trim() : '',
        imdbId
      });
    } else {
      results.push({ title: line, year: '', imdbId });
    }
  }

  return results;
}

export function generateNewsletterHTML(movies, config = {}) {
  const title = config.title || 'This week at the movies';
  const subtitle = config.intro || config.subtitle || 'Discover the latest releases, with trailers and technical details in one place.';
  const topBannerUrl = config.topBannerUrl || '';
  const topBannerLink = config.topBannerLink || '#';
  const secondBannerUrl = config.secondBannerUrl || '';
  const secondBannerLink = config.secondBannerLink || '#';
  const footerText = config.footer || 'Movie Studio · Artwork and metadata provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.';

  const activeMovies = (movies || []).filter(m => m.checked !== false && m.selected !== false);

  const movieCards = activeMovies.map(m => {
    const posterUrl = m.selectedPoster || m.images?.poster?.[0]?.url || '';
    const trailerUrl = m.selectedTrailer || m.trailerUrl || (m.videos && m.videos[0]?.url) || '';
    
    const details = [];
    if (m.featureDuration) details.push(`<strong>Feature Film Duration:</strong> ${m.featureDuration}`);
    if (m.distributor) details.push(`<strong>Distributor:</strong> ${m.distributor}`);
    if (m.cplPart1Duration) details.push(`<strong>CPL Part 1 Duration:</strong> ${m.cplPart1Duration}`);
    if (m.cplPart2Duration) details.push(`<strong>CPL Part 2 Duration:</strong> ${m.cplPart2Duration}`);
    if (m.firstFrameEndCredits) details.push(`<strong>First Frame End Credits:</strong> ${m.firstFrameEndCredits}`);
    if (m.firstFrameMovingCredits) details.push(`<strong>First Frame Moving Credits:</strong> ${m.firstFrameMovingCredits}`);

    let techDetailsHtml = '';
    if (details.length > 0) {
      techDetailsHtml = `<div style="margin-top: 10px; padding: 10px 12px; background: #F0F5F2; border-radius: 6px; font-size: 12px; line-height: 1.6; color: #18362D;">
        ${details.join('<br>')}
      </div>`;
    }

    let cplBoxHtml = '';
    if (m.cplEntries) {
      cplBoxHtml = `<div style="margin-top: 8px; padding: 10px; background: #F0F5F2; border: 1px solid #DCE5DE; border-radius: 6px; font-size: 11px; font-family: monospace; white-space: pre-wrap; color: #1D3029;">
        <strong>CPL Entries:</strong><br>${m.cplEntries}
      </div>`;
    }

    const watchButton = trailerUrl ? `
      <div style="margin-top: 14px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${trailerUrl}" style="height:36px;v-text-anchor:middle;width:130px;" arcsize="18%" stroke="f" fillcolor="#176D56">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;">Watch trailer</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${trailerUrl}" target="_blank" style="background-color:#176D56; border-radius:6px; color:#ffffff; display:inline-block; font-family:Arial, sans-serif; font-size:13px; font-weight:bold; line-height:36px; text-align:center; text-decoration:none; width:130px; -webkit-text-size-adjust:none;">Watch trailer ↗</a>
        <!--<![endif]-->
      </div>
    ` : '';

    const metaLine = [m.year, m.language].filter(Boolean).join(' · ');

    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff; border: 1px solid #DFE5DF; border-radius: 12px; margin-bottom: 20px; overflow: hidden;">
        <tr>
          <td style="padding: 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                ${posterUrl ? `
                  <td width="102" valign="top" style="padding-right: 18px;">
                    <img src="${posterUrl}" width="102" alt="${m.title}" style="display: block; width: 102px; height: 148px; object-fit: cover; border-radius: 6px; border: 1px solid #DFE5DF;" />
                  </td>
                ` : ''}
                <td valign="top">
                  <h3 style="margin: 0 0 4px 0; font-size: 21px; font-weight: bold; color: #18362D;">${m.title}</h3>
                  ${metaLine ? `<div style="font-size: 13px; color: #74817A; margin-bottom: 8px;">${metaLine}</div>` : ''}
                  <p style="margin: 0 0 10px 0; font-size: 13px; line-height: 1.5; color: #294236;">${m.overview || 'Synopsis and release details available.'}</p>
                  ${techDetailsHtml}
                  ${cplBoxHtml}
                  ${watchButton}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <!--[if mso]>
  <xml>
    <o:OfficeDocumentSettings>
      <o:AllowPNG/>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; min-width: 100%; background-color: #EEF2EF; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table { border-spacing: 0; font-family: Arial, Helvetica, sans-serif; color: #18362D; }
    td { padding: 0; }
    img { border: 0; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #EEF2EF;">
  <center style="width: 100%; table-layout: fixed; background-color: #EEF2EF; padding-top: 24px; padding-bottom: 40px;">
    <div style="max-width: 650px; margin: 0 auto;">
      <!--[if mso]>
      <table align="center" width="650" cellpadding="0" cellspacing="0" border="0" style="width:650px;">
      <tr>
      <td>
      <![endif]-->
      <table align="center" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 650px; margin: 0 auto; background-color: #EEF2EF;">
        ${topBannerUrl ? `
          <tr>
            <td align="center" style="padding-bottom: 16px;">
              <a href="${topBannerLink}" target="_blank">
                <img src="${topBannerUrl}" width="650" alt="Banner" style="display: block; width: 100%; max-width: 650px; height: auto; border-radius: 8px;" />
              </a>
            </td>
          </tr>
        ` : ''}

        <tr>
          <td align="center" style="padding: 24px 20px 20px 20px; text-align: center;">
            <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: bold; color: #18362D; letter-spacing: -0.5px;">${title}</h1>
            <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #5A7E50;">${subtitle}</p>
          </td>
        </tr>

        ${secondBannerUrl ? `
          <tr>
            <td align="center" style="padding-bottom: 20px;">
              <a href="${secondBannerLink}" target="_blank">
                <img src="${secondBannerUrl}" width="650" alt="Special Feature" style="display: block; width: 100%; max-width: 650px; height: auto; border-radius: 8px;" />
              </a>
            </td>
          </tr>
        ` : ''}

        <tr>
          <td>
            ${movieCards || `<div style="text-align: center; padding: 40px; color: #74817A; font-size: 14px;">No movies selected for this edition.</div>`}
          </td>
        </tr>

        <tr>
          <td align="center" style="padding: 24px 20px; text-align: center; font-size: 12px; color: #74817A;">
            ${footerText}
          </td>
        </tr>
      </table>
      <!--[if mso]>
      </td>
      </tr>
      </table>
      <![endif]-->
    </div>
  </center>
</body>
</html>`;
}
