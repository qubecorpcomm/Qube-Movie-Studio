import { parseMovieListText, generateNewsletterHTML, langCode } from './core.mjs';

// Application Shared State
const state = {
  movies: [],
  selectedUid: null,
  activeTab: 'library',
  status: { tmdb: false, youtube: false },
  batchRunning: false,
  stopBatchRequested: false,
  filter: '',
  newsletter: {
    title: 'This week at the movies',
    intro: 'Discover the latest releases, with trailers and technical details in one place.',
    topBannerUrl: '',
    topBannerLink: '',
    secondBannerUrl: '',
    secondBannerLink: '',
    footer: 'Movie Studio · Artwork and metadata provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.'
  }
};

const SAMPLE_MOVIES_TEXT = `Vikram (2022) Tamil
Interstellar | 2014 | English
Oppenheimer (2023)
Dune: Part Two (2024)`;

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
  loadLocalState();
  checkAPIStatus();
  setupNavigation();
  setupEventHandlers();

  // If initial state is empty, load sample movies
  if (state.movies.length === 0) {
    addMoviesFromParsedList(parseMovieListText(SAMPLE_MOVIES_TEXT));
  } else {
    if (!state.selectedUid && state.movies.length > 0) {
      state.selectedUid = state.movies[0].uid;
    }
    updateAllUI();
  }
});

// Save / Load Local State
function saveLocalState() {
  try {
    const payload = {
      movies: state.movies,
      selectedUid: state.selectedUid,
      newsletter: state.newsletter
    };
    localStorage.setItem('movie_studio_state_v1', JSON.stringify(payload));
  } catch (err) {
    console.warn('Could not save to localStorage', err);
  }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem('movie_studio_state_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.movies)) state.movies = parsed.movies;
      if (parsed.selectedUid) state.selectedUid = parsed.selectedUid;
      if (parsed.newsletter) state.newsletter = { ...state.newsletter, ...parsed.newsletter };
    }
  } catch (err) {
    console.warn('Could not load from localStorage', err);
  }
}

// API Connection Status
async function checkAPIStatus() {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.getElementById('connectionStatusText');
  const modalStatusLine = document.getElementById('modalStatusLine');

  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.status = data;

    if (data.tmdb) {
      statusDot.className = 'status-dot';
      statusText.textContent = 'TMDB connected';
      modalStatusLine.textContent = `TMDB: Configured ✅ · YouTube: ${data.youtube ? 'Configured ✅' : 'Not configured'}`;
    } else {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Manual mode · add API keys';
      modalStatusLine.textContent = 'TMDB: Key missing (Offline Mode) · YouTube: Key missing';
    }
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Server unavailable';
    modalStatusLine.textContent = 'Server could not be reached.';
  }
}

// Navigation Tabs
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-item');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      setActiveTab(tab);
    });
  });
}

function setActiveTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  document.querySelectorAll('.view-panel').forEach(p => {
    p.classList.toggle('active', p.id === `view-${tab}`);
  });

  // Breadcrumb & Headings Sync
  const bcPath = document.getElementById('bcPath');
  const pageTitle = document.getElementById('pageTitle');
  const pageSub = document.getElementById('pageSub');

  const titles = {
    library: { path: 'MOVIE STUDIO / LIBRARY', h1: 'Your movie library', dot: '.', sub: 'Bring in your titles. Find the artwork. Build something worth opening.' },
    artwork: { path: 'MOVIE STUDIO / ARTWORK', h1: 'The art of the release', dot: '.', sub: 'Choose posters, backdrops and logos in the language that fits.' },
    trailers: { path: 'MOVIE STUDIO / TRAILERS', h1: 'Let the story begin', dot: '.', sub: 'Find the right trailer, review alternatives, or add your own link.' },
    newsletter: { path: 'MOVIE STUDIO / NEWSLETTER', h1: 'Ready for the inbox', dot: '.', sub: 'Turn your curated movie list into a newsletter worth opening.' }
  };

  const t = titles[tab] || titles.library;
  bcPath.textContent = t.path;
  pageTitle.innerHTML = `${t.h1}<span class="period-dot">${t.dot}</span>`;
  pageSub.textContent = t.sub;

  updateAllUI();
}

// Notice Bar Update
function showNotice(msg, type = 'info') {
  const bar = document.getElementById('noticeBar');
  bar.textContent = msg;
  bar.className = `notice-bar ${type}`;
}

