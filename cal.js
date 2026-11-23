// Calendar feeds (iCal, e.g. Google's "Secret address in iCal format"), read-only. Pure, no DOM.
// expand() turns a feed into the occurrences that touch a window of days, repeats and their exceptions included.
import ICAL from "./vendor/ical.min.js";

const MAX_STEPS = 20000; // per repeating event: a daily event from years ago still fits; a runaway rule stops
const fmts = new Map();
// Wall-clock time in an IANA zone the feed names but does not define (e.g. America/New_York): convert with the browser's zone data.
function zoned(t, tz) {
  let f = fmts.get(tz);
  if (f === undefined) { try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); } catch { f = null; } fmts.set(tz, f); }
  if (!f) return null; // not a zone the browser knows (e.g. a Windows name): treat as local time
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const off = (ms) => { const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms; };
  const ms = wall - off(wall);
  return wall - off(ms); // second pass settles the offset around a DST change
}
const localMs = (t) => {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day).getTime(); // a date (all-day) is local midnight
  if (t.zone?.tzid === "floating" && t.timezone) { const ms = zoned(t, t.timezone); if (ms !== null) return ms; }
  return t.toJSDate().getTime();
};
const dayStart = (d) => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)).getTime();
const nextDay = (d) => { const x = new Date(dayStart(d)); x.setDate(x.getDate() + 1); return x.getTime(); };

// Occurrences overlapping the local days [from, to] (YYYY-MM-DD, inclusive): [{ key, title, allDay, start, end }] with times in ms.
// All-day events run from local midnight to local midnight (end exclusive), so a 3-day trip shows on each of its days.
export function expand(text, from, to) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const tz of comp.getAllSubcomponents("vtimezone")) { try { ICAL.TimezoneService.register(tz); } catch {} } // the feed's own zones, so times convert right
  const lo = dayStart(from), hi = nextDay(to), out = [];
  const vevents = comp.getAllSubcomponents("vevent"), moved = new Map(); // uid -> the changed occurrences of a repeating event
  for (const ve of vevents) if (ve.hasProperty("recurrence-id")) { const uid = ve.getFirstPropertyValue("uid"); moved.set(uid, [...(moved.get(uid) ?? []), ve]); }
  const add = (uid, item, s, e) => {
    if (String(item.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const start = localMs(s), end = e ? localMs(e) : s.isDate ? nextDay(`${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`) : start;
    if (end < lo || start >= hi || (end === lo && end > start)) return; // ends before the window (an event ending at midnight belongs to the day before)
    out.push({ key: `${uid}|${start}`, title: (item.summary ?? "").trim() || "(No title)", allDay: s.isDate, start, end: Math.max(end, start) });
  };
  for (const ve of vevents) {
    if (ve.hasProperty("recurrence-id")) continue; // handled through its repeating event
    let ev;
    try { ev = new ICAL.Event(ve, { exceptions: moved.get(ve.getFirstPropertyValue("uid")) ?? [], strictExceptions: true }); } catch { continue; } // one broken event must not hide the rest
    const uid = ev.uid ?? "";
    try {
      if (!ev.isRecurring()) { add(uid, ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      for (let n = 0, next; n < MAX_STEPS && (next = it.next()); n++) {
        const slot = localMs(next);
        if (slot < lo - 32 * 864e5) continue; // long before the window: skip cheaply (a moved occurrence stays within a month of its slot)
        const d = ev.getOccurrenceDetails(next);
        if (localMs(d.startDate) >= hi && slot >= hi) break; // past the window
        add(uid, d.item, d.startDate, d.endDate);
      }
    } catch {}
  }
  return out.sort((a, b) => b.allDay - a.allDay || a.start - b.start || a.title.localeCompare(b.title));
}

// The occurrences on one local day, all-day ones first, then by start time.
export const onDay = (occ, d) => { const s = dayStart(d), e = nextDay(d); return occ.filter((o) => o.start < e && (o.end > s || (o.end === o.start && o.start >= s))); };

const hm = (ms) => { const x = new Date(ms); return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
// "09:30–10:00"; a time that falls on another day than `d` shows as … (it started yesterday, or ends tomorrow).
export function span(o, d) {
  if (o.allDay) return "All day";
  const s = dayStart(d), e = nextDay(d);
  return `${o.start < s ? "…" : hm(o.start)}${o.end > o.start ? `–${o.end > e ? "…" : hm(o.end)}` : ""}`;
}
