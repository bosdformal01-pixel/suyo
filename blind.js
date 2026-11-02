// 수요미식회 — 블라인드 평점
// 모임에 간 사람들이 점수를 몰래 내고, 참석자가 다 내면(또는 회장·임원이 열면) 한 번에 공개돼요.
// 점수는 blindScore에 따로 저장되고, 공개 전에는 본인만 읽을 수 있어요(Firestore 규칙으로 막음).
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, writeBatch, collection, query, where,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = getApp();
const db = getFirestore(app);
const auth = getAuth(app);

const SHOW_DAYS = 6; // 모임 날부터 며칠 동안 카드를 보여줄지
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const fmtDate = (k) => { const [, m, d] = k.split("-").map(Number); return `${m}월 ${d}일`; };
const toast = (t) => { const el = document.getElementById("toast"); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 2400); };
const errMsg = (e) => (e && e.code === "permission-denied" ? "권한이 없어요 (이미 공개됐을 수도 있어요)" : "잠깐 문제가 생겼어요. 다시 해 주세요");

const S = {
  uid: null, me: null, events: {}, places: [], date: null,
  yes: [], votes: [], reveal: null, myScore: null, scores: null, myReview: null,
  draft: 3.0, editing: false, confirmReveal: false, revealing: false,
};
let unsubDate = [];

// ---------- 화면 자리 만들기 (홈 맨 위) ----------
const card = document.createElement("section");
card.className = "group wide";
card.id = "blind-card";
card.hidden = true;
const grid = document.querySelector(".dash-grid");
if (grid) grid.insertBefore(card, grid.firstChild);

// ---------- 데이터 구독 ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) { S.uid = null; card.hidden = true; return; }
  S.uid = user.uid;
  onSnapshot(doc(db, "members", user.uid), (d) => { S.me = d.exists() ? d.data() : null; render(); }, () => {});
  onSnapshot(collection(db, "events"), (snap) => {
    S.events = {}; snap.forEach((d) => (S.events[d.id] = d.data())); pickDate();
  }, () => {});
  onSnapshot(collection(db, "places"), (snap) => { S.places = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, () => {});
});

function pickDate() {
  const today = keyOf(new Date());
  const keys = Object.keys(S.events)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && (S.events[k].place || "").trim() && k <= today && dayDiff(k, today) <= SHOW_DAYS)
    .sort();
  const date = keys.length ? keys[keys.length - 1] : null;
  if (date !== S.date) watchDate(date);
  else render();
}

function watchDate(date) {
  unsubDate.forEach((u) => u()); unsubDate = [];
  Object.assign(S, { date, yes: [], votes: [], votesLoaded: false, reveal: null, myScore: null, scores: null, myReview: null, editing: false, confirmReveal: false });
  if (!date) return render();
  unsubDate.push(onSnapshot(query(collection(db, "attendance"), where("date", "==", date)), (snap) => {
    S.yes = snap.docs.map((d) => d.data()).filter((a) => a.status === "yes"); render(); maybeAutoReveal();
  }, () => {}));
  unsubDate.push(onSnapshot(query(collection(db, "blind"), where("date", "==", date)), (snap) => {
    S.votes = snap.docs.map((d) => d.data());
    S.votesLoaded = true;
    if (S.votes.some((v) => v.uid === S.uid) && S.myScore == null) loadMyScore();
    if (S.reveal) loadScores();
    render(); maybeAutoReveal();
  }, () => {}));
  unsubDate.push(onSnapshot(doc(db, "blindReveal", date), (d) => {
    S.reveal = d.exists() ? d.data() : null;
    if (S.reveal && S.votesLoaded) loadScores();
    render();
  }, () => {}));
}

async function loadMyScore() {
  try {
    const d = await getDoc(doc(db, "blindScore", `${S.date}_${S.uid}`));
    if (d.exists()) { S.myScore = d.data().stars; S.draft = S.myScore; render(); }
  } catch (_) {}
}

async function loadScores() {
  const date = S.date;
  try {
    const got = await Promise.all(S.votes.map((v) => getDoc(doc(db, "blindScore", `${date}_${v.uid}`)).catch(() => null)));
    if (date !== S.date) return;
    S.scores = {};
    got.forEach((d) => { if (d && d.exists()) S.scores[d.data().uid] = d.data().stars; });
    const place = placeOf();
    if (place) {
      const r = await getDoc(doc(db, "reviews", `${place.id}_${S.uid}`)).catch(() => null);
      S.myReview = r && r.exists() ? r.data() : null;
    }
    render();
  } catch (_) {}
}

