import { parseMovieListText, extractBulletinMetadata, generateNewsletterHTML, langCode } from './core.mjs';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
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
    accentColor: '#3066be',
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

// DOM Initialization with readyState safeguard
function boot() {
  loadLocalState();
  checkAPIStatus();
  initFirebase();
  setupNavigation();
  setupEventHandlers();
  updateAllUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

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

// API Fetch Wrapper attaching user-configured keys
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const tmdbKey = (localStorage.getItem('user_tmdb_api_key') || '').trim();
  const ytKey = (localStorage.getItem('user_youtube_api_key') || '').trim();
  if (tmdbKey) headers.set('x-tmdb-api-key', tmdbKey);
  if (ytKey) headers.set('x-youtube-api-key', ytKey);
  return fetch(url, { ...options, headers });
}

// API Connection Status
async function checkAPIStatus() {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.getElementById('connectionStatusText');
  const modalStatusLine = document.getElementById('modalStatusLine');

  const localTmdb = (localStorage.getItem('user_tmdb_api_key') || '').trim();
  const localYt = (localStorage.getItem('user_youtube_api_key') || '').trim();

  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    state.status = {
      ...data,
      tmdb: data.tmdb || !!localTmdb,
      youtube: data.youtube || !!localYt,
      tmdbSource: localTmdb ? 'client' : (data.tmdb ? 'server' : 'none')
    };
  } catch {
    state.status = {
      tmdb: !!localTmdb,
      youtube: !!localYt,
      tmdbSource: localTmdb ? 'client' : 'none',
      youtubeSource: localYt ? 'client' : 'none'
    };
  }

  if (state.status.tmdb) {
    if (statusDot) statusDot.className = 'status-dot';
    if (statusText) statusText.textContent = 'TMDB connected';
    if (modalStatusLine) {
      modalStatusLine.textContent = `TMDB: Connected ✅ · YouTube: ${state.status.youtube ? 'Connected ✅' : 'Optional'}`;
    }
  } else {
    if (statusDot) statusDot.className = 'status-dot offline';
    if (statusText) statusText.textContent = 'Manual mode · enter API key';
    if (modalStatusLine) {
      modalStatusLine.textContent = 'TMDB: Key missing (Enter key below) · YouTube: Optional';
    }
  }
}

// Initialize Firebase & Firestore
async function initFirebase() {
  if (auth) return auth;
  try {
    let config = null;
    try {
      const res = await fetch('/api/firebase-config');
      if (res.ok) config = await res.json();
    } catch {}
    if (!config || !config.projectId) {
      try {
        const res2 = await fetch('/firebase-applet-config.json');
        if (res2.ok) config = await res2.json();
      } catch {}
    }
    if (!config || !config.projectId) {
      console.warn('Firebase configuration not available.');
      return null;
    }

    if (!firebaseApp) {
      firebaseApp = initializeApp(config);
      db = getFirestore(firebaseApp, config.firestoreDatabaseId);
      auth = getAuth(firebaseApp);
    }

    // Process redirect result if returning from Google Auth redirect
    try {
      const redirectResult = await getRedirectResult(auth);
      if (redirectResult && redirectResult.user) {
        await handleSignedInUser(redirectResult.user);
      }
    } catch (redirectErr) {
      console.warn('Redirect sign-in error:', redirectErr);
      displayAuthError(redirectErr);
    }

    // Validate connection to Firestore on boot
    testFirestoreConnection();

    // Listen to Auth State
    onAuthStateChanged(auth, async (user) => {
      await handleSignedInUser(user);
    });
  } catch (err) {
    console.warn('Firebase initialization skipped or failed:', err);
  }
  return auth;
}

