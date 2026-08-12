package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.project.ApexLogViewerProjectService
import com.electivus.apexlogviewer.project.ApexLogViewerApplicationSettings
import com.electivus.apexlogviewer.project.ApexLogViewerDiagnostics
import com.electivus.apexlogviewer.project.LogsProjectState
import com.electivus.apexlogviewer.project.SearchProjectState
import com.electivus.apexlogviewer.project.ApexLogViewerSettings
import com.electivus.apexlogviewer.project.LogSortDirection
import com.electivus.apexlogviewer.project.LogSortField
import com.electivus.apexlogviewer.project.LogViewOptions
import com.electivus.apexlogviewer.runtime.ApexLogViewerRuntime
import com.electivus.apexlogviewer.runtime.LogTriageSummary
import com.electivus.apexlogviewer.runtime.ParseLogRequest
import com.electivus.apexlogviewer.runtime.ParsedLogEntry
import com.electivus.apexlogviewer.runtime.createApexLogViewerRuntime
import com.intellij.ide.impl.OpenProjectTask
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.ex.ProjectManagerEx
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.wm.RegisterToolWindowTask
import com.intellij.openapi.wm.ToolWindowAnchor
import com.intellij.openapi.wm.ToolWindowEP
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.EmptyIcon
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Container
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.JLabel
import javax.swing.text.JTextComponent

class ApexLogViewerToolWindowTest : BasePlatformTestCase() {
    fun testNativeApplicationSettingsEnforceTheRuntimeContractBounds() {
        val settings = ApexLogViewerApplicationSettings()
        settings.pageSize = 500
        settings.processingConcurrency = 0

        assertEquals(200, settings.pageSize)
        assertEquals(1, settings.processingConcurrency)
        assertFalse(settings.traceLogging)
    }

    fun testProjectSettingsPersistRestorableViewOptionsAndRejectUnknownEnumValues() {
        val settings = ApexLogViewerSettings()
        settings.viewOptions = LogViewOptions(
            user = "Demo User",
            operation = "Execute Anonymous",
            status = "Failed",
            errorsOnly = true,
            sortField = LogSortField.LOG_ID,
            sortDirection = LogSortDirection.ASCENDING,
        )

        assertEquals("Demo User", settings.viewOptions.user)
        assertEquals("Execute Anonymous", settings.viewOptions.operation)
        assertEquals("Failed", settings.viewOptions.status)
        assertTrue(settings.viewOptions.errorsOnly)
        assertEquals(LogSortField.LOG_ID, settings.viewOptions.sortField)
        assertEquals(LogSortDirection.ASCENDING, settings.viewOptions.sortDirection)

        settings.state.sortField = "unknown"
        settings.state.sortDirection = "unknown"
        assertEquals(LogSortField.START_TIME, settings.viewOptions.sortField)
        assertEquals(LogSortDirection.DESCENDING, settings.viewOptions.sortDirection)
    }

    fun testRefreshLogsActionIsRegistered() {
        val actionIds = listOf(
            RefreshLogsAction.ID,
            LoadMoreLogsAction.ID,
            CancelLogSearchAction.ID,
            ContinueLogSearchAction.ID,
            RetryLogSearchAction.ID,
            DownloadAllLogsAction.ID,
            CancelDownloadAllLogsAction.ID,
            OpenParsedLogAction.ID,
            OpenRawLogAction.ID,
            OpenInIlluminatedCloudAction.ID,
        )
        val presentations = actionIds.map { id ->
            requireNotNull(ActionManager.getInstance().getAction(id)).templatePresentation
        }

        assertEquals(
            listOf(
                "Refresh Apex Logs",
                "Load More Logs",
                "Cancel Search",
                "Continue Search",
                "Try Search Again",
                "Download All Logs",
                "Cancel Download All",
                "Open in Apex Log Viewer",
                "Open Raw Log",
                "Open in Illuminated Cloud 2",
            ),
            presentations.map { it.text },
        )
        assertTrue(presentations.all { it.icon != null })
        assertEquals(actionIds.size, presentations.map { it.icon }.distinct().size)
        assertNotNull(ActionManager.getInstance().getAction(OpenDiagnosticsAction.ID))
    }