// Global Event Handlers Setup
function setupEventHandlers() {
  // Focus textarea
  document.getElementById('btnAddMovieFocus').addEventListener('click', () => {
    setActiveTab('library');
    const textarea = document.getElementById('movieInputText');
    textarea.focus();
  });

  // Try sample list
  document.getElementById('btnTrySample').addEventListener('click', () => {
    document.getElementById('movieInputText').value = SAMPLE_MOVIES_TEXT;
  });

  // Add titles
  document.getElementById('btnAddTitles').addEventListener('click', () => {
    const text = document.getElementById('movieInputText').value;
    const parsed = parseMovieListText(text);
    if (parsed.length > 0) {
      addMoviesFromParsedList(parsed);
      document.getElementById('movieInputText').value = '';
      showNotice(`Added ${parsed.length} movie(s) to your library.`);
    } else {
      showNotice('Please enter movie titles or paste a list.', 'error');
    }
  });

  // File import (.txt, .csv, .pdf)
  const fileImportInput = document.getElementById('fileImportInput');
  document.getElementById('btnImportFile').addEventListener('click', () => fileImportInput.click());
  fileImportInput.addEventListener('change', handleFileImport);

  // Batch search button
  document.getElementById('btnFindArtworkAll').addEventListener('click', runBatchSearch);
  const btnFindTrailers = document.getElementById('btnFindTrailersAll');
  if (btnFindTrailers) btnFindTrailers.addEventListener('click', runBatchSearch);

  // Stop batch
  const btnStopBatch = document.getElementById('btnStopBatch');
  btnStopBatch.addEventListener('click', () => {
    state.stopBatchRequested = true;
    showNotice('Stopping batch search after current item...');
  });

  // Filter inputs
  ['movieFilterInput', 'movieFilterInputArtwork', 'movieFilterInputTrailers'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', (e) => {
        state.filter = e.target.value.toLowerCase();
        renderCollectionList();
      });
    }
  });

  // Export CSV
  ['btnExportCSV', 'btnExportCSVArtwork', 'btnExportCSVTrailers'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', exportCSVReport);
  });

  // Download ZIP
  const btnZip = document.getElementById('btnDownloadZipTop');
  if (btnZip) btnZip.addEventListener('click', downloadArtworkZIP);

  // Modals setup
  const connModal = document.getElementById('connModal');
  document.getElementById('btnConnDetails').addEventListener('click', () => {
    connModal.showModal();
  });
  document.getElementById('btnCloseConnModal').addEventListener('click', () => connModal.close());
  document.getElementById('btnDoneConnModal').addEventListener('click', () => connModal.close());

  // Confirm modal setup
  document.getElementById('btnCloseConfirmModal').addEventListener('click', closeConfirmModal);
  document.getElementById('btnCancelConfirmModal').addEventListener('click', closeConfirmModal);

  // Project Save / Load
  document.getElementById('btnSaveProject').addEventListener('click', saveProjectJSON);
  const fileProjectInput = document.getElementById('fileProjectInput');
  document.getElementById('btnOpenProject').addEventListener('click', () => fileProjectInput.click());
  fileProjectInput.addEventListener('change', loadProjectJSON);

  // Newsletter Controls Live Sync
  setupNewsletterSync();
}

// Add Movies to Shared State
function addMoviesFromParsedList(parsedList) {
  const newItems = parsedList.map(item => ({
    uid: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    id: item.imdbId || null,
    title: item.title,
    year: item.year || '',
    language: item.language || '',
    distributor: item.distributor || '',
    posterUrl: '',
    trailerUrl: '',
    selectedPoster: null,
    selectedBackdrop: null,
    selectedLogo: null,
    selectedTrailer: null,
    keepPoster: false,
    keepTrailer: false,
    overview: item.overview || '',
    featureDuration: item.featureDuration || '',
    cplPart1Duration: item.cplPart1Duration || '',
    cplPart2Duration: item.cplPart2Duration || '',
    firstFrameEndCredits: item.firstFrameEndCredits || '',
    firstFrameMovingCredits: item.firstFrameMovingCredits || '',
    cplEntries: item.cplEntries || '',
    images: { poster: [], backdrop: [], logo: [] },
    videos: [],
    tmdbCandidates: [],
    status: 'pending',
    statusText: 'Pending',
    checked: true
  }));

  state.movies.push(...newItems);
  if (!state.selectedUid && state.movies.length > 0) {
    state.selectedUid = state.movies[0].uid;
  }

  updateAllUI();
  saveLocalState();
}

// Update All Workspace Views & Counters
function updateAllUI() {
  const total = state.movies.length;
  const artworkCount = state.movies.filter(m => m.selectedPoster || m.posterUrl).length;
  const trailerCount = state.movies.filter(m => m.selectedTrailer || m.trailerUrl || (m.videos && m.videos.length > 0)).length;
  const includedInNewsletter = state.movies.filter(m => m.checked !== false).length;

  // Badges
  document.getElementById('badgeMovieCount').textContent = total;
  document.getElementById('badgeArtworkCount').textContent = artworkCount;
  document.getElementById('badgeTrailerCount').textContent = trailerCount;

  // Metrics Strip
  document.getElementById('metricMovies').textContent = total;
  document.getElementById('metricArtwork').textContent = artworkCount;
  document.getElementById('metricTrailers').textContent = trailerCount;
  document.getElementById('metricNewsletter').textContent = includedInNewsletter;

  renderCollectionList();
  renderSelectedMovieDetail();
  renderNewsletterPreview();
  saveLocalState();
}

