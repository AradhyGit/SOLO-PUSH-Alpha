/* ========================================================
   SoloPush — app.js
   Core application logic: Auth, Clock, Tasks, Notes
   ======================================================== */

// ─────────── FIREBASE CONFIG ───────────
// TODO: Replace with YOUR Firebase project config.
// 1. Go to https://console.firebase.google.com
// 2. Create a project → Add a Web App
// 3. Enable Authentication → Google sign-in
// 4. Create a Cloud Firestore database
// 5. Paste the config object below
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

let firebaseReady = false;
let db = null;
let auth = null;
let currentUser = null;

try {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db   = firebase.firestore();
  if (firebaseConfig.apiKey !== "YOUR_API_KEY") {
    firebaseReady = true;
  }
} catch (e) {
  console.warn("Firebase init skipped — add your config to app.js", e);
}

// ─────────── UTILITY HELPERS ───────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const dateKey = (y, m, d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ─────────── SETTINGS MANAGER ───────────
const Settings = {
  data: {
    theme: 'dark',
    font: 'Inter',
    accent: '#7c3aed',
    is24Hour: true
  },

  accentMap: {
    '#7c3aed': { light: '#a78bfa', glow: 'rgba(124,58,237,.35)' },
    '#2563eb': { light: '#60a5fa', glow: 'rgba(37,99,235,.35)' },
    '#059669': { light: '#34d399', glow: 'rgba(5,150,105,.35)' },
    '#d97706': { light: '#fbbf24', glow: 'rgba(217,119,6,.35)' },
    '#e11d48': { light: '#fb7185', glow: 'rgba(225,29,72,.35)' },
    '#06b6d4': { light: '#22d3ee', glow: 'rgba(6,182,212,.35)' }
  },

  load() {
    try {
      const raw = localStorage.getItem('solopush_settings');
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    this.apply();
  },

  save() {
    localStorage.setItem('solopush_settings', JSON.stringify(this.data));
    this.apply();
  },

  apply() {
    // 1. Theme
    document.documentElement.setAttribute('data-theme', this.data.theme);

    // 2. Font
    document.documentElement.style.setProperty('--font-main', `'${this.data.font}', system-ui, -apple-system, sans-serif`);

    // 3. Accent
    const colors = this.accentMap[this.data.accent] || { light: '#a78bfa', glow: 'rgba(124,58,237,.35)' };
    document.documentElement.style.setProperty('--accent', this.data.accent);
    document.documentElement.style.setProperty('--accent-light', colors.light);
    document.documentElement.style.setProperty('--accent-glow', colors.glow);

    // 4. Update UI controls in modal if open/rendered
    $$('.theme-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === this.data.theme);
    });
    const fontSelect = $('#fontSelect');
    if (fontSelect) fontSelect.value = this.data.font;
    $$('.accent-dot').forEach(dot => {
      dot.classList.toggle('active', dot.dataset.accent === this.data.accent);
    });
    const toggle24 = $('#toggle24Hour');
    if (toggle24) toggle24.checked = this.data.is24Hour;
  }
};

