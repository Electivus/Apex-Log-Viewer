export const buildLogFilename = (startTimeUtc: string, username: string, logId: string): string => {
  const trimmedUser = username.trim();
  const safeUser = (trimmedUser ? trimmedUser.replace(/[^A-Za-z0-9_.@-]/g, '_') : '') || 'default';
  return `${startTimeUtc}_${safeUser}_${logId}.log`;
};
