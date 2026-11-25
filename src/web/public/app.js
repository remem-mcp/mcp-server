/**
 * Remem dashboard client.
 *
 * Plain DOM code without a framework. All dynamic text is inserted with
 * `textContent`, and views are reached through hash links so they work with
 * the keyboard, the browser history and assistive technology.
 */

import { renderMarkdown } from "/markdown.js";

const REPORT_VIEWS = ["daily", "weekly", "monthly"];
const VIEWS = [...REPORT_VIEWS, "logs", "search", "stats", "export"];
const LANGUAGES = ["ja", "en"];
const DOCUMENT_STYLES = ["business", "standard", "compact"];
const DOCUMENT_FONTS = ["gothic", "mincho"];

const viewEl = document.getElementById("view");
const headingEl = document.getElementById("view-heading");
const statusEl = document.getElementById("status");
const languageSelect = document.getElementById("language-select");

/** @type {{language: string, messages: Record<string, string>, today: string, version: string, projects: {name: string, count: number}[], tags: {name: string, count: number}[]}} */
let meta;
let renderToken = 0;
let uid = 0;

// --- storage (preferences stay in this browser only) ---

function loadStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for this page only
  }
}

/** Language: the user's saved choice, otherwise the browser's language */
function preferredLanguage() {
  const saved = loadStored("remem.language", null);
  if (LANGUAGES.includes(saved)) return saved;
  return (navigator.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

function documentSettings() {
  const saved = loadStored("remem.document", {});
  return {
    style: DOCUMENT_STYLES.includes(saved.style) ? saved.style : "business",
    font: DOCUMENT_FONTS.includes(saved.font) ? saved.font : "gothic",
    author: typeof saved.author === "string" ? saved.author : "",
    department: typeof saved.department === "string" ? saved.department : "",
    approval: saved.approval !== false,
    stripEmoji: saved.stripEmoji !== false,
    pageBreak: saved.pageBreak !== false,
    logs: saved.logs === true,
  };
}

// --- helpers ---

/** Translate a UI message, filling {{placeholders}} */
function t(key, values = {}) {
  const template = meta?.messages?.[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""));
}

/** Create an element with properties, attributes and children */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== "list" && key !== "form") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Add the chosen language to an API path */
function withLanguage(path) {
  return `${path}${path.includes("?") ? "&" : "?"}lang=${meta?.language ?? preferredLanguage()}`;
}

