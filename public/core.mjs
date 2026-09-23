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

  // Detect Qube Wire report structure (either key-value form or block PDF/OCR format)
  if (/distributor:|feature film duration:|first frame end credits:|cpl part 1/i.test(rawText)) {
    const results = [];
    
    // Check if format has explicit "Movie Name:" tags
    if (/movie name:/i.test(rawText)) {
      const blocks = rawText.split(/(?=\n\s*(?:Movie Name|Title)\s*:)/i).filter(b => b.trim());
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

    // OCR / PDF Block-based report parser
    // Splitting by lines where a movie entry starts, e.g. "Title (Year)" followed by "Distributor:"
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let currentMovie = null;
    let inCPLSection = false;

    const finalizeMovie = () => {
      if (currentMovie && currentMovie.title) {
        if (Array.isArray(currentMovie.cplList)) {
          currentMovie.cplEntries = currentMovie.cplList.join('\n');
          delete currentMovie.cplList;
        }
        results.push(currentMovie);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Header lines to skip (HELP DESK, Phone, email, Date range)
      if (/^(HELP DESK|Phone:|eMail:|e-mail:|September|October|November|December|January|February|March|April|May|June|July|August)\b/i.test(line) && !line.includes('(')) {
        continue;
      }

      // Check if line looks like a Movie Header: e.g. "Avengers Endgame: Encore (2026), English – IMAX 5"
      const headerMatch = line.match(/^(.+?)\s*\((20\d\d)\)(?:,\s*(.+))?$/);
      if (headerMatch && i + 1 < lines.length && /Distributor:/i.test(lines[i + 1])) {
        finalizeMovie();
        const rawTitle = headerMatch[1].trim();
        const year = headerMatch[2];
        const langFormat = headerMatch[3] ? headerMatch[3].trim() : '';

        currentMovie = {
          title: rawTitle,
          year,
          language: langFormat,
          distributor: '',
          featureDuration: '',
          firstFrameEndCredits: '',
          firstFrameMovingCredits: '',
          cplList: []
        };
        inCPLSection = false;
        continue;
      }

      if (!currentMovie) continue;

      if (/^Distributor\s*:\s*(.+)/i.test(line)) {
        currentMovie.distributor = line.match(/^Distributor\s*:\s*(.+)/i)[1].trim();
        inCPLSection = true;
        continue;
      }

      if (/^First Frame End Credits\s*:\s*(.+)/i.test(line)) {
        currentMovie.firstFrameEndCredits = line.match(/^First Frame End Credits\s*:\s*(.+)/i)[1].trim();
        inCPLSection = false;
        continue;
      }

      if (/^First Frame Moving Credits\s*:\s*(.+)/i.test(line)) {
        currentMovie.firstFrameMovingCredits = line.match(/^First Frame Moving Credits\s*:\s*(.+)/i)[1].trim();
        inCPLSection = false;
        continue;
      }

      if (/^Feature Film Duration\s*:\s*(.+)/i.test(line)) {
        currentMovie.featureDuration = line.match(/^Feature Film Duration\s*:\s*(.+)/i)[1].trim();
        inCPLSection = false;
        continue;
      }

      if (/^CPL Part 1 Duration\s*:\s*(.+)/i.test(line)) {
        currentMovie.cplPart1Duration = line.match(/^CPL Part 1 Duration\s*:\s*(.+)/i)[1].trim();
        continue;
      }

      if (/^CPL Part 2 Duration\s*:\s*(.+)/i.test(line)) {
        currentMovie.cplPart2Duration = line.match(/^CPL Part 2 Duration\s*:\s*(.+)/i)[1].trim();
        continue;
      }

      if (inCPLSection) {
        currentMovie.cplList.push(line);
      }
    }
    finalizeMovie();

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
  const topBannerUrl = config.topBannerUrl || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg';
  const topBannerLink = config.topBannerLink || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg';
  const secondBannerUrl = config.secondBannerUrl || 'https://i.ibb.co/spJ8m0Tg/02.jpg';
  const secondBannerLink = config.secondBannerLink || 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg';
  const footerText = config.footer || '';

  const defaultIntroHTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "http://www.w3.org/TR/REC-html40/strict.dtd">
<html><head><meta name="qrichtext" content="1" /><meta charset="utf-8" /><style type="text/css">
p, li { white-space: pre-wrap; }
hr { height: 1px; border-width: 0; }
li.unchecked::marker { content: "\\2610"; }
li.checked::marker { content: "\\2612"; }
</style></head><body style=" font-family:'Segoe UI'; font-size:9pt; font-weight:400; font-style:normal;">
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">Keep tabs on the feature releases coming your way and plan your screening schedules seamlessly with our weekly feature report.</p>
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">Need further information? Call the Qube Wire support team at: (424) 343-2691 or</p>
<p style=" margin-top:12px; margin-bottom:12px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">write to: support@qubewire.com</p></body></html>`;

  const introContent = config.intro ? config.intro : defaultIntroHTML;
  const layoutTemplate = config.layoutTemplate || 'one-column';

  const activeMovies = (movies || []).filter(m => m.checked !== false && m.selected !== false);

  let movieCards = '';

  if (layoutTemplate === 'two-column') {
    const rows = [];
    for (let i = 0; i < activeMovies.length; i += 2) {
      const pair = activeMovies.slice(i, i + 2);
      const cellsHtml = pair.map(m => {
        let rawPoster = m.selectedPoster || m.posterUrl || m.images?.poster?.[0]?.url || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='280' height='160' viewBox='0 0 280 160'><rect width='100%25' height='100%25' fill='%23f1f5f9'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2394a3b8' font-family='Arial' font-size='12'>No Poster</text></svg>";
        let posterUrl = rawPoster;
        if (rawPoster && rawPoster.startsWith('/')) {
          posterUrl = rawPoster.startsWith('/w') || rawPoster.startsWith('/original')
            ? `https://image.tmdb.org/t/p${rawPoster}`
            : `https://image.tmdb.org/t/p/w500${rawPoster}`;
        }
        const trailerUrl = m.selectedTrailer || m.trailerUrl || (m.videos && m.videos[0]?.url) || '#';
        let metaSubtitle = '';
        if (m.year && m.language) metaSubtitle = `${m.year} / ${m.language}`;
        else if (m.language) metaSubtitle = m.language;
        else if (m.year) metaSubtitle = m.year;

        const durationStr = m.featureDuration || 'N/A';
        const distributorStr = m.distributor || 'N/A';

        let cplLines = [];
        if (m.cplEntries) cplLines = m.cplEntries.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        else if (m.cpl) cplLines = [m.cpl];

        const cplLinesHtml = cplLines.map(line => 
          `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:12px;margin-bottom:4px;text-align:left;'>${line}</div>`
        ).join('\n');

        const endCreditsHtml = m.firstFrameEndCredits ? 
          `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:11px;margin-top:4px;text-align:left;'>End Credits: <strong>${m.firstFrameEndCredits}</strong></div>` : '';

        return `<td valign='top' width='50%' style='width:50%;padding:8px;box-sizing:border-box;'>
          <table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;'>
            <tr><td style='padding:12px;' align='center'>
              <img src='${posterUrl}' alt='poster' width='100%' style='display:block;border-radius:6px;border:1px solid #e9eef6;object-fit:cover;max-height:220px;width:100%;margin-bottom:10px;'>
              <div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-weight:800;font-size:16px;line-height:1.2;margin-bottom:4px;text-align:left;'>${m.title}</div>
              <div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;margin-bottom:6px;text-align:left;'>${metaSubtitle}</div>
              <div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;margin-bottom:4px;text-align:left;'>Duration: ${durationStr}</div>
              <div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;margin-bottom:10px;text-align:left;'>${distributorStr}</div>
              <div style='margin-bottom:10px;text-align:left;'>
                <a href="${trailerUrl}" target="_blank" style="display:inline-block;padding:8px 14px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:13px;color:#ffffff;background-color:#2b6ef6;text-decoration:none;border-radius:5px;">Watch Trailer</a>
              </div>
              ${cplLines.length ? `<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;text-align:left;margin-top:6px;'><div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-size:11px;font-weight:700;margin-bottom:4px;'>CPL Details</div>${cplLinesHtml}${endCreditsHtml}</div>` : ''}
            </td></tr>
          </table>
        </td>`;
      }).join('');

      const emptyCell = pair.length === 1 ? `<td width='50%' style='width:50%;padding:8px;'></td>` : '';
      rows.push(`<tr>${cellsHtml}${emptyCell}</tr>`);
    }
    movieCards = `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='max-width:650px;margin:12px auto;border-collapse:collapse;'>${rows.join('')}</table>`;
  } else {
    movieCards = activeMovies.map(m => {
    let rawPoster = m.selectedPoster || m.posterUrl || m.images?.poster?.[0]?.url || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='170' viewBox='0 0 120 170'><rect width='100%25' height='100%25' fill='%23f1f5f9'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2394a3b8' font-family='Arial' font-size='12'>No Poster</text></svg>";
    let posterUrl = rawPoster;
    if (rawPoster && rawPoster.startsWith('/')) {
      posterUrl = rawPoster.startsWith('/w') || rawPoster.startsWith('/original')
        ? `https://image.tmdb.org/t/p${rawPoster}`
        : `https://image.tmdb.org/t/p/w500${rawPoster}`;
    }
    const trailerUrl = m.selectedTrailer || m.trailerUrl || (m.videos && m.videos[0]?.url) || '#';
    
    // Construct meta subtitle (Year / Language)
    let metaSubtitle = '';
    if (m.year && m.language) {
      metaSubtitle = `${m.year} / ${m.language}`;
    } else if (m.language) {
      metaSubtitle = m.language;
    } else if (m.year) {
      metaSubtitle = m.year;
    }

    const durationStr = m.featureDuration || 'N/A';
    const distributorStr = m.distributor || 'N/A';

    // Build CPL lines
    let cplLines = [];
    if (m.cplEntries) {
      cplLines = m.cplEntries.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else if (m.cpl) {
      cplLines = [m.cpl];
    }

    const cplLinesHtml = cplLines.map(line => 
      `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-bottom:8px;text-align:left;'>${line}</div>`
    ).join('\n');

    const endCreditsHtml = m.firstFrameEndCredits ? 
      `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:6px;text-align:left;'>First Frame End Credits: <strong style='color:#0b1220;margin-left:6px;'>${m.firstFrameEndCredits}</strong></div>` : '';

    const movingCreditsHtml = m.firstFrameMovingCredits ? 
      `<div style='font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:13px;margin-top:4px;text-align:left;'>First Frame Moving Credits: <strong style='color:#0b1220;margin-left:6px;'>${m.firstFrameMovingCredits}</strong></div>` : '';

    return `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;margin:12px 0;'><tr><td align='center' style='padding:0;'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0" style="width:650px;"><tr><td><![endif]-->
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='max-width:650px;width:100%;margin:0 auto;border-collapse:collapse;background:#ffffff;'>
<tr><td style='padding:14px; width:100%; text-align:left;'>
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;'><tr>
<td valign='top' style='width:160px;padding:6px 12px 6px 12px;box-sizing:border-box;'>
<img src='${posterUrl}' alt='poster' width='120' height='170' style='display:block;border-radius:6px;border:1px solid #e9eef6;object-fit:cover;max-width:120px;width:120px;height:170px;'>
</td>
<td valign='top' style='padding:6px 16px 6px 0;box-sizing:border-box;'>
<div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-weight:800;font-size:20px;line-height:1.1;margin-bottom:6px;text-align:left;'>${m.title}</div>
<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:8px;text-align:left;'>${metaSubtitle}</div>
${m.overview ? `<div style='font-family:Arial,Helvetica,sans-serif;color:#4b5563;font-size:13px;margin-bottom:8px;text-align:left;'>${m.overview}</div>` : ''}
<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:10px;max-width:370px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;'>
Duration: ${durationStr}
</div>
<div style='font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;margin-bottom:6px;max-width:370px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;'>
${distributorStr}
</div>
<div style='margin-top:6px;text-align:left;'><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
 href="${trailerUrl}"
 style="height:44px;v-text-anchor:middle;width:160px;" arcsize="8%" strokecolor="#2356c6" fillcolor="#2b6ef6">
 <w:anchorlock/>
 <center style="color:#ffffff;font-family:Arial, Helvetica, sans-serif;font-size:16px;font-weight:bold;">
 Watch Trailer
 </center>
 </v:roundrect><![endif]-->
 <!--[if !mso]><!-- -->
 <table role="presentation" cellspacing="0" cellpadding="0" border="0" class="vml-btn" style="display:inline-block;border-collapse:collapse;border:0;">
 <tr>
 <td align="center" valign="middle" bgcolor="#2b6ef6" style="background-color:#2b6ef6;border-radius:6px;border:0;padding:0;">
 <a href="${trailerUrl}" target="_blank" style="display:inline-block;padding:10px 20px;font-family:Arial, Helvetica, sans-serif;font-weight:700;font-size:16px;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px;border:0;outline:0;-webkit-text-size-adjust:none;-ms-text-size-adjust:100%;">Watch Trailer</a>
 </td>
 </tr>
 </table>
 <!--<![endif]--></div>
</td>
</tr></table>
</td></tr>
<tr><td style='background:#ffffff;padding:12px 18px 18px 18px;'>
<div style='background:#fbfdff;border:1px solid #eef6ff;border-radius:6px;padding:12px;'>
<div style='font-family:Arial,Helvetica,sans-serif;color:#0b1220;font-size:13px;font-weight:700;margin-bottom:8px;'>CPL Details</div>
${cplLinesHtml}
${endCreditsHtml}
${movingCreditsHtml}
</div>
</td></tr>
<tr><td style='padding-top:12px;'><div class='card-divider' style='border-bottom:1px solid #e5e7eb;height:1px;width:100%;'></div></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>`;
  }).join('');
  }

  return `<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>

    <style>
    body { margin:0 !important; padding:0 !important; background-color:#f5f7fb; font-family:Inter,Arial,Helvetica,sans-serif; color:#0b1220; }
    table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { text-decoration:none; color:#2b6ef6; }
    .card-divider { border-bottom:1px solid #e5e7eb; line-height:1px; font-size:1px; width:100%; display:block; }
    @media screen and (max-width:650px) {
      .container-table { width:100% !important; }
      .vml-btn td, .vml-btn a { border:0 !important; outline:0 !important; -webkit-text-size-adjust:none !important; -ms-text-size-adjust:100% !important; }
      .nowrap-ell { white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; display:block !important; max-width:320px !important; }
    }
    @media print {
      body { background-color:#ffffff !important; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
      table { page-break-inside:avoid !important; break-inside:avoid !important; }
    }
    </style>
    
</head><body>
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='min-width:100%;border-collapse:collapse;'><tr><td align='center' style='padding:18px 0;'>
<table role='presentation' class='container-table' width='100%' cellpadding='0' cellspacing='0' style='max-width:650px;margin:0 auto;background:#ffffff;'>
<tr><td style='padding:0;' align='center'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<a href="${topBannerLink}" target="_blank"><img src="${topBannerUrl}" alt="banner1" width="650" style="display:block;width:650px;max-width:100%;height:auto;border-radius:8px 8px 0 0;"></a>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
<tr><td style='padding:0;'><div style='width:100%;height:10px;background:#2b6ef6;display:block;'></div></td></tr>
<tr><td style='padding:0;background:#ffffff;'><div style='padding:24px;margin:0 auto;text-align:center;color:#0b1220;max-width:650px;display:block;clear:both;overflow:auto;'>${introContent}</div></td></tr>
<tr><td style='padding:0;'><div style='width:100%;height:10px;background:#2b6ef6;display:block;'></div></td></tr>
<tr><td style='padding:0;' align='center'>
<!--[if mso]><table role="presentation" width="650" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<a href="${secondBannerLink}" target="_blank"><img src="${secondBannerUrl}" alt="banner2" width="650" style="display:block;width:650px;max-width:100%;height:auto;"></a>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
${movieCards}
<tr><td style='padding:18px 20px;text-align:center;font-size:12px;color:#6b7280;'>${footerText}</td></tr>
</table></td></tr></table></body></html>`;
}
