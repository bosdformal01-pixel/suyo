// ============================================================
//  수요미식회 — 메인 스크립트 (v2)
//  설정값은 config.js, 권한 규칙은 firestore.rules 에 있어요.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updatePassword, reauthenticateWithCredential, linkWithCredential, EmailAuthProvider, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, deleteField,
  collection, query, where, orderBy, limit, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = window.SUYO_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const ROLE_LABEL = { admin: "회장", officer: "임원", member: "멤버" };

// ---------- 공통 화면 도우미 ----------
function gateError(msg) {
  $("#gate-loading").hidden = true;
  $("#auth-box").hidden = true;
  const el = $("#gate-error");
  el.textContent = msg;
  el.hidden = false;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
function errMsg(e) {
  console.error(e);
  if (e?.code === "permission-denied") return "권한이 없어요.";
  if (e?.code === "unavailable") return "인터넷 연결을 확인해 주세요.";
  return "문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
}
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* 무시 */ } };

// ---------- 날짜 ----------
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
function today0() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function nextWedFrom(d) { const x = new Date(d); x.setDate(x.getDate() + ((3 - x.getDay() + 7) % 7)); return x; }
function wednesday(offsetWeeks = 0) { const d = nextWedFrom(today0()); d.setDate(d.getDate() + offsetWeeks * 7); return d; }
function toDate(ts) { return ts?.toDate ? ts.toDate() : null; }
function hhmm(d) { return d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : ""; }
function dayLabel(d) { return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})`; }
function ago(d) {
  if (!d) return "방금";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- 화면 모드 (자동 / 라이트 / 나이트) ----------
function applyTheme(v) {
  if (v === "light" || v === "dark") { document.documentElement.setAttribute("data-theme", v); lsSet("suyo-theme", v); }
  else { document.documentElement.removeAttribute("data-theme"); lsDel("suyo-theme"); }
  const cur = lsGet("suyo-theme") || "auto";
  $$("#theme-seg button").forEach((b) => b.classList.toggle("on", b.dataset.themeVal === cur));
}
$$("#theme-seg button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeVal)));
applyTheme(lsGet("suyo-theme") || "auto");

// ---------- 설정 확인 ----------
if (!CFG.firebase || !CFG.firebase.apiKey || !CFG.firebase.projectId) {
  gateError("아직 설정이 안 됐어요.\nconfig.js 파일에 Firebase 설정값을 넣어 주세요.");
  throw new Error("config.js 미설정");
}

const fbApp = initializeApp(CFG.firebase);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const SNAP = { serverTimestamps: "estimate" };

// ---------- 상태 ----------
const S = {
  uid: null, me: null,
  members: {},
  weekOffset: 0, wedKey: dateKey(wednesday(0)),
  attendance: [], event: null, allEvents: {},
  schedule: [],
  polls: [], votes: {},
  messages: [],
  places: [], reviews: [],
  invites: [],
  notices: [], allYes: [], routes: {},
  settle: null, paid: {},
  selected: null, myStars: 0,
  tab: "home",
  lastPw: null, // 방금 로그인할 때 쓴 비밀번호 (비밀번호 변경 창에서 다시 묻지 않으려고 메모리에만 보관)
};
const myRole = () => S.me?.role || "member";
const isAdmin = () => myRole() === "admin";
const isOfficer = () => ["admin", "officer"].includes(myRole());
const memberName = (uid, fallback) => S.members[uid]?.name || fallback || "알 수 없음";

// ============================================================
//  로그인: 닉네임 + 비밀번호
//  (닉네임을 내부용 이메일 주소로 바꿔서 Firebase 로그인을 써요. 사용자는 이메일을 몰라도 돼요.)
// ============================================================
function normName(name) { return name.trim().normalize("NFC").toLowerCase(); }
async function loginEmail(name) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("suyo:" + normName(name)));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `m${hex}@suyo-misikhoe.app`;
}

let authMode = "login";
function setAuthMode(m) {
  authMode = m;
  $("#mode-login").classList.toggle("on", m === "login");
  $("#mode-join").classList.toggle("on", m === "join");
  $("#join-extra").hidden = m !== "join";
  $("#auth-code").required = m === "join";
  $("#auth-pw-label").textContent = m === "join" ? "초대 코드 (회장에게 받은 초기 비밀번호)" : "비밀번호";
  $("#auth-pw").type = m === "join" ? "text" : "password";
  $("#auth-pw").autocomplete = m === "join" ? "off" : "current-password";
  $("#auth-submit").textContent = m === "join" ? "가입하기" : "로그인";
  $("#auth-hint").textContent = m === "join"
    ? "가입하면 바로 새 비밀번호를 정하는 창이 떠요. 그다음부터는 닉네임 + 새 비밀번호로 로그인해요."
    : "가입할 때 쓴 닉네임과 비밀번호로 어느 기기에서나 로그인할 수 있어요.";
}
$("#mode-login").addEventListener("click", () => setAuthMode("login"));
$("#mode-join").addEventListener("click", () => setAuthMode("join"));

function showAuth(msg) {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  $("#gate-loading").hidden = true;
  $("#gate-error").hidden = true;
  $("#auth-box").hidden = false;
  if (msg) toast(msg);
  setTimeout(() => $("#auth-name").focus(), 50);
}

let registering = false;
onAuthStateChanged(auth, async (user) => {
  if (registering) return; // 가입 처리 중에는 가입 코드가 직접 이어서 처리해요
  if (!user) { stopApp(); showAuth(); return; }
  await enterWithUser(user);
});

async function enterWithUser(user) {
  S.uid = user.uid;
  try {
    const snap = await getDoc(doc(db, "members", user.uid));
    if (!snap.exists()) {
      await signOut(auth);
      showAuth(user.isAnonymous ? "로그인 방식이 바뀌었어요. '처음이에요' 탭에서 초대 코드로 가입해 주세요." : "멤버 정보가 없어요. 회장에게 문의해 주세요.");
      return;
    }
    S.me = snap.data();
    startApp();
    if (user.isAnonymous) openPw("migrate");
    else if (S.me.mustChangePw) openPw("forced");
  } catch (e) {
    console.error(e);
    gateError("데이터베이스에 연결할 수 없어요.\nFirestore 규칙(firestore.rules)을 게시했는지 확인해 주세요.");
  }
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#auth-name").value.trim();
  const rawPw = $("#auth-pw").value;
  const pw = authMode === "join" ? rawPw.trim() : rawPw;
  if (!name || !pw) return;
  const btn = $("#auth-submit");
  btn.disabled = true;
  try {
    const email = await loginEmail(name);
    if (authMode === "login") await doLogin(email, pw);
    else await doJoin(name, email, pw, $("#auth-code").value.trim());
  } finally {
    btn.disabled = false;
  }
});

async function doLogin(email, pw) {
  try {
    S.lastPw = pw;
    await signInWithEmailAndPassword(auth, email, pw); // 성공하면 onAuthStateChanged 가 이어서 처리
  } catch (err) {
    S.lastPw = null;
    console.error(err);
    if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err.code))
      toast("닉네임 또는 비밀번호가 맞지 않아요. 처음이면 '처음이에요' 탭을 눌러 주세요.");
    else if (err.code === "auth/too-many-requests") toast("너무 많이 틀렸어요. 잠시 후 다시 시도해 주세요.");
    else if (err.code === "auth/operation-not-allowed") toast("Firebase에서 '이메일/비밀번호' 로그인을 켜 주세요.");
    else toast(errMsg(err));
  }
}

async function doJoin(name, email, invite, joinCode) {
  if (invite.length < 6) { toast("초대 코드를 다시 확인해 주세요."); return; }
  if (!joinCode) { toast("입장 코드를 입력해 주세요."); return; }
  registering = true;
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, invite);
  } catch (err) {
    registering = false;
    console.error(err);
    if (err.code === "auth/email-already-in-use") toast("이미 가입된 닉네임이에요. 로그인 탭에서 로그인하거나 다른 닉네임을 써 주세요.");
    else if (err.code === "auth/operation-not-allowed") toast("Firebase에서 '이메일/비밀번호' 로그인을 켜 주세요.");
    else toast(errMsg(err));
    return;
  }
  const uid = cred.user.uid;
  try {
    const b = writeBatch(db);
    b.set(doc(db, "members", uid), { uid, name, joinCode, invite, mustChangePw: true, joinedAt: serverTimestamp() });
    b.update(doc(db, "invites", invite), { usedBy: uid, usedByName: name, usedAt: serverTimestamp() });
    await b.commit();
  } catch (err) {
    console.error(err);
    await deleteUser(cred.user).catch(() => signOut(auth)); // 실패하면 만든 계정을 지워서 닉네임을 다시 쓸 수 있게
    registering = false;
    toast("초대 코드나 입장 코드가 맞지 않아요. (이미 사용된 초대 코드일 수도 있어요)");
    return;
  }
  registering = false;
  S.lastPw = invite;
  await enterWithUser(cred.user);
}

// ============================================================
//  비밀번호 창 (첫 로그인 강제 변경 / 직접 변경 / 예전 계정 전환)
// ============================================================
let pwMode = "change";
function openPw(mode) {
  pwMode = mode;
  const forced = mode === "forced" || mode === "migrate";
  const titles = {
    forced: ["새 비밀번호를 정해 주세요", "초대 코드는 처음 한 번만 쓰는 비밀번호예요. 앞으로 쓸 내 비밀번호로 바꿔야 사이트를 쓸 수 있어요."],
    migrate: ["새 로그인 방식으로 바꿔요", `앞으로는 닉네임 '${S.me?.name}'과 비밀번호로 어느 기기에서나 로그인해요. 사용할 비밀번호를 정해 주세요.`],
    change: ["비밀번호 바꾸기", "지금 비밀번호를 한 번 더 확인해요."],
  };
  $("#pw-title").textContent = titles[mode][0];
  $("#pw-desc").textContent = titles[mode][1];
  const needCur = mode === "change" || (mode === "forced" && !S.lastPw);
  $("#pw-cur-wrap").hidden = !needCur;
  $("#pw-cur").required = needCur;
  $("#pw-cur").previousElementSibling.textContent = mode === "forced" ? "초대 코드 (지금 비밀번호)" : "지금 비밀번호";
  $("#pw-cancel").hidden = forced;
  $("#pw-err").hidden = true;
  ["#pw-cur", "#pw-new", "#pw-new2"].forEach((s) => ($(s).value = ""));
  $("#pw-modal").hidden = false;
  setTimeout(() => $(needCur ? "#pw-cur" : "#pw-new").focus(), 50);
}
function pwError(msg) { const el = $("#pw-err"); el.textContent = msg; el.hidden = false; }
$("#pw-cancel").addEventListener("click", () => ($("#pw-modal").hidden = true));
$("#set-pw").addEventListener("click", () => { closeSheet(); openPw(auth.currentUser?.isAnonymous ? "migrate" : "change"); });

$("#pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur = $("#pw-cur-wrap").hidden ? S.lastPw : $("#pw-cur").value;
  const npw = $("#pw-new").value, npw2 = $("#pw-new2").value;
  if (npw.length < 6) return pwError("새 비밀번호는 6자 이상이어야 해요.");
  if (npw !== npw2) return pwError("새 비밀번호 두 칸이 서로 달라요.");
  if (cur && npw === cur) return pwError("지금 비밀번호와 다른 비밀번호로 정해 주세요.");
  const btn = $("#pw-submit");
  btn.disabled = true;
  const user = auth.currentUser;
  try {
    if (pwMode === "migrate") {
      await linkWithCredential(user, EmailAuthProvider.credential(await loginEmail(S.me.name), npw));
    } else {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
      await updatePassword(user, npw);
      if (S.me.mustChangePw || S.me.invite) {
        await updateDoc(doc(db, "members", S.uid), { mustChangePw: false, invite: deleteField() });
        S.me.mustChangePw = false; delete S.me.invite;
      }
    }
    S.lastPw = null;
    $("#pw-modal").hidden = true;
    toast(pwMode === "migrate" ? "전환 완료! 이제 닉네임 + 비밀번호로 로그인해요" : "비밀번호를 바꿨어요");
  } catch (err) {
    console.error(err);
    if (["auth/invalid-credential", "auth/wrong-password"].includes(err.code)) pwError("지금 비밀번호가 맞지 않아요.");
    else if (err.code === "auth/weak-password") pwError("더 어려운 비밀번호로 정해 주세요. (6자 이상)");
    else if (err.code === "auth/email-already-in-use" || err.code === "auth/credential-already-in-use") pwError("같은 닉네임으로 된 계정이 이미 있어요. 회장에게 문의해 주세요.");
    else if (err.code === "auth/operation-not-allowed") pwError("Firebase에서 '이메일/비밀번호' 로그인을 먼저 켜 주세요.");
    else if (err.code === "auth/requires-recent-login") { pwError("보안을 위해 다시 로그인해 주세요."); setTimeout(() => signOut(auth), 1500); }
    else pwError(errMsg(err));
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
//  앱 시작 & 실시간 구독
// ============================================================
let unsubs = [];
let started = false;
function stopApp() {
  unsubs.forEach((u) => u()); unsubs = [];
  weekUnsubs.forEach((u) => u()); weekUnsubs = [];
  Object.values(voteUnsubs).forEach((u) => u());
  for (const k of Object.keys(voteUnsubs)) delete voteUnsubs[k];
  stopInvites();
  ["#pw-modal", "#settings", "#cal", "#history"].forEach((s) => ($(s).hidden = true));
  $("#auth-pw").value = "";
  started = false;
  S.me = null; S.uid = null;
}

function startApp() {
  if (started) return;
  started = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  renderMe();

  unsubs.push(onSnapshot(collection(db, "members"), (qs) => {
    S.members = {};
    qs.forEach((d) => (S.members[d.id] = d.data()));
    if (S.members[S.uid]) {
      const keepPw = S.me?.mustChangePw === false ? { mustChangePw: false } : {};
      S.me = { ...S.members[S.uid], ...keepPw };
    }
    renderMe(); renderHome(); renderMembers(); renderSettle(); renderNotices(); renderHistory();
  }));

  subscribeWeek();

  unsubs.push(onSnapshot(collection(db, "events"), (qs) => {
    S.allEvents = {};
    qs.forEach((d) => (S.allEvents[d.id] = d.data()));
    renderCalendar(); renderHistory(); renderPicker();
  }));

  unsubs.push(onSnapshot(query(collection(db, "attendance"), where("status", "==", "yes")), (qs) => {
    S.allYes = qs.docs.map((d) => d.data());
    renderHistory();
  }));

  unsubs.push(onSnapshot(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(5)), (qs) => {
    S.notices = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderNotices();
  }));

  unsubs.push(onSnapshot(collection(db, "schedule"), (qs) => {
    S.schedule = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })).sort((a, b) => a.date.localeCompare(b.date));
    renderHome(); renderCalendar();
  }));

  unsubs.push(onSnapshot(query(collection(db, "polls"), orderBy("createdAt", "desc"), limit(30)), (qs) => {
    S.polls = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    syncVoteSubs();
    renderPolls(); renderHome();
  }));

  unsubs.push(onSnapshot(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(200)), (qs) => {
    S.messages = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })).reverse();
    renderChat(); renderHome();
  }));

  unsubs.push(onSnapshot(collection(db, "places"), (qs) => {
    S.places = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderPlaces(); renderPlaceOptions(); renderHome();
  }));

  unsubs.push(onSnapshot(collection(db, "routes"), (qs) => {
    S.routes = {};
    qs.forEach((d) => (S.routes[d.id] = d.data()));
    renderHome();
    if (S.selected) renderDetail();
  }));

  unsubs.push(onSnapshot(collection(db, "reviews"), (qs) => {
    S.reviews = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderPlaces();
  }));

  const start = location.hash.replace("#", "");
  showTab(["home", "polls", "chat", "places"].includes(start) ? start : "home");
}

function renderMe() {
  if (!S.me) return;
  const title = S.me.title || (S.me.role === "admin" ? "회장" : S.me.role === "officer" ? "임원" : "");
  $("#me-name").textContent = S.me.name;
  $("#me-title").textContent = title;
  $("#set-title").textContent = S.me.name;
  $("#set-sub").textContent = [title, ROLE_LABEL[myRole()] !== title ? ROLE_LABEL[myRole()] + " 권한" : ""].filter(Boolean).join(" · ") || "멤버";
  $("#admin-group").hidden = !isAdmin();
}

let weekUnsubs = [];
function subscribeWeek() {
  weekUnsubs.forEach((u) => u());
  S.wedKey = dateKey(wednesday(S.weekOffset));
  S.attendance = []; S.event = null;
  weekUnsubs = [
    onSnapshot(query(collection(db, "attendance"), where("date", "==", S.wedKey)), (qs) => {
      S.attendance = qs.docs.map((d) => d.data());
      renderHome();
    }),
    onSnapshot(doc(db, "events", S.wedKey), (d) => {
      S.event = d.exists() ? d.data(SNAP) : null;
      renderHome();
    }),
    onSnapshot(doc(db, "settlements", S.wedKey), (d) => {
      S.settle = d.exists() ? d.data(SNAP) : null;
      renderSettle();
    }),
    onSnapshot(collection(db, "settlements", S.wedKey, "paid"), (qs) => {
      S.paid = {};
      qs.forEach((d) => (S.paid[d.id] = d.data()));
      renderSettle();
    }),
  ];
  S.settle = null; S.paid = {};
  closeSettleForm();
  renderHome();
}

const voteUnsubs = {};
function syncVoteSubs() {
  const ids = new Set(S.polls.map((p) => p.id));
  for (const id of Object.keys(voteUnsubs)) {
    if (!ids.has(id)) { voteUnsubs[id](); delete voteUnsubs[id]; delete S.votes[id]; }
  }
  for (const id of ids) {
    if (voteUnsubs[id]) continue;
    voteUnsubs[id] = onSnapshot(collection(db, "polls", id, "votes"), (qs) => {
      S.votes[id] = qs.docs.map((d) => d.data());
      renderPolls(); renderHome();
    });
  }
}

// ============================================================
//  탭
// ============================================================
function showTab(tab) {
  S.tab = tab;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== tab));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  window.scrollTo(0, 0);
  if (tab === "chat") { markChatRead(); scrollChatBottom(); }
  if (tab === "places") initMap();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) showTab(g.dataset.goto);
  if (e.target.closest("[data-open-cal]")) openCal();
});

// ============================================================
//  설정 시트 (이름 버튼)
// ============================================================
function openSheet() { showPage("main"); $("#settings").hidden = false; }
function closeSheet() { $("#settings").hidden = true; }
function showPage(p) {
  $$("#settings .sheet-page").forEach((el) => (el.hidden = el.dataset.page !== p));
  if (p === "invites") startInvites();
  if (p === "members") renderMembers();
}
$("#me-btn").addEventListener("click", openSheet);
$("#settings").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close-sheet]")) closeSheet();
  const go = e.target.closest("[data-page-go]");
  if (go) showPage(go.dataset.pageGo);
});
$("#set-logout").addEventListener("click", async () => {
  if (auth.currentUser?.isAnonymous) { toast("먼저 '비밀번호 바꾸기'로 새 로그인 방식으로 바꿔 주세요."); return; }
  closeSheet();
  await signOut(auth);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#history").hidden) $("#history").hidden = true;
  else if (!$("#cal").hidden) closeCal();
  else if (!$("#settings").hidden) closeSheet();
  else if (!$("#pw-modal").hidden && !$("#pw-cancel").hidden) $("#pw-modal").hidden = true;
});

// 멤버 목록 / 역할 관리
function renderMembers() {
  const list = $("#mem-list");
  if (!list) return;
  const rows = Object.entries(S.members).sort(([, a], [, b]) => {
    const order = { admin: 0, officer: 1, member: 2 };
    return (order[a.role || "member"] - order[b.role || "member"]) || a.name.localeCompare(b.name, "ko");
  });
  $("#mem-count").textContent = `${rows.length}명`;
  $("#mem-help").textContent = isAdmin()
    ? "역할: 회장은 모든 관리, 임원은 캘린더 일정 관리를 할 수 있어요. 직책은 이름 옆에 보이는 글자예요. (예: 맛집부 장관)"
    : "누가 어떤 직책인지 볼 수 있어요.";
  list.innerHTML = rows.map(([uid, m]) => {
    const role = m.role || "member";
    const tag = `<span class="role-tag ${role}">${esc(m.title || ROLE_LABEL[role])}</span>`;
    const edit = isAdmin() ? `
      <div class="mem-edit" data-uid="${uid}">
        <select aria-label="${esc(m.name)} 역할">
          ${["member", "officer", "admin"].map((r) => `<option value="${r}" ${r === role ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}
        </select>
        <input maxlength="20" placeholder="직책 (예: 맛집부 장관)" value="${esc(m.title || "")}" aria-label="${esc(m.name)} 직책">
        <button class="btn primary sm" type="button" data-save-mem>저장</button>
        ${uid !== S.uid ? `<button class="btn danger sm" type="button" data-del-mem>내보내기</button>` : ""}
      </div>` : "";
    return `<div class="mem-row"><span class="nm">${esc(m.name)}${uid === S.uid ? ' <span class="muted small">(나)</span>' : ""}</span>${tag}${edit}</div>`;
  }).join("");
}
$("#mem-list").addEventListener("click", async (e) => {
  const box = e.target.closest(".mem-edit");
  if (!box) return;
  const uid = box.dataset.uid;
  if (e.target.closest("[data-save-mem]")) {
    const role = box.querySelector("select").value;
    const title = box.querySelector("input").value.trim();
    if (uid === S.uid && role !== "admin") {
      const others = Object.entries(S.members).filter(([id, m]) => id !== S.uid && m.role === "admin");
      if (!others.length) { toast("회장이 한 명은 있어야 해요. 다른 사람을 먼저 회장으로 정해 주세요."); return; }
    }
    try {
      await updateDoc(doc(db, "members", uid), { role, title });
      toast(`${memberName(uid)} 님 정보를 저장했어요`);
    } catch (err) { toast(errMsg(err)); }
  }
  const del = e.target.closest("[data-del-mem]");
  if (del) {
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1"; del.textContent = "정말 내보내기?";
      setTimeout(() => { del.dataset.confirm = ""; del.textContent = "내보내기"; }, 3000);
      return;
    }
    try {
      await deleteDoc(doc(db, "members", uid));
      toast("멤버에서 내보냈어요. 같은 닉네임을 다시 쓰려면 Firebase Authentication에서 계정도 지워 주세요.");
    } catch (err) { toast(errMsg(err)); }
  }
});