async function api(path, options) {
  const response = await fetch(withLanguage(path), options);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function setStatus(message) {
  statusEl.textContent = message;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Format a YYYY-MM-DD date in the dashboard language, e.g. "2026年11月25日(水)" */
function formatDate(date, { weekday = true } = {}) {
  return new Intl.DateTimeFormat(meta.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: weekday ? "short" : undefined,
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatMonth(date) {
  return new Intl.DateTimeFormat(meta.language, { year: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

/** Short label of a report period, used in lists */
function periodLabel(type, start, end) {
  if (type === "daily") return start;
  if (type === "monthly") return start.slice(0, 7);
  return t("week", { start, end });
}

/** Full label of a report period, used in headings and documents */
function periodText(type, start, end) {
  if (type === "daily") return formatDate(start);
  if (type === "monthly") return formatMonth(start);
  return `${formatDate(start, { weekday: false })}${t("rangeSeparator")}${formatDate(end, { weekday: false })}`;
}

function activityTypeLabel(type) {
  return meta.messages[`type${capitalize(type)}`] ?? type;
}

/** Format minutes as hours and minutes, e.g. 95 -> "1h 35m" */
function formatMinutes(minutes) {
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Remove emoji (and the space after them) for formal documents */
function stripEmoji(text) {
  return text.replace(/(?:\p{Extended_Pictographic}[️‍]*)+[ \t]?/gu, "");
}

/** A labelled form field; returns the wrapper */
function field(labelText, control, helpText) {
  const id = nextId("field");
  control.id = id;
  const wrapper = el("div", { class: "field" }, el("label", { for: id, text: labelText }), control);
  if (helpText) {
    const helpId = `${id}-help`;
    control.setAttribute("aria-describedby", helpId);
    wrapper.append(el("p", { class: "help", id: helpId, text: helpText }));
  }
  return wrapper;
}

function selectField(labelText, options, selected) {
  const select = el(
    "select",
    {},
    ...options.map((option) => el("option", { value: option.value, text: option.label, selected: option.value === selected }))
  );
  return { wrapper: field(labelText, select), control: select };
}

function checkboxField(labelText, checked) {
  const id = nextId("check");
  const input = el("input", { type: "checkbox", id, checked });
  return { wrapper: el("div", { class: "checkbox" }, input, el("label", { for: id, text: labelText })), control: input };
}

/**
 * Table of activity logs with a caption and header cells.
 *
 * @param {{withDate: boolean, onEdit?: (activity: object) => void, onDelete?: (activity: object) => void}} options
 */
function activityTable(activities, caption, { withDate, onEdit, onDelete }) {
  const hasActions = Boolean(onEdit || onDelete);
  const columns = [
    withDate ? t("colDate") : t("colTime"),
    t("colType"),
    t("colProject"),
    t("colTags"),
    t("colContent"),
    t("colMinutes"),
    ...(hasActions ? [t("colActions")] : []),
  ];
  const rows = activities.map((activity) => {
    const when = withDate ? activity.ts.slice(0, 16) : activity.ts.slice(11, 16);
    return el(
      "tr",
      { "data-activity": activity.id },
      el("td", { class: "nowrap", text: when }),
      el("td", { class: "nowrap", text: activityTypeLabel(activity.type) }),
      el("td", { text: activity.project ?? "" }),
      el("td", {}, ...activity.tags.map((tag) => el("span", { class: "tag", text: tag }))),
      el("td", { class: "content", text: activity.content }),
      el("td", { class: "nowrap", text: formatMinutes(activity.minutes) }),
      hasActions &&
        el(
          "td",
          { class: "row-actions" },
          onEdit &&
            el("button", {
              type: "button",
              class: "small",
              text: t("editLog"),
              "aria-label": t("editLogLabel", { time: when }),
              onclick: () => onEdit(activity),
            }),
          onDelete &&
            el("button", {
              type: "button",
              class: "small",
              text: t("deleteLog"),
              "aria-label": t("deleteLogLabel", { time: when }),
              onclick: () => onDelete(activity),
            })
        )
    );
  });
  const table = el(
    "table",
    { class: "log-table" },
    el("caption", { text: caption }),
    el("thead", {}, el("tr", {}, ...columns.map((column) => el("th", { scope: "col", text: column })))),
    el("tbody", {}, ...rows)
  );
  // A horizontally scrollable region must be reachable with the keyboard
  return el("div", { class: "table-wrap", tabIndex: 0, role: "group", "aria-label": caption }, table);
}

// --- report views (daily / weekly / monthly) ---

async function renderReports(type, selectedDate, token) {
  const [list, report] = await Promise.all([
    api(`/api/summaries?type=${type}`),
    selectedDate ? api(`/api/report?type=${type}&date=${selectedDate}`) : Promise.resolve(null),
  ]);
  if (token !== renderToken) return;

  const dateInput = el("input", { type: "date", value: selectedDate ?? meta.today, required: true });
  const openForm = el(
    "form",
    {
      class: "form-row",
      onsubmit: (event) => {
        event.preventDefault();
        if (dateInput.value) location.hash = `#/${type}/${dateInput.value}`;
      },
    },
    field(t("openDateLabel"), dateInput, t("openDateHelp")),
    el("button", { type: "submit", text: t("openButton") })
  );

  const items = [...list.items].reverse();
  const listHeadingId = nextId("list-heading");
  const listPanel = el(
    "section",
    { class: "panel", "aria-labelledby": listHeadingId },
    el("h2", { id: listHeadingId, text: t("listHeading") }),
    openForm,
    items.length === 0
      ? el("p", { class: "muted", text: t("listEmpty") })
      : el(
          "ul",
          { class: "report-list" },
          ...items.map((item) =>
            el(
              "li",
              {},
              el("a", {
                href: `#/${type}/${item.start}`,
                text: periodLabel(type, item.start, item.end),
                "aria-current": report && report.start === item.start ? "true" : undefined,
              })
            )
          )
        )
  );

  const detailPanel = el("section", { class: "panel" });
  if (report) {
    renderDetail(detailPanel, report, selectedDate);
  } else {
    detailPanel.append(el("p", { class: "muted", text: t("detailEmpty") }));
  }

  const layout = el("div", { class: "layout" }, listPanel, detailPanel);
  if (type === "daily" && meta.briefing) {
    const briefingId = nextId("briefing-heading");
    const plan = el("div", { class: "markdown" });
    renderMarkdown(plan, meta.briefing.plan, 3);
    viewEl.replaceChildren(
      el(
        "div",
        { class: "stack" },
        el(
          "section",
          { class: "panel briefing", "aria-labelledby": briefingId },
          el("h2", { id: briefingId, text: t("briefingHeading", { date: formatDate(meta.briefing.date) }) }),
          plan
        ),
        layout
      )
    );
  } else {
    viewEl.replaceChildren(layout);
  }
  return detailPanel.querySelector("h2");
}

/** Render one report with its edit form into `panel` */
function renderDetail(panel, report, date, { editing = false, focus } = {}) {
  const headingId = nextId("detail-heading");
  const heading = el("h2", { id: headingId, tabIndex: -1, text: periodText(report.type, report.start, report.end) });
  panel.setAttribute("aria-labelledby", headingId);
  panel.replaceChildren(heading);

  if (editing) {
    const textarea = el("textarea", { value: report.summary ?? "", spellcheck: true });
    const errorEl = el("p", { class: "error", role: "alert" });
    const wrapper = field(t("editorLabel"), textarea, t("editorHelp"));
    wrapper.append(errorEl);
    const planArea = el("textarea", { class: "short", value: report.next_plan ?? "", spellcheck: true });
    const planField = report.type === "daily" ? field(t("nextPlanLabel"), planArea, t("nextPlanHelp")) : null;

    const showError = (message) => {
      textarea.setAttribute("aria-invalid", "true");
      errorEl.textContent = message;
      textarea.focus();
    };

    panel.append(
      el(
        "form",
        {
          novalidate: true,
          onsubmit: async (event) => {
            event.preventDefault();
            if (textarea.value.trim() === "") return showError(t("emptyError"));
            try {
              const saved = await api("/api/report", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: report.type,
                  date,
                  summary: textarea.value,
                  ...(planField ? { next_plan: planArea.value } : {}),
                }),
              });
              setStatus(t("saved"));
              // The saved plan may be today's reminder
              if (planField) await applyLanguage(meta.language);
              if (location.hash === `#/${report.type}/${date}`) {
                // Refresh the list as well, since a new report may have been created
                await route({ focusSelector: "[data-action='edit']" });
              } else {
                renderDetail(panel, saved, date, { focus: "edit" });
              }
            } catch {
              showError(t("saveFailed"));
            }
          },
        },
        wrapper,
        planField,
        el(
          "div",
          { class: "actions" },
          el("button", { type: "submit", class: "primary", text: t("save") }),
          el("button", { type: "button", text: t("cancel"), onclick: () => renderDetail(panel, report, date, { focus: "edit" }) })
        )
      )
    );
    textarea.focus();
    return;
  }

  const editButton = el("button", {
    type: "button",
    "data-action": "edit",
    text: report.summary === null ? t("write") : t("edit"),
    onclick: () => renderDetail(panel, report, date, { editing: true }),
  });
  const actions = el("div", { class: "actions" }, editButton);
  if (report.summary !== null) {
    actions.append(
      el("a", { class: "button", href: `#/export/${report.type}/${report.start}`, text: t("openDocument") }),
      el("button", {
        type: "button",
        text: t("copyText"),
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(report.text ?? report.summary);
            setStatus(t("copied"));
          } catch {
            setStatus(t("copyFailed"));
          }
        },
      })
    );
  }
  panel.append(actions);

  if (report.summary === null) {
    panel.append(el("p", { class: "muted", text: t("noSummary") }));
  } else {
    const body = el("div", { class: "markdown" });
    renderMarkdown(body, report.summary, 3);
    panel.append(body);
  }

  if (report.type === "daily" && report.next_plan) {
    const plan = el("div", { class: "markdown" });
    renderMarkdown(plan, report.next_plan, 4);
    panel.append(el("h3", { text: t("nextPlanHeading") }), plan);
  }

  if (report.type === "daily") {
    panel.append(
      report.activities.length === 0
        ? el("p", { class: "muted", text: t("activitiesEmpty") })
        : activityTable(report.activities, t("activitiesHeading"), { withDate: false })
    );
  }

  if (focus === "edit") editButton.focus();
}

// --- activity logs view ---

/** Shared date range + project + tag filter fields */
function filterFields({ from, to }) {
  const fromInput = el("input", { type: "date", value: from });
  const toInput = el("input", { type: "date", value: to });
  const all = [{ value: "", label: t("all") }];
  const project = selectField(t("project"), [...all, ...meta.projects.map((p) => ({ value: p.name, label: `${p.name} (${p.count})` }))], "");
  const tag = selectField(t("tag"), [...all, ...meta.tags.map((p) => ({ value: p.name, label: `${p.name} (${p.count})` }))], "");
  const errorEl = el("p", { class: "error", role: "alert" });

  /** Query parameters, or null (with a visible error) when the range is invalid */
  const params = () => {
    errorEl.textContent = "";
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
      errorEl.textContent = t("rangeError");
      fromInput.focus();
      return null;
    }
    const result = new URLSearchParams();
    if (fromInput.value) result.set("from", fromInput.value);
    if (toInput.value) result.set("to", toInput.value);
    if (project.control.value) result.set("project", project.control.value);
    if (tag.control.value) result.set("tag", tag.control.value);
    return result;
  };

  return { fields: [field(t("from"), fromInput), field(t("to"), toInput), project.wrapper, tag.wrapper], errorEl, params };
}

/** Form for correcting one log entry; `done` receives the saved entry or null on cancel */
function logEditForm(activity, done) {
  const headingId = nextId("edit-log-heading");
  const type = selectField(
    t("typeLabel"),
    meta.activityTypes.map((value) => ({ value, label: activityTypeLabel(value) })),
    activity.type
  );
  const content = el("textarea", { class: "short", value: activity.content, required: true });
  const project = el("input", { type: "text", value: activity.project ?? "", maxLength: 50 });
  const tags = el("input", { type: "text", value: activity.tags.join(", ") });
  const minutes = el("input", { type: "number", value: activity.minutes ?? "", min: 0, max: 1440, step: 1, inputMode: "numeric" });
  const errorEl = el("p", { class: "error", role: "alert" });

  const fail = (control, message) => {
    control.setAttribute("aria-invalid", "true");
    errorEl.textContent = message;
    control.focus();
  };

  const form = el(
    "form",
    {
      class: "panel stack",
      "aria-labelledby": headingId,
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        for (const control of [content, minutes]) control.removeAttribute("aria-invalid");
        if (content.value.trim() === "") return fail(content, t("contentError"));
        const minuteValue = minutes.value.trim() === "" ? 0 : Number(minutes.value);
        if (!Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 1440) return fail(minutes, t("minutesError"));
        try {
          done(
            await api("/api/activity", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: activity.id,
                type: type.control.value,
                content: content.value,
                project: project.value,
                tags: tags.value.split(/[,、]/).map((tag) => tag.trim()).filter(Boolean),
                minutes: minuteValue,
              }),
            })
          );
        } catch {
          fail(content, t("saveFailed"));
        }
      },
    },
    el("h2", { id: headingId, tabIndex: -1, text: `${t("editLogHeading")} (${activity.ts.slice(0, 16)})` }),
    field(t("contentLabel"), content),
    el("div", { class: "form-row" }, type.wrapper, field(t("project"), project), field(t("tagsLabel"), tags), field(t("minutesLabel"), minutes)),
    errorEl,
    el(
      "div",
      { class: "actions" },
      el("button", { type: "submit", class: "primary", text: t("save") }),
      el("button", { type: "button", text: t("cancel"), onclick: () => done(null) })
    )
  );
  return form;
}