// 참석자 = 이번 모임에 '참석'으로 표시한 사람 + 점수를 낸 사람
function people() {
  const map = new Map();
  S.yes.forEach((a) => map.set(a.uid, a.name || "?"));
  S.votes.forEach((v) => { if (!map.has(v.uid)) map.set(v.uid, v.name || "?"); });
  return [...map].map(([uid, name]) => ({ uid, name }));
}
const voted = (uid) => S.votes.some((v) => v.uid === uid);
const placeOf = () => {
  const name = ((S.events[S.date] || {}).place || "").trim();
  return S.places.find((p) => (p.name || "").trim() === name) || null;
};
const isOfficer = () => S.me && ["admin", "officer"].includes(S.me.role);

async function maybeAutoReveal() {
  if (!S.date || S.reveal || S.revealing || !S.me) return;
  const yesIds = S.yes.map((a) => a.uid);
  if (yesIds.length < 2 || !yesIds.every(voted)) return;
  S.revealing = true;
  try {
    await setDoc(doc(db, "blindReveal", S.date), { uid: S.uid, name: S.me.name, auto: true, at: serverTimestamp() });
  } catch (_) { /* 다른 사람이 먼저 열었으면 괜찮아요 */ }
  S.revealing = false;
}

// ---------- 그리기 ----------
function render() {
  if (!S.uid || !S.me || !S.date) { card.hidden = true; return; }
  card.hidden = false;
  const ev = S.events[S.date] || {};
  const ppl = people();
  const nVoted = ppl.filter((p) => voted(p.uid)).length;
  const revealed = !!S.reveal;
  const scores = S.scores || {};
  const vals = Object.values(scores);
  const hi = vals.length > 1 ? Math.max(...vals) : null;
  const lo = vals.length > 1 ? Math.min(...vals) : null;

  const cards = ppl.map((p) => {
    let cls = "face", txt = "?";
    if (revealed) {
      if (p.uid in scores) {
        cls += " open"; txt = scores[p.uid].toFixed(1);
        if (hi !== lo && scores[p.uid] === hi) cls += " hi";
        if (hi !== lo && scores[p.uid] === lo) cls += " lo";
      } else { cls += " wait"; txt = "안 냄"; }
    } else if (!voted(p.uid)) { cls += " wait"; txt = "아직"; }
    if (p.uid === S.uid) cls += " me";
    return `<div class="bc"><div class="${cls}">${txt}</div><span class="nm">${esc(p.uid === S.uid ? "나" : p.name)}</span></div>`;
  }).join("");

  let body = "";
  if (revealed) {
    if (!vals.length) {
      body = `<p class="muted small">${S.scores ? "낸 점수가 없어요." : "점수를 불러오는 중…"}</p>`;
    } else {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const who = (v) => ppl.filter((p) => scores[p.uid] === v).map((p) => p.name).join(", ");
      body = `<div class="reveal-sum">
          <div class="box"><div class="k">우리 평균</div><div class="v">★ ${avg.toFixed(1)}<small>${vals.length}명</small></div></div>
          <div class="box"><div class="k">제일 후한 사람</div><div class="v">${hi !== null && hi !== lo ? esc(who(hi)) : "-"}<small>${hi !== null && hi !== lo ? hi.toFixed(1) + "점" : "모두 같아요"}</small></div></div>
          <div class="box"><div class="k">제일 짠 사람</div><div class="v">${lo !== null && hi !== lo ? esc(who(lo)) : "-"}<small>${lo !== null && hi !== lo ? lo.toFixed(1) + "점" : ""}</small></div></div>
        </div>`;
      const mine = scores[S.uid];
      const place = placeOf();
      if (mine != null && place) {
        const same = S.myReview && Math.abs((S.myReview.stars || 0) - mine) < 0.01;
        body += same
          ? `<p class="muted small blind-done">✓ 내 점수 ${mine.toFixed(1)}점이 맛집 평점에 들어가 있어요</p>`
          : `<div class="blind-actions"><button class="btn primary" type="button" data-blind="save-review">내 점수(${mine.toFixed(1)}) 맛집 평점에 남기기</button></div>`;
      } else if (mine != null && !place) {
        body += `<p class="muted small">맛집 목록에 '${esc(ev.place)}'이(가) 없어서 평점에는 못 넣어요. 맛집 탭에서 먼저 추가해 주세요.</p>`;
      }
    }
    body += `<p class="muted small blind-foot">${S.reveal.auto ? "참석자가 다 내서 자동 공개" : `${esc(S.reveal.name)}님이 공개`}</p>`;
  } else {
    const iVoted = voted(S.uid);
    if (iVoted && !S.editing) {
      body = `<div class="my-rate done"><span class="big">${S.myScore != null ? S.myScore.toFixed(1) : "…"}</span><span class="muted small">내가 낸 점수예요. 공개 전까진 나만 보여요.</span></div>
        <div class="blind-actions"><button class="btn ghost" type="button" data-blind="edit">점수 바꾸기</button>${isOfficer() ? revealBtn() : ""}</div>`;
    } else {
      body = `<div class="my-rate"><span class="big" id="blind-val">${S.draft.toFixed(1)}</span><input id="blind-range" type="range" min="0.1" max="5" step="0.1" value="${S.draft}" aria-label="내 별점"></div>
        <div class="blind-actions"><button class="btn primary" type="button" data-blind="submit">${iVoted ? "다시 내기" : "몰래 내기"}</button>${iVoted ? '<button class="btn ghost" type="button" data-blind="cancel">취소</button>' : ""}${isOfficer() && !iVoted ? revealBtn() : ""}</div>`;
    }
    const yesN = S.yes.length;
    body += `<p class="muted small blind-foot">${yesN ? `참석한 ${yesN}명이 다 내면 한 번에 공개돼요.` : "참석 표시한 사람이 없어서 회장·임원이 열어야 공개돼요."} 그 전엔 누가 몇 점 줬는지 아무도 못 봐요.</p>`;
  }

  const html = `<header class="group-head"><h3>🙈 블라인드 평점</h3><span class="muted small">${revealed ? "공개됨" : `${nVoted}/${ppl.length || 0}명 냈어요`}</span></header>
    <div class="card"><div class="blind-meta"><b>${esc(ev.place)}</b><span class="muted small">${fmtDate(S.date)} 모임</span></div>
    ${ppl.length ? `<div class="blind-cards" style="--n:${Math.min(ppl.length, 6)}">${cards}</div>` : ""}${body}</div>`;
  if (card._h !== html) { card._h = html; card.innerHTML = html; }
}
const revealBtn = () => `<button class="btn ghost" type="button" data-blind="reveal">${S.confirmReveal ? "정말 공개?" : "지금 공개 (임원)"}</button>`;