    fun testDiagnosticsPackageIsBoundedAndExcludesSensitiveState() {
        val diagnostics = ApexLogViewerDiagnostics()
        repeat(205) { index ->
            diagnostics.record("search", "failed", if (index == 204) "token=secret-value" else "remote-acquisition")
        }

        val contents = diagnostics.sanitizedPackage(
            project,
            LogsProjectState(
                selectedOrg = "sensitive-user@example.com",
                search = SearchProjectState(query = "sensitive query"),
            ),
        )

        assertFalse(contents.contains("sensitive-user@example.com"))
        assertFalse(contents.contains("sensitive query"))
        assertFalse(contents.contains("secret-value"))
        assertTrue(contents.contains("\"code\": \"redacted\""))
        assertEquals(200, Regex("\"phase\"").findAll(contents).count())
    }

    fun testParsedLogViewerActionAndEditorAreRegistered() {
        assertNotNull(ActionManager.getInstance().getAction(OpenParsedLogAction.ID))
        assertNotNull(ActionManager.getInstance().getAction(OpenRawLogAction.ID))
        assertNotNull(ActionManager.getInstance().getAction(OpenInIlluminatedCloudAction.ID))
        assertTrue(
            FileEditorProvider.EP_FILE_EDITOR_PROVIDER.extensionList.any {
                it is ParsedLogFileEditorProvider
            },
        )
    }

    fun testReplayHandoffInvokesTheIlluminatedCloudActionWithTheDependableVirtualFile() {
        val localLog = Files.createTempFile("alv-ic2-handoff-", ".log")
        Files.writeString(localLog, "12:00:00.000 (1)|EXECUTION_STARTED|")
        val virtualFile = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(localLog))
        ParsedLogFileEditorProvider.approveForParsedViewer(project, virtualFile)
        var delegatedFile: Any? = null
        var updateFile: Any? = null
        var delegatedFiles: List<Any> = emptyList()
        var updateFiles: List<Any> = emptyList()
        val integration = object : AnAction() {
            override fun update(event: AnActionEvent) {
                updateFile = event.getData(CommonDataKeys.VIRTUAL_FILE)
                updateFiles = event.getData(PlatformDataKeys.VIRTUAL_FILE_ARRAY)?.toList().orEmpty()
            }

            override fun actionPerformed(event: AnActionEvent) {
                assertSame(project, event.project)
                delegatedFile = event.getData(CommonDataKeys.VIRTUAL_FILE)
                delegatedFiles = event.getData(PlatformDataKeys.VIRTUAL_FILE_ARRAY)?.toList().orEmpty()
            }
        }
        val actionManager = ActionManager.getInstance()
        actionManager.registerAction(OpenInIlluminatedCloudAction.IC2_ACTION_ID, integration)
        Disposer.register(testRootDisposable) {
            actionManager.unregisterAction(OpenInIlluminatedCloudAction.IC2_ACTION_ID)
        }
        val handoff = requireNotNull(actionManager.getAction(OpenInIlluminatedCloudAction.ID))
        val context = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .add(CommonDataKeys.VIRTUAL_FILE, virtualFile)
            .build()
        val event = AnActionEvent.createEvent(
            handoff,
            context,
            handoff.templatePresentation.clone(),
            "ApexLogViewer.Test",
            ActionUiKind.NONE,
            null,
        )

