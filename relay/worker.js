/* =====================================================================
   위치공유(myWhere) 실시간 그룹 릴레이 — Cloudflare Worker
   ---------------------------------------------------------------------
   계약(앱과 일치):
     POST /u   body={g,m,n,lat,lng,t,acc,bear,spd}   → 내 위치 업로드(15분 후 자동 만료)
     GET  /g?g={group}                                → {members:[{m,n,lat,lng,t,...}]}

   저장소: Cloudflare KV (네임스페이스 바인딩 이름 = MYWHERE)
   인증 없음 — '그룹 코드'가 공유 비밀번호 역할이니, 추측하기 어려운 코드를 쓰세요.
   배포 방법은 같은 폴더의 README.md 참고.
   ===================================================================== */

const TTL_SEC = 900;          // 15분 동안만 보관
const FRESH_MS = 600000;      // 조회 시 최근 10분 이내만 노출

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!env.MYWHERE) {
      return json({ error: 'KV 바인딩(MYWHERE)이 설정되지 않았습니다' }, 500);
    }

    // 위치 업로드 (평문 또는 암호문 c 를 그대로 통과)
    if (url.pathname === '/u' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const g = String(body.g || '').trim();
      const m = String(body.m || '').trim();
      if (!g || !m) return json({ error: 'g, m 필요' }, 400);

      // g 를 제외한 나머지 필드를 그대로 저장 (c=암호문 또는 평문 lat/lng/...)
      const rec = {};
      for (const k of Object.keys(body)) { if (k !== 'g') rec[k] = body[k]; }
      rec.m = m;
      rec._r = Date.now();   // 서버 수신 시각(만료 판단용)

      const key = `g:${g}:m:${m}`;
      await env.MYWHERE.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC });
      return json({ ok: true });
    }

    // 그룹 조회
    if (url.pathname === '/g' && request.method === 'GET') {
      const g = String(url.searchParams.get('g') || '').trim();
      if (!g) return json({ members: [] });

      const prefix = `g:${g}:m:`;
      const list = await env.MYWHERE.list({ prefix, limit: 100 });
      const members = [];
      const cutoff = Date.now() - FRESH_MS;
      for (const k of list.keys) {
        const v = await env.MYWHERE.get(k.name);
        if (!v) continue;
        try {
          const r = JSON.parse(v);
          if ((r._r || 0) >= cutoff) { delete r._r; members.push(r); }
        } catch (e) {}
      }
      return json({ members });
    }

    if (url.pathname === '/' ) {
      return json({ ok: true, service: 'myWhere relay', endpoints: ['POST /u', 'GET /g?g=CODE'] });
    }

    return json({ error: 'not found' }, 404);
  },
};
