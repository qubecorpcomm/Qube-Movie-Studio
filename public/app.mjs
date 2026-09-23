import { parseMovieListText, generateNewsletterHTML } from './core.mjs';

// Application State
const state = {
  movies: [],
  status: { tmdb: false, youtube: false },
  selectedMovieId: null,
  activeModal: null,
  newsletterConfig: {
    title: 'Weekly Movie Brief',
    subtitle: 'Hand-picked featured releases & trailers',
    headerBg: '#0f172a',
    headerTextColor: '#ffffff',
    accentColor: '#2563eb'
  }
};

// DOM Elements
const statusBadge = document.getElementById('statusBadge');
const apiAlert = document.getElementById('apiAlert');
const movieCount = document.getElementById('movieCount');
const movieGrid = document.getElementById('movieGrid');
const selectedCount = document.getElementById('selectedCount');
const newsletterPreview = document.getElementById('newsletterPreview');
const zipSelectionGrid = document.getElementById('zipSelectionGrid');
const zipCount = document.getElementById('zipCount');
const btnDownloadZIP = document.getElementById('btnDownloadZIP');

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  checkAPIStatus();
  setupTabNavigation();
  setupEventListeners();
  updateWorkspaceUI();
});

// Check Server API Capabilities
async function checkAPIStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.status = data;

    if (data.tmdb) {
      statusBadge.innerHTML = `<span class="badge badge-success">TMDB Connected ✅</span>`;
      apiAlert.classList.add('hidden');
    } else {
      statusBadge.innerHTML = `<span class="badge badge-warning">TMDB Unconfigured</span>`;
      apiAlert.classList.remove('hidden');
    }
  } catch {
    statusBadge.innerHTML = `<span class="badge badge-danger">Server Offline</span>`;
  }
}

// Setup Tab Switching
function setupTabNavigation() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.getElementById(`tab-${target}`).classList.add('active');

      if (target === 'newsletter') {
        renderNewsletterPreview();
      } else if (target === 'zip') {
        renderZipGallery();
      }
    });
  });
}

// Event Listeners
function setupEventListeners() {
  // Demo Data Button
  document.getElementById('btnDemo').addEventListener('click', loadDemoMovies);

  // Import Text
  document.getElementById('btnImportText').addEventListener('click', () => {
    const text = document.getElementById('importText').value;
    const parsed = parseMovieListText(text);
    if (parsed.length > 0) {
      addMoviesToState(parsed);
      document.getElementById('importText').value = '';
      switchTab('workspace');
    }
  });

  document.getElementById('btnClearImport').addEventListener('click', () => {
    document.getElementById('importText').value = '';
  });

  // Dropzone File Upload
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileImportInput');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFileUpload(e.target.files[0]);
  });

  // Workspace Toolbar
  document.getElementById('btnFetchAll').addEventListener('click', fetchAllMetadata);
  document.getElementById('btnSelectAll').addEventListener('click', () => setAllSelected(true));
  document.getElementById('btnUnselectAll').addEventListener('click', () => setAllSelected(false));
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnRemoveSelected').addEventListener('click', removeSelected);

  // Project Backup / Restore
  document.getElementById('btnSaveProject').addEventListener('click', saveProjectJSON);
  document.getElementById('btnLoadProject').addEventListener('click', () => {
    document.getElementById('fileProjectInput').click();
  });
  document.getElementById('fileProjectInput').addEventListener('change', loadProjectJSON);

  // Newsletter Controls
  ['nlTitle', 'nlSubtitle', 'nlHeaderBg', 'nlHeaderTextColor', 'nlAccentColor'].forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
      const key = id.replace('nl', '').toLowerCase();
      const mapKey = { title: 'title', subtitle: 'subtitle', headerbg: 'headerBg', headertextcolor: 'headerTextColor', accentcolor: 'accentColor' };
      state.newsletterConfig[mapKey[key]] = e.target.value;
      renderNewsletterPreview();
    });
  });

  document.getElementById('btnCopyHTML').addEventListener('click', copyNewsletterHTML);
  document.getElementById('btnDownloadHTML').addEventListener('click', downloadNewsletterHTML);

  // ZIP Export
  btnDownloadZIP.addEventListener('click', downloadArtworkZIP);

  // Modal Close
  document.getElementById('modalClose').addEventListener('click', closeModal);
}

function switchTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

// Add Movies to State
function addMoviesToState(movieList) {
  const newEntries = movieList.map((m, idx) => ({
    uid: 'm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    id: null,
    title: m.title,
    year: m.year || '',
    overview: '',
    selectedPoster: null,
    selectedBackdrop: null,
    selectedTrailer: null,
    images: { poster: [], backdrop: [], logo: [] },
    videos: [],
    status: 'pending',
    selected: false
  }));

  state.movies.push(...newEntries);
  updateWorkspaceUI();
  // Auto fetch metadata if TMDB is available
  if (state.status.tmdb) {
    newEntries.forEach(m => fetchSingleMovieMetadata(m));
  }
}

// Load Curated Demo Movies
function loadDemoMovies() {
  const demoList = [
    { title: 'Dune: Part Two', year: '2024' },
    { title: 'Oppenheimer', year: '2023' },
    { title: 'Spider-Man: Across the Spider-Verse', year: '2023' },
    { title: 'Interstellar', year: '2014' },
    { title: 'Everything Everywhere All at Once', year: '2022' }
  ];
  addMoviesToState(demoList);
  switchTab('workspace');
}

// File Upload Handler (.txt, .csv, .pdf)
async function handleFileUpload(file) {
  const statusEl = document.getElementById('fileUploadStatus');
  statusEl.textContent = `Processing ${file.name}...`;

  try {
    let text = '';
    if (file.name.endsWith('.pdf')) {
      const arrayBuffer = await file.arrayBuffer();
      const res = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: arrayBuffer
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to read PDF file.');
      text = data.text;
    } else {
      text = await file.text();
    }

    const parsed = parseMovieListText(text);
    if (parsed.length === 0) throw new Error('No movie titles found in file.');

    addMoviesToState(parsed);
    statusEl.textContent = `Successfully imported ${parsed.length} movies!`;
    switchTab('workspace');
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// Fetch Metadata for single movie
async function fetchSingleMovieMetadata(movie) {
  movie.status = 'loading';
  updateMovieCard(movie);

  try {
    // Search
    const searchRes = await fetch(`/api/search?q=${encodeURIComponent(movie.title)}&year=${movie.year}`);
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      movie.status = 'not_found';
      updateMovieCard(movie);
      return;
    }

    const match = searchData.results[0];
    movie.id = match.id;
    movie.title = match.title;
    movie.year = match.release_date ? match.release_date.slice(0, 4) : movie.year;

    // Detail
    const detailRes = await fetch(`/api/movie/${match.id}`);
    const detailData = await detailRes.json();

    movie.overview = detailData.movie?.overview || match.overview || '';
    movie.images = detailData.images || { poster: [], backdrop: [], logo: [] };
    movie.videos = detailData.videos || [];

    movie.selectedPoster = movie.images.poster?.[0]?.url || null;
    movie.selectedBackdrop = movie.images.backdrop?.[0]?.url || null;
    movie.selectedTrailer = movie.videos?.[0]?.url || null;

    movie.status = 'found';
  } catch {
    movie.status = 'error';
  }

  updateMovieCard(movie);
}

// Fetch metadata for all pending movies
function fetchAllMetadata() {
  state.movies.forEach(m => {
    if (m.status !== 'found') fetchSingleMovieMetadata(m);
  });
}

// Update Workspace UI
function updateWorkspaceUI() {
  movieCount.textContent = state.movies.length;
  
  const selected = state.movies.filter(m => m.selected).length;
  selectedCount.textContent = `${selected} of ${state.movies.length} selected`;

  if (state.movies.length === 0) {
    movieGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <h3>No movies in workspace yet</h3>
        <p>Paste movie titles in the Import tab or click <strong>Load Demo</strong> above to get started.</p>
      </div>
    `;
    return;
  }

  movieGrid.innerHTML = '';
  state.movies.forEach((m, index) => {
    const card = createMovieCardElement(m, index);
    movieGrid.appendChild(card);
  });
}

// Create Card DOM Element
function createMovieCardElement(m, index) {
  const card = document.createElement('div');
  card.className = `movie-card ${m.selected ? 'selected' : ''}`;
  card.dataset.uid = m.uid;

  const posterUrl = m.selectedPoster || m.images?.poster?.[0]?.url;
  const backdropUrl = m.selectedBackdrop || m.images?.backdrop?.[0]?.url;

  card.innerHTML = `
    <input type="checkbox" class="card-select-checkbox" ${m.selected ? 'checked' : ''} />
    <div class="poster-wrapper">
      ${backdropUrl ? `<img src="${backdropUrl}" class="poster-backdrop" alt="backdrop" />` : ''}
      ${posterUrl ? `<img src="${posterUrl}" class="poster-img" alt="${m.title}" />` : `
        <div class="poster-placeholder">
          <span style="font-size: 2rem;">🎬</span>
          <span style="font-size: 0.75rem;">${m.status === 'loading' ? 'Fetching...' : 'No Artwork'}</span>
        </div>
      `}
    </div>
    <div class="movie-content">
      <div class="movie-title">${m.title}</div>
      <div class="movie-meta">
        <span>${m.year || 'N/A'}</span>
        <span class="badge ${m.status === 'found' ? 'badge-success' : m.status === 'loading' ? 'badge-warning' : 'badge-danger'}">
          ${m.status === 'found' ? 'Found' : m.status === 'loading' ? 'Loading...' : m.status === 'not_found' ? 'Not Found' : 'Pending'}
        </span>
      </div>
      <p class="movie-overview">${m.overview || 'No overview text available. Click search to refine or update.'}</p>
      <div class="movie-card-footer">
        <div style="display: flex; gap: 0.25rem;">
          <button class="btn btn-secondary btn-sm btn-art" title="Pick Artwork">🖼️ Artwork</button>
          <button class="btn btn-secondary btn-sm btn-search" title="Search / Match">🔍 Refine</button>
        </div>
        <div style="display: flex; gap: 0.25rem;">
          <button class="btn btn-ghost btn-sm btn-up" title="Move Up">⬆️</button>
          <button class="btn btn-ghost btn-sm btn-down" title="Move Down">⬇️</button>
          <button class="btn btn-ghost btn-sm btn-del" title="Delete">🗑️</button>
        </div>
      </div>
    </div>
  `;

  // Bind Events
  const checkbox = card.querySelector('.card-select-checkbox');
  checkbox.addEventListener('change', (e) => {
    m.selected = e.target.checked;
    card.classList.toggle('selected', m.selected);
    const selected = state.movies.filter(x => x.selected).length;
    selectedCount.textContent = `${selected} of ${state.movies.length} selected`;
  });

  card.querySelector('.btn-art').addEventListener('click', () => openArtworkModal(m));
  card.querySelector('.btn-search').addEventListener('click', () => openSearchModal(m));
  card.querySelector('.btn-del').addEventListener('click', () => {
    state.movies = state.movies.filter(x => x.uid !== m.uid);
    updateWorkspaceUI();
  });
  card.querySelector('.btn-up').addEventListener('click', () => {
    if (index > 0) {
      const temp = state.movies[index];
      state.movies[index] = state.movies[index - 1];
      state.movies[index - 1] = temp;
      updateWorkspaceUI();
    }
  });
  card.querySelector('.btn-down').addEventListener('click', () => {
    if (index < state.movies.length - 1) {
      const temp = state.movies[index];
      state.movies[index] = state.movies[index + 1];
      state.movies[index + 1] = temp;
      updateWorkspaceUI();
    }
  });

  return card;
}

function updateMovieCard(movie) {
  const existing = document.querySelector(`.movie-card[data-uid="${movie.uid}"]`);
  if (existing) {
    const parent = existing.parentElement;
    const index = state.movies.findIndex(m => m.uid === movie.uid);
    if (index !== -1) {
      const newCard = createMovieCardElement(movie, index);
      parent.replaceChild(newCard, existing);
    }
  }
}

// Select All / Deselect All
function setAllSelected(selected) {
  state.movies.forEach(m => m.selected = selected);
  updateWorkspaceUI();
}

function removeSelected() {
  state.movies = state.movies.filter(m => !m.selected);
  updateWorkspaceUI();
}

// Artwork Picker Modal
function openArtworkModal(movie) {
  const modal = document.getElementById('movieModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');

  modalTitle.textContent = `Select Artwork for ${movie.title}`;

  const posters = movie.images?.poster || [];
  const backdrops = movie.images?.backdrop || [];

  modalBody.innerHTML = `
    <h4>Posters (${posters.length})</h4>
    <div class="gallery-grid">
      ${posters.length ? posters.map((p, i) => `
        <div class="gallery-thumb ${movie.selectedPoster === p.url ? 'selected' : ''}" data-type="poster" data-url="${p.url}">
          <img src="${p.url}" alt="poster ${i}" />
        </div>
      `).join('') : '<p style="color:var(--text-muted); font-size:0.85rem;">No posters available</p>'}
    </div>

    <h4 style="margin-top: 1.5rem;">Backdrops (${backdrops.length})</h4>
    <div class="gallery-grid">
      ${backdrops.length ? backdrops.map((b, i) => `
        <div class="gallery-thumb ${movie.selectedBackdrop === b.url ? 'selected' : ''}" data-type="backdrop" data-url="${b.url}">
          <img src="${b.url}" alt="backdrop ${i}" style="height: 90px; object-fit: cover;" />
        </div>
      `).join('') : '<p style="color:var(--text-muted); font-size:0.85rem;">No backdrops available</p>'}
    </div>
  `;

  modalBody.querySelectorAll('.gallery-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      const type = thumb.dataset.type;
      const url = thumb.dataset.url;
      if (type === 'poster') movie.selectedPoster = url;
      if (type === 'backdrop') movie.selectedBackdrop = url;
      updateMovieCard(movie);
      openArtworkModal(movie); // Re-render gallery selection
    });
  });

  modal.classList.remove('hidden');
}

// Search / Refine Modal
function openSearchModal(movie) {
  const modal = document.getElementById('movieModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');

  modalTitle.textContent = `Refine Match: ${movie.title}`;

  modalBody.innerHTML = `
    <div class="form-group" style="display: flex; gap: 0.5rem;">
      <input type="text" id="modalSearchQuery" value="${movie.title}" placeholder="Search title or IMDb ID (tt1234567)" style="flex: 1;" />
      <button id="btnModalSearch" class="btn btn-primary">Search TMDB</button>
    </div>
    <div id="modalSearchResults" style="margin-top: 1rem;">
      <p style="color:var(--text-muted); font-size:0.85rem;">Click search to query TMDB.</p>
    </div>
  `;

  document.getElementById('btnModalSearch').addEventListener('click', async () => {
    const q = document.getElementById('modalSearchQuery').value.trim();
    const resultsContainer = document.getElementById('modalSearchResults');
    resultsContainer.innerHTML = '<p style="color:var(--text-muted);">Searching...</p>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        resultsContainer.innerHTML = '<p style="color:var(--danger);">No results found.</p>';
        return;
      }

      resultsContainer.innerHTML = data.results.map(r => `
        <div style="display: flex; gap: 1rem; padding: 0.75rem; border-bottom: 1px solid var(--border-color); align-items: center;">
          <img src="${r.poster_path ? 'https://image.tmdb.org/t/p/w92' + r.poster_path : 'https://via.placeholder.com/60x90'}" style="width: 50px; border-radius: 4px;" />
          <div style="flex: 1;">
            <strong>${r.title}</strong> (${r.release_date ? r.release_date.slice(0, 4) : 'N/A'})
            <p style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${r.overview ? r.overview.slice(0, 100) + '...' : ''}</p>
          </div>
          <button class="btn btn-secondary btn-sm btn-select-match" data-id="${r.id}">Select</button>
        </div>
      `).join('');

      resultsContainer.querySelectorAll('.btn-select-match').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          movie.id = id;
          movie.status = 'loading';
          updateMovieCard(movie);
          closeModal();

          const detailRes = await fetch(`/api/movie/${id}`);
          const detailData = await detailRes.json();

          movie.title = detailData.movie.title;
          movie.year = detailData.movie.year;
          movie.overview = detailData.movie.overview;
          movie.images = detailData.images;
          movie.videos = detailData.videos;

          movie.selectedPoster = movie.images.poster?.[0]?.url || null;
          movie.selectedBackdrop = movie.images.backdrop?.[0]?.url || null;
          movie.selectedTrailer = movie.videos?.[0]?.url || null;
          movie.status = 'found';

          updateMovieCard(movie);
        });
      });
    } catch {
      resultsContainer.innerHTML = '<p style="color:var(--danger);">Failed to search TMDB.</p>';
    }
  });

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('movieModal').classList.add('hidden');
}

// Newsletter Preview Renderer
function renderNewsletterPreview() {
  const html = generateNewsletterHTML(state.movies, state.newsletterConfig);
  const doc = newsletterPreview.contentDocument || newsletterPreview.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
}

function copyNewsletterHTML() {
  const html = generateNewsletterHTML(state.movies, state.newsletterConfig);
  navigator.clipboard.writeText(html).then(() => {
    alert('Newsletter HTML copied to clipboard!');
  });
}

function downloadNewsletterHTML() {
  const html = generateNewsletterHTML(state.movies, state.newsletterConfig);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'movie-newsletter.html';
  a.click();
  URL.revokeObjectURL(url);
}

// Artwork ZIP Gallery
function renderZipGallery() {
  const assets = [];
  state.movies.forEach(m => {
    if (m.selectedPoster) assets.push({ name: `${m.title}_poster`, url: m.selectedPoster });
    if (m.selectedBackdrop) assets.push({ name: `${m.title}_backdrop`, url: m.selectedBackdrop });
  });

  zipCount.textContent = `${assets.length} images queued for ZIP`;
  btnDownloadZIP.disabled = assets.length === 0;

  if (assets.length === 0) {
    zipSelectionGrid.innerHTML = '<p style="color:var(--text-muted); grid-column:1/-1;">No images found in workspace. Fetch movie metadata first.</p>';
    return;
  }

  zipSelectionGrid.innerHTML = assets.map((a, i) => `
    <div class="zip-item">
      <img src="${a.url}" alt="${a.name}" />
      <div class="zip-item-title">${a.name}</div>
    </div>
  `).join('');
}

async function downloadArtworkZIP() {
  const assets = [];
  state.movies.forEach(m => {
    if (m.selectedPoster) assets.push({ name: `${m.title}_poster`, url: m.selectedPoster });
    if (m.selectedBackdrop) assets.push({ name: `${m.title}_backdrop`, url: m.selectedBackdrop });
  });

  if (assets.length === 0) return;

  btnDownloadZIP.disabled = true;
  btnDownloadZIP.textContent = 'Generating ZIP...';

  try {
    const res = await fetch('/api/artwork.zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to generate ZIP.');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'movie-artwork.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`ZIP Export Error: ${err.message}`);
  } finally {
    btnDownloadZIP.disabled = false;
    btnDownloadZIP.textContent = '⬇️ Download Artwork ZIP';
  }
}

// Project Persistence (JSON / CSV)
function saveProjectJSON() {
  const projectData = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    newsletterConfig: state.newsletterConfig,
    movies: state.movies
  };
  const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qube-movie-studio-project.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function loadProjectJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (data.movies && Array.isArray(data.movies)) {
        state.movies = data.movies;
        if (data.newsletterConfig) state.newsletterConfig = data.newsletterConfig;
        updateWorkspaceUI();
        alert('Project loaded successfully!');
      }
    } catch {
      alert('Invalid project JSON file.');
    }
  };
  reader.readAsText(file);
}

function exportCSV() {
  if (state.movies.length === 0) {
    alert('No movies in workspace to export.');
    return;
  }

  const rows = [['Title', 'Year', 'Overview', 'Poster URL', 'Backdrop URL', 'Trailer URL']];
  state.movies.forEach(m => {
    rows.push([
      `"${(m.title || '').replace(/"/g, '""')}"`,
      `"${m.year || ''}"`,
      `"${(m.overview || '').replace(/"/g, '""')}"`,
      `"${m.selectedPoster || ''}"`,
      `"${m.selectedBackdrop || ''}"`,
      `"${m.selectedTrailer || ''}"`
    ]);
  });

  const csvContent = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'movie-workspace.csv';
  a.click();
  URL.revokeObjectURL(url);
}