// 초대 코드 관리 (회장 전용)
let invUnsub = null;
function startInvites() {
  if (invUnsub || !isAdmin()) return;
  invUnsub = onSnapshot(collection(db, "invites"), (qs) => {
    S.invites = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }))
      .sort((a, b) => (a.usedBy ? 1 : 0) - (b.usedBy ? 1 : 0) || a.id.localeCompare(b.id));
    renderInvites();
  }, (err) => toast(errMsg(err)));
}
function stopInvites() { if (invUnsub) { invUnsub(); invUnsub = null; } }
function renderInvites() {
  const unused = S.invites.filter((i) => !i.usedBy);
  $("#inv-count").textContent = `전체 ${S.invites.length}개 · 안 쓴 코드 ${unused.length}개`;
  $("#inv-list").innerHTML = S.invites.length
    ? S.invites.map((i) => `
        <div class="inv-row ${i.usedBy ? "used" : ""}">
          <code>${esc(i.id)}</code>
          <span class="st">${i.usedBy ? `${esc(i.usedByName || memberName(i.usedBy))} 님 사용` : "안 씀"}</span>
          ${i.usedBy ? "" : `<button class="btn ghost sm" type="button" data-del-inv="${esc(i.id)}">삭제</button>`}
        </div>`).join("")
    : '<div class="inv-row"><span class="muted small">아직 초대 코드가 없어요. 위에서 추가해 주세요.</span></div>';
}
function randomCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 글자(0,o,1,l,i) 제외
  const a = new Uint32Array(6); crypto.getRandomValues(a);
  return "suyo-" + [...a].map((n) => chars[n % chars.length]).join("");
}
$("#inv-gen").addEventListener("click", () => {
  $("#inv-input").value = Array.from({ length: 15 }, randomCode).join("\n");
});
$("#inv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const codes = [...new Set($("#inv-input").value.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
  const bad = codes.filter((c) => c.length < 6 || c.length > 30 || c.includes("/") || c === "." || c === "..");
  if (!codes.length) return;
  if (bad.length) { toast(`6~30자, '/' 없이 만들어 주세요: ${bad.slice(0, 3).join(", ")}`); return; }
  const dup = codes.filter((c) => S.invites.some((i) => i.id === c));
  if (dup.length) { toast(`이미 있는 코드예요: ${dup.slice(0, 3).join(", ")}`); return; }
  try {
    const b = writeBatch(db);
    codes.forEach((c) => b.set(doc(db, "invites", c), { createdAt: serverTimestamp(), usedBy: null, usedByName: "", usedAt: null }));
    await b.commit();
    $("#inv-input").value = "";
    toast(`초대 코드 ${codes.length}개를 추가했어요`);
  } catch (err) { toast(errMsg(err)); }
});
$("#inv-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-inv]");
  if (!del) return;
  try { await deleteDoc(doc(db, "invites", del.dataset.delInv)); } catch (err) { toast(errMsg(err)); }
});
$("#inv-copy").addEventListener("click", async () => {
  const text = S.invites.filter((i) => !i.usedBy).map((i) => i.id).join("\n");
  if (!text) { toast("안 쓴 코드가 없어요"); return; }
  try { await navigator.clipboard.writeText(text); toast("안 쓴 코드를 복사했어요"); }
  catch { $("#inv-input").value = text; $("#inv-input").select(); toast("복사가 안 돼서 입력칸에 넣어 뒀어요. 직접 복사해 주세요."); }
});

