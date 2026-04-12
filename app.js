/* ================================================================
   app.js — CampusLink Main Application Logic (Firebase ES Module)
   ================================================================ */
import { auth, db, storage, googleProvider } from './firebase-config.js';
import { CLOUDINARY_CONFIG } from './cloudinary-config.js';
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, where, increment, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import {
  ref, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

// Import Custom Modules
import { initEvents } from './events.js';


/* ════════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */
let unsubPosts = null;
let unsubNotifsList = null;
let unsubNotifsUnread = null;
let unsubMessages = null;
let unsubChallenges = null;
let toastTimer = null;
const commentUnsubs = {};
let currentSearchCategory = 'all';
let currentSearchQuery = '';
let currentSavedFilter = 'all';
let currentCalendarDate = new Date();
let selectedCalendarDate = new Date();
let viewingUserId = null;
let unreadNotifIds = [];
let unreadMessageIds = [];

// ── App State Manager (Simulated React state) ──
const state = {
  activeTab: 'feed',
  isLoading: true,
  lastUpdate: Date.now(),
  userProfile: null,
  currentUser: null,
  posts: [],
  notifications: [],
  messages: [],
  savedPostIds: new Set(),
  followedUsers: new Set(),
  notifDropOpen: false,
  msgDropOpen: false,
  currentPostType: 'text',
  challenges: [],
};

/**
 * Centralized state updater that triggers UI re-renders
 * Similar to React's setState
 */
function setState(newState) {
  const oldState = { ...state };
  Object.assign(state, newState);
  state.lastUpdate = Date.now();

  // Backward compatibility for modules using global variables
  if (newState.posts) window.posts = state.posts;
  if (newState.currentUser) window.currentUser = state.currentUser;
  if (newState.userProfile) window.userProfile = state.userProfile;

  // Trigger targeted UI updates based on what changed
  if (newState.activeTab !== undefined && newState.activeTab !== oldState.activeTab) {
    updateTabUI(state.activeTab);
  }

  if (newState.isLoading !== undefined) {
    toggleLoadingUI(state.isLoading);
  }

  if (newState.posts !== undefined) {
    renderPosts();
    if (state.activeTab === 'events' && typeof window.renderEvents === 'function') window.renderEvents(state.posts);
    if (state.activeTab === 'myposts') renderMyPosts();
  }

  if (newState.userProfile !== undefined) {
    updateProfileUI();
  }

  if (newState.challenges !== undefined) {
    renderChHome();
  }
}window.setState = setState;

function toggleLoadingUI(isLoading) {
  const sk = document.getElementById('lsbSkeleton');
  const cnt = document.getElementById('lsbContent');
  const postSk = document.getElementById('postsSkeleton');
  const postCnt = document.getElementById('postsContainer');

  if (isLoading) {
    if (sk) sk.classList.remove('hidden');
    if (cnt) cnt.classList.add('hidden');
    if (postSk) postSk.classList.remove('hidden');
    if (postCnt) postCnt.classList.add('hidden');
  } else {
    if (sk) sk.classList.add('hidden');
    if (cnt) cnt.classList.remove('hidden');
    if (postSk) postSk.classList.add('hidden');
    if (postCnt) postCnt.classList.remove('hidden');
  }
}

/* ════════════════════════════════════════════════════════════════
   THEME NAMES MAP
═══════════════════════════════════════════════════════════════ */
const THEMES = {
  classic: 'Classic', emerald: 'Emerald', ocean: 'Ocean', violet: 'Violet',
  midnight: 'Midnight', rose: 'Rose', solar: 'Solar'
};

/* ════════════════════════════════════════════════════════════════
   AUTH GUARD — redirect to login if not signed in
═══════════════════════════════════════════════════════════════ */
onAuthStateChanged(auth, async user => {
  if (!user) {
    if (window.location.pathname.includes('login.html')) return;
    window.location.href = 'login.html' + window.location.search;
    return;
  }
  
  try {
    // 1. Load Firestore profile immediately
    const snap = await getDoc(doc(db, 'users', user.uid));
    const data = snap.exists() ? snap.data() : {};
    
    // 2. Load following list
    const followedSet = new Set();
    const followSnap = await getDocs(collection(db, 'users', user.uid, 'following'));
    followSnap.forEach(d => followedSet.add(d.id));

    // 3. Update global state once
    setState({ 
      currentUser: user,
      userProfile: data,
      followedUsers: followedSet,
      isLoading: false
    });

    // 4. Initialize real-time listeners (The "Database Connection") - Only call these once!
    listenPosts();
    listenNotifications();
    listenMessages();
    listenChallenges();
    loadSavedIds();

    initUI();
  } catch (e) { 
    console.error('Initialization error:', e);
    toast('❌ Error connecting to database. Please refresh.');
  }
});

/* ════════════════════════════════════════════════════════════════
   INIT UI  — runs after auth confirmed
═══════════════════════════════════════════════════════════════ */
function initUI() {
  // Restore theme: Firestore profile > localStorage > Default (classic)
  const savedTheme = state.userProfile?.theme || localStorage.getItem('cl_theme') || 'classic';
  applyTheme(savedTheme, null, false);

  // Update profile elements
  const initials = getInitials(state.currentUser?.displayName || state.userProfile?.displayName || 'User');
  const photo = state.currentUser?.photoURL || state.userProfile?.photoURL || '';

  setAvatarEl('navAvatar', initials, photo, false);
  setAvatarEl('lsbAvatar', initials, photo, true);
  setAvatarEl('createAvatar', initials, photo, false);

  const nameEl = document.getElementById('profileName');
  if (nameEl) nameEl.textContent = state.currentUser?.displayName || state.userProfile?.displayName || 'User';

  // Build role line
  const roleParts = [];
  if (state.userProfile?.role) roleParts.push(state.userProfile.role);
  if (state.userProfile?.department) roleParts.push(state.userProfile.department);
  if (state.userProfile?.college) roleParts.push(state.userProfile.college);
  const roleEl = document.getElementById('profileRole');
  if (roleEl) roleEl.textContent = roleParts.length ? roleParts.join(' • ') : 'CampusLink Member';

  const badgeEl = document.getElementById('levelBadge');
  if (badgeEl) badgeEl.textContent = `⭐ Level ${state.userProfile?.level || 1}`;

  // Stats
  const cred = Math.min(100, (state.userProfile?.posts || 0) * 5 + (state.userProfile?.followers || 0));
  const fillEl = document.getElementById('credFill');
  const pctEl = document.getElementById('credPct');
  if (fillEl) fillEl.style.width = cred + '%';
  if (pctEl) pctEl.textContent = cred + '%';

  const sFollowers = document.getElementById('statFollowers');
  const sFollowing = document.getElementById('statFollowing');
  const sPosts = document.getElementById('statPosts');
  if (sFollowers) sFollowers.textContent = fmtNum(state.userProfile?.followers || 0);
  if (sFollowing) sFollowing.textContent = fmtNum(state.userProfile?.following || 0);
  if (sPosts) sPosts.textContent = fmtNum(state.userProfile?.posts || 0);

  if (cnt) cnt.classList.remove('hidden');

  // Hydrate Profile UI (Remove skeletons)
  const sk = document.getElementById('lsbSkeleton');
  if (sk) sk.classList.add('hidden');
  
  // These are now hydrated automatically via listeners called in onAuthStateChanged
  // if (typeof loadChallenges === 'function') loadChallenges();

  // ── Initialize Modules ──
  initEvents({ window, db, auth });

  // ── Switch to Feed tab as the default landing view (if no deep link) ──
  const urlParams = new URLSearchParams(window.location.search);
  const deepLinkPostId = urlParams.get('post') || window.location.hash.replace('#post-', '');
  const userId = urlParams.get('u');

  if (!deepLinkPostId && !userId) {
    const lastPage = sessionStorage.getItem('cl_last_page') || 'feed';
    switchTab(null, lastPage);
  } else {
    // If deep link exists, ensure we are on the appropriate tab
    const targetTab = userId ? 'myposts' : 'feed';
    switchTab(null, targetTab);
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeComposer(); closeLightbox(); closeTheme(); closeNotifDropdown(); closeCalendar(); closeContactModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('globalSearch').focus(); }
  });

  // Handle deep link actions on initial load
  handleDeepLinkActions();

  // Close dropdowns when clicking outside
  document.addEventListener('click', e => {
    const dropN = document.getElementById('notifDropdown');
    const btnN = document.getElementById('notifBtn');
    if (dropN && !dropN.contains(e.target) && !btnN.contains(e.target)) {
      if (typeof closeNotifDropdown === 'function') closeNotifDropdown();
    }

    const dropM = document.getElementById('msgDropdown');
    const btnM = document.getElementById('msgBtn');
    if (dropM && !dropM.contains(e.target) && !btnM.contains(e.target)) {
      if (typeof closeMsgDropdown === 'function') closeMsgDropdown();
    }
  });

  // Search
  const searchInp = document.getElementById('globalSearch');
  if (searchInp) searchInp.addEventListener('input', handleSearch);

  // Calendar
  const calBtn = document.getElementById('eventDateBtn');
  if (calBtn) calBtn.onclick = () => openCalendar();

  const prevM = document.getElementById('prevMonth');
  const nextM = document.getElementById('nextMonth');
  if (prevM) prevM.onclick = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
    renderCalendar();
  };
  if (nextM) nextM.onclick = () => {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
    renderCalendar();
  };

  initScrollHide();
  
  // Set loading to false once UI is initialised
  setState({ isLoading: false });
}

function updateProfileUI() {
  const { userProfile, currentUser } = state;
  if (!userProfile || !currentUser) return;

  const initials = getInitials(currentUser.displayName || userProfile.displayName || 'User');
  const photo = currentUser.photoURL || userProfile.photoURL || '';

  setAvatarEl('navAvatar', initials, photo, false);
  setAvatarEl('lsbAvatar', initials, photo, true);
  setAvatarEl('createAvatar', initials, photo, false);

  const nameEl = document.getElementById('profileName');
  if (nameEl) nameEl.textContent = currentUser.displayName || userProfile.displayName || 'User';

  const roleEl = document.getElementById('profileRole');
  if (roleEl) {
    const roleParts = [];
    if (userProfile.role) roleParts.push(userProfile.role);
    if (userProfile.department) roleParts.push(userProfile.department);
    if (userProfile.college) roleParts.push(userProfile.college);
    roleEl.textContent = roleParts.length ? roleParts.join(' • ') : 'CampusLink Member';
  }

  const badgeEl = document.getElementById('levelBadge');
  if (badgeEl) badgeEl.textContent = `⭐ Level ${userProfile.level || 1}`;

  // Stats
  const cred = Math.min(100, (userProfile.posts || 0) * 5 + (userProfile.followers || 0));
  const fillEl = document.getElementById('credFill');
  const pctEl = document.getElementById('credPct');
  if (fillEl) fillEl.style.width = cred + '%';
  if (pctEl) pctEl.textContent = cred + '%';

  const sFollowers = document.getElementById('statFollowers');
  const sFollowing = document.getElementById('statFollowing');
  const sPosts = document.getElementById('statPosts');
  if (sFollowers) sFollowers.textContent = fmtNum(userProfile.followers || 0);
  if (sFollowing) sFollowing.textContent = fmtNum(userProfile.following || 0);
  if (sPosts) sPosts.textContent = fmtNum(userProfile.posts || 0);

  // Show admin link if admin
  if (userProfile.isAdmin || userProfile.role === 'admin') {
    const adminLink = document.getElementById('adminNavLink');
    const adminMob = document.getElementById('adminNavLinkMobile');
    if (adminLink) { adminLink.classList.remove('hidden'); adminLink.style.display = 'flex'; }
    if (adminMob) { adminMob.classList.remove('hidden'); adminMob.style.display = 'flex'; }
  }
}

/* ════════════════════════════════════════════════════════════════
   SCROLL-HIDE NAV  — slides navbar + page-tabs up, mobile nav down
═══════════════════════════════════════════════════════════════ */
function initScrollHide() {
  const mainHeader = document.querySelector('.main-header');
  const mobileNav = document.querySelector('.mobile-nav');
  const navbar = document.querySelector('.navbar');

  let lastY = window.scrollY;
  let ticking = false;
  const THRESHOLD = 5;
  const TOP_GUARD = 40;

  function onScroll() {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        const currentY = window.scrollY;
        const delta = currentY - lastY;

        // Shadow & Glass Effect (Always active)
        if (currentY > 15) navbar?.classList.add('nav-pinned');
        else navbar?.classList.remove('nav-pinned');

        // Edge case: Ignore if focus is on input field
        const focusEl = document.activeElement;
        const isInteracting = focusEl && (focusEl.tagName === 'INPUT' || focusEl.tagName === 'TEXTAREA' || focusEl.isContentEditable);

        // Hide/Show Logic (Specs request max-width 768px)
        if (window.innerWidth <= 768 && !isInteracting) {
          if (Math.abs(delta) >= THRESHOLD) {
            if (delta > 0 && currentY > TOP_GUARD) {
              // Sliding Down -> Hide
              mainHeader?.classList.add('hide-header');
              mobileNav?.classList.add('hide-bottom-nav');
            } else {
              // Sliding Up -> Show
              mainHeader?.classList.remove('hide-header');
              mobileNav?.classList.remove('hide-bottom-nav');
            }
            lastY = currentY;
          }
        } else {
          // Always show on desktop or when typing
          mainHeader?.classList.remove('hide-header');
          mobileNav?.classList.remove('hide-bottom-nav');
        }
        
        // Safety guard for top of page
        if (currentY <= 5) {
          mainHeader?.classList.remove('hide-header');
          mobileNav?.classList.remove('hide-bottom-nav');
        }

        ticking = false;
      });
      ticking = true;
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ════════════════════════════════════════════════════════════════
   CALENDAR LOGIC
