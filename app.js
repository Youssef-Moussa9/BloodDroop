// ============================================================================
// app.js — Qatra (Blood Donor Network)
// ============================================================================
import { LANGUAGES, t } from "./i18n.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { Country, State, City } from "https://cdn.jsdelivr.net/npm/country-state-city@3.2.1/+esm";

const ROOT = document.getElementById("app-root");
const BRAND_TEXT = document.getElementById("brand-text");
const BRAND_TAGLINE = document.getElementById("brand-tagline");
const LANG_SWITCH_BTN = document.getElementById("lang-switch-btn");
const LANG_SWITCH_CODE = document.getElementById("lang-switch-code");
const EMAIL_STORAGE_KEY = "qatra_email_for_signin";

// ---------------------------------------------------------------------------
// Blood type compatibility: who CAN DONATE TO whom.
// ---------------------------------------------------------------------------
const CAN_DONATE_TO = {
  "O-":  ["O-","O+","A-","A+","B-","B+","AB-","AB+"],
  "O+":  ["O+","A+","B+","AB+"],
  "A-":  ["A-","A+","AB-","AB+"],
  "A+":  ["A+","AB+"],
  "B-":  ["B-","B+","AB-","AB+"],
  "B+":  ["B+","AB+"],
  "AB-": ["AB-","AB+"],
  "AB+": ["AB+"],
};
const BLOOD_TYPES = ["O-","O+","A-","A+","B-","B+","AB-","AB+"];

function donorsThatCanServe(recipientType) {
  return BLOOD_TYPES.filter(donorType => (CAN_DONATE_TO[donorType] || []).includes(recipientType));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function emptyForm() {
  return {
    name: "", bloodType: "",
    country: "", countryName: "", state: "", stateName: "", city: "", cityName: "",
    cityWriteIn: false, cityCustom: "", stateWriteIn: false, stateCustom: "",
    phone: "", hasWhatsapp: null, altPhone: "", email: "", notes: "",
  };
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  lang: "en",
  dir: "ltr",
  langSearch: "",
  role: null, // "donor" | "recipient"
  countries: [],
  form: emptyForm(),
  submitting: false,
  results: null, // array of matched donors, after recipient submits
  editing: null, // { collection: "donors"|"recipients" } when editing an existing record
  recoverEmail: "",
  recoverError: "",
  recoverSentTo: "",
  myData: { donor: null, recipient: null },
};

function tr(key) { return t(state.lang, key); }
function trf(key, vars) {
  let str = tr(key);
  Object.keys(vars || {}).forEach(k => { str = str.replace(`{${k}}`, vars[k]); });
  return str;
}

function detectDeviceLanguage() {
  const candidates = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || "en"];
  for (const raw of candidates) {
    const base = String(raw || "").toLowerCase().split("-")[0];
    const match = LANGUAGES.find(l => l.code === base);
    if (match) return match.code;
  }
  return "en";
}

function setLangDirection() {
  const lang = LANGUAGES.find(l => l.code === state.lang);
  state.dir = lang && lang.rtl ? "rtl" : "ltr";
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.dir;
}

// ---------------------------------------------------------------------------
// Firebase (lazy — only loaded if firebase-config.js has real keys)
// ---------------------------------------------------------------------------
let dbConnPromise = null;
async function getDb() {
  if (!isConfigured) return null;
  if (!dbConnPromise) {
    dbConnPromise = (async () => {
      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
      const firestore = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js");
      const app = initializeApp(firebaseConfig);
      return { app, db: firestore.getFirestore(app), fs: firestore };
    })();
  }
  return dbConnPromise;
}

let authConnPromise = null;
async function getAuthConn() {
  if (!isConfigured) return null;
  if (!authConnPromise) {
    authConnPromise = (async () => {
      const conn = await getDb();
      const authMod = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js");
      const auth = authMod.getAuth(conn.app);
      return { auth, authMod };
    })();
  }
  return authConnPromise;
}

// ---- Demo-mode fallback store (used when Firebase isn't configured yet) ----
function demoStore() {
  window.__qatraDemoStore = window.__qatraDemoStore || { donors: {} };
  return window.__qatraDemoStore;
}

// Create a NEW record. Fails (throws) if one already exists for this email
// and we're not signed in as that email — mirrors the real Firestore rules,
// which classify "writing to an existing doc" as an update, not a create.
async function createRecord(collectionName, email, data) {
  const key = normalizeEmail(email);
  const conn = await getDb();
  if (!conn) {
    const store = demoStore();
    store[collectionName][key] = { ...data, email: key };
    return;
  }
  const { db, fs } = conn;
  const ref = fs.doc(db, collectionName, key);
  const existing = await fs.getDoc(ref);
  if (existing.exists()) {
    const err = new Error("already-exists");
    err.code = "already-exists";
    throw err;
  }
  await fs.setDoc(ref, { ...data, email: key, createdAt: fs.serverTimestamp() });
}

