/* ============================================================
   Team Manager — 掲示板・タスク・メンバー進捗・カレンダー
   Firebase Auth + Firestore (compat SDK)
   ============================================================ */

const LOGIN_DOMAIN = 'team-manager.app'; // ログインID → 疑似メールアドレス変換用

// ---------- 状態 ----------
let db = null;
let auth = null;
let me = null;            // firebase auth user
let myProfile = null;     // users/{uid} のデータ
let usersMap = {};        // uid -> profile
let posts = [];           // 掲示板投稿
let tasksMap = new Map(); // id -> task
let eventsMap = new Map();// id -> event
let unsubscribers = [];
let currentView = 'board';
let taskTab = 'mine';
let taskStatusFilter = 'all';
let boardFilter = 'all';
let calYear, calMonth;    // カレンダー表示中の年月

// ---------- ユーティリティ ----------
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTimestamp(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDateStr(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow})`;
}

// 期間表示: "7/20(月)" または "7/20(月) 〜 7/22(水)"
function periodLabel(start, end) {
  if (!start && !end) return '';
  if (start && end && start !== end) return `${fmtDateStr(start)} 〜 ${fmtDateStr(end)}`;
  return fmtDateStr(start || end);
}

// 期間内の日付リスト（最大62日で打ち切り）
function expandRangeDates(start, end) {
  const s = start || end;
  const e = end || start;
  if (!s) return [];
  const dates = [];
  let [y, m, d] = s.split('-').map(Number);
  let cur = new Date(y, m - 1, d);
  for (let i = 0; i < 62; i++) {
    const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    dates.push(ds);
    if (ds >= e) break;
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ---------- 参加者選択（共通フォーマット） ----------
function participantsFieldHtml(selectedUids) {
  const sel = new Set(selectedUids || []);
  const rows = Object.entries(usersMap).map(([uid, u]) => `
    <label class="form-check participant-item">
      <input type="checkbox" class="participant-cb" value="${uid}" data-name="${esc(u.name)}" ${sel.has(uid) ? 'checked' : ''}>
      ${esc(u.name)} <span class="participant-pos">${esc(u.position || '')}</span>
    </label>`).join('');
  return `
    <div class="form-group">
      <label>参加者・関係者（複数選択可）</label>
      <div class="participant-list">${rows || '<span class="form-hint">メンバーがいません</span>'}</div>
    </div>`;
}

function collectParticipants() {
  const uids = [], names = [];
  document.querySelectorAll('.participant-cb:checked').forEach((cb) => {
    uids.push(cb.value);
    names.push(cb.dataset.name);
  });
  return { uids, names };
}

function participantsLabel(names) {
  if (!names || names.length === 0) return '';
  if (names.length <= 3) return names.join('・');
  return `${names.slice(0, 3).join('・')} 他${names.length - 3}名`;
}

// 期間入力（共通フォーマット）
function periodFieldsHtml(start, end, startLabel, endLabel) {
  return `
    <div class="form-row">
      <div class="form-group">
        <label>${startLabel || '開始日'}</label>
        <input type="date" id="item-start" value="${start || ''}">
      </div>
      <div class="form-group">
        <label>${endLabel || '終了日'}</label>
        <input type="date" id="item-end" value="${end || ''}">
      </div>
    </div>`;
}

// ---------- 種類切替（タスク / 予定） ----------
function typeSwitchHtml(current) {
  return `
    <div class="type-switch">
      <button type="button" class="type-btn ${current === 'task' ? 'active' : ''}" id="type-task">✅ タスク</button>
      <button type="button" class="type-btn ${current === 'event' ? 'active' : ''}" id="type-event">📅 予定</button>
    </div>
    <div class="form-hint" style="margin:-6px 0 12px">${current === 'task' ? 'タスク＝担当者と進捗を管理するもの / 予定＝日時が決まっている出来事' : '予定＝日時が決まっている出来事 / タスク＝担当者と進捗を管理するもの'}</div>`;
}

// ---------- 自動翻訳 ----------
const TRANS_LANGS = [
  ['en', 'English'], ['ja', '日本語'], ['zh-CN', '中文(简体)'], ['ko', '한국어'],
  ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['th', 'ไทย']
];

async function translateText(text, target) {
  if (!text.trim()) return '';
  // Google 翻訳（非公式エンドポイント）→ 失敗時は MyMemory にフォールバック
  try {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`);
    if (r.ok) {
      const d = await r.json();
      return d[0].map((x) => x[0]).join('');
    }
  } catch (e) { /* fallback へ */ }
  const r2 = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=autodetect|${encodeURIComponent(target)}`);
  const d2 = await r2.json();
  if (d2.responseData && d2.responseData.translatedText) return d2.responseData.translatedText;
  throw new Error('翻訳に失敗しました');
}

// 翻訳バー（詳細モーダル共通）。textsFn は翻訳対象テキストを返す関数
function translateBarHtml() {
  const lang = localStorage.getItem('transLang') || 'en';
  const auto = localStorage.getItem('transAuto') === '1';
  const opts = TRANS_LANGS.map(([code, label]) =>
    `<option value="${code}" ${code === lang ? 'selected' : ''}>${label}</option>`).join('');
  return `
    <div class="translate-bar">
      <select id="trans-lang">${opts}</select>
      <button class="btn btn-sm" id="trans-btn">🌐 翻訳</button>
      <label class="form-check" style="font-size:12px"><input type="checkbox" id="trans-auto" ${auto ? 'checked' : ''}> 自動翻訳</label>
    </div>
    <div class="trans-result hidden" id="trans-result"></div>`;
}

function setupTranslateBar(textsFn) {
  const btn = $('trans-btn');
  if (!btn) return;
  const run = async () => {
    const lang = $('trans-lang').value;
    localStorage.setItem('transLang', lang);
    const out = $('trans-result');
    out.classList.remove('hidden');
    out.textContent = '翻訳中...';
    try {
      const results = [];
      for (const t of textsFn().filter((x) => x && x.trim())) {
        results.push(await translateText(t, lang));
      }
      out.textContent = results.join('\n\n') || '(翻訳対象がありません)';
    } catch (e) {
      out.textContent = '⚠️ 翻訳に失敗しました。時間をおいて再試行してください。';
    }
  };
  btn.addEventListener('click', run);
  $('trans-auto').addEventListener('change', (e) => {
    localStorage.setItem('transAuto', e.target.checked ? '1' : '0');
  });
  $('trans-lang').addEventListener('change', () => localStorage.setItem('transLang', $('trans-lang').value));
  if (localStorage.getItem('transAuto') === '1') run();
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

const STATUS_LABEL = { todo: '未着手', doing: '進行中', done: '完了' };
const STATUS_BADGE = { todo: 'badge-todo', doing: 'badge-doing', done: 'badge-done' };

// ---------- モーダル ----------
function openModal(title, bodyHtml) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('modal-overlay').classList.add('hidden');
  $('modal-body').innerHTML = '';
}
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('modal-overlay')) closeModal();
});

// ============================================================
// 初期化
// ============================================================
(function init() {
  if (typeof firebaseConfig === 'undefined' || firebaseConfig.apiKey.startsWith('PASTE')) {
    $('setup-screen').classList.remove('hidden');
    return;
  }
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      me = user;
      await loadMyProfile();
      showApp();
    } else {
      me = null;
      myProfile = null;
      teardownSubscriptions();
      $('app-screen').classList.add('hidden');
      $('auth-screen').classList.remove('hidden');
    }
  });
})();

async function loadMyProfile() {
  const snap = await db.collection('users').doc(me.uid).get();
  myProfile = snap.exists ? snap.data() : { name: 'ユーザー', position: '-' };
}

function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  $('user-name').textContent = myProfile.name;
  $('user-position').textContent = myProfile.position;
  $('user-avatar').textContent = (myProfile.name || '?').charAt(0);
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  setupSubscriptions();
  switchView(currentView);
}

// ============================================================
// 認証
// ============================================================
function showAuthError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function authErrorJa(err) {
  const code = err && err.code ? err.code : '';
  if (code.includes('email-already-in-use')) return 'このIDは既に使われています';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'IDまたはパスワードが違います';
  if (code.includes('weak-password')) return 'パスワードは6文字以上にしてください';
  if (code.includes('too-many-requests')) return '試行回数が多すぎます。しばらく待ってください';
  if (code.includes('network')) return 'ネットワークエラーが発生しました';
  return 'エラーが発生しました（' + code + '）';
}

$('tab-login').addEventListener('click', () => {
  $('tab-login').classList.add('active');
  $('tab-register').classList.remove('active');
  $('login-form').classList.remove('hidden');
  $('register-form').classList.add('hidden');
  $('auth-error').classList.add('hidden');
});
$('tab-register').addEventListener('click', () => {
  $('tab-register').classList.add('active');
  $('tab-login').classList.remove('active');
  $('register-form').classList.remove('hidden');
  $('login-form').classList.add('hidden');
  $('auth-error').classList.add('hidden');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('login-id').value.trim().toLowerCase();
  const pw = $('login-pw').value;
  try {
    await auth.signInWithEmailAndPassword(`${id}@${LOGIN_DOMAIN}`, pw);
  } catch (err) {
    showAuthError(authErrorJa(err));
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('reg-name').value.trim();
  const position = $('reg-position').value.trim();
  const id = $('reg-id').value.trim().toLowerCase();
  const pw = $('reg-pw').value;
  if (!/^[a-z0-9_.\-]+$/.test(id)) {
    showAuthError('IDは半角英数字（. _ - 可）で入力してください');
    return;
  }
  try {
    const cred = await auth.createUserWithEmailAndPassword(`${id}@${LOGIN_DOMAIN}`, pw);
    await db.collection('users').doc(cred.user.uid).set({
      loginId: id,
      name,
      position,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    myProfile = { loginId: id, name, position };
  } catch (err) {
    showAuthError(authErrorJa(err));
  }
});

$('logout-btn').addEventListener('click', () => auth.signOut());

// ============================================================
// Firestore 購読
// ============================================================
function teardownSubscriptions() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  usersMap = {};
  posts = [];
  tasksMap = new Map();
  eventsMap = new Map();
}

function setupSubscriptions() {
  teardownSubscriptions();

  // メンバー一覧
  unsubscribers.push(
    db.collection('users').onSnapshot((snap) => {
      usersMap = {};
      snap.forEach((doc) => { usersMap[doc.id] = doc.data(); });
      renderIfActive(['members', 'tasks']);
    })
  );

  // 掲示板
  unsubscribers.push(
    db.collection('posts').orderBy('createdAt', 'desc').limit(200).onSnapshot((snap) => {
      posts = [];
      snap.forEach((doc) => posts.push({ id: doc.id, ...doc.data() }));
      renderIfActive(['board']);
    })
  );

  // タスク: 公開分 + 自分の分（プライベート含む）を別クエリで購読しマージ
  const mergeTaskSnap = (tag) => (snap) => {
    for (const [id, t] of tasksMap) {
      if (t._src === tag) tasksMap.delete(id);
    }
    snap.forEach((doc) => {
      const existing = tasksMap.get(doc.id);
      if (!existing || existing._src === tag) {
        tasksMap.set(doc.id, { id: doc.id, _src: tag, ...doc.data() });
      }
    });
    renderIfActive(['tasks', 'members', 'calendar', 'board']);
  };
  unsubscribers.push(
    db.collection('tasks').where('isPrivate', '==', false).onSnapshot(mergeTaskSnap('pub'))
  );
  unsubscribers.push(
    db.collection('tasks').where('ownerUid', '==', me.uid).onSnapshot(mergeTaskSnap('own'))
  );

  // 予定: 公開分 + 自分の分
  const mergeEventSnap = (tag) => (snap) => {
    for (const [id, ev] of eventsMap) {
      if (ev._src === tag) eventsMap.delete(id);
    }
    snap.forEach((doc) => {
      const existing = eventsMap.get(doc.id);
      if (!existing || existing._src === tag) {
        eventsMap.set(doc.id, { id: doc.id, _src: tag, ...doc.data() });
      }
    });
    renderIfActive(['calendar', 'board']);
  };
  unsubscribers.push(
    db.collection('events').where('isPrivate', '==', false).onSnapshot(mergeEventSnap('pub'))
  );
  unsubscribers.push(
    db.collection('events').where('ownerUid', '==', me.uid).onSnapshot(mergeEventSnap('own'))
  );
}

function renderIfActive(views) {
  if (views.includes(currentView)) render();
}

// ============================================================
// ビュー切り替え
// ============================================================
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  render();
}

function render() {
  if (currentView === 'board') renderBoard();
  else if (currentView === 'tasks') renderTasks();
  else if (currentView === 'members') renderMembers();
  else if (currentView === 'calendar') renderCalendar();
}

// ============================================================
// 掲示板
// ============================================================
document.querySelectorAll('#board-filters .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    boardFilter = btn.dataset.kind;
    document.querySelectorAll('#board-filters .chip').forEach((b) => b.classList.toggle('active', b === btn));
    renderBoard();
  });
});

// 掲示板 = 統合フィード: 投稿 + 公開タスク + 公開予定 を時系列で表示
function feedItems() {
  const created = (x) => (x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : Date.now());
  const items = [];
  posts.forEach((p) => items.push({ kind: 'post', created: created(p), pinned: !!p.pinned, data: p }));
  [...tasksMap.values()].filter((t) => !t.isPrivate).forEach((t) =>
    items.push({ kind: 'task', created: created(t), pinned: false, data: t }));
  [...eventsMap.values()].filter((ev) => !ev.isPrivate).forEach((ev) =>
    items.push({ kind: 'event', created: created(ev), pinned: false, data: ev }));
  return items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.created - a.created);
}

function feedCardHtml(item) {
  if (item.kind === 'post') {
    const p = item.data;
    return `
      <div class="post-card" data-kind="post" data-id="${p.id}">
        <div class="post-card-title">
          <span class="badge badge-feed-post">💬 投稿</span>
          ${p.pinned ? '<span class="pin-badge">📌 固定</span>' : ''}
          ${esc(p.title)}
        </div>
        <div class="post-card-preview">${esc(p.body)}</div>
        <div class="post-card-meta">
          <span>👤 ${esc(p.authorName)}</span>
          <span>🕐 ${fmtTimestamp(p.createdAt)}</span>
          <span>💬 ${p.commentCount || 0}</span>
          ${p.startDate || p.endDate ? `<span>📅 ${periodLabel(p.startDate, p.endDate)}</span>` : ''}
          ${p.participantNames && p.participantNames.length ? `<span>👥 ${esc(participantsLabel(p.participantNames))}</span>` : ''}
        </div>
      </div>`;
  }
  if (item.kind === 'task') {
    const t = item.data;
    return `
      <div class="post-card" data-kind="task" data-id="${t.id}">
        <div class="post-card-title">
          <span class="badge badge-feed-task">✅ タスク</span>
          <span class="badge ${STATUS_BADGE[t.status]}">${STATUS_LABEL[t.status]}</span>
          <span class="${t.status === 'done' ? 'task-title done' : ''}" style="flex:none">${esc(t.title)}</span>
        </div>
        ${t.detail ? `<div class="post-card-preview">${esc(t.detail)}</div>` : ''}
        <div class="post-card-meta">
          <span>👤 ${esc(t.assigneeName || t.ownerName || '')}</span>
          ${t.startDate || t.dueDate ? `<span>📅 ${periodLabel(t.startDate, t.dueDate)}</span>` : ''}
          ${t.participantNames && t.participantNames.length ? `<span>👥 ${esc(participantsLabel(t.participantNames))}</span>` : ''}
          <span>進捗 ${t.progress || 0}%</span>
        </div>
      </div>`;
  }
  const ev = item.data;
  return `
    <div class="post-card" data-kind="event" data-id="${ev.id}">
      <div class="post-card-title">
        <span class="badge badge-feed-event">📅 予定</span>
        ${esc(ev.title)}
      </div>
      ${ev.memo ? `<div class="post-card-preview">${esc(ev.memo)}</div>` : ''}
      <div class="post-card-meta">
        <span>📅 ${periodLabel(ev.date, ev.endDate)}${ev.time ? ' 🕐 ' + esc(ev.time) : ''}</span>
        ${ev.participantNames && ev.participantNames.length ? `<span>👥 ${esc(participantsLabel(ev.participantNames))}</span>` : `<span>👤 ${esc(ev.ownerName || '')}</span>`}
      </div>
    </div>`;
}

function renderBoard() {
  const list = $('post-list');
  let items = feedItems();
  if (boardFilter !== 'all') items = items.filter((it) => it.kind === boardFilter);
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">まだ何もありません。「＋ 新規投稿」から始めましょう。タスクや予定を作成しても、ここに自動で表示されます。</div>';
    return;
  }
  list.innerHTML = items.map(feedCardHtml).join('');
  list.querySelectorAll('.post-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.kind === 'post') openPostDetail(el.dataset.id);
      else if (el.dataset.kind === 'task') openTaskModal(el.dataset.id);
      else openEventModal(el.dataset.id);
    });
  });
}

$('new-post-btn').addEventListener('click', () => {
  openModal('新規投稿', `
    <div class="form-group">
      <label>タイトル</label>
      <input type="text" id="post-title" placeholder="例）今週のミーティングについて">
    </div>
    <div class="form-group">
      <label>内容・詳細</label>
      <textarea id="post-body" rows="6"></textarea>
    </div>
    ${periodFieldsHtml('', '', '開始日（任意）', '終了日（任意）')}
    <div class="form-hint" style="margin:-8px 0 12px">日付を入れるとカレンダーにも表示されます</div>
    ${participantsFieldHtml([])}
    <label class="form-check"><input type="checkbox" id="post-pinned"> 📌 上部に固定する</label>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="post-cancel">キャンセル</button>
        <button class="btn btn-primary" id="post-save">投稿する</button>
      </div>
    </div>
  `);
  $('post-cancel').addEventListener('click', closeModal);
  $('post-save').addEventListener('click', async () => {
    const title = $('post-title').value.trim();
    const body = $('post-body').value.trim();
    if (!title) { toast('タイトルを入力してください'); return; }
    const start = $('item-start').value || null;
    const end = $('item-end').value || null;
    if (start && end && end < start) { toast('終了日は開始日以降にしてください'); return; }
    const p = collectParticipants();
    await db.collection('posts').add({
      title, body,
      startDate: start,
      endDate: end,
      participantUids: p.uids,
      participantNames: p.names,
      pinned: $('post-pinned').checked,
      authorUid: me.uid,
      authorName: myProfile.name,
      commentCount: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    closeModal();
    toast('投稿しました');
  });
});

async function openPostDetail(postId) {
  const p = posts.find((x) => x.id === postId);
  if (!p) return;
  const isMine = p.authorUid === me.uid;
  openModal(p.title, `
    <div class="post-card-meta" style="margin-top:-6px">
      <span>👤 ${esc(p.authorName)}</span>
      <span>🕐 ${fmtTimestamp(p.createdAt)}</span>
      ${p.pinned ? '<span class="pin-badge">📌 固定</span>' : ''}
    </div>
    ${p.startDate || p.endDate ? `<div class="post-card-meta">📅 ${periodLabel(p.startDate, p.endDate)}</div>` : ''}
    ${p.participantNames && p.participantNames.length ? `<div class="post-card-meta">👥 ${esc(p.participantNames.join('・'))}</div>` : ''}
    <div class="post-detail-body">${esc(p.body)}</div>
    ${translateBarHtml()}
    <div class="comment-list" id="comment-list"><div class="empty-state">読み込み中...</div></div>
    <form class="comment-form" id="comment-form">
      <input type="text" id="comment-input" placeholder="コメントを書く..." autocomplete="off">
      <button type="submit" class="btn btn-primary btn-sm">送信</button>
    </form>
    <div class="modal-actions">
      <button class="btn btn-sm" id="post-to-task">✅ タスク化</button>
      <button class="btn btn-sm" id="post-to-event">📅 予定化</button>
      ${isMine ? `
        <button class="btn btn-sm" id="post-pin-toggle">${p.pinned ? '固定を解除' : '📌 固定する'}</button>
        <div class="right"><button class="btn btn-sm btn-danger" id="post-delete">削除</button></div>
      ` : ''}
    </div>
  `);

  setupTranslateBar(() => [p.title, p.body]);

  $('post-to-task').addEventListener('click', () => {
    openTaskModal(null, {
      title: p.title,
      detail: p.body,
      startDate: p.startDate || '',
      dueDate: p.endDate || p.startDate || '',
      participantUids: p.participantUids || []
    });
  });

  $('post-to-event').addEventListener('click', () => {
    openEventModal(null, {
      title: p.title,
      memo: p.body,
      date: p.startDate || p.endDate || todayStr(),
      endDate: p.endDate && p.startDate ? p.endDate : '',
      participantUids: p.participantUids || []
    });
  });

  const loadComments = async () => {
    const snap = await db.collection('posts').doc(postId).collection('comments').orderBy('createdAt', 'asc').get();
    const el = $('comment-list');
    if (!el) return;
    if (snap.empty) {
      el.innerHTML = '<div class="empty-state" style="padding:10px 0">コメントはまだありません</div>';
      return;
    }
    let html = '';
    snap.forEach((doc) => {
      const c = doc.data();
      html += `
        <div class="comment-item">
          <div class="avatar" style="width:26px;height:26px;font-size:12px">${esc((c.authorName || '?').charAt(0))}</div>
          <div class="comment-content">
            <div class="comment-author">${esc(c.authorName)}<span class="comment-time">${fmtTimestamp(c.createdAt)}</span></div>
            <div class="comment-text">${esc(c.text)}</div>
          </div>
        </div>`;
    });
    el.innerHTML = html;
  };
  loadComments();

  $('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('comment-input').value.trim();
    if (!text) return;
    $('comment-input').value = '';
    await db.collection('posts').doc(postId).collection('comments').add({
      text,
      authorUid: me.uid,
      authorName: myProfile.name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('posts').doc(postId).update({
      commentCount: firebase.firestore.FieldValue.increment(1)
    });
    loadComments();
  });

  if (isMine) {
    $('post-pin-toggle').addEventListener('click', async () => {
      await db.collection('posts').doc(postId).update({ pinned: !p.pinned });
      closeModal();
    });
    $('post-delete').addEventListener('click', async () => {
      if (!confirm('この投稿を削除しますか？')) return;
      await db.collection('posts').doc(postId).delete();
      closeModal();
      toast('削除しました');
    });
  }
}

// ============================================================
// タスク
// ============================================================
document.querySelectorAll('[data-tasktab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    taskTab = btn.dataset.tasktab;
    document.querySelectorAll('[data-tasktab]').forEach((b) => b.classList.toggle('active', b === btn));
    renderTasks();
  });
});
document.querySelectorAll('#task-filters .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    taskStatusFilter = btn.dataset.status;
    document.querySelectorAll('#task-filters .chip').forEach((b) => b.classList.toggle('active', b === btn));
    renderTasks();
  });
});

function sortTasks(arr) {
  return arr.sort((a, b) => {
    const da = a.dueDate || '9999-99-99';
    const db_ = b.dueDate || '9999-99-99';
    if (da !== db_) return da < db_ ? -1 : 1;
    return 0;
  });
}

function taskCardHtml(t) {
  const today = todayStr();
  const overdue = t.dueDate && t.dueDate < today && t.status !== 'done';
  return `
    <div class="task-card" data-id="${t.id}">
      <div class="task-row">
        <span class="badge ${STATUS_BADGE[t.status]}">${STATUS_LABEL[t.status]}</span>
        <span class="task-title ${t.status === 'done' ? 'done' : ''}">${t.isPrivate ? '🔒 ' : ''}${esc(t.title)}</span>
        ${t.participantNames && t.participantNames.length ? `<span class="task-due">👥 ${esc(participantsLabel(t.participantNames))}</span>` : ''}
        ${t.startDate || t.dueDate ? `<span class="task-due ${overdue ? 'overdue' : ''}">📅 ${periodLabel(t.startDate, t.dueDate)}${overdue ? ' 期限超過' : ''}</span>` : ''}
      </div>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill ${t.status === 'done' ? 'done' : ''}" style="width:${t.progress || 0}%"></div></div>
        <span class="progress-label">${t.progress || 0}%</span>
      </div>
    </div>`;
}

function renderTasks() {
  const list = $('task-list');
  let arr = [...tasksMap.values()];

  if (taskStatusFilter !== 'all') arr = arr.filter((t) => t.status === taskStatusFilter);

  let html = '';
  if (taskTab === 'mine') {
    arr = arr.filter((t) => t.assigneeUid === me.uid || t.ownerUid === me.uid ||
      (t.participantUids || []).includes(me.uid));
    const priv = sortTasks(arr.filter((t) => t.isPrivate));
    const pub = sortTasks(arr.filter((t) => !t.isPrivate));
    if (pub.length) html += `<div class="task-group-title">🌐 公開タスク</div>` + pub.map(taskCardHtml).join('');
    if (priv.length) html += `<div class="task-group-title">🔒 プライベートタスク（自分のみ表示）</div>` + priv.map(taskCardHtml).join('');
  } else {
    arr = arr.filter((t) => !t.isPrivate);
    // 担当者ごとにグループ化
    const groups = {};
    arr.forEach((t) => {
      const key = t.assigneeUid || t.ownerUid;
      (groups[key] = groups[key] || []).push(t);
    });
    const uids = Object.keys(groups).sort((a, b) => {
      const pa = (usersMap[a] || {}).position || '';
      const pb = (usersMap[b] || {}).position || '';
      return pa.localeCompare(pb, 'ja');
    });
    uids.forEach((uid) => {
      const u = usersMap[uid] || {};
      const name = groups[uid][0].assigneeName || u.name || '不明';
      html += `<div class="task-group-title">👤 ${esc(name)} <span class="badge badge-pos">${esc(u.position || '-')}</span></div>`;
      html += sortTasks(groups[uid]).map(taskCardHtml).join('');
    });
  }

  list.innerHTML = html || '<div class="empty-state">タスクがありません</div>';
  list.querySelectorAll('.task-card').forEach((el) => {
    el.addEventListener('click', () => openTaskModal(el.dataset.id));
  });
}

$('new-task-btn').addEventListener('click', () => openTaskModal(null));

function memberOptionsHtml(selectedUid) {
  return Object.entries(usersMap).map(([uid, u]) =>
    `<option value="${uid}" ${uid === selectedUid ? 'selected' : ''}>${esc(u.name)}（${esc(u.position)}）</option>`
  ).join('');
}

function openTaskModal(taskId, prefill) {
  const t = taskId ? tasksMap.get(taskId) : null;
  const pre = prefill || {};
  const isNew = !t;
  const canEdit = isNew || !t.isPrivate || t.ownerUid === me.uid;
  openModal(isNew ? '新規作成' : 'タスクの編集', `
    ${isNew ? typeSwitchHtml('task') : ''}
    <div class="form-group">
      <label>タイトル</label>
      <input type="text" id="task-title" value="${t ? esc(t.title) : esc(pre.title || '')}" placeholder="例）週次レポート作成">
    </div>
    <div class="form-group">
      <label>内容・詳細</label>
      <textarea id="task-detail" rows="4">${t ? esc(t.detail || '') : esc(pre.detail || '')}</textarea>
    </div>
    ${periodFieldsHtml(
      t ? (t.startDate || '') : (pre.startDate || ''),
      t ? (t.dueDate || '') : (pre.dueDate || ''),
      '開始日（任意）', '期限'
    )}
    <div class="form-group">
      <label>担当者</label>
      <select id="task-assignee">${memberOptionsHtml(t ? t.assigneeUid : me.uid)}</select>
    </div>
    ${participantsFieldHtml(t ? (t.participantUids || []) : (pre.participantUids || []))}
    <div class="form-row">
      <div class="form-group">
        <label>ステータス</label>
        <select id="task-status">
          <option value="todo" ${t && t.status === 'todo' ? 'selected' : ''}>未着手</option>
          <option value="doing" ${t && t.status === 'doing' ? 'selected' : ''}>進行中</option>
          <option value="done" ${t && t.status === 'done' ? 'selected' : ''}>完了</option>
        </select>
      </div>
      <div class="form-group">
        <label>進捗: <span id="task-progress-label">${t ? (t.progress || 0) : 0}</span>%</label>
        <input type="range" id="task-progress" min="0" max="100" step="5" value="${t ? (t.progress || 0) : 0}">
      </div>
    </div>
    <label class="form-check">
      <input type="checkbox" id="task-private" ${(t ? t.isPrivate : pre.isPrivate) ? 'checked' : ''}>
      🔒 プライベート（自分にのみ表示）
    </label>
    <div class="form-hint">プライベートタスクは担当者が自分・参加者なしの場合のみ設定できます</div>
    ${!isNew ? translateBarHtml() : ''}
    <div class="modal-actions">
      ${!isNew && canEdit ? '<button class="btn btn-sm btn-danger" id="task-delete">削除</button>' : '<span></span>'}
      <div class="right">
        <button class="btn" id="task-cancel">キャンセル</button>
        ${canEdit ? `<button class="btn btn-primary" id="task-save">${isNew ? '作成する' : '保存する'}</button>` : ''}
      </div>
    </div>
  `);

  if (!isNew) setupTranslateBar(() => [$('task-title').value, $('task-detail').value]);

  // 種類切替: 入力途中の内容を引き継いで予定モーダルへ
  if (isNew) {
    $('type-event').addEventListener('click', () => {
      const p = collectParticipants();
      openEventModal(null, {
        title: $('task-title').value,
        memo: $('task-detail').value,
        date: $('item-start').value || $('item-end').value || todayStr(),
        endDate: $('item-end').value && $('item-start').value ? $('item-end').value : '',
        participantUids: p.uids,
        isPrivate: $('task-private').checked
      });
    });
  }

  const progressInput = $('task-progress');
  const statusSelect = $('task-status');
  progressInput.addEventListener('input', () => {
    $('task-progress-label').textContent = progressInput.value;
    if (progressInput.value === '100') statusSelect.value = 'done';
    else if (progressInput.value !== '0' && statusSelect.value === 'todo') statusSelect.value = 'doing';
  });
  statusSelect.addEventListener('change', () => {
    if (statusSelect.value === 'done') {
      progressInput.value = 100;
      $('task-progress-label').textContent = '100';
    }
  });

  $('task-cancel').addEventListener('click', closeModal);

  if (canEdit) {
    $('task-save').addEventListener('click', async () => {
      const title = $('task-title').value.trim();
      if (!title) { toast('タイトルを入力してください'); return; }
      const assigneeUid = $('task-assignee').value;
      const p = collectParticipants();
      let isPrivate = $('task-private').checked;
      if (isPrivate && (assigneeUid !== me.uid || p.uids.some((u) => u !== me.uid))) {
        toast('プライベートタスクは担当者が自分・参加者なしの場合のみ設定できます');
        return;
      }
      const start = $('item-start').value || null;
      const due = $('item-end').value || null;
      if (start && due && due < start) { toast('期限は開始日以降にしてください'); return; }
      const assignee = usersMap[assigneeUid] || {};
      const data = {
        title,
        detail: $('task-detail').value.trim(),
        assigneeUid,
        assigneeName: assignee.name || '',
        position: assignee.position || '',
        startDate: start,
        dueDate: due,
        participantUids: p.uids,
        participantNames: p.names,
        status: statusSelect.value,
        progress: Number(progressInput.value),
        isPrivate,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (isNew) {
        data.ownerUid = me.uid;
        data.ownerName = myProfile.name;
        data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('tasks').add(data);
        toast('タスクを作成しました');
      } else {
        await db.collection('tasks').doc(taskId).update(data);
        toast('保存しました');
      }
      closeModal();
    });
  }

  if (!isNew && canEdit) {
    $('task-delete').addEventListener('click', async () => {
      if (!confirm('このタスクを削除しますか？')) return;
      await db.collection('tasks').doc(taskId).delete();
      closeModal();
      toast('削除しました');
    });
  }
}

// ============================================================
// メンバー
// ============================================================
function renderMembers() {
  const list = $('member-list');
  const entries = Object.entries(usersMap).sort((a, b) =>
    (a[1].position || '').localeCompare(b[1].position || '', 'ja')
  );
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">メンバーがいません</div>';
    return;
  }
  let html = '';
  entries.forEach(([uid, u]) => {
    const memberTasks = sortTasks(
      [...tasksMap.values()].filter((t) => !t.isPrivate && (t.assigneeUid === uid || (!t.assigneeUid && t.ownerUid === uid)))
    );
    const doneCount = memberTasks.filter((t) => t.status === 'done').length;
    const rows = memberTasks.map((t) => {
      const overdue = t.dueDate && t.dueDate < todayStr() && t.status !== 'done';
      return `
        <div class="member-task-row" data-id="${t.id}">
          <span class="badge ${STATUS_BADGE[t.status]}">${STATUS_LABEL[t.status]}</span>
          <span class="task-title ${t.status === 'done' ? 'done' : ''}" style="font-weight:400">${esc(t.title)}</span>
          ${t.dueDate ? `<span class="task-due ${overdue ? 'overdue' : ''}">${fmtDateStr(t.dueDate)}</span>` : ''}
          <div class="progress-bar" style="width:90px;flex:none"><div class="progress-fill ${t.status === 'done' ? 'done' : ''}" style="width:${t.progress || 0}%"></div></div>
          <span class="progress-label">${t.progress || 0}%</span>
        </div>`;
    }).join('');
    html += `
      <div class="member-card">
        <div class="member-head">
          <div class="avatar">${esc((u.name || '?').charAt(0))}</div>
          <div>
            <div class="member-name">${esc(u.name)}</div>
            <span class="badge badge-pos">${esc(u.position || '-')}</span>
          </div>
          <div class="member-stats">公開タスク ${memberTasks.length} 件 / 完了 ${doneCount} 件</div>
        </div>
        <div class="member-tasks">${rows || '<div class="empty-state" style="padding:8px 0">公開タスクなし</div>'}</div>
      </div>`;
  });
  list.innerHTML = html;
  list.querySelectorAll('.member-task-row').forEach((el) => {
    el.addEventListener('click', () => openTaskModal(el.dataset.id));
  });
}

// ============================================================
// カレンダー
// ============================================================
$('cal-prev').addEventListener('click', () => { shiftMonth(-1); });
$('cal-next').addEventListener('click', () => { shiftMonth(1); });
$('cal-today').addEventListener('click', () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
});

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function itemsByDate() {
  const map = {};
  const push = (date, item) => { (map[date] = map[date] || []).push(item); };
  [...tasksMap.values()].forEach((t) => {
    expandRangeDates(t.startDate, t.dueDate).forEach((d) =>
      push(d, { kind: 'task', sortKey: '99:99', data: t }));
  });
  [...eventsMap.values()].forEach((ev) => {
    expandRangeDates(ev.date, ev.endDate).forEach((d) =>
      push(d, { kind: 'event', sortKey: ev.time || '00:00', data: ev }));
  });
  posts.forEach((p) => {
    expandRangeDates(p.startDate, p.endDate).forEach((d) =>
      push(d, { kind: 'post', sortKey: '00:01', data: p }));
  });
  const kindOrder = { event: 0, post: 1, task: 2 };
  Object.values(map).forEach((arr) => arr.sort((a, b) => {
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
    return a.sortKey < b.sortKey ? -1 : 1;
  }));
  return map;
}

function calItemHtml(item) {
  if (item.kind === 'task') {
    const t = item.data;
    const cls = t.status === 'done' ? 'cal-item-done' : 'cal-item-task';
    return `<div class="cal-item ${cls}">${t.isPrivate ? '🔒' : ''}✅ ${esc(t.title)}</div>`;
  }
  if (item.kind === 'post') {
    return `<div class="cal-item cal-item-post">💬 ${esc(item.data.title)}</div>`;
  }
  const ev = item.data;
  return `<div class="cal-item cal-item-event">${ev.isPrivate ? '🔒' : ''}${ev.time ? esc(ev.time) + ' ' : ''}${esc(ev.title)}</div>`;
}

function renderCalendar() {
  $('cal-title').textContent = `${calYear}年 ${calMonth + 1}月`;
  const grid = $('cal-grid');
  const itemMap = itemsByDate();
  const today = todayStr();

  const firstDow = new Date(calYear, calMonth, 1).getDay();
  const startDate = new Date(calYear, calMonth, 1 - firstDow);
  const cellCount = 42;

  let html = ['日', '月', '火', '水', '木', '金', '土'].map((d) => `<div class="cal-dow">${d}</div>`).join('');

  for (let i = 0; i < cellCount; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const other = d.getMonth() !== calMonth;
    const dowCls = d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '';
    const items = itemMap[ds] || [];
    const maxShow = 3;
    const shown = items.slice(0, maxShow).map(calItemHtml).join('');
    const more = items.length > maxShow ? `<div class="cal-more">他 ${items.length - maxShow} 件</div>` : '';
    const marks = items.slice(0, 6).map((it) => {
      const c = it.kind === 'event' ? 'dot-event' :
        it.kind === 'post' ? 'dot-post' :
        (it.data.status === 'done' ? 'dot-done' : 'dot-task');
      return `<i class="dot ${c}"></i>`;
    }).join('');
    html += `
      <div class="cal-cell ${other ? 'other-month' : ''} ${dowCls}" data-date="${ds}">
        <div class="cal-date ${ds === today ? 'today' : ''}">${d.getDate()}</div>
        ${shown}${more}
        <div class="cal-marks">${marks}</div>
      </div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-cell').forEach((el) => {
    el.addEventListener('click', () => openDayModal(el.dataset.date));
  });
}

