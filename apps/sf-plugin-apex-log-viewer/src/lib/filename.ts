export const buildLogFilename = (startTimeUtc: string, username: string, logId: string): string => {
  const safeUser = username.trim() || 'default';
  return `${startTimeUtc}_${safeUser}_${logId}.log`;
};
