import { parseMovieListText, extractBulletinMetadata, generateNewsletterHTML, langCode } from './core.mjs';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js';

// Firebase Global References
let firebaseApp = null;
let db = null;
let auth = null;
let currentUser = null;
let unsubscribeProjects = null;
let cloudProjects = [];

// Firestore Operation Types & Error Handler
const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Application Shared State with strict per-tool data isolation
const state = {
  activeTab: 'artwork',
  status: { tmdb: false, youtube: false },
  batchRunning: false,
  stopBatchRequested: false,
  artwork: {
    movies: [],
    selectedUid: null,
    filter: ''
  },
  trailers: {
    movies: [],
    selectedUid: null,
    filter: ''
  },
  newsletter: {
    movies: [],
    selectedUid: null,
    title: 'Theatrical Release & CPL Bulletin',
    scheduleDate: 'September 24–30, 2026',
    helpDeskPhone: '(424) 343-2691',
    helpDeskEmail: 'support@qubewire.com',
    intro: 'Keep tabs on the feature releases coming your way and plan your screening schedules seamlessly with our weekly theatrical report.',
    topBannerUrl: 'https://i.ibb.co/5NfYmGx/QW-banner-new.jpg',
    topBannerLink: 'https://www.qubewire.com',
    secondBannerUrl: 'https://i.ibb.co/spJ8m0Tg/02.jpg',
    secondBannerLink: 'https://www.qubewire.com',
    footer: '© Qube Cinema Inc. / QubeWire. All rights reserved. For technical assistance or KDM inquiries, please contact our 24/7 Help Desk.',
    layoutTemplate: 'theatrical-bulletin',
    accentColor: '#2b6ef6',
    fontFamily: 'sans-serif'
  }
};

// Helper to get display name for each tool
function toolDisplayName(t) {
  if (t === 'artwork') return 'Artwork Studio';
  if (t === 'trailers') return 'Trailer Studio';
  if (t === 'newsletter') return 'Newsletter Generator';
  return 'Workspace';
}

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
  loadLocalState();
  checkAPIStatus();
  initFirebase();
  setupNavigation();
  setupEventHandlers();
  updateAllUI();
});

const ALLOWED_EMAIL = 'qubecorpcomm@gmail.com';

// Save / Load Local State - Session starts fresh on reload/reopen (no persistence across reloads)
function saveLocalState() {
  try {
    localStorage.removeItem('movie_studio_state_v1');
  } catch (err) {
    // Ignore storage error
  }
}

