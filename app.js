/* ================================================================
   app.js — CampusLink Main Application Logic (Firebase ES Module)
   ================================================================ */
import { auth, db, storage, googleProvider } from './firebase-config.js';
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, where, increment
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import {
  ref, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

/* ════════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */
let currentUser     = null;
let userProfile     = null;
let posts           = [];
let unsubPosts      = null;   // Firestore realtime listener
let toastTimer      = null;
let currentPostType = 'text';
const followedUsers   = new Set(); // tracks UIDs followed this session
const commentUnsubs   = {};        // per-post Firestore listeners
const savedPostIds    = new Set(); // tracks saved post IDs
let notifDropOpen     = false;
let msgDropOpen       = false;
let currentSearchCategory = 'all';
let currentSearchQuery    = '';
let currentSavedFilter    = 'all';

/* ════════════════════════════════════════════════════════════════
   THEME NAMES MAP
═══════════════════════════════════════════════════════════════ */
const THEMES = {
  emerald:'Emerald', ocean:'Ocean', violet:'Violet',
  midnight:'Midnight', rose:'Rose', solar:'Solar'
};

/* ════════════════════════════════════════════════════════════════
   AUTH GUARD — redirect to login if not signed in
═══════════════════════════════════════════════════════════════ */
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = user;
  // Load Firestore profile
  const snap = await getDoc(doc(db, 'users', user.uid));
  userProfile = snap.exists() ? snap.data() : {};

  // Load persisted following list into the Set
  try {
    const followSnap = await getDocs(collection(db, 'users', user.uid, 'following'));
    followSnap.forEach(d => followedUsers.add(d.id));
  } catch(e) { console.warn('Could not load following list:', e); }

  initUI();
});

/* ════════════════════════════════════════════════════════════════
   INIT UI  — runs after auth confirmed
═══════════════════════════════════════════════════════════════ */
function initUI() {
  // Restore theme
  const savedTheme = localStorage.getItem('cl_theme') || 'emerald';
  applyTheme(savedTheme, null, false);

  // Update profile elements
  const initials = getInitials(currentUser.displayName || userProfile.displayName || 'User');
  const photo    = currentUser.photoURL || userProfile.photoURL || '';

  setAvatarEl('navAvatar',   initials, photo, false);
  setAvatarEl('lsbAvatar',   initials, photo, true);
  setAvatarEl('createAvatar',initials, photo, false);

  document.getElementById('profileName').textContent = currentUser.displayName || userProfile.displayName || 'User';

  // Build role line: "Student • CSE • IIT Madras" or fallback
  const roleParts = [];
  if (userProfile.role)       roleParts.push(userProfile.role);
  if (userProfile.department) roleParts.push(userProfile.department);
  if (userProfile.college)    roleParts.push(userProfile.college);
  document.getElementById('profileRole').textContent = roleParts.length ? roleParts.join(' • ') : 'CampusLink Member';

  document.getElementById('levelBadge').textContent  = `⭐ Level ${userProfile.level || 1}`;

  // Stats
  const cred = Math.min(100, (userProfile.posts || 0) * 5 + (userProfile.followers || 0));
  document.getElementById('credFill').style.width = cred + '%';
  document.getElementById('credPct').textContent  = cred + '%';
  document.getElementById('statFollowers').textContent = fmtNum(userProfile.followers || 0);
  document.getElementById('statFollowing').textContent = fmtNum(userProfile.following || 0);
  document.getElementById('statPosts').textContent     = fmtNum(userProfile.posts    || 0);

  // Start listeners
  listenPosts();
  renderHackathons();
  renderTopUsers();
  renderExplore();
  listenNotifications();
  listenMessages();
  loadSavedIds(); // Load saved post IDs from Firestore

  // Show admin link if admin
  if (userProfile.isAdmin || userProfile.role === 'admin') {
    const adminLink = document.getElementById('adminNavLink');
    const adminMob  = document.getElementById('adminNavLinkMobile');
    if (adminLink) adminLink.style.display = 'flex';
    if (adminMob)  adminMob.style.display  = 'flex';
  }

  // ── FINAL STEP: Hide Loader ──
  setTimeout(() => {
    document.body.classList.remove('loading');
    document.body.classList.add('loaded');
  }, 200);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeComposer(); closeLightbox(); closeTheme(); closeNotifDropdown(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('globalSearch').focus(); }
  });

  // Close notif dropdown when clicking outside
  document.addEventListener('click', e => {
    const dropN = document.getElementById('notifDropdown');
    const btnN  = document.getElementById('notifBtn');
    if (dropN && !dropN.contains(e.target) && !btnN.contains(e.target)) closeNotifDropdown();

    const dropM = document.getElementById('msgDropdown');
    const btnM  = document.getElementById('msgBtn');
    if (dropM && !dropM.contains(e.target) && !btnM.contains(e.target)) closeMsgDropdown();
  });

  // Search
  document.getElementById('globalSearch').addEventListener('input', handleSearch);
}

/* ════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
}
function fmtNum(n) { return n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n); }
function timeAgo(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400)return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function setAvatarEl(id, initials, photo, wrap) {
  const el = document.getElementById(id);
  if (!el) return;
  if (photo) { el.innerHTML = `<img src="${photo}" alt="${initials}" onerror="this.style.display='none'">`; }
  else        { el.textContent = initials; }
}
function avatarHTML(initials, photo, size='post') {
  const cls = size === 'post' ? 'post-avatar' : 'lb-avatar';
  if (photo) return `<div class="${cls}"><img src="${photo}" alt="${initials}"></div>`;
  return `<div class="${cls}">${initials}</div>`;
}

/* ════════════════════════════════════════════════════════════════
   FIRESTORE — REALTIME POSTS LISTENER
═══════════════════════════════════════════════════════════════ */
function listenPosts() {
  if (unsubPosts) unsubPosts();
  const q = query(collection(db, 'posts'), orderBy('createdAt','desc'), limit(30));
  unsubPosts = onSnapshot(q, snap => {
    posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderPosts();
  });
}

