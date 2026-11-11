// The idea board on /get-involved.
//
// Ideas are GitHub issues on ward-wise/ideas: one ticket per nominated measure or dashboard. The work
// itself lives in a repo the volunteer starts, linked from the ticket's "Work lives at" field. Every
// [data-idea-board] node names the label it shows; one unauthenticated request (GitHub allows 60 an
// hour per visitor) feeds all of them and is cached for the session.
(function () {
  "use strict";

  const REPO = "ward-wise/ideas";
  const BOARD_URL = `https://github.com/${REPO}/issues`;
  const API_URL = `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100`;
  const CACHE_KEY = "ww-idea-board-v1";
  const CACHE_MS = 10 * 60 * 1000;
  const MAX_PER_BOARD = 12;

  const api = window.WardWiseExplorer || {};
  const esc = api.escapeHtml || ((value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));

  function readCache() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.issues;
    } catch (error) { /* storage blocked: fetch instead */ }
    return null;
  }

  function writeCache(issues) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), issues })); } catch (error) { /* fine */ }
  }

  // Issue forms render each field as "### <label>\n\n<answer>"; unanswered fields say "_No response_".
  function formField(body, pattern) {
    const sections = String(body || "").split(/^###\s+/m);
    for (const section of sections) {
      const newline = section.indexOf("\n");
      if (newline < 0) continue;
      if (!pattern.test(section.slice(0, newline))) continue;
      const answer = section.slice(newline + 1).trim();
      return answer && answer !== "_No response_" ? answer : "";
    }
    return "";
  }

  function slim(issue) {
    const labels = (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name));
    const domain = labels.find((label) => label.startsWith("domain:"));
    const work = formField(issue.body, /work lives at/i).match(/https?:\/\/\S+/);
    return {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      labels,
      // labels are written domain:psychological_wellbeing; show "Psychological wellbeing"
      domain: domain ? domain.slice("domain:".length).replace(/[_-]+/g, " ").trim() : "",
      nominator: formField(issue.body, /nominat/i).split("\n")[0].slice(0, 80),
      work: work ? work[0] : "",
      claimed: labels.includes("in-progress") || (issue.assignees || []).length > 0,
      comments: issue.comments || 0,
    };
  }

  async function loadIdeas() {
    const cached = readCache();
    if (cached) return cached;
    const response = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (response.status === 404) {
      const error = new Error("board missing");
      error.missing = true;
      throw error;
    }
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const issues = (await response.json()).filter((issue) => !issue.pull_request).map(slim);
    writeCache(issues);
    return issues;
  }

  function status(idea) {
    if (idea.labels.includes("not-feasible")) return ["Not feasible yet", "is-muted"];
    if (idea.claimed) return ["In progress", "is-claimed"];
    if (idea.labels.includes("needs-data")) return ["Needs a data source", "is-data"];
    return ["Open", "is-open"];
  }

  function card(idea, cta, showDomain) {
    const [statusText, statusClass] = status(idea);
    const bits = [];
    if (idea.nominator) bits.push(`Nominated by ${esc(idea.nominator)}`);
    if (idea.comments) bits.push(`${idea.comments} comment${idea.comments === 1 ? "" : "s"}`);
    const work = idea.work
      ? `<a class="gi-idea-work" href="${esc(idea.work)}" rel="noopener">See the work</a>`
      : "";
    return `
      <li class="gi-idea">
        <span class="gi-chips"><span class="gi-status ${statusClass}">${esc(statusText)}</span>${idea.labels.includes("good first issue") ? '<span class="gi-status is-first">Good first project</span>' : ""}</span>
        ${showDomain && idea.domain ? `<p class="gi-idea-domain">${esc(capitalize(idea.domain))}</p>` : ""}
        <a class="gi-idea-title" href="${esc(idea.url)}" rel="noopener">${esc(idea.title)}</a>
        ${bits.length ? `<p class="gi-idea-meta">${bits.join(" · ")}</p>` : ""}
        <p class="gi-idea-links">
          <a href="${esc(idea.url)}" rel="noopener">${esc(idea.claimed ? "Follow on GitHub" : cta)}</a>
          ${work}
        </p>
      </li>`;
  }

  function list(ideas, cta, showDomain) {
    return `<ul class="gi-ideas">${ideas.map((idea) => card(idea, cta, showDomain)).join("")}</ul>`;
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function render(node, ideas) {
    const wanted = node.dataset.labels;
    const cta = node.dataset.cta || "Open on GitHub";
    // Open ideas first, then claimed ones; newest first within each (GitHub's default order).
    const matching = ideas
      .filter((idea) => idea.labels.includes(wanted) && !idea.labels.includes("not-feasible"))
      .sort((a, b) => Number(a.claimed) - Number(b.claimed));
    const footer = `<p class="gi-board-foot"><a class="fd-more" href="${BOARD_URL}?q=is%3Aopen+label%3A${encodeURIComponent(`"${wanted}"`)}" rel="noopener">See all on GitHub</a>
      <a class="fd-more" href="${BOARD_URL}/new/choose" rel="noopener">Add an idea</a></p>`;

    if (!matching.length) {
      node.innerHTML = `<p class="gi-board-note">${esc(node.dataset.empty || "Nothing here right now.")}</p>${footer}`;
      return;
    }

    // Boards that show a domain (measures) sort by it so related ideas sit together in one grid.
    const byDomain = node.dataset.group === "domain";
    if (byDomain) {
      matching.sort((a, b) => Number(a.claimed) - Number(b.claimed)
        || (!a.domain) - (!b.domain) || a.domain.localeCompare(b.domain));
    }
    const shown = matching.slice(0, MAX_PER_BOARD);
    const body = list(shown, cta, byDomain);
    const more = matching.length > shown.length
      ? `<p class="gi-board-note">Showing ${shown.length} of ${matching.length}.</p>`
      : "";
    node.innerHTML = body + more + footer;
  }

  function renderError(node, error) {
    // The board repo is new; until it exists say so plainly rather than showing an empty list.
    const text = error && error.missing
      ? "The idea board is still being set up. Until it opens, nominate through the form or bring your idea to Chi Hack Night."
      : `Couldn't load the idea board just now. <a href="${BOARD_URL}" rel="noopener">See it on GitHub</a>.`;
    node.innerHTML = `<p class="gi-board-note">${text}</p>`;
  }

  async function init() {
    const boards = [...document.querySelectorAll("[data-idea-board]")];
    if (!boards.length) return;
    boards.forEach((node) => { node.innerHTML = '<p class="fd-loading">Loading ideas…</p>'; });
    try {
      const ideas = await loadIdeas();
      boards.forEach((node) => render(node, ideas));
    } catch (error) {
      boards.forEach((node) => renderError(node, error));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