async function updateRecord(collectionName, email, data) {
  const key = normalizeEmail(email);
  const conn = await getDb();
  if (!conn) {
    const store = demoStore();
    store[collectionName][key] = { ...data, email: key };
    return;
  }
  const { db, fs } = conn;
  await fs.setDoc(fs.doc(db, collectionName, key), { ...data, email: key, updatedAt: fs.serverTimestamp() }, { merge: false });
}

async function deleteRecord(collectionName, email) {
  const key = normalizeEmail(email);
  const conn = await getDb();
  if (!conn) {
    const store = demoStore();
    delete store[collectionName][key];
    return;
  }
  const { db, fs } = conn;
  await fs.deleteDoc(fs.doc(db, collectionName, key));
}

async function fetchOwnRecord(collectionName, email) {
  const key = normalizeEmail(email);
  const conn = await getDb();
  if (!conn) {
    const store = demoStore();
    return store[collectionName][key] || null;
  }
  const { db, fs } = conn;
  const snap = await fs.getDoc(fs.doc(db, collectionName, key));
  return snap.exists() ? snap.data() : null;
}

async function fetchDonorsByCountry(countryCode) {
  const conn = await getDb();
  if (!conn) {
    const store = demoStore();
    return Object.values(store.donors).filter(d => d.country === countryCode);
  }
  const { db, fs } = conn;
  const q = fs.query(fs.collection(db, "donors"), fs.where("country", "==", countryCode));
  const snap = await fs.getDocs(q);
  return snap.docs.map(d => d.data());
}

// ---- Email-link sign-in (passwordless) -------------------------------------
async function sendLoginLink(email) {
  const conn = await getAuthConn();
  if (!conn) return; // demo mode: nothing to send, caller handles the shortcut
  const { auth, authMod } = conn;
  const url = window.location.origin + window.location.pathname;
  await authMod.sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
  window.localStorage.setItem(EMAIL_STORAGE_KEY, normalizeEmail(email));
}

async function completeLoginWithLink(email) {
  const conn = await getAuthConn();
  if (!conn) return null;
  const { auth, authMod } = conn;
  const result = await authMod.signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_STORAGE_KEY);
  return result.user;
}

async function checkForIncomingSignInLink() {
  if (!isConfigured) return { pending: false };
  const conn = await getAuthConn();
  if (!conn) return { pending: false };
  const { auth, authMod } = conn;
  if (!authMod.isSignInWithEmailLink(auth, window.location.href)) return { pending: false };
  const savedEmail = window.localStorage.getItem(EMAIL_STORAGE_KEY);
  history.replaceState(null, "", window.location.pathname);
  if (savedEmail) {
    await completeLoginWithLink(savedEmail);
    return { pending: true, email: savedEmail };
  }
  return { pending: true, email: null }; // need to ask the user to re-confirm their email
}

