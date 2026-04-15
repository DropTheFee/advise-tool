// SüRJ ADVISE Tool — Cloudflare Worker
// KV-based auth + user management + session storage + GHL integration

const GHL_LOCATION_ID = '4RRtueNq1LIvO5VWxWVB';
const GHL_API_KEY = 'pit-94230723-2b35-4ca1-bd78-01078416b8b1';
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_BRIEF_FIELD_ID = 'REPLACE_WITH_YOUR_CUSTOM_FIELD_ID';

const COOKIE_NAME = 'surj_auth';
const COOKIE_TTL = 60 * 60 * 8;
const AUTH_SECRET = 'surj-advise-kv-auth-2026';

// ─── CRYPTO ───────────────────────────────────────────────────────────────────

async function hashPassword(password, salt) {
  if (!salt) {
    salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + password));
  var hash = Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  return salt + ':' + hash;
}

async function verifyPassword(password, stored) {
  var parts = stored.split(':');
  if (parts.length !== 2) return false;
  return (await hashPassword(password, parts[0])) === stored;
}

function genTempPassword() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes).map(function(b) { return chars[b % chars.length]; }).join('');
}

async function signToken(payload) {
  var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return encoded + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyToken(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 2) return null;
    var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    var valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(parts[1]), function(c) { return c.charCodeAt(0); }), new TextEncoder().encode(parts[0]));
    if (!valid) return null;
    var payload = JSON.parse(decodeURIComponent(escape(atob(parts[0]))));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch(e) {
    return null;
  }
}

function getAuthCookie(request) {
  var m = (request.headers.get('Cookie') || '').match(new RegExp(COOKIE_NAME + '=([^;]+)'));
  return m ? m[1] : null;
}

async function getAuthSession(request) {
  var t = getAuthCookie(request);
  return t ? verifyToken(t) : null;
}

function setCookie(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + COOKIE_TTL;
}

function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

// ─── USER KV ──────────────────────────────────────────────────────────────────

async function getUser(u, env) {
  var r = await env.ADVISE_SESSIONS.get('user:' + u + ':profile');
  return r ? JSON.parse(r) : null;
}

async function getUserAuth(u, env) {
  var r = await env.ADVISE_SESSIONS.get('user:' + u + ':auth');
  return r ? JSON.parse(r) : null;
}

async function saveUser(u, profile, env) {
  await env.ADVISE_SESSIONS.put('user:' + u + ':profile', JSON.stringify(profile));
}

async function saveUserAuth(u, auth, env) {
  await env.ADVISE_SESSIONS.put('user:' + u + ':auth', JSON.stringify(auth));
}

async function listUsers(env) {
  var list = await env.ADVISE_SESSIONS.list({ prefix: 'user:', limit: 100 });
  var users = [];
  for (var k of list.keys) {
    if (k.name.endsWith(':profile')) {
      var r = await env.ADVISE_SESSIONS.get(k.name);
      if (r) users.push(JSON.parse(r));
    }
  }
  return users.sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
}

async function usersExist(env) {
  var list = await env.ADVISE_SESSIONS.list({ prefix: 'user:', limit: 1 });
  return list.keys.length > 0;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function jsonResp(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({}, cors, { 'Content-Type': 'application/json' })
  });
}

function redir(path) {
  return new Response(null, { status: 302, headers: { 'Location': path } });
}

function fmtNum(n) {
  return n && !isNaN(n) ? '$' + Math.round(n).toLocaleString() : '$0';
}