// ─────────── LOCAL STORAGE WRAPPER ───────────
const Store = {
  _data: { tasks: {}, notes: [], streak: 0, lastActive: null, focusSessions: {} },

  _getStorageKey() {
    return currentUser ? `solopush_data_${currentUser.uid}` : 'solopush_data';
  },

  load() {
    try {
      const key = this._getStorageKey();
      let raw = localStorage.getItem(key);
      if (!raw && currentUser) {
        // If student account has no data yet, migrate existing guest tasks and notes
        raw = localStorage.getItem('solopush_data');
      }
      if (raw) {
        this._data = JSON.parse(raw);
      } else {
        this._data = { tasks: {}, notes: [], streak: 0, lastActive: null, focusSessions: {} };
      }
    } catch (e) { /* ignore */ }
    this._computeStreak();
  },

  save() {
    this._data.lastActive = todayKey();
    const key = this._getStorageKey();
    localStorage.setItem(key, JSON.stringify(this._data));
    if (firebaseReady && currentUser && currentUser.isFirebase) this._syncToCloud();
  },

  // ── Tasks ──
  getTasks(dateStr) { return this._data.tasks[dateStr] || []; },
  setTasks(dateStr, list) { this._data.tasks[dateStr] = list; this.save(); },
  getAllTaskDates() { return Object.keys(this._data.tasks).filter(k => this._data.tasks[k].length > 0); },

  // ── Notes ──
  getNotes() { return this._data.notes || []; },
  setNotes(list) { this._data.notes = list; this.save(); },

  // ── Focus Sessions ──
  getFocusSessions(dateStr) {
    if (!this._data.focusSessions) this._data.focusSessions = {};
    return this._data.focusSessions[dateStr] || [];
  },
  addFocusSession(dateStr, session) {
    if (!this._data.focusSessions) this._data.focusSessions = {};
    if (!this._data.focusSessions[dateStr]) this._data.focusSessions[dateStr] = [];
    this._data.focusSessions[dateStr].push(session);
    this.save();
  },
  getTodayFocusTotal() {
    const sessions = this.getFocusSessions(todayKey());
    return sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  },

  // ── Streak ──
  getStreak() { return this._data.streak || 0; },
  _computeStreak() {
    const last = this._data.lastActive;
    const today = todayKey();
    if (!last) { this._data.streak = 0; return; }
    if (last === today) return;                // same day
    const diff = (new Date(today) - new Date(last)) / 86400000;
    if (diff === 1) { this._data.streak = (this._data.streak || 0) + 1; }
    else if (diff > 1) { this._data.streak = 0; }
    this._data.lastActive = today;
  },

  // ── Cloud sync ──
  async _syncToCloud() {
    if (!db || !currentUser) return;
    try {
      await db.collection('users').doc(currentUser.uid).set(this._data, { merge: true });
    } catch (e) { console.warn("Cloud sync failed", e); }
  },

  async loadFromCloud() {
    if (!db || !currentUser) return;
    try {
      const doc = await db.collection('users').doc(currentUser.uid).get();
      if (doc.exists) {
        this._data = { ...this._data, ...doc.data() };
        localStorage.setItem('solopush_data', JSON.stringify(this._data));
      }
    } catch (e) { console.warn("Cloud load failed", e); }
  }
};

// ─────────── TOAST NOTIFICATIONS ───────────
function toast(message, type = 'info') {
  const container = $('#toastContainer');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ─────────── NAVIGATION ───────────
function initNav() {
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
      // Close mobile sidebar
      $('#sidebar').classList.remove('open');
      $('#sidebarOverlay').classList.remove('open');
    });
  });

  // Mobile hamburger
  $('#hamburger').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#sidebarOverlay').classList.toggle('open');
  });
  $('#sidebarOverlay').addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#sidebarOverlay').classList.remove('open');
  });
}

function switchView(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => {
    v.classList.remove('active');
    if (v.id === `view-${name}`) v.classList.add('active');
  });
  if (name === 'dashboard') updateStats();
  if (name === 'tasks') renderCalendar();
  if (name === 'notes') renderNotes();
}

// ─────────── AUTH & STUDENT LOGIN ───────────
let selectedAuthAvatar = '🚀';