function showConfirmModal(message, confirmLabel, cancelLabel) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal-box" role="alertdialog" aria-modal="true">
          <p class="modal-message">${escapeHtml(message)}</p>
          <div class="modal-actions">
            <button type="button" class="btn-ghost modal-cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn-primary modal-confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>`);
    function close(result) { overlay.remove(); resolve(result); }
    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".modal-confirm").addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function el(html) {
  const div = document.createElement("div");
  div.innerHTML = html.trim();
  return div.firstElementChild;
}
function icon(path, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
const ICONS = {
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  drop: icon('<path d="M12 2s7 7.6 7 12.5A7 7 0 0 1 5 14.5C5 9.6 12 2 12 2z"/>'),
  heart: icon('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  check: icon('<path d="M20 6 9 17l-5-5"/>', 28),
  mail: icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>'),
};
function chevronBackIcon() {
  return icon(state.dir === "rtl" ? '<path d="m9 18 6-6-6-6"/>' : '<path d="m15 18-6-6 6-6"/>', 18);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function render(scrollTop) {
  setLangDirection();
  BRAND_TEXT.textContent = tr("appName");
  BRAND_TAGLINE.textContent = tr("tagline");
  LANG_SWITCH_CODE.textContent = state.lang.toUpperCase();
  ROOT.innerHTML = "";
  const screen = state.route || "language";
  const map = {
    language: screenLanguage,
    role: screenRole,
    form: screenForm,
    thankYouDonor: screenThankYouDonor,
    results: screenResults,
    recoverEmail: screenRecoverEmail,
    recoverSent: screenRecoverSent,
    recoverConfirm: screenRecoverConfirm,
    myData: screenMyData,
  };
  ROOT.appendChild((map[screen] || screenLanguage)());
  if (scrollTop !== false) window.scrollTo(0, 0);
}

function backButton(to) {
  const btn = el(`<button class="btn-ghost">${chevronBackIcon()}${tr("back")}</button>`);
  btn.addEventListener("click", () => { state.route = to; render(); });
  return btn;
}

function manageLink() {
  const btn = el(`<button type="button" class="btn-ghost" style="margin-top:4px;">${ICONS.mail}${tr("manageLinkText")}</button>`);
  btn.addEventListener("click", () => { state.route = "recoverEmail"; state.recoverError = ""; render(); });
  return btn;
}

// ---- Screen: language ------------------------------------------------------
function screenLanguage() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(backButton(state.preLanguageRoute || "role"));
  wrap.appendChild(el(`<h1>${tr("chooseLanguage")}</h1>`));

  const searchBox = el(`
    <div class="search-box">
      ${ICONS.search}
      <input type="text" placeholder="${escapeHtml(tr("searchLanguage"))}" value="${escapeHtml(state.langSearch)}" aria-label="${escapeHtml(tr("searchLanguage"))}" />
    </div>`);
  const input = searchBox.querySelector("input");
  input.addEventListener("input", (e) => { state.langSearch = e.target.value; renderList(); });
  wrap.appendChild(searchBox);

  const listWrap = el(`<div class="lang-list" role="listbox"></div>`);
  wrap.appendChild(listWrap);

  function renderList() {
    const query = state.langSearch.trim().toLowerCase();
    const filtered = LANGUAGES.filter(l => l.name.toLowerCase().includes(query) || l.code.toLowerCase().includes(query));
    listWrap.innerHTML = "";
    if (filtered.length === 0) { listWrap.appendChild(el(`<div class="lang-empty">—</div>`)); return; }
    filtered.forEach(l => {
      const btn = el(`<button type="button" class="lang-item${l.code === state.lang ? " selected" : ""}" role="option"><span>${escapeHtml(l.name)}</span></button>`);
      btn.addEventListener("click", () => { state.lang = l.code; state.route = state.preLanguageRoute || "role"; render(); });
      listWrap.appendChild(btn);
    });
  }
  renderList();
  return wrap;
}

// ---- Screen: role -----------------------------------------------------------
function screenRole() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<h1>${tr("roleQuestion")}</h1>`));

  const grid = el(`<div class="role-grid"></div>`);
  const donorCard = el(`
    <button type="button" class="role-card donor">
      <div class="icon">${ICONS.drop}</div>
      <h3>${tr("roleDonor")}</h3>
      <p>${tr("roleDonorDesc")}</p>
    </button>`);
  donorCard.addEventListener("click", () => { state.role = "donor"; state.editing = null; state.form = emptyForm(); state.route = "form"; render(); });

  const recipientCard = el(`
    <button type="button" class="role-card recipient">
      <div class="icon">${ICONS.heart}</div>
      <h3>${tr("roleRecipient")}</h3>
      <p>${tr("roleRecipientDesc")}</p>
    </button>`);
  recipientCard.addEventListener("click", () => { state.role = "recipient"; state.editing = null; state.form = emptyForm(); state.route = "form"; render(); });

  grid.appendChild(donorCard);
  grid.appendChild(recipientCard);
  wrap.appendChild(grid);
  wrap.appendChild(manageLink());
  return wrap;
}

// ---- Screen: form (donor or recipient; also used for editing) --------------
function screenForm() {
  const isDonor = state.role === "donor";
  const isEditing = !!state.editing;
  const wrap = el(`<div></div>`);
  wrap.appendChild(backButton(isEditing ? "myData" : "role"));

  let title = isDonor ? tr("formTitleDonor") : tr("formTitleRecipient");
  if (isEditing) title = isDonor ? tr("editTitleDonor") : tr("editTitleRecipient");
  wrap.appendChild(el(`<h1>${title}</h1>`));

  if (!isConfigured) wrap.appendChild(el(`<div class="demo-banner">${tr("demoNotice")}</div>`));

  const form = el(`<form novalidate></form>`);

  if (isDonor) {
    form.appendChild(fieldText("name", tr("labelName"), "text", true));
  }
  form.appendChild(bloodTypeField());
  form.appendChild(locationFields());
  if (isDonor) {
    form.appendChild(fieldText("phone", tr("labelPhone"), "tel", true));
    form.appendChild(whatsappField());
    const altWrap = el(`<div class="field-group" id="alt-phone-wrap" style="display:none"></div>`);
    altWrap.appendChild(fieldText("altPhone", tr("labelAltPhone"), "tel", false, true));
    form.appendChild(altWrap);
    const emailField = fieldText("email", tr("labelEmail"), "email", true, false, isEditing);
    if (isEditing) {
      const note = el(`<div class="donor-meta" style="margin:-10px 0 14px;">${tr("emailLockedNote")}</div>`);
      emailField.appendChild(note);
    }
    form.appendChild(emailField);
    form.appendChild(notesField());
  }

  const errorBox = el(`<div class="error-text" style="display:none"></div>`);
  form.appendChild(errorBox);

  const submitLabel = isEditing ? tr("saveChangesBtn") : (isDonor ? tr("submitBtn") : tr("searchBtn"));
  const spinnerLabel = isDonor ? tr("savingMsg") : tr("searchingMsg");
  const submitBtn = el(`<button type="submit" class="btn-primary">${submitLabel}</button>`);
  form.appendChild(submitBtn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span>${spinnerLabel}`;
    try {
      const errorKey = await validateForm(isDonor);
      if (errorKey) {
        errorBox.textContent = tr(errorKey);
        errorBox.style.display = "block";
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
        return;
      }
      await handleSubmit(isDonor, isEditing);
    } catch (err) {
      console.error(err);
      errorBox.textContent = (err && err.code === "already-exists") ? tr("alreadyRegisteredError") : tr("saveErrorMsg");
      errorBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  });

  wrap.appendChild(form);
  if (isDonor) updateAltPhoneVisibility();
  return wrap;
}

