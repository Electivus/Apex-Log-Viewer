package com.electivus.apexlogviewer.ui

import com.electivus.apexlogviewer.ApexLogViewerBundle
import com.electivus.apexlogviewer.runtime.ApexLogViewerRuntime
import com.electivus.apexlogviewer.runtime.LogCategory
import com.electivus.apexlogviewer.runtime.LogTriageSummary
import com.electivus.apexlogviewer.runtime.ParseLogRequest
import com.electivus.apexlogviewer.runtime.ParsedLogEntry
import com.electivus.apexlogviewer.runtime.createApexLogViewerRuntime
import com.electivus.apexlogviewer.runtime.managedLifecycleLogId
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.ide.CopyProvider
import com.intellij.openapi.actionSystem.DataSink
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.UiDataProvider
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.Project
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.table.JBTable
import com.intellij.openapi.ide.CopyPasteManager
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.datatransfer.StringSelection
import java.beans.PropertyChangeListener
import java.nio.file.Path
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.JComponent
import javax.swing.event.DocumentEvent
import javax.swing.table.AbstractTableModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ParsedLogFileEditorProvider : FileEditorProvider {
    override fun accept(project: Project, file: VirtualFile): Boolean = isRecognizedApexLog(project, file)

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        ParsedLogFileEditor(project, file, createApexLogViewerRuntime())

    override fun getEditorTypeId(): String = EDITOR_TYPE_ID

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.PLACE_AFTER_DEFAULT_EDITOR

    companion object {
        const val EDITOR_TYPE_ID = "electivus-apex-log-viewer-parsed"

        internal fun isRecognizedApexLog(project: Project, file: VirtualFile): Boolean {
            if (file.extension?.equals("log", ignoreCase = true) != true || !file.isInLocalFileSystem) return false
            val approvedProjects = file.getUserData(PARSED_VIEWER_APPROVED_PROJECTS)
            val explicitlyApproved = approvedProjects?.let { synchronized(it) { project in it } } == true
            return explicitlyApproved || managedLogId(project, file) != null
        }

        internal fun approveForParsedViewer(project: Project, file: VirtualFile) {
            val approvedProjects = synchronized(file) {
                file.getUserData(PARSED_VIEWER_APPROVED_PROJECTS) ?: Collections.newSetFromMap(
                    WeakHashMap<Project, Boolean>(),
                ).also { file.putUserData(PARSED_VIEWER_APPROVED_PROJECTS, it) }
            }
            synchronized(approvedProjects) { approvedProjects += project }
        }

        internal fun managedLogId(project: Project, file: VirtualFile): String? {
            if (!file.isInLocalFileSystem) return null
            val basePath = project.basePath?.let(Path::of) ?: return null
            val path = runCatching(file::toNioPath).getOrNull() ?: return null
            return managedLifecycleLogId(basePath, path)
        }

        private val PARSED_VIEWER_APPROVED_PROJECTS =
            Key.create<MutableSet<Project>>("ApexLogViewer.ParsedViewerApprovedProjects")
    }
}

internal fun localizedTriageReason(summary: LogTriageSummary): String {
    val key = when (summary.reasons.firstOrNull()?.code) {
        "assertion_failure" -> "parsedLog.triage.assertionFailure"
        "validation_failure" -> "parsedLog.triage.validationFailure"
        "dml_failure" -> "parsedLog.triage.dmlFailure"
        "fatal_exception" -> "parsedLog.triage.fatalException"
        "suspicious_error_payload" -> "parsedLog.triage.suspiciousPayload"
        "rollback_detected" -> "parsedLog.triage.rollbackDetected"
        else -> "parsedLog.triage.detected"
    }
    return ApexLogViewerBundle.message(key)
}

