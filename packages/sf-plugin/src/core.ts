import { createApexLogViewerCore } from '@alv/core';

import { createSfCoreAuthSource } from './sfCoreAuth.js';

export const core = createApexLogViewerCore({ auth: createSfCoreAuthSource() });
