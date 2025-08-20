// engine/businessHours.js
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function partsInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const wd = (parts.weekday || '').toLowerCase().slice(0,3);
  const dayKey = WEEK.includes(wd) ? wd : 'mon';
  const minutes = parseInt(parts.hour,10)*60 + parseInt(parts.minute,10);
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
  return { dayKey, minutes, isoDate };
}

export function isOpenNow(cfg, now = new Date()) {
  if (!cfg || !cfg.timezone || !cfg.hours) return { open: true };
  const { dayKey, minutes, isoDate } = partsInTz(now, cfg.timezone);

  const todays = (cfg.exceptions && cfg.exceptions[isoDate])
    ? cfg.exceptions[isoDate]
    : (Array.isArray(cfg.holidays) && cfg.holidays.includes(isoDate) ? [] : (cfg.hours[dayKey] || []));

  const open = todays.some(w => {
    const [sh, sm] = (w.start || '00:00').split(':').map(Number);
    const [eh, em] = (w.end   || '23:59').split(':').map(Number);
    const a = sh*60+sm, b = eh*60+em;
    return minutes >= a && minutes <= b;
  });

  return { open };
}
