
import { auth, db, storage } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, updateDoc, deleteDoc,
  query, orderBy, limit, serverTimestamp, increment, where
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { ref, listAll, getMetadata } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

let currentUser = null;
let userProfile = null;

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = user;
  
  // Load Firestore profile to check admin status
  const snap = await getDoc(doc(db, 'users', user.uid));
  userProfile = snap.exists() ? snap.data() : {};
  
  // Authorization check (Assuming isAdmin: true in Firestore profile)
  if (!userProfile.isAdmin && userProfile.role !== 'admin') {
    alert("⚠️ Access Denied: Admin Panel only.");
    window.location.href = 'index.html';
    return;
  }

  initAdmin();
});

async function initAdmin() {
  // Update admin profile elements
  updateAdminProfile();
  
  // Dashboard default
  loadDashboard();
  
  // Hide loader
  setTimeout(() => {
    document.body.classList.remove('loading');
    document.body.classList.add('loaded');
  }, 200);
}

function updateAdminProfile() {
  const avatar = document.getElementById('adminAvatar');
  const avatarMob = document.getElementById('adminAvatarMobile');
  const name = currentUser.displayName || userProfile.displayName || 'Admin';
  const initial = name.charAt(0).toUpperCase();
  const photo = currentUser.photoURL || userProfile.photoURL || '';

  const html = photo 
    ? `<img src="${photo}" alt="${initial}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : initial;

  if (avatar) {
    avatar.innerHTML = html;
    if (!photo) avatar.textContent = initial;
  }
  if (avatarMob) {
    avatarMob.innerHTML = html;
    if (!photo) avatarMob.textContent = initial;
  }
}

// ── TAB SWITCHING ───────────────────────────────────────────────────
window.switchAdminTab = function(tab) {
  const views = ['dashboard', 'users', 'posts', 'reports'];
  const titleMap = { dashboard: 'Dashboard', users: 'Users', posts: 'Posts', reports: 'Reports' };

  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = (v === tab) ? 'block' : 'none';
  });

  document.querySelectorAll('.admin-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
  });

  document.getElementById('tabTitle').textContent = titleMap[tab];

  // Close sidebar on mobile after clicking
  if (window.innerWidth <= 768 && typeof toggleAdminSidebar === 'function') {
    const sidebar = document.getElementById('adminSidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      toggleAdminSidebar();
    }
  }

  if (tab === 'dashboard') loadDashboard();
  if (tab === 'users') loadUsers();
  if (tab === 'posts') loadPosts();
  if (tab === 'reports') loadReports();
};

// ── DASHBOARD ───────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    const postsSnap = await getDocs(collection(db, 'posts'));
    
    document.getElementById('countUsers').textContent = usersSnap.size;
    document.getElementById('countPosts').textContent = postsSnap.size;
    
    // Load storage usage
    loadStorageUsage();
    
    // Recent activity: Show latest 6 user sign-ups from last 48 hours
    const activityTable = document.getElementById('recentActivityTable').querySelector('tbody');
    
    const fortyEightHoursAgo = new Date();
    fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);
    
    const q = query(
      collection(db, 'users'), 
      where('createdAt', '>=', fortyEightHoursAgo),
      orderBy('createdAt', 'desc'), 
      limit(6)
    );
    const recentUsersSnap = await getDocs(q);
    
    activityTable.innerHTML = '';
    
    if (recentUsersSnap.empty) {
      activityTable.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px;">No recent account creations.</td></tr>';
      return;
    }

    recentUsersSnap.forEach(d => {
      const u = d.data();
      const tr = document.createElement('tr');
      
      const displayName = u.displayName || 'New User';
      const initials = displayName.charAt(0).toUpperCase();
      const timeStr = u.createdAt ? formatTimeAgo(u.createdAt.toDate()) : 'Recently';
      
      tr.innerHTML = `
        <td>
          <div style="display:flex; align-items:center; gap:12px;">
            <div class="lb-avatar" style="width:32px; height:32px; font-size:0.75rem;">
              ${u.photoURL ? `<img src="${u.photoURL}">` : initials}
            </div>
            <div>
              <strong>${displayName}</strong>
              <br>
              <small style="color: var(--muted); font-size: 0.7rem;">${u.email || ''}</small>
            </div>
          </div>
        </td>
        <td><span class="badge badge-user">Joined CampusLink</span></td>
        <td>${timeStr}</td>
      `;
      activityTable.appendChild(tr);
    });
  } catch(e) { 
    console.error('Dashboard Load Error:', e);
    const activityTable = document.getElementById('recentActivityTable').querySelector('tbody');
    activityTable.innerHTML = '<tr><td colspan="3" style="text-align:center; color: #ef4444;">Error loading activity.</td></tr>';
  }
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);
  
  if (diffInSeconds < 60) return 'Just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  
  return date.toLocaleDateString();
}

// ── USERS ───────────────────────────────────────────────────────────
async function loadUsers() {
  const table = document.getElementById('usersTable').querySelector('tbody');
  table.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px;"><span class="spinner"></span> Loading user database...</td></tr>';
  
  try {
    const snap = await getDocs(collection(db, 'users'));
    table.innerHTML = '';
    
    if (snap.empty) {
      table.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--muted);">No users found.</td></tr>';
      return;
    }

    snap.forEach(d => {
      const u = d.data();
      const tr = document.createElement('tr');
      const isSelf = d.id === (currentUser?.uid);
      
      const displayName = u.displayName || 'Unknown Name';
      const email = u.email || 'No email provided';
      const initials = displayName?.charAt(0) || u.email?.charAt(0) || '?';
      
      tr.innerHTML = `
        <td><div class="lb-avatar">${u.photoURL ? `<img src="${u.photoURL}">` : initials}</div></td>
        <td>
          <strong>${displayName}</strong>
          <br>
          <small style="color: var(--muted); font-size: 0.75rem;">${email}</small>
        </td>
        <td><span class="badge ${u.isAdmin?'badge-admin':'badge-user'}">${u.isAdmin?'Admin':'User'}</span></td>
        <td>${u.posts || 0}</td>
        <td>
          ${isSelf ? '<em style="color: var(--primary); font-weight: bold;">(You)</em>' : `
            <button class="action-btn" onclick="toggleAdmin('${d.id}', ${!u.isAdmin})">
              ${u.isAdmin ? 'Demote' : 'Make Admin'}
            </button>
            <button class="action-btn btn-delete" onclick="deleteUser('${d.id}')">Delete</button>
          `}
        </td>
      `;
      table.appendChild(tr);
    });
  } catch(e) { 
    console.error('Error loading users:', e);
    table.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: #ef4444;">Access Error: Failed to fetch users database.</td></tr>'; 
  }
}

window.toggleAdmin = async (uid, shouldBeAdmin) => {
  if (!confirm('Change user role?')) return;
  try {
    await updateDoc(doc(db, 'users', uid), { isAdmin: shouldBeAdmin, role: shouldBeAdmin ? 'admin' : 'student' });
    toast(`User updated!`);
    loadUsers();
  } catch(e) { toast('Error updating user'); }
};

window.deleteUser = async (uid) => {
  if (!confirm('Waring: This will remove user from database. Proceed?')) return;
  try {
    await deleteDoc(doc(db, 'users', uid));
    toast('User removed!');
    loadUsers();
  } catch(e) { toast('Error deleting user'); }
};

// ── POSTS ───────────────────────────────────────────────────────────
async function loadPosts() {
  const table = document.getElementById('postsTable').querySelector('tbody');
  table.innerHTML = '<tr><td colspan="4">Loading posts...</td></tr>';
  
  try {
    const q = query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(50));
    const snap = await getDocs(q);
    table.innerHTML = '';
    snap.forEach(d => {
      const p = d.data();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${p.authorName || 'User'}</strong></td>
        <td>${(p.text || '').substring(0, 60)}...</td>
        <td><span class="badge badge-user">${p.type}</span></td>
        <td>
          <button class="action-btn btn-delete" onclick="deletePost('${d.id}')">Remove</button>
        </td>
      `;
      table.appendChild(tr);
    });
  } catch(e) { table.innerHTML = '<tr><td colspan="4">Error loading posts</td></tr>'; }
}