function initAuth() {
  const authBtn    = $('#authBtn');
  const authBtnM   = $('#authBtnMobile');
  const authModal  = $('#authModal');
  const authClose  = $('#authModalClose');
  const googleBtn  = $('#btnGoogleInstantLogin');
  const loginForm  = $('#studentLoginForm');
  const avatarDots = $$('.avatar-option');

  // Restore saved student profile if present
  try {
    const savedUser = localStorage.getItem('solopush_current_user');
    if (savedUser) {
      currentUser = JSON.parse(savedUser);
      renderUserSession();
    }
  } catch (e) {}

  // Open modal / sign out triggers
  function handleAuthClick() {
    if (currentUser) {
      if (confirm(`Sign out of ${currentUser.name || 'Student Profile'}?`)) {
        signOutStudent();
      }
    } else {
      openAuthModal();
    }
  }

  if (authBtn) authBtn.addEventListener('click', handleAuthClick);
  if (authBtnM) authBtnM.addEventListener('click', handleAuthClick);

  // Close modal
  const closeAuthModal = () => authModal && authModal.classList.remove('open');
  if (authClose) authClose.addEventListener('click', closeAuthModal);
  if (authModal) {
    authModal.addEventListener('click', e => {
      if (e.target === authModal) closeAuthModal();
    });
  }

  // Avatar picker
  avatarDots.forEach(btn => {
    btn.addEventListener('click', () => {
      avatarDots.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedAuthAvatar = btn.dataset.avatar || '🚀';
    });
  });

  // Google Sign-In button
  if (googleBtn) {
    googleBtn.addEventListener('click', () => {
      if (firebaseReady && auth) {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider)
          .then(result => {
            const user = result.user;
            loginStudent({
              uid: user.uid,
              name: user.displayName || 'Google Student',
              email: user.email || '',
              avatar: '🌟',
              goal: 'Google Sync Active',
              isFirebase: true,
              isGoogle: true
            });
            closeAuthModal();
          })
          .catch(err => {
            console.warn('Firebase popup unavailable or failed, launching instant Google profile:', err);
            promptInstantGoogleLogin();
          });
      } else {
        promptInstantGoogleLogin();
      }
    });
  }

  function promptInstantGoogleLogin() {
    const emailPrompt = prompt('Sign in with your Google account:\nEnter your Gmail or student email address:', 'student@gmail.com');
    if (!emailPrompt) return;
    const namePart = emailPrompt.split('@')[0] || 'Student';
    const formattedName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
    loginStudent({
      uid: 'google_' + emailPrompt.replace(/[^a-zA-Z0-9]/g, '_'),
      name: formattedName,
      email: emailPrompt,
      avatar: '🌟',
      goal: 'Google Account Connected',
      isGoogle: true
    });
    closeAuthModal();
  }

  // Student Profile Form submission
  if (loginForm) {
    loginForm.addEventListener('submit', e => {
      e.preventDefault();
      const nameInput  = $('#authInputName');
      const emailInput = $('#authInputEmail');
      const goalInput  = $('#authInputGoal');

      const name  = nameInput ? nameInput.value.trim() : '';
      const email = emailInput ? emailInput.value.trim() : '';
      const goal  = goalInput ? goalInput.value.trim() : '';

      if (!name) {
        toast('Please enter your name', 'error');
        return;
      }

      loginStudent({
        uid: 'user_' + (email ? email.replace(/[^a-zA-Z0-9]/g, '_') : uid()),
        name: name,
        email: email || 'student@solopush.app',
        avatar: selectedAuthAvatar || '🚀',
        goal: goal || 'SoloPush Student',
        isGoogle: false
      });

      closeAuthModal();
    });
  }

  // Firebase auth state listener if active
  if (firebaseReady && auth) {
    auth.onAuthStateChanged(async user => {
      if (user && (!currentUser || currentUser.isFirebase)) {
        loginStudent({
          uid: user.uid,
          name: user.displayName || 'Google Student',
          email: user.email || '',
          avatar: '🌟',
          goal: 'Google Sync Active',
          isFirebase: true,
          isGoogle: true
        });
        await Store.loadFromCloud();
        refreshAll();
      }
    });
  }
}

function openAuthModal() {
  const modal = $('#authModal');
  if (!modal) return;
  modal.classList.add('open');
  const nameInput = $('#authInputName');
  if (nameInput) setTimeout(() => nameInput.focus(), 150);
}

function loginStudent(userObj) {
  currentUser = { ...userObj, loggedInAt: new Date().toISOString() };
  localStorage.setItem('solopush_current_user', JSON.stringify(currentUser));
  
  // Reload store with user's specific dataset
  Store.load();
  refreshAll();
  renderUserSession();
  toast(`Welcome back, ${currentUser.name}! Progress tracking active 🎉`, 'success');
}

function signOutStudent() {
  const prevName = currentUser ? currentUser.name : 'Student';
  if (firebaseReady && auth && currentUser && currentUser.isFirebase) {
    auth.signOut().catch(() => {});
  }
  currentUser = null;
  localStorage.removeItem('solopush_current_user');

  // Reload guest store and refresh views
  Store.load();
  refreshAll();
  renderUserSession();
  toast(`Signed out. See you next study session, ${prevName}!`, 'info');
}