// Render Collection List in Current Active View
function renderCollectionList() {
  const containers = [
    { listId: 'libraryList', countId: 'filterCount', inputId: 'movieFilterInput' },
    { listId: 'libraryListArtwork', countId: 'filterCountArtwork', inputId: 'movieFilterInputArtwork' },
    { listId: 'libraryListTrailers', countId: 'filterCountTrailers', inputId: 'movieFilterInputTrailers' }
  ];

  const filteredMovies = state.movies.filter(m => {
    if (!state.filter) return true;
    return m.title.toLowerCase().includes(state.filter) ||
           (m.year && m.year.includes(state.filter)) ||
           (m.language && m.language.toLowerCase().includes(state.filter));
  });

  containers.forEach(({ listId, countId, inputId }) => {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const inputEl = document.getElementById(inputId);

    if (inputEl && inputEl.value.toLowerCase() !== state.filter) {
      inputEl.value = state.filter;
    }

    if (countEl) countEl.textContent = `${filteredMovies.length} movies`;
    if (!listEl) return;

    if (state.movies.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">＋</div>
          <div class="empty-title">Your collection starts here</div>
          <div class="empty-desc">Paste a list above or add a movie.</div>
        </div>
      `;
      return;
    }

    if (filteredMovies.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No matching movies</div>
          <div class="empty-desc">Try clearing your filter search.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    filteredMovies.forEach(m => {
      const row = document.createElement('div');
      row.className = `movie-row ${m.uid === state.selectedUid ? 'active' : ''}`;
      row.tabIndex = 0;
      row.role = 'button';
      row.setAttribute('aria-label', `Select ${m.title}`);

      const posterUrl = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
      const initialLetter = m.title ? m.title.charAt(0).toUpperCase() : 'M';

      const statusClass = m.status === 'found' ? 'found' : m.status === 'loading' ? 'loading' : m.status === 'error' ? 'error' : '';

      row.innerHTML = `
        <input type="checkbox" class="movie-checkbox" ${m.checked !== false ? 'checked' : ''} aria-label="Include ${m.title} in newsletter and batch actions" />
        ${posterUrl ? `<img src="${posterUrl}" class="movie-poster-img" alt="${m.title}" />` : `<div class="movie-poster-thumb">${initialLetter}</div>`}
        <div class="movie-info-block">
          <div class="movie-row-title">${m.title}</div>
          <div class="movie-row-meta">${[m.year, m.language].filter(Boolean).join(' · ') || 'Details to discover'}</div>
        </div>
        <div class="status-pill-small ${statusClass}">${m.statusText || 'Pending'}</div>
      `;

      // Checkbox click
      const chk = row.querySelector('.movie-checkbox');
      chk.addEventListener('click', (e) => {
        e.stopPropagation();
        m.checked = e.target.checked;
        updateAllUI();
      });

      // Row select click
      row.addEventListener('click', () => {
        state.selectedUid = m.uid;
        updateAllUI();
      });

      // Keyboard navigation
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectedUid = m.uid;
          updateAllUI();
        }
      });

      listEl.appendChild(row);
    });
  });
}

// Render Selected Movie Detail Panel
function renderSelectedMovieDetail() {
  const cards = [
    document.getElementById('movieDetailCard'),
    document.getElementById('movieDetailCardArtwork'),
    document.getElementById('movieDetailCardTrailers')
  ];

  const m = state.movies.find(item => item.uid === state.selectedUid);

  cards.forEach((card, idx) => {
    if (!card) return;

    if (!m) {
      card.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✦</div>
          <div class="empty-title">A place for your next release</div>
          <div class="empty-desc">${state.movies.length > 0 ? 'Select a movie from the list to choose artwork and trailers.' : 'Add a movie, then select it here to choose artwork and trailers.'}</div>
        </div>
      `;
      return;
    }

    const tabType = idx === 0 ? 'library' : idx === 1 ? 'artwork' : 'trailers';
    card.innerHTML = buildDetailCardHTML(m, tabType);
    bindDetailCardEvents(card, m);
  });
}