async function renderLogs(token) {
  const filter = filterFields({ from: addDays(meta.today, -6), to: meta.today });
  const results = el("div", {});
  const editor = el("div", {});

  const rowButton = (id, label) =>
    [...results.querySelectorAll(`tr[data-activity="${id}"] button`)].find((button) => button.textContent === label);

  const load = async () => {
    const params = filter.params();
    if (!params) return;
    const data = await api(`/api/activities?${params}`);
    const caption = t("logsCaption", { count: data.items.length });
    results.replaceChildren(
      data.items.length === 0
        ? el("p", { class: "muted", text: t("logsEmpty") })
        : activityTable(data.items, caption, {
            withDate: true,
            onEdit: (activity) => {
              const form = logEditForm(activity, async (saved) => {
                editor.replaceChildren();
                if (saved) {
                  await load();
                  setStatus(t("logSaved"));
                }
                // Return to the row the user was working on
                (rowButton(activity.id, t("editLog")) ?? headingEl).focus();
              });
              editor.replaceChildren(form);
              form.querySelector("h2").focus();
            },
            onDelete: async (activity) => {
              if (!window.confirm(t("confirmDelete"))) return;
              try {
                await api(`/api/activity?id=${activity.id}`, { method: "DELETE" });
                editor.replaceChildren();
                await load();
                setStatus(t("logDeleted"));
                headingEl.focus();
              } catch {
                setStatus(t("saveFailed"));
              }
            },
          })
    );
    return caption;
  };

  const headingId = nextId("filter-heading");
  const form = el(
    "form",
    {
      class: "panel",
      "aria-labelledby": headingId,
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const caption = await load();
          if (caption) setStatus(caption);
        } catch {
          setStatus(t("loadFailed"));
        }
      },
    },
    el("h2", { id: headingId, text: t("filterHeading") }),
    el("div", { class: "form-row" }, ...filter.fields, el("button", { type: "submit", class: "primary", text: t("apply") })),
    filter.errorEl
  );

  await load();
  if (token !== renderToken) return;
  viewEl.replaceChildren(el("div", { class: "stack" }, form, editor, el("section", { class: "panel" }, results)));
}