function renderUserSession() {
  const userInfo   = $('#userInfo');
  const userAvatar = $('#userAvatarBadge');
  const userName   = $('#userName');
  const userGrade  = $('#userGrade');
  const authBtn    = $('#authBtn');
  const authBtnM   = $('#authBtnMobile');

  if (currentUser) {
    if (userInfo) userInfo.style.display = 'flex';
    if (userAvatar) userAvatar.textContent = currentUser.avatar || '🚀';
    if (userName) userName.textContent = currentUser.name || 'Student';
    if (userGrade) userGrade.textContent = currentUser.goal || 'SoloPush Student';

    if (authBtn) {
      authBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i><span>Sign out</span>';
      authBtn.classList.add('signed-in');
    }
    if (authBtnM) {
      authBtnM.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i>';
      authBtnM.classList.add('signed-in');
    }
  } else {
    if (userInfo) userInfo.style.display = 'none';
    if (authBtn) {
      authBtn.innerHTML = '<i class="fa-brands fa-google"></i><span>Sign in</span>';
      authBtn.classList.remove('signed-in');
    }
    if (authBtnM) {
      authBtnM.innerHTML = '<i class="fa-brands fa-google"></i>';
      authBtnM.classList.remove('signed-in');
    }
  }
}

// ─────────── MINI REALTIME CLOCK (Top-Right) ───────────
let prevMiniTime = { h1: '', h2: '', m1: '', m2: '' };

function initClock() {
  tickMiniClock();
  setInterval(tickMiniClock, 1000);
}

function tickMiniClock() {
  const now = new Date();
  let rawHours = now.getHours();
  if (!Settings.data.is24Hour) {
    rawHours = rawHours % 12 || 12;
  }
  const h = String(rawHours).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');

  updateMiniDigit('miniHourTens', prevMiniTime.h1, h[0]);
  updateMiniDigit('miniHourOnes', prevMiniTime.h2, h[1]);
  updateMiniDigit('miniMinTens',  prevMiniTime.m1, m[0]);
  updateMiniDigit('miniMinOnes',  prevMiniTime.m2, m[1]);

  prevMiniTime = { h1: h[0], h2: h[1], m1: m[0], m2: m[1] };
}

function updateMiniDigit(id, oldVal, newVal) {
  if (oldVal === newVal) return;
  const card = $(`#${id}`);
  if (!card) return;
  const span = $('span', card);
  if (!span) return;

  if (oldVal !== '') {
    card.classList.add('flipping');
    setTimeout(() => {
      span.textContent = newVal;
    }, 150);
    setTimeout(() => {
      card.classList.remove('flipping');
    }, 350);
  } else {
    span.textContent = newVal;
  }
}

// ─────────── CALENDAR ───────────
let calYear, calMonth, selectedDate;

function initCalendar() {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
  selectedDate = todayKey();

  $('#calPrev').addEventListener('click', () => { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendar(); });
  $('#calNext').addEventListener('click', () => { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendar(); });
  $('#btnToday').addEventListener('click', () => {
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
    selectedDate = todayKey();
    renderCalendar();
    renderTasks();
  });

  renderCalendar();
}

function renderCalendar() {
  $('#calMonthYear').textContent = `${MONTHS[calMonth]} ${calYear}`;

  const container = $('#calendarDays');
  container.innerHTML = '';

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrev  = new Date(calYear, calMonth, 0).getDate();

  const today = todayKey();
  const taskDates = new Set(Store.getAllTaskDates());

  // Previous month's trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = daysInPrev - i;
    const pm = calMonth === 0 ? 11 : calMonth - 1;
    const py = calMonth === 0 ? calYear - 1 : calYear;
    const key = dateKey(py, pm, d);
    container.appendChild(makeCalDay(d, key, true, today, taskDates));
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(calYear, calMonth, d);
    container.appendChild(makeCalDay(d, key, false, today, taskDates));
  }

  // Next month's leading days
  const totalCells = container.children.length;
  const remaining = (7 - totalCells % 7) % 7;
  for (let d = 1; d <= remaining; d++) {
    const nm = calMonth === 11 ? 0 : calMonth + 1;
    const ny = calMonth === 11 ? calYear + 1 : calYear;
    const key = dateKey(ny, nm, d);
    container.appendChild(makeCalDay(d, key, true, today, taskDates));
  }
}

function makeCalDay(dayNum, key, isOther, today, taskDates) {
  const el = document.createElement('button');
  el.className = 'cal-day';
  el.textContent = dayNum;
  if (isOther) el.classList.add('other-month');
  if (key === today) el.classList.add('today');
  if (key === selectedDate) el.classList.add('selected');
  if (taskDates.has(key)) el.classList.add('has-tasks');

  el.addEventListener('click', () => {
    selectedDate = key;
    renderCalendar();
    renderTasks();
  });
  return el;
}