// ---------- 버튼 ----------
card.addEventListener("input", (e) => {
  if (e.target.id !== "blind-range") return;
  S.draft = Math.round(parseFloat(e.target.value) * 10) / 10;
  const v = document.getElementById("blind-val"); if (v) v.textContent = S.draft.toFixed(1);
});
card.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-blind]"); if (!b) return;
  const act = b.dataset.blind;
  if (act === "edit") { S.editing = true; S.draft = S.myScore ?? S.draft; card._h = ""; return render(); }
  if (act === "cancel") { S.editing = false; card._h = ""; return render(); }
  if (act === "submit") {
    const stars = Math.min(5, Math.max(0.1, S.draft));
    b.disabled = true;
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "blind", `${S.date}_${S.uid}`), { date: S.date, uid: S.uid, name: S.me.name, at: serverTimestamp() });
      batch.set(doc(db, "blindScore", `${S.date}_${S.uid}`), { date: S.date, uid: S.uid, name: S.me.name, stars, at: serverTimestamp() });
      await batch.commit();
      S.myScore = stars; S.editing = false; card._h = ""; render();
      toast("몰래 냈어요 🤫");
    } catch (err) { toast(errMsg(err)); b.disabled = false; }
    return;
  }
  if (act === "reveal") {
    if (!S.confirmReveal) { S.confirmReveal = true; card._h = ""; render(); setTimeout(() => { S.confirmReveal = false; card._h = ""; render(); }, 3000); return; }
    try { await setDoc(doc(db, "blindReveal", S.date), { uid: S.uid, name: S.me.name, auto: false, at: serverTimestamp() }); }
    catch (err) { toast(errMsg(err)); }
    return;
  }
  if (act === "save-review") {
    const place = placeOf(); const mine = (S.scores || {})[S.uid];
    if (!place || mine == null) return;
    b.disabled = true;
    try {
      const data = { placeId: place.id, uid: S.uid, name: S.me.name, stars: mine, text: (S.myReview && S.myReview.text) || "", at: serverTimestamp() };
      await setDoc(doc(db, "reviews", `${place.id}_${S.uid}`), data);
      S.myReview = data; card._h = ""; render();
      toast("맛집 평점에 남겼어요");
    } catch (err) { toast(errMsg(err)); b.disabled = false; }
  }
});

// 날짜가 바뀌면(자정 넘김) 다시 고르기
setInterval(() => { if (S.uid) pickDate(); }, 60 * 1000);
