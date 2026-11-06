import type * as vscode from 'vscode';
import { CustomLogsViewProvider, type CustomLogsViewProviderOptions } from '../provider/CustomLogsViewProvider';
import { localize } from '../host/utils/localize';
import { createSessionEditorPanel } from './sessionEditorPanel';

let trackCapture: CustomLogsViewProviderOptions['trackCapture'];

const editorPanel = createSessionEditorPanel({
  viewType: 'electivus.apexLogViewer.customLogsView.editorPanel',
  title: () => localize('customLogs.view.name', 'Electivus Custom Logs'),
  createController: context => new CustomLogsViewProvider(context, { trackCapture })
});

export const CustomLogsEditorPanel = {
  ...editorPanel,
  /** `track` shows the captures of each tab this opens in the window's status bar item. */
  initialize(context: vscode.ExtensionContext, track?: CustomLogsViewProviderOptions['trackCapture']): void {
    trackCapture = track;
    editorPanel.initialize(context);
  }
};