// ============================================================
//  홈: 이번 주 수요일
// ============================================================
$("#week-prev").addEventListener("click", () => { S.weekOffset--; closePlanForm(); subscribeWeek(); });
$("#week-next").addEventListener("click", () => { S.weekOffset++; closePlanForm(); subscribeWeek(); });

function renderHome() {
  if (!S.me) return;
  const wed = wednesday(S.weekOffset);
  const diff = Math.round((wed - today0()) / 86400000);
  $("#week-date").textContent = dayLabel(wed);
  $("#week-dday").textContent = diff === 0 ? "오늘 모임!" : diff > 0 ? `D-${diff}` : `${-diff}일 전 모임`;

  // 계획
  const ev = S.event;
  const updated = ev?.updatedByName ? `<div class="plan-foot">${esc(ev.updatedByName)} 님이 ${ago(toDate(ev.updatedAt))} 수정</div>` : "";
  const sameDay = S.schedule.filter((s) => s.date === S.wedKey);
  $("#plan-view").innerHTML = `
    <dt>장소</dt><dd class="${ev?.place ? "" : "empty"}">${esc(ev?.place || "아직 안 정했어요")}</dd>
    <dt>시간</dt><dd class="${ev?.time ? "" : "empty"}">${esc(ev?.time || CFG.defaultTime || "미정")}</dd>
    ${ev?.note ? `<dt>메모</dt><dd>${esc(ev.note)}</dd>` : ""}
    ${sameDay.length ? `<dt>일정</dt><dd>${sameDay.map((s) => esc(s.title)).join(", ")}</dd>` : ""}
    ${updated}`;

  // 가는 법 (학교 → 장소)
  const planBox = $("#plan-route");
  const planPlace = ev?.place ? findPlaceByName(ev.place) : null;
  if (planPlace) { planBox.hidden = false; planBox.innerHTML = routeHtml(planPlace); ensureBus(planPlace); }
  else if (ev?.place) { planBox.hidden = false; planBox.innerHTML = '<div class="route-body sub">맛집 목록에 있는 식당으로 장소를 정하면 학교에서 가는 법(버스·택시)이 나와요.</div>'; }
  else planBox.hidden = true;

  // 참석
  const mine = S.attendance.find((a) => a.uid === S.uid)?.status;
  $$(".rsvp").forEach((b) => b.classList.toggle("on", b.dataset.status === mine));
  const groups = { yes: [], maybe: [], no: [] };
  S.attendance.forEach((a) => groups[a.status]?.push(memberName(a.uid, a.name)));
  const answered = new Set(S.attendance.map((a) => a.uid));
  const none = Object.entries(S.members).filter(([id]) => !answered.has(id)).map(([, m]) => m.name);
  const row = (cls, label, arr) => `
    <div class="rsvp-row"><span class="lbl ${cls}">${label} ${arr.length}</span>
      <div class="names">${arr.length ? arr.map((n) => `<span class="name-pill">${esc(n)}</span>`).join("") : '<span class="muted small">-</span>'}</div>
    </div>`;
  $("#rsvp-lists").innerHTML = row("yes", "참석", groups.yes) + row("maybe", "미정", groups.maybe) + row("no", "불참", groups.no) + row("none", "무응답", none);
  $("#rsvp-summary").textContent = `멤버 ${Object.keys(S.members).length}명 중 ${S.attendance.length}명 응답`;

  // 다가오는 일정
  const tk = dateKey(today0());
  const up = S.schedule.filter((s) => s.date >= tk).slice(0, 3);
  $("#home-schedule").innerHTML = up.length
    ? up.map((s) => `<button class="mini-item" data-open-cal="${s.date}"><span class="t"><b>${esc(dayLabel(parseKey(s.date)))}</b> ${esc(s.title)}</span><span class="small muted">›</span></button>`).join("")
    : `<div class="empty-note">예정된 일정이 없어요.${isOfficer() ? " 캘린더에서 날짜를 눌러 추가할 수 있어요." : ""}</div>`;

  // 진행 중 투표
  const open = S.polls.filter((p) => !p.closed).slice(0, 4);
  $("#home-polls").innerHTML = open.length
    ? open.map((p) => {
        const voted = (S.votes[p.id] || []).some((v) => v.uid === S.uid);
        return `<button class="mini-item" data-goto="polls"><span class="t">${esc(p.question)}</span><span class="small ${voted ? "muted" : ""}" style="${voted ? "" : "color:var(--accent);font-weight:700"}">${voted ? "투표함" : "투표하기"}</span></button>`;
      }).join("")
    : '<div class="empty-note">진행 중인 투표가 없어요.</div>';

  // 최근 대화
  const last = S.messages.slice(-3);
  $("#home-chat").innerHTML = last.length
    ? last.map((m) => `<button class="mini-item" data-goto="chat"><span class="t"><b>${esc(memberName(m.uid, m.name))}</b> ${esc(m.text)}</span><span class="small muted">${ago(toDate(m.createdAt))}</span></button>`).join("")
    : '<div class="empty-note">아직 대화가 없어요. 첫 메시지를 남겨 보세요.</div>';
}

