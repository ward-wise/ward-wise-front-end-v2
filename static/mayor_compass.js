// Mayor compass (/mayor): the quiz, the map and the candidate table. The data is static/mayor_compass_data.js.
//
// Counts sent (only via WardWiseAnalytics.track, never from ?demo= URLs). Same names as the register in
// analytics.js; they exist so we can show how Chicago answered, ward by ward, and which statements split people:
//   mayor_quiz_started       {}                       first answer of a run
//   mayor_quiz_answer        {statement, answer, number, matters}   each answer, Not sure or skip
//   mayor_quiz_issues        {issues}                 leaving the top 3 issues step
//   mayor_quiz_profile       {quiz_ward, age_band, leaning, skipped}   leaving the optional picks step
//   mayor_quiz_finished      {answers, matters, issues, quiz_ward, age_band, leaning, answered,
//                             finished_early, best_match, best_match_pct, top3, x, y}   result revealed
//   mayor_quiz_restart       {}                       Change my answers
//   mayor_quiz_share_card    {}                       share card downloaded
//   mayor_quiz_person_opened {person}                 the drawer opens on a person
//   mayor_quiz_card_copied   {where}                  result picture copied (where: top, result or card)
//   mayor_quiz_reset         {answered, finished}     Start over, after Yes
//   mayor_quiz_why_opened    {match}                  "See why" opened under the result (statement list)
// quiz_ward is the ward typed into the quiz; track() already sets "ward" to the visitor's own saved ward.
(function () {
"use strict";
const DATA = window.MayorCompassData;
if (!DATA) return;
const QS = DATA.questions, Q = {}; QS.forEach(q => Q[q.qid] = q);
const PEOPLE = DATA.people;
const BY = {}; PEOPLE.forEach(p => BY[p.id] = p);
const ORDER = ["E5","C1","E6","S12","E17","S1","E1","C4","E14","S5","E13","S4","E10","C2","E3","S6","E16","C3","E15","C5","E7","S2","E11","E12"];
const TOPICS = ["Crime and public safety","Taxes","Housing costs","Schools","City budget and pensions","Public transit (CTA)","Jobs and the economy","Police reform","Homelessness","Immigration"];
const AGES = ["18 to 24","25 to 34","35 to 49","50 to 64","65+"];
const LABELS = {"-2":"Strongly disagree","-1":"Disagree","0":"Neutral","1":"Agree","2":"Strongly agree"};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const DEMO = /[?&]demo=(1|mid|card)/.test(location.search), MID = /[?&]demo=mid/.test(location.search), CARDDEMO = /[?&]demo=card/.test(location.search);
const store = {get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}, set(k,v){if(DEMO)return;try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};

/* ---------- tracking ---------- */
// Sent only through WardWiseAnalytics.track, which adds the visitor's saved ward and the page.
// Never from ?demo= URLs, which are for looking at the design.
const WORDS = {"-2": "strongly_disagree", "-1": "disagree", "0": "neutral", "1": "agree", "2": "strongly_agree"};
function track(name, props){
  if (DEMO || !window.WardWiseAnalytics) return;
  try { window.WardWiseAnalytics.track(name, props || {}); } catch (e) { /* analytics is best-effort */ }
}
// quiz_ward is the ward the visitor says they live in for this quiz; track() already owns "ward".
function profileProps(pr, skipped){
  const o = {};
  if (pr.ward) o.quiz_ward = pr.ward;
  if (pr.age) o.age_band = pr.age;
  if (pr.lean) o.leaning = pr.lean;
  o.skipped = skipped;
  return o;
}
let started = false, earlyFinish = false;
function noteAnswer(qid, word){
  if (!started) { started = true; track("mayor_quiz_started", {}); }
  track("mayor_quiz_answer", {statement: qid, answer: word, number: ORDER.indexOf(qid) + 1, matters: !!stars[qid]});
}
function trackFinished(){
  if (DEMO || !window.WardWiseAnalytics) return;
  const me = you(), ans = {};
  ORDER.forEach(q => { if (answers[q] != null) ans[q] = WORDS[answers[q]]; else if (unsure[q]) ans[q] = "not_sure"; else if (q in answers) ans[q] = "skipped"; });
  const ranked = rankOf(PEOPLE.filter(p => p.cand));
  const o = {match_method: "closeness", answers: ans, matters: ORDER.filter(q => stars[q]), issues: top3.slice(), answered: answered(), finished_early: earlyFinish,
    top3: ranked.slice(0, 3).map(c => ({id: c.p.id, pct: c.m.pct})), x: Math.round(me.x * 100) / 100, y: Math.round(me.y * 100) / 100};
  if (profile && profile.ward) o.quiz_ward = profile.ward;
  if (profile && profile.age) o.age_band = profile.age;
  if (profile && profile.lean) o.leaning = profile.lean;
  if (ranked[0]) { o.best_match = ranked[0].p.id; o.best_match_pct = ranked[0].m.pct; }
  track("mayor_quiz_finished", o);
}

let answers = store.get("mc-answers", {}), stars = store.get("mc-stars", {}), unsure = store.get("mc-unsure", {}), top3 = store.get("mc-top3", []), profile = store.get("mc-profile", {}), qi = 0;
// Statement S4 was reworded on Nov 10, 2026 (accept federal help -> turn away federal forces). Drop answers saved before that.
if (store.get("mc-ver", 0) < 2) { if (answers.S4 != null) delete answers.S4; store.set("mc-answers", answers); store.set("mc-ver", 2); }
// Nov 10, 2026 (round 8): the map lines changed to Progressive/Conservative and More city control/More personal freedom,
// with 24 statements. Answers saved on the old lines would place people wrongly, so they start fresh.
if (store.get("mc-ver", 0) < 3) { answers = {}; unsure = {}; stars = {}; ["mc-answers", "mc-unsure", "mc-stars"].forEach(k => store.set(k, {})); store.set("mc-done", false); store.set("mc-ver", 3); }
let stage = "q", stepsDone = false, animYou = false, bdAll = false, bdOpen = false, pickTop = [], draft = {};
let animPod = false, cdTimers = [], cdLeft = 0;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
if (DEMO) {
  answers = {}; stars = {}; unsure = {}; profile = {}; top3 = ["Crime and public safety", "Housing costs", "Taxes"];
  [2,1,-1,2,-1,1,-2,1,2,-1,1,-1,1,-2,2,-1,1,1,-1,2,-1,1,2,-1].slice(0, MID ? 12 : ORDER.length).forEach((v, i) => answers[ORDER[i]] = v);
  if (!MID) { answers[ORDER[5]] = 0; delete answers[ORDER[11]]; unsure[ORDER[11]] = true; }
}
if (!Array.isArray(top3)) top3 = [];
for (const k of Object.keys(answers)) if (!ORDER.includes(k)) delete answers[k];
for (const k of Object.keys(stars)) if (!ORDER.includes(k)) delete stars[k];
for (const k of Object.keys(unsure)) if (!ORDER.includes(k) || !unsure[k] || answers[k] != null) delete unsure[k];
let finished = DEMO ? !MID : ((Object.keys(answers).length > 0 || Object.keys(unsure).length > 0) && store.get("mc-done", false) === true), showField = false;
stepsDone = finished;
let pre = false, openId = null;

/* ---------- plain words: one rule everywhere ---------- */
const AX = {
  x: {k: "Economy", pos: "conservative", neg: "progressive", posS: "conservative", negS: "progressive",
      mid: "Near the middle on the economy", midS: "Middle on the economy", endNeg: "Progressive", endPos: "Conservative", rot: {pos: 90, neg: -90}},
  y: {k: "City control", pos: "more city control", neg: "more personal freedom", posS: "more city control", negS: "more personal freedom",
      mid: "Near the middle on city control", midS: "Middle on city control", endNeg: "More personal freedom", endPos: "More city control", rot: {pos: 0, neg: 180}}
};
const level = v => { const a = Math.abs(v); return a < 1.5 ? 0 : a < 5 ? 1 : 2; };
function say(ax, v, short){
  if (v == null) return "No public record yet";
  const A = AX[ax], l = level(v);
  if (l === 0) return short ? A.midS : A.mid;
  return (l === 1 ? "Somewhat toward " : "Strongly toward ") + (v > 0 ? (short ? A.posS : A.pos) : (short ? A.negS : A.neg));
}
function mixedText(p, ax){
  if (!p || !p["mixed_" + ax]) return null;
  const s = p["sides_" + ax] || [0, 0], A = AX[ax];
  return "Mixed on " + (ax === "x" ? "the economy" : "city control") + ": " + s[1] + " toward " + A.posS + ", " + s[0] + " toward " + A.negS;
}
const sayP = (p, ax, short) => mixedText(p, ax) || say(ax, p[ax], short);
const ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
const BAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="4"/></svg>';
function icon(ax, v){
  if (level(v) === 0) return BAL;
  return '<span style="display:grid;transform:rotate(' + AX[ax].rot[v > 0 ? "pos" : "neg"] + 'deg)">' + ARROW + '</span>';
}
function scoreLine(ax, v, o){
  o = o || {}; const A = AX[ax];
  if (v == null) return '<div class="sl ' + (ax === "y" ? "safe" : "") + ' ' + (o.cls || "") + '">' + (o.nohead ? "" : '<div class="sl-head"><span class="sl-k">' + A.k + '</span></div>') + '<div class="sl-words nodata"><b>No public record yet</b></div></div>';
  const pct = 50 + v * 5, lo = Math.min(50, pct), w = Math.abs(pct - 50), far = Math.abs(v).toFixed(1) + " of 10 from the middle";
  const gauge = '<div class="gauge" aria-hidden="true"><div class="zone" style="left:35%;width:30%"></div><div class="gf" style="left:' + lo + '%;width:' + w + '%"></div><div class="mid"></div><div class="pin" style="left:' + pct + '%"></div></div>';
  const ends = o.ends === false ? "" : '<div class="ends"><span>' + A.endNeg + '</span><span>' + A.endPos + '</span></div>';
  const head = o.nohead ? "" : '<div class="sl-head"><span class="sl-k">' + A.k + '</span><span class="sl-num">' + far + '</span></div>';
  const num = o.nohead ? '<span class="sl-num">' + far + '</span>' : "";
  return '<div class="sl ' + (ax === "y" ? "safe" : "") + ' ' + (o.cls || "") + '">' + head + '<div class="sl-words"><span class="ico">' + icon(ax, v) + '</span><b>' + (o.mixed || say(ax, v, o.short)) + '</b></div>' + gauge + ends + num + '</div>';
}
const nameOf = p => p.id === "richard-j-daley" ? "R. J. Daley" : p.id === "richard-m-daley" ? "R. M. Daley" : p.short;

/* ---------- chart (Signposts) ---------- */
let uid = 0;
function chart(o){
  const id = "c" + (++uid), S = o.S, M = o.M || 0, Mb = o.Mb == null ? M : o.Mb, Ml = o.Ml || 0, k = S / 20, half = S / 2;
  const W = S + 2 * M + Ml, H = S + M + Mb, X = x => M + half + x * k, Y = y => M + half - y * k, rr = 18;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Chart of candidates: progressive to conservative, and more city control to more personal freedom"><g transform="translate(' + Ml + ' 0)"><defs><clipPath id="' + id + '"><rect x="' + M + '" y="' + M + '" width="' + S + '" height="' + S + '" rx="' + rr + '"/></clipPath></defs>';
  s += '<g clip-path="url(#' + id + ')"><rect x="' + M + '" y="' + M + '" width="' + S + '" height="' + S + '" fill="var(--card)"/>';
  s += '<rect x="' + (M + half) + '" y="' + M + '" width="' + half + '" height="' + half + '" fill="var(--q1)"/><rect x="' + M + '" y="' + M + '" width="' + half + '" height="' + half + '" fill="var(--q2)"/>';
  s += '<rect x="' + M + '" y="' + (M + half) + '" width="' + half + '" height="' + half + '" fill="var(--q3)"/><rect x="' + (M + half) + '" y="' + (M + half) + '" width="' + half + '" height="' + half + '" fill="var(--q4)"/></g>';
  // light 10 by 10 grid: a line every 2 points, clipped to the rounded map
  let grid = ""; for (let v = -8; v <= 8; v += 2) if (v) grid += '<line x1="' + X(v) + '" y1="' + M + '" x2="' + X(v) + '" y2="' + (M + S) + '"/><line x1="' + M + '" y1="' + Y(v) + '" x2="' + (M + S) + '" y2="' + Y(v) + '"/>';
  s += '<g class="grid" clip-path="url(#' + id + ')">' + grid + '</g>';
  const a0 = M + 10, a1 = M + S - 10;
  s += '<line class="axis" x1="' + a0 + '" y1="' + Y(0) + '" x2="' + a1 + '" y2="' + Y(0) + '"/><line class="axis" x1="' + X(0) + '" y1="' + a0 + '" x2="' + X(0) + '" y2="' + a1 + '"/>';
  const ah = (x, y, rot) => '<path class="axhead" transform="translate(' + x + ' ' + y + ') rotate(' + rot + ')" d="M0 0L-9 -5V5Z"/>';
  s += ah(a1 + 3, Y(0), 0) + ah(a0 - 3, Y(0), 180) + ah(X(0), a0 - 3, -90) + ah(X(0), a1 + 3, 90);
  const pad = 14, nm = o.cap || 13.5;
  const corner = (x, y, anc, l1, l2) => '<text x="' + x + '" y="' + y + '" text-anchor="' + anc + '"><tspan class="q-cap" style="font-size:' + nm + 'px">' + l1 + '</tspan><tspan class="q-cap sm" x="' + x + '" dy="15">' + l2 + '</tspan></text>';
  s += corner(M + S - pad, M + pad + 10, "end", "Conservative, more control", "Less spending, more rules");
  s += corner(M + pad, M + pad + 10, "start", "Progressive, more control", "More programs, more rules");
  s += corner(M + pad, M + S - pad - 14, "start", "Progressive, more freedom", "More programs, fewer rules");
  s += corner(M + S - pad, M + S - pad - 14, "end", "Conservative, more freedom", "Less spending, fewer rules");
  /* obstacles for label placement */
  const boxes = [{x: M + S - pad - 190, y: M + pad, w: 190, h: 32}, {x: M + pad, y: M + pad, w: 190, h: 32}, {x: M + pad, y: M + S - pad - 26, w: 190, h: 30}, {x: M + S - pad - 190, y: M + S - pad - 26, w: 190, h: 30}];
  const hit = b => boxes.some(q => b.x < q.x + q.w + 1.5 && b.x + b.w + 1.5 > q.x && b.y < q.y + q.h + 1.5 && b.y + b.h + 1.5 > q.y);
  const inb = b => b.x >= M + 3 && b.x + b.w <= M + S - 3 && b.y >= M + 3 && b.y + b.h <= M + S - 3;
  const shown = PEOPLE.filter(p => p.x != null && p.y != null && (p.cand || o.pre || p.year >= 1955));
  const order = [...shown].sort((a, b) => (a.cand - b.cand) || ((a.year < 1955) - (b.year < 1955)) || b.year - a.year);
  const rad = p => p.cand ? 7 : (!p.cand && p.year < 1955 ? 4 : 5.5);
  order.forEach(p => { const r = rad(p); boxes.push({x: X(p.x) - r - 1, y: Y(p.y) - r - 1, w: 2 * r + 2, h: 2 * r + 2}); });
  let youLab = "";
  if (o.you) {
    const cx = X(o.you.x), cy = Y(o.you.y); boxes.push({x: cx - 18, y: cy - 18, w: 36, h: 36});
    const left = cx - 22 - 28 > M + 4; const bx = left ? cx - 22 - 28 : cx + 22;
    boxes.push({x: bx, y: cy - 10, w: 28, h: 15});
    youLab = '<text class="lab you" x="' + (left ? cx - 22 : cx + 22) + '" y="' + (cy + 5) + '" text-anchor="' + (left ? "end" : "start") + '">You</text>';
  }
  function place(cx, cy, r, w, h){
    const g = 4;
    const near = [[cx + r + g, cy - h / 2], [cx - r - g - w, cy - h / 2], [cx - w / 2, cy - r - g - h], [cx - w / 2, cy + r + g], [cx + r + g - 2, cy - r - g - h + 2], [cx + r + g - 2, cy + r + g - 2], [cx - r - g - w + 2, cy - r - g - h + 2], [cx - r - g - w + 2, cy + r + g - 2]];
    for (const [x, y] of near) { const b = {x, y, w, h}; if (inb(b) && !hit(b)) return {b}; }
    for (const d of [26, 40, 56]) for (let a = 0; a < 8; a++) {
      const ang = a * Math.PI / 4, c = Math.cos(ang), sn = Math.sin(ang), px = cx + c * d, py = cy + sn * d;
      const b = {x: c > .3 ? px : c < -.3 ? px - w : px - w / 2, y: sn > .3 ? py : sn < -.3 ? py - h : py - h / 2, w, h};
      if (inb(b) && !hit(b)) return {b, lead: true};
    }
    return null;
  }
  let lines = "", labels = "", under = "", over = "";
  /* closest match: thin line from You to the top match, with its label */
  if (o.you && o.match && o.match.p.x != null && o.match.p.y != null) {
    const ux = X(o.you.x), uy = Y(o.you.y), tx = X(o.match.p.x), ty = Y(o.match.p.y);
    under += '<line class="mline" x1="' + ux + '" y1="' + uy + '" x2="' + tx + '" y2="' + ty + '"/>';
    over += '<circle class="mring" cx="' + tx + '" cy="' + ty + '" r="13.5"/>';
    const txt = "Best match: " + o.match.p.name + ", " + o.match.pct + "%", w = txt.length * 6.3 + 6, h = 15;
    let spot = null;
    outer: for (const t of [.5, .4, .6, .3, .7, .2, .8]) for (const oy of [-13, 13, -24, 24]) {
      const b = {x: ux + (tx - ux) * t - w / 2, y: uy + (ty - uy) * t + oy - h / 2, w, h};
      if (inb(b) && !hit(b)) { spot = b; break outer; }
    }
    if (!spot) { const pl = place(tx, ty, 11, w, h); if (pl) spot = pl.b; }
    if (spot) { boxes.push(spot); labels += '<text class="lab match" x="' + (spot.x + 2) + '" y="' + (spot.y + h - 3) + '">' + esc(txt) + '</text>'; }
  }
  /* name labels: candidates first, then mayors since 1955 */
  [...shown].filter(p => p.cand || p.year >= 1955).sort((a, b) => (b.cand - a.cand) || (b.n - a.n)).forEach(p => {
    if (o.match && o.match.p.id === p.id && o.you) return;
    const cx = X(p.x), cy = Y(p.y), r = rad(p), t = nameOf(p), w = t.length * (p.cand ? 6.7 : 5.8) + 4, h = 14;
    const pl = place(cx, cy, r, w, h); if (!pl) return;
    const b = pl.b; boxes.push(b);
    if (pl.lead) {
      const px = Math.max(b.x, Math.min(cx, b.x + b.w)), py = Math.max(b.y, Math.min(cy, b.y + b.h)), dx = px - cx, dy = py - cy, dd = Math.hypot(dx, dy) || 1;
      if (dd > r + 5) lines += '<line class="lead" x1="' + (cx + dx / dd * (r + 1)) + '" y1="' + (cy + dy / dd * (r + 1)) + '" x2="' + px + '" y2="' + py + '"/>';
    }
        labels += '<text class="lab ' + (p.cand ? "" : "m") + '" data-for="' + p.id + '" x="'  + (b.x + 2) + '" y="' + (b.y + h - 3) + '">' + esc(t) + '</text>';
  });
  s += under + lines;
  const rk = {}; (o.you && o.top3 || []).forEach((t, i) => rk[t.p.id] = i + 1); // 1, 2, 3 on your top matches
  order.forEach(p => {
    const cx = X(p.x), cy = Y(p.y), pre = !p.cand && p.year < 1955, cls = p.cand ? "cand" : (pre ? "pre" : "mayor"), r = rad(p), thin = p.proof === "thin";
        s += '<g data-id="' + p.id + '" class="pt" tabindex="0" role="button" aria-label="' + esc(p.name) + '"><circle class="hring" cx="' + cx + '" cy="' + cy + '" r="' + (r + 7) + '"/><circle class="dot ' + cls + (thin ? " thin" : "") + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>'  + (thin ? '<circle class="thinring" cx="' + cx + '" cy="' + cy + '" r="' + (r + 3) + '"/>' : '') + (rk[p.id] ? '<circle class="rk" cx="' + cx + '" cy="' + cy + '" r="9.5"/><text class="rkn" x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle">' + rk[p.id] + '</text>' : '') + '</g>';
  });
  s += over + labels;
  if (o.you) { const cx = X(o.you.x), cy = Y(o.you.y); s += '<g class="youg"><circle class="you-halo" cx="' + cx + '" cy="' + cy + '" r="17"/><circle class="you-dot" cx="' + cx + '" cy="' + cy + '" r="8"/>' + youLab + '</g>'; }
  if (o.sideLabels) {
    const f = 'font-size="11.5" fill="var(--ink-2)" font-weight="600"';
    s += '<text x="' + (M + half) + '" y="' + (M - 9) + '" text-anchor="middle" ' + f + '>&#8593; More city control</text>';
    s += '<text x="' + (M + half) + '" y="' + (H - M + 20) + '" text-anchor="middle" ' + f + '>&#8595; More personal freedom</text>';
    s += '<text transform="translate(' + (M - 9) + ' ' + (M + half) + ') rotate(-90)" text-anchor="middle" ' + f + '>&#8592; Progressive</text>';
    s += '<text transform="translate(' + (M + S + 9) + ' ' + (M + half) + ') rotate(90)" text-anchor="middle" ' + f + '>Conservative &#8594;</text>';
  }
  if (o.strip) {
    const y0 = M + S + 12, seg = [[-10, -5, "strongly"], [-5, -1.5, "somewhat"], [-1.5, 1.5, "near the middle"], [1.5, 5, "somewhat"], [5, 10, "strongly"]];
    seg.forEach(g => { const x1 = X(g[0]) + 2, x2 = X(g[1]) - 2;
      s += '<path d="M' + x1 + ' ' + y0 + 'v5h' + (x2 - x1) + 'v-5" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-linejoin="round"/><text class="ringlab" x="' + ((x1 + x2) / 2) + '" y="' + (y0 + 20) + '" text-anchor="middle">' + g[2] + '</text>'; });
    const xl = M - 12;
    seg.forEach(g => { const y1 = Y(g[1]) + 2, y2 = Y(g[0]) - 2;
      s += '<path d="M' + xl + ' ' + y1 + 'h-5v' + (y2 - y1) + 'h5" fill="none" stroke="var(--line)" stroke-width="1.5" stroke-linejoin="round"/><text class="ringlab" transform="translate(' + (xl - 12) + ' ' + ((y1 + y2) / 2) + ') rotate(-90)" text-anchor="middle">' + g[2] + '</text>'; });
    s += '<text class="ringlab" x="' + (M + S / 2) + '" y="' + (y0 + 37) + '" text-anchor="middle">Same bands on both issues (bottom and side): how far a dot sits from the middle</text>';
  }
  return s + '</g></svg>';
}

/* ---------- hover tooltip, in words ---------- */
const tip = $("tip");
function tipHTML(p){
  const who = p.cand && p.mayor ? "Current mayor and 2027 candidate" : p.cand ? "2027 candidate" : "Mayor, " + p.years;
  let h = '<b class="nm">' + esc(p.name) + '</b><span class="sub2">' + esc(who) + '</span>';
  h += '<div class="tl"><em>Economy</em><span>' + sayP(p, "x", true) + '</span></div><div class="tl"><em>Control</em><span>' + sayP(p, "y", true) + '</span></div>';
  h += '<div class="tl"><em>Record</em><span>' + p.n + ' sourced facts, ' + p.proof + '</span></div>';
  if (p.proof === "thin") h += '<div class="warn">Thin record: treat this dot as a rough guess.</div>';
  else if (p.pulled) h += '<div class="warn">One issue has under 4 facts, so this dot is pulled toward the middle.</div>';
  return h + '<div class="go">Click for the sources</div>';
}
function tipMove(e){ const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 16, y = e.clientY + 16; if (x + w > innerWidth - 10) x = e.clientX - w - 16; if (y + h > innerHeight - 10) y = e.clientY - h - 16; tip.style.left = x + "px"; tip.style.top = y + "px"; }
document.addEventListener("mouseover", e => { const g = e.target.closest && e.target.closest(".pt"); if (g && BY[g.dataset.id]) { tip.innerHTML = tipHTML(BY[g.dataset.id]); tip.classList.add("on"); tipMove(e); } });
document.addEventListener("mousemove", e => { if (tip.classList.contains("on")) tipMove(e); });
document.addEventListener("mouseout", e => { const g = e.target.closest && e.target.closest(".pt"); if (g) tip.classList.remove("on"); });
/* hover or keyboard focus on a dot: it grows with a soft ring, its name goes bold, the other dots fade */
function hotDot(g, on){
  const svg = g.ownerSVGElement; if (!svg) return;
  g.classList.toggle("hot", on); svg.classList.toggle("hov", on);
  svg.querySelectorAll('.lab[data-for="' + g.dataset.id + '"]').forEach(t => t.classList.toggle("hot", on));
}
document.addEventListener("mouseover", e => { const g = e.target.closest && e.target.closest("#mc .pt"); if (g && !g.classList.contains("hot")) hotDot(g, true); });
document.addEventListener("mouseout", e => { const g = e.target.closest && e.target.closest("#mc .pt"); if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) hotDot(g, false); });
document.addEventListener("focusin", e => { const g = e.target.closest && e.target.closest("#mc .pt"); if (g) hotDot(g, true); });
document.addEventListener("focusout", e => { const g = e.target.closest && e.target.closest("#mc .pt"); if (g) hotDot(g, false); });
document.addEventListener("click", e => { if (e.target.closest("a[href], .cmp")) return; const c = e.target.closest("#mc [data-id]"); if (c) { tip.classList.remove("on"); openPerson(c.dataset.id); } });
document.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("#mc .pt[data-id], #mc .crow[data-id], #mc .mrow[data-id]")) { e.preventDefault(); openPerson(e.target.dataset.id); } if (e.key === "Escape" && !$("card-ov").hidden) closeCard(); else if (e.key === "Escape" && !$("cmp-ov").hidden) closeCmp(); else if (e.key === "Escape" && !$("drawer").hidden) closePerson(); });

