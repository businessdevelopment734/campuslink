import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, getDoc, getDocs, collection, query, where, orderBy, updateDoc, increment, deleteDoc, arrayUnion, arrayRemove, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

let currentUser = null;
let targetUserId = null;
let targetUser = null;
let targetPosts = [];
let followedUsers = new Set();
let toastTimer = null;

// UTILS (Duplicated for standalone page, could be shared in real app)
function escHTML(s) { return s ? s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])) : ''; }
function getInitials(n) { return (n || 'U').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(); }
function fmtNum(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n; }
function timeAgo(date) {
  if (!date) return 'Recently';
  const seconds = Math.floor((new Date() - (date.toDate ? date.toDate() : new Date(date))) / 1000);
  if (seconds < 60) return 'Just now';
  const intervals = { 'year': 31536000, 'month': 2592000, 'week': 604800, 'day': 86400, 'hour': 3600, 'minute': 60 };
  for (let key in intervals) {
    let count = Math.floor(seconds / intervals[key]);
    if (count > 0) return count + ' ' + key + (count > 1 ? 's' : '') + ' ago';
  }
  return 'Just now';
}
function typeBadge(t) {
  const map = { hackathon: '🏆 Hackathon', workshop: '⚙️ Workshop', cultural: '🎨 Cultural', symposium: '🏛️ Symposium', project: '🛠️ Project', link: '🔗 Link', image: '🖼️ Image' };
  return map[t] || '📝 Post';
}

// INITIALIZATION
const params = new URLSearchParams(window.location.search);
targetUserId = params.get('u');

if (!targetUserId) {
  console.warn('No user ID provided in URL, redirecting to index...');
  window.location.href = 'index.html';
} else {
  // Load target user profile immediately without waiting for Auth
  loadProfile();
  initScrollHide();
}

/**
 * Scroll-hide logic for profile page header
 */