// --- search view ---

function renderSearch() {
  const queryInput = el("input", { type: "search", maxLength: 200, required: true });
  const fromInput = el("input", { type: "date" });
  const toInput = el("input", { type: "date" });
  const errorEl = el("p", { class: "error", role: "alert" });
  const results = el("div", { class: "stack" });

  const search = async () => {
    errorEl.textContent = "";
    queryInput.removeAttribute("aria-invalid");
    if (queryInput.value.trim() === "") {
      queryInput.setAttribute("aria-invalid", "true");
      errorEl.textContent = t("searchQueryError");
      queryInput.focus();
      return;
    }
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
      errorEl.textContent = t("rangeError");
      fromInput.focus();
      return;
    }
    const params = new URLSearchParams({ q: queryInput.value.trim() });
    if (fromInput.value) params.set("from", fromInput.value);
    if (toInput.value) params.set("to", toInput.value);

    try {
      const data = await api(`/api/search?${params}`);
      const reports = [
        ...data.daily.map((row) => ({ type: "daily", start: row.date, end: row.date })),
        ...data.weekly.map((row) => ({ type: "weekly", start: row.period_start, end: row.period_end })),
        ...data.monthly.map((row) => ({ type: "monthly", start: row.period_start, end: row.period_end })),
      ];
      const total = reports.length + data.activities.length;
      const sections = [];

      if (reports.length > 0) {
        const id = nextId("search-reports");
        sections.push(
          el(
            "section",
            { class: "panel", "aria-labelledby": id },
            el("h2", { id, text: t("searchReports", { count: reports.length }) }),
            el(
              "ul",
              { class: "report-list" },
              ...reports.map((report) =>
                el(
                  "li",
                  {},
                  el("a", {
                    href: `#/${report.type}/${report.start}`,
                    text: `${viewTitle(report.type)}: ${periodText(report.type, report.start, report.end)}`,
                  })
                )
              )
            )
          )
        );
      }
      if (data.activities.length > 0) {
        sections.push(
          el(
            "section",
            { class: "panel" },
            activityTable(data.activities, t("searchLogs", { count: data.activities.length }), { withDate: true })
          )
        );
      }

      const message =
        total === 0 ? t("searchEmpty") : t(data.partial ? "searchPartial" : "searchResults", { count: total });
      if (total > 0 && data.partial) sections.unshift(el("p", { class: "muted", text: message }));
      results.replaceChildren(...(total === 0 ? [el("p", { class: "muted", text: t("searchEmpty") })] : sections));
      setStatus(message);
    } catch {
      setStatus(t("loadFailed"));
    }
  };

  const form = el(
    "form",
    {
      class: "panel",
      role: "search",
      "aria-label": t("navSearch"),
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void search();
      },
    },
    el(
      "div",
      { class: "form-row" },
      el("div", { class: "grow" }, field(t("searchLabel"), queryInput, t("searchHelp"))),
      field(t("from"), fromInput),
      field(t("to"), toInput),
      el("button", { type: "submit", class: "primary", text: t("searchButton") })
    ),
    errorEl
  );

  viewEl.replaceChildren(el("div", { class: "stack" }, form, results));
}