// Build Detail Card Markup
function buildDetailCardHTML(m, tabType) {
  const matchOptions = (m.tmdbCandidates || []).map(c => `
    <option value="${c.id}" ${c.id === m.id ? 'selected' : ''}>${c.title} (${c.release_date ? c.release_date.slice(0, 4) : 'N/A'}) · ${c.original_language || 'en'}</option>
  `).join('');

  const posterUrl = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url || '';
  const backdropUrl = m.selectedBackdrop || m.images?.backdrop?.[0]?.url || '';
  const logoUrl = m.selectedLogo || m.images?.logo?.[0]?.url || '';

  const posterSelectOpts = (m.images?.poster || []).map(p => `
    <option value="${p.url}" ${p.url === posterUrl ? 'selected' : ''}>${p.iso_639_1 || 'orig'} · ${p.width}x${p.height}</option>
  `).join('');

  const backdropSelectOpts = (m.images?.backdrop || []).map(b => `
    <option value="${b.url}" ${b.url === backdropUrl ? 'selected' : ''}>${b.iso_639_1 || 'orig'} · ${b.width}x${b.height}</option>
  `).join('');

  const logoSelectOpts = (m.images?.logo || []).map(l => `
    <option value="${l.url}" ${l.url === logoUrl ? 'selected' : ''}>${l.iso_639_1 || 'orig'} · ${l.width}x${l.height}</option>
  `).join('');

  const trailerSelectOpts = (m.videos || []).map(v => `
    <option value="${v.url}" ${v.url === (m.trailerUrl || m.selectedTrailer) ? 'selected' : ''}>${v.name} · ${v.type} (${v.iso_639_1 || 'en'})</option>
  `).join('');

  const activeTrailerUrl = m.trailerUrl || m.selectedTrailer || m.videos?.[0]?.url || '';
  const youtubeVideoId = extractYouTubeID(activeTrailerUrl);

  const tmdbLink = m.id ? `https://www.themoviedb.org/movie/${m.id}` : '#';
  const imdbLink = m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}` : '#';

  const languages = ['Tamil', 'Telugu', 'Malayalam', 'Hindi', 'Kannada', 'English', 'Spanish', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Mandarin', 'Cantonese', 'Arabic', 'Russian'];

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="card-heading">${m.title}</h2>
          <span class="pill">MOVIE DETAILS</span>
        </div>
        <div class="card-subheading">${m.statusText || 'Pending'}</div>
      </div>
      <div class="detail-actions-row">
        <button class="btn btn-primary btn-sm" id="btnSearchSingle">Search this movie</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveUp" title="Move up">↑</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveDown" title="Move down">↓</button>
        <button class="btn btn-danger btn-sm" id="btnRemoveMovie">Remove</button>
      </div>
    </div>

    ${m.tmdbCandidates && m.tmdbCandidates.length > 0 ? `
      <div class="form-group" style="margin-bottom: 12px;">
        <label class="form-label" for="selectMovieMatch">Movie match</label>
        <select id="selectMovieMatch" class="form-select">${matchOptions}</select>
      </div>
    ` : ''}

    <div class="form-group" style="margin-bottom: 16px;">
      <label class="form-label" for="selectLanguage">Preferred artwork and trailer language</label>
      <select id="selectLanguage" class="form-select">
        <option value="">Automatic / original</option>
        ${languages.map(l => `<option value="${l}" ${langCode(l) === langCode(m.language) ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <!-- ARTWORK GRID -->
    <div class="artwork-3col-grid">
      <div class="art-slot">
        <div class="art-slot-label">Poster</div>
        <div class="art-slot-preview">
          ${posterUrl ? `<img src="${posterUrl}" alt="Poster" />` : '—'}
        </div>
        <select id="selectPoster" class="form-select form-select-sm">
          ${posterSelectOpts || '<option>No artwork found</option>'}
        </select>
        ${posterUrl ? `<a href="${posterUrl}" target="_blank" class="art-slot-link">Open full size ↗</a>` : ''}
      </div>

      <div class="art-slot">
        <div class="art-slot-label">Backdrop</div>
        <div class="art-slot-preview">
          ${backdropUrl ? `<img src="${backdropUrl}" alt="Backdrop" />` : '—'}
        </div>
        <select id="selectBackdrop" class="form-select form-select-sm">
          ${backdropSelectOpts || '<option>No artwork found</option>'}
        </select>
        ${backdropUrl ? `<a href="${backdropUrl}" target="_blank" class="art-slot-link">Open full size ↗</a>` : ''}
      </div>

      <div class="art-slot">
        <div class="art-slot-label">Logo</div>
        <div class="art-slot-preview">
          ${logoUrl ? `<img src="${logoUrl}" alt="Logo" />` : '—'}
        </div>
        <select id="selectLogo" class="form-select form-select-sm">
          ${logoSelectOpts || '<option>No artwork found</option>'}
        </select>
        ${logoUrl ? `<a href="${logoUrl}" target="_blank" class="art-slot-link">Open full size ↗</a>` : ''}
      </div>
    </div>

    <div style="display:flex; gap:12px; margin-bottom:14px; font-size:12px;">
      ${m.id ? `<a href="${tmdbLink}" target="_blank" style="color:var(--primary-green); text-decoration:none;">TMDB ↗</a>` : ''}
      ${m.imdb_id ? `<a href="${imdbLink}" target="_blank" style="color:var(--primary-green); text-decoration:none;">IMDb ↗</a>` : ''}
    </div>

    <!-- FORM EDITING GRID -->
    <div class="form-grid-2col">
      <div class="form-group full-width">
        <label class="form-label" for="inputMovieTitle">Movie title</label>
        <input type="text" id="inputMovieTitle" class="form-input" value="${escapeHTML(m.title)}">
      </div>

      <div class="form-group">
        <label class="form-label" for="inputYear">Year</label>
        <input type="text" id="inputYear" class="form-input" value="${escapeHTML(m.year)}">
      </div>

      <div class="form-group">
        <label class="form-label" for="inputLanguage">Language</label>
        <input type="text" id="inputLanguage" class="form-input" value="${escapeHTML(m.language)}">
      </div>

      <div class="form-group full-width">
        <label class="form-label" for="inputDistributor">Distributor</label>
        <input type="text" id="inputDistributor" class="form-input" value="${escapeHTML(m.distributor)}">
      </div>

      <div class="form-group full-width">
        <label class="form-label" for="inputPosterUrl">Poster URL</label>
        <input type="text" id="inputPosterUrl" class="form-input" value="${escapeHTML(posterUrl)}">
      </div>

      <div class="form-group full-width" style="display:flex; justify-content:space-between; align-items:center;">
        <label class="checkbox-label">
          <input type="checkbox" id="chkKeepPoster" ${m.keepPoster ? 'checked' : ''}>
          Keep my poster when searching
        </label>
        <button class="btn btn-secondary btn-sm" id="btnUploadPoster">Upload a poster</button>
        <input type="file" id="filePosterInput" accept="image/*" style="display:none;">
      </div>

      <!-- TRAILER SECTION -->
      <div class="mini-heading">TRAILER & TEASER</div>

      <div class="form-group full-width">
        <label class="form-label" for="selectTrailer">Video alternatives</label>
        <select id="selectTrailer" class="form-select">${trailerSelectOpts || '<option value="">No trailers found</option>'}</select>
      </div>

      <div class="form-group full-width">
        <label class="form-label" for="inputTrailerUrl">Trailer link / YouTube video ID</label>
        <input type="text" id="inputTrailerUrl" class="form-input" value="${escapeHTML(activeTrailerUrl)}">
      </div>

      <div class="form-group full-width" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <label class="checkbox-label">
          <input type="checkbox" id="chkKeepTrailer" ${m.keepTrailer ? 'checked' : ''}>
          Keep my trailer when searching
        </label>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-secondary btn-sm" id="btnUsePastedTrailer">Use pasted link</button>
          <button class="btn btn-secondary btn-sm" id="btnSearchYouTube">Search YouTube API</button>
          ${activeTrailerUrl ? `<a href="${activeTrailerUrl}" target="_blank" class="btn btn-secondary btn-sm">Watch ↗</a>` : ''}
        </div>
      </div>

      ${youtubeVideoId ? `
        <div class="form-group full-width">
          <div class="iframe-preview-wrap">
            <iframe src="https://www.youtube-nocookie.com/embed/${youtubeVideoId}" title="YouTube Video Preview" allowfullscreen></iframe>
          </div>
        </div>
      ` : ''}

      <!-- NEWSLETTER & TECHNICAL DETAILS -->
      <div class="mini-heading">NEWSLETTER & TECHNICAL DETAILS</div>

      <div class="form-group full-width">
        <label class="form-label" for="inputSynopsis">Synopsis</label>
        <textarea id="inputSynopsis" class="form-textarea" rows="3">${escapeHTML(m.overview)}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label" for="inputFeatureDuration">Feature duration</label>
        <input type="text" id="inputFeatureDuration" class="form-input" value="${escapeHTML(m.featureDuration)}" placeholder="e.g. 02:45:00">
      </div>

      <div class="form-group">
        <label class="form-label" for="inputCplPart1">CPL Part 1 duration</label>
        <input type="text" id="inputCplPart1" class="form-input" value="${escapeHTML(m.cplPart1Duration)}" placeholder="e.g. 01:20:00">
      </div>

      <div class="form-group">
        <label class="form-label" for="inputCplPart2">CPL Part 2 duration</label>
        <input type="text" id="inputCplPart2" class="form-input" value="${escapeHTML(m.cplPart2Duration)}" placeholder="e.g. 01:25:00">
      </div>

      <div class="form-group">
        <label class="form-label" for="inputFirstFrameEnd">First frame end credits</label>
        <input type="text" id="inputFirstFrameEnd" class="form-input" value="${escapeHTML(m.firstFrameEndCredits)}" placeholder="e.g. 02:38:00">
      </div>

      <div class="form-group full-width">
        <label class="form-label" for="inputFirstFrameMoving">First frame moving credits</label>
        <input type="text" id="inputFirstFrameMoving" class="form-input" value="${escapeHTML(m.firstFrameMovingCredits)}" placeholder="e.g. 02:42:00">
      </div>

      <div class="form-group full-width">
        <label class="form-label" for="inputCplEntries">CPL entries · one per line: part | name | duration</label>
        <textarea id="inputCplEntries" class="form-textarea" rows="3" placeholder="1 | VIKRAM_PART1 | 01:20:00&#10;2 | VIKRAM_PART2 | 01:25:00">${escapeHTML(m.cplEntries)}</textarea>
      </div>

      <div class="form-group full-width" style="margin-top: 10px;">
        <button class="btn btn-primary btn-full" id="btnApplyMovieChanges">Apply changes</button>
      </div>
    </div>
  `;
}

// Bind Detail Card Interactive Events
function bindDetailCardEvents(card, m) {
  // Reorder / remove
  const btnUp = card.querySelector('#btnMoveUp');
  const btnDown = card.querySelector('#btnMoveDown');
  const btnRemove = card.querySelector('#btnRemoveMovie');

  if (btnUp) btnUp.addEventListener('click', () => moveMovieOrder(m.uid, -1));
  if (btnDown) btnDown.addEventListener('click', () => moveMovieOrder(m.uid, 1));
  if (btnRemove) btnRemove.addEventListener('click', () => promptRemoveMovie(m));

  // Search single
  const btnSearchSingle = card.querySelector('#btnSearchSingle');
  if (btnSearchSingle) btnSearchSingle.addEventListener('click', () => fetchMovieMetadata(m));

  // Match select
  const selectMatch = card.querySelector('#selectMovieMatch');
  if (selectMatch) {
    selectMatch.addEventListener('change', async (e) => {
      const matchId = e.target.value;
      if (matchId) await loadMovieDetailFromTMDB(m, matchId);
    });
  }

  // Artwork selects
  const selPoster = card.querySelector('#selectPoster');
  const selBackdrop = card.querySelector('#selectBackdrop');
  const selLogo = card.querySelector('#selectLogo');

  if (selPoster) selPoster.addEventListener('change', (e) => { m.selectedPoster = e.target.value; updateAllUI(); });
  if (selBackdrop) selBackdrop.addEventListener('change', (e) => { m.selectedBackdrop = e.target.value; updateAllUI(); });
  if (selLogo) selLogo.addEventListener('change', (e) => { m.selectedLogo = e.target.value; updateAllUI(); });

  // Upload poster
  const btnUploadPoster = card.querySelector('#btnUploadPoster');
  const filePosterInput = card.querySelector('#filePosterInput');
  if (btnUploadPoster && filePosterInput) {
    btnUploadPoster.addEventListener('click', () => filePosterInput.click());
    filePosterInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          m.posterUrl = evt.target.result;
          m.selectedPoster = evt.target.result;
          showNotice('Custom poster uploaded and selected.');
          updateAllUI();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Video select
  const selTrailer = card.querySelector('#selectTrailer');
  if (selTrailer) {
    selTrailer.addEventListener('change', (e) => {
      m.selectedTrailer = e.target.value;
      m.trailerUrl = e.target.value;
      updateAllUI();
    });
  }

  // Use pasted link button
  const btnPastedTrailer = card.querySelector('#btnUsePastedTrailer');
  const inputTrailerUrl = card.querySelector('#inputTrailerUrl');
  if (btnPastedTrailer && inputTrailerUrl) {
    btnPastedTrailer.addEventListener('click', () => {
      m.trailerUrl = inputTrailerUrl.value.trim();
      m.selectedTrailer = inputTrailerUrl.value.trim();
      showNotice('Pasted trailer link applied.');
      updateAllUI();
    });
  }

  // Search YouTube API button
  const btnYouTube = card.querySelector('#btnSearchYouTube');
  if (btnYouTube) {
    btnYouTube.addEventListener('click', async () => {
      if (!state.status.youtube) {
        showNotice('YouTube API key is missing. Set YOUTUBE_API_KEY to search.', 'error');
        return;
      }
      showNotice(`Searching YouTube for ${m.title}...`);
      try {
        const res = await fetch(`/api/youtube?q=${encodeURIComponent(m.title)}`);
        const data = await res.json();
        if (data.videos && data.videos.length > 0) {
          m.videos.push(...data.videos);
          m.selectedTrailer = data.videos[0].url;
          m.trailerUrl = data.videos[0].url;
          showNotice(`Found ${data.videos.length} trailer alternative(s) on YouTube.`);
          updateAllUI();
        } else {
          showNotice('No YouTube trailers found.', 'error');
        }
      } catch {
        showNotice('YouTube search failed.', 'error');
      }
    });
  }

  // Apply Changes button
  const btnApply = card.querySelector('#btnApplyMovieChanges');
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      m.title = card.querySelector('#inputMovieTitle').value.trim() || m.title;
      m.year = card.querySelector('#inputYear').value.trim();
      m.language = card.querySelector('#inputLanguage').value.trim();
      m.distributor = card.querySelector('#inputDistributor').value.trim();
      m.posterUrl = card.querySelector('#inputPosterUrl').value.trim();

      const keepPosterChk = card.querySelector('#chkKeepPoster');
      if (keepPosterChk) m.keepPoster = keepPosterChk.checked;

      const keepTrailerChk = card.querySelector('#chkKeepTrailer');
      if (keepTrailerChk) m.keepTrailer = keepTrailerChk.checked;

      m.overview = card.querySelector('#inputSynopsis').value.trim();
      m.featureDuration = card.querySelector('#inputFeatureDuration').value.trim();
      m.cplPart1Duration = card.querySelector('#inputCplPart1').value.trim();
      m.cplPart2Duration = card.querySelector('#inputCplPart2').value.trim();
      m.firstFrameEndCredits = card.querySelector('#inputFirstFrameEnd').value.trim();
      m.firstFrameMovingCredits = card.querySelector('#inputFirstFrameMoving').value.trim();
      m.cplEntries = card.querySelector('#inputCplEntries').value.trim();

      showNotice('Movie details updated across your workspace.');
      updateAllUI();
    });
  }
}

// Fetch Movie Metadata for Single Movie
async function fetchMovieMetadata(m) {
  if (!state.status.tmdb) {
    m.status = 'error';
    m.statusText = 'No TMDB key';
    updateAllUI();
    return false;
  }

  m.status = 'loading';
  m.statusText = 'Searching…';
  updateAllUI();

  try {
    const searchUrl = `/api/search?q=${encodeURIComponent(m.title)}${m.year ? `&year=${m.year}` : ''}${m.language ? `&language=${m.language}` : ''}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      m.status = 'error';
      m.statusText = 'No match · edit title';
      updateAllUI();
      return false;
    }

    m.tmdbCandidates = searchData.results;
    const match = searchData.results[0];
    await loadMovieDetailFromTMDB(m, match.id);
    return true;
  } catch {
    m.status = 'error';
    m.statusText = 'Search failed';
    updateAllUI();
    return false;
  }
}

