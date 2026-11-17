import { draftPreview } from "/preview-policy.js";
import { showCalendarAccess } from "/calendar-access-ui.js";
import { showShare } from "/share-ui.js";
import { memberConnectUrl, memberCalendarPayload } from "/my-calendar-ui.js";
import { accountMenuMarkup, bindAccountMenu } from "/account-menu.js";
import { bindTeamEditor } from "/team-ui.js";
import { newMeeting, meetingSlug } from "/meeting-defaults.js";
import { showHostReschedule } from "/host-booking-ui.js";
import { showProfile, profilePreview, changeProfileImage } from "/profile-ui.js";
import { deliveryMarkup, hasDeliveryIssue } from "/delivery-ui.js";
import { bindApprovalSettings, approvalNotice } from "/approval-ui.js";
import { bindReminders } from "/reminder-ui.js";
import { bindQuestionsEditor, savedIntakeMarkup } from "/intake-ui.js";
import { showSessions } from "/session-ui.js";
import { showManageAccount, createExportController, exportRequest, bindExportRow, canExportProfile, profileExportMarkup } from "/account-data-ui.js";
import { DEFAULT } from "/policy.js";
import { meetingLink } from "/conference-ui.js";
import { analyticsMarkup, bindAnalytics } from "/analytics-ui.js";
import { operationsMarkup, showResolveDialog, attentionCount } from "/operations-ui.js";
import { updateTimeLimitHint } from "/host-editor.js";
import { bindChangeRules, cleanReason, REASON_MAX } from "/change-policy-ui.js";
import { bindLinkAccess, accessFor, linkState, previewDraft } from "/link-access-ui.js";
import { bookingsMarkup, setupMarkup, showRowMenu, isRequest } from "/bookings-ui.js";
import { linksMarkup, linkMenuItems } from "/links-ui.js";
import { editorMarkup, readEditor, ownHoursOf, previewSlots, previewMarkup, bindLength } from "/link-editor-ui.js";
import { availabilityPageMarkup, bindAvailabilityPage, currentMonday, zoneLabel } from "/availability-page.js";
import { addDays, weeklySummary, zonedEpoch } from "/week-calendar.js";
import { WORKSPACE_HEADER, resolveWorkspaces, readStoredWorkspace, storeWorkspace, clearStoredWorkspace, captureInviteToken, stashInviteToken, takePendingInvite, clearPendingInvite, roleLabel, switcherMarkup, bindSwitcher, showCreateWorkspace, sectionsFor, can, canAdminister, cleanWorkspace, teamMarkup, bindTeam, showInviteDialog, showInviteAcceptance } from "/workspace-ui.js";
import { integrationsMarkup, bindIntegrations, integrationsHeading } from "/integrations-ui.js";
import { activityMarkup, bindActivity, loadActivity } from "/activity-ui.js";
import { normalizeBrand, brandMark, studioName, legalLinksMarkup } from "/brand.js";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let activeWorkspace = null, onCompanyRefusal = () => {
};
const ACCOUNT_ROUTES = /^(workspaces$|workspace\/invitations\/(inspect|accept)$|sessions(\/|$)|calendar-contributions(\/|$))/;
async function api(path, data, { workspace = activeWorkspace } = {}) {
  const headers = data ? { "Content-Type": "application/json" } : {}, company = workspace && !workspace.personal && !ACCOUNT_ROUTES.test(path) ? workspace : null;
  if (company) headers[WORKSPACE_HEADER] = company.id;
  const r = await fetch("/api/live/" + path, data ? { method: "POST", headers, body: JSON.stringify(data) } : { headers });
  let value;
  try {
    value = await r.json();
  } catch {
    value = { error: r.ok ? "Unexpected response." : "Request failed (" + r.status + ")." };
  }
  if (!r.ok) {
    if (company && company === activeWorkspace && (r.status === 403 || r.status === 404)) onCompanyRefusal();
    throw Object.assign(Error(value.error || "Request failed."), { code: value.code, status: r.status });
  }
  return value;
}
export async function hostUI(bootstrap) {
  const brand = normalizeBrand(bootstrap.brand);
  stashInviteToken(captureInviteToken());
  let inviteToken = takePendingInvite();
  const calendarCallback = new URLSearchParams(location.search).get("calendar") === "connected";
  const initialLinkId = /^#link=([-a-zA-Z0-9_]{1,100})$/.exec(location.hash)?.[1];
  const initialBookingId = /^#booking=([-a-zA-Z0-9_]{16,80})$/.exec(location.hash)?.[1];
  const account = bootstrap.hostId || bootstrap.email || "";
  const linkedQuery = new URLSearchParams(location.search).get("workspace");
  let linkedWorkspace = linkedQuery === null ? null : /^h_[A-Za-z0-9_-]{24}$/.test(linkedQuery) ? linkedQuery : "invalid", linkDenied = false;
  if (linkedQuery !== null) {
    const q = new URLSearchParams(location.search);
    q.delete("workspace");
    history.replaceState(null, "", location.pathname + (q.size ? "?" + q : "") + location.hash);
  }
  let ws = resolveWorkspaces(null), personalName = "", loadError = "", accessNotice = null, generation = 0, teamData = null, teamLoading = false, teamError = "", intData = null, intLoading = false, intError = "", actData = null, actLoading = false, actError = "", checkingAccess = false;
  const root = document.querySelector("#app");
  const hashSection = (hash) => ({ "#calendars": "Availability", "#availability": "Availability", "#analytics": "Analytics", "#stats": "Analytics", "#status": "Status", "#team": "Team", "#integrations": "Integrations", "#activity": "Activity", "#links": "Meetings" })[hash] || (/^#link=/.test(hash) ? "Meetings" : "Bookings");
  let settings, calendars = [], section = hashSection(location.hash), selected = 0, editing = !!initialLinkId, message = "", bookings = [], bookingView = "home", bookingQuery = "", bookingSearching = false, deciding = {}, bookingLoading = false, bookingLoaded = false, reconciliationIssues = [], notificationIssues = [], analyticsData = null, analyticsMetric = "pageViews", analyticsLoading = false, dirty = false, calendarsLoaded = false, savedTypeIds = new Set(), refreshTeamCalendars = () => {
  }, opsData = null, opsLoading = false, opsError = "";
  let profileExport = null;
  let ownLoad = 0, ownCalendar = null, ownLoading = false, ownError = "", contributions = [];
  // Availability page and link editor state.
  let av = { mode: "every", monday: null, events: [], calendars: [], nextWeek: null, status: "", loadedFor: "" }, avUnbind = () => {
  }, linkStats = {}, copiedLink = "", ownHoursDraft = null, previewDay = "", previewBusy = [], previewTimer = 0;
  // A load starts its independent reads together. An early read is the same
  // request the load would send, keyed by workspace and path, so its reply or
  // error is used as is. A different workspace or a newer load sends it again.
  let earlyReads = new Map();
  const earlyKey = (workspace, path) => (workspace.personal ? "personal" : workspace.id) + " " + path;
  function prefetch(workspace, path) {
    const key = earlyKey(workspace, path);
    if (!earlyReads.has(key)) earlyReads.set(key, { gen: generation, reply: api(path, null, { workspace }).then((value) => ({ value }), (error) => ({ error })) });
  }
  async function take(path) {
    const key = earlyKey(ws.active, path), entry = earlyReads.get(key);
    earlyReads.delete(key);
    if (entry?.gen !== generation) return api(path);
    const reply = await entry.reply;
    if (reply.error) throw reply.error;
    return reply.value;
  }
  // Before the listing returns, only the personal profile is safe to ask for:
  // a remembered company id is never sent until the listing confirms it.
  const startsPersonal = () => {
    const stored = readStoredWorkspace();
    return !stored || stored.account !== account || stored.id === account || stored.id === "personal";
  };
  const hasOwnCalendar = () => !ws.active.personal && can(ws.active, "manageOwnCalendar");
  const ownView = () => hasOwnCalendar();
  const legacySettings = () => ({ ...settings, accounts: settings.accounts.filter((a) => !a.ownerMemberId) });
  const needsReconnect = (a) => a.connected && (a.reconnectRequired === true || calendars.some((c) => c.id === a.id && c.reconnectRequired === true));
  function reconnectNotice() {
    if (!settings || section === "Availability" || !can(ws.active, "manageSettings")) return "";
    const shared = legacySettings().accounts.filter(needsReconnect), own = settings.accounts.filter((a) => a.ownerMemberId && a.ownerMemberId === bootstrap.hostId && needsReconnect(a)), accounts = shared.length ? shared : own;
    if (!accounts.length) return "";
    const href = shared.length ? connectHref() : memberConnectUrl(ws.active.id);
    return `<div class="setup-callout workspace-notice reconnect-notice" role="alert"><div><strong>Your Google Calendar connection stopped working</strong><span>Booking links that use ${esc(accounts.map((a) => a.email).join(", "))} can’t take new bookings until you reconnect.</span></div><a class="primary compact-button" data-calendar-connect href="${esc(href)}">Reconnect Google Calendar</a></div>`;
  }
  const autoSlugIds = new Set();
  let settingsBaseline = "", draftNeedsReview = false, disposeAccountMenu = () => false;
  const fingerprint = (value) => JSON.stringify([value.meetingTypes, value.accounts, value.availabilitySchedules || [], value.defaultAvailabilityScheduleId || null], (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item);
  async function loadWorkspaces() {
    let listing = null, failed = "";
    try {
      listing = await api("workspaces");
    } catch (e) {
      if (![404, 405].includes(e.status)) failed = e.message;
    }
    const next = resolveWorkspaces(listing, { account, stored: readStoredWorkspace() });
    if (linkedWorkspace) {
      const wanted = linkedWorkspace;
      linkedWorkspace = null;
      const target = !failed && next.workspaces.find((w) => w.id === wanted);
      if (target) {
        next.active = target;
        next.stale = null;
      } else {
        linkDenied = true;
        history.replaceState(null, "", location.pathname);
        message = linkDenied = failed ? "Profiles could not be loaded, so this link was not opened. Try again." : `This link is for a profile ${bootstrap.email || "this account"} cannot access. Sign in with the account that received it, or ask an admin for an invitation.`;
        ws = next;
        activeWorkspace = ws.active;
        if (!failed && !next.stale) storeWorkspace(account, ws.active);
        return;
      }
    }
    if (next.stale) {
      clearStoredWorkspace();
      message = `${next.stale.name} is no longer available. Showing your profile.`;
    } else if (failed && readStoredWorkspace()?.account === account) {
      message = "Profiles could not be loaded. Showing your profile.";
    }
    ws = next;
    activeWorkspace = ws.active;
    if (!failed) storeWorkspace(account, ws.active);
  }
  const allowed = () => sectionsFor(ws.active);
  function ensureSection() {
    if (!allowed().includes(section)) section = allowed()[0];
  }
  // Reads a load needs regardless of what it renders first.
  function prefetchFirstReads(workspace) {
    prefetch(workspace, "settings");
    prefetch(workspace, "bookings");
    if (section !== "Availability" || !workspace.personal) return;
    // The week is computed in the browser's zone; a profile in another zone misses and refetches.
    const zoneName = browserZone(), monday = currentMonday(zoneName);
    prefetch(workspace, weekPath(monday, zoneName, true));
    prefetch(workspace, weekPath(addDays(monday, 7), zoneName, true));
  }
  async function load({ first = false } = {}) {
    const gen = ++generation;
    try {
      await loadGeneration(gen, first);
    } finally {
      if (gen === generation) earlyReads.clear();
    }
  }
  async function loadGeneration(gen, first) {
    if (first) refreshContributions();
    const listed = loadWorkspaces();
    if (!linkedWorkspace && startsPersonal()) prefetchFirstReads({ personal: true });
    await listed;
    if (gen !== generation) return;
    if (first && calendarCallback && hasOwnCalendar()) {
      section = "Availability";
      const q = new URLSearchParams(location.search);
      q.delete("calendar");
      history.replaceState(null, "", location.pathname + (q.size ? "?" + q : "") + "#availability");
    }
    ensureSection();
    // The listing has confirmed this workspace, so its bookings can load beside its settings.
    prefetch(ws.active, "bookings");
    try {
      const latest = await take("settings");
      if (gen !== generation) return;
      settings = latest;
      settingsBaseline = fingerprint(settings);
      draftNeedsReview = false;
      loadError = "";
    } catch (e) {
      if (gen !== generation) return;
      settings = null;
      loadError = e.message || "Studio could not be loaded.";
      render();
      return;
    }
    if (gen !== generation) return;
    if (ws.active.personal) {
      personalName = settings.profile?.name || bootstrap.email || "Your profile";
      ws.personal.name = personalName;
    }
    savedTypeIds = new Set((settings.meetingTypes || []).map((t) => t.id));
    if (editing && !settings.meetingTypes[selected]) editing = false;
    if (first && initialLinkId) {
      const index = settings.meetingTypes.findIndex((t) => t.id === initialLinkId);
      editing = index >= 0;
      if (editing) selected = index;
    }
    await fixNewProfileZone();
    if (gen !== generation) return;
    render();
    if (section !== "Bookings") refreshBookings({ quiet: true });
    if (section === "Availability") await refreshAvailability();
    if (section === "Meetings") refreshLinkStats();
    if (section === "Analytics") await refreshAnalytics();
    if (section === "Status") await refreshOperations();
    if (section === "Team") await refreshTeam();
    if (section === "Integrations") await refreshIntegrations();
    if (section === "Activity") await refreshActivity();
    if (section === "Bookings") {
      await refreshBookings();
      if (first && initialBookingId && !linkDenied) await openBooking(initialBookingId, null);
      if (linkDenied) {
        message = linkDenied;
        status(linkDenied);
      }
    }
    if (gen !== generation) return;
    if (first && inviteToken) {
      const token = inviteToken;
      inviteToken = null;
      showInviteAcceptance(api, token, { email: bootstrap.email, onSwitchAccount: async () => {
        const r = await fetch("/auth/logout", { method: "POST" });
        if (!r.ok) throw Error("Sign out failed. Try again.");
        clearStoredWorkspace();
        location.assign("/studio");
      }, onAccepted: async (joined) => {
        await loadWorkspaces();
        const target = joined && ws.workspaces.find((w) => w.id === joined.id);
        if (target) {
          switchTo(target, `Joined ${target.name}`);
        } else render();
      } });
    }
    if (!can(ws.active, "manageSettings")) return;
    try {
      const result = await api("calendars");
      if (gen !== generation) return;
      calendars = result.accounts || [];
      calendarsLoaded = true;
      if (reconnectNotice() && !dirty) render();
      else {
        refreshTeamCalendars();
        refreshOverrideName();
      }
    } catch (e) {
      if (gen === generation) status(e.message);
    }
  }
  // On phones the account button is hidden and More opens the same menu.
  function accountOpener() {
    const trigger = document.querySelector("#account-trigger");
    return trigger?.getClientRects().length ? trigger : document.querySelector("[data-more]") || trigger;
  }
  // The editor is not re-rendered when calendars arrive (it may hold edits), so name the override in place.
  function refreshOverrideName() {
    const name = document.querySelector("[data-calendar-override] b"), t = settings?.meetingTypes?.[selected];
    if (!name || !t) return;
    const found = calendars.flatMap((a) => Array.isArray(a.calendars) ? a.calendars : a.calendars?.items ?? []).find((c) => c.id === t.calendarId);
    if (found?.summary) name.textContent = found.summary;
  }
  function resetWorkspaceState() {
    generation++;
    earlyReads.clear();
    profileExport?.controller.dispose();
    profileExport = null;
    ownLoad++;
    avUnbind();
    ownCalendar = null;
    ownLoading = false;
    ownError = "";
    av = { mode: "every", monday: null, events: [], calendars: [], nextWeek: null, status: "", loadedFor: "" };
    clearTimeout(avTimer);
    avDirty = false;
    linkStats = {};
    bookingView = "home";
    deciding = {};
    ownHoursDraft = null;
    settings = null;
    loadError = "";
    accessNotice = null;
    calendars = [];
    calendarsLoaded = false;
    bookings = [];
    bookingLoaded = false;
    bookingLoading = false;
    reconciliationIssues = [];
    notificationIssues = [];
    analyticsData = null;
    opsData = null;
    opsError = "";
    teamData = null;
    teamError = "";
    intData = null;
    actData = null;
    intError = "";
    selected = 0;
    dirty = false;
  }
  async function switchTo(target, note = "") {
    await settleAvailability();
    ws = { ...ws, active: target };
    activeWorkspace = target;
    storeWorkspace(account, target);
    resetWorkspaceState();
    ensureSection();
    message = note;
    history.replaceState(null, "", hashFor(section));
    render();
    document.querySelector("#workspace-trigger")?.focus();
    await load();
    if (note) status(note);
    requestAnimationFrame(() => {
      if (!document.querySelector("dialog[open]")) document.querySelector("#workspace-trigger")?.focus();
    });
  }
  function createProfile(trigger, onboarding = false) {
    showCreateWorkspace(api, { trigger, onboarding, onCreated: async (created) => {
      await loadWorkspaces();
      const target = ws.workspaces.find((w) => w.id === created.id) || created;
      if (!ws.workspaces.some((w) => w.id === target.id)) ws = { ...ws, workspaces: [...ws.workspaces, target] };
      editing = false;
      await switchTo(target);
    } });
  }
  function selectWorkspace(id) {
    const target = ws.workspaces.find((w) => w.id === id);
    if (target) leaveEditor(() => switchTo(target));
  }
  onCompanyRefusal = async () => {
    if (checkingAccess) return;
    checkingAccess = true;
    const current = ws.active;
    try {
      let listing;
      try {
        listing = await api("workspaces");
      } catch {
        return;
      }
      if (current !== ws.active) return;
      const latest = (listing.workspaces || []).map(cleanWorkspace).find((w) => w && w.id === current.id);
      if (!latest) {
        accessNotice = { name: current.name };
        clearStoredWorkspace();
        if (dirty) status(`You no longer have access to ${current.name}. Unsaved edits here cannot be saved.`);
        else render();
        return;
      }
      if (latest.role !== current.role) {
        ws = { ...ws, workspaces: ws.workspaces.map((w) => w.id === latest.id ? latest : w), active: latest };
        activeWorkspace = latest;
        storeWorkspace(account, latest);
        const before = section;
        ensureSection();
        message = `Your role in ${latest.name} is now ${roleLabel(latest.role)}.`;
        if (dirty && before === section) status(message);
        else {
          dirty = false;
          render();
          if (section === "Availability") await refreshAvailability();
        }
      }
    } finally {
      checkingAccess = false;
    }
  };
  const hashFor = (next) => next === "Meetings" ? editing && settings?.meetingTypes[selected] ? "#link=" + encodeURIComponent(settings.meetingTypes[selected].id) : "#links" : { Availability: "#availability", Analytics: "#stats", Status: "#status", Team: "#team", Integrations: "#integrations", Activity: "#activity" }[next] || location.pathname;
  const hostId = () => settings?.hostId || bootstrap.hostId;
  const link = (t) => `${location.origin}/b/${hostId()}/${t.slug}`;
  const sectionLabel = (name) => ({ Meetings: "Links", Analytics: "Stats", Status: "Troubleshooting" })[name] || name;
  function bookingLinks() {
    return linksMarkup({ settings, stats: linkStats, savedIds: savedTypeIds, canEdit: can(ws.active, "manageSettings"), copied: copiedLink });
  }
  function editLink(index) {
    if (!settings.meetingTypes[index]) return;
    selected = index;
    editing = true;
    message = "";
    ownHoursDraft = ownHoursOf(settings.meetingTypes[index]);
    previewDay = "";
    history.replaceState(null, "", hashFor("Meetings"));
    render();
    document.querySelector("#back-to-links")?.focus();
  }
  // The person's own availability, used by "Any time I'm available" links.
  function myAvailability() {
    if (ws.active.personal) return (settings?.availabilitySchedules || []).find((s) => s.id === settings.defaultAvailabilityScheduleId) || null;
    return ownCalendar?.schedule ? { zone: ownCalendar.schedule.zone, weeklyHours: ownCalendar.schedule.weeklyHours, dateOverrides: ownCalendar.schedule.dateOverrides || {} } : null;
  }
  function meeting() {
    if (!editing) return bookingLinks();
    const t = settings.meetingTypes[selected];
    if (!t) return "<p>No links yet.</p>";
    const ready = !ws.active.personal || settings.accounts.some((a) => a.connected && !a.ownerMemberId);
    return `${ready ? "" : `<div class="setup-callout"><div><strong>Connect your calendar to take bookings</strong></div><a class="primary compact-button" data-calendar-connect href="${esc(connectHref())}">Continue with Google</a></div>`}${editorMarkup(t, { settings, calendars, team: !ws.active.personal || !!t.teamScheduling, features: bootstrap.features, notificationSender: bootstrap.notificationSender, ownHours: t.useDefaultSchedule ? null : ownHoursDraft ?? ownHoursOf(t), dirty, openRows: editorOpenRows.id === t.id ? editorOpenRows.rows : null })}`;
  }
  const connectHref = () => "/auth/google?connect=1" + (ws.active.personal ? "" : "&workspace=" + encodeURIComponent(ws.active.id));
  function openShare(index, trigger, initialView = "share") {
    const saved = settings.meetingTypes[index], form = index === selected ? document.querySelector("#meeting-form") : null;
    let draft = saved;
    if (form) {
      try {
        draft = editorDraft(form);
      } catch (e) {
        status(e.message);
        return;
      }
    }
    const live = savedTypeIds.has(saved.id) && saved.published ? link(saved) : null;
    showShare({
      trigger,
      title: draft.title,
      liveUrl: live,
      dirty: !!form && dirty,
      initialView,
      closedState: savedTypeIds.has(saved.id) ? linkState(saved, accessFor(settings, saved.id)) : "open",
      onEdit: () => {
        if (!form) editLink(index);
        const fold = document.querySelector("[data-link-access]");
        if (fold) {
          const row = fold.closest("details.le-row");
          if (row) row.open = true;
          fold.open = true;
          fold.querySelector("summary")?.focus();
        }
      },
      onSave: form && dirty && draft.published ? () => form.requestSubmit() : void 0,
      onActivate: form && !draft.published ? () => {
        form.elements.published.checked = true;
        form.dispatchEvent(new Event("input", { bubbles: true }));
        form.requestSubmit();
      } : void 0,
      loadPreview: async (duration) => draftPreview(settings, previewDraft(draft), Date.now(), duration)
    });
  }
  const icons = { Activity: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', Availability: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 2 2 5-5"/>', Team: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5 5 0 0 1 20.5 19"/>', Integrations: '<path d="M9 7V4M15 7V4"/><rect x="6" y="7" width="12" height="6" rx="2"/><path d="M12 13v3a4 4 0 0 1-4 4"/>', Status: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>', Analytics: '<path d="M4 20h16M7 16v-5m5 5V5m5 11V8"/>', Meetings: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h5"/>', Calendars: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>', Bookings: '<path d="M8 3h8v4H8z"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 14l3 3 5-6"/>', arrow: '<path d="m9 5 7 7-7 7"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>' };
  const icon = (name) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.Bookings}</svg>`;
  const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = () => myAvailability()?.zone || browserZone();
  const fmt = (ms, opts) => new Intl.DateTimeFormat(void 0, { timeZone: zone(), ...opts }).format(ms);
  const bookingState = (b) => b.status === "cancelled" && b.successorId ? "Rescheduled" : b.status === "confirmed" && b.end < Date.now() ? "Completed" : { awaiting_approval: "Needs approval", rejected: "Declined", expired: "Expired", confirmed: "Confirmed", pending: "Confirming", cancelling: "Cancelling", cancelled: "Cancelled", failed: "Not booked" }[b.status] || b.status;
  function calendarNoticeMarkup(booking) {
    const delayed = booking.calendarSyncStatus === "pending" ? '<p class="detail-note" role="status">Calendar updates are delayed. Check the calendar connection.</p>' : "";
    const change = booking.calendarChange === "updated" ? "Updated in Google Calendar" : booking.calendarChange === "cancelled" ? "Cancelled in Google Calendar" : "";
    return delayed + (change ? `<p class="detail-note">${change}</p>` : "");
  }
  function bookingLocationMarkup(booking) {
    const url = meetingLink(booking);
    if (url) return `<dt>Location</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Join meeting</a><span>${esc(url)}</span></dd>`;
    if (booking.conferenceStatus === "pending") return '<dt>Location</dt><dd role="status">Creating Google Meet link…</dd>';
    if (booking.conferenceStatus === "failed" || booking.conferenceStatus === "ready") return '<dt>Location</dt><dd role="status">Meeting link needs attention. Check Google Calendar.</dd>';
    return booking.location ? `<dt>Location</dt><dd>${esc(booking.location)}</dd>` : "";
  }
  // ----- Bookings home and first run -----
  function attentionNotice() {
    if (!reconciliationIssues.length && !notificationIssues.length) return "";
    const auth = reconciliationIssues.some((i) => i.kind === "authorization");
    return `<div class="booking-attention" role="status"><div><strong>${auth ? "Reconnect your calendar" : reconciliationIssues.length ? "Some bookings are waiting for calendar sync" : "Some booking emails need attention"}</strong><p>${auth ? "Calendar access has expired. Reconnect to finish syncing." : reconciliationIssues.length ? "Your bookings are saved. We’ll keep trying to sync them with Google." : "Calendar bookings are saved, but email delivery needs review."}</p></div>${auth ? allowed().includes("Availability") ? '<button class="secondary" data-section="Availability">Open Availability</button>' : "" : reconciliationIssues.length ? '<button class="secondary" id="retry-sync">Retry sync</button>' : allowed().includes("Status") ? '<button class="secondary" data-section="Status">Review emails</button>' : ""}</div>`;
  }
  const setupKey = () => "scheduling-setup:" + (settings?.hostId || bootstrap.hostId || "");
  function setupProgress() {
    try {
      return JSON.parse(localStorage.getItem(setupKey()) || "{}") || {};
    } catch {
      return {};
    }
  }
  function saveSetup(next) {
    try {
      localStorage.setItem(setupKey(), JSON.stringify({ ...setupProgress(), ...next }));
    } catch {
    }
  }
  const looksNew = () => ws.active.personal && (settings?.meetingTypes || []).length === 1 && settings.meetingTypes[0].id === "intro";
  function setupStep() {
    if (!settings || !looksNew() || !bookingLoaded || bookings.length || setupProgress().shared) return 0;
    const account = settings.accounts.find((a) => a.connected && !a.ownerMemberId);
    return !account ? 1 : !setupProgress().hours ? 2 : 3;
  }
  function setupCard() {
    const step = setupStep();
    if (!step) return "";
    const account = settings.accounts.find((a) => a.connected && !a.ownerMemberId), type = settings.meetingTypes[0], hours = myAvailability();
    const destination = account && (calendars.find((c) => c.id === account.id)?.calendars || []).find?.((c) => c.id === account.destinationCalendarId)?.summary;
    return setupMarkup({ account: account?.email, destinationName: destination || (account ? "your main calendar" : ""), hours: hours ? weeklySummary(hours.weeklyHours) : "Mon–Fri 09:00–17:00", zoneName: zoneLabel(zone()).replace(/ \(.*$/, ""), duration: type.duration, linkUrl: link(type), connectHref: connectHref(), step });
  }
  // A brand-new profile starts in the service's default zone; use the person's own.
  async function fixNewProfileZone() {
    if (!looksNew() || setupProgress().hours) return;
    const availability = myAvailability(), browser = browserZone();
    if (!availability || availability.zone !== DEFAULT.zone || browser === DEFAULT.zone || weeklySummary(availability.weeklyHours) !== "Mon–Fri 09:00–17:00") return;
    try {
      const saved = await api("settings", { patch: { availabilitySchedules: settings.availabilitySchedules.map((s) => s.id === availability.id ? { ...s, zone: browser } : s) }, expectedRevision: settings.revision });
      settings = { linkAccess: settings.linkAccess, ...saved.settings, revision: saved.revision };
      settingsBaseline = fingerprint(settings);
    } catch {
    }
  }
  function bookingList(notices = "") {
    return bookingsMarkup({ bookings, view: bookingView, query: bookingQuery, searching: bookingSearching, fmt, zoneName: zoneLabel(zone()), canDecide: can(ws.active, "approveBookings"), deciding, loading: bookingLoading && !bookingLoaded, setup: bookingView === "home" ? setupCard() : "", notices: notices + attentionNotice() });
  }
  function refreshButton(id, loading) {
    return `<button class="secondary refresh-bookings" id="${id}" aria-label="Refresh" ${loading ? "disabled" : ""}>${icon("refresh")}<span>${loading ? "Refreshing…" : "Refresh"}</span></button>`;
  }
  function headingAction() {
    if (!settings) return "";
    if (section === "Analytics") return refreshButton("refresh-analytics", analyticsLoading);
    if (section === "Status") return refreshButton("refresh-operations", opsLoading);
    if (section === "Team" && canAdminister(ws.active) && teamData) return '<button class="primary compact-button" id="team-invite">Invite</button>';
    if (section === "Integrations") return integrationsHeading(intData);
    return "";
  }
  async function refreshContributions() {
    try {
      contributions = (await api("calendar-contributions")).contributions || [];
      if (!dirty) render();
    } catch {
    }
  }
  async function refreshOwnCalendar() {
    const gen = generation, request = ++ownLoad;
    ownLoading = true;
    try {
      const state = await api("my-calendar");
      if (gen !== generation || request !== ownLoad) return;
      ownCalendar = state;
      ownError = "";
    } catch (e) {
      if (gen === generation && request === ownLoad) ownError = e.message;
    } finally {
      if (gen === generation && request === ownLoad) ownLoading = false;
    }
  }
  // ----- Availability -----
  function availabilityView() {
    const personal = ws.active.personal;
    let schedule, accounts = [], editable = true, notice = "";
    if (personal) {
      const availability = myAvailability();
      if (!availability) return null;
      schedule = { zone: availability.zone, weeklyHours: availability.weeklyHours, dateOverrides: availability.dateOverrides || {} };
      accounts = settings.accounts.filter((a) => !a.ownerMemberId && a.connected).map((a) => ({ id: a.id, email: a.email, reconnect: needsReconnect(a) }));
    } else {
      if (!ownCalendar) return null;
      const s = ownCalendar.schedule, account = ownCalendar.account;
      schedule = { zone: ownCalendar.scheduleConfigured ? s.zone : browserZone(), weeklyHours: s.weeklyHours, dateOverrides: s.dateOverrides || {} };
      accounts = account && ownCalendar.readiness !== "withdrawn" && (account.connected || ownCalendar.readiness === "reconnect") ? [{ id: account.id, email: account.email, reconnect: ownCalendar.readiness === "reconnect" }] : [];
      editable = accounts.length > 0 && ownCalendar.readiness !== "reconnect";
      if (!accounts.length) notice = `<div class="setup-callout"><div><strong>Connect your calendar</strong><span>Then set the hours people can book you in ${esc(ws.active.name)}.</span></div><a class="primary compact-button" data-calendar-connect href="${esc(memberConnectUrl(ws.active.id))}">Continue with Google</a></div>`;
      else if (!ownCalendar.scheduleConfigured) notice = `<div class="setup-callout"><div><strong>Your hours</strong><span>${esc(weeklySummary(s.weeklyHours))} until you change them.</span></div><button type="button" class="secondary compact-button" data-use-hours>Use these hours</button></div>`;
    }
    const colors = new Map(av.calendars.map((c) => [c.accountId + "\n" + c.id, c.color]));
    return { schedule, mode: av.mode, monday: av.monday || currentMonday(schedule.zone), events: av.events.map((e) => ({ ...e, color: colors.get(e.accountId + "\n" + e.calendarId) })), nextWeek: av.nextWeek, calendars: av.calendars, accounts, status: av.status, scope: "person", connectHref: personal ? connectHref() : memberConnectUrl(ws.active.id), canDisconnect: personal && can(ws.active, "manageCalendars"), editable, notice, calendarsLoading: av.loading };
  }
  function weekPath(monday, zoneName, personal = ws.active.personal) {
    return `${personal ? "calendar-events" : "my-calendar/events"}?from=${zonedEpoch(monday, 0, zoneName)}&to=${zonedEpoch(addDays(monday, 7), 0, zoneName)}`;
  }
  async function fetchWeek(monday, zoneName) {
    return take(weekPath(monday, zoneName));
  }
  async function refreshAvailability({ eventsOnly = false } = {}) {
    const gen = generation;
    if (!ws.active.personal && !eventsOnly) {
      await refreshOwnCalendar();
      if (gen !== generation) return;
      if (section === "Availability") render();
    }
    const view = availabilityView();
    if (!view) return;
    av.monday ||= view.monday;
    const monday = av.monday, next = addDays(currentMonday(view.schedule.zone), 7), key = ws.active.id + monday;
    av.loading = true;
    // A week not shown yet repaints as loading. A loaded week is only marked,
    // since repainting it could interrupt a drag.
    if (av.loadedFor !== key) {
      if (section === "Availability") renderAvailability();
    } else document.querySelector("[data-av-root] .av-grid")?.setAttribute("aria-busy", "true");
    try {
      const [week, nextWeek] = await Promise.all([fetchWeek(monday, view.schedule.zone), monday === next ? null : fetchWeek(next, view.schedule.zone)]);
      if (gen !== generation || av.monday !== monday) return;
      av.events = week.events || [];
      av.calendars = week.calendars || [];
      av.nextWeek = { monday: next, events: (nextWeek || week).events || [] };
      av.loadedFor = key;
      if (av.status && !/Sav/.test(av.status)) av.status = "";
    } catch (e) {
      if (gen === generation) av.status = e.message;
    } finally {
      if (gen === generation) {
        av.loading = false;
        if (section === "Availability") renderAvailability();
      }
    }
  }
  function renderAvailability() {
    const container = document.querySelector("[data-av-root]"), view = container && availabilityView();
    if (!view) return;
    const focused = document.activeElement?.closest?.("[data-av-root]") ? document.activeElement.dataset?.day || document.activeElement.dataset?.mode || document.activeElement.dataset?.weekStep : null;
    container.innerHTML = availabilityPageMarkup(view);
    bindAvailabilityRoot(view);
    if (focused) container.querySelector(`[data-day="${focused}"],button[data-mode="${focused}"],[data-week-step="${focused}"]`)?.focus();
  }
  function bindAvailabilityRoot(view = availabilityView()) {
    avUnbind();
    const container = document.querySelector("[data-av-root]");
    if (!container || !view) return;
    avUnbind = bindAvailabilityPage(container, view, {
      onSchedule: (next) => updateSchedule(next),
      onMode: (mode) => {
        av.mode = mode;
        renderAvailability();
      },
      onWeek: (monday) => {
        av.monday = monday;
        av.events = [];
        renderAvailability();
        refreshAvailability({ eventsOnly: true });
      },
      onBusy: (accountId, ids) => saveCalendarChoice(accountId, { conflictCalendarIds: ids }),
      onDestination: (accountId, id) => saveCalendarChoice(accountId, { destinationCalendarId: id }),
      onZone: (zoneName) => updateSchedule({ ...view.schedule, zone: zoneName })
    });
    container.querySelectorAll("[data-calendar-connect]").forEach((a) => a.onclick = (event) => {
      event.preventDefault();
      leaveEditor(() => location.assign(a.href));
    });
    container.querySelectorAll("[data-disconnect]").forEach((b) => b.onclick = () => leaveEditor(() => confirmDisconnect(b.dataset.disconnect)));
    const useHours = container.querySelector("[data-use-hours]");
    if (useHours) useHours.onclick = () => updateSchedule(view.schedule);
  }
  // Inline editor rows stay open across saves and re-renders of the same link.
  let editorOpenRows = { id: null, rows: new Set() };
  // Saves as you go. Hours and calendar choices share one queue, so writes go
  // out in order and each payload is built from the latest local state when it
  // is sent (fresh revision, nothing clobbered).
  let avDirty = false, avTimer = 0, avQueue = Promise.resolve(), avPending = 0;
  function avEnqueue(task) {
    const gen = generation;
    avPending++;
    const run = avQueue.then(() => {
      avPending--;
      return gen === generation ? task() : void 0;
    });
    avQueue = run.catch(() => {
    });
    return run;
  }
  function updateSchedule(next) {
    if (ws.active.personal) {
      const availability = myAvailability();
      if (!availability) return;
      settings = { ...settings, availabilitySchedules: settings.availabilitySchedules.map((s) => s.id === availability.id ? { ...s, zone: next.zone, weeklyHours: next.weeklyHours, dateOverrides: next.dateOverrides } : s) };
    } else {
      if (!ownCalendar) return;
      ownCalendar = { ...ownCalendar, schedule: { zone: next.zone, weeklyHours: next.weeklyHours, dateOverrides: next.dateOverrides }, scheduleConfigured: true };
    }
    avDirty = true;
    av.status = "Saving…";
    renderAvailability();
    clearTimeout(avTimer);
    avTimer = setTimeout(() => avEnqueue(flushSchedule), 300);
  }
  // Before switching profiles: send what hasn't been sent yet, so nothing is lost
  // or sent to the wrong profile. Requests already in flight carry their own
  // profile and are left to finish; their results are ignored after the switch.
  function settleAvailability() {
    clearTimeout(avTimer);
    if (avDirty) avEnqueue(flushSchedule);
    return avPending ? avQueue : Promise.resolve();
  }
  async function flushSchedule() {
    if (!avDirty) return;
    avDirty = false;
    const gen = generation;
    try {
      if (ws.active.personal) {
        const local = settings.availabilitySchedules, saved = await api("settings", { patch: { availabilitySchedules: local }, expectedRevision: settings.revision });
        if (gen !== generation) return;
        settings = { linkAccess: settings.linkAccess, ...saved.settings, revision: saved.revision, ...avDirty ? { availabilitySchedules: settings.availabilitySchedules } : {} };
        settingsBaseline = fingerprint(settings);
      } else {
        const local = ownCalendar.schedule, saved = await api("my-calendar", memberCalendarPayload(ownCalendar, {}, local));
        if (gen !== generation) return;
        ownCalendar = avDirty ? { ...saved, schedule: ownCalendar.schedule } : saved;
      }
      av.status = avDirty ? "Saving…" : "Saved";
    } catch (e) {
      if (gen !== generation) return;
      av.status = e.message || "Not saved. Try again.";
      if (e.code === "settings_conflict" || e.status === 409) {
        try {
          if (ws.active.personal) settings = await api("settings");
          else ownCalendar = await api("my-calendar");
        } catch {
        }
      }
    } finally {
      if (gen === generation && section === "Availability") renderAvailability();
    }
  }
  function saveCalendarChoice(accountId, change) {
    av.calendars = av.calendars.map((c) => c.accountId !== accountId ? c : change.destinationCalendarId ? { ...c, destination: c.id === change.destinationCalendarId, busy: c.busy || c.id === change.destinationCalendarId } : { ...c, busy: change.conflictCalendarIds.includes(c.id) || c.destination });
    av.status = "Saving…";
    renderAvailability();
    return avEnqueue(async () => {
      const gen = generation;
      try {
        if (ws.active.personal) {
          const account = settings.accounts.find((a) => a.id === accountId), destination = change.destinationCalendarId || account.destinationCalendarId;
          const busy = av.calendars.filter((c) => c.accountId === accountId && c.busy).map((c) => c.id);
          await api("calendars", { accounts: [{ accountId, destinationCalendarId: destination, conflictCalendarIds: [...new Set([destination, ...busy])] }] });
          const latest = await api("settings");
          if (gen !== generation) return;
          settings = avDirty ? { ...latest, availabilitySchedules: settings.availabilitySchedules } : latest;
          settingsBaseline = fingerprint(latest);
        } else {
          const busy = av.calendars.filter((c) => c.busy).map((c) => c.id);
          const saved = await api("my-calendar", memberCalendarPayload(ownCalendar, { calendarId: change.destinationCalendarId || ownCalendar.account.calendarId, conflictCalendarIds: busy }));
          if (gen !== generation) return;
          ownCalendar = avDirty ? { ...saved, schedule: ownCalendar.schedule } : saved;
        }
        av.status = avDirty ? "Saving…" : "Saved";
        refreshAvailability({ eventsOnly: true });
      } catch (e) {
        if (gen !== generation) return;
        const error = e.message || "Not saved. Try again.";
        await refreshAvailability();
        if (gen === generation) {
          av.status = error;
          if (section === "Availability") renderAvailability();
        }
      }
    });
  }
  // Placeholder shapes in the page's own layout while its first data loads. No sample hours or rows.
  function loadingMarkup() {
    const bars = (n) => "<i></i>".repeat(n), cells = '<span></span>'.repeat(8);
    if (section === "Availability") return `<div class="sk" role="status"><span class="sr-only">Loading…</span><div class="av-head" aria-hidden="true">${bars(2)}</div><div class="av-wrap" aria-hidden="true"><div class="wk sk-week"><div class="sk-days">${cells}</div><div class="sk-hours">${cells}</div></div><div class="av-panel">${bars(5)}</div></div></div>`;
    return `<div class="sk sk-list" role="status"><span class="sr-only">Loading…</span><div aria-hidden="true">${bars(5)}</div></div>`;
  }
  function availabilityBody() {
    if (!ws.active.personal && !ownCalendar) return ownError ? `<p role="alert">${esc(ownError)}</p><button type="button" class="secondary" data-own-retry>Try again</button>` : loadingMarkup();
    const view = availabilityView();
    return view ? `<div data-av-root>${availabilityPageMarkup(view)}</div>` : loadingMarkup();
  }
  async function refreshLinkStats() {
    const gen = generation;
    try {
      const data = await api("analytics");
      if (gen !== generation) return;
      analyticsData = data;
      linkStats = Object.fromEntries(Object.entries(data.links || {}).map(([id, s]) => [id, { views: s.views || 0, confirmed: s.confirmed || 0 }]));
      // Numbers change in place, so focus and scroll stay where they are.
      if (section === "Meetings" && !editing) document.querySelectorAll("[data-link-row]").forEach((row) => {
        const t = settings?.meetingTypes?.[Number(row.dataset.linkRow)], stat = linkStats[t?.id] ?? { views: 0, confirmed: 0 }, cells = row.querySelectorAll(".lk-stat b");
        if (cells.length === 2) {
          cells[0].textContent = String(stat.confirmed);
          cells[1].textContent = String(stat.views);
        }
      });
    } catch {
    }
  }
  function sectionBody(notices = "") {
    if (!settings) return loadError ? `<div class="team-state"><p class="error" role="alert">${esc(loadError)}</p><div class="row"><button type="button" class="secondary compact-button" id="retry-load">Try again</button>${ws.active.personal ? "" : '<button type="button" class="secondary compact-button" data-workspace-personal>Back to your profile</button>'}</div></div>` : loadingMarkup();
    const time = (ms) => fmt(ms, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (section === "Meetings") return editing ? notices + meeting() : bookingLinks().replace("</header>", "</header>" + notices);
    if (section === "Availability") return availabilityBody();
    if (section === "Analytics") return analyticsData ? analyticsMarkup(analyticsData, analyticsMetric) : `<p role="status">${analyticsLoading ? "Loading stats…" : "Stats are unavailable. Try refreshing."}</p>`;
    if (section === "Status") return operationsMarkup(opsData, { loading: opsLoading, error: opsError, formatTime: time });
    if (section === "Team") return `<div class="team-workspace">${teamMarkup(teamData, { workspace: ws.active, email: bootstrap.email, loading: teamLoading, error: teamError, formatDate: (ms) => fmt(ms, { month: "short", day: "numeric" }) })}${companyCalendarsMarkup()}${teamData ? profileExportMarkup(ws.active) : ""}</div>`;
    if (section === "Integrations") return integrationsMarkup(intData, { loading: intLoading, error: intError, formatTime: time });
    if (section === "Activity") return activityMarkup(actData, { loading: actLoading, error: actError, formatTime: time, formatDate: (ms) => fmt(ms, { month: "short", day: "numeric" }), origin: location.origin, showAccount: !ws.active.personal });
    return bookingList(notices);
  }
  // Calendars an admin connected for the whole team (from before members had their own).
  function companyCalendarsMarkup() {
    if (ws.active.personal || !canAdminister(ws.active) || !settings) return "";
    const legacy = legacySettings().accounts;
    if (!legacy.length) return "";
    return `<section class="team-block" aria-labelledby="company-calendars-title"><div class="team-block-head"><h2 id="company-calendars-title">Company calendars</h2><span class="team-count">${legacy.length}</span></div><ul class="team-list">${legacy.map((a) => {
      const [state, label] = !a.connected ? ["disconnected", "Not connected"] : needsReconnect(a) ? ["reconnect", "Reconnect needed"] : ["connected", "Connected"];
      return `<li class="member-calendar-row"><strong title="${esc(a.email)}">${esc(a.email)}</strong><span class="connection-state" data-state="${state}">${label}</span>${state === "connected" ? `<button type="button" class="quiet-button" data-disconnect="${esc(a.id)}">Disconnect</button>` : `<a class="secondary compact-button" data-calendar-connect href="${esc(connectHref())}">Reconnect</a>`}</li>`;
    }).join("")}</ul></section>`;
  }
  function render() {
    avUnbind();
    const accountMenuWasOpen = disposeAccountMenu();
    const focusedSection = document.activeElement?.dataset?.section;
    document.documentElement.dataset.theme = localStorage.getItem("scheduling-theme") || "light";
    document.documentElement.dataset.accent = "graphite";
    const company = ws.active.personal ? null : ws.active, profile = settings?.profile || {};
    document.title = (section === "Meetings" && editing && settings?.meetingTypes[selected] ? settings.meetingTypes[selected].title : sectionLabel(section)) + " · " + (company ? company.name + " · " : "") + studioName(brand);
    const name = company ? personalName : profile.name, avatar = company ? "" : profile.avatarImage;
    const requests = bookings.filter(isRequest).length, primary = allowed().filter((x) => ["Bookings", "Meetings", "Availability", "Activity"].includes(x)), setupSections = allowed().filter((x) => ["Team", "Integrations"].includes(x));
    const navButton = (x) => `<button data-section="${x}" ${section === x ? 'aria-current="page"' : ""} class="${section === x ? "active" : ""}">${icon(x)}<span>${sectionLabel(x)}</span>${x === "Bookings" && requests ? `<span class="nav-count" aria-label="${requests} waiting for your OK">${requests}</span>` : ""}</button>`;
    const ownHead = section === "Bookings" || section === "Meetings";
    const notices = `${accessNotice ? `<div class="setup-callout workspace-notice" role="alert"><div><strong>You no longer have access to ${esc(accessNotice.name)}</strong></div><button class="secondary compact-button" data-workspace-personal>Back to your profile</button></div>` : ""}${reconnectNotice()}<p id="host-status" class="${message ? "has-message" : ""}" role="status">${esc(message)}</p>`;
    const heading = section === "Analytics" && allowed().includes("Meetings") ? `<div><button type="button" class="back-to-links" data-section="Meetings">← Links</button><h1>Stats</h1></div>` : `<div><h1>${sectionLabel(section)}</h1></div>`;
    const moreSections = [...allowed().includes("Activity") ? ["Activity"] : [], ...setupSections, ...allowed().includes("Analytics") ? ["Analytics"] : []].map((x) => [x, sectionLabel(x)]);
    root.innerHTML = `<div class="host-console"><aside class="host-nav"><div class="host-brand"><a class="wordmark" href="/studio"><span class="host-logo">${esc(brandMark(brand))}</span>${esc(brand.productName)}</a>${switcherMarkup({ ...ws, workspaces: ws.workspaces.map((w) => w.personal ? { ...w, name: personalName || bootstrap.email || "Your profile" } : w), active: { ...ws.active, ...ws.active.personal ? { name: personalName || bootstrap.email || "Your profile" } : {}, avatarImage: profile.avatarImage } })}</div><nav aria-label="Scheduling">${primary.map(navButton).join("")}${setupSections.length ? `<p class="nav-group" aria-hidden="true">Setup</p>${setupSections.map(navButton).join("")}` : ""}</nav>${accountMenuMarkup({ name: name || "Your account", email: bootstrap.email, avatar, editProfile: can(ws.active, "manageSettings") && !!settings, editPicture: !!settings && !company && can(ws.active, "manageSettings"), troubleshooting: allowed().includes("Status"), issues: attentionCount(opsData), calendarAccess: contributions.length > 0, dark: document.documentElement.dataset.theme === "dark", sections: moreSections })}<div class="host-legal">${legalLinksMarkup(brand)}</div></aside><main class="host-content" id="main">${ownHead ? sectionBody(notices) : `<header class="host-heading">${heading}${headingAction()}</header>${notices}${sectionBody()}`}</main><nav class="tabbar" aria-label="Sections">${primary.filter((x) => x !== "Activity").map((x) => `<button type="button" data-section="${x}" ${section === x ? 'aria-current="page"' : ""}>${icon(x)}<span>${sectionLabel(x)}</span>${x === "Bookings" && requests ? `<em aria-label="${requests} waiting">${requests}</em>` : ""}</button>`).join("")}<button type="button" data-more aria-label="More">${icon("more")}<span>More</span></button></nav></div>`;
    bind();
    alignNavigation();
    if (accountMenuWasOpen) accountOpener()?.focus({ preventScroll: true });
    if (focusedSection === section) root.querySelector(`.host-nav [data-section="${section}"]`)?.focus({ preventScroll: true });
  }
  function alignNavigation() {
    const nav = root.querySelector(".host-nav nav"), current = nav?.querySelector("[aria-current=page]");
    if (nav && current && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = current.offsetLeft - nav.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
  }
  window.addEventListener("resize", alignNavigation);
  async function refreshTeam() {
    const gen = generation, restore = document.activeElement?.id;
    teamLoading = true;
    if (!teamData) render();
    try {
      const result = await api("workspace");
      if (gen !== generation) return;
      teamData = result;
      teamError = "";
      if (hasOwnCalendar()) {
        try {
          if (canAdminister(ws.active)) {
            const readiness = await api("member-calendars");
            if (gen !== generation) return;
            teamData = { ...result, members: (result.members || []).map((m) => ({ ...m, ...(readiness.members || []).find((r) => r.id === m.id) })) };
          } else {
            const mine = await api("my-calendar/readiness");
            if (gen !== generation) return;
            teamData = { ...result, members: (result.members || []).map((m) => m.email?.toLowerCase() === bootstrap.email?.toLowerCase() ? { ...m, readiness: mine.readiness } : m) };
          }
        } catch {
        }
      }
      const latest = cleanWorkspace(result.workspace);
      if (latest && latest.id === ws.active.id && latest.role !== ws.active.role) {
        ws = { ...ws, active: latest, workspaces: ws.workspaces.map((w) => w.id === latest.id ? latest : w) };
        activeWorkspace = latest;
        storeWorkspace(account, latest);
      }
    } catch (e) {
      if (gen !== generation) return;
      teamError = e.message || "Team could not be loaded.";
    } finally {
      if (gen === generation) {
        teamLoading = false;
        render();
        if (restore) document.getElementById(restore)?.focus();
      }
    }
  }
  async function refreshActivity() {
    const gen = generation;
    actLoading = true;
    if (!actData) render();
    try {
      const result = await loadActivity(api);
      if (gen !== generation) return;
      actData = result;
      actError = "";
    } catch (e) {
      if (gen !== generation) return;
      actError = e.message || "Activity could not be loaded.";
    } finally {
      if (gen === generation) {
        actLoading = false;
        render();
      }
    }
  }
  async function refreshIntegrations() {
    const gen = generation;
    intLoading = true;
    if (!intData) render();
    try {
      const result = await api("integrations");
      if (gen !== generation) return;
      if (!Array.isArray(result?.integrations)) throw Error("Integrations are not available on this service yet.");
      intData = result;
      intError = "";
      message = "";
    } catch (e) {
      if (gen !== generation) return;
      intError = e.message || "Integrations could not be loaded.";
    } finally {
      if (gen === generation) {
        intLoading = false;
        render();
      }
    }
  }
  async function refreshAnalytics() {
    const gen = generation, restore = document.activeElement?.id === "refresh-analytics";
    analyticsLoading = true;
    render();
    try {
      const data = await api("analytics");
      if (gen !== generation) return;
      analyticsData = data;
      message = "";
    } catch (e) {
      if (gen !== generation) return;
      message = e.message;
    } finally {
      if (gen !== generation) return;
      analyticsLoading = false;
      render();
      if (restore) document.querySelector("#refresh-analytics")?.focus();
    }
  }
  async function refreshOperations() {
    const gen = generation;
    opsLoading = true;
    render();
    try {
      const data = await api("operations");
      if (gen !== generation) return;
      opsData = data;
      opsError = "";
    } catch (e) {
      if (gen !== generation) return;
      opsError = e.message || "Status could not be loaded.";
    } finally {
      if (gen === generation) {
        opsLoading = false;
        render();
      }
    }
  }
  async function refreshBookings({ quiet = false } = {}) {
    const gen = generation, before = bookings.filter(isRequest).length;
    bookingLoading = true;
    if (!quiet) render();
    try {
      const result = await take("bookings");
      if (gen !== generation) return;
      bookings = result.bookings || [];
      reconciliationIssues = result.reconciliationIssues || [];
      notificationIssues = result.notificationIssues || [];
      bookingLoaded = true;
      if (!quiet) message = "";
    } catch (e) {
      if (gen !== generation) return;
      if (!quiet) message = e.message;
    } finally {
      if (gen === generation) {
        bookingLoading = false;
        if (!quiet || !dirty && (section === "Bookings" || bookings.filter(isRequest).length !== before)) render();
      }
    }
  }
  async function navigate(next) {
    if (next === "Calendars") next = "Availability";
    if (!allowed().includes(next)) return;
    section = next;
    if (next === "Meetings") editing = false;
    if (next === "Bookings") bookingView = "home";
    history.replaceState(null, "", hashFor(next));
    message = "";
    render();
    if (!settings) return;
    if (next === "Bookings") await refreshBookings();
    if (next === "Meetings") refreshLinkStats();
    if (next === "Status") await refreshOperations();
    if (next === "Analytics") await refreshAnalytics();
    if (next === "Team") await refreshTeam();
    if (next === "Integrations") await refreshIntegrations();
    if (next === "Activity") await refreshActivity();
    if (next === "Availability") await refreshAvailability();
  }
  async function openBooking(id, trigger, { confirmCancel = false, reschedule = false } = {}) {
    const dialog = document.createElement("dialog");
    dialog.className = "booking-dialog";
    dialog.setAttribute("aria-label", "Booking details");
    document.body.append(dialog);
    let detail, confirming = confirmCancel, working = false, decisionKey = crypto.randomUUID(), reasonDraft = "";
    const close = () => {
      if (!working) dialog.close();
    };
    dialog.addEventListener("cancel", (e) => {
      if (working) e.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector(`[data-manage="${CSS.escape(id)}"]`)?.focus();
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) close();
    });
    function draw(error = "") {
      const b = detail?.booking;
      dialog.innerHTML = `<div class="booking-detail-head"><span>Booking details</span><button class="icon-button" data-close aria-label="Close booking details">${icon("close")}</button></div>${b ? `<div class="booking-detail-body"><span class="booking-badge state-${esc(b.status)}">${esc(bookingState(b))}</span><h2>${esc(b.title)}</h2><p class="detail-when">${esc(fmt(b.start, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}<br>${esc(fmt(b.start, { hour: "2-digit", minute: "2-digit", hour12: false }))}–${esc(fmt(b.end, { hour: "2-digit", minute: "2-digit", hour12: false }))}<span>${Math.round((b.end - b.start) / 6e4)} min · ${esc(zoneLabel(zone()))}</span></p><dl class="booking-detail-list"><dt>Guest</dt><dd><strong>${esc(b.name)}</strong><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>${bookingLocationMarkup(b)}${savedIntakeMarkup(b)}${b.cancellationReason ? `<dt>Cancellation reason</dt><dd class="cancel-reason">${esc(b.cancellationReason)}</dd>` : ""}</dl>${b.successorId ? '<p class="detail-note">This booking was replaced by a new time.</p>' : ""}${calendarNoticeMarkup(b)}${approvalNotice(b, { host: true })}${deliveryMarkup(b, (ms) => fmt(ms, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }))}${error ? `<p class="error" role="alert">${esc(error)}</p><button class="secondary compact-button" data-refresh-detail>Refresh request</button>` : ""}</div><footer class="booking-detail-footer">${b.status === "awaiting_approval" && can(ws.active, "approveBookings") ? `<button class="danger-quiet" data-decision="reject" ${working ? "disabled" : ""}>Decline request</button><button class="primary" data-decision="approve" ${working ? "disabled" : ""}>${working ? "Saving…" : "Approve booking"}</button>` : b.status === "confirmed" && b.end > Date.now() && (detail.managementToken || detail.hostActions?.manage) ? confirming ? `<p>Cancel this meeting?<span>The guest will receive a calendar update.</span></p><div class="host-cancel-confirm"><label for="host-cancel-reason" class="cancel-reason-label">Reason <span class="optional">(optional)</span></label><textarea id="host-cancel-reason" data-cancel-reason maxlength="${REASON_MAX}" ${working ? "disabled" : ""}>${esc(reasonDraft)}</textarea></div><div class="row"><button class="secondary" data-keep>Keep booking</button><button class="danger-button" data-cancel ${working ? "disabled" : ""}>${working ? "Cancelling…" : "Cancel booking"}</button></div>` : `<button type="button" class="secondary" data-host-reschedule>Reschedule</button><button class="danger-quiet" data-ask>Cancel booking</button>` : `<button class="secondary" data-close>Done</button>`}</footer>` : `<div class="booking-detail-body"><p role="status">${esc(error || "Loading booking…")}</p>${error ? '<button class="secondary" data-retry>Try again</button>' : ""}</div>`}`;
      const refreshEmails = dialog.querySelector("[data-refresh-delivery]");
      if (refreshEmails) refreshEmails.onclick = async () => {
        refreshEmails.disabled = true;
        refreshEmails.textContent = "Refreshing…";
        await loadDetail();
        dialog.querySelector("[data-refresh-delivery]")?.focus();
      };
      const refreshDetail = dialog.querySelector("[data-refresh-detail]");
      if (refreshDetail) refreshDetail.onclick = loadDetail;
      dialog.querySelectorAll("[data-decision]").forEach((button) => button.onclick = async () => {
        if (working) return;
        const action = button.dataset.decision;
        working = true;
        draw();
        try {
          const result = await api("bookings/" + encodeURIComponent(id) + "/decision", { action, expectedVersion: detail.booking.version, key: decisionKey });
          detail.booking = { ...detail.booking, ...result.booking };
          decisionKey = crypto.randomUUID();
          bookings = bookings.map((b2) => b2.id === id ? result.booking : b2);
          render();
          draw();
          await loadDetail();
          dialog.querySelector("[data-close]")?.focus();
        } catch (e) {
          draw(e.message);
        } finally {
          working = false;
          dialog.querySelectorAll("[data-decision]").forEach((b2) => {
            b2.disabled = false;
            if (b2.dataset.decision === "approve") b2.textContent = "Approve booking";
          });
        }
      });
      dialog.querySelectorAll("[data-close]").forEach((b2) => b2.onclick = close);
      const retry = dialog.querySelector("[data-retry]");
      if (retry) retry.onclick = loadDetail;
      const move = dialog.querySelector("[data-host-reschedule]");
      if (move) move.onclick = () => showHostReschedule({ booking: detail.booking, api, trigger: move, onSaved: async (result) => {
        dialog.close();
        await refreshBookings();
        if (result.booking?.id) await openBooking(result.booking.id, null);
      } });
      const ask = dialog.querySelector("[data-ask]");
      if (ask) ask.onclick = () => {
        confirming = true;
        draw();
        dialog.querySelector("[data-keep]").focus();
      };
      const keep = dialog.querySelector("[data-keep]");
      if (keep) keep.onclick = () => {
        confirming = false;
        draw();
        dialog.querySelector("[data-ask]").focus();
      };
      const cancel = dialog.querySelector("[data-cancel]");
      const reasonInput = dialog.querySelector("[data-cancel-reason]");
      if (reasonInput) reasonInput.oninput = () => {
        reasonDraft = reasonInput.value;
      };
      if (cancel) cancel.onclick = async () => {
        if (working) return;
        if (reasonInput) reasonDraft = reasonInput.value;
        const reason = cleanReason(reasonDraft);
        working = true;
        draw();
        try {
          const data = await api("bookings/" + encodeURIComponent(id) + "/cancel", reason ? { reason } : {});
          detail.booking = { ...detail.booking, ...data.booking };
          bookings = bookings.map((b2) => b2.id === id ? data.booking : b2);
          confirming = false;
          reasonDraft = "";
          render();
          draw();
          await loadDetail();
          dialog.querySelector("[data-close]").focus();
        } catch (e) {
          draw(e.message);
        } finally {
          working = false;
          const b2 = dialog.querySelector("[data-cancel]");
          if (b2) {
            b2.disabled = false;
            b2.textContent = "Cancel booking";
          }
          const r = dialog.querySelector("[data-cancel-reason]");
          if (r) r.disabled = false;
        }
      };
    }
    async function loadDetail() {
      try {
        detail = await api("bookings/" + encodeURIComponent(id));
        if (dialog.isConnected) draw();
      } catch (e) {
        if (dialog.isConnected) draw(e.message);
      }
    }
    draw();
    dialog.showModal();
    await loadDetail();
    if (confirmCancel) dialog.querySelector("[data-keep]")?.focus();
    if (reschedule && dialog.isConnected) dialog.querySelector("[data-host-reschedule]")?.click();
  }
  function status(text) {
    message = text;
    const el = document.querySelector("#host-status");
    if (el) {
      el.textContent = text;
      el.classList.toggle("has-message", !!text);
    }
  }
  function offerReload() {
    const area = document.querySelector("#host-status");
    if (!area) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet-button";
    button.textContent = "Review latest settings";
    area.append(" ", button);
    button.onclick = () => {
      let reloaded = false;
      const dialog = document.createElement("dialog");
      dialog.className = "unsaved-dialog";
      dialog.setAttribute("aria-label", "Settings changed");
      dialog.innerHTML = '<h2>Settings changed elsewhere</h2><p>Your edits are still here. Load the latest saved settings to review what changed. This discards your unsaved edits.</p><div class="row"><button class="secondary" data-keep>Keep editing</button><button class="primary" data-reload>Load latest settings</button></div>';
      document.body.append(dialog);
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (!reloaded && button.isConnected) button.focus();
      });
      dialog.querySelector("[data-keep]").onclick = () => dialog.close();
      dialog.querySelector("[data-reload]").onclick = async (event) => {
        const reloadButton = event.currentTarget;
        reloadButton.disabled = true;
        try {
          const latest = await api("settings");
          if (!dialog.isConnected) return;
          const id = settings.meetingTypes[selected]?.id;
          settings = latest;
          settingsBaseline = fingerprint(latest);
          draftNeedsReview = false;
          selected = Math.max(0, settings.meetingTypes.findIndex((type) => type.id === id));
          savedTypeIds = new Set(settings.meetingTypes.map((type) => type.id));
          dirty = false;
          message = "Latest settings loaded";
          reloaded = true;
          dialog.close();
          render();
          requestAnimationFrame(() => document.querySelector("[name=title]")?.focus());
        } catch (error) {
          status(error.message);
          reloadButton.disabled = false;
        }
      };
      dialog.showModal();
      dialog.querySelector("[data-keep]").focus();
    };
  }
  function confirmRemoveType(trigger) {
    const type = settings.meetingTypes[selected];
    if (!type) return;
    const dialog = document.createElement("dialog");
    dialog.className = "unsaved-dialog";
    dialog.setAttribute("aria-label", "Remove meeting link");
    dialog.innerHTML = `<h2>Remove ${esc(type.title)}?</h2><p>This booking page and its rescheduling link will stop working. Existing bookings and calendar events stay. Pause bookings instead if you want to use this link again.</p><p class="error" role="alert"></p><div class="row"><button class="secondary" data-keep>Keep link</button><button class="danger-button" data-remove>Remove link</button></div>`;
    document.body.append(dialog);
    let working = false;
    dialog.addEventListener("cancel", (e) => {
      if (working) e.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger.isConnected) trigger.focus();
    });
    dialog.querySelector("[data-keep]").onclick = () => dialog.close();
    dialog.querySelector("[data-remove]").onclick = async () => {
      if (working) return;
      working = true;
      dialog.querySelectorAll("button").forEach((b) => b.disabled = true);
      try {
        const types = settings.meetingTypes.filter((t) => t.id !== type.id);
        if (savedTypeIds.has(type.id)) {
          const saved = await api("settings", { patch: { meetingTypes: types }, expectedRevision: settings.revision });
          settings = { linkAccess: settings.linkAccess, ...saved.settings, revision: saved.revision };
        } else settings = { ...settings, meetingTypes: types };
        savedTypeIds = new Set(settings.meetingTypes.map((t) => t.id));
        selected = Math.max(0, Math.min(selected, settings.meetingTypes.length - 1));
        editing = false;
        dirty = false;
        history.replaceState(null, "", location.pathname);
        message = "Meeting link removed";
        dialog.close();
        render();
        document.querySelector("[data-type]")?.focus();
      } catch (error) {
        dialog.querySelector("[role=alert]").textContent = error.message;
        working = false;
        dialog.querySelectorAll("button").forEach((b) => b.disabled = false);
      }
    };
    dialog.showModal();
    dialog.querySelector("[data-keep]").focus();
  }
  function busy(fn) {
    return async (e) => {
      const b = e.currentTarget, gen = generation;
      b.disabled = true;
      try {
        await fn(e, gen);
      } catch (error) {
        if (gen === generation) status(error.message);
      } finally {
        b.disabled = false;
      }
    };
  }
  function syncAppearance(form) {
    const card = form.querySelector(".profile-brand-preview");
    if (!card) return;
    const values = new FormData(form);
    card.dataset.theme = values.get("theme");
    card.dataset.accent = values.get("accent");
    card.dataset.motion = values.get("motion");
    card.querySelector(".brand-meeting-title").textContent = values.get("title") || settings.meetingTypes[selected].title;
    const description = card.querySelector(".brand-description");
    description.textContent = values.get("description") || "";
    description.hidden = !description.textContent;
    card.querySelector(".brand-duration").textContent = "◷ " + values.get("duration") + " min";
    card.querySelector(".brand-location").textContent = values.get("locationType") === "google_meet" ? "Google Meet" : values.get("location") || "";
  }
  function bindProfileButtons() {
    document.querySelectorAll("[data-profile]").forEach((button) => button.onclick = () => {
      const trigger = button.closest("#account-menu") ? accountOpener() : button;
      const gen = generation, profileApi = (path, data) => {
        if (gen !== generation) throw Error("The profile changed. Choose the image again.");
        return api(path, data);
      }, key = button.dataset.profile === "banner" ? "bannerImage" : "avatarImage", selector = `[data-profile="${button.dataset.profile}"]`, restore = () => gen === generation ? (button.closest("#account-menu") ? accountOpener() : document.querySelector(selector)) : null;
      const merge = (latest) => {
        if (gen !== generation) return;
        if (dirty) {
          if (fingerprint(latest) !== settingsBaseline) draftNeedsReview = true;
          settings = { ...settings, profile: latest.profile, revision: latest.revision };
        } else {
          settings = { ...latest };
          settingsBaseline = fingerprint(latest);
          draftNeedsReview = false;
          if (!settings.meetingTypes[selected]) editing = false;
        }
      };
      const saved = (result) => {
        if (gen !== generation) return;
        status("");
        merge({ ...result.settings, revision: result.revision });
        if (ws.active.personal) {
          personalName = settings.profile.name || bootstrap.email;
          ws.personal.name = personalName;
        }
        if (!dirty) {
          render();
          requestAnimationFrame(() => restore()?.focus());
          return;
        }
        const preview = document.querySelector(".appearance-preview");
        if (preview) {
          const form = document.querySelector("#meeting-form"), type = { ...settings.meetingTypes[selected] };
          for (const name of ["title", "description", "location", "locationType", "theme", "accent", "motion"]) {
            const field2 = form?.elements[name];
            if (field2) type[name] = field2.value;
          }
          type.duration = Number(form?.elements.duration?.value || type.duration);
          preview.innerHTML = profilePreview(settings.profile, type);
        }
        const mark = document.querySelector(".workspace-trigger .workspace-mark");
        if (mark) mark.innerHTML = settings.profile.avatarImage ? `<img src="${esc(settings.profile.avatarImage)}" alt="">` : esc((settings.profile.name || "?").slice(0, 1));
        const avatar = document.querySelector(".host-identity .host-avatar");
        if (avatar && ws.active.personal) avatar.innerHTML = settings.profile.avatarImage ? `<img src="${esc(settings.profile.avatarImage)}" alt="">` : esc((personalName || "?").slice(0, 1));
        const identity = document.querySelector(".host-identity strong");
        if (identity && ws.active.personal) identity.textContent = personalName;
        bindProfileButtons();
      };
      if (["banner", "picture", "avatar"].includes(button.dataset.profile)) changeProfileImage(profileApi, { key, isCurrent: () => gen === generation, profile: settings.profile, revision: settings.revision, trigger, restore, onSaved: saved, onLoaded: merge, onError: (e) => {
        if (gen === generation) status(e.message);
      } });
      else showProfile(profileApi, settings.profile, settings.revision, { trigger, onLoaded: merge, onSaved: saved });
    });
  }
  function bind() {
    disposeAccountMenu = bindAccountMenu(root);
    if (section === "Analytics" && analyticsData) bindAnalytics(document.querySelector(".analytics-workspace"), analyticsData, (metric) => {
      analyticsMetric = metric;
    });
    bindProfileButtons();
    document.querySelectorAll("[data-section]").forEach((b) => b.onclick = () => leaveEditor(() => navigate(b.dataset.section)));
    document.querySelector("[data-more]")?.addEventListener("click", () => document.querySelector("#account-trigger")?.click());
    document.querySelectorAll("[data-type]").forEach((b) => b.onclick = () => leaveEditor(() => editLink(Number(b.dataset.type))));
    document.querySelector("[data-own-retry]")?.addEventListener("click", () => refreshAvailability());
    if (section === "Availability") bindAvailabilityRoot();
    if (section === "Meetings" && !editing) bindLinks();
    if (section === "Meetings" && editing) bindEditor();
    if (section === "Bookings") bindBookings();
    document.querySelectorAll("[data-calendar-connect]").forEach((a) => a.onclick = (event) => {
      event.preventDefault();
      leaveEditor(() => location.assign(a.href));
    });
    document.querySelectorAll("[data-disconnect]").forEach((b) => b.onclick = () => leaveEditor(() => confirmDisconnect(b.dataset.disconnect)));
    const retrySync = document.querySelector("#retry-sync");
    if (retrySync) retrySync.onclick = busy(async (_e, gen) => {
      await api("repair", {});
      if (gen === generation) await refreshBookings();
    });
    const analyticsRefresh = document.querySelector("#refresh-analytics");
    if (analyticsRefresh) analyticsRefresh.onclick = refreshAnalytics;
    const opsRefresh = document.querySelector("#refresh-operations");
    if (opsRefresh) opsRefresh.onclick = async () => {
      await refreshOperations();
      document.querySelector("#refresh-operations")?.focus();
    };
    const opsRepair = document.querySelector("#ops-repair");
    if (opsRepair) opsRepair.onclick = async () => {
      const gen = generation;
      opsRepair.disabled = true;
      opsRepair.textContent = "Running…";
      let text = "Done";
      try {
        await api("repair", {});
      } catch (e) {
        text = e.message;
      }
      if (gen !== generation) return;
      await refreshOperations();
      if (gen !== generation) return;
      status(text);
      document.querySelector("#refresh-operations")?.focus();
    };
    document.querySelectorAll("[data-ops-booking]").forEach((b) => b.onclick = () => openBooking(b.dataset.opsBooking, b));
    document.querySelectorAll("[data-ops-resolve]").forEach((b) => b.onclick = () => {
      const item = opsData?.deliveries?.review?.items?.[Number(b.dataset.opsResolve)];
      if (!item) return;
      showResolveDialog(item, { api, trigger: b, formatTime: (ms) => fmt(ms, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), onDone: async (text) => {
        await refreshOperations();
        if (text) {
          status(text);
          const next = document.querySelector("[data-ops-resolve]") || document.querySelector("#refresh-operations");
          next?.focus();
        }
      } });
    });
    document.querySelector("#host-theme").onclick = () => leaveEditor(() => {
      localStorage.setItem("scheduling-theme", document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      render();
      accountOpener()?.focus();
    });
    document.querySelector("#calendar-access")?.addEventListener("click", () => leaveEditor(() => showCalendarAccess({ api, workspaceName: (id) => ws.workspaces.find((w) => w.id === id)?.name || "Former team", trigger: accountOpener(), onChanged: async () => {
      ownLoad++;
      ownCalendar = null;
      try {
        contributions = (await api("calendar-contributions")).contributions || [];
      } catch {
      }
      if (section === "Availability") await refreshAvailability();
      render();
    } })));
    document.querySelector("#manage-account").onclick = () => {
      const trigger = accountOpener();
      leaveEditor(() => showManageAccount({ email: bootstrap.email, accountId: bootstrap.hostId, trigger, onSessions: (button) => showSessions(api, button) }));
    };
    document.querySelector("#sign-out").onclick = () => leaveEditor(async () => {
      await fetch("/auth/logout", { method: "POST" });
      clearStoredWorkspace();
      clearPendingInvite();
      location.reload();
    });
    bindSwitcher(root, { onSelect: selectWorkspace, onCreate: (trigger) => leaveEditor(() => createProfile(trigger)) });
    document.querySelectorAll("[data-workspace-personal]").forEach((b) => b.onclick = () => leaveEditor(() => switchTo(ws.personal)));
    const retryLoad = document.querySelector("#retry-load");
    if (retryLoad) retryLoad.onclick = () => load();
    const main = document.querySelector("#main");
    if (section === "Team" && settings) {
      document.querySelector("[data-team-connect-own]")?.addEventListener("click", () => navigate("Availability"));
      bindTeam(main, { api, getData: () => teamData, workspace: ws.active, email: bootstrap.email, reload: refreshTeam, status, formatDate: (ms) => fmt(ms, { month: "short", day: "numeric" }), onOwnershipChanged: async () => {
        await loadWorkspaces();
        ensureSection();
        await refreshTeam();
      }, onLeft: async () => {
        const name = ws.active.name;
        clearStoredWorkspace();
        await switchTo(ws.personal, `You left ${name}`);
      } });
      const invite = document.querySelector("#team-invite");
      if (invite) invite.onclick = () => showInviteDialog(api, { workspace: ws.active, trigger: invite, formatDate: (ms) => fmt(ms, { month: "short", day: "numeric" }), onInvited: refreshTeam });
    }
    bindProfileExport();
    if (section === "Integrations" && settings) bindIntegrations(main, { api, getData: () => intData, reload: refreshIntegrations, status });
    if (section === "Activity" && settings) bindActivity(main, { data: () => actData, reload: refreshActivity, status, openBooking });
  }
  // ----- Bookings -----
  function bindBookings() {
    document.querySelectorAll("[data-manage]").forEach((b) => b.onclick = () => openBooking(b.dataset.manage, b));
    document.querySelectorAll("[data-bookings-view]").forEach((b) => b.onclick = () => {
      bookingView = b.dataset.bookingsView;
      render();
      document.querySelector(bookingView === "home" ? "#main h1" : "[data-bookings-view=home]")?.focus();
    });
    const openSearch = document.querySelector("[data-booking-search-open]");
    if (openSearch) openSearch.onclick = () => {
      bookingSearching = true;
      render();
      document.querySelector("#booking-search")?.focus();
    };
    const search = document.querySelector("#booking-search");
    if (search) {
      search.oninput = () => {
        bookingQuery = search.value;
        const position = search.selectionStart;
        render();
        const next = document.querySelector("#booking-search");
        next?.focus();
        next?.setSelectionRange(position, position);
      };
      search.onkeydown = (event) => {
        if (event.key === "Escape") {
          bookingQuery = "";
          bookingSearching = false;
          render();
          document.querySelector("[data-booking-search-open]")?.focus();
        }
      };
    }
    document.querySelectorAll("[data-decide-ask]").forEach((b) => b.onclick = () => {
      deciding = { ...deciding, [b.dataset.decideAsk]: "confirm-reject" };
      render();
      document.querySelector(`[data-decide-keep="${CSS.escape(b.dataset.decideAsk)}"]`)?.focus();
    });
    document.querySelectorAll("[data-decide-keep]").forEach((b) => b.onclick = () => {
      const { [b.dataset.decideKeep]: _, ...rest } = deciding;
      deciding = rest;
      render();
      document.querySelector(`[data-decide-ask="${CSS.escape(b.dataset.decideKeep)}"]`)?.focus();
    });
    document.querySelectorAll("[data-decide]").forEach((b) => b.onclick = async () => {
      const id = b.dataset.bookingId, action = b.dataset.decide, booking = bookings.find((x) => x.id === id), gen = generation;
      if (!booking || deciding[id] === "approve" || deciding[id] === "reject") return;
      deciding = { ...deciding, [id]: action };
      render();
      try {
        const result = await api("bookings/" + encodeURIComponent(id) + "/decision", { action, expectedVersion: booking.version, key: crypto.randomUUID() });
        if (gen !== generation) return;
        bookings = bookings.map((x) => x.id === id ? { ...x, ...result.booking } : x);
        message = action === "approve" ? `Approved ${booking.name}` : `Declined ${booking.name}`;
      } catch (e) {
        if (gen === generation) message = e.message;
      } finally {
        if (gen === generation) {
          const { [id]: _, ...rest } = deciding;
          deciding = rest;
          render();
          refreshBookings({ quiet: true });
        }
      }
    });
    document.querySelectorAll("[data-row-menu]").forEach((b) => b.onclick = () => {
      const id = b.dataset.rowMenu, booking = bookings.find((x) => x.id === id), manage = booking?.status === "confirmed" && booking.end > Date.now();
      showRowMenu(b, [...manage ? [["reschedule", "Reschedule"], ["cancel", "Cancel", true]] : [], ["details", "Details"]], (pick) => openBooking(id, b, { confirmCancel: pick === "cancel", reschedule: pick === "reschedule" }));
    });
    const hoursOk = document.querySelector("[data-setup-hours]");
    if (hoursOk) hoursOk.onclick = () => {
      saveSetup({ hours: true });
      render();
      document.querySelector("[data-setup-copy]")?.focus();
    };
    const copySetup = document.querySelector("[data-setup-copy]");
    if (copySetup) copySetup.onclick = busy(async (_e, gen) => {
      await navigator.clipboard.writeText(link(settings.meetingTypes[0]));
      if (gen !== generation) return;
      saveSetup({ shared: true });
      message = "Link copied";
      render();
    });
  }
  // ----- Links -----
  function bindLinks() {
    document.querySelectorAll("[data-copy-booking-link]").forEach((b) => b.onclick = busy(async (_event, gen) => {
      const type = settings.meetingTypes[Number(b.dataset.copyBookingLink)];
      await navigator.clipboard.writeText(link(type));
      if (gen !== generation) return;
      copiedLink = type.id;
      if (b.isConnected) b.textContent = "Copied";
      setTimeout(() => {
        if (copiedLink === type.id) copiedLink = "";
      }, 2000);
    }));
    document.querySelectorAll("[data-turn-on]").forEach((b) => b.onclick = busy(() => setPublished(Number(b.dataset.turnOn), true)));
    const add = document.querySelector("#add-type");
    if (add) add.onclick = () => leaveEditor(() => {
      const draft = newMeeting(settings, calendars, browserZone());
      autoSlugIds.add(draft.id);
      settings.meetingTypes.push({ ...draft, useDefaultSchedule: true, scheduleId: null, published: !!settings.accounts.some((a) => a.connected) });
      selected = settings.meetingTypes.length - 1;
      editing = true;
      dirty = true;
      ownHoursDraft = null;
      previewDay = "";
      history.replaceState(null, "", hashFor("Meetings"));
      render();
      document.querySelector("[name=title]").focus();
      document.querySelector("[name=title]").select();
    });
    document.querySelectorAll("[data-link-menu]").forEach((b) => b.onclick = () => {
      const index = Number(b.dataset.linkMenu), type = settings.meetingTypes[index];
      showRowMenu(b, linkMenuItems(type, { canEdit: can(ws.active, "manageSettings"), live: savedTypeIds.has(type.id) && type.published }), (pick) => {
        if (pick === "preview") return openShare(index, b, "preview");
        if (pick === "embed") return openShare(index, b, "share");
        if (pick === "on" || pick === "off") return busy(() => setPublished(index, pick === "on"))({ currentTarget: b });
        if (pick === "duplicate") return busy(() => duplicateLink(index))({ currentTarget: b });
        if (pick === "delete") {
          selected = index;
          confirmRemoveType(b);
        }
      });
    });
  }
  async function saveTypes(types, text) {
    const saved = await api("settings", { patch: { meetingTypes: types }, expectedRevision: settings.revision });
    settings = { linkAccess: settings.linkAccess, ...saved.settings, revision: saved.revision };
    settingsBaseline = fingerprint(settings);
    savedTypeIds = new Set(settings.meetingTypes.map((t) => t.id));
    message = text;
    render();
  }
  function setPublished(index, published) {
    return saveTypes(settings.meetingTypes.map((t, i) => i === index ? { ...t, published } : t), published ? "Link is on" : "Link is off");
  }
  function duplicateLink(index) {
    const source = settings.meetingTypes[index], id = crypto.randomUUID().slice(0, 8), title = `${source.title} copy`.slice(0, 160);
    return saveTypes([...settings.meetingTypes, { ...structuredClone(source), id, title, slug: meetingSlug(title, settings.meetingTypes, id), published: false }], "Link duplicated");
  }
  // ----- Link editor -----
  function editorDraft(form) {
    return readEditor(form, settings.meetingTypes[selected], settings.accounts, ownHoursDraft);
  }
  async function updatePreview() {
    const box = document.querySelector("[data-live-preview]"), form = document.querySelector("#meeting-form");
    if (!box || !form) return;
    let draft;
    try {
      draft = editorDraft(form);
    } catch {
      draft = null;
    }
    if (!draft) return;
    try {
      const preview = previewSlots(draft, { availability: myAvailability(), busy: draft.teamScheduling ? [] : previewBusy });
      box.innerHTML = previewMarkup({ config: { ...preview.config, title: draft.title }, slots: preview.slots }, { hostName: ws.active.personal ? settings.profile?.name || "" : ws.active.name, selected: previewDay, fmt: (ms, opts) => new Intl.DateTimeFormat(void 0, { timeZone: preview.config.zone, ...opts }).format(ms) });
      box.querySelectorAll("[data-preview-day]").forEach((b) => b.onclick = () => {
        previewDay = b.dataset.previewDay;
        updatePreview();
      });
    } catch (e) {
      box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }
  async function loadPreviewBusy() {
    const gen = generation, now = Date.now();
    try {
      const result = await api(`${ws.active.personal ? "calendar-events" : "my-calendar/events"}?from=${now}&to=${now + 8 * 864e5}`);
      if (gen !== generation) return;
      previewBusy = (result.events || []).filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end }));
      updatePreview();
    } catch {
    }
  }
  function markDirty(form) {
    dirty = true;
    const state = form.querySelector("#editor-save-state");
    if (state) state.textContent = "Unsaved changes";
    form.querySelector("[data-discard]")?.removeAttribute("hidden");
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 150);
  }
  function editOwnHours(form, trigger) {
    const type = settings.meetingTypes[selected];
    ownHoursDraft ||= ownHoursOf(type) || structuredClone(myAvailability() || { zone: browserZone(), weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, d > 0 && d < 6 ? [{ start: 540, end: 1020 }] : []])), dateOverrides: {} });
    const dialog = document.createElement("dialog");
    dialog.className = "own-hours-dialog";
    dialog.setAttribute("aria-label", `Times for ${type.title}`);
    document.body.append(dialog);
    let mode = "every", monday = currentMonday(ownHoursDraft.zone), unbind = () => {
    };
    const draw = () => {
      unbind();
      const view = { schedule: ownHoursDraft, mode, monday, events: [], scope: "link", title: `Times for ${form.elements.title.value || type.title}`, editable: true };
      dialog.innerHTML = `<div data-av-dialog>${availabilityPageMarkup(view)}</div><div class="row own-hours-actions"><button type="button" class="primary" data-own-done>Done</button></div>`;
      unbind = bindAvailabilityPage(dialog, view, {
        onSchedule: (next) => {
          ownHoursDraft = next;
          draw();
        },
        onMode: (next) => {
          mode = next;
          draw();
        },
        onWeek: (next) => {
          monday = next;
          draw();
        },
        onUseAvailability: () => {
          form.elements.scheduleId.value = "__default__";
          dialog.close();
        }
      });
      dialog.querySelector("[data-own-done]").onclick = () => dialog.close();
    };
    dialog.addEventListener("close", () => {
      unbind();
      dialog.remove();
      const own = form.elements.scheduleId.value !== "__default__";
      let summary = form.querySelector("[data-own-hours-summary]");
      if (own && !summary) {
        form.elements.scheduleId.insertAdjacentHTML("afterend", ' <span class="le-own" data-own-hours-summary></span> <button type="button" class="link-button" data-edit-own-hours>Edit times</button>');
        summary = form.querySelector("[data-own-hours-summary]");
        form.querySelector("[data-edit-own-hours]").onclick = (event) => editOwnHours(form, event.currentTarget);
      }
      if (summary) {
        summary.hidden = !own;
        summary.textContent = weeklySummary(ownHoursDraft.weeklyHours);
        form.querySelector("[data-edit-own-hours]").hidden = !own;
      }
      markDirty(form);
      (trigger?.isConnected ? trigger : form.elements.scheduleId).focus();
    });
    draw();
    dialog.showModal();
  }
  function bindEditor() {
    const form = document.querySelector("#meeting-form");
    if (!form) return;
    refreshTeamCalendars = bindTeamEditor(form, { settings, getCalendars: () => calendars, isLoaded: () => calendarsLoaded });
    updateTimeLimitHint(form);
    bindLength(form);
    form.querySelectorAll("details.le-row").forEach((row) => row.addEventListener("toggle", () => {
      const id = settings.meetingTypes[selected]?.id;
      if (editorOpenRows.id !== id) editorOpenRows = { id, rows: new Set() };
      if (row.open) editorOpenRows.rows.add(row.dataset.row);
      else editorOpenRows.rows.delete(row.dataset.row);
    }));
    bindChangeRules(form);
    bindLinkAccess(form);
    bindApprovalSettings(form);
    bindQuestionsEditor(form);
    bindReminders(form);
    form.oninput = (event) => {
      if (event?.target?.name === "slug") autoSlugIds.delete(settings.meetingTypes[selected].id);
      if (event?.target?.name === "title") {
        if (autoSlugIds.has(settings.meetingTypes[selected].id)) form.elements.slug.value = meetingSlug(form.elements.title.value, settings.meetingTypes, settings.meetingTypes[selected].id);
        form.querySelector(".le-title h1").textContent = form.elements.title.value;
      }
      if (event?.target?.name === "published") form.querySelector("[data-publish-label]").textContent = form.elements.published.checked ? "On" : "Off";
      updateTimeLimitHint(form);
      status("");
      markDirty(form);
    };
    form.onchange = form.oninput;
    const hoursMode = form.querySelector("[data-hours-mode]");
    hoursMode.addEventListener("change", () => {
      if (hoursMode.value === "") editOwnHours(form, hoursMode);
      else {
        form.querySelector("[data-own-hours-summary]")?.setAttribute("hidden", "");
        form.querySelector("[data-edit-own-hours]")?.setAttribute("hidden", "");
      }
    });
    form.querySelector("[data-edit-own-hours]")?.addEventListener("click", (event) => editOwnHours(form, event.currentTarget));
    // A per-link calendar belongs to its account; another account starts from that account's default.
    form.querySelector("select[name=accountId]")?.addEventListener("change", () => {
      form.elements.destinationChoice.value = "__account_default__";
      form.querySelector("[data-calendar-override]")?.remove();
    });
    const reset = form.querySelector("[data-reset-calendar]");
    if (reset) reset.onclick = () => {
      form.elements.destinationChoice.value = "__account_default__";
      form.querySelector("[data-calendar-override]").remove();
      markDirty(form);
      form.elements.scheduleId.focus();
    };
    const where = form.querySelector("[name=locationType]");
    if (where) where.addEventListener("change", () => {
      form.querySelector("#custom-location").hidden = where.value !== "custom";
    });
    form.querySelector("[data-discard]")?.addEventListener("click", async () => {
      dirty = false;
      try {
        settings = await api("settings");
        settingsBaseline = fingerprint(settings);
        draftNeedsReview = false;
      } catch (e) {
        status(e.message);
      }
      savedTypeIds = new Set(settings.meetingTypes.map((t) => t.id));
      if (!settings.meetingTypes[selected]) editing = false;
      ownHoursDraft = editing ? ownHoursOf(settings.meetingTypes[selected]) : null;
      render();
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      if (draftNeedsReview) {
        status("This link changed elsewhere. Review it before saving.");
        offerReload();
        return;
      }
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      try {
        const t = editorDraft(form), types = settings.meetingTypes.map((x, i) => i === selected ? t : x);
        const saved = await api("settings", { patch: { meetingTypes: types }, expectedRevision: settings.revision });
        settings = { linkAccess: settings.linkAccess, ...saved.settings, revision: saved.revision };
        settingsBaseline = fingerprint(saved.settings);
        draftNeedsReview = false;
        savedTypeIds = new Set(settings.meetingTypes.map((t2) => t2.id));
        autoSlugIds.delete(t.id);
        ownHoursDraft = ownHoursOf(settings.meetingTypes[selected]);
        dirty = false;
        message = "Saved";
        render();
        document.querySelector("#editor-save-state").textContent = "Saved";
      } catch (err) {
        status(err.message);
        if (err.code === "settings_conflict") offerReload();
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
    const remove = document.querySelector("#remove-type");
    if (remove) remove.onclick = () => confirmRemoveType(remove);
    const back = document.querySelector("#back-to-links");
    if (back) back.onclick = () => leaveEditor(() => {
      editing = false;
      history.replaceState(null, "", hashFor("Meetings"));
      message = "";
      render();
      document.querySelector(`[data-type="${selected}"]`)?.focus();
      refreshLinkStats();
    });
    updatePreview();
    loadPreviewBusy();
  }
  function bindProfileExport() {
    const row = document.querySelector("[data-profile-export]"), target = ws.active;
    if (!row || section !== "Team" || !canExportProfile(target)) {
      profileExport?.controller.dispose();
      profileExport = null;
      return;
    }
    if (!profileExport || profileExport.workspaceId !== target.id || profileExport.controller.disposed) {
      profileExport?.controller.dispose();
      const gen = generation, entry = { workspaceId: target.id, draw: () => {
      } };
      entry.controller = createExportController({ scope: "workspace", name: target.name, request: exportRequest({ scope: "workspace", workspaceId: target.id, expectedAccountId: bootstrap.hostId }), isCurrent: () => gen === generation && section === "Team" && ws.active.id === target.id && canExportProfile(ws.active), onUpdate: (state) => entry.draw(state), onAuthorityLost: () => onCompanyRefusal() });
      profileExport = entry;
    }
    profileExport.draw = bindExportRow(row, profileExport.controller, { label: "Export data", actionLabel: `Export ${target.name} data` });
  }
  function leaveEditor(action) {
    if (!dirty) {
      action();
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "unsaved-dialog";
    dialog.setAttribute("aria-label", "Unsaved changes");
    dialog.innerHTML = '<h2>Save your changes first?</h2><p>Your edits haven’t been saved.</p><div class="row"><button class="secondary" data-stay>Keep editing</button><button class="secondary" data-discard>Discard changes</button><button class="primary" data-save>Save changes</button></div>';
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("[data-stay]").onclick = () => dialog.close();
    dialog.querySelector("[data-discard]").onclick = async () => {
      dirty = false;
      dialog.close();
      try {
        settings = await api("settings");
        settingsBaseline = fingerprint(settings);
        draftNeedsReview = false;
        action();
      } catch (e) {
        status(e.message);
      }
    };
    dialog.querySelector("[data-save]").onclick = async () => {
      const gen = generation;
      dialog.close();
      const form = document.querySelector("#meeting-form");
      if (form?.onsubmit) await form.onsubmit(new Event("submit", { cancelable: true }));
      if (gen === generation && !dirty) action();
    };
    dialog.showModal();
    dialog.querySelector("[data-stay]").focus();
  }
  function confirmDisconnect(id) {
    const trigger = document.querySelector(`[data-disconnect="${CSS.escape(id)}"]`);
    const email = settings.accounts.find((a) => a.id === id)?.email || "this account";
    const dialog = document.createElement("dialog");
    dialog.className = "unsaved-dialog";
    dialog.setAttribute("aria-label", "Disconnect calendar");
    dialog.innerHTML = `<h2>Disconnect calendar?</h2><p>Meeting links using ${esc(email)} will stop accepting new bookings. Existing meetings stay on your calendar.</p><div class="row"><button class="secondary" data-keep>Keep connected</button><button class="danger-button" data-confirm>Disconnect</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (trigger?.isConnected) trigger.focus();
    });
    dialog.querySelector("[data-keep]").onclick = () => dialog.close();
    dialog.querySelector("[data-confirm]").onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api("disconnect", { accountId: id });
        settings = await api("settings");
        dirty = false;
        message = "Calendar disconnected";
        dialog.close();
        render();
        if (section === "Availability") refreshAvailability();
      } catch (err) {
        status(err.message);
        e.currentTarget.disabled = false;
      }
    };
    dialog.showModal();
    dialog.querySelector("[data-keep]").focus();
  }
  const onKeys = (e) => {
    if (document.querySelector("dialog[open]")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && document.querySelector("#meeting-form")) {
      e.preventDefault();
      document.querySelector("#meeting-form").requestSubmit();
    }
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && section === "Bookings") {
      e.preventDefault();
      const q = document.querySelector("#booking-search");
      if (q) q.focus();
      else document.querySelector("[data-booking-search-open]")?.click();
    }
  };
  document.addEventListener("keydown", onKeys);
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // Paint the Studio frame now; the first reads fill it in.
  render();
  await load({ first: true });
}