// --- statistics view ---

/**
 * A ranked table with one bar per row. The bar repeats the number shown in
 * the same row, so it is decorative for assistive technology.
 */
function statTable(title, groups, { useMinutes, total, label }) {
  const max = Math.max(...groups.map((group) => (useMinutes ? group.minutes : group.count)), 1);
  const rows = groups.map((group) => {
    const value = useMinutes ? group.minutes : group.count;
    const bar = el("span", { class: "bar", "aria-hidden": "true" });
    bar.style.setProperty("width", `${Math.max((value / max) * 100, value > 0 ? 1.5 : 0)}%`);
    const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "";
    return el(
      "tr",
      {},
      el("th", { scope: "row", text: label(group.name) }),
      el("td", { class: "bar-cell" }, el("span", { class: "bar-track" }, bar), el("span", { class: "bar-share", text: share })),
      el("td", { class: "number", text: String(group.count) }),
      el("td", { class: "number", text: formatMinutes(group.minutes) || "–" })
    );
  });
  return el(
    "div",
    { class: "table-wrap", tabIndex: 0, role: "group", "aria-label": title },
    el(
      "table",
      { class: "stat-table" },
      el("caption", { text: title }),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: t("statsColName") }),
          el("th", { scope: "col", text: t("statsColShare") }),
          el("th", { scope: "col", class: "number", text: t("statsColCount") }),
          el("th", { scope: "col", class: "number", text: t("statsColTime") })
        )
      ),
      el("tbody", {}, ...rows)
    )
  );
}

