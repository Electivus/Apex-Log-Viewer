import { CustomLogsViewProvider } from '../provider/CustomLogsViewProvider';
import { localize } from '../host/utils/localize';
import { createSessionEditorPanel } from './sessionEditorPanel';

export const CustomLogsEditorPanel = createSessionEditorPanel({
  viewType: 'electivus.apexLogViewer.customLogsView.editorPanel',
  title: () => localize('customLogs.view.name', 'Electivus Custom Logs'),
  createController: context => new CustomLogsViewProvider(context)
});