async function handleSignedInUser(user) {
  const gateErr = document.getElementById('authGateError');
  if (user) {
    const userEmail = (user.email || '').toLowerCase();
    if (userEmail === ALLOWED_EMAIL) {
      currentUser = user;
      if (gateErr) gateErr.classList.add('hidden');
      updateAuthUI();
      saveUserProfile(user);
      subscribeToCloudProjects(user.uid);
      showNotice(`Signed in as ${userEmail}`);
    } else {
      // Unauthorized email logged in
      if (gateErr) {
        gateErr.innerHTML = `<strong>Access Denied:</strong> ${escapeHTML(user.email)} is not authorized to access this application.`;
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
}

function displayAuthError(err) {
  const gateErr = document.getElementById('authGateError');
  const gateBtn = document.getElementById('btnGateSignIn');
  if (gateBtn) {
    gateBtn.disabled = false;
    gateBtn.textContent = 'Sign in with Google';
  }
  if (!gateErr) return;

  const currentHost = window.location.hostname;
  const isVercel = currentHost.includes('vercel.app');

  if (err.code === 'auth/unauthorized-domain') {
    gateErr.innerHTML = `
      <div style="font-weight:700; margin-bottom:4px; color:#991B1B;">Domain Authorization Required</div>
      <div style="margin-bottom:8px;">
        The domain <code>${escapeHTML(currentHost)}</code> is not in your Firebase Authentication Authorized Domains list.
      </div>
      <div style="font-size:11px; line-height:1.5; color:#374151; background:#ffffff; padding:8px 10px; border-radius:6px; border:1px solid #FCA5A5;">
        <strong>To resolve:</strong><br>
        1. Open <a href="https://console.firebase.google.com/project/gen-lang-client-0078890909/authentication/settings" target="_blank" rel="noopener noreferrer" style="color:#2563eb; text-decoration:underline; font-weight:600;">Firebase Console &rarr; Auth Settings</a><br>
        2. Click <strong>Authorized domains</strong> &rarr; <strong>Add domain</strong><br>
        3. Enter <code>${escapeHTML(currentHost)}</code> and click <strong>Save</strong>.<br>
        <div style="margin-top:6px; font-style:italic;">Or access the pre-authorized preview URL directly.</div>
      </div>
    `;
  } else if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
    gateErr.innerHTML = `
      <div style="font-weight:700; margin-bottom:4px; color:#991B1B;">Popup Blocked by Browser</div>
      <div style="margin-bottom:6px;">
        Your browser (e.g. Brave Shields or ad-blocker) blocked the Google sign-in window.
      </div>
      <div style="font-size:11px; color:#374151;">
        Please click <strong>"Sign in with Redirect"</strong> below or lower Brave Shields for this domain.
      </div>
    `;
  } else if (err.code === 'auth/network-request-failed') {
    gateErr.innerHTML = `
      <div style="font-weight:700; margin-bottom:4px; color:#991B1B;">Network / Third-Party Cookie Blocked</div>
      <div style="margin-bottom:4px;">
        Google Auth network request failed. If using Brave Browser, please turn <strong>Shields DOWN</strong> for this domain or allow Google login.
      </div>
    `;
  } else if (err.code === 'auth/popup-closed-by-user') {
    gateErr.innerHTML = `
      <div>Sign-in popup was closed before completing. Click below to try again.</div>
    `;
  } else {
    gateErr.innerHTML = `
      <div style="font-weight:700; margin-bottom:4px; color:#991B1B;">Sign-in Error (${escapeHTML(err.code || 'unknown')})</div>
      <div>${escapeHTML(err.message || String(err))}</div>
    `;
  }
  gateErr.classList.remove('hidden');
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
      updatedAt: new Date().toISOString()
    };
    const localTmdb = (localStorage.getItem('user_tmdb_api_key') || '').trim();
    const localYt = (localStorage.getItem('user_youtube_api_key') || '').trim();
    if (localTmdb) profile.custom_tmdb_key = localTmdb;
    if (localYt) profile.custom_yt_key = localYt;

    await setDoc(userDocRef, profile, { merge: true });

    // If local has no keys, try fetching from Firestore profile
    if (!localTmdb) {
      try {
        const snap = await getDocFromServer(userDocRef);
        if (snap.exists()) {
          const d = snap.data();
          if (d.custom_tmdb_key) {
            localStorage.setItem('user_tmdb_api_key', d.custom_tmdb_key);
            if (d.custom_yt_key) localStorage.setItem('user_youtube_api_key', d.custom_yt_key);
            checkAPIStatus();
          }
        }
      } catch {}
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// Auth Handlers
async function signInWithGoogle(useRedirect = false) {
  const gateBtn = document.getElementById('btnGateSignIn');
  const gateRedirectBtn = document.getElementById('btnGateSignInRedirect');
  const gateErr = document.getElementById('authGateError');
  if (gateErr) gateErr.classList.add('hidden');

  if (gateBtn) {
    gateBtn.disabled = true;
    gateBtn.textContent = 'Connecting…';
  }

  if (!auth) {
    await initFirebase();
  }

  if (!auth) {
    if (gateErr) {
      gateErr.innerHTML = `<strong>Authentication Unavailable:</strong> Could not connect to Firebase. Check your internet connection or reload the page.`;
      gateErr.classList.remove('hidden');
    }
    if (gateBtn) {
      gateBtn.disabled = false;
      gateBtn.textContent = 'Sign in with Google';
    }
    return;
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    if (useRedirect) {
      if (gateRedirectBtn) gateRedirectBtn.textContent = 'Redirecting to Google…';
      await signInWithRedirect(auth, provider);
      return;
    }

    if (gateBtn) gateBtn.textContent = 'Signing in…';
    const result = await signInWithPopup(auth, provider);
    if (result && result.user) {
      await handleSignedInUser(result.user);
    }
  } catch (err) {
    console.error('Sign-in error:', err);
    if (!useRedirect && (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')) {
      try {
        if (gateErr) {
          gateErr.innerHTML = `Popup blocked. Automatically redirecting to Google Sign-in…`;
          gateErr.classList.remove('hidden');
        }
        await signInWithRedirect(auth, provider);
        return;
      } catch (redirErr) {
        displayAuthError(redirErr);
        return;
      }
    }
    displayAuthError(err);
  } finally {
    if (gateBtn) {
      gateBtn.disabled = false;
      gateBtn.textContent = 'Sign in with Google';
    }
    if (gateRedirectBtn) {
      gateRedirectBtn.textContent = 'Popup blocked or in Brave? Sign in with Redirect →';
    }
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
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.email || 'Authorized User';
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
  // Top Upload PDF button and global PDF file picker
  const btnUploadPdfTop = document.getElementById('btnUploadPdfTop');
  const globalPdfInput = document.getElementById('globalPdfInput');
  if (btnUploadPdfTop && globalPdfInput) {
    btnUploadPdfTop.addEventListener('click', () => {
      globalPdfInput.value = '';
      globalPdfInput.click();
    });

    globalPdfInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      showNotice(`Processing "${file.name}"... Please wait.`);
      let text = '';

      if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
        try {
          const res = await fetch('/api/pdf', {
            method: 'POST',
            body: file
          });
          if (res.ok) {
            const data = await res.json();
            text = data.text || '';
          }
        } catch {}

        // Fallback to client-side PDF.js if available
        if (!text && window.pdfjsLib) {
          try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const pagesText = [];
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const textContent = await page.getTextContent();
              pagesText.push(textContent.items.map(item => item.str).join(' '));
            }
            text = pagesText.join('\n');
          } catch {}
        }
      } else {
        text = await file.text().catch(() => '');
      }

      if (!text || !text.trim()) {
        showNotice(`Could not extract movie text from "${file.name}". Please ensure it contains selectable text or paste directly.`, 'error');
        return;
      }

      const parsed = parseMovieListText(text);
      if (parsed.length === 0) {
        showNotice(`No movie titles detected in "${file.name}".`, 'error');
        return;
      }

      const activeKey = state.activeTab || 'artwork';
      addMoviesToTool(parsed, activeKey);
      showNotice(`Successfully imported ${parsed.length} movie(s) from "${file.name}" to ${activeKey}!`);

      if (activeKey === 'newsletter') {
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
      }

      updateAllUI();

      setTimeout(() => {
        const colSection = document.querySelector('.collection-section') || document.querySelector('.collection-grid');
        if (colSection) colSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    });
  }

  // Smooth scroll and focus for Add Movie buttons
  const handleAddMovieClick = () => {
    let inputId = 'artworkInputText';
    if (state.activeTab === 'trailers') inputId = 'trailersInputText';
    if (state.activeTab === 'newsletter') inputId = 'newsletterInputText';
    const el = document.getElementById(inputId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      el.style.transition = 'box-shadow 0.3s ease, border-color 0.3s ease';
      el.style.borderColor = 'var(--primary-green)';
      el.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.35)';
      setTimeout(() => {
        el.style.borderColor = '';
        el.style.boxShadow = '';
      }, 2000);
      showNotice(`Type or paste movie titles into the ${state.activeTab} box below.`);
    }
  };

  const btnAddMovieTop = document.getElementById('btnAddMovieTop');
  if (btnAddMovieTop) btnAddMovieTop.addEventListener('click', handleAddMovieClick);

  const btnAddFocus = document.getElementById('btnAddMovieFocus');
  if (btnAddFocus) btnAddFocus.addEventListener('click', handleAddMovieClick);

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

  // Download All Posters button in Artwork toolbar
  const btnDlPostersAll = document.getElementById('btnDownloadPostersAll');
  if (btnDlPostersAll) btnDlPostersAll.addEventListener('click', downloadAllPosters);

  // Download Selected Trailer MP4s in Trailers toolbar
  const btnDlTrailersVideoBatch = document.getElementById('btnDownloadTrailersVideoBatch');
  if (btnDlTrailersVideoBatch) btnDlTrailersVideoBatch.addEventListener('click', downloadSelectedTrailersVideo);

  // Download Trailer Links button in Trailers toolbar
  const btnDlTrailersAll = document.getElementById('btnDownloadTrailersAll');
  if (btnDlTrailersAll) btnDlTrailersAll.addEventListener('click', downloadAllTrailerLinks);

  // Select All / Deselect All checkboxes
  const selAllArt = document.getElementById('selectAllArtwork');
  if (selAllArt) {
    selAllArt.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      (state.artwork?.movies || []).forEach(m => { m.checked = isChecked; });
      updateAllUI();
    });
  }

  const selAllTrl = document.getElementById('selectAllTrailers');
  if (selAllTrl) {
    selAllTrl.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      (state.trailers?.movies || []).forEach(m => { m.checked = isChecked; });
      updateAllUI();
    });
  }

  // In-App Trailer Player Modal handlers
  const btnClosePlayerModal = document.getElementById('btnCloseTrailerPlayerModal');
  if (btnClosePlayerModal) btnClosePlayerModal.addEventListener('click', closeTrailerPlayerModal);
  const btnClosePlayerFooter = document.getElementById('btnCloseTrailerPlayerFooter');
  if (btnClosePlayerFooter) btnClosePlayerFooter.addEventListener('click', closeTrailerPlayerModal);

  // Bulk Trailer Downloader Modal handlers
  const bulkTrailerModal = document.getElementById('bulkTrailerModal');
  const closeBulkModal = () => {
    if (bulkTrailerModal && typeof bulkTrailerModal.close === 'function') {
      bulkTrailerModal.close();
    }
  };
  const btnCloseBulk = document.getElementById('btnCloseBulkTrailerModal');
  if (btnCloseBulk) btnCloseBulk.addEventListener('click', closeBulkModal);
  const btnCloseBulkFooter = document.getElementById('btnCloseBulkTrailerModalFooter');
  if (btnCloseBulkFooter) btnCloseBulkFooter.addEventListener('click', closeBulkModal);

  const btnDlAllShortcutsModal = document.getElementById('btnDownloadAllShortcutsModal');
  if (btnDlAllShortcutsModal) btnDlAllShortcutsModal.addEventListener('click', downloadAllTrailerLinks);

  const btnExportAllLinksModal = document.getElementById('btnExportAllTrailerLinksModal');
  if (btnExportAllLinksModal) {
    btnExportAllLinksModal.addEventListener('click', async () => {
      const allMovies = state.trailers?.movies || [];
      const checkedMovies = allMovies.filter(m => m.checked !== false);
      const moviesToExport = checkedMovies.length > 0 ? checkedMovies : allMovies;
      const validTrailers = moviesToExport.filter(m => !!(m.trailerUrl || m.selectedTrailer || m.trailer_url || (m.videos && m.videos[0]?.url)));
      const lines = validTrailers.map(m => `${m.title}: ${m.trailerUrl || m.selectedTrailer || m.trailer_url || (m.videos && m.videos[0]?.url)}`).join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        showNotice(`Copied ${validTrailers.length} trailer link(s) to clipboard!`);
      } catch {
        showNotice(`Selected ${validTrailers.length} trailer link(s).`);
      }
    });
  }

  // API Key & Connection Modal setup
  const connModal = document.getElementById('connModal');
  const btnConnDetails = document.getElementById('btnConnDetails');
  const btnCloseConnModal = document.getElementById('btnCloseConnModal');
  const btnCancelConnModal = document.getElementById('btnCancelConnModal');
  const btnSaveApiKeys = document.getElementById('btnSaveApiKeys');
  const btnClearApiKeys = document.getElementById('btnClearApiKeys');
  const inputTmdbApiKey = document.getElementById('inputTmdbApiKey');
  const inputYtApiKey = document.getElementById('inputYtApiKey');
  const btnToggleTmdbKey = document.getElementById('btnToggleTmdbKey');
  const btnToggleYtKey = document.getElementById('btnToggleYtKey');
  const apiKeysNotice = document.getElementById('apiKeysNotice');

  function syncKeyInputs() {
    if (inputTmdbApiKey) inputTmdbApiKey.value = (localStorage.getItem('user_tmdb_api_key') || '').trim();
    if (inputYtApiKey) inputYtApiKey.value = (localStorage.getItem('user_youtube_api_key') || '').trim();
    if (apiKeysNotice) {
      apiKeysNotice.className = 'hidden';
      apiKeysNotice.textContent = '';
    }
  }

  if (btnConnDetails && connModal) {
    btnConnDetails.addEventListener('click', () => {
      syncKeyInputs();
      connModal.showModal();
    });
  }

  if (btnCloseConnModal && connModal) {
    btnCloseConnModal.addEventListener('click', () => connModal.close());
  }

  if (btnCancelConnModal && connModal) {
    btnCancelConnModal.addEventListener('click', () => connModal.close());
  }

  if (btnToggleTmdbKey && inputTmdbApiKey) {
    btnToggleTmdbKey.addEventListener('click', () => {
      if (inputTmdbApiKey.type === 'password') {
        inputTmdbApiKey.type = 'text';
        btnToggleTmdbKey.textContent = 'Hide';
      } else {
        inputTmdbApiKey.type = 'password';
        btnToggleTmdbKey.textContent = 'Show';
      }
    });
  }

  if (btnToggleYtKey && inputYtApiKey) {
    btnToggleYtKey.addEventListener('click', () => {
      if (inputYtApiKey.type === 'password') {
        inputYtApiKey.type = 'text';
        btnToggleYtKey.textContent = 'Hide';
      } else {
        inputYtApiKey.type = 'password';
        btnToggleYtKey.textContent = 'Show';
      }
    });
  }

  if (btnSaveApiKeys) {
    btnSaveApiKeys.addEventListener('click', async () => {
      const tmdbVal = (inputTmdbApiKey ? inputTmdbApiKey.value : '').trim();
      const ytVal = (inputYtApiKey ? inputYtApiKey.value : '').trim();

      btnSaveApiKeys.disabled = true;
      btnSaveApiKeys.textContent = 'Saving…';

      // Store keys locally
      if (tmdbVal) {
        localStorage.setItem('user_tmdb_api_key', tmdbVal);
      } else {
        localStorage.removeItem('user_tmdb_api_key');
      }

      if (ytVal) {
        localStorage.setItem('user_youtube_api_key', ytVal);
      } else {
        localStorage.removeItem('user_youtube_api_key');
      }

      // Sync with user's Firestore profile if signed in
      if (currentUser && db) {
        try {
          await setDoc(doc(db, 'users', currentUser.uid), {
            userId: currentUser.uid,
            email: currentUser.email || '',
            displayName: currentUser.displayName || currentUser.email || 'User',
            photoURL: currentUser.photoURL || '',
            custom_tmdb_key: tmdbVal || '',
            custom_yt_key: ytVal || '',
            keysUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }, { merge: true });
        } catch (err) {
          console.warn('Could not sync keys to Firestore profile:', err);
        }
      }

      await checkAPIStatus();

      if (apiKeysNotice) {
        apiKeysNotice.className = '';
        apiKeysNotice.style.background = '#ECFDF5';
        apiKeysNotice.style.border = '1px solid #A7F3D0';
        apiKeysNotice.style.color = '#065F46';
        apiKeysNotice.textContent = tmdbVal
          ? '✅ TMDB API key connected successfully!'
          : 'Saved in manual mode.';
      }

      showNotice(tmdbVal ? 'TMDB connected successfully.' : 'API keys updated.');

      setTimeout(() => {
        if (connModal && connModal.open) connModal.close();
        btnSaveApiKeys.disabled = false;
        btnSaveApiKeys.textContent = 'Save & Connect';
      }, 900);
    });
  }

  if (btnClearApiKeys) {
    btnClearApiKeys.addEventListener('click', async () => {
      localStorage.removeItem('user_tmdb_api_key');
      localStorage.removeItem('user_youtube_api_key');
      if (inputTmdbApiKey) inputTmdbApiKey.value = '';
      if (inputYtApiKey) inputYtApiKey.value = '';
      if (currentUser && db) {
        try {
          await setDoc(doc(db, 'users', currentUser.uid), {
            userId: currentUser.uid,
            email: currentUser.email || '',
            displayName: currentUser.displayName || currentUser.email || 'User',
            photoURL: currentUser.photoURL || '',
            custom_tmdb_key: '',
            custom_yt_key: '',
            keysUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }, { merge: true });
        } catch (err) {
          console.warn('Could not clear keys from Firestore profile:', err);
        }
      }
      await checkAPIStatus();
      if (apiKeysNotice) {
        apiKeysNotice.className = '';
        apiKeysNotice.style.background = '#F3F4F6';
        apiKeysNotice.style.border = '1px solid #E5E7EB';
        apiKeysNotice.style.color = '#4B5563';
        apiKeysNotice.textContent = 'API keys cleared. Site is running in manual offline mode.';
      }
      showNotice('API keys removed.');
    });
  }

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
  if (btnSignIn) btnSignIn.addEventListener('click', () => signInWithGoogle(false));

  const btnGateSignIn = document.getElementById('btnGateSignIn');
  if (btnGateSignIn) btnGateSignIn.addEventListener('click', () => signInWithGoogle(false));

  const btnGateSignInRedirect = document.getElementById('btnGateSignInRedirect');
  if (btnGateSignInRedirect) btnGateSignInRedirect.addEventListener('click', () => signInWithGoogle(true));

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
    let crossActor = item.actor || item.cast || '';
    let crossProduction = item.production || item.production_company || item.distributor || '';

    if (!crossPoster || !crossTrailer || !crossActor || !crossProduction) {
      const crossPool = [...(state.artwork?.movies || []), ...(state.trailers?.movies || []), ...(state.newsletter?.movies || [])];
      const match = crossPool.find(m => m && m.title && item.title && m.title.toLowerCase().trim() === item.title.toLowerCase().trim());
      if (match) {
        if (!crossPoster) {
          crossPoster = match.selectedPoster || match.posterUrl || match.poster_url || match.images?.poster?.[0]?.url || '';
        }
        if (!crossTrailer) {
          crossTrailer = match.selectedTrailer || match.trailerUrl || match.trailer_url || (match.videos && match.videos[0]?.url) || '';
        }
        if (!crossActor && match.actor) crossActor = match.actor;
        if (!crossProduction && (match.production || match.distributor)) crossProduction = match.production || match.distributor;
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
      actor: crossActor || '',
      production: crossProduction || item.distributor || '',
      language: item.language || '',
      distributor: crossProduction || item.distributor || '',
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
      const q = toolState.filter.toLowerCase();
      return (m.title && m.title.toLowerCase().includes(q)) ||
             (m.year && String(m.year).includes(q)) ||
             (m.language && m.language.toLowerCase().includes(q)) ||
             (m.actor && m.actor.toLowerCase().includes(q)) ||
             (m.production && m.production.toLowerCase().includes(q));
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
      const metaParts = [m.year, m.language, m.actor, m.production].filter(Boolean);
      const metaText = metaParts.length > 0 ? metaParts.join(' · ') : 'Details to discover';

      row.innerHTML = `
        <input type="checkbox" class="movie-checkbox" ${m.checked !== false ? 'checked' : ''} aria-label="Include ${m.title}" />
        ${posterUrl ? `<img src="${posterUrl}" class="movie-poster-img" alt="${m.title}" />` : `<div class="movie-poster-thumb">${initialLetter}</div>`}
        <div class="movie-info-block">
          <div class="movie-row-title">${m.title}</div>
          <div class="movie-row-meta" title="${escapeHTML(metaText)}">${escapeHTML(metaText)}</div>
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

  // Sync Select All checkbox states
  const artMovies = state.artwork?.movies || [];
  const selAllArt = document.getElementById('selectAllArtwork');
  if (selAllArt && artMovies.length > 0) {
    selAllArt.checked = artMovies.every(m => m.checked !== false);
  }

  const trlMovies = state.trailers?.movies || [];
  const selAllTrl = document.getElementById('selectAllTrailers');
  if (selAllTrl && trlMovies.length > 0) {
    selAllTrl.checked = trlMovies.every(m => m.checked !== false);
  }
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

    if (tool === 'artwork') {
      card.innerHTML = buildArtworkDetailCardHTML(m);
      bindArtworkDetailCardEvents(card, m);
    } else {
      card.innerHTML = buildTrailerDetailCardHTML(m);
      bindTrailerDetailCardEvents(card, m);
    }
  });
}

// Build Detail Card Markup for Posters & Artwork Panel ONLY
function buildArtworkDetailCardHTML(m) {
  const matchOptions = (m.tmdbCandidates || []).map(c => `
    <option value="${c.id}" ${c.id === m.id ? 'selected' : ''}>${escapeHTML(c.title)} (${c.release_date ? c.release_date.slice(0, 4) : 'N/A'}) · ${c.original_language || 'en'}</option>
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

  const tmdbLink = m.id ? `https://www.themoviedb.org/movie/${m.id}` : '#';
  const imdbLink = m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}` : '#';
  const languages = ['Tamil', 'Telugu', 'Malayalam', 'Hindi', 'Kannada', 'English', 'Spanish', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Mandarin', 'Cantonese', 'Arabic', 'Russian'];

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="card-heading">${escapeHTML(m.title)}</h2>
          <span class="pill">POSTERS &amp; ARTWORK</span>
        </div>
        <div class="card-subheading">${m.statusText || 'Pending'}</div>
      </div>
      <div class="detail-actions-row">
        <button class="btn btn-primary btn-sm" id="btnSearchSingle">Search artwork</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveUp" title="Move up">↑</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveDown" title="Move down">↓</button>
        <button class="btn btn-danger btn-sm" id="btnRemoveMovie">Remove</button>
      </div>
    </div>

    <!-- SEARCH BOX FOR POSTER -->
    <div class="search-box-card" style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; margin-bottom: 16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
        <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--primary-green);">
          🔍 Search &amp; Find Posters
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">Refine by title, year, actor &amp; production</span>
      </div>

      <div class="form-grid-2col" style="gap: 10px; margin-bottom: 12px;">
        <div class="form-group full-width">
          <label class="form-label" for="searchMovieTitle" style="font-size: 11px;">Movie title / Search query</label>
          <input type="text" id="searchMovieTitle" class="form-input" value="${escapeHTML(m.title)}" placeholder="Enter movie title...">
        </div>

        <div class="form-group">
          <label class="form-label" for="searchMovieYear" style="font-size: 11px;">Year</label>
          <input type="text" id="searchMovieYear" class="form-input" value="${escapeHTML(m.year || '')}" placeholder="e.g. 2026">
        </div>

        <div class="form-group">
          <label class="form-label" for="searchMovieActor" style="font-size: 11px;">Actor</label>
          <input type="text" id="searchMovieActor" class="form-input" value="${escapeHTML(m.actor || '')}" placeholder="e.g. Shah Rukh Khan, Vijay...">
        </div>

        <div class="form-group full-width">
          <label class="form-label" for="searchMovieProduction" style="font-size: 11px;">Production name</label>
          <input type="text" id="searchMovieProduction" class="form-input" value="${escapeHTML(m.production || m.distributor || '')}" placeholder="e.g. Red Chillies, Marvel Studios, Sun Pictures...">
        </div>

        <div class="form-group full-width" style="margin-top: 2px;">
          <label class="form-label" style="font-size: 11px; display:flex; justify-content:space-between;">
            <span>Language</span>
            <span style="font-weight:normal; color:var(--text-muted);">${m.language || 'Auto / Original'}</span>
          </label>
          <div class="quick-lang-buttons" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
            ${['Auto', 'Tamil', 'Telugu', 'Hindi', 'Malayalam', 'Kannada', 'English'].map(lang => {
              const isAuto = lang === 'Auto';
              const isSelected = isAuto ? !m.language : (m.language && langCode(lang) === langCode(m.language));
              return `<button type="button" class="btn btn-sm btn-quick-lang ${isSelected ? 'btn-primary' : 'btn-secondary'}" data-lang="${isAuto ? '' : lang}" style="padding: 3px 10px; font-size: 11px; border-radius: 4px;">${lang}</button>`;
            }).join('')}
          </div>
          <select id="selectArtworkSearchLang" class="form-select form-select-sm">
            <option value="">Automatic / Original language</option>
            ${languages.map(l => `<option value="${l}" ${langCode(l) === langCode(m.language) ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <button type="button" class="btn btn-primary btn-full" id="btnSearchArtworkBox">
        🔍 Search Poster &amp; Artwork
      </button>
    </div>

    ${m.tmdbCandidates && m.tmdbCandidates.length > 0 ? `
      <div class="form-group" style="margin-bottom: 12px;">
        <label class="form-label" for="selectMovieMatch">Movie match</label>
        <select id="selectMovieMatch" class="form-select">${matchOptions}</select>
      </div>
    ` : ''}

    <div class="form-group" style="margin-bottom: 16px;">
      <label class="form-label" for="selectLanguage">Preferred artwork language</label>
      <select id="selectLanguage" class="form-select">
        <option value="">Automatic / original</option>
        ${languages.map(l => `<option value="${l}" ${langCode(l) === langCode(m.language) ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <!-- ARTWORK 3-COL GRID -->
    <div class="artwork-3col-grid">
      <div class="art-slot">
        <div class="art-slot-label">Poster</div>
        <div class="art-slot-preview">
          ${posterUrl ? `<img src="${posterUrl}" alt="Poster" />` : '—'}
        </div>
        <select id="selectPoster" class="form-select form-select-sm">
          ${posterSelectOpts || '<option>No poster found</option>'}
        </select>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
          ${posterUrl ? `<a href="${posterUrl}" target="_blank" rel="noopener noreferrer" class="art-slot-link">Open ↗</a>` : '<span></span>'}
          ${posterUrl ? `<button type="button" class="btn btn-secondary btn-sm btn-download-art" data-url="${escapeHTML(posterUrl)}" data-name="${escapeHTML(m.title)}_poster.jpg" style="padding:2px 7px;font-size:11px;">⬇ Save</button>` : ''}
        </div>
      </div>

      <div class="art-slot">
        <div class="art-slot-label">Backdrop</div>
        <div class="art-slot-preview">
          ${backdropUrl ? `<img src="${backdropUrl}" alt="Backdrop" />` : '—'}
        </div>
        <select id="selectBackdrop" class="form-select form-select-sm">
          ${backdropSelectOpts || '<option>No backdrop found</option>'}
        </select>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
          ${backdropUrl ? `<a href="${backdropUrl}" target="_blank" rel="noopener noreferrer" class="art-slot-link">Open ↗</a>` : '<span></span>'}
          ${backdropUrl ? `<button type="button" class="btn btn-secondary btn-sm btn-download-art" data-url="${escapeHTML(backdropUrl)}" data-name="${escapeHTML(m.title)}_backdrop.jpg" style="padding:2px 7px;font-size:11px;">⬇ Save</button>` : ''}
        </div>
      </div>

      <div class="art-slot">
        <div class="art-slot-label">Logo</div>
        <div class="art-slot-preview">
          ${logoUrl ? `<img src="${logoUrl}" alt="Logo" />` : '—'}
        </div>
        <select id="selectLogo" class="form-select form-select-sm">
          ${logoSelectOpts || '<option>No logo found</option>'}
        </select>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
          ${logoUrl ? `<a href="${logoUrl}" target="_blank" rel="noopener noreferrer" class="art-slot-link">Open ↗</a>` : '<span></span>'}
          ${logoUrl ? `<button type="button" class="btn btn-secondary btn-sm btn-download-art" data-url="${escapeHTML(logoUrl)}" data-name="${escapeHTML(m.title)}_logo.png" style="padding:2px 7px;font-size:11px;">⬇ Save</button>` : ''}
        </div>
      </div>
    </div>

    <!-- POSTER URL & UPLOAD -->
    <div class="form-group full-width" style="margin-top: 14px;">
      <label class="form-label" for="inputPosterUrl">Poster URL</label>
      <input type="text" id="inputPosterUrl" class="form-input" value="${escapeHTML(posterUrl)}" placeholder="https://image.tmdb.org/... or paste custom URL">
    </div>

    <div class="form-group full-width" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
      <label class="checkbox-label">
        <input type="checkbox" id="chkKeepPoster" ${m.keepPoster ? 'checked' : ''}>
        Keep my poster when searching
      </label>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-secondary btn-sm" id="btnUploadPoster">Upload a poster</button>
        ${posterUrl ? `<button type="button" class="btn btn-secondary btn-sm" id="btnDownloadCurrentPoster" title="Download this poster image">⬇ Download poster</button>` : ''}
      </div>
      <input type="file" id="filePosterInput" accept="image/*" style="display:none;">
    </div>

    <div style="display:flex; gap:12px; margin-bottom:14px; font-size:12px;">
      ${m.id ? `<a href="${tmdbLink}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-green); text-decoration:none;">TMDB ↗</a>` : ''}
      ${m.imdb_id ? `<a href="${imdbLink}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-green); text-decoration:none;">IMDb ↗</a>` : ''}
    </div>
  `;
}

// Build Detail Card Markup for Trailers & Teasers Panel ONLY
function buildTrailerDetailCardHTML(m) {
  const matchOptions = (m.tmdbCandidates || []).map(c => `
    <option value="${c.id}" ${c.id === m.id ? 'selected' : ''}>${escapeHTML(c.title)} (${c.release_date ? c.release_date.slice(0, 4) : 'N/A'}) · ${c.original_language || 'en'}</option>
  `).join('');

  const trailerSelectOpts = (m.videos || []).map(v => {
    const cat = v.category || v.type || 'Video';
    const icon = cat === 'Trailer' ? '🎬' : cat === 'Teaser' ? '🔥' : cat === 'Song' ? '🎵' : cat === 'Promo' ? '⚡' : '▶';
    return `<option value="${v.url}" data-category="${cat}" ${v.url === (m.trailerUrl || m.selectedTrailer) ? 'selected' : ''}>${icon} [${cat}] ${escapeHTML(v.name)} (${v.iso_639_1 || 'orig'})</option>`;
  }).join('');

  const activeTrailerUrl = m.trailerUrl || m.selectedTrailer || m.videos?.[0]?.url || '';
  const youtubeVideoId = extractYouTubeID(activeTrailerUrl);

  const tmdbLink = m.id ? `https://www.themoviedb.org/movie/${m.id}` : '#';
  const imdbLink = m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}` : '#';
  const languages = ['Tamil', 'Telugu', 'Malayalam', 'Hindi', 'Kannada', 'English', 'Spanish', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Mandarin', 'Cantonese', 'Arabic', 'Russian'];

  return `
    <div class="detail-header">
      <div>
        <div class="detail-title-row">
          <h2 class="card-heading">${escapeHTML(m.title)}</h2>
          <span class="pill">TRAILERS &amp; TEASERS</span>
        </div>
        <div class="card-subheading">${m.statusText || 'Pending'}</div>
      </div>
      <div class="detail-actions-row">
        <button class="btn btn-primary btn-sm" id="btnSearchSingle">Search trailers</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveUp" title="Move up">↑</button>
        <button class="btn btn-secondary btn-sm" id="btnMoveDown" title="Move down">↓</button>
        <button class="btn btn-danger btn-sm" id="btnRemoveMovie">Remove</button>
      </div>
    </div>

    <!-- SEARCH BOX FOR TRAILER, TEASER, SONGS, PROMOS -->
    <div class="search-box-card" style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px; margin-bottom: 16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
        <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--primary-green);">
          🔍 Find Trailers, Teasers, Songs &amp; Promos
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">Refine by title, year, actor &amp; production</span>
      </div>

      <div class="form-grid-2col" style="gap: 10px; margin-bottom: 12px;">
        <div class="form-group full-width">
          <label class="form-label" for="searchMovieTitle" style="font-size: 11px;">Movie title / Search query</label>
          <input type="text" id="searchMovieTitle" class="form-input" value="${escapeHTML(m.title)}" placeholder="Enter movie title...">
        </div>

        <div class="form-group">
          <label class="form-label" for="searchMovieYear" style="font-size: 11px;">Year</label>
          <input type="text" id="searchMovieYear" class="form-input" value="${escapeHTML(m.year || '')}" placeholder="e.g. 2026">
        </div>

        <div class="form-group">
          <label class="form-label" for="searchMovieActor" style="font-size: 11px;">Actor</label>
          <input type="text" id="searchMovieActor" class="form-input" value="${escapeHTML(m.actor || '')}" placeholder="e.g. Shah Rukh Khan, Vijay...">
        </div>

        <div class="form-group full-width">
          <label class="form-label" for="searchMovieProduction" style="font-size: 11px;">Production name</label>
          <input type="text" id="searchMovieProduction" class="form-input" value="${escapeHTML(m.production || m.distributor || '')}" placeholder="e.g. Red Chillies, Marvel Studios, Sun Pictures...">
        </div>

        <div class="form-group full-width" style="margin-top: 2px;">
          <label class="form-label" style="font-size: 11px; display:flex; justify-content:space-between;">
            <span>Language</span>
            <span style="font-weight:normal; color:var(--text-muted);">${m.language || 'Auto / Original'}</span>
          </label>
          <div class="quick-lang-buttons" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
            ${['Auto', 'Tamil', 'Telugu', 'Hindi', 'Malayalam', 'Kannada', 'English'].map(lang => {
              const isAuto = lang === 'Auto';
              const isSelected = isAuto ? !m.language : (m.language && langCode(lang) === langCode(m.language));
              return `<button type="button" class="btn btn-sm btn-quick-lang ${isSelected ? 'btn-primary' : 'btn-secondary'}" data-lang="${isAuto ? '' : lang}" style="padding: 3px 10px; font-size: 11px; border-radius: 4px;">${lang}</button>`;
            }).join('')}
          </div>
          <select id="selectTrailerSearchLang" class="form-select form-select-sm">
            <option value="">Automatic / Original language</option>
            ${languages.map(l => `<option value="${l}" ${langCode(l) === langCode(m.language) ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- ASSET CATEGORY FIND BUTTONS -->
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        <button type="button" class="btn btn-primary btn-sm btn-find-media" data-category="all" id="btnSearchAllMedia" style="flex:1; min-width:125px;">
          🔍 All Videos
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-find-media" data-category="trailer" id="btnSearchTrailerOnly" style="flex:1; min-width:110px;">
          🎬 Trailers
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-find-media" data-category="teaser" id="btnSearchTeaserOnly" style="flex:1; min-width:105px;">
          🔥 Teasers
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-find-media" data-category="song" id="btnSearchSongOnly" style="flex:1; min-width:100px;">
          🎵 Songs
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-find-media" data-category="promo" id="btnSearchPromoOnly" style="flex:1; min-width:105px;">
          ⚡ Promos
        </button>
      </div>
    </div>

    ${m.tmdbCandidates && m.tmdbCandidates.length > 0 ? `
      <div class="form-group" style="margin-bottom: 12px;">
        <label class="form-label" for="selectMovieMatch">Movie match</label>
        <select id="selectMovieMatch" class="form-select">${matchOptions}</select>
      </div>
    ` : ''}

    <!-- TRAILER & VIDEO DISCOVERY WITH CATEGORIES -->
    <div class="form-group full-width" style="margin-bottom: 12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom: 8px;">
        <label class="form-label" for="selectTrailer" style="margin-bottom:0;">Video Alternatives (Trailers, Teasers, Songs, Promos)</label>
        <div class="video-cat-pills" style="display:flex; flex-wrap:wrap; gap:4px;">
          <button type="button" class="btn btn-sm btn-video-filter active" data-cat="all" style="padding:2px 7px; font-size:10px;">All (${(m.videos || []).length})</button>
          <button type="button" class="btn btn-sm btn-video-filter" data-cat="Trailer" style="padding:2px 7px; font-size:10px;">🎬 Trailers (${(m.videos || []).filter(v => (v.category || v.type) === 'Trailer').length})</button>
          <button type="button" class="btn btn-sm btn-video-filter" data-cat="Teaser" style="padding:2px 7px; font-size:10px;">🔥 Teasers (${(m.videos || []).filter(v => (v.category || v.type) === 'Teaser').length})</button>
          <button type="button" class="btn btn-sm btn-video-filter" data-cat="Song" style="padding:2px 7px; font-size:10px;">🎵 Songs (${(m.videos || []).filter(v => (v.category || v.type) === 'Song').length})</button>
          <button type="button" class="btn btn-sm btn-video-filter" data-cat="Promo" style="padding:2px 7px; font-size:10px;">⚡ Promos (${(m.videos || []).filter(v => (v.category || v.type) === 'Promo').length})</button>
        </div>
      </div>
      <select id="selectTrailer" class="form-select">${trailerSelectOpts || '<option value="">No videos found</option>'}</select>
    </div>

    <div class="form-group full-width" style="margin-bottom: 12px;">
      <label class="form-label" for="inputTrailerUrl">Trailer link / YouTube video URL</label>
      <input type="text" id="inputTrailerUrl" class="form-input" value="${escapeHTML(activeTrailerUrl)}" placeholder="https://www.youtube.com/watch?v=...">
    </div>

    <div class="form-group full-width" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom: 16px;">
      <label class="checkbox-label">
        <input type="checkbox" id="chkKeepTrailer" ${m.keepTrailer ? 'checked' : ''}>
        Keep my trailer when searching
      </label>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" id="btnUsePastedTrailer">Use pasted link</button>
        <button class="btn btn-secondary btn-sm" id="btnSearchYouTube">Search YouTube API</button>
        ${activeTrailerUrl ? `<a href="${activeTrailerUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Watch ↗</a>` : ''}
        ${activeTrailerUrl ? `<button type="button" class="btn btn-primary btn-sm" id="btnDownloadSingleTrailerVideo" title="Download MP4 trailer video file">⬇ Download Trailer (MP4)</button><button type="button" class="btn btn-secondary btn-sm" id="btnDownloadSingleTrailer" title="Download trailer link shortcut file">⬇ Link (.url)</button>` : ''}
      </div>
    </div>

    ${youtubeVideoId ? `
      <div class="form-group full-width" style="margin-bottom: 16px;">
        <div class="iframe-preview-wrap">
          <iframe src="https://www.youtube-nocookie.com/embed/${youtubeVideoId}" title="YouTube Video Preview" allowfullscreen></iframe>
        </div>
      </div>
    ` : ''}

    <div style="display:flex; gap:12px; margin-bottom:14px; font-size:12px;">
      ${m.id ? `<a href="${tmdbLink}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-green); text-decoration:none;">TMDB ↗</a>` : ''}
      ${m.imdb_id ? `<a href="${imdbLink}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-green); text-decoration:none;">IMDb ↗</a>` : ''}
    </div>
  `;
}

// Bind Artwork Detail Card Events
function bindArtworkDetailCardEvents(card, m) {
  const btnUp = card.querySelector('#btnMoveUp');
  const btnDown = card.querySelector('#btnMoveDown');
  const btnRemove = card.querySelector('#btnRemoveMovie');

  if (btnUp) btnUp.addEventListener('click', () => moveMovieOrder(m.uid, -1, 'artwork'));
  if (btnDown) btnDown.addEventListener('click', () => moveMovieOrder(m.uid, 1, 'artwork'));
  if (btnRemove) btnRemove.addEventListener('click', () => promptRemoveMovie(m, 'artwork'));

  // Search single & Search box trigger
  const triggerArtworkSearch = () => {
    const tVal = card.querySelector('#searchMovieTitle')?.value?.trim();
    const yVal = card.querySelector('#searchMovieYear')?.value?.trim();
    const aVal = card.querySelector('#searchMovieActor')?.value?.trim();
    const pVal = card.querySelector('#searchMovieProduction')?.value?.trim();

    if (tVal) m.title = tVal;
    m.year = yVal || '';
    m.actor = aVal || '';
    m.production = pVal || '';

    fetchMovieMetadata(m);
  };

  const btnSearchArtworkBox = card.querySelector('#btnSearchArtworkBox');
  if (btnSearchArtworkBox) btnSearchArtworkBox.addEventListener('click', triggerArtworkSearch);

  const btnSearchSingle = card.querySelector('#btnSearchSingle');
  if (btnSearchSingle) btnSearchSingle.addEventListener('click', triggerArtworkSearch);

  // Language buttons in Artwork Search Box
  card.querySelectorAll('.quick-lang-buttons .btn-quick-lang').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      m.language = btn.dataset.lang || '';
      triggerArtworkSearch();
    });
  });

  const selArtworkLang = card.querySelector('#selectArtworkSearchLang');
  if (selArtworkLang) {
    selArtworkLang.addEventListener('change', (e) => {
      m.language = e.target.value;
      triggerArtworkSearch();
    });
  }

  // Search box Enter key and live input sync
  ['#searchMovieTitle', '#searchMovieYear', '#searchMovieActor', '#searchMovieProduction'].forEach(sel => {
    const inp = card.querySelector(sel);
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          triggerArtworkSearch();
        }
      });
      inp.addEventListener('change', () => {
        if (sel === '#searchMovieTitle') m.title = inp.value.trim() || m.title;
        else if (sel === '#searchMovieYear') m.year = inp.value.trim();
        else if (sel === '#searchMovieActor') m.actor = inp.value.trim();
        else if (sel === '#searchMovieProduction') m.production = inp.value.trim();
      });
    }
  });

  // Match select
  const selectMatch = card.querySelector('#selectMovieMatch');
  if (selectMatch) {
    selectMatch.addEventListener('change', async (e) => {
      const matchId = e.target.value;
      if (matchId) await loadMovieDetailFromTMDB(m, matchId);
    });
  }

  // Language select
  const selLang = card.querySelector('#selectLanguage');
  if (selLang) {
    selLang.addEventListener('change', async (e) => {
      m.language = e.target.value;
      if (m.id) await loadMovieDetailFromTMDB(m, m.id);
    });
  }

  // Artwork selects
  const selPoster = card.querySelector('#selectPoster');
  const selBackdrop = card.querySelector('#selectBackdrop');
  const selLogo = card.querySelector('#selectLogo');

  if (selPoster) selPoster.addEventListener('change', (e) => {
    m.selectedPoster = e.target.value;
    m.posterUrl = e.target.value;
    m.poster_url = e.target.value;
    updateAllUI();
  });
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
          m.poster_url = evt.target.result;
          m.selectedPoster = evt.target.result;
          m.keepPoster = true;
          showNotice('Custom poster uploaded and selected.');
          updateAllUI();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Download current poster directly
  const btnDownloadPoster = card.querySelector('#btnDownloadCurrentPoster');
  if (btnDownloadPoster) {
    btnDownloadPoster.addEventListener('click', () => {
      const pUrl = m.posterUrl || m.selectedPoster || m.poster_url;
      if (!pUrl) {
        showNotice('No poster image available to download.', 'error');
        return;
      }
      downloadFileFromUrl(pUrl, `${cleanFileName(m.title)}_poster.jpg`);
    });
  }

  // Download individual art slot items (Poster, Backdrop, Logo)
  card.querySelectorAll('.btn-download-art').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const name = btn.dataset.name || 'artwork.jpg';
      if (!url) {
        showNotice('No image URL found to download.', 'error');
        return;
      }
      downloadFileFromUrl(url, cleanFileName(name));
    });
  });

  // Apply Changes button
  const btnApply = card.querySelector('#btnApplyMovieChanges');
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      m.title = card.querySelector('#inputMovieTitle').value.trim() || m.title;
      m.year = card.querySelector('#inputYear').value.trim();
      m.language = card.querySelector('#inputLanguage').value.trim();
      const distInput = card.querySelector('#inputDistributor');
      if (distInput) m.distributor = distInput.value.trim();
      const pInput = card.querySelector('#inputPosterUrl');
      if (pInput) {
        m.posterUrl = pInput.value.trim();
        m.poster_url = pInput.value.trim();
        m.selectedPoster = pInput.value.trim();
      }

      const keepPosterChk = card.querySelector('#chkKeepPoster');
      if (keepPosterChk) m.keepPoster = keepPosterChk.checked;

      showNotice(`Artwork details updated for "${m.title}".`);
      updateAllUI();
    });
  }
}

// Bind Trailer Detail Card Events
function bindTrailerDetailCardEvents(card, m) {
  const btnUp = card.querySelector('#btnMoveUp');
  const btnDown = card.querySelector('#btnMoveDown');
  const btnRemove = card.querySelector('#btnRemoveMovie');

  if (btnUp) btnUp.addEventListener('click', () => moveMovieOrder(m.uid, -1, 'trailers'));
  if (btnDown) btnDown.addEventListener('click', () => moveMovieOrder(m.uid, 1, 'trailers'));
  if (btnRemove) btnRemove.addEventListener('click', () => promptRemoveMovie(m, 'trailers'));

  // Search single & Search box trigger with media category (all, trailer, teaser, song, promo)
  const triggerTrailerSearch = async (mediaCategory = 'all') => {
    const tVal = card.querySelector('#searchMovieTitle')?.value?.trim();
    const yVal = card.querySelector('#searchMovieYear')?.value?.trim();
    const aVal = card.querySelector('#searchMovieActor')?.value?.trim();
    const pVal = card.querySelector('#searchMovieProduction')?.value?.trim();

    if (tVal) m.title = tVal;
    m.year = yVal || '';
    m.actor = aVal || '';
    m.production = pVal || '';

    // Search TMDB metadata & videos
    await fetchMovieMetadata(m);

    // Also search YouTube with enriched title + year + actor + production + category
    const ytKey = (localStorage.getItem('user_youtube_api_key') || '').trim();
    if (state.status.youtube || ytKey) {
      try {
        const fullQ = [m.title, m.year, m.actor, m.production].filter(Boolean).join(' ');
        const catParam = mediaCategory ? `&category=${encodeURIComponent(mediaCategory)}` : '';
        const langParam = m.language ? `&language=${encodeURIComponent(m.language)}` : '';
        const res = await apiFetch(`/api/youtube?q=${encodeURIComponent(fullQ)}&year=${encodeURIComponent(m.year || '')}&actor=${encodeURIComponent(m.actor || '')}&production=${encodeURIComponent(m.production || '')}${catParam}${langParam}`);
        const data = await res.json();
        if (data.videos && data.videos.length > 0) {
          m.videos = m.videos || [];
          const existingUrls = new Set(m.videos.map(v => v.url));
          const newVids = data.videos.filter(v => !existingUrls.has(v.url));
          m.videos.unshift(...newVids);
          if (!m.keepTrailer && newVids.length > 0) {
            m.selectedTrailer = newVids[0].url;
            m.trailerUrl = newVids[0].url;
            m.trailer_url = newVids[0].url;
          }
          showNotice(`Found ${newVids.length} new ${mediaCategory === 'all' ? 'video' : mediaCategory}(s)!`);
          updateAllUI();
        }
      } catch {}
    }
  };

  const btnSearchTrailerBox = card.querySelector('#btnSearchTrailerBox');
  if (btnSearchTrailerBox) btnSearchTrailerBox.addEventListener('click', () => triggerTrailerSearch('all'));

  const btnSearchSingle = card.querySelector('#btnSearchSingle');
  if (btnSearchSingle) btnSearchSingle.addEventListener('click', () => triggerTrailerSearch('all'));

  // Find media buttons (All, Trailers, Teasers, Songs, Promos)
  card.querySelectorAll('.btn-find-media').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.category || 'all';
      triggerTrailerSearch(cat);
    });
  });

  // Language buttons in Trailer Search Box
  card.querySelectorAll('.quick-lang-buttons .btn-quick-lang').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      m.language = btn.dataset.lang || '';
      triggerTrailerSearch('all');
    });
  });

  const selTrailerLang = card.querySelector('#selectTrailerSearchLang');
  if (selTrailerLang) {
    selTrailerLang.addEventListener('change', (e) => {
      m.language = e.target.value;
      triggerTrailerSearch('all');
    });
  }

  // Video category filter pills
  card.querySelectorAll('.btn-video-filter').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      card.querySelectorAll('.btn-video-filter').forEach(p => p.classList.remove('active', 'btn-primary'));
      pill.classList.add('active', 'btn-primary');
      const filterCat = pill.dataset.cat;
      const selectEl = card.querySelector('#selectTrailer');
      if (!selectEl) return;
      Array.from(selectEl.options).forEach(opt => {
        if (!opt.dataset.category) return;
        if (filterCat === 'all' || opt.dataset.category === filterCat) {
          opt.style.display = '';
        } else {
          opt.style.display = 'none';
        }
      });
      if (selectEl.selectedOptions[0]?.style.display === 'none') {
        const firstVisible = Array.from(selectEl.options).find(o => o.style.display !== 'none');
        if (firstVisible) {
          selectEl.value = firstVisible.value;
          m.selectedTrailer = firstVisible.value;
          m.trailerUrl = firstVisible.value;
          m.trailer_url = firstVisible.value;
          updateAllUI();
        }
      }
    });
  });

  // Search box Enter key and live input sync
  ['#searchMovieTitle', '#searchMovieYear', '#searchMovieActor', '#searchMovieProduction'].forEach(sel => {
    const inp = card.querySelector(sel);
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          triggerTrailerSearch();
        }
      });
      inp.addEventListener('change', () => {
        if (sel === '#searchMovieTitle') m.title = inp.value.trim() || m.title;
        else if (sel === '#searchMovieYear') m.year = inp.value.trim();
        else if (sel === '#searchMovieActor') m.actor = inp.value.trim();
        else if (sel === '#searchMovieProduction') m.production = inp.value.trim();
      });
    }
  });

  // Match select
  const selectMatch = card.querySelector('#selectMovieMatch');
  if (selectMatch) {
    selectMatch.addEventListener('change', async (e) => {
      const matchId = e.target.value;
      if (matchId) await loadMovieDetailFromTMDB(m, matchId);
    });
  }

  // Language select
  const selLang = card.querySelector('#selectLanguage');
  if (selLang) {
    selLang.addEventListener('change', async (e) => {
      m.language = e.target.value;
      if (m.id) await loadMovieDetailFromTMDB(m, m.id);
    });
  }

  // Video select
  const selTrailer = card.querySelector('#selectTrailer');
  if (selTrailer) {
    selTrailer.addEventListener('change', (e) => {
      m.selectedTrailer = e.target.value;
      m.trailerUrl = e.target.value;
      m.trailer_url = e.target.value;
      updateAllUI();
    });
  }

  // Use pasted link button
  const btnPastedTrailer = card.querySelector('#btnUsePastedTrailer');
  const inputTrailerUrl = card.querySelector('#inputTrailerUrl');
  if (btnPastedTrailer && inputTrailerUrl) {
    btnPastedTrailer.addEventListener('click', () => {
      const val = inputTrailerUrl.value.trim();
      m.trailerUrl = val;
      m.trailer_url = val;
      m.selectedTrailer = val;
      showNotice('Pasted trailer link applied.');
      updateAllUI();
    });
  }

  // Search YouTube API button
  const btnYouTube = card.querySelector('#btnSearchYouTube');
  if (btnYouTube) {
    btnYouTube.addEventListener('click', async () => {
      const ytKey = (localStorage.getItem('user_youtube_api_key') || '').trim();
      if (!state.status.youtube && !ytKey) {
        showNotice('YouTube API key is missing. Set key in Connection Details to search.', 'error');
        return;
      }
      const fullQ = [m.title, m.year, m.actor, m.production].filter(Boolean).join(' ');
      showNotice(`Searching YouTube for ${fullQ}...`);
      try {
        const res = await apiFetch(`/api/youtube?q=${encodeURIComponent(fullQ)}&year=${encodeURIComponent(m.year || '')}&actor=${encodeURIComponent(m.actor || '')}&production=${encodeURIComponent(m.production || '')}`);
        const data = await res.json();
        if (data.videos && data.videos.length > 0) {
          m.videos = m.videos || [];
          m.videos.push(...data.videos);
          m.selectedTrailer = data.videos[0].url;
          m.trailerUrl = data.videos[0].url;
          m.trailer_url = data.videos[0].url;
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

  // Download single trailer video file (MP4)
  const btnDownloadSingleTrailerVideo = card.querySelector('#btnDownloadSingleTrailerVideo');
  if (btnDownloadSingleTrailerVideo) {
    btnDownloadSingleTrailerVideo.addEventListener('click', () => {
      const tUrl = m.trailerUrl || m.selectedTrailer || m.trailer_url;
      if (!tUrl) {
        showNotice('No trailer link available to download.', 'error');
        return;
      }
      downloadTrailerVideo(m.title, tUrl);
    });
  }

  // Download single trailer shortcut file (.url)
  const btnDownloadSingleTrl = card.querySelector('#btnDownloadSingleTrailer');
  if (btnDownloadSingleTrl) {
    btnDownloadSingleTrl.addEventListener('click', () => {
      const tUrl = m.trailerUrl || m.selectedTrailer || m.trailer_url;
      if (!tUrl) {
        showNotice('No trailer link available to download.', 'error');
        return;
      }
      downloadTrailerShortcut(m.title, tUrl);
    });
  }

  // Apply Changes button
  const btnApply = card.querySelector('#btnApplyMovieChanges');
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      m.title = card.querySelector('#inputMovieTitle').value.trim() || m.title;
      m.year = card.querySelector('#inputYear').value.trim();
      m.language = card.querySelector('#inputLanguage').value.trim();

      const tInput = card.querySelector('#inputTrailerUrl');
      if (tInput) {
        m.trailerUrl = tInput.value.trim();
        m.trailer_url = tInput.value.trim();
        m.selectedTrailer = tInput.value.trim();
      }

      const keepTrailerChk = card.querySelector('#chkKeepTrailer');
      if (keepTrailerChk) m.keepTrailer = keepTrailerChk.checked;

      showNotice(`Trailer details updated for "${m.title}".`);
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
    let searchData = null;
    try {
      const searchUrl = `/api/search?q=${encodeURIComponent(m.title)}${m.year ? `&year=${encodeURIComponent(m.year)}` : ''}${m.language ? `&language=${encodeURIComponent(m.language)}` : ''}${m.actor ? `&actor=${encodeURIComponent(m.actor)}` : ''}${m.production ? `&production=${encodeURIComponent(m.production)}` : ''}`;
      const searchRes = await apiFetch(searchUrl);
      if (searchRes.ok) searchData = await searchRes.json();
    } catch {}

    // Direct browser TMDB query fallback if server route had an issue
    if (!searchData || !searchData.results) {
      const customTmdb = (localStorage.getItem('user_tmdb_api_key') || '').trim();
      if (customTmdb) {
        try {
          const directUrl = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(customTmdb)}&query=${encodeURIComponent(m.title)}${m.year ? `&year=${encodeURIComponent(m.year)}` : ''}&include_adult=false`;
          const directRes = await fetch(directUrl);
          if (directRes.ok) {
            const rawData = await directRes.json();
            searchData = { results: rawData.results || [] };
          }
        } catch {}
      }
    }

    if (!searchData || !searchData.results || searchData.results.length === 0) {
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
    let data = null;
    try {
      const detailUrl = `/api/movie/${tmdbId}${m.language ? `?language=${m.language}` : ''}`;
      const res = await apiFetch(detailUrl);
      if (res.ok) data = await res.json();
    } catch {}

    // Direct browser TMDB detail fallback
    if (!data || !data.movie) {
      const customTmdb = (localStorage.getItem('user_tmdb_api_key') || '').trim();
      if (customTmdb) {
        try {
          const directUrl = `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(customTmdb)}&append_to_response=images,videos`;
          const directRes = await fetch(directUrl);
          if (directRes.ok) {
            const mRaw = await directRes.json();
            const posters = (mRaw.images?.posters || []).map(p => ({
              url: `https://image.tmdb.org/t/p/w500${p.file_path}`,
              width: p.width,
              height: p.height
            }));
            const vids = (mRaw.videos?.results || []).filter(v => v.site === 'YouTube').map(v => ({
              name: v.name,
              url: `https://www.youtube.com/watch?v=${v.key}`,
              type: v.type
            }));
            data = {
              movie: {
                id: mRaw.id,
                title: mRaw.title,
                year: mRaw.release_date?.slice(0, 4) || '',
                original_language: mRaw.original_language,
                imdb_id: mRaw.imdb_id,
                overview: mRaw.overview
              },
              images: { poster: posters, backdrop: [], logo: [] },
              videos: vids
            };
          }
        } catch {}
      }
    }

    if (!data || !data.movie) {
      throw new Error('Failed to load movie details');
    }

    m.id = data.movie.id;
    m.imdb_id = data.movie.imdb_id;
    m.overview = data.movie.overview || m.overview || '';
    if (!m.year && data.movie.year) m.year = data.movie.year;
    if (!m.actor && data.movie.actor) m.actor = data.movie.actor;
    if (!m.production && data.movie.production) m.production = data.movie.production;
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
      let tUrl = m.videos?.[0]?.url || null;
      // If TMDB had no videos, automatically search YouTube so every movie gets a working trailer
      if (!tUrl) {
        try {
          const ytUrl = `/api/youtube?q=${encodeURIComponent(m.title)}${m.year ? `&year=${encodeURIComponent(m.year)}` : ''}${m.actor ? `&actor=${encodeURIComponent(m.actor)}` : ''}${m.production ? `&production=${encodeURIComponent(m.production)}` : ''}`;
          const ytRes = await apiFetch(ytUrl);
          if (ytRes.ok) {
            const ytData = await ytRes.json();
            if (ytData.videos && ytData.videos.length > 0) {
              m.videos = ytData.videos;
              tUrl = ytData.videos[0].url;
            }
          }
        } catch {}
      }
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
async function extractPdfTextClient(file) {
  // Method 1: Client-side PDF.js parsing
  try {
    if (!window.pdfjsLib) {
      await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = () => resolve();
        script.onerror = () => resolve();
        setTimeout(resolve, 2000);
        document.head.appendChild(script);
      });
    }

    if (window.pdfjsLib) {
      if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      const textLines = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const lines = [];
        for (const item of textContent.items) {
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
          textLines.push(s);
        }
      }
      const fullText = textLines.join('\n').trim();
      if (fullText && fullText.length > 15) return fullText;
    }
  } catch (err) {
    console.warn('In-browser PDF.js parse skipped:', err);
  }

  // Method 2: Fast PDF text stream extractor
  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let str = '';
    const maxBytes = Math.min(bytes.length, 6 * 1024 * 1024);
    for (let i = 0; i < maxBytes; i++) {
      str += String.fromCharCode(bytes[i]);
    }
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
    const fallback = textBlocks.join('\n').trim();
    if (fallback && fallback.length > 25) return fallback;
  } catch (err) {
    console.warn('Fast PDF text stream parser failed:', err);
  }

  return null;
}

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

      // Step 1: Try instant in-browser client-side extraction
      try {
        text = await extractPdfTextClient(file);
      } catch (err) {
        console.warn('Client extraction error:', err);
      }

      // Step 2: Fall back to backend /api/pdf endpoint if client-side did not get text
      if (!text || text.trim().length < 15) {
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
            throw new Error('This PDF has no selectable text (scanned image). Please use selectable text or OCR first.');
          }
          throw new Error(data.error || 'Failed to extract text from PDF.');
        }
        text = data.text || '';
      }
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
                const res = await apiFetch(`/api/fetch-movie-assets?title=${encodeURIComponent(m.title)}&year=${encodeURIComponent(m.year || '')}&language=${encodeURIComponent(m.language || '')}`);
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

    let posterVal = document.getElementById('nlDetailPosterUrl')?.value.trim() || '';
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
    const posterInput = document.getElementById('nlDetailPosterUrl');
    if (posterInput) posterInput.value = dataUrl;
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
  const trailerEl = document.getElementById('nlDetailTrailerUrl');

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

  if (posterEl) {
    posterEl.value = m.poster_url || m.posterUrl || m.selectedPoster || m.poster_remote || m.images?.poster?.[0]?.url || '';
  }

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

