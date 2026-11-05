/**
 * Help text renders `<%= %>` against the loaded oclif config, so the path is the installed plugin's own root
 * and never the build machine's, which `oclif manifest` would otherwise freeze into the shipped manifest.
 */
export const CUSTOM_LOG_REFERENCE_DIR = "<%= config.plugins.get('@electivus/plugin-electivus').root %>/reference";

export const CUSTOM_LOG_REFERENCE_NOTE =
  `The mapping format is documented offline in ${CUSTOM_LOG_REFERENCE_DIR}/CUSTOM_LOGS.md, ` +
  `and its JSON Schema is ${CUSTOM_LOG_REFERENCE_DIR}/sfdx-project.electivus.schema.json.`;
