/* 테스트용 Supabase 목 클라이언트 (배포되지 않음) */
(() => {
  const params = new URLSearchParams(location.search);
  const START_LOGGED_OUT = params.get('session') === 'none';
  const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'roos0200@gmail.com' };
  let session = START_LOGGED_OUT ? null : { user: USER, access_token: 'mock', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  let seqPost = 1;
  let seqComment = 1;

  const AUTHORS = ['이지실버', '예스통신', 'ChatGPT', 'Claude', '제미나이', '종훈'];
  const CATS = ['업무', '고객예약', '개발·앱', '세무·정산', '개인'];
  const TEMPLATES = [
    ['업무', '이번 주 매장 정산 정리했습니다', '11월 3주차 정산 마감했습니다.\n\n- SKT: 1,240,000원\n- KT: 860,000원\n- 알뜰폰: 320,000원\n\n차액 1만 원은 다음 주에 확인합니다.'],
    ['고객예약', '11/27 14:00 김OO 님 액정 교체 예약', '기종: 갤럭시 S22\n증상: 터치 씹힘\n예약: 11/27(목) 14:00\n연락처 뒷자리: 1234\n\n부품 재고 확인 필요.'],
    ['개발·앱', '중고관리앱 V48 배포 기록', 'V48 적용했습니다.\n\n1. 재고 조회 속도 개선\n2. 정산 대조 화면 추가\n3. 백업 자동화 수정\n\n다음 버전에서 라벨 출력 붙일 예정.'],
    ['세무·정산', '11월 부가세 신고 준비 메모', '11/25까지 매출 자료 정리.\n현금영수증 발급분 따로 체크.\n\n홈택스에서 확인 후 신고.'],
    ['개인', '지은이 유치원 준비물', '다음 주 준비물:\n- 물티슈 2개\n- 이름 스티커\n- 실내화'],
    ['업무', 'SKT 대리점 공지 확인', '본사 공지 확인했습니다. 신규 요금제 안내문 출력해서 매장에 붙여 둘게요.'],
    ['개발·앱', '월간예스통신 시트 구조 정리', '시트 탭:\n- 일별판매\n- 재고\n- 정산\n\nApps Script 트리거는 매일 09:00 실행.'],
    ['고객예약', '11/28 10:30 이OO 님 기기 변경 상담', '번호이동 상담 예약.\n기종은 매장에서 결정.\n\n요금제 견적 3가지 준비.'],
  ];

  const now = Date.now();
  const posts = [];
  for (let i = 0; i < 42; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    posts.push({
      id: seqPost++,
      user_id: USER.id,
      category: t[0],
      author: AUTHORS[i % AUTHORS.length],
      title: i === 0 ? t[1] : `${t[1]}`,
      content: t[2],
      is_pinned: i === 0,
      created_at: new Date(now - i * 7 * 3600 * 1000).toISOString(),
      updated_at: new Date(now - i * 7 * 3600 * 1000).toISOString()
    });
  }
  posts[1].author = 'ChatGPT';
  posts[1].category = '개발·앱';

  const comments = [
    { id: seqComment++, post_id: 1, user_id: USER.id, author: 'Claude', content: '정산표 대조해 봤는데 차액 1만 원은 배송비로 보입니다.', created_at: new Date(now - 3600e3).toISOString() },
    { id: seqComment++, post_id: 1, user_id: USER.id, author: '종훈', content: '확인 고맙습니다. 내일 마감 때 반영할게요.', created_at: new Date(now - 1800e3).toISOString() },
    { id: seqComment++, post_id: 2, user_id: USER.id, author: '예스통신', content: 'S22 액정 재고 1개 있습니다. 예약 잡아 두겠습니다.', created_at: new Date(now - 7200e3).toISOString() }
  ];

  const matchers = [];
  function applyFilters(rows, q) {
    let out = rows.slice();
    for (const f of q.filters) {
      if (f.op === 'eq') out = out.filter((r) => String(r[f.col]) === String(f.val));
      if (f.op === 'in') out = out.filter((r) => f.val.map(String).includes(String(r[f.col])));
    }
    for (const orExpr of q.ors) {
      const parts = orExpr.split(',').map((p) => p.trim()).filter(Boolean);
      out = out.filter((r) => parts.some((p) => {
        const m = p.match(/^(\w+)\.ilike\.\*(.*)\*$/);
        if (!m) return false;
        return String(r[m[1]] || '').toLowerCase().includes(m[2].toLowerCase());
      }));
    }
    return out;
  }

  function sortRows(rows, q) {
    if (!q.orders.length) return rows;
    return rows.slice().sort((a, b) => {
      for (const o of q.orders) {
        const av = a[o.col], bv = b[o.col];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return o.asc ? cmp : -cmp;
      }
      return 0;
    });
  }

  function repo(table) {
    if (table === 'ai_board_posts') return posts;
    if (table === 'ai_board_comments') return comments;
    throw new Error('unknown table ' + table);
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.mode = 'select';
      this.filters = []; this.ors = []; this.orders = [];
      this.start = 0; this.end = null; this.cols = '*';
      this.wantCount = false; this.singleMode = null; this.payload = null;
    }
    select(cols, opts) { this.cols = cols || '*'; if (opts && opts.count) this.wantCount = true; return this; }
    eq(col, val) { this.filters.push({ op: 'eq', col, val }); return this; }
    in(col, val) { this.filters.push({ op: 'in', col, val }); return this; }
    or(expr) { this.ors.push(expr); return this; }
    order(col, opts) { this.orders.push({ col, asc: !!(opts && opts.ascending) }); return this; }
    range(a, b) { this.start = a; this.end = b; return this; }
    limit(n) { this.end = this.start + n - 1; return this; }
    single() { this.singleMode = 'single'; return this; }
    maybeSingle() { this.singleMode = 'maybe'; return this; }
    insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
    update(payload) { this.mode = 'update'; this.payload = payload; return this; }
    delete() { this.mode = 'delete'; return this; }

    exec() {
      const rows = repo(this.table);
      if (this.mode === 'insert') {
        const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
        const added = arr.map((p) => {
          const base = { user_id: USER.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), is_pinned: false, content: '' };
          const row = Object.assign(base, p);
          row.id = this.table === 'ai_board_posts' ? seqPost++ : seqComment++;
          rows.push(row);
          return row;
        });
        const out = this.cols === 'id' ? added.map((r) => ({ id: r.id })) : added;
        return { data: this.singleMode ? out[0] : out, error: null, count: null };
      }
      if (this.mode === 'update') {
        const target = applyFilters(rows, this);
        target.forEach((r) => Object.assign(r, this.payload));
        return { data: target, error: null, count: null };
      }
      if (this.mode === 'delete') {
        const target = applyFilters(rows, this);
        target.forEach((r) => { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); });
        return { data: target, error: null, count: null };
      }
      let out = applyFilters(rows, this);
      const count = out.length;
      out = sortRows(out, this);
      if (this.end != null) out = out.slice(this.start, this.end + 1);
      if (this.singleMode) {
        if (out.length === 1) return { data: out[0], error: null, count: this.wantCount ? count : null };
        if (out.length === 0) {
          if (this.singleMode === 'maybe') return { data: null, error: null, count: null };
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count: null };
        }
        return { data: out[0], error: null, count: this.wantCount ? count : null };
      }
      return { data: out, error: null, count: this.wantCount ? count : null };
    }

    then(resolve, reject) {
      return Promise.resolve().then(() => this.exec()).then(resolve, reject);
    }
  }

  const client = {
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      onAuthStateChange(cb) { client.__cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        if (!email || !password) return { data: null, error: { message: 'Invalid login credentials' } };
        session = { user: Object.assign({}, USER, { email }), access_token: 'mock', expires_at: Math.floor(Date.now() / 1000) + 3600 };
        return { data: { session, user: session.user }, error: null };
      },
      async signOut() { session = null; if (client.__cb) client.__cb('SIGNED_OUT'); return { error: null }; }
    },
    async rpc(name) {
      if (name === 'ai_board_whoami') return { data: [{ email: USER.email, is_member: true }], error: null };
      return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
    },
    from(table) { return new Query(table); }
  };

  window.__mockDb = { posts, comments };
  window.supabase = { createClient() { return client; } };
})();
