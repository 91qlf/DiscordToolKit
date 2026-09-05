// ==UserScript==
// @name         Discord Toolkit — Search & Purge
// @namespace    discord-toolkit
// @version      8.0
// @description  Recherche universelle, suppression en masse, gestion des DM, export de salon en HTML et sortie de serveurs en masse — by Eren
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/91qlf/DiscordToolKit/refs/heads/main/Discord%20ToolKit.js
// @downloadURL  https://raw.githubusercontent.com/91qlf/DiscordToolKit/refs/heads/main/Discord%20ToolKit.js
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = 'https://discord.com/api/v9';
  let searchRunning = false;
  let searchStop = false;
  let purgeRunning = false;
  let purgeStop = false;
  let exportRunning = false;
  let exportStop = false;
  let guildsLeaveRunning = false;
  let me = null;

  // ================= RÉCUPÉRATION DU TOKEN =================
  // Discord bloque la lecture directe de localStorage.token depuis 2022.
  // Méthode 1 (fiable) : passer par les modules webpack internes du client.
  // Méthode 2 (fallback) : ancienne technique par iframe.

  function getTokenViaWebpack() {
    try {
      const chunkName = Object.keys(window).find((k) => k.startsWith('webpackChunkdiscord_app'));
      if (!chunkName) return null;
      let wpRequire;
      window[chunkName].push([[Symbol()], {}, (r) => { wpRequire = r; }]);
      window[chunkName].pop();
      if (!wpRequire || !wpRequire.c) return null;
      for (const mod of Object.values(wpRequire.c)) {
        const exp = mod && mod.exports;
        if (!exp) continue;
        const candidate = exp.default && exp.default.getToken ? exp.default : exp.getToken ? exp : null;
        if (candidate && typeof candidate.getToken === 'function') {
          const t = candidate.getToken();
          if (t) return t;
        }
      }
    } catch (e) {
      console.warn('[Toolkit] getTokenViaWebpack a échoué', e);
    }
    return null;
  }

  function getTokenViaIframe() {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const raw = iframe.contentWindow.localStorage.getItem('token');
      document.body.removeChild(iframe);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function looksLikeValidToken(t) {
    return typeof t === 'string' && /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(t);
  }

  function getToken() {
    const t1 = getTokenViaWebpack();
    if (looksLikeValidToken(t1)) return t1;
    const t2 = getTokenViaIframe();
    if (looksLikeValidToken(t2)) return t2;
    return null;
  }

  // ================= UTILITAIRES API =================

  async function apiFetch(url, token, options = {}, onWait) {
    while (true) {
      const res = await fetch(url, {
        ...options,
        headers: { Authorization: token, ...(options.headers || {}) },
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfter = (data.retry_after || 1) * 1000 + 250;
        if (onWait) onWait(retryAfter);
        await sleep(retryAfter);
        continue;
      }
      return res;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchMe(token) {
    const res = await apiFetch(`${API_BASE}/users/@me`, token);
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchMyGuilds(token) {
    const res = await apiFetch(`${API_BASE}/users/@me/guilds`, token);
    if (!res.ok) return [];
    return res.json();
  }

  async function leaveGuild(guildId, token, onWait) {
    return apiFetch(`${API_BASE}/users/@me/guilds/${guildId}`, token, { method: 'DELETE' }, onWait);
  }

  async function fetchMyDMs(token) {
    const res = await apiFetch(`${API_BASE}/users/@me/channels`, token);
    if (!res.ok) return [];
    return res.json();
  }

  function dmLabel(ch) {
    if (ch.name) return ch.name;
    if (Array.isArray(ch.recipients) && ch.recipients.length) {
      return ch.recipients.map((r) => r.username).join(', ');
    }
    return ch.id;
  }

  async function fetchChannelInfo(channelId, token) {
    const res = await apiFetch(`${API_BASE}/channels/${channelId}`, token);
    if (!res.ok) return null;
    return res.json();
  }

  function currentGuildIdFromUrl() {
    const m = window.location.pathname.match(/\/channels\/(\d+)\//);
    return m ? m[1] : '@me';
  }

  // ----- Profil / badges -----
  const BADGE_FLAGS = [
    [1 << 0, 'Staff Discord'],
    [1 << 1, 'Partenaire'],
    [1 << 2, "HypeSquad Events"],
    [1 << 3, 'Bug Hunter niveau 1'],
    [1 << 6, 'HypeSquad Bravery'],
    [1 << 7, 'HypeSquad Brilliance'],
    [1 << 8, 'HypeSquad Balance'],
    [1 << 9, 'Early Supporter'],
    [1 << 14, 'Bug Hunter niveau 2'],
    [1 << 16, 'Développeur vérifié'],
    [1 << 17, 'Modérateur certifié'],
    [1 << 18, 'Bot HTTP actif tôt'],
    [1 << 22, 'Actif depuis 2016 (Nitro)'],
  ];
  function decodeBadges(publicFlags) {
    if (!publicFlags) return [];
    return BADGE_FLAGS.filter(([bit]) => (publicFlags & bit) !== 0).map(([, name]) => name);
  }
  function snowflakeToDate(id) {
    try {
      const ms = Number((BigInt(id) >> 22n) + 1420070400000n);
      return new Date(ms);
    } catch (e) {
      return null;
    }
  }

  async function fetchFullProfile(token) {
    const res = await apiFetch(`${API_BASE}/users/@me`, token);
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchMyConnections(token) {
    const res = await apiFetch(`${API_BASE}/users/@me/connections`, token);
    if (!res.ok) return [];
    return res.json();
  }

  // ----- Statut personnalisé -----
  async function setCustomStatus(token, text, emojiName) {
    return apiFetch(`${API_BASE}/users/@me/settings`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_status: text ? { text, emoji_name: emojiName || null, expires_at: null } : null }),
    });
  }

  // ----- Activité personnalisée (Rich Presence) via les modules internes de Discord -----
  function findWebpackModule(predicate) {
    try {
      const chunkName = Object.keys(window).find((k) => k.startsWith('webpackChunkdiscord_app'));
      if (!chunkName) return null;
      let wpRequire;
      window[chunkName].push([[Symbol()], {}, (r) => { wpRequire = r; }]);
      window[chunkName].pop();
      if (!wpRequire || !wpRequire.c) return null;
      for (const mod of Object.values(wpRequire.c)) {
        const exp = mod && mod.exports;
        if (!exp) continue;
        if (exp.default && predicate(exp.default)) return exp.default;
        if (predicate(exp)) return exp;
      }
    } catch (e) {
      console.warn('[Toolkit] findWebpackModule a échoué', e);
    }
    return null;
  }

  function getFluxDispatcher() {
    return findWebpackModule(
      (m) => m && typeof m.dispatch === 'function' && typeof m.subscribe === 'function' && typeof m.isDispatching === 'function'
    );
  }

  function setLocalActivity(activity) {
    const dispatcher = getFluxDispatcher();
    if (!dispatcher) return false;
    dispatcher.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', activity: activity || null, socketId: 'DiscordToolkit' });
    return true;
  }

  function loadSavedStatuses() {
    try {
      return JSON.parse(localStorage.getItem('dtk_saved_statuses') || '[]');
    } catch (e) {
      return [];
    }
  }
  function saveSavedStatuses(list) {
    localStorage.setItem('dtk_saved_statuses', JSON.stringify(list));
  }

  // ----- Amis / relations -----
  async function fetchMyRelationships(token) {
    const res = await apiFetch(`${API_BASE}/users/@me/relationships`, token);
    if (!res.ok) return [];
    return res.json();
  }
  async function removeFriend(userId, token, onWait) {
    return apiFetch(`${API_BASE}/users/@me/relationships/${userId}`, token, { method: 'DELETE' }, onWait);
  }
  async function openOrGetDm(userId, token, onWait) {
    const res = await apiFetch(
      `${API_BASE}/users/@me/channels`,
      token,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: userId }) },
      onWait
    );
    if (!res.ok) return null;
    return res.json();
  }

  // ----- Avatar / bannière -----
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Lecture du fichier impossible'));
      r.readAsDataURL(file);
    });
  }
  async function updateAvatar(token, dataUrl) {
    return apiFetch(`${API_BASE}/users/@me`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: dataUrl }),
    });
  }
  async function updateBanner(token, dataUrl) {
    return apiFetch(`${API_BASE}/users/@me`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banner: dataUrl }),
    });
  }

  async function editMessage(channelId, messageId, token, content) {
    return apiFetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }

  function parseChannelList(raw) {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
  }

  function embedToText(embed) {
    const parts = [];
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.url) parts.push(embed.url);
    if (embed.footer && embed.footer.text) parts.push(embed.footer.text);
    if (embed.author && embed.author.name) parts.push(embed.author.name);
    if (Array.isArray(embed.fields)) {
      for (const f of embed.fields) {
        if (f.name) parts.push(f.name);
        if (f.value) parts.push(f.value);
      }
    }
    return parts.join('\n');
  }

  // ================= MOTEUR DE RECHERCHE =================

  async function* iterateChannelMessages(channelId, token, onWait, onError) {
    let before = null;
    let first = true;
    while (!searchStop) {
      let url = `${API_BASE}/channels/${channelId}/messages?limit=100`;
      if (before) url += `&before=${before}`;
      const res = await apiFetch(url, token, {}, onWait);
      if (!res.ok) {
        if (first && onError) {
          const body = await res.json().catch(() => ({}));
          onError(`Erreur API ${res.status} sur le salon ${channelId} : ${body.message || res.statusText}`);
        }
        return;
      }
      first = false;
      const messages = await res.json();
      if (!Array.isArray(messages) || messages.length === 0) return;
      for (const m of messages) yield m;
      before = messages[messages.length - 1].id;
      if (messages.length < 100) return;
      await sleep(350);
    }
  }

  function messageMatches(msg, opts) {
    const { type, keyword, idStr, authorId, matchMode, caseSensitive } = opts;

    if (authorId && msg.author.id !== authorId) return { match: false };

    const norm = (s) => (caseSensitive ? s : s.toLowerCase());
    const kw = keyword ? norm(keyword) : null;
    const idq = idStr || null;

    let haystacks = [];
    if (type === 'text' || type === 'all') {
      if (msg.content) haystacks.push(msg.content);
    }
    if (type === 'embeds' || type === 'all') {
      if (Array.isArray(msg.embeds)) for (const e of msg.embeds) haystacks.push(embedToText(e));
    }
    if (type === 'attachments' || type === 'all') {
      if (Array.isArray(msg.attachments)) for (const a of msg.attachments) haystacks.push(a.filename + ' ' + a.url);
    }

    if (haystacks.length === 0 && type !== 'all') return { match: false };
    if (type === 'all' && haystacks.length === 0) haystacks = [''];

    const combined = haystacks.join('\n');
    const hay = norm(combined);
    const hasKw = kw ? hay.includes(kw) : null;
    const hasId = idq ? combined.includes(idq) : null;

    let match;
    if (kw && idq) match = matchMode === 'OR' ? hasKw || hasId : hasKw && hasId;
    else if (kw) match = hasKw;
    else if (idq) match = hasId;
    else match = true;

    return { match, snippet: combined.slice(0, 300) };
  }

  async function runSearch(channels, opts, token, onProgress, guildIdOverride) {
    const results = [];
    let scanned = 0;
    const guildId = guildIdOverride || currentGuildIdFromUrl();

    let lastError = null;

    for (const channelId of channels) {
      if (searchStop) break;
      for await (const msg of iterateChannelMessages(
        channelId,
        token,
        (wait) => onProgress({ scanned, found: results.length, status: `Rate limit, pause ${Math.round(wait)}ms...` }),
        (err) => { lastError = err; onProgress({ scanned, found: results.length, status: err, error: true }); }
      )) {
        if (searchStop) break;
        scanned++;
        const r = messageMatches(msg, opts);
        if (r.match) {
          results.push({
            id: msg.id,
            channelId,
            authorTag: msg.author.username + (msg.author.discriminator && msg.author.discriminator !== '0' ? '#' + msg.author.discriminator : ''),
            authorId: msg.author.id,
            timestamp: msg.timestamp,
            content: msg.content || '',
            embedCount: (msg.embeds || []).length,
            attachmentCount: (msg.attachments || []).length,
            snippet: r.snippet,
            link: `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`,
          });
        }
        if (scanned % 20 === 0) {
          onProgress({ scanned, found: results.length, status: `Scan du salon ${channelId}... (${scanned} messages)` });
        }
      }
    }
    if (scanned === 0 && lastError) {
      onProgress({ scanned, found: results.length, status: lastError, error: true });
    } else {
      onProgress({ scanned, found: results.length, status: 'Recherche terminée.' });
    }
    return results;
  }

  async function runPurge(channels, token, myId, onProgress, delayMs) {
    let scanned = 0, deleted = 0, failed = 0;
    let lastError = null;
    for (const channelId of channels) {
      if (purgeStop) break;
      for await (const msg of iterateChannelMessages(
        channelId,
        token,
        (wait) => onProgress({ scanned, deleted, failed, status: `Rate limit, pause ${Math.round(wait)}ms...` }),
        (err) => { lastError = err; onProgress({ scanned, deleted, failed, status: err, error: true }); }
      )) {
        if (purgeStop) break;
        scanned++;
        if (msg.author.id === myId) {
          const res = await apiFetch(
            `${API_BASE}/channels/${channelId}/messages/${msg.id}`,
            token,
            { method: 'DELETE' },
            (wait) => onProgress({ scanned, deleted, failed, status: `Rate limit, pause ${Math.round(wait)}ms...` })
          );
          if (res.ok || res.status === 204) deleted++;
          else if (res.status !== 404) failed++;
          onProgress({ scanned, deleted, failed, status: `Suppression salon ${channelId}... (${deleted} supprimés)` });
          await sleep(delayMs);
        }
      }
    }
    if (scanned === 0 && lastError) {
      onProgress({ scanned, deleted, failed, status: lastError, error: true });
    } else {
      onProgress({ scanned, deleted, failed, status: 'Suppression terminée.' });
    }
    return { scanned, deleted, failed };
  }

  // ================= EXPORT HTML =================

  function avatarUrl(user) {
    if (user.avatar) {
      const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
      return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=80`;
    }
    let idx;
    if (user.discriminator && user.discriminator !== '0') {
      idx = parseInt(user.discriminator, 10) % 5;
    } else {
      try {
        idx = Number((BigInt(user.id) >> 22n) % 6n);
      } catch (e) {
        idx = 0;
      }
    }
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }

  function mdToHtml(content, mentions) {
    let text = escapeHtml(content || '');
    text = text.replace(/```([\s\S]*?)```/g, (m, code) => `<pre class="dexp-codeblock">${code}</pre>`);
    text = text.replace(/`([^`]+)`/g, '<code class="dexp-code">$1</code>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/__(.+?)__/g, '<u>$1</u>');
    text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
    text = text.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => {
      const u = (mentions || []).find((x) => x.id === id);
      return `<span class="dexp-mention">@${u ? escapeHtml(u.username) : 'utilisateur'}</span>`;
    });
    text = text.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="dexp-mention">@rôle</span>');
    text = text.replace(/&lt;#(\d+)&gt;/g, '<span class="dexp-mention">#salon</span>');
    text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  function renderEmbed(e) {
    const color = typeof e.color === 'number' ? '#' + e.color.toString(16).padStart(6, '0') : '#4b4d53';
    let html = `<div class="dexp-embed" style="border-left-color:${color}">`;
    if (e.author && e.author.name) {
      html += `<div class="dexp-embed-author">${e.author.icon_url ? `<img src="${e.author.icon_url}">` : ''}${escapeHtml(e.author.name)}</div>`;
    }
    if (e.title) {
      const t = escapeHtml(e.title);
      html += `<div class="dexp-embed-title">${e.url ? `<a href="${e.url}" target="_blank">${t}</a>` : t}</div>`;
    }
    if (e.description) html += `<div class="dexp-embed-desc">${mdToHtml(e.description, [])}</div>`;
    if (Array.isArray(e.fields) && e.fields.length) {
      html += `<div class="dexp-embed-fields">` + e.fields
        .map((f) => `<div class="dexp-embed-field${f.inline ? ' inline' : ''}"><div class="fn">${escapeHtml(f.name)}</div><div class="fv">${mdToHtml(f.value, [])}</div></div>`)
        .join('') + `</div>`;
    }
    if (e.thumbnail && e.thumbnail.url) html += `<img class="dexp-embed-thumb" src="${e.thumbnail.url}">`;
    if (e.image && e.image.url) html += `<img class="dexp-embed-image" src="${e.image.url}">`;
    if (e.footer && e.footer.text) {
      html += `<div class="dexp-embed-footer">${e.footer.icon_url ? `<img src="${e.footer.icon_url}">` : ''}${escapeHtml(e.footer.text)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  function renderAttachment(a) {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(a.filename || '') || (a.content_type && a.content_type.startsWith('image/'));
    if (isImage) return `<img class="dexp-attach-img" src="${a.url}" alt="${escapeHtml(a.filename || '')}">`;
    return `<a class="dexp-attach-file" href="${a.url}" target="_blank">📎 ${escapeHtml(a.filename || 'fichier')}</a>`;
  }

  function groupMessages(messages) {
    const groups = [];
    let current = null;
    for (const msg of messages) {
      const ts = new Date(msg.timestamp);
      if (
        current &&
        current.authorId === msg.author.id &&
        ts - current.lastTs < 7 * 60 * 1000 &&
        !msg.referenced_message
      ) {
        current.messages.push(msg);
        current.lastTs = ts;
      } else {
        current = { authorId: msg.author.id, author: msg.author, lastTs: ts, messages: [msg] };
        groups.push(current);
      }
    }
    return groups;
  }

  function buildExportHtml(channelName, messages) {
    const groups = groupMessages(messages);
    let lastDay = null;
    let body = '';
    for (const g of groups) {
      const day = g.messages[0].timestamp.slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        body += `<div class="dexp-daydivider"><span>${new Date(g.messages[0].timestamp).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span></div>`;
      }
      const author = g.author;
      const tag = author.username + (author.discriminator && author.discriminator !== '0' ? '#' + author.discriminator : '');
      body += `<div class="dexp-group">
        <img class="dexp-avatar" src="${avatarUrl(author)}" alt="">
        <div class="dexp-group-body">
          <div class="dexp-group-head"><span class="dexp-username">${escapeHtml(tag)}</span><span class="dexp-time">${new Date(g.messages[0].timestamp).toLocaleString('fr-FR')}</span></div>`;
      for (const msg of g.messages) {
        body += `<div class="dexp-msg">`;
        if (msg.content) body += `<div class="dexp-content">${mdToHtml(msg.content, msg.mentions)}</div>`;
        if (Array.isArray(msg.embeds)) for (const e of msg.embeds) body += renderEmbed(e);
        if (Array.isArray(msg.attachments)) for (const a of msg.attachments) body += renderAttachment(a);
        body += `</div>`;
      }
      body += `</div></div>`;
    }

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>#${escapeHtml(channelName)} — export</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#313338; color:#dbdee1; font-family: -apple-system,'Segoe UI','gg sans',Helvetica,sans-serif; font-size:15px; }
  #dexp-header { background:#2b2d31; padding:14px 22px; border-bottom:1px solid #26282c; font-weight:800; font-size:16px; color:#fff; position:sticky; top:0; }
  #dexp-body { max-width:860px; margin:0 auto; padding:12px 22px 60px; }
  .dexp-daydivider { text-align:center; color:#949ba4; font-size:12px; font-weight:700; margin:22px 0 10px; position:relative; }
  .dexp-daydivider::before, .dexp-daydivider::after { content:''; position:absolute; top:50%; width:42%; border-top:1px solid #3f4147; }
  .dexp-daydivider::before { left:0; } .dexp-daydivider::after { right:0; }
  .dexp-group { display:flex; gap:16px; padding:8px 8px; border-radius:6px; }
  .dexp-group:hover { background:rgba(4,4,5,0.07); }
  .dexp-avatar { width:40px; height:40px; border-radius:50%; flex-shrink:0; margin-top:2px; }
  .dexp-group-body { flex:1; min-width:0; }
  .dexp-group-head { display:flex; align-items:baseline; gap:8px; margin-bottom:2px; }
  .dexp-username { font-weight:700; color:#f2f3f5; }
  .dexp-time { font-size:11px; color:#949ba4; }
  .dexp-msg { line-height:1.4; }
  .dexp-content { white-space:normal; word-break:break-word; }
  .dexp-mention { background:rgba(88,101,242,0.3); color:#c9cdfb; border-radius:3px; padding:0 2px; font-weight:600; }
  .dexp-code { background:#2b2d31; border:1px solid #1e1f22; border-radius:4px; padding:0 4px; font-family:monospace; font-size:13px; }
  .dexp-codeblock { background:#2b2d31; border:1px solid #1e1f22; border-radius:6px; padding:8px 10px; font-family:monospace; font-size:13px; overflow-x:auto; }
  .dexp-attach-img { max-width:400px; max-height:300px; border-radius:8px; margin-top:6px; display:block; }
  .dexp-attach-file { display:inline-flex; align-items:center; gap:6px; background:#2b2d31; border:1px solid #3f4147; border-radius:8px; padding:8px 12px; margin-top:6px; color:#00a8fc; text-decoration:none; font-size:13px; }
  .dexp-embed { border-left:4px solid #4b4d53; background:#2b2d31; border-radius:0 6px 6px 0; padding:10px 14px; margin-top:6px; max-width:480px; }
  .dexp-embed-author { font-size:13px; font-weight:700; color:#f2f3f5; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
  .dexp-embed-author img { width:20px; height:20px; border-radius:50%; }
  .dexp-embed-title { font-weight:700; color:#00a8fc; margin-bottom:4px; }
  .dexp-embed-title a { color:#00a8fc; text-decoration:none; }
  .dexp-embed-desc { font-size:13.5px; color:#dbdee1; }
  .dexp-embed-fields { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .dexp-embed-field { flex:1 1 100%; }
  .dexp-embed-field.inline { flex:1 1 30%; }
  .dexp-embed-field .fn { font-weight:700; font-size:13px; color:#f2f3f5; margin-bottom:2px; }
  .dexp-embed-field .fv { font-size:13px; color:#dbdee1; }
  .dexp-embed-thumb { max-width:80px; max-height:80px; border-radius:4px; float:right; margin-left:10px; }
  .dexp-embed-image { max-width:100%; border-radius:6px; margin-top:8px; display:block; }
  .dexp-embed-footer { display:flex; align-items:center; gap:6px; font-size:11.5px; color:#949ba4; margin-top:8px; }
  .dexp-embed-footer img { width:16px; height:16px; border-radius:50%; }
  a { color:#00a8fc; }
</style>
</head>
<body>
  <div id="dexp-header">#${escapeHtml(channelName)} — export généré le ${new Date().toLocaleString('fr-FR')} (${messages.length} message${messages.length > 1 ? 's' : ''})</div>
  <div id="dexp-body">${body || '<p style="text-align:center;color:#949ba4;margin-top:40px;">Aucun message.</p>'}</div>
</body>
</html>`;
  }

  // ================= INTERFACE =================

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes dtk-fadein { from { opacity:0; transform: translateY(10px) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
      @keyframes dtk-pop { 0% { transform: scale(.85); opacity:0; } 100% { transform: scale(1); opacity:1; } }
      @keyframes dtk-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(88,101,242,.55); } 50% { box-shadow: 0 0 0 8px rgba(88,101,242,0); } }
      @keyframes dtk-spin { to { transform: rotate(360deg); } }

      #dtk-toggle {
        border: none; cursor:pointer; background: transparent; padding:0;
        width:24px; height:24px; display:flex; align-items:center; justify-content:center;
        color:#b5bac1; transition: color .15s ease; flex-shrink:0;
      }
      #dtk-toggle svg { width:20px; height:20px; }
      #dtk-toggle:hover { color:#fff; }
      #dtk-toggle:active { color:#dbdee1; }
      #dtk-toggle.dtk-toggle-floating {
        position: fixed; top:14px; right:210px; z-index:999998;
        width:32px; height:32px; border-radius:8px; background: rgba(30,31,34,0.92);
        box-shadow: 0 2px 10px rgba(0,0,0,0.4); color:#dbdee1;
      }
      #dtk-toggle.dtk-toggle-floating:hover { background: rgba(45,46,50,0.95); color:#fff; }

      #dtk-panel {
        position: fixed; bottom: 90px; right: 22px; width: 460px; max-height: 80vh;
        background: linear-gradient(180deg, rgba(24,25,28,.92), rgba(18,19,22,.94));
        backdrop-filter: blur(24px) saturate(160%);
        -webkit-backdrop-filter: blur(24px) saturate(160%);
        color: #e4e6ea; font-family: -apple-system, 'Segoe UI', 'gg sans', Helvetica, sans-serif;
        border-radius: 20px; border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(139,92,246,0.06), inset 0 1px 0 rgba(255,255,255,0.04);
        z-index: 999999; display: none; flex-direction: column; overflow: hidden; font-size: 13px;
        animation: dtk-fadein .22s cubic-bezier(.16,1,.3,1);
      }
      #dtk-panel::before {
        content:''; position:absolute; top:0; left:0; right:0; height:2px;
        background: linear-gradient(90deg,#6366f1,#8b5cf6,#ec4899,#6366f1);
        background-size: 300% 100%; animation: dtk-shift 5s linear infinite;
      }
      @keyframes dtk-shift { to { background-position: 300% 0; } }

      #dtk-header {
        padding: 16px 18px 14px; display:flex; justify-content:space-between; align-items:center;
        cursor: move; border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      #dtk-header .dtk-title { display:flex; align-items:center; gap:10px; }
      #dtk-header .dtk-title-icon {
        width:30px; height:30px; border-radius:9px; display:flex; align-items:center; justify-content:center;
        background: linear-gradient(140deg,#6366f1,#ec4899); box-shadow: 0 3px 10px rgba(139,92,246,0.4); color:#fff;
      }
      #dtk-header .dtk-title-icon svg { width:16px; height:16px; }
      #dtk-header .dtk-title-text { display:flex; flex-direction:column; line-height:1.25; }
      #dtk-header .dtk-title-text b { font-size:14.5px; font-weight:800; letter-spacing:.2px; }
      #dtk-header .dtk-title-text span { font-size:10px; color:#8b8f98; font-weight:600; display:flex; align-items:center; gap:4px; }
      #dtk-header .dtk-dot { width:6px; height:6px; border-radius:50%; background:#23a55a; box-shadow:0 0 6px #23a55a; }
      #dtk-header .dtk-close {
        cursor:pointer; color:#8b8f98; font-size:13px; width:26px; height:26px; display:flex;
        align-items:center; justify-content:center; border-radius:8px; transition: all .12s ease;
        background: rgba(255,255,255,0.03);
      }
      #dtk-header .dtk-close:hover { color:#f5b3b3; background: rgba(218,55,60,0.15); }

      #dtk-tabs { display:flex; flex-wrap:wrap; gap:4px; padding: 12px 16px 10px; position:relative; z-index:2; box-shadow: 0 8px 12px -6px rgba(0,0,0,0.45); }
      .dtk-tab {
        flex:1 1 30%; min-width:80px; text-align:center; padding:8px 2px; cursor:pointer; font-weight:700;
        color:#8b8f98; font-size:11px; border-radius: 10px; transition: all .18s ease; position:relative;
        display:flex; align-items:center; justify-content:center; gap:5px; white-space:nowrap;
      }
      .dtk-tab:hover { color:#dbdee1; background: rgba(255,255,255,0.03); }
      .dtk-tab.active { color:#fff; background: linear-gradient(135deg, rgba(99,102,241,0.22), rgba(236,72,153,0.14)); box-shadow: inset 0 0 0 1px rgba(139,92,246,0.35); }

      .dtk-list { margin-top:12px; max-height:200px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding-right:3px; }
      .dtk-list-item {
        display:flex; align-items:center; gap:9px; background: rgba(255,255,255,0.03);
        border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:8px 10px; font-size:12px; color:#dbdee1;
      }
      .dtk-list-item input[type=checkbox] {
        appearance:none; -webkit-appearance:none; width:18px; height:18px; border-radius:6px;
        flex-shrink:0; cursor:pointer; background:rgba(255,255,255,0.05);
        border:1.5px solid rgba(255,255,255,0.18); position:relative; transition: all .15s ease;
      }
      .dtk-list-item input[type=checkbox]:hover:not(:disabled) { border-color: rgba(139,92,246,0.55); background: rgba(139,92,246,0.08); }
      .dtk-list-item input[type=checkbox]:checked {
        background: linear-gradient(135deg,#6366f1,#ec4899); border-color: transparent;
        box-shadow: 0 2px 8px rgba(139,92,246,0.45);
      }
      .dtk-list-item input[type=checkbox]:checked::after {
        content:''; position:absolute; left:5px; top:1px; width:5px; height:9px;
        border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
      }
      .dtk-list-item input[type=checkbox]:disabled { cursor:not-allowed; opacity:.4; }
      .dtk-list-item .sub { color:#5c5f66; font-size:10px; margin-left:auto; }
      .dtk-list-item.disabled { opacity:.45; }

      #dtk-body { padding: 6px 18px 6px; overflow-y: auto; position:relative; z-index:1; }
      #dtk-body::-webkit-scrollbar, #dtk-results::-webkit-scrollbar, .dtk-list::-webkit-scrollbar { width: 7px; }
      #dtk-body::-webkit-scrollbar-thumb, #dtk-results::-webkit-scrollbar-thumb, .dtk-list::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg,#8b5cf6,#ec4899); border-radius:8px; border:1px solid rgba(0,0,0,0.15);
      }
      #dtk-body::-webkit-scrollbar-thumb:hover, #dtk-results::-webkit-scrollbar-thumb:hover, .dtk-list::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(180deg,#a78bfa,#f472b6);
      }
      #dtk-body::-webkit-scrollbar-track, #dtk-results::-webkit-scrollbar-track, .dtk-list::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.03); border-radius:8px;
      }
      #dtk-body, #dtk-results, .dtk-list { scrollbar-width: thin; scrollbar-color: #8b5cf6 rgba(255,255,255,0.03); }

      .dtk-panel-tab { display:none; }
      .dtk-panel-tab.active { display:block; animation: dtk-fadein .16s ease; }

      #dtk-body label {
        display:flex; align-items:center; gap:5px; margin-top:12px; margin-bottom:5px;
        color:#8b8f98; font-size:10px; text-transform:uppercase; letter-spacing:.6px; font-weight:800;
      }
      #dtk-body input[type=text], #dtk-body select, #dtk-body textarea {
        width:100%; box-sizing:border-box; background: rgba(255,255,255,0.035);
        border:1px solid rgba(255,255,255,0.07); color:#e4e6ea; padding:9px 11px; border-radius:9px;
        font-size:12.5px; font-family:inherit; transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
      }
      #dtk-body textarea { resize: vertical; min-height: 42px; }
      #dtk-body input::placeholder, #dtk-body textarea::placeholder { color: #5c5f66; }
      #dtk-body input:focus, #dtk-body select:focus, #dtk-body textarea:focus {
        outline:none; border-color:#8b5cf6; background: rgba(139,92,246,0.06); box-shadow: 0 0 0 3px rgba(139,92,246,0.14);
      }
      #dtk-body select { appearance:none; -webkit-appearance:none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M0 0l5 6 5-6z' fill='%238b8f98'/></svg>");
        background-repeat:no-repeat; background-position: right 12px center; padding-right: 28px;
      }

      .dtk-row { display:flex; gap:8px; }
      .dtk-row > div { flex:1; }
      .dtk-check { display:flex; align-items:center; gap:7px; margin-top:12px; font-size:12px; color:#dbdee1; }
      .dtk-check input[type=checkbox] {
        appearance:none; -webkit-appearance:none; width:16px; height:16px; border-radius:5px;
        cursor:pointer; background:rgba(255,255,255,0.05); border:1.5px solid rgba(255,255,255,0.18);
        position:relative; transition: all .15s ease; flex-shrink:0;
      }
      .dtk-check input[type=checkbox]:hover { border-color: rgba(139,92,246,0.55); background: rgba(139,92,246,0.08); }
      .dtk-check input[type=checkbox]:checked {
        background: linear-gradient(135deg,#6366f1,#ec4899); border-color: transparent;
        box-shadow: 0 2px 8px rgba(139,92,246,0.45);
      }
      .dtk-check input[type=checkbox]:checked::after {
        content:''; position:absolute; left:4.5px; top:1px; width:4px; height:8px;
        border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
      }

      .dtk-btnrow { display:flex; gap:8px; margin-top:14px; }
      .dtk-btn {
        flex:1; padding:10px 0; border:none; border-radius:9px; cursor:pointer; font-weight:700;
        font-size:12.5px; transition: filter .12s ease, transform .08s ease, box-shadow .15s ease;
        display:flex; align-items:center; justify-content:center; gap:6px;
      }
      .dtk-btn svg { width:15px; height:15px; flex-shrink:0; display:block; }
      .dtk-btn:hover:not(:disabled) { filter: brightness(1.14); }
      .dtk-btn:active:not(:disabled) { transform: scale(.96); }
      .dtk-btn.primary { background: linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; box-shadow: 0 4px 14px rgba(99,102,241,0.35); }
      .dtk-btn.stop { background: rgba(255,255,255,0.06); color:#dbdee1; }
      .dtk-btn.danger { background: linear-gradient(135deg,#ef4444,#dc2626); color:#fff; box-shadow: 0 4px 14px rgba(239,68,68,0.3); }
      .dtk-btn.ghost { background: rgba(255,255,255,0.05); color:#dbdee1; }
      .dtk-btn:disabled { opacity:.35; cursor:not-allowed; filter:none; box-shadow:none; }

      .dtk-statusline {
        margin-top:11px; font-size:11.5px; color:#c4b5fd; min-height:14px; line-height:1.5;
        display:flex; align-items:center; gap:8px; background:transparent;
        border:1px solid transparent; border-radius:9px; padding:0 2px;
        transition: background .15s ease, border-color .15s ease, padding .15s ease;
      }
      .dtk-statusline.filled { background: rgba(139,92,246,0.08); border-color: rgba(139,92,246,0.2); padding:8px 12px; }
      .dtk-statusline.error { color:#f5b3b3; }
      .dtk-statusline.filled.error { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.25); }
      .dtk-spinner {
        width:11px; height:11px; border-radius:50%; border:2px solid rgba(139,92,246,0.25);
        border-top-color:#8b5cf6; animation: dtk-spin .7s linear infinite; flex-shrink:0; display:none;
      }
      .dtk-spinner.on { display:inline-block; }

      .dtk-stats { display:flex; gap:8px; margin-top:12px; }
      .dtk-stat {
        flex:1; background: rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.06); border-radius:10px;
        padding:10px; text-align:center;
      }
      .dtk-stat .n { font-size:19px; font-weight:800; color:#fff; background: linear-gradient(135deg,#a5b4fc,#f0abfc); -webkit-background-clip:text; background-clip:text; color:transparent; }
      .dtk-stat .l { font-size:9px; color:#8b8f98; text-transform:uppercase; margin-top:3px; letter-spacing:.5px; font-weight:700; }

      #dtk-results { margin-top:12px; max-height:230px; overflow-y:auto; padding-right:3px; display:flex; flex-direction:column; gap:7px; }
      .dtk-result {
        background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-left:3px solid #8b5cf6;
        border-radius:9px; padding:9px 11px; font-size:11.5px; transition: border-color .15s ease, background .15s ease;
      }
      .dtk-result:hover { background: rgba(139,92,246,0.06); border-left-color:#ec4899; }
      .dtk-result .meta { color:#8b8f98; font-size:10.5px; margin-bottom:4px; display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
      .dtk-badge { background: rgba(139,92,246,0.18); color:#c4b5fd; padding:1px 6px; border-radius:5px; font-size:9.5px; font-weight:700; }
      .dtk-result .snippet { color:#dbdee1; white-space: pre-wrap; word-break: break-word; line-height:1.45; }
      .dtk-result a { color:#a78bfa; text-decoration:none; font-weight:700; font-size:11px; }
      .dtk-result a:hover { text-decoration:underline; color:#ec4899; }
      .dtk-empty { text-align:center; color:#5c5f66; font-size:11.5px; padding: 18px 0; }

      .dtk-warning {
        background: linear-gradient(135deg, rgba(239,68,68,0.13), rgba(239,68,68,0.04));
        border:1px solid rgba(239,68,68,0.4); color:#fca5a5;
        padding:11px 13px; border-radius:10px; font-size:11.5px; margin-top:2px; line-height:1.55;
      }

      .dtk-select { position:relative; }
      .dtk-select-trigger {
        width:100%; display:flex; align-items:center; justify-content:space-between; gap:8px;
        background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:9px;
        padding:9px 12px; font-size:12.5px; color:#dbdee1; cursor:pointer; font-family:inherit; text-align:left;
        transition: all .15s ease; height:38px; box-sizing:border-box;
      }
      .dtk-select-trigger:hover { border-color: rgba(139,92,246,0.45); background: rgba(139,92,246,0.07); }
      .dtk-select.open .dtk-select-trigger { border-color:#8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,0.15); }
      .dtk-select-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
      .dtk-select-chevron { color:#8b8f98; flex-shrink:0; transition: transform .15s ease; }
      .dtk-select.open .dtk-select-chevron { transform: rotate(180deg); color:#c4b5fd; }
      .dtk-select-list {
        position:absolute; top:calc(100% + 6px); left:0; right:0; background:#1e1f22;
        border:1px solid rgba(139,92,246,0.3); border-radius:10px; padding:5px; z-index:30;
        max-height:200px; overflow-y:auto; box-shadow: 0 10px 30px rgba(0,0,0,0.55); display:none;
      }
      .dtk-select.open .dtk-select-list { display:block; animation: dtk-fadein .12s ease; }
      .dtk-select-item { padding:8px 10px; border-radius:7px; font-size:12.5px; color:#dbdee1; cursor:pointer; transition: all .12s ease; }
      .dtk-select-item:hover { background: rgba(139,92,246,0.16); color:#fff; }
      .dtk-select-item.selected { background: linear-gradient(135deg, rgba(99,102,241,0.3), rgba(236,72,153,0.2)); color:#fff; font-weight:700; }
      .dtk-select-item.disabled { opacity:.4; cursor:not-allowed; }
      .dtk-select-list::-webkit-scrollbar { width:6px; }
      .dtk-select-list::-webkit-scrollbar-thumb { background: linear-gradient(180deg,#8b5cf6,#ec4899); border-radius:6px; }
      .dtk-select-list::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); }

      .dtk-filepicker { display:flex; align-items:center; gap:10px; margin-top:4px; flex-wrap:wrap; }
      .dtk-filepicker-label { font-size:11.5px; color:#8b8f98; }

      #dtk-footer {
        padding: 10px 18px; text-align:center; font-size: 10.5px; color:#5c5f66;
        border-top:1px solid rgba(255,255,255,0.06); letter-spacing:.3px;
        display:flex; align-items:center; justify-content:center; gap:5px;
      }
      #dtk-footer b { color:#8b8f98; font-weight:800; }
      #dtk-footer .dtk-heart { color:#ec4899; animation: dtk-pulse-heart 1.6s ease infinite; display:inline-block; }
      @keyframes dtk-pulse-heart { 0%,100% { transform: scale(1); } 50% { transform: scale(1.25); } }
    `;
    document.head.appendChild(style);

    const searchIcon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7" stroke="white" stroke-width="2.2"/><path d="M20 20L16.5 16.5" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    const trashIcon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 7L7 20H17L18 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 7V4H15V7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    const boltIcon = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 3L4 14H11L10 21L20 9H13L13 3Z" fill="currentColor"/></svg>`;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'dtk-toggle';
    toggleBtn.innerHTML = boltIcon;
    toggleBtn.title = 'Discord Toolkit';

    function isDiscordAppLoaded() {
      // Ces éléments n'existent (avec du contenu réel) qu'une fois le splash de chargement disparu,
      // contrairement à de simples conteneurs vides déjà présents derrière l'écran "DID YOU KNOW".
      if (document.querySelector('[data-list-id="guildsnav"] [data-list-item-id]')) return true;
      if (document.querySelector('[aria-label="Inbox" i], [aria-label="Boîte de réception" i], [aria-label="Boite de reception" i]')) return true;
      return false;
    }

    function tryMountToggle() {
      const toolbar = document.querySelector('[class*="toolbar_"]');
      if (toolbar && toolbar !== toggleBtn.parentElement) {
        toolbar.insertBefore(toggleBtn, toolbar.firstChild);
        toggleBtn.classList.remove('dtk-toggle-floating');
        return true;
      }
      return !!toolbar;
    }

    let mountAttempts = 0;
    const mountRetry = setInterval(() => {
      mountAttempts++;
      if (!isDiscordAppLoaded()) return; // toujours sur l'écran de chargement, on ne fait rien

      const mounted = document.body.contains(toggleBtn);
      if (tryMountToggle()) return;
      if (!mounted) {
        document.body.appendChild(toggleBtn);
        toggleBtn.classList.add('dtk-toggle-floating');
      }
      if (mountAttempts > 400) clearInterval(mountRetry);
    }, 800);

    const panel = document.createElement('div');
    panel.id = 'dtk-panel';
    panel.innerHTML = `
      <div id="dtk-header">
        <div class="dtk-title">
          <div class="dtk-title-icon">${boltIcon}</div>
          <div class="dtk-title-text">
            <b>Discord Toolkit</b>
            <span><span class="dtk-dot"></span>Prêt</span>
          </div>
        </div>
        <div class="dtk-close">✕</div>
      </div>

      <div id="dtk-tabs">
        <div class="dtk-tab active" data-tab="search">🔍 Recherche</div>
        <div class="dtk-tab" data-tab="purge">🗑️ Suppression</div>
        <div class="dtk-tab" data-tab="guilds">🚪 Serveurs</div>
        <div class="dtk-tab" data-tab="closedm">🔒 Fermer DM</div>
        <div class="dtk-tab" data-tab="export">📤 Export</div>
        <div class="dtk-tab" data-tab="profile">🪪 Profil</div>
        <div class="dtk-tab" data-tab="status">🎭 Statuts</div>
        <div class="dtk-tab" data-tab="friends">👥 Amis</div>
        <div class="dtk-tab" data-tab="deadservers">💤 Serveurs morts</div>
        <div class="dtk-tab" data-tab="avatarrotate">🖼️ Avatar/Bannière</div>
        <div class="dtk-tab" data-tab="msgrotate">🔄 Message</div>
      </div>

      <div id="dtk-body">

        <div class="dtk-panel-tab active" id="tab-search">
          <label>Cible</label>
          <select id="s-target">
            <option value="channels">Salon(s) de serveur</option>
            <option value="dm">Messages privés</option>
          </select>

          <div id="s-channels-wrap">
            <label>Salon(s) ciblé(s)</label>
            <textarea id="s-channels" placeholder="ID de salon, ou plusieurs séparés par des virgules"></textarea>
          </div>

          <div id="s-dm-wrap" style="display:none;">
            <div class="dtk-btnrow">
              <button class="dtk-btn ghost" id="s-dm-load">Charger mes conversations</button>
            </div>
            <div class="dtk-list" id="s-dm-list"></div>
          </div>

          <div class="dtk-row">
            <div>
              <label>Type de contenu</label>
              <select id="s-type">
                <option value="all">Tout (texte + embeds + fichiers)</option>
                <option value="text">Texte des messages</option>
                <option value="embeds">Embeds uniquement</option>
                <option value="attachments">Pièces jointes</option>
              </select>
            </div>
            <div>
              <label>Combinaison</label>
              <select id="s-mode">
                <option value="AND">Mot-clé ET ID</option>
                <option value="OR">Mot-clé OU ID</option>
              </select>
            </div>
          </div>

          <label>Mot-clé (optionnel)</label>
          <input type="text" id="s-keyword" placeholder="ex : release, bienvenue, mise à jour..." />

          <label>ID recherché (optionnel)</label>
          <input type="text" id="s-id" placeholder="ex : 123456789012345678" />

          <label>Filtrer par auteur (optionnel)</label>
          <input type="text" id="s-author" placeholder="ID de l'auteur du message" />

          <div class="dtk-check">
            <input type="checkbox" id="s-case" />
            <label for="s-case" style="margin:0;text-transform:none;color:#dbdee1;font-size:12px;font-weight:500;">Respecter la casse</label>
          </div>

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="s-start">${searchIcon} Lancer la recherche</button>
            <button class="dtk-btn stop" id="s-stop">Stop</button>
          </div>
          <div id="dtk-status" class="dtk-statusline"><span class="dtk-spinner" id="s-spinner"></span><span id="s-status-text"></span></div>

          <div class="dtk-stats" id="s-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="s-stat-scanned">0</div><div class="l">Scannés</div></div>
            <div class="dtk-stat"><div class="n" id="s-stat-found">0</div><div class="l">Trouvés</div></div>
          </div>

          <div class="dtk-btnrow" id="s-exportrow" style="display:none;">
            <button class="dtk-btn ghost" id="s-copy">Copier les liens</button>
            <button class="dtk-btn ghost" id="s-export">Exporter en JSON</button>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-purge">
          <div class="dtk-warning">
            ⚠️ Action irréversible : ceci supprime définitivement <b>vos propres messages</b> dans la cible indiquée. Les messages des autres membres ne sont jamais touchés.
          </div>

          <label>Cible</label>
          <select id="p-target">
            <option value="channels">Salon(s) de serveur</option>
            <option value="dm">Messages privés</option>
          </select>

          <div id="p-channels-wrap">
            <label>Salon(s) ciblé(s)</label>
            <textarea id="p-channels" placeholder="ID de salon, ou plusieurs séparés par des virgules"></textarea>
          </div>

          <div id="p-dm-wrap" style="display:none;">
            <div class="dtk-btnrow">
              <button class="dtk-btn ghost" id="p-dm-load">Charger mes conversations</button>
            </div>
            <div class="dtk-list" id="p-dm-list"></div>
          </div>

          <label>Délai entre suppressions (ms)</label>
          <input type="text" id="p-delay" value="1200" />

          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="p-preview">Prévisualiser (compter)</button>
          </div>

          <div class="dtk-stats" id="p-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="p-stat-scanned">0</div><div class="l">Scannés</div></div>
            <div class="dtk-stat"><div class="n" id="p-stat-mine">0</div><div class="l">À vous</div></div>
          </div>

          <label>Tape "SUPPRIMER" pour confirmer</label>
          <input type="text" id="dtk-confirm-input" placeholder="SUPPRIMER" />

          <div class="dtk-btnrow">
            <button class="dtk-btn danger" id="p-start" disabled>${trashIcon} Supprimer mes messages</button>
            <button class="dtk-btn stop" id="p-stop">Stop</button>
          </div>
          <div id="dtk-purge-status" class="dtk-statusline"><span class="dtk-spinner" id="p-spinner"></span><span id="p-status-text"></span></div>

          <div class="dtk-stats" id="p-stats2" style="display:none;">
            <div class="dtk-stat"><div class="n" id="p-stat-deleted">0</div><div class="l">Supprimés</div></div>
            <div class="dtk-stat"><div class="n" id="p-stat-failed">0</div><div class="l">Échecs</div></div>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-guilds">
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="g-load">Charger mes serveurs</button>
          </div>
          <div class="dtk-list" id="g-list"></div>

          <div class="dtk-warning" style="margin-top:14px;">
            ⚠️ Action irréversible : vous quitterez définitivement les serveurs sélectionnés. Les serveurs dont vous êtes propriétaire ne peuvent pas être quittés ainsi.
          </div>
          <label>Tape "QUITTER" pour confirmer</label>
          <input type="text" id="g-confirm-input" placeholder="QUITTER" />
          <div class="dtk-btnrow">
            <button class="dtk-btn danger" id="g-start" disabled>🚪 Quitter les serveurs sélectionnés</button>
          </div>
          <div id="dtk-guilds-status" class="dtk-statusline"><span class="dtk-spinner" id="g-spinner"></span><span id="g-status-text"></span></div>
          <div class="dtk-stats" id="g-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="g-stat-left">0</div><div class="l">Quittés</div></div>
            <div class="dtk-stat"><div class="n" id="g-stat-failed">0</div><div class="l">Échecs</div></div>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-closedm">
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="cd-load">Charger mes conversations</button>
          </div>

          <label>Messages privés (1 à 1)</label>
          <div class="dtk-list" id="cd-dm-list"></div>
          <div class="dtk-btnrow">
            <button class="dtk-btn danger" id="cd-close-dms">🔒 Fermer les DM sélectionnés</button>
          </div>

          <label style="margin-top:18px;">Groupes</label>
          <div class="dtk-list" id="cd-group-list"></div>
          <div class="dtk-warning" style="margin-top:10px;">
            ⚠️ Discord affiche toujours automatiquement « a quitté le groupe » aux autres membres quand vous quittez — c'est un comportement du client/serveur Discord, pas un réglage que ce script peut activer/désactiver. Il n'existe pas de sortie réellement "invisible" pour un groupe.
          </div>
          <div class="dtk-btnrow">
            <button class="dtk-btn danger" id="cd-leave-groups">🚪 Quitter les groupes sélectionnés</button>
          </div>

          <div id="dtk-closedm-status" class="dtk-statusline"><span class="dtk-spinner" id="cd-spinner"></span><span id="cd-status-text"></span></div>
          <div class="dtk-stats" id="cd-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="cd-stat-done">0</div><div class="l">Traités</div></div>
            <div class="dtk-stat"><div class="n" id="cd-stat-failed">0</div><div class="l">Échecs</div></div>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-export">
          <label>Salon à exporter (ID)</label>
          <input type="text" id="exp-channel" placeholder="ID du salon" />

          <label>Nombre max de messages (vide = tout)</label>
          <input type="text" id="exp-limit" placeholder="ex : 500" />

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="exp-start">📤 Exporter en HTML</button>
            <button class="dtk-btn stop" id="exp-stop">Stop</button>
          </div>
          <div id="dtk-export-status" class="dtk-statusline"><span class="dtk-spinner" id="exp-spinner"></span><span id="exp-status-text"></span></div>
          <div class="dtk-stats" id="exp-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="exp-stat-scanned">0</div><div class="l">Récupérés</div></div>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-profile">
          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="prof-load">🪪 Récupérer mes données</button>
          </div>
          <div id="dtk-profile-status" class="dtk-statusline"><span class="dtk-spinner" id="prof-spinner"></span><span id="prof-status-text"></span></div>
          <div id="prof-preview" style="margin-top:12px;"></div>
          <div class="dtk-btnrow" id="prof-exportrow" style="display:none; margin-top:10px;">
            <button class="dtk-btn ghost" id="prof-export">Exporter en JSON</button>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-status">
          <label>Texte du statut</label>
          <input type="text" id="st-text" placeholder="ex : En ligne mais occupé" />
          <label>Emoji (nom, optionnel — ex : 🎮 ou custom_name)</label>
          <input type="text" id="st-emoji" placeholder="ex : 🎮" />

          <div class="dtk-check">
            <input type="checkbox" id="st-persist" />
            <label for="st-persist" style="margin:0;text-transform:none;color:#dbdee1;font-size:12px;font-weight:500;">Garder ce statut actif jusqu'à la fermeture de l'onglet</label>
          </div>

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="st-apply">Appliquer maintenant</button>
            <button class="dtk-btn ghost" id="st-save">💾 Sauvegarder</button>
            <button class="dtk-btn stop" id="st-stop-persist" style="display:none;">⏹️ Stop</button>
          </div>
          <div id="dtk-status-status" class="dtk-statusline"><span class="dtk-spinner" id="st-spinner"></span><span id="st-status-text"></span></div>

          <label style="margin-top:14px;">Statuts sauvegardés</label>
          <div class="dtk-list" id="st-list"></div>
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="st-clear">🗑️ Retirer le statut actuel</button>
          </div>

          <label style="margin-top:20px;">Activité personnalisée (ex : "Joue à ...")</label>
          <div class="dtk-warning" style="margin-top:6px;">
            ⚠️ Repose sur les modules internes de Discord (comme pour le bouton de la barre d'outils) : peut cesser de fonctionner après une mise à jour de Discord.
          </div>
          <div class="dtk-row">
            <div>
              <label>Type</label>
              <select id="ac-type">
                <option value="0">Joue à</option>
                <option value="2">Écoute</option>
                <option value="3">Regarde</option>
                <option value="5">En compétition dans</option>
                <option value="1">Diffuse en direct</option>
              </select>
            </div>
            <div>
              <label>Nom</label>
              <input type="text" id="ac-name" placeholder="ex : Visual Studio Code" />
            </div>
          </div>
          <label>Détails (ligne 1, optionnel)</label>
          <input type="text" id="ac-details" placeholder="ex : En train de coder" />
          <label>État (ligne 2, optionnel)</label>
          <input type="text" id="ac-state" placeholder="ex : Sur Discord Toolkit" />
          <label id="ac-url-label" style="display:none;">URL du stream (Twitch/YouTube, requis si "Diffuse en direct")</label>
          <input type="text" id="ac-url" style="display:none;" placeholder="https://twitch.tv/..." />

          <div class="dtk-check">
            <input type="checkbox" id="ac-persist" />
            <label for="ac-persist" style="margin:0;text-transform:none;color:#dbdee1;font-size:12px;font-weight:500;">Garder cette activité active jusqu'à la fermeture de l'onglet</label>
          </div>

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="ac-apply">Appliquer l'activité</button>
            <button class="dtk-btn ghost" id="ac-clear">Retirer l'activité</button>
            <button class="dtk-btn stop" id="ac-stop-persist" style="display:none;">⏹️ Stop</button>
          </div>
          <div id="dtk-activity-status" class="dtk-statusline"><span class="dtk-spinner" id="ac-spinner"></span><span id="ac-status-text"></span></div>
        </div>

        <div class="dtk-panel-tab" id="tab-friends">
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="fr-load">Charger mes amis</button>
          </div>
          <label>Seuil d'inactivité</label>
          <select id="fr-threshold">
            <option value="30">Plus de 1 mois</option>
            <option value="90" selected>Plus de 3 mois</option>
            <option value="180">Plus de 6 mois</option>
            <option value="365">Plus de 12 mois</option>
          </select>
          <div id="dtk-friends-status" class="dtk-statusline"><span class="dtk-spinner" id="fr-spinner"></span><span id="fr-status-text"></span></div>
          <div class="dtk-list" id="fr-list" style="margin-top:10px; max-height:260px;"></div>
          <div class="dtk-warning" style="margin-top:12px;">
            ⚠️ Action irréversible : retirer un ami supprime la relation des deux côtés.
          </div>
          <div class="dtk-btnrow">
            <button class="dtk-btn danger" id="fr-remove">Retirer les amis sélectionnés</button>
          </div>
        </div>

        <div class="dtk-panel-tab" id="tab-deadservers">
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="ds-scan">Scanner mes serveurs</button>
            <button class="dtk-btn stop" id="ds-stop">Stop</button>
          </div>
          <label>Seuil d'inactivité</label>
          <select id="ds-threshold">
            <option value="30">Plus de 30 jours</option>
            <option value="90" selected>Plus de 90 jours</option>
            <option value="180">Plus de 6 mois</option>
            <option value="365">Plus de 1 an</option>
          </select>
          <div id="dtk-deadservers-status" class="dtk-statusline"><span class="dtk-spinner" id="ds-spinner"></span><span id="ds-status-text"></span></div>
          <div class="dtk-stats" id="ds-stats" style="display:none;">
            <div class="dtk-stat"><div class="n" id="ds-stat-scanned">0</div><div class="l">Scannés</div></div>
            <div class="dtk-stat"><div class="n" id="ds-stat-dead">0</div><div class="l">Inactifs</div></div>
          </div>
          <div class="dtk-list" id="ds-list" style="margin-top:10px; max-height:260px;"></div>
        </div>

        <div class="dtk-panel-tab" id="tab-avatarrotate">
          <div class="dtk-warning">
            ⚠️ Les images restent en mémoire dans cet onglet uniquement (perdues si tu recharges la page), et la rotation ne tourne que tant que cet onglet Discord reste ouvert. Discord limite aussi la fréquence des changements de profil — évite les intervalles trop courts.
          </div>
          <label>Images (avatar) — plusieurs fichiers possibles</label>
          <div class="dtk-filepicker">
            <button type="button" class="dtk-btn ghost" id="av-files-btn">📁 Choisir des images</button>
            <span class="dtk-filepicker-label" id="av-files-label">Aucun fichier choisi</span>
          </div>
          <input type="file" id="av-files" accept="image/*" multiple style="display:none;" />
          <div class="dtk-list" id="av-list" style="max-height:140px;"></div>

          <div class="dtk-row">
            <div>
              <label>Cible</label>
              <select id="av-target">
                <option value="avatar">Avatar</option>
                <option value="banner">Bannière</option>
              </select>
            </div>
            <div>
              <label>Intervalle (minutes)</label>
              <input type="text" id="av-interval" value="60" />
            </div>
          </div>

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="av-start">▶️ Démarrer la rotation</button>
            <button class="dtk-btn stop" id="av-stop">⏹️ Stop</button>
          </div>
          <div id="dtk-avatarrotate-status" class="dtk-statusline"><span class="dtk-spinner" id="av-spinner"></span><span id="av-status-text"></span></div>
        </div>

        <div class="dtk-panel-tab" id="tab-msgrotate">
          <div class="dtk-warning">
            ⚠️ Ne fonctionne que sur un message que vous avez vous-même envoyé, et seulement tant que cet onglet Discord reste ouvert.
          </div>
          <label>Salon (ID)</label>
          <input type="text" id="mr-channel" placeholder="ID du salon" />
          <label>ID du message à modifier</label>
          <input type="text" id="mr-message" placeholder="ID du message" />
          <label>Intervalle (minutes)</label>
          <input type="text" id="mr-interval" value="60" />

          <label style="margin-top:14px;">Messages (minimum 2)</label>
          <div id="mr-list"></div>
          <div class="dtk-btnrow">
            <button class="dtk-btn ghost" id="mr-add">➕ Ajouter un message</button>
          </div>

          <div class="dtk-btnrow">
            <button class="dtk-btn primary" id="mr-start">▶️ Démarrer la rotation</button>
            <button class="dtk-btn stop" id="mr-stop">⏹️ Stop</button>
          </div>
          <div id="dtk-msgrotate-status" class="dtk-statusline"><span class="dtk-spinner" id="mr-spinner"></span><span id="mr-status-text"></span></div>
        </div>

      </div>
      <div id="dtk-footer"><b>Discord Toolkit</b> · by <span class="dtk-heart">♥</span> Eren</div>
    `;
    document.body.appendChild(panel);

    // ===== Sélecteurs custom (remplace les <select> natifs) =====
    function buildCustomSelect(selectEl) {
      selectEl.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.className = 'dtk-select';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'dtk-select-trigger';
      trigger.innerHTML = `<span class="dtk-select-label"></span><svg class="dtk-select-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      const list = document.createElement('div');
      list.className = 'dtk-select-list';

      function updateLabel() {
        const opt = selectEl.options[selectEl.selectedIndex];
        trigger.querySelector('.dtk-select-label').textContent = opt ? opt.textContent : '';
        list.querySelectorAll('.dtk-select-item').forEach((it) => it.classList.toggle('selected', it.dataset.value === selectEl.value));
      }

      function renderOptions() {
        list.innerHTML = '';
        Array.from(selectEl.options).forEach((opt) => {
          const item = document.createElement('div');
          item.className = 'dtk-select-item' + (opt.disabled ? ' disabled' : '') + (opt.value === selectEl.value ? ' selected' : '');
          item.textContent = opt.textContent;
          item.dataset.value = opt.value;
          if (!opt.disabled) {
            item.addEventListener('click', () => {
              selectEl.value = opt.value;
              selectEl.dispatchEvent(new Event('change', { bubbles: true }));
              updateLabel();
              wrap.classList.remove('open');
            });
          }
          list.appendChild(item);
        });
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !wrap.classList.contains('open');
        document.querySelectorAll('.dtk-select.open').forEach((s) => s.classList.remove('open'));
        if (willOpen) wrap.classList.add('open');
      });

      renderOptions();
      updateLabel();
      wrap.appendChild(trigger);
      wrap.appendChild(list);
      selectEl.insertAdjacentElement('afterend', wrap);
    }

    panel.querySelectorAll('select').forEach(buildCustomSelect);
    document.addEventListener('click', () => {
      panel.querySelectorAll('.dtk-select.open').forEach((s) => s.classList.remove('open'));
    });

    toggleBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'flex' : 'none';
    });
    panel.querySelector('.dtk-close').addEventListener('click', () => (panel.style.display = 'none'));

    panel.querySelectorAll('.dtk-tab').forEach((tabEl) => {
      tabEl.addEventListener('click', () => {
        panel.querySelectorAll('.dtk-tab').forEach((t) => t.classList.remove('active'));
        panel.querySelectorAll('.dtk-panel-tab').forEach((t) => t.classList.remove('active'));
        tabEl.classList.add('active');
        document.getElementById('tab-' + tabEl.dataset.tab).classList.add('active');
      });
    });

    (function makeDraggable() {
      const header = document.getElementById('dtk-header');
      let dragging = false, offX = 0, offY = 0;
      header.addEventListener('mousedown', (e) => {
        dragging = true;
        const rect = panel.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = e.clientX - offX + 'px';
        panel.style.top = e.clientY - offY + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.position = 'fixed';
      });
      document.addEventListener('mouseup', () => (dragging = false));
    })();

    const statusTextMap = {
      'dtk-status': 's-status-text',
      'dtk-purge-status': 'p-status-text',
      'dtk-guilds-status': 'g-status-text',
      'dtk-closedm-status': 'cd-status-text',
      'dtk-export-status': 'exp-status-text',
      'dtk-profile-status': 'prof-status-text',
      'dtk-status-status': 'st-status-text',
      'dtk-friends-status': 'fr-status-text',
      'dtk-deadservers-status': 'ds-status-text',
      'dtk-avatarrotate-status': 'av-status-text',
      'dtk-msgrotate-status': 'mr-status-text',
      'dtk-activity-status': 'ac-status-text',
    };
    function setStatus(el, spinnerEl, text, opts = {}) {
      el.classList.toggle('error', !!opts.error);
      spinnerEl.classList.toggle('on', !!opts.busy);
      document.getElementById(statusTextMap[el.id] || el.id).textContent = text || '';
      el.classList.toggle('filled', !!(text && String(text).trim()) || !!opts.busy);
    }

    // ===== Recherche =====
    let lastResults = [];

    document.getElementById('s-start').addEventListener('click', async () => {
      if (searchRunning) return;
      const isDm = document.getElementById('s-target').value === 'dm';
      const channels = isDm ? getSelectedFrom('s-dm-list') : parseChannelList(document.getElementById('s-channels').value);
      const statusEl = document.getElementById('dtk-status');
      const spinnerEl = document.getElementById('s-spinner');
      if (channels.length === 0) {
        setStatus(statusEl, spinnerEl, isDm ? '⚠️ Sélectionne au moins une conversation.' : '⚠️ Indique au moins un ID de salon valide.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Ouvre les devtools (F12), reste sur un salon, puis recharge la page et réessaie.', { error: true });
        return;
      }
      const opts = {
        type: document.getElementById('s-type').value,
        matchMode: document.getElementById('s-mode').value,
        keyword: document.getElementById('s-keyword').value.trim() || null,
        idStr: document.getElementById('s-id').value.trim() || null,
        authorId: document.getElementById('s-author').value.trim() || null,
        caseSensitive: document.getElementById('s-case').checked,
      };

      searchRunning = true;
      searchStop = false;
      document.getElementById('s-stats').style.display = 'flex';
      document.getElementById('s-exportrow').style.display = 'none';
      setStatus(statusEl, spinnerEl, 'Démarrage...', { busy: true });

      const results = await runSearch(channels, opts, token, (p) => {
        setStatus(statusEl, spinnerEl, p.status, { error: !!p.error, busy: !p.error });
        document.getElementById('s-stat-scanned').textContent = p.scanned;
        document.getElementById('s-stat-found').textContent = p.found;
      }, isDm ? '@me' : undefined);

      searchRunning = false;
      lastResults = results;
      spinnerEl.classList.remove('on');

      if (results.length === 0) {
        setStatus(statusEl, spinnerEl, 'Aucun résultat trouvé.', {});
      } else {
        setStatus(statusEl, spinnerEl, `${results.length} résultat(s) trouvé(s).`, {});
      }
      document.getElementById('s-exportrow').style.display = results.length > 0 ? 'flex' : 'none';
    });

    document.getElementById('s-stop').addEventListener('click', () => {
      searchStop = true;
      document.getElementById('s-status-text').textContent = 'Arrêt demandé...';
      document.getElementById('dtk-status').classList.add('filled');
    });

    document.getElementById('s-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(lastResults.map((r) => r.link).join('\n')).then(() => {
        document.getElementById('s-status-text').textContent = `${lastResults.length} lien(s) copié(s).`;
        document.getElementById('dtk-status').classList.add('filled');
      });
    });

    document.getElementById('s-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `discord-search-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // ===== Suppression =====
    document.getElementById('dtk-confirm-input').addEventListener('input', (e) => {
      document.getElementById('p-start').disabled = e.target.value !== 'SUPPRIMER';
    });

    document.getElementById('p-preview').addEventListener('click', async () => {
      const isDm = document.getElementById('p-target').value === 'dm';
      const channels = isDm ? getSelectedFrom('p-dm-list') : parseChannelList(document.getElementById('p-channels').value);
      const statusEl = document.getElementById('dtk-purge-status');
      const spinnerEl = document.getElementById('p-spinner');
      if (channels.length === 0) {
        setStatus(statusEl, spinnerEl, isDm ? '⚠️ Sélectionne au moins une conversation.' : '⚠️ Indique au moins un ID de salon valide.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      if (!me) me = await fetchMe(token);
      if (!me) {
        setStatus(statusEl, spinnerEl, '⚠️ Impossible de récupérer votre profil.', { error: true });
        return;
      }

      document.getElementById('p-stats').style.display = 'flex';
      setStatus(statusEl, spinnerEl, `Prévisualisation pour ${me.username}...`, { busy: true });

      let scanned = 0, mine = 0;
      let lastError = null;
      purgeStop = false;
      for (const channelId of channels) {
        if (purgeStop) break;
        for await (const msg of iterateChannelMessages(
          channelId,
          token,
          (wait) => setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true }),
          (err) => { lastError = err; setStatus(statusEl, spinnerEl, err, { error: true }); }
        )) {
          if (purgeStop) break;
          scanned++;
          if (msg.author.id === me.id) mine++;
          if (scanned % 20 === 0) {
            document.getElementById('p-stat-scanned').textContent = scanned;
            document.getElementById('p-stat-mine').textContent = mine;
            setStatus(statusEl, spinnerEl, `Analyse en cours... (${scanned} messages)`, { busy: true });
          }
        }
      }
      document.getElementById('p-stat-scanned').textContent = scanned;
      document.getElementById('p-stat-mine').textContent = mine;
      if (scanned === 0 && lastError) {
        setStatus(statusEl, spinnerEl, lastError, { error: true });
      } else {
        setStatus(statusEl, spinnerEl, `Analyse terminée : ${mine} message(s) à vous trouvés sur ${scanned} scannés.`);
      }
    });

    document.getElementById('p-start').addEventListener('click', async () => {
      if (purgeRunning) return;
      const isDm = document.getElementById('p-target').value === 'dm';
      const channels = isDm ? getSelectedFrom('p-dm-list') : parseChannelList(document.getElementById('p-channels').value);
      const statusEl = document.getElementById('dtk-purge-status');
      const spinnerEl = document.getElementById('p-spinner');
      if (channels.length === 0) {
        setStatus(statusEl, spinnerEl, isDm ? '⚠️ Sélectionne au moins une conversation.' : '⚠️ Indique au moins un ID de salon valide.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      if (!me) me = await fetchMe(token);
      if (!me) {
        setStatus(statusEl, spinnerEl, '⚠️ Impossible de récupérer votre profil.', { error: true });
        return;
      }
      const delay = Math.max(400, parseInt(document.getElementById('p-delay').value, 10) || 1200);

      if (!confirm(`Confirmer la suppression de TOUS vos messages dans ${channels.length} ${isDm ? 'conversation(s)' : 'salon(s)'} ? Cette action est irréversible.`)) return;

      purgeRunning = true;
      purgeStop = false;
      document.getElementById('p-stats2').style.display = 'flex';
      setStatus(statusEl, spinnerEl, 'Démarrage de la suppression...', { busy: true });

      const result = await runPurge(channels, token, me.id, (p) => {
        setStatus(statusEl, spinnerEl, p.status, { error: !!p.error, busy: !p.error });
        document.getElementById('p-stat-deleted').textContent = p.deleted;
        document.getElementById('p-stat-failed').textContent = p.failed;
      }, delay);

      purgeRunning = false;
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `Terminé : ${result.deleted} supprimé(s), ${result.failed} échec(s), sur ${result.scanned} messages scannés.`);
    });

    document.getElementById('p-stop').addEventListener('click', () => {
      purgeStop = true;
      document.getElementById('p-status-text').textContent = 'Arrêt demandé...';
      document.getElementById('dtk-purge-status').classList.add('filled');
    });

    // ===== Serveurs (quitter en masse) =====
    let loadedGuilds = [];

    function renderGuildList() {
      const list = document.getElementById('g-list');
      if (loadedGuilds.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucun serveur chargé.</div>`;
        return;
      }
      list.innerHTML = loadedGuilds
        .map(
          (g) => `
        <div class="dtk-list-item${g.owner ? ' disabled' : ''}">
          <input type="checkbox" class="g-item" value="${g.id}" ${g.owner ? 'disabled' : ''} />
          <span>${escapeHtml(g.name)}</span>
          ${g.owner ? '<span class="sub">Propriétaire</span>' : ''}
        </div>`
        )
        .join('');
    }

    document.getElementById('g-load').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-guilds-status');
      const spinnerEl = document.getElementById('g-spinner');
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      setStatus(statusEl, spinnerEl, 'Chargement des serveurs...', { busy: true });
      loadedGuilds = await fetchMyGuilds(token);
      spinnerEl.classList.remove('on');
      renderGuildList();
      setStatus(statusEl, spinnerEl, `${loadedGuilds.length} serveur(s) chargé(s).`, {});
    });

    document.getElementById('g-confirm-input').addEventListener('input', (e) => {
      document.getElementById('g-start').disabled = e.target.value !== 'QUITTER';
    });

    document.getElementById('g-start').addEventListener('click', async () => {
      if (guildsLeaveRunning) return;
      const selected = Array.from(document.querySelectorAll('.g-item:checked')).map((el) => el.value);
      const statusEl = document.getElementById('dtk-guilds-status');
      const spinnerEl = document.getElementById('g-spinner');
      if (selected.length === 0) {
        setStatus(statusEl, spinnerEl, '⚠️ Sélectionne au moins un serveur.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      if (!confirm(`Confirmer la sortie de ${selected.length} serveur(s) ? Cette action est irréversible.`)) return;

      guildsLeaveRunning = true;
      document.getElementById('g-stats').style.display = 'flex';
      let left = 0, failed = 0;
      setStatus(statusEl, spinnerEl, 'Sortie des serveurs...', { busy: true });

      for (const guildId of selected) {
        const res = await leaveGuild(guildId, token, (wait) => setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true }));
        if (res.ok || res.status === 204) left++;
        else failed++;
        document.getElementById('g-stat-left').textContent = left;
        document.getElementById('g-stat-failed').textContent = failed;
        setStatus(statusEl, spinnerEl, `${left} quitté(s), ${failed} échec(s)...`, { busy: true });
        await sleep(600);
      }

      guildsLeaveRunning = false;
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `Terminé : ${left} serveur(s) quitté(s), ${failed} échec(s).`, {});
      loadedGuilds = loadedGuilds.filter((g) => !selected.includes(g.id) || g.owner);
      renderGuildList();
    });

    // ===== DM partagé (utilisé par Recherche, Suppression et Fermer DM) =====
    let loadedDMs = [];

    function renderDmListInto(containerId, dms) {
      const list = document.getElementById(containerId);
      if (dms.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucune conversation chargée.</div>`;
        return;
      }
      list.innerHTML = dms
        .map(
          (ch) => `
        <div class="dtk-list-item">
          <input type="checkbox" class="dm-item" value="${ch.id}" />
          <span>${escapeHtml(dmLabel(ch))}</span>
        </div>`
        )
        .join('');
    }

    async function loadDmsInto(containerId, statusEl, spinnerEl) {
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      setStatus(statusEl, spinnerEl, 'Chargement des conversations...', { busy: true });
      loadedDMs = await fetchMyDMs(token);
      spinnerEl.classList.remove('on');
      renderDmListInto(containerId, loadedDMs);
      setStatus(statusEl, spinnerEl, `${loadedDMs.length} conversation(s) chargée(s).`, {});
    }

    function getSelectedFrom(containerId) {
      return Array.from(document.querySelectorAll(`#${containerId} .dm-item:checked`)).map((el) => el.value);
    }

    document.getElementById('s-target').addEventListener('change', (e) => {
      const isDm = e.target.value === 'dm';
      document.getElementById('s-channels-wrap').style.display = isDm ? 'none' : 'block';
      document.getElementById('s-dm-wrap').style.display = isDm ? 'block' : 'none';
    });
    document.getElementById('s-dm-load').addEventListener('click', () => {
      loadDmsInto('s-dm-list', document.getElementById('dtk-status'), document.getElementById('s-spinner'));
    });

    document.getElementById('p-target').addEventListener('change', (e) => {
      const isDm = e.target.value === 'dm';
      document.getElementById('p-channels-wrap').style.display = isDm ? 'none' : 'block';
      document.getElementById('p-dm-wrap').style.display = isDm ? 'block' : 'none';
    });
    document.getElementById('p-dm-load').addEventListener('click', () => {
      loadDmsInto('p-dm-list', document.getElementById('dtk-purge-status'), document.getElementById('p-spinner'));
    });

    // ===== Fermer DM / Quitter les groupes =====
    document.getElementById('cd-load').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-closedm-status');
      const spinnerEl = document.getElementById('cd-spinner');
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      setStatus(statusEl, spinnerEl, 'Chargement des conversations...', { busy: true });
      const all = await fetchMyDMs(token);
      const dms = all.filter((ch) => ch.type === 1);
      const groups = all.filter((ch) => ch.type === 3);
      spinnerEl.classList.remove('on');
      renderDmListInto('cd-dm-list', dms);
      renderDmListInto('cd-group-list', groups);
      setStatus(statusEl, spinnerEl, `${dms.length} DM et ${groups.length} groupe(s) chargé(s).`, {});
    });

    async function closeChannels(ids, statusEl, spinnerEl, verb) {
      document.getElementById('cd-stats').style.display = 'flex';
      let done = 0, failed = 0;
      for (const id of ids) {
        const res = await apiFetch(`${API_BASE}/channels/${id}`, getToken(), { method: 'DELETE' }, (wait) =>
          setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true })
        );
        if (res.ok || res.status === 204) done++;
        else failed++;
        document.getElementById('cd-stat-done').textContent = done;
        document.getElementById('cd-stat-failed').textContent = failed;
        setStatus(statusEl, spinnerEl, `${verb}... ${done} traité(s), ${failed} échec(s)`, { busy: true });
        await sleep(500);
      }
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `Terminé : ${done} traité(s), ${failed} échec(s).`, {});
    }

    document.getElementById('cd-close-dms').addEventListener('click', async () => {
      const ids = getSelectedFrom('cd-dm-list');
      const statusEl = document.getElementById('dtk-closedm-status');
      const spinnerEl = document.getElementById('cd-spinner');
      if (ids.length === 0) {
        setStatus(statusEl, spinnerEl, '⚠️ Sélectionne au moins un DM.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      if (!confirm(`Fermer ${ids.length} DM ? (fermer un DM n'avertit jamais l'autre personne, il réapparaîtra si elle vous réécrit)`)) return;
      await closeChannels(ids, statusEl, spinnerEl, 'Fermeture');
    });

    document.getElementById('cd-leave-groups').addEventListener('click', async () => {
      const ids = getSelectedFrom('cd-group-list');
      const statusEl = document.getElementById('dtk-closedm-status');
      const spinnerEl = document.getElementById('cd-spinner');
      if (ids.length === 0) {
        setStatus(statusEl, spinnerEl, '⚠️ Sélectionne au moins un groupe.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      if (!confirm(`Quitter ${ids.length} groupe(s) ? Un message "a quitté le groupe" sera visible par les autres membres (comportement Discord non désactivable). Action irréversible.`)) return;
      await closeChannels(ids, statusEl, spinnerEl, 'Sortie des groupes');
    });

    // ===== Export salon HTML =====
    document.getElementById('exp-start').addEventListener('click', async () => {
      if (exportRunning) return;
      const channelId = document.getElementById('exp-channel').value.trim();
      const statusEl = document.getElementById('dtk-export-status');
      const spinnerEl = document.getElementById('exp-spinner');
      if (!/^\d+$/.test(channelId)) {
        setStatus(statusEl, spinnerEl, '⚠️ Indique un ID de salon valide.', { error: true });
        return;
      }
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      const limitRaw = document.getElementById('exp-limit').value.trim();
      const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : Infinity;

      exportRunning = true;
      exportStop = false;
      document.getElementById('exp-stats').style.display = 'flex';
      setStatus(statusEl, spinnerEl, 'Récupération des infos du salon...', { busy: true });

      const chanInfo = await fetchChannelInfo(channelId, token);
      const channelName = chanInfo ? (chanInfo.name || dmLabel(chanInfo) || channelId) : channelId;

      setStatus(statusEl, spinnerEl, 'Récupération des messages...', { busy: true });
      const messages = [];
      for await (const msg of iterateChannelMessages(
        channelId,
        token,
        (wait) => setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true }),
        (err) => setStatus(statusEl, spinnerEl, err, { error: true })
      )) {
        if (exportStop) break;
        messages.push(msg);
        if (messages.length % 20 === 0) {
          document.getElementById('exp-stat-scanned').textContent = messages.length;
          setStatus(statusEl, spinnerEl, `${messages.length} message(s) récupéré(s)...`, { busy: true });
        }
        if (messages.length >= limit) break;
      }
      document.getElementById('exp-stat-scanned').textContent = messages.length;

      if (messages.length === 0) {
        exportRunning = false;
        spinnerEl.classList.remove('on');
        setStatus(statusEl, spinnerEl, 'Aucun message récupéré.', { error: true });
        return;
      }

      setStatus(statusEl, spinnerEl, 'Génération du fichier HTML...', { busy: true });
      messages.reverse();
      const html = buildExportHtml(channelName, messages);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${channelName}-export-${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(url);

      exportRunning = false;
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `Export terminé : ${messages.length} message(s).`, {});
    });

    document.getElementById('exp-stop').addEventListener('click', () => {
      exportStop = true;
      document.getElementById('exp-status-text').textContent = 'Arrêt demandé...';
      document.getElementById('dtk-export-status').classList.add('filled');
    });

    // ===== Export du profil =====
    let lastProfileExport = null;

    document.getElementById('prof-load').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-profile-status');
      const spinnerEl = document.getElementById('prof-spinner');
      const token = getToken();
      if (!token) {
        setStatus(statusEl, spinnerEl, '⚠️ Token introuvable. Recharge la page et réessaie.', { error: true });
        return;
      }
      setStatus(statusEl, spinnerEl, 'Récupération du profil...', { busy: true });
      const profile = await fetchFullProfile(token);
      if (!profile) {
        spinnerEl.classList.remove('on');
        setStatus(statusEl, spinnerEl, '⚠️ Impossible de récupérer le profil.', { error: true });
        return;
      }
      setStatus(statusEl, spinnerEl, 'Récupération des connexions...', { busy: true });
      const connections = await fetchMyConnections(token);
      spinnerEl.classList.remove('on');

      const created = snowflakeToDate(profile.id);
      const badges = decodeBadges(profile.public_flags);
      lastProfileExport = {
        id: profile.id,
        username: profile.username,
        discriminator: profile.discriminator,
        global_name: profile.global_name || null,
        bio: profile.bio || null,
        created_at: created ? created.toISOString() : null,
        avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : null,
        banner: profile.banner ? `https://cdn.discordapp.com/banners/${profile.id}/${profile.banner}.png` : null,
        accent_color: profile.accent_color || null,
        premium_type: profile.premium_type || 0,
        badges,
        connections: connections.map((c) => ({ type: c.type, name: c.name, verified: c.verified, visibility: c.visibility })),
        exported_at: new Date().toISOString(),
      };

      document.getElementById('prof-preview').innerHTML = `
        <div class="dtk-list-item" style="flex-direction:column; align-items:flex-start; gap:4px;">
          <div><b>${escapeHtml(profile.username)}</b>${profile.global_name ? ' (' + escapeHtml(profile.global_name) + ')' : ''}</div>
          <div class="sub" style="margin:0;">ID : ${profile.id}</div>
          <div class="sub" style="margin:0;">Créé le : ${created ? created.toLocaleDateString('fr-FR') : '—'}</div>
          <div class="sub" style="margin:0;">Badges : ${badges.length ? escapeHtml(badges.join(', ')) : 'aucun'}</div>
          <div class="sub" style="margin:0;">Connexions liées : ${connections.length}</div>
        </div>`;
      document.getElementById('prof-exportrow').style.display = 'flex';
      setStatus(statusEl, spinnerEl, 'Profil récupéré.', {});
    });

    document.getElementById('prof-export').addEventListener('click', () => {
      if (!lastProfileExport) return;
      const blob = new Blob([JSON.stringify(lastProfileExport, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `discord-profil-${lastProfileExport.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // ===== Statuts personnalisés =====
    function renderStatusList() {
      const list = document.getElementById('st-list');
      const saved = loadSavedStatuses();
      if (saved.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucun statut sauvegardé.</div>`;
        return;
      }
      list.innerHTML = saved
        .map(
          (s, i) => `
        <div class="dtk-list-item" style="justify-content:space-between;">
          <span>${s.emoji ? escapeHtml(s.emoji) + ' ' : ''}${escapeHtml(s.text)}</span>
          <span style="display:flex; gap:8px;">
            <button class="dtk-btn ghost st-apply-saved" data-i="${i}" style="padding:4px 10px; font-size:10.5px;">Appliquer</button>
            <button class="dtk-btn ghost st-del-saved" data-i="${i}" style="padding:4px 10px; font-size:10.5px;">✕</button>
          </span>
        </div>`
        )
        .join('');

      list.querySelectorAll('.st-apply-saved').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const s = saved[parseInt(btn.dataset.i, 10)];
          const statusEl = document.getElementById('dtk-status-status');
          const spinnerEl = document.getElementById('st-spinner');
          const token = getToken();
          if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
          setStatus(statusEl, spinnerEl, 'Application du statut...', { busy: true });
          const res = await setCustomStatus(token, s.text, s.emoji);
          spinnerEl.classList.remove('on');
          setStatus(statusEl, spinnerEl, res.ok ? 'Statut appliqué.' : '⚠️ Échec de l\'application.', { error: !res.ok });
        })
      );
      list.querySelectorAll('.st-del-saved').forEach((btn) =>
        btn.addEventListener('click', () => {
          const arr = loadSavedStatuses();
          arr.splice(parseInt(btn.dataset.i, 10), 1);
          saveSavedStatuses(arr);
          renderStatusList();
        })
      );
    }
    renderStatusList();

    let statusPersistTimer = null;

    function stopStatusPersist(message) {
      if (statusPersistTimer) clearInterval(statusPersistTimer);
      statusPersistTimer = null;
      document.getElementById('st-stop-persist').style.display = 'none';
      if (message) {
        document.getElementById('st-status-text').textContent = message;
        document.getElementById('dtk-status-status').classList.add('filled');
      }
    }

    document.getElementById('st-apply').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-status-status');
      const spinnerEl = document.getElementById('st-spinner');
      const text = document.getElementById('st-text').value.trim();
      const emoji = document.getElementById('st-emoji').value.trim();
      const persist = document.getElementById('st-persist').checked;
      const token = getToken();
      if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
      if (!text) { setStatus(statusEl, spinnerEl, '⚠️ Indique un texte de statut.', { error: true }); return; }

      if (statusPersistTimer) clearInterval(statusPersistTimer);
      statusPersistTimer = null;
      document.getElementById('st-stop-persist').style.display = 'none';

      setStatus(statusEl, spinnerEl, 'Application du statut...', { busy: true });
      const res = await setCustomStatus(token, text, emoji);
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, res.ok ? 'Statut appliqué.' : '⚠️ Échec de l\'application.', { error: !res.ok });

      if (res.ok && persist) {
        document.getElementById('st-stop-persist').style.display = 'inline-flex';
        statusPersistTimer = setInterval(async () => {
          const t = getToken();
          if (!t) return;
          await setCustomStatus(t, text, emoji);
          setStatus(statusEl, spinnerEl, 'Statut maintenu actif (ré-appliqué automatiquement).', {});
        }, 4 * 60 * 1000);
      }
    });

    document.getElementById('st-stop-persist').addEventListener('click', () => {
      stopStatusPersist('Maintien du statut arrêté (le statut reste tel quel).');
    });

    document.getElementById('st-save').addEventListener('click', () => {
      const text = document.getElementById('st-text').value.trim();
      const emoji = document.getElementById('st-emoji').value.trim();
      if (!text) return;
      const arr = loadSavedStatuses();
      arr.push({ text, emoji });
      saveSavedStatuses(arr);
      renderStatusList();
      document.getElementById('st-text').value = '';
      document.getElementById('st-emoji').value = '';
    });

    document.getElementById('st-clear').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-status-status');
      const spinnerEl = document.getElementById('st-spinner');
      const token = getToken();
      if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
      stopStatusPersist(null);
      setStatus(statusEl, spinnerEl, 'Suppression du statut...', { busy: true });
      const res = await setCustomStatus(token, null, null);
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, res.ok ? 'Statut retiré.' : '⚠️ Échec.', { error: !res.ok });
    });

    // ===== Activité personnalisée (Rich Presence) =====
    let activityPersistTimer = null;

    document.getElementById('ac-type').addEventListener('change', (e) => {
      const isStream = e.target.value === '1';
      document.getElementById('ac-url-label').style.display = isStream ? 'block' : 'none';
      document.getElementById('ac-url').style.display = isStream ? 'block' : 'none';
    });

    function buildActivityFromForm() {
      const name = document.getElementById('ac-name').value.trim();
      if (!name) return null;
      const type = parseInt(document.getElementById('ac-type').value, 10);
      const details = document.getElementById('ac-details').value.trim();
      const state = document.getElementById('ac-state').value.trim();
      const url = document.getElementById('ac-url').value.trim();
      const activity = {
        name,
        type,
        flags: 0,
        timestamps: { start: Date.now() },
      };
      if (details) activity.details = details;
      if (state) activity.state = state;
      if (type === 1 && url) activity.url = url;
      return activity;
    }

    function stopActivityPersist(message) {
      if (activityPersistTimer) clearInterval(activityPersistTimer);
      activityPersistTimer = null;
      document.getElementById('ac-stop-persist').style.display = 'none';
      if (message) {
        document.getElementById('ac-status-text').textContent = message;
        document.getElementById('dtk-activity-status').classList.add('filled');
      }
    }

    document.getElementById('ac-apply').addEventListener('click', () => {
      const statusEl = document.getElementById('dtk-activity-status');
      const spinnerEl = document.getElementById('ac-spinner');
      const activity = buildActivityFromForm();
      const persist = document.getElementById('ac-persist').checked;
      if (!activity) { setStatus(statusEl, spinnerEl, '⚠️ Indique au moins un nom d\'activité.', { error: true }); return; }
      if (activity.type === 1 && !activity.url) { setStatus(statusEl, spinnerEl, '⚠️ Indique une URL de stream Twitch/YouTube.', { error: true }); return; }

      if (activityPersistTimer) clearInterval(activityPersistTimer);
      activityPersistTimer = null;
      document.getElementById('ac-stop-persist').style.display = 'none';

      const ok = setLocalActivity(activity);
      setStatus(statusEl, spinnerEl, ok ? 'Activité appliquée.' : '⚠️ Impossible d\'accéder aux modules internes de Discord (essaie de recharger la page).', { error: !ok });

      if (ok && persist) {
        document.getElementById('ac-stop-persist').style.display = 'inline-flex';
        activityPersistTimer = setInterval(() => {
          setLocalActivity({ ...activity, timestamps: { start: activity.timestamps.start } });
          setStatus(statusEl, spinnerEl, 'Activité maintenue active (ré-appliquée automatiquement).', {});
        }, 4 * 60 * 1000);
      }
    });

    document.getElementById('ac-stop-persist').addEventListener('click', () => {
      stopActivityPersist('Maintien de l\'activité arrêté.');
    });

    document.getElementById('ac-clear').addEventListener('click', () => {
      const statusEl = document.getElementById('dtk-activity-status');
      const spinnerEl = document.getElementById('ac-spinner');
      stopActivityPersist(null);
      const ok = setLocalActivity(null);
      setStatus(statusEl, spinnerEl, ok ? 'Activité retirée.' : '⚠️ Impossible d\'accéder aux modules internes de Discord.', { error: !ok });
    });

    // ===== Amis inactifs =====
    let loadedFriends = [];

    document.getElementById('fr-load').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-friends-status');
      const spinnerEl = document.getElementById('fr-spinner');
      const token = getToken();
      if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
      setStatus(statusEl, spinnerEl, 'Chargement des amis...', { busy: true });
      const relationships = (await fetchMyRelationships(token)).filter((r) => r.type === 1);

      loadedFriends = [];
      let done = 0;
      setStatus(statusEl, spinnerEl, `Analyse des conversations (0/${relationships.length})...`, { busy: true });

      for (const r of relationships) {
        const ch = await openOrGetDm(r.id, token, (wait) =>
          setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true })
        );
        const lastMsgId = ch ? ch.last_message_id : null;
        const lastDate = lastMsgId ? snowflakeToDate(lastMsgId) : null;
        const daysSince = lastDate ? Math.floor((Date.now() - lastDate.getTime()) / 86400000) : null;
        const deleted = /^Deleted User [a-f0-9]+$/i.test(r.user.username || '');
        loadedFriends.push({ id: r.id, tag: r.user.username, lastDate, daysSince, deleted });
        done++;
        if (done % 3 === 0 || done === relationships.length) {
          setStatus(statusEl, spinnerEl, `Analyse des conversations (${done}/${relationships.length})...`, { busy: true });
        }
        await sleep(350);
      }

      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `${loadedFriends.length} ami(s) chargé(s).`, {});
      renderFriendsList();
    });

    function renderFriendsList() {
      const threshold = parseInt(document.getElementById('fr-threshold').value, 10);
      const list = document.getElementById('fr-list');
      const filtered = loadedFriends.filter((f) => f.deleted || f.daysSince === null || f.daysSince >= threshold);
      if (filtered.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucun ami inactif selon ce seuil.</div>`;
        return;
      }
      list.innerHTML = filtered
        .map(
          (f) => `
        <div class="dtk-list-item">
          <input type="checkbox" class="fr-item" value="${f.id}" />
          <span>${escapeHtml(f.tag)}</span>
          <span class="sub">${f.deleted ? 'Compte supprimé' : f.daysSince === null ? 'Jamais échangé' : f.daysSince + ' j sans échange'}</span>
        </div>`
        )
        .join('');
    }
    document.getElementById('fr-threshold').addEventListener('change', renderFriendsList);

    document.getElementById('fr-remove').addEventListener('click', async () => {
      const ids = Array.from(document.querySelectorAll('.fr-item:checked')).map((el) => el.value);
      const statusEl = document.getElementById('dtk-friends-status');
      const spinnerEl = document.getElementById('fr-spinner');
      if (ids.length === 0) { setStatus(statusEl, spinnerEl, '⚠️ Sélectionne au moins un ami.', { error: true }); return; }
      const token = getToken();
      if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
      if (!confirm(`Retirer ${ids.length} ami(s) ? Action irréversible.`)) return;

      let done = 0, failed = 0;
      setStatus(statusEl, spinnerEl, 'Suppression...', { busy: true });
      for (const id of ids) {
        const res = await removeFriend(id, token, (wait) => setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true }));
        if (res.ok || res.status === 204) done++; else failed++;
        setStatus(statusEl, spinnerEl, `${done} retiré(s), ${failed} échec(s)...`, { busy: true });
        await sleep(500);
      }
      loadedFriends = loadedFriends.filter((f) => !ids.includes(f.id));
      spinnerEl.classList.remove('on');
      setStatus(statusEl, spinnerEl, `Terminé : ${done} retiré(s), ${failed} échec(s).`, {});
      renderFriendsList();
    });

    // ===== Serveurs morts =====
    let deadServersScanStop = false;

    document.getElementById('ds-scan').addEventListener('click', async () => {
      const statusEl = document.getElementById('dtk-deadservers-status');
      const spinnerEl = document.getElementById('ds-spinner');
      const token = getToken();
      if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }

      deadServersScanStop = false;
      document.getElementById('ds-stats').style.display = 'flex';
      document.getElementById('ds-list').innerHTML = '';
      setStatus(statusEl, spinnerEl, 'Chargement des serveurs...', { busy: true });

      const guilds = await fetchMyGuilds(token);
      let scanned = 0;
      const results = [];

      for (const g of guilds) {
        if (deadServersScanStop) break;
        scanned++;
        document.getElementById('ds-stat-scanned').textContent = scanned;
        setStatus(statusEl, spinnerEl, `Analyse de "${g.name}"...`, { busy: true });

        const res = await apiFetch(`${API_BASE}/guilds/${g.id}/channels`, token, {}, (wait) =>
          setStatus(statusEl, spinnerEl, `Rate limit, pause ${Math.round(wait)}ms...`, { busy: true })
        );
        if (!res.ok) { await sleep(300); continue; }
        const channels = await res.json();
        let lastMsgId = null;
        for (const ch of channels) {
          if (ch.last_message_id && (!lastMsgId || BigInt(ch.last_message_id) > BigInt(lastMsgId))) {
            lastMsgId = ch.last_message_id;
          }
        }
        const lastDate = lastMsgId ? snowflakeToDate(lastMsgId) : null;
        const daysSince = lastDate ? Math.floor((Date.now() - lastDate.getTime()) / 86400000) : null;
        results.push({ id: g.id, name: g.name, daysSince, lastDate });
        await sleep(350);
      }

      spinnerEl.classList.remove('on');
      const threshold = parseInt(document.getElementById('ds-threshold').value, 10);
      const dead = results.filter((r) => r.daysSince === null || r.daysSince >= threshold);
      document.getElementById('ds-stat-dead').textContent = dead.length;
      setStatus(statusEl, spinnerEl, `Terminé : ${scanned} serveur(s) scanné(s), ${dead.length} inactif(s).`, {});

      const list = document.getElementById('ds-list');
      if (dead.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucun serveur inactif selon ce seuil.</div>`;
      } else {
        list.innerHTML = dead
          .map(
            (r) => `
          <div class="dtk-list-item">
            <span>${escapeHtml(r.name)}</span>
            <span class="sub">${r.daysSince === null ? 'Aucune activité détectée' : r.daysSince + ' j sans message'}</span>
          </div>`
          )
          .join('');
      }
    });

    document.getElementById('ds-stop').addEventListener('click', () => {
      deadServersScanStop = true;
      document.getElementById('ds-status-text').textContent = 'Arrêt demandé...';
      document.getElementById('dtk-deadservers-status').classList.add('filled');
    });

    // ===== Rotation avatar/bannière =====
    let avatarQueue = [];
    let avatarRotateTimer = null;
    let avatarRotateIndex = 0;

    function renderAvatarQueue() {
      const list = document.getElementById('av-list');
      if (avatarQueue.length === 0) {
        list.innerHTML = `<div class="dtk-empty">Aucune image chargée.</div>`;
        return;
      }
      list.innerHTML = avatarQueue.map((f, i) => `<div class="dtk-list-item"><span>${escapeHtml(f.name)}</span></div>`).join('');
    }

    document.getElementById('av-files-btn').addEventListener('click', () => {
      document.getElementById('av-files').click();
    });

    document.getElementById('av-files').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      const label = document.getElementById('av-files-label');
      label.textContent = files.length === 0 ? 'Aucun fichier choisi' : files.length === 1 ? files[0].name : `${files.length} fichiers sélectionnés`;
      const converted = [];
      for (const file of files) {
        converted.push({ name: file.name, dataUrl: await fileToDataUrl(file) });
      }
      avatarQueue = converted;
      renderAvatarQueue();
    });

    document.getElementById('av-start').addEventListener('click', () => {
      const statusEl = document.getElementById('dtk-avatarrotate-status');
      const spinnerEl = document.getElementById('av-spinner');
      if (avatarQueue.length === 0) { setStatus(statusEl, spinnerEl, '⚠️ Charge au moins une image.', { error: true }); return; }
      const intervalMin = Math.max(5, parseInt(document.getElementById('av-interval').value, 10) || 60);
      const target = document.getElementById('av-target').value;
      if (avatarRotateTimer) clearInterval(avatarRotateTimer);
      avatarRotateIndex = 0;

      async function applyNext() {
        const token = getToken();
        if (!token) { setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true }); return; }
        const item = avatarQueue[avatarRotateIndex % avatarQueue.length];
        setStatus(statusEl, spinnerEl, `Application de "${item.name}"...`, { busy: true });
        const res = target === 'avatar' ? await updateAvatar(token, item.dataUrl) : await updateBanner(token, item.dataUrl);
        spinnerEl.classList.remove('on');
        setStatus(statusEl, spinnerEl, res.ok ? `"${item.name}" appliqué. Prochain changement dans ${intervalMin} min.` : '⚠️ Échec de la mise à jour (rate limit Discord probable).', { error: !res.ok });
        avatarRotateIndex++;
      }

      applyNext();
      avatarRotateTimer = setInterval(applyNext, intervalMin * 60 * 1000);
      setStatus(statusEl, spinnerEl, 'Rotation démarrée.', {});
    });

    document.getElementById('av-stop').addEventListener('click', () => {
      if (avatarRotateTimer) clearInterval(avatarRotateTimer);
      avatarRotateTimer = null;
      document.getElementById('av-status-text').textContent = 'Rotation arrêtée.';
      document.getElementById('dtk-avatarrotate-status').classList.add('filled');
    });

    // ===== Rotation de message =====
    let mrMessages = ['', ''];
    let mrRotateTimer = null;
    let mrRotateIndex = 0;

    function renderMrList() {
      const list = document.getElementById('mr-list');
      list.innerHTML = mrMessages
        .map(
          (val, i) => `
        <div class="dtk-list-item" style="align-items:stretch; flex-direction:column; gap:6px;">
          <div style="display:flex; width:100%; justify-content:space-between; align-items:center;">
            <span class="sub" style="margin:0;">Message ${i + 1}</span>
            ${mrMessages.length > 2 ? `<button class="dtk-btn ghost mr-remove" data-i="${i}" style="padding:2px 8px; font-size:10px;">✕ Retirer</button>` : ''}
          </div>
          <textarea class="mr-text" data-i="${i}" style="width:100%; min-height:52px; resize:vertical;">${escapeHtml(val)}</textarea>
        </div>`
        )
        .join('');

      list.querySelectorAll('.mr-text').forEach((ta) => {
        ta.addEventListener('input', (e) => {
          mrMessages[parseInt(e.target.dataset.i, 10)] = e.target.value;
        });
      });
      list.querySelectorAll('.mr-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          mrMessages.splice(parseInt(btn.dataset.i, 10), 1);
          renderMrList();
        });
      });
    }
    renderMrList();

    document.getElementById('mr-add').addEventListener('click', () => {
      mrMessages.push('');
      renderMrList();
    });

    document.getElementById('mr-start').addEventListener('click', () => {
      const statusEl = document.getElementById('dtk-msgrotate-status');
      const spinnerEl = document.getElementById('mr-spinner');
      const channelId = document.getElementById('mr-channel').value.trim();
      const messageId = document.getElementById('mr-message').value.trim();
      const validMessages = mrMessages.map((m) => m.trim()).filter(Boolean);

      if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
        setStatus(statusEl, spinnerEl, '⚠️ Indique un ID de salon et de message valides.', { error: true });
        return;
      }
      if (validMessages.length < 2) {
        setStatus(statusEl, spinnerEl, '⚠️ Il faut au moins 2 messages non vides.', { error: true });
        return;
      }
      const intervalMin = Math.max(1, parseInt(document.getElementById('mr-interval').value, 10) || 60);
      if (mrRotateTimer) clearInterval(mrRotateTimer);
      mrRotateIndex = 0;

      async function applyNext() {
        const token = getToken();
        if (!token) {
          setStatus(statusEl, spinnerEl, '⚠️ Token introuvable.', { error: true });
          return;
        }
        const i = mrRotateIndex % validMessages.length;
        setStatus(statusEl, spinnerEl, `Application du message ${i + 1}/${validMessages.length}...`, { busy: true });
        const res = await editMessage(channelId, messageId, token, validMessages[i]);
        spinnerEl.classList.remove('on');
        setStatus(
          statusEl,
          spinnerEl,
          res.ok
            ? `Message mis à jour (${i + 1}/${validMessages.length}). Prochain changement dans ${intervalMin} min.`
            : '⚠️ Échec de la modification (ce n\'est peut-être pas votre message, ou rate limit).',
          { error: !res.ok }
        );
        mrRotateIndex++;
      }

      applyNext();
      mrRotateTimer = setInterval(applyNext, intervalMin * 60 * 1000);
      setStatus(statusEl, spinnerEl, 'Rotation démarrée.', {});
    });

    document.getElementById('mr-stop').addEventListener('click', () => {
      if (mrRotateTimer) clearInterval(mrRotateTimer);
      mrRotateTimer = null;
      document.getElementById('mr-status-text').textContent = 'Rotation arrêtée.';
      document.getElementById('dtk-msgrotate-status').classList.add('filled');
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  const readyCheck = setInterval(() => {
    if (document.body) {
      clearInterval(readyCheck);
      buildUI();
    }
  }, 1000);
})();