/* ---------- maps: result map (You + match) after finishing, plain field map before ---------- */
const clean = t => t.replace(/\.$/, "");
const tbHTML = you => '<div class="legend">' + (you ? '<span><i class="y"></i>You</span>' : '') + '<span><i class="c"></i>Candidate</span>' + (you ? '<span><i class="r">1</i>Your top 3</span>' : '') + '<span><i class="m"></i>Mayor since 1955</span><span><span class="ring"></span>Thin record</span></div>';
$("fieldtb").innerHTML = tbHTML(false);
function drawMaps(){
  const mm = finished && window._me && window._me.n >= 4;
  $("herotb").innerHTML = tbHTML(mm);
  const mn = $("mapnote"); if (mn) { mn.innerHTML = mm ? (window._note || "") : ""; mn.hidden = !(mm && window._note); }
  $("hero-chart").innerHTML = '<div class="plot">' + chart({S: 448, M: 34, sideLabels: true, cap: 11.5, pre, you: mm ? window._me : null, match: mm ? window._top : null, top3: mm ? window._top3 : null}) + '</div>';
  $("field-chart").innerHTML = "";
  if (mm && animYou) { // the You dot drops into place once, right after the reveal (about 600ms); reduced motion places it at once
    animYou = false;
    const g = document.querySelector("#hero-chart .youg");
    if (g && !reduced() && g.animate) { // bouncy drop: falls, bounces twice, settles (700ms, transform and opacity only)
      g.animate([{transform: "translateY(-150px)", opacity: 0, offset: 0}, {transform: "translateY(0)", opacity: 1, offset: .5, easing: "ease-out"}, {transform: "translateY(-22px)", opacity: 1, offset: .68, easing: "ease-in"}, {transform: "translateY(0)", opacity: 1, offset: .82, easing: "ease-out"}, {transform: "translateY(-6px)", opacity: 1, offset: .92, easing: "ease-in"}, {transform: "translateY(0)", opacity: 1, offset: 1}], {duration: 700, easing: "ease-in"});
    }
  }
  document.querySelectorAll(".legPre").forEach(e => e.hidden = !pre);
  document.querySelectorAll(".preOn").forEach(b => b.setAttribute("aria-pressed", pre)); document.querySelectorAll(".preOff").forEach(b => b.setAttribute("aria-pressed", !pre));
  const n = PEOPLE.filter(p => (p.x == null || p.y == null) && (p.cand || pre || p.year >= 1955));
  const c = n.filter(p => p.cand).map(p => esc(p.name)), m = n.filter(p => !p.cand).map(p => esc(p.name));
  $("norec").innerHTML = '<h4>Not enough public record yet</h4><p><b>2027 candidates:</b> ' + c.join(", ") + "." + (m.length ? ' <b>Past mayors:</b> ' + m.join(", ") + "." : "") + " These people have no sourced position on at least one issue, so we do not place a dot.</p>";
}
function setPre(v){
  pre = v;
  drawMaps();
}
document.addEventListener("click", e => { if (e.target.closest(".preOn")) setPre(true); else if (e.target.closest(".preOff")) setPre(false); });

