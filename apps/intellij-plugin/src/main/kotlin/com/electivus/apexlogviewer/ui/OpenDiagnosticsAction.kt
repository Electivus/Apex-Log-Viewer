package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.openapi.ide.CopyPasteManager
import java.awt.Dimension
import java.awt.datatransfer.StringSelection
import java.awt.event.ActionEvent
import javax.swing.Action
import javax.swing.JComponent

class OpenDiagnosticsAction : DumbAwareAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        project.service<ApexLogViewerProjectService>().buildDiagnosticsPackage { result ->
            result.onSuccess { content -> DiagnosticsPreviewDialog(project, content).show() }
                .onFailure {
                    Messages.showErrorDialog(
                        project,
                        ApexLogViewerBundle.message("diagnostics.preview.failed"),
                        ApexLogViewerBundle.message("diagnostics.preview.title"),
                    )
                }
        }
    }

    companion object {
        const val ID = "ApexLogViewer.OpenDiagnostics"
    }
}

private class DiagnosticsPreviewDialog(
    private val project: Project,
    private val content: String,
) : DialogWrapper(project) {
    private val preview = JBTextArea(content).apply {
        isEditable = false
        lineWrap = false
        accessibleContext?.accessibleName = ApexLogViewerBundle.message("diagnostics.preview.accessibleName")
    }
    private val copyAction = object : DialogWrapperAction(ApexLogViewerBundle.message("diagnostics.copy")) {
        override fun doAction(event: ActionEvent?) {
            CopyPasteManager.getInstance().setContents(StringSelection(content))
        }
    }
    private val saveAction = object : DialogWrapperAction(ApexLogViewerBundle.message("diagnostics.save")) {
        override fun doAction(event: ActionEvent?) {
            val descriptor = FileSaverDescriptor(
                ApexLogViewerBundle.message("diagnostics.save.title"),
                ApexLogViewerBundle.message("diagnostics.save.description"),
                "json",
            )
            val selected = FileChooserFactory.getInstance()
                .createSaveFileDialog(descriptor, project)
                .save(null as java.nio.file.Path?, DIAGNOSTICS_FILE_NAME)
                ?: return
            project.service<ApexLogViewerProjectService>()
                .saveDiagnosticsPackage(selected.file.toPath(), content) { result ->
                    result.onFailure {
                        Messages.showErrorDialog(
                            project,
                            ApexLogViewerBundle.message("diagnostics.save.failed"),
                            ApexLogViewerBundle.message("diagnostics.save.title"),
                        )
                    }
                }
        }
    }

    init {
        title = ApexLogViewerBundle.message("diagnostics.preview.title")
        init()
    }

    override fun createCenterPanel(): JComponent = JBScrollPane(preview).apply {
        preferredSize = Dimension(800, 560)
    }

    override fun createActions(): Array<Action> = arrayOf(copyAction, saveAction, cancelAction)

    companion object {
        private const val DIAGNOSTICS_FILE_NAME = "apex-log-viewer-diagnostics.json"
    }
}