function updateAltPhoneVisibility() {
  const w = document.getElementById("alt-phone-wrap");
  if (!w) return;
  w.style.display = state.form.hasWhatsapp === false ? "block" : "none";
}

function fieldText(key, label, type, required, optional, disabled) {
  const group = el(`
    <div class="field-group">
      <label for="f-${key}">${label}${optional ? `<span class="tag-optional">(${tr("optional")})</span>` : ""}</label>
      <input id="f-${key}" type="${type}" value="${escapeHtml(state.form[key])}" ${required ? "required" : ""} ${disabled ? "disabled" : ""} autocomplete="off" />
    </div>`);
  const input = group.querySelector("input");
  if (key === "phone" || key === "altPhone") {
    input.addEventListener("input", (e) => {
      const value = enforcePhoneLength(e.target.value, state.form.country);
      if (value !== e.target.value) e.target.value = value;
      state.form[key] = value;
    });
  } else {
    input.addEventListener("input", (e) => { state.form[key] = e.target.value; });
  }
  return group;
}

// If the phone-number library is loaded and the number already has too many
// digits for the selected country, drop the character that just made it too
// long — so typing simply stops accepting digits once the number is complete,
// instead of only rejecting it after the whole form is submitted.
function enforcePhoneLength(value, countryIso) {
  if (!phoneLibModule || !countryIso || !phoneLibModule.validatePhoneNumberLength) return value;
  try {
    const reason = phoneLibModule.validatePhoneNumberLength(value, countryIso);
    if (reason === "TOO_LONG") return value.slice(0, -1);
  } catch (e) { /* ignore and allow typing if the check itself fails */ }
  return value;
}

function bloodTypeField() {
  const group = el(`<div class="field-group"><label>${tr("labelBloodType")}</label><div class="chip-group"></div></div>`);
  const chipGroup = group.querySelector(".chip-group");
  BLOOD_TYPES.forEach(bt => {
    const chip = el(`<button type="button" class="chip${state.form.bloodType === bt ? " selected" : ""}">${bt}</button>`);
    chip.addEventListener("click", () => {
      state.form.bloodType = bt;
      group.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
    });
    chipGroup.appendChild(chip);
  });
  return group;
}

function whatsappField() {
  const group = el(`
    <div class="field-group">
      <label>${tr("hasWhatsapp")}</label>
      <div class="toggle-row">
        <button type="button" class="toggle-btn${state.form.hasWhatsapp === true ? " selected" : ""}" data-v="yes">${tr("yes")}</button>
        <button type="button" class="toggle-btn${state.form.hasWhatsapp === false ? " selected" : ""}" data-v="no">${tr("no")}</button>
      </div>
    </div>`);
  group.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.form.hasWhatsapp = btn.dataset.v === "yes";
      group.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      updateAltPhoneVisibility();
    });
  });
  return group;
}

function notesField() {
  const group = el(`
    <div class="field-group">
      <label>${tr("labelNotes")}<span class="tag-optional">(${tr("optional")})</span></label>
      <textarea placeholder="${escapeHtml(tr("notesPlaceholder"))}">${escapeHtml(state.form.notes)}</textarea>
    </div>`);
  group.querySelector("textarea").addEventListener("input", (e) => { state.form.notes = e.target.value; });
  return group;
}