/* ---------- quiz (always on screen) ---------- */
// "answered" for progress = a scored answer (including Neutral = 0) or a Not sure. Scoring and matching only look at answers.
const answered = () => Object.keys(answers).filter(k => answers[k] != null).length + Object.keys(unsure).length;
const progressN = () => Object.keys(answers).length + Object.keys(unsure).length;
const isAnswered = q => (q in answers) || !!unsure[q];
function bump(before){ /* progress fills quietly: no banners, no pop */ }
let riseNext = false;
const REDUCED = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// Card slides off toward the answer: left for disagree, right for agree, up for neutral, down for Not sure and Skip. Motion only, no feedback on the answer.
// Short travel, a small tilt and a fade, so the eye follows one card out and one card in.
let swapDir = null;
function flyOut(v){ riseNext = true; swapDir = v; }
// Like sorting flashcards: the answered card tips toward your answer (disagree left, agree right,
// neutral up, Not sure and Skip down) and fades, while the next card sits still underneath. The old card is copied in place with the same box, so nothing re-wraps.
// Back brings the earlier card gliding in from the left. A fast key press starts the next glide.
// Same glide with Reduce motion on: Connor has it on and asked for this motion.
function snapOld(qe){
  if (!qe.querySelector(".qbody")) return null;
  const c = qe.cloneNode(true);
  c.removeAttribute("id"); c.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
  if (typeof swapDir === "number") c.querySelectorAll(".ans").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.v === swapDir)));
  return {node: c, top: qe.offsetTop, left: qe.offsetLeft, width: qe.offsetWidth, height: qe.offsetHeight};
}
function easeSwap(qe, old, back){
  const host = qe.parentElement;
  host.querySelectorAll(".qflip").forEach(n => n.remove());
  if (back) {
    try { qe.animate([{transform: "translateX(-220px)", opacity: 0}, {transform: "none", opacity: 1}], {duration: 380, easing: "cubic-bezier(.2,.7,.2,1)"}); } catch (e) { /* no motion */ }
    return;
  }
  if (!qe.querySelector(".qbody") || !old) { // the top 3 and picks steps: a plain fade in
    Array.from(qe.children).forEach(el => { try { el.animate([{opacity: 0}, {opacity: 1}], {duration: 180, easing: "ease-out"}); } catch (e) { /* no motion */ } });
    return;
  }
  const g = old.node; g.classList.add("qflip"); g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, {top: old.top + "px", left: old.left + "px", width: old.width + "px", height: old.height + "px"});
  host.appendChild(g);
  // Connor: the top moves first and the card tilts, then it disappears; no straight throw across
  // the map. The card pivots on its bottom edge, so the top swings toward the answer while the
  // bottom barely moves, then it fades out where it is. Neutral lifts, Not sure and Skip drop.
  const side = {"-2": -1, "-1": -1, "1": 1, "2": 1}[String(swapDir)] || 0;
  const lift = String(swapDir) === "0" ? -1 : 1;
  const kf = side ? [
      {transform: "none", opacity: 1},
      {transform: `rotate(${side * 7}deg)`, opacity: 1, offset: .4},
      {transform: `translateX(${side * 40}px) rotate(${side * 16}deg)`, opacity: 0}]
    : [{transform: "none", opacity: 1},
      {transform: `translateY(${lift * 10}px) rotate(${lift * -1.5}deg)`, opacity: 1, offset: .4},
      {transform: `translateY(${lift * 36}px) rotate(${lift * -3}deg)`, opacity: 0}];
  g.style.transformOrigin = side ? (side > 0 ? "100% 100%" : "0% 100%") : "50% 100%";
  try {
    g.animate(kf, {duration: 340, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards"}).onfinish = () => g.remove();
  } catch (e) { g.remove(); }
  setTimeout(() => g.remove(), 420);
}
function setAns(v){ const qid = ORDER[qi], b = progressN(); noteAnswer(qid, WORDS[v]); flyOut(v); answers[qid] = v; delete unsure[qid]; store.set("mc-answers", answers); store.set("mc-unsure", unsure); bump(b); advance(); }
function setUnsure(){ const qid = ORDER[qi], b = progressN(); noteAnswer(qid, "not_sure"); flyOut("down"); delete answers[qid]; unsure[qid] = true; store.set("mc-answers", answers); store.set("mc-unsure", unsure); bump(b); advance(); }
function meterHTML(cur, live){
  let h = '<div class="mtr' + (live ? "" : " wave") + '" role="group" aria-label="Statements. Pick one to go to it."><div class="mgrp">';
  for (let i = 0; i < ORDER.length; i++) {
    const qid = ORDER[i], st = unsure[qid] || answers[qid] != null ? "on" : answers[qid] === null ? "sk" : "";
    const word = st === "on" ? "answered" : st === "sk" ? "skipped" : "not answered";
    h += '<button type="button" class="mseg' + (i === cur ? " cur" : "") + '" data-k="' + i + '" style="--i:' + i + '"'
      + (i === cur ? ' aria-current="step"' : "") + (live ? "" : ' disabled tabindex="-1"')
      + ' aria-label="Statement ' + (i + 1) + ', ' + word + '" title="' + (i + 1) + '. ' + esc(Q[qid].text) + '"><span class="sbar"><b class="' + st + '"></b></span></button>';
  }
  return h + '</div></div>';
}
/* The top of the quiz card: Back, where you are, how many are left, and the statement bar. The same
   parts fill the strip that pins under the site header when the card scrolls out of view. */
function headParts(){
  const back = '<button type="button" class="linkbtn qbk" data-back' + (stage === "q" && qi === 0 ? " disabled" : "") + '>\u2190 Back</button>';
  const left = stage === "top" ? "Two quick steps" : stage === "prof" ? "Last step, all optional" : `Statement ${qi+1} of ${ORDER.length}`;
  const right = stage === "q" ? `${answered()} answered, ${ORDER.length - progressN()} to go` : `${answered()} answered`;
  return {back, left, right, meter: meterHTML(stage === "q" ? qi : -1, true)};
}
function headHTML(){
  const h = headParts(), any = progressN() > 0 || Object.keys(stars).some(k => stars[k]);
  return `<div class="qprog tnum"><span class="qwhere">${h.back}<span>${h.left}</span></span><span class="qright"><span>${h.right}</span>${any ? '<span class="resetwrap">' + RESET_BTN + '</span>' : ""}</span></div>${h.meter}`;
}
/* Start over: one click asks "Clear all answers?" in place; Yes wipes answers, stars, issues and picks. */
const RESET_BTN = '<button type="button" class="linkbtn rsbtn" data-reset>Start over</button>';
document.addEventListener("click", e => {
  const t = e.target.closest && e.target.closest("[data-reset], [data-reset-yes], [data-reset-no]"); if (!t || !t.closest("#mc")) return;
  const w = t.closest(".resetwrap"); if (!w) return;
  if (t.hasAttribute("data-reset")) { w.innerHTML = '<span class="rsq">Clear all answers?</span><button type="button" class="linkbtn rsyes" data-reset-yes>Yes</button><button type="button" class="linkbtn" data-reset-no>Cancel</button>'; w.querySelector("[data-reset-yes]").focus(); }
  else if (t.hasAttribute("data-reset-no")) { w.innerHTML = RESET_BTN; w.querySelector("[data-reset]").focus(); }
  else resetAll();
});
function resetAll(){
  track("mayor_quiz_reset", {answered: answered(), finished});
  cdTimers.forEach(clearTimeout); cdTimers = [];
  answers = {}; unsure = {}; stars = {}; top3 = []; profile = {}; pickTop = []; draft = {};
  ["mc-answers", "mc-unsure", "mc-stars", "mc-profile"].forEach(k => store.set(k, {})); store.set("mc-top3", []); store.set("mc-done", false);
  started = false; earlyFinish = false; stepsDone = false; finished = false; stage = "q"; qi = 0; showField = false; animYou = false; bdAll = false; bdOpen = false;
  render(); window.scrollTo(0, 0);
}
function goBack(){
  if (finished || stage === "count") return;
  if (stage === "q") { if (qi > 0) { qi--; riseNext = "back"; render(true); } }
  else if (stage === "top") $("tback").click();
  else if (stage === "prof") $("pback").click();
}
function jumpTo(k){
  if (finished || stage === "count" || (stage === "q" && k === qi)) return;
  if (stage === "prof" && $("pw")) draft = {ward: $("pw").value, age: draft.age || "", lean: $("pl").value};
  const fromQ = stage === "q";
  if (fromQ && k > qi) flyOut("down"); else riseNext = "back";
  stage = "q"; qi = k; render(fromQ);
}
function wireHead(root, fromPin){
  const toCard = () => { if (fromPin) window.scrollTo({top: Math.max(0, $("app").getBoundingClientRect().top + window.scrollY - pinTop()), behavior: "smooth"}); };
  root.querySelectorAll("[data-back]").forEach(b => b.onclick = () => { goBack(); toCard(); });
  root.querySelectorAll(".mseg[data-k]").forEach(b => b.onclick = () => { jumpTo(+b.dataset.k); toCard(); });
}
/* pinned strip: shows while the card's own bar is above the bottom of the site header */
let pinOn = false;
function pinTop(){ const hd = document.querySelector("header.gn") || document.querySelector(".site-header"); return hd ? Math.max(0, hd.getBoundingClientRect().bottom) : 0; }
function fillPin(){
  const inn = $("qpin-in"); if (!inn) return;
  if (finished || !(stage === "q" || stage === "top" || stage === "prof")) { inn.innerHTML = ""; return; }
  const h = headParts();
  inn.innerHTML = `<span class="qwhere tnum">${h.back}<span>${h.left}</span></span>${h.meter}<span class="tnum pinright">${h.right}</span>`;
  wireHead(inn, true);
}
function updatePin(){
  const pin = $("qpin"); if (!pin) return;
  const m = $("quiz").querySelector(".mtr"), top = pinTop();
  const show = !finished && !!$("qpin-in").firstChild && !!m && m.getBoundingClientRect().bottom < top + 4;
  pin.style.top = top + "px";
  if (show !== pinOn) { pinOn = show; pin.classList.toggle("on", show); }
}
window.addEventListener("scroll", updatePin, {passive: true});
function renderQ(still){
  if (qi >= ORDER.length) qi = ORDER.length - 1;
  const qid = ORDER[qi], q = Q[qid], a = answers[qid];
  $("quiz").innerHTML = `${headHTML()}
    <div class="qbody">
    <p class="qtext" id="qtext">${esc(q.text)}</p>
    <p class="qctx">${q.context ? esc(q.context) : ""}</p>
    <div class="answers five" role="group" aria-labelledby="qtext">${[-2,-1,0,1,2].map(v => `<button type="button" class="ans" data-v="${v}" aria-pressed="${a === v}">${LABELS[v]}</button>`).join("")}</div>
    <div class="unsurerow"><button type="button" class="unsurebtn" id="qunsure" aria-pressed="${!!unsure[qid]}">Not sure</button></div>
    </div>
    <p class="keyhint">Press 1 to 5, 6 for Not sure, or use the arrow keys. Backspace goes back.</p>
    <div class="qfoot">
      <button type="button" class="star" id="star" aria-pressed="${!!stars[qid]}">${stars[qid] ? "★ Matters to me" : "☆ Matters to me"}</button>
      <div class="actions" style="gap:16px">
        <button type="button" class="linkbtn" id="qback" ${qi === 0 ? "disabled" : ""}>Back</button>
        <button type="button" class="linkbtn" id="qskip">${a === null ? "Skipped" : "Skip"}</button>
        <button type="button" class="btn" id="qnext">${qi === ORDER.length - 1 ? "Finish" : "Next"}</button>
      </div>
    </div>
    ${answered() >= 10 ? '<div class="finnow"><button type="button" class="linkbtn" id="qfin">Finish now</button><span class="small">Your result is less reliable with fewer answers.</span></div>' : ""}`;
  if ($("qfin")) $("qfin").onclick = () => { earlyFinish = true; finish(); };
  $("quiz").querySelectorAll(".ans").forEach(b => b.onclick = () => setAns(+b.dataset.v));
  $("qunsure").onclick = setUnsure;
  $("star").onclick = () => { stars[qid] = !stars[qid]; store.set("mc-stars", stars); renderQ(true); };
  $("qback").onclick = goBack;
  wireHead($("quiz"), false);
  $("qskip").onclick = () => { noteAnswer(qid, "skipped"); flyOut("down"); const b = progressN(); answers[qid] = null; delete unsure[qid]; store.set("mc-answers", answers); store.set("mc-unsure", unsure); bump(b); advance(); };
  $("qnext").onclick = () => { flyOut(a == null ? "down" : a); advance(); };
}
/* two short steps after the last statement, before the reveal */
function renderTop(){
  $("quiz").innerHTML = `${headHTML()}
    <p class="stepq" id="qtext">Which issues matter most to you? Pick up to 3.</p>
    <div class="chips" role="group" aria-labelledby="qtext">${TOPICS.map(tp => `<button type="button" class="tchip" aria-pressed="${pickTop.includes(tp)}" ${!pickTop.includes(tp) && pickTop.length >= 3 ? "disabled" : ""}>${esc(tp)}</button>`).join("")}</div>
    <div class="qfoot"><span class="small tnum">${pickTop.length} of 3 picked</span>
      <div class="actions" style="gap:16px"><button type="button" class="linkbtn" id="tback">Back</button><button type="button" class="linkbtn" id="tskip">Skip</button><button type="button" class="btn" id="tgo">Continue</button></div></div>`;
  $("quiz").querySelectorAll(".tchip").forEach((b, i) => b.onclick = () => {
    const tp = TOPICS[i]; if (pickTop.includes(tp)) pickTop = pickTop.filter(x => x !== tp); else if (pickTop.length < 3) pickTop.push(tp);
    renderTop(); $("quiz").querySelectorAll(".tchip")[i].focus();
  });
  $("tback").onclick = () => { riseNext = "back"; stage = "q"; qi = ORDER.length - 1; render(); };
  wireHead($("quiz"), false);
  $("tskip").onclick = () => { flyOut("down"); top3 = []; store.set("mc-top3", top3); track("mayor_quiz_issues", {issues: []}); stage = "prof"; render(); };
  $("tgo").onclick = () => { flyOut(1); top3 = pickTop.slice(); store.set("mc-top3", top3); track("mayor_quiz_issues", {issues: top3.slice()}); stage = "prof"; render(); };
}
function renderProf(){
  const cands = PEOPLE.filter(p => p.cand).map(p => p.name).sort((x, y) => x.localeCompare(y));
  const sel = (v, cur) => cur === v ? " selected" : "";
  $("quiz").innerHTML = `${headHTML()}
    <p class="stepq" id="qtext">Help show how Chicago answered</p>
    <p class="stepsub">Three quick picks. No name or email.</p>
    <div class="pform">
      <div class="prow">
        <label class="f">Your ward<select id="pw"><option value="">Choose</option>${Array.from({length: 50}, (_, i) => `<option value="${i + 1}"${sel(String(i + 1), draft.ward)}>${i + 1}</option>`).join("")}<option value="Not sure"${sel("Not sure", draft.ward)}>Not sure</option></select></label>
        <label class="f">Leaning toward<select id="pl"><option value="">Choose</option>${cands.map(n => `<option value="${esc(n)}"${sel(n, draft.lean)}>${esc(n)}</option>`).join("")}<option value="Undecided"${sel("Undecided", draft.lean)}>Undecided</option><option value="Prefer not to say"${sel("Prefer not to say", draft.lean)}>Prefer not to say</option></select></label>
      </div>
      <div class="f"><span id="pa-l">Age</span><div class="agechips" role="group" aria-labelledby="pa-l">${AGES.map(x => `<button type="button" class="tchip" data-age="${x}" aria-pressed="${draft.age === x}">${x}</button>`).join("")}</div></div>
    </div>
    <div class="qfoot"><span></span>
      <div class="actions" style="gap:16px"><button type="button" class="linkbtn" id="pback">Back</button><button type="button" class="linkbtn" id="pskip">Skip</button><button type="button" class="btn" id="pgo">See my result</button></div></div>`;
  const grab = () => { draft = {ward: $("pw").value, age: draft.age || "", lean: $("pl").value}; };
  ["pw", "pl"].forEach(id => $(id).onchange = grab);
  $("quiz").querySelectorAll("[data-age]").forEach(btn => btn.onclick = () => { grab(); draft.age = draft.age === btn.dataset.age ? "" : btn.dataset.age; $("quiz").querySelectorAll("[data-age]").forEach(x => x.setAttribute("aria-pressed", x.dataset.age === draft.age)); });
  $("pback").onclick = () => { riseNext = "back"; grab(); stage = "top"; render(); };
  wireHead($("quiz"), false);
  $("pskip").onclick = () => { flyOut("down"); profile = {}; store.set("mc-profile", profile); track("mayor_quiz_profile", {skipped: true}); reveal(); };
  $("pgo").onclick = () => { flyOut(1); grab(); profile = draft; store.set("mc-profile", profile); track("mayor_quiz_profile", profileProps(profile, false)); reveal(); };
}
function advance(){ if (qi >= ORDER.length - 1) { earlyFinish = false; finish(); return; } qi++; render(true); }
function finish(){
  if (!stepsDone) { riseNext = true; stage = "top"; pickTop = top3.slice(); draft = Object.assign({}, profile); showField = false; render(); window.scrollTo(0, 0); return; }
  reveal();
}
function doReveal(){ cdTimers.forEach(clearTimeout); cdTimers = []; stepsDone = true; stage = "q"; finished = true; showField = false; bdAll = false; bdOpen = false; animYou = true; animPod = true; store.set("mc-done", true); trackFinished(); render(); window.scrollTo(0, 0); }
/* drumroll: 3, 2, 1 (about 1.35 s), then the result. Click or any key skips it. No result shows until it ends. */
function reveal(){
  stepsDone = true;
  if (reduced()) { doReveal(); return; }
  stage = "count"; cdLeft = 3; render(); window.scrollTo(0, 0);
  cdTimers = [setTimeout(() => tick(2), 450), setTimeout(() => tick(1), 900), setTimeout(doReveal, 1350)];
}
function tick(n){ const e = $("cdnum"); if (e) e.innerHTML = "<span>" + n + "</span>"; }
function renderCount(){
  $("quiz").innerHTML = `<div class="cdwn" id="cdwn" role="status"><div class="qprog tnum"><span>All ${ORDER.length} statements in</span><span>${answered()} answered</span></div>
    ${meterHTML(-1, false)}
    <div class="cdstage"><p class="cdlab">Tallying your answers</p><div class="cdnum" id="cdnum"><span>3</span></div><p class="small">Click or press any key to skip</p></div></div>`;
  $("cdwn").onclick = doReveal;
}
function reopen(){ track("mayor_quiz_restart", {}); started = false; earlyFinish = false; cdTimers.forEach(clearTimeout); cdTimers = []; finished = false; stage = "q"; showField = false; animYou = false; store.set("mc-done", false); qi = 0; render(); window.scrollTo(0, 0); }
let bodyH = 0, bodyW = 0;
function lockBody(qe){
  const b = qe.querySelector(".qbody"); if (!b) return;
  if (b.offsetWidth !== bodyW) {
    bodyW = b.offsetWidth; bodyH = 0;
    const m = b.cloneNode(true); m.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
    Object.assign(m.style, {position: "absolute", visibility: "hidden", left: "0", top: "0", width: bodyW + "px", minHeight: "0"});
    qe.appendChild(m);
    const qt = m.querySelector(".qtext"), qc = m.querySelector(".qctx");
    ORDER.forEach(id => { qt.textContent = Q[id].text; qc.textContent = Q[id].context || ""; bodyH = Math.max(bodyH, m.offsetHeight); });
    m.remove();
  }
  b.style.minHeight = bodyH + "px";
}
window.addEventListener("resize", () => { bodyW = 0; const qe = $("quiz"); if (qe && stage === "q" && !finished) lockBody(qe); });
function render(cardOnly){
  // Map and table always show. Your dot, matches and the match sort wait until you finish.
  const fold = false;
  $("quiz").hidden = finished; $("app").classList.toggle("isdone", finished);
  $("fieldfold").hidden = true; $("fieldbody").hidden = false;
  $("fieldmap").hidden = true;
  $("candMore").textContent = candsAll ? "Show fewer" : "Show all " + PEOPLE.filter(p => p.cand).length + " candidates";
  const old = riseNext && !finished && stage === "q" ? snapOld($("quiz")) : null;
  if (finished) $("quiz").innerHTML = ""; else if (stage === "count") renderCount(); else if (stage === "top") renderTop(); else if (stage === "prof") renderProf(); else renderQ();
  const qe = $("quiz");
  if (riseNext && !finished) easeSwap(qe, stage === "q" ? old : null, riseNext === "back");
  if (stage === "q" && !finished) lockBody(qe);
  riseNext = false;
  fillPin(); updatePin();
  updateLive();
  // Before the reveal, an answer changes nothing in the table or the maps; rebuilding them on
  // every answer is what made the card stutter.
  if (cardOnly) return;
  if (!fold) { renderCands(); renderMayors(); }
  drawMaps();
}
/* keys: 1 to 5 pick an answer, 6 is Not sure */
document.addEventListener("keydown", e => {
  if (stage === "count" && !finished) { if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== "Shift" && e.key !== "Tab") { e.preventDefault(); doReveal(); } return; }
  if (finished || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches && e.target.matches("input,textarea,select")) return;
  if (e.target.closest && e.target.closest("header, nav, footer")) return; // keys 1 to 6 belong to the quiz, not to the site menu
  if (!$("cmp-ov").hidden || !$("card-ov").hidden || !$("drawer").hidden) return;
  if (e.key === "Backspace") { if (stage === "q" || stage === "top" || stage === "prof") { e.preventDefault(); goBack(); } return; }
  if (stage !== "q") return;
  const map = {"1": -2, "2": -1, "3": 0, "4": 1, "5": 2};
  const ar = {ArrowLeft: e.shiftKey ? -2 : -1, ArrowRight: e.shiftKey ? 2 : 1, ArrowUp: 0};
  if (e.key in map) { e.preventDefault(); setAns(map[e.key]); } else if (e.key in ar) { e.preventDefault(); setAns(ar[e.key]); } else if (e.key === "ArrowDown") { e.preventDefault(); setUnsure(); } else if (e.key === "6") { e.preventDefault(); setUnsure(); }
});