═══════════════════════════════════════════════════════════════ */
window.openCalendar = function () {
  document.getElementById('calendarOverlay').classList.add('open');
  currentCalendarDate = new Date();
  selectedCalendarDate = new Date();
  renderCalendar();
  if (window.renderDateEvents) window.renderDateEvents(selectedCalendarDate, state.posts);
};

window.closeCalendar = function (e) {
  if (!e || e.target.id === 'calendarOverlay' || e.target.className === 'close-btn')
    document.getElementById('calendarOverlay').classList.remove('open');
};

function renderCalendar() {
  const daysContainer = document.getElementById('calendarDays');
  const monthLabel = document.getElementById('currentMonth');
  if (!daysContainer || !monthLabel) return;

  daysContainer.innerHTML = '';
  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  monthLabel.textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(currentCalendarDate);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Empty slots for previous month
  for (let i = 0; i < firstDay; i++) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'cal-day empty';
    daysContainer.appendChild(emptyDiv);
  }

  const today = new Date();

  for (let d = 1; d <= daysInMonth; d++) {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'cal-day';
    dayDiv.textContent = d;

    const date = new Date(year, month, d);

    if (date.toDateString() === today.toDateString()) dayDiv.classList.add('today');
    if (date.toDateString() === selectedCalendarDate.toDateString()) dayDiv.classList.add('selected');

    const hasEvents = typeof window.hasEventsOnDate === 'function' ? window.hasEventsOnDate(date, state.posts) : false;
    if (hasEvents) dayDiv.classList.add('has-event');

    dayDiv.onclick = () => {
      selectedCalendarDate = new Date(year, month, d);
      document.querySelectorAll('.cal-day').forEach(el => el.classList.remove('selected'));
      dayDiv.classList.add('selected');
      if (window.renderDateEvents) window.renderDateEvents(selectedCalendarDate, state.posts);
    };

    daysContainer.appendChild(dayDiv);
  }
}

/* ════════════════════════════════════════════════════════════════
   EMAILJS CONTACT LOGIC
═══════════════════════════════════════════════════════════════ */
// 💡 REPLACE THESE with your EmailJS credentials: https://dashboard.emailjs.com/
const EMAILJS_PUBLIC_KEY = 'Wg09n64IvKke8j7RN';
const EMAILJS_SERVICE_ID = 'service_7n0uxto';
const EMAILJS_TEMPLATE_ID = 'template_uaqr74q';

// Initialize EmailJS safely
if (typeof emailjs !== 'undefined') {
  emailjs.init(EMAILJS_PUBLIC_KEY);
  console.log('✅ EmailJS Initialized');
}

window.openContactModal = function () {
  const overlay = document.getElementById('contactOverlay');
  if (overlay) overlay.classList.add('open');
  // Auto-fill user details if logged in
  if (currentUser) {
    document.getElementById('contactName').value = currentUser.displayName || '';
    document.getElementById('contactEmail').value = currentUser.email || '';
  }
};

window.closeContactModal = function (e) {
  if (!e || e.target.id === 'contactOverlay' || e.target.className === 'close-btn') {
    const overlay = document.getElementById('contactOverlay');
    if (overlay) overlay.classList.remove('open');
  }
};

window.handleContactSubmit = async function (e) {
  e.preventDefault();
  const btn = document.getElementById('contactSubmitBtn');
  const originalText = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending…';

  const formData = {
    user_name: document.getElementById('contactName').value,
    user_email: document.getElementById('contactEmail').value,
    subject: document.getElementById('contactSubject').value,
    message: document.getElementById('contactMessage').value
  };

  try {
    // If you haven't replaced the placeholder IDs, this will fail gracefully or show an error
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, formData);
    toast('✅ Message sent! We\'ll get back to you soon.');
    document.getElementById('contactForm').reset();
    closeContactModal();
  } catch (err) {
    console.error('EmailJS Error:', err);
    toast('❌ Error sending message. Ensure your API keys are correct.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
};

window.notifySubscribersEmailJS = notifySubscribersEmailJS; 
async function notifySubscribersEmailJS(eData, description, imageURL) {
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('subscribed', '==', true)));
    if (snap.empty) return;
    const emailList = snap.docs.map(d => d.data().email).filter(Boolean).join(',');
    if (!emailList) return;
    const templateParams = {
      to_name: 'CampusLink User',
      to_email: currentUser.email || 'support@campuslink.com',
      bcc_list: emailList,
      event_name: eData.title,
      event_date: eData.date || 'TBA',
      event_college: eData.college || 'Our Campus',
      event_description: description,
      subject: `🎉 New Event Alert: ${eData.title}`,
    };
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams);
  } catch (e) { console.error('Email notification failed:', e); }
}


window.scrollToPost = function (postId) {
  const el = document.getElementById(`ptw-${postId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const card = el.closest('.post-card');
    if (card) {
      card.style.outline = '3px solid var(--primary)';
      card.style.transition = 'outline 0.3s';
      setTimeout(() => card.style.outline = 'none', 2000);
    }
  }
};

window.smoothJump = function (id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};


/* ════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
window.getInitials = getInitials;
function fmtNum(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); }
window.fmtNum = fmtNum;
function timeAgo(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function setAvatarEl(id, initials, photo, wrap) {
  const el = document.getElementById(id);
  if (!el) return;
  if (photo) { el.innerHTML = `<img src="${photo}" alt="${initials}" onerror="this.style.display='none'">`; }
  else { el.textContent = initials; }
}
function avatarHTML(initials, photo, size = 'post') {
  const cls = size === 'post' ? 'post-avatar' : 'lb-avatar';
  if (photo) return `<div class="${cls}"><img src="${photo}" alt="${initials}" onclick="openLightbox('${photo}')" style="cursor:pointer"></div>`;
  return `<div class="${cls}">${initials}</div>`;
}

/* ════════════════════════════════════════════════════════════════
   FIRESTORE — REALTIME POSTS LISTENER
═══════════════════════════════════════════════════════════════ */
function listenPosts() {
  if (unsubPosts) return; // Prevent duplicate listeners
  const q = query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(100));
  unsubPosts = onSnapshot(q, snap => {
    const newPosts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setState({ posts: newPosts, isLoading: false });
    
    // Handle deep link scroll once posts are loaded
    handleDeepLinkActions();
  });
}

function handleDeepLinkActions() {
  const urlParams = new URLSearchParams(window.location.search);
  const postId = urlParams.get('post');
  const userId = urlParams.get('u');

  // 1. Handle Post Deep Link
  if (postId && !window._deepLinkedHandled) {
    const postEl = document.getElementById(`ptw-${postId}`);
    if (postEl) {
      window._deepLinkedHandled = true;
      switchToFeedAndScroll(postId);
      clearUrlParam('post');
    }
  }

  // 2. Handle User Profile Deep Link
  if (userId && !window._userDeepLinkedHandled) {
    window._userDeepLinkedHandled = true;
    viewUserProfile(userId);
    clearUrlParam('u');
  }
}

function clearUrlParam(param) {
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.delete(param);
  window.history.replaceState({}, document.title, newUrl.toString());
}

/* ════════════════════════════════════════════════════════════════
   RENDER POSTS
═══════════════════════════════════════════════════════════════ */
function renderPosts() {
  const container = document.getElementById('postsContainer');
  const emptyState = document.getElementById('emptyFeed');
  const skeleton = document.getElementById('postsSkeleton');

  if (!container) return; // Not on feed page
  
  // 1. Handle Loading State
  if (state.isLoading) {
    if (skeleton) skeleton.classList.remove('hidden');
    if (container) container.classList.add('hidden');
    if (emptyState) emptyState.classList.add('hidden');
    return;
  }

  // 2. Hide skeleton once data is ready
  if (skeleton) skeleton.classList.add('hidden');
  container.classList.remove('hidden');

  // 3. Filter posts from state
  const map = { all: null, post: 'text', image: 'image', link: 'link', project: 'project', hackathon: 'hackathon', workshop: 'workshop', cultural: 'cultural', symposium: 'symposium' };
  const targetType = map[currentSearchCategory];

  const list = (state.posts || []).filter(p => {
    const matchType = !targetType || (p.type === targetType);
    const matchKwd = !currentSearchQuery || (
      (p.text || '').toLowerCase().includes(currentSearchQuery) ||
      (p.authorName || '').toLowerCase().includes(currentSearchQuery) ||
      (p.tags || []).some(t => t.toLowerCase().includes(currentSearchQuery))
    );
    return matchType && matchKwd;
  });

  if (!list.length) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    emptyState.style.display = 'block';
    const emptyMsg = currentSearchQuery
      ? `<h3>🔍 No results for "${currentSearchQuery}" ${currentSearchCategory !== 'all' ? 'in ' + currentSearchCategory + 's' : ''}</h3>`
      : `<h3>📭 No ${currentSearchCategory === 'all' ? 'posts' : currentSearchCategory + 's'} found yet</h3>`;
    emptyState.innerHTML = `<div class="empty-state">${emptyMsg}<p>Try a different keyword or category.</p></div>`;
    return;
  }

  emptyState.classList.add('hidden');
  emptyState.style.display = 'none';
  
  container.classList.remove('hidden');
  container.innerHTML = list.map((p, i) => buildPostHTML(p, i)).join('');
}

function buildPostHTML(p, idx) {
  const words = (p.text || '').trim().split(/\s+/);
  const previewText = words.slice(0, 10).join(' ');
  const initials = getInitials(p.authorName);
  const photo = p.authorPhoto || '';
  const liked = (p.likedBy || []).includes(state.currentUser?.uid);
  const ts = timeAgo(p.createdAt);
  const isOwnPost = p.authorId === state.currentUser?.uid;
  const isFollowing = state.followedUsers.has(p.authorId);

  // Follow button — hidden on own posts
  const followBtn = isOwnPost
    ? `<span class="own-post-tag">You</span>`
    : `<button
        class="post-follow-btn ${isFollowing ? 'following' : ''}"
        onclick="toggleFollow(this,'${(p.authorName || '').replace(/'/g, "\\'")}','${p.authorId}')"
        title="${isFollowing ? 'Unfollow' : 'Follow'} ${p.authorName}"
      >${isFollowing ? '✓ Following' : '+ Follow'}</button>`;

  let extra = '';

  // 1. Link Preview (Hidden until expanded if text is long)
  if (p.linkURL) {
    const displayLink = p.linkURL.replace(/^https?:\/\//, '').split('/')[0];
    const linkHTML = `<div class="link-preview-box" onclick="window.open('${p.linkURL}','_blank')">
      <div class="lp-icon">🔗</div>
      <div class="lp-info">
        <h5>${escHTML(displayLink)}</h5>
        <p>${escHTML(p.linkURL)}</p>
      </div>
      <div class="lp-arrow">↗️</div>
    </div>`;

    // We wrap this in extra if words > 10
    extra += `<div class="post-extra-hidden">${linkHTML}</div>`;
  }

  // 2. Event Details (Hackathon, Workshop, Cultural)
  if (p.eventData) {
    const evDate = p.eventData.date ? new Date(p.eventData.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Date TBD';
    extra += `<div class="event-details-box">
      <div class="ed-header">
        <span class="ed-badge">${typeBadge(p.type)}</span>
        <span class="ed-date">📅 ${evDate}</span>
      </div>
      <h4>${escHTML(p.eventData.title || 'Untitled Event')}</h4>
    </div>`;
  }

  // 3. Image (Shared across Types)
  if (p.imageURL) {
    extra += `<img class="post-img" src="${p.imageURL}" alt="Post image" loading="lazy" onclick="openLightbox('${p.imageURL}')" onerror="this.style.display='none'"/>`;
  }

  // 4. Project Box (Legacy/Fallback)
  if (p.type === 'project' && p.projData) {
    const tags = (p.projData.tags || []).map(t => `<span class="proj-tag">#${t}</span>`).join('');
    extra += `<div class="proj-box">
      <h4>${p.projData.title || 'Project'}</h4>
      <p>${p.projData.desc || ''}</p>
      <div class="proj-tags">${tags}</div>
      <button class="join-btn" onclick="toast('👥 Team request sent!')">Join Team 👥</button>
    </div>`;
  }

  return `<div class="post-card">
    <div class="post-header">
      ${avatarHTML(initials, photo)}
      <div class="post-info" onclick="viewUserProfile('${p.authorId}')" style="cursor:pointer">
        <h4>${p.authorName || 'User'}</h4>
        <p>${ts}</p>
      </div>
      <div class="post-header-right">
        ${!isOwnPost ? `<button class="icon-btn" style="width:34px; height:34px; font-size:1rem; border-color:var(--border); background:var(--bg2)" onclick="window.location.href='messages.html?u=${p.authorId}'" title="Message ${p.authorName}">💬</button>` : ''}
        ${isOwnPost || (state.userProfile?.isAdmin || state.userProfile?.role === 'admin') ? `<button class="icon-btn" style="width:34px; height:34px; font-size:1rem; border-color:var(--border); background:var(--bg2)" onclick="openEditModal('${p.id}')" title="Edit Post">✏️</button>` : ''}
        ${isOwnPost || (state.userProfile?.isAdmin || state.userProfile?.role === 'admin') ? `<button class="icon-btn" style="width:34px; height:34px; font-size:1rem; border-color:var(--border); background:var(--bg2); color:#ef4444" onclick="deletePost('${p.id}')" title="Delete Post">🗑️</button>` : ''}
        <span class="post-badge">${typeBadge(p.type)}</span>
        ${p.dayNum ? `<span class="post-badge" style="background:var(--grad); color:#fff; border:none">🏆 Day ${p.dayNum}</span>` : ''}
        ${followBtn}
      </div>
    </div>
    <div class="post-text-wrap" id="ptw-${p.id}">
      <div class="post-content post-content-preview" style="margin:14px 0; font-size:1.1rem; line-height:1.75; color:var(--text)">
        ${words.length > 10 ? escHTML(previewText) + '...' : escHTML(p.text || '')}
        ${words.length > 10 ? `<button class="read-more-btn" onclick="toggleExpandPost('${p.id}')">Read more...</button>` : ''}
      </div>
      <div class="post-content post-content-full" style="margin:14px 0; font-size:1.1rem; line-height:1.75; color:var(--text)">
        ${escHTML(p.text || '')}
        <button class="read-more-btn" onclick="toggleExpandPost('${p.id}')">Show less</button>
      </div>
    </div>
    ${extra}
    <div class="post-actions">
      <button class="act-btn ${liked ? 'liked' : ''}" onclick="likePost('${p.id}',this)" title="Like">❤️ <span onclick="event.stopPropagation(); openLikesModal('${p.id}')" style="text-decoration:underline; cursor:pointer">${fmtNum(p.likes || 0)}</span></button>
      <button class="act-btn" onclick="toggleComments('${p.id}','${(p.authorId || '')}','${escAttr(p.authorName || '')}')" title="Comment">💬 ${fmtNum(p.comments || 0)}</button>
      <button class="act-btn" onclick="sharePost('${p.id}',this)" title="Share">↗️ ${fmtNum(p.shares || 0)}</button>
      <button class="act-btn save-btn ${state.savedPostIds.has(p.id) ? 'saved' : ''}" onclick="toggleSavePost('${p.id}',this)" title="${state.savedPostIds.has(p.id) ? 'Unsave' : 'Save'}">${state.savedPostIds.has(p.id) ? '📌' : '🔖'}</button>
    </div>
    <!-- Comment Section (hidden by default) -->
    <div class="comment-section" id="cs-${p.id}" style="display:none">
      <div class="comment-list" id="cl-${p.id}"></div>
      <div class="comment-input-row">
        <div class="comment-avatar" id="ca-${p.id}">AJ</div>
        <input class="comment-input" id="ci-${p.id}" placeholder="Write a comment…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addComment('${p.id}','${(p.authorId || '')}','${escAttr(p.authorName || '')}')}"/>
        <button class="comment-send" onclick="addComment('${p.id}','${(p.authorId || '')}','${escAttr(p.authorName || '')}')" title="Send">➤</button>
      </div>
    </div>
  </div>`;
}