// ---- Location fields: country -> state -> city, each searchable -----------
function locationFields() {
  const wrap = el(`<div></div>`);
  if (state.countries.length === 0) state.countries = Country.getAllCountries().filter(c => c.isoCode !== "IL");

  const countryGroup = el(`<div class="field-group"><label>${tr("labelCountry")}</label></div>`);
  const countrySelect = buildSearchableSelect({
    id: "country",
    options: state.countries.map(c => ({ value: c.isoCode, label: c.name })),
    selected: state.form.country,
    onChange: (value, label) => {
      state.form.country = value; state.form.countryName = label;
      state.form.state = ""; state.form.stateName = ""; state.form.stateWriteIn = false;
      state.form.city = ""; state.form.cityName = ""; state.form.cityWriteIn = false;
      state.route = "form"; render(false);
    },
  });
  countryGroup.appendChild(countrySelect);
  wrap.appendChild(countryGroup);

  if (state.form.country) {
    const states = State.getStatesOfCountry(state.form.country);
    const stateGroup = el(`<div class="field-group"><label>${tr("labelState")}</label></div>`);
    if (states.length > 0 && !state.form.stateWriteIn) {
      const stateSelect = buildSearchableSelect({
        id: "state",
        options: states.map(s => ({ value: s.isoCode, label: s.name })),
        selected: state.form.state,
        onChange: (value, label) => {
          state.form.state = value; state.form.stateName = label;
          state.form.city = ""; state.form.cityName = ""; state.form.cityWriteIn = false;
          state.route = "form"; render(false);
        },
      });
      stateGroup.appendChild(stateSelect);
      const writeInBtn = el(`<button type="button" class="write-in-toggle">${tr("otherWriteIn")}</button>`);
      writeInBtn.addEventListener("click", () => { state.form.stateWriteIn = true; state.route = "form"; render(false); });
      stateGroup.appendChild(writeInBtn);
    } else {
      const input = el(`<input type="text" placeholder="${escapeHtml(tr("labelState"))}" value="${escapeHtml(state.form.stateCustom)}" />`);
      input.addEventListener("input", (e) => { state.form.stateCustom = e.target.value; state.form.stateName = e.target.value; });
      stateGroup.appendChild(input);
    }
    wrap.appendChild(stateGroup);
  }

  const canShowCity = state.form.country && (state.form.state || state.form.stateWriteIn || State.getStatesOfCountry(state.form.country).length === 0);
  if (canShowCity) {
    const cities = state.form.state ? City.getCitiesOfState(state.form.country, state.form.state) : [];
    const cityGroup = el(`<div class="field-group"><label>${tr("labelCity")}</label></div>`);
    if (cities.length > 0 && !state.form.cityWriteIn) {
      const citySelect = buildSearchableSelect({
        id: "city",
        options: cities.map(c => ({ value: c.name, label: c.name })),
        selected: state.form.city,
        onChange: (value, label) => { state.form.city = value; state.form.cityName = label; state.route = "form"; render(false); },
      });
      cityGroup.appendChild(citySelect);
      const writeInBtn = el(`<button type="button" class="write-in-toggle">${tr("otherWriteIn")}</button>`);
      writeInBtn.addEventListener("click", () => { state.form.cityWriteIn = true; state.route = "form"; render(false); });
      cityGroup.appendChild(writeInBtn);
    } else {
      const input = el(`<input type="text" placeholder="${escapeHtml(tr("labelCity"))}" value="${escapeHtml(state.form.cityCustom)}" />`);
      input.addEventListener("input", (e) => { state.form.cityCustom = e.target.value; state.form.cityName = e.target.value; state.form.city = e.target.value; });
      cityGroup.appendChild(input);
    }
    wrap.appendChild(cityGroup);
  }
  return wrap;
}

function buildSearchableSelect({ id, options, selected, onChange }) {
  const wrap = el(`<div class="search-box" style="margin-bottom:8px"></div>`);
  const selectedLabel = options.find(o => o.value === selected)?.label || "";
  wrap.innerHTML = `${ICONS.search}<input type="text" data-role="ss-input-${id}" placeholder="${escapeHtml(tr("selectPlaceholder"))}" value="${escapeHtml(selectedLabel)}" autocomplete="off" />`;
  const input = wrap.querySelector("input");
  const listBox = el(`<div class="lang-list" style="margin-top:6px; max-height:220px;"></div>`);
  listBox.style.display = "none";

  function renderOptions(query) {
    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
    listBox.innerHTML = "";
    filtered.slice(0, 200).forEach(o => {
      const item = el(`<button type="button" class="lang-item${o.value === selected ? " selected" : ""}">${escapeHtml(o.label)}</button>`);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); onChange(o.value, o.label); });
      listBox.appendChild(item);
    });
    if (filtered.length === 0) listBox.appendChild(el(`<div class="lang-empty">—</div>`));
  }
  input.addEventListener("focus", () => { renderOptions(input.value === selectedLabel ? "" : input.value); listBox.style.display = "block"; });
  input.addEventListener("input", () => renderOptions(input.value));
  input.addEventListener("blur", () => setTimeout(() => { listBox.style.display = "none"; }, 120));

  const holder = el(`<div></div>`);
  holder.appendChild(wrap);
  holder.appendChild(listBox);
  return holder;
}

// ---------------------------------------------------------------------------
// Validation + submit
// ---------------------------------------------------------------------------
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]{1,}$/u;
const PHONE_FALLBACK_RE = /^\+?[0-9][0-9\s-]{6,17}$/; // used only if the phone-number library fails to load

function isValidName(name) { return NAME_RE.test(String(name || "").trim()); }

// libphonenumber-js knows each country's real number length/format rules (e.g. an
// Egyptian mobile is exactly 11 digits). We load it lazily, and fall back to a loose
// generic check if the CDN is unreachable, so a network hiccup never blocks signup.
let phoneLibPromise = null;
let phoneLibModule = null; // set once resolved, so keystroke handlers can use it synchronously
function getPhoneLib() {
  if (!phoneLibPromise) {
    phoneLibPromise = import("https://cdn.jsdelivr.net/npm/libphonenumber-js/+esm")
      .then(mod => { phoneLibModule = mod; return mod; })
      .catch(() => null);
  }
  return phoneLibPromise;
}
getPhoneLib(); // start loading right away so it's ready before anyone reaches the phone field