internal class ParsedLogFileEditor(
    private val project: Project,
    private val file: VirtualFile,
    private val runtime: ApexLogViewerRuntime,
) : UserDataHolderBase(), FileEditor, Disposable {
    private val component = ParsedLogRootPanel(file)
    private val searchField = SearchTextField(false)
    private val tabs = JBTabbedPane()
    private val status = JBLabel(ApexLogViewerBundle.message("parsedLog.status.loading"))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val disposed = AtomicBoolean()
    private var entries: List<ParsedLogEntry> = emptyList()
    private var triage = LogTriageSummary(false, reasons = emptyList())

    init {
        searchField.textEditor.accessibleContext?.accessibleName =
            ApexLogViewerBundle.message("parsedLog.search.accessibleName")
        tabs.accessibleContext?.accessibleName = ApexLogViewerBundle.message("parsedLog.tabs.accessibleName")
        val actionManager = ActionManager.getInstance()
        val toolbar = actionManager.createActionToolbar(
            "ApexLogViewer.ParsedLogToolbar",
            DefaultActionGroup(
                listOf(OpenRawLogAction.ID, OpenInIlluminatedCloudAction.ID)
                    .map { requireNotNull(actionManager.getAction(it)) },
            ),
            true,
        )
        toolbar.targetComponent = component
        val header = JBPanel<JBPanel<*>>(BorderLayout())
        header.add(toolbar.component, BorderLayout.WEST)
        header.add(searchField, BorderLayout.CENTER)
        component.add(header, BorderLayout.NORTH)
        component.add(tabs, BorderLayout.CENTER)
        component.add(status, BorderLayout.SOUTH)
        searchField.textEditor.document.addDocumentListener(
            object : DocumentAdapter() {
                override fun textChanged(event: DocumentEvent) = render()
            },
        )
        scope.launch {
            val request = ParseLogRequest(file.toNioPath())
            val result = runCatching { runtime.parseLog(request) to runtime.triageLog(request) }
            ApplicationManager.getApplication().invokeLater {
                if (!disposed.get() && !project.isDisposed) {
                    result.onSuccess { (parsedEntries, summary) ->
                        entries = parsedEntries
                        triage = summary
                        render()
                    }.onFailure {
                        status.text = ApexLogViewerBundle.message("parsedLog.status.failed")
                    }
                }
            }
        }
    }

    private fun render() {
        val query = searchField.text
        val searched = if (query.isBlank()) entries else entries.filter { entry ->
            entry.message.contains(query, ignoreCase = true) ||
                entry.details?.contains(query, ignoreCase = true) == true ||
                entry.type.contains(query, ignoreCase = true)
        }
        val selectedIndex = tabs.selectedIndex.coerceAtLeast(0)
        tabs.removeAll()
        PERSPECTIVES.forEach { perspective ->
            val rows = searched.filter { entry ->
                perspective.accepts(entry) || perspective.titleKey == "parsedLog.tab.errors" &&
                    triage.reasons.any { diagnostic ->
                        diagnostic.line?.let { it == entry.lineNumber } == true ||
                            diagnostic.eventType?.let { it == entry.type } == true
                    }
            }
            tabs.addTab(ApexLogViewerBundle.message(perspective.titleKey), JBScrollPane(createEntriesTable(rows, perspective.titleKey)))
        }
        if (tabs.tabCount > 0) tabs.selectedIndex = selectedIndex.coerceAtMost(tabs.tabCount - 1)
        status.text = triage.primaryReason?.let {
            ApexLogViewerBundle.message("parsedLog.status.triage", searched.size, localizedTriageReason(triage))
        } ?: ApexLogViewerBundle.message("parsedLog.status.ready", searched.size)
    }

    private fun createEntriesTable(rows: List<ParsedLogEntry>, perspectiveKey: String): JBTable {
        val model = ParsedEntriesTableModel(rows)
        return ParsedEntriesTable(
            project,
            file,
            model,
            ApexLogViewerBundle.message("parsedLog.table.accessibleName", ApexLogViewerBundle.message(perspectiveKey)),
        )
    }

    override fun getComponent(): JComponent = component

    override fun getPreferredFocusedComponent(): JComponent = searchField.textEditor

    override fun getName(): String = ApexLogViewerBundle.message("parsedLog.editor.name")

    override fun getFile(): VirtualFile = file

    override fun setState(state: com.intellij.openapi.fileEditor.FileEditorState) = Unit

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = file.isValid

    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        scope.cancel()
        runtime.close()
    }

    private data class Perspective(
        val titleKey: String,
        val accepts: (ParsedLogEntry) -> Boolean,
    )

    companion object {
        private val PERSPECTIVES = listOf(
            Perspective("parsedLog.tab.debug") { it.category == LogCategory.DEBUG },
            Perspective("parsedLog.tab.soql") { it.category == LogCategory.SOQL },
            Perspective("parsedLog.tab.dml") { it.category == LogCategory.DML },
            Perspective("parsedLog.tab.errors") { it.category == LogCategory.ERROR },
        )
    }
}

