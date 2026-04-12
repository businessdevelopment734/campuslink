/* ================================================================
   events.js — Events Module for CampusLink
   ================================================================ */
import { db } from './firebase-config.js';

const EVENT_TYPES = ['hackathon', 'workshop', 'cultural', 'symposium'];

/**
 * Initialize Events Module
 */
export function initEvents(context) {
  // Use window globals for state and common utilities to ensure they are always fresh
  const { window } = context;

  window.renderEvents = function(posts) {
    const container = document.getElementById('eventsContainer');
    if (!container) return;

    // Use passed posts or fallback to global window.posts
    const data = posts || window.posts || [];

    // Get all event posts that have an eventData.date field
    const eventPosts = data.filter(p =>
      EVENT_TYPES.includes(p.type) && p.eventData && p.eventData.date
    );

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const todayEvents = [];
    const upcomingEvents = [];
    const pastEvents = [];

    eventPosts.forEach(p => {
      try {
        const evDate = new Date(p.eventData.date);
        if (evDate >= todayStart && evDate <= todayEnd) {
          todayEvents.push(p);
        } else if (evDate > todayEnd) {
          upcomingEvents.push(p);
        } else {
          pastEvents.push(p);
        }
      } catch (e) {
        console.error('Error parsing event date:', e, p);
        pastEvents.push(p); // Fallback
      }
    });

    upcomingEvents.sort((a, b) => new Date(a.eventData.date) - new Date(b.eventData.date));
    pastEvents.sort((a, b) => new Date(b.eventData.date) - new Date(a.eventData.date));

    if (!eventPosts.length) {
      container.innerHTML = `
        <div class="events-empty-state">
          <div class="ees-icon">🎯</div>
          <h3>No Events Yet</h3>
          <p>Be the first to post a hackathon, workshop, or cultural event!</p>
          <button class="btn-submit" style="max-width:200px;margin-top:16px" onclick="openComposer()">➕ Post an Event</button>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="ev-page-header">
        <div class="eph-left">
          <div class="eph-icon">🎯</div>
          <div class="eph-info">
            <h1 class="ev-page-title">Live & Upcoming Events</h1>
            <p class="ev-page-subtitle">All campus happenings in one place</p>
          </div>
        </div>
        <div class="ev-jump-nav">
          <button class="ev-jump-btn" onclick="document.getElementById('ev-sec-today')?.scrollIntoView({behavior:'smooth', block:'center'})">🕐 Today</button>
          <button class="ev-jump-btn" onclick="document.getElementById('ev-sec-upcoming')?.scrollIntoView({behavior:'smooth', block:'center'})">🚀 Upcoming</button>
          <button class="ev-jump-btn" onclick="document.getElementById('ev-sec-past')?.scrollIntoView({behavior:'smooth', block:'center'})">📜 Past</button>
        </div>
      </div>

      ${buildEventSection('🕐 Today\'s Events', todayEvents, 'today')}
      ${buildEventSection('🚀 Upcoming Events', upcomingEvents, 'upcoming')}
      ${buildEventSection('📜 Past Events', pastEvents, 'past')}
    `;
  };

  function buildEventSection(title, events, type) {
    if (!events.length) {
      return `
        <div class="ev-section ev-section-${type}" id="ev-sec-${type}">
          <div class="ev-section-header">
            <h2 class="ev-section-title">${title}</h2>
            <span class="ev-section-count">0</span>
          </div>
          <div class="ev-section-empty">
            <span>${type === 'today' ? '📅 No events today' : type === 'upcoming' ? '🔭 No upcoming events' : '🗂️ No past events'}</span>
          </div>
        </div>`;
    }

    const cards = events.map((p, i) => buildEventCard(p, i, type)).join('');
    return `
      <div class="ev-section ev-section-${type}" id="ev-sec-${type}">
        <div class="ev-section-header">
          <h2 class="ev-section-title">${title}</h2>
          <span class="ev-section-count">${events.length}</span>
        </div>
        <div class="ev-cards-grid">
          ${cards}
        </div>
      </div>`;
  }

  function buildEventCard(p, idx, sectionType) {
    const evDate = new Date(p.eventData.date);
    const dateStr = evDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = evDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const desc = (p.text || '').slice(0, 120);
    const college = p.eventData.college || '';
    const titleBadge = window.typeBadge(p.type);
    const isToday = sectionType === 'today';
    const isPast = sectionType === 'past';

    const typeIconMap = {
      hackathon: '🏆',
      workshop: '⚙️',
      cultural: '🎨',
      symposium: '🏛️'
    };
    const typeIcon = typeIconMap[p.type] || '🎯';

    return `
      <div class="ev-card ${isPast ? 'ev-card-past' : ''} ${isToday ? 'ev-card-today' : ''}"
           style="animation-delay:${idx * 0.07}s"
           onclick="switchToFeedAndScroll('${p.id}')">

        ${isToday ? '<div class="ev-today-ribbon">🔴 LIVE TODAY</div>' : ''}

        ${p.imageURL
        ? `<div class="ev-card-img-wrap">
               <img src="${p.imageURL}" alt="${window.escHTML(p.eventData.title || '')}" class="ev-card-img" loading="lazy" onerror="this.parentElement.style.display='none'">
               <div class="ev-card-img-overlay">
                 <span class="ev-type-pill">${titleBadge}</span>
               </div>
             </div>`
        : `<div class="ev-card-no-img">
               <span class="ev-no-img-icon">${typeIcon}</span>
               <span class="ev-type-pill ev-type-pill-center">${titleBadge}</span>
             </div>`
      }

        <div class="ev-card-body">
          <h3 class="ev-card-title">${window.escHTML(p.eventData.title || 'Untitled Event')}</h3>

          ${college ? `<p class="ev-card-college">🏫 ${window.escHTML(college)}</p>` : ''}

          <div class="ev-card-meta">
            <span class="ev-meta-item">📅 ${dateStr}</span>
            <span class="ev-meta-item">⏰ ${timeStr}</span>
          </div>

          ${desc ? `<p class="ev-card-desc">${window.escHTML(desc)}${(p.text && p.text.length > 120) ? '…' : ''}</p>` : ''}

          <div class="ev-card-footer">
            <span class="ev-author">
              <span class="ev-author-avatar">${window.getInitials(p.authorName)}</span>
              ${window.escHTML(p.authorName || 'User')}
            </span>
            <button class="ev-view-btn" onclick="event.stopPropagation(); switchToFeedAndScroll('${p.id}')">
              ${isPast ? '📖 View' : '👁️ Details'}
            </button>
          </div>
        </div>
      </div>`;
  }

  // Related utility functions
  window.hasEventsOnDate = function(date, posts) {
    const data = posts || window.posts || [];
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();

    return data.some(p => {
      if (!p.eventData || !p.eventData.date) return false;
      const evDate = new Date(p.eventData.date);
      return evDate.getFullYear() === y && evDate.getMonth() === m && evDate.getDate() === d;
    });
  };

  window.renderDateEvents = function(date, posts) {
    const data = posts || window.posts || [];
    const listContainer = document.getElementById('calendarEventsList');
    const label = document.getElementById('selectedDateLabel');
    if (!listContainer || !label) return;

    // Format label
    const labelDate = (date instanceof Date) ? date : new Date(date);
    const labelStr = labelDate.toLocaleDateString('en-IN', { month: 'long', day: 'numeric', year: 'numeric' });
    label.textContent = `Events on ${labelStr}`;

    const y = labelDate.getFullYear();
    const m = labelDate.getMonth();
    const d = labelDate.getDate();

    const filtered = data.filter(p => {
      if (!p.eventData || !p.eventData.date) return false;
      const evDate = new Date(p.eventData.date);
      return evDate.getFullYear() === y && evDate.getMonth() === m && evDate.getDate() === d;
    });

    if (!filtered.length) {
      listContainer.innerHTML = `
        <div class="no-events-msg">
          <div style="font-size: 2rem; margin-bottom: 8px;">📅</div>
          <p>No events found for this date.</p>
        </div>`;
      return;
    }

    listContainer.innerHTML = filtered.map((p, i) => {
      const evTime = new Date(p.eventData.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="cal-event-card" style="animation-delay: ${i * 0.1}s" onclick="closeCalendar(); switchToFeedAndScroll('${p.id}')">
          ${p.imageURL ? `<img src="${p.imageURL}" class="cec-poster" alt="Poster">` : ''}
          <div class="cec-info">
            <h5>${window.escHTML(p.eventData.title || 'Untitled Event')}</h5>
            <p>${window.escHTML(p.text || '').slice(0, 80)}...</p>
            <div class="cec-footer">
              <span class="cec-time">⏰ ${evTime}</span>
              <span class="cec-type">${window.typeBadge(p.type)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  };

  window.switchToFeedAndScroll = function (postId) {
    // Clear any active profile view first
    if (window.viewingUserId !== undefined) window.viewingUserId = null;
    // Switch to feed tab first, then scroll to the post
    const feedTab = document.querySelector('.ptab');
    if (feedTab && window.switchTab) window.switchTab(feedTab, 'feed');
    setTimeout(() => { if (window.scrollToPost) window.scrollToPost(postId); }, 300);
  };
}