async function renderStats(token) {
  const filter = filterFields({ from: `${meta.today.slice(0, 7)}-01`, to: meta.today });
  const results = el("div", { class: "stack" });

  const load = async () => {
    const params = filter.params();
    if (!params) return;
    const stats = await api(`/api/stats?${params}`);
    if (stats.count === 0) {
      results.replaceChildren(el("p", { class: "muted", text: t("statsEmpty") }));
      return t("statsEmpty");
    }

    const useMinutes = stats.minutes > 0;
    const options = { useMinutes, total: useMinutes ? stats.minutes : stats.count };
    const tile = (label, value) => el("div", { class: "tile" }, el("dt", { text: label }), el("dd", { text: value }));

    results.replaceChildren(
      el(
        "section",
        { class: "panel" },
        el("dl", { class: "tiles" }, tile(t("statsTotalLogs"), String(stats.count)), tile(t("statsTotalTime"), formatMinutes(stats.minutes) || "–")),
        el("p", { class: "help", text: useMinutes ? t("statsNoteTime") : t("statsNoteCount") })
      ),
      el("section", { class: "panel" }, statTable(t("statsByProject"), stats.byProject, { ...options, label: (name) => name || t("noProject") })),
      el("section", { class: "panel" }, statTable(t("statsByType"), stats.byType, { ...options, label: activityTypeLabel })),
      stats.byTag.length > 0 && el("section", { class: "panel" }, statTable(t("statsByTag"), stats.byTag, { ...options, label: (name) => name })),
      el("section", { class: "panel" }, statTable(t("statsByDay"), stats.byDay, { ...options, label: (name) => formatDate(name) }))
    );
    return t("statsUpdated", { count: stats.count });
  };

  const headingId = nextId("stats-filter-heading");
  const form = el(
    "form",
    {
      class: "panel",
      "aria-labelledby": headingId,
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const message = await load();
          if (message) setStatus(message);
        } catch {
          setStatus(t("loadFailed"));
        }
      },
    },
    el("h2", { id: headingId, text: t("filterHeading") }),
    el("div", { class: "form-row" }, ...filter.fields, el("button", { type: "submit", class: "primary", text: t("apply") })),
    filter.errorEl
  );

  await load();
  if (token !== renderToken) return;
  viewEl.replaceChildren(el("div", { class: "stack" }, form, results));
}

// --- export & print view ---

/**
 * Build one printable document ("sheet") for a report.
 *
 * @param {{type: string, start: string, end: string, summary: string}} report
 * @param {ReturnType<typeof documentSettings>} settings
 * @param {object[]} activities - Logs of that day (daily reports only)
 */
function buildSheet(report, settings, activities) {
  const titleId = nextId("sheet-title");
  const header = el(
    "header",
    { class: "doc-header" },
    el("h3", { class: "doc-title", id: titleId, text: t(`docTitle${capitalize(report.type)}`) })
  );

  if (settings.approval) {
    const roles = [t("approvalApprover"), t("approvalReviewer"), t("approvalAuthor")];
    header.append(
      el(
        "table",
        { class: "approval" },
        el("caption", { class: "visually-hidden", text: t("approvalCaption") }),
        el("thead", {}, el("tr", {}, ...roles.map((role) => el("th", { scope: "col", text: role })))),
        // Empty boxes for stamps or signatures
        el("tbody", {}, el("tr", {}, ...roles.map(() => el("td", {}))))
      )
    );
  }

  const metaRows = [[report.type === "daily" ? t("docDate") : t("docPeriod"), periodText(report.type, report.start, report.end)]];
  if (settings.department.trim()) metaRows.push([t("departmentLabel"), settings.department.trim()]);
  if (settings.author.trim()) metaRows.push([t("authorLabel"), settings.author.trim()]);

  const body = el("div", { class: "markdown doc-body" });
  renderMarkdown(body, settings.stripEmoji ? stripEmoji(report.summary) : report.summary, 4);

  const sheet = el(
    "article",
    {
      class: `sheet style-${settings.style} font-${settings.font}${settings.pageBreak ? " page-break" : ""}`,
      "aria-labelledby": titleId,
    },
    header,
    el(
      "table",
      { class: "doc-meta" },
      el("tbody", {}, ...metaRows.map(([label, value]) => el("tr", {}, el("th", { scope: "row", text: label }), el("td", { text: value }))))
    ),
    body
  );

  if (settings.logs && activities.length > 0) {
    sheet.append(activityTable(activities, t("docLogs"), { withDate: false }));
  }
  return sheet;
}

/**
 * @param {{type: string | null, date: string | null}} preset - Report to preview right away (from a report page)
 */
