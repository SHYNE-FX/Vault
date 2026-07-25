// app.js — vault state, UI wiring, CSV backup, biometric quick-unlock
'use strict';

const LS_VAULT = 'vault_blob_v1';       // { saltB64, iv, data }
const LS_BIO   = 'vault_bio_v1';        // { credId, wrapped:{iv,data} } wrapped master password
const IDB_WRAP_KEY = 'wrappingKey';

let masterKey = null;      // CryptoKey (AES-GCM) derived from password, in-memory only
let saltB64 = null;
let vault = { items: [] };
let currentCatFilter = 'all';
let activeItemId = null;

const CATS = {
  password: { label: 'Password', icon: 'key' },
  bank:     { label: 'Bank', icon: 'account_balance' },
  card:     { label: 'Card', icon: 'credit_card' },
  document: { label: 'Documents', icon: 'draft' },
  token:    { label: 'Token', icon: 'token' },
  note:     { label: 'Notes', icon: 'stylus_note' },
};

function iconHtml(name) { return `<span class="material-symbols-outlined">${name}</span>`; }

const DOC_LABEL_OPTIONS = ['Aadhaar Card', 'PAN Card', 'Voter Card', 'DL Card', 'RC Card', 'Passport'];

// field schema per category: [{key,label,type,secret}]
const SCHEMAS = {
  password: [
    { key: 'label', label: 'Site / App name', type: 'text', required: true, placeholder: 'e.g. Gmail, Netflix' },
    { key: 'username', label: 'Username / Email', type: 'text', placeholder: 'e.g. jane@email.com' },
    { key: 'password', label: 'Password', type: 'password', secret: true, generate: true, placeholder: 'Enter or generate a password' },
    { key: 'url', label: 'Website URL', type: 'text', placeholder: 'e.g. https://example.com' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Add any extra notes' },
  ],
  bank: [
    { key: 'label', label: 'Bank / Account name', type: 'text', required: true, placeholder: 'e.g. HDFC Savings' },
    { key: 'accountNumber', label: 'Account number', type: 'text', secret: true, placeholder: 'Enter account number' },
    { key: 'ifsc', label: 'IFSC / Branch code', type: 'text', placeholder: 'e.g. HDFC0001234' },
    { key: 'pin', label: '16-digit PIN', type: 'password', secret: true, placeholder: 'Enter PIN' },
    { key: 'cvv', label: 'CVV', type: 'password', secret: true, placeholder: 'Enter CVV' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Add any extra notes' },
  ],
  card: [
    { key: 'label', label: 'Card name', type: 'text', required: true, placeholder: 'e.g. HDFC Millennia' },
    { key: 'cardType', label: 'Card type', type: 'select', options: ['Credit', 'Debit'], placeholder: 'Select card type' },
    { key: 'cardNumber', label: 'Card number', type: 'text', secret: true, placeholder: 'Enter 16-digit card number' },
    { key: 'expiry', label: 'Expiry (MM/YY)', type: 'text', placeholder: 'e.g. 08/29' },
    { key: 'cvv', label: 'CVV', type: 'password', secret: true, placeholder: 'Enter CVV' },
    { key: 'pin', label: 'PIN', type: 'password', secret: true, placeholder: 'Enter PIN' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Add any extra notes' },
  ],
  document: [
    { key: 'label', label: 'Document type', type: 'select', required: true, options: DOC_LABEL_OPTIONS, placeholder: 'Select document type' },
    { key: 'idNumber', label: 'Label', type: 'text', placeholder: 'Enter a label' },
    { key: 'password', label: 'Password', type: 'password', secret: true, placeholder: 'Enter password (if any)' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Add any extra notes' },
  ],
  token: [
    { key: 'label', label: 'Label', type: 'text', required: true, placeholder: 'e.g. 2FA Recovery Code' },
    { key: 'password', label: 'Password', type: 'password', secret: true, generate: true, placeholder: 'Enter or generate a value' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Add any extra notes' },
  ],
  note: [
    { key: 'label', label: 'Label', type: 'text', required: true, placeholder: 'e.g. Wifi Password, Locker Code' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Write your note here' },
  ],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(t), ms);
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ================= PWA =================
let deferredInstallPrompt = null;

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // A new worker was found for an already-controlled page.
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(reg);
          }
        });
      });
    }).catch(() => {});

    // Reload once the new worker takes control, so the fresh assets are used.
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hideInstallButton();
    toast('Vault installed');
  });
}