function loadLocalState() {
  try {
    localStorage.removeItem('movie_studio_state_v1');
  } catch (err) {
    // Ignore storage error
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

// Initialize Firebase & Firestore
async function initFirebase() {
  try {
    const res = await fetch('/api/firebase-config');
    if (!res.ok) return;
    const config = await res.json();
    if (!config.projectId) return;

    firebaseApp = initializeApp(config);
    db = getFirestore(firebaseApp, config.firestoreDatabaseId);
    auth = getAuth(firebaseApp);

    // Validate connection to Firestore on boot
    testFirestoreConnection();

    // Listen to Auth State
    onAuthStateChanged(auth, async (user) => {
      const gateErr = document.getElementById('authGateError');
      if (user) {
        const userEmail = (user.email || '').toLowerCase();
        if (userEmail === ALLOWED_EMAIL) {
          currentUser = user;
          if (gateErr) gateErr.classList.add('hidden');
          updateAuthUI();
          saveUserProfile(user);
          subscribeToCloudProjects(user.uid);
        } else {
          // Unauthorized email logged in
          if (gateErr) {
            gateErr.textContent = `Access Denied: ${user.email} is not authorized. Only qubecorpcomm@gmail.com can access this application.`;
            gateErr.classList.remove('hidden');
          }
          await signOut(auth);
          currentUser = null;
          updateAuthUI();
        }
      } else {
        currentUser = null;
        updateAuthUI();
      }
    });
  } catch (err) {
    console.warn('Firebase initialization skipped or failed:', err);
  }
}

async function testFirestoreConnection() {
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

// User Profile Record
async function saveUserProfile(user) {
  if (!db || !user) return;
  const path = `users/${user.uid}`;
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const profile = {
      userId: user.uid,
      email: user.email || '',
      displayName: user.displayName || user.email || 'User',
      photoURL: user.photoURL || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await setDoc(userDocRef, profile, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// Auth Handlers
async function signInWithGoogle() {
  if (!auth) {
    showNotice('Firebase Auth is not available.', 'error');
    return;
  }
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    const signedInEmail = (result.user?.email || '').toLowerCase();
    if (signedInEmail !== ALLOWED_EMAIL) {
      const gateErr = document.getElementById('authGateError');
      if (gateErr) {
        gateErr.textContent = `Access Denied: ${result.user?.email} is not authorized. Only qubecorpcomm@gmail.com can access this application.`;
        gateErr.classList.remove('hidden');
      }
      await signOut(auth);
      currentUser = null;
      updateAuthUI();
    } else {
      showNotice(`Signed in as ${signedInEmail}`);
    }
  } catch (err) {
    showNotice(`Sign-in error: ${err.message}`, 'error');
  }
}

async function signOutUser() {
  if (!auth) return;
  try {
    await signOut(auth);
    currentUser = null;
    updateAuthUI();
    showNotice('Signed out successfully.');
  } catch (err) {
    showNotice(`Sign-out error: ${err.message}`, 'error');
  }
}

function updateAuthUI() {
  const btnSignIn = document.getElementById('btnSignInGoogle');
  const badge = document.getElementById('userProfileBadge');
  const avatar = document.getElementById('userAvatar');
  const nameEl = document.getElementById('userName');
  const authWarning = document.getElementById('cloudAuthWarning');
  const saveBlock = document.getElementById('cloudSaveBlock');
  const overlay = document.getElementById('authGateOverlay');
  const isAuthorized = currentUser && (currentUser.email || '').toLowerCase() === ALLOWED_EMAIL;

  if (isAuthorized) {
    if (btnSignIn) btnSignIn.classList.add('hidden');
    if (badge) badge.classList.remove('hidden');
    if (avatar) avatar.src = currentUser.photoURL || 'https://www.gstatic.com/images/branding/product/2x/avatar_square_32dp.png';
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.email || 'qubecorpcomm';
    if (authWarning) authWarning.classList.add('hidden');
    if (saveBlock) saveBlock.classList.remove('hidden');
    if (overlay) overlay.classList.add('hidden');
  } else {
    if (btnSignIn) btnSignIn.classList.remove('hidden');
    if (badge) badge.classList.add('hidden');
    if (authWarning) authWarning.classList.remove('hidden');
    if (saveBlock) saveBlock.classList.add('hidden');
    if (overlay) overlay.classList.remove('hidden');
  }
}

// Cloud Projects Firestore Subscription
function subscribeToCloudProjects(userId) {
  if (!db) return;
  const path = 'projects';
  try {
    const q = query(collection(db, 'projects'), where('ownerId', '==', userId));
    if (unsubscribeProjects) unsubscribeProjects();

    unsubscribeProjects = onSnapshot(q, (snapshot) => {
      cloudProjects = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
      renderCloudProjectsList();
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

function renderCloudProjectsList() {
  const container = document.getElementById('cloudProjectsList');
  if (!container) return;

  if (!currentUser) {
    container.innerHTML = `<p style="color:var(--muted-text); font-size:12px;">Sign in with Google to view and load your cloud projects.</p>`;
    return;
  }

  if (cloudProjects.length === 0) {
    container.innerHTML = `<p style="color:var(--muted-text); font-size:12px;">No cloud projects saved yet.</p>`;
    return;
  }

  container.innerHTML = cloudProjects.map(proj => {
    const movieCount = Array.isArray(proj.movies) ? proj.movies.length : 0;
    const dateStr = proj.updatedAt ? new Date(proj.updatedAt).toLocaleDateString() : 'Recent';
    return `
      <div class="cloud-project-item">
        <div class="cloud-project-info">
          <span class="cloud-project-name">${escapeHTML(proj.name || 'Untitled Project')}</span>
          <span class="cloud-project-date">${movieCount} movie(s) · Updated ${dateStr}</span>
        </div>
        <div class="cloud-project-actions">
          <button class="btn btn-secondary btn-sm btn-load-cloud" data-id="${proj.id}">Load</button>
          <button class="btn btn-danger btn-sm btn-delete-cloud" data-id="${proj.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Attach item action handlers
  container.querySelectorAll('.btn-load-cloud').forEach(btn => {
    btn.addEventListener('click', () => loadCloudProject(btn.dataset.id));
  });
  container.querySelectorAll('.btn-delete-cloud').forEach(btn => {
    btn.addEventListener('click', () => deleteCloudProject(btn.dataset.id));
  });
}

// Save Workspace to Firestore Cloud Project
async function saveCurrentProjectToCloud() {
  if (!db || !currentUser) {
    showNotice('Please sign in with Google to save projects to Cloud.', 'error');
    return;
  }

  const nameInput = document.getElementById('inputProjectName');
  const projName = (nameInput?.value || '').trim() || `Workspace ${new Date().toLocaleDateString()}`;

  const projId = 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const path = `projects/${projId}`;

  const payload = {
    projectId: projId,
    ownerId: currentUser.uid,
    name: projName,
    artwork: state.artwork,
    trailers: state.trailers,
    newsletter: state.newsletter,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    await setDoc(doc(db, 'projects', projId), payload);
    showNotice(`Saved project "${projName}" to Cloud!`);
    if (nameInput) nameInput.value = '';
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

function loadCloudProject(projId) {
  const proj = cloudProjects.find(p => p.id === projId);
  if (!proj) return;

  const totalCurrent = (state.artwork?.movies?.length || 0) + (state.trailers?.movies?.length || 0) + (state.newsletter?.movies?.length || 0);
  if (totalCurrent > 0) {
    if (!confirm(`Replace current workspace with cloud project "${proj.name}"?`)) return;
  }

  if (proj.artwork && Array.isArray(proj.artwork.movies)) {
    state.artwork = proj.artwork;
  }
  if (proj.trailers && Array.isArray(proj.trailers.movies)) {
    state.trailers = proj.trailers;
  }
  if (proj.newsletter) {
    state.newsletter = { ...state.newsletter, ...proj.newsletter };
  }
  // Backwards compatibility with v1
  if (Array.isArray(proj.movies)) {
    state.artwork.movies = proj.movies;
    state.artwork.selectedUid = proj.movies[0]?.uid || null;
  }

  if (!Array.isArray(state.artwork?.movies)) state.artwork = { movies: [], selectedUid: null };
  if (!Array.isArray(state.trailers?.movies)) state.trailers = { movies: [], selectedUid: null };
  if (!Array.isArray(state.newsletter?.movies)) state.newsletter.movies = [];

  saveLocalState();
  updateAllUI();
  document.getElementById('cloudModal')?.close();
  showNotice(`Loaded cloud project "${proj.name}".`);
}

async function deleteCloudProject(projId) {
  if (!db || !currentUser) return;
  const proj = cloudProjects.find(p => p.id === projId);
  if (!proj) return;

  if (!confirm(`Delete cloud project "${proj.name}"? This cannot be undone.`)) return;

  const path = `projects/${projId}`;
  try {
    await deleteDoc(doc(db, 'projects', projId));
    showNotice(`Deleted cloud project "${proj.name}".`);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
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
    artwork: { path: 'MOVIE STUDIO / ARTWORK', h1: 'Posters & Artwork Studio', dot: '.', sub: 'Import titles or upload PDF reports to find and select posters, backdrops, and logos.' },
    trailers: { path: 'MOVIE STUDIO / TRAILERS', h1: 'Trailers & Teasers Studio', dot: '.', sub: 'Import titles or upload PDF reports to discover official trailers and video clips.' },
    newsletter: { path: 'MOVIE STUDIO / NEWSLETTER', h1: 'Newsletter Generator', dot: '.', sub: 'Import titles or upload PDF reports to generate custom HTML email newsletters.' }
  };

  const t = titles[tab] || titles.artwork;
  if (bcPath) bcPath.textContent = t.path;
  if (pageTitle) pageTitle.innerHTML = `${t.h1}<span class="period-dot">${t.dot}</span>`;
  if (pageSub) pageSub.textContent = t.sub;

  updateAllUI();
}

// Notice Bar Update
function showNotice(msg, type = 'info') {
  const bar = document.getElementById('noticeBar');
  if (bar) {
    bar.textContent = msg;
    bar.className = `notice-bar ${type}`;
  }
}

// Global Event Handlers Setup
function setupEventHandlers() {
  // Focus active tool's input textarea
  const btnAddFocus = document.getElementById('btnAddMovieFocus');
  if (btnAddFocus) {
    btnAddFocus.addEventListener('click', () => {
      let inputId = 'artworkInputText';
      if (state.activeTab === 'trailers') inputId = 'trailersInputText';
      if (state.activeTab === 'newsletter') inputId = 'newsletterInputText';
      const el = document.getElementById(inputId);
      if (el) el.focus();
    });
  }

  // Bind title addition per tool (strict per-panel isolation)
  const bindAddTitles = (btnId, inputId, toolName, toolKey) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (btn && input) {
      btn.addEventListener('click', () => {
        const text = input.value;
        const parsed = parseMovieListText(text);
        if (parsed.length > 0) {
          addMoviesToTool(parsed, toolKey);
          input.value = '';
          showNotice(`Added ${parsed.length} title(s) to ${toolName} only.`);
          if (toolKey === 'newsletter') {
            const bulletinMeta = extractBulletinMetadata(text);
            if (bulletinMeta) {
              if (bulletinMeta.scheduleDate) {
                state.newsletter.scheduleDate = bulletinMeta.scheduleDate;
                const schedEl = document.getElementById('nlScheduleDate');
                if (schedEl) schedEl.value = bulletinMeta.scheduleDate;
                state.newsletter.title = `Theatrical Release Bulletin: ${bulletinMeta.scheduleDate}`;
                const titleEl = document.getElementById('nlTitle');
                if (titleEl) titleEl.value = state.newsletter.title;
              }
              if (bulletinMeta.helpDeskPhone) {
                state.newsletter.helpDeskPhone = bulletinMeta.helpDeskPhone;
                const phoneEl = document.getElementById('nlHelpDeskPhone');
                if (phoneEl) phoneEl.value = bulletinMeta.helpDeskPhone;
              }
              if (bulletinMeta.helpDeskEmail) {
                state.newsletter.helpDeskEmail = bulletinMeta.helpDeskEmail;
                const emailEl = document.getElementById('nlHelpDeskEmail');
                if (emailEl) emailEl.value = bulletinMeta.helpDeskEmail;
              }
            }
            renderNewsletterMovieList();
            renderNewsletterPreview();
            if (state.status.tmdb) {
              const unsearched = state.newsletter.movies.filter(m => !m.selectedPoster && !m.posterUrl);
              if (unsearched.length > 0) {
                (async () => {
                  for (const m of unsearched) {
                    await fetchMovieMetadata(m);
                    renderNewsletterPreview();
                    renderNewsletterMovieList();
                  }
                })();
              }
            }
          }
        } else {
          showNotice('Please enter movie titles or paste a list.', 'error');
        }
      });
    }
  };

  bindAddTitles('btnAddTitlesArtwork', 'artworkInputText', 'Artwork Studio', 'artwork');
  bindAddTitles('btnAddTitlesTrailers', 'trailersInputText', 'Trailer Studio', 'trailers');
  bindAddTitles('btnAddTitlesNewsletter', 'newsletterInputText', 'Newsletter Generator', 'newsletter');

  // Bind file import per tool (strict per-panel isolation)
  const bindFileImport = (btnId, fileInputId, toolKey) => {
    const btn = document.getElementById(btnId);
    const fileInput = document.getElementById(fileInputId);
    if (btn && fileInput) {
      btn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => handleFileImport(e, toolKey));
    }
  };

  bindFileImport('btnImportFileArtwork', 'fileImportInputArtwork', 'artwork');
  bindFileImport('btnImportFileTrailers', 'fileImportInputTrailers', 'trailers');
  bindFileImport('btnImportFileNewsletter', 'fileImportInputNewsletter', 'newsletter');
  bindFileImport('btnNlImportFile', 'fileNlImportInput', 'newsletter');

  // Batch search buttons
  const btnFindArt = document.getElementById('btnFindArtworkAll');
  if (btnFindArt) btnFindArt.addEventListener('click', () => runBatchSearch('artwork'));
  const btnFindTrailers = document.getElementById('btnFindTrailersAll');
  if (btnFindTrailers) btnFindTrailers.addEventListener('click', () => runBatchSearch('trailers'));

  // Stop batch
  const btnStopBatch = document.getElementById('btnStopBatch');
  if (btnStopBatch) {
    btnStopBatch.addEventListener('click', () => {
      state.stopBatchRequested = true;
      showNotice('Stopping batch search after current item...');
    });
  }

  // Tool-specific Filter inputs
  const filterArt = document.getElementById('movieFilterInputArtwork');
  if (filterArt) {
    filterArt.addEventListener('input', (e) => {
      state.artwork.filter = e.target.value.toLowerCase();
      renderCollectionList();
    });
  }

  const filterTrl = document.getElementById('movieFilterInputTrailers');
  if (filterTrl) {
    filterTrl.addEventListener('input', (e) => {
      state.trailers.filter = e.target.value.toLowerCase();
      renderCollectionList();
    });
  }

  // Export CSV per tool
  const btnCsvArt = document.getElementById('btnExportCSVArtwork');
  if (btnCsvArt) btnCsvArt.addEventListener('click', () => exportCSVReport('artwork'));
  const btnCsvTrl = document.getElementById('btnExportCSVTrailers');
  if (btnCsvTrl) btnCsvTrl.addEventListener('click', () => exportCSVReport('trailers'));

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

  // Cloud Projects Modal & Auth setup
  const cloudModal = document.getElementById('cloudModal');
  const btnCloud = document.getElementById('btnCloudProjects');
  if (btnCloud && cloudModal) {
    btnCloud.addEventListener('click', () => cloudModal.showModal());
  }
  const btnCloseCloud1 = document.getElementById('btnCloseCloudModal');
  const btnCloseCloud2 = document.getElementById('btnCloseCloudModalFooter');
  if (btnCloseCloud1 && cloudModal) btnCloseCloud1.addEventListener('click', () => cloudModal.close());
  if (btnCloseCloud2 && cloudModal) btnCloseCloud2.addEventListener('click', () => cloudModal.close());

  const btnSignIn = document.getElementById('btnSignInGoogle');
  if (btnSignIn) btnSignIn.addEventListener('click', signInWithGoogle);

  const btnGateSignIn = document.getElementById('btnGateSignIn');
  if (btnGateSignIn) btnGateSignIn.addEventListener('click', signInWithGoogle);

  const btnSignOut = document.getElementById('btnSignOut');
  if (btnSignOut) btnSignOut.addEventListener('click', signOutUser);

  const btnSaveCloud = document.getElementById('btnSaveToCloud');
  if (btnSaveCloud) btnSaveCloud.addEventListener('click', saveCurrentProjectToCloud);

  // Confirm modal setup
  document.getElementById('btnCloseConfirmModal').addEventListener('click', closeConfirmModal);
  document.getElementById('btnCancelConfirmModal').addEventListener('click', closeConfirmModal);

  // Project Save / Load
  const btnSaveProject = document.getElementById('btnSaveProject');
  if (btnSaveProject) btnSaveProject.addEventListener('click', saveProjectJSON);
  const fileProjectInput = document.getElementById('fileProjectInput');
  const btnOpenProject = document.getElementById('btnOpenProject');
  if (btnOpenProject && fileProjectInput) btnOpenProject.addEventListener('click', () => fileProjectInput.click());
  if (fileProjectInput) fileProjectInput.addEventListener('change', loadProjectJSON);

  // Newsletter Controls Live Sync
  setupNewsletterSync();
}

// Add Movies strictly to the target tool's isolated state
function addMoviesToTool(parsedList, tool = state.activeTab) {
  if (!tool) tool = 'artwork';
  if (!state[tool]) {
    state[tool] = { movies: [], selectedUid: null, filter: '' };
  }
  const toolState = state[tool];
  if (!Array.isArray(toolState.movies)) {
    toolState.movies = [];
  }
  if (!Array.isArray(parsedList)) return;

  const newItems = parsedList.map(item => {
    if (!item || typeof item !== 'object') return null;
    // Cross-reference existing poster/trailer from other tabs if not present
    let crossPoster = item.poster_url || item.poster_remote || item.posterUrl || item.selectedPoster || '';
    let crossTrailer = item.trailer_url || item.trailerUrl || item.selectedTrailer || '';

    if (!crossPoster || !crossTrailer) {
      const crossPool = [...(state.artwork?.movies || []), ...(state.trailers?.movies || []), ...(state.newsletter?.movies || [])];
      const match = crossPool.find(m => m && m.title && item.title && m.title.toLowerCase().trim() === item.title.toLowerCase().trim());
      if (match) {
        if (!crossPoster) {
          crossPoster = match.selectedPoster || match.posterUrl || match.poster_url || match.images?.poster?.[0]?.url || '';
        }
        if (!crossTrailer) {
          crossTrailer = match.selectedTrailer || match.trailerUrl || match.trailer_url || (match.videos && match.videos[0]?.url) || '';
        }
      }
    }

    const featureDur = item.feature_duration || item.featureDuration || '';
    const p1Dur = item.cpl_part1_duration || item.cplPart1Duration || '';
    const p2Dur = item.cpl_part2_duration || item.cplPart2Duration || '';
    const ffec = item.first_frame_end_credits || item.firstFrameEndCredits || '';
    const ffmc = item.first_frame_moving_credits || item.firstFrameMovingCredits || '';

    return {
      ...item,
      uid: item.uid || ('m_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
      id: item.id || item.imdbId || null,
      imdb_id: item.imdb_id || item.imdbId || null,
      title: item.title,
      year: item.year || '',
      language: item.language || '',
      distributor: item.distributor || '',
      poster_url: crossPoster || '',
      poster_remote: item.poster_remote || crossPoster || '',
      posterUrl: crossPoster || '',
      selectedPoster: crossPoster || null,
      selectedBackdrop: item.selectedBackdrop || null,
      selectedLogo: item.selectedLogo || null,
      trailer_url: crossTrailer || '',
      trailerUrl: crossTrailer || '',
      selectedTrailer: crossTrailer || null,
      keepPoster: item.keepPoster || false,
      keepTrailer: item.keepTrailer || false,
      overview: item.overview || '',
      feature_duration: featureDur,
      featureDuration: featureDur,
      cpl_part1_duration: p1Dur,
      cplPart1Duration: p1Dur,
      cpl_part2_duration: p2Dur,
      cplPart2Duration: p2Dur,
      first_frame_end_credits: ffec,
      firstFrameEndCredits: ffec,
      first_frame_moving_credits: ffmc,
      firstFrameMovingCredits: ffmc,
      cpls: item.cpls || [],
      cplEntries: item.cplEntries || (Array.isArray(item.cpls) ? item.cpls.map(c => typeof c === 'string' ? c : (c.name ? `${c.name}${c.part ? ' - ' + c.part : ''}` : '')).filter(Boolean).join('\n') : ''),
      raw_block: item.raw_block || [],
      poster_mode: item.poster_mode || (crossPoster ? 'manual' : 'auto'),
      trailer_mode: item.trailer_mode || (crossTrailer ? 'manual' : 'auto'),
      images: item.images || { poster: [], backdrop: [], logo: [] },
      videos: item.videos || [],
      tmdbCandidates: item.tmdbCandidates || [],
      status: item.status || 'pending',
      statusText: item.statusText || 'Pending',
      checked: item.checked !== false,
      include: item.include !== false
    };
  }).filter(Boolean);

  toolState.movies.push(...newItems);
  if (!toolState.selectedUid && toolState.movies.length > 0) {
    toolState.selectedUid = toolState.movies[0].uid;
  }

  updateAllUI();
  saveLocalState();
}

// Backward-compatibility alias
function addMoviesFromParsedList(parsedList) {
  addMoviesToTool(parsedList, state.activeTab);
}

// Update All Workspace Views & Counters
function updateAllUI() {
  if (!state.artwork) state.artwork = { movies: [] };
  if (!Array.isArray(state.artwork.movies)) state.artwork.movies = [];
  if (!state.trailers) state.trailers = { movies: [] };
  if (!Array.isArray(state.trailers.movies)) state.trailers.movies = [];
  if (!state.newsletter) state.newsletter = { movies: [] };
  if (!Array.isArray(state.newsletter.movies)) state.newsletter.movies = [];

  const artworkTotal = state.artwork.movies.length;
  const artworkPosters = state.artwork.movies.filter(m => m && (m.selectedPoster || m.posterUrl)).length;
  const trailersTotal = state.trailers.movies.length;
  const trailersReady = state.trailers.movies.filter(m => m && (m.selectedTrailer || m.trailerUrl || (m.videos && m.videos.length > 0))).length;
  const newsletterTotal = state.newsletter.movies.length;
  const newsletterIncluded = state.newsletter.movies.filter(m => m && m.checked !== false).length;

  // Badges
  const bMovie = document.getElementById('badgeMovieCount');
  if (bMovie) bMovie.textContent = state[state.activeTab]?.movies?.length || 0;
  const bArtwork = document.getElementById('badgeArtworkCount');
  if (bArtwork) bArtwork.textContent = artworkTotal;
  const bTrailers = document.getElementById('badgeTrailerCount');
  if (bTrailers) bTrailers.textContent = trailersTotal;
  const bNewsletter = document.getElementById('badgeNewsletterCount');
  if (bNewsletter) bNewsletter.textContent = newsletterTotal;

  // Metrics Strip
  const mMovies = document.getElementById('metricMovies');
  if (mMovies) {
    if (state.activeTab === 'artwork') mMovies.textContent = artworkTotal;
    else if (state.activeTab === 'trailers') mMovies.textContent = trailersTotal;
    else mMovies.textContent = newsletterTotal;
  }
  const mArtwork = document.getElementById('metricArtwork');
  if (mArtwork) mArtwork.textContent = artworkPosters;
  const mTrailers = document.getElementById('metricTrailers');
  if (mTrailers) mTrailers.textContent = trailersReady;
  const mNL = document.getElementById('metricNewsletter');
  if (mNL) mNL.textContent = newsletterIncluded;

  renderCollectionList();
  renderSelectedMovieDetail();
  renderNewsletterMovieList();
  renderNewsletterPreview();
  saveLocalState();
}

// Render Collection List in Current Active View with strict panel isolation
function renderCollectionList() {
  const panels = [
    {
      tool: 'artwork',
      listId: 'libraryListArtwork',
      countId: 'filterCountArtwork',
      inputId: 'movieFilterInputArtwork'
    },
    {
      tool: 'trailers',
      listId: 'libraryListTrailers',
      countId: 'filterCountTrailers',
      inputId: 'movieFilterInputTrailers'
    }
  ];

  panels.forEach(({ tool, listId, countId, inputId }) => {
    const toolState = state[tool];
    if (!toolState) return;

    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const inputEl = document.getElementById(inputId);

    const filtered = toolState.movies.filter(m => {
      if (!toolState.filter) return true;
      return m.title.toLowerCase().includes(toolState.filter) ||
             (m.year && m.year.includes(toolState.filter)) ||
             (m.language && m.language.toLowerCase().includes(toolState.filter));
    });

    if (inputEl && inputEl.value.toLowerCase() !== toolState.filter) {
      inputEl.value = toolState.filter;
    }

    if (countEl) countEl.textContent = `${filtered.length} movies`;
    if (!listEl) return;

    if (toolState.movies.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">＋</div>
          <div class="empty-title">Your ${tool === 'artwork' ? 'Artwork' : 'Trailer'} collection starts here</div>
          <div class="empty-desc">Paste a list above or upload a report for this tool.</div>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No matching movies</div>
          <div class="empty-desc">Try clearing your filter search.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    filtered.forEach(m => {
      const row = document.createElement('div');
      row.className = `movie-row ${m.uid === toolState.selectedUid ? 'active' : ''}`;
      row.tabIndex = 0;
      row.role = 'button';
      row.setAttribute('aria-label', `Select ${m.title}`);

      const posterUrl = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
      const initialLetter = m.title ? m.title.charAt(0).toUpperCase() : 'M';
      const statusClass = m.status === 'found' ? 'found' : m.status === 'loading' ? 'loading' : m.status === 'error' ? 'error' : '';

      row.innerHTML = `
        <input type="checkbox" class="movie-checkbox" ${m.checked !== false ? 'checked' : ''} aria-label="Include ${m.title}" />
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
        toolState.selectedUid = m.uid;
        updateAllUI();
      });

      // Keyboard navigation
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toolState.selectedUid = m.uid;
          updateAllUI();
        }
      });

      listEl.appendChild(row);
    });
  });
}

// Render Selected Movie Detail Panel strictly per tool
function renderSelectedMovieDetail() {
  const cards = [
    {
      tool: 'artwork',
      card: document.getElementById('movieDetailCardArtwork')
    },
    {
      tool: 'trailers',
      card: document.getElementById('movieDetailCardTrailers')
    }
  ];

  cards.forEach(({ tool, card }) => {
    if (!card) return;
    const toolState = state[tool];
    if (!toolState) return;

    const m = toolState.movies.find(item => item.uid === toolState.selectedUid);

    if (!m) {
      card.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✦</div>
          <div class="empty-title">A place for your next release</div>
          <div class="empty-desc">${toolState.movies.length > 0 ? `Select a movie from the ${toolDisplayName(tool)} list.` : `Add or upload movies to ${toolDisplayName(tool)} above.`}</div>
        </div>
      `;
      return;
    }

    card.innerHTML = buildDetailCardHTML(m, tool);
    bindDetailCardEvents(card, m, tool);
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
function bindDetailCardEvents(card, m, tool = 'artwork') {
  // Reorder / remove
  const btnUp = card.querySelector('#btnMoveUp');
  const btnDown = card.querySelector('#btnMoveDown');
  const btnRemove = card.querySelector('#btnRemoveMovie');

  if (btnUp) btnUp.addEventListener('click', () => moveMovieOrder(m.uid, -1, tool));
  if (btnDown) btnDown.addEventListener('click', () => moveMovieOrder(m.uid, 1, tool));
  if (btnRemove) btnRemove.addEventListener('click', () => promptRemoveMovie(m, tool));

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

      showNotice(`Movie details updated in ${toolDisplayName(tool)}.`);
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
      const pUrl = m.images.poster?.[0]?.url || null;
      m.selectedPoster = pUrl;
      m.selectedBackdrop = m.images.backdrop?.[0]?.url || null;
      m.selectedLogo = m.images.logo?.[0]?.url || null;
      if (pUrl) {
        m.poster_url = pUrl;
        m.posterUrl = pUrl;
        m.poster_remote = pUrl;
      }
    }

    if (!m.keepTrailer) {
      const tUrl = m.videos?.[0]?.url || null;
      m.selectedTrailer = tUrl;
      if (tUrl) {
        m.trailerUrl = tUrl;
        m.trailer_url = tUrl;
      }
    }

    m.status = 'found';
    m.statusText = 'Matched · review choices';
  } catch {
    m.status = 'error';
    m.statusText = 'Details failed';
  }

  updateAllUI();
}

// Run Sequential Batch Search strictly within the targeted tool
async function runBatchSearch(tool = state.activeTab) {
  const toolState = state[tool];
  if (!toolState) return;

  const checkedMovies = toolState.movies.filter(m => m.checked !== false);
  if (checkedMovies.length === 0) {
    showNotice(`No movies selected for batch search in ${toolDisplayName(tool)}.`, 'error');
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
    showNotice(`Searching ${i + 1} of ${checkedMovies.length} in ${toolDisplayName(tool)}: ${m.title}`);
    
    const success = await fetchMovieMetadata(m);
    if (success) processed++; else failed++;
  }

  state.batchRunning = false;
  if (btnStop) btnStop.classList.add('hidden');
  showNotice(`Search finished for ${toolDisplayName(tool)}: ${processed} processed, ${failed} failed.`);
}

// Reorder Movie in specific tool
function moveMovieOrder(uid, delta, tool = state.activeTab) {
  const toolState = state[tool];
  if (!toolState) return;

  const idx = toolState.movies.findIndex(m => m.uid === uid);
  if (idx < 0) return;

  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= toolState.movies.length) return;

  const temp = toolState.movies[idx];
  toolState.movies[idx] = toolState.movies[targetIdx];
  toolState.movies[targetIdx] = temp;

  updateAllUI();
}

// Prompt Remove Movie Modal for specific tool
function promptRemoveMovie(m, tool = state.activeTab) {
  const modal = document.getElementById('confirmModal');
  const msg = document.getElementById('confirmModalMessage');
  msg.textContent = `Are you sure you want to remove "${m.title}" from ${toolDisplayName(tool)}?`;

  const btnAccept = document.getElementById('btnAcceptConfirmModal');
  const onAccept = () => {
    const toolState = state[tool];
    if (toolState) {
      toolState.movies = toolState.movies.filter(item => item.uid !== m.uid);
      if (toolState.selectedUid === m.uid) {
        toolState.selectedUid = toolState.movies[0]?.uid || null;
      }
    }
    closeConfirmModal();
    btnAccept.removeEventListener('click', onAccept);
    showNotice(`Removed "${m.title}" from ${toolDisplayName(tool)}.`);
    updateAllUI();
  };

  btnAccept.addEventListener('click', onAccept);
  modal.showModal();
}

function closeConfirmModal() {
  const modal = document.getElementById('confirmModal');
  modal.close();
}

// File Import Handler strictly targeted per tool
async function handleFileImport(e, toolTarget) {
  const file = e.target.files[0];
  if (!file) return;

  const targetTool = toolTarget || state.activeTab || 'artwork';

  if (file.size > 10 * 1024 * 1024) {
    showNotice('File exceeds 10 MB limit.', 'error');
    return;
  }

  showNotice(`Reading file "${file.name}" for ${toolDisplayName(targetTool)}...`);

  try {
    let text = '';
    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      if (targetTool === 'newsletter' && state.newsletter?.movies && state.newsletter.movies.length > 0) {
        const replace = window.confirm('Replace current newsletter movies with those from the PDF?');
        if (!replace) {
          e.target.value = '';
          return;
        }
      }

      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: buffer
      });
      const contentType = res.headers.get('content-type') || '';
      let data = {};
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const rawErr = await res.text();
        throw new Error(`Server returned ${res.status}: ${rawErr.replace(/<[^>]*>?/gm, '').trim().slice(0, 80)}`);
      }
      if (!res.ok) {
        if (data.error && data.error.includes('OCR')) {
          throw new Error('This PDF has no selectable text (scan). It needs OCR first.');
        }
        throw new Error(data.error || 'Failed to extract text from PDF.');
      }
      text = data.text || '';
    } else {
      text = await file.text();
    }

    let parsed = [];
    try {
      parsed = parseMovieListText(text) || [];
    } catch (parseErr) {
      console.warn('PDF or text parsing error:', parseErr);
      showNotice('Error parsing movie list from file.', 'error');
      return;
    }

    // Defensive check to handle cases where targetTool state or movies array is missing/undefined
    if (!state[targetTool] || !Array.isArray(state[targetTool]?.movies)) {
      if (!state[targetTool]) state[targetTool] = {};
      state[targetTool].movies = [];
    }

    if (parsed && Array.isArray(parsed) && parsed.length > 0) {
      if (targetTool === 'newsletter' && isPdf) {
        if (!state.newsletter) state.newsletter = {};
        state.newsletter.movies = [];
      }
      addMoviesToTool(parsed, targetTool);
      setActiveTab(targetTool);
      showNotice(`Imported ${parsed.length} title(s) from "${file.name}" into ${toolDisplayName(targetTool)}.`);

      if (targetTool === 'newsletter') {
        const bulletinMeta = extractBulletinMetadata(text);
        if (bulletinMeta) {
          if (bulletinMeta.scheduleDate) {
            state.newsletter.scheduleDate = bulletinMeta.scheduleDate;
            const schedEl = document.getElementById('nlScheduleDate');
            if (schedEl) schedEl.value = bulletinMeta.scheduleDate;
            state.newsletter.title = `Theatrical Release Bulletin: ${bulletinMeta.scheduleDate}`;
            const titleEl = document.getElementById('nlTitle');
            if (titleEl) titleEl.value = state.newsletter.title;
          }
          if (bulletinMeta.helpDeskPhone) {
            state.newsletter.helpDeskPhone = bulletinMeta.helpDeskPhone;
            const phoneEl = document.getElementById('nlHelpDeskPhone');
            if (phoneEl) phoneEl.value = bulletinMeta.helpDeskPhone;
          }
          if (bulletinMeta.helpDeskEmail) {
            state.newsletter.helpDeskEmail = bulletinMeta.helpDeskEmail;
            const emailEl = document.getElementById('nlHelpDeskEmail');
            if (emailEl) emailEl.value = bulletinMeta.helpDeskEmail;
          }
        }

        renderNewsletterMovieList();
        renderNewsletterPreview();

        // Run auto-fetch with progress indicator
        const targetMovies = Array.isArray(state.newsletter?.movies) ? state.newsletter.movies : [];
        if (targetMovies.length > 0) {
          (async () => {
            for (let i = 0; i < targetMovies.length; i++) {
              const m = targetMovies[i];
              showNotice(`Auto-fetching poster & trailer (${i + 1}/${targetMovies.length}): ${m.title}...`);
              try {
                const res = await fetch(`/api/fetch-movie-assets?title=${encodeURIComponent(m.title)}&year=${encodeURIComponent(m.year || '')}&language=${encodeURIComponent(m.language || '')}`);
                if (res.ok) {
                  const assetData = await res.json();
                  if (assetData.poster_remote) {
                    m.poster_remote = assetData.poster_remote;
                    m.poster_url = assetData.poster_remote;
                    m.selectedPoster = assetData.poster_remote;
                  }
                  if (assetData.tmdb_id) m.tmdb_id = assetData.tmdb_id;
                  if (assetData.trailer_url) {
                    m.trailer_url = assetData.trailer_url;
                    m.selectedTrailer = assetData.trailer_url;
                  }
                  if (!m.selectedPoster && !m.poster_url && m.trailer_url) {
                    const ytMatch = m.trailer_url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
                    if (ytMatch && ytMatch[1]) {
                      const ytThumb = `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
                      m.poster_remote = ytThumb;
                      m.poster_url = ytThumb;
                      m.selectedPoster = ytThumb;
                    }
                  }
                }
              } catch {
                // Fallback to fetchMovieMetadata
                if (state.status.tmdb) {
                  await fetchMovieMetadata(m);
                }
              }
              renderNewsletterPreview();
              renderNewsletterMovieList();
            }
            showNotice(`Auto-fetch complete for ${targetMovies.length} newsletter movie(s).`);
          })();
        }
      }
    } else {
      if (isPdf) {
        showNotice('No movie data found in the PDF.', 'error');
      } else {
        showNotice('No valid titles found in imported file.', 'error');
      }
    }
  } catch (err) {
    showNotice(`Import Error: ${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
}

// Newsletter Sync Setup
function setupNewsletterSync() {
  const titleInit = document.getElementById('nlTitle');
  if (titleInit && state.newsletter.title) {
    titleInit.value = state.newsletter.title;
  }
  const schedInit = document.getElementById('nlScheduleDate');
  if (schedInit && state.newsletter.scheduleDate) {
    schedInit.value = state.newsletter.scheduleDate;
  }
  const phoneInit = document.getElementById('nlHelpDeskPhone');
  if (phoneInit && state.newsletter.helpDeskPhone) {
    phoneInit.value = state.newsletter.helpDeskPhone;
  }
  const emailInit = document.getElementById('nlHelpDeskEmail');
  if (emailInit && state.newsletter.helpDeskEmail) {
    emailInit.value = state.newsletter.helpDeskEmail;
  }
  const layoutSelectInit = document.getElementById('nlLayoutTemplate');
  if (layoutSelectInit && state.newsletter.layoutTemplate) {
    layoutSelectInit.value = state.newsletter.layoutTemplate;
  }
  const fontSelectInit = document.getElementById('nlFontFamily');
  if (fontSelectInit && state.newsletter.fontFamily) {
    fontSelectInit.value = state.newsletter.fontFamily;
  }
  const accentColorInit = document.getElementById('nlAccentColor');
  const accentHexInit = document.getElementById('nlAccentColorHex');
  if (accentColorInit && state.newsletter.accentColor) {
    accentColorInit.value = state.newsletter.accentColor;
  }
  if (accentHexInit && state.newsletter.accentColor) {
    accentHexInit.value = state.newsletter.accentColor;
  }
  const introInit = document.getElementById('nlIntro');
  if (introInit && state.newsletter.intro) {
    introInit.value = state.newsletter.intro;
  }
  const topBUrlInit = document.getElementById('nlTopBannerUrl');
  if (topBUrlInit && state.newsletter.topBannerUrl) {
    topBUrlInit.value = state.newsletter.topBannerUrl;
  }
  const topBLinkInit = document.getElementById('nlTopBannerLink');
  if (topBLinkInit && state.newsletter.topBannerLink) {
    topBLinkInit.value = state.newsletter.topBannerLink;
  }
  const secBUrlInit = document.getElementById('nlSecondBannerUrl');
  if (secBUrlInit && state.newsletter.secondBannerUrl) {
    secBUrlInit.value = state.newsletter.secondBannerUrl;
  }
  const secBLinkInit = document.getElementById('nlSecondBannerLink');
  if (secBLinkInit && state.newsletter.secondBannerLink) {
    secBLinkInit.value = state.newsletter.secondBannerLink;
  }
  const footerInit = document.getElementById('nlFooterText');
  if (footerInit && state.newsletter.footer) {
    footerInit.value = state.newsletter.footer;
  }

  const fields = [
    'nlTitle', 'nlScheduleDate', 'nlLayoutTemplate', 'nlFontFamily',
    'nlHelpDeskPhone', 'nlHelpDeskEmail', 'nlIntro',
    'nlTopBannerUrl', 'nlTopBannerLink', 'nlSecondBannerUrl', 'nlSecondBannerLink', 'nlFooterText'
  ];

  fields.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, () => {
        state.newsletter.title = document.getElementById('nlTitle')?.value || '';
        state.newsletter.scheduleDate = document.getElementById('nlScheduleDate')?.value || '';
        state.newsletter.helpDeskPhone = document.getElementById('nlHelpDeskPhone')?.value || '';
        state.newsletter.helpDeskEmail = document.getElementById('nlHelpDeskEmail')?.value || '';
        const layoutSelect = document.getElementById('nlLayoutTemplate');
        if (layoutSelect) state.newsletter.layoutTemplate = layoutSelect.value;
        const fontSelect = document.getElementById('nlFontFamily');
        if (fontSelect) state.newsletter.fontFamily = fontSelect.value;
        state.newsletter.intro = document.getElementById('nlIntro')?.value || '';
        state.newsletter.topBannerUrl = document.getElementById('nlTopBannerUrl')?.value || '';
        state.newsletter.topBannerLink = document.getElementById('nlTopBannerLink')?.value || '';
        state.newsletter.secondBannerUrl = document.getElementById('nlSecondBannerUrl')?.value || '';
        state.newsletter.secondBannerLink = document.getElementById('nlSecondBannerLink')?.value || '';
        state.newsletter.footer = document.getElementById('nlFooterText')?.value || '';

        renderNewsletterPreview();
        saveLocalState();
      });
    }
  });

  if (accentColorInit && accentHexInit) {
    accentColorInit.addEventListener('input', () => {
      accentHexInit.value = accentColorInit.value;
      state.newsletter.accentColor = accentColorInit.value;
      renderNewsletterPreview();
      saveLocalState();
    });
    accentHexInit.addEventListener('input', () => {
      const val = accentHexInit.value.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
        accentColorInit.value = val;
      }
      state.newsletter.accentColor = val;
      renderNewsletterPreview();
      saveLocalState();
    });
  }

  // Header Rich Text Editor & Toolbar setup
  const headerEditor = document.getElementById('nlHeaderEditor');
  if (headerEditor) {
    if (state.newsletter.header_html) {
      headerEditor.innerHTML = state.newsletter.header_html;
    }
    headerEditor.addEventListener('input', () => {
      state.newsletter.header_html = headerEditor.innerHTML;
      renderNewsletterPreview();
      saveLocalState();
    });
  }

  const bindRtf = (id, command, val = null) => {
    const btn = document.getElementById(id);
    if (btn && headerEditor) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        headerEditor.focus();
        if (command === 'createLink') {
          const url = prompt('Enter link URL (e.g. https://... or mailto:...):');
          if (url) document.execCommand('createLink', false, url);
        } else if (command === 'reset') {
          headerEditor.innerHTML = `<p style="margin:0 0 6px 0;">Keep tabs on the feature releases coming your way and plan your screening schedules seamlessly with our weekly feature report.</p><p style="margin:0 0 6px 0;">Need further information? Call the Qube Wire support team at: (424) 343-2691 or</p><p style="margin:0;">write to: support@qubewire.com</p>`;
        } else {
          document.execCommand(command, false, val);
        }
        state.newsletter.header_html = headerEditor.innerHTML;
        renderNewsletterPreview();
        saveLocalState();
      });
    }
  };

  bindRtf('btnRtfBold', 'bold');
  bindRtf('btnRtfItalic', 'italic');
  bindRtf('btnRtfH1', 'formatBlock', '<h1>');
  bindRtf('btnRtfH2', 'formatBlock', '<h2>');
  bindRtf('btnRtfLink', 'createLink');
  bindRtf('btnRtfReset', 'reset');

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

  // Newsletter Reorder & Remove buttons
  const btnNlUp = document.getElementById('btnNlMoveUp');
  if (btnNlUp) {
    btnNlUp.addEventListener('click', () => {
      if (state.newsletter.selectedUid) {
        moveMovieOrder(state.newsletter.selectedUid, -1, 'newsletter');
      }
    });
  }

  const btnNlDown = document.getElementById('btnNlMoveDown');
  if (btnNlDown) {
    btnNlDown.addEventListener('click', () => {
      if (state.newsletter.selectedUid) {
        moveMovieOrder(state.newsletter.selectedUid, 1, 'newsletter');
      }
    });
  }

  const btnNlRemove = document.getElementById('btnNlRemoveMovie');
  if (btnNlRemove) {
    btnNlRemove.addEventListener('click', () => {
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (activeMovie) {
        promptRemoveMovie(activeMovie, 'newsletter');
      } else {
        showNotice('No movie selected to remove in Newsletter.', 'error');
      }
    });
  }

  // Live input sync for all Movie Details fields
  const syncActiveMovieFromInputs = () => {
    const newsletterData = state.newsletter;
    if (!newsletterData || !Array.isArray(newsletterData.movies)) return;
    const activeMovie = newsletterData.movies.find(item => item && item.uid === newsletterData.selectedUid);
    if (!activeMovie) return;
    const titleVal = document.getElementById('nlDetailTitle')?.value.trim();
    if (titleVal) activeMovie.title = titleVal;
    activeMovie.year = document.getElementById('nlDetailYear')?.value.trim() || '';
    activeMovie.language = document.getElementById('nlDetailLanguage')?.value.trim() || '';
    activeMovie.distributor = document.getElementById('nlDetailDistributor')?.value.trim() || '';
    activeMovie.feature_duration = document.getElementById('nlDetailFeatureDuration')?.value.trim() || '';
    activeMovie.featureDuration = activeMovie.feature_duration;
    activeMovie.cpl_part1_duration = document.getElementById('nlDetailPart1Duration')?.value.trim() || '';
    activeMovie.cplPart1Duration = activeMovie.cpl_part1_duration;
    activeMovie.cpl_part2_duration = document.getElementById('nlDetailPart2Duration')?.value.trim() || '';
    activeMovie.cplPart2Duration = activeMovie.cpl_part2_duration;
    activeMovie.first_frame_end_credits = document.getElementById('nlDetailEndCredits')?.value.trim() || '';
    activeMovie.firstFrameEndCredits = activeMovie.first_frame_end_credits;
    activeMovie.first_frame_moving_credits = document.getElementById('nlDetailMovingCredits')?.value.trim() || '';
    activeMovie.firstFrameMovingCredits = activeMovie.first_frame_moving_credits;
    activeMovie.cplEntries = document.getElementById('nlDetailCplEntries')?.value.trim() || '';

    const pMode = document.getElementById('nlDetailPosterMode')?.value || 'auto';
    activeMovie.poster_mode = pMode;
    activeMovie.posterMode = pMode;

    let posterVal = document.getElementById('nlDetailPosterUrl')?.value.trim() || '';

    const tMode = document.getElementById('nlDetailTrailerMode')?.value || 'auto';
    activeMovie.trailer_mode = tMode;
    activeMovie.trailerMode = tMode;

    let trailerVal = document.getElementById('nlDetailTrailerUrl')?.value.trim() || '';
    if (trailerVal && !trailerVal.startsWith('http') && !trailerVal.startsWith('mailto:') && trailerVal.includes('@')) {
      trailerVal = `mailto:${trailerVal}`;
    }
    activeMovie.trailer_url = trailerVal;
    activeMovie.trailerUrl = trailerVal;
    activeMovie.selectedTrailer = trailerVal;

    if (!posterVal && trailerVal) {
      const ytMatch = trailerVal.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (ytMatch && ytMatch[1]) {
        posterVal = `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
        const pInput = document.getElementById('nlDetailPosterUrl');
        if (pInput) pInput.value = posterVal;
      }
    }

    activeMovie.poster_url = posterVal;
    activeMovie.posterUrl = posterVal;
    activeMovie.selectedPoster = posterVal;
    activeMovie.poster_remote = posterVal;

    const incCheck = document.getElementById('nlDetailInclude');
    if (incCheck) {
      activeMovie.include = incCheck.checked;
      activeMovie.checked = incCheck.checked;
    }

    renderNewsletterPreview();
    saveLocalState();
  };

  [
    'nlDetailTitle', 'nlDetailYear', 'nlDetailLanguage', 'nlDetailDistributor',
    'nlDetailFeatureDuration', 'nlDetailPart1Duration', 'nlDetailPart2Duration',
    'nlDetailEndCredits', 'nlDetailMovingCredits', 'nlDetailCplEntries',
    'nlDetailPosterUrl', 'nlDetailTrailerUrl'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', syncActiveMovieFromInputs);
      el.addEventListener('change', syncActiveMovieFromInputs);
    }
  });

  // Mode Dropdown changes: auto vs manual
  const posterModeSelect = document.getElementById('nlDetailPosterMode');
  const btnFetchPoster = document.getElementById('btnNlFetchPoster');
  const posterInput = document.getElementById('nlDetailPosterUrl');
  if (posterModeSelect) {
    posterModeSelect.addEventListener('change', () => {
      const isManual = posterModeSelect.value === 'manual';
      if (btnFetchPoster) btnFetchPoster.disabled = isManual;
      if (isManual && posterInput) posterInput.focus();
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (activeMovie) {
        activeMovie.poster_mode = posterModeSelect.value;
        activeMovie.posterMode = posterModeSelect.value;
      }
      syncActiveMovieFromInputs();
    });
  }

  const trailerModeSelect = document.getElementById('nlDetailTrailerMode');
  const btnFetchTrailer = document.getElementById('btnNlFetchTrailer');
  const trailerInput = document.getElementById('nlDetailTrailerUrl');
  if (trailerModeSelect) {
    trailerModeSelect.addEventListener('change', () => {
      const isManual = trailerModeSelect.value === 'manual';
      if (btnFetchTrailer) btnFetchTrailer.disabled = isManual;
      if (isManual && trailerInput) trailerInput.focus();
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (activeMovie) {
        activeMovie.trailer_mode = trailerModeSelect.value;
        activeMovie.trailerMode = trailerModeSelect.value;
      }
      syncActiveMovieFromInputs();
    });
  }

  // Poster Image Upload
  setupImageUpload('btnNlUploadPoster', 'fileNlPosterInput', (dataUrl) => {
    const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
    if (!activeMovie) {
      showNotice('Please select a movie first to upload poster.', 'error');
      return;
    }
    activeMovie.poster_url = dataUrl;
    activeMovie.posterUrl = dataUrl;
    activeMovie.selectedPoster = dataUrl;
    activeMovie.poster_mode = 'manual';
    activeMovie.posterMode = 'manual';
    if (posterInput) posterInput.value = dataUrl;
    if (posterModeSelect) posterModeSelect.value = 'manual';
    if (btnFetchPoster) btnFetchPoster.disabled = true;
    renderNewsletterPreview();
    saveLocalState();
    showNotice(`Poster image set for "${activeMovie.title}".`);
  });

  // Include in Newsletter Checkbox
  const includeCheck = document.getElementById('nlDetailInclude');
  if (includeCheck) {
    includeCheck.addEventListener('change', () => {
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (activeMovie) {
        activeMovie.include = includeCheck.checked;
        activeMovie.checked = includeCheck.checked;
        renderNewsletterMovieList();
        renderNewsletterPreview();
        saveLocalState();
      }
    });
  }

  // Newsletter Action Buttons (Fetch, Apply Changes, Update Preview)
  if (btnFetchPoster) {
    btnFetchPoster.addEventListener('click', async () => {
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (!activeMovie) {
        showNotice('Please select a movie from the newsletter list first.', 'error');
        return;
      }
      if (activeMovie.poster_mode === 'manual') {
        showNotice('Poster mode is Manual. Switch to Auto to fetch from TMDB.', 'error');
        return;
      }
      showNotice(`Searching TMDB poster for "${activeMovie.title}"...`);
      try {
        const res = await fetch(`/api/fetch-movie-assets?title=${encodeURIComponent(activeMovie.title)}&year=${encodeURIComponent(activeMovie.year || '')}&language=${encodeURIComponent(activeMovie.language || '')}`);
        if (res.ok) {
          const data = await res.json();
          if (data.poster_remote) {
            activeMovie.poster_remote = data.poster_remote;
            activeMovie.poster_url = data.poster_remote;
            activeMovie.posterUrl = data.poster_remote;
            activeMovie.selectedPoster = data.poster_remote;
            if (data.tmdb_id) activeMovie.tmdb_id = data.tmdb_id;
            if (posterInput) posterInput.value = data.poster_remote;
            showNotice(`Poster found for "${activeMovie.title}".`);
            renderNewsletterPreview();
            saveLocalState();
            return;
          }
        }
      } catch {}

      // Cross-tab fallback
      const crossMatch = [...(state.artwork?.movies || []), ...(state.trailers?.movies || []), ...(state.newsletter?.movies || [])]
        .find(m => m && m.title && m.title.toLowerCase().trim() === activeMovie.title.toLowerCase().trim());
      const crossPoster = crossMatch?.selectedPoster || crossMatch?.posterUrl || crossMatch?.poster_url || crossMatch?.images?.poster?.[0]?.url;
      if (crossPoster) {
        activeMovie.poster_remote = crossPoster;
        activeMovie.poster_url = crossPoster;
        activeMovie.posterUrl = crossPoster;
        activeMovie.selectedPoster = crossPoster;
        if (posterInput) posterInput.value = crossPoster;
        showNotice(`Poster found for "${activeMovie.title}".`);
        renderNewsletterPreview();
        saveLocalState();
        return;
      }

      // Fallback
      if (state.status.tmdb) {
        await fetchMovieMetadata(activeMovie);
        const poster = activeMovie.selectedPoster || activeMovie.posterUrl || activeMovie.images?.poster?.[0]?.url;
        if (poster) {
          activeMovie.poster_remote = poster;
          activeMovie.poster_url = poster;
          activeMovie.posterUrl = poster;
          activeMovie.selectedPoster = poster;
          if (posterInput) posterInput.value = poster;
          showNotice(`Poster found for "${activeMovie.title}".`);
          renderNewsletterPreview();
          saveLocalState();
          return;
        }
      }
      showNotice(`No poster found for '${activeMovie.title}'. Paste a URL or click Upload.`, 'error');
    });
  }

  if (btnFetchTrailer) {
    btnFetchTrailer.addEventListener('click', async () => {
      const activeMovie = state.newsletter.movies.find(item => item.uid === state.newsletter.selectedUid);
      if (!activeMovie) {
        showNotice('Please select a movie from the newsletter list first.', 'error');
        return;
      }
      if (activeMovie.trailer_mode === 'manual') {
        showNotice('Trailer mode is Manual. Switch to Auto to fetch trailer.', 'error');
        return;
      }
      showNotice(`Searching trailer for "${activeMovie.title}"...`);
      try {
        const res = await fetch(`/api/fetch-movie-assets?title=${encodeURIComponent(activeMovie.title)}&year=${encodeURIComponent(activeMovie.year || '')}&language=${encodeURIComponent(activeMovie.language || '')}`);
        if (res.ok) {
          const data = await res.json();
          if (data.trailer_url) {
            activeMovie.trailer_url = data.trailer_url;
            activeMovie.trailerUrl = data.trailer_url;
            activeMovie.selectedTrailer = data.trailer_url;
            if (trailerInput) trailerInput.value = data.trailer_url;
            showNotice(`Trailer found for "${activeMovie.title}".`);
            renderNewsletterPreview();
            saveLocalState();
            return;
          }
        }
      } catch {}

      // Cross-tab fallback
      const crossMatch = [...(state.trailers?.movies || []), ...(state.artwork?.movies || []), ...(state.newsletter?.movies || [])]
        .find(m => m && m.title && m.title.toLowerCase().trim() === activeMovie.title.toLowerCase().trim());
      const crossTrailer = crossMatch?.selectedTrailer || crossMatch?.trailerUrl || crossMatch?.trailer_url || (crossMatch?.videos && crossMatch.videos[0]?.url);
      if (crossTrailer) {
        activeMovie.trailer_url = crossTrailer;
        activeMovie.trailerUrl = crossTrailer;
        activeMovie.selectedTrailer = crossTrailer;
        if (trailerInput) trailerInput.value = crossTrailer;
        showNotice(`Trailer found for "${activeMovie.title}".`);
        renderNewsletterPreview();
        saveLocalState();
        return;
      }

      // Fallback to YouTube official trailer search URL
      const ytSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent((activeMovie.title + ' ' + (activeMovie.year || '') + ' official trailer').trim())}`;
      activeMovie.trailer_url = ytSearch;
      activeMovie.trailerUrl = ytSearch;
      activeMovie.selectedTrailer = ytSearch;
      if (trailerInput) trailerInput.value = ytSearch;
      showNotice(`YouTube trailer link created for "${activeMovie.title}".`);
      renderNewsletterPreview();
      saveLocalState();
    });
  }

  const btnApplyChanges = document.getElementById('btnNlApplyChanges');
  if (btnApplyChanges) {
    btnApplyChanges.addEventListener('click', () => {
      const newsletterData = state.newsletter;
      if (!newsletterData || !Array.isArray(newsletterData?.movies)) {
        showNotice('No newsletter movie list available.', 'error');
        return;
      }

      // Sync active movie details from detail panel input controls
      syncActiveMovieFromInputs();

      // Iterate through the current movies array to commit and synchronize properties
      newsletterData.movies.forEach(m => {
        if (!m) return;
        if (m.poster_url) {
          m.posterUrl = m.poster_url;
          m.selectedPoster = m.poster_url;
        } else if (m.selectedPoster) {
          m.poster_url = m.selectedPoster;
          m.posterUrl = m.selectedPoster;
        } else if (m.posterUrl) {
          m.poster_url = m.posterUrl;
          m.selectedPoster = m.posterUrl;
        }

        if (m.trailer_url) {
          m.trailerUrl = m.trailer_url;
          m.selectedTrailer = m.trailer_url;
        } else if (m.selectedTrailer) {
          m.trailer_url = m.selectedTrailer;
          m.trailerUrl = m.selectedTrailer;
        } else if (m.trailerUrl) {
          m.trailer_url = m.trailerUrl;
          m.selectedTrailer = m.trailerUrl;
        }
      });

      renderNewsletterMovieList();
      updateAllUI();

      // Explicitly force re-render of the live preview iframe
      const freshMovies = (state.newsletter && Array.isArray(state.newsletter?.movies)) ? state.newsletter.movies : [];
      const freshHtml = generateNewsletterHTML(freshMovies, state.newsletter || {});
      const iframe = document.getElementById('nlIframePreview');
      if (iframe) {
        iframe.srcdoc = freshHtml;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc) {
            doc.open();
            doc.write(freshHtml);
            doc.close();
          }
        } catch (e) {
          console.warn('Iframe doc write refresh notice:', e);
        }
      }

      const activeMovie = newsletterData.movies.find(item => item && item.uid === newsletterData.selectedUid);
      showNotice(`Changes applied${activeMovie ? ` for "${activeMovie.title}"` : ''}. Newsletter preview updated.`);
    });
  }

  const btnUpdatePreview = document.getElementById('btnNlUpdatePreview');
  if (btnUpdatePreview) {
    btnUpdatePreview.addEventListener('click', () => {
      syncActiveMovieFromInputs();
      renderNewsletterPreview();
      showNotice('Newsletter live preview refreshed.');
    });
  }

  // Sharing & Export Buttons
  const btnCopy = document.getElementById('btnCopyHTML');
  if (btnCopy) btnCopy.addEventListener('click', copyNewsletterHTML);
  const btnCopyQuick = document.getElementById('btnCopyHTMLQuick');
  if (btnCopyQuick) btnCopyQuick.addEventListener('click', copyNewsletterHTML);
  const btnCopyRich = document.getElementById('btnCopyRichEmail');
  if (btnCopyRich) btnCopyRich.addEventListener('click', copyRichEmailHTML);

  const btnExport = document.getElementById('btnExportHTML');
  if (btnExport) btnExport.addEventListener('click', () => exportNewsletterHTML(false));
  const btnExportEmb = document.getElementById('btnExportEmbeddedHTML');
  if (btnExportEmb) btnExportEmb.addEventListener('click', () => exportNewsletterHTML(true));

  // Print PDF Button
  const btnPrint = document.getElementById('btnPrintNewsletter');
  if (btnPrint) {
    btnPrint.addEventListener('click', printNewsletterPDF);
  }
}

// Copy raw shareable HTML to clipboard
async function copyNewsletterHTML() {
  const newsletterData = state.newsletter;
  if (!newsletterData || !Array.isArray(newsletterData.movies) || newsletterData.movies.length === 0) {
    showNotice('No movies in Newsletter to copy.', 'error');
    return;
  }
  const html = generateNewsletterHTML(newsletterData.movies, newsletterData);
  try {
    await navigator.clipboard.writeText(html);
    showNotice('Shareable HTML copied to clipboard! You can paste it into any web page or email platform.');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = html;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showNotice('Shareable HTML copied to clipboard!');
  }
}

// Copy rich formatted email to clipboard (paste straight into Gmail / Outlook / Apple Mail)
async function copyRichEmailHTML() {
  const newsletterData = state.newsletter;
  if (!newsletterData || !Array.isArray(newsletterData.movies) || newsletterData.movies.length === 0) {
    showNotice('No movies in Newsletter to copy.', 'error');
    return;
  }
  const html = generateNewsletterHTML(newsletterData.movies, newsletterData);
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const blobHtml = new Blob([html], { type: 'text/html' });
      const blobText = new Blob([html], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blobHtml,
          'text/plain': blobText
        })
      ]);
      showNotice('Rich Email copied to clipboard! You can now paste directly into Gmail, Outlook, or Apple Mail compose window.');
      return;
    }
  } catch (e) {
    console.warn('Rich clipboard write fallback:', e);
  }

  try {
    await navigator.clipboard.writeText(html);
    showNotice('Newsletter HTML copied to clipboard!');
  } catch {
    showNotice('Could not copy to clipboard.', 'error');
  }
}

// Print Newsletter to PDF / Physical Printer directly from Iframe
function printNewsletterPDF() {
  const iframe = document.getElementById('nlIframePreview');
  if (!iframe) {
    showNotice('Newsletter preview iframe not found.', 'error');
    return;
  }
  const targetWindow = iframe.contentWindow || iframe.contentDocument?.defaultView;
  if (targetWindow) {
    showNotice('Opening Print / PDF dialog...');
    targetWindow.focus();
    targetWindow.print();
  } else {
    showNotice('Could not access newsletter preview window.', 'error');
  }
}

// Render Newsletter Movie List strictly from newsletter.movies with Drag-and-Drop and Manual Sorting
let nlDraggedIdx = null;

function renderNewsletterMovieList() {
  const listBox = document.getElementById('nlMovieListBox');
  if (!listBox) return;

  const newsletterData = state.newsletter;
  if (!newsletterData || !Array.isArray(newsletterData.movies) || newsletterData.movies.length === 0) {
    listBox.innerHTML = '<div style="padding: 14px; text-align: center; color: #9CA3AF; font-size: 13px;">No movies in Newsletter. Add or upload titles above to see them here.</div>';
    clearNewsletterMovieDetails();
    return;
  }

  let activeMovie = newsletterData.movies.find(m => m && m.uid === newsletterData.selectedUid);
  if (!activeMovie && newsletterData.movies.length > 0) {
    newsletterData.selectedUid = newsletterData.movies[0].uid;
    activeMovie = newsletterData.movies[0];
  }

  listBox.innerHTML = '';
  newsletterData.movies.forEach((m, idx) => {
    if (!m) return;
    const item = document.createElement('div');
    const isSelected = m.uid === newsletterData.selectedUid;
    item.className = `nl-movie-item ${isSelected ? 'selected' : ''}`;
    item.dataset.uid = m.uid;
    item.dataset.index = idx;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    item.draggable = true;

    // Drag Handle Icon
    const dragHandle = document.createElement('span');
    dragHandle.className = 'nl-drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = 'Drag to reorder movie';

    // Title Label
    const titleSpan = document.createElement('span');
    titleSpan.className = 'nl-movie-title-text';
    titleSpan.textContent = `${m.title}${m.year ? ` (${m.year})` : ''}`;

    // Manual Reorder Buttons (Move Up / Move Down)
    const reorderControls = document.createElement('div');
    reorderControls.className = 'nl-reorder-controls';

    const btnUp = document.createElement('button');
    btnUp.type = 'button';
    btnUp.className = 'nl-reorder-btn';
    btnUp.innerHTML = '▲';
    btnUp.title = 'Move up in list';
    btnUp.onclick = (e) => {
      e.stopPropagation();
      if (idx > 0) {
        const temp = newsletterData.movies[idx];
        newsletterData.movies[idx] = newsletterData.movies[idx - 1];
        newsletterData.movies[idx - 1] = temp;
        saveLocalState();
        renderNewsletterMovieList();
        renderNewsletterPreview();
      }
    };

    const btnDown = document.createElement('button');
    btnDown.type = 'button';
    btnDown.className = 'nl-reorder-btn';
    btnDown.innerHTML = '▼';
    btnDown.title = 'Move down in list';
    btnDown.onclick = (e) => {
      e.stopPropagation();
      if (idx < newsletterData.movies.length - 1) {
        const temp = newsletterData.movies[idx];
        newsletterData.movies[idx] = newsletterData.movies[idx + 1];
        newsletterData.movies[idx + 1] = temp;
        saveLocalState();
        renderNewsletterMovieList();
        renderNewsletterPreview();
      }
    };

    reorderControls.appendChild(btnUp);
    reorderControls.appendChild(btnDown);

    item.appendChild(dragHandle);
    item.appendChild(titleSpan);
    item.appendChild(reorderControls);

    // Selection Event
    item.addEventListener('click', () => {
      newsletterData.selectedUid = m.uid;
      renderNewsletterMovieList();
      const current = newsletterData.movies.find(x => x && x.uid === m.uid);
      populateNewsletterMovieDetails(current);
    });

    // Drag-and-Drop Handlers
    item.addEventListener('dragstart', (e) => {
      nlDraggedIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (nlDraggedIdx === null || nlDraggedIdx === idx) return;
      const movedItem = newsletterData.movies.splice(nlDraggedIdx, 1)[0];
      newsletterData.movies.splice(idx, 0, movedItem);
      nlDraggedIdx = null;
      saveLocalState();
      renderNewsletterMovieList();
      renderNewsletterPreview();
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      nlDraggedIdx = null;
    });

    listBox.appendChild(item);
  });

  populateNewsletterMovieDetails(activeMovie);
}

// Populate Selected Movie Details (Section 3)
function populateNewsletterMovieDetails(m) {
  if (!m) {
    clearNewsletterMovieDetails();
    return;
  }

  const titleEl = document.getElementById('nlDetailTitle');
  const yearEl = document.getElementById('nlDetailYear');
  const langEl = document.getElementById('nlDetailLanguage');
  const distEl = document.getElementById('nlDetailDistributor');
  const durEl = document.getElementById('nlDetailFeatureDuration');
  const p1El = document.getElementById('nlDetailPart1Duration');
  const p2El = document.getElementById('nlDetailPart2Duration');
  const ffecEl = document.getElementById('nlDetailEndCredits');
  const ffmcEl = document.getElementById('nlDetailMovingCredits');
  const cplEl = document.getElementById('nlDetailCplEntries');
  const incEl = document.getElementById('nlDetailInclude');
  const posterEl = document.getElementById('nlDetailPosterUrl');
  const posterModeEl = document.getElementById('nlDetailPosterMode');
  const trailerEl = document.getElementById('nlDetailTrailerUrl');
  const trailerModeEl = document.getElementById('nlDetailTrailerMode');
  const btnFetchPoster = document.getElementById('btnNlFetchPoster');
  const btnFetchTrailer = document.getElementById('btnNlFetchTrailer');

  if (titleEl) titleEl.value = m.title || '';
  if (yearEl) yearEl.value = m.year || '';
  if (langEl) langEl.value = m.language || '';
  if (distEl) distEl.value = m.distributor || '';
  if (durEl) durEl.value = m.feature_duration || m.featureDuration || '';
  if (p1El) p1El.value = m.cpl_part1_duration || m.cplPart1Duration || '';
  if (p2El) p2El.value = m.cpl_part2_duration || m.cplPart2Duration || '';
  if (ffecEl) ffecEl.value = m.first_frame_end_credits || m.firstFrameEndCredits || '';
  if (ffmcEl) ffmcEl.value = m.first_frame_moving_credits || m.firstFrameMovingCredits || '';
  if (cplEl) cplEl.value = m.cplEntries || (Array.isArray(m.cpls) ? m.cpls.map(c => typeof c === 'string' ? c : (c.name ? `${c.name}${c.part ? ' - ' + c.part : ''}` : '')).filter(Boolean).join('\n') : '');

  if (incEl) {
    incEl.checked = m.include !== false && m.checked !== false;
  }

  const posterMode = m.poster_mode || m.posterMode || 'auto';
  if (posterModeEl) posterModeEl.value = posterMode;
  if (btnFetchPoster) btnFetchPoster.disabled = (posterMode === 'manual');
  if (posterEl) {
    posterEl.value = m.poster_url || m.posterUrl || m.selectedPoster || m.poster_remote || m.images?.poster?.[0]?.url || '';
  }

  const trailerMode = m.trailer_mode || m.trailerMode || 'auto';
  if (trailerModeEl) trailerModeEl.value = trailerMode;
  if (btnFetchTrailer) btnFetchTrailer.disabled = (trailerMode === 'manual');
  if (trailerEl) {
    trailerEl.value = m.trailer_url || m.trailerUrl || m.selectedTrailer || (m.videos && m.videos[0]?.url) || '';
  }
}

// Clear Movie Details Fields
function clearNewsletterMovieDetails() {
  const fields = [
    'nlDetailTitle', 'nlDetailYear', 'nlDetailLanguage', 'nlDetailDistributor',
    'nlDetailFeatureDuration', 'nlDetailPart1Duration', 'nlDetailPart2Duration',
    'nlDetailEndCredits', 'nlDetailMovingCredits', 'nlDetailCplEntries',
    'nlDetailPosterUrl', 'nlDetailTrailerUrl'
  ];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
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

// Render Newsletter Live Preview strictly from newsletter.movies
function renderNewsletterPreview() {
  const iframe = document.getElementById('nlIframePreview');
  if (!iframe) return;

  const newsletterData = state.newsletter;
  const moviesArray = (newsletterData && Array.isArray(newsletterData.movies)) ? newsletterData.movies : [];

  const html = generateNewsletterHTML(moviesArray, newsletterData || {});
  iframe.srcdoc = html;
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
    }
  } catch {
    // iframe.srcdoc reliably handles rendering
  }
}

// Export Newsletter HTML File strictly from newsletter.movies
async function exportNewsletterHTML(embedImages = false) {
  const newsletterData = state.newsletter;
  let moviesToExport = (newsletterData && Array.isArray(newsletterData.movies)) ? newsletterData.movies : [];

  if (moviesToExport.length === 0) {
    showNotice('No movies in Newsletter to export. Add titles to newsletter first.', 'error');
    return;
  }

  if (embedImages) {
    showNotice('Embedding TMDB images for offline export...');
    moviesToExport = await Promise.all(moviesToExport.map(async (m) => {
      const copy = { ...m };
      const poster = m.poster_url || m.poster_remote || m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
      if (poster && poster.startsWith('https://image.tmdb.org')) {
        try {
          const res = await fetch('/api/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: poster })
          });
          const data = await res.json();
          if (data.url) {
            copy.selectedPoster = data.url;
            copy.poster_url = data.url;
            copy.poster_remote = data.url;
            copy.posterUrl = data.url;
          }
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

// Download Artwork ZIP strictly from artwork.movies
async function downloadArtworkZIP() {
  const assets = [];
  state.artwork.movies.forEach(m => {
    const poster = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
    if (poster) assets.push({ name: `${m.title}_poster`, url: poster });
    const backdrop = m.selectedBackdrop || m.images?.backdrop?.[0]?.url;
    if (backdrop) assets.push({ name: `${m.title}_backdrop`, url: backdrop });
  });

  if (assets.length === 0) {
    showNotice('No artwork available for ZIP export in Artwork Studio.', 'error');
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

// Export CSV Report strictly for targeted tool
function exportCSVReport(tool = state.activeTab) {
  const targetTool = (tool === 'trailers') ? 'trailers' : 'artwork';
  const movies = state[targetTool]?.movies || [];

  if (movies.length === 0) {
    showNotice(`No movies to export in ${toolDisplayName(targetTool)}.`, 'error');
    return;
  }

  const headers = ['Title', 'Year', 'Language', 'Distributor', 'Poster URL', 'Trailer URL', 'Feature Duration', 'CPL Part 1 Duration', 'CPL Part 2 Duration', 'Synopsis'];
  const rows = [headers.join(',')];

  movies.forEach(m => {
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
  a.download = `${targetTool}-report.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice(`${toolDisplayName(targetTool)} CSV report exported.`);
}

// Save Project JSON with isolated tool datasets
function saveProjectJSON() {
  const project = {
    version: '2.0',
    artwork: state.artwork,
    trailers: state.trailers,
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

// Load Project JSON supporting both isolated format and legacy format
function loadProjectJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (data) {
        const total = (data.artwork?.movies?.length || 0) + (data.trailers?.movies?.length || 0) + (data.newsletter?.movies?.length || 0) + (data.movies?.length || 0);
        const currentTotal = (state.artwork?.movies?.length || 0) + (state.trailers?.movies?.length || 0) + (state.newsletter?.movies?.length || 0);
        if (total > 0 && currentTotal > 0) {
          if (!confirm('Replace your current workspace with this project file?')) return;
        }

        if (data.artwork && Array.isArray(data.artwork.movies)) {
          state.artwork = data.artwork;
        }
        if (data.trailers && Array.isArray(data.trailers.movies)) {
          state.trailers = data.trailers;
        }
        if (data.newsletter) {
          state.newsletter = { ...state.newsletter, ...data.newsletter };
        }
        // Backward compatibility with v1 single-array projects
        if (Array.isArray(data.movies)) {
          state.artwork.movies = data.movies;
          state.artwork.selectedUid = data.movies[0]?.uid || null;
        }

        if (!Array.isArray(state.artwork?.movies)) state.artwork = { movies: [], selectedUid: null };
        if (!Array.isArray(state.trailers?.movies)) state.trailers = { movies: [], selectedUid: null };
        if (!Array.isArray(state.newsletter?.movies)) state.newsletter.movies = [];

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