/* ---------- scoring ---------- */
function you(){
  const ax = {econ: [], control: []};
  // A starred statement ("Matters to me") counts twice in where your dot lands.
  for (const [qid, v] of Object.entries(answers)) if (v != null && Q[qid]) { const s = v * Q[qid].agree_direction * 5; ax[Q[qid].axis].push(s); if (stars[qid]) ax[Q[qid].axis].push(s); }
  const m = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  return {x: m(ax.econ), y: m(ax.control), n: ax.econ.length + ax.control.length};
}
// The match is a count (Connor, Nov 11: "this should be count"). Statement by statement, how close is
// your answer to theirs: the same answer is a full point, each step apart on the five-step scale
// loses a quarter, opposite ends score zero. A starred statement counts twice, as it does in where
// your dot lands. A person needs MIN_ANS sourced answers to be ranked (Connor: 8 or more) and you
// need MIN_SHARED statements in common. d (map distance) is kept only to explain a nearer dot.
const MIN_ANS = 8, MIN_SHARED = 5;
const STEP = [1, .75, .5, .25, 0]; // points for answers 0, 1, 2, 3 or 4 steps apart
const nAns = p => p.answers.filter(a => Q[a.qid]).length;
function match(p, me){
  let w = 0, sum = 0, n = 0, same = 0, sides = 0;
  for (const a of p.answers) { const u = answers[a.qid]; if (u == null || !Q[a.qid]) continue;
    const k = stars[a.qid] ? 2 : 1; n++; w += k; sum += k * STEP[Math.abs(u - a.value)];
    if (u !== 0 && a.value !== 0) { sides++; if (Math.sign(u) === Math.sign(a.value)) same++; } }
  me = me || you();
  const few = nAns(p) < MIN_ANS, ok = !few && n >= MIN_SHARED;
  return {pct: ok ? Math.round(100 * sum / w) : null, raw: ok ? sum / w : null, n, same, sides, few,
    d: p.x == null || p.y == null ? null : Math.hypot(p.x - me.x, p.y - me.y)};
}
// best first: closeness, then more shared statements, then the nearer dot
function rankOf(list){
  const me = you(), far = c => c.m.d == null ? 99 : c.m.d;
  return list.map(p => ({p, m: match(p, me)})).filter(c => c.m.pct != null).sort((a, b) => (b.m.raw - a.m.raw) || (b.m.n - a.m.n) || (far(a) - far(b)));
}
// One line for the map when the nearest candidate dot is not the best match (Connor: people will
// question a result when another dot sits closer).
function nearNote(me, top){
  if (!top) return "";
  const dots = PEOPLE.filter(p => p.cand && p.x != null && p.y != null).map(p => ({p, m: match(p, me)})).sort((a, b) => a.m.d - b.m.d);
  const near = dots[0]; if (!near || near.p.id === top.p.id) return "";
  if (top.m.d != null && top.m.d - near.m.d < 0.3) return "";
  if (near.m.pct == null) return esc(near.p.name) + "'s dot sits nearer to yours, but " + (near.m.few ? esc(near.p.short) + " has " + nAns(near.p) + " sourced answers, too few to rank." : "you two share too few answered statements to rank.");
  if (near.m.pct >= top.m.pct) return "";
  return esc(near.p.name) + "'s dot sits nearer to yours, but your answers are closer to " + esc(top.p.name) + "'s, statement by statement (" + top.m.pct + "% to " + near.m.pct + "%). A dot is an average, so it can hide single statements where you differ.";
}
function updateLive(){
  if (!finished) { window._me = null; window._top = null; window._top3 = []; window._note = ""; window._mayor = null; $("live").innerHTML = ""; if ($("copyres")) $("copyres").hidden = true; return; }
  const me = you(), ranked = rankOf(PEOPLE.filter(p => p.cand));
  const top = ranked[0] || null;
  window._me = me; window._top = top ? {p: top.p, pct: top.m.pct} : null; window._top3 = ranked.slice(0, 3).map(c => ({p: c.p, pct: c.m.pct})); window._note = nearNote(me, top);
  if ($("copyres")) $("copyres").hidden = me.n < 4;
  if (me.n < 4) {
    const need = 4 - me.n;
    $("live").innerHTML = '<div class="reslabel">Your result</div><p class="hint">You answered too few statements to place you. Answer ' + need + ' more and your match appears here, with your dot on the chart.</p>' + REDO;
    $("qredo").onclick = reopen;
    return;
  }
  const sent = (ax, lab) => "On " + lab + ', you land <em class="' + (ax === "y" ? "t" : "") + '">' + (level(me[ax]) === 0 ? "near the middle" : say(ax, me[ax]).toLowerCase()) + "</em>.";
  const ms = rankOf(PEOPLE.filter(p => !p.cand))[0]; // past mayors use the same count and the same 8-answer bar
  window._mayor = ms ? ms.p : null;
  const done = true;
  let h = '<div class="reslabel">' + (done ? "Your best match" : "Best match so far") + ' <span style="text-transform:none;letter-spacing:0;font-weight:400">(based on ' + me.n + ' of ' + ORDER.length + ' statements)</span></div>';
  if (top3.length) h += '<p class="topline"><b>Your top issues:</b> ' + top3.map(esc).join(", ") + '</p>';
  if (top) {
    const pods = ranked.slice(0, 3), go = animPod; animPod = false;
    const burst = go && !reduced() ? '<div class="burst" aria-hidden="true">' + Array.from({length: 18}, (_, i) => { const a = (i / 18) * Math.PI * 2 + .2, d = 70 + (i % 3) * 30; return '<i style="--dx:' + Math.round(Math.cos(a) * d * 1.3) + 'px;--dy:' + Math.round(Math.sin(a) * d - 20) + 'px;--r:' + (i * 47 % 360) + 'deg;--c:' + ["var(--blue)", "var(--good)", "var(--weak)", "var(--ink-3)"][i % 4] + '"></i>'; }).join("") + '</div>' : "";
    h += '<div class="podium' + (go ? " go" : "") + '" role="group" aria-label="Your top ' + pods.length + ' matches" style="grid-template-columns:repeat(' + pods.length + ',minmax(0,1fr))">' + pods.map((c, i) => '<button type="button" class="pod p' + (i + 1) + '" data-id="' + c.p.id + '" style="--d:' + [360, 180, 0][i] + 'ms"><span class="lift"><span class="pdn">' + esc(c.p.name) + '</span><span class="pdp tnum">' + c.m.pct + '%</span><small class="lead2">' + ["Best match", "2nd", "3rd"][i] + '</small><small class="pds tnum">Same side on ' + c.m.same + ' of ' + c.m.sides + '</small></span><span class="blk">' + (i + 1) + '</span></button>').join("") + burst + '</div>';
    h += '<p class="bmsm">Match counts how close your answers are to theirs, statement by statement. The same answer is a full point, each step apart is less, and opposite ends is zero. Starred statements count double. A candidate needs ' + MIN_ANS + ' or more sourced answers to be ranked.</p>';

    // The statement list sits behind "See why" (Connor, Nov 11: the open list was too much under the result).
    h += '<div class="why"><button type="button" class="linkbtn" id="bdwhy" aria-expanded="' + bdOpen + '">' + (bdOpen ? "Hide the statements" : "See why you match " + esc(top.p.name)) + '</button></div>' + (bdOpen ? breakdownHTML(top.p) : "");
    const lean = profile && profile.lean;
    if (lean && lean !== "Undecided" && lean !== "Prefer not to say" && lean !== top.p.name) h += '<p class="leanline">You said you lean toward ' + esc(lean) + '. Your answers line up most with ' + esc(top.p.name) + '.</p>';
  } else h += '<p class="hint">No candidate has enough public positions to name a match yet.</p>';
  h += '<p class="resline">' + sent("x", "the economy") + " " + sent("y", "city control") + (ms ? ' <span style="font-weight:400;color:var(--ink-2)">Closest past mayor: ' + esc(ms.p.name) + '.</span>' : "") + '</p>';
  $("live").innerHTML = h + REDO.replace('<div class="actions">', '<div class="actions"><button type="button" class="btn" id="qcopy">Copy my results</button><button type="button" class="btn btn-ghost" id="qcard">See my share card</button>');
  $("qredo").onclick = reopen; $("qcard").onclick = openCard; $("qcopy").onclick = () => copyCard($("qcopy"), "result");
  const bm = $("bdmore"); if (bm) bm.onclick = () => { bdAll = !bdAll; updateLive(); };
  const bw = $("bdwhy"); if (bw) bw.onclick = () => { bdOpen = !bdOpen; if (bdOpen) track("mayor_quiz_why_opened", {match: top.p.id}); updateLive(); const b2 = $("bdwhy"); if (b2) b2.focus({preventScroll: true}); };
}
/* "You and <best match>": same sign = agree, opposite sign = differ, a Neutral on either side = counted apart */
function breakdownHTML(p){
  const mp = {}; p.answers.forEach(a => mp[a.qid] = a);
  const rows = [];
  ORDER.forEach(qid => { const u = answers[qid], a = mp[qid]; if (u == null || !a) return;
    rows.push({qid, u, a, kind: (u === 0 || a.value === 0) ? "neutral" : (Math.sign(u) === Math.sign(a.value) ? "agree" : "differ")}); });
  const n = k => rows.filter(r => r.kind === k).length, pl = c => c + (c === 1 ? " statement" : " statements");
  let h = '<div class="bd"><div class="reslabel" style="margin:0">You and ' + esc(p.name) + '</div>';
  if (!rows.length) return h + '<p class="bdsub">You and ' + esc(p.name) + ' have no statement you both answered.</p></div>';
  h += '<p class="bdsum">You agree on ' + pl(n("agree")) + ' and differ on ' + n("differ") + '.</p>';
  if (n("neutral")) h += '<p class="bdsub">On ' + pl(n("neutral")) + ', one side is neutral. Those are counted apart.</p>';
  const tag = {agree: ["good", "Agree"], differ: ["weak", "Differ"], neutral: ["", "One side neutral"]};
  h += '<div class="bdlist">' + (bdAll ? rows : rows.slice(0, 5)).map(r => '<div class="bdrow"><div class="bds">' + esc(Q[r.qid].text) + '</div><div class="bdc"><span class="chip blue">You: ' + LABELS[r.u] + '</span><span class="chip">' + esc(p.short) + ': ' + LABELS[r.a.value] + '</span><span class="chip ' + tag[r.kind][0] + '">' + tag[r.kind][1] + '</span><a href="' + esc(r.a.source_url) + '" target="_blank" rel="noopener">Source</a></div></div>').join("") + '</div>';
  if (rows.length > 5) h += '<div><button type="button" class="linkbtn" id="bdmore">' + (bdAll ? "Show fewer" : "Show all " + rows.length) + '</button></div>';
  return h + '</div>';
}
const REDO = '<div class="actions"><button type="button" class="btn btn-ghost" id="qredo">Change my answers</button><span class="resetwrap">' + RESET_BTN + '</span></div>';

