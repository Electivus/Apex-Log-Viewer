export const formatStartTimeUtc = (startTime: string): string => {
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid StartTime');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
};
