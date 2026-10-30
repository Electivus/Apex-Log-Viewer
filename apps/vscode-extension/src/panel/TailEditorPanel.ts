import { SfLogTailViewProvider } from '../provider/SfLogTailViewProvider';
import { localize } from '../host/utils/localize';
import { createSessionEditorPanel } from './sessionEditorPanel';

export const TailEditorPanel = createSessionEditorPanel({
  viewType: 'electivus.apexLogViewer.tailView.editorPanel',
  title: () => localize('salesforce.tail.view.name', 'Electivus Apex Logs Tail'),
  createController: context => new SfLogTailViewProvider(context)
});