$$(".rsvp").forEach((b) =>
  b.addEventListener("click", async () => {
    const status = b.dataset.status;
    const ref = doc(db, "attendance", `${S.wedKey}_${S.uid}`);
    const mine = S.attendance.find((a) => a.uid === S.uid)?.status;
    try {
      if (mine === status) await deleteDoc(ref); // 같은 버튼 다시 누르면 취소
      else await setDoc(ref, { date: S.wedKey, uid: S.uid, name: S.me.name, status, at: serverTimestamp() });
    } catch (e) { toast(errMsg(e)); }
  })
);

// 계획 수정
function openPlanForm() {
  const ev = S.event || {};
  $("#plan-place").value = ev.place ?? "";
  $("#plan-time").value = ev.time || CFG.defaultTime || "";
  $("#plan-note").value = ev.note || "";
  $("#plan-form").hidden = false;
  $("#plan-view").hidden = true;
  $("#plan-edit-btn").hidden = true;
}
function closePlanForm() {
  $("#plan-form").hidden = true;
  $("#plan-view").hidden = false;
  $("#plan-edit-btn").hidden = false;
}
$("#plan-edit-btn").addEventListener("click", openPlanForm);
$("#plan-cancel").addEventListener("click", closePlanForm);
$("#plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await savePlan($("#plan-place").value.trim(), $("#plan-time").value, $("#plan-note").value.trim());
    closePlanForm();
    toast("모임 계획을 저장했어요");
  } catch (err) { toast(errMsg(err)); }
});
function savePlan(place, time, note) {
  return setDoc(doc(db, "events", S.wedKey), {
    place, time, note, updatedBy: S.uid, updatedByName: S.me.name, updatedAt: serverTimestamp(),
  });
}

// ============================================================
//  캘린더 (보기는 모두, 일정 추가/삭제는 회장·임원)
// ============================================================
const CAL = { y: 0, m: 0, sel: null };
function openCal(dateStr) {
  const base = dateStr ? parseKey(dateStr) : wednesday(S.weekOffset);
  CAL.y = base.getFullYear(); CAL.m = base.getMonth();
  CAL.sel = dateKey(base);
  $("#cal").hidden = false;
  renderCalendar();
}
function closeCal() { $("#cal").hidden = true; }
$("#cal-open").addEventListener("click", () => openCal());
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open-cal]");
  if (t && t.dataset.openCal) { e.stopImmediatePropagation(); openCal(t.dataset.openCal); }
}, true);
$("#cal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close-cal]")) closeCal();
});
$("#cal-prev").addEventListener("click", () => { CAL.m--; if (CAL.m < 0) { CAL.m = 11; CAL.y--; } renderCalendar(); });
$("#cal-next").addEventListener("click", () => { CAL.m++; if (CAL.m > 11) { CAL.m = 0; CAL.y++; } renderCalendar(); });

function renderCalendar() {
  if ($("#cal").hidden) return;
  $("#cal-title").textContent = `${CAL.y}년 ${CAL.m + 1}월`;
  const first = new Date(CAL.y, CAL.m, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const tk = dateKey(today0());
  const schDates = new Set(S.schedule.map((s) => s.date));
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== CAL.m) break; // 6번째 줄이 다음 달뿐이면 생략
    const k = dateKey(d);
    const cls = ["cal-cell", d.getMonth() !== CAL.m && "out", d.getDay() === 3 && "wed", k === tk && "today", k === CAL.sel && "sel"].filter(Boolean).join(" ");
    const dots = `${S.allEvents[k]?.place ? '<i class="dot meet"></i>' : ""}${schDates.has(k) ? '<i class="dot sch"></i>' : ""}`;
    html += `<button type="button" class="${cls}" data-day="${k}" aria-label="${dayLabel(d)}"><span>${d.getDate()}</span><span class="dots">${dots}</span></button>`;
  }
  $("#cal-grid").innerHTML = html;
  renderCalDay();
}
$("#cal-grid").addEventListener("click", (e) => {
  const c = e.target.closest("[data-day]");
  if (!c) return;
  CAL.sel = c.dataset.day;
  const d = parseKey(CAL.sel);
  if (d.getMonth() !== CAL.m) { CAL.y = d.getFullYear(); CAL.m = d.getMonth(); }
  renderCalendar();
});

function renderCalDay() {
  const k = CAL.sel;
  if (!k) return;
  const d = parseKey(k);
  $("#cal-day-title").textContent = dayLabel(d);
  const ev = S.allEvents[k];
  $("#cal-day-plan").textContent = d.getDay() === 3
    ? (ev?.place ? `모임 장소: ${ev.place}${ev.time ? " · " + ev.time : ""}` : "수요일 모임 — 장소 미정")
    : "";
  $("#cal-goweek").textContent = d.getDay() === 3 ? "이 날 모임 보기" : "이 주 모임 보기";
  const items = S.schedule.filter((s) => s.date === k);
  $("#cal-day-list").innerHTML = items.length
    ? items.map((s) => `
        <div class="sch-item">
          <div class="body"><div class="t">${esc(s.title)}</div>${s.note ? `<div class="n">${esc(s.note)}</div>` : ""}<div class="n">${esc(s.createdByName || "")}</div></div>
          ${isOfficer() ? `<button class="btn ghost sm" type="button" data-del-sch="${s.id}">삭제</button>` : ""}
        </div>`).join("")
    : '<div class="empty-note">이 날 일정이 없어요.</div>';
  $("#sch-form").hidden = !isOfficer();
  $("#sch-readonly").hidden = isOfficer();
}
$("#cal-goweek").addEventListener("click", () => {
  const target = nextWedFrom(parseKey(CAL.sel));
  S.weekOffset = Math.round((target - wednesday(0)) / (7 * 86400000));
  closeCal(); closePlanForm(); subscribeWeek(); showTab("home");
});
$("#sch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#sch-title").value.trim();
  if (!title || !CAL.sel) return;
  try {
    await addDoc(collection(db, "schedule"), {
      date: CAL.sel, title, note: $("#sch-note").value.trim(),
      createdBy: S.uid, createdByName: S.me.name, updatedAt: serverTimestamp(),
    });
    $("#sch-title").value = ""; $("#sch-note").value = "";
    toast("일정을 추가했어요");
  } catch (err) { toast(errMsg(err)); }
});
$("#cal-day-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-sch]");
  if (!del) return;
  if (del.dataset.confirm !== "1") {
    del.dataset.confirm = "1"; del.textContent = "정말 삭제?";
    setTimeout(() => { del.dataset.confirm = ""; del.textContent = "삭제"; }, 3000);
    return;
  }
  try { await deleteDoc(doc(db, "schedule", del.dataset.delSch)); toast("일정을 삭제했어요"); } catch (err) { toast(errMsg(err)); }
});

// ============================================================
//  투표
// ============================================================
function addOptionInput(value = "") {
  const wrap = $("#poll-options");
  if (wrap.children.length >= 8) { toast("선택지는 8개까지 만들 수 있어요"); return; }
  const row = document.createElement("div");
  row.className = "opt-row";
  row.innerHTML = `<input maxlength="60" placeholder="선택지 ${wrap.children.length + 1}"><button type="button" class="icon-btn" aria-label="선택지 삭제">×</button>`;
  row.querySelector("input").value = value;
  row.querySelector("button").addEventListener("click", () => row.remove());
  wrap.appendChild(row);
}
function resetPollForm() {
  $("#poll-q").value = "";
  $("#poll-options").innerHTML = "";
  addOptionInput(); addOptionInput();
}
resetPollForm();
$("#poll-add-opt").addEventListener("click", () => addOptionInput());
$("#poll-add-place").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!v) return;
  const empty = $$("#poll-options input").find((i) => !i.value.trim());
  if (empty) empty.value = v; else addOptionInput(v);
  e.target.value = "";
});

$("#poll-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("#poll-q").value.trim();
  const options = [...new Set($$("#poll-options input").map((i) => i.value.trim()).filter(Boolean))];
  if (options.length < 2) { toast("선택지를 2개 이상 적어 주세요"); return; }
  try {
    await addDoc(collection(db, "polls"), {
      question, options, createdBy: S.uid, createdByName: S.me.name, createdAt: serverTimestamp(), closed: false,
    });
    resetPollForm();
    $("#poll-create").open = false;
    toast("투표를 올렸어요");
  } catch (err) { toast(errMsg(err)); }
});