window.deletePost = async (postId) => {
  if (!confirm('Delete this post permanently?')) return;
  try {
    await deleteDoc(doc(db, 'posts', postId));
    toast('Post removed!');
    loadPosts();
  } catch(e) { toast('Error removing post'); }
};

// ── REPORTS ────────────────────────────────────────────────────────
async function loadReports() {
  const table = document.getElementById('recentActivityTable').querySelector('tbody'); // Using dash as placeholder
  const title = document.getElementById('tabTitle');
  
  if (title.textContent !== 'Reports') return;
  
  const reportTable = document.querySelector('#view-dashboard div[style*="padding: 24px"] h3');
  reportTable.textContent = 'Reported Content';
  
  const body = document.getElementById('recentActivityTable').querySelector('tbody');
  body.innerHTML = '<tr><td colspan="3">Loading reports...</td></tr>';

  try {
    const snap = await getDocs(collection(db, 'reports'));
    body.innerHTML = '';
    if (snap.empty) {
      body.innerHTML = '<tr><td colspan="3">No pending reports! 🎉</td></tr>';
      return;
    }
    snap.forEach(d => {
      const r = d.data();
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.reportedBy || 'Reporter'}</strong></td>
        <td>${r.reason || 'General Violation'} - <em>${r.contentType || 'post'}</em></td>
        <td><button class="action-btn" onclick="dismissReport('${d.id}')">Dismiss</button></td>
      `;
      body.appendChild(tr);
    });
  } catch(e) { body.innerHTML = '<tr><td colspan="3">Error loading reports</td></tr>'; }
}

window.dismissReport = async (id) => {
  try {
    await deleteDoc(doc(db, 'reports', id));
    toast('Report dismissed!');
    loadReports();
  } catch(e) { toast('Error dismissing report'); }
};
function toast(msg) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

let isCalculatingStorage = false;
async function loadStorageUsage() {
  if (isCalculatingStorage) return;
  isCalculatingStorage = true;
  const TOTAL_CAPACITY = 1024 * 1024 * 1024 * 5; // 5 GB
  const storageEl = document.getElementById('storageUsage');
  const fillEl = document.getElementById('storageFill');
  const detailEl = document.getElementById('storageDetail');

  if (!storageEl) {
    isCalculatingStorage = false;
    return;
  }
  
  detailEl.textContent = 'Scanning storage...';
  try {
    let totalSize = 0;
    let fileCount = 0;
    
    // Recursive folder scan with per-folder resilience
    async function scanFolder(folderRef) {
      try {
        const res = await listAll(folderRef);
        
        // Parallel metadata fetch for items
        const metas = await Promise.all(res.items.map(item => 
          getMetadata(item).catch(err => {
            console.warn(`Could not read metadata for ${item.fullPath}:`, err);
            return { size: 0 };
          })
        ));
        
        for (const m of metas) {
          totalSize += (m.size || 0);
          fileCount++;
        }
        
        // Recurse into subfolders sequentially to avoid hitting rate limits
        for (const prefix of res.prefixes) {
          await scanFolder(prefix);
        }
      } catch (e) {
        console.warn(`Error scanning folder ${folderRef.fullPath}:`, e.message);
      }
    }

    console.log('Starting storage usage calculation from root...');
    
    // Start scan from root
    await scanFolder(ref(storage));

    const pct = Math.min(100, (totalSize / TOTAL_CAPACITY) * 100);
    const usedMB = (totalSize / (1024 * 1024)).toFixed(1);
    const totalGB = (TOTAL_CAPACITY / (1024 * 1024 * 1024)).toFixed(0);

    storageEl.style.fontSize = '1.4rem';
    storageEl.textContent = `${pct.toFixed(2)}%`;
    fillEl.style.width = `${pct}%`;
    detailEl.textContent = `${usedMB} MB used (${fileCount} files)`;
    
    // Color coding based on usage
    if (pct > 90) fillEl.style.background = '#ff4d4d'; // Severe
    else if (pct > 70) fillEl.style.background = '#ffa500'; // Warning
    else fillEl.style.background = 'var(--primary)'; // Normal
    
    console.log(`Calculation complete: ${usedMB} MB / ${totalGB} GB (${fileCount} files)`);
    
  } catch(e) {
    console.error('Final Storage Error:', e);
    storageEl.style.fontSize = '0.7rem';
    storageEl.textContent = 'Auth Required';
    detailEl.textContent = 'Check cloud storage rules.';
  } finally {
    isCalculatingStorage = false;
  }
}