function openDayModal(dateStr) {
  const items = itemsByDate()[dateStr] || [];
  const rows = items.map((item, idx) => {
    if (item.kind === 'task') {
      const t = item.data;
      return `
        <div class="day-item" data-idx="${idx}">
          <span class="badge ${STATUS_BADGE[t.status]}">${STATUS_LABEL[t.status]}</span>
          <span style="flex:1">${t.isPrivate ? '🔒 ' : ''}✅ ${esc(t.title)}</span>
          <span class="task-due">👤 ${esc(t.assigneeName || t.ownerName || '')}</span>
        </div>`;
    }
    if (item.kind === 'post') {
      const p = item.data;
      return `
        <div class="day-item" data-idx="${idx}">
          <span class="dot dot-post"></span>
          <span style="flex:1">💬 ${esc(p.title)}</span>
          <span class="task-due">${p.participantNames && p.participantNames.length ? '👥 ' + esc(participantsLabel(p.participantNames)) : '👤 ' + esc(p.authorName || '')}</span>
        </div>`;
    }
    const ev = item.data;
    return `
      <div class="day-item" data-idx="${idx}">
        <span class="dot dot-event"></span>
        <span style="flex:1">${ev.isPrivate ? '🔒 ' : ''}${ev.title ? esc(ev.title) : ''}</span>
        <span class="task-due">${ev.time ? '🕐 ' + esc(ev.time) : ''} ${ev.participantNames && ev.participantNames.length ? '👥 ' + esc(participantsLabel(ev.participantNames)) : '👤 ' + esc(ev.ownerName || '')}</span>
      </div>`;
  }).join('');

  openModal(`📅 ${fmtDateStr(dateStr)}`, `
    <div class="day-item-list">${rows || '<div class="empty-state" style="padding:10px 0">予定・タスクはありません</div>'}</div>
    <div class="modal-actions">
      <div class="right">
        <button class="btn" id="day-add-task">＋ タスク</button>
        <button class="btn btn-primary" id="day-add-event">＋ 予定</button>
      </div>
    </div>
  `);

  document.querySelectorAll('.day-item').forEach((el) => {
    el.addEventListener('click', () => {
      const item = items[Number(el.dataset.idx)];
      if (item.kind === 'task') openTaskModal(item.data.id);
      else if (item.kind === 'post') openPostDetail(item.data.id);
      else openEventModal(item.data.id);
    });
  });
  $('day-add-task').addEventListener('click', () => openTaskModal(null, { dueDate: dateStr }));
  $('day-add-event').addEventListener('click', () => openEventModal(null, { date: dateStr }));
}