function renderPolls() {
  const list = $("#poll-list");
  if (!S.polls.length) {
    list.innerHTML = '<div class="card"><div class="empty-note">아직 투표가 없어요. 위에서 첫 투표를 만들어 보세요.<br>예) "이번 주 어디 갈까?" — 마라탕 / 돈까스 / 떡볶이</div></div>';
    return;
  }
  list.innerHTML = S.polls.map((p) => {
    const votes = S.votes[p.id] || [];
    const total = votes.length;
    const my = votes.find((v) => v.uid === S.uid)?.choice;
    const counts = p.options.map((_, i) => votes.filter((v) => v.choice === i));
    const max = Math.max(0, ...counts.map((c) => c.length));
    const canManage = p.createdBy === S.uid || isAdmin();
    const opts = p.options.map((opt, i) => {
      const who = counts[i];
      const pct = total ? Math.round((who.length / total) * 100) : 0;
      const win = p.closed && max > 0 && who.length === max;
      return `<button class="poll-opt ${my === i ? "mine" : ""}" data-poll="${p.id}" data-choice="${i}" ${p.closed ? "disabled" : ""}>
          <span class="bar" style="width:${pct}%"></span>
          <span class="top"><span>${win ? '<b class="win-tag">1위</b> ' : ""}${esc(opt)}${my === i ? " ✓" : ""}</span><span class="cnt">${who.length}표 · ${pct}%</span></span>
          ${who.length ? `<span class="who">${who.map((v) => esc(memberName(v.uid, v.name))).join(", ")}</span>` : ""}
        </button>`;
    }).join("");
    return `<article class="card">
        <div class="card-head">
          <h3 class="poll-q">${esc(p.question)}</h3>
          <span class="poll-tag ${p.closed ? "" : "live"}">${p.closed ? "마감" : "진행 중"}</span>
        </div>
        <div class="stack tight">${opts}</div>
        <div class="row wrap" style="justify-content:space-between">
          <span class="poll-meta">${esc(p.createdByName)} · ${ago(toDate(p.createdAt))} · ${total}명 참여</span>
          ${canManage ? `<span class="row">
              <button class="btn ghost sm" data-close="${p.id}">${p.closed ? "다시 열기" : "마감하기"}</button>
              <button class="btn danger sm" data-delpoll="${p.id}">삭제</button>
            </span>` : ""}
        </div>
      </article>`;
  }).join("");
}

$("#poll-list").addEventListener("click", async (e) => {
  const opt = e.target.closest("[data-choice]");
  const cl = e.target.closest("[data-close]");
  const del = e.target.closest("[data-delpoll]");
  try {
    if (opt) {
      const pid = opt.dataset.poll, choice = Number(opt.dataset.choice);
      const ref = doc(db, "polls", pid, "votes", S.uid);
      const mine = (S.votes[pid] || []).find((v) => v.uid === S.uid)?.choice;
      if (mine === choice) await deleteDoc(ref);
      else await setDoc(ref, { uid: S.uid, name: S.me.name, choice });
    } else if (cl) {
      const p = S.polls.find((x) => x.id === cl.dataset.close);
      await updateDoc(doc(db, "polls", p.id), { closed: !p.closed });
    } else if (del) {
      if (del.dataset.confirm !== "1") {
        del.dataset.confirm = "1"; del.textContent = "정말 삭제?";
        setTimeout(() => { del.dataset.confirm = ""; del.textContent = "삭제"; }, 3000);
        return;
      }
      await deleteDoc(doc(db, "polls", del.dataset.delpoll));
      toast("투표를 삭제했어요");
    }
  } catch (err) { toast(errMsg(err)); }
});

// ============================================================
//  대화
// ============================================================
function markChatRead() {
  const last = S.messages[S.messages.length - 1];
  const t = toDate(last?.createdAt)?.getTime();
  if (t) lsSet("suyo-chat-seen", String(t));
  $("#chat-badge").hidden = true;
}
function updateChatBadge() {
  if (S.tab === "chat") { markChatRead(); return; }
  const seen = Number(lsGet("suyo-chat-seen") || 0);
  const n = S.messages.filter((m) => m.uid !== S.uid && (toDate(m.createdAt)?.getTime() || 0) > seen).length;
  const b = $("#chat-badge");
  b.hidden = n === 0;
  b.textContent = n > 99 ? "99+" : String(n);
}
function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160; }
function scrollChatBottom() { requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight)); }

function renderChat() {
  const stick = S.tab === "chat" && nearBottom();
  let lastDay = "", lastUid = "";
  $("#chat-list").innerHTML = S.messages.length
    ? S.messages.map((m) => {
        const d = toDate(m.createdAt) || new Date();
        const day = dateKey(d);
        let out = "";
        if (day !== lastDay) { out += `<div class="chat-day">${dayLabel(d)}</div>`; lastDay = day; lastUid = ""; }
        const me = m.uid === S.uid;
        const canDel = me || isAdmin();
        const t = S.members[m.uid]?.title;
        out += `<div class="msg ${me ? "me" : ""}" data-id="${m.id}">
            ${!me && lastUid !== m.uid ? `<span class="who">${esc(memberName(m.uid, m.name))}${t ? ` · ${esc(t)}` : ""}</span>` : ""}
            <div class="line"><div class="bubble">${esc(m.text)}</div><span class="time">${hhmm(d)}</span>
              ${canDel || isOfficer() ? `<span class="acts" hidden>
                ${isOfficer() ? `<button class="pin" data-pinmsg="${m.id}">공지로</button>` : ""}
                ${canDel ? `<button class="del" data-delmsg="${m.id}">삭제</button>` : ""}
              </span>` : ""}</div>
          </div>`;
        lastUid = m.uid;
        return out;
      }).join("")
    : '<div class="empty-note" style="text-align:center;padding:40px 0">아직 대화가 없어요.<br>어디 갈지 먼저 얘기해 볼까요?</div>';
  updateChatBadge();
  if (stick) scrollChatBottom();
}

$("#chat-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-delmsg]");
  if (del) {
    try { await deleteDoc(doc(db, "messages", del.dataset.delmsg)); } catch (err) { toast(errMsg(err)); }
    return;
  }
  const pin = e.target.closest("[data-pinmsg]");
  if (pin) {
    const m = S.messages.find((x) => x.id === pin.dataset.pinmsg);
    if (m) await addNotice(m.text.slice(0, 300));
    return;
  }
  const msg = e.target.closest(".msg");
  const acts = msg?.querySelector(".acts");
  if (acts) acts.hidden = !acts.hidden; // 말풍선을 누르면 삭제/공지 버튼이 나와요
});

// ============================================================
//  공지 고정 (회장·임원이 쓰고 해제)
// ============================================================
async function addNotice(text) {
  try {
    await addDoc(collection(db, "notices"), { text, createdBy: S.uid, createdByName: S.me.name, createdAt: serverTimestamp() });
    toast("공지로 고정했어요");
  } catch (err) { toast(errMsg(err)); }
}
function renderNotices() {
  if (!S.me) return;
  const list = S.notices.slice(0, 3);
  const card = $("#notice-card");
  card.hidden = !list.length && !isOfficer();
  $("#notice-write-btn").hidden = !isOfficer() || !$("#notice-form").hidden;
  $("#notice-list").innerHTML = list.length
    ? list.map((n) => `
        <div class="notice">
          <div class="body"><div class="t">${esc(n.text)}</div><div class="by">${esc(memberName(n.createdBy, n.createdByName))} · ${ago(toDate(n.createdAt))}</div></div>
          ${isOfficer() ? `<button class="btn ghost sm" type="button" data-unpin="${n.id}">내리기</button>` : ""}
        </div>`).join("")
    : '<div class="empty-note">고정된 공지가 없어요. 중요한 안내는 공지로 올려 두세요.</div>';
  const top = list[0];
  const banner = $("#chat-notice");
  banner.hidden = !top;
  if (top) banner.innerHTML = `<b>공지</b><span>${esc(top.text)}</span>`;
}
$("#notice-write-btn").addEventListener("click", () => { $("#notice-form").hidden = false; renderNotices(); $("#notice-text").focus(); });
$("#notice-cancel").addEventListener("click", () => { $("#notice-form").hidden = true; renderNotices(); });
$("#notice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#notice-text").value.trim();
  if (!text) return;
  await addNotice(text);
  $("#notice-text").value = ""; $("#notice-form").hidden = true; renderNotices();
});
$("#notice-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-unpin]");
  if (!b) return;
  try { await deleteDoc(doc(db, "notices", b.dataset.unpin)); toast("공지를 내렸어요"); } catch (err) { toast(errMsg(err)); }
});

// ============================================================
//  N빵 정산 (이번 주 모임 기준)
// ============================================================
const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";
function share(total, n) { return n ? Math.ceil(total / n / 10) * 10 : 0; } // 10원 단위 올림
function settleCanEdit() { return !S.settle || S.settle.payer === S.uid || S.settle.updatedBy === S.uid || isOfficer(); }

function renderSettle() {
  if (!S.me || !$("#settle-form").hidden) return;
  const st = S.settle;
  const btn = $("#settle-edit-btn");
  btn.textContent = st ? "수정" : "정산 시작";
  btn.hidden = !!st && !settleCanEdit();
  if (!st) {
    $("#settle-view").innerHTML = '<div class="empty-note">모임이 끝나면 총 금액을 넣어 보세요. 나눌 금액을 계산해 주고, 누가 보냈는지 체크할 수 있어요.</div>';
    return;
  }
  const people = st.participants || [];
  const each = share(st.total, people.length);
  const done = people.filter((u) => u === st.payer || S.paid[u]).length;
  const pct = people.length ? Math.round((done / people.length) * 100) : 0;
  const canMark = (u) => u === S.uid || st.payer === S.uid || isOfficer();
  $("#settle-view").innerHTML = `
    <div class="settle-sum"><span class="big">${won(each)}</span><span class="muted small">1인당 · 총 ${won(st.total)} ÷ ${people.length}명</span></div>
    <div class="muted small">${esc(memberName(st.payer, st.payerName))} 님이 먼저 계산했어요 · ${done}/${people.length}명 완료</div>
    <div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
    ${st.memo ? `<div class="settle-memo"><span>보낼 곳: ${esc(st.memo)}</span><button class="btn ghost sm" type="button" id="settle-copy">복사</button></div>` : ""}
    <div class="pay-list">
      ${people.map((u) => {
        const isPayer = u === st.payer;
        const on = isPayer || !!S.paid[u];
        return `<div class="pay-row"><span>${esc(memberName(u))}${u === S.uid ? ' <span class="muted small">(나)</span>' : ""}</span>
          <button class="pay-btn ${on ? "on" : ""}" type="button" data-pay="${u}" ${isPayer || !canMark(u) ? "disabled" : ""}>${isPayer ? "계산함" : on ? "보냄 ✓" : "아직"}</button></div>`;
      }).join("")}
    </div>`;
}