async function isValidPhoneForCountry(phone, countryIso) {
  const p = String(phone || "").trim();
  if (!p) return false;
  try {
    const lib = await getPhoneLib();
    if (lib && typeof lib.isValidPhoneNumber === "function" && countryIso) {
      return lib.isValidPhoneNumber(p, countryIso);
    }
  } catch (e) { /* fall through to the generic check below */ }
  return PHONE_FALLBACK_RE.test(p);
}

// Returns an i18n error key if the form is invalid, or null if it's ready to submit.
async function validateForm(isDonor) {
  const f = state.form;
  const locationOk = f.country && (f.city || f.cityCustom);
  const bloodOk = !!f.bloodType;

  if (!isDonor) {
    if (!bloodOk || !locationOk) return "requiredError";
    return null;
  }

  if (!f.name || !bloodOk || !locationOk || !f.phone || f.hasWhatsapp === null || !f.email) return "requiredError";
  if (!isValidName(f.name)) return "invalidNameError";
  if (!(await isValidPhoneForCountry(f.phone, f.country))) return "invalidPhoneError";
  if (f.hasWhatsapp === false && f.altPhone && !(await isValidPhoneForCountry(f.altPhone, f.country))) return "invalidPhoneError";
  if (!/\S+@\S+\.\S+/.test(f.email)) return "requiredError";
  return null;
}

function buildRecord() {
  const f = state.form;
  return {
    name: f.name,
    bloodType: f.bloodType,
    country: f.country,
    countryName: f.countryName,
    state: f.stateWriteIn ? f.stateCustom : f.state,
    stateName: f.stateWriteIn ? f.stateCustom : f.stateName,
    city: f.cityWriteIn ? f.cityCustom : f.city,
    cityName: f.cityWriteIn ? f.cityCustom : f.cityName,
    phone: f.phone,
    hasWhatsapp: f.hasWhatsapp,
    altPhone: f.altPhone || null,
    notes: f.notes || null,
  };
}

async function handleSubmit(isDonor, isEditing) {
  const f = state.form;

  if (!isDonor) {
    // Recipients never save anything — this is a live search, not a registration.
    const matchTypes = donorsThatCanServe(f.bloodType);
    const donors = await fetchDonorsByCountry(f.country);
    const matched = donors
      .filter(d => matchTypes.includes(d.bloodType))
      .map(d => ({ ...d, proximity: proximityScore(d, f), exact: d.bloodType === f.bloodType }))
      .sort((a, b) => (a.proximity - b.proximity) || (a.exact === b.exact ? 0 : a.exact ? -1 : 1));
    state.results = matched;
    state.route = "results";
    render();
    return;
  }

  const collection = "donors";
  const record = buildRecord();

  if (isEditing) {
    await updateRecord(collection, f.email, record);
    state.myData.donor = { ...record, email: normalizeEmail(f.email) };
    state.route = "myData";
    render();
    return;
  }

  await createRecord(collection, f.email, record);
  state.route = "thankYouDonor";
  render();
}

function proximityScore(donor, recipientForm) {
  if (donor.city && donor.city === (recipientForm.cityWriteIn ? recipientForm.cityCustom : recipientForm.city)) return 0;
  if (donor.state && donor.state === (recipientForm.stateWriteIn ? recipientForm.stateCustom : recipientForm.state)) return 1;
  return 2;
}

// ---- Screen: thank you (donor) ---------------------------------------------
function screenThankYouDonor() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<div class="confirm-badge">${ICONS.check}</div>`));
  wrap.appendChild(el(`<h1>${tr("thankYouDonorTitle")}</h1>`));
  wrap.appendChild(el(`<p class="subtitle">${tr("thankYouDonorBody")}</p>`));
  wrap.appendChild(el(`<div class="demo-banner">${tr("saveEmailNote")}</div>`));
  const btn = el(`<button type="button" class="btn-primary">${tr("newSearch")}</button>`);
  btn.addEventListener("click", () => { resetFlow(); render(); });
  wrap.appendChild(btn);
  return wrap;
}

// ---- Screen: results (recipient) -------------------------------------------
function screenResults() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<h1>${tr("thankYouRecipientTitle")}</h1>`));
  wrap.appendChild(el(`<p class="subtitle">${tr("resultsIntro")}</p>`));

  const results = state.results || [];
  if (results.length === 0) {
    wrap.appendChild(el(`<div class="empty-state">${tr("noMatches")}</div>`));
  } else {
    results.forEach(d => wrap.appendChild(donorCard(d)));
  }
  const btn = el(`<button type="button" class="btn-primary">${tr("newSearch")}</button>`);
  btn.addEventListener("click", () => { resetFlow(); render(); });
  wrap.appendChild(btn);
  return wrap;
}

