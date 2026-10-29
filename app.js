// ============================================================
//  수요미식회 — 메인 스크립트
//  (설정값은 config.js, 권한 규칙은 firestore.rules 에 있어요)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = window.SUYO_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS = { yes: "참석", maybe: "미정", no: "불참" };
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

// ---------- 공통 화면 도우미 ----------
function gateError(msg) {
  $("#gate-loading").hidden = true;
  $("#join-form").hidden = true;
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
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}
function errMsg(e) {
  console.error(e);
  if (e?.code === "permission-denied") return "권한이 없어요. 다시 시도해 주세요.";
  if (e?.code === "unavailable") return "인터넷 연결을 확인해 주세요.";
  return "문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
}
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } };

// ---------- 날짜 ----------
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function wednesday(offsetWeeks = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7) + offsetWeeks * 7); // 오늘 이후 가장 가까운 수요일
  return d;
}
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

// ---------- 설정 확인 ----------
if (!CFG.firebase || !CFG.firebase.apiKey || !CFG.firebase.projectId) {
  gateError("아직 설정이 안 됐어요.\nconfig.js 파일에 Firebase 설정값을 넣어 주세요.\n(README.md 2단계 참고)");
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
  attendance: [], event: null,
  polls: [], votes: {},
  messages: [],
  places: [], reviews: [],
  selected: null, myStars: 0,
  tab: "home",
};
const isAdmin = () => S.me?.role === "admin";

// ============================================================
//  로그인 / 입장
// ============================================================
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) {
      console.error(e);
      gateError("로그인을 할 수 없어요.\nFirebase 콘솔 > Authentication > 로그인 방법에서\n'익명'을 사용 설정했는지 확인해 주세요.");
    }
    return;
  }
  S.uid = user.uid;
  try {
    const snap = await getDoc(doc(db, "members", user.uid));
    if (snap.exists()) { S.me = snap.data(); startApp(); }
    else showJoin();
  } catch (e) {
    console.error(e);
    gateError("데이터베이스에 연결할 수 없어요.\nFirestore를 만들고 firestore.rules 규칙을 게시했는지 확인해 주세요.");
  }
});

function showJoin() {
  $("#gate-loading").hidden = true;
  $("#join-form").hidden = false;
  $("#join-name").focus();
}

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#join-name").value.trim();
  const code = $("#join-code").value.trim();
  if (!name || !code) return;
  const btn = e.submitter || $("#join-form button");
  btn.disabled = true;
  try {
    await setDoc(doc(db, "members", S.uid), { uid: S.uid, name, joinCode: code, joinedAt: serverTimestamp() });
    S.me = (await getDoc(doc(db, "members", S.uid))).data();
    startApp();
  } catch (err) {
    console.error(err);
    toast(err?.code === "permission-denied" ? "입장 코드가 맞지 않아요." : errMsg(err));
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
//  앱 시작 & 실시간 구독
// ============================================================
let started = false;
function startApp() {
  if (started) return;
  started = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#me-chip").textContent = S.me.name + (isAdmin() ? " · 회장" : "");

  onSnapshot(collection(db, "members"), (qs) => {
    S.members = {};
    qs.forEach((d) => (S.members[d.id] = d.data()));
    renderHome();
  });

  subscribeWeek();

  onSnapshot(query(collection(db, "polls"), orderBy("createdAt", "desc"), limit(30)), (qs) => {
    S.polls = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    syncVoteSubs();
    renderPolls(); renderHome();
  });

  onSnapshot(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(200)), (qs) => {
    S.messages = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) })).reverse();
    renderChat(); renderHome();
  });

  onSnapshot(collection(db, "places"), (qs) => {
    S.places = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderPlaces(); renderPlaceOptions();
  });

  onSnapshot(collection(db, "reviews"), (qs) => {
    S.reviews = qs.docs.map((d) => ({ id: d.id, ...d.data(SNAP) }));
    renderPlaces();
  });

  const start = location.hash.replace("#", "");
  showTab(["home", "polls", "chat", "places"].includes(start) ? start : "home");
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
  ];
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
});

// ============================================================
//  홈: 이번 주 수요일
// ============================================================
$("#week-prev").addEventListener("click", () => { S.weekOffset--; closePlanForm(); subscribeWeek(); });
$("#week-next").addEventListener("click", () => { S.weekOffset++; closePlanForm(); subscribeWeek(); });