/* ---------- candidates + mayors ---------- */
const money = v => v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? "$" + Math.round(v / 1e3) + "K" : "$" + Math.round(v);
const shortDate = d => { const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return m[+d.slice(5,7) - 1] + " " + (+d.slice(8,10)) + ", " + d.slice(0,4); };
function fundsCell(f){
  if (!f || f.none) return '<span class="fd-none">' + esc(f && f.none ? "No committee on file" : "No report found") + '</span>';
  // Two short lines: raised (plus loans), then cash and the filing link.
  return '<span class="fd-top"><b class="fd-big tnum">' + money(f.raised) + '</b>' + (f.loans ? '<span class="fd-sub tnum"> + ' + money(f.loans) + ' loans</span>' : "") + '</span>' +
    '<span class="fd-sub tnum">' + money(f.cash) + ' cash' + (f.through !== "2026-09-30" ? " (" + shortDate(f.through) + ")" : "") +
    ' · <a class="fd-src" href="' + esc(f.report_url) + '" target="_blank" rel="noopener">Filing</a></span>';
}
function lineCell(ax, v, thin, p){
  const mx = mixedText(p, ax), words = mx || say(ax, v, false);
  if (v == null) return '<span class="ln none" title="No public record yet"><svg viewBox="0 0 160 16" aria-hidden="true"><line x1="2" y1="8" x2="158" y2="8" class="ln-dash"/></svg><span class="sr">No public record yet</span></span>';
  const x = 80 + v * 7.6;
  return '<span class="ln" title="' + esc(words) + '"><svg viewBox="0 0 160 16" aria-hidden="true"><line x1="2" y1="8" x2="158" y2="8" class="ln-base"/><line x1="80" y1="3" x2="80" y2="13" class="ln-mid"/><circle cx="' + x.toFixed(1) + '" cy="8" r="5.5" class="ln-dot ' + (ax === "y" ? "safe" : "") + (thin ? " thin" : "") + (mx ? " mixed" : "") + '"/></svg><span class="sr">' + esc(words) + '</span></span>';
}
const lnHead = (k, a, b) => '<span class="lnh"><span>' + k + '</span><span class="lnh-ends"><i>' + a + '</i><i>' + b + '</i></span></span>';
function leanCell(ax, v){ return v == null ? '<span class="lean none">No public record yet</span>' : '<span class="lean">' + say(ax, v, true) + '</span>'; }
let candsAll = false, maysAll = false;
function fundsCompact(f){
  if (!f || f.none) return '<span class="fd-none">' + esc(f && f.none ? "No campaign committee on file" : "No report found") + '</span>';
  return fundsCell(f);
}
let cmp = [];
function renderCands(){
  const f = p => (p.funds && p.funds.raised) || -1;
  const live = finished && you().n >= 4;
  let cs = PEOPLE.filter(p => p.cand).map(p => ({p, m: match(p)}));
  cs.sort((a, b) => f(b.p) - f(a.p));
  // Ranked candidates first, best match on top; the rest (too few answers) follow by money raised.
  if (live) { const r = rankOf(PEOPLE.filter(p => p.cand)), ids = r.map(c => c.p.id); cs = r.concat(cs.filter(c => !ids.includes(c.p.id))); }
  const firm = live ? cs.find(c => c.m.pct != null) : null;
  const bestId = firm ? firm.p.id : null;
  $("cand-grid").innerHTML = '<div class="ctab' + (live ? " m" : "") + '" role="table" aria-label="2027 candidates"><div class="chead" role="row"><span></span><span role="columnheader">Candidate</span>' + (live ? '<span role="columnheader">Match</span>' : '') + '<span role="columnheader">' + lnHead("Economy", "Progressive", "Conservative") + '</span><span role="columnheader">' + lnHead("City control", "Freedom", "Control") + '</span><span role="columnheader">Raised for the mayor race</span><span></span></div>' +
    (candsAll ? cs : cs.slice(0, 12)).map(({p, m}) => `<div class="crow${p.id === bestId ? " best" : ""}" role="row" data-id="${p.id}" tabindex="0" aria-label="${esc(p.name)}: open positions and sources">
      <label class="cmp" title="Tick two to compare"><input type="checkbox" class="cmpbox" data-cid="${p.id}" aria-label="Compare ${esc(p.name)}" ${cmp.includes(p.id) ? "checked" : ""}></label>
      <span class="cname" role="cell"><span class="mn" title="${esc(p.background || p.role)}">${esc(p.name)}</span><span class="cmeta"><span class="cstat ${/no challenge/i.test(p.status||"") ? "good" : /did not|withdrew/i.test(p.status||"") ? "weak" : ""}">${esc(p.status || "Status unknown")}</span> · ${p.n} ${p.n === 1 ? "fact" : "facts"}${p.site ? ` · <a class="csite" href="${esc(p.site)}" target="_blank" rel="noopener">Site</a>` : ""}</span></span>
      ${live ? `<span class="mcell" role="cell">${m.pct != null ? `<span class="mtop"><b class="mpct tnum">${m.pct}%</b><span class="mbar"><i style="width:${m.pct}%"></i></span></span><span class="mon">${m.same} of ${m.sides} same side</span>` : `<span class="mnone">${m.few ? "Not enough answers yet" : "Too few shared answers"}</span>`}</span>` : ""}
      <span class="cell" role="cell">${lineCell("x", p.x, p.proof === "thin", p)}</span>
      <span class="cell" role="cell">${lineCell("y", p.y, p.proof === "thin", p)}</span>
      <span class="cfund" role="cell">${fundsCell(p.funds)}</span>
      <span aria-hidden="true"></span>
    </div>`).join("") + '</div>' +
    '<p class="small ctab-note"><b>How to read the lines:</b> the dot shows where each person sits, the tick is the middle, a hollow dot means a mixed record with clear views on both sides, a faded dot means a thin record, and a dashed line means no public record. Hover a line for the words.</p><p class="small ctab-note" style="margin-top:6px">Money comes from each candidate\'s campaign committee filings with the Illinois State Board of Elections, from July 2023 (after the last mayor race) through Sep 30, 2026. Raised counts gifts from people and groups, plus money moved in from other political committees. Loans are shown apart. Cash on hand is what the committee had at the end of the latest report. Click a row for positions and sources.</p>';
  document.querySelectorAll("#cand-grid .cmpbox").forEach(b => b.onchange = () => toggleCmp(b.dataset.cid));
  moveNotes(); renderCmpBar();
}
function toggleCmp(id){
  const i = cmp.indexOf(id); if (i >= 0) cmp.splice(i, 1); else { cmp.push(id); if (cmp.length > 2) cmp.shift(); }
  renderCands(); renderMayors();
  const el = document.querySelector('.cmpbox[data-cid="' + id + '"]'); if (el) el.focus();
}
function renderCmpBar(){
  const el = $("cmpbar"), live = finished && you().n >= 4;
  if (cmp.length === 2) el.innerHTML = `<p class="small">Comparing <b>${esc(BY[cmp[0]].name)}</b> and <b>${esc(BY[cmp[1]].name)}</b>.</p><span class="actions" style="gap:14px"><button type="button" class="linkbtn" id="cmpclr">Clear</button><button type="button" class="btn sm" id="cmpgo">Compare these two</button></span>`;
  else el.innerHTML = `<p class="small">${live ? "Sorted by how close your answers are to each candidate's, statement by statement. " : ""}Compare 2: tick two rows, candidates or past mayors, to see their answers side by side, with sources.${cmp.length === 1 ? " Pick one more." : ""}</p>`;
  if (cmp.length === 2) { $("cmpgo").onclick = openCmp; $("cmpclr").onclick = () => { cmp = []; renderCands(); renderMayors(); }; }
}
let lastFocus = null;
const lockOn = on => document.body.classList.toggle("mc-lock", on);
function openCmp(){
  const [A, B] = cmp.map(id => BY[id]);
  const mapOf = p => { const o = {}; p.answers.forEach(a => o[a.qid] = a); return o; };
  const ma = mapOf(A), mb = mapOf(B);
  const qs = ORDER.filter(q => ma[q] || mb[q]);
  const both = qs.filter(q => ma[q] && mb[q]), same = both.filter(q => Math.sign(ma[q].value) === Math.sign(mb[q].value));
  const cell = a => a ? `<div><span class="chip blue">${LABELS[a.value]}</span> <span class="chip">${a.basis === "action" ? "Vote or action" : a.basis === "stated" ? "Stated publicly" : "Judged from a related act"}</span><p>${esc(a.evidence)}</p><p class="src"><a href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(a.source_name || "Source")}</a> · ${esc(a.source_date || "")}</p></div>` : '<div class="none">No public position found.</div>';
  const head = p => `<div><h3>${esc(p.name)}</h3><p class="small">${sayP(p, "x", true)}. ${sayP(p, "y", true)}.</p><p class="small">${p.n} sourced facts</p></div>`;
  $("cmp-dlg").innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2 id="cmp-t" class="h3" style="font-size:15px;color:var(--ink-2);font-weight:600">Side by side, statement by statement</h2><button type="button" class="iconbtn" id="cmp-x" aria-label="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>
    <p class="cmpsum">${both.length ? `They take the same side on <b>${same.length} of ${both.length}</b> statements where both have a sourced position.` : "They share no statement where both have a sourced position."}</p>
    <div class="cmphead"><div class="small" style="padding-top:4px">Statement</div>${head(A)}${head(B)}</div>
    ${qs.map(q => `<div class="cmprow"><div class="st">${esc(Q[q].text)}</div>${cell(ma[q])}${cell(mb[q])}</div>`).join("") || '<p class="small">Neither has a sourced answer to the quiz statements yet.</p>'}`;
  lastFocus = document.activeElement; $("cmp-ov").hidden = false; lockOn(true); $("cmp-dlg").scrollTop = 0; $("cmp-dlg").focus();
  $("cmp-x").onclick = closeCmp;
}
function closeCmp(){ $("cmp-ov").hidden = true; lockOn(false); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
$("cmp-ov").addEventListener("mousedown", e => { if (e.target === $("cmp-ov")) closeCmp(); });
/* ---------- share card: a 1080x1350 PNG drawn on a canvas, no libraries ---------- */
// Same words rule as the page: under 1.5 from the middle counts as the middle.
const quadName = me => {
  const mx = Math.abs(me.x) < 1.5, my = Math.abs(me.y) < 1.5;
  if (mx && my) return "Right in the middle";
  const a = mx ? "Middle on the economy" : me.x > 0 ? "Conservative" : "Progressive";
  const b = my ? "middle on city control" : me.y > 0 ? "more city control" : "more personal freedom";
  return a + ", " + b;
};
function wrapText(g, text, x, y, maxW, lh){
  let line = "", yy = y;
  text.split(" ").forEach(w => { const test = line ? line + " " + w : w; if (g.measureText(test).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = test; });
  g.fillText(line, x, yy); return yy;
}
/* QR code for https://www.wardwise.org/mayor (version 3, error level M), made once with segno 1.6.1.
   The address never changes, so the page needs no QR library. */
const QR = ["11111110100100011001001111111", "10000010010000110010101000001", "10111010101001101100001011101", "10111010100111101001101011101", "10111010010001100110001011101", "10000010100011111001001000001", "11111110101010101010101111111", "00000000110001101111100000000", "01010111110110001000011101101", "01000101110011111000101001101", "10011111010111001101001100110", "01011101110100101001011110110", "10111110111100000101001101000", "01101001011111001011110101010", "01001110100101111000101000011", "01011001000000010110111100001", "01111111010110000101110000010", "01001100001011011010011101111", "10110010110000111100010001011", "00011100100100000111100011010", "10110010000101011001111110110", "00000000110111101100100010001", "11111110100100100110101011110", "10000010110010100000100010110", "10111010011110001010111111011", "10111010111010111101111011001", "10111010010011101111100011001", "10000010100100010111100101010", "11111110011101101101111011010"];
function drawCard(me, top){
  // 1080x1350, mostly map: a slim header, the map with a light 10 by 10 grid, one line of matches, a QR strip.
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1350; const g = c.getContext("2d");
  const F = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 1080, 1350); g.textBaseline = "alphabetic";
  // header: wordmark left, race right, then "My spot: <box name>"
  g.save(); g.translate(72, 46); g.scale(0.82, 0.82);
  g.fillStyle = "rgba(0,113,227,0.14)"; g.beginPath(); g.moveTo(18, 46); g.lineTo(52, 2); g.lineTo(58, 34); g.closePath(); g.fill();
  g.strokeStyle = "#0071e3"; g.lineWidth = 3.6; g.lineCap = "round"; g.lineJoin = "round"; g.beginPath(); g.moveTo(18, 46); g.lineTo(30, 33); g.lineTo(39, 38); g.lineTo(52, 18); g.stroke();
  g.fillStyle = "#0071e3"; g.beginPath(); g.arc(52, 18, 4.2, 0, 7); g.fill();
  g.fillStyle = "#1c2433"; g.beginPath(); g.arc(18, 46, 4.6, 0, 7); g.fill(); g.restore();
  g.fillStyle = "#1d1d1f"; g.font = "700 30px " + F; g.fillText("Ward Wise", 130, 86);
  g.fillStyle = "#6e6e73"; g.font = "600 22px " + F; g.textAlign = "right"; g.fillText("Chicago mayor 2027", 1008, 86); g.textAlign = "left";
  const qn = quadName(me); let fs = 36;
  const fit = () => { g.font = "600 " + fs + "px " + F; const w1 = g.measureText("My spot: ").width; g.font = "700 " + fs + "px " + F; return w1 + g.measureText(qn).width; };
  while (fs > 24 && fit() > 936) fs -= 2;
  g.font = "600 " + fs + "px " + F; g.fillStyle = "#6e6e73"; g.fillText("My spot: ", 72, 152); const w1 = g.measureText("My spot: ").width;
  g.font = "700 " + fs + "px " + F; g.fillStyle = "#0071e3"; g.fillText(qn, 72 + w1, 152);
  // map: same layout and colors as the page map (right = conservative, up = more city control)
  const S = 840, mx = (1080 - S) / 2, my = 190, h = S / 2, k = S / 20;
  const X = v => mx + h + Math.max(-10, Math.min(10, v)) * k, Y = v => my + h - Math.max(-10, Math.min(10, v)) * k;
  g.save(); g.beginPath(); if (g.roundRect) g.roundRect(mx, my, S, S, 22); else g.rect(mx, my, S, S); g.clip();
  const col = ["rgba(240,160,60,0.30)", "rgba(60,180,140,0.30)", "rgba(150,120,220,0.30)", "rgba(90,160,235,0.30)"];
  [[mx + h, my, col[0]], [mx, my, col[1]], [mx, my + h, col[2]], [mx + h, my + h, col[3]]].forEach(q => { g.fillStyle = q[2]; g.fillRect(q[0], q[1], h, h); });
  g.strokeStyle = "rgba(29,29,31,0.07)"; g.lineWidth = 1.5; g.beginPath();
  for (let v = -8; v <= 8; v += 2) { if (!v) continue; g.moveTo(X(v), my); g.lineTo(X(v), my + S); g.moveTo(mx, Y(v)); g.lineTo(mx + S, Y(v)); }
  g.stroke(); g.restore();
  g.strokeStyle = "rgba(29,29,31,0.4)"; g.lineWidth = 2; g.beginPath(); g.moveTo(mx, my + h); g.lineTo(mx + S, my + h); g.moveTo(mx + h, my); g.lineTo(mx + h, my + S); g.stroke();
  const word = (t, x, y, al) => { g.textAlign = al; g.lineWidth = 6; g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineJoin = "round"; g.strokeText(t, x, y); g.fillStyle = "rgba(29,29,31,0.62)"; g.fillText(t, x, y); };
  g.font = "600 21px " + F;
  word("More city control", mx + h, my + 34, "center"); word("More personal freedom", mx + h, my + S - 18, "center");
  word("Progressive", mx + 16, my + h - 14, "left"); word("Conservative", mx + S - 16, my + h - 14, "right"); g.textAlign = "left";
  // every 2027 candidate with a spot on both lines (hollow = thin record, like the page map); your top 3 get 1, 2, 3
  const t3 = (window._top3 || []), near = t3.map(t => t.p.id);
  PEOPLE.filter(p => p.cand && p.x != null && p.y != null && !near.includes(p.id)).forEach(p => {
    g.beginPath(); g.arc(X(p.x), Y(p.y), 9, 0, 7);
    if (p.proof === "thin") { g.strokeStyle = "rgba(29,29,31,0.5)"; g.lineWidth = 3; g.stroke(); }
    else { g.fillStyle = "rgba(29,29,31,0.45)"; g.fill(); g.strokeStyle = "#ffffff"; g.lineWidth = 2.5; g.stroke(); } });
  const dx = X(me.x), dy = Y(me.y);
  g.fillStyle = "rgba(0,113,227,0.16)"; g.beginPath(); g.arc(dx, dy, 36, 0, 7); g.fill();
  g.fillStyle = "#0071e3"; g.strokeStyle = "#ffffff"; g.lineWidth = 6; g.beginPath(); g.arc(dx, dy, 19, 0, 7); g.stroke(); g.fill();
  const badge = (n, x, y, r) => { g.fillStyle = "#1d1d1f"; g.strokeStyle = "#ffffff"; g.lineWidth = 3; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
    g.fillStyle = "#ffffff"; g.font = "700 " + Math.round(r * 1.15) + "px " + F; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(n), x, y + 1); g.textAlign = "left"; g.textBaseline = "alphabetic"; };
  // badges that would cover each other sit side by side, so 1, 2 and 3 all stay readable
  const spots = [];
  t3.forEach((t, i) => { if (t.p.x == null || t.p.y == null) return; let bx = X(t.p.x), by = Y(t.p.y);
    for (let n = 0; n < 6 && spots.some(o => Math.hypot(o[0] - bx, o[1] - by) < 35); n++) bx += 35;
    spots.push([bx, by, i]); });
  spots.reverse().forEach(([bx, by, i]) => badge(i + 1, bx, by, 17));
  g.font = "800 30px " + F; const side = dx > mx + S - 120 ? -1 : 1; g.textAlign = side > 0 ? "left" : "right";
  g.lineWidth = 7; g.strokeStyle = "#ffffff"; g.lineJoin = "round"; g.strokeText("You", dx + 30 * side, dy - 26); g.fillStyle = "#0071e3"; g.fillText("You", dx + 30 * side, dy - 26); g.textAlign = "left";
  // one line of matches, numbered like the map, then the closest past mayor
  const yb = my + S + 58;
  if (t3.length) {
    g.font = "600 24px " + F; const lab = "Closest candidates", lw = g.measureText(lab).width + 22;
    g.font = "700 28px " + F; const items = t3.map(t => t.p.short + " " + t.pct + "%"), need = items.reduce((s2, t) => s2 + 40 + g.measureText(t).width + 30, 0);
    let x = 72;
    if (lw + need <= 936) { g.font = "600 24px " + F; g.fillStyle = "#6e6e73"; g.fillText(lab, x, yb); x += lw; }
    items.forEach((txt, i) => { badge(i + 1, x + 15, yb - 10, 15); g.fillStyle = "#1d1d1f"; g.font = "700 28px " + F; g.fillText(txt, x + 38, yb); x += 40 + g.measureText(txt).width + 30; });
  } else { g.fillStyle = "#1d1d1f"; g.font = "700 26px " + F; g.fillText("No candidate has enough public positions to match yet.", 72, yb); }
  const pm = window._mayor;
  if (pm) { g.font = "600 24px " + F; g.fillStyle = "#6e6e73"; g.fillText("Closest past mayor:", 72, yb + 44); const w = g.measureText("Closest past mayor: ").width; g.fillStyle = "#1d1d1f"; g.font = "700 24px " + F; g.fillText(pm.name, 72 + w, yb + 44); }
  // bottom strip: a QR code for friends on a phone, and the printed link
  g.fillStyle = "#e8e8ed"; g.fillRect(72, 1166, 936, 2);
  const qs = 4, qx = 72, qy = 1196;
  g.fillStyle = "#1d1d1f"; QR.forEach((row, r) => { for (let c2 = 0; c2 < row.length; c2++) if (row[c2] === "1") g.fillRect(qx + c2 * qs, qy + r * qs, qs, qs); });
  const tx = qx + QR.length * qs + 30;
  g.fillStyle = "#6e6e73"; g.font = "600 22px " + F; g.fillText("Scan or visit to take the quiz", tx, 1240);
  g.fillStyle = "#0071e3"; g.font = "700 40px " + F; g.fillText("wardwise.org/mayor", tx, 1290);
  return c;
}
let cardCanvas = null;
function openCard(){
  const me = window._me, top = window._top; if (!me || me.n < 4) return;
  cardCanvas = drawCard(me, top); const url = cardCanvas.toDataURL("image/png");
  $("card-dlg").innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h2 id="card-t" class="h3" style="font-size:15px;color:var(--ink-2);font-weight:600">Your share card</h2><button type="button" class="iconbtn" id="card-x" aria-label="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>
    <img class="cardimg" id="cardimg" alt="Share card: ${esc(quadName(me))}" src="${url}">
    <div class="cardact"><button type="button" class="btn" id="card-cp">Copy</button><button type="button" class="btn btn-ghost" id="card-dl">Download</button><span class="small">Pastes as a picture, with the quiz link on it.</span></div>`;
  lastFocus = document.activeElement; $("card-ov").hidden = false; lockOn(true); $("card-dlg").focus();
  $("card-x").onclick = closeCard; $("card-cp").onclick = () => copyCard($("card-cp"), "card");
}
/* Copy the picture to the clipboard in one click. It already carries "Take the quiz at wardwise.org/mayor".
   Where the browser cannot copy a picture, the share card opens with its Download button instead. */
