const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

const UNTIL_FORMAT_ERROR =
  'must be a local time such as "17:30" (HH:MM, next occurrence) or a date and time such as "2026-10-11T06:00"';

export function parseUntil(value: string, now: Date = new Date()): Date {
  const timeOfDay = TIME_OF_DAY.exec(value);
  if (timeOfDay) {
    const hours = Number(timeOfDay[1]);
    const minutes = Number(timeOfDay[2]);
    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
    );
    if (today.getTime() > now.getTime()) return today;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      hours,
      minutes,
    );
  }

  const dateTime = DATE_TIME.exec(value);
  if (dateTime) {
    const deadline = new Date(value);
    const [year, month, day, hours, minutes] = dateTime
      .slice(1, 6)
      .map(Number) as [number, number, number, number, number];
    const calendar = new Date(Date.UTC(year, month - 1, day, hours, minutes));
    const isRealDate =
      calendar.getUTCFullYear() === year &&
      calendar.getUTCMonth() === month - 1 &&
      calendar.getUTCDate() === day &&
      calendar.getUTCHours() === hours &&
      calendar.getUTCMinutes() === minutes;
    if (isRealDate && !Number.isNaN(deadline.getTime())) return deadline;
  }

  throw new Error(UNTIL_FORMAT_ERROR);
}

export function formatDeadline(deadline: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${deadline.getFullYear()}-${pad(deadline.getMonth() + 1)}-${pad(deadline.getDate())} ${pad(deadline.getHours())}:${pad(deadline.getMinutes())}`;
}
