// The session user's DEVELOPER_LOG trace flags over Tooling: read them, and put them back to a snapshot.
export async function userDeveloperLogFlags(h, session) {
  const auth = await h.orgAuth();
  const api = `${auth.instanceUrl}/services/data/v${auth.apiVersion}`;
  const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };
  const query = async (soql, { toolingApi = true } = {}) => {
    const res = await fetch(`${api}${toolingApi ? '/tooling' : ''}/query?q=${encodeURIComponent(soql)}`, { headers });
    if (!res.ok) {
      throw new Error(`Query failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()).records.map(({ attributes, ...record }) => record);
  };
  const tooling = async (method, path, body) => {
    const res = await fetch(`${api}/tooling/sobjects/TraceFlag${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  };
  const [user] = await query(`SELECT Id FROM User WHERE Username = '${session.org.username}'`, { toolingApi: false });
  const soql = `SELECT Id, DebugLevelId, DebugLevel.DeveloperName, StartDate, ExpirationDate FROM TraceFlag WHERE LogType = 'DEVELOPER_LOG' AND TracedEntityId = '${user.Id}' ORDER BY Id`;
  return {
    auth,
    query,
    tooling,
    userId: user.Id,
    read: () => query(soql),
    /** Deletes flags that are not in `before` and puts back the level and dates of those that are. */
    async restore(before) {
      const known = new Map(before.map(flag => [flag.Id, flag]));
      const outcome = { deleted: [], restored: [], errors: [] };
      for (const now of await query(soql)) {
        const was = known.get(now.Id);
        if (!was) {
          const res = await tooling('DELETE', `/${now.Id}`);
          (res.ok ? outcome.deleted : outcome.errors).push(
            res.ok ? now.Id : `delete ${now.Id}: ${res.status} ${res.body}`
          );
        } else if (now.DebugLevelId !== was.DebugLevelId || now.ExpirationDate !== was.ExpirationDate) {
          const res = await tooling('PATCH', `/${was.Id}`, {
            DebugLevelId: was.DebugLevelId,
            StartDate: was.StartDate,
            ExpirationDate: was.ExpirationDate
          });
          (res.ok ? outcome.restored : outcome.errors).push(
            res.ok ? was.Id : `restore ${was.Id}: ${res.status} ${res.body}`
          );
        }
      }
      return outcome;
    }
  };
}