// Load Movie Detail by TMDB ID
async function loadMovieDetailFromTMDB(m, tmdbId) {
  m.status = 'loading';
  m.statusText = 'Loading details…';
  updateAllUI();

  try {
    const detailUrl = `/api/movie/${tmdbId}${m.language ? `?language=${m.language}` : ''}`;
    const res = await fetch(detailUrl);
    const data = await res.json();

    m.id = data.movie.id;
    m.imdb_id = data.movie.imdb_id;
    m.overview = data.movie.overview || m.overview || '';
    m.images = data.images || { poster: [], backdrop: [], logo: [] };
    m.videos = data.videos || [];

    if (!m.keepPoster) {
      m.selectedPoster = m.images.poster?.[0]?.url || null;
      m.selectedBackdrop = m.images.backdrop?.[0]?.url || null;
      m.selectedLogo = m.images.logo?.[0]?.url || null;
    }

    if (!m.keepTrailer) {
      m.selectedTrailer = m.videos?.[0]?.url || null;
      m.trailerUrl = m.selectedTrailer;
    }

    m.status = 'found';
    m.statusText = 'Matched · review choices';
  } catch {
    m.status = 'error';
    m.statusText = 'Details failed';
  }

  updateAllUI();
}

// Run Sequential Batch Search
async function runBatchSearch() {
  const checkedMovies = state.movies.filter(m => m.checked !== false);
  if (checkedMovies.length === 0) {
    showNotice('No movies selected for batch search.', 'error');
    return;
  }

  if (!state.status.tmdb) {
    showNotice('TMDB_API_KEY is not configured in environment. Enable API key to search.', 'error');
    return;
  }

  state.batchRunning = true;
  state.stopBatchRequested = false;
  const btnStop = document.getElementById('btnStopBatch');
  if (btnStop) btnStop.classList.remove('hidden');

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < checkedMovies.length; i++) {
    if (state.stopBatchRequested) {
      showNotice(`Batch search stopped after item ${i}.`);
      break;
    }

    const m = checkedMovies[i];
    showNotice(`Searching ${i + 1} of ${checkedMovies.length}: ${m.title}`);
    
    const success = await fetchMovieMetadata(m);
    if (success) processed++; else failed++;
  }

  state.batchRunning = false;
  if (btnStop) btnStop.classList.add('hidden');
  showNotice(`Search finished: ${processed} processed, ${failed} failed.`);
}