function typeBadge(type) {
  const map = { 
    text: '📝 Post', 
    image: '🖼️ Image', 
    link: '🔗 Link', 
    project: '🛠️ Project', 
    hackathon: '🏆 Hackathon', 
    workshop: '⚙️ Workshop', 
    cultural: '🎨 Cultural', 
    symposium: '🏛️ Symposium',
    challenge: '🏆 Challenge'
  };
  return map[type] || '📝 Post';
}
window.typeBadge = typeBadge;

function escHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}
window.escHTML = escHTML;

function escAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
window.escAttr = escAttr;

/* ════════════════════════════════════════════════════════════════
   COMMENTS — toggle section open/close
═══════════════════════════════════════════════════════════════ */
window.toggleComments = function (postId, authorId, authorName) {
  const section = document.getElementById(`cs-${postId}`);
  if (!section) return;

  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    // Populate current user avatar in input row
    const caEl = document.getElementById(`ca-${postId}`);
    if (caEl) {
      const photo = state.currentUser?.photoURL;
      const initials = getInitials(state.currentUser?.displayName || 'U');
      if (photo) caEl.innerHTML = `<img src="${photo}" alt="${initials}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      else caEl.textContent = initials;
    }

    // Start real-time listener for this post's comments
    if (!commentUnsubs[postId]) {
      const q = query(collection(db, 'posts', postId, 'comments'), orderBy('createdAt', 'asc'));
      commentUnsubs[postId] = onSnapshot(q, snap => {
        renderComments(postId, snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });
    }

    // Focus input
    setTimeout(() => document.getElementById(`ci-${postId}`)?.focus(), 100);
  } else {
    // Unsubscribe and close
    if (commentUnsubs[postId]) { commentUnsubs[postId](); delete commentUnsubs[postId]; }
  }
};

/* ════════════════════════════════════════════════════════════════
   COMMENTS — render list
═══════════════════════════════════════════════════════════════ */
function renderComments(postId, comments) {
  const list = document.getElementById(`cl-${postId}`);
  if (!list) return;
  if (!comments.length) {
    list.innerHTML = `<p class="no-comments">Be the first to comment! 👋</p>`;
    return;
  }
  list.innerHTML = comments.map(c => {
    const init = getInitials(c.authorName || 'U');
    const photo = c.authorPhoto || '';
    const ts = timeAgo(c.createdAt);
    const avatarEl = photo
      ? `<div class="cmt-avatar"><img src="${photo}" alt="${init}" onclick="openLightbox('${photo}')" style="cursor:pointer"></div>`
      : `<div class="cmt-avatar">${init}</div>`;
    const isOwn = c.authorId === state.currentUser?.uid;
    return `<div class="cmt-row">
      ${avatarEl}
      <div class="cmt-bubble">
        <div class="cmt-meta"><span class="cmt-name" onclick="viewUserProfile('${c.authorId}')" style="cursor:pointer">${escHTML(c.authorName || 'User')}</span><span class="cmt-time">${ts}</span></div>
        <div class="cmt-text">${escHTML(c.text || '')}</div>
      </div>
      ${isOwn ? `<button class="cmt-del" onclick="deleteComment('${postId}','${c.id}')" title="Delete">🗑️</button>` : ''}
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

/* ════════════════════════════════════════════════════════════════
   COMMENTS — add
═══════════════════════════════════════════════════════════════ */
window.addComment = async function (postId, postAuthorId, postAuthorName) {
  const input = document.getElementById(`ci-${postId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentUser) { toast('⚠️ Please sign in to comment'); return; }

  input.value = '';
  input.disabled = true;

  try {
    const commentData = {
      text,
      authorId: state.currentUser.uid,
      authorName: state.currentUser.displayName || state.userProfile?.displayName || 'User',
      authorPhoto: state.currentUser.photoURL || state.userProfile?.photoURL || '',
      createdAt: serverTimestamp()
    };

    // Add comment to sub-collection
    await addDoc(collection(db, 'posts', postId, 'comments'), commentData);

    // Increment comment count on post
    try { await updateDoc(doc(db, 'posts', postId), { comments: increment(1) }); } catch { }

    // ── Send notification to post owner (skip if own post) ──
    if (postAuthorId && postAuthorId !== state.currentUser.uid) {
      try {
        await addDoc(collection(db, 'notifications', postAuthorId, 'items'), {
          type: 'comment',
          fromId: state.currentUser.uid,
          fromName: state.currentUser.displayName || 'Someone',
          fromPhoto: state.currentUser.photoURL || '',
          postId,
          message: `💬 ${state.currentUser.displayName || 'Someone'} commented on your post`,
          read: false,
          createdAt: serverTimestamp()
        });
      } catch (e) { console.warn('Notification failed:', e); }
    }

    toast('💬 Comment posted!');
  } catch (e) {
    console.error('Comment error:', e);
    toast('❌ Could not post comment: ' + (e.message || ''));
  } finally {
    input.disabled = false;
    input.focus();
  }
};

/* ════════════════════════════════════════════════════════════════
   COMMENTS — delete own comment
═══════════════════════════════════════════════════════════════ */
window.deleteComment = async function (postId, commentId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await deleteDoc(doc(db, 'posts', postId, 'comments', commentId));
    await updateDoc(doc(db, 'posts', postId), { comments: increment(-1) });
    toast('🗑️ Comment deleted');
  } catch (e) { toast('❌ Could not delete comment'); }
};

/* ════════════════════════════════════════════════════════════════
   NOTIFICATIONS — real-time listener
═══════════════════════════════════════════════════════════════ */
function listenNotifications() {
  if (!state.currentUser || unsubNotifsList) return;

  // 1. Real-time listener for the dropdown list (last 20 items)
  const qList = query(
    collection(db, 'notifications', state.currentUser.uid, 'items'),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  unsubNotifsList = onSnapshot(qList, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const notifs = all.filter(n => n.type !== 'message');

    // Store for dropdown
    const btn = document.getElementById('notifBtn');
    if (btn) btn._notifs = notifs;
    if (state.activeTab === 'notifications' || (document.getElementById('notifDropdown'))) renderNotifDropdown(notifs);
  });

  // 2. Separate listener for accurate unread counts (Global)
  const qUnread = query(
    collection(db, 'notifications', state.currentUser.uid, 'items'),
    where('read', '==', false)
  );
  unsubNotifsUnread = onSnapshot(qUnread, snap => {
    const unreadRaw = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    unreadMessageIds = unreadRaw.filter(n => n.type === 'message').map(n => n.id);
    unreadNotifIds = unreadRaw.filter(n => n.type !== 'message').map(n => n.id);

    // General notifications badge
    const nBadge = document.querySelector('.notif-badge');
    if (nBadge) {
      nBadge.textContent = unreadNotifIds.length || '';
      if (unreadNotifIds.length) { nBadge.classList.remove('hidden'); nBadge.style.display = 'flex'; } 
      else { nBadge.classList.add('hidden'); nBadge.style.display = 'none'; }
    }

    // Message notifications badge
    const mBadge = document.querySelector('.msg-badge');
    if (mBadge) {
      mBadge.textContent = unreadMessageIds.length || '';
      if (unreadMessageIds.length) { mBadge.classList.remove('hidden'); mBadge.style.display = 'flex'; } 
      else { mBadge.classList.add('hidden'); mBadge.style.display = 'none'; }
    }
  });
}

/* ════════════════════════════════════════════════════════════════
   NOTIFICATIONS — open/close dropdown
═══════════════════════════════════════════════════════════════ */
window.toggleNotifDropdown = function (e) {
  e.stopPropagation();
  const btn = document.getElementById('notifBtn');
  const notifs = btn._notifs || [];
  let drop = document.getElementById('notifDropdown');

  if (notifDropOpen || document.getElementById('notifDropdown')) { closeNotifDropdown(); return; }
  if (msgDropOpen || document.getElementById('msgDropdown')) closeMsgDropdown();

  // Create dropdown
  drop = document.createElement('div');
  drop.id = 'notifDropdown';
  drop.className = 'notif-dropdown';
  document.body.appendChild(drop);
  notifDropOpen = true;
  renderNotifDropdown(notifs);

  // Mark all as read immediately using tracked IDs
  if (unreadNotifIds.length > 0) {
    const idsToClear = [...unreadNotifIds];
    unreadNotifIds = []; // Optimistically clear locally
    idsToClear.forEach(async (id) => {
      try {
        await updateDoc(doc(db, 'notifications', state.currentUser.uid, 'items', id), { read: true });
      } catch (e) { }
    });
  }
};

function closeNotifDropdown() {
  const drop = document.getElementById('notifDropdown');
  if (drop) drop.remove();
  notifDropOpen = false;
}
window.closeNotifDropdown = closeNotifDropdown;

function renderNotifDropdown(notifs) {
  const drop = document.getElementById('notifDropdown');
  if (!drop) return;
  const btn = document.getElementById('notifBtn');
  const rect = btn.getBoundingClientRect();
  drop.style.cssText = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;z-index:2000;min-width:300px;max-width:340px;`;

  if (!notifs.length) {
    drop.innerHTML = `<div class="nd-empty">🔔 No notifications yet</div>`;
    return;
  }
  drop.innerHTML = `
    <div class="nd-header">🔔 Notifications
      <button class="nd-close" onclick="closeNotifDropdown()">✕</button>
    </div>
    <div class="nd-list">
      ${notifs.map(n => {
    const photo = n.fromPhoto
      ? `<img src="${n.fromPhoto}" alt="${n.fromName}" onclick="event.stopPropagation(); openLightbox('${n.fromPhoto}')" style="cursor:pointer" onerror="this.style.display='none'">`
      : `<span>${getInitials(n.fromName)}</span>`;
    return `<div class="nd-item ${n.read ? '' : 'unread'}">
          <div class="nd-avatar">${photo}</div>
          <div class="nd-body">
            <p>${escHTML(n.message || '')}</p>
            <span class="nd-time">${timeAgo(n.createdAt)}</span>
          </div>
        </div>`;
  }).join('')}
    </div>`;
}

/* ════════════════════════════════════════════════════════════════
   MESSAGES — real-time listener
═══════════════════════════════════════════════════════════════ */
function listenMessages() {
  if (!state.currentUser || unsubMessages) return;
  const q = query(
    collection(db, 'users', state.currentUser.uid, 'recent_chats'),
    orderBy('lastAt', 'desc'),
    limit(10)
  );
  unsubMessages = onSnapshot(q, snap => {
    const chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const drop = document.getElementById('msgDropdown');
    const btn = document.getElementById('msgBtn');
    if (drop && (msgDropOpen || document.getElementById('msgDropdown'))) renderMsgDropdown(chats);
    if (btn) btn._chats = chats;
  });
}

function listenChallenges() {
  if (!state.currentUser || unsubChallenges) return;
  const q = query(
    collection(db, 'users', state.currentUser.uid, 'challenges'),
    orderBy('start', 'desc')
  );
  unsubChallenges = onSnapshot(q, snap => {
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setState({ challenges: list });
  });
}

/* ════════════════════════════════════════════════════════════════
   MESSAGES — open/close dropdown
═══════════════════════════════════════════════════════════════ */
window.toggleMsgDropdown = function (e) {
  e.stopPropagation();
  const btn = document.getElementById('msgBtn');
  const chats = btn._chats || [];
  let drop = document.getElementById('msgDropdown');

  if (msgDropOpen || document.getElementById('msgDropdown')) { closeMsgDropdown(); return; }
  if (notifDropOpen || document.getElementById('notifDropdown')) closeNotifDropdown();

  // Create dropdown
  drop = document.createElement('div');
  drop.id = 'msgDropdown';
  drop.className = 'notif-dropdown msg-dropdown'; // reuse base styles
  document.body.appendChild(drop);
  msgDropOpen = true;
  renderMsgDropdown(chats);

  // Mark message notifications as read immediately using tracked IDs
  if (unreadMessageIds.length > 0) {
    const idsToClear = [...unreadMessageIds];
    unreadMessageIds = []; // Optimistically clear locally

    idsToClear.forEach(async (id) => {
      try {
        await updateDoc(doc(db, 'notifications', state.currentUser.uid, 'items', id), { read: true });
      } catch (e) { console.warn('Failed to clear notif:', id, e); }
    });
  }
};

function closeMsgDropdown() {
  const drop = document.getElementById('msgDropdown');
  if (drop) drop.remove();
  msgDropOpen = false;
}
window.closeMsgDropdown = closeMsgDropdown;

function renderMsgDropdown(chats) {
  const drop = document.getElementById('msgDropdown');
  if (!drop) return;
  const btn = document.getElementById('msgBtn');
  const rect = btn.getBoundingClientRect();
  drop.style.cssText = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;z-index:2000;min-width:300px;max-width:340px;`;

  if (!chats.length) {
    drop.innerHTML = `
      <div class="nd-header">💬 Messages
        <button class="nd-close" onclick="closeMsgDropdown()">✕</button>
      </div>
      <div class="nd-empty">No conversations yet</div>
      <div class="nd-footer"><a href="messages.html">View all messages</a></div>`;
    return;
  }
  drop.innerHTML = `
    <div class="nd-header">💬 Messages
      <button class="nd-close" onclick="closeMsgDropdown()">✕</button>
    </div>
    <div class="nd-list">
      ${chats.map(c => {
    const init = getInitials(c.withName);
    const photo = c.withPhoto
      ? `<img src="${c.withPhoto}" alt="${c.withName}" onclick="event.stopPropagation(); openLightbox('${c.withPhoto}')" style="cursor:pointer" onerror="this.style.display='none'">`
      : `<span>${init}</span>`;
    return `<div class="nd-item ${c.unreadCount ? 'unread' : ''}" onclick="window.location.href='messages.html?chat=${c.id}'">
          <div class="nd-avatar">${photo}</div>
          <div class="nd-body">
            <div class="nd-msg-top">
              <strong>${escHTML(c.withName || 'User')}</strong>
              <span class="nd-time">${timeAgo(c.lastAt)}</span>
            </div>
            <p>${escHTML(c.lastMessage || '')}</p>
          </div>
        </div>`;
  }).join('')}
    </div>
    <div class="nd-footer"><a href="messages.html">View all messages</a></div>`;
}


/* ════════════════════════════════════════════════════════════════
   RENDER PROJECTS
═══════════════════════════════════════════════════════════════ */
function renderProjects() {
  const proj = state.posts.filter(p => p.type === 'project');
  const container = document.getElementById('projectsContainer');
  if (!proj.length) {
    container.innerHTML = `<div class="empty-state"><h3>🛠️ No Projects Yet</h3><p>Be the first to share a project!</p></div>`;
    return;
  }
  container.innerHTML = proj.map(p => buildPostHTML(p, 0)).join('');
}

/* ════════════════════════════════════════════════════════════════
   RENDER EVENTS — Dynamic, date-aware (Today / Upcoming / Past)
═══════════════════════════════════════════════════════════════ */


window.switchToFeedAndScroll = function (postId) {
  // Clear any active profile view first
  viewingUserId = null;
  // Switch to feed tab first, then scroll to the post
  const feedTab = document.querySelector('.ptab');
  if (feedTab) switchTab(feedTab, 'feed');
  setTimeout(() => scrollToPost(postId), 300);
};



/* ════════════════════════════════════════════════════════════════
   RENDER SIDEBAR WIDGETS (Bento Elite)
═══════════════════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════════════════════
   CREATE POST (with optional image upload)
═══════════════════════════════════════════════════════════════ */
window.createPost = async function () {
  const textarea = document.getElementById('postContent');
  const text = textarea.value.trim();
  const type = document.getElementById('postTypeSelect').value;
  const fileInput = document.getElementById('postImageFile');
  const file = fileInput.files[0] || null;
  const linkURL = !document.getElementById('df-link').classList.contains('d-field-hidden') ? document.getElementById('postLinkURL').value.trim() : '';
  const eventTitle = !document.getElementById('df-event-group').classList.contains('d-field-hidden') ? document.getElementById('postEventTitle').value.trim() : '';
  const eventDate = !document.getElementById('df-event-group').classList.contains('d-field-hidden') ? document.getElementById('postEventDate').value : '';
  const eventCollege = !document.getElementById('df-event-group').classList.contains('d-field-hidden') ? document.getElementById('postEventCollege').value.trim() : '';
  const tagsRaw = document.getElementById('postTags').value.trim();

  // Requirements: Textarea not empty
  if (!text) { toast('⚠️ Please write something first!'); return; }

  // Requirements: At least one source provided (image OR url OR hashtag OR event details)
  const hasSource = (file || linkURL || tagsRaw || eventTitle);
  if (!hasSource && type !== 'text') {
    toast('⚠️ Please provide a source (image, link, or event details)!');
    return;
  }

  const btn = document.getElementById('postSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 🚀 Posting…';

  try {
    let imageURL = '';
    if (file) {
      toast('📸 Uploading image…');
      try {
        imageURL = await uploadImageStorage(file);
      } catch (e) {
        console.warn('Storage failed, using fallback:', e);
        if (file.size < 500 * 1024) imageURL = await fileToBase64(file);
      }
    }

    const tags = tagsRaw ? tagsRaw.split(/[\s,]+/).map(t => t.startsWith('#') ? t : '#' + t).filter(Boolean) : [];

    const postData = {
      text,
      type,
      imageURL,
      linkURL,
      tags,
      authorId: state.currentUser.uid,
      authorName: state.currentUser.displayName || state.userProfile?.displayName || 'User',
      authorPhoto: state.currentUser.photoURL || state.userProfile?.photoURL || '',
      likes: 0,
      likedBy: [],
      comments: 0,
      shares: 0,
      sharedBy: [],
      createdAt: serverTimestamp()
    };

    // If event type, add event data
    if (['hackathon', 'workshop', 'cultural', 'symposium'].includes(type)) {
      const eData = { title: eventTitle, date: eventDate, college: eventCollege };
      postData.eventData = eData;

      // Send EmailJS notifications (moved logic to cloud/admin or handled by module if needed)
      // For now, we keep the call if the function is available globally
      if (window.notifySubscribersEmailJS) window.notifySubscribersEmailJS(eData, text, imageURL);
    }

    await addDoc(collection(db, 'posts'), postData);



    // Update stats
    try { await updateDoc(doc(db, 'users', state.currentUser.uid), { posts: increment(1) }); } catch { }

    // Reset Form
    textarea.value = '';
    fileInput.value = '';
    document.getElementById('postTypeSelect').value = 'text';
    document.getElementById('postTags').value = '';
    if (document.getElementById('postLinkURL')) document.getElementById('postLinkURL').value = '';
    if (document.getElementById('postEventDate')) document.getElementById('postEventDate').value = '';
    if (document.getElementById('postEventCollege')) document.getElementById('postEventCollege').value = '';

    updatePostFormFields(); // Reset visibility
    closeComposer();
    toast('🎉 Post shared successfully!');
  } catch (e) {
    console.error('Post Error:', e);
    toast('❌ Failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Post Now 🚀';
  }
};

/* ════════════════════════════════════════════════════════════════
   EDIT POST (FOR ADMINS)
═══════════════════════════════════════════════════════════════ */
window.openEditModal = async function (postId) {
  try {
    const postDoc = await getDoc(doc(db, 'posts', postId));
    if (!postDoc.exists()) return;
    const p = postDoc.data();

    document.getElementById('editPostId').value = postId;
    document.getElementById('editPostText').value = p.text || '';

    const evGroup = document.getElementById('editEventGroup');
    if (['hackathon', 'workshop', 'cultural', 'symposium'].includes(p.type) || p.eventData) {
      if (evGroup) {
        evGroup.classList.remove('edit-event-group');
        evGroup.style.display = 'flex';
        document.getElementById('editEventTitle').value = p.eventData?.title || '';
        document.getElementById('editEventDate').value = p.eventData?.date || '';
        document.getElementById('editEventCollege').value = p.eventData?.college || '';
      }
    } else {
      if (evGroup) { evGroup.classList.add('edit-event-group'); evGroup.style.display = 'none'; }
    }

    document.getElementById('editPostOverlay').classList.add('open');
  } catch (e) { toast('Error loading post data'); }
};

window.closeEditModal = function () {
  document.getElementById('editPostOverlay').classList.remove('open');
};

window.savePostEdit = async function (e) {
  if (e) e.preventDefault();
  const id = document.getElementById('editPostId').value;
  const text = document.getElementById('editPostText').value;
  const evTitle = document.getElementById('editEventTitle').value;
  const evDate = document.getElementById('editEventDate').value;
  const evCollege = document.getElementById('editEventCollege').value;

  const btn = document.getElementById('saveEditBtn');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const postDoc = await getDoc(doc(db, 'posts', id));
    const p = postDoc.data();

    const updates = { text };

    if (['hackathon', 'workshop', 'cultural', 'symposium'].includes(p.type) || p.eventData) {
      updates.eventData = {
        title: evTitle,
        date: evDate,
        college: evCollege
      };
    }

    await updateDoc(doc(db, 'posts', id), updates);
    toast('✅ Post updated successfully!');
    closeEditModal();
  } catch (e) {
    console.error(e);
    toast('❌ Error saving changes');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
};
/**
 * 🗑️ DELETE POST — Allows author or admin to remove a post
 */
window.deletePost = async function (postId) {
  if (!confirm('🗑️ Delete this post permanently?')) return;
  try {
    await deleteDoc(doc(db, 'posts', postId));
    toast('🗑️ Post deleted successfully');
  } catch (e) {
    console.error('Delete error:', e);
    toast('❌ Could not delete post: ' + (e.message || ''));
  }
};

/* ════════════════════════════════════════════════════════════════
   IMAGE UPLOAD — Firebase Storage (requires CORS setup)
═══════════════════════════════════════════════════════════════ */
async function uploadImageStorage(file) {
  const bar = document.getElementById('uploadBar');
  const pct = document.getElementById('uploadPct');
  if (bar) { bar.classList.remove('hidden', 'upload-bar'); bar.style.display = 'block'; }

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
    formData.append('api_key', CLOUDINARY_CONFIG.apiKey);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/image/upload`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && pct) {
          const progress = Math.round((e.loaded / e.total) * 100);
          pct.textContent = progress + '%';
        }
      };

      xhr.onload = () => {
        if (bar) bar.style.display = 'none';
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          resolve(response.secure_url);
        } else {
          console.error('Cloudinary Error:', xhr.responseText);
          reject(new Error('Upload failed: ' + xhr.statusText));
        }
      };

      xhr.onerror = () => {
        if (bar) bar.style.display = 'none';
        reject(new Error('Network error during upload.'));
      };

      xhr.send(formData);
    });
  } catch (e) {
    if (bar) bar.style.display = 'none';
    throw e;
  }
}