$('new-event-btn').addEventListener('click', () => openEventModal(null, { date: todayStr() }));

function openEventModal(eventId, prefill) {
  const ev = eventId ? eventsMap.get(eventId) : null;
  const pre = prefill || {};
  const isNew = !ev;
  const canEdit = isNew || !ev.isPrivate || ev.ownerUid === me.uid;
  openModal(isNew ? '新規作成' : '予定の編集', `
    ${isNew ? typeSwitchHtml('event') : ''}
    <div class="form-group">
      <label>タイトル</label>
      <input type="text" id="event-title" value="${ev ? esc(ev.title) : esc(pre.title || '')}" placeholder="例）定例ミーティング">
    </div>
    <div class="form-group">
      <label>内容・詳細（任意）</label>
      <textarea id="event-memo" rows="3">${ev ? esc(ev.memo || '') : esc(pre.memo || '')}</textarea>
    </div>
    ${periodFieldsHtml(
      ev ? ev.date : (pre.date || todayStr()),
      ev ? (ev.endDate || '') : (pre.endDate || ''),
      '開始日', '終了日（任意）'
    )}
    <div class="form-group" style="max-width:180px">
      <label>時刻（任意）</label>
      <input type="time" id="event-time" value="${ev ? (ev.time || '') : (pre.time || '')}">
    </div>
    ${participantsFieldHtml(ev ? (ev.participantUids || []) : (pre.participantUids || []))}
    <label class="form-check">
      <input type="checkbox" id="event-private" ${(ev ? ev.isPrivate : pre.isPrivate) ? 'checked' : ''}>
      🔒 プライベート（自分にのみ表示）
    </label>
    ${!isNew ? translateBarHtml() : ''}
    <div class="modal-actions">
      ${!isNew && canEdit ? '<button class="btn btn-sm btn-danger" id="event-delete">削除</button>' : '<span></span>'}
      <div class="right">
        <button class="btn" id="event-cancel">キャンセル</button>
        ${canEdit ? `<button class="btn btn-primary" id="event-save">${isNew ? '追加する' : '保存する'}</button>` : ''}
      </div>
    </div>
  `);

  if (!isNew) setupTranslateBar(() => [$('event-title').value, $('event-memo').value]);

  // 種類切替: 入力途中の内容を引き継いでタスクモーダルへ
  if (isNew) {
    $('type-task').addEventListener('click', () => {
      const p = collectParticipants();
      openTaskModal(null, {
        title: $('event-title').value,
        detail: $('event-memo').value,
        startDate: $('item-start').value || '',
        dueDate: $('item-end').value || $('item-start').value || '',
        participantUids: p.uids,
        isPrivate: $('event-private').checked
      });
    });
  }

  $('event-cancel').addEventListener('click', closeModal);

  if (canEdit) {
    $('event-save').addEventListener('click', async () => {
      const title = $('event-title').value.trim();
      const date = $('item-start').value;
      if (!title || !date) { toast('タイトルと開始日を入力してください'); return; }
      const endDate = $('item-end').value || null;
      if (endDate && endDate < date) { toast('終了日は開始日以降にしてください'); return; }
      const p = collectParticipants();
      const isPrivate = $('event-private').checked;
      if (isPrivate && p.uids.some((u) => u !== me.uid)) {
        toast('プライベートの予定には参加者を設定できません');
        return;
      }
      const data = {
        title,
        date,
        endDate,
        time: $('event-time').value || '',
        memo: $('event-memo').value.trim(),
        participantUids: p.uids,
        participantNames: p.names,
        isPrivate,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (isNew) {
        data.ownerUid = me.uid;
        data.ownerName = myProfile.name;
        data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('events').add(data);
        toast('予定を追加しました');
      } else {
        await db.collection('events').doc(eventId).update(data);
        toast('保存しました');
      }
      closeModal();
    });
  }

  if (!isNew && canEdit) {
    $('event-delete').addEventListener('click', async () => {
      if (!confirm('この予定を削除しますか？')) return;
      await db.collection('events').doc(eventId).delete();
      closeModal();
      toast('削除しました');
    });
  }
}