/* ════════════════════════════════════════════════════════════════
   RENDER POSTS
═══════════════════════════════════════════════════════════════ */
function renderPosts() {
  const container  = document.getElementById('postsContainer');
  const emptyState = document.getElementById('emptyFeed');
  
  if (!container) return; // Not on feed page

  // Apply filters from global state
  const map = { all:null, post:'text', image:'image', link:'link', project:'project', hackathon:'hackathon' };
  const targetType = map[currentSearchCategory];
  
  const list = posts.filter(p => {
    const matchType = !targetType || (p.type === targetType);
    const matchKwd  = !currentSearchQuery || (
      (p.text || '').toLowerCase().includes(currentSearchQuery) || 
      (p.authorName || '').toLowerCase().includes(currentSearchQuery) || 
      (p.tags || []).some(t => t.toLowerCase().includes(currentSearchQuery))
    );
    return matchType && matchKwd;
  });

  if (!list.length) {
    container.innerHTML = '';
    emptyState.style.display = 'block';
    const emptyMsg = currentSearchQuery 
      ? `<h3>🔍 No results for "${currentSearchQuery}" ${currentSearchCategory !== 'all' ? 'in ' + currentSearchCategory + 's' : ''}</h3>`
      : `<h3>📭 No ${currentSearchCategory === 'all' ? 'posts' : currentSearchCategory + 's'} found yet</h3>`;
    emptyState.innerHTML = `<div class="empty-state">${emptyMsg}<p>Try a different keyword or category.</p></div>`;
    return;
  }
  
  emptyState.style.display = 'none';
  container.innerHTML = list.map((p, i) => buildPostHTML(p, i)).join('');
}

