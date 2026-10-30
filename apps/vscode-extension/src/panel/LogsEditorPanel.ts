import { SfLogsViewProvider } from '../provider/SfLogsViewProvider';
import { localize } from '../host/utils/localize';
import { createSessionEditorPanel } from './sessionEditorPanel';

export const LogsEditorPanel = createSessionEditorPanel({
  viewType: 'electivus.apexLogViewer.logsView.editorPanel',
  title: () => localize('salesforce.logs.view.name', 'Electivus Apex Logs'),
  createController: context => new SfLogsViewProvider(context)
});