/* ════════════════════════════════════════════════════════════════
   BASE64 FALLBACK — stores image inline in Firestore
   (works without CORS setup, but limited to <500KB images)
═══════════════════════════════════════════════════════════════ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(e);
    reader.readAsDataURL(file);
  });
}


/* ════════════════════════════════════════════════════════════════
   LIKE POST
═══════════════════════════════════════════════════════════════ */
window.likePost = async function (postId, btn) {
  if (!state.currentUser) return;
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  const liked = (post.likedBy || []).includes(state.currentUser.uid);
  const postRef = doc(db, 'posts', postId);
  try {
    if (liked) {
      await updateDoc(postRef, {
        likes: increment(-1),
        likedBy: (post.likedBy || []).filter(id => id !== state.currentUser.uid)
      });
      btn.classList.remove('liked');
      btn.innerHTML = `❤️ ${fmtNum(Math.max(0, (post.likes || 0) - 1))}`;
      toast('💔 Post unliked');
    } else {
      await updateDoc(postRef, {
        likes: increment(1),
        likedBy: [...(post.likedBy || []), state.currentUser.uid]
      });
      btn.classList.add('liked');
      btn.innerHTML = `❤️ ${fmtNum((post.likes || 0) + 1)}`;
      toast('❤️ Post liked!');
    }
  } catch (e) { toast('❌ Could not update like.'); }
};

