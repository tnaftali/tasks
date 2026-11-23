process.env.TZ = "Europe/Madrid"; // the app runs in the viewer's zone; pin one so the expectations are fixed
import test from "node:test";
import assert from "node:assert/strict";
import { expand, onDay, span } from "./cal.js";

// A feed shaped like Google's: its own VTIMEZONE, a weekly meeting with a skipped and a moved week, an all-day trip,
// a cancelled event, a UTC event and an event in another zone.
const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
X-WR-CALNAME:Work
BEGIN:VTIMEZONE
TZID:Europe/Madrid
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:standup@x
DTSTART;TZID=Europe/Madrid:20240102T093000
DTEND;TZID=Europe/Madrid:20240102T094500
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Europe/Madrid:20261201T093000
SUMMARY:Team standup
END:VEVENT
BEGIN:VEVENT
UID:standup@x
RECURRENCE-ID;TZID=Europe/Madrid:20261124T093000
DTSTART;TZID=Europe/Madrid:20261124T113000
DTEND;TZID=Europe/Madrid:20261124T120000
SUMMARY:Team standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:trip@x
DTSTART;VALUE=DATE:20261127
DTEND;VALUE=DATE:20261130
SUMMARY:Trip to Lisbon
END:VEVENT
BEGIN:VEVENT
UID:gone@x
DTSTART;TZID=Europe/Madrid:20261124T150000
DTEND;TZID=Europe/Madrid:20261124T160000
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
BEGIN:VEVENT
UID:utc@x
DTSTART:20261124T180000Z
DTEND:20261124T190000Z
SUMMARY:Easy run
END:VEVENT
BEGIN:VEVENT
UID:ny@x
DTSTART;TZID=America/New_York:20261124T090000
DTEND;TZID=America/New_York:20261124T100000
SUMMARY:Call with NY
END:VEVENT
BEGIN:VEVENT
UID:late@x
DTSTART;TZID=Europe/Madrid:20261124T230000
DTEND;TZID=Europe/Madrid:20261125T010000
SUMMARY:Late flight
END:VEVENT
END:VCALENDAR`.replace(/\n/g, "\r\n");

const at = (s) => new Date(s).getTime();
const occ = expand(ICS, "2026-11-23", "2026-12-06");
const titles = (d) => onDay(occ, d).map((o) => `${o.title} ${span(o, d)}`);

test("expand: a moved week moves, a skipped week is skipped, other weeks repeat", () => {
  const standups = expand(ICS, "2026-11-23", "2026-12-10").filter((o) => o.title.startsWith("Team standup")).map((o) => [o.title, new Date(o.start).toISOString()]);
  assert.deepEqual(standups, [
    ["Team standup (moved)", "2026-11-24T10:30:00.000Z"], // 11:30 Madrid instead of 09:30
    ["Team standup", "2026-12-08T08:30:00.000Z"], // 1 Dec is skipped (EXDATE)
  ]);
});

test("onDay: all-day first, then by time; times in the viewer's zone; cancelled events hidden", () => {
  assert.deepEqual(titles("2026-11-24"), ["Team standup (moved) 11:30–12:00", "Call with NY 15:00–16:00", "Easy run 19:00–20:00", "Late flight 23:00–…"]);
  assert.deepEqual(titles("2026-11-25"), ["Late flight …–01:00"]);
});

test("onDay: a multi-day all-day event shows on each of its days, not the day it ends", () => {
  for (const d of ["2026-11-27", "2026-11-28", "2026-11-29"]) assert.deepEqual(titles(d), ["Trip to Lisbon All day"]);
  assert.deepEqual(titles("2026-11-30"), []);
});

test("expand: a broken event is skipped, the rest still load", () => {
  const bad = ICS.replace("BEGIN:VEVENT\r\nUID:utc@x", "BEGIN:VEVENT\r\nUID:broken@x\r\nDTSTART:garbage\r\nSUMMARY:Broken\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:utc@x");
  assert.ok(expand(bad, "2026-11-24", "2026-11-24").some((o) => o.title === "Easy run"));
});

test("expand: a zone the feed names but does not define still converts", () => {
  const ny = occ.find((o) => o.title === "Call with NY");
  assert.equal(new Date(ny.start).toISOString(), "2026-11-24T14:00:00.000Z"); // 09:00 New York
});

test("expand: a daily event from years ago is fast enough", () => {
  const daily = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d@x\r\nDTSTART:20100101T080000Z\r\nDTEND:20100101T081500Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Pills\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const t0 = performance.now(), o = expand(daily, "2026-11-23", "2026-12-06");
  assert.equal(o.length, 14);
  assert.ok(performance.now() - t0 < 2000);
});