function buildPostHTML(p, idx) {
  const initials  = getInitials(p.authorName);
  const photo     = p.authorPhoto || '';
  const liked     = (p.likedBy || []).includes(currentUser?.uid);
  const ts        = timeAgo(p.createdAt);
  const isOwnPost = p.authorId === currentUser?.uid;
  const isFollowing = followedUsers.has(p.authorId);

  // Follow button — hidden on own posts
  const followBtn = isOwnPost
    ? `<span class="own-post-tag">You</span>`
    : `<button
        class="post-follow-btn ${isFollowing ? 'following' : ''}"
        onclick="toggleFollow(this,'${(p.authorName||'').replace(/'/g,"\\'")  }','${p.authorId}')"
        title="${isFollowing ? 'Unfollow' : 'Follow'} ${p.authorName}"
      >${isFollowing ? '✓ Following' : '+ Follow'}</button>`;

  let extra = '';

  // 1. Link Preview
  if (p.linkURL) {
    const displayLink = p.linkURL.replace(/^https?:\/\//, '').split('/')[0];
    extra += `<div class="link-preview-box" onclick="window.open('${p.linkURL}','_blank')">
      <div class="lp-icon">🔗</div>
      <div class="lp-info">
        <h5>${escHTML(displayLink)}</h5>
        <p>${escHTML(p.linkURL)}</p>
      </div>
      <div class="lp-arrow">↗️</div>
    </div>`;
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
    extra += `<img class="post-img" src="${p.imageURL}" alt="Post image" loading="lazy" onclick="openLightbox('${p.imageURL}')"/>`;
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
      <div class="post-info">
        <h4>${p.authorName || 'User'}</h4>
        <p>${ts}</p>
      </div>
      <div class="post-header-right">
        <span class="post-badge">${typeBadge(p.type)}</span>
        ${followBtn}
      </div>
    </div>
    <div class="post-content">${escHTML(p.text || '')}</div>
    ${extra}
    <div class="post-stats">
      <span>❤️ ${fmtNum(p.likes || 0)}</span>
      <span>💬 ${fmtNum(p.comments || 0)}</span>
      <span>↗️ ${p.shares || 0}</span>
    </div>
    <div class="post-actions">
      <button class="act-btn ${liked ? 'liked' : ''}" onclick="likePost('${p.id}',this)" title="Like">❤️</button>
      <button class="act-btn" onclick="toggleComments('${p.id}','${(p.authorId||'')}','${escAttr(p.authorName||'')}')" title="Comment">💬</button>
      <button class="act-btn" onclick="sharePost('${p.id}')" title="Share">↗️</button>
      <button class="act-btn save-btn ${savedPostIds.has(p.id) ? 'saved' : ''}" onclick="toggleSavePost('${p.id}',this)" title="${savedPostIds.has(p.id) ? 'Unsave' : 'Save'}">${savedPostIds.has(p.id) ? '📌' : '🔖'}</button>
    </div>
    <!-- Comment Section (hidden by default) -->
    <div class="comment-section" id="cs-${p.id}" style="display:none">
      <div class="comment-list" id="cl-${p.id}"></div>
      <div class="comment-input-row">
        <div class="comment-avatar" id="ca-${p.id}">AJ</div>
        <input class="comment-input" id="ci-${p.id}" placeholder="Write a comment…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addComment('${p.id}','${(p.authorId||'')}','${escAttr(p.authorName||'')}')}"/>
        <button class="comment-send" onclick="addComment('${p.id}','${(p.authorId||'')}','${escAttr(p.authorName||'')}')" title="Send">➤</button>
      </div>
    </div>
  </div>`;
}

function typeBadge(type) {
  const map = { text:'📝 Post', image:'🖼️ Image', link:'🔗 Link', project:'🛠️ Project', hackathon:'🏆 Hackathon' };
  return map[type] || '📝 Post';
}
function escHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}
function escAttr(str) {
  return str.replace(/'/g,'&#39;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════════════════════
   COMMENTS — toggle section open/close
═══════════════════════════════════════════════════════════════ */
window.toggleComments = function(postId, authorId, authorName) {
  const section = document.getElementById(`cs-${postId}`);
  if (!section) return;

  const isOpen = section.style.display !== 'none';
  section.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    // Populate current user avatar in input row
    const caEl = document.getElementById(`ca-${postId}`);
    if (caEl) {
      const photo = currentUser?.photoURL;
      const initials = getInitials(currentUser?.displayName || 'U');
      if (photo) caEl.innerHTML = `<img src="${photo}" alt="${initials}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      else caEl.textContent = initials;
    }

    // Start real-time listener for this post's comments
    if (!commentUnsubs[postId]) {
      const q = query(collection(db, 'posts', postId, 'comments'), orderBy('createdAt','asc'));
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
    const init  = getInitials(c.authorName || 'U');
    const photo = c.authorPhoto || '';
    const ts    = timeAgo(c.createdAt);
    const avatarEl = photo
      ? `<div class="cmt-avatar"><img src="${photo}" alt="${init}"></div>`
      : `<div class="cmt-avatar">${init}</div>`;
    const isOwn = c.authorId === currentUser?.uid;
    return `<div class="cmt-row">
      ${avatarEl}
      <div class="cmt-bubble">
        <div class="cmt-meta"><span class="cmt-name">${escHTML(c.authorName||'User')}</span><span class="cmt-time">${ts}</span></div>
        <div class="cmt-text">${escHTML(c.text||'')}</div>
      </div>
      ${isOwn ? `<button class="cmt-del" onclick="deleteComment('${postId}','${c.id}')" title="Delete">🗑️</button>` : ''}
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

/* ════════════════════════════════════════════════════════════════
   COMMENTS — add
═══════════════════════════════════════════════════════════════ */
window.addComment = async function(postId, postAuthorId, postAuthorName) {
  const input = document.getElementById(`ci-${postId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!currentUser) { toast('⚠️ Please sign in to comment'); return; }

  input.value = '';
  input.disabled = true;

  try {
    const commentData = {
      text,
      authorId:    currentUser.uid,
      authorName:  currentUser.displayName || userProfile?.displayName || 'User',
      authorPhoto: currentUser.photoURL || userProfile?.photoURL || '',
      createdAt:   serverTimestamp()
    };

    // Add comment to sub-collection
    await addDoc(collection(db, 'posts', postId, 'comments'), commentData);

    // Increment comment count on post
    try { await updateDoc(doc(db, 'posts', postId), { comments: increment(1) }); } catch {}

    // ── Send notification to post owner (skip if own post) ──
    if (postAuthorId && postAuthorId !== currentUser.uid) {
      try {
        await addDoc(collection(db, 'notifications', postAuthorId, 'items'), {
          type:      'comment',
          fromId:    currentUser.uid,
          fromName:  currentUser.displayName || 'Someone',
          fromPhoto: currentUser.photoURL || '',
          postId,
          message:   `💬 ${currentUser.displayName || 'Someone'} commented on your post`,
          read:      false,
          createdAt: serverTimestamp()
        });
      } catch(e) { console.warn('Notification failed:', e); }
    }

    toast('💬 Comment posted!');
  } catch(e) {
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
window.deleteComment = async function(postId, commentId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await deleteDoc(doc(db, 'posts', postId, 'comments', commentId));
    await updateDoc(doc(db, 'posts', postId), { comments: increment(-1) });
    toast('🗑️ Comment deleted');
  } catch(e) { toast('❌ Could not delete comment'); }
};

/* ════════════════════════════════════════════════════════════════
   NOTIFICATIONS — real-time listener
═══════════════════════════════════════════════════════════════ */
function listenNotifications() {
  if (!currentUser) return;
  const q = query(
    collection(db, 'notifications', currentUser.uid, 'items'),
    orderBy('createdAt','desc'),
    limit(20)
  );
  onSnapshot(q, snap => {
    const notifs   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unread   = notifs.filter(n => !n.read).length;
    const badge    = document.querySelector('.notif-badge');
    if (badge) {
      badge.textContent = unread || '';
      badge.style.display = unread ? 'flex' : 'none';
    }
    // Re-render dropdown if open
    const drop = document.getElementById('notifDropdown');
    if (drop && notifDropOpen) renderNotifDropdown(notifs);
    // Store for dropdown use
    document.getElementById('notifBtn')._notifs = notifs;
  });
}

/* ════════════════════════════════════════════════════════════════
   NOTIFICATIONS — open/close dropdown
═══════════════════════════════════════════════════════════════ */
window.toggleNotifDropdown = function(e) {
  e.stopPropagation();
  const btn    = document.getElementById('notifBtn');
  const notifs = btn._notifs || [];
  let drop = document.getElementById('notifDropdown');

  if (notifDropOpen) { closeNotifDropdown(); return; }
  if (msgDropOpen) closeMsgDropdown();

  // Create dropdown
  drop = document.createElement('div');
  drop.id = 'notifDropdown';
  drop.className = 'notif-dropdown';
  document.body.appendChild(drop);
  notifDropOpen = true;
  renderNotifDropdown(notifs);

  // Mark all as read after 2s
  setTimeout(async () => {
    const unread = notifs.filter(n => !n.read);
    for (const n of unread) {
      try { await updateDoc(doc(db,'notifications',currentUser.uid,'items',n.id), { read: true }); } catch {}
    }
  }, 2000);
};

function closeNotifDropdown() {
  const drop = document.getElementById('notifDropdown');
  if (drop) drop.remove();
  notifDropOpen = false;
}

function renderNotifDropdown(notifs) {
  const drop = document.getElementById('notifDropdown');
  if (!drop) return;
  const btn = document.getElementById('notifBtn');
  const rect = btn.getBoundingClientRect();
  drop.style.cssText = `position:fixed;top:${rect.bottom+6}px;right:${window.innerWidth - rect.right}px;z-index:2000;min-width:300px;max-width:340px;`;

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
          ? `<img src="${n.fromPhoto}" alt="${n.fromName}" onerror="this.style.display='none'">`
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
  if (!currentUser) return;
  // Listen to recent snippets/chats for this user
  const q = query(
    collection(db, 'users', currentUser.uid, 'recent_chats'),
    orderBy('lastAt','desc'),
    limit(10)
  );
  onSnapshot(q, snap => {
    const chats    = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const unread   = chats.filter(c => c.unreadCount > 0).length;
    const badge    = document.querySelector('.msg-badge');
    if (badge) {
      badge.textContent = unread || '';
      badge.style.display = unread ? 'flex' : 'none';
    }
    // Re-render dropdown if open
    const drop = document.getElementById('msgDropdown');
    if (drop && msgDropOpen) renderMsgDropdown(chats);
    // Store for dropdown use
    document.getElementById('msgBtn')._chats = chats;
  });
}

/* ════════════════════════════════════════════════════════════════
   MESSAGES — open/close dropdown
═══════════════════════════════════════════════════════════════ */
window.toggleMsgDropdown = function(e) {
  e.stopPropagation();
  const btn   = document.getElementById('msgBtn');
  const chats = btn._chats || [];
  let drop    = document.getElementById('msgDropdown');

  if (msgDropOpen) { closeMsgDropdown(); return; }
  if (notifDropOpen) closeNotifDropdown();

  // Create dropdown
  drop = document.createElement('div');
  drop.id = 'msgDropdown';
  drop.className = 'notif-dropdown msg-dropdown'; // reuse base styles
  document.body.appendChild(drop);
  msgDropOpen = true;
  renderMsgDropdown(chats);
};

function closeMsgDropdown() {
  const drop = document.getElementById('msgDropdown');
  if (drop) drop.remove();
  msgDropOpen = false;
}

function renderMsgDropdown(chats) {
  const drop = document.getElementById('msgDropdown');
  if (!drop) return;
  const btn = document.getElementById('msgBtn');
  const rect = btn.getBoundingClientRect();
  drop.style.cssText = `position:fixed;top:${rect.bottom+6}px;right:${window.innerWidth - rect.right}px;z-index:2000;min-width:300px;max-width:340px;`;

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
        const init  = getInitials(c.withName);
        const photo = c.withPhoto
          ? `<img src="${c.withPhoto}" alt="${c.withName}" onerror="this.style.display='none'">`
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
  const proj = posts.filter(p => p.type === 'project');
  const container = document.getElementById('projectsContainer');
  if (!proj.length) {
    container.innerHTML = `<div class="empty-state"><h3>🛠️ No Projects Yet</h3><p>Be the first to share a project!</p></div>`;
    return;
  }
  container.innerHTML = proj.map(p => buildPostHTML(p, 0)).join('');
}

/* ════════════════════════════════════════════════════════════════
   RENDER EVENTS
═══════════════════════════════════════════════════════════════ */
const EVENTS_DATA = [
  { icon:'🤖', title:'AI Workshop',       date:'Mar 25, 2025', attendees:342 },
  { icon:'💻', title:'Web Dev Meetup',    date:'Mar 28, 2025', attendees:215 },
  { icon:'🐍', title:'Python Bootcamp',   date:'Apr 1, 2025',  attendees:428 },
  { icon:'📱', title:'Mobile Dev Summit', date:'Apr 5, 2025',  attendees:189 }
];
function renderEvents() {
  document.getElementById('eventsContainer').innerHTML = EVENTS_DATA.map(ev => `
    <div class="event-card">
      <div class="event-icon">${ev.icon}</div>
      <div class="event-info">
        <h3>${ev.title}</h3>
        <p>📅 ${ev.date} • 👥 ${ev.attendees} attending</p>
      </div>
      <button class="attend-btn" onclick="toast('🎟️ Registered for ${ev.title}!')">Attend 🎟️</button>
    </div>`).join('');
}

/* ════════════════════════════════════════════════════════════════
   RENDER LEADERBOARD
═══════════════════════════════════════════════════════════════ */
async function renderLeaderboard() {
  const container = document.getElementById('leaderboardContainer');
  container.innerHTML = `<div class="empty-state"><p>Loading leaders…</p></div>`;
  try {
    const q    = query(collection(db, 'users'), orderBy('posts','desc'), limit(10));
    const snap = await getDocs(q);
    const users = snap.docs.map(d => d.data());
    if (!users.length) { container.innerHTML = `<div class="empty-state"><h3>🥇 No data yet</h3></div>`; return; }
    container.innerHTML = users.map((u, i) => {
      const init  = getInitials(u.displayName);
      const photo = u.photoURL || '';
      const pts   = (u.posts || 0) * 5 + (u.followers || 0);
      return `<div class="lb-row">
        <div class="rank-num ${i===0?'gold':''}">${i+1}</div>
        ${avatarHTML(init, photo, 'lb')}
        <div class="lb-info"><h4>${u.displayName || 'User'}</h4><p>${u.role || 'Member'}</p></div>
        <div class="lb-pts">${pts} pts</div>
        ${u.uid !== currentUser?.uid
          ? `<button class="follow-btn" onclick="toggleFollow(this,'${u.displayName}','${u.uid}')">Follow</button>`
          : '<span style="font-size:.75rem;color:var(--muted)">You</span>'}
      </div>`;
    }).join('');
  } catch(e) { container.innerHTML = `<div class="empty-state"><p>Could not load leaderboard.</p></div>`; }
}

/* ════════════════════════════════════════════════════════════════
   RENDER HACKATHONS WIDGET
═══════════════════════════════════════════════════════════════ */
const HACKS = [
  { icon:'🏆', name:'HackStart 2024', date:'Apr 1–3',   prize:'₹1L'  },
  { icon:'⚙️', name:'CodeCraft',      date:'Apr 10–12', prize:'₹50K' },
  { icon:'🔨', name:'BuildHub',       date:'Apr 20–22', prize:'₹75K' }
];
function renderHackathons() {
  const html = HACKS.map(h => `
    <div class="wi-item" onclick="toast('🏆 ${h.name} — Register opens soon!')">
      <div class="wi-icon">${h.icon}</div>
      <div class="wi-info"><h4>${h.name}</h4><p>📅 ${h.date} • 💰 ${h.prize}</p></div>
    </div>`).join('');
    
  const w1 = document.getElementById('hackathonsWidget');
  const w2 = document.getElementById('hackathonsWidgetTrends');
  if (w1) w1.innerHTML = html;
  if (w2) w2.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════════
   RENDER TOP USERS WIDGET
═══════════════════════════════════════════════════════════════ */
async function renderTopUsers() {
  const w1 = document.getElementById('topUsersWidget');
  const w2 = document.getElementById('topUsersWidgetTrends');
  try {
    const q    = query(collection(db, 'users'), orderBy('followers','desc'), limit(3));
    const snap = await getDocs(q);
    if (snap.empty) {
      if (w1) w1.innerHTML = '<p style="font-size:.8rem;color:var(--muted)">No users yet.</p>';
      return;
    }
    const html = snap.docs.map((d, i) => {
      const u    = d.data();
      const init = getInitials(u.displayName);
      return `<div class="lb-row" style="padding:10px 14px">
        <div class="rank-num ${i===0?'gold':''}">${i+1}</div>
        ${avatarHTML(init, u.photoURL||'', 'lb')}
        <div class="lb-info"><h4>${u.displayName||'User'}</h4><p>${u.followers||0} followers</p></div>
      </div>`;
    }).join('');
    
    if (w1) w1.innerHTML = html;
    if (w2) w2.innerHTML = html;
  } catch { if (w1) w1.innerHTML = ''; }
}

/* ════════════════════════════════════════════════════════════════
   RENDER EXPLORE
═══════════════════════════════════════════════════════════════ */
const EXPLORE_DATA = [
  { icon:'🤖', title:'Artificial Intelligence', desc:'350 members' },
  { icon:'🌐', title:'Web Development',         desc:'520 members' },
  { icon:'📱', title:'Mobile Apps',             desc:'210 members' },
  { icon:'🔒', title:'Cybersecurity',           desc:'180 members' },
  { icon:'🎮', title:'Game Dev',                desc:'290 members' },
  { icon:'📊', title:'Data Science',            desc:'440 members' }
];
function renderExplore() {
  const c = document.getElementById('exploreContainer');
  if (!c) return;
  c.innerHTML = EXPLORE_DATA.map(e => `
    <div class="explore-card" onclick="toast('👋 Joined ${e.title}!')">
      <div class="ec-icon">${e.icon}</div>
      <h4>${e.title}</h4>
      <p>${e.desc}</p>
    </div>`).join('');
}

/* ════════════════════════════════════════════════════════════════
   CREATE POST (with optional image upload)
═══════════════════════════════════════════════════════════════ */
window.createPost = async function() {
  const textarea   = document.getElementById('postContent');
  const text       = textarea.value.trim();
  const type       = document.getElementById('postTypeSelect').value;
  const fileInput  = document.getElementById('postImageFile');
  const file       = fileInput.files[0] || null;
  const linkURL    = document.getElementById('df-link').style.display !== 'none' ? document.getElementById('postLinkURL').value.trim() : '';
  const eventTitle = document.getElementById('df-event-group').style.display !== 'none' ? document.getElementById('postEventTitle').value.trim() : '';
  const eventDate  = document.getElementById('df-event-group').style.display !== 'none' ? document.getElementById('postEventDate').value : '';
  const tagsRaw    = document.getElementById('postTags').value.trim();

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
        imageURL = await uploadImageStorage(file, `posts/${currentUser.uid}/${Date.now()}_${file.name}`);
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
      authorId:    currentUser.uid,
      authorName:  currentUser.displayName || userProfile?.displayName || 'User',
      authorPhoto: currentUser.photoURL    || userProfile?.photoURL    || '',
      likes:       0,
      likedBy:     [],
      comments:    0,
      shares:      0,
      createdAt:   serverTimestamp()
    };

    // If event type, add event data
    if (['hackathon','workshop','cultural'].includes(type)) {
      postData.eventData = { title: eventTitle, date: eventDate };
    }

    await addDoc(collection(db, 'posts'), postData);

    // Update stats
    try { await updateDoc(doc(db, 'users', currentUser.uid), { posts: increment(1) }); } catch {}
    
    // Reset Form
    textarea.value = '';
    fileInput.value = '';
    document.getElementById('postTypeSelect').value = 'text';
    document.getElementById('postTags').value = '';
    if (document.getElementById('postLinkURL')) document.getElementById('postLinkURL').value = '';
    if (document.getElementById('postEventTitle')) document.getElementById('postEventTitle').value = '';
    if (document.getElementById('postEventDate')) document.getElementById('postEventDate').value = '';
    
    updatePostFormFields(); // Reset visibility
    closeComposer();
    toast('🎉 Post shared successfully!');
  } catch(e) {
    console.error('Post Error:', e);
    toast('❌ Failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Post Now 🚀';
  }
};

/* ════════════════════════════════════════════════════════════════
   IMAGE UPLOAD — Firebase Storage (requires CORS setup)
═══════════════════════════════════════════════════════════════ */
function uploadImageStorage(file, path) {
  return new Promise((resolve, reject) => {
    const storageRef = ref(storage, path);
    const task       = uploadBytesResumable(storageRef, file);
    const bar        = document.getElementById('uploadBar');
    const pct        = document.getElementById('uploadPct');
    bar.style.display = 'block';
    task.on('state_changed',
      snap => { pct.textContent = Math.round(snap.bytesTransferred / snap.totalBytes * 100) + '%'; },
      err  => { bar.style.display = 'none'; reject(err); },
      async () => { bar.style.display = 'none'; resolve(await getDownloadURL(task.snapshot.ref)); }
    );
  });
}

/* ════════════════════════════════════════════════════════════════
   BASE64 FALLBACK — stores image inline in Firestore
   (works without CORS setup, but limited to <500KB images)
═══════════════════════════════════════════════════════════════ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = e => reject(e);
    reader.readAsDataURL(file);
  });
}


/* ════════════════════════════════════════════════════════════════
   LIKE POST
═══════════════════════════════════════════════════════════════ */
window.likePost = async function(postId, btn) {
  if (!currentUser) return;
  const post = posts.find(p => p.id === postId);
  if (!post) return;
  const liked    = (post.likedBy || []).includes(currentUser.uid);
  const postRef  = doc(db, 'posts', postId);
  try {
    if (liked) {
      await updateDoc(postRef, {
        likes:   increment(-1),
        likedBy: (post.likedBy || []).filter(id => id !== currentUser.uid)
      });
      btn.classList.remove('liked');
      toast('💔 Post unliked');
    } else {
      await updateDoc(postRef, {
        likes:   increment(1),
        likedBy: [...(post.likedBy || []), currentUser.uid]
      });
      btn.classList.add('liked');
      toast('❤️ Post liked!');
    }
  } catch(e) { toast('❌ Could not update like.'); }
};

/* ════════════════════════════════════════════════════════════════
   SHARE POST
═══════════════════════════════════════════════════════════════ */
window.sharePost = async function(postId) {
  try {
    await navigator.clipboard.writeText(window.location.href + '#post-' + postId);
    toast('🔗 Link copied to clipboard!');
    await updateDoc(doc(db, 'posts', postId), { shares: increment(1) });
  } catch { toast('↗️ Shared!'); }
};

/* ════════════════════════════════════════════════════════════════
   FOLLOW / UNFOLLOW
═══════════════════════════════════════════════════════════════ */
window.toggleFollow = async function(btn, name, uid) {
  if (!currentUser || !uid) return;
  if (uid === currentUser.uid) { toast('😅 You cannot follow yourself!'); return; }

  const isFollowing = followedUsers.has(uid);

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
    const followRef   = doc(db, 'users', currentUser.uid, 'following', uid);
    const followerRef = doc(db, 'users', uid, 'followers', currentUser.uid);

    if (!isFollowing) {
      // ── FOLLOW ──
      followedUsers.add(uid);

      // Store in following sub-collection
      await setDoc(followRef, {
        uid, displayName: name,
        followedAt: serverTimestamp()
      });
      // Store in target's followers sub-collection
      await setDoc(followerRef, {
        uid:         currentUser.uid,
        displayName: currentUser.displayName || 'User',
        photoURL:    currentUser.photoURL || '',
        followedAt:  serverTimestamp()
      });

      // Update counts
      await setDoc(doc(db,'users', uid),             { followers: increment(1) }, { merge: true });
      await setDoc(doc(db,'users', currentUser.uid), { following: increment(1) }, { merge: true });

      // ── Create notification ONLY ONCE (check first) ──
      const notifRef  = doc(db, 'notifications', uid, 'items', `follow_${currentUser.uid}`);
      const notifSnap = await getDoc(notifRef);
      if (!notifSnap.exists()) {
        await setDoc(notifRef, {
          type:      'follow',
          fromId:    currentUser.uid,
          fromName:  currentUser.displayName || 'User',
          fromPhoto: currentUser.photoURL || '',
          message:   `👤 ${currentUser.displayName || 'Someone'} started following you`,
          read:      false,
          createdAt: serverTimestamp()
        });
      }

      toast(`✅ Now following ${name}!`);
    } else {
      // ── UNFOLLOW ──
      followedUsers.delete(uid);

      await deleteDoc(followRef);
      await deleteDoc(followerRef);
      await setDoc(doc(db,'users', uid),             { followers: increment(-1) }, { merge: true });
      await setDoc(doc(db,'users', currentUser.uid), { following: increment(-1) }, { merge: true });

      toast(`Unfollowed ${name}`);
    }
  } catch(e) {
    console.error('Follow error:', e);
    toast('❌ Could not update follow. Try again.');
    // Revert
    if (!isFollowing) followedUsers.delete(uid); else followedUsers.add(uid);
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
window.setSearchCategory = function(btn, cat) {
  document.querySelectorAll('.sc-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentSearchCategory = cat;

  const input = document.getElementById('feedSearchInput');
  const h = { all:'Search anything...', post:'Search posts or thoughts…', image:'Search images…', link:'Search links…', project:'Search projects…', hackathon:'Search hackathons…' };
  if(input) { input.placeholder = h[cat] || 'Search…'; input.focus(); }
  renderPosts();
};

window.handleFeedSearch = function(e) {
  const xBtn = document.getElementById('clearSearchBtn');
  const q    = e.target.value.toLowerCase().trim();
  currentSearchQuery = q;
  if(xBtn) xBtn.style.display = q ? 'flex' : 'none';
  if (e.key === 'Enter') renderPosts();
};

window.clearFeedSearch = function() {
  const input = document.getElementById('feedSearchInput');
  if(input) input.value = '';
  const xBtn = document.getElementById('clearSearchBtn');
  if(xBtn) xBtn.style.display = 'none';
  currentSearchQuery = '';
  renderPosts();
};

function handleSearch(e) {
  currentSearchQuery = e.target.value.toLowerCase().trim();
  renderPosts();
}

/* ════════════════════════════════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════════════════════════════ */
window.switchTab = function(btn, page) {
  // Update desktop top tabs
  document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  // Update sidebar nav items
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  // Update mobile bottom nav items
  document.querySelectorAll('.m-nav-item').forEach(b => b.classList.remove('active'));

  if (btn) btn.classList.add('active');
  
  // Find and activate corresponding items in other menus
  const sidebarItem = document.querySelector(`.nav-item[onclick*="'${page}'"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  
  const mobileItem = document.querySelector(`.m-nav-item[onclick*="'${page}'"]`);
  if (mobileItem) mobileItem.classList.add('active');

  // Hide/Show page sections
  const feedCreate  = document.getElementById('pg-feed');
  const postsBox    = document.getElementById('postsContainer');
  const emptyBox    = document.getElementById('emptyFeed');
  const allSections = ['pg-projects','pg-events','pg-leaderboard','pg-explore','pg-saved','pg-myposts','pg-trends'];

  if (page === 'feed') {
    feedCreate.style.display = '';
    postsBox.style.display   = '';
    emptyBox.style.display   = '';
    allSections.forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  } else {
    feedCreate.style.display = 'none';
    postsBox.style.display   = 'none';
    emptyBox.style.display   = 'none';
    allSections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === `pg-${page}` ? '' : 'none';
    });
    if (page==='projects')    renderProjects();
    if (page==='events')      renderEvents();
    if (page==='leaderboard') renderLeaderboard();
    if (page==='saved')       renderSaved();
    if (page==='myposts')     renderMyPosts();
    if (page==='trends')      { renderHackathons(); renderTopUsers(); }
  }
};

/* ════════════════════════════════════════════════════════════════
   FILTER BUTTONS
═══════════════════════════════════════════════════════════════ */
window.lbFilter = function(btn, name) {
  document.querySelectorAll('.filt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  toast(`📊 Filtering: ${name}`);
};

/* ════════════════════════════════════════════════════════════════
   POST TYPE SELECTOR
═══════════════════════════════════════════════════════════════ */
window.setPostType = function(btn, type) {
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
window.openComposer = function() {
  document.getElementById('composerOverlay').classList.add('open');
  updatePostFormFields(); // Initialize dynamic fields
  setTimeout(() => document.getElementById('postContent')?.focus(), 100);
};
window.closeComposer = function(e) {
  if (!e || e.target.id === 'composerOverlay')
    document.getElementById('composerOverlay').classList.remove('open');
};
window.openTheme = function() {
  document.getElementById('themeOverlay').classList.add('open');
};
window.closeTheme = function() {
  document.getElementById('themeOverlay').classList.remove('open');
};
window.closeThemeOutside = function(e) {
  if (e.target.id === 'themeOverlay') closeTheme();
};
window.openLightbox = function(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
};
window.closeLightbox = function() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
};

/* ════════════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════════ */
window.applyTheme = function(name, el, save = true) {
  document.documentElement.setAttribute('data-theme', name);
  if (save) localStorage.setItem('cl_theme', name);
  const nameEl = document.getElementById('themeName');
  if (nameEl) nameEl.textContent = THEMES[name] || name;
  document.querySelectorAll('.th-card').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  else {
    // Highlight correct card on load
    document.querySelectorAll('.th-card').forEach(c => {
      if (c.querySelector('span')?.textContent.toLowerCase() === name) c.classList.add('active');
    });
  }
};

/* ════════════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════════ */
window.toast = function(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
};

/* ════════════════════════════════════════════════════════════════
   SIGN OUT
═══════════════════════════════════════════════════════════════ */
window.handleSignOut = async function() {
  if (unsubPosts) unsubPosts();
  await signOut(auth);
  window.location.href = 'login.html';
};

/* ════════════════════════════════════════════════════════════════
   UPDATE POST FORM FIELDS (Dynamic visibility)
   ═══════════════════════════════════════════════════════════════ */
window.updatePostFormFields = function() {
  const typeSelection = document.getElementById('postTypeSelect')?.value;
  
  // Hide all dynamic fields first
  document.querySelectorAll('.d-field').forEach(el => el.style.display = 'none');
  
  if (typeSelection === 'image') {
    document.getElementById('df-image').style.display = 'block';
  } else if (typeSelection === 'link') {
    document.getElementById('df-link').style.display = 'block';
  } else if (['hackathon','workshop','cultural'].includes(typeSelection)) {
    document.getElementById('df-image').style.display = 'block'; // Poster
    document.getElementById('df-event-group').style.display = 'block';
    document.getElementById('df-link').style.display = 'block'; // Registration Link
  }
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Load IDs on startup
═══════════════════════════════════════════════════════════════ */
async function loadSavedIds() {
  if (!currentUser) return;
  try {
    const snap = await getDocs(collection(db, 'users', currentUser.uid, 'saved'));
    snap.forEach(d => savedPostIds.add(d.id));
    // Re-render posts so save buttons reflect state
    renderPosts();
  } catch(e) { console.warn('Could not load saved IDs:', e); }
}

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Toggle save / unsave a post
═══════════════════════════════════════════════════════════════ */
window.toggleSavePost = async function(postId, btn) {
  if (!currentUser) { toast('⚠️ Please sign in to save posts'); return; }
  const isSaved = savedPostIds.has(postId);
  const savedRef = doc(db, 'users', currentUser.uid, 'saved', postId);

  // Optimistic UI update
  if (isSaved) {
    savedPostIds.delete(postId);
    btn.classList.remove('saved');
    btn.textContent = '🔖';
    btn.title = 'Save';
  } else {
    savedPostIds.add(postId);
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
      const post = posts.find(p => p.id === postId);
      await setDoc(savedRef, {
        postId,
        savedAt:     serverTimestamp(),
        postType:    post?.type || 'text',
        authorName:  post?.authorName || '',
        authorPhoto: post?.authorPhoto || '',
        text:        (post?.text || '').slice(0, 500), // short snapshot
        imageURL:    post?.imageURL || '',
        linkURL:     post?.linkURL || '',
      });
      toast('📌 Post saved to your collection!');
    }
  } catch(e) {
    console.error('Save error:', e);
    // Revert on failure
    if (isSaved) { savedPostIds.add(postId); btn.classList.add('saved'); btn.textContent = '📌'; }
    else         { savedPostIds.delete(postId); btn.classList.remove('saved'); btn.textContent = '🔖'; }
    toast('❌ Could not update saved post');
  }
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Render the Saved page
═══════════════════════════════════════════════════════════════ */
async function renderSaved() {
  const container = document.getElementById('savedContainer');
  const emptyEl   = document.getElementById('savedEmpty');
  const clearBtn  = document.getElementById('savedClearBtn');
  if (!container) return;

  container.innerHTML = `<div class="saved-loading"><div class="spinner" style="width:32px;height:32px;border-width:3px"></div><p>Loading saved posts…</p></div>`;
  emptyEl.style.display = 'none';

  try {
    const q    = query(collection(db, 'users', currentUser.uid, 'saved'), orderBy('savedAt', 'desc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '';
      emptyEl.style.display = 'block';
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
      const livePost = posts.find(p => p.id === id);
      if (livePost) return buildSavedCard(livePost, savedMeta[id]);
      // Fallback: use snapshot from Firestore
      return buildSavedCardFromMeta(id, savedMeta[id]);
    });

    container.innerHTML = savedCards.join('');
  } catch(e) {
    console.error('Render saved error:', e);
    container.innerHTML = `<div class="empty-state"><h3>❌ Could not load saved posts</h3><p>${e.message}</p></div>`;
  }
}

function buildSavedCard(post, meta) {
  const initials   = getInitials(post.authorName);
  const photo      = post.authorPhoto || '';
  const liked      = (post.likedBy || []).includes(currentUser?.uid);
  const ts         = timeAgo(post.createdAt);
  const savedTs    = meta?.savedAt ? timeAgo(meta.savedAt) : '';
  const isSaved    = savedPostIds.has(post.id);

  let extra = '';
  if (post.imageURL) extra += `<img class="post-img" src="${post.imageURL}" alt="Post image" loading="lazy" onclick="openLightbox('${post.imageURL}')"/>`;
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
        <span class="post-badge">${typeBadge(post.type)}</span>
      </div>
    </div>
    <div class="post-content">${escHTML(post.text || '')}</div>
    ${extra}
    <div class="post-stats">
      <span>❤️ ${fmtNum(post.likes || 0)}</span>
      <span>💬 ${fmtNum(post.comments || 0)}</span>
    </div>
    <div class="post-actions">
      <button class="act-btn ${liked ? 'liked' : ''}" onclick="likePost('${post.id}',this)" title="Like">❤️ Like</button>
      <button class="act-btn" onclick="toggleComments('${post.id}','${post.authorId||''}','${escAttr(post.authorName||'')}')" title="Comment">💬 Comment</button>
      <button class="act-btn save-btn saved" onclick="toggleSavePost('${post.id}',this);renderSaved()" title="Unsave">📌 Unsave</button>
    </div>
    <div class="comment-section" id="cs-${post.id}" style="display:none">
      <div class="comment-list" id="cl-${post.id}"></div>
      <div class="comment-input-row">
        <div class="comment-avatar" id="ca-${post.id}">${getInitials(currentUser?.displayName||'U')}</div>
        <input class="comment-input" id="ci-${post.id}" placeholder="Write a comment…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addComment('${post.id}','${post.authorId||''}','${escAttr(post.authorName||'')}')}"/>
        <button class="comment-send" onclick="addComment('${post.id}','${post.authorId||''}','${escAttr(post.authorName||'')}')" title="Send">➤</button>
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
window.setSavedFilter = function(btn, type) {
  document.querySelectorAll('.saved-filt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentSavedFilter = type;
  renderSaved();
};

/* ════════════════════════════════════════════════════════════════
   SAVED POSTS — Clear all saved posts
═══════════════════════════════════════════════════════════════ */
window.clearAllSaved = async function() {
  if (!currentUser) return;
  if (!confirm('Remove ALL saved posts? This cannot be undone.')) return;
  try {
    const snap = await getDocs(collection(db, 'users', currentUser.uid, 'saved'));
    const batch_size = snap.docs.length;
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
      savedPostIds.delete(d.id);
    }
    toast('Cleared ' + batch_size + ' saved post' + (batch_size !== 1 ? 's' : ''));
    renderSaved();
    renderPosts();
  } catch(e) {
    console.error('Clear saved error:', e);
    toast('Could not clear saved posts');
  }
};

/* ════════════════════════════════════════════════════════════════
   STAT CLICK — My Posts quick-nav
════════════════════════════════════════════════════════════════ */
window.openMyPostsTab = function() {
  const btn = document.querySelector('.ptab[onclick*="myposts"]');
  switchTab(btn, 'myposts');
};

/* ════════════════════════════════════════════════════════════════
   FOLLOWERS MODAL — open / close / load
════════════════════════════════════════════════════════════════ */
let _followersData = [];
let _followingData = [];

window.openFollowersModal = async function() {
  const overlay = document.getElementById('followersOverlay');
  const list    = document.getElementById('followersList');
  const count   = document.getElementById('followersCount');
  const search  = document.getElementById('followersSearch');
  overlay.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div class="fm-loading"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><p>Loading followers...</p></div>';
  try {
    const snap = await getDocs(collection(db, 'users', currentUser.uid, 'followers'));
    _followersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (count) count.textContent = '(' + _followersData.length + ')';
    renderFollowList('followers', _followersData);
  } catch(e) {
    list.innerHTML = '<div class="fm-empty">Could not load followers.</div>';
  }
};

window.closeFollowersModal = function(e) {
  if (!e || e.target.id === 'followersOverlay')
    document.getElementById('followersOverlay').classList.remove('open');
};

/* ════════════════════════════════════════════════════════════════
   FOLLOWING MODAL — open / close / load
════════════════════════════════════════════════════════════════ */
window.openFollowingModal = async function() {
  const overlay = document.getElementById('followingOverlay');
  const list    = document.getElementById('followingList');
  const count   = document.getElementById('followingCount');
  const search  = document.getElementById('followingSearch');
  overlay.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div class="fm-loading"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><p>Loading following...</p></div>';
  try {
    const snap = await getDocs(collection(db, 'users', currentUser.uid, 'following'));
    _followingData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (count) count.textContent = '(' + _followingData.length + ')';
    renderFollowList('following', _followingData);
  } catch(e) {
    list.innerHTML = '<div class="fm-empty">Could not load following list.</div>';
  }
};

window.closeFollowingModal = function(e) {
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
      : 'Not following anyone yet. Explore and connect!';
    listEl.innerHTML = '<div class="fm-empty"><div style="font-size:2.5rem;margin-bottom:10px">' +
      (type === 'followers' ? '\uD83D\uDC65' : '\uD83D\uDC64') +
      '</div><p>' + emptyMsg + '</p></div>';
    return;
  }
  listEl.innerHTML = users.map(function(u) {
    const uid         = u.uid || u.id;
    const name        = u.displayName || 'User';
    const photo       = u.photoURL || '';
    const bio         = u.bio || u.role || u.department || '';
    const isMe        = uid === currentUser.uid;
    const isFollowing = followedUsers.has(uid);
    const initials    = getInitials(name);
    const escapedName = name.replace(/'/g, "\\'");

    const avatarEl = photo
      ? '<img src="' + photo + '" alt="' + initials + '" class="fm-avatar-img" onerror="this.style.display=\'none\'">'
      : '<span class="fm-avatar-initials">' + initials + '</span>';

    const followBtnEl = isMe
      ? '<span class="fm-you-tag">You</span>'
      : '<button class="fm-follow-btn ' + (isFollowing ? 'following' : '') + '" id="fm-btn-' + uid + '" onclick="toggleFollowFromModal(this,\'' + escapedName + '\',\'' + uid + '\')">' +
        (isFollowing ? '\u2713 Following' : '+ Follow') +
        '</button>';

    return '<div class="fm-user-card">' +
      '<div class="fm-avatar">' + avatarEl + '</div>' +
      '<div class="fm-user-info">' +
        '<h4 class="fm-name">' + escHTML(name) + '</h4>' +
        (bio ? '<p class="fm-bio">' + escHTML(bio) + '</p>' : '') +
      '</div>' +
      '<div class="fm-action">' + followBtnEl + '</div>' +
    '</div>';
  }).join('');
}

/* ── In-modal search filter ── */
window.filterFollowList = function(type, query) {
  const data     = type === 'followers' ? _followersData : _followingData;
  const q        = query.toLowerCase().trim();
  const filtered = q ? data.filter(function(u) { return (u.displayName||'').toLowerCase().includes(q); }) : data;
  renderFollowList(type, filtered);
};

/* ── Follow / Unfollow from inside a modal ── */
window.toggleFollowFromModal = async function(btn, name, uid) {
  btn.disabled = true;
  await toggleFollow(btn, name, uid);
  btn.disabled = false;
  const isNow = followedUsers.has(uid);
  btn.classList.toggle('following', isNow);
  btn.textContent = isNow ? '\u2713 Following' : '+ Follow';
};

/* ════════════════════════════════════════════════════════════════
   MY POSTS TAB — render (list + grid views)
════════════════════════════════════════════════════════════════ */
let myPostsView = 'list';

function renderMyPosts() {
  const container = document.getElementById('myPostsContainer');
  const emptyEl   = document.getElementById('myPostsEmpty');
  const nameEl    = document.getElementById('mypName');
  const countEl   = document.getElementById('mypCount');
  const avatarEl  = document.getElementById('mypAvatar');
  if (!container) return;

  const name     = (currentUser && currentUser.displayName) || (userProfile && userProfile.displayName) || 'User';
  const photo    = (currentUser && currentUser.photoURL)    || (userProfile && userProfile.photoURL)    || '';
  const initials = getInitials(name);

  if (nameEl)   nameEl.textContent = name + "'s Posts";
  if (avatarEl) {
    avatarEl.innerHTML = photo
      ? '<img src="' + photo + '" alt="' + initials + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
      : initials;
  }

  const myPosts = posts.filter(function(p) { return p.authorId === (currentUser && currentUser.uid); });
  if (countEl) countEl.textContent = myPosts.length + ' post' + (myPosts.length !== 1 ? 's' : '') + ' shared';

  if (!myPosts.length) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  if (myPostsView === 'grid') {
    container.className = 'myp-grid';
    container.innerHTML = myPosts.map(function(p) { return buildMyPostGridCard(p); }).join('');
  } else {
    container.className = 'myp-list';
    container.innerHTML = myPosts.map(function(p, i) { return buildPostHTML(p, i); }).join('');
  }
}

function buildMyPostGridCard(p) {
  const ts     = timeAgo(p.createdAt);
  const hasImg = !!p.imageURL;
  const text   = (p.text || '').slice(0, 120) + ((p.text||'').length > 120 ? '...' : '');
  const overlay = '<div class="myp-grid-overlay"><span>\u2764\uFE0F ' + fmtNum(p.likes||0) + '</span><span>\uD83D\uDCAC ' + fmtNum(p.comments||0) + '</span></div>';

  const imgPart  = '<div class="myp-grid-img" style="background-image:url(\'' + p.imageURL + '\')">' + overlay + '</div>';
  const textPart = '<div class="myp-grid-text"><p>' + escHTML(text) + '</p></div>';

  return '<div class="myp-grid-card" onclick="expandMyPost(\'' + p.id + '\')">' +
    (hasImg ? imgPart : textPart) +
    '<div class="myp-grid-footer">' +
      '<span class="myp-grid-badge">' + typeBadge(p.type) + '</span>' +
      '<span class="myp-grid-time">' + ts + '</span>' +
    '</div>' +
  '</div>';
}

window.expandMyPost = function(postId) {
  setMyPostsView('list', document.getElementById('mypListBtn'));
  setTimeout(function() {
    const myPosts = posts.filter(function(p) { return p.authorId === (currentUser && currentUser.uid); });
    const idx     = myPosts.findIndex(function(p) { return p.id === postId; });
    const cards   = document.querySelectorAll('#myPostsContainer .post-card');
    if (cards[idx]) {
      cards[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      cards[idx].style.outline = '3px solid var(--primary)';
      setTimeout(function() { cards[idx].style.outline = ''; }, 2000);
    }
  }, 150);
};

window.setMyPostsView = function(view, btn) {
  myPostsView = view;
  document.querySelectorAll('.myp-view-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderMyPosts();
};