/* ════════════════════════════════════════════════════════════════
   SHARE POST
═══════════════════════════════════════════════════════════════ */
window.sharePost = async function (postId, btn) {
  try {
    const shareURL = new URL(window.location.href.split('#')[0].split('?')[0]);
    shareURL.searchParams.set('post', postId);

    await navigator.clipboard.writeText(shareURL.toString());
    toast('🔗 Link copied to clipboard!');

    if (!state.currentUser) return;
    const post = state.posts.find(p => p.id === postId);
    if (!post) return;

    // Only count share once per user
    const hasShared = (post.sharedBy || []).includes(state.currentUser.uid);
    if (!hasShared) {
      await updateDoc(doc(db, 'posts', postId), {
        shares: increment(1),
        sharedBy: arrayUnion(state.currentUser.uid)
      });
      if (btn) btn.innerHTML = `↗️ ${fmtNum((post.shares || 0) + 1)}`;
    }
  } catch (e) {
    console.error('Share error:', e);
    toast('↗️ Shared!');
  }
};

/* ════════════════════════════════════════════════════════════════
   FOLLOW / UNFOLLOW
═══════════════════════════════════════════════════════════════ */
window.toggleFollow = async function (btn, name, uid) {
  if (!state.currentUser || !uid) return;
  if (uid === state.currentUser.uid) { toast('😅 You cannot follow yourself!'); return; }

  const isFollowing = state.followedUsers.has(uid);

  // ── Optimistic UI ──
  const allBtns = document.querySelectorAll(`.post-follow-btn`);
  allBtns.forEach(b => {
    if (b.getAttribute('onclick')?.includes(`'${uid}'`)) {
      b.classList.toggle('following', !isFollowing);
      b.textContent = !isFollowing ? '✓ Following' : '+ Follow';
      b.disabled = true; // prevent double-tap
    }
  });

  const sideStat = document.getElementById('statFollowing');
  if (sideStat) {
    const cur = parseInt(sideStat.textContent) || 0;
    sideStat.textContent = fmtNum(isFollowing ? Math.max(0, cur - 1) : cur + 1);
  }

  try {
    const followRef = doc(db, 'users', state.currentUser.uid, 'following', uid);
    const followerRef = doc(db, 'users', uid, 'followers', state.currentUser.uid);

    if (!isFollowing) {
      // ── FOLLOW ──
      state.followedUsers.add(uid);

      // Store in following sub-collection
      await setDoc(followRef, {
        uid, displayName: name,
        followedAt: serverTimestamp()
      });
      // Store in target's followers sub-collection
      await setDoc(followerRef, {
        uid: state.currentUser.uid,
        displayName: state.currentUser.displayName || 'User',
        photoURL: state.currentUser.photoURL || '',
        followedAt: serverTimestamp()
      });

      // Update counts
      await setDoc(doc(db, 'users', uid), { followers: increment(1) }, { merge: true });
      await setDoc(doc(db, 'users', state.currentUser.uid), { following: increment(1) }, { merge: true });

      // ── Create notification ONLY ONCE (check first) ──
      const notifRef = doc(db, 'notifications', uid, 'items', `follow_${state.currentUser.uid}`);
      const notifSnap = await getDoc(notifRef);
      if (!notifSnap.exists()) {
        await setDoc(notifRef, {
          type: 'follow',
          fromId: state.currentUser.uid,
          fromName: state.currentUser.displayName || 'User',
          fromPhoto: state.currentUser.photoURL || '',
          message: `👤 ${state.currentUser.displayName || 'Someone'} started following you`,
          read: false,
          createdAt: serverTimestamp()
        });
      }

      toast(`✅ Now following ${name}!`);
    } else {
      // ── UNFOLLOW ──
      state.followedUsers.delete(uid);

      await deleteDoc(followRef);
      await deleteDoc(followerRef);
      await setDoc(doc(db, 'users', uid), { followers: increment(-1) }, { merge: true });
      await setDoc(doc(db, 'users', state.currentUser.uid), { following: increment(-1) }, { merge: true });

      toast(`Unfollowed ${name}`);
    }
  } catch (e) {
    console.error('Follow error:', e);
    toast('❌ Could not update follow. Try again.');
    // Revert
    if (!isFollowing) state.followedUsers.delete(uid); else state.followedUsers.add(uid);
    allBtns.forEach(b => {
      if (b.getAttribute('onclick')?.includes(`'${uid}'`)) {
        b.classList.toggle('following', isFollowing);
        b.textContent = isFollowing ? '✓ Following' : '+ Follow';
      }
    });
  } finally {
    allBtns.forEach(b => {
      if (b.getAttribute('onclick')?.includes(`'${uid}'`)) b.disabled = false;
    });
  }
};

/* ════════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════ */
window.setSearchCategory = function (btn, cat) {
  document.querySelectorAll('.sc-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentSearchCategory = cat;

  const input = document.getElementById('feedSearchInput');
  const h = { all: 'Search anything...', post: 'Search posts or thoughts…', image: 'Search images…', link: 'Search links…', project: 'Search projects…', hackathon: 'Search hackathons…', workshop: 'Search workshops…', cultural: 'Search cultural events…', symposium: 'Search symposiums…' };
  if (input) { input.placeholder = h[cat] || 'Search…'; input.focus(); }
  renderPosts();
};

window.handleFeedSearch = function (e) {
  const xBtn = document.getElementById('clearSearchBtn');
  const q = e.target.value.toLowerCase().trim();
  currentSearchQuery = q;
  if (xBtn) { if (q) { xBtn.classList.remove('hidden'); xBtn.style.display = 'flex'; } else { xBtn.classList.add('hidden'); xBtn.style.display = 'none'; } }
  renderPosts();
};

window.clearFeedSearch = function () {
  const input = document.getElementById('feedSearchInput');
  if (input) input.value = '';
  const xBtn = document.getElementById('clearSearchBtn');
  if (xBtn) { xBtn.classList.add('hidden'); xBtn.style.display = 'none'; }
  currentSearchQuery = '';
  renderPosts();
};

function handleSearch(e) {
  const q = e.target.value.toLowerCase().trim();
  currentSearchQuery = q;

  // If user is searching and results are hidden, switch to the Feed tab
  const postsBox = document.getElementById('postsContainer');
  if (q && postsBox && postsBox.style.display === 'none') {
    const feedTabBtn = document.querySelector('.ptab') || document.querySelector('.nav-item');
    if (typeof switchTab === 'function') switchTab(feedTabBtn, 'feed');
  }

  renderPosts();
}

/* ════════════════════════════════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════════════════════════════ */
function switchTab(btn, page) {
  if (!page || (state.activeTab === page && document.querySelector(`.page-section.active`))) return;
  
  // Update state
  setState({ activeTab: page });
  sessionStorage.setItem('cl_last_page', page);
}

function updateTabUI(page) {
  // Clear existing statuses
  document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.m-nav-item').forEach(b => b.classList.remove('active'));

  // Highlight active buttons
  const ptab = document.querySelector(`.ptab[onclick*="'${page}'"]`);
  if (ptab) ptab.classList.add('active');

  const sidebarItem = document.querySelector(`.nav-item[onclick*="'${page}'"]`);
  if (sidebarItem) sidebarItem.classList.add('active');

  const mobileItem = document.querySelector(`.m-nav-item[onclick*="'${page}'"]`);
  if (mobileItem) mobileItem.classList.add('active');

  const feedCreate = document.getElementById('pg-feed');
  const postsBox = document.getElementById('postsContainer');
  const emptyBox = document.getElementById('emptyFeed');
  const allSectionsIds = ['pg-projects', 'pg-events', 'pg-saved', 'pg-myposts', 'pg-challenges'];

  // Smooth scroll to top on tab switch
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (page === 'feed') {
    if (feedCreate) feedCreate.classList.remove('hidden');
    if (postsBox) postsBox.classList.remove('hidden');
    if (emptyBox) emptyBox.classList.remove('hidden');
    allSectionsIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active', 'show');
    });
  } else {
    if (feedCreate) feedCreate.classList.add('hidden');
    if (postsBox) postsBox.classList.add('hidden');
    if (emptyBox) emptyBox.classList.add('hidden');
    
    allSectionsIds.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === `pg-${page}`) {
        el.classList.remove('hidden');
        el.classList.add('active');
        // Small delay for CSS transition
        requestAnimationFrame(() => {
           el.classList.add('show');
        });
      } else {
        el.classList.add('hidden');
        el.classList.remove('active', 'show');
      }
    });

    // Lazy render content
    if (page === 'projects') renderProjects();
    if (page === 'events') window.renderEvents(state.posts);
    if (page === 'saved') renderSaved();
    if (page === 'myposts') { viewingUserId = null; renderMyPosts(); }
    if (page === 'challenges') renderChHome();
  }
}

window.switchTab = switchTab;

window.viewUserProfile = function (uid) {
  window.location.href = `profile.html?u=${uid}`;
};

window.shareProfile = async function () {
  try {
    const uid = viewingUserId || state.currentUser?.uid;
    if (!uid) { toast('⚠️ No profile to share!'); return; }
    
    // Create direct profile link using standard URL API for robustness
    const shareURL = new URL('profile.html', window.location.href);
    shareURL.searchParams.set('u', uid);

    await navigator.clipboard.writeText(shareURL.toString());
    toast('🔗 Profile link copied to clipboard!');
  } catch (e) {
    toast('❌ Error copying link');
  }
};