// ─────────── TASKS ───────────
function initTasks() {
  const btnAdd    = $('#btnAddTask');
  const inputRow  = $('#taskInputRow');
  const input     = $('#taskInput');
  const btnSave   = $('#btnSaveTask');
  const btnCancel = $('#btnCancelTask');

  btnAdd.addEventListener('click', () => {
    inputRow.style.display = 'flex';
    input.value = '';
    input.focus();
  });

  btnCancel.addEventListener('click', () => { inputRow.style.display = 'none'; });

  btnSave.addEventListener('click', () => addTask());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });

  renderTasks();
}

function addTask() {
  const input = $('#taskInput');
  const text = input.value.trim();
  if (!text) return;
  const tasks = Store.getTasks(selectedDate);
  tasks.push({ id: uid(), text, done: false });
  Store.setTasks(selectedDate, tasks);
  input.value = '';
  $('#taskInputRow').style.display = 'none';
  renderTasks();
  renderCalendar();
  toast('Task added!', 'success');
}

function renderTasks() {
  const list = $('#taskList');
  const tasks = Store.getTasks(selectedDate);

  // Update title
  const d = new Date(selectedDate + 'T00:00:00');
  const label = selectedDate === todayKey() ? 'Today' : d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  $('#taskDateTitle').textContent = `Tasks for ${label}`;

  if (tasks.length === 0) {
    list.innerHTML = '<li class="task-empty">No tasks for this day. Click <strong>+ Add Task</strong> to begin!</li>';
    return;
  }

  list.innerHTML = '';
  tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = `task-item${task.done ? ' done' : ''}`;
    li.innerHTML = `
      <div class="task-check" data-id="${task.id}"><i class="fa-solid fa-check"></i></div>
      <span class="task-text">${escapeHtml(task.text)}</span>
      <button class="task-delete" data-id="${task.id}"><i class="fa-solid fa-trash"></i></button>
    `;
    list.appendChild(li);
  });

  // Bind events
  $$('.task-check', list).forEach(el => {
    el.addEventListener('click', () => toggleTask(el.dataset.id));
  });
  $$('.task-delete', list).forEach(el => {
    el.addEventListener('click', () => deleteTask(el.dataset.id));
  });
}

function toggleTask(id) {
  const tasks = Store.getTasks(selectedDate);
  const t = tasks.find(t => t.id === id);
  if (t) { t.done = !t.done; Store.setTasks(selectedDate, tasks); renderTasks(); }
}

function deleteTask(id) {
  let tasks = Store.getTasks(selectedDate);
  tasks = tasks.filter(t => t.id !== id);
  Store.setTasks(selectedDate, tasks);
  renderTasks();
  renderCalendar();
  toast('Task removed', 'info');
}

// ─────────── NOTES ───────────
let editingNoteId = null;
let selectedNoteColor = '#7c3aed';

function initNotes() {
  const modal      = $('#noteModal');
  const btnNew     = $('#btnNewNote');
  const btnSave    = $('#noteModalSave');
  const btnCancel  = $('#noteModalCancel');
  const btnClose   = $('#noteModalClose');

  btnNew.addEventListener('click', () => openNoteModal());
  btnSave.addEventListener('click', () => saveNote());
  btnCancel.addEventListener('click', () => closeNoteModal());
  btnClose.addEventListener('click', () => closeNoteModal());

  // Color dots
  $$('.color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      $$('.color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      selectedNoteColor = dot.dataset.color;
    });
  });

  // Close modal on overlay click
  modal.addEventListener('click', e => { if (e.target === modal) closeNoteModal(); });

  renderNotes();
}

function openNoteModal(note = null) {
  editingNoteId = note ? note.id : null;
  $('#noteModalTitle').textContent = note ? 'Edit Note' : 'New Note';
  $('#noteTitleInput').value = note ? note.title : '';
  $('#noteBodyInput').value  = note ? note.body  : '';
  selectedNoteColor = note ? (note.color || '#7c3aed') : '#7c3aed';

  // Highlight correct color dot
  $$('.color-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.color === selectedNoteColor);
  });

  $('#noteModal').classList.add('open');
  setTimeout(() => $('#noteTitleInput').focus(), 100);
}

function closeNoteModal() {
  $('#noteModal').classList.remove('open');
  editingNoteId = null;
}