async function renderExport(preset, token) {
  const settings = documentSettings();

  const type = selectField(
    t("exportType"),
    [
      { value: "all", label: t("typeAll") },
      { value: "daily", label: t("navDaily") },
      { value: "weekly", label: t("navWeekly") },
      { value: "monthly", label: t("navMonthly") },
    ],
    preset.type ?? "all"
  );
  const fromInput = el("input", { type: "date" });
  const toInput = el("input", { type: "date" });
  const errorEl = el("p", { class: "error", role: "alert" });
  const preview = el("div", {});

  if (preset.type && preset.date) {
    // Limit the range to the one report the user came from
    const report = await api(`/api/report?type=${preset.type}&date=${preset.date}`);
    if (token !== renderToken) return;
    fromInput.value = report.start;
    toInput.value = report.end;
  }

  // Document style controls
  const style = selectField(
    t("styleLabel"),
    DOCUMENT_STYLES.map((value) => ({ value, label: t(`style${capitalize(value)}`) })),
    settings.style
  );
  const font = selectField(
    t("fontLabel"),
    DOCUMENT_FONTS.map((value) => ({ value, label: t(`font${capitalize(value)}`) })),
    settings.font
  );
  const authorInput = el("input", { type: "text", value: settings.author, autocomplete: "name", maxLength: 60 });
  const departmentInput = el("input", { type: "text", value: settings.department, autocomplete: "organization", maxLength: 60 });
  const approval = checkboxField(t("approvalLabel"), settings.approval);
  const emoji = checkboxField(t("stripEmojiLabel"), settings.stripEmoji);
  const pageBreak = checkboxField(t("pageBreakLabel"), settings.pageBreak);
  const logs = checkboxField(t("includeLogs"), settings.logs);

  const readSettings = () => ({
    style: style.control.value,
    font: font.control.value,
    author: authorInput.value,
    department: departmentInput.value,
    approval: approval.control.checked,
    stripEmoji: emoji.control.checked,
    pageBreak: pageBreak.control.checked,
    logs: logs.control.checked,
  });

  const buildParams = (format) => {
    errorEl.textContent = "";
    if (fromInput.value && toInput.value && fromInput.value > toInput.value) {
      errorEl.textContent = t("rangeError");
      fromInput.focus();
      return null;
    }
    const params = new URLSearchParams({ format, type: type.control.value });
    if (fromInput.value) params.set("from", fromInput.value);
    if (toInput.value) params.set("to", toInput.value);
    if (logs.control.checked) params.set("logs", "1");
    return params;
  };

  const download = (format) => {
    const params = buildParams(format);
    // The response is an attachment, so the page itself stays in place
    if (params) window.location.assign(withLanguage(`/api/export?${params}`));
  };

  let previewShown = false;
  const showPreview = async ({ moveFocus }) => {
    const params = buildParams("json");
    if (!params) return;
    const current = readSettings();
    store("remem.document", current);

    try {
      const data = await api(`/api/export?${params}`);
      const sheets = [];
      for (const kind of REPORT_VIEWS) {
        for (const row of data[kind]) {
          const report =
            kind === "daily"
              ? { type: kind, start: row.date, end: row.date, summary: row.summary }
              : { type: kind, start: row.period_start, end: row.period_end, summary: row.summary };
          const activities = kind === "daily" ? (data.activities ?? []).filter((a) => a.ts.slice(0, 10) === row.date) : [];
          sheets.push(buildSheet(report, current, activities));
        }
      }

      const headingId = nextId("preview-heading");
      const heading = el("h2", { id: headingId, tabIndex: -1, text: t("previewHeading") });
      preview.replaceChildren(
        el(
          "section",
          { class: "preview", "aria-labelledby": headingId },
          el(
            "div",
            { class: "preview-bar no-print" },
            heading,
            sheets.length > 0 &&
              el("button", { type: "button", class: "primary", text: t("print"), onclick: () => window.print() })
          ),
          sheets.length === 0 ? el("p", { class: "muted", text: t("previewEmpty") }) : el("div", { class: "sheets" }, ...sheets)
        )
      );
      previewShown = true;
      setStatus(sheets.length === 0 ? t("previewEmpty") : t("previewCount", { count: sheets.length }));
      if (moveFocus) heading.focus();
    } catch {
      setStatus(t("loadFailed"));
    }
  };

  // Changing a style option updates an open preview without moving focus
  const onSettingChange = () => {
    store("remem.document", readSettings());
    if (previewShown) void showPreview({ moveFocus: false });
  };
  for (const control of [style.control, font.control, approval.control, emoji.control, pageBreak.control, logs.control]) {
    control.addEventListener("change", onSettingChange);
  }
  for (const control of [authorInput, departmentInput]) control.addEventListener("change", onSettingChange);

  const headingId = nextId("export-heading");
  const docHeadingId = nextId("doc-heading");
  const form = el(
    "form",
    { class: "panel no-print stack", "aria-labelledby": headingId, onsubmit: (event) => event.preventDefault() },
    el(
      "div",
      {},
      el("h2", { id: headingId, text: t("exportHeading") }),
      el("p", { class: "help", text: t("exportHelp") }),
      el("div", { class: "form-row" }, type.wrapper, field(t("from"), fromInput), field(t("to"), toInput)),
      errorEl
    ),
    el(
      "fieldset",
      { "aria-describedby": `${docHeadingId}-help` },
      el("legend", { id: docHeadingId, text: t("docHeading") }),
      el("p", { class: "help", id: `${docHeadingId}-help`, text: t("docHelp") }),
      el(
        "div",
        { class: "form-row" },
        style.wrapper,
        font.wrapper,
        field(t("departmentLabel"), departmentInput),
        field(t("authorLabel"), authorInput)
      ),
      el("div", { class: "form-row" }, approval.wrapper, emoji.wrapper, pageBreak.wrapper, logs.wrapper)
    ),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", class: "primary", text: t("preview"), onclick: () => void showPreview({ moveFocus: true }) }),
      el("button", { type: "button", text: t("downloadMarkdown"), onclick: () => download("markdown") }),
      el("button", { type: "button", text: t("downloadText"), onclick: () => download("text") }),
      el("button", { type: "button", text: t("downloadJson"), onclick: () => download("json") })
    )
  );

  viewEl.replaceChildren(el("div", { class: "stack" }, form, preview));
  if (preset.type && preset.date) {
    await showPreview({ moveFocus: false });
    return preview.querySelector("h2");
  }
}