function openSettleForm() {
  const st = S.settle;
  const ids = Object.keys(S.members).sort((a, b) => memberName(a).localeCompare(memberName(b), "ko"));
  const chosen = new Set(st?.participants || S.attendance.filter((a) => a.status === "yes").map((a) => a.uid));
  if (!chosen.size) chosen.add(S.uid);
  $("#settle-total").value = st?.total ?? "";
  $("#settle-payer").innerHTML = ids.map((u) => `<option value="${u}" ${(st?.payer || S.uid) === u ? "selected" : ""}>${esc(memberName(u))}</option>`).join("");
  $("#settle-people").innerHTML = ids.map((u) => `<label class="chk"><input type="checkbox" value="${u}" ${chosen.has(u) ? "checked" : ""}> ${esc(memberName(u))}</label>`).join("");
  $("#settle-memo").value = st?.memo || "";
  $("#settle-delete").hidden = !st;
  $("#settle-form").hidden = false;
  $("#settle-view").hidden = true;
  $("#settle-edit-btn").hidden = true;
  settlePreview();
}
function closeSettleForm() {
  $("#settle-form").hidden = true;
  $("#settle-view").hidden = false;
  $("#settle-edit-btn").hidden = false;
  renderSettle();
}
function settlePreview() {
  const total = Math.max(0, Math.round(Number($("#settle-total").value) || 0));
  const n = $$("#settle-people input:checked").length;
  $("#settle-preview").textContent = n ? `${n}명이 ${won(share(total, n))}씩 (10원 단위 올림)` : "나눌 사람을 골라 주세요.";
}
$("#settle-edit-btn").addEventListener("click", openSettleForm);
$("#settle-cancel").addEventListener("click", closeSettleForm);
$("#settle-total").addEventListener("input", settlePreview);
$("#settle-people").addEventListener("change", settlePreview);
$("#settle-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const total = Math.max(0, Math.round(Number($("#settle-total").value) || 0));
  const participants = $$("#settle-people input:checked").map((i) => i.value);
  if (!participants.length) { toast("나눌 사람을 골라 주세요"); return; }
  const payer = $("#settle-payer").value;
  try {
    await setDoc(doc(db, "settlements", S.wedKey), {
      total, payer, payerName: memberName(payer), participants, memo: $("#settle-memo").value.trim(),
      updatedBy: S.uid, updatedAt: serverTimestamp(),
    });
    closeSettleForm();
    toast("정산을 저장했어요");
  } catch (err) { toast(errMsg(err)); }
});
$("#settle-delete").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1"; btn.textContent = "정말 지우기?";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "정산 지우기"; }, 3000);
    return;
  }
  try {
    for (const u of Object.keys(S.paid)) await deleteDoc(doc(db, "settlements", S.wedKey, "paid", u)).catch(() => {});
    await deleteDoc(doc(db, "settlements", S.wedKey));
    closeSettleForm();
    toast("정산을 지웠어요");
  } catch (err) { toast(errMsg(err)); }
});
$("#settle-view").addEventListener("click", async (e) => {
  if (e.target.closest("#settle-copy")) {
    try { await navigator.clipboard.writeText(S.settle.memo); toast("복사했어요"); } catch { toast("복사가 안 돼요. 길게 눌러 직접 복사해 주세요."); }
    return;
  }
  const b = e.target.closest("[data-pay]");
  if (!b || b.disabled) return;
  const u = b.dataset.pay;
  const ref = doc(db, "settlements", S.wedKey, "paid", u);
  try {
    if (S.paid[u]) await deleteDoc(ref);
    else await setDoc(ref, { by: S.uid, at: serverTimestamp() });
  } catch (err) { toast(errMsg(err)); }
});

// ============================================================
//  우리가 간 곳 (지난 수요일 기록 + 통계)
// ============================================================
function visits() {
  const tk = dateKey(today0());
  return Object.entries(S.allEvents)
    .filter(([k, ev]) => k <= tk && ev.place)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([k, ev]) => ({ date: k, place: ev.place, who: S.allYes.filter((a) => a.date === k).map((a) => a.uid) }));
}
function visitedNames() { return new Set(visits().map((v) => v.place.trim())); }
function renderHistory() {
  if (!S.me) return;
  const vs = visits();
  $("#history-count").textContent = vs.length ? `${vs.length}번` : "";
  $("#home-history").innerHTML = vs.length
    ? vs.slice(0, 3).map((v) => `<button class="mini-item" type="button" data-hist><span class="t"><b>${esc(dayLabel(parseKey(v.date)))}</b> ${esc(v.place)}</span><span class="small muted">${v.who.length}명</span></button>`).join("")
    : '<div class="empty-note">수요일 모임 장소를 정하면 여기에 기록이 쌓여요.</div>';
  if (!$("#history").hidden) renderHistorySheet();
}
function renderHistorySheet() {
  const vs = visits();
  const byPlace = {}, byMember = {};
  vs.forEach((v) => {
    byPlace[v.place] = (byPlace[v.place] || 0) + 1;
    v.who.forEach((u) => (byMember[u] = (byMember[u] || 0) + 1));
  });
  const rank = (obj, label) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#st-visits").textContent = vs.length;
  $("#st-places").textContent = Object.keys(byPlace).length;
  const tp = rank(byPlace);
  $("#st-top-places").innerHTML = tp.length
    ? tp.map(([n, c], i) => `<div class="rank"><span class="no">${i + 1}</span><span class="nm">${esc(n)}</span><span class="ct">${c}번</span></div>`).join("")
    : '<div class="rank"><span class="muted small">아직 기록이 없어요.</span></div>';
  const tm = rank(byMember);
  $("#st-top-members").innerHTML = tm.length
    ? tm.map(([u, c], i) => `<div class="rank"><span class="no">${i + 1}</span><span class="nm">${esc(memberName(u))}</span><span class="ct">${c}/${vs.length}회</span></div>`).join("")
    : '<div class="rank"><span class="muted small">참석을 누른 기록이 쌓이면 보여요.</span></div>';
  $("#hist-list").innerHTML = vs.length
    ? vs.map((v) => `<div class="hist"><span class="dt">${v.date.slice(2).replaceAll("-", ".")}</span><div class="body"><div><b>${esc(v.place)}</b></div><div class="who">${v.who.length ? v.who.map((u) => esc(memberName(u))).join(", ") : "참석 기록 없음"}</div></div></div>`).join("")
    : '<div class="hist"><span class="muted small">아직 기록이 없어요.</span></div>';
}
function openHistory() { $("#history").hidden = false; renderHistorySheet(); }
$("#history-open").addEventListener("click", openHistory);
$("#home-history").addEventListener("click", (e) => { if (e.target.closest("[data-hist]")) openHistory(); });
$("#history").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close-history]")) $("#history").hidden = true;
});

const chatInput = $("#chat-input");
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer:fine)").matches) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = ""; chatInput.style.height = "auto";
  try {
    await addDoc(collection(db, "messages"), { uid: S.uid, name: S.me.name, text, createdAt: serverTimestamp() });
    scrollChatBottom();
  } catch (err) { chatInput.value = text; toast(errMsg(err)); }
});

// ============================================================
//  맛집 + 카카오맵
// ============================================================
let kakaoMaps = null, map = null, placesSvc = null, mapInitStarted = false;
const markers = {};

function mapMsg(text) {
  const el = $("#map-msg");
  el.textContent = text;
  el.hidden = !text;
}