// Download Artwork ZIP strictly from selected artwork.movies
async function downloadArtworkZIP() {
  const assets = [];
  const allMovies = state.artwork?.movies || [];
  const checkedMovies = allMovies.filter(m => m.checked !== false);
  const moviesToExport = checkedMovies.length > 0 ? checkedMovies : allMovies;

  moviesToExport.forEach(m => {
    const poster = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url;
    if (poster) assets.push({ name: `${cleanFileName(m.title)}_poster`, url: poster });
    const backdrop = m.selectedBackdrop || m.images?.backdrop?.[0]?.url;
    if (backdrop) assets.push({ name: `${cleanFileName(m.title)}_backdrop`, url: backdrop });
    const logo = m.selectedLogo || m.images?.logo?.[0]?.url;
    if (logo) assets.push({ name: `${cleanFileName(m.title)}_logo`, url: logo });
  });

  if (assets.length === 0) {
    showNotice('No artwork available for selected movies in Artwork Studio.', 'error');
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
    a.download = 'selected-movie-artwork.zip';
    a.click();
    URL.revokeObjectURL(url);
    showNotice(`Downloaded selected artwork ZIP (${assets.length} image(s)).`);
  } catch (err) {
    showNotice(`ZIP Error: ${err.message}`, 'error');
  }
}

