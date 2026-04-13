// SüRJ ADVISE Tool — Cloudflare Worker
// Handles routing, KV session storage, and GHL webhook integration

const GHL_LOCATION_ID = '4RRtueNq1LIvO5VWxWVB';
const GHL_API_KEY = 'pit-94230723-2b35-4ca1-bd78-01078416b8b1';
const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_BRIEF_FIELD_ID = 'REPLACE_WITH_YOUR_CUSTOM_FIELD_ID'; // paste from GHL after you create the field
const GHL_PIPELINE_ID = 'REPLACE_WITH_PIPELINE_ID'; // from GHL Opportunities settings
const GHL_STAGE_PROPOSAL_SENT = 'Proposal Sent'; // exact stage name from your pipeline

// ─── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── API Routes ──────────────────────────────────────────────────────────
    if (path === '/api/save' && method === 'POST') {
      return handleSave(request, env, corsHeaders);
    }

    if (path.startsWith('/api/session/') && method === 'GET') {
      const id = path.replace('/api/session/', '');
      return handleGetSession(id, env, corsHeaders);
    }

    if (path.startsWith('/api/brief/') && method === 'POST') {
      const id = path.replace('/api/brief/', '');
      return handleGenerateBrief(id, request, env, corsHeaders);
    }

    if (path === '/api/sessions' && method === 'GET') {
      return handleListSessions(env, corsHeaders);
    }

    // ── Page Routes ─────────────────────────────────────────────────────────
    if (path === '/' || path === '/index.html') {
      return serveAsset('index.html', env);
    }

    if (path === '/dashboard' || path === '/dashboard.html') {
      return serveAsset('dashboard.html', env);
    }

    if (path.startsWith('/brief/')) {
      return serveBriefPage(path.replace('/brief/', ''), env);
    }

    // Static assets
    if (path.startsWith('/public/')) {
      return serveAsset(path.replace('/public/', ''), env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ─── SAVE SESSION ──────────────────────────────────────────────────────────────
async function handleSave(request, env, headers) {
  try {
    const body = await request.json();
    const { sessionId, data } = body;

    if (!sessionId || !data) {
      return jsonResponse({ error: 'Missing sessionId or data' }, 400, headers);
    }

    // Save full session data
    await env.ADVISE_SESSIONS.put(
      'session:' + sessionId + ':data',
      JSON.stringify(data),
      { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
    );

    // Save metadata separately for dashboard listing
    const meta = {
      id: sessionId,
      prospect: data.prospect || {},
      tier: data.selectedTier || '',
      outcome: data.outcome || '',
      totalLeak: data.calc ? data.calc.totalAnn : 0,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      briefGenerated: false
    };

    await env.ADVISE_SESSIONS.put(
      'session:' + sessionId + ':meta',
      JSON.stringify(meta),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    return jsonResponse({ ok: true, sessionId }, 200, headers);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, headers);
  }
}

// ─── GET SESSION ───────────────────────────────────────────────────────────────
async function handleGetSession(id, env, headers) {
  try {
    const raw = await env.ADVISE_SESSIONS.get('session:' + id + ':data');
    if (!raw) return jsonResponse({ error: 'Session not found' }, 404, headers);
    return jsonResponse(JSON.parse(raw), 200, headers);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, headers);
  }
}

// ─── LIST SESSIONS (Dashboard) ─────────────────────────────────────────────────
async function handleListSessions(env, headers) {
  try {
    const list = await env.ADVISE_SESSIONS.list({ prefix: 'session:', limit: 100 });
    const metas = [];

    for (const key of list.keys) {
      if (key.name.endsWith(':meta')) {
        const raw = await env.ADVISE_SESSIONS.get(key.name);
        if (raw) metas.push(JSON.parse(raw));
      }
    }

    // Sort newest first
    metas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return jsonResponse({ sessions: metas }, 200, headers);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, headers);
  }
}

// ─── GENERATE BRIEF + GHL WEBHOOK ─────────────────────────────────────────────
async function handleGenerateBrief(id, request, env, headers) {
  try {
    const body = await request.json();
    const { briefHTML, sessionData } = body;

    // Store brief HTML
    await env.ADVISE_SESSIONS.put(
      'session:' + id + ':brief',
      briefHTML,
      { expirationTtl: 60 * 60 * 24 * 365 } // 1 year
    );

    // Update meta with brief generated flag
    const metaRaw = await env.ADVISE_SESSIONS.get('session:' + id + ':meta');
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      meta.briefGenerated = true;
      meta.briefUrl = 'https://advise.surj.app/brief/' + id;
      await env.ADVISE_SESSIONS.put('session:' + id + ':meta', JSON.stringify(meta));
    }

    // Fire GHL integration (non-blocking — don't fail if GHL is slow)
    const briefUrl = 'https://advise.surj.app/brief/' + id;
    env.ctx ? env.ctx.waitUntil(fireGHLIntegration(sessionData, briefUrl)) : null;
    // Also fire without ctx just in case
    fireGHLIntegration(sessionData, briefUrl).catch(() => {});

    return jsonResponse({ ok: true, briefUrl }, 200, headers);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, headers);
  }
}