function renderHome() {
  if (!S.me) return;
  const wed = wednesday(S.weekOffset);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((wed - today) / 86400000);
  $("#week-date").textContent = dayLabel(wed);
  $("#week-dday").textContent = diff === 0 ? "오늘 모임!" : diff > 0 ? `D-${diff}` : `${-diff}일 전 모임`;

  // 계획
  const ev = S.event;
  const updated = ev?.updatedByName ? `<div class="plan-foot">${esc(ev.updatedByName)} 님이 ${ago(toDate(ev.updatedAt))} 수정</div>` : "";
  $("#plan-view").innerHTML = `
    <dt>장소</dt><dd class="${ev?.place ? "" : "empty"}">${esc(ev?.place || "아직 안 정했어요")}</dd>
    <dt>시간</dt><dd class="${ev?.time ? "" : "empty"}">${esc(ev?.time || CFG.defaultTime || "미정")}</dd>
    ${ev?.note ? `<dt>메모</dt><dd>${esc(ev.note)}</dd>` : ""}
    ${updated}`;

  // 참석
  const mine = S.attendance.find((a) => a.uid === S.uid)?.status;
  $$(".rsvp").forEach((b) => b.classList.toggle("on", b.dataset.status === mine));
  const groups = { yes: [], maybe: [], no: [] };
  S.attendance.forEach((a) => groups[a.status]?.push(S.members[a.uid]?.name || a.name));
  const answered = new Set(S.attendance.map((a) => a.uid));
  const none = Object.entries(S.members).filter(([id]) => !answered.has(id)).map(([, m]) => m.name);
  const row = (cls, label, arr) => `
    <div class="rsvp-row"><span class="lbl ${cls}">${label} ${arr.length}</span>
      <div class="names">${arr.length ? arr.map((n) => `<span class="name-pill">${esc(n)}</span>`).join("") : '<span class="muted small">-</span>'}</div>
    </div>`;
  $("#rsvp-lists").innerHTML = row("yes", "참석", groups.yes) + row("maybe", "미정", groups.maybe) + row("no", "불참", groups.no) + row("none", "무응답", none);
  $("#rsvp-summary").textContent = `멤버 ${Object.keys(S.members).length}명 중 ${S.attendance.length}명 응답`;

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
    ? last.map((m) => `<button class="mini-item" data-goto="chat"><span class="t"><b>${esc(m.name)}</b> ${esc(m.text)}</span><span class="small muted">${ago(toDate(m.createdAt))}</span></button>`).join("")
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
function openPlanForm(prefillPlace) {
  const ev = S.event || {};
  $("#plan-place").value = prefillPlace ?? ev.place ?? "";
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
$("#plan-edit-btn").addEventListener("click", () => openPlanForm());
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
          ${who.length ? `<span class="who">${who.map((v) => esc(S.members[v.uid]?.name || v.name)).join(", ")}</span>` : ""}
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
      if (del.dataset.confirm !== "1") { // 실수 방지: 두 번 눌러야 삭제
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
        out += `<div class="msg ${me ? "me" : ""}" data-id="${m.id}">
            ${!me && lastUid !== m.uid ? `<span class="who">${esc(S.members[m.uid]?.name || m.name)}</span>` : ""}
            <div class="line"><div class="bubble">${esc(m.text)}</div><span class="time">${hhmm(d)}</span>
              ${canDel ? `<button class="del" data-delmsg="${m.id}" hidden>삭제</button>` : ""}</div>
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
  const msg = e.target.closest(".msg");
  const btn = msg?.querySelector(".del");
  if (btn) btn.hidden = !btn.hidden; // 내 말풍선을 누르면 삭제 버튼이 나와요
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
    mapMsg("카카오 지도 키가 아직 없어요.\nconfig.js에 kakaoJsKey를 넣으면 지도가 보여요.\n(README.md 3단계 참고)");
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
}
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
  $("#pd-link").href = p.url || `https://map.kakao.com/link/search/${encodeURIComponent(p.name)}`;
  $("#pd-route").href = `https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
  $("#pd-delete").hidden = !(p.addedBy === S.uid || isAdmin());
  $("#review-delete").hidden = !mine;
  $("#pd-reviews").innerHTML = rs
    .sort((a, b) => (toDate(b.at)?.getTime() || 0) - (toDate(a.at)?.getTime() || 0))
    .map((r) => `<div class="review"><div class="hd"><b>${esc(S.members[r.uid]?.name || r.name)}</b>${starsHtml(r.stars)}<span class="muted small">${ago(toDate(r.at))}</span></div>${r.text ? `<p>${esc(r.text)}</p>` : ""}</div>`)
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