// --- routing ---

function parseHash() {
  const [, view, second, third] = location.hash.split("/");
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
  if (view === "export") {
    const hasPreset = REPORT_VIEWS.includes(second) && isDate(third);
    return { view, date: null, preset: hasPreset ? { type: second, date: third } : { type: null, date: null } };
  }
  return { view: VIEWS.includes(view) ? view : "daily", date: isDate(second) ? second : null, preset: null };
}

function viewTitle(view) {
  return t(`nav${capitalize(view)}`);
}

/**
 * Render the view for the current hash.
 *
 * @param {{moveFocus?: boolean, focusSelector?: string}} options
 */
async function route({ moveFocus = false, focusSelector } = {}) {
  const token = ++renderToken;
  const { view, date, preset } = parseHash();
  const title = viewTitle(view);

  document.title = `${title} | ${t("appTitle")}`;
  headingEl.textContent = title;
  for (const link of document.querySelectorAll("#nav a")) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  try {
    let focusTarget = headingEl;
    if (REPORT_VIEWS.includes(view)) {
      const detailHeading = await renderReports(view, date, token);
      if (date && detailHeading) focusTarget = detailHeading;
    } else if (view === "logs") {
      await renderLogs(token);
    } else if (view === "search") {
      renderSearch();
    } else if (view === "stats") {
      await renderStats(token);
    } else {
      const previewHeading = await renderExport(preset, token);
      if (previewHeading) focusTarget = previewHeading;
    }
    if (token !== renderToken) return;

    const explicit = focusSelector ? viewEl.querySelector(focusSelector) : null;
    if (explicit) explicit.focus();
    else if (moveFocus) focusTarget.focus();
  } catch {
    if (token !== renderToken) return;
    viewEl.replaceChildren(el("p", { class: "error", role: "alert", text: t("loadFailed") }));
  }
}

/** Load messages for a language and update every static text on the page */
async function applyLanguage(language) {
  meta = await (async () => {
    const response = await fetch(`/api/meta?lang=${language}`);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  })();

  document.documentElement.lang = meta.language;
  languageSelect.value = meta.language;
  document.getElementById("language-label").textContent = t("languageLabel");
  document.getElementById("app-title").textContent = t("appTitle");
  document.getElementById("skip-link").textContent = t("skipToContent");
  document.getElementById("footer-note").textContent = `${t("localOnly")} (Remem ${meta.version})`;
  document.getElementById("nav").setAttribute("aria-label", t("navLabel"));
  for (const link of document.querySelectorAll("#nav a")) link.textContent = viewTitle(link.dataset.view);
}

async function start() {
  try {
    await applyLanguage(preferredLanguage());
  } catch {
    viewEl.replaceChildren(
      el("p", { class: "error", role: "alert", text: "Could not load data. Check that Remem is still running and reload the page." })
    );
    return;
  }

  languageSelect.addEventListener("change", async () => {
    store("remem.language", languageSelect.value);
    try {
      await applyLanguage(languageSelect.value);
      setStatus("");
      await route();
      // Keep focus on the control the user is operating
      languageSelect.focus();
    } catch {
      setStatus(t("loadFailed"));
    }
  });

  document.getElementById("skip-link").addEventListener("click", (event) => {
    // Keep the hash for routing; just move focus to the main content
    event.preventDefault();
    document.getElementById("main").focus();
  });

  window.addEventListener("hashchange", () => {
    setStatus("");
    void route({ moveFocus: true });
  });
  await route();
}

void start();
