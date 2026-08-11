package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.electivus.apexlogviewer.runtime.ApexLogViewerRuntimeException
import com.electivus.apexlogviewer.runtime.LogListRow
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile

internal object ApexLogViewerDataKeys {
    val LOG_ROW: DataKey<LogListRow> = DataKey.create("ApexLogViewer.SelectedLogRow")
}

class OpenParsedLogAction : AnAction() {
    override fun update(event: AnActionEvent) {
        val project = event.project?.takeUnless { it.isDisposed }
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabled = project != null && (
            event.getData(ApexLogViewerDataKeys.LOG_ROW) != null ||
                file?.let(::isLocalLogCandidate) == true
            )
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val existing = event.getData(CommonDataKeys.VIRTUAL_FILE)
        if (
            event.getData(ApexLogViewerDataKeys.LOG_ROW) == null &&
            existing != null &&
            isLocalLogCandidate(existing) &&
            !ParsedLogFileEditorProvider.isRecognizedApexLog(project, existing)
        ) {
            project.service<ApexLogViewerProjectService>().recognizeExternalLog(existing) { recognized ->
                if (recognized) {
                    ParsedLogFileEditorProvider.approveForParsedViewer(project, existing)
                    openParsedLog(project, existing)
                } else {
                    Messages.showWarningDialog(
                        project,
                        ApexLogViewerBundle.message("action.openParsedLog.unrecognized"),
                        ApexLogViewerBundle.message("action.openParsedLog.unrecognized.title"),
                    )
                }
            }
            return
        }
        withDependableLog(event) { project, file ->
            ParsedLogFileEditorProvider.approveForParsedViewer(project, file)
            openParsedLog(project, file)
        }
    }

    companion object {
        const val ID = "ApexLogViewer.OpenParsedLog"
    }
}

class OpenRawLogAction : AnAction() {
    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = hasDependableLog(event)
    }

    override fun actionPerformed(event: AnActionEvent) {
        withDependableLog(event) { project, file ->
            val editors = FileEditorManager.getInstance(project)
            editors.openFile(file, true)
            editors.setSelectedEditor(file, RAW_EDITOR_TYPE_ID)
        }
    }

    companion object {
        const val ID = "ApexLogViewer.OpenRawLog"
    }
}

class OpenInIlluminatedCloudAction : AnAction() {
    override fun update(event: AnActionEvent) {
        val hasLog = hasDependableLog(event)
        val integration = ActionManager.getInstance().getAction(IC2_ACTION_ID)
        event.presentation.isEnabled = event.project != null && hasLog && integration != null
        event.presentation.description = if (integration == null) {
            ApexLogViewerBundle.message("action.openInIlluminatedCloud.unavailable")
        } else {
            ApexLogViewerBundle.message("action.openInIlluminatedCloud.description")
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val integration = ActionManager.getInstance().getAction(IC2_ACTION_ID)
        if (integration == null) {
            showIlluminatedCloudFailure(project)
            return
        }
        withDependableLog(event) { project, file ->
            val context = logDataContext(project, file = file)
            val delegatedEvent = AnActionEvent.createEvent(
                integration,
                context,
                integration.templatePresentation.clone(),
                PLACE,
                ActionUiKind.NONE,
                event.inputEvent,
            )
            val updateResult = runCatching { ActionUtil.updateAction(integration, delegatedEvent) }.getOrNull()
            if (
                updateResult?.isPerformed != true ||
                !delegatedEvent.presentation.isEnabled ||
                !delegatedEvent.presentation.isVisible
            ) {
                showIlluminatedCloudFailure(project)
                return@withDependableLog
            }
            val result = runCatching { ActionUtil.performAction(integration, delegatedEvent) }.getOrNull()
            if (result?.isPerformed != true) showIlluminatedCloudFailure(project)
        }
    }

    companion object {
        const val ID = "ApexLogViewer.OpenInIlluminatedCloud"
        const val IC2_ACTION_ID = "IlluminatedCloud.LogAnalyzer.Open"
        private const val PLACE = "ApexLogViewer.ReplayHandoff"
    }
}

internal fun logDataContext(
    project: com.intellij.openapi.project.Project,
    row: LogListRow? = null,
    file: VirtualFile? = null,
): DataContext = DataContext { dataId ->
    when (dataId) {
        CommonDataKeys.PROJECT.name -> project
        CommonDataKeys.VIRTUAL_FILE.name -> file
        ApexLogViewerDataKeys.LOG_ROW.name -> row
        else -> null
    }
}

private const val RAW_EDITOR_TYPE_ID = "text-editor"

private fun isLocalLogCandidate(file: VirtualFile): Boolean =
    file.isInLocalFileSystem && file.extension?.equals("log", ignoreCase = true) == true

private fun openParsedLog(project: Project, file: VirtualFile) {
    val editors = FileEditorManager.getInstance(project)
    val parsedProviderIsPresent = editors.getComposite(file)
        ?.allProviders
        ?.any { it.editorTypeId == ParsedLogFileEditorProvider.EDITOR_TYPE_ID } == true
    if (editors.isFileOpen(file) && !parsedProviderIsPresent) {
        editors.closeFile(file)
    }
    editors.openFile(file, true)
    editors.setSelectedEditor(file, ParsedLogFileEditorProvider.EDITOR_TYPE_ID)
}

private fun hasDependableLog(event: AnActionEvent): Boolean {
    val project = event.project?.takeUnless(Project::isDisposed) ?: return false
    if (event.getData(ApexLogViewerDataKeys.LOG_ROW) != null) return true
    val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return false
    return ParsedLogFileEditorProvider.isRecognizedApexLog(project, file)
}

internal fun withDependableLog(event: AnActionEvent, operation: (Project, VirtualFile) -> Unit) {
    val project = event.project ?: return
    val existing = event.getData(CommonDataKeys.VIRTUAL_FILE)
    if (existing != null && ParsedLogFileEditorProvider.isRecognizedApexLog(project, existing)) {
        operation(project, existing)
        return
    }
    val row = event.getData(ApexLogViewerDataKeys.LOG_ROW) ?: return
    project.service<ApexLogViewerProjectService>().materializeLog(row) { result ->
        result.onSuccess { local ->
            val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(local.localPath)
            if (file == null) {
                showOpenFailure(project, "local-persistence")
                return@onSuccess
            }
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) operation(project, file)
            }
        }.onFailure { error ->
            showOpenFailure(project, (error as? ApexLogViewerRuntimeException)?.code ?: "unexpected")
        }
    }
}

private fun showOpenFailure(project: Project, code: String) {
    ApplicationManager.getApplication().invokeLater {
        if (!project.isDisposed) {
            Messages.showErrorDialog(
                project,
                localizedFailure(code),
                ApexLogViewerBundle.message("action.openLog.failed.title"),
            )
        }
    }
}

private fun showIlluminatedCloudFailure(project: Project) {
    ApplicationManager.getApplication().invokeLater {
        if (!project.isDisposed) {
            Messages.showWarningDialog(
                project,
                ApexLogViewerBundle.message("action.openInIlluminatedCloud.failed"),
                ApexLogViewerBundle.message("action.openInIlluminatedCloud.failed.title"),
            )
        }
    }
}