// Reorder Movie
function moveMovieOrder(uid, delta) {
  const idx = state.movies.findIndex(m => m.uid === uid);
  if (idx < 0) return;

  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= state.movies.length) return;

  const temp = state.movies[idx];
  state.movies[idx] = state.movies[targetIdx];
  state.movies[targetIdx] = temp;

  updateAllUI();
}

// Prompt Remove Movie Modal
function promptRemoveMovie(m) {
  const modal = document.getElementById('confirmModal');
  const msg = document.getElementById('confirmModalMessage');
  msg.textContent = `Are you sure you want to remove "${m.title}" from your library?`;

  const btnAccept = document.getElementById('btnAcceptConfirmModal');
  const onAccept = () => {
    state.movies = state.movies.filter(item => item.uid !== m.uid);
    if (state.selectedUid === m.uid) {
      state.selectedUid = state.movies[0]?.uid || null;
    }
    closeConfirmModal();
    btnAccept.removeEventListener('click', onAccept);
    showNotice(`Removed "${m.title}".`);
    updateAllUI();
  };

  btnAccept.addEventListener('click', onAccept);
  modal.showModal();
}

function closeConfirmModal() {
  const modal = document.getElementById('confirmModal');
  modal.close();
}

// File Import Handler (.txt, .csv, .pdf)
async function handleFileImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    showNotice('File exceeds 10 MB limit.', 'error');
    return;
  }

  showNotice(`Reading file "${file.name}"...`);

  try {
    let text = '';
    if (file.name.endsWith('.pdf')) {
      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to extract text from PDF.');
      text = data.text;
    } else {
      text = await file.text();
    }

    const parsed = parseMovieListText(text);
    if (parsed.length > 0) {
      addMoviesFromParsedList(parsed);
      showNotice(`Successfully imported ${parsed.length} titles from ${file.name}.`);
    } else {
      showNotice('No valid titles found in imported file.', 'error');
    }
  } catch (err) {
    showNotice(`Import Error: ${err.message}`, 'error');
  }
}