function toInternationalDigits(phone, countryIso) {
  let p = String(phone || "").replace(/[^\d+]/g, "");
  if (!p) return "";
  if (p.startsWith("+")) return p.slice(1);
  const country = state.countries.find(c => c.isoCode === countryIso);
  const code = country ? String(country.phonecode || "").replace(/[^\d]/g, "") : "";
  if (p.startsWith("0")) p = p.slice(1);
  return code ? `${code}${p}` : p;
}

function donorCard(d) {
  const proximityLabel = d.proximity === 0 ? tr("matchSameCity") : d.proximity === 1 ? tr("matchSameState") : tr("matchSameCountry");
  const matchLabel = d.exact ? tr("exactMatch") : tr("compatibleMatch");
  // The number that actually has WhatsApp: the primary phone if the donor said
  // so, otherwise the alternate number they gave specifically because it has WhatsApp.
  const whatsappSourceNumber = d.hasWhatsapp ? d.phone : d.altPhone;
  const whatsappDigits = whatsappSourceNumber ? toInternationalDigits(whatsappSourceNumber, d.country) : "";
  return el(`
    <div class="donor-card">
      <div class="donor-card-top">
        <div>
          <div class="donor-name">${escapeHtml(d.name)}</div>
          <div class="donor-meta">${escapeHtml(d.cityName || d.city || "")}${d.stateName ? ", " + escapeHtml(d.stateName) : ""}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
          <span class="badge blood">${escapeHtml(d.bloodType)} · ${escapeHtml(matchLabel)}</span>
          <span class="badge proximity">${escapeHtml(proximityLabel)}</span>
        </div>
      </div>
      <div class="donor-actions">
        <a class="call" href="tel:${encodeURIComponent(d.phone)}">${tr("contactCall")}</a>
        ${whatsappDigits ? `<a class="whatsapp" target="_blank" rel="noopener" href="https://wa.me/${whatsappDigits}">${tr("contactWhatsapp")}</a>` : ""}
        ${d.email ? `<a class="email" href="mailto:${encodeURIComponent(d.email)}">${tr("contactEmail")}</a>` : ""}
      </div>
    </div>`);
}

// ---- Screen: recover — enter email ------------------------------------------
function screenRecoverEmail() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(backButton("role"));
  wrap.appendChild(el(`<h1>${tr("recoverTitle")}</h1>`));
  wrap.appendChild(el(`<p class="subtitle">${tr("recoverSubtitle")}</p>`));

  const form = el(`<form novalidate></form>`);
  const group = el(`
    <div class="field-group">
      <label>${tr("recoverEmailLabel")}</label>
      <input type="email" required autocomplete="off" value="${escapeHtml(state.recoverEmail)}" />
    </div>`);
  group.querySelector("input").addEventListener("input", (e) => { state.recoverEmail = e.target.value; });
  form.appendChild(group);

  const errorBox = el(`<div class="error-text" style="display:${state.recoverError ? "block" : "none"}">${escapeHtml(state.recoverError)}</div>`);
  form.appendChild(errorBox);

  const btn = el(`<button type="submit" class="btn-primary">${tr("recoverSendBtn")}</button>`);
  form.appendChild(btn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = normalizeEmail(state.recoverEmail);
    if (!/\S+@\S+\.\S+/.test(email)) {
      errorBox.textContent = tr("requiredError");
      errorBox.style.display = "block";
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${tr("savingMsg")}`;
    try {
      if (!isConfigured) {
        // Demo mode: skip the real email round-trip so the flow stays testable.
        await loadMyData(email);
        state.route = "myData";
        render();
        return;
      }
      await sendLoginLink(email);
      state.recoverSentTo = email;
      state.route = "recoverSent";
      render();
    } catch (err) {
      console.error(err);
      errorBox.textContent = tr("recoverErrorGeneric");
      errorBox.style.display = "block";
      btn.disabled = false;
      btn.textContent = tr("recoverSendBtn");
    }
  });

  wrap.appendChild(form);
  return wrap;
}

function screenRecoverSent() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<div class="confirm-badge">${ICONS.mail}</div>`));
  wrap.appendChild(el(`<h1>${tr("recoverSentTitle")}</h1>`));
  wrap.appendChild(el(`<p class="subtitle">${escapeHtml(trf("recoverSentBody", { email: state.recoverSentTo }))}</p>`));
  return wrap;
}

