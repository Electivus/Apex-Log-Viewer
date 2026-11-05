/**
 * Help text renders `<%- %>` against the loaded oclif config, so the path is the installed plugin's own root
 * and never the build machine's, which `oclif manifest` would otherwise freeze into the shipped manifest.
 * The unescaped tag keeps a root with `'` or `&` a real path.
 */
const REFERENCE_DIR = '<%- config.plugins.get(command.pluginName).root %>/reference';

export const CUSTOM_LOG_REFERENCE_NOTE =
  `The mapping format is documented offline in ${REFERENCE_DIR}/CUSTOM_LOGS.md, ` +
  `and its JSON Schema is ${REFERENCE_DIR}/sfdx-project.electivus.schema.json. ` +
  'Wrapped at 80 columns, a path splits mid-word, so print this help with OCLIF_COLUMNS=1000 to copy it.';