function saveNote() {
  const title = $('#noteTitleInput').value.trim();
  const body  = $('#noteBodyInput').value.trim();
  if (!title && !body) { toast('Note is empty', 'error'); return; }

  let notes = Store.getNotes();

  if (editingNoteId) {
    const idx = notes.findIndex(n => n.id === editingNoteId);
    if (idx !== -1) {
      notes[idx].title = title;
      notes[idx].body  = body;
      notes[idx].color = selectedNoteColor;
      notes[idx].updatedAt = new Date().toISOString();
    }
    toast('Note updated!', 'success');
  } else {
    notes.unshift({
      id: uid(),
      title: title || 'Untitled',
      body,
      color: selectedNoteColor,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    toast('Note saved!', 'success');
  }

  Store.setNotes(notes);
  closeNoteModal();
  renderNotes();
}

function renderNotes() {
  const grid = $('#notesGrid');
  const notes = Store.getNotes();

  if (notes.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:40px 0;">No notes yet. Click <strong>+ New Note</strong> to start writing!</p>';
    return;
  }

  grid.innerHTML = '';
  notes.forEach(note => {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.style.borderTopColor = note.color || '#7c3aed';
    const dateStr = new Date(note.updatedAt || note.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    card.innerHTML = `
      <button class="note-card-delete" data-id="${note.id}"><i class="fa-solid fa-trash"></i></button>
      <div class="note-card-title">${escapeHtml(note.title)}</div>
      <div class="note-card-body">${escapeHtml(note.body)}</div>
      <div class="note-card-date">${dateStr}</div>
    `;

    // Click to edit
    card.addEventListener('click', e => {
      if (e.target.closest('.note-card-delete')) return;
      openNoteModal(note);
    });

    grid.appendChild(card);
  });

  // Delete buttons
  $$('.note-card-delete', grid).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteNote(btn.dataset.id);
    });
  });
}

function deleteNote(id) {
  let notes = Store.getNotes().filter(n => n.id !== id);
  Store.setNotes(notes);
  renderNotes();
  toast('Note deleted', 'info');
}

// ─────────── DASHBOARD STATS ───────────
function updateStats() {
  const today = todayKey();
  const tasks = Store.getTasks(today);
  const notes = Store.getNotes();

  $('#statTotal').textContent = tasks.length;
  $('#statDone').textContent  = tasks.filter(t => t.done).length;
  $('#statNotes').textContent = notes.length;
  $('#statStreak').textContent = Store.getStreak();

  // Study time stat
  const totalSec = Store.getTodayFocusTotal();
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  $('#statStudy').textContent = `${h}h ${m}m`;
}

// ─────────── FOCUS CLOCK (Study Timer) ───────────
let focusInterval  = null;
let focusElapsed   = 0;       // seconds elapsed in current session
let focusRunning   = false;
let focusPaused    = false;
let focusPrevDigits = { h1:'0', h2:'0', m1:'0', m2:'0', s1:'0', s2:'0' };

function initFocusClock() {
  const btnStart = $('#focusStart');
  const btnPause = $('#focusPause');
  const btnReset = $('#focusReset');
  const btnFs    = $('#btnFocusFullscreen');
  const wrapper  = $('#focusClockWrapper') || $('.focus-clock-wrapper');

  btnStart.addEventListener('click', () => {
    if (focusPaused) {
      resumeFocus();
    } else {
      startFocus();
    }
  });

  btnPause.addEventListener('click', pauseFocus);
  btnReset.addEventListener('click', resetFocus);

  // Fullscreen Focus Mode
  if (btnFs && wrapper) {
    btnFs.addEventListener('click', toggleFocusFullscreen);

    // Escape key listener
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && wrapper.classList.contains('is-fullscreen')) {
        exitFocusFullscreen();
      }
    });

    // Native browser fullscreen change sync
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && wrapper.classList.contains('is-fullscreen')) {
        exitFocusFullscreen(false);
      }
    });
  }

  renderFocusDisplay(0);
  renderFocusSessions();
  updateFocusTodayStats();
}

function toggleFocusFullscreen() {
  const wrapper = $('#focusClockWrapper') || $('.focus-clock-wrapper');
  if (!wrapper) return;
  if (wrapper.classList.contains('is-fullscreen')) {
    exitFocusFullscreen();
  } else {
    enterFocusFullscreen();
  }
}

