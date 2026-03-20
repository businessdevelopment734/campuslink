
import { auth, db, storage } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, updateDoc, deleteDoc,
  query, orderBy, limit, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

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
    
    // Recent activity mock or from logs
    const activityTable = document.getElementById('recentActivityTable').querySelector('tbody');
    activityTable.innerHTML = `
      <tr><td>System</td><td>Admin Panel initialized</td><td>Just now</td></tr>
      <tr><td>${userProfile.displayName || 'Admin'}</td><td>Logged in</td><td>Today</td></tr>
    `;
  } catch(e) { console.error(e); }
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