function loadKakao() {
  return new Promise((resolve, reject) => {
    if (window.kakao?.maps?.load) return window.kakao.maps.load(() => resolve(window.kakao));
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(CFG.kakaoJsKey)}&libraries=services&autoload=false`;
    s.onload = () => (window.kakao?.maps?.load ? window.kakao.maps.load(() => resolve(window.kakao)) : reject(new Error("sdk")));
    s.onerror = () => reject(new Error("load"));
    document.head.appendChild(s);
  });
}

async function initMap() {
  if (map) { map.relayout(); fitToPlaces(); return; }
  if (mapInitStarted) return;
  mapInitStarted = true;
  if (!CFG.kakaoJsKey) {
    mapMsg("카카오 지도 키가 아직 없어요.\nconfig.js에 kakaoJsKey를 넣으면 지도가 보여요.");
    mapInitStarted = false;
    return;
  }
  mapMsg("지도를 불러오는 중…");
  try {
    const kakao = await loadKakao();
    kakaoMaps = kakao.maps;
    const c = CFG.mapCenter || { lat: 37.5663, lng: 126.9779 };
    map = new kakaoMaps.Map($("#map"), { center: new kakaoMaps.LatLng(c.lat, c.lng), level: 5 });
    map.addControl(new kakaoMaps.ZoomControl(), kakaoMaps.ControlPosition.RIGHT);
    placesSvc = new kakaoMaps.services.Places();
    mapMsg("");
    syncMarkers();
    fitToPlaces();
  } catch (e) {
    console.error(e);
    mapInitStarted = false;
    mapMsg("지도를 불러오지 못했어요.\n카카오 디벨로퍼스에서 ① 카카오맵 사용 설정을 켰는지\n② 사이트 주소(도메인)를 등록했는지 확인해 주세요.");
  }
}

function fitToPlaces() {
  if (!map || !S.places.length || S.selected) return;
  const b = new kakaoMaps.LatLngBounds();
  S.places.forEach((p) => b.extend(new kakaoMaps.LatLng(p.lat, p.lng)));
  if (S.places.length === 1) { map.setCenter(new kakaoMaps.LatLng(S.places[0].lat, S.places[0].lng)); map.setLevel(4); }
  else map.setBounds(b, 40, 40, 40, 40);
}

function syncMarkers() {
  if (!map) return;
  const ids = new Set(S.places.map((p) => p.id));
  for (const id of Object.keys(markers)) if (!ids.has(id)) { markers[id].setMap(null); delete markers[id]; }
  for (const p of S.places) {
    if (markers[p.id]) continue;
    const m = new kakaoMaps.Marker({ map, position: new kakaoMaps.LatLng(p.lat, p.lng), title: p.name });
    kakaoMaps.event.addListener(m, "click", () => selectPlace(p.id, false));
    markers[p.id] = m;
  }
}

function stats(placeId) {
  const rs = S.reviews.filter((r) => r.placeId === placeId);
  const avg = rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0;
  return { rs, avg, count: rs.length, mine: rs.find((r) => r.uid === S.uid) };
}
function starsHtml(avg) {
  return `<span class="stars" aria-label="5점 만점에 ${avg.toFixed(1)}점">★★★★★<span class="fill" style="width:${(avg / 5) * 100}%">★★★★★</span></span>`;
}

function renderPlaceOptions() {
  const names = S.places.map((p) => p.name).sort((a, b) => a.localeCompare(b, "ko"));
  $("#place-datalist").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
  $("#poll-add-place").innerHTML = '<option value="">맛집 목록에서 추가…</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

function renderPlaces() {
  syncMarkers();
  const sort = $("#place-sort").value;
  const rows = S.places.map((p) => ({ p, ...stats(p.id) }));
  rows.sort((a, b) => {
    if (sort === "count") return b.count - a.count || b.avg - a.avg;
    if (sort === "new") return (toDate(b.p.createdAt)?.getTime() || 0) - (toDate(a.p.createdAt)?.getTime() || 0);
    return b.avg - a.avg || b.count - a.count;
  });
  $("#place-count").textContent = S.places.length ? `${S.places.length}곳` : "";
  $("#place-list").innerHTML = rows.length
    ? rows.map(({ p, avg, count, mine }) => `
        <button class="place-card ${S.selected === p.id ? "sel" : ""}" data-place="${p.id}">
          <span class="nm">${esc(p.name)}</span>
          <span class="cat">${esc(p.category || p.address || "")}</span>
          <span class="score">${starsHtml(avg)}<span class="num">${count ? avg.toFixed(1) : "-"}</span><span class="muted small">리뷰 ${count}</span>
            ${mine ? '<span class="my-tag">내 평점 ' + mine.stars + "</span>" : ""}</span>
        </button>`).join("")
    : '<div class="empty-note">아직 등록된 맛집이 없어요. 위 검색창에서 가 본 식당을 찾아 추가해 보세요.</div>';
  if (S.selected) renderDetail();
  renderPicker();
}

// ============================================================
//  가는 법: 학교 → 장소
//  버스: ODsay 대중교통 API (한 번 찾은 결과는 저장해서 모두 같이 씀)
//  택시: 울산 택시 요금으로 추정 (거리 = 직선거리 × 1.35)
// ============================================================
const SCHOOL = CFG.school || { name: "학교", lat: CFG.mapCenter?.lat, lng: CFG.mapCenter?.lng };
const TAXI = CFG.taxi || { base: 4500, baseMeters: 2000, perMeters: 125, perWon: 100, perSeconds: 30 };
const busState = {}; // placeId -> "loading" | { error } (이번 접속 동안만)

function findPlaceByName(name) {
  const n = String(name || "").trim();
  return S.places.find((p) => p.name.trim() === n) || null;
}
function haversine(a, b) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function taxiEstimate(p) {
  const road = haversine(SCHOOL, p) * 1.35;
  const minutes = Math.max(3, Math.round((road / 1000 / 24) * 60) + 2); // 시내 평균 시속 24km + 잡는 시간
  const distFare = (Math.max(0, road - TAXI.baseMeters) / TAXI.perMeters) * TAXI.perWon;
  const timeFare = ((minutes * 60 * 0.25) / TAXI.perSeconds) * TAXI.perWon; // 막히는 구간(약 25%)은 시간요금
  const fare = TAXI.base + distFare + timeFare;
  const r100 = (x) => Math.round(x / 100) * 100;
  return { km: road / 1000, minutes, lo: Math.max(TAXI.base, r100(fare * 0.9)), hi: Math.max(TAXI.base, r100(fare * 1.15)) };
}
function kakaoRouteLink(p) {
  return `https://map.kakao.com/link/from/${encodeURIComponent(SCHOOL.name)},${SCHOOL.lat},${SCHOOL.lng}/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
}

async function ensureBus(p) {
  if (!CFG.odsayKey || S.routes[p.id]?.from === SCHOOL.name || busState[p.id]) return;
  busState[p.id] = "loading";
  try {
    const url = `https://api.odsay.com/v1/api/searchPubTransPathT?SX=${SCHOOL.lng}&SY=${SCHOOL.lat}&EX=${p.lng}&EY=${p.lat}&OPT=0&SearchPathType=2&apiKey=${encodeURIComponent(CFG.odsayKey)}`;
    const j = await (await fetch(url)).json();
    const err = j.error && (Array.isArray(j.error) ? j.error[0] : j.error);
    let data;
    if (err) {
      if (String(err.code) === "-98") data = { from: SCHOOL.name, near: true, bus: null };
      else { busState[p.id] = { error: err.message || err.msg || "경로를 찾지 못했어요" }; rerenderRoutes(p.id); return; }
    } else {
      const path = (j.result?.path || [])[0];
      if (!path) { busState[p.id] = { error: "버스 경로가 없어요" }; rerenderRoutes(p.id); return; }
      const steps = path.subPath.map((sp) => {
        if (sp.trafficType === 3) return sp.sectionTime > 0 ? { t: "walk", min: sp.sectionTime } : null;
        if (sp.trafficType === 2) {
          const st = sp.passStopList?.stations || [];
          return {
            t: "bus", nos: (sp.lane || []).map((l) => String(l.busNo)).slice(0, 4),
            from: sp.startName || "", to: sp.endName || "", next: st[1]?.stationName || "",
            count: sp.stationCount || 0, min: sp.sectionTime || 0,
          };
        }
        return null;
      }).filter(Boolean);
      data = { from: SCHOOL.name, near: false, bus: { total: path.info.totalTime, pay: path.info.payment, steps } };
    }
    await setDoc(doc(db, "routes", p.id), { ...data, at: serverTimestamp() }).catch(() => {});
    S.routes[p.id] = data;
    delete busState[p.id];
    rerenderRoutes(p.id);
  } catch (e) {
    console.error(e);
    busState[p.id] = { error: "버스 정보를 불러오지 못했어요 (ODsay 키·등록 주소 확인)" };
    rerenderRoutes(p.id);
  }
}
function rerenderRoutes(placeId) {
  renderHome();
  if (S.selected === placeId) $("#pd-route-info").innerHTML = routeHtml(S.places.find((x) => x.id === placeId));
}

function routeHtml(p) {
  if (!p || !SCHOOL.lat) return "";
  const r = S.routes[p.id]?.from === SCHOOL.name ? S.routes[p.id] : null;
  const st = busState[p.id];
  const walkMin = Math.max(1, Math.round((haversine(SCHOOL, p) * 1.25) / 67));
  let bus;
  if (r?.near || (!r && walkMin <= 10)) {
    bus = `<div class="route-row"><span class="route-tag walk">도보</span><div class="route-body"><div class="main">걸어서 약 ${walkMin}분</div><div class="sub">학교에서 가까워요</div></div></div>`;
  } else if (r?.bus) {
    const b = r.bus;
    const steps = b.steps.map((s) => s.t === "walk"
      ? `<li>걸어서 ${s.min}분</li>`
      : `<li><b>${esc(s.from)}</b> 정류장${s.next ? ` (${esc(s.next)} 방면)` : ""}에서 ${s.nos.map((n) => `<span class="bus-no">${esc(n)}</span>`).join(" ")} 타기 → ${s.count}정거장, ${s.min}분 → <b>${esc(s.to)}</b> 하차</li>`).join("");
    bus = `<div class="route-row"><span class="route-tag bus">버스</span><div class="route-body">
        <div class="main">약 ${b.total}분 · ${won(b.pay)}</div>
        <div class="sub">걷는 시간 포함, 기다리는 시간 제외 · 요금은 일반(성인) 기준</div>
        <ol class="route-steps">${steps}</ol></div></div>`;
  } else if (st === "loading") {
    bus = '<div class="route-row"><span class="route-tag bus">버스</span><div class="route-body sub">버스 경로 찾는 중…</div></div>';
  } else if (st?.error) {
    bus = `<div class="route-row"><span class="route-tag bus">버스</span><div class="route-body sub">${esc(st.error)}</div></div>`;
  } else {
    bus = '<div class="route-row"><span class="route-tag bus">버스</span><div class="route-body sub">아래 카카오맵 길찾기에서 버스 경로를 볼 수 있어요.</div></div>';
  }
  const t = taxiEstimate(p);
  const taxi = `<div class="route-row"><span class="route-tag taxi">택시</span><div class="route-body">
      <div class="main">약 ${t.minutes}분 · ${won(t.lo)}~${won(t.hi)}</div>
      <div class="sub">거리 약 ${t.km.toFixed(1)}km · 울산 택시요금 기준 추정 (밤 10시 이후 20% 할증)</div></div></div>`;
  return `<div class="route-head">${esc(SCHOOL.name)}에서 가는 법</div>${bus}${taxi}
    <a href="${kakaoRouteLink(p)}" target="_blank" rel="noopener">카카오맵 길찾기로 정확히 보기 ›</a>`;
}

// ============================================================
//  오늘 뭐 먹지? (맛집 목록에서 뽑기)
// ============================================================
function pickPool() {
  const onlyNew = $("#pick-new").checked, onlyGood = $("#pick-good").checked, cat = $("#pick-cat").value;
  const visited = visitedNames();
  return S.places.filter((p) => {
    if (onlyNew && visited.has(p.name.trim())) return false;
    if (onlyGood) { const s = stats(p.id); if (!s.count || s.avg < 4) return false; }
    if (cat && p.category !== cat) return false;
    return true;
  });
}
function renderPicker() {
  const sel = $("#pick-cat");
  const cats = [...new Set(S.places.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const cur = sel.value;
  sel.innerHTML = '<option value="">모든 종류</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = cats.includes(cur) ? cur : "";
  const n = pickPool().length;
  $("#pick-pool").textContent = `후보 ${n}곳`;
  if (!$("#pick-result").dataset.state) {
    $("#pick-result").innerHTML = S.places.length
      ? '<span class="muted">조건을 고르고 뽑기를 눌러 보세요.</span>'
      : '<span class="muted">맛집을 먼저 추가하면 뽑기를 할 수 있어요.</span>';
  }
}
["#pick-new", "#pick-good", "#pick-cat"].forEach((s) => $(s).addEventListener("change", renderPicker));

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
let rolling = false;
$("#pick-go").addEventListener("click", async () => {
  const pool = pickPool();
  const box = $("#pick-result");
  if (!pool.length) { toast("조건에 맞는 맛집이 없어요. 조건을 줄여 보세요."); return; }
  if (rolling) return;
  rolling = true;
  box.dataset.state = "rolling";
  box.className = "pick-result rolling";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && pool.length > 1) {
    for (let i = 0; i < 14; i++) {
      box.innerHTML = `<span class="nm">${esc(pool[i % pool.length].name)}</span>`;
      await new Promise((r) => setTimeout(r, 50 + i * 12));
    }
  }
  const p = pool[Math.floor(Math.random() * pool.length)];
  const s = stats(p.id);
  box.className = "pick-result done";
  box.dataset.state = "done";
  box.innerHTML = `
    <span class="nm">${esc(p.name)}</span>
    <span class="muted small">${esc(p.category || "")}${s.count ? ` · ★ ${s.avg.toFixed(1)} (${s.count})` : " · 평점 없음"}${visitedNames().has(p.name.trim()) ? "" : " · 아직 안 가 봄"}</span>
    <div class="row wrap">
      <button class="btn ghost sm" type="button" data-pick-open="${p.id}">자세히</button>
      <button class="btn primary sm" type="button" data-pick-plan="${p.id}">이번 주 장소로 정하기</button>
    </div>`;
  rolling = false;
});
$("#pick-result").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-pick-open]");
  if (o) { selectPlace(o.dataset.pickOpen, true); return; }
  const pl = e.target.closest("[data-pick-plan]");
  if (pl) { S.selected = pl.dataset.pickPlan; $("#pd-plan").click(); }
});
$("#pick-poll").addEventListener("click", async () => {
  const pool = pickPool();
  if (pool.length < 2) { toast("후보가 2곳 이상 있어야 투표를 만들 수 있어요."); return; }
  const options = shuffled(pool).slice(0, 3).map((p) => p.name.slice(0, 60));
  const wed = wednesday(0);
  try {
    await addDoc(collection(db, "polls"), {
      question: `${wed.getMonth() + 1}/${wed.getDate()} 어디 갈까? (뽑기 후보)`, options,
      createdBy: S.uid, createdByName: S.me.name, createdAt: serverTimestamp(), closed: false,
    });
    toast("후보 투표를 올렸어요");
    showTab("polls");
  } catch (err) { toast(errMsg(err)); }
});
$("#place-sort").addEventListener("change", renderPlaces);
$("#place-list").addEventListener("click", (e) => {
  const c = e.target.closest("[data-place]");
  if (c) selectPlace(c.dataset.place, true);
});

