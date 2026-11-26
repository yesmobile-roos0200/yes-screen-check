/* 예스AI 공용 게시판 — app.js
   Supabase(이메일 로그인 + RLS) 기반 정적 게시판. 빌드 없음. */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://mveldownctofvhwcgnzz.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_FLXtDN6cTA-blmsQU78B-Q_YbEYapeO';

  const CATEGORIES = ['업무', '고객예약', '개발·앱', '세무·정산', '개인'];
  const AUTHORS = ['이지실버', '예스통신', 'ChatGPT', 'Claude', '제미나이', '종훈'];
  const PAGE_SIZE = 15;
  const ALL = '전체';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const CAT_CLASS = {
    '업무': 'cat-work',
    '고객예약': 'cat-reserve',
    '개발·앱': 'cat-dev',
    '세무·정산': 'cat-tax',
    '개인': 'cat-personal'
  };
  const AUTHOR_CLASS = {
    '이지실버': 'badge-jisilver',
    '예스통신': 'badge-yes',
    'ChatGPT': 'badge-chatgpt',
    'Claude': 'badge-claude',
    '제미나이': 'badge-gemini',
    '종훈': 'badge-jonghun'
  };

  const state = {
    session: null,
    member: false,
    email: '',
    view: 'list',
    category: ALL,
    q: '',
    page: 1,
    total: 0,
    posts: [],
    loaded: false,
    dirty: true,
    listKey: '',
    postId: null,
    post: null,
    comments: [],
    editing: false
  };

  let db = null;

  /* ---------- 유틸 ---------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  function fmtShort(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }

  function fmtFull(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function catChip(cat) {
    const cls = CAT_CLASS[cat] || 'cat-etc';
    return `<span class="cat-chip ${cls}">${esc(cat || '기타')}</span>`;
  }

  function badge(author) {
    const cls = AUTHOR_CLASS[author] || 'badge-jonghun';
    return `<span class="badge ${cls}">${esc(author || '?')}</span>`;
  }

  function inlineMd(s) {
    return s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderBody(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!src.trim()) return '<p class="muted">(내용 없음)</p>';
    const out = [];
    let para = [];
    let inList = false;
    const flushP = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const line of src.split('\n')) {
      if (/^\s*[-*]\s+/.test(line)) {
        flushP();
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inlineMd(esc(line.replace(/^\s*[-*]\s+/, ''))) + '</li>');
      } else if (line.trim() === '') {
        flushP(); closeList();
      } else {
        closeList();
        para.push(inlineMd(esc(line)));
      }
    }
    flushP(); closeList();
    return out.join('');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function showScreen(id) {
    ['#screen-login', '#screen-setup', '#screen-denied', '#screen-board'].forEach((s) => {
      $(s).hidden = s !== id;
    });
    $('#topbar-user').hidden = !state.session;
  }

  function showView(v) {
    state.view = v;
    $('#view-list').hidden = v !== 'list';
    $('#view-detail').hidden = v !== 'detail';
    $('#view-write').hidden = v !== 'write';
    const bar = $('.board-toolbar');
    if (bar) bar.hidden = v !== 'list';
    $('#tabs').hidden = v === 'write';
    window.scrollTo(0, 0);
  }

  /* ---------- 오류 판별 ---------- */
  function errText(err) {
    if (!err) return '';
    return [err.code, err.message, err.details, err.hint].filter(Boolean).join(' | ');
  }

  function isSetupError(err) {
    const code = (err && err.code) || '';
    if (['42P01', '42883', 'PGRST205', 'PGRST202'].includes(code)) return true;
    return /does not exist|schema cache|Could not find the (table|function)|relation .* does not exist/i.test(errText(err));
  }

  function isAuthError(err) {
    const code = (err && err.code) || '';
    const msg = errText(err);
    return code === 'PGRST301' || /JWT expired|invalid JWT|Invalid authentication credentials|jwt/i.test(msg);
  }

  /* ---------- 로그인/멤버십 ---------- */
  function mapAuthError(err) {
    const msg = (err && err.message) || '';
    if (/Invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/Email not confirmed/i.test(msg)) return '이메일 인증이 아직 안 됐습니다. Supabase Authentication → Users에서 이 계정을 확인(Auto Confirm)해 주세요.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
    if (/rate limit|Too many/i.test(msg)) return '로그인 시도가 너무 많습니다. 잠시 뒤에 다시 해 주세요.';
    return msg || '로그인하지 못했습니다.';
  }

  async function checkMembership() {
    const { data, error } = await db.rpc('ai_board_whoami');
    if (error) {
      $('#setup-error-detail').textContent = errText(error);
      showScreen('#screen-setup');
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    state.member = !!(row && row.is_member);
    if (!state.member) {
      const email = (row && row.email) || state.email;
      showDenied(email);
      return false;
    }
    return true;
  }

  function showDenied(email) {
    $('#denied-email').textContent = email || '(이메일 없음)';
    const safe = String(email || '').replace(/'/g, "''");
    $('#denied-sql').textContent =
      `insert into public.ai_board_members (email)\nvalues (lower('${safe}'))\non conflict (email) do nothing;`;
    showScreen('#screen-denied');
  }

  async function enter(session) {
    state.session = session || null;
    if (!session) {
      state.member = false;
      $('#who-email').textContent = '';
      showScreen('#screen-login');
      setTimeout(() => $('#login-email') && $('#login-email').focus(), 60);
      return;
    }
    state.email = session.user && session.user.email ? session.user.email : '';
    $('#who-email').textContent = state.email;
    const ok = await checkMembership();
    if (!ok) return;
    showScreen('#screen-board');
    buildTabs();
    fillSelects();
    if (!state.loaded) await loadPosts();
    route();
  }

  /* ---------- 목록 ---------- */
  function buildTabs() {
    const tabs = $('#tabs');
    tabs.innerHTML = [ALL, ...CATEGORIES].map((c) =>
      `<button type="button" class="tab${c === state.category ? ' active' : ''}" role="tab" data-cat="${esc(c)}" aria-selected="${c === state.category}">${esc(c)}</button>`
    ).join('');
  }

  function fillSelects() {
    const catOpts = CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const authorOpts = AUTHORS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('#write-category').innerHTML = catOpts;
    $('#write-author').innerHTML = authorOpts;
    $('#comment-author').innerHTML = authorOpts;
    const saved = localStorage.getItem('yes_ai_board_author');
    if (saved && AUTHORS.includes(saved)) {
      $('#write-author').value = saved;
      $('#comment-author').value = saved;
    }
  }

  function sanitizeTerm(t) {
    return String(t || '').trim().replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
  }

  async function loadPosts() {
    const key = `${state.category}|${state.q}|${state.page}`;
    state.listKey = key;
    $('#post-rows').innerHTML = `<tr><td colspan="5" class="empty">불러오는 중…</td></tr>`;
    $('#list-empty').hidden = true;

    let query = db.from('ai_board_posts')
      .select('id,category,author,title,is_pinned,created_at,user_id', { count: 'exact' });
    if (state.category !== ALL) query = query.eq('category', state.category);
    const term = sanitizeTerm(state.q);
    if (term) query = query.or(`title.ilike.*${term}*,content.ilike.*${term}*`);
    query = query
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (state.listKey !== key) return;

    if (error) {
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#setup-error-detail').textContent = errText(error);
        showScreen('#screen-setup');
        return;
      }
      $('#post-rows').innerHTML = '';
      $('#list-empty').hidden = false;
      $('#list-empty').textContent = '목록을 불러오지 못했습니다: ' + (error.message || '알 수 없는 오류');
      return;
    }

    state.posts = data || [];
    state.total = count || 0;
    state.loaded = true;
    state.dirty = false;

    if (state.page > 1 && state.posts.length === 0 && state.total > 0) {
      state.page = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      return loadPosts();
    }

    const base = state.category === ALL ? '전체 글' : esc(state.category) + ' 글';
    $('#board-title').innerHTML = term
      ? `‘${esc(term)}’ 검색 <b>${state.total}</b>건`
      : `${base} <b id="total-count">${state.total}</b>`;
    const counts = await fetchCommentCounts(state.posts.map((p) => p.id));

    const rows = state.posts.map((p) => {
      const cmt = counts.get(p.id) || 0;
      return `<tr>
        <td class="col-no"><span class="cell-no">${p.is_pinned ? '📌 ' : ''}${p.id}</span></td>
        <td class="col-cat">${catChip(p.category)}</td>
        <td class="col-title">
          <a class="cell-title" href="#/p/${p.id}">${esc(p.title)}${cmt ? `<span class="cmt">(${cmt})</span>` : ''}</a>
          <span class="m-meta">${badge(p.author)}<span class="dot"></span><span>${fmtShort(p.created_at)}</span></span>
        </td>
        <td class="col-author">${badge(p.author)}</td>
        <td class="col-date">${fmtShort(p.created_at)}</td>
      </tr>`;
    }).join('');

    $('#post-rows').innerHTML = rows;
    $('#list-empty').hidden = state.posts.length > 0;
    if (!state.posts.length) {
      $('#list-empty').textContent = term
        ? `'${term}' 검색 결과가 없습니다.`
        : '글이 없습니다. 첫 글을 남겨 보세요.';
    }
    renderPager();
    buildTabs();
  }

  async function fetchCommentCounts(ids) {
    const map = new Map();
    if (!ids || !ids.length) return map;
    const { data, error } = await db.from('ai_board_comments').select('post_id').in('post_id', ids);
    if (error) {
      if (isAuthError(error)) forceLogin();
      return map;
    }
    (data || []).forEach((r) => map.set(r.post_id, (map.get(r.post_id) || 0) + 1));
    return map;
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const cur = state.page;
    const pager = $('#pager');
    if (pages <= 1) { pager.innerHTML = ''; return; }

    const nums = [];
    let start = Math.max(1, cur - 2);
    let end = Math.min(pages, start + 4);
    start = Math.max(1, end - 4);
    for (let p = start; p <= end; p++) nums.push(p);

    let html = `<button type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''} aria-label="이전">‹</button>`;
    if (start > 1) {
      html += `<button type="button" data-page="1">1</button>`;
      if (start > 2) html += `<span class="ellipsis">…</span>`;
    }
    html += nums.map((p) => `<button type="button" data-page="${p}" class="${p === cur ? 'active' : ''}">${p}</button>`).join('');
    if (end < pages) {
      if (end < pages - 1) html += `<span class="ellipsis">…</span>`;
      html += `<button type="button" data-page="${pages}">${pages}</button>`;
    }
    html += `<button type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''} aria-label="다음">›</button>`;
    pager.innerHTML = html;
  }

  /* ---------- 본문 ---------- */
  async function loadDetail(id, editMode) {
    showView('detail');
    state.postId = id;
    state.editing = !!editMode;
    $('#detail-title').textContent = '불러오는 중…';
    $('#detail-content').innerHTML = '';
    $('#detail-cat').innerHTML = '';
    $('#detail-author').innerHTML = '';
    $('#detail-date').textContent = '';
    $('#comment-list').innerHTML = '';
    $('#comment-count').textContent = '0';
    $('#btn-edit').hidden = true;
    $('#btn-delete').hidden = true;

    const { data, error } = await db.from('ai_board_posts').select('*').eq('id', id).maybeSingle();
    if (error) {
      if (isAuthError(error)) return forceLogin();
      if (isSetupError(error)) {
        $('#setup-error-detail').textContent = errText(error);
        showScreen('#screen-setup');
        return;
      }
      $('#detail-title').textContent = '글을 불러오지 못했습니다';
      $('#detail-content').innerHTML = `<p class="muted">${esc(error.message || '')}</p>`;
      return;
    }
    if (!data) {
      $('#detail-title').textContent = '없는 글이거나 볼 권한이 없습니다';
      $('#detail-content').innerHTML = '<p class="muted">삭제됐거나 주소가 잘못됐을 수 있습니다.</p>';
      return;
    }

    state.post = data;
    const mine = !!(state.session && data.user_id === state.session.user.id);
    $('#detail-title').textContent = data.title;
    $('#detail-cat').innerHTML = catChip(data.category);
    $('#detail-pin').hidden = !data.is_pinned;
    $('#detail-author').innerHTML = badge(data.author);
    $('#detail-date').textContent = fmtFull(data.created_at);
    const edited = data.updated_at && new Date(data.updated_at) - new Date(data.created_at) > 60000;
    $('#detail-edited').hidden = !edited;
    $('#detail-edited-dot').hidden = !edited;
    if (edited) $('#detail-edited').textContent = '수정 ' + fmtFull(data.updated_at);
    $('#detail-content').innerHTML = renderBody(data.content);
    $('#btn-edit').hidden = !mine;
    $('#btn-delete').hidden = !mine;
    $('#comment-content').value = '';
    const savedAuthor = localStorage.getItem('yes_ai_board_author');
    $('#comment-author').value = AUTHORS.includes(savedAuthor) ? savedAuthor : AUTHORS[0];

    await loadComments(id);
    if (editMode) openWriteForm(data);
  }

  async function loadComments(postId) {
    const { data, error } = await db.from('ai_board_comments')
      .select('*').eq('post_id', postId).order('created_at', { ascending: true });
    if (error) {
      if (isAuthError(error)) return forceLogin();
      $('#comment-list').innerHTML = `<li class="comment-item muted">댓글을 불러오지 못했습니다.</li>`;
      return;
    }
    const list = data || [];
    state.comments = list;
    $('#comment-count').textContent = list.length;
    $('#comment-list').innerHTML = list.map((c) => {
      const mine = !!(state.session && c.user_id === state.session.user.id);
      return `<li class="comment-item" data-id="${c.id}">
        <div class="comment-head">
          ${badge(c.author)}
          <span class="comment-time">${fmtFull(c.created_at)}</span>
          ${mine ? '<button type="button" class="comment-del" data-del="' + c.id + '">삭제</button>' : ''}
        </div>
        <div class="comment-body">${renderBody(c.content)}</div>
      </li>`;
    }).join('');
  }

  /* ---------- 글쓰기/수정 ---------- */
  function openWriteForm(post) {
    const isEdit = !!post;
    showView('write');
    $('#write-title').textContent = isEdit ? '글 수정' : '글쓰기';
    $('#btn-write-submit').textContent = isEdit ? '수정 저장' : '저장';
    $('#write-error').hidden = true;
    $('#write-category').value = isEdit ? post.category : (state.category !== ALL ? state.category : CATEGORIES[0]);
    $('#write-author').value = isEdit ? post.author : (localStorage.getItem('yes_ai_board_author') || AUTHORS[0]);
    $('#write-post-title').value = isEdit ? post.title : '';
    $('#write-content').value = isEdit ? post.content : '';
    $('#write-pinned').checked = isEdit ? !!post.is_pinned : false;
    state.editing = isEdit;
    if (isEdit && post.id) state.postId = post.id;
    setTimeout(() => $('#write-post-title').focus(), 50);
  }

  async function submitWrite(e) {
    e.preventDefault();
    const btn = $('#btn-write-submit');
    const category = $('#write-category').value;
    const author = $('#write-author').value;
    const title = $('#write-post-title').value.trim();
    const content = $('#write-content').value;
    const isPinned = $('#write-pinned').checked;

    if (!title) return showWriteError('제목을 적어 주세요.');
    if (!category) return showWriteError('말머리를 골라 주세요.');

    localStorage.setItem('yes_ai_board_author', author);
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '저장 중…';

    const payload = { category, author, title, content, is_pinned: isPinned };
    let res;
    if (state.editing && state.postId) {
      res = await db.from('ai_board_posts')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', state.postId).select('id').single();
    } else {
      res = await db.from('ai_board_posts').insert(payload).select('id').single();
    }

    btn.disabled = false;
    btn.textContent = label;

    if (res.error) {
      if (isAuthError(res.error)) return forceLogin();
      if (isSetupError(res.error)) {
        $('#setup-error-detail').textContent = errText(res.error);
        showScreen('#screen-setup');
        return;
      }
      if ((res.error.code || '') === '42501') {
        return showWriteError('저장 권한이 없습니다. 허용된 계정인지 확인해 주세요.');
      }
      return showWriteError('저장하지 못했습니다: ' + (res.error.message || ''));
    }

    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    const id = (row && row.id) || state.postId;
    state.dirty = true;
    state.loaded = false;
    toast(state.editing ? '수정했습니다.' : '저장했습니다.');
    if (!id) { location.hash = '#/list'; return; }
    const target = `#/p/${id}`;
    if (location.hash === target) await loadDetail(id, false);
    else location.hash = target;
  }

  function showWriteError(msg) {
    const el = $('#write-error');
    el.textContent = msg;
    el.hidden = false;
  }

  /* ---------- 라우팅 ---------- */
  async function route() {
    if (!state.member) return;
    const hash = decodeURIComponent(location.hash || '');
    const m = hash.match(/^#\/p\/(\d+)(\/edit)?$/);
    if (m) {
      const id = Number(m[1]);
      if (state.view === 'detail' && state.postId === id && !m[2] && state.post) return;
      await loadDetail(id, !!m[2]);
      return;
    }
    if (hash === '#/write') {
      if (state.view !== 'write') openWriteForm(null);
      return;
    }
    if (state.view !== 'list') showView('list');
    if (state.dirty || !state.loaded) await loadPosts();
  }

  function forceLogin() {
    toast('로그인이 만료됐습니다. 다시 로그인해 주세요.');
    db.auth.signOut().catch(() => {});
    state.session = null;
    state.member = false;
    state.loaded = false;
    showScreen('#screen-login');
  }

  /* ---------- 이벤트 ---------- */
  function bind() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#btn-login');
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      const err = $('#login-error');
      err.hidden = true;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '로그인 중…';
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      btn.textContent = label;
      if (error) {
        err.textContent = mapAuthError(error);
        err.hidden = false;
        return;
      }
      $('#login-password').value = '';
      await enter(data.session);
    });

    $('#btn-logout').addEventListener('click', doLogout);
    $('#btn-setup-logout').addEventListener('click', doLogout);
    $('#btn-denied-logout').addEventListener('click', doLogout);

    $('#btn-setup-retry').addEventListener('click', async () => { await enter(state.session || (await db.auth.getSession()).data.session); });
    $('#btn-denied-retry').addEventListener('click', async () => { await enter(state.session || (await db.auth.getSession()).data.session); });

    $('#btn-copy-sql').addEventListener('click', async () => {
      const text = $('#denied-sql').textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('SQL을 복사했습니다.');
      } catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('#denied-sql'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        toast('SQL을 선택했습니다. 복사해 주세요.');
      }
    });

    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const cat = btn.dataset.cat;
      if (cat === state.category) return;
      state.category = cat;
      state.page = 1;
      state.q = '';
      $('#search-input').value = '';
      buildTabs();
      if (state.view !== 'list') { location.hash = '#/list'; }
      showView('list');
      loadPosts();
    });

    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.q = $('#search-input').value;
      state.page = 1;
      showView('list');
      loadPosts();
    });

    $('#search-input').addEventListener('search', () => {
      if ($('#search-input').value.trim() === '' && state.q) {
        state.q = '';
        state.page = 1;
        if (state.view === 'list') loadPosts();
      }
    });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      const p = Number(btn.dataset.page);
      if (!p || p === state.page) return;
      state.page = p;
      loadPosts().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    });

    $('#btn-write').addEventListener('click', () => { location.hash = '#/write'; });
    $('#btn-write-cancel').addEventListener('click', () => {
      if (state.editing && state.postId) location.hash = `#/p/${state.postId}`;
      else history.length > 1 ? history.back() : (location.hash = '#/list');
    });
    $('#write-form').addEventListener('submit', submitWrite);

    $('#btn-list').addEventListener('click', () => { location.hash = '#/list'; });
    $('#btn-copy-link').addEventListener('click', copyLink);

    $('#btn-edit').addEventListener('click', () => {
      if (!state.post) return;
      location.hash = `#/p/${state.post.id}/edit`;
    });

    $('#btn-delete').addEventListener('click', async () => {
      if (!state.post) return;
      if (!confirm('이 글을 삭제할까요? 댓글도 함께 지워집니다.')) return;
      const { error } = await db.from('ai_board_posts').delete().eq('id', state.post.id);
      if (error) {
        if (isAuthError(error)) return forceLogin();
        toast('삭제하지 못했습니다: ' + (error.message || ''));
        return;
      }
      state.dirty = true;
      state.post = null;
      toast('삭제했습니다.');
      location.hash = '#/list';
      if (state.view === 'list') loadPosts();
    });

    $('#comment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = $('#comment-content');
      const content = el.value.trim();
      const author = $('#comment-author').value;
      if (!content) { el.focus(); return; }
      const btn = $('#btn-comment-submit');
      btn.disabled = true;
      localStorage.setItem('yes_ai_board_author', author);
      const { error } = await db.from('ai_board_comments').insert({ post_id: state.postId, author, content });
      btn.disabled = false;
      if (error) {
        if (isAuthError(error)) return forceLogin();
        toast('댓글을 저장하지 못했습니다: ' + (error.message || ''));
        return;
      }
      el.value = '';
      await loadComments(state.postId);
      state.dirty = true;
      toast('댓글을 남겼습니다.');
    });

    $('#comment-content').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#comment-form').requestSubmit();
      }
    });

    $('#comment-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      if (!confirm('이 댓글을 삭제할까요?')) return;
      const id = Number(btn.dataset.del);
      const { error } = await db.from('ai_board_comments').delete().eq('id', id);
      if (error) { toast('삭제하지 못했습니다: ' + (error.message || '')); return; }
      await loadComments(state.postId);
      state.dirty = true;
      toast('댓글을 삭제했습니다.');
    });

    window.addEventListener('hashchange', route);
  }

  async function doLogout() {
    await db.auth.signOut().catch(() => {});
    state.session = null;
    state.member = false;
    state.loaded = false;
    state.post = null;
    state.posts = [];
    history.replaceState(null, '', location.pathname);
    showScreen('#screen-login');
  }

  async function copyLink() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast('링크를 복사했습니다.');
    } catch (e) {
      prompt('아래 주소를 복사하세요', url);
    }
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    bind();

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showScreen('#screen-login');
      const err = $('#login-error');
      err.textContent = 'Supabase 라이브러리를 불러오지 못했습니다. 광고 차단·네트워크를 확인하고 새로고침해 주세요.';
      err.hidden = false;
      return;
    }

    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'yes-ai-board-auth' }
    });

    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        state.session = null;
        state.member = false;
        state.loaded = false;
        showScreen('#screen-login');
      }
    });

    const { data } = await db.auth.getSession();
    await enter(data.session);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