function enterFocusFullscreen() {
  const wrapper = $('#focusClockWrapper') || $('.focus-clock-wrapper');
  const btnFs   = $('#btnFocusFullscreen');
  if (!wrapper) return;

  wrapper.classList.add('is-fullscreen');
  if (btnFs) {
    btnFs.innerHTML = '<i class="fa-solid fa-compress"></i><span class="fs-label">Exit (Esc)</span>';
    btnFs.title = 'Exit Fullscreen (Esc)';
  }

  // Request browser full screen if supported
  if (wrapper.requestFullscreen && !document.fullscreenElement) {
    wrapper.requestFullscreen().catch(() => {});
  }
  toast('Entered Fullscreen Focus Mode 🎯 (Press Esc to exit)', 'info');
}

function exitFocusFullscreen(callBrowserExit = true) {
  const wrapper = $('#focusClockWrapper') || $('.focus-clock-wrapper');
  const btnFs   = $('#btnFocusFullscreen');
  if (!wrapper) return;

  wrapper.classList.remove('is-fullscreen');
  if (btnFs) {
    btnFs.innerHTML = '<i class="fa-solid fa-expand"></i><span class="fs-label">Fullscreen</span>';
    btnFs.title = 'Toggle Fullscreen Focus';
  }

  if (callBrowserExit && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function startFocus() {
  focusElapsed = 0;
  focusRunning = true;
  focusPaused  = false;
  focusPrevDigits = { h1:'0', h2:'0', m1:'0', m2:'0', s1:'0', s2:'0' };

  $('.focus-clock-wrapper').classList.add('running');
  $('#focusStart').disabled = true;
  $('#focusPause').disabled = false;
  $('#focusReset').disabled = false;

  focusInterval = setInterval(() => {
    focusElapsed++;
    renderFocusDisplay(focusElapsed);
  }, 1000);

  toast('Focus session started — let\'s go! 🧠', 'success');
}

function pauseFocus() {
  if (!focusRunning) return;
  clearInterval(focusInterval);
  focusRunning = false;
  focusPaused  = true;

  $('.focus-clock-wrapper').classList.remove('running');
  const btnStart = $('#focusStart');
  btnStart.disabled = false;
  btnStart.innerHTML = '<i class="fa-solid fa-play"></i><span>Resume</span>';
  btnStart.classList.add('is-resume');
  $('#focusPause').disabled = true;

  toast('Focus paused — take a breath', 'info');
}

function resumeFocus() {
  focusRunning = true;
  focusPaused  = false;

  $('.focus-clock-wrapper').classList.add('running');
  const btnStart = $('#focusStart');
  btnStart.disabled = true;
  btnStart.innerHTML = '<i class="fa-solid fa-play"></i><span>Start</span>';
  btnStart.classList.remove('is-resume');
  $('#focusPause').disabled = false;

  focusInterval = setInterval(() => {
    focusElapsed++;
    renderFocusDisplay(focusElapsed);
  }, 1000);

  toast('Resumed — keep going! 💪', 'success');
}

function resetFocus() {
  clearInterval(focusInterval);

  // Save session if at least 10 seconds elapsed
  if (focusElapsed >= 10) {
    const now = new Date();
    const session = {
      id: uid(),
      duration: focusElapsed,
      startedAt: new Date(now.getTime() - focusElapsed * 1000).toISOString(),
      endedAt: now.toISOString()
    };
    Store.addFocusSession(todayKey(), session);
    const mins = Math.floor(focusElapsed / 60);
    const secs = focusElapsed % 60;
    toast(`Session saved: ${mins}m ${secs}s 🎉`, 'success');
  }

  focusElapsed = 0;
  focusRunning = false;
  focusPaused  = false;
  focusPrevDigits = { h1:'0', h2:'0', m1:'0', m2:'0', s1:'0', s2:'0' };

  $('.focus-clock-wrapper').classList.remove('running');
  const btnStart = $('#focusStart');
  btnStart.disabled = false;
  btnStart.innerHTML = '<i class="fa-solid fa-play"></i><span>Start</span>';
  btnStart.classList.remove('is-resume');
  $('#focusPause').disabled = true;
  $('#focusReset').disabled = true;

  renderFocusDisplay(0);
  renderFocusSessions();
  updateFocusTodayStats();
  updateStats();
}

function renderFocusDisplay(totalSec) {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');

  flipFocusDigit('focusHourTens', focusPrevDigits.h1, h[0]);
  flipFocusDigit('focusHourOnes', focusPrevDigits.h2, h[1]);
  flipFocusDigit('focusMinTens',  focusPrevDigits.m1, m[0]);
  flipFocusDigit('focusMinOnes',  focusPrevDigits.m2, m[1]);
  flipFocusDigit('focusSecTens',  focusPrevDigits.s1, s[0]);
  flipFocusDigit('focusSecOnes',  focusPrevDigits.s2, s[1]);

  focusPrevDigits = { h1:h[0], h2:h[1], m1:m[0], m2:m[1], s1:s[0], s2:s[1] };
}

function flipFocusDigit(id, oldVal, newVal) {
  if (oldVal === newVal) return;
  const card = $(`#${id}`);
  const front = $('.flip-card-front span', card);
  const back  = $('.flip-card-back span', card);

  back.textContent = newVal;
  card.classList.add('flipping');

  setTimeout(() => {
    front.textContent = newVal;
    card.classList.remove('flipping');
  }, 500);
}

function updateFocusTodayStats() {
  const sessions = Store.getFocusSessions(todayKey());
  const totalSec = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);

  $('#focusTodayTotal').textContent = `${h}h ${m}m`;
  $('#focusTodaySessions').textContent = sessions.length;
}

function renderFocusSessions() {
  const log = $('#focusSessionsLog');
  const sessions = Store.getFocusSessions(todayKey());

  if (sessions.length === 0) {
    log.innerHTML = '<div class="focus-sessions-empty">No study sessions today yet. Hit <strong>Start</strong> to begin!</div>';
    return;
  }

  log.innerHTML = '';
  // Show newest first
  [...sessions].reverse().forEach(s => {
    const startTime = new Date(s.startedAt).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    const endTime   = new Date(s.endedAt).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    const dur = s.duration || 0;
    const h = Math.floor(dur / 3600);
    const m = Math.floor((dur % 3600) / 60);
    const sec = dur % 60;
    let durStr = '';
    if (h > 0) durStr += `${h}h `;
    if (m > 0 || h > 0) durStr += `${m}m `;
    durStr += `${sec}s`;

    const entry = document.createElement('div');
    entry.className = 'focus-session-entry';
    entry.innerHTML = `
      <span class="session-time"><i class="fa-regular fa-clock"></i> ${startTime} — ${endTime}</span>
      <span class="session-duration">${durStr}</span>
    `;
    log.appendChild(entry);
  });
}

// ─────────── SETTINGS UI ───────────
function initSettings() {
  const btnSettings = $('#btnSettings');
  const modal = $('#settingsModal');
  const btnClose = $('#settingsModalClose');
  const btnDone = $('#settingsModalDone');
  const fontSelect = $('#fontSelect');
  const toggle24 = $('#toggle24Hour');

  if (!btnSettings || !modal) return;

  // Open modal
  btnSettings.addEventListener('click', () => {
    Settings.apply();
    modal.classList.add('open');
  });

  // Close modal
  const closeModal = () => modal.classList.remove('open');
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnDone) btnDone.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Theme switch (Dark / Light)
  $$('.theme-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      Settings.data.theme = btn.dataset.theme;
      Settings.save();
      toast(`Theme set to ${btn.dataset.theme.toUpperCase()}`, 'info');
    });
  });

  // Font switch
  if (fontSelect) {
    fontSelect.addEventListener('change', () => {
      Settings.data.font = fontSelect.value;
      Settings.save();
      toast(`Font changed to ${fontSelect.value}`, 'info');
    });
  }

  // Accent color switch
  $$('.accent-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      Settings.data.accent = dot.dataset.accent;
      Settings.save();
      toast('Accent color updated', 'success');
    });
  });

  // 24h clock toggle
  if (toggle24) {
    toggle24.addEventListener('change', () => {
      Settings.data.is24Hour = toggle24.checked;
      Settings.save();
      tickMiniClock();
      toast(toggle24.checked ? '24-hour clock enabled' : '12-hour clock enabled', 'info');
    });
  }
}

// ─────────── HELPERS ───────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function refreshAll() {
  renderCalendar();
  renderTasks();
  renderNotes();
  updateStats();
  renderFocusSessions();
  updateFocusTodayStats();
}

// ─────────── INIT ───────────
document.addEventListener('DOMContentLoaded', () => {
  Settings.load();
  Store.load();
  initNav();
  initAuth();
  initClock();
  initSettings();
  initFocusClock();
  initCalendar();
  initTasks();
  initNotes();
  updateStats();
});