function initScrollHide() {
  const mainHeader = document.querySelector('.main-header');
  const navbar = document.querySelector('.navbar');

  let lastY = window.scrollY;
  let ticking = false;
  const THRESHOLD = 5;
  const TOP_GUARD = 40;

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        const currentY = window.scrollY;
        const delta = currentY - lastY;

        if (currentY > 15) navbar?.classList.add('nav-pinned');
        else navbar?.classList.remove('nav-pinned');

        const focusEl = document.activeElement;
        const isInteracting = focusEl && (focusEl.tagName === 'INPUT' || focusEl.tagName === 'TEXTAREA' || focusEl.isContentEditable);

        if (window.innerWidth <= 768 && !isInteracting) {
          if (Math.abs(delta) >= THRESHOLD) {
            if (delta > 0 && currentY > TOP_GUARD) {
              mainHeader?.classList.add('hide-header');
            } else {
              mainHeader?.classList.remove('hide-header');
            }
            lastY = currentY;
          }
        } else {
          mainHeader?.classList.remove('hide-header');
        }
        
        if (currentY <= 5) mainHeader?.classList.remove('hide-header');
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

// HANDLE AUTH STATE (Parallel)
onAuthStateChanged(auth, async user => {
  console.log('Auth state changed:', user ? 'Logged in' : 'Logged out');
  currentUser = user;
  
  if (user) {
    // Update navbar avatar
    updateNavAvatar(user);
    
    // Load local interactions (following list)
    try {
      const followingSnap = await getDocs(collection(db, 'users', user.uid, 'following'));
      followedUsers = new Set(followingSnap.docs.map(d => d.id));
      // Re-render header to update follow button state
      renderProfileHeader();
    } catch (e) {
      console.error('Error loading interactions:', e);
    }
  } else {
    // Still render header for guests
    renderProfileHeader();
  }
});

async function updateNavAvatar(user) {
  const navAv = document.getElementById('navAvatar');
  if (!navAv) return;
  const init = getInitials(user.displayName);
  if (user.photoURL) {
    navAv.innerHTML = `<img src="${user.photoURL}" alt="${init}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    navAv.textContent = init;
  }
}

async function loadProfile() {
  const loader = document.getElementById('profileLoader');
  const content = document.getElementById('profileContent');

  console.log('Starting loadProfile for:', targetUserId);
  try {
    // 1. Fetch User Document
    const userDoc = await getDoc(doc(db, 'users', targetUserId));
    if (!userDoc.exists()) {
      console.error('User does not exist in Firestore');
      loader.innerHTML = '<div class="empty-state"><h3>👤 User not found</h3><p>The profile you are looking for does not exist.</p><button class="btn-ph btn-message" onclick="window.location.href=\'index.html\'">🏠 Back Home</button></div>';
      return;
    }
    targetUser = userDoc.data();
    console.log('User data loaded:', targetUser.displayName);
    
    // Render the basic info we have
    renderProfileHeader();
    
    // Success: Switch view immediately so header is visible
    loader.style.display = 'none';
    content.style.display = 'block';

    // 2. Load Target User Posts
    console.log('Fetching posts for user...');
    const q = query(collection(db, 'posts'), where('authorId', '==', targetUserId));
    const postSnap = await getDocs(q);
    targetPosts = postSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('Posts loaded:', targetPosts.length);
    
    // Sort in memory
    targetPosts.sort((a, b) => {
      const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : (a.createdAt || 0);
      const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : (b.createdAt || 0);
      return tb - ta;
    });
    
    renderPosts();
    

    


  } catch (e) {
    console.error('Error fetching profile data:', e);
    const loader = document.getElementById('profileLoader');
    if (loader) {
      loader.innerHTML = `
        <div class="empty-state">
          <h3>❌ Profile Error</h3>
          <p>${e.message || 'Could not load profile. Please check your connection.'}</p>
          <button class="btn-ph btn-message" onclick="window.location.reload()" style="margin-top:20px">🔄 Retry</button>
        </div>`;
    }
  }
}

function renderProfileHeader() {
  if (!targetUser) return;
  const isMe = currentUser && currentUser.uid === targetUserId;
  const initials = getInitials(targetUser.displayName);
  const avatar = document.getElementById('userAvatar');
  
  if (targetUser.photoURL) avatar.innerHTML = `<img src="${targetUser.photoURL}" alt="${initials}">`;
  else avatar.textContent = initials;

  document.getElementById('userName').textContent = targetUser.displayName || 'User';
  document.getElementById('userRole').textContent = targetUser.role || 'Member';
  document.getElementById('userCollege').textContent = '🏫 ' + (targetUser.college || 'CampusLink User');
  document.getElementById('userDept').textContent = '📚 ' + (targetUser.department || 'Student');
  document.getElementById('userBio').textContent = targetUser.bio || 'No bio shared yet.';

  document.getElementById('statPosts').textContent = targetPosts.length || targetUser.posts || 0;
  document.getElementById('statFollowers').textContent = fmtNum(targetUser.followers || 0);
  document.getElementById('statFollowing').textContent = fmtNum(targetUser.following || 0);

  const followBtn = document.getElementById('followBtn');
  const msgBtn = document.getElementById('msgBtn');

  if (isMe) {
    if (followBtn) {
      followBtn.textContent = '⚙️ Edit Profile';
      followBtn.onclick = () => window.location.href = 'settings.html';
      followBtn.className = 'btn-ph btn-message'; // Use the secondary style
    }
    if (msgBtn) msgBtn.style.display = 'none';
  } else {
    const isFollowing = followedUsers.has(targetUserId);
    if (followBtn) {
      followBtn.innerHTML = isFollowing ? '✓ Following' : '+ Follow';
      followBtn.className = 'btn-ph btn-follow ' + (isFollowing ? 'following' : '');
      followBtn.onclick = handleFollow;
    }
    if (msgBtn) msgBtn.style.display = 'flex';
  }
}
function renderPosts() {
  const container = document.getElementById('userPostsContainer');
  if (!container) return;

  if (targetPosts.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>📭 No posts yet</h3><p>This user hasn\'t posted anything yet.</p></div>';
    return;
  }

  container.innerHTML = targetPosts.map(p => buildPostHTML(p)).join('');
}



function buildPostHTML(p) {
  const ts = timeAgo(p.createdAt);
  const initials = getInitials(p.authorName);
  const liked = (p.likedBy || []).includes(currentUser?.uid);
  
  let extra = '';
  if (p.imageURL) extra += `<img class="post-img" src="${p.imageURL}" loading="lazy" onclick="openFullImage('${p.imageURL}')">`;
  if (p.linkURL) {
    const displayLink = p.linkURL.replace(/^https?:\/\//, '').split('/')[0];
    extra += `<div class="link-preview-box" onclick="window.open('${p.linkURL}','_blank')">
      <div class="lp-icon">🔗</div>
      <div class="lp-info"><h5>${escHTML(displayLink)}</h5><p>${escHTML(p.linkURL)}</p></div>
      <div class="lp-arrow">↗️</div></div>`;
  }

  return `
    <div class="card post-card">
      <div class="post-header">
        <div class="post-avatar">${p.authorPhoto ? `<img src="${p.authorPhoto}" alt="${initials}">` : initials}</div>
        <div class="post-info">
          <h4>${escHTML(p.authorName)}</h4>
          <p>${ts}</p>
        </div>
        <div class="post-header-right"><span class="post-badge">${typeBadge(p.type)}</span></div>
      </div>
      <div class="post-text-wrap">
        <div class="post-content">${escHTML(p.text || '')}</div>
        ${extra}
      </div>
      <div class="post-actions">
        <button class="act-btn ${liked ? 'liked' : ''}" onclick="toast('❤️ Please view in main feed to interact')">❤️ ${fmtNum(p.likes || 0)}</button>
        <button class="act-btn" onclick="handleMessage()">💬 Message</button>
        <button class="act-btn" onclick="handleShare()" title="Share Post">↗️ Share</button>
      </div>
    </div>`;
}

// WINDOW GLOBALS
window.handleFollow = async function() {
  if (currentUser.uid === targetUserId) { window.location.href = 'settings.html'; return; }
  
  const btn = document.getElementById('followBtn');
  const isFollowing = followedUsers.has(targetUserId);
  btn.disabled = true;

  try {
    const myRef = doc(db, 'users', currentUser.uid);
    const theirRef = doc(db, 'users', targetUserId);
    const followListRef = doc(db, 'users', currentUser.uid, 'following', targetUserId);
    const followerListRef = doc(db, 'users', targetUserId, 'followers', currentUser.uid);

    if (isFollowing) {
      await deleteDoc(followListRef);
      await deleteDoc(followerListRef);
      await updateDoc(myRef, { following: increment(-1) });
      await updateDoc(theirRef, { followers: increment(-1) });
      followedUsers.delete(targetUserId);
      toast('Unfollowed ' + targetUser.displayName);
    } else {
      await setDoc(followListRef, { uid: targetUserId, displayName: targetUser.displayName, photoURL: targetUser.photoURL || '', followedAt: serverTimestamp() });
      await setDoc(followerListRef, { uid: currentUser.uid, displayName: currentUser.displayName || 'User', photoURL: currentUser.photoURL || '', followedAt: serverTimestamp() });
      await updateDoc(myRef, { following: increment(1) });
      await updateDoc(theirRef, { followers: increment(1) });
      followedUsers.add(targetUserId);
      toast('Following ' + targetUser.displayName + '! 🚀');
    }
    
    // Refresh stats
    const updatedDoc = await getDoc(theirRef);
    targetUser = updatedDoc.data();
    renderProfileHeader();

  } catch (e) {
    toast('❌ Error: ' + e.message);
  } finally {
    btn.disabled = false;
  }
};

window.handleMessage = () => window.location.href = `messages.html?u=${targetUserId}`;

window.handleShare = async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast('🔗 Profile link copied to clipboard!');
  } catch (e) {
    toast('❌ Could not copy link');
  }
};

window.openFullImage = (url) => {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  img.src = url;
  lb.classList.add('open');
};

window.toast = function(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
};

// FOLLOWERS / FOLLOWING LIST LOGIC
window.openFollowers = () => fetchAndShowUserList('followers', 'Followers');
window.openFollowing = () => fetchAndShowUserList('following', 'Following');
window.closeUserList  = () => document.getElementById('userListOverlay').classList.remove('open');

async function fetchAndShowUserList(sub, title) {
  if (!targetUserId) return;
  const overlay = document.getElementById('userListOverlay');
  const body = document.getElementById('userListBody');
  const hTitle = document.getElementById('userListTitle');

  hTitle.textContent = title;
  body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">⌛ Loading...</div>';
  overlay.classList.add('open');

  try {
    const snap = await getDocs(collection(db, 'users', targetUserId, sub));
    if (snap.empty) {
      body.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted)">No ${title.toLowerCase()} yet.</div>`;
      return;
    }

    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    body.innerHTML = items.map(u => {
      const init = getInitials(u.displayName);
      const aviHTML = u.photoURL 
        ? `<img src="${u.photoURL}" alt="${init}" style="width:100%;height:100%;object-fit:cover">` 
        : init;

      return `
        <div style="display:flex;align-items:center;gap:12px;padding:12px;cursor:pointer;border-bottom:1.5px solid var(--border);transition:background .2s"
             onclick="window.location.href='profile.html?u=${u.uid || u.id}'"
             onmouseover="this.style.background='var(--bg2)'" 
             onmouseout="this.style.background='transparent'">
          <div style="width:42px;height:42px;border-radius:12px;background:var(--grad);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;overflow:hidden;flex-shrink:0">
            ${aviHTML}
          </div>
          <div style="flex:1">
            <div style="font-size:.9rem;font-weight:700;color:var(--text)">${escHTML(u.displayName || 'User')}</div>
            <div style="font-size:.75rem;color:var(--muted)">CampusLink Member</div>
          </div>
          <div style="font-size:1.1rem">❱</div>
        </div>
      `;
    }).join('');

  } catch (e) {
    console.error('Error fetching user list:', e);
    body.innerHTML = '<div style="color:red;padding:20px">Error loading list.</div>';
  }
}