/* ════════════════════════════════════════════════════════════════
   FILTER BUTTONS
═══════════════════════════════════════════════════════════════ */
window.lbFilter = function (btn, name) {
  document.querySelectorAll('.filt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  toast(`📊 Filtering: ${name}`);
};

/* ════════════════════════════════════════════════════════════════
   POST TYPE SELECTOR
═══════════════════════════════════════════════════════════════ */
window.setPostType = function (btn, type) {
  document.querySelectorAll('.cbt').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
  currentPostType = type;
  if (document.getElementById('postTypeSelect')) {
    document.getElementById('postTypeSelect').value = type;
  }
};

/* ════════════════════════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════════════════════ */
function openComposer() {
  const overlay = document.getElementById('composerOverlay');
  if (overlay) overlay.classList.add('open');
  if (window.updatePostFormFields) window.updatePostFormFields(); 
  setTimeout(() => document.getElementById('postContent')?.focus(), 100);
}
window.openComposer = openComposer;
window.closeComposer = function (e) {
  if (!e || e.target.id === 'composerOverlay')
    document.getElementById('composerOverlay').classList.remove('open');
};
window.openTheme = function () {
  document.getElementById('themeOverlay').classList.add('open');
};
window.closeTheme = function () {
  document.getElementById('themeOverlay').classList.remove('open');
};
window.closeThemeOutside = function (e) {
  if (e.target.id === 'themeOverlay') closeTheme();
};
window.openLightbox = function (src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
};
window.closeLightbox = function () {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
};

/* ════════════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════════ */
window.applyTheme = function (name, el, save = true) {
  document.documentElement.setAttribute('data-theme', name);
  const label = document.getElementById('themeName');
  if (label) label.textContent = THEMES[name] || name;

  if (save) {
    localStorage.setItem('cl_theme', name);
    // Persist to user profile in Firestore for "each user" experience
    if (state.currentUser) {
      updateDoc(doc(db, 'users', state.currentUser.uid), { theme: name })
        .catch(e => console.warn('Theme profile sync failed:', e));
    }
  }

  // Highlight selected card in UI
  document.querySelectorAll('.th-card').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  else {
    // Highlight correct card on load
    document.querySelectorAll('.th-card').forEach(c => {
      const cardText = c.querySelector('span')?.textContent.toLowerCase();
      if (cardText === name || (name === 'classic' && cardText === 'classic')) {
        c.classList.add('active');
      }
    });
  }
};

/* ════════════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════════ */
function toast(msg) {
  const el = document.getElementById('toastEl');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
window.toast = toast;

/* ════════════════════════════════════════════════════════════════
   SIGN OUT
═══════════════════════════════════════════════════════════════ */
window.handleSignOut = async function () {
  if (unsubPosts) unsubPosts();
  await signOut(auth);
  window.location.href = 'login.html';
};

/* ════════════════════════════════════════════════════════════════
   UPDATE POST FORM FIELDS (Dynamic visibility)
   ═══════════════════════════════════════════════════════════════ */
window.updatePostFormFields = function () {
  const typeSelection = document.getElementById('postTypeSelect')?.value;

  // Hide all dynamic fields first
  document.querySelectorAll('.d-field').forEach(el => { el.classList.add('d-field-hidden'); el.style.display = 'none'; });

  if (typeSelection === 'image') {
    document.getElementById('df-image').classList.remove('d-field-hidden'); document.getElementById('df-image').style.display = 'block';
  } else if (typeSelection === 'link') {
    document.getElementById('df-link').classList.remove('d-field-hidden'); document.getElementById('df-link').style.display = 'block';
  } else if (['hackathon', 'workshop', 'cultural', 'symposium'].includes(typeSelection)) {
    document.getElementById('df-image').classList.remove('d-field-hidden'); document.getElementById('df-image').style.display = 'block'; // Poster
    document.getElementById('df-event-group').classList.remove('d-field-hidden'); document.getElementById('df-event-group').style.display = 'block';
    document.getElementById('df-link').classList.remove('d-field-hidden'); document.getElementById('df-link').style.display = 'block'; // Registration Link
  }
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Load IDs on startup
═══════════════════════════════════════════════════════════════ */
async function loadSavedIds() {
  if (!state.currentUser) return;
  try {
    const snap = await getDocs(collection(db, 'users', state.currentUser.uid, 'saved'));
    snap.forEach(d => state.savedPostIds.add(d.id));
    // Re-render posts so save buttons reflect state
    renderPosts();
  } catch (e) { console.warn('Could not load saved IDs:', e); }
}

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Toggle save / unsave a post
═══════════════════════════════════════════════════════════════ */
window.toggleSavePost = async function (postId, btn) {
  if (!state.currentUser) { toast('⚠️ Please sign in to save posts'); return; }
  const isSaved = state.savedPostIds.has(postId);
  const savedRef = doc(db, 'users', state.currentUser.uid, 'saved', postId);

  // Optimistic UI update
  if (isSaved) {
    state.savedPostIds.delete(postId);
    btn.classList.remove('saved');
    btn.textContent = '🔖';
    btn.title = 'Save';
  } else {
    state.savedPostIds.add(postId);
    btn.classList.add('saved');
    btn.textContent = '📌';
    btn.title = 'Unsave';
    // Animate
    btn.style.transform = 'scale(1.3)';
    setTimeout(() => btn.style.transform = '', 250);
  }

  try {
    if (isSaved) {
      await deleteDoc(savedRef);
      toast('🔖 Post removed from saved');
    } else {
      // Find the post data to snapshot-save it
      const post = state.posts.find(p => p.id === postId);
      await setDoc(savedRef, {
        postId,
        savedAt: serverTimestamp(),
        postType: post?.type || 'text',
        authorName: post?.authorName || '',
        authorPhoto: post?.authorPhoto || '',
        text: (post?.text || '').slice(0, 500), // short snapshot
        imageURL: post?.imageURL || '',
        linkURL: post?.linkURL || '',
      });
      toast('📌 Post saved to your collection!');
    }
  } catch (e) {
    console.error('Save error:', e);
    // Revert on failure
    if (isSaved) { state.savedPostIds.add(postId); btn.classList.add('saved'); btn.textContent = '📌'; }
    else { state.savedPostIds.delete(postId); btn.classList.remove('saved'); btn.textContent = '🔖'; }
    toast('❌ Could not update saved post');
  }
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Render the Saved page
═══════════════════════════════════════════════════════════════ */
async function renderSaved() {
  const container = document.getElementById('savedContainer');
  const emptyEl = document.getElementById('savedEmpty');
  const clearBtn = document.getElementById('savedClearBtn');
  if (!container) return;

  container.innerHTML = `<div class="saved-loading"><div class="spinner" style="width:32px;height:32px;border-width:3px"></div><p>Loading saved posts…</p></div>`;
  emptyEl.classList.add('hidden'); emptyEl.style.display = 'none';

  try {
    const q = query(collection(db, 'users', state.currentUser.uid, 'saved'), orderBy('savedAt', 'desc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden'); emptyEl.style.display = 'block';
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }
    if (clearBtn) clearBtn.style.display = '';

    // Fetch the full live post data for each saved ID
    const savedIds = snap.docs.map(d => d.id);
    const savedMeta = {};
    snap.docs.forEach(d => { savedMeta[d.id] = d.data(); });

    // Filter by type if needed
    const filtered = savedIds.filter(id => {
      if (currentSavedFilter === 'all') return true;
      return (savedMeta[id]?.postType || 'text') === currentSavedFilter;
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="empty-state"><h3>No ${currentSavedFilter}s saved</h3><p>Try a different filter.</p></div>`;
      return;
    }

    // Match with live posts array (may not always have all)
    const savedCards = filtered.map(id => {
      const livePost = state.posts.find(p => p.id === id);
      if (livePost) return buildSavedCard(livePost, savedMeta[id]);
      // Fallback: use snapshot from Firestore
      return buildSavedCardFromMeta(id, savedMeta[id]);
    });

    container.innerHTML = savedCards.join('');
  } catch (e) {
    console.error('Render saved error:', e);
    container.innerHTML = `<div class="empty-state"><h3>❌ Could not load saved posts</h3><p>${e.message}</p></div>`;
  }
}

function buildSavedCard(post, meta) {
  const initials = getInitials(post.authorName);
  const photo = post.authorPhoto || '';
  const liked = (post.likedBy || []).includes(state.currentUser?.uid);
  const ts = timeAgo(post.createdAt);
  const savedTs = meta?.savedAt ? timeAgo(meta.savedAt) : '';
  const isSaved = state.savedPostIds.has(post.id);

  let extra = '';
  if (post.imageURL) extra += `<img class="post-img" src="${post.imageURL}" alt="Post image" loading="lazy" onclick="openLightbox('${post.imageURL}')" onerror="this.style.display='none'"/>`;
  if (post.linkURL) {
    const displayLink = post.linkURL.replace(/^https?:\/\//, '').split('/')[0];
    extra += `<div class="link-preview-box" onclick="window.open('${post.linkURL}','_blank')">
      <div class="lp-icon">🔗</div>
      <div class="lp-info"><h5>${escHTML(displayLink)}</h5><p>${escHTML(post.linkURL)}</p></div>
      <div class="lp-arrow">↗️</div></div>`;
  }

  return `<div class="post-card saved-card">
    <div class="saved-badge-row"><span class="saved-when">📌 Saved ${savedTs}</span></div>
    <div class="post-header">
      ${avatarHTML(initials, photo)}
      <div class="post-info"><h4>${post.authorName || 'User'}</h4><p>${ts}</p></div>
      <div class="post-header-right">
        ${(post.authorId && post.authorId !== state.currentUser?.uid) ? `<button class="icon-btn" style="width:34px; height:34px; font-size:1rem; border-color:var(--border); background:var(--bg2)" onclick="window.location.href='messages.html?u=${post.authorId}'" title="Message ${post.authorName}">💬</button>` : ''}
        <span class="post-badge">${typeBadge(post.type)}</span>
      </div>
    </div>
    <div class="post-content">${escHTML(post.text || '')}</div>
    ${extra}
    <div class="post-actions">
      <button class="act-btn ${liked ? 'liked' : ''}" onclick="likePost('${post.id}',this)" title="Like">❤️ ${fmtNum(post.likes || 0)}</button>
      <button class="act-btn" onclick="toggleComments('${post.id}','${post.authorId || ''}','${escAttr(post.authorName || '')}')" title="Comment">💬 ${fmtNum(post.comments || 0)}</button>
      <button class="act-btn save-btn saved" onclick="toggleSavePost('${post.id}',this);renderSaved()" title="Unsave">📌 Unsave</button>
    </div>
    <div class="comment-section" id="cs-${post.id}" style="display:none">
      <div class="comment-list" id="cl-${post.id}"></div>
      <div class="comment-input-row">
        <div class="comment-avatar" id="ca-${post.id}">${getInitials(state.currentUser?.displayName || 'U')}</div>
        <input class="comment-input" id="ci-${post.id}" placeholder="Write a comment…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addComment('${post.id}','${post.authorId || ''}','${escAttr(post.authorName || '')}')}"/>
        <button class="comment-send" onclick="addComment('${post.id}','${post.authorId || ''}','${escAttr(post.authorName || '')}')" title="Send">➤</button>
      </div>
    </div>
  </div>`;
}

function buildSavedCardFromMeta(postId, meta) {
  return `<div class="post-card saved-card">
    <div class="saved-badge-row"><span class="saved-when">📌 Saved ${meta?.savedAt ? timeAgo(meta.savedAt) : ''}</span></div>
    <div class="post-header">
      <div class="post-avatar">${getInitials(meta?.authorName || '?')}</div>
      <div class="post-info"><h4>${escHTML(meta?.authorName || 'Unknown User')}</h4><p>Cached post</p></div>
      <div class="post-header-right"><span class="post-badge">${typeBadge(meta?.postType)}</span></div>
    </div>
    <div class="post-content">${escHTML(meta?.text || '')}</div>
    ${meta?.imageURL ? `<img class="post-img" src="${meta.imageURL}" loading="lazy"/>` : ''}
    <div class="post-actions">
      <button class="act-btn save-btn saved" onclick="toggleSavePost('${postId}',this);renderSaved()" title="Unsave">📌 Unsave</button>
    </div>
  </div>`;
}

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Filter by type
═══════════════════════════════════════════════════════════════ */
window.setSavedFilter = function (btn, type) {
  document.querySelectorAll('.saved-filt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentSavedFilter = type;
  renderSaved();
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Clear all saved posts
═══════════════════════════════════════════════════════════════ */
window.clearAllSaved = async function () {
  if (!state.currentUser) return;
  if (!confirm('Remove ALL saved posts? This cannot be undone.')) return;
  try {
    const snap = await getDocs(collection(db, 'users', state.currentUser.uid, 'saved'));
    const batch_size = snap.docs.length;
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
      state.savedPostIds.delete(d.id);
    }
    toast('Cleared ' + batch_size + ' saved post' + (batch_size !== 1 ? 's' : ''));
    renderSaved();
    renderPosts();
  } catch (e) {
    console.error('Clear saved error:', e);
    toast('Could not clear saved posts');
  }
};

/* ════════════════════════════════════════════════════════════════
   STAT CLICK — My Posts quick-nav
════════════════════════════════════════════════════════════════ */
window.openMyPostsTab = function () {
  const btn = document.querySelector('.ptab[onclick*="myposts"]');
  switchTab(btn, 'myposts');
};

/* ════════════════════════════════════════════════════════════════
   FOLLOWERS MODAL — open / close / load
════════════════════════════════════════════════════════════════ */
let _followersData = [];
let _followingData = [];

window.openFollowersModal = async function () {
  const targetUid = viewingUserId || state.currentUser?.uid;
  const overlay = document.getElementById('followersOverlay');
  const list = document.getElementById('followersList');
  const count = document.getElementById('followersCount');
  const search = document.getElementById('followersSearch');
  overlay.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div class="fm-loading"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><p>Loading followers...</p></div>';
  try {
    const snap = await getDocs(collection(db, 'users', targetUid, 'followers'));
    _followersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (count) count.textContent = '(' + _followersData.length + ')';
    renderFollowList('followers', _followersData);
  } catch (e) {
    list.innerHTML = '<div class="fm-empty">Could not load followers.</div>';
  }
};

window.closeFollowersModal = function (e) {
  if (!e || e.target.id === 'followersOverlay')
    document.getElementById('followersOverlay').classList.remove('open');
};

/* ════════════════════════════════════════════════════════════════
   POST LIKERS MODAL — open / close / load
════════════════════════════════════════════════════════════════ */
window.openLikesModal = async function (postId) {
  const overlay = document.getElementById('likesOverlay');
  const list = document.getElementById('likesList');
  const count = document.getElementById('likesCount');

  if (!overlay || !list) return;

  overlay.classList.add('open');
  list.innerHTML = '<div class="fm-loading"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><p>Loading likers...</p></div>';

  try {
    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (!postSnap.exists()) {
      list.innerHTML = '<div class="fm-empty">Post not found.</div>';
      return;
    }
    const p = postSnap.data();
    const likedBy = p.likedBy || [];

    if (count) count.textContent = '(' + likedBy.length + ')';

    if (!likedBy.length) {
      list.innerHTML = '<div class="fm-empty">No likes yet. ❤️</div>';
      return;
    }

    // Fetch user details for each UID
    const userPromises = likedBy.map(uid => getDoc(doc(db, 'users', uid)));
    const snapshots = await Promise.all(userPromises);
    const users = snapshots.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));

    _renderUserListInModal('likesList', users);
  } catch (e) {
    console.error('Likes load error:', e);
    list.innerHTML = '<div class="fm-empty">Could not load likers.</div>';
  }
};

window.closeLikesModal = function (e) {
  if (!e || e.target.id === 'likesOverlay')
    document.getElementById('likesOverlay').classList.remove('open');
};

/* ── Shared helper for modals ── */
function _renderUserListInModal(elementId, users) {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;

  listEl.innerHTML = users.map(u => {
    const uid = u.uid || u.id;
    const name = u.displayName || 'User';
    const photo = u.photoURL || '';
    const bio = u.bio || u.role || '';
    const initials = getInitials(name);
    const isMe = uid === state.currentUser?.uid;
    const isFollowing = state.followedUsers.has(uid);

    const avatarEl = photo
      ? `<img src="${photo}" alt="${initials}" class="fm-avatar-img" onclick="openLightbox('${photo}')" style="cursor:pointer" onerror="this.style.display='none'">`
      : `<span class="fm-avatar-initials">${initials}</span>`;

    const followBtnEl = isMe
      ? '<span class="fm-you-tag">You</span>'
      : `<button class="fm-follow-btn ${isFollowing ? 'following' : ''}" onclick="toggleFollowFromModal(this,'${name.replace(/'/g, "\\'")}','${uid}')">
          ${isFollowing ? '✓ Following' : '+ Follow'}
        </button>`;

    return `<div class="fm-user-card">
      <div class="fm-avatar" onclick="closeLikesModal(); closeFollowersModal(); closeFollowingModal(); viewUserProfile('${uid}')" style="cursor:pointer">${avatarEl}</div>
      <div class="fm-user-info" onclick="closeLikesModal(); closeFollowersModal(); closeFollowingModal(); viewUserProfile('${uid}')" style="cursor:pointer">
        <h4 class="fm-name">${escHTML(name)}</h4>
        ${bio ? `<p class="fm-bio">${escHTML(bio)}</p>` : ''}
      </div>
      <div class="fm-action">${followBtnEl}</div>
    </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════════════════
   FOLLOWING MODAL — open / close / load
════════════════════════════════════════════════════════════════ */
window.openFollowingModal = async function () {
  const targetUid = viewingUserId || state.currentUser?.uid;
  const overlay = document.getElementById('followingOverlay');
  const list = document.getElementById('followingList');
  const count = document.getElementById('followingCount');
  const search = document.getElementById('followingSearch');
  overlay.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div class="fm-loading"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><p>Loading following...</p></div>';
  try {
    const snap = await getDocs(collection(db, 'users', targetUid, 'following'));
    _followingData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (count) count.textContent = '(' + _followingData.length + ')';
    renderFollowList('following', _followingData);
  } catch (e) {
    list.innerHTML = '<div class="fm-empty">Could not load following list.</div>';
  }
};

window.closeFollowingModal = function (e) {
  if (!e || e.target.id === 'followingOverlay')
    document.getElementById('followingOverlay').classList.remove('open');
};

/* ── Shared: render a user list inside a follow modal ── */
function renderFollowList(type, users) {
  const listEl = document.getElementById(type === 'followers' ? 'followersList' : 'followingList');
  if (!listEl) return;
  if (!users.length) {
    const emptyMsg = type === 'followers'
      ? 'No followers yet. Share posts to grow your audience!'
      : 'Not following anyone yet. Connect with others!';
    listEl.innerHTML = '<div class="fm-empty"><div style="font-size:2.5rem;margin-bottom:10px">' +
      (type === 'followers' ? '\uD83D\uDC65' : '\uD83D\uDC64') +
      '</div><p>' + emptyMsg + '</p></div>';
    return;
  }
  listEl.innerHTML = users.map(function (u) {
    const uid = u.uid || u.id;
    const name = u.displayName || 'User';
    const photo = u.photoURL || '';
    const bio = u.bio || u.role || u.department || '';
    const isMe = uid === state.currentUser?.uid;
    const isFollowing = state.followedUsers.has(uid);
    const initials = getInitials(name);
    const escapedName = name.replace(/'/g, "\\'");

    const avatarEl = photo
      ? '<img src="' + photo + '" alt="' + initials + '" class="fm-avatar-img" onclick="openLightbox(\'' + photo + '\')" style="cursor:pointer" onerror="this.style.display=\'none\'">'
      : '<span class="fm-avatar-initials">' + initials + '</span>';

    const followBtnEl = isMe
      ? '<span class="fm-you-tag">You</span>'
      : '<button class="fm-follow-btn ' + (isFollowing ? 'following' : '') + '" id="fm-btn-' + uid + '" onclick="toggleFollowFromModal(this,\'' + escapedName + '\',\'' + uid + '\')">' +
      (isFollowing ? '\u2713 Following' : '+ Follow') +
      '</button>';

    return '<div class="fm-user-card">' +
      '<div class="fm-avatar" onclick="closeFollowersModal(); closeFollowingModal(); viewUserProfile(\'' + uid + '\')" style="cursor:pointer">' + avatarEl + '</div>' +
      '<div class="fm-user-info" onclick="closeFollowersModal(); closeFollowingModal(); viewUserProfile(\'' + uid + '\')" style="cursor:pointer">' +
      '<h4 class="fm-name">' + escHTML(name) + '</h4>' +
      (bio ? '<p class="fm-bio">' + escHTML(bio) + '</p>' : '') +
      '</div>' +
      '<div class="fm-action">' + followBtnEl + '</div>' +
      '</div>';
  }).join('');
}

/* ── In-modal search filter ── */
window.filterFollowList = function (type, query) {
  const data = type === 'followers' ? _followersData : _followingData;
  const q = query.toLowerCase().trim();
  const filtered = q ? data.filter(function (u) { return (u.displayName || '').toLowerCase().includes(q); }) : data;
  renderFollowList(type, filtered);
};

/* ── Follow / Unfollow from inside a modal ── */
window.toggleFollowFromModal = async function (btn, name, uid) {
  btn.disabled = true;
  await toggleFollow(btn, name, uid);
  btn.disabled = false;
  const isNow = state.followedUsers.has(uid);
  btn.classList.toggle('following', isNow);
  btn.textContent = isNow ? '\u2713 Following' : '+ Follow';
};

/* ════════════════════════════════════════════════════════════════
   MY POSTS TAB — render (list + grid views)
════════════════════════════════════════════════════════════════ */
let myPostsView = 'list';

function renderMyPosts() {
  const container = document.getElementById('myPostsContainer');
  const emptyEl = document.getElementById('myPostsEmpty');
  const nameEl = document.getElementById('mypName');
  const countEl = document.getElementById('mypCount');
  const avatarEl = document.getElementById('mypAvatar');
  if (!container) return;

  const isSelf = !viewingUserId || viewingUserId === state.currentUser?.uid;

  if (isSelf) {
    const name = (state.currentUser && state.currentUser.displayName) || (state.userProfile && state.userProfile.displayName) || 'User';
    const photo = (state.currentUser && state.currentUser.photoURL) || (state.userProfile && state.userProfile.photoURL) || '';
    const initials = getInitials(name);

    if (nameEl) nameEl.textContent = name + "'s Posts";
    if (avatarEl) {
      avatarEl.innerHTML = photo
        ? '<img src="' + photo + '" alt="' + initials + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
        : initials;
    }

    const myPosts = state.posts.filter(function (p) { return p.authorId === (state.currentUser && state.currentUser.uid); });
    if (countEl) countEl.textContent = myPosts.length + ' post' + (myPosts.length !== 1 ? 's' : '') + ' shared';

    if (!myPosts.length) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden'); emptyEl.style.display = 'block';
      return;
    }
    emptyEl.classList.add('hidden'); emptyEl.style.display = 'none';

    if (myPostsView === 'grid') {
      container.className = 'myp-grid';
      container.innerHTML = myPosts.map(function (p) { return buildMyPostGridCard(p); }).join('');
    } else {
      container.className = 'myp-list';
      container.innerHTML = myPosts.map(function (p, i) { return buildPostHTML(p, i); }).join('');
    }
  } else {
    // Viewing someone else
    container.innerHTML = `<div class="saved-loading"><div class="spinner"></div><p>Loading profile…</p></div>`;
    getDoc(doc(db, 'users', viewingUserId)).then(snap => {
      if (!snap.exists()) {
        container.innerHTML = `<div class="empty-state"><h3>👤 User Not Found</h3></div>`;
        return;
      }
      const u = snap.data();
      const name = u.displayName || 'User';
      const photo = u.photoURL || '';
      const initials = getInitials(name);

      if (nameEl) nameEl.textContent = name + "'s Posts";
      if (avatarEl) {
        avatarEl.innerHTML = photo
          ? '<img src="' + photo + '" alt="' + initials + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
          : initials;
      }

      const userPosts = state.posts.filter(function (p) { return p.authorId === viewingUserId; });
      if (countEl) countEl.textContent = userPosts.length + ' post' + (userPosts.length !== 1 ? 's' : '') + ' shared';

      if (!userPosts.length) {
        container.innerHTML = '';
        emptyEl.classList.remove('hidden'); emptyEl.style.display = 'block';
        return;
      }
      emptyEl.classList.add('hidden'); emptyEl.style.display = 'none';

      if (myPostsView === 'grid') {
        container.className = 'myp-grid';
        container.innerHTML = userPosts.map(function (p) { return buildMyPostGridCard(p); }).join('');
      } else {
        container.className = 'myp-list';
        container.innerHTML = userPosts.map(function (p, i) { return buildPostHTML(p, i); }).join('');
      }
    }).catch(e => {
      container.innerHTML = `<div class="empty-state"><h3>❌ Error loading profile</h3></div>`;
    });
  }
}

function buildMyPostGridCard(p) {
  const ts = timeAgo(p.createdAt);
  const hasImg = !!p.imageURL;
  const text = (p.text || '').slice(0, 120) + ((p.text || '').length > 120 ? '...' : '');
  const overlay = '<div class="myp-grid-overlay"><span>\u2764\uFE0F ' + fmtNum(p.likes || 0) + '</span><span>\uD83D\uDCAC ' + fmtNum(p.comments || 0) + '</span></div>';

  const imgPart = '<div class="myp-grid-img" style="background-image:url(\'' + p.imageURL + '\')">' + overlay + '</div>';
  const textPart = '<div class="myp-grid-text"><p>' + escHTML(text) + '</p></div>';

  return '<div class="myp-grid-card" onclick="expandMyPost(\'' + p.id + '\')">' +
    (hasImg ? imgPart : textPart) +
    '<div class="myp-grid-footer">' +
    '<span class="myp-grid-badge">' + typeBadge(p.type) + '</span>' +
    '<span class="myp-grid-time">' + ts + '</span>' +
    '</div>' +
    '</div>';
}

window.expandMyPost = function (postId) {
  setMyPostsView('list', document.getElementById('mypListBtn'));
  setTimeout(function () {
    const myPosts = state.posts.filter(function (p) { return p.authorId === (state.currentUser && state.currentUser.uid); });
    const idx = myPosts.findIndex(function (p) { return p.id === postId; });
    const cards = document.querySelectorAll('#myPostsContainer .post-card');
    if (cards[idx]) {
      cards[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      cards[idx].style.outline = '3px solid var(--primary)';
      setTimeout(function () { cards[idx].style.outline = ''; }, 2000);
    }
  }, 150);
};

window.setMyPostsView = function (view, btn) {
  myPostsView = view;
  document.querySelectorAll('.myp-view-btn').forEach(function (b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderMyPosts();
};

window.toggleExpandPost = function (postId) {
  const wrap = document.getElementById(`ptw-${postId}`);
  if (wrap) {
    wrap.classList.toggle('expanded');

    // Smooth transition logic: although handled by CSS mostly, 
    // we toggle the extra hidden content display programmatically as well
    const card = wrap.closest('.post-card');
    if (card) {
      const extra = card.querySelectorAll('.post-extra-hidden');
      const isExpanded = wrap.classList.contains('expanded');
      extra.forEach(el => {
        el.style.display = isExpanded ? 'block' : 'none';
      });
      // Scroll to view if it's too long? Maybe not, user didn't ask.
    }
  }
};


/* ══════════════════════════════════════════════════════════════
   STRIDE CHALLENGES SYSTEM (Integrated Logic)
   ══════════════════════════════════════════════════════════════ */
let activeChId = null;
let activeDayIdx = -1;

function renderChHome() {
  const grid = document.getElementById('chGrid');
  const empty = document.getElementById('chEmpty');
  const home = document.getElementById('chHome');
  const detail = document.getElementById('chDetail');

  if (!grid || !home) return;

  home.classList.remove('hidden');
  detail.classList.add('hidden');
  grid.innerHTML = '';

  const list = state.challenges || [];

  if (list.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.forEach(c => {
    const completed = c.completedDays.length;
    const pct = (completed / c.days) * 100;
    const card = document.createElement('div');
    card.className = 'ch-card';
    card.onclick = (e) => {
      if (e.target.closest('.del-ch')) return;
      viewChDetail(c.id);
    };
    card.innerHTML = `
      <div class="ch-card-header">
        <h3 class="ch-card-title">${c.title}</h3>
        <span class="ch-card-badge">${pct.toFixed(0)}%</span>
      </div>
      <button class="del-ch" onclick="deleteChallenge('${c.id}')">✕</button>
      <div class="ch-card-meta">
        <div class="meta-item">📅 <span>${formatChDate(c.start)}</span></div>
        <div class="meta-item">🎯 <span>${c.days} Days</span></div>
      </div>
      <div class="ch-progress-wrap">
        <div class="ch-progress-header">
          <span>Overall Progression</span>
          <span>${completed} / ${c.days}</span>
        </div>
        <div class="ch-progress-bar">
          <div class="ch-progress-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}
window.renderChHome = renderChHome;

function viewChDetail(id) {
  activeChId = id;
  const c = (state.challenges || []).find(i => i.id === id);
  if (!c) return;

  document.getElementById('chHome').classList.add('hidden');
  document.getElementById('chDetail').classList.remove('hidden');

  document.getElementById('chDetTitle').textContent = c.title;
  document.getElementById('chDetDuration').textContent = `${c.days} Days`;
  document.getElementById('chDetStart').textContent = formatChDate(c.start);
  document.getElementById('chDetTotal').textContent = c.days;
  
  const completedCount = c.completedDays.length;
  const pct = (completedCount / c.days) * 100;
  document.getElementById('chDetProgText').textContent = `${completedCount} / ${c.days}`;
  document.getElementById('chDetProgFill').style.width = `${pct}%`;

  const timeline = document.getElementById('chTimeline');
  timeline.innerHTML = '';

  for (let i = 0; i < c.days; i++) {
    const isComp = c.completedDays.includes(i);
    const isActive = !isComp && i === c.activeDayIndex;
    const isLocked = !isComp && i > c.activeDayIndex;

    const row = document.createElement('div');
    row.className = `ch-day-row ${isComp ? 'completed' : (isActive ? 'active' : 'locked')}`;
    
    if (isActive) {
      row.onclick = () => openChPostModal(i, c.title);
    }

    let msg = isLocked ? "Locked" : (isActive ? "Check-in now" : "All Done!");
    let icon = isComp ? "💎" : (isActive ? "✨" : "🔒");

    row.innerHTML = `
      <div class="ch-day-top">
        <div class="ch-day-num">Day ${i + 1}</div>
        <div class="ch-day-icon">${icon}</div>
      </div>
      <div class="ch-day-info">
        <p style="font-weight:700; color:var(--text); margin-bottom:4px">${msg}</p>
        <p style="opacity:0.6">${isComp ? 'Challenge completed successfully' : 'Progress tracker'}</p>
      </div>
    `;
    timeline.appendChild(row);
  }
}
window.viewChDetail = viewChDetail;

function backToChHome() {
  renderChHome();
}
window.backToChHome = backToChHome;

async function deleteChallenge(id) {
  if (!confirm("Delete this challenge?")) return;
  try {
    await deleteDoc(doc(db, 'users', state.currentUser.uid, 'challenges', id));
    toast("Challenge deleted 🗑️");
    if (activeChId === id) backToChHome();
  } catch (e) {
    toast("❌ Error deleting challenge");
  }
}
window.deleteChallenge = deleteChallenge;

/* MODALS */
function openChCreateModal() {
  document.getElementById('chNewStart').value = new Date().toISOString().split('T')[0];
  document.getElementById('chCreateOverlay').classList.add('open');
}
window.openChCreateModal = openChCreateModal;

function closeChCreateModal() {
  document.getElementById('chCreateOverlay').classList.remove('open');
}
window.closeChCreateModal = closeChCreateModal;

async function handleChCreate() {
  const title = document.getElementById('chNewTitle').value;
  const days = parseInt(document.getElementById('chNewDays').value);
  const start = document.getElementById('chNewStart').value;
  const desc = document.getElementById('chNewDesc').value;

  if (!title || days < 1) return;

  const btn = document.querySelector('button[onclick="handleChCreate()"]');
  if (btn) btn.disabled = true;

  try {
    const newCh = {
      title, days, start, desc,
      completedDays: [],
      activeDayIndex: 0,
      createdAt: serverTimestamp()
    };

    await addDoc(collection(db, 'users', state.currentUser.uid, 'challenges'), newCh);
    closeChCreateModal();
    toast("Challenge Started! 🚀");
  } catch (e) {
    toast("❌ Error creating challenge");
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.handleChCreate = handleChCreate;

function closeChPostModal() {
  document.getElementById('chPostOverlay').classList.remove('open');
}
window.closeChPostModal = closeChPostModal;

let currentChPostType = 'text';

function setChPostType(type, btn) {
  currentChPostType = type;
  document.querySelectorAll('.ch-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // Hide all fields
  document.getElementById('chFieldImage').classList.add('hidden');
  document.getElementById('chFieldPoll').classList.add('hidden');
  document.getElementById('chFieldQuiz').classList.add('hidden');

  // Show target
  if (type === 'image') document.getElementById('chFieldImage').classList.remove('hidden');
  if (type === 'poll') document.getElementById('chFieldPoll').classList.remove('hidden');
  if (type === 'quiz') document.getElementById('chFieldQuiz').classList.remove('hidden');
}
window.setChPostType = setChPostType;

function openChPostModal(idx, title) {
  activeDayIdx = idx;
  document.getElementById('chPostTitle').textContent = `Day ${idx + 1}`;
  document.getElementById('chPostSub').textContent = title;
  document.getElementById('chPostContent').value = '';
  
  // Reset fields
  currentChPostType = 'text';
  document.querySelectorAll('.ch-type-btn').forEach(b => b.classList.remove('active'));
  const textBtn = document.querySelector('.ch-type-btn');
  if (textBtn) textBtn.classList.add('active');
  
  document.getElementById('chFieldImage').classList.add('hidden');
  document.getElementById('chFieldPoll').classList.add('hidden');
  document.getElementById('chFieldQuiz').classList.add('hidden');

  document.getElementById('chPostOverlay').classList.add('open');
}
window.openChPostModal = openChPostModal;

function previewChImage(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('chImagePreview').src = e.target.result;
    document.getElementById('chImagePreviewArea').classList.remove('hidden');
    document.getElementById('chImageSelectBtn').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}
window.previewChImage = previewChImage;

function clearChImage() {
  document.getElementById('chPostImageFile').value = '';
  document.getElementById('chImagePreviewArea').classList.add('hidden');
  document.getElementById('chImageSelectBtn').classList.remove('hidden');
}
window.clearChImage = clearChImage;

async function submitChDayPost() {
  const text = document.getElementById('chPostContent').value.trim();
  if (!text) return toast("Share your thoughts on today's progress ✍️");

  const idx = (state.challenges || []).findIndex(c => c.id === activeChId);
  if (idx === -1) return;

  const ch = state.challenges[idx];
  let imageURL = null;

  // Handle Image Upload if needed
  if (currentChPostType === 'image') {
    const file = document.getElementById('chPostImageFile').files[0];
    if (file) {
      toast("📤 Uploading image...");
      try {
        imageURL = await uploadImageStorage(file);
      } catch (err) {
        console.error("Upload failed", err);
        return toast("❌ Image upload failed");
      }
    }
  }

  // Prepare Post Data
  let postParams = {
    type: 'text',
    text: `[Stride] Day ${activeDayIdx + 1}: ${text}`,
    tags: ['Stride', 'Progress']
  };

  if (imageURL) {
    postParams.type = 'image';
    postParams.imageURL = imageURL;
  } else if (currentChPostType === 'poll') {
    const q = document.getElementById('chPostPollQ').value.trim();
    const opts = Array.from(document.querySelectorAll('.ch-poll-opt')).map(o => o.value.trim()).filter(v => v);
    if (q && opts.length >= 2) {
       postParams.type = 'poll';
       postParams.pollData = { question: q, options: opts.map(o => ({ text: o, votes: [] })) };
    }
  } else if (currentChPostType === 'quiz') {
    const q = document.getElementById('chPostQuizQ').value.trim();
    const ans = document.getElementById('chPostQuizAns').value.trim();
    const w1 = document.getElementById('chPostQuizOpt1').value.trim();
    const w2 = document.getElementById('chPostQuizOpt2').value.trim();
    if (q && ans && w1) {
       postParams.type = 'quiz';
       postParams.quizData = { 
         question: q, 
         options: [ { text: ans, correct: true }, { text: w1, correct: false }, { text: w2, correct: false } ].filter(o => o.text)
       };
    }
  }

  // Complete the day locally & Push to Firestore
  if (!ch.completedDays.includes(activeDayIdx)) {
    const newCompleted = [...ch.completedDays, activeDayIdx];
    let newActiveIdx = Math.min(ch.days - 1, activeDayIdx + 1);
    if (newCompleted.length === ch.days) newActiveIdx = 999;

    try {
      await updateDoc(doc(db, 'users', state.currentUser.uid, 'challenges', activeChId), {
        completedDays: newCompleted,
        activeDayIndex: newActiveIdx
      });
      toast(`Day ${activeDayIdx + 1} streak saved! 💎`);
    } catch (e) {
      toast("❌ Error saving progress to cloud");
    }
  }

  closeChPostModal();
  viewChDetail(activeChId);
  
  // Create real post if available
  if (typeof createPost === 'function') {
    // Note: createPost normally reads from DOM, we need a programmatic version
    // but standard practice here is to use addDoc directly or wrap createPost
    // We'll call createNewPost which we defined above or similar.
    createNewPost(postParams);
  }
}

// ── PROGRAMMATIC POST CREATION HELPER ──
async function createNewPost(params) {
  try {
    const postData = {
      ...params,
      authorId: state.currentUser.uid,
      authorName: state.currentUser.displayName || state.userProfile?.displayName || 'User',
      authorPhoto: state.currentUser.photoURL || state.userProfile?.photoURL || '',
      likes: 0,
      likedBy: [],
      comments: 0,
      shares: 0,
      sharedBy: [],
      createdAt: serverTimestamp()
    };
    await addDoc(collection(db, 'posts'), postData);
    toast('🚀 Challenge progress shared to feed!');
  } catch (err) {
    console.error('Error creating programmatic post:', err);
  }
}
window.createNewPost = createNewPost;
window.submitChDayPost = submitChDayPost;

function formatChDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