// 검색
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search-q").value.trim();
  const box = $("#search-results");
  if (!q) return;
  if (!placesSvc) { toast("지도가 준비되면 검색할 수 있어요"); return; }
  placesSvc.keywordSearch(q, (data, status) => {
    box.hidden = false;
    if (status !== kakaoMaps.services.Status.OK || !data.length) {
      box.innerHTML = '<div class="sr-item"><span class="muted">검색 결과가 없어요. 동네 이름을 같이 넣어 보세요.</span></div>';
      return;
    }
    box.innerHTML = data.slice(0, 8).map((r, i) => {
      const exists = S.places.some((p) => p.id === r.id);
      return `<div class="sr-item">
          <div class="info"><div class="nm">${esc(r.place_name)}</div><div class="ad">${esc(r.category_name.split(" > ").slice(-1)[0])} · ${esc(r.road_address_name || r.address_name)}</div></div>
          ${exists ? `<button class="btn ghost sm" data-open="${esc(r.id)}">보기</button>` : `<button class="btn primary sm" data-add="${i}">추가</button>`}
        </div>`;
    }).join("") + '<div class="sr-item"><button class="btn ghost sm" data-closesr>닫기</button></div>';
    box._data = data;
  }, { location: map.getCenter() });
});

$("#search-results").addEventListener("click", async (e) => {
  const box = $("#search-results");
  if (e.target.closest("[data-closesr]")) { box.hidden = true; return; }
  const open = e.target.closest("[data-open]");
  if (open) { box.hidden = true; selectPlace(open.dataset.open, true); return; }
  const add = e.target.closest("[data-add]");
  if (!add) return;
  const r = box._data[Number(add.dataset.add)];
  add.disabled = true;
  try {
    await setDoc(doc(db, "places", r.id), {
      name: r.place_name.slice(0, 80),
      address: r.road_address_name || r.address_name || "",
      category: r.category_name.split(" > ").slice(-1)[0] || "",
      phone: r.phone || "",
      lat: Number(r.y), lng: Number(r.x),
      url: r.place_url || "",
      addedBy: S.uid, addedByName: S.me.name, createdAt: serverTimestamp(),
    });
    box.hidden = true;
    $("#search-q").value = "";
    toast(`'${r.place_name}' 추가! 평점을 남겨 주세요`);
    setTimeout(() => selectPlace(r.id, true), 300);
  } catch (err) { add.disabled = false; toast(errMsg(err)); }
});

// 상세
function selectPlace(id, pan) {
  S.selected = id;
  const mine = stats(id).mine;
  S.myStars = mine?.stars || 0;
  $("#review-text").value = mine?.text || "";
  paintStars();
  renderPlaces();
  const p = S.places.find((x) => x.id === id);
  if (p && map && pan) { map.panTo(new kakaoMaps.LatLng(p.lat, p.lng)); }
  $("#place-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderDetail() {
  const p = S.places.find((x) => x.id === S.selected);
  const box = $("#place-detail");
  if (!p) { box.hidden = true; S.selected = null; return; }
  box.hidden = false;
  const { rs, avg, count, mine } = stats(p.id);
  $("#pd-name").textContent = p.name;
  $("#pd-meta").textContent = [p.category, p.address, p.phone].filter(Boolean).join(" · ");
  $("#pd-summary").innerHTML = count
    ? `<span class="big">${avg.toFixed(1)}</span>${starsHtml(avg)}<span class="muted small">${count}명 평가</span>`
    : '<span class="muted">아직 평점이 없어요. 첫 평점을 남겨 주세요!</span>';
  $("#pd-route-info").innerHTML = routeHtml(p);
  ensureBus(p);
  $("#pd-link").href = p.url || `https://map.kakao.com/link/search/${encodeURIComponent(p.name)}`;
  $("#pd-route").href = `https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
  $("#pd-delete").hidden = !(p.addedBy === S.uid || isAdmin());
  $("#review-delete").hidden = !mine;
  $("#pd-reviews").innerHTML = rs
    .sort((a, b) => (toDate(b.at)?.getTime() || 0) - (toDate(a.at)?.getTime() || 0))
    .map((r) => `<div class="review"><div class="hd"><b>${esc(memberName(r.uid, r.name))}</b>${starsHtml(r.stars)}<span class="muted small">${ago(toDate(r.at))}</span></div>${r.text ? `<p>${esc(r.text)}</p>` : ""}</div>`)
    .join("");
}
$("#pd-close").addEventListener("click", () => { S.selected = null; $("#place-detail").hidden = true; renderPlaces(); });

function paintStars() { $$("#star-input button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) <= S.myStars)); }
$$("#star-input button").forEach((b) => b.addEventListener("click", () => { S.myStars = Number(b.dataset.v); paintStars(); }));

$("#review-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!S.myStars) { toast("별을 눌러 평점을 골라 주세요"); return; }
  try {
    await setDoc(doc(db, "reviews", `${S.selected}_${S.uid}`), {
      placeId: S.selected, uid: S.uid, name: S.me.name, stars: S.myStars, text: $("#review-text").value.trim(), at: serverTimestamp(),
    });
    toast("평점을 저장했어요");
  } catch (err) { toast(errMsg(err)); }
});
$("#review-delete").addEventListener("click", async () => {
  try {
    await deleteDoc(doc(db, "reviews", `${S.selected}_${S.uid}`));
    S.myStars = 0; $("#review-text").value = ""; paintStars();
    toast("내 평점을 지웠어요");
  } catch (err) { toast(errMsg(err)); }
});
$("#pd-plan").addEventListener("click", async () => {
  const p = S.places.find((x) => x.id === S.selected);
  if (!p) return;
  try {
    if (S.weekOffset !== 0) { S.weekOffset = 0; subscribeWeek(); }
    const cur = await getDoc(doc(db, "events", S.wedKey)); // 이미 적힌 시간·메모는 그대로 둬요
    const ev = cur.exists() ? cur.data() : {};
    await savePlan(p.name, ev.time || CFG.defaultTime || "", ev.note || "");
    toast(`이번 주 장소: ${p.name}`);
  } catch (err) { toast(errMsg(err)); }
});
$("#pd-delete").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1"; btn.textContent = "정말 삭제?";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "목록에서 삭제"; }, 3000);
    return;
  }
  try {
    await deleteDoc(doc(db, "places", S.selected));
    S.selected = null; $("#place-detail").hidden = true;
    toast("맛집을 삭제했어요");
  } catch (err) { toast(errMsg(err)); }
});
