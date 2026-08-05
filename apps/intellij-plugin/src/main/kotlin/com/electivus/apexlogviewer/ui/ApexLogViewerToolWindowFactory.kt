package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout

class ApexLogViewerToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        project.service<ApexLogViewerProjectService>()

        addTab(
            toolWindow,
            ApexLogViewerBundle.message("toolWindow.logs"),
            ApexLogViewerBundle.message("toolWindow.logs.empty"),
            ApexLogViewerBundle.message("toolWindow.logs.accessibleDescription"),
        )
        addTab(
            toolWindow,
            ApexLogViewerBundle.message("toolWindow.debugFlags"),
            ApexLogViewerBundle.message("toolWindow.debugFlags.empty"),
            ApexLogViewerBundle.message("toolWindow.debugFlags.accessibleDescription"),
        )
    }

    private fun addTab(
        toolWindow: ToolWindow,
        title: String,
        emptyMessage: String,
        accessibleDescription: String,
    ) {
        val panel = JBPanel<JBPanel<*>>(BorderLayout())
        panel.accessibleContext.accessibleDescription = accessibleDescription
        panel.add(JBLabel(emptyMessage), BorderLayout.NORTH)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, title, false))
    }

    companion object {
        const val ID = "Electivus Apex Log Viewer"
    }
}
