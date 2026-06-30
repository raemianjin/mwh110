/* =====================================================================
   myWhere — app.js  (v1.1.0)
   가족 텔레메트리: 실시간 위치 + 시간 스크러버 궤적 재생 + 다중 베이스맵.
   - 코덱: MYWHERE1: + base64url(JSON)
   - 페어링: MYWHEREKEY1: (QR / 직접입력), 위치는 종단간 암호화(네이티브)
   - 지도: Leaflet (다크 / 위성 / 기본 전환), 타임라인 재생
   - 브리지 계약(메서드/콜백명)은 이전 버전과 동일하게 유지
   영찬영하 Daddy · J패밀리
   ===================================================================== */
(function () {
  'use strict';

  var B = window.Bridge || {};
  function has(fn) { return B && typeof B[fn] === 'function'; }

  var pending = {};
  var reqSeq = 0;
  function nextId(tag) { reqSeq += 1; return tag + '_' + reqSeq + '_' + Date.now(); }
  function resolve(id, val) {
    var cb = pending[id];
    if (cb) { delete pending[id]; try { cb(val); } catch (e) {} }
  }

  var $ = function (id) { return document.getElementById(id); };
  function toast(m) { if (has('toast')) B.toast(m); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function show(el, v) { if (el) el.style.display = v ? '' : 'none'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ms) {
    var d = new Date(ms);
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtClock(ms) {
    var d = new Date(ms);
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtAgo(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + '초 전';
    var m = Math.floor(s / 60);
    if (m < 60) return m + '분 전';
    var h = Math.floor(m / 60);
    if (h < 24) return h + '시간 ' + (m % 60) + '분 전';
    return Math.floor(h / 24) + '일 전';
  }
  function distM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    var la1 = a[0] * toR, la2 = b[0] * toR;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  function bearing(a, b) {
    var toR = Math.PI / 180, toD = 180 / Math.PI;
    var la1 = a[0] * toR, la2 = b[0] * toR, dLng = (b[1] - a[1]) * toR;
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * toD + 360) % 360;
  }

  // ── base64url ──
  function b64urlEnc(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDec(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  var PREFIX = 'MYWHERE1:';

  function downsample(points, max) {
    if (points.length <= max) return points;
    var out = [], step = (points.length - 1) / (max - 1);
    for (var i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
    out.push(points[points.length - 1]);
    return out;
  }
  function encodePayload(name, points) {
    var p = downsample(points, 80).map(function (q) { return [round6(q.lat), round6(q.lng), Math.round(q.t / 1000)]; });
    return PREFIX + b64urlEnc(new TextEncoder().encode(JSON.stringify({ v: 1, n: name || '', p: p })));
  }
  function decodeAny(raw) {
    if (!raw) return null;
    var m = raw.match(/MYWHERE1:([A-Za-z0-9_\-]+)/);
    if (m) {
      try {
        var obj = JSON.parse(new TextDecoder().decode(b64urlDec(m[1])));
        if (obj && obj.p && obj.p.length) {
          var pts = obj.p.map(function (a) { return { lat: +a[0], lng: +a[1], t: (+a[2]) * 1000 }; })
                         .filter(function (q) { return isFinite(q.lat) && isFinite(q.lng); });
          if (pts.length) return { name: obj.n || '', points: pts, source: 'code' };
        }
      } catch (e) {}
    }
    var g = raw.match(/[?&](?:q|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) ||
            raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
            raw.match(/maps[^]*?(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/) ||
            raw.match(/(-?\d{1,2}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})/);
    if (g) {
      var lat = +g[1], lng = +g[2];
      if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
        return { name: '', points: [{ lat: lat, lng: lng, t: Date.now() }], source: 'link' };
    }
    return null;
  }

  // =====================================================================
  // 라인 아이콘 (이모지 미사용)
  // =====================================================================
  var ICONS = {
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    crosshair: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.5"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H14a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><line x1="14" y1="14" x2="14" y2="17"/><line x1="17" y1="14" x2="21" y2="14"/><line x1="21" y1="14" x2="21" y2="21"/><line x1="14" y1="21" x2="18" y2="21"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    satellite: '<path d="M13 7 9 3 5 7l4 4"/><path d="m17 11 4 4-4 4-4-4"/><path d="m8 12 4 4"/><path d="m16 8-4-4"/><path d="M9 15a4 4 0 0 1-4 4"/>'
  };
  function svgIcon(name) {
    var inner = ICONS[name] || ICONS.pin;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function injectIcons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
      if (el.getAttribute('data-done')) return;
      el.innerHTML = svgIcon(el.getAttribute('data-ic'));
      el.setAttribute('data-done', '1');
    });
  }

  // 마커/핑 시각 CSS 주입 (지도 위 요소)
  function injectMarkerCss() {
    var css =
      '.tl-dot{width:13px;height:13px;border-radius:50%;border:2px solid #0A0E16;box-shadow:0 0 0 1px rgba(255,255,255,.18),0 0 8px rgba(0,0,0,.5);}' +
      '.tl-ping{display:block;width:13px;height:13px;border-radius:50%;position:relative;}' +
      '.tl-ping i{position:absolute;inset:0;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);}' +
      '.tl-ping::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid var(--c);animation:tlping 1.8s ease-out infinite;}' +
      '@keyframes tlping{0%{transform:scale(.5);opacity:.85;}100%{transform:scale(2.7);opacity:0;}}' +
      '.tl-arrow{color:var(--live);filter:drop-shadow(0 0 3px rgba(0,0,0,.7));}' +
      '.tl-start{width:11px;height:11px;border-radius:50%;background:#0A0E16;border:2px solid #fff;}' +
      '.tl-lab{font-family:var(--mono);font-size:11px;font-weight:600;color:#EAEFF7;text-shadow:0 1px 4px #000;white-space:nowrap;transform:translate(11px,-24px);}' +
      '.prefers-reduced .tl-ping::after{animation:none;}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  // =====================================================================
  // 지도 + 베이스 레이어
  // =====================================================================
  try {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'leaflet/images/marker-icon-2x.png',
      iconUrl: 'leaflet/images/marker-icon.png',
      shadowUrl: 'leaflet/images/marker-shadow.png'
    });
  } catch (e) {}

  var TILES = {
    dark: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opt: { maxZoom: 20, subdomains: 'abcd', crossOrigin: true } },
    sat:  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, crossOrigin: true } },
    std:  { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { maxZoom: 19, crossOrigin: true } }
  };
  var maps = {};        // id -> L.Map
  var baseLayer = {};   // id -> current tile layer
  var baseKind = {};    // id -> 'dark'|'sat'|'std'
  var tlLayer = {};     // id -> L.layerGroup (타임라인 렌더)
  var fitted = {};      // id -> bool (최초 1회만 자동 맞춤)

  function getMap(id, center) {
    if (maps[id]) return maps[id];
    var map = L.map(id, { zoomControl: false, attributionControl: false, preferCanvas: true })
      .setView(center || [37.5665, 126.9780], 14);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    baseKind[id] = 'dark';
    baseLayer[id] = L.tileLayer(TILES.dark.url, TILES.dark.opt).addTo(map);
    maps[id] = map;
    map.on('zoomstart dragstart', function () { fitted[id] = true; }); // 사용자 조작 후 자동맞춤 중단
    return map;
  }
  function setBaseLayer(id, kind) {
    var map = maps[id]; if (!map || !TILES[kind]) return;
    if (baseLayer[id]) map.removeLayer(baseLayer[id]);
    baseLayer[id] = L.tileLayer(TILES[kind].url, TILES[kind].opt).addTo(map);
    baseLayer[id].bringToBack();
    baseKind[id] = kind;
  }
  function invalidate(id) {
    var m = maps[id];
    if (m) setTimeout(function () { try { m.invalidateSize(); } catch (e) {} }, 60);
  }
  function createLayerSwitch(mountId, mapId) {
    var mount = $(mountId); if (!mount || mount.getAttribute('data-built')) return;
    mount.setAttribute('data-built', '1');
    var defs = [['dark', '다크'], ['sat', '위성'], ['std', '기본']];
    defs.forEach(function (d) {
      var b = document.createElement('button');
      b.textContent = d[1];
      if (d[0] === (baseKind[mapId] || 'dark')) b.className = 'on';
      on(b, 'click', function () {
        setBaseLayer(mapId, d[0]);
        mount.querySelectorAll('button').forEach(function (x) { x.className = ''; });
        b.className = 'on';
      });
      mount.appendChild(b);
    });
  }

  // 마커 아이콘
  function dotIcon(color, ping) {
    if (ping) {
      return L.divIcon({ className: '', iconSize: [13, 13], iconAnchor: [7, 7],
        html: '<span class="tl-ping" style="--c:' + color + '"><i></i></span>' });
    }
    return L.divIcon({ className: '', iconSize: [13, 13], iconAnchor: [7, 7],
      html: '<span class="tl-dot" style="background:' + color + '"></span>' });
  }
  function startIcon() { return L.divIcon({ className: '', iconSize: [11, 11], iconAnchor: [6, 6], html: '<span class="tl-start"></span>' }); }
  function arrowIcon(deg) {
    return L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
      html: '<span class="tl-arrow" style="display:block;transform:rotate(' + (deg) + 'deg)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 L12 20 M12 4 L7 10 M12 4 L17 10"/></svg></span>' });
  }
  function labelIcon(text) { return L.divIcon({ className: '', iconSize: [1, 1], html: '<span class="tl-lab">' + escapeHtml(text) + '</span>' }); }

  var palette = ['#39E0D0', '#8B7CFF', '#F4B740', '#FF6B7A', '#5BC8FF', '#9DE34F', '#FF8AC4', '#FFB35B'];
  function colorFor(idStr) {
    var h = 0; for (var i = 0; i < idStr.length; i++) h = (h * 31 + idStr.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // 한 entity 의 시간 t 까지 경로/머리 그리기
  function drawEntity(g, ent, cur, isLiveHead) {
    var pts = ent.points.filter(function (p) { return p.t <= cur + 1; });
    if (!pts.length) return null;
    var lls = pts.map(function (p) { return [p.lat, p.lng]; });
    var head = lls[lls.length - 1];
    if (lls.length > 1) {
      L.polyline(lls, { color: ent.color, weight: 3.5, opacity: .9, lineJoin: 'round', lineCap: 'round' }).addTo(g);
      L.marker(lls[0], { icon: startIcon(), interactive: false }).addTo(g);
      var step = Math.max(1, Math.floor((lls.length - 1) / 5));
      for (var i = step; i < lls.length; i += step) {
        var a = lls[i - 1], b = lls[i];
        if (distM(a, b) < 4) continue;
        var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        L.marker(mid, { icon: arrowIcon(bearing(a, b)), interactive: false }).addTo(g);
      }
    }
    L.marker(head, { icon: dotIcon(ent.color, !!isLiveHead), interactive: false }).addTo(g);
    if (ent.name) L.marker(head, { icon: labelIcon(ent.name), interactive: false }).addTo(g);
    return lls;
  }

  // =====================================================================
  // 타임라인 스크러버 엔진
  // =====================================================================
  function Timeline(mapId, mountId, opt) {
    this.mapId = mapId; this.mountId = mountId; this.opt = opt || {};
    this.entities = []; this.min = 0; this.max = 0; this.cur = 0;
    this.live = (this.opt.live !== false); this.playing = false; this.speed = 1;
    this.raf = null; this.last = 0; this.built = false;
  }
  Timeline.SPEEDS = [1, 8, 60];
  Timeline.prototype.build = function () {
    if (this.built) return;
    var mount = $(this.mountId); if (!mount) return;
    var self = this;
    mount.className = 'scrub';
    mount.innerHTML =
      '<div class="scrub-head">' +
        '<button class="scrub-play"><i class="ic" data-ic="play"></i></button>' +
        '<div class="scrub-time mono">--:--<span class="d"></span></div>' +
        '<button class="scrub-speed mono">1\u00d7</button>' +
        '<button class="scrub-live mono">LIVE</button>' +
      '</div>' +
      '<div class="scrub-track">' +
        '<div class="scrub-ticks"></div>' +
        '<input type="range" class="scrub-range" min="0" max="1000" value="1000" />' +
      '</div>';
    injectIcons(mount);
    var ticks = mount.querySelector('.scrub-ticks'); var th = '';
    for (var i = 0; i <= 24; i++) th += '<i' + (i % 6 === 0 ? ' class="big"' : '') + '></i>';
    ticks.innerHTML = th;
    this.elPlay = mount.querySelector('.scrub-play');
    this.elTime = mount.querySelector('.scrub-time');
    this.elSpeed = mount.querySelector('.scrub-speed');
    this.elLive = mount.querySelector('.scrub-live');
    this.elRange = mount.querySelector('.scrub-range');
    on(this.elPlay, 'click', function () { self.togglePlay(); });
    on(this.elSpeed, 'click', function () {
      var idx = Timeline.SPEEDS.indexOf(self.speed); self.speed = Timeline.SPEEDS[(idx + 1) % Timeline.SPEEDS.length];
      self.elSpeed.textContent = self.speed + '\u00d7';
    });
    on(this.elLive, 'click', function () { self.goLive(); });
    on(this.elRange, 'input', function () {
      self.live = false; self.playing = false;
      var f = (+self.elRange.value) / 1000;
      self.cur = self.min + f * (self.max - self.min);
      self.syncHead(); self.render();
    });
    this.built = true;
  };
  Timeline.prototype.setData = function (entities) {
    this.build();
    this.entities = entities || [];
    var lo = Infinity, hi = -Infinity;
    this.entities.forEach(function (e) {
      e.points.sort(function (a, b) { return a.t - b.t; });
      if (e.points.length) { lo = Math.min(lo, e.points[0].t); hi = Math.max(hi, e.points[e.points.length - 1].t); }
    });
    if (!isFinite(lo)) { lo = hi = Date.now(); }
    this.min = lo; this.max = hi;
    if (this.live || this.cur > this.max) this.cur = this.max;
    if (this.cur < this.min) this.cur = this.min;
    this.syncHead(); this.render();
  };
  Timeline.prototype.syncHead = function () {
    if (!this.elRange) return;
    var span = (this.max - this.min) || 1;
    this.elRange.value = Math.round(((this.cur - this.min) / span) * 1000);
    if (this.elLive) this.elLive.className = 'scrub-live mono' + (this.live ? ' on' : '');
    if (this.elPlay) this.elPlay.querySelector('.ic').innerHTML = svgIcon(this.playing ? 'pause' : 'play');
    if (this.elTime) {
      if (!this.entities.length || !isFinite(this.cur)) { this.elTime.innerHTML = '--:--<span class="d"></span>'; }
      else this.elTime.innerHTML = fmtClock(this.cur) + '<span class="d">' + (this.live ? 'LIVE' : fmtAgo(this.cur)) + '</span>';
    }
  };
  Timeline.prototype.render = function () {
    var map = getMap(this.mapId);
    var key = this.mapId + '__tl';
    if (tlLayer[key]) map.removeLayer(tlLayer[key]);
    var g = L.layerGroup().addTo(map); tlLayer[key] = g;
    var bounds = [];
    var self = this;
    this.entities.forEach(function (e) {
      var liveHead = self.live && (Math.abs(self.cur - self.max) < 1);
      var lls = drawEntity(g, e, self.cur, liveHead);
      if (lls) lls.forEach(function (p) { bounds.push(p); });
    });
    if (!fitted[this.mapId] && bounds.length) {
      try {
        if (bounds.length === 1) map.setView(bounds[0], 16);
        else map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 17 });
        fitted[this.mapId] = true;
      } catch (e) {}
    }
    invalidate(this.mapId);
    updateLivePill();
  };
  Timeline.prototype.togglePlay = function () {
    if (this.playing) { this.playing = false; this.stopLoop(); this.syncHead(); return; }
    if (this.max - this.min < 1000) { toast('재생할 경로가 충분하지 않습니다'); return; }
    this.live = false; this.playing = true;
    if (Math.abs(this.cur - this.max) < 1) this.cur = this.min; // 끝이면 처음부터
    this.last = Date.now(); this.syncHead(); this.loop();
  };
  Timeline.prototype.loop = function () {
    var self = this;
    this.raf = requestAnimationFrame(function () {
      var now = Date.now(), dt = now - self.last; self.last = now;
      self.cur += dt * self.speed;
      if (self.cur >= self.max) { self.cur = self.max; self.playing = false; }
      self.syncHead(); self.render();
      if (self.playing) self.loop();
    });
  };
  Timeline.prototype.stopLoop = function () { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } };
  Timeline.prototype.goLive = function () {
    this.live = true; this.playing = false; this.stopLoop();
    this.cur = this.max; this.syncHead(); this.render();
  };

  var tlSend = new Timeline('mapSend', 'sendScrub', { live: true });
  var tlRecv = new Timeline('mapRecv', 'recvScrub', { live: false });
  var tlGroup = new Timeline('mapGroup', 'groupScrub', { live: true });

  function anyLive() { return (tlSend.live && current === 'send' && hasSendData) || (tlGroup.live && current === 'group' && svcState.group); }
  function updateLivePill() {
    var p = $('livePill'); if (!p) return;
    p.className = 'livepill' + (anyLive() ? ' on' : '');
  }

  // =====================================================================
  // 궤적 저장소 (그룹 멤버 누적 · localStorage)
  // =====================================================================
  var TKEY = 'mywhere_trails_v1';
  var groupTrails = {};   // id -> [{lat,lng,t}]
  var groupNames = {};    // id -> name
  function loadTrails() {
    try { var o = JSON.parse(localStorage.getItem(TKEY) || '{}'); groupTrails = o.trails || {}; groupNames = o.names || {}; }
    catch (e) { groupTrails = {}; groupNames = {}; }
  }
  var saveTimer = null;
  function saveTrails() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { localStorage.setItem(TKEY, JSON.stringify({ trails: groupTrails, names: groupNames })); } catch (e) {}
    }, 1500);
  }
  function pruneOld(arr, maxAgeMs, cap) {
    var cut = Date.now() - maxAgeMs;
    var out = arr.filter(function (p) { return p.t >= cut; });
    if (out.length > cap) out = out.slice(out.length - cap);
    return out;
  }
  function pushTrail(id, name, lat, lng, t) {
    if (!isFinite(lat) || !isFinite(lng)) return;
    if (name) groupNames[id] = name;
    var arr = groupTrails[id] || [];
    var last = arr[arr.length - 1];
    if (!last || (t - last.t >= 1000 && distM([last.lat, last.lng], [lat, lng]) >= 2) || (t - last.t >= 60000)) {
      arr.push({ lat: lat, lng: lng, t: t });
      groupTrails[id] = pruneOld(arr, 6 * 3600 * 1000, 600);
      saveTrails();
    } else if (last) { last.lat = lat; last.lng = lng; last.t = t; } // 미세이동: 머리만 갱신
  }
  function entitiesFromTrails(myId) {
    var out = [];
    Object.keys(groupTrails).forEach(function (id) {
      var pts = groupTrails[id]; if (!pts || !pts.length) return;
      var isMe = (id === myId);
      out.push({ id: id, name: (groupNames[id] || '익명') + (isMe ? ' (나)' : ''),
        color: isMe ? '#39E0D0' : colorFor(id), points: pts.slice() });
    });
    return out;
  }

  // =====================================================================
  // 탭 전환
  // =====================================================================
  var current = 'send';
  function switchTab(tab) {
    current = tab;
    ['send', 'recv', 'group', 'set'].forEach(function (t) {
      var pg = $('pg-' + t); if (pg) pg.classList.toggle('active', t === tab);
    });
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
    if (has('setCanBack')) B.setCanBack(tab !== 'send');
    if (tab === 'send') { createLayerSwitch('sendLayers', 'mapSend'); invalidate('mapSend'); startMyLive(); }
    else stopMyLive();
    if (tab === 'recv') { createLayerSwitch('recvLayers', 'mapRecv'); invalidate('mapRecv'); }
    if (tab === 'group') { createLayerSwitch('groupLayers', 'mapGroup'); invalidate('mapGroup'); refreshPermsAndState(); }
    if (tab === 'set') refreshPermsAndState();
    maybeStartReads();
    updateLivePill();
  }
  window.__goBack = function () { switchTab('send'); };

  // =====================================================================
  // 내 위치 (실시간 + 궤적)
  // =====================================================================
  var lastSend = null;
  var hasSendData = false;
  var myLiveTimer = null;

  function getCurrentLocation() {
    return new Promise(function (res) {
      if (!has('getCurrentLocation')) { res(null); return; }
      var id = nextId('loc'); pending[id] = res; B.getCurrentLocation(id);
      setTimeout(function () { resolve(id, null); }, 25000);
    });
  }
  window.__onLocation = function (reqId, json) { var v = null; try { v = JSON.parse(json); } catch (e) {} resolve(reqId, v); };

  function reverseGeocode(lat, lng) {
    return new Promise(function (res) {
      if (!has('geocode')) { res(''); return; }
      var id = nextId('geo'); pending[id] = res; B.geocode(id, lat, lng);
      setTimeout(function () { resolve(id, ''); }, 12000);
    });
  }
  window.__onGeocode = function (reqId, address) { resolve(reqId, address || ''); };

  function myTrail(windowMin) {
    try {
      var arr = JSON.parse(B.getMyTrailJson(windowMin || 0));
      return (arr || []).map(function (p) { return { lat: +p.lat, lng: +p.lng, t: +p.t, bear: p.bear, spd: p.spd, acc: p.acc }; })
                        .filter(function (q) { return isFinite(q.lat) && isFinite(q.lng); });
    } catch (e) { return []; }
  }

  function tmapScheme(lat, lng, name) {
    var nm = encodeURIComponent(name && name.trim() ? name : '공유 위치');
    return 'tmap://route?goalname=' + nm + '&goalx=' + round6(lng) + '&goaly=' + round6(lat);
  }
  function whoLabel(name) { return name ? (name + '님 위치') : '내 위치'; }
  function shortAddr(a) { return (a || '').replace(/^대한민국\s+/, '').trim(); }
  function buildShareText(s) { return '[위치공유] ' + whoLabel(s.name) + ' ' + fmtTime(s.t) + ' · 구글맵 ' + s.mapsUrl + ' · ' + s.code; }
  function buildTmapShareText(s) { return '[위치공유] ' + whoLabel(s.name) + ' ' + fmtTime(s.t) + ' · 티맵 ' + tmapScheme(s.lat, s.lng, s.name) + ' · 구글맵 ' + s.mapsUrl + ' · ' + s.code; }

  function teleHtml(rows) {
    return rows.map(function (r) {
      return '<div class="cell' + (r.full ? ' full' : '') + '"><div class="k">' + escapeHtml(r.k) + '</div><div class="v ' + (r.mono ? 'mono' : '') + '">' + r.v + '</div></div>';
    }).join('');
  }

  function renderMyTele(loc, pts, addr) {
    var rows = [
      { k: 'COORD', v: round6(loc.lat) + ', ' + round6(loc.lng), mono: true },
      { k: 'TIME', v: fmtClock(loc.t), mono: true },
      { k: 'ACCURACY', v: (loc.acc > 0 ? '±' + Math.round(loc.acc) + ' m' : '—'), mono: true },
      { k: 'TRAIL', v: pts.length + ' pts' + (trailDuration(pts) ? ' · ' + trailDuration(pts) : ''), mono: true },
      { k: 'ADDRESS', v: escapeHtml(addr || '확인 중…'), full: true }
    ];
    var el = $('sendTele'); if (el) { el.innerHTML = teleHtml(rows); show(el, true); }
  }

  function buildSendPayload(loc, pts) {
    var settings = loadSettingsObj();
    var name = settings.name || '';
    var code = encodePayload(name, pts.length ? pts : [{ lat: loc.lat, lng: loc.lng, t: loc.t }]);
    var mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + round6(loc.lat) + ',' + round6(loc.lng);
    lastSend = { name: name, points: pts, code: code, mapsUrl: mapsUrl, lat: loc.lat, lng: loc.lng, t: loc.t, acc: loc.acc };
    $('btnShare').disabled = false; $('btnCopy').disabled = false;
  }

  function refreshMyMap(loc) {
    var settings = loadSettingsObj();
    var win = settings.recentWindowMin || 30;
    var pts = myTrail(win);
    if (loc && loc.ok) {
      pts.push({ lat: loc.lat, lng: loc.lng, t: loc.t });
    }
    pts.sort(function (a, b) { return a.t - b.t; });
    // 중복 제거(같은 t)
    var seen = {}, clean = [];
    pts.forEach(function (p) { var k = p.t + ':' + round6(p.lat); if (!seen[k]) { seen[k] = 1; clean.push(p); } });
    pts = clean;
    if (!pts.length && loc && loc.ok) pts = [{ lat: loc.lat, lng: loc.lng, t: loc.t }];
    if (!pts.length) return false;
    hasSendData = true;
    var name = settings.name || '나';
    tlSend.setData([{ id: 'me', name: name, color: '#39E0D0', points: pts }]);
    var cur = pts[pts.length - 1];
    buildSendPayload(loc && loc.ok ? loc : { lat: cur.lat, lng: cur.lng, t: cur.t, acc: 0 }, pts);
    $('sendStatus').textContent = svcState.track ? 'tracking' : 'live';
    return true;
  }

  async function doGetLocation() {
    var btn = $('btnGetLoc');
    if (btn) btn.disabled = true;
    var loc = await getCurrentLocation();
    if (btn) btn.disabled = false;
    if (!loc || !loc.ok) { toast(loc && loc.error ? loc.error : '위치를 가져오지 못했습니다'); return; }
    fitted['mapSend'] = false; // 새 위치 요청 시 한번 맞춤
    refreshMyMap(loc);
    var addr = shortAddr(await reverseGeocode(loc.lat, loc.lng));
    renderMyTele(loc, lastSend ? lastSend.points : [{ lat: loc.lat, lng: loc.lng, t: loc.t }], addr);
  }

  // 내 위치 탭이 보이는 동안 라이브 갱신
  function startMyLive() {
    stopMyLive();
    if (!hasSendData) { refreshMyMap(null); } // trail 만으로라도 표시
    myLiveTimer = setInterval(function () {
      if (current !== 'send') return;
      if (tlSend.live) refreshMyMap(null); // 새 trail 포인트 반영(라이브일 때만)
    }, 5000);
  }
  function stopMyLive() { if (myLiveTimer) { clearInterval(myLiveTimer); myLiveTimer = null; } }

  function trailDuration(pts) {
    if (pts.length < 2) return '';
    var m = Math.round((pts[pts.length - 1].t - pts[0].t) / 60000);
    if (m < 1) return '1분 미만';
    if (m < 60) return '최근 ' + m + '분';
    return '최근 ' + Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  }

  // =====================================================================
  // 받은 위치
  // =====================================================================
  async function doDecode(text) {
    var raw = (text != null ? text : ($('recvInput') ? $('recvInput').value : '')) || '';
    if (!raw.trim()) { toast('붙여넣은 내용이 없습니다'); return; }
    var parsed = decodeAny(raw);
    if (!parsed) { toast('위치 정보를 찾지 못했습니다. 메시지 전체를 붙여넣어 보세요.'); show($('recvInfoCard'), false); show($('recvEmpty'), true); return; }
    var pts = parsed.points.slice().sort(function (a, b) { return a.t - b.t; });
    var cur = pts[pts.length - 1];
    show($('recvEmpty'), false); show($('recvInfoCard'), true);
    createLayerSwitch('recvLayers', 'mapRecv');
    $('recvTitle').textContent = parsed.name ? (parsed.name + '님 위치') : '받은 위치';
    fitted['mapRecv'] = false;
    tlRecv.live = false;
    tlRecv.setData([{ id: 'recv', name: parsed.name || '받은 위치', color: '#8B7CFF', points: pts }]);

    var rows = [
      { k: 'COORD', v: round6(cur.lat) + ', ' + round6(cur.lng), mono: true },
      { k: 'TIME', v: fmtClock(cur.t), mono: true },
      { k: 'TRAIL', v: (pts.length > 1 ? pts.length + ' pts · ' + (trailDuration(pts) || '경로') : (parsed.source === 'link' ? '링크(경로 없음)' : '단일 지점')), mono: true },
      { k: 'RECEIVED', v: fmtAgo(cur.t), mono: true },
      { k: 'ADDRESS', v: '<span id="recvAddr">확인 중…</span>', full: true }
    ];
    $('recvTele').innerHTML = teleHtml(rows);

    $('btnOpenMaps').onclick = function () { if (has('openMaps')) B.openMaps(cur.lat, cur.lng); };
    var tb = $('btnOpenTmap'); if (tb) tb.onclick = function () { if (has('openTmap')) B.openTmap(cur.lat, cur.lng, parsed.name || ''); };

    var addr = await reverseGeocode(cur.lat, cur.lng);
    var el = $('recvAddr'); if (el) el.textContent = shortAddr(addr) || '주소 확인 불가';
  }

  function consumeShared() {
    if (!has('consumeSharedText')) return;
    var t = ''; try { t = B.consumeSharedText() || ''; } catch (e) {}
    if (t && t.trim()) { if ($('recvInput')) $('recvInput').value = t; switchTab('recv'); doDecode(t); }
  }
  window.__onSharedText = function () { consumeShared(); };

  // =====================================================================
  // 실시간 그룹
  // =====================================================================
  var groupTimer = null;
  var svcState = { group: false, track: false };

  window.__onServiceState = function (json) { try { svcState = JSON.parse(json); } catch (e) {} renderServiceState(); };
  function renderServiceState() {
    var swT = $('swTrack'); if (swT) swT.classList.toggle('on', !!svcState.track);
    var lbl = $('trackLbl'); if (lbl) lbl.textContent = svcState.track ? '추적 중' : '실시간 추적';
    var chip = $('chipGroupRun');
    if (chip) {
      chip.className = 'chip ' + (svcState.group ? 'ok' : 'no');
      chip.innerHTML = '<span class="dot"></span>' + (svcState.group ? '공유 중' : '공유 꺼짐');
    }
    var gl = $('groupToggleLbl'); if (gl) gl.textContent = svcState.group ? '실시간 공유 중지' : '실시간 공유 시작';
    var gi = $('btnGroupToggle'); if (gi) { var ic = gi.querySelector('.ic'); if (ic) ic.innerHTML = svgIcon(svcState.group ? 'pause' : 'play'); }
    if (svcState.group) startGroupPolling(); else stopGroupReads();
    show($('groupMapCard'), !!svcState.group);
    var ss = $('sendStatus'); if (ss && current === 'send') ss.textContent = svcState.track ? 'tracking' : (hasSendData ? 'live' : 'standby');
  }
  function maybeStartReads() {
    if (svcState.group && current === 'group') startGroupReads();
    else stopGroupReads();
  }
  function startGroupPolling() { maybeStartReads(); }

  function backendReady(s) {
    s = s || loadSettingsObj();
    return (s.backendMode === 'worker') ? !!(s.relayUrl && s.relayUrl.trim()) : !!(s.firebaseUrl && s.firebaseUrl.trim());
  }
  function refreshRelayChip() {
    var s = loadSettingsObj(); var ok = backendReady(s);
    var label = (s.backendMode === 'worker') ? 'Worker' : 'Firebase';
    var chip = $('chipRelay');
    if (chip) { chip.className = 'chip ' + (ok ? 'ok' : 'no'); chip.innerHTML = '<span class="dot"></span>' + (ok ? (label + ' 연결됨') : (label + ' 미설정')); }
    show($('relayWarn'), !ok);
  }

  function toggleGroup() {
    var s = loadSettingsObj();
    var code = ($('grpCode') ? $('grpCode').value.trim() : '') || s.groupCode || '';
    if (svcState.group) { if (has('stopGroup')) B.stopGroup(); return; }
    if (!backendReady(s)) { toast('설정에서 실시간 백엔드 URL을 먼저 입력하세요'); switchTab('set'); return; }
    if (!code) { toast('그룹 코드를 입력하세요'); return; }
    saveSettings({ groupCode: code });
    if ($('setGroup')) $('setGroup').value = code;
    if (has('startGroup')) B.startGroup();
  }

  function startGroupReads() {
    stopGroupReads();
    var s = loadSettingsObj();
    pollGroupOnce();
    if (s.backendMode !== 'worker' && has('startGroupStream')) {
      B.startGroupStream();
      groupTimer = setInterval(pollGroupOnce, 90000);
    } else {
      var sec = Math.max(10, s.updateIntervalSec || 20);
      groupTimer = setInterval(pollGroupOnce, sec * 1000);
    }
  }
  function stopGroupReads() {
    if (groupTimer) { clearInterval(groupTimer); groupTimer = null; }
    if (has('stopGroupStream')) B.stopGroupStream();
  }
  function pollGroupOnce() {
    if (!has('pollGroup')) return;
    var id = nextId('grp'); pending[id] = renderGroup; B.pollGroup(id);
    setTimeout(function () { resolve(id, null); }, 12000);
  }
  window.__onGroup = function (reqId, json) {
    var data = null; try { data = JSON.parse(json); } catch (e) {}
    if (reqId === 'stream') { renderGroup(data); return; }
    resolve(reqId, data);
  };

  function renderGroup(snap) {
    if (!snap) return;
    var members = (snap && snap.members) ? snap.members : (Array.isArray(snap) ? snap : []);
    var unknown = (snap && typeof snap.unknown === 'number') ? snap.unknown : 0;
    var uw = $('unknownWarn'); if (uw) { show(uw, unknown > 0); var uc = $('unknownCount'); if (uc) uc.textContent = unknown; }

    var s = loadSettingsObj(); var myId = s.memberId;
    // 멤버 위치 누적
    members.forEach(function (mb) {
      if (!isFinite(mb.lat) || !isFinite(mb.lng)) return;
      pushTrail(mb.m, mb.n || '익명', mb.lat, mb.lng, mb.t || Date.now());
    });
    // 내 위치도 그룹 궤적에 합류(내 trail 기준)
    if (myId) {
      var mine = myTrail(0);
      if (mine.length) { var last = mine[mine.length - 1]; pushTrail(myId, s.name || '나', last.lat, last.lng, last.t); }
    }

    var ents = entitiesFromTrails(myId);
    var live = members.slice().sort(function (a, b) { return b.t - a.t; });
    // 멤버 리스트
    var listHtml = '';
    live.forEach(function (mb) {
      var isMe = (mb.m === myId);
      var col = isMe ? '#39E0D0' : colorFor(mb.m || mb.n || '?');
      var initial = (mb.n || '?').trim().charAt(0).toUpperCase() || '?';
      listHtml += '<div class="mem"><div class="av" style="background:' + col + '">' + escapeHtml(initial) + '</div>' +
        '<div class="nm">' + escapeHtml(mb.n || '익명') + (isMe ? ' <span style="color:var(--muted)">(나)</span>' : '') + '</div>' +
        '<div class="ago mono">' + fmtAgo(mb.t) + '</div></div>';
    });
    var ml = $('memList');
    if (ml) ml.innerHTML = listHtml || '<div class="empty">아직 참여한 사람이 없습니다.<br>같은 그룹 코드로 함께 시작해 보세요.</div>';
    var gc = $('groupCount'); if (gc) gc.textContent = live.length ? (live.length + ' online') : '';

    if (ents.length) tlGroup.setData(ents);
    updateLivePill();
  }

  // =====================================================================
  // 설정 / 권한
  // =====================================================================
  var settingsCache = {};
  function loadSettingsObj() { try { settingsCache = JSON.parse(B.getSettings()) || {}; } catch (e) {} return settingsCache; }
  function saveSettings(partial) {
    var merged = Object.assign({}, loadSettingsObj(), partial);
    if (has('saveSettings')) B.saveSettings(JSON.stringify(merged));
    settingsCache = merged;
  }
  function applyBackendVisibility(mode) { var fb = (mode === 'firebase'); show($('fldFirebase'), fb); show($('fldRelay'), !fb); }
  function fillSettingsUI() {
    var s = loadSettingsObj();
    if ($('setName')) $('setName').value = s.name || '';
    if ($('setGroup')) $('setGroup').value = s.groupCode || '';
    if ($('setRelay')) $('setRelay').value = s.relayUrl || '';
    if ($('setFirebase')) $('setFirebase').value = s.firebaseUrl || '';
    if ($('setBackend')) $('setBackend').value = (s.backendMode === 'worker') ? 'worker' : 'firebase';
    applyBackendVisibility(s.backendMode || 'firebase');
    if ($('setWindow')) $('setWindow').value = s.recentWindowMin || 30;
    if ($('setInterval')) $('setInterval').value = s.updateIntervalSec || 20;
    if ($('setMinDist')) $('setMinDist').value = (s.minDistanceM != null ? s.minDistanceM : 15);
    if ($('swHiAcc')) $('swHiAcc').classList.toggle('on', !!s.highAccuracy);
    if ($('swAuto')) $('swAuto').classList.toggle('on', !!s.autoStartGroup);
    if ($('grpCode')) $('grpCode').value = s.groupCode || '';
    refreshRelayChip(); refreshE2E();
  }
  function saveSettingsFromUI() {
    var partial = {
      name: $('setName') ? $('setName').value.trim() : '',
      groupCode: $('setGroup') ? $('setGroup').value.trim() : '',
      relayUrl: $('setRelay') ? $('setRelay').value.trim() : '',
      firebaseUrl: $('setFirebase') ? $('setFirebase').value.trim() : '',
      backendMode: ($('setBackend') && $('setBackend').value === 'worker') ? 'worker' : 'firebase',
      recentWindowMin: clampNum($('setWindow'), 30, 1, 1440),
      updateIntervalSec: clampNum($('setInterval'), 20, 5, 600),
      minDistanceM: clampNum($('setMinDist'), 15, 0, 1000),
      highAccuracy: $('swHiAcc') ? $('swHiAcc').classList.contains('on') : false,
      autoStartGroup: $('swAuto') ? $('swAuto').classList.contains('on') : false
    };
    saveSettings(partial); fillSettingsUI();
    if ($('grpCode')) $('grpCode').value = partial.groupCode;
    refreshRelayChip(); toast('설정을 저장했습니다');
  }
  function clampNum(el, def, lo, hi) { var v = el ? parseInt(el.value, 10) : def; if (isNaN(v)) v = def; return Math.min(hi, Math.max(lo, v)); }
  window.__onSettingsImported = function () { fillSettingsUI(); refreshPermsAndState(); toast('가져온 설정을 적용했습니다'); };

  window.__onPermissions = function (json) { var p = {}; try { p = JSON.parse(json); } catch (e) {} applyPermUI(p); };
  function applyPermUI(p) { setPermBtn($('permFine'), p.fine); setPermBtn($('permBg'), p.background); setPermBtn($('permNoti'), p.notify); }
  function setPermBtn(btn, ok) { if (!btn) return; btn.textContent = ok ? '허용됨' : '요청'; btn.classList.toggle('line', !!ok); btn.disabled = false; }
  function refreshPerms() { if (!has('permState')) return; try { applyPermUI(JSON.parse(B.permState())); } catch (e) {} }
  function refreshState() { if (!has('serviceState')) return; try { svcState = JSON.parse(B.serviceState()); } catch (e) {} renderServiceState(); }
  function refreshPermsAndState() { refreshPerms(); refreshState(); refreshRelayChip(); }

  // =====================================================================
  // QR 페어링 + E2E
  // =====================================================================
  var PAIR_PREFIX = 'MYWHEREKEY1:';
  function randCode() {
    var cset = 'abcdefghijkmnpqrstuvwxyz23456789', r = '';
    var a = new Uint8Array(8); (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < 8; i++) r += cset[a[i] % cset.length];
    return 'fam-' + r;
  }
  function buildPairing() {
    var s = loadSettingsObj();
    var url = (s.backendMode === 'worker') ? s.relayUrl : s.firebaseUrl;
    var obj = { v: 1, b: (s.backendMode === 'worker' ? 'worker' : 'firebase'), u: url || '', g: s.groupCode || '', k: s.groupKey || '' };
    return PAIR_PREFIX + b64urlEnc(new TextEncoder().encode(JSON.stringify(obj)));
  }
  function parsePairing(raw) {
    if (!raw) return null;
    var m = raw.match(/MYWHEREKEY1:([A-Za-z0-9_\-]+)/);
    if (!m) return null;
    try { var obj = JSON.parse(new TextDecoder().decode(b64urlDec(m[1]))); return (obj && obj.k) ? obj : null; } catch (e) { return null; }
  }
  function makeQr(text) { var qr = qrcode(0, 'M'); qr.addData(text); qr.make(); return qr.createDataURL(6, 10); }
  function showPairingQr() {
    var s = loadSettingsObj();
    var url = (s.backendMode === 'worker') ? s.relayUrl : s.firebaseUrl;
    if (!url || !url.trim()) { toast('먼저 설정에서 백엔드 URL을 입력하세요'); switchTab('set'); return; }
    if (!s.groupCode) { saveSettings({ groupCode: randCode() }); s = loadSettingsObj(); }
    if (!s.groupKey && has('generateGroupKey')) { saveSettings({ groupKey: B.generateGroupKey() }); s = loadSettingsObj(); }
    if ($('grpCode')) $('grpCode').value = s.groupCode;
    var payload = buildPairing();
    try { $('pairQr').src = makeQr(payload); show($('pairOut'), true); $('btnPairCopy').onclick = function () { if (has('copyText')) B.copyText(payload); }; }
    catch (e) { toast('QR 생성 실패'); }
    refreshE2E(); refreshRelayChip();
  }
  function applyPairing(obj) {
    if (!obj) { toast('유효한 페어링 코드가 아닙니다'); return; }
    var patch = { groupCode: obj.g || '', groupKey: obj.k || '', backendMode: (obj.b === 'worker' ? 'worker' : 'firebase') };
    if (obj.b === 'worker') patch.relayUrl = obj.u || ''; else patch.firebaseUrl = obj.u || '';
    saveSettings(patch); fillSettingsUI();
    if ($('grpCode')) $('grpCode').value = obj.g || '';
    show($('pairManualBox'), false);
    refreshE2E(); refreshRelayChip();
    toast('페어링 완료 — 암호화 키를 받았습니다');
  }
  function refreshE2E() {
    var s = loadSettingsObj();
    var onx = !!(s.groupKey && s.groupKey.length >= 40);
    var a = $('e2eStatus');
    if (a) { a.className = 'chip ' + (onx ? 'ok' : '') ; a.innerHTML = '<span class="dot"></span>' + (onx ? '종단간 암호화 사용 중' : '암호화 미설정 — 페어링 필요'); }
    var b = $('setE2E');
    if (b) { b.className = 'chip ' + (onx ? 'ok' : ''); b.innerHTML = '<span class="dot"></span>' + (onx ? '암호화 키 설정됨' : '암호화 키 없음 (그룹 탭에서 페어링)'); }
  }

  // 카메라 QR 스캐너
  var scanStream = null, scanRAF = null;
  function scanAvailable() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof jsQR !== 'undefined'); }
  function startScan() {
    if (!scanAvailable()) { toast('이 기기에서 카메라 스캔을 쓸 수 없어요. 코드 직접 입력을 이용하세요.'); show($('pairManualBox'), true); return; }
    var perm = {}; try { perm = JSON.parse(B.permState()); } catch (e) {}
    if (!perm.camera) { if (has('requestPermission')) B.requestPermission('camera'); toast('카메라 권한을 허용한 뒤 다시 눌러주세요'); return; }
    show($('scanOverlay'), true);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        scanStream = stream;
        var v = $('scanVideo'); v.srcObject = stream; v.setAttribute('playsinline', ''); v.muted = true;
        var p = v.play(); if (p && p.catch) p.catch(function () {});
        scanRAF = requestAnimationFrame(scanTick);
      })
      .catch(function () { stopScan(); toast('카메라를 열 수 없어요. 코드 직접 입력을 이용하세요.'); show($('pairManualBox'), true); });
  }
  function scanTick() {
    if (!scanStream) return;
    var v = $('scanVideo'), c = $('scanCanvas');
    if (v && v.readyState === v.HAVE_ENOUGH_DATA) {
      c.width = v.videoWidth; c.height = v.videoHeight;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, c.width, c.height);
      try {
        var img = ctx.getImageData(0, 0, c.width, c.height);
        var code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) { var obj = parsePairing(code.data); if (obj) { if (navigator.vibrate) navigator.vibrate(60); stopScan(); applyPairing(obj); return; } }
      } catch (e) {}
    }
    scanRAF = requestAnimationFrame(scanTick);
  }
  function stopScan() {
    if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    var v = $('scanVideo'); if (v) v.srcObject = null;
    show($('scanOverlay'), false);
  }

  // =====================================================================
  // 바인딩 / 초기화
  // =====================================================================
  function bind() {
    document.querySelectorAll('.tabbar button').forEach(function (b) {
      on(b, 'click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    // 내 위치
    on($('btnGetLoc'), 'click', doGetLocation);
    on($('btnTrackToggle'), 'click', function () {
      if (svcState.track) { if (has('stopTrack')) B.stopTrack(); }
      else { if (has('startTrack')) B.startTrack(); toast('실시간 추적을 켰습니다'); }
    });
    on($('btnShare'), 'click', function () { if (lastSend && has('shareText')) B.shareText(buildShareText(lastSend)); });
    on($('btnCopy'), 'click', function () { if (lastSend && has('copyText')) B.copyText(buildShareText(lastSend)); });
    on($('btnSendGoogle'), 'click', function () { if (lastSend && has('openMaps')) B.openMaps(lastSend.lat, lastSend.lng); });
    on($('btnSendTmap'), 'click', function () { if (lastSend && has('openTmap')) B.openTmap(lastSend.lat, lastSend.lng, lastSend.name || ''); });
    on($('btnShareTmap'), 'click', function () { if (lastSend && has('shareText')) B.shareText(buildTmapShareText(lastSend)); });
    on($('swTrack'), 'click', function () { if (svcState.track) { if (has('stopTrack')) B.stopTrack(); } else { if (has('startTrack')) B.startTrack(); } });
    on($('btnClearTrail'), 'click', function () {
      if (has('clearTrail')) B.clearTrail();
      hasSendData = false; lastSend = null; $('btnShare').disabled = true; $('btnCopy').disabled = true;
      show($('sendTele'), false);
      tlSend.setData([]); fitted['mapSend'] = false;
      toast('이동기록을 지웠습니다');
    });

    // 받기
    on($('btnDecode'), 'click', function () { doDecode(); });
    on($('btnPasteClear'), 'click', function () { if ($('recvInput')) $('recvInput').value = ''; show($('recvInfoCard'), false); show($('recvEmpty'), true); });

    // 그룹
    on($('btnGroupToggle'), 'click', toggleGroup);
    on($('btnPairCreate'), 'click', showPairingQr);
    on($('btnPairScan'), 'click', startScan);
    on($('scanCancel'), 'click', stopScan);
    on($('btnPairManual'), 'click', function () { var b = $('pairManualBox'); show(b, b && b.style.display === 'none'); });
    on($('btnPairManualApply'), 'click', function () { applyPairing(parsePairing($('pairManualInput') ? $('pairManualInput').value : '')); });
    on($('grpCode'), 'change', function () { saveSettings({ groupCode: $('grpCode').value.trim() }); refreshRelayChip(); });

    // 설정
    on($('btnSaveSet'), 'click', saveSettingsFromUI);
    on($('setBackend'), 'change', function () { applyBackendVisibility(this.value === 'worker' ? 'worker' : 'firebase'); });
    on($('swHiAcc'), 'click', function () { this.classList.toggle('on'); });
    on($('swAuto'), 'click', function () { this.classList.toggle('on'); });
    on($('permFine'), 'click', function () { if (has('requestPermission')) B.requestPermission('location'); });
    on($('permBg'), 'click', function () { if (has('requestPermission')) B.requestPermission('background'); });
    on($('permNoti'), 'click', function () { if (has('requestPermission')) B.requestPermission('notify'); });
    on($('btnAppSettings'), 'click', function () { if (has('openAppSettings')) B.openAppSettings(); });
    on($('btnExport'), 'click', function () { if (has('exportSettings')) B.exportSettings(); });
    on($('btnImport'), 'click', function () { if (has('importSettings')) B.importSettings(); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopScan(); stopMyLive(); }
      else { refreshPermsAndState(); if (current === 'send') startMyLive(); }
    });
  }

  function init() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) document.body.classList.add('prefers-reduced');
    injectIcons(document);
    injectMarkerCss();
    loadTrails();
    bind();
    fillSettingsUI();
    refreshPermsAndState();
    refreshE2E();
    switchTab('send');
    consumeShared();
    if (has('log')) B.log('myWhere v1.1.0 ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