// ─── GHL INTEGRATION ──────────────────────────────────────────────────────────
async function fireGHLIntegration(sessionData, briefUrl) {
  const p = sessionData.prospect || {};
  const calc = sessionData.calc || {};
  const tier = sessionData.selectedTier || '';
  const tierName = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'TBD';
  const tierPrices = { launch: '$297', grow: '$497', scale: '$797' };

  const headers = {
    'Authorization': 'Bearer ' + GHL_API_KEY,
    'Content-Type': 'application/json',
    'Version': '2021-07-28'
  };

  // 1. Search for existing contact by name + business
  let contactId = null;
  try {
    const searchRes = await fetch(
      GHL_API_BASE + '/contacts/?locationId=' + GHL_LOCATION_ID + '&query=' + encodeURIComponent(p.first + ' ' + p.last),
      { headers }
    );
    const searchData = await searchRes.json();
    if (searchData.contacts && searchData.contacts.length > 0) {
      contactId = searchData.contacts[0].id;
    }
  } catch (e) {}

  // 2. Create or update contact
  const contactPayload = {
    locationId: GHL_LOCATION_ID,
    firstName: p.first || '',
    lastName: p.last || '',
    companyName: p.business || '',
    source: 'ADVISE Tool',
    tags: ['ADVISE Call', 'SüRJ-' + tierName],
    customFields: [
      { id: GHL_BRIEF_FIELD_ID, value: briefUrl }
    ]
  };

  try {
    if (contactId) {
      await fetch(GHL_API_BASE + '/contacts/' + contactId, {
        method: 'PUT',
        headers,
        body: JSON.stringify(contactPayload)
      });
    } else {
      const createRes = await fetch(GHL_API_BASE + '/contacts/', {
        method: 'POST',
        headers,
        body: JSON.stringify(contactPayload)
      });
      const createData = await createRes.json();
      contactId = createData.contact ? createData.contact.id : null;
    }
  } catch (e) {}

  if (!contactId) return;

  // 3. Add structured note to contact
  const noteLines = [
    '=== ADVISE Discovery Call — ' + new Date().toLocaleDateString() + ' ===',
    '',
    'Business: ' + (p.business || '—'),
    'Industry: ' + (p.industry || '—'),
    '',
    '--- FINANCIALS ---',
    'Annual Revenue: ' + fmtNum(calc.revenue || 0),
    'Monthly Leads: ' + (sessionData.kpi ? sessionData.kpi.leads : '—'),
    'Quotes/Mo: ' + (sessionData.kpi ? sessionData.kpi.quotes : '—'),
    'Closed/Mo: ' + (sessionData.kpi ? sessionData.kpi.closed : '—'),
    'Avg Deal Value: ' + fmtNum(sessionData.kpi ? sessionData.kpi.deal : 0),
    '',
    '--- PROFIT LEAK ---',
    'Conversion Gap (mo): ' + fmtNum(calc.convLossMo || 0),
    'Owner Time Cost (yr): ' + fmtNum(calc.ownerCost || 0),
    'Referral Gap (yr): ' + fmtNum(calc.refCost || 0),
    'TOTAL MONTHLY LEAK: ' + fmtNum(calc.totalMo || 0),
    'TOTAL ANNUAL LEAK: ' + fmtNum(calc.totalAnn || 0),
    '',
    '--- RECOMMENDED PLAN ---',
    'Tier: SüRJ ' + tierName + ' (' + (tierPrices[tier] || 'TBD') + '/mo)',
    '',
    '--- BRIEF ---',
    'Full brief: ' + briefUrl,
    ''
  ].join('\n');

  try {
    await fetch(GHL_API_BASE + '/contacts/' + contactId + '/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: noteLines, userId: '' })
    });
  } catch (e) {}

  // 4. Create or update opportunity — move to Proposal Sent
  try {
    const oppPayload = {
      locationId: GHL_LOCATION_ID,
      name: (p.business || p.first + ' ' + p.last) + ' — SüRJ ' + tierName,
      contactId: contactId,
      pipelineStageId: GHL_STAGE_PROPOSAL_SENT,
      status: 'open',
      monetaryValue: tierPrices[tier] ? parseInt(tierPrices[tier].replace('$','')) : 297,
      source: 'ADVISE Tool'
    };

    // Search for existing opportunity first
    const oppSearch = await fetch(
      GHL_API_BASE + '/opportunities/search?location_id=' + GHL_LOCATION_ID + '&contact_id=' + contactId,
      { headers }
    );
    const oppData = await oppSearch.json();

    if (oppData.opportunities && oppData.opportunities.length > 0) {
      const oppId = oppData.opportunities[0].id;
      await fetch(GHL_API_BASE + '/opportunities/' + oppId, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ pipelineStageId: GHL_STAGE_PROPOSAL_SENT })
      });
    } else {
      await fetch(GHL_API_BASE + '/opportunities/', {
        method: 'POST',
        headers,
        body: JSON.stringify(oppPayload)
      });
    }
  } catch (e) {}
}

// ─── SERVE BRIEF PAGE ──────────────────────────────────────────────────────────
async function serveBriefPage(id, env) {
  try {
    const brief = await env.ADVISE_SESSIONS.get('session:' + id + ':brief');
    if (!brief) {
      return new Response(notFoundHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    return new Response(brief, {
      headers: { 'Content-Type': 'text/html' }
    });
  } catch (e) {
    return new Response('Error loading brief', { status: 500 });
  }
}

// ─── SERVE STATIC ASSET ────────────────────────────────────────────────────────
async function serveAsset(filename, env) {
  try {
    const asset = await env.ASSETS.fetch('https://assets/' + filename);
    return asset;
  } catch (e) {
    return new Response('Asset not found: ' + filename, { status: 404 });
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '$0';
  return '$' + Math.round(n).toLocaleString();
}

function notFoundHTML() {
  return '<!DOCTYPE html><html><head><title>Brief Not Found</title><style>body{background:#060F18;color:#F0F4F8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;}</style></head><body><div><h1 style="font-size:48px;margin-bottom:16px;">SüRJ</h1><p style="color:#7A9BB5;">This brief link has expired or does not exist.</p><p style="margin-top:24px;"><a href="https://surj.app" style="color:#6EDFC8;">Return to surj.app</a></p></div></body></html>';
}