// Clean file name for safe filesystem saving
function cleanFileName(str) {
  return (str || 'file').replace(/[/\\?%*:|"<>]/g, '_').trim();
}

// Download single file directly via blob or link
async function downloadFileFromUrl(fileUrl, defaultFilename = 'download.jpg') {
  showNotice(`Downloading ${defaultFilename}...`);
  try {
    // If it's a data URL, directly download
    if (fileUrl.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = fileUrl;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showNotice(`Downloaded ${defaultFilename}.`);
      return;
    }

    // Try fetching as blob to trigger direct browser save without opening new tab
    const res = await fetch(fileUrl, { mode: 'cors' }).catch(() => null);
    if (res && res.ok) {
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      showNotice(`Downloaded ${defaultFilename}.`);
      return;
    }
  } catch (err) {
    console.warn('Direct blob download notice:', err);
  }

  // Fallback: direct anchor download attribute or window link
  const a = document.createElement('a');
  a.href = fileUrl;
  a.download = defaultFilename;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showNotice(`Download initiated for ${defaultFilename}.`);
}

// Open in-app trailer video player modal
function openTrailerPlayerModal(title, trailerUrl) {
  if (!trailerUrl) {
    showNotice('No trailer URL available to play.', 'error');
    return;
  }

  const modal = document.getElementById('trailerPlayerModal');
  const titleEl = document.getElementById('trailerPlayerTitle');
  const iframe = document.getElementById('trailerPlayerIframe');
  const urlText = document.getElementById('trailerPlayerUrlText');

  if (!modal || !iframe) return;

  const videoIdMatch = trailerUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  const videoId = videoIdMatch ? videoIdMatch[1] : '';

  if (titleEl) titleEl.textContent = `${title} - Official Trailer`;
  if (urlText) urlText.textContent = trailerUrl;

  if (videoId) {
    iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;
  } else {
    iframe.src = trailerUrl;
  }

  // Set up copy and download buttons on player
  const btnCopy = document.getElementById('btnCopyPlayerTrailerLink');
  if (btnCopy) {
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(trailerUrl);
        showNotice('Trailer link copied to clipboard!');
      } catch {
        showNotice(`Trailer URL: ${trailerUrl}`);
      }
    };
  }

  const btnDlMp4 = document.getElementById('btnDownloadPlayerTrailerMp4');
  if (btnDlMp4) {
    btnDlMp4.onclick = () => {
      downloadTrailerVideo(title, trailerUrl);
    };
  }

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  }
}

