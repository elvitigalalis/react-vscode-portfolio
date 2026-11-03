// The shared iCal reader for the Brightspace and SB Engaged feeds (docs/sheet-sources.md,
// "Contracts"). Pure: text in, events out. Follows RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545)
// as far as both feeds need it: folding (3.1), text escapes (3.3.11), DATE and DATE-TIME (3.3.4,
// 3.3.5), DURATION (3.3.6) and DTEND's fallbacks (3.6.1). RRULE is ignored: neither feed repeats.

// --- Lines -------------------------------------------------------------------------------

// "NAME;P1=v;P2=\"a:b\":value" -> { name, params, value }. The value starts at the first colon
// outside a quoted parameter value (3.1, 3.2).
function property(line) {
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i === line.length) return null;
  const [name, ...rest] = line.slice(0, i).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

// Undoes \\ \; \, \n \N (3.3.11). One pass, so "\\n" stays a backslash and an n.
const unescape = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

// A CATEGORIES value split on unescaped commas, each part unescaped and trimmed.
const splitList = (s) => (s.match(/(?:\\.|[^\\,])+/g) ?? []).map((p) => unescape(p).trim()).filter(Boolean);

// --- Times -------------------------------------------------------------------------------

const zones = new Map();
const offsets = new Map();

// The zone's UTC offset in ms at instant `t`, cached per zone and quarter hour (offsets only
// change on quarter-hour boundaries), so the 8 MB feed doesn't format once per event.
function offsetAt(t, timeZone) {
  const key = `${timeZone}|${Math.floor(t / 900_000)}`;
  let off = offsets.get(key);
  if (off !== undefined) return off;
  let fmt = zones.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    zones.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  const base = Math.floor(t / 1000) * 1000;
  off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - base;
  offsets.set(key, off);
  return off;
}

// The instant when the clock in `timeZone` reads `local` (a UTC-based ms value for the wall
// time). RFC 5545 3.3.5: a repeated hour means its first occurrence, a skipped hour is read with
// the offset before the gap.
function zoned(local, timeZone) {
  const before = offsetAt(local - 43_200_000, timeZone), after = offsetAt(local + 43_200_000, timeZone);
  const fits = (off) => offsetAt(local - off, timeZone) === off;
  const a = local - before, b = local - after;
  if (fits(before) && fits(after)) return Math.min(a, b);
  if (fits(after)) return b;
  return a;
}

// A DTSTART/DTEND value -> { date } for VALUE=DATE, { t } (ms) for a date-time, or null.
// A floating time (no Z, no TZID) is read as UTC; neither feed sends one.
function when(prop) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(prop.value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const local = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  const back = new Date(local);
  if (back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d || +(h ?? 0) > 23 || +(mi ?? 0) > 59 || +(s ?? 0) > 60) return null;
  if (h === undefined) return { date: `${y}-${mo}-${d}`, t: local };
  if (z || !prop.params.TZID) return { t: local };
  return { t: zoned(local, prop.params.TZID) };
}

// "PT1H20M", "P1D", "-PT15M", "P2W" -> ms, or null (3.3.6).
function duration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m || value.trim().endsWith("P") || value.trim().endsWith("T")) return null;
  const [, sign, w, d, h, mi, s] = m.map((x, i) => (i > 1 ? Number(x ?? 0) : x));
  const ms = ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
  return sign === "-" ? -ms : ms;
}

const dayString = (t) => new Date(t).toISOString().slice(0, 10);

// --- Events ------------------------------------------------------------------------------

// One VEVENT's properties -> { event, s, e } (the contract's event and its span in ms), or null
// when it can't be read.
function toEvent(props) {
  const get = (name) => props.find((p) => p.name === name);
  const uid = get("UID")?.value.trim();
  const dtstart = get("DTSTART");
  const start = dtstart && when(dtstart);
  if (!uid || !start) return null;
  const allDay = start.date !== undefined;

  let end;
  const dtend = get("DTEND"), dur = get("DURATION");
  if (dtend) {
    end = when(dtend);
    if (!end || (end.date !== undefined) !== allDay) return null;
  } else if (dur) {
    const ms = duration(dur.value);
    if (ms === null) return null;
    end = allDay ? { date: dayString(start.t + ms), t: start.t + ms } : { t: start.t + ms };
  } else {
    // 3.6.1: a DATE start with no end lasts one day; a DATE-TIME start, zero length.
    end = allDay ? { date: dayString(start.t + 86_400_000), t: start.t + 86_400_000 } : { t: start.t };
  }
  if (end.t < start.t) return null;

  const text = (name) => { const p = get(name); return p ? unescape(p.value) : ""; };
  const event = {
    uid,
    summary: text("SUMMARY"),
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    url: get("URL")?.value.trim() ?? "",
    categories: props.filter((p) => p.name === "CATEGORIES").flatMap((p) => splitList(p.value)),
    start: allDay ? start.date : new Date(start.t).toISOString(),
    end: allDay ? end.date : new Date(end.t).toISOString(),
    allDay,
  };
  return { event, s: start.t, e: end.t };
}

// The events overlapping [from, to) (Dates or ISO strings). A zero-length event counts when
// from <= start < to. All-day events are read as UTC days, so a window edge can let in one
// from the day next to it; callers place them by date.
export function parseIcs(text, { from, to }) {
  const lo = +new Date(from), hi = +new Date(to);
  const lines = String(text ?? "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let props = null, nested = 0;
  for (const line of lines) {
    if (props === null) {
      if (line === "BEGIN:VEVENT") { props = []; nested = 0; }
      continue;
    }
    if (line.startsWith("BEGIN:")) { nested++; continue; } // VALARM and the like
    if (line.startsWith("END:")) {
      if (nested > 0) { nested--; continue; }
      if (line === "END:VEVENT") {
        let r = null;
        try { r = toEvent(props); } catch { r = null; } // a bad TZID throws a RangeError
        if (r && r.s < hi && (r.e > lo || (r.e === r.s && r.s >= lo))) out.push(r.event);
      }
      props = null;
      continue;
    }
    if (nested > 0) continue;
    const p = property(line);
    if (p) props.push(p);
  }
  return out;
}
