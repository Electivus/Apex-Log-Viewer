import type { NestedFrame } from '../../shared/apexLogParser/types';

export function filterAndCollapse(
  frames: NestedFrame[] | undefined,
  hideSystem: boolean,
  collapseRepeats: boolean,
  hiddenActors?: Set<string>
): (NestedFrame & { count?: number })[] {
  let list: NestedFrame[] = (frames || []).slice();
  const hidden = hiddenActors || new Set<string>();
  if (hideSystem) {
    list = list.filter(fr => !/^Class:System\b/.test(fr.actor) && !/^System\./.test(fr.label));
  }
  if (hidden.size) {
    list = list.filter(fr => !hidden.has(fr.actor));
  }
  // Collapse consecutive repeats on same lane, same depth and same label
  list.sort((a, b) => a.start - b.start || a.depth - b.depth);
  if (!collapseRepeats) return list as any;
  const out: (NestedFrame & { count?: number })[] = [];
  for (const f of list) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.actor === f.actor &&
      prev.depth === f.depth &&
      prev.label === f.label &&
      (prev.end ?? prev.start) <= f.start
    ) {
      prev.end = f.end ?? f.start + 1;
      prev.count = (prev.count || 1) + 1;
      if (f.profile) {
        // Sum profiling counters when collapsing
        (prev.profile ||= {});
        if (f.profile.soql) prev.profile.soql = (prev.profile.soql || 0) + f.profile.soql;
        if (f.profile.dml) prev.profile.dml = (prev.profile.dml || 0) + f.profile.dml;
        if (f.profile.callout) prev.profile.callout = (prev.profile.callout || 0) + f.profile.callout;
        if (f.profile.cpuMs) prev.profile.cpuMs = (prev.profile.cpuMs || 0) + f.profile.cpuMs;
        if (f.profile.heapBytes) prev.profile.heapBytes = (prev.profile.heapBytes || 0) + f.profile.heapBytes;
        if (f.profile.timeMs) prev.profile.timeMs = (prev.profile.timeMs || 0) + f.profile.timeMs;
        if (f.profile.soqlTimeMs) prev.profile.soqlTimeMs = (prev.profile.soqlTimeMs || 0) + f.profile.soqlTimeMs;
        if (f.profile.dmlTimeMs) prev.profile.dmlTimeMs = (prev.profile.dmlTimeMs || 0) + f.profile.dmlTimeMs;
        if (f.profile.calloutTimeMs) prev.profile.calloutTimeMs = (prev.profile.calloutTimeMs || 0) + f.profile.calloutTimeMs;
      }
    } else {
      // Clone profile to avoid mutating the source graph when we merge repeats
      out.push({ ...f, profile: f.profile ? { ...f.profile } : undefined });
    }
  }
  return out;
}

export default filterAndCollapse;