// ---- Screen: recover — confirm email (cross-device link open) -------------
function screenRecoverConfirm() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<h1>${tr("recoverConfirmTitle")}</h1>`));
  wrap.appendChild(el(`<p class="subtitle">${tr("recoverConfirmBody")}</p>`));

  const form = el(`<form novalidate></form>`);
  const group = el(`<div class="field-group"><label>${tr("recoverEmailLabel")}</label><input type="email" required autocomplete="off" /></div>`);
  group.querySelector("input").addEventListener("input", (e) => { state.recoverEmail = e.target.value; });
  form.appendChild(group);
  const errorBox = el(`<div class="error-text" style="display:none"></div>`);
  form.appendChild(errorBox);
  const btn = el(`<button type="submit" class="btn-primary">${tr("recoverConfirmBtn")}</button>`);
  form.appendChild(btn);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = normalizeEmail(state.recoverEmail);
    btn.disabled = true;
    try {
      await completeLoginWithLink(email);
      await loadMyData(email);
      state.route = "myData";
      render();
    } catch (err) {
      console.error(err);
      errorBox.textContent = tr("recoverErrorInvalidLink");
      errorBox.style.display = "block";
      btn.disabled = false;
    }
  });

  wrap.appendChild(form);
  return wrap;
}

// ---- Screen: my data (view / edit / delete) --------------------------------
async function loadMyData(email) {
  const key = normalizeEmail(email);
  const donor = await fetchOwnRecord("donors", key);
  state.myData = { donor: donor ? { ...donor, email: key } : null, recipient: null };
}

function screenMyData() {
  const wrap = el(`<div></div>`);
  wrap.appendChild(el(`<h1>${tr("myDataTitle")}</h1>`));

  const { donor } = state.myData;
  if (!donor) {
    wrap.appendChild(el(`<div class="empty-state">${tr("myDataEmpty")}</div>`));
  } else {
    wrap.appendChild(myDataCard(donor, "donors", tr("myDataDonorLabel")));
  }

  const btn = el(`<button type="button" class="btn-primary">${tr("newSearch")}</button>`);
  btn.addEventListener("click", () => { resetFlow(); render(); });
  wrap.appendChild(btn);
  return wrap;
}

function myDataCard(record, collection, label) {
  const isDonor = collection === "donors";
  const card = el(`
    <div class="donor-card">
      <div class="donor-card-top">
        <div>
          <div class="donor-meta">${escapeHtml(label)}</div>
          <div class="donor-name">${escapeHtml(record.name)}</div>
          <div class="donor-meta">${escapeHtml(record.cityName || record.city || "")}${record.stateName ? ", " + escapeHtml(record.stateName) : ""}</div>
        </div>
        <span class="badge blood">${escapeHtml(record.bloodType)}</span>
      </div>
      <div class="donor-actions">
        <a href="#" class="edit-btn call">${tr("editBtn")}</a>
        <a href="#" class="delete-btn whatsapp">${tr("deleteBtn")}</a>
      </div>
    </div>`);

  card.querySelector(".edit-btn").addEventListener("click", (e) => {
    e.preventDefault();
    state.role = isDonor ? "donor" : "recipient";
    state.editing = { collection };
    const f = emptyForm();
    Object.assign(f, {
      name: record.name || "", bloodType: record.bloodType || "",
      country: record.country || "", countryName: record.countryName || "",
      phone: record.phone || "", hasWhatsapp: record.hasWhatsapp !== undefined ? record.hasWhatsapp : null,
      altPhone: record.altPhone || "", email: record.email || "", notes: record.notes || "",
    });
    // Figure out whether the saved state/city match a known picklist entry, or need write-in mode.
    const statesForCountry = record.country ? State.getStatesOfCountry(record.country) : [];
    const stateMatch = statesForCountry.find(s => s.isoCode === record.state);
    if (stateMatch) { f.state = record.state; f.stateName = record.stateName; f.stateWriteIn = false; }
    else if (record.state) { f.stateWriteIn = true; f.stateCustom = record.stateName || record.state; f.stateName = f.stateCustom; }
    const citiesForState = (record.country && stateMatch) ? City.getCitiesOfState(record.country, record.state) : [];
    const cityMatch = citiesForState.find(c => c.name === record.city);
    if (cityMatch) { f.city = record.city; f.cityName = record.cityName; f.cityWriteIn = false; }
    else if (record.city) { f.cityWriteIn = true; f.cityCustom = record.cityName || record.city; f.cityName = f.cityCustom; }

    state.form = f;
    state.route = "form";
    render();
  });

  card.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    const confirmed = await showConfirmModal(tr("deleteConfirmMsg"), tr("deleteBtn"), tr("back"));
    if (!confirmed) return;
    await deleteRecord(collection, record.email);
    state.myData[isDonor ? "donor" : "recipient"] = null;
    render();
  });

  return card;
}

function resetFlow() {
  state.role = null;
  state.route = "role";
  state.results = null;
  state.editing = null;
  state.recoverEmail = "";
  state.recoverError = "";
  state.form = emptyForm();
}

// ---------------------------------------------------------------------------
// Boot: handle an incoming email sign-in link before the first render.
// ---------------------------------------------------------------------------
LANG_SWITCH_BTN.addEventListener("click", () => {
  state.preLanguageRoute = state.route;
  state.route = "language";
  render();
});

(async function boot() {
  state.lang = detectDeviceLanguage();
  state.route = "role"; // skip the language screen by default — it's auto-detected
  try {
    const linkResult = await checkForIncomingSignInLink();
    if (linkResult.pending) {
      if (linkResult.email) {
        await loadMyData(linkResult.email);
        state.route = "myData";
      } else {
        state.route = "recoverConfirm";
      }
    }
  } catch (err) {
    console.error(err);
    state.route = "recoverEmail";
    state.recoverError = tr("recoverErrorInvalidLink");
  }
  render();
})();