        handoff.update(event)
        assertTrue(event.presentation.isEnabled)
        handoff.actionPerformed(event)
        assertSame(virtualFile, updateFile)
        assertSame(virtualFile, delegatedFile)
        assertEquals(listOf(virtualFile), updateFiles)
        assertEquals(listOf(virtualFile), delegatedFiles)
    }

    fun testReplayHandoffDoesNotInvokeAnIlluminatedCloudActionThatIsHiddenOrDisabled() {
        TestDialogManager.setTestDialog(TestDialog.OK, testRootDisposable)
        val localLog = Files.createTempFile("alv-ic2-unavailable-", ".log")
        Files.writeString(localLog, "12:00:00.000 (1)|EXECUTION_STARTED|")
        val virtualFile = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(localLog))
        ParsedLogFileEditorProvider.approveForParsedViewer(project, virtualFile)
        val actionManager = ActionManager.getInstance()
        var enabled = true
        var visible = false
        var invocations = 0
        val integration = object : AnAction() {
            override fun update(event: AnActionEvent) {
                event.presentation.isEnabled = enabled
                event.presentation.isVisible = visible
            }

            override fun actionPerformed(event: AnActionEvent) {
                invocations += 1
            }
        }
        actionManager.registerAction(OpenInIlluminatedCloudAction.IC2_ACTION_ID, integration)
        Disposer.register(testRootDisposable) {
            actionManager.unregisterAction(OpenInIlluminatedCloudAction.IC2_ACTION_ID)
        }
        val handoff = requireNotNull(actionManager.getAction(OpenInIlluminatedCloudAction.ID))
        val context = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .add(CommonDataKeys.VIRTUAL_FILE, virtualFile)
            .build()

        fun performHandoff() {
            val event = AnActionEvent.createEvent(
                handoff,
                context,
                handoff.templatePresentation.clone(),
                "ApexLogViewer.Test",
                ActionUiKind.NONE,
                null,
            )
            handoff.actionPerformed(event)
        }

        performHandoff()
        enabled = false
        visible = true
        performHandoff()
        UIUtil.dispatchAllInvocationEvents()

        assertEquals(0, invocations)
    }

    fun testParsedEditorClaimsManagedLogsAndExplicitActionApprovesAnExternalApexLog() {
        val externalPath = Files.createTempFile("alv-explicit-", ".log")
        Files.writeString(externalPath, "12:00:00.000 (1)|EXECUTION_STARTED|")
        val externalFile = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(externalPath))
        val managedPath = Path.of(requireNotNull(project.basePath))
            .resolve("apexlogs/orgs/test/logs/2026-08-10/07L000000000001.log")
        Files.createDirectories(managedPath.parent)
        Files.writeString(managedPath, "12:00:00.000 (1)|EXECUTION_STARTED|")
        val managedFile = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(managedPath))
        val provider = ParsedLogFileEditorProvider()

        assertFalse(provider.accept(project, externalFile))
        assertTrue(provider.accept(project, managedFile))
        // The lightweight test editor manager uses this public key to select the provider it exercises.
        externalFile.putUserData(FileEditorProvider.KEY, provider)
        val editorManager = FileEditorManager.getInstance(project)
        editorManager.openFile(externalFile, true)
        assertFalse(editorManager.getSelectedEditor(externalFile) is ParsedLogFileEditor)
        val action = requireNotNull(ActionManager.getInstance().getAction(OpenParsedLogAction.ID))
        val context = SimpleDataContext.builder()
            .add(CommonDataKeys.PROJECT, project)
            .add(CommonDataKeys.VIRTUAL_FILE, externalFile)
            .build()
        val event = AnActionEvent.createEvent(
            action,
            context,
            action.templatePresentation.clone(),
            "ApexLogViewer.Test",
            ActionUiKind.NONE,
            null,
        )
        action.update(event)
        assertTrue(event.presentation.isEnabled)
        action.actionPerformed(event)
        val deadline = System.nanoTime() + 5_000_000_000L
        while (editorManager.getSelectedEditor(externalFile) !is ParsedLogFileEditor && System.nanoTime() < deadline) {
            UIUtil.dispatchAllInvocationEvents()
            Thread.sleep(10)
        }
        assertTrue(provider.accept(project, externalFile))
        assertTrue(editorManager.getSelectedEditor(externalFile) is ParsedLogFileEditor)

        val otherRoot = Files.createTempDirectory("alv-external-project-scope-")
        val projectManager = ProjectManagerEx.getInstanceEx()
        val otherProject = requireNotNull(
            projectManager.newProject(
                otherRoot,
                OpenProjectTask.build().asNewProject().withProjectName("alv-external-project-scope"),
            ),
        )
        try {
            assertFalse(provider.accept(otherProject, externalFile))
        } finally {
            projectManager.closeAndDispose(otherProject)
            Files.walk(otherRoot).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
    }

    fun testParsedEditorIgnoresAsyncCompletionAfterItIsDisposed() {
        val localLog = Files.createTempFile("alv-parsed-disposal-", ".log")
        Files.writeString(localLog, "12:00:00.000 (1)|EXECUTION_STARTED|")
        val virtualFile = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(localLog))
        val parseStarted = CountDownLatch(1)
        val releaseParse = CountDownLatch(1)
        val parseCompleted = CountDownLatch(1)
        val runtimeClosed = AtomicBoolean()
        val runtime = object : ApexLogViewerRuntime by createApexLogViewerRuntime() {
            override suspend fun parseLog(request: ParseLogRequest): List<ParsedLogEntry> {
                parseStarted.countDown()
                assertTrue(releaseParse.await(5, TimeUnit.SECONDS))
                return emptyList()
            }

            override suspend fun triageLog(request: ParseLogRequest) =
                LogTriageSummary(false, reasons = emptyList()).also { parseCompleted.countDown() }

            override fun close() {
                runtimeClosed.set(true)
            }
        }
        val editor = ParsedLogFileEditor(project, virtualFile, runtime)
        val status = requireNotNull(
            (editor.component.layout as BorderLayout).getLayoutComponent(BorderLayout.SOUTH) as? JLabel,
        )
        val loadingText = status.text
        assertTrue(parseStarted.await(5, TimeUnit.SECONDS))

        editor.dispose()
        releaseParse.countDown()
        assertTrue(parseCompleted.await(5, TimeUnit.SECONDS))
        repeat(20) {
            UIUtil.dispatchAllInvocationEvents()
            Thread.sleep(10)
        }

        assertTrue(runtimeClosed.get())
        assertEquals(loadingText, status.text)
    }

    fun testProjectOpenIsDormantUntilTheRegisteredToolWindowIsShown() {
        val lifecycleRoot = Path.of(requireNotNull(project.basePath)).resolve("apexlogs")
        val lifecycleRootExisted = Files.exists(lifecycleRoot)
        val serviceBeforeRegistration = project.getServiceIfCreated(ApexLogViewerProjectService::class.java)

        val registration = ToolWindowEP.EP_NAME.extensionList.single {
            it.id == ApexLogViewerToolWindowFactory.ID
        }
        assertEquals("bottom", registration.anchor)
        assertEquals("AllIcons.FileTypes.Text", registration.icon)
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
                ToolWindowAnchor.BOTTOM,
            ),
        )
        assertSame(serviceBeforeRegistration, project.getServiceIfCreated(ApexLogViewerProjectService::class.java))
        assertEquals(lifecycleRootExisted, Files.exists(lifecycleRoot))
        assertEquals(0, toolWindow.contentManager.contents.size)

        // The headless manager does not invoke lazy factories on show; this is the callback the graphical manager makes.
        registeredFactory.createToolWindowContent(project, toolWindow)

        assertNotNull(project.getServiceIfCreated(ApexLogViewerProjectService::class.java))
        assertEquals(
            listOf("Logs"),
            toolWindow.contentManager.contents.map { it.displayName },
        )
        val logsSurface = toolWindow.contentManager.contents.single().component
        assertNotNull(findAccessibleComponent(logsSurface, "Salesforce org"))
        val search = requireNotNull(findAccessibleComponent(logsSurface, "Search Apex logs"))
        assertNotNull(findAccessibleComponent(logsSurface, "Filter Apex logs by operation"))
        assertNotNull(findAccessibleComponent(logsSurface, "Filter Apex logs by user"))
        assertNotNull(findAccessibleComponent(logsSurface, "Filter Apex logs by status"))
        assertNotNull(findAccessibleComponent(logsSurface, "Show only Apex logs with errors"))
        assertNotNull(findAccessibleComponent(logsSurface, "Apex logs table"))
        assertNotNull(findAccessibleComponent(logsSurface, "Apex log search status"))
        (search as JTextComponent).text = "needle"
        assertEquals("needle", project.service<ApexLogViewerProjectService>().state.value.search.query)
        assertEquals(lifecycleRootExisted, Files.exists(lifecycleRoot))
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

    fun testCancellingDownloadAllConfirmationDoesNotStartTheProjectService() {
        val projectPath = Files.createTempDirectory("alv-intellij-download-cancel-")
        val projectManager = ProjectManagerEx.getInstanceEx()
        val downloadProject = requireNotNull(
            projectManager.newProject(
                projectPath,
                OpenProjectTask.build().asNewProject().withProjectName("alv-download-cancel-test"),
            ),
        )
        var confirmationCalls = 0
        try {
            val action = DownloadAllLogsAction {
                confirmationCalls += 1
                false
            }
            val context = SimpleDataContext.builder().add(CommonDataKeys.PROJECT, downloadProject).build()
            val event = AnActionEvent.createEvent(
                action,
                context,
                action.templatePresentation.clone(),
                "ApexLogViewer.Test",
                ActionUiKind.NONE,
                null,
            )

            assertNull(downloadProject.getServiceIfCreated(ApexLogViewerProjectService::class.java))
            action.actionPerformed(event)
            assertEquals(1, confirmationCalls)
            assertNull(downloadProject.getServiceIfCreated(ApexLogViewerProjectService::class.java))
        } finally {
            projectManager.closeAndDispose(downloadProject)
            Files.walk(projectPath).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
    }

    private fun findAccessibleComponent(root: Component, accessibleName: String): Component? {
        if (root.accessibleContext?.accessibleName == accessibleName) return root
        if (root is Container) {
            root.components.forEach { child ->
                findAccessibleComponent(child, accessibleName)?.let { return it }
            }
        }
        return null
    }

}
