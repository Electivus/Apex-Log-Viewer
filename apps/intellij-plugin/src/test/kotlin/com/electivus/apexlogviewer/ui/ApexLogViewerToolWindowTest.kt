package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.intellij.ide.impl.OpenProjectTask
import com.intellij.openapi.components.service
import com.intellij.openapi.project.ex.ProjectManagerEx
import com.intellij.openapi.wm.RegisterToolWindowTask
import com.intellij.openapi.wm.ToolWindowAnchor
import com.intellij.openapi.wm.ToolWindowEP
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.EmptyIcon
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator

class ApexLogViewerToolWindowTest : BasePlatformTestCase() {
    fun testProjectOpenIsDormantUntilTheRegisteredToolWindowIsShown() {
        val lifecycleRoot = Path.of(requireNotNull(project.basePath)).resolve("apexlogs")

        assertFalse(Files.exists(lifecycleRoot))
        assertNull(project.getServiceIfCreated(ApexLogViewerProjectService::class.java))

        val registration = ToolWindowEP.EP_NAME.extensionList.single {
            it.id == ApexLogViewerToolWindowFactory.ID
        }
        assertEquals(
            "Native IntelliJ IDEA access to the Apex Log Lifecycle.",
            registration.pluginDescriptor.description,
        )
        val registeredFactory = registration.getToolWindowFactory(registration.pluginDescriptor)
        val toolWindowManager = ToolWindowManager.getInstance(project)
        val toolWindow = toolWindowManager.registerToolWindow(
            RegisterToolWindowTask.lazyAndClosable(
                ApexLogViewerToolWindowFactory.ID,
                registeredFactory,
                EmptyIcon.ICON_16,
                ToolWindowAnchor.RIGHT,
            ),
        )
        assertNull(project.getServiceIfCreated(ApexLogViewerProjectService::class.java))
        assertEquals(0, toolWindow.contentManager.contents.size)

        // The headless manager does not invoke lazy factories on show; this is the callback the graphical manager makes.
        registeredFactory.createToolWindowContent(project, toolWindow)

        assertNotNull(project.getServiceIfCreated(ApexLogViewerProjectService::class.java))
        assertEquals(
            listOf("Logs", "Debug Flags"),
            toolWindow.contentManager.contents.map { it.displayName },
        )
        assertFalse(Files.exists(lifecycleRoot))
    }

    fun testProjectScopedServiceIsDisposedWithItsProject() {
        val projectPath = Files.createTempDirectory("alv-intellij-disposal-")
        val projectManager = ProjectManagerEx.getInstanceEx()
        val disposableProject = requireNotNull(
            projectManager.newProject(
                projectPath,
                OpenProjectTask.build().asNewProject().withProjectName("alv-disposal-test"),
            ),
        )

        try {
            val service = disposableProject.service<ApexLogViewerProjectService>()

            assertFalse(service.isDisposed)
            assertTrue(projectManager.closeAndDispose(disposableProject))
            assertTrue(disposableProject.isDisposed)
            assertTrue(service.isDisposed)
        } finally {
            if (!disposableProject.isDisposed) {
                projectManager.closeAndDispose(disposableProject)
            }
            Files.walk(projectPath).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
    }
}