// Newsletter Sync Setup
function setupNewsletterSync() {
  const fields = ['nlTitle', 'nlIntro', 'nlTopBannerUrl', 'nlTopBannerLink', 'nlSecondBannerUrl', 'nlSecondBannerLink', 'nlFooterText'];

  fields.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => {
        state.newsletter.title = document.getElementById('nlTitle').value;
        state.newsletter.intro = document.getElementById('nlIntro').value;
        state.newsletter.topBannerUrl = document.getElementById('nlTopBannerUrl').value;
        state.newsletter.topBannerLink = document.getElementById('nlTopBannerLink').value;
        state.newsletter.secondBannerUrl = document.getElementById('nlSecondBannerUrl').value;
        state.newsletter.secondBannerLink = document.getElementById('nlSecondBannerLink').value;
        state.newsletter.footer = document.getElementById('nlFooterText').value;

        renderNewsletterPreview();
        saveLocalState();
      });
    }
  });

  // Top Banner Upload
  setupImageUpload('btnUploadTopBanner', 'fileTopBannerInput', (url) => {
    document.getElementById('nlTopBannerUrl').value = url;
    state.newsletter.topBannerUrl = url;
    renderNewsletterPreview();
  });

  // Second Banner Upload
  setupImageUpload('btnUploadSecondBanner', 'fileSecondBannerInput', (url) => {
    document.getElementById('nlSecondBannerUrl').value = url;
    state.newsletter.secondBannerUrl = url;
    renderNewsletterPreview();
  });

  // Export Buttons
  document.getElementById('btnExportHTML').addEventListener('click', () => exportNewsletterHTML(false));
  document.getElementById('btnExportEmbeddedHTML').addEventListener('click', () => exportNewsletterHTML(true));
}