async function copyCard(btn, where){
  const me = window._me; if (!me || me.n < 4) return;
  const c = drawCard(me, window._top);
  let ok = false;
  try {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) throw new Error("no clipboard");
    await navigator.clipboard.write([new ClipboardItem({"image/png": new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("no image")), "image/png"))})]);
    ok = true;
  } catch (e) { ok = false; }
  if (!ok) { if ($("card-ov").hidden) openCard(); return; }
  track("mayor_quiz_card_copied", {where});
  // The label swaps inside a button locked to its own width, so nothing around it moves.
  const lab = btn.querySelector(".cltext") || btn, was = btn.dataset.label || lab.textContent; btn.dataset.label = was;
  if (!btn.style.minWidth) btn.style.minWidth = btn.getBoundingClientRect().width + "px";
  lab.textContent = "Copied \u2713"; btn.classList.add("done");
  clearTimeout(btn._t); btn._t = setTimeout(() => { lab.textContent = was; btn.classList.remove("done"); }, 2000);
}
function closeCard(){ $("card-ov").hidden = true; lockOn(false); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
$("card-ov").addEventListener("mousedown", e => { if (e.target === $("card-ov")) closeCard(); });
function moveNotes(){ const n = $("cnotes"); n.innerHTML = ""; document.querySelectorAll("#cand-grid .ctab-note").forEach(e => n.appendChild(e)); }
function renderMayors(){
  let left = maysAll ? 1e9 : 6, total = 0;
  const placed = PEOPLE.filter(p => p.mayor);
  const eras = [["Since 2011", 2011, 3000], ["1955 to 2011", 1955, 2011]];
  $("eras").innerHTML = eras.map(([t, a, b]) => {
    let rows = placed.filter(p => p.year >= a && p.year < b && (p.n > 0)).sort((x, y) => y.year - x.year);
    total += rows.length; rows = rows.slice(0, left); left -= rows.length;
    if (!rows.length) return "";
    return `<div class="era"><h3>${t}</h3><div class="mhead"><span></span><span>Mayor</span><span>${lnHead("Economy", "Progressive", "Conservative")}</span><span>${lnHead("City control", "Freedom", "Control")}</span><span class="pf">Record</span><span></span></div>${rows.map(p => `<div class="mrow" role="row" data-id="${p.id}" tabindex="0" aria-label="${esc(p.name)}: open positions and sources"><label class="cmp" title="Tick two to compare"><input type="checkbox" class="cmpbox" data-cid="${p.id}" aria-label="Compare ${esc(p.name)}" ${cmp.includes(p.id) ? "checked" : ""}></label><span><span class="mn">${esc(p.name)}</span><br><span class="yr">${esc(p.years)}</span></span><span class="cell">${lineCell("x", p.x, p.proof === "thin", p)}</span><span class="cell">${lineCell("y", p.y, p.proof === "thin", p)}</span><span class="pf small">${p.proof} record</span><span aria-hidden="true"></span></div>`).join("")}</div>`;
  }).join("");
  document.querySelectorAll("#eras .cmpbox").forEach(b => b.onchange = () => toggleCmp(b.dataset.cid));
  $("mayMore").textContent = maysAll ? "Show fewer" : "Show all " + total + " mayors"; $("norecCard").hidden = !maysAll;
  $("norecord").innerHTML = DATA.norecord.map(m => `<div>${esc(m.name)} <span class="yr small">${esc(m.years)}</span></div>`).join("");
}

/* ---------- drawer ---------- */
function openPerson(id){
  const p = BY[id]; if (!p) return; openId = id; track("mayor_quiz_person_opened", {person: id});
  const ans = {}; p.answers.forEach(a => ans[a.qid] = a);
  const qrow = qid => { const a = ans[qid], q = Q[qid]; if (!a) return ""; const u = answers[qid];
    return `<div class="fact"><div class="st">${esc(q.text)}</div><div class="row"><span class="chip blue">${LABELS[a.value]}</span><span class="chip">${a.basis === "action" ? "Based on a vote or action" : a.basis === "stated" ? "Stated publicly" : "Judged from a related act"}</span>${finished && u != null && u !== undefined ? `<span class="chip ${Math.abs(u - a.value) <= 1 && Math.sign(u) === Math.sign(a.value) ? "good" : "weak"}">You: ${LABELS[u]}</span>` : ""}</div><p>${esc(a.evidence)}</p><p class="src"><a href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(a.source_name || "Source")}</a> · ${esc(a.source_date || "")}</p></div>`; };
  const missing = ORDER.filter(q => !ans[q]);
  const sec = (title, ax) => { const qs = ORDER.filter(q => Q[q].axis === ax && ans[q]); return `<h4>${title}</h4>` + (qs.length ? qs.map(qrow).join("") : `<p class="small">No public position found on these statements.</p>`); };
  $("drawer").innerHTML = `<div class="top"><div><p class="eyebrow" style="margin:0 0 4px;font-size:14px">${esc(p.role)} · ${esc(p.years)}</p><h2 id="dr-name">${esc(p.name)}</h2>${p.party ? `<p class="small" style="margin-top:4px">${esc(p.party)}${p.status ? " · " + esc(p.status) : ""}</p>` : (p.status ? `<p class="small" style="margin-top:4px">${esc(p.status)}</p>` : "")}</div><button type="button" class="iconbtn" id="dr-close" aria-label="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>
    <div class="scores">${scoreLine("x", p.x, {cls: "big", mixed: mixedText(p, "x")})}${scoreLine("y", p.y, {cls: "big", mixed: mixedText(p, "y")})}<div class="proofline"><b class="tnum">${p.n}</b> sourced facts, ${p.proof} record</div></div>
    ${p.pulled ? `<p class="small" style="margin-top:10px">Fewer than 4 facts on a line, so the dot is pulled toward the middle. Before the pull: the economy was ${say("x", p.raw_x, true).toLowerCase()}, city control was ${say("y", p.raw_y, true).toLowerCase()}.</p>` : ""}
    <h4>Summary</h4><p style="font-size:15px"><b>Economy.</b> ${esc(p.summary_econ || "No public record found.")}</p><p style="font-size:15px;margin-top:6px"><b>City control.</b> ${esc(p.summary_control || "No public record found.")}</p>
    ${sec("Economy statements", "econ")}${sec("City control statements", "control")}
    ${p.acts.length ? `<h4>Other record</h4>` + p.acts.map(e => `<div class="fact"><div class="row"><span class="chip">${e.axis === "econ" ? (e.direction < 0 ? "Economy: toward progressive" : "Economy: toward conservative") : (e.direction > 0 ? "Toward more city control" : "Toward more personal freedom")}</span>${e.year ? `<span class="small">${esc(e.year)}</span>` : ""}</div><p>${esc(e.action)}</p><p class="src"><a href="${esc(e.source_url)}" target="_blank" rel="noopener">${esc(e.source_name || "Source")}</a> · ${esc(e.source_date || "")}</p></div>`).join("") : ""}
    ${p.issues.length ? `<h4>Positions on 2027 issues</h4>` + p.issues.map(i => `<div class="fact"><div class="st">${esc(i.issue)}</div><p>${esc(i.position)}</p>${i.quote ? `<p style="color:var(--ink-2)">"${esc(i.quote)}"</p>` : ""}<p class="src"><a href="${esc(i.source_url)}" target="_blank" rel="noopener">Source</a> · ${esc(i.source_date || "")}</p></div>`).join("") : ""}
    ${missing.length && p.answers.length ? `<h4>No public position found</h4><ul class="missing">${missing.map(q => `<li>${esc(Q[q].text)}</li>`).join("")}</ul>` : ""}
    ${p.gaps.length ? `<h4>Gaps in the record</h4><ul class="missing">${p.gaps.map(g => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
    <p class="small fixline" style="margin-top:16px">See a mistake in this record? <a href="mailto:connor@wardwise.org?subject=${encodeURIComponent("Mayor quiz correction: " + p.name)}">Email connor@wardwise.org</a>.</p>`;
  $("drawer").hidden = false; $("scrim").hidden = false; $("drawer").scrollTop = 0;
  $("dr-close").onclick = closePerson; $("dr-close").focus();
}
function closePerson(){ $("drawer").hidden = true; $("scrim").hidden = true; openId = null; }
$("scrim").onclick = closePerson;

function refresh(){ render(); }
$("candMore").onclick = () => { candsAll = !candsAll; refresh(); };
$("mayMore").onclick = () => { maysAll = !maysAll; refresh(); };
const showTab = c => { $("panelC").hidden = !c; $("panelM").hidden = c; $("tabC").setAttribute("aria-pressed", c); $("tabM").setAttribute("aria-pressed", !c); };
$("tabC").onclick = () => showTab(true); $("tabM").onclick = () => showTab(false);
$("m-check").textContent = DATA.check;

started = progressN() > 0; // a reload mid-quiz continues the same run
/* Copy my results at the top right: shown only after the reveal, copies the same picture as the result screen */
if ($("copyres")) $("copyres").onclick = () => copyCard($("copyres"), "top");
qi = ORDER.findIndex(q => !isAnswered(q)); if (qi < 0) qi = ORDER.length - 1;
$("showAnyway").onclick = () => { showField = true; render(); };
if (DEMO && !MID) { // sample profile leans toward someone who is NOT the best match
  const r = rankOf(PEOPLE.filter(p => p.cand));
  profile = {ward: "5", age: "25 to 34", lean: (r[1] || r[0]).p.name};
}
render();
if (CARDDEMO) openCard();

/* ---------- share card download: a normal browser download of the canvas ---------- */
document.addEventListener("click", e => {
  if (!e.target.closest || !e.target.closest("#card-dl") || !cardCanvas) return;
  track("mayor_quiz_share_card", {});
  cardCanvas.toBlob(blob => {
    if (!blob) return;
    const a = document.createElement("a"), href = URL.createObjectURL(blob);
    a.href = href; a.download = "my-chicago-compass.png"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }, "image/png");
});

window.MayorCompass = {restart: reopen};

})();