private class ParsedLogRootPanel(private val file: VirtualFile) :
    JBPanel<ParsedLogRootPanel>(BorderLayout()), UiDataProvider {
    override fun uiDataSnapshot(sink: DataSink) {
        sink.set(CommonDataKeys.VIRTUAL_FILE, file)
    }
}

private class ParsedEntriesTable(
    private val project: Project,
    private val file: VirtualFile,
    private val entriesModel: ParsedEntriesTableModel,
    accessibleName: String,
) : JBTable(entriesModel), UiDataProvider, CopyProvider {
    init {
        autoCreateRowSorter = true
        accessibleContext?.accessibleName = accessibleName
        addMouseListener(
            object : MouseAdapter() {
                override fun mouseClicked(event: MouseEvent) {
                    if (event.clickCount == 2 && selectedRow >= 0) {
                        entriesModel.rowAt(convertRowIndexToModel(selectedRow))
                            ?.let { OpenFileDescriptor(project, file, it.id, 0).navigate(true) }
                    }
                }
            },
        )
    }

    override fun uiDataSnapshot(sink: DataSink) {
        sink.set(PlatformDataKeys.COPY_PROVIDER, this)
        sink.set(CommonDataKeys.VIRTUAL_FILE, file)
    }

    override fun performCopy(dataContext: com.intellij.openapi.actionSystem.DataContext) {
        val text = selectedRows.joinToString("\n") { viewRow ->
            val modelRow = convertRowIndexToModel(viewRow)
            (0 until columnCount).joinToString("\t") { viewColumn ->
                entriesModel.getValueAt(modelRow, convertColumnIndexToModel(viewColumn)).toString()
            }
        }
        CopyPasteManager.getInstance().setContents(StringSelection(text))
    }

    override fun isCopyEnabled(dataContext: com.intellij.openapi.actionSystem.DataContext): Boolean = selectedRowCount > 0

    override fun isCopyVisible(dataContext: com.intellij.openapi.actionSystem.DataContext): Boolean = true
}

private class ParsedEntriesTableModel(private val rows: List<ParsedLogEntry>) : AbstractTableModel() {
    private val columnKeys = listOf(
        "parsedLog.column.time",
        "parsedLog.column.type",
        "parsedLog.column.line",
        "parsedLog.column.message",
        "parsedLog.column.details",
    )

    override fun getRowCount(): Int = rows.size

    override fun getColumnCount(): Int = columnKeys.size

    override fun getColumnName(column: Int): String = ApexLogViewerBundle.message(columnKeys[column])

    override fun getValueAt(rowIndex: Int, columnIndex: Int): Any = when (columnIndex) {
        0 -> rows[rowIndex].timestamp
        1 -> rows[rowIndex].type
        2 -> rows[rowIndex].lineNumber ?: ""
        3 -> rows[rowIndex].message
        4 -> rows[rowIndex].details.orEmpty()
        else -> ""
    }

    fun rowAt(index: Int): ParsedLogEntry? = rows.getOrNull(index)
}