function showUpdateBar(reg) {
  const bar = $('#update-bar');
  if (!bar) return;
  show(bar);
  $('#update-reload').onclick = () => {
    if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    hide(bar);
  };
  $('#update-dismiss').onclick = () => hide(bar);
}

function showInstallButton() {
  const btn = $('#install-btn');
  if (btn) show(btn);
}

function hideInstallButton() {
  const btn = $('#install-btn');
  if (btn) hide(btn);
}

async function promptInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hideInstallButton();
}

// ================= BOOT =================
window.addEventListener('DOMContentLoaded', boot);

function storageWorks() {
  try {
    const k = '__vault_test__';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch (e) { return false; }
}

function boot() {
  if (!storageWorks()) {
    document.body.innerHTML = `<div style="padding:32px;text-align:center;font-family:sans-serif;color:#1a1b2b;">
      <h2>Storage unavailable</h2>
      <p>This browser is blocking local storage, so nothing can be saved.</p>
      <p>Open this app over <b>http://</b> or <b>https://</b> (e.g. run a local server) instead of double-clicking the file directly — Chrome disables storage for <code>file://</code> pages.</p>
    </div>`;
    return;
  }
  setupPWA();
  const raw = localStorage.getItem(LS_VAULT);
  if (!raw) {
    show($('#screen-setup'));
  } else {
    show($('#screen-unlock'));
    checkBiometricAvailable();
  }
  wireEvents();
}

// ================= SETUP =================
$('#form-setup') && ($('#form-setup').onsubmit = async (e) => {
  e.preventDefault();
  const p1 = $('#setup-pass').value;
  const p2 = $('#setup-pass2').value;
  const err = $('#setup-error');
  err.textContent = '';
  if (p1.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
  if (p1 !== p2) { err.textContent = 'Passwords do not match.'; return; }

  const { key, saltB64: s } = await VaultCrypto.deriveKey(p1, null);
  masterKey = key; saltB64 = s;
  vault = { items: [] };
  await persistVault();
  enterApp();
  toast('Vault created');
});

// ================= UNLOCK =================
$('#form-unlock') && ($('#form-unlock').onsubmit = async (e) => {
  e.preventDefault();
  const pass = $('#unlock-pass').value;
  const err = $('#unlock-error');
  err.textContent = '';
  const ok = await tryUnlockWithPassword(pass);
  if (!ok) err.textContent = 'Incorrect password.';
});

async function tryUnlockWithPassword(pass) {
  const raw = JSON.parse(localStorage.getItem(LS_VAULT));
  try {
    const { key } = await VaultCrypto.deriveKey(pass, raw.saltB64);
    const decoded = await VaultCrypto.decryptJSON(key, raw);
    masterKey = key; saltB64 = raw.saltB64;
    vault = decoded;
    enterApp();
    return true;
  } catch (e) {
    return false;
  }
}

async function checkBiometricAvailable() {
  const bioData = localStorage.getItem(LS_BIO);
  if (!bioData) return;
  if (!window.PublicKeyCredential) return;
  try {
    const avail = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (avail) show($('#btn-biometric'));
  } catch (e) {}
}

$('#btn-biometric') && ($('#btn-biometric').onclick = async () => {
  const err = $('#unlock-error');
  err.textContent = '';
  try {
    const bio = JSON.parse(localStorage.getItem(LS_BIO));
    const credId = VaultCrypto.b64ToBuf(bio.credId);
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: credId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    // assertion succeeded -> unwrap stored password via IndexedDB wrapping key
    const wrapKey = await idbGet(IDB_WRAP_KEY);
    if (!wrapKey) throw new Error('no wrap key');
    const pass = await VaultCrypto.unwrapString(wrapKey, bio.wrapped);
    const ok = await tryUnlockWithPassword(pass);
    if (!ok) err.textContent = 'Biometric unlock failed. Use password.';
  } catch (e) {
    err.textContent = 'Biometric unlock cancelled or unavailable.';
  }
});

$('#btn-reset-vault') && ($('#btn-reset-vault').onclick = () => {
  if (confirm('This permanently deletes all encrypted data on this device. Continue?')) {
    localStorage.removeItem(LS_VAULT);
    localStorage.removeItem(LS_BIO);
    idbDel(IDB_WRAP_KEY).catch(() => {});
    location.reload();
  }
});

// ================= PERSIST =================
async function persistVault() {
  const payload = await VaultCrypto.encryptJSON(masterKey, vault);
  const blob = JSON.stringify({ saltB64, iv: payload.iv, data: payload.data });
  localStorage.setItem(LS_VAULT, blob);
  if (localStorage.getItem(LS_VAULT) !== blob) {
    throw new Error('Save failed: storage did not persist the write.');
  }
}

function enterApp() {
  hide($('#screen-setup')); hide($('#screen-unlock'));
  show($('#screen-app'));
  renderList();
  updateBioMenuLabel();
}

// ================= LIST RENDERING =================
function wireEvents() {
  const installBtn = $('#install-btn');
  if (installBtn) installBtn.addEventListener('click', promptInstall);

  $('#category-select').addEventListener('change', (e) => {
    currentCatFilter = e.target.value;
    renderList();
  });

  $('#search-input').addEventListener('input', renderList);

  $('#btn-fab').addEventListener('click', () => show($('#sheet-picker')));
  $('#picker-cancel').addEventListener('click', () => hide($('#sheet-picker')));
  $('#sheet-picker').addEventListener('click', (e) => { if (e.target.id === 'sheet-picker') hide($('#sheet-picker')); });

  $$('.picker-item').forEach(btn => btn.addEventListener('click', () => {
    hide($('#sheet-picker'));
    openEditor(btn.dataset.cat, null);
  }));

  $('#editor-close').addEventListener('click', () => hide($('#sheet-editor')));
  $('#editor-delete').addEventListener('click', onDeleteEntry);

  $('#view-close').addEventListener('click', () => hide($('#sheet-view')));
  $('#view-edit').addEventListener('click', () => {
    hide($('#sheet-view'));
    const item = vault.items.find(i => i.id === activeItemId);
    openEditor(item.cat, item);
  });

  $('#btn-menu').addEventListener('click', () => show($('#sheet-menu')));
  $('#menu-cancel').addEventListener('click', () => hide($('#sheet-menu')));
  $('#sheet-menu').addEventListener('click', (e) => { if (e.target.id === 'sheet-menu') hide($('#sheet-menu')); });

  $('#menu-lock').addEventListener('click', () => {
    masterKey = null; vault = { items: [] };
    hide($('#sheet-menu'));
    hide($('#screen-app'));
    show($('#screen-unlock'));
    checkBiometricAvailable();
  });

  $('#menu-export').addEventListener('click', exportCSV);
  $('#menu-import').addEventListener('click', () => $('#import-file-input').click());
  $('#import-file-input').addEventListener('change', importCSV);
  $('#menu-biometric-toggle').addEventListener('click', toggleBiometric);
  $('#menu-change-pass').addEventListener('click', changeMasterPassword);
}

function renderList() {
  const q = $('#search-input').value.trim().toLowerCase();
  const list = $('#vault-list');
  list.innerHTML = '';
  const filtered = vault.items.filter(item => {
    const catOk = currentCatFilter === 'all' || item.cat === currentCatFilter;
    if (!catOk) return false;
    if (!q) return true;
    const hay = (item.fields.label + ' ' + (item.fields.username || '') + ' ' + (item.fields.url || '')).toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (filtered.length === 0) { show($('#empty-state')); return; }
  hide($('#empty-state'));

  filtered.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.style.animationDelay = `${Math.min(idx, 8) * 25}ms`;
    const sub = item.cat === 'password' ? (item.fields.username || item.fields.url || '') :
                item.cat === 'card' ? maskTail(item.fields.cardNumber) :
                item.cat === 'bank' ? maskTail(item.fields.accountNumber) :
                item.cat === 'document' ? maskTail(item.fields.idNumber) :
                item.cat === 'note' ? (item.fields.notes || '') : '';
    card.innerHTML = `
      <div class="item-icon">${iconHtml(CATS[item.cat].icon)}</div>
      <div class="item-text">
        <p class="item-title">${escapeHtml(item.fields.label || 'Untitled')}</p>
        <p class="item-sub">${escapeHtml(sub || CATS[item.cat].label)}</p>
      </div>
      <span class="item-cat-tag">${CATS[item.cat].label}</span>
    `;
    card.addEventListener('click', () => openView(item));
    list.appendChild(card);
  });
}
function maskTail(v) {
  if (!v) return '';
  const s = String(v);
  return s.length > 4 ? '•••• ' + s.slice(-4) : s;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================= EDITOR =================
function openEditor(cat, item) {
  activeItemId = item ? item.id : null;
  $('#editor-title').textContent = item ? 'Edit ' + CATS[cat].label : 'New ' + CATS[cat].label;
  item ? show($('#editor-delete')) : hide($('#editor-delete'));

  const form = $('#form-editor');
  form.innerHTML = '';
  form.dataset.cat = cat;
  const schema = SCHEMAS[cat];

  for (const f of schema) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const value = item ? escapeHtml(item.fields[f.key] || '') : '';
    if (f.type === 'select') {
      const opts = f.options.map(o => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
      wrap.innerHTML = `<span>${f.label}</span>
        <select name="${f.key}" ${f.required ? 'required' : ''}>
          <option value="" disabled ${value ? '' : 'selected'}>${f.placeholder || 'Select an option'}</option>
          ${opts}
        </select>`;
    } else if (f.type === 'textarea') {
      wrap.innerHTML = `<span>${f.label}</span><textarea name="${f.key}" placeholder="${f.placeholder || ''}">${value}</textarea>`;
    } else if (f.secret) {
      wrap.innerHTML = `<span>${f.label}</span>
        <div class="pass-field-wrap">
          <input type="password" name="${f.key}" value="${value}" placeholder="${f.placeholder || ''}" ${f.required ? 'required' : ''} />
          <div class="pass-tools">
            ${f.generate ? `<button type="button" class="btn-gen" title="Generate"><span class="material-symbols-outlined">casino</span></button>` : ''}
            <button type="button" class="btn-toggle" title="Show"><span class="material-symbols-outlined">visibility</span></button>
          </div>
        </div>`;
    } else {
      wrap.innerHTML = `<span>${f.label}</span><input type="text" name="${f.key}" value="${value}" placeholder="${f.placeholder || ''}" ${f.required ? 'required' : ''} />`;
    }
    form.appendChild(wrap);
  }

  form.querySelectorAll('.btn-toggle').forEach(btn => btn.addEventListener('click', () => {
    const input = btn.closest('.pass-field-wrap').querySelector('input');
    const nowText = input.type === 'password';
    input.type = nowText ? 'text' : 'password';
    btn.querySelector('.material-symbols-outlined').textContent = nowText ? 'visibility_off' : 'visibility';
  }));
  form.querySelectorAll('.btn-gen').forEach(btn => btn.addEventListener('click', () => {
    const input = btn.closest('.pass-field-wrap').querySelector('input');
    input.value = generatePassword();
    input.type = 'text';
  }));

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const fields = {};
    for (const f of schema) fields[f.key] = (fd.get(f.key) || '').toString();
    if (!fields.label) { toast('Label is required'); return; }

    if (activeItemId) {
      const item2 = vault.items.find(i => i.id === activeItemId);
      item2.fields = fields;
      item2.updatedAt = Date.now();
    } else {
      vault.items.push({ id: uid(), cat, fields, updatedAt: Date.now() });
    }
    try {
      await persistVault();
    } catch (err) {
      toast('Save failed — storage is unavailable in this browser');
      return;
    }
    hide($('#sheet-editor'));
    renderList();
    toast('Saved');
  };

  show($('#sheet-editor'));
}

async function onDeleteEntry() {
  if (!activeItemId) return;
  if (!confirm('Delete this entry permanently?')) return;
  vault.items = vault.items.filter(i => i.id !== activeItemId);
  await persistVault();
  hide($('#sheet-editor'));
  renderList();
  toast('Deleted');
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

// ================= VIEW ENTRY =================
function openView(item) {
  activeItemId = item.id;
  $('#view-title').textContent = item.fields.label || CATS[item.cat].label;
  const body = $('#view-body');
  body.innerHTML = '';
  const schema = SCHEMAS[item.cat];

  for (const f of schema) {
    const val = item.fields[f.key];
    if (!val && f.key !== 'label') continue;
    const row = document.createElement('div');
    row.className = 'view-row';
    const isSecret = !!f.secret;
    row.innerHTML = `
      <div class="view-row-text">
        <p class="view-row-label">${f.label}</p>
        <p class="view-row-value ${isSecret ? 'masked' : ''} ${f.type === 'textarea' ? 'view-notes' : ''}" data-real="${escapeHtml(val)}">${isSecret ? '••••••••' : escapeHtml(val)}</p>
      </div>
      <div class="view-row-actions">
        ${isSecret ? `<button class="btn-eye" title="Show"><span class="material-symbols-outlined">visibility</span></button>` : ''}
        <button class="btn-copy" title="Copy"><span class="material-symbols-outlined">content_copy</span></button>
      </div>`;
    body.appendChild(row);

    if (isSecret) {
      row.querySelector('.btn-eye').addEventListener('click', (e) => {
        const p = row.querySelector('.view-row-value');
        const shown = p.classList.toggle('masked');
        p.textContent = shown ? '••••••••' : val;
        e.currentTarget.querySelector('.material-symbols-outlined').textContent = shown ? 'visibility' : 'visibility_off';
      });
    }
    row.querySelector('.btn-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(val);
        toast('Copied to clipboard');
        setTimeout(async () => {
          try { const cur = await navigator.clipboard.readText(); if (cur === val) await navigator.clipboard.writeText(''); } catch (e) {}
        }, 30000);
      } catch (e) { toast('Copy failed'); }
    });
  }
  show($('#sheet-view'));
}

// ================= CSV BACKUP =================
const CSV_COLUMNS = ['id', 'cat', 'label', 'field1', 'field2', 'field3', 'field4', 'field5', 'field6', 'notes', 'updatedAt'];

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCSV() {
  hide($('#sheet-menu'));
  const rows = [['id', 'category', 'label', 'field_key_1', 'field_val_1', 'field_key_2', 'field_val_2', 'field_key_3', 'field_val_3', 'field_key_4', 'field_val_4', 'field_key_5', 'field_val_5', 'notes', 'updatedAt']];
  for (const item of vault.items) {
    const schema = SCHEMAS[item.cat].filter(f => f.key !== 'label' && f.key !== 'notes');
    const row = [item.id, item.cat, item.fields.label || ''];
    for (let i = 0; i < 5; i++) {
      const f = schema[i];
      row.push(f ? f.key : '', f ? (item.fields[f.key] || '') : '');
    }
    row.push(item.fields.notes || '', item.updatedAt || '');
    rows.push(row);
  }
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `vault-backup-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded — keep it safe, it is unencrypted');
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') {}
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function importCSV(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text).filter(r => r.length > 1);
  rows.shift(); // header
  let added = 0;
  for (const r of rows) {
    const [id, cat, label, k1, v1, k2, v2, k3, v3, k4, v4, k5, v5, notes, updatedAt] = r;
    if (!SCHEMAS[cat]) continue;
    const fields = { label, notes: notes || '' };
    [[k1, v1], [k2, v2], [k3, v3], [k4, v4], [k5, v5]].forEach(([k, v]) => { if (k) fields[k] = v; });
    const exists = vault.items.find(i => i.id === id);
    if (exists) { exists.fields = fields; exists.updatedAt = Number(updatedAt) || Date.now(); }
    else { vault.items.push({ id: id || uid(), cat, fields, updatedAt: Number(updatedAt) || Date.now() }); added++; }
  }
  await persistVault();
  renderList();
  hide($('#sheet-menu'));
  toast(`Restored ${rows.length} entries (${added} new)`);
}

// ================= BIOMETRIC UNLOCK SETUP =================
function updateBioMenuLabel() {
  const enabled = !!localStorage.getItem(LS_BIO);
  $('#menu-biometric-label').textContent = enabled ? 'Disable biometric unlock' : 'Enable biometric unlock';
}

async function toggleBiometric() {
  hide($('#sheet-menu'));
  const enabled = !!localStorage.getItem(LS_BIO);
  if (enabled) {
    localStorage.removeItem(LS_BIO);
    await idbDel(IDB_WRAP_KEY).catch(() => {});
    updateBioMenuLabel();
    toast('Biometric unlock disabled');
    return;
  }
  if (!window.PublicKeyCredential) { toast('Biometrics not supported on this device'); return; }
  try {
    const avail = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!avail) { toast('No biometric hardware found'); return; }
    const pass = prompt('Re-enter master password to enable biometric unlock:');
    if (!pass) return;
    const ok = await verifyPasswordOnly(pass);
    if (!ok) { toast('Incorrect password'); return; }

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Vault' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'vault-user', displayName: 'Vault User' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
      },
    });
    const wrapKey = await VaultCrypto.generateWrappingKey();
    await idbSet(IDB_WRAP_KEY, wrapKey);
    const wrapped = await VaultCrypto.wrapString(wrapKey, pass);
    localStorage.setItem(LS_BIO, JSON.stringify({ credId: VaultCrypto.bufToB64(cred.rawId), wrapped }));
    updateBioMenuLabel();
    toast('Biometric unlock enabled');
  } catch (e) {
    toast('Could not enable biometric unlock');
  }
}

async function verifyPasswordOnly(pass) {
  const raw = JSON.parse(localStorage.getItem(LS_VAULT));
  try {
    const { key } = await VaultCrypto.deriveKey(pass, raw.saltB64);
    await VaultCrypto.decryptJSON(key, raw);
    return true;
  } catch (e) { return false; }
}

// ================= CHANGE PASSWORD =================
async function changeMasterPassword() {
  hide($('#sheet-menu'));
  const oldPass = prompt('Enter current master password:');
  if (!oldPass) return;
  const ok = await verifyPasswordOnly(oldPass);
  if (!ok) { toast('Incorrect password'); return; }
  const newPass = prompt('Enter new master password (min 6 chars):');
  if (!newPass || newPass.length < 6) { toast('Password too short'); return; }
  const { key, saltB64: s } = await VaultCrypto.deriveKey(newPass, null);
  masterKey = key; saltB64 = s;
  await persistVault();
  if (localStorage.getItem(LS_BIO)) {
    localStorage.removeItem(LS_BIO);
    await idbDel(IDB_WRAP_KEY).catch(() => {});
    updateBioMenuLabel();
    toast('Password changed. Re-enable biometrics if needed.');
  } else {
    toast('Password changed');
  }
}