function closeTrailerPlayerModal() {
  const modal = document.getElementById('trailerPlayerModal');
  const iframe = document.getElementById('trailerPlayerIframe');
  if (iframe) iframe.src = '';
  if (modal && typeof modal.close === 'function') {
    modal.close();
  }
}

// Download direct MP4 trailer video cleanly with full binary validation
async function downloadTrailerVideo(title, trailerUrl) {
  if (!trailerUrl) {
    showNotice('No trailer URL available to download.', 'error');
    return;
  }

  const safeFilename = `${cleanFileName(title)} Trailer.mp4`;
  showNotice(`Requesting MP4 video stream for "${title}"... Please wait.`);

  const downloadApiUrl = `/api/download-trailer?url=${encodeURIComponent(trailerUrl)}&title=${encodeURIComponent(title)}`;

  try {
    const res = await fetch(downloadApiUrl);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // 1. Direct streamed video MP4 binary from server
    if (res.ok && (contentType.includes('video') || contentType.includes('mp4') || contentType.includes('octet-stream'))) {
      const rawBlob = await res.blob();
      if (rawBlob.size < 50000) {
        showNotice(`Stream incomplete (${Math.round(rawBlob.size/1024)} KB). Link copied to clipboard for IDM / 4K Downloader.`, 'error');
        try { await navigator.clipboard.writeText(trailerUrl); } catch {}
        return;
      }

      const videoBlob = new Blob([rawBlob], { type: 'video/mp4' });
      const objUrl = URL.createObjectURL(videoBlob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = safeFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
      showNotice(`Downloaded "${safeFilename}" (${(rawBlob.size / (1024*1024)).toFixed(1)} MB)!`);
      return;
    }

    // 2. Server returned error / restriction notice
    const errData = await res.json().catch(() => ({}));
    showNotice(errData.error || 'YouTube cloud download restricted. Trailer link copied to clipboard!', 'error');
    try { await navigator.clipboard.writeText(trailerUrl); } catch {}
  } catch (err) {
    console.warn('Trailer download fetch error:', err);
    showNotice('Download error. Trailer link copied to clipboard for IDM / 4K Downloader.', 'error');
    try { await navigator.clipboard.writeText(trailerUrl); } catch {}
  }
}

// Open clean Bulk MP4 Trailer Downloader modal for selected movies
function downloadSelectedTrailersVideo() {
  const allMovies = state.trailers?.movies || [];
  const checkedMovies = allMovies.filter(m => m.checked !== false);
  const moviesToExport = checkedMovies.length > 0 ? checkedMovies : allMovies;

  const validTrailers = moviesToExport.filter(m => !!(m.trailerUrl || m.selectedTrailer || m.trailer_url || (m.videos && m.videos[0]?.url)));

  if (validTrailers.length === 0) {
    showNotice('No trailer video links found for selected movies in Trailer Studio.', 'error');
    return;
  }

  const modal = document.getElementById('bulkTrailerModal');
  const itemsList = document.getElementById('bulkTrailerItemsList');

  if (modal && itemsList) {
    itemsList.innerHTML = validTrailers.map((m, idx) => {
      const safeTitle = escapeHTML(m.title);
      const yearStr = m.year ? ` (${escapeHTML(m.year)})` : '';
      const url = m.trailerUrl || m.selectedTrailer || m.trailer_url || (m.videos && m.videos[0]?.url);

      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:6px; font-size:13px; gap:8px; flex-wrap:wrap;">
          <div style="flex:1; min-width:180px;">
            <div style="font-weight:600; color:var(--text-color, #111827);">${idx + 1}. ${safeTitle}${yearStr}</div>
            <div style="font-size:11px; color:var(--muted-text, #6b7280); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:320px;">${escapeHTML(url)}</div>
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary btn-sm btn-play-inapp" data-title="${escapeHTML(m.title)}" data-url="${escapeHTML(url)}">▶ Play In-App</button>
            <button type="button" class="btn btn-secondary btn-sm btn-dl-inapp" data-title="${escapeHTML(m.title)}" data-url="${escapeHTML(url)}">⬇ Download MP4</button>
            <button type="button" class="btn btn-secondary btn-sm btn-copy-inapp" data-url="${escapeHTML(url)}">📋 Copy Link</button>
          </div>
        </div>
      `;
    }).join('');

    itemsList.querySelectorAll('.btn-play-inapp').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget.getAttribute('data-title');
        const u = e.currentTarget.getAttribute('data-url');
        if (t && u) openTrailerPlayerModal(t, u);
      });
    });

    itemsList.querySelectorAll('.btn-dl-inapp').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget.getAttribute('data-title');
        const u = e.currentTarget.getAttribute('data-url');
        if (t && u) downloadTrailerVideo(t, u);
      });
    });

    itemsList.querySelectorAll('.btn-copy-inapp').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const u = e.currentTarget.getAttribute('data-url');
        if (u) {
          try {
            await navigator.clipboard.writeText(u);
            showNotice('Trailer link copied to clipboard!');
          } catch {
            showNotice(`Trailer link: ${u}`);
          }
        }
      });
    });

    if (typeof modal.showModal === 'function') {
      modal.showModal();
    }
  }

  showNotice(`Opened Bulk MP4 Trailer Downloader for ${validTrailers.length} movie(s).`);
}

// Download single trailer shortcut file (.url format supported across Windows/Mac/Linux)
function downloadTrailerShortcut(title, trailerUrl) {
  const safeTitle = cleanFileName(title);
  const content = `[InternetShortcut]\r\nURL=${trailerUrl}\r\n`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeTitle} Trailer.url`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotice(`Downloaded trailer link for "${title}".`);
}

// Download all posters from selected Artwork collection as a ZIP or sequential files
async function downloadAllPosters() {
  const allMovies = state.artwork?.movies || [];
  const checkedMovies = allMovies.filter(m => m.checked !== false);
  const moviesToExport = checkedMovies.length > 0 ? checkedMovies : allMovies;

  const posters = moviesToExport
    .map(m => ({
      name: `${cleanFileName(m.title)}_poster`,
      url: m.posterUrl || m.selectedPoster || m.poster_url || m.images?.poster?.[0]?.url
    }))
    .filter(p => !!p.url);

  if (posters.length === 0) {
    showNotice('No posters found for selected movies in Artwork Studio.', 'error');
    return;
  }

  showNotice(`Downloading ${posters.length} selected poster(s)...`);

  // Try creating ZIP via server endpoint
  try {
    const res = await fetch('/api/artwork.zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets: posters })
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'selected-movie-posters.zip';
      a.click();
      URL.revokeObjectURL(url);
      showNotice(`Downloaded ${posters.length} poster(s) in selected-movie-posters.zip!`);
      return;
    }
  } catch (err) {
    console.warn('ZIP fallback to individual downloads:', err);
  }

  // Fallback: download posters individually
  for (let i = 0; i < Math.min(posters.length, 10); i++) {
    const p = posters[i];
    await downloadFileFromUrl(p.url, `${p.name}.jpg`);
  }
}

// Download trailer links collection as formatted text
function downloadAllTrailerLinks() {
  const allMovies = state.trailers?.movies || [];
  const checkedMovies = allMovies.filter(m => m.checked !== false);
  const moviesToExport = checkedMovies.length > 0 ? checkedMovies : allMovies;

  const trailers = moviesToExport
    .map(m => ({
      title: m.title,
      year: m.year,
      url: m.trailerUrl || m.selectedTrailer || m.trailer_url || (m.videos && m.videos[0]?.url)
    }))
    .filter(t => !!t.url);

  if (trailers.length === 0) {
    showNotice('No trailer links found for selected movies in Trailer Studio.', 'error');
    return;
  }

  // Create clean text file list + web links
  const lines = [
    `# ============================================================`,
    `# QUBE MOVIE STUDIO - SELECTED TRAILER & TEASER LINKS`,
    `# Generated: ${new Date().toLocaleString()}`,
    `# Selected Titles: ${trailers.length}`,
    `# ============================================================`,
    ``
  ];

  trailers.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title}${t.year ? ` (${t.year})` : ''}`);
    lines.push(`   Link: ${t.url}`);
    lines.push(``);
  });

  const textContent = lines.join('\n');
  const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'selected-movie-trailers.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotice(`Downloaded trailer links file for ${trailers.length} selected movie(s).`);
}

// Export CSV Report strictly for selected movies in targeted tool
function exportCSVReport(tool = state.activeTab) {
  const targetTool = (tool === 'trailers') ? 'trailers' : 'artwork';
  const allMovies = state[targetTool]?.movies || [];
  const checkedMovies = allMovies.filter(m => m.checked !== false);
  const movies = checkedMovies.length > 0 ? checkedMovies : allMovies;

  if (movies.length === 0) {
    showNotice(`No movies to export in ${toolDisplayName(targetTool)}.`, 'error');
    return;
  }

  const headers = ['Title', 'Year', 'Actor', 'Production', 'Language', 'Distributor', 'Poster URL', 'Trailer URL', 'Feature Duration', 'CPL Part 1 Duration', 'CPL Part 2 Duration', 'Synopsis'];
  const rows = [headers.join(',')];

  movies.forEach(m => {
    const poster = m.posterUrl || m.selectedPoster || m.images?.poster?.[0]?.url || '';
    const trailer = m.trailerUrl || m.selectedTrailer || m.videos?.[0]?.url || '';
    const row = [
      escapeCSV(m.title),
      escapeCSV(m.year),
      escapeCSV(m.actor || ''),
      escapeCSV(m.production || m.distributor || ''),
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
  a.download = `selected-${targetTool}-report.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice(`${toolDisplayName(targetTool)} CSV report exported for ${movies.length} selected movie(s).`);
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