async function serveAsset(filename, env) {
  return env.ASSETS.fetch(new Request('https://dummy-host/' + filename));
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;
    var cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ── SETUP (one-time, disabled once any user exists) ────────────────────
    if (path === '/setup') {
      if (await usersExist(env)) return redir('/login');
      return serveAsset('setup.html', env);
    }

    if (path === '/do-setup') {
      if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleSetup(request, env, cors);
    }

    // ── PUBLIC: client brief links, no auth ever ───────────────────────────
    if (path.startsWith('/brief/')) {
      return serveBriefPage(path.replace('/brief/', ''), env, 'client');
    }

    // ── LOGIN PAGE ─────────────────────────────────────────────────────────
    if (path === '/login') {
      if (await getAuthSession(request)) return redir('/dashboard');
      return serveAsset('login.html', env);
    }

    // ── LOGIN POST (separate path — avoids Cloudflare asset 405 issue) ────
    if (path === '/do-login') {
      if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleLogin(request, env);
    }

    // ── LOGOUT ─────────────────────────────────────────────────────────────
    if (path === '/logout') {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': clearCookie() }
      });
    }

    // ── CHANGE PASSWORD PAGE ───────────────────────────────────────────────
    if (path === '/change-password') {
      return serveAsset('change-password.html', env);
    }

    if (path === '/do-change-password') {
      if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleChangePassword(request, env, cors);
    }

    // ── API: sessions ──────────────────────────────────────────────────────
    if (path === '/api/save' && method === 'POST') {
      return handleSave(request, env, cors);
    }

    if (path.startsWith('/api/session/') && method === 'GET') {
      return handleGetSession(path.replace('/api/session/', ''), env, cors);
    }

    if (path.startsWith('/api/session/') && method === 'DELETE') {
      return handleDeleteSession(path.replace('/api/session/', ''), env, cors);
    }

    if (path.startsWith('/api/brief/') && method === 'POST') {
      return handleGenerateBrief(path.replace('/api/brief/', ''), 'client', request, env, cors);
    }

    if (path.startsWith('/api/admin-brief/') && method === 'POST') {
      return handleGenerateBrief(path.replace('/api/admin-brief/', ''), 'admin', request, env, cors);
    }

    if (path === '/api/sessions' && method === 'GET') {
      return handleListSessions(request, env, cors);
    }

    if (path === '/api/me' && method === 'GET') {
      var sess = await getAuthSession(request);
      if (!sess) return jsonResp({ error: 'Not authenticated' }, 401, cors);
      return jsonResp({ username: sess.username, role: sess.role, displayName: sess.displayName }, 200, cors);
    }

    if (path.startsWith('/api/lock/') && method === 'POST') {
      return handleLockSession(path.replace('/api/lock/', ''), request, env, cors);
    }

    // ── API: user management (admin only) ─────────────────────────────────
    if (path === '/api/users' && method === 'GET') {
      return handleListUsers(request, env, cors);
    }

    if (path === '/api/users' && method === 'POST') {
      return handleCreateUser(request, env, cors);
    }

    if (path.startsWith('/api/users/') && path.endsWith('/reset') && method === 'POST') {
      return handleResetPassword(path.replace('/api/users/', '').replace('/reset', ''), request, env, cors);
    }

    if (path.startsWith('/api/users/') && method === 'PUT') {
      return handleUpdateUser(path.replace('/api/users/', ''), request, env, cors);
    }

    if (path.startsWith('/api/users/') && method === 'DELETE') {
      return handleDeleteUser(path.replace('/api/users/', ''), request, env, cors);
    }

        // ── ADMIN BRIEF + USER MANAGEMENT PAGE ────────────────────────────────
        // ── ADMIN BRIEF + USER MANAGEMENT PAGE ────────────────────────────────
    if (path.startsWith('/admin/')) {
 if (path === '/admin/users') {
  return serveAsset('users.html', env);
}
          return new Response(
            'ADMIN ROUTE OK\n' +
            'username=' + (adminSess.username || '') + '\n' +
            'role=' + (adminSess.role || '') + '\n' +
            'displayName=' + (adminSess.displayName || ''),
            {
              status: 200,
              headers: { 'Content-Type': 'text/plain' }
            }
          );
        } catch (e) {
          return new Response(
            'ADMIN ROUTE ERROR:\n' + (e && e.stack ? e.stack : String(e)),
            {
              status: 500,
              headers: { 'Content-Type': 'text/plain' }
            }
          );
        }
      }

      var adminSess = await getAuthSession(request);
      if (!adminSess) return redir('/login');
    }

    // ── ALL OTHER PROTECTED ROUTES ─────────────────────────────────────────

    // ── ALL OTHER PROTECTED ROUTES ─────────────────────────────────────────
    var protectedSess = await getAuthSession(request);
    if (!protectedSess) {
      if (await usersExist(env)) return redir('/login');
      return redir('/setup');
    }

    if (protectedSess.mustChangePassword && path !== '/change-password') {
      return redir('/change-password');
    }

    if (path === '/' || path === '/index.html') return serveAsset('index.html', env);
    if (path === '/dashboard' || path === '/dashboard.html') return serveAsset('dashboard.html', env);

    return env.ASSETS.fetch(request);
  }
};