function setupImageUpload(btnId, fileInputId, callback) {
  const btn = document.getElementById(btnId);
  const fileInput = document.getElementById(fileInputId);
  if (btn && fileInput) {
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => callback(evt.target.result);
        reader.readAsDataURL(file);
      }
    });
  }
}

// Render Newsletter Live Preview
function renderNewsletterPreview() {
  const iframe = document.getElementById('nlIframePreview');
  if (!iframe) return;

  const html = generateNewsletterHTML(state.movies, state.newsletter);
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

// Export Newsletter HTML File
async function exportNewsletterHTML(embedImages = false) {
  let moviesToExport = state.movies;

  if (embedImages) {
    showNotice('Embedding TMDB images for offline export...');
    moviesToExport = await Promise.all(state.movies.map(async (m) => {
      const copy = { ...m };
      const poster = m.selectedPoster || m.images?.poster?.[0]?.url;
      if (poster && poster.startsWith('https://image.tmdb.org')) {
        try {
          const res = await fetch('/api/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: poster })
          });
          const data = await res.json();
          if (data.url) copy.selectedPoster = data.url;
        } catch {
          // fallback to remote
        }
      }
      return copy;
    }));
  }

  const html = generateNewsletterHTML(moviesToExport, state.newsletter);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'movie-newsletter.html';
  a.click();
  URL.revokeObjectURL(url);
  showNotice('Newsletter HTML exported successfully.');
}

// Download Artwork ZIP
async function downloadArtworkZIP() {
  const assets = [];
  state.movies.forEach(m => {
    const poster = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
    if (poster) assets.push({ name: `${m.title}_poster`, url: poster });
    const backdrop = m.selectedBackdrop || m.images?.backdrop?.[0]?.url;
    if (backdrop) assets.push({ name: `${m.title}_backdrop`, url: backdrop });
  });

  if (assets.length === 0) {
    showNotice('No artwork available for ZIP export.', 'error');
    return;
  }

  showNotice(`Preparing ZIP archive with ${assets.length} image(s)...`);

  try {
    const res = await fetch('/api/artwork.zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets })
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'ZIP export failed.');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'movie-artwork.zip';
    a.click();
    URL.revokeObjectURL(url);
    showNotice('Artwork ZIP downloaded.');
  } catch (err) {
    showNotice(`ZIP Error: ${err.message}`, 'error');
  }
}

// Export CSV Report
function exportCSVReport() {
  if (state.movies.length === 0) {
    showNotice('No movies to export.', 'error');
    return;
  }

  const headers = ['Title', 'Year', 'Language', 'Distributor', 'Poster URL', 'Trailer URL', 'Feature Duration', 'CPL Part 1 Duration', 'CPL Part 2 Duration', 'Synopsis'];
  const rows = [headers.join(',')];

  state.movies.forEach(m => {
    const poster = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url || '';
    const trailer = m.trailerUrl || m.selectedTrailer || m.videos?.[0]?.url || '';
    const row = [
      escapeCSV(m.title),
      escapeCSV(m.year),
      escapeCSV(m.language),
      escapeCSV(m.distributor),
      escapeCSV(poster),
      escapeCSV(trailer),
      escapeCSV(m.featureDuration),
      escapeCSV(m.cplPart1Duration),
      escapeCSV(m.cplPart2Duration),
      escapeCSV(m.overview)
    ];
    rows.push(row.join(','));
  });

  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'movie-report.csv';
  a.click();
  URL.revokeObjectURL(url);
  showNotice('Movie CSV report exported.');
}

// Save Project JSON
function saveProjectJSON() {
  const project = {
    version: '1.0',
    movies: state.movies,
    newsletter: state.newsletter
  };

  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'movie-studio-project.json';
  a.click();
  URL.revokeObjectURL(url);
  showNotice('Project file saved.');
}

// Load Project JSON
function loadProjectJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (data && Array.isArray(data.movies)) {
        if (state.movies.length > 0) {
          if (!confirm('Replace your current movie workspace with this project file?')) return;
        }
        state.movies = data.movies;
        if (data.newsletter) state.newsletter = { ...state.newsletter, ...data.newsletter };
        state.selectedUid = state.movies[0]?.uid || null;
        updateAllUI();
        showNotice('Project loaded successfully.');
      } else {
        showNotice('Invalid project file format.', 'error');
      }
    } catch {
      showNotice('Could not parse project file.', 'error');
    }
  };
  reader.readAsText(file);
}

// Helper Utilities
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeCSV(str) {
  if (!str) return '""';
  const clean = String(str).replace(/"/g, '""');
  return `"${clean}"`;
}

function extractYouTubeID(url) {
  if (!url) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}
