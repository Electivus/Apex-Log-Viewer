FROM mcr.microsoft.com/vscode/devcontainers/typescript-node:24@sha256:e36c918ec9c679c18451231e277ea9122c00a097fb6e4a23c8c3d35bf08bbc3a

ARG ALV_PNPM_VERSION=11.11.0
# The `dist.integrity` of that version: `npm view pnpm@<version> dist.integrity`.
ARG ALV_PNPM_INTEGRITY=sha512-RGP2X9gO2A1pvB1L8WPulPYFxzgPwxi7Wy6+FfjNEtScUaTVnpUbQB52TTtsp1HL9RvFDtcAGmvLSTXmhMNIgg==

# Install the repository package manager and Salesforce CLI globally for the node user.
# pnpm ships as one registry tarball with no dependencies. Check it against the pinned
# hash and unpack it where `npm install -g` would, instead of an install that only pins
# the version.
RUN npm_prefix="$(npm prefix -g)" \
  && test -n "${npm_prefix}" \
  && curl -fsSL --connect-timeout 20 --max-time 300 --retry 3 \
    -o /tmp/pnpm.tgz "https://registry.npmjs.org/pnpm/-/pnpm-${ALV_PNPM_VERSION}.tgz" \
  && test "sha512-$(openssl dgst -sha512 -binary /tmp/pnpm.tgz | openssl base64 -A)" = "${ALV_PNPM_INTEGRITY}" \
  && rm -rf "${npm_prefix}/lib/node_modules/pnpm" \
  && mkdir -p "${npm_prefix}/lib/node_modules/pnpm" "${npm_prefix}/bin" \
  && tar -xzf /tmp/pnpm.tgz -C "${npm_prefix}/lib/node_modules/pnpm" --strip-components=1 --no-same-owner \
  && rm /tmp/pnpm.tgz \
  && ln -sf ../lib/node_modules/pnpm/bin/pnpm.mjs "${npm_prefix}/bin/pnpm" \
  && ln -sf ../lib/node_modules/pnpm/bin/pnpm.mjs "${npm_prefix}/bin/pn" \
  && ln -sf ../lib/node_modules/pnpm/bin/pnpx.mjs "${npm_prefix}/bin/pnpx" \
  && ln -sf ../lib/node_modules/pnpm/bin/pnpx.mjs "${npm_prefix}/bin/pnx" \
  && test "$(pnpm --version)" = "${ALV_PNPM_VERSION}"
RUN npm install -g @salesforce/cli@2.150.6 --no-audit --no-fund
