package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class ApexLogViewerToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = project.service<ApexLogViewerProjectService>()
        val panel = LogsToolWindowPanel(project, service)
        toolWindow.contentManager.addContent(
            ContentFactory.getInstance().createContent(panel, ApexLogViewerBundle.message("toolWindow.logs"), false),
        )
    }

    companion object {
        const val ID = "Electivus Apex Log Viewer"
    }
}