// ─── SETUP ────────────────────────────────────────────────────────────────────

async function handleSetup(request, env, cors) {
  try {
    if (await usersExist(env)) return jsonResp({ error: 'Setup already complete' }, 403, cors);
    var body = await request.json();
    var username = (body.username || '').trim().toLowerCase();
    var password = (body.password || '').trim();
    var displayName = (body.displayName || '').trim();
    var email = (body.email || '').trim();
    var phone = (body.phone || '').trim();
    if (!username || !password || !displayName || !email) {
      return jsonResp({ error: 'All fields required' }, 400, cors);
    }
    if (password.length < 8) {
      return jsonResp({ error: 'Password must be at least 8 characters' }, 400, cors);
    }
    var hash = await hashPassword(password);
    var now = new Date().toISOString();
    await saveUser(username, { username: username, displayName: displayName, email: email, phone: phone, role: 'admin', disabled: false, createdAt: now, lastLogin: null }, env);
    await saveUserAuth(username, { passwordHash: hash, mustChangePassword: false }, env);
    return jsonResp({ ok: true }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  try {
    var params = new URLSearchParams(await request.text());
    var username = (params.get('username') || '').trim().toLowerCase();
    var password = (params.get('password') || '').trim();
    var profile = await getUser(username, env);
    var auth = await getUserAuth(username, env);
    if (!profile || !auth || profile.disabled) {
      return redir('/login?error=' + encodeURIComponent('Invalid username or password.'));
    }
    var valid = await verifyPassword(password, auth.passwordHash);
    if (!valid) {
      return redir('/login?error=' + encodeURIComponent('Invalid username or password.'));
    }
    profile.lastLogin = new Date().toISOString();
    await saveUser(username, profile, env);
    var token = await signToken({
      username: profile.username,
      role: profile.role,
      displayName: profile.displayName,
      phone: profile.phone,
      email: profile.email,
      mustChangePassword: auth.mustChangePassword || false,
      exp: Date.now() + (COOKIE_TTL * 1000)
    });
    var dest = auth.mustChangePassword ? '/change-password' : '/dashboard';
    return new Response(null, {
      status: 302,
      headers: { 'Location': dest, 'Set-Cookie': setCookie(token) }
    });
  } catch(e) {
    return redir('/login?error=' + encodeURIComponent('Login error. Please try again.'));
  }
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

async function handleChangePassword(request, env, cors) {
  try {
    var sess = await getAuthSession(request);
    if (!sess) return jsonResp({ error: 'Not authenticated' }, 401, cors);
    var body = await request.json();
    var np = (body.newPassword || '').trim();
    var cp = (body.confirmPassword || '').trim();
    if (!np || np.length < 8) return jsonResp({ error: 'Password must be at least 8 characters' }, 400, cors);
    if (np !== cp) return jsonResp({ error: 'Passwords do not match' }, 400, cors);
    await saveUserAuth(sess.username, { passwordHash: await hashPassword(np), mustChangePassword: false }, env);
    var profile = await getUser(sess.username, env);
    var token = await signToken({
      username: sess.username,
      role: sess.role,
      displayName: sess.displayName,
      phone: profile ? profile.phone : '',
      email: profile ? profile.email : '',
      mustChangePassword: false,
      exp: Date.now() + (COOKIE_TTL * 1000)
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: Object.assign({}, cors, { 'Content-Type': 'application/json', 'Set-Cookie': setCookie(token) })
    });
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────

async function handleListUsers(request, env, cors) {
  var sess = await getAuthSession(request);
  if (!sess || sess.role !== 'admin') return jsonResp({ error: 'Forbidden' }, 403, cors);
  return jsonResp({ users: await listUsers(env) }, 200, cors);
}

async function handleCreateUser(request, env, cors) {
  var sess = await getAuthSession(request);
  if (!sess || sess.role !== 'admin') return jsonResp({ error: 'Forbidden' }, 403, cors);
  try {
    var body = await request.json();
    var username = (body.username || '').trim().toLowerCase();
    var displayName = (body.displayName || '').trim();
    var email = (body.email || '').trim();
    var phone = (body.phone || '').trim();
    var role = body.role === 'admin' ? 'admin' : 'rep';
    if (!username || !displayName || !email) return jsonResp({ error: 'Username, name, and email required' }, 400, cors);
    if (await getUser(username, env)) return jsonResp({ error: 'Username already exists' }, 409, cors);
    var temp = genTempPassword();
    var now = new Date().toISOString();
    await saveUser(username, { username: username, displayName: displayName, email: email, phone: phone, role: role, disabled: false, createdAt: now, lastLogin: null }, env);
    await saveUserAuth(username, { passwordHash: await hashPassword(temp), mustChangePassword: true }, env);
    return jsonResp({ ok: true, tempPassword: temp }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleUpdateUser(username, request, env, cors) {
  var sess = await getAuthSession(request);
  if (!sess || sess.role !== 'admin') return jsonResp({ error: 'Forbidden' }, 403, cors);
  try {
    var body = await request.json();
    var profile = await getUser(username, env);
    if (!profile) return jsonResp({ error: 'User not found' }, 404, cors);
    if (body.displayName !== undefined) profile.displayName = body.displayName;
    if (body.email !== undefined) profile.email = body.email;
    if (body.phone !== undefined) profile.phone = body.phone;
    if (body.role !== undefined) profile.role = body.role === 'admin' ? 'admin' : 'rep';
    if (body.disabled !== undefined) profile.disabled = body.disabled;
    await saveUser(username, profile, env);
    return jsonResp({ ok: true }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleResetPassword(username, request, env, cors) {
  var sess = await getAuthSession(request);
  if (!sess || sess.role !== 'admin') return jsonResp({ error: 'Forbidden' }, 403, cors);
  try {
    if (!(await getUser(username, env))) return jsonResp({ error: 'User not found' }, 404, cors);
    var temp = genTempPassword();
    await saveUserAuth(username, { passwordHash: await hashPassword(temp), mustChangePassword: true }, env);
    return jsonResp({ ok: true, tempPassword: temp }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleDeleteUser(username, request, env, cors) {
  var sess = await getAuthSession(request);
  if (!sess || sess.role !== 'admin') return jsonResp({ error: 'Forbidden' }, 403, cors);
  if (username === sess.username) return jsonResp({ error: 'Cannot delete your own account' }, 400, cors);
  await env.ADVISE_SESSIONS.delete('user:' + username + ':profile');
  await env.ADVISE_SESSIONS.delete('user:' + username + ':auth');
  return jsonResp({ ok: true }, 200, cors);
}

// ─── SESSION HANDLERS ─────────────────────────────────────────────────────────

async function handleSave(request, env, cors) {
  try {
    var body = await request.json();
    var sessionId = body.sessionId;
    var data = body.data;
    if (!sessionId || !data) return jsonResp({ error: 'Missing fields' }, 400, cors);
    var sess = await getAuthSession(request);
    if (sess && !data.createdBy) {
      data.createdBy = sess.username;
      data.createdByName = sess.displayName;
      data.repPhone = sess.phone;
      data.repEmail = sess.email;
    }
    await env.ADVISE_SESSIONS.put('session:' + sessionId + ':data', JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 90 });
    var meta = {
      id: sessionId,
      prospect: data.prospect || {},
      tier: data.selectedTier || '',
      outcome: data.outcome || '',
      totalLeak: data.calc ? data.calc.totalAnn : 0,
      createdBy: data.createdBy || 'unknown',
      createdByName: data.createdByName || 'Unknown',
      repPhone: data.repPhone || '',
      repEmail: data.repEmail || '',
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      briefGenerated: false,
      locked: false
    };
    var exRaw = await env.ADVISE_SESSIONS.get('session:' + sessionId + ':meta');
    if (exRaw) {
      var ex = JSON.parse(exRaw);
      meta.locked = ex.locked || false;
      meta.briefGenerated = ex.briefGenerated || false;
      meta.briefUrl = ex.briefUrl || '';
      meta.adminUrl = ex.adminUrl || '';
      meta.createdAt = ex.createdAt || meta.createdAt;
      meta.createdBy = ex.createdBy || meta.createdBy;
      meta.createdByName = ex.createdByName || meta.createdByName;
      meta.repPhone = ex.repPhone || meta.repPhone;
      meta.repEmail = ex.repEmail || meta.repEmail;
    }
    await env.ADVISE_SESSIONS.put('session:' + sessionId + ':meta', JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 * 90 });
    return jsonResp({ ok: true, sessionId: sessionId }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleGetSession(id, env, cors) {
  try {
    var r = await env.ADVISE_SESSIONS.get('session:' + id + ':data');
    if (!r) return jsonResp({ error: 'Not found' }, 404, cors);
    return jsonResp(JSON.parse(r), 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleListSessions(request, env, cors) {
  try {
    var sess = await getAuthSession(request);
    var list = await env.ADVISE_SESSIONS.list({ prefix: 'session:', limit: 200 });
    var metas = [];
    for (var k of list.keys) {
      if (k.name.endsWith(':meta')) {
        var r = await env.ADVISE_SESSIONS.get(k.name);
        if (r) {
          var m = JSON.parse(r);
          if (!sess || sess.role === 'admin' || m.createdBy === sess.username) {
            metas.push(m);
          }
        }
      }
    }
    metas.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    return jsonResp({ sessions: metas, role: sess ? sess.role : 'unknown' }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleGenerateBrief(id, briefType, request, env, cors) {
  try {
    var body = await request.json();
    var kvKey = briefType === 'admin' ? 'session:' + id + ':admin' : 'session:' + id + ':brief';
    await env.ADVISE_SESSIONS.put(kvKey, body.briefHTML, { expirationTtl: 60 * 60 * 24 * 365 });
    var briefUrl = briefType === 'admin'
      ? 'https://advise.surj.app/admin/' + id
      : 'https://advise.surj.app/brief/' + id;
    var mr = await env.ADVISE_SESSIONS.get('session:' + id + ':meta');
    if (mr) {
      var m = JSON.parse(mr);
      m.briefGenerated = true;
      if (briefType === 'client') m.briefUrl = briefUrl;
      if (briefType === 'admin') m.adminUrl = briefUrl;
      await env.ADVISE_SESSIONS.put('session:' + id + ':meta', JSON.stringify(m));
    }
    fireGHLIntegration(body.sessionData, briefUrl).catch(function() {});
    return jsonResp({ ok: true, briefUrl: briefUrl }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleDeleteSession(id, env, cors) {
  try {
    var mr = await env.ADVISE_SESSIONS.get('session:' + id + ':meta');
    if (mr && JSON.parse(mr).locked) return jsonResp({ error: 'Session is locked' }, 403, cors);
    await env.ADVISE_SESSIONS.delete('session:' + id + ':data');
    await env.ADVISE_SESSIONS.delete('session:' + id + ':meta');
    await env.ADVISE_SESSIONS.delete('session:' + id + ':brief');
    await env.ADVISE_SESSIONS.delete('session:' + id + ':admin');
    return jsonResp({ ok: true }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

async function handleLockSession(id, request, env, cors) {
  try {
    var body = await request.json();
    var mr = await env.ADVISE_SESSIONS.get('session:' + id + ':meta');
    if (!mr) return jsonResp({ error: 'Not found' }, 404, cors);
    var m = JSON.parse(mr);
    m.locked = body.locked;
    await env.ADVISE_SESSIONS.put('session:' + id + ':meta', JSON.stringify(m));
    return jsonResp({ ok: true, locked: m.locked }, 200, cors);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, cors);
  }
}

// ─── SERVE BRIEF ──────────────────────────────────────────────────────────────

async function serveBriefPage(id, env, briefType) {
  var kvKey = briefType === 'admin' ? 'session:' + id + ':admin' : 'session:' + id + ':brief';
  try {
    var brief = await env.ADVISE_SESSIONS.get(kvKey);
    if (brief) {
      return new Response(brief, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    var rep = { displayName: 'Steve Wilson', phone: '(405) 913-1956', email: 'admin@surj.app' };
    var mr = await env.ADVISE_SESSIONS.get('session:' + id + ':meta');
    if (mr) {
      var m = JSON.parse(mr);
      if (m.createdByName) rep.displayName = m.createdByName;
      if (m.repPhone) rep.phone = m.repPhone;
      if (m.repEmail) rep.email = m.repEmail;
    }
    return new Response(notFoundHTML(rep), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  } catch(e) {
    return new Response(notFoundHTML({ displayName: 'Steve Wilson', phone: '(405) 913-1956', email: 'admin@surj.app' }), { status: 500, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
}

// ─── GHL ──────────────────────────────────────────────────────────────────────

async function fireGHLIntegration(sessionData, briefUrl) {
  if (!sessionData) return;
  var p = sessionData.prospect || {};
  var calc = sessionData.calc || {};
  var tier = sessionData.selectedTier || '';
  var tierName = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'TBD';
  var tierPrices = { launch: '$297', grow: '$497', scale: '$797' };
  var h = { 'Authorization': 'Bearer ' + GHL_API_KEY, 'Content-Type': 'application/json', 'Version': '2021-07-28' };
  var contactId = null;
  try {
    var sr = await (await fetch(GHL_API_BASE + '/contacts/?locationId=' + GHL_LOCATION_ID + '&query=' + encodeURIComponent((p.first || '') + ' ' + (p.last || '')), { headers: h })).json();
    if (sr.contacts && sr.contacts.length > 0) contactId = sr.contacts[0].id;
  } catch(e) {}
  var cp = { locationId: GHL_LOCATION_ID, firstName: p.first || '', lastName: p.last || '', companyName: p.business || '', source: 'ADVISE Tool', tags: ['ADVISE Call', 'SüRJ-' + tierName], customFields: [{ id: GHL_BRIEF_FIELD_ID, value: briefUrl }] };
  try {
    if (contactId) {
      await fetch(GHL_API_BASE + '/contacts/' + contactId, { method: 'PUT', headers: h, body: JSON.stringify(cp) });
    } else {
      var cr = await (await fetch(GHL_API_BASE + '/contacts/', { method: 'POST', headers: h, body: JSON.stringify(cp) })).json();
      contactId = cr.contact ? cr.contact.id : null;
    }
  } catch(e) {}
  if (!contactId) return;
  var note = [
    '=== ADVISE Call — ' + new Date().toLocaleDateString() + ' ===',
    'Rep: ' + (sessionData.createdByName || 'Unknown'),
    'Business: ' + (p.business || '—'),
    '',
    'Monthly Leak: ' + fmtNum(calc.totalMo || 0),
    'Annual Leak: ' + fmtNum(calc.totalAnn || 0),
    'Plan: SüRJ ' + tierName + ' (' + (tierPrices[tier] || 'TBD') + '/mo)',
    '',
    'Brief: ' + briefUrl
  ].join('\n');
  try {
    await fetch(GHL_API_BASE + '/contacts/' + contactId + '/notes', { method: 'POST', headers: h, body: JSON.stringify({ body: note, userId: '' }) });
  } catch(e) {}
}

// ─── NOT FOUND PAGE ───────────────────────────────────────────────────────────

function notFoundHTML(rep) {
  var name = (rep && rep.displayName) ? rep.displayName : 'Steve Wilson';
  var phone = (rep && rep.phone) ? rep.phone : '(405) 913-1956';
  var email = (rep && rep.email) ? rep.email : 'admin@surj.app';
  var phoneClean = phone.replace(/[^0-9]/g, '');
  var first = name.split(' ')[0];
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brief Unavailable \u2014 S\u00fcRJ</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,700;0,900;1,300&family=DM+Sans:wght@300;400;500&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">'
    + '<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#060F18;color:#F0F4F8;font-family:"DM Sans",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background-image:radial-gradient(ellipse at 20% 50%,rgba(107,63,160,0.15),transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(26,138,114,0.1),transparent 50%);}.wrap{max-width:520px;width:100%;text-align:center;}.logo{font-family:"Fraunces",serif;font-size:52px;font-weight:900;background:linear-gradient(135deg,#9B6FD0,#6EDFC8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;}.logo-sub{font-family:"Syne",sans-serif;font-size:9px;font-weight:700;color:#7A9BB5;letter-spacing:3px;text-transform:uppercase;margin-bottom:40px;}.card{background:#0a1624;border:1px solid rgba(110,223,200,0.12);border-radius:20px;padding:40px 36px;}.icon{font-size:40px;margin-bottom:16px;}h1{font-family:"Fraunces",serif;font-size:28px;font-weight:900;margin-bottom:8px;line-height:1.2;}h1 em{font-style:italic;font-weight:300;color:#9B6FD0;}.desc{font-size:15px;color:#7A9BB5;line-height:1.7;margin-bottom:32px;}.divider{height:1px;background:rgba(110,223,200,0.1);margin:28px 0;}.rep-label{font-family:"Syne",sans-serif;font-size:9px;font-weight:700;color:#6EDFC8;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;}.rep-name{font-family:"Fraunces",serif;font-size:22px;font-weight:700;margin-bottom:4px;}.rep-title{font-size:12px;color:#7A9BB5;margin-bottom:20px;}.cta-row{display:flex;flex-direction:column;gap:10px;}.cta-call{display:block;padding:16px 24px;background:linear-gradient(135deg,#C8860A,#F5C842);border-radius:10px;color:#060F18;font-family:"Syne",sans-serif;font-size:13px;font-weight:800;text-decoration:none;}.cta-email{display:block;padding:14px 24px;background:transparent;border:1px solid rgba(110,223,200,0.25);border-radius:10px;color:#6EDFC8;font-family:"Syne",sans-serif;font-size:12px;font-weight:700;text-decoration:none;}.cta-sms{display:block;padding:14px 24px;background:transparent;border:1px solid rgba(107,63,160,0.3);border-radius:10px;color:#9B6FD0;font-family:"Syne",sans-serif;font-size:12px;font-weight:700;text-decoration:none;}.footer-note{font-size:11px;color:#4a6a80;margin-top:24px;line-height:1.6;}</style>'
    + '</head><body><div class="wrap"><div class="logo">S\u00fcRJ</div><div class="logo-sub">Business Growth Platform</div>'
    + '<div class="card"><div class="icon">\uD83D\uDCCB</div><h1>Your brief is <em>temporarily</em> unavailable</h1>'
    + '<p class="desc">The link you followed may have expired or the document is being updated. ' + first + ' can resend it in seconds \u2014 reach out directly below.</p>'
    + '<div class="divider"></div><div class="rep-label">Your S\u00fcRJ Representative</div>'
    + '<div class="rep-name">' + name + '</div><div class="rep-title">Recherch\u00e9 Merchant Solutions</div>'
    + '<div class="cta-row">'
    + '<a href="tel:' + phoneClean + '" class="cta-call">\uD83D\uDCDE Call ' + first + ' \u2014 ' + phone + '</a>'
    + '<a href="mailto:' + email + '?subject=My%20S%C3%BCRj%20Brief&body=Hi%20' + first + '%2C%20my%20brief%20link%20is%20not%20working.%20Can%20you%20resend%20it%3F" class="cta-email">\u2709 Email \u2014 ' + email + '</a>'
    + '<a href="sms:' + phoneClean + '" class="cta-sms">\uD83D\uDCAC Text ' + first + ' directly</a>'
    + '</div></div>'
    + '<p class="footer-note">surj.app \u00b7 Powered by Recherch\u00e9 Merchant Solutions \u00b7 Edmond, Oklahoma</p>'
    + '</div></body></html>';
}
