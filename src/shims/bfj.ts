// Minimal stub for 'bfj' to avoid pulling in heavy deps (jsonpath) at runtime.
// Our extension doesn't use TestService.writeResultFiles (the only path using bfj),
// so this stub should never be executed. If it is, fail loudly.

export function stringify(): never {
  throw new Error("bfj.stringify is not available in this build");
}

export default { stringify };

